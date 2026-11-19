import argparse
import hashlib
import os
import stat
import subprocess
from pathlib import Path


REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
WHEEL_HASH = "4cbe71d71c49590728b208ecdb9fc22e405c582def53deb6cca9cd396e598da4"
TARGETS = {
    "venv": Path(".venv"),
    "cache": Path(".runtime") / "cache",
    "wheels": Path(".runtime") / "wheels",
    "setup-marker": Path(".runtime") / "setup.env",
    "setup-pending": Path(".runtime") / "setup.pending",
}


def _is_reparse_point(path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, "st_file_attributes", 0) & REPARSE_POINT)


def _validate_root(root):
    root = Path(os.path.abspath(root))
    current = Path(root.anchor)
    if _is_reparse_point(current):
        raise RuntimeError(f"Refusing to use a redirected app folder: {current}")
    for part in root.parts[1:]:
        current = current / part
        if _is_reparse_point(current):
            raise RuntimeError(f"Refusing to use a redirected app folder: {current}")
    if not root.is_dir():
        raise RuntimeError(f"The app folder is missing: {root}")
    return root


def _validate_target(root, relative):
    target = root / relative
    current = root
    for part in relative.parts:
        current = current / part
        if _is_reparse_point(current):
            raise RuntimeError(f"Refusing to remove a reparse point: {current}")
    if os.path.commonpath((os.path.abspath(root), os.path.abspath(target))) != os.path.abspath(root):
        raise RuntimeError(f"Refusing to remove a path outside the app folder: {target}")
    return target


def _remove_tree(target):
    if not target.is_dir():
        target.unlink()
        return
    pending = [(target, False)]
    while pending:
        directory, visited = pending.pop()
        if visited:
            os.rmdir(directory)
            continue
        pending.append((directory, True))
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                if _is_reparse_point(path):
                    if entry.is_dir(follow_symlinks=False):
                        os.rmdir(path)
                    else:
                        os.unlink(path)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append((path, False))
                else:
                    os.unlink(path)


def check(root, names):
    root = _validate_root(root)
    for name in names:
        _validate_target(root, TARGETS[name])


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _expected_setup_marker(root):
    return (
        f"setup-v3;python={_sha256(root / 'python' / 'python311.dll').upper()};"
        f"torch=2.14.1;torchvision=0.29.1;cuda=13.0;nunchaku=1.4.1;wheel={WHEEL_HASH};"
        f"requirements={_sha256(root / 'requirements.txt').upper()};setup={_sha256(root / 'setup.ps1').upper()}"
    )


def verify_ready(root):
    root = _validate_root(root)
    check(root, ("venv", "cache", "wheels", "setup-marker", "setup-pending"))
    bundled_python = root / "python" / "python.exe"
    python_dll = root / "python" / "python311.dll"
    venv_python = root / ".venv" / "Scripts" / "python.exe"
    marker = root / ".runtime" / "setup.env"
    pending = root / ".runtime" / "setup.pending"
    configuration = root / ".venv" / "pyvenv.cfg"
    for path in (bundled_python, python_dll, venv_python, configuration, marker):
        if not path.is_file():
            raise RuntimeError(f"The installed app runtime is incomplete: {path.name} is missing")
    config_text = configuration.read_text(encoding="utf-8")
    home = next((line.split("=", 1)[1].strip() for line in config_text.splitlines() if line.lower().startswith("home") and "=" in line), "")
    expected_home = os.path.normcase(os.path.abspath(bundled_python.parent))
    actual_home = os.path.normcase(os.path.abspath(home)) if home else ""
    if actual_home != expected_home or any(line.strip().lower() == "include-system-site-packages = true" for line in config_text.splitlines()):
        raise RuntimeError("The app environment does not use its bundled Python")
    if marker.read_text(encoding="utf-8").strip() != _expected_setup_marker(root):
        raise RuntimeError("The installed app runtime is outdated or incomplete")
    if pending.exists():
        raise RuntimeError("Runtime setup did not finish")
    result = subprocess.run(
        [str(venv_python), "-B", "-c", "import sys; assert sys.version_info[:2] == (3, 11)"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("The app environment cannot start its bundled Python")


def remove(root, names):
    root = _validate_root(root)
    targets = [_validate_target(root, TARGETS[name]) for name in names]
    for target in targets:
        if not os.path.lexists(target):
            continue
        if target.is_dir():
            _remove_tree(target)
        else:
            target.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--check", action="append", choices=sorted(TARGETS), default=[])
    parser.add_argument("--remove", action="append", choices=sorted(TARGETS), default=[])
    parser.add_argument("--verify-ready", action="store_true")
    args = parser.parse_args()
    if not args.check and not args.remove and not args.verify_ready:
        parser.error("Specify --verify-ready, --check, or --remove.")
    if args.verify_ready:
        verify_ready(args.root)
    if args.check:
        check(args.root, args.check)
    if args.remove:
        remove(args.root, args.remove)


if __name__ == "__main__":
    main()
