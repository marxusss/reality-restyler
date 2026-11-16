# Setup

## First launch

1. Run `run.bat`.
2. If Python 3.11 is missing, setup offers to install it with winget.
3. If model files are missing, select an existing model folder or download the missing files. Downloads resume on the next launch.
4. Compact 2x downloads automatically when absent.
5. If Tailscale is missing, setup offers to install it with winget. If it is installed but signed out, setup opens Tailscale sign-in.

Model files come from [FLUX.2 Klein 9B Nunchaku](https://huggingface.co/tonera/FLUX.2-klein-9B-Nunchaku) and are stored outside Git in `models/`, or in the folder selected during setup. The selected path is saved in `.runtime/models.path`. Compact 2x comes from [Phips/2xNomosUni_compact_multijpg](https://huggingface.co/Phips/2xNomosUni_compact_multijpg). To add it later, run `run.bat -InstallUpscaler`.

## Tailscale

1. Sign in on the PC and phone to the same tailnet.
2. In [Tailscale Admin → DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**.
3. Device and tailnet DNS names enter the public Certificate Transparency log.
4. Run `run.bat` and scan the printed QR code or open its phone link.

The app requests and renews the HTTPS certificate automatically. It does not store Tailscale or Hugging Face credentials. If Hugging Face requests model access, sign in and approve it on the opened model page, press Enter, then complete `hf auth login` if prompted.

## Troubleshooting

- `Required files are missing or invalid`: rerun `run.bat` and accept the model download, or select the folder containing the existing files.
- `Runtime module unavailable`: rerun `run.bat` to repair the local Python environment.
- Tailscale HTTPS startup error: enable HTTPS Certificates in Tailscale Admin → DNS, then restart `run.bat`.
- Phone camera access: allow camera access in the browser when prompted.
