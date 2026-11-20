import argparse
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_ROOT = Path(os.environ.get("REALITY_RESTYLE_MODELS_DIR", ROOT / "models")).expanduser()
MODEL_REPO = "tonera/FLUX.2-klein-9B-Nunchaku"
MODEL_URL = f"https://huggingface.co/{MODEL_REPO}"
MODEL_REVISION = "d76d4d72c17b5a48f795c9ee1680c5ea97c77435"
UPSCALE_REPO = "Phips/2xNomosUni_compact_multijpg"
UPSCALE_REVISION = "4774921957bcbd222e7e4861728b02ebb3502c31"
BUNDLE_NAME = "FLUX.2-klein-9B-Nunchaku"
TRANSFORMER_NAME = "svdq-fp4_r32-FLUX.2-klein-9B-Nunchaku.safetensors"
UPSCALE_NAME = "2xNomosUni_compact_multijpg.safetensors"
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
    TRANSFORMER_NAME,
)
FILE_SIZES = {
    "text_encoder/model-00001-of-00004.safetensors": 4902257696,
    "text_encoder/model-00002-of-00004.safetensors": 4915960368,
    "text_encoder/model-00003-of-00004.safetensors": 4983068496,
    "text_encoder/model-00004-of-00004.safetensors": 1580230264,
    "vae/diffusion_pytorch_model.safetensors": 168120878,
    TRANSFORMER_NAME: 5800843496,
}
UPSCALE_SIZE = 1205456


def normalize_root(value):
    path = Path(value).expanduser().resolve()
    if path.name in {BUNDLE_NAME, "FLUX.2-klein-9B"}:
        return path.parent
    return path


def model_directory(root):
    root = Path(root).expanduser().resolve()
    candidates = (root / BUNDLE_NAME, root, root / "FLUX.2-klein-9B")
    for candidate in candidates:
        if (candidate / "model_index.json").is_file():
            return candidate
    return root / BUNDLE_NAME


def transformer_file(root, base_dir=None):
    root = Path(root).expanduser().resolve()
    base_dir = model_directory(root) if base_dir is None else Path(base_dir)
    candidates = (
        base_dir / TRANSFORMER_NAME,
        root / BUNDLE_NAME / TRANSFORMER_NAME,
        base_dir.parent / BUNDLE_NAME / TRANSFORMER_NAME,
    )
    for candidate in dict.fromkeys(candidates):
        if candidate.is_file():
            return candidate
    return base_dir / TRANSFORMER_NAME


def upscaler_file(root):
    return Path(root).expanduser().resolve() / "upscalers" / UPSCALE_NAME


def _valid_file(path, relative):
    if not path.is_file():
        return False
    expected_size = FILE_SIZES.get(relative)
    return expected_size is None or path.stat().st_size == expected_size


def missing_files(root):
    root = Path(root).expanduser().resolve()
    base = model_directory(root)
    transformer = transformer_file(root, base)
    missing = []
    for relative in PIPELINE_FILES:
        if relative == TRANSFORMER_NAME:
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


def download_upscaler(root):
    from huggingface_hub import hf_hub_download

    destination = upscaler_file(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and destination.stat().st_size == UPSCALE_SIZE:
        return destination
    hf_hub_download(
        repo_id=UPSCALE_REPO,
        filename=UPSCALE_NAME,
        revision=UPSCALE_REVISION,
        local_dir=str(destination.parent),
        **_setup_progress_options(),
    )
    if not destination.is_file() or destination.stat().st_size != UPSCALE_SIZE:
        raise RuntimeError("The Compact 2x file is incomplete.")
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-upscaler", action="store_true")
    parser.add_argument("--download-required", action="store_true")
    parser.add_argument("--download-upscaler", action="store_true")
    parser.add_argument("--non-interactive-auth", action="store_true")
    args = parser.parse_args()
    root = normalize_root(args.root)
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
        path = upscaler_file(root)
        if not path.is_file() or path.stat().st_size != UPSCALE_SIZE:
            print("Compact 2x is missing or invalid.")
            return 2
    if args.download_upscaler:
        path = download_upscaler(root)
        print(f"Compact 2x ready: {path}")
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
