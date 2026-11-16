# Setup

## First launch

1. Run `RealityRestylingSetup.exe`.
2. If Python 3.11 is missing, setup installs it with winget.
3. Choose whether you already have the model, want it downloaded, or want to add it later. Existing files can be selected with the folder picker. Downloads resume if interrupted.
4. Compact 2x downloads automatically when absent.
5. The installer can install Tailscale with winget and open sign-in.

Model files come from [FLUX.2 Klein 9B Nunchaku](https://huggingface.co/tonera/FLUX.2-klein-9B-Nunchaku) and are stored outside the application folder. The selected path is saved in `.runtime/models.path`. Compact 2x comes from [Phips/2xNomosUni_compact_multijpg](https://huggingface.co/Phips/2xNomosUni_compact_multijpg). To add it later, run the installer again.

## Tailscale

1. Sign in on the PC and phone to the same tailnet.
2. In [Tailscale Admin → DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**.
3. Device and tailnet DNS names enter the public Certificate Transparency log.
4. Run Reality Restyling and scan the printed QR code or open its phone link.

The app requests and renews the HTTPS certificate automatically. It does not store Tailscale or Hugging Face credentials. If Hugging Face requests model access, sign in and approve it on the opened model page, press Enter, then complete `hf auth login` if prompted.

## Troubleshooting

- `Required files are missing or invalid`: run the installer again and select or download the model files.
- `Runtime module unavailable`: run the installer again to repair the local Python environment.
- Tailscale HTTPS startup error: enable HTTPS Certificates in Tailscale Admin → DNS, then restart Reality Restyling.
- Phone camera access: allow camera access in the browser when prompted.
