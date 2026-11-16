# Reality Restyling

## Setup

- Windows 11, Python 3.11, a CUDA-capable NVIDIA GPU, and Tailscale on the PC and phone.
- Place the model files below, then run `run.bat`. The first launch installs the pinned Python runtime.
- [Setup guide](docs/setup.md)

## Model files

- [FLUX.2 Klein 9B](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B) → `models/FLUX.2-klein-9B/`
- [Nunchaku FP4 transformer](https://huggingface.co/tonera/FLUX.2-klein-9B-Nunchaku) → `models/FLUX.2-klein-9B-Nunchaku/svdq-fp4_r32-FLUX.2-klein-9B-Nunchaku.safetensors`
- Optional [Compact 2x](https://huggingface.co/Phips/2xNomosUni_compact_multijpg) → `models/upscalers/2xNomosUni_compact_multijpg.safetensors`
- Obtain separate rights before using the 9B model for commercial or production purposes.

## Tailscale

Sign in on the PC and phone to the same tailnet. In Tailscale Admin → DNS, enable MagicDNS and HTTPS Certificates, then open `https://<host>.ts.net:8781`.

## Run

```powershell
run.bat
```
