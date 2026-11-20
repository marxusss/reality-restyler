import gc
import os
import threading
import time
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from model_setup import missing_files, model_directory, normalize_root

ROOT = Path(__file__).resolve().parent
MODELS = normalize_root(os.environ.get("REALITY_RESTYLE_MODELS_DIR", ROOT / "models"))
UPSCALER_FILE = MODELS / "upscalers" / "2xNomosUni_compact_multijpg.safetensors"
PROMPT_CACHE_SIZE = 5
from runtime_settings import DEFAULT_SETTINGS, RESOLUTIONS, PROMPT_TOKEN_LIMIT, normalize_settings
from timing import TimingWindow

@lru_cache(maxsize=1)
def _style_tokenizer():
    from jinja2.sandbox import ImmutableSandboxedEnvironment
    from tokenizers import Tokenizer

    folder = model_directory(MODELS) / "tokenizer"
    template = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True).from_string(
        (folder / "chat_template.jinja").read_text(encoding="utf-8")
    )
    return Tokenizer.from_file(str(folder / "tokenizer.json")), template

def prompt_token_count(prompt):
    tokenizer, template = _style_tokenizer()
    rendered = template.render(messages=[{"role": "user", "content": prompt}],
                               add_generation_prompt=True, enable_thinking=False)
    return len(tokenizer.encode(rendered).ids)

def combine_style_prompts(prompts):
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= 5:
        raise ValueError("Choose one to five styles.")
    if any(not isinstance(text, str) or not text.strip() or len(text) > 2000 for text in prompts):
        raise ValueError("Invalid style prompt.")
    if len(prompts) == 1:
        prompt = prompts[0]
    else:
        parts = [text.strip().removesuffix(", keep scene intact").rstrip(" .") for text in prompts]
        prompt = ".\n".join(parts) + ". keep scene intact"
    if len(prompt) > 2000:
        raise ValueError("These styles exceed the prompt length limit.")
    tokens = prompt_token_count(prompt)
    if tokens > PROMPT_TOKEN_LIMIT:
        raise ValueError(f"These styles use {tokens} tokens. The limit is {PROMPT_TOKEN_LIMIT}.")
    return prompt, tokens

class Runtime:
    def __init__(self):
        self._lock = threading.RLock()
        self._settings_lock = threading.Lock()
        self._status_lock = threading.RLock()
        self._settings = dict(DEFAULT_SETTINGS)
        self._pipe = None
        self._upscaler = None
        self._upscaler_attempted = False
        self._prompt_cache = OrderedDict()
        self._last_heartbeat = 0.0
        self._metrics = {
            "loaded": False,
            "model_ms": 0.0,
            "upscale_ms": 0.0,
            "total_ms": 0.0,
            "error": "",
            "upscaler_available": UPSCALER_FILE.is_file(),
        }
        self._timing = TimingWindow("inference")
        self._cold_prompt_timing = TimingWindow("prompt_encode_cold", sample_label="prompts")
        self._warm_timing = TimingWindow("inference_warm")

    def settings(self):
        with self._settings_lock:
            return dict(self._settings)

    def set_settings(self, raw):
        with self._settings_lock:
            self._settings = normalize_settings(raw, self._settings)
            return dict(self._settings)

    def metrics(self):
        with self._status_lock:
            result = dict(self._metrics)
            result["upscaler_available"] = UPSCALER_FILE.is_file()
            result["loaded"] = self._pipe is not None
            return result

    def flush_timings(self):
        with self._lock:
            self._timing.flush()
            self._cold_prompt_timing.flush()
            self._warm_timing.flush()

    def loaded(self):
        with self._status_lock:
            return self._pipe is not None

    def heartbeat(self):
        with self._status_lock:
            if self._pipe is None:
                self._last_heartbeat = 0.0
                return False
            self._last_heartbeat = time.monotonic()
            return True

    def idle_expired(self, idle_seconds):
        with self._status_lock:
            return self._idle_expired_locked(idle_seconds)

    def _idle_expired_locked(self, idle_seconds):
        return self._pipe is not None and self._last_heartbeat > 0.0 and time.monotonic() - self._last_heartbeat >= idle_seconds

    def unload_if_idle(self, idle_seconds):
        with self._lock:
            with self._status_lock:
                if not self._idle_expired_locked(idle_seconds):
                    return False
                self._unload_locked()
                return True

    def report_error(self, message):
        with self._status_lock:
            self._metrics["error"] = str(message)[:500]

    def start(self, raw, allow_low_vram=False, report_stage=None):
        def report(stage):
            if report_stage is not None:
                report_stage(stage)

        self.set_settings(raw)
        with self._lock:
            if self._pipe is not None:
                self.heartbeat()
                return {"ok": True, "low_vram": False, "upscaler_available": UPSCALER_FILE.is_file()}
            report("checking")
            base_dir, transformer_path, missing = missing_files(MODELS)
            if missing:
                raise RuntimeError("Required files are missing or invalid. Restart from the Reality Restyling launcher to set them up.")
            import torch
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is unavailable on this computer.")
            free, total = torch.cuda.mem_get_info()
            low_vram = total < 24 * 1024 ** 3 or free < 20 * 1024 ** 3
            if low_vram and not allow_low_vram:
                return {
                    "ok": False,
                    "low_vram": True,
                    "free_vram_gb": round(free / 1024 ** 3, 1),
                    "total_vram_gb": round(total / 1024 ** 3, 1),
                }
            torch.set_float32_matmul_precision("high")
            torch.backends.cudnn.benchmark = False
            try:
                from diffusers import Flux2KleinPipeline
                from nunchaku.models.transformers.transformer_flux2 import NunchakuFlux2Transformer2DModel
                from transformers import BitsAndBytesConfig, Qwen3ForCausalLM
                report("text_encoder")
                text_encoder = Qwen3ForCausalLM.from_pretrained(
                    str(base_dir),
                    subfolder="text_encoder",
                    quantization_config=BitsAndBytesConfig(load_in_8bit=True),
                    torch_dtype=torch.float16,
                    local_files_only=True,
                    device_map={"": 0},
                )
                report("model")
                transformer = NunchakuFlux2Transformer2DModel.from_pretrained(
                    str(transformer_path),
                    torch_dtype=torch.bfloat16,
                )
                report("pipeline")
                pipe = Flux2KleinPipeline.from_pretrained(
                    str(base_dir),
                    transformer=transformer,
                    text_encoder=text_encoder,
                    torch_dtype=torch.bfloat16,
                    local_files_only=True,
                )
                report("gpu")
                pipe.transformer.to("cuda")
                pipe.vae.to("cuda")
                pipe.set_progress_bar_config(disable=True)
            except Exception as exc:
                print(f"Runtime load failed: {type(exc).__name__}: {exc}", flush=True)
                gc.collect()
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                if isinstance(exc, ModuleNotFoundError):
                    raise RuntimeError(f"Runtime module unavailable: {exc.name}. Restart from the Reality Restyling launcher to repair dependencies.") from None
                raise RuntimeError(f"Local runtime failed: {type(exc).__name__}: {exc}") from None
            with self._status_lock:
                self._pipe = pipe
                self._upscaler = None
                self._upscaler_attempted = False
                self._prompt_cache.clear()
                self._last_heartbeat = time.monotonic()
                self._metrics.update({
                    "loaded": True,
                    "model_ms": 0.0,
                    "upscale_ms": 0.0,
                    "total_ms": 0.0,
                    "error": "",
                    "upscaler_available": UPSCALER_FILE.is_file(),
                })
            return {"ok": True, "low_vram": low_vram, "upscaler_available": UPSCALER_FILE.is_file()}

    def unload(self):
        with self._lock:
            self._unload_locked()

    def _unload_locked(self):
        self._timing.flush()
        self._cold_prompt_timing.flush()
        self._warm_timing.flush()
        pipe = self._pipe
        upscaler = self._upscaler
        with self._status_lock:
            self._pipe = None
            self._upscaler = None
            self._upscaler_attempted = False
            self._prompt_cache.clear()
            self._last_heartbeat = 0.0
            self._metrics.update({
                "loaded": False,
                "model_ms": 0.0,
                "upscale_ms": 0.0,
                "total_ms": 0.0,
            })
        del pipe
        del upscaler
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as exc:
            print(f"CUDA cache release failed: {type(exc).__name__}: {exc}", flush=True)

    def _encode_prompt(self, prompt):
        cached = self._prompt_cache.get(prompt)
        if cached is not None:
            self._prompt_cache.move_to_end(prompt)
            return cached
        import torch
        with torch.inference_mode():
            embeds, ids = self._pipe.encode_prompt(
                prompt=prompt,
                device="cuda",
                num_images_per_prompt=1,
                max_sequence_length=PROMPT_TOKEN_LIMIT,
            )
            target_dtype = getattr(self._pipe.transformer, "dtype", embeds.dtype)
            if embeds.dtype != target_dtype:
                embeds = embeds.to(dtype=target_dtype)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
        self._prompt_cache[prompt] = (embeds, ids)
        self._prompt_cache.move_to_end(prompt)
        while len(self._prompt_cache) > PROMPT_CACHE_SIZE:
            self._prompt_cache.popitem(last=False)
        return embeds, ids

    def _load_upscaler(self):
        if self._upscaler is not None:
            return self._upscaler
        if self._upscaler_attempted:
            return None
        self._upscaler_attempted = True
        if not UPSCALER_FILE.is_file():
            self.report_error("Upscaler checkpoint is missing.")
            return None
        try:
            from spandrel import ModelLoader
            model = ModelLoader().load_from_file(str(UPSCALER_FILE))
            if int(getattr(model, "scale", 0) or 0) != 2:
                raise RuntimeError("Unexpected model scale.")
            self._upscaler = model.cuda().eval()
            if getattr(self._upscaler, "supports_half", False):
                self._upscaler.half()
            return self._upscaler
        except Exception as exc:
            print(f"Upscaler load failed: {type(exc).__name__}: {exc}", flush=True)
            self.report_error("Upscaler could not be loaded.")
            return None

    def _upscale(self, image, torch, model=None):
        if model is None:
            model = self._load_upscaler()
        if model is None:
            return image
        array = np.asarray(image.convert("RGB"))
        with torch.inference_mode():
            tensor = torch.from_numpy(array.copy()).to("cuda").permute(2, 0, 1).unsqueeze(0).float() / 255.0
            if getattr(model, "supports_half", False):
                tensor = tensor.half()
            output = (model(tensor).clamp(0, 1) * 255.0 + 0.5).to(torch.uint8)
            output = output.squeeze(0).permute(1, 2, 0).contiguous().cpu().numpy()
        return Image.fromarray(output)

    def render(self, image):
        with self._lock:
            if self._pipe is None:
                raise RuntimeError("The model is not loaded.")
            frame_started = time.perf_counter()
            preprocess_started = frame_started
            settings = self.settings()
            rotation = settings["rotation"]
            source = image.convert("RGB")
            if rotation:
                source = source.rotate(-rotation, expand=True)
            width, height = source.size
            scale = settings["resolution"] / max(width, height)
            target_width = max(16, round(width * scale / 16) * 16)
            target_height = max(16, round(height * scale / 16) * 16)
            source = source.resize((target_width, target_height), Image.Resampling.BICUBIC)
            preprocess_ms = (time.perf_counter() - preprocess_started) * 1000.0
            import torch
            generation_started = time.perf_counter()
            prompt_cache_miss = settings["prompt"] not in self._prompt_cache
            prompt_started = time.perf_counter()
            embeds, ids = self._encode_prompt(settings["prompt"])
            prompt_encode_ms = (time.perf_counter() - prompt_started) * 1000.0
            generator = torch.Generator(device="cuda").manual_seed(0)
            pipe = self._pipe
            original_encode = pipe.encode_prompt
            had_override = "encode_prompt" in pipe.__dict__
            previous_override = pipe.__dict__.get("encode_prompt")
            def cached_encode_prompt(
                prompt=None,
                device=None,
                num_images_per_prompt=1,
                prompt_embeds=None,
                max_sequence_length=PROMPT_TOKEN_LIMIT,
                text_encoder_out_layers=(9, 18, 27),
            ):
                if prompt is None and num_images_per_prompt == 1 and prompt_embeds is embeds:
                    return embeds, ids
                return original_encode(
                    prompt=prompt,
                    device=device,
                    num_images_per_prompt=num_images_per_prompt,
                    prompt_embeds=prompt_embeds,
                    max_sequence_length=max_sequence_length,
                    text_encoder_out_layers=text_encoder_out_layers,
                )
            pipe.encode_prompt = cached_encode_prompt
            pipeline_started = time.perf_counter()
            try:
                with torch.inference_mode():
                    output = pipe(
                        prompt_embeds=embeds,
                        image=[source],
                        num_inference_steps=settings["steps"],
                        guidance_scale=1.0,
                        height=target_height,
                        width=target_width,
                        generator=generator,
                        output_type="pil",
                        max_sequence_length=PROMPT_TOKEN_LIMIT,
                    ).images[0]
            finally:
                if had_override:
                    pipe.encode_prompt = previous_override
                else:
                    try:
                        del pipe.encode_prompt
                    except AttributeError:
                        pass
            pipeline_ms = (time.perf_counter() - pipeline_started) * 1000.0
            model_ms = (time.perf_counter() - generation_started) * 1000.0
            upscale_load_ms = 0.0
            upscale_compute_ms = 0.0
            if settings["upscale"]:
                load_started = time.perf_counter()
                load_was_attempted = self._upscaler_attempted
                upscaler = self._load_upscaler()
                if not load_was_attempted:
                    upscale_load_ms = (time.perf_counter() - load_started) * 1000.0
                if upscaler is not None:
                    upscale_started = time.perf_counter()
                    output = self._upscale(output, torch, upscaler)
                    upscale_compute_ms = (time.perf_counter() - upscale_started) * 1000.0
            postprocess_started = time.perf_counter()
            if rotation:
                output = output.rotate(rotation, expand=True)
            postprocess_ms = (time.perf_counter() - postprocess_started) * 1000.0
            total_ms = (time.perf_counter() - generation_started) * 1000.0
            upscale_ms = upscale_load_ms + upscale_compute_ms
            with self._status_lock:
                self._metrics.update({
                    "loaded": True,
                    "model_ms": round(model_ms, 1),
                    "upscale_ms": round(upscale_ms, 1),
                    "total_ms": round(total_ms, 1),
                })
            timing_context = {
                "input": f"{width}x{height}",
                "output": f"{target_width}x{target_height}",
                "steps": settings["steps"],
                "upscale": int(settings["upscale"]),
            }
            if prompt_cache_miss:
                self._cold_prompt_timing.record(
                    context={"token_limit": PROMPT_TOKEN_LIMIT},
                    prompt_encode_wall_ms=prompt_encode_ms,
                )
            else:
                self._warm_timing.record(
                    context=timing_context,
                    pipeline_wall_ms=pipeline_ms,
                    total_ms=model_ms,
                )
            self._timing.record(
                context=timing_context,
                preprocess_ms=preprocess_ms,
                prompt_encode_wall_ms=prompt_encode_ms,
                prompt_cache_miss=prompt_cache_miss,
                pipeline_wall_ms=pipeline_ms,
                upscale_load_ms=upscale_load_ms,
                upscale_compute_wall_ms=upscale_compute_ms,
                postprocess_ms=postprocess_ms,
                total_ms=total_ms,
            )
            if not settings["upscale"] or self._upscaler is not None:
                self.report_error("")
            return output
