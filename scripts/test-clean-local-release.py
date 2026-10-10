#!/usr/bin/env python3
"""Cleanup tests only create and delete isolated temporary fixture checkouts."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("clean-local-release.py")
spec = importlib.util.spec_from_file_location("cleanup", SCRIPT)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
ARCHIVE = "Morrow-Mail-0.7.0-macos-arm64.zip"


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.now = time.time()
        self.old = self.now - 8 * 24 * 60 * 60

    def file(self, name, old=True):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
        if old:
            os.utime(path, (self.old, self.old))
        return path

    def selected(self):
        return {path.relative_to(self.root).as_posix() for path, _ in cleanup.plan(self.root, self.now)}

    def test_scope_age_and_private_files(self):
        old = "build/release-old/" + ARCHIVE
        self.file(old)
        self.file("dist/" + ARCHIVE)
        self.file("build/release-new/" + ARCHIVE, old=False)
        self.file("test-results/release-old/report.json")
        self.file("test-results/release-old/screenshot.png")
        self.file("test-results/release-old/evidence.zip")
        self.file("build/release-old/data/" + ARCHIVE)
        self.file("build/release-old/owned-fixture/genmail.sqlite")
        self.file("build/release-old/owned-fixture/" + ARCHIVE)
        self.file("data/" + ARCHIVE)
        self.file("backups/" + ARCHIVE)
        self.file("build/installed-backup/" + ARCHIVE)
        self.file("build/macos-native/release/" + ARCHIVE)
        self.file("rust/target/debug/cache")
        self.file("macos/.build/encryption.key")
        self.assertEqual(self.selected(), {old, "dist/" + ARCHIVE, "rust/target"})

    def test_bundles_keep_recent_contents_and_private_workspaces(self):
        for name in ("old", "new", "private"):
            bundle = "test-results/release-{}/Morrow Mail.app".format(name)
            self.file(bundle + "/Contents/MacOS/MorrowMail", old=name != "new")
            if name == "private":
                self.file(bundle + "/data/genmail.sqlite")
            os.utime(self.root / bundle, (self.old, self.old))
        self.assertEqual(self.selected(), {"test-results/release-old/Morrow Mail.app"})

    def test_symlinks_and_tracked_files_are_not_deleted(self):
        outside = self.file("outside/" + ARCHIVE)
        (self.root / "dist").symlink_to(outside.parent, target_is_directory=True)
        self.file("build/release-old/keep.txt")
        (self.root / "build/release-old" / ARCHIVE).symlink_to(outside)
        (self.root / "build/release-linked").symlink_to(outside.parent, target_is_directory=True)
        (self.root / "rust").symlink_to(outside.parent, target_is_directory=True)
        self.assertEqual(self.selected(), set())
        tracked = self.file("build/release-old/" + ARCHIVE.replace("0.7.0", "0.6.0"))
        subprocess.run(["git", "-C", str(self.root), "add", str(tracked)], check=True)
        with self.assertRaisesRegex(ValueError, "tracked output"):
            self.selected()
        self.assertTrue(outside.exists())

    def test_preview_apply_and_busy_guard(self):
        self.file("rust/Cargo.toml")
        self.file("package.json")
        script = self.file("scripts/clean-local-release.py")
        old = self.file("build/release-old/" + ARCHIVE)
        cache = self.file("rust/target/debug/cache")
        report = self.file("build/release-old/report.json")
        with patch.object(cleanup, "__file__", str(script)):
            with patch.object(sys, "argv", [str(script)]):
                cleanup.main()
            self.assertTrue(old.exists())
            original = subprocess.check_output

            def output(command, **kwargs):
                return "/usr/bin/swift-build\n" if command[0] == "ps" else original(command, **kwargs)

            with patch.object(sys, "argv", [str(script), "--apply"]):
                with patch.object(subprocess, "check_output", side_effect=output):
                    with self.assertRaisesRegex(ValueError, "running"):
                        cleanup.main()
                self.assertTrue(old.exists())

                def idle(command, **kwargs):
                    return "/usr/bin/python3\n" if command[0] == "ps" else original(command, **kwargs)

                with patch.object(subprocess, "check_output", side_effect=idle):
                    cleanup.main()
                    cleanup.main()
            self.assertFalse(old.exists())
            self.assertFalse(cache.exists())
            self.assertTrue(report.exists())

    def test_running_extracted_app_blocks_cleanup(self):
        self.file("rust/Cargo.toml")
        self.file("package.json")
        script = self.file("scripts/clean-local-release.py")
        executable = self.file("build/release-old/Morrow Mail.app/Contents/MacOS/MorrowMail")
        bundle = self.root / "build/release-old/Morrow Mail.app"
        os.utime(bundle, (self.old, self.old))
        original = subprocess.check_output

        def output(command, **kwargs):
            return str(executable) + "\n" if command[0] == "ps" else original(command, **kwargs)

        with patch.object(cleanup, "__file__", str(script)):
            with patch.object(sys, "argv", [str(script), "--apply"]):
                with patch.object(subprocess, "check_output", side_effect=output):
                    with self.assertRaisesRegex(ValueError, "running"):
                        cleanup.main()
        self.assertTrue(executable.exists())

    def test_scan_errors_abort_before_deletion(self):
        cache = self.file("rust/target/debug/cache")

        def failed_walk(path, **kwargs):
            kwargs["onerror"](PermissionError("fixture unreadable directory"))

        with patch.object(os, "walk", side_effect=failed_walk):
            with self.assertRaises(PermissionError):
                self.selected()
        self.assertTrue(cache.exists())


if __name__ == "__main__":
    unittest.main()
