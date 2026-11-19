# Release

Set `version.txt` to the release version, commit it, and push the matching `v` tag. GitHub builds the installer and checksum and attaches both to the release.

The repository must be public for installed clients to check releases without credentials. The launcher checks the stable GitHub release on startup. The first update-capable installer must be installed manually; later updates prompt in the launcher.
