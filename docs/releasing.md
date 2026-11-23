# Release

Set `version.txt` to the release version, commit it, and push the matching annotated `v` tag with the release notes as its message. GitHub publishes those notes with the installer, SHA-256 checksum, and matching source archive.

The repository must be public for installed clients to check releases without credentials. The installed launcher checks stable GitHub releases; local checkouts run separately with `dev.ps1`. The first update-capable installer must be installed manually; later updates prompt in the launcher.
