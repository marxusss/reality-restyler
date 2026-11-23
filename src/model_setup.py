import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
import urllib.request
import webbrowser
from pathlib import Path

from hardware_check import best_cuda_device

ROOT = Path(__file__).resolve().parent
DEFAULT_ROOT = Path(os.environ.get("REALITY_RESTYLE_MODELS_DIR", ROOT / "models")).expanduser()
MODEL_REPO = "tonera/FLUX.2-klein-9B-Nunchaku"
MODEL_URL = f"https://huggingface.co/{MODEL_REPO}"
MODEL_REVISION = "d76d4d72c17b5a48f795c9ee1680c5ea97c77435"
UPSCALE_REPO = "Phips/2xNomosUni_compact_multijpg"
UPSCALE_REVISION = "4774921957bcbd222e7e4861728b02ebb3502c31"
SPAN_REVISION = "4592ce6db68b395699f13e7e2a4e3baf317ef1c6"
SPAN_CHECKPOINT_URL = f"https://raw.githubusercontent.com/Amazingren/NTIRE2026_ESR/{SPAN_REVISION}/model_zoo/team22_spanv2_c2.pth"
BUNDLE_NAME = "FLUX.2-klein-9B-Nunchaku"
TRANSFORMER_NAME = "svdq-fp4_r32-FLUX.2-klein-9B-Nunchaku.safetensors"
INT4_TRANSFORMER_NAME = "svdq-int4_r32-FLUX.2-klein-9B-Nunchaku.safetensors"


def selected_transformer():
    # FP4 weights require Blackwell; earlier NVIDIA generations use INT4.
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("Could not detect a supported NVIDIA CUDA GPU.")
    device = best_cuda_device(torch)
    if torch.cuda.get_device_capability(device)[0] < 12:
        return INT4_TRANSFORMER_NAME
    return TRANSFORMER_NAME

UPSCALE_NAME = "2xNomosUni_compact_multijpg.safetensors"
SPAN_UPSCALE_NAME = "team22_spanv2_c2.pth"
PIPELINE_FILES = (
    "model_index.json",
    "scheduler/scheduler_config.json",
    "text_encoder/config.json",
    "text_encoder/generation_config.json",
    "text_encoder/model-00001-of-00004.safetensors",
    "text_encoder/model-00002-of-00004.safetensors",
    "text_encoder/model-00003-of-00004.safetensors",
    "text_encoder/model-00004-of-00004.safetensors",
    "text_encoder/model.safetensors.index.json",
    "tokenizer/added_tokens.json",
    "tokenizer/chat_template.jinja",
    "tokenizer/merges.txt",
    "tokenizer/special_tokens_map.json",
    "tokenizer/tokenizer.json",
    "tokenizer/tokenizer_config.json",
    "tokenizer/vocab.json",
    "transformer/config.json",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
)
FILE_SIZES = {
    "text_encoder/model-00001-of-00004.safetensors": 4902257696,
    "text_encoder/model-00002-of-00004.safetensors": 4915960368,
    "text_encoder/model-00003-of-00004.safetensors": 4983068496,
    "text_encoder/model-00004-of-00004.safetensors": 1580230264,
    "vae/diffusion_pytorch_model.safetensors": 168120878,
    TRANSFORMER_NAME: 5800843496,
    INT4_TRANSFORMER_NAME: 5525885656,
}
UPSCALE_SIZE = 1205456
SPAN_UPSCALE_SIZE = 565288
SPAN_UPSCALE_SHA256 = "fca2743272b8a7fb32931ed3287454173c7d209f204cb2f58084ee868414d371"
UPSCALERS = ("spanv2x4", "compact2x")


def normalize_root(value):
    path = Path(value).expanduser().resolve()
    if path.name == BUNDLE_NAME:
        return path.parent
    return path


def model_directory(root):
    root = Path(root).expanduser().resolve()
    bundle = root / BUNDLE_NAME
    if (bundle / "model_index.json").is_file():
        return bundle
    if (root / "model_index.json").is_file():
        return root
    return bundle


def transformer_file(root, base_dir=None, name=None):
    base_dir = model_directory(root) if base_dir is None else Path(base_dir)
    name = selected_transformer() if name is None else name
    return base_dir / name


def upscaler_file(root, upscaler_id):
    names = {"compact2x": UPSCALE_NAME, "spanv2x4": SPAN_UPSCALE_NAME}
    if upscaler_id not in names:
        raise ValueError("The upscaler is not supported.")
    return Path(root).expanduser().resolve() / "upscalers" / names[upscaler_id]


def upscaler_is_valid(path, upscaler_id):
    if not path.is_file():
        return False
    if upscaler_id == "compact2x":
        return path.stat().st_size == UPSCALE_SIZE
    if upscaler_id == "spanv2x4":
        if path.stat().st_size != SPAN_UPSCALE_SIZE:
            return False
        return hashlib.sha256(path.read_bytes()).hexdigest() == SPAN_UPSCALE_SHA256
    return False


def _valid_file(path, relative):
    if not path.is_file():
        return False
    expected_size = FILE_SIZES.get(relative)
    return expected_size is None or path.stat().st_size == expected_size


def missing_files(root):
    root = Path(root).expanduser().resolve()
    base = model_directory(root)
    precision_file = selected_transformer()
    transformer = transformer_file(root, base, precision_file)
    missing = []
    for relative in (*PIPELINE_FILES, precision_file):
        if relative == precision_file:
            if not _valid_file(transformer, relative):
                missing.append(relative)
        elif not _valid_file(base / relative, relative):
            missing.append(relative)
    return base, transformer, missing


def _missing_bytes(missing):
    return sum(FILE_SIZES.get(name, 0) for name in missing)


def _setup_progress_options(prefix="RR_MODEL"):
    if os.environ.get("REALITY_RESTYLE_INSTALL_PROGRESS") != "1":
        return {}
    from tqdm import tqdm

    class SetupProgress(tqdm):
        def display(self, msg=None, pos=None):
            if self.unit == "B" and self.total and not self.desc.startswith("Downloading bytes"):
                print(f"{prefix} {int(self.n)} of {int(self.total)}", flush=True)

    return {"tqdm_class": SetupProgress}


def _download_model(root, missing):
    from huggingface_hub import snapshot_download

    target = model_directory(root)
    target.mkdir(parents=True, exist_ok=True)
    selected = list(dict.fromkeys(missing))
    if selected:
        snapshot_download(
            repo_id=MODEL_REPO,
            revision=MODEL_REVISION,
            local_dir=str(target),
            allow_patterns=selected,
            **_setup_progress_options(),
        )


def _wait_for_hub_access(exc, non_interactive=False):
    name = type(exc).__name__.lower()
    detail = str(exc).lower()
    gated = "gated" in name or "gated" in detail or "401" in detail or "403" in detail
    if not gated:
        raise exc
    print(f"Open {MODEL_URL} and approve access if Hugging Face requests it.")
    webbrowser.open(MODEL_URL)
    if non_interactive or not sys.stdin.isatty():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None,
                "Complete any access approval in the browser, then select OK to retry with a saved Hugging Face token.",
                "Reality Restyling Setup",
                0x40,
            )
        except Exception:
            pass
        from huggingface_hub import get_token
        if not get_token():
            webbrowser.open("https://huggingface.co/settings/tokens")
            raise RuntimeError("Hugging Face authentication needs setup. Save a read token on this computer, then run setup again.") from exc
        return
    input("Press Enter after approval or login to retry the download. ")
    from huggingface_hub import get_token

    if not get_token():
        print("Hugging Face requires a local account token for this download.")
        webbrowser.open("https://huggingface.co/settings/tokens")
        cli = Path(sys.executable).parent / "hf.exe"
        if not cli.is_file():
            raise RuntimeError("Install a read token with `hf auth login`, then run RealityRestylingSetup.exe again.") from exc
        subprocess.run([str(cli), "auth", "login"], check=True)


def download_model(root, missing, non_interactive=False):
    try:
        _download_model(root, missing)
    except Exception as exc:
        _wait_for_hub_access(exc, non_interactive)
        _download_model(root, missing)


def download_upscaler(root, upscaler_id):
    destination = upscaler_file(root, upscaler_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if upscaler_is_valid(destination, upscaler_id):
        return destination
    if upscaler_id == "compact2x":
        from huggingface_hub import hf_hub_download
        hf_hub_download(
            repo_id=UPSCALE_REPO,
            filename=UPSCALE_NAME,
            revision=UPSCALE_REVISION,
            local_dir=str(destination.parent),
            **_setup_progress_options(),
        )
        if not upscaler_is_valid(destination, upscaler_id):
            raise RuntimeError("The Compact 2x file is incomplete.")
        return destination
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=f".{destination.name}.", suffix=".partial", delete=False) as temporary:
        partial = Path(temporary.name)
    digest = hashlib.sha256()
    received = 0
    try:
        request = urllib.request.Request(SPAN_CHECKPOINT_URL, headers={"User-Agent": "RealityRestylingSetup"})
        with urllib.request.urlopen(request, timeout=30) as response, partial.open("wb") as output:
            total = int(response.headers.get("Content-Length") or SPAN_UPSCALE_SIZE)
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if os.environ.get("REALITY_RESTYLE_INSTALL_PROGRESS") == "1":
                    print(f"RR_MODEL {received} of {total}", flush=True)
        if received != SPAN_UPSCALE_SIZE or digest.hexdigest() != SPAN_UPSCALE_SHA256:
            raise RuntimeError("The SPANV2 checkpoint failed verification.")
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-upscaler", action="store_true")
    parser.add_argument("--download-required", action="store_true")
    parser.add_argument("--download-upscaler", action="store_true")
    parser.add_argument("--upscaler-id", choices=UPSCALERS, default=os.environ.get("REALITY_RESTYLE_UPSCALER_ID", "spanv2x4"))
    parser.add_argument("--non-interactive-auth", action="store_true")
    args = parser.parse_args()
    root = normalize_root(args.root)
    base = model_directory(root)
    missing = []
    if args.check or args.download_required:
        base, _, missing = missing_files(root)
    if args.check:
        if missing:
            print("Missing or invalid model files:")
            for name in missing:
                print(f"  {name}")
            size = _missing_bytes(missing)
            if size:
                print(f"Additional download: about {size / 1_000_000_000:.1f} GB")
            return 2
        print(f"Model files ready: {base}")
    if args.download_required and missing:
        size = _missing_bytes(missing)
        if size:
            print(f"Downloading about {size / 1_000_000_000:.1f} GB of missing model files.")
        download_model(root, missing, args.non_interactive_auth)
        base, _, missing = missing_files(root)
        if missing:
            raise RuntimeError("Model download is incomplete: " + ", ".join(missing))
        print(f"Model files ready: {base}")
    if args.check_upscaler:
        path = upscaler_file(root, args.upscaler_id)
        if not upscaler_is_valid(path, args.upscaler_id):
            print(f"{args.upscaler_id} is missing or invalid.")
            return 2
    if args.download_upscaler:
        path = download_upscaler(root, args.upscaler_id)
        print(f"{args.upscaler_id} ready: {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Setup cancelled.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"Model setup failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
