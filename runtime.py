import gc
import os
import threading
import time
from pathlib import Path

from PIL import Image
from model_setup import missing_files, model_directory, normalize_root, transformer_file

ROOT = Path(__file__).resolve().parent
MODELS = normalize_root(os.environ.get("REALITY_RESTYLE_MODELS_DIR", ROOT / "models"))
BASE_DIR = model_directory(MODELS)
TRANSFORMER_FILE = transformer_file(MODELS, BASE_DIR)
UPSCALER_FILE = MODELS / "upscalers" / "2xNomosUni_compact_multijpg.safetensors"
RESOLUTIONS = (512, 640, 768, 896, 1024)
DEFAULT_SETTINGS = {
    "prompt": "",
    "steps": 4,
    "resolution": 1024,
    "upscale": True,
    "rotation": 0,
}

def normalize_settings(raw, previous=None):
    source = dict(DEFAULT_SETTINGS if previous is None else previous)
    if not isinstance(raw, dict):
        raise ValueError("Settings must be an object.")
    allowed = set(DEFAULT_SETTINGS)
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError("Unknown setting.")
    source.update(raw)
    prompt = source.get("prompt")
    if not isinstance(prompt, str) or len(prompt) > 2000:
        raise ValueError("Prompt must be text under 2000 characters.")
    steps = source.get("steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 12:
        raise ValueError("Steps must be between 1 and 12.")
    resolution = source.get("resolution")
    if type(resolution) is not int or resolution not in RESOLUTIONS:
        raise ValueError("Resolution is not supported.")
    upscale = source.get("upscale")
    if not isinstance(upscale, bool):
        raise ValueError("Upscale must be a boolean.")
    rotation = source.get("rotation")
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValueError("Rotation must be 0, 90, 180, or 270.")
    return {
        "prompt": prompt,
        "steps": steps,
        "resolution": int(resolution),
        "upscale": upscale,
        "rotation": rotation,
    }

class Runtime:
    def __init__(self):
        self._lock = threading.RLock()
        self._settings_lock = threading.Lock()
        self._settings = dict(DEFAULT_SETTINGS)
        self._pipe = None
        self._upscaler = None
        self._upscaler_attempted = False
        self._prompt = None
        self._prompt_embeds = None
        self._prompt_ids = None
        self._last_heartbeat = 0.0
        self._metrics = {
            "loaded": False,
            "model_ms": 0.0,
            "upscale_ms": 0.0,
            "total_ms": 0.0,
            "error": "",
            "upscaler_available": UPSCALER_FILE.is_file(),
        }

    def settings(self):
        with self._settings_lock:
            return dict(self._settings)

    def set_settings(self, raw):
        with self._settings_lock:
            self._settings = normalize_settings(raw, self._settings)
            return dict(self._settings)

    def metrics(self):
        with self._lock:
            result = dict(self._metrics)
            result["upscaler_available"] = UPSCALER_FILE.is_file()
            result["loaded"] = self._pipe is not None
            return result

    def loaded(self):
        return self._pipe is not None

    def heartbeat(self):
        with self._lock:
            if self._pipe is None:
                self._last_heartbeat = 0.0
                return False
            self._last_heartbeat = time.monotonic()
            return True

    def idle_expired(self, idle_seconds):
        with self._lock:
            return self._idle_expired_locked(idle_seconds)

    def _idle_expired_locked(self, idle_seconds):
        return self._pipe is not None and self._last_heartbeat > 0.0 and time.monotonic() - self._last_heartbeat >= idle_seconds

    def unload_if_idle(self, idle_seconds):
        with self._lock:
            if not self._idle_expired_locked(idle_seconds):
                return False
            self._unload_locked()
            return True

    def report_error(self, message):
        with self._lock:
            self._metrics["error"] = str(message)[:500]

    def start(self, raw, allow_low_vram=False):
        self.set_settings(raw)
        with self._lock:
            if self._pipe is not None:
                self._last_heartbeat = time.monotonic()
                return {"ok": True, "low_vram": False, "upscaler_available": UPSCALER_FILE.is_file()}
            _, _, missing = missing_files(MODELS)
            if missing:
                raise RuntimeError("Required files are missing or invalid. Close and rerun run.bat to set them up.")
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
                text_encoder = Qwen3ForCausalLM.from_pretrained(
                    str(BASE_DIR),
                    subfolder="text_encoder",
                    quantization_config=BitsAndBytesConfig(load_in_8bit=True),
                    torch_dtype=torch.bfloat16,
                    local_files_only=True,
                    device_map={"": 0},
                )
                transformer = NunchakuFlux2Transformer2DModel.from_pretrained(
                    str(TRANSFORMER_FILE),
                    torch_dtype=torch.bfloat16,
                )
                pipe = Flux2KleinPipeline.from_pretrained(
                    str(BASE_DIR),
                    transformer=transformer,
                    text_encoder=text_encoder,
                    torch_dtype=torch.bfloat16,
                    local_files_only=True,
                )
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
                    raise RuntimeError(f"Runtime module unavailable: {exc.name}. Run run.bat to repair dependencies.") from None
                raise RuntimeError(f"Local runtime failed: {type(exc).__name__}: {exc}") from None
            self._pipe = pipe
            self._upscaler = None
            self._upscaler_attempted = False
            self._prompt = None
            self._prompt_embeds = None
            self._prompt_ids = None
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
        pipe = self._pipe
        upscaler = self._upscaler
        self._pipe = None
        self._upscaler = None
        self._upscaler_attempted = False
        self._prompt = None
        self._prompt_embeds = None
        self._prompt_ids = None
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
        if self._prompt == prompt and self._prompt_embeds is not None:
            return self._prompt_embeds, self._prompt_ids
        embeds, ids = self._pipe.encode_prompt(
            prompt=prompt,
            device="cuda",
            num_images_per_prompt=1,
            max_sequence_length=512,
        )
        self._prompt = prompt
        self._prompt_embeds = embeds
        self._prompt_ids = ids
        return embeds, ids

    def _load_upscaler(self):
        if self._upscaler is not None:
            return self._upscaler
        if self._upscaler_attempted:
            return None
        self._upscaler_attempted = True
        if not UPSCALER_FILE.is_file():
            self._metrics["error"] = "Upscaler checkpoint is missing."
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
            self._metrics["error"] = "Upscaler could not be loaded."
            return None

    def _upscale(self, image, torch):
        model = self._load_upscaler()
        if model is None:
            return image
        import numpy as np
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
            import torch
            generation_started = time.perf_counter()
            embeds, ids = self._encode_prompt(settings["prompt"])
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
                max_sequence_length=512,
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
                        max_sequence_length=512,
                    ).images[0]
            finally:
                if had_override:
                    pipe.encode_prompt = previous_override
                else:
                    try:
                        del pipe.encode_prompt
                    except AttributeError:
                        pass
            model_ms = (time.perf_counter() - generation_started) * 1000.0
            upscale_ms = 0.0
            if settings["upscale"]:
                upscale_started = time.perf_counter()
                output = self._upscale(output, torch)
                upscale_ms = (time.perf_counter() - upscale_started) * 1000.0
            if rotation:
                output = output.rotate(rotation, expand=True)
            total_ms = (time.perf_counter() - generation_started) * 1000.0
            self._metrics.update({
                "loaded": True,
                "model_ms": round(model_ms, 1),
                "upscale_ms": round(upscale_ms, 1),
                "total_ms": round(total_ms, 1),
            })
            if not settings["upscale"] or self._upscaler is not None:
                self._metrics["error"] = ""
            return output
