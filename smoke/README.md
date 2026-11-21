# Release smoke checks (opt-in)

The default CI runs fast unit/API tests and compiles the Windows installer. It does **not** download model weights, require CUDA, install Windows software, or connect to a phone.

- **GPU inference:** On a CUDA machine with an existing model installation, from the project's Python environment run `python smoke/gpu_inference.py --models PATH_TO_MODELS --output gpu-smoke-output.png`. Loads the actual model, renders one frame, and checks that it produces an image. No time limit or performance threshold. Upscaler is disabled to isolate core inference.
- **Windows installer:** On a **clean disposable Windows VM**, build the installer, then run `powershell -File smoke/installer.ps1 -Installer .\RealityRestylingSetup.exe`. This performs a real silent install (including its dependency setup), checks the installed app and imports the server. It may take a long time or require network access; it intentionally leaves the install in place for inspection. Never run on a machine with an existing install.
- **Updater check:** With an installed copy and internet connectivity, run `powershell -File smoke/updater_check.ps1 -InstallRoot "PATH_TO_INSTALLED_APP"`. Exercises the read-only release-check path; it never installs an update.

For a full release, manually verify the following in the browser and on a physical phone (not in CI):

1. Start, pause, resume, and unload the model. Confirm auto-unload occurs after an inactive *completed* startup, not during loading.
2. Open camera with only one available device; switch cameras when several exist; unplug/deny a camera and verify recovery.
3. Save a restyled photo, record a short video, and verify both files open.
4. Add, edit, delete, and synchronize a custom style across browser sessions.
5. Connect phone through Tailscale and confirm the browser can capture and display processed frames.
6. On a disposable Windows VM with an older version installed, perform an update and verify the app still launches and saved settings persist.

The browser UI, real GPU, Tailscale, and update-install paths remain *outside default CI*.
