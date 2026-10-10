#!/usr/bin/env python3
"""Preview local build cleanup; use --apply after a successful paired release."""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


CACHES = (
    "rust/target", "macos/.build", "build/swift-cache", "build/swift-module-cache",
)
ARCHIVE = re.compile(r"Morrow-Mail-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-(?:macos-arm64|windows-x64)\.(?:zip|dmg)")
KEEP_SECONDS = 7 * 24 * 60 * 60
BUILD_PROCESSES = {
    "cargo", "rustc", "swift", "swift-build", "swift-frontend", "xcodebuild",
    "morrow-build", "morrow-native-check", "morrow-publish",
}


def real_path(root, path):
    """Reject linked ancestors as well as linked cleanup targets."""
    return path != root and root in path.parents and not any(
        part.is_symlink() for part in (path, *path.parents)
    )


def private_file(name):
    return (name in ("encryption.key", "settings.json", ".env", "genmail.db", ".git")
            or name.startswith(".env.") or ".sqlite" in name)


def scan_error(error):
    raise error


def files_in(path):
    if path.is_file():
        yield path
        return
    for directory, dirs, files in os.walk(path, followlinks=False, onerror=scan_error):
        base = Path(directory)
        # Private workspaces are not disposable, even inside generated output.
        if any(name in dirs for name in (".git", "backups")):
            raise ValueError("contains a workspace or backups")
        dirs[:] = [name for name in dirs if not (base / name).is_symlink()]
        for name in files:
            if private_file(name):
                raise ValueError("contains private workspace files")
            item = base / name
            if not item.is_symlink():
                yield item


def candidates(root):
    for name in CACHES:
        path = root / name
        if real_path(root, path) and path.is_dir():
            yield path, False
    for name in ("build", "test-results", "dist"):
        parent = root / name
        if not real_path(root, parent) or not parent.is_dir():
            continue
        for child in sorted(parent.iterdir()):
            if not real_path(root, child):
                continue
            if name == "dist" and child.is_file() and ARCHIVE.fullmatch(child.name):
                yield child, True
            if not child.is_dir() or not (
                child.name in ("release", "releases")
                or child.name.startswith("release-")
            ):
                continue
            for directory, dirs, files in os.walk(child, followlinks=False, onerror=scan_error):
                base = Path(directory)
                if ".git" in dirs or any(private_file(filename) for filename in files):
                    dirs.clear()
                    continue
                dirs[:] = [d for d in dirs if not (base / d).is_symlink()
                           and d not in ("data", "backups", ".git", "workspace")]
                if "Morrow Mail.app" in dirs:
                    yield base / "Morrow Mail.app", True
                    dirs.remove("Morrow Mail.app")
                for filename in sorted(files):
                    path = base / filename
                    if not path.is_symlink() and ARCHIVE.fullmatch(filename):
                        yield path, True


def plan(root, now):
    tracked = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "-z"],
    ).decode().split("\0")
    tracked = [root / name for name in tracked if name]
    result = []
    for path, age_limit in candidates(root):
        if any(path == item or path in item.parents for item in tracked):
            raise ValueError("Refusing tracked output: " + str(path.relative_to(root)))
        try:
            stats = [path.stat(), *(item.stat() for item in files_in(path))]
        except ValueError as error:
            print("KEEP {}: {}".format(path.relative_to(root), error))
            continue
        if age_limit and max(item.st_mtime for item in stats) > now - KEEP_SECONDS:
            continue
        # Allocated bytes are only an estimate on APFS with snapshots/clones.
        size = sum(item.st_blocks * 512 for item in stats[1:])
        result.append((path, size))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="delete the listed local outputs")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if not (root / "rust/Cargo.toml").is_file() or not (root / "package.json").is_file():
        raise ValueError("Run the script from a Morrow Mail source checkout.")
    git_root = Path(subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True,
    ).strip()).resolve()
    if git_root != root:
        raise ValueError("Refusing cleanup inside an unrelated parent repository.")
    items = plan(root, time.time())
    if args.apply:
        # shortcut: this is not a shared build lock; stop all builds/tests before --apply.
        processes = subprocess.check_output(["ps", "-axo", "comm="], text=True)
        if any(Path(line.strip()).name in BUILD_PROCESSES
               or any(line.strip().startswith(str(path) + "/") for path, _ in items)
               for line in processes.splitlines()):
            raise ValueError("A build/check/publisher is running. Stop it before cleanup.")
    for path, size in items:
        print("{} {:8.1f} MiB  {}".format(
            "DELETE" if args.apply else "WOULD DELETE", size / 1024**2, path.relative_to(root),
        ), flush=True)
        if args.apply:
            if not real_path(root, path):
                raise ValueError("Cleanup path changed; stopping.")
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    print("{} item(s), estimated {:.2f} GiB {}.".format(
        len(items), sum(size for _, size in items) / 1024**3,
        "removed" if args.apply else "eligible",
    ))
    if not args.apply:
        print("Preview only. After verifying the paired release, stop builds/tests and rerun with --apply.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("Cleanup stopped: {}".format(error), file=sys.stderr)
        sys.exit(1)
