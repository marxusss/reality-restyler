# Reality Restyling

## Setup

- Windows 11, an NVIDIA GPU, and Tailscale on the PC and phone.
- Run `run.bat`. Setup installs the runtime, reuses or downloads model files, and prints the phone link and QR code.
- [FLUX.2 Klein 9B Nunchaku](https://huggingface.co/tonera/FLUX.2-klein-9B-Nunchaku) · [Compact 2x](https://huggingface.co/Phips/2xNomosUni_compact_multijpg)
- [Setup guide](docs/setup.md)

## Tailscale

- Sign in to the same tailnet on both devices.
- In Tailscale Admin → DNS, enable MagicDNS and HTTPS Certificates. Device and tailnet DNS names enter the public Certificate Transparency log.

Obtain separate rights before using the 9B model for commercial or production purposes.
