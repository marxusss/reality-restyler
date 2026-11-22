import gc
import os
import threading
import time
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

from hardware_check import SIMULTANEOUS_VRAM_GIB, best_cuda_device
from model_setup import (
    SPAN_UPSCALE_SIZE,
    UPSCALE_SIZE,
    missing_files,
    model_directory,
    normalize_root,
    upscaler_file,
    upscaler_is_valid,
)
from runtime_settings import DEFAULT_SETTINGS, PROMPT_TOKEN_LIMIT, normalize_settings
from timing import TimingWindow

ROOT = Path(__file__).resolve().parent
MODELS = normalize_root(os.environ.get("REALITY_RESTYLE_MODELS_DIR", ROOT / "models"))
COMPACT_UPSCALER_FILE = upscaler_file(MODELS, "compact2x")
SPAN_UPSCALER_FILE = upscaler_file(MODELS, "spanv2x4")
PROMPT_CACHE_SIZE = 5


def _upscaler_available(upscaler_id):
    if upscaler_id != DEFAULT_SETTINGS["upscaler"]:
        return False
    path = upscaler_file(MODELS, upscaler_id)
    expected_size = {"compact2x": UPSCALE_SIZE, "spanv2x4": SPAN_UPSCALE_SIZE}[upscaler_id]
    return path.is_file() and path.stat().st_size == expected_size


def _cpu_offload_enabled():
    return os.environ.get("REALITY_RESTYLE_CPU_OFFLOAD", "0").strip().lower() in {"1", "true", "yes"}


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
    # Preserve each complete prompt, including repeated scene guidance.
    prompt = "\n\n".join(prompts)
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
        self._device_index = 0
        self._upscaler = None
        self._upscaler_attempted = False
        self._upscaler_key = None
        self._last_upscale_report = None
        self._prompt_cache = OrderedDict()
        self._metrics = {
            "loaded": False,
            "model_ms": 0.0,
            "upscale_ms": 0.0,
            "total_ms": 0.0,
            "error": "",
            "upscaler_available": _upscaler_available(self._settings["upscaler"]),
            "upscaler_applied": False,
            "generated_size": "",
            "output_size": "",
        }
        self._timing = TimingWindow("inference")
        self._cold_prompt_timing = TimingWindow("prompt_encode_cold", sample_label="prompts")
        self._warm_timing = TimingWindow("inference_warm")

    def settings(self):
        with self._settings_lock:
            return dict(self._settings)

    def set_settings(self, raw):
        with self._settings_lock:
            previous = self._settings
            self._settings = normalize_settings(raw, self._settings)
            updated = dict(self._settings)
        if (previous["upscale"], previous["upscaler"]) != (updated["upscale"], updated["upscaler"]):
            with self._status_lock:
                self._metrics.update({
                    "upscaler_applied": False,
                    "generated_size": "",
                    "output_size": "",
                })
        return updated

    def metrics(self):
        selected_upscaler = self.settings()["upscaler"]
        with self._status_lock:
            result = dict(self._metrics)
            result["upscaler"] = selected_upscaler
            result["upscaler_available"] = _upscaler_available(selected_upscaler)
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
            return self._pipe is not None

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
                return {"ok": True, "low_vram": False, "upscaler_available": _upscaler_available(self.settings()["upscaler"])}
            report("checking")
            import torch
            if not torch.cuda.is_available():
                raise RuntimeError("An NVIDIA CUDA GPU is required to run this model.")
            self._device_index = best_cuda_device(torch)
            torch.cuda.set_device(self._device_index)
            device = f"cuda:{self._device_index}"
            base_dir, transformer_path, missing = missing_files(MODELS)
            if missing:
                raise RuntimeError("Required files are missing or invalid. Restart from the Reality Restyling launcher to set them up.")
            free, total = torch.cuda.mem_get_info(self._device_index)
            low_vram = total < SIMULTANEOUS_VRAM_GIB * 1024 ** 3 or free < 20 * 1024 ** 3
            if low_vram and not allow_low_vram:
                return {
                    "ok": False,
                    "low_vram": True,
                    "free_vram_gb": round(free / 1024 ** 3, 1),
                    "total_vram_gb": round(total / 1024 ** 3, 1),
                }
            cpu_offload = low_vram and _cpu_offload_enabled()
            torch.set_float32_matmul_precision("high")
            torch.backends.cudnn.benchmark = False
            try:
                from diffusers import Flux2KleinPipeline
                from nunchaku.models.transformers.transformer_flux2 import (
                    NunchakuFlux2Transformer2DModel,
                )
                from transformers import BitsAndBytesConfig, Qwen3ForCausalLM
                report("text_encoder")
                encoder_quant = (BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                                     bnb_4bit_compute_dtype=torch.float16)
                                 if cpu_offload else BitsAndBytesConfig(load_in_8bit=True))
                text_encoder = Qwen3ForCausalLM.from_pretrained(
                    str(base_dir),
                    subfolder="text_encoder",
                    quantization_config=encoder_quant,
                    torch_dtype=torch.float16,
                    local_files_only=True,
                    device_map={"": device},
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
                if cpu_offload:
                    # Offload components between prompt encoding and frame inference.
                    pipe.enable_model_cpu_offload(device=device)
                else:
                    pipe.transformer.to(device)
                    pipe.vae.to(device)
                pipe.set_progress_bar_config(disable=True)
            except Exception as exc:
                print(f"Runtime load failed: {type(exc).__name__}: {exc}", flush=True)
                gc.collect()
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                if isinstance(exc, RuntimeError) and str(exc) == "Startup cancelled.":
                    raise
                if isinstance(exc, ModuleNotFoundError):
                    raise RuntimeError(f"Runtime module unavailable: {exc.name}. Restart from the Reality Restyling launcher to repair dependencies.") from None
                raise RuntimeError(f"Local runtime failed: {type(exc).__name__}: {exc}") from None
            with self._status_lock:
                self._pipe = pipe
                self._upscaler = None
                self._upscaler_attempted = False
                self._upscaler_key = None
                self._last_upscale_report = None
                self._prompt_cache.clear()
                self._metrics.update({
                    "loaded": True,
                    "model_ms": 0.0,
                    "upscale_ms": 0.0,
                    "total_ms": 0.0,
                    "error": "",
                    "upscaler_available": _upscaler_available(self.settings()["upscaler"]),
                    "upscaler_applied": False,
                    "generated_size": "",
                    "output_size": "",
                })
            return {"ok": True, "low_vram": low_vram, "upscaler_available": _upscaler_available(self.settings()["upscaler"])}

    def unload(self):
        with self._lock:
            self._unload_locked()

    def _unload_locked(self):
        self._timing.flush()
        self._cold_prompt_timing.flush()
        self._warm_timing.flush()
        pipe = self._pipe
        upscaler = self._upscaler
        if callable(getattr(upscaler, "close", None)):
            try:
                upscaler.close()
            except Exception as exc:
                print(f"Upscaler release failed: {type(exc).__name__}: {exc}", flush=True)
        with self._status_lock:
            self._pipe = None
            self._upscaler = None
            self._upscaler_attempted = False
            self._upscaler_key = None
            self._last_upscale_report = None
            self._prompt_cache.clear()
            self._metrics.update({
                "loaded": False,
                "model_ms": 0.0,
                "upscale_ms": 0.0,
                "total_ms": 0.0,
                "upscaler_applied": False,
                "generated_size": "",
                "output_size": "",
            })
        del pipe
        del upscaler
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.set_device(self._device_index)
                torch.cuda.empty_cache()
        except Exception as exc:
            print(f"CUDA cache release failed: {type(exc).__name__}: {exc}", flush=True)

    def _encode_prompt(self, prompt):
        cached = self._prompt_cache.get(prompt)
        if cached is not None:
            self._prompt_cache.move_to_end(prompt)
            return cached
        import torch
        torch.cuda.set_device(self._device_index)
        with torch.inference_mode():
            embeds, ids = self._pipe.encode_prompt(
                prompt=prompt,
                device=f"cuda:{self._device_index}",
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

    def _load_upscaler(self, upscaler_id):
        if self._upscaler_key != upscaler_id:
            old_model = self._upscaler
            if callable(getattr(old_model, "close", None)):
                try:
                    old_model.close()
                except Exception as exc:
                    print(f"Upscaler release failed: {type(exc).__name__}: {exc}", flush=True)
            self._upscaler = None
            self._upscaler_attempted = False
            self._upscaler_key = upscaler_id
            del old_model
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        if self._upscaler is not None:
            return self._upscaler
        if self._upscaler_attempted:
            raise RuntimeError(f"{upscaler_id} failed to load.")
        self._upscaler_attempted = True
        if not _upscaler_available(upscaler_id):
            self.report_error("Upscaler checkpoint is missing.")
            raise RuntimeError("Upscaler checkpoint is missing.")
        if not upscaler_is_valid(upscaler_file(MODELS, upscaler_id), upscaler_id):
            self.report_error("Upscaler checkpoint is invalid.")
            raise RuntimeError("Upscaler checkpoint is invalid.")
        try:
            import torch
            if upscaler_id == "compact2x":
                from spandrel import ModelLoader
                model = ModelLoader().load_from_file(str(COMPACT_UPSCALER_FILE))
                if int(getattr(model, "scale", 0) or 0) != 2:
                    raise RuntimeError("Unexpected model scale.")
                self._upscaler = model.cuda().eval()
                if getattr(self._upscaler, "supports_half", False):
                    self._upscaler.half()
            elif upscaler_id == "spanv2x4":
                from upscaler_models.spanv2 import SPANV2ESR
                model = SPANV2ESR(3, 3, feature_channels=32, upscale=4, bias=False)
                state = torch.load(SPAN_UPSCALER_FILE, map_location="cpu", weights_only=True)
                for key in ("model", "state_dict", "params", "params_ema"):
                    if isinstance(state, dict) and key in state:
                        state = state[key]
                        break
                model.load_state_dict(state, strict=True)
                self._upscaler = model.cuda().float().eval()
            else:
                raise RuntimeError("This video upscaler is not available in the Windows camera runtime.")
            return self._upscaler
        except Exception as exc:
            print(f"Upscaler {upscaler_id} load failed: {type(exc).__name__}: {exc}", flush=True)
            self.report_error(f"Upscaler could not be loaded: {type(exc).__name__}.")
            raise RuntimeError(f"Upscaler {upscaler_id} could not be loaded.") from exc

    def _upscale(self, image, torch, upscaler_id, model=None):
        if model is None:
            model = self._load_upscaler(upscaler_id)
        if model is None:
            raise RuntimeError(f"Upscaler {upscaler_id} is unavailable.")
        expected_scale = {"compact2x": 2, "spanv2x4": 4}[upscaler_id]
        array = np.asarray(image.convert("RGB"))
        with torch.inference_mode():
            tensor = torch.from_numpy(array.copy()).to("cuda").permute(2, 0, 1).unsqueeze(0).float() / 255.0
            if getattr(model, "supports_half", False):
                tensor = tensor.half()
            output = (model(tensor).clamp(0, 1) * 255.0 + 0.5).to(torch.uint8)
            output = output.squeeze(0).permute(1, 2, 0).contiguous().cpu().numpy()
        expected_size = (image.width * expected_scale, image.height * expected_scale)
        if (output.shape[1], output.shape[0]) != expected_size:
            raise RuntimeError(
                f"{upscaler_id} returned {output.shape[1]}x{output.shape[0]}, "
                f"expected {expected_size[0]}x{expected_size[1]}."
            )
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
            torch.cuda.set_device(self._device_index)
            generation_started = time.perf_counter()
            prompt_cache_miss = settings["prompt"] not in self._prompt_cache
            prompt_started = time.perf_counter()
            embeds, ids = self._encode_prompt(settings["prompt"])
            prompt_encode_ms = (time.perf_counter() - prompt_started) * 1000.0
            generator = torch.Generator(device=f"cuda:{self._device_index}").manual_seed(0)
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
            upscaler_applied = False
            generated_size = output.size
            if settings["upscale"]:
                load_started = time.perf_counter()
                load_was_attempted = self._upscaler_attempted and self._upscaler_key == settings["upscaler"]
                upscaler = self._load_upscaler(settings["upscaler"])
                if not load_was_attempted:
                    upscale_load_ms = (time.perf_counter() - load_started) * 1000.0
                upscale_started = time.perf_counter()
                output = self._upscale(output, torch, settings["upscaler"], upscaler)
                upscale_compute_ms = (time.perf_counter() - upscale_started) * 1000.0
                upscaler_applied = True
            postprocess_started = time.perf_counter()
            if rotation:
                output = output.rotate(rotation, expand=True)
            postprocess_ms = (time.perf_counter() - postprocess_started) * 1000.0
            upscale_report = (
                settings["upscaler"] if settings["upscale"] else "off",
                upscaler_applied,
                generated_size,
                output.size,
            )
            if upscale_report != self._last_upscale_report:
                print(
                    f"UPSCALE model={upscale_report[0]} applied={int(upscaler_applied)} "
                    f"generated={generated_size[0]}x{generated_size[1]} "
                    f"output={output.width}x{output.height}",
                    flush=True,
                )
                self._last_upscale_report = upscale_report
            total_ms = (time.perf_counter() - generation_started) * 1000.0
            upscale_ms = upscale_load_ms + upscale_compute_ms
            with self._status_lock:
                self._metrics.update({
                    "loaded": True,
                    "model_ms": round(model_ms, 1),
                    "upscale_ms": round(upscale_ms, 1),
                    "total_ms": round(total_ms, 1),
                    "upscaler_applied": upscaler_applied,
                    "generated_size": f"{generated_size[0]}x{generated_size[1]}",
                    "output_size": f"{output.width}x{output.height}",
                })
            timing_context = {
                "input": f"{width}x{height}",
                "generated": f"{generated_size[0]}x{generated_size[1]}",
                "output": f"{output.width}x{output.height}",
                "steps": settings["steps"],
                "upscale": int(settings["upscale"]),
                "upscaler": settings["upscaler"] if settings["upscale"] else "off",
                "upscaler_applied": int(upscaler_applied),
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
