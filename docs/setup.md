# Setup

## First launch

1. Run `RealityRestylingSetup.exe`.
2. If Python 3.11 is missing, setup installs it with winget.
3. Choose whether you already have the model, want it downloaded, or want to add it later. Existing files can be selected with the folder picker. Downloads resume if interrupted.
4. Compact 2x downloads automatically when absent.
5. Launch **Reality Restyling** and select **Open app**. From a source checkout, run `run.bat` and open [localhost:8781](http://127.0.0.1:8781/).

Model files come from [FLUX.2 Klein 9B Nunchaku](https://huggingface.co/tonera/FLUX.2-klein-9B-Nunchaku) and are stored outside the application folder. The selected path is saved in `.runtime/models.path`. Compact 2x comes from [Phips/2xNomosUni_compact_multijpg](https://huggingface.co/Phips/2xNomosUni_compact_multijpg). To add it later, run the installer again.

Uninstall removes the generated Python environment and runtime files. Model files remain in their selected folder; Python and Tailscale are not removed.

## Phone access

1. Install [Tailscale](https://tailscale.com/download) on the PC and phone. Sign in to the same tailnet.
2. Give the PC a generic name in Tailscale. HTTPS certificate issuance publishes its full Tailscale hostname in a permanent public log.
3. Enable **MagicDNS** and **HTTPS Certificates** in [Tailscale Admin → DNS](https://login.tailscale.com/admin/dns).
4. To switch modes, close the server console window for the current session. Restart **Reality Restyling** and select **Phone access**, or run `run.bat -PhoneAccess` from source.
5. Confirm the hostname, then scan the terminal QR code or open the phone link.

If Hugging Face requests model access, approve it on the opened page. The installer retries with a locally saved Hugging Face token. If needed, save a read token and rerun the installer.

Anyone allowed by your tailnet policy to reach port 8781 can control the app and submit camera frames. Restrict access to trusted devices.

## Troubleshooting

- `Required files are missing or invalid`: run the installer again and select or download the model files.
- `Runtime module unavailable`: run the installer again to repair the local Python environment.
- Tailscale HTTPS startup error: enable HTTPS Certificates in Tailscale Admin → DNS, then restart Reality Restyling.
- Phone camera access: allow camera access in the browser when prompted.
