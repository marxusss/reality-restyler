# Setup

## Requirements

- Windows 11
- Python 3.11
- CUDA-capable NVIDIA GPU
- Tailscale on the PC and phone

## Model files

Download the files linked in the [README](../README.md#model-files) and place each at its listed path under `models/`.

## Tailscale

1. Sign in to Tailscale on the PC and phone using the same tailnet.
2. In the Tailscale admin console, open **DNS** and enable **MagicDNS**.
3. Enable **HTTPS Certificates**. Device and tailnet DNS names are recorded in the public Certificate Transparency log; choose names accordingly.
4. Run `run.bat` from this folder and open `https://<host>.ts.net:8781` on the phone.

## Troubleshooting

- `Required model files are missing or invalid`: check the filenames and paths in `models/`.
- `Runtime module unavailable`: run `run.bat` again to repair the local Python environment.
- `Tailscale certificate unavailable`: check the tailnet HTTPS Certificates setting. Without a valid certificate, remote browsers may reject the fallback certificate.
