#!/usr/bin/env python3
"""Portable boundary checks; the root runner executes these, not the fixture."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("probe-macos-instruments.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Boundaries(unittest.TestCase):
    def setUp(self):
        probe._CANCELLED = False

    def exercise(self, body, cancel_after_spawn=False):
        original = subprocess.Popen
        children = []

        def spawn(_arguments, **options):
            child = original([sys.executable, "-I", "-B", "-c", body], **options)
            children.append(child)
            if cancel_after_spawn:
                probe.cancel(signal.SIGTERM, None)
            return child

        with patch.object(probe.subprocess, "Popen", side_effect=spawn), patch.object(probe, "COMMAND_SECONDS", 0.15):
            record, streams = probe.run_command("help", time.monotonic() + 1)
        self.assertTrue(record["reaped"])
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.killpg(children[0].pid, 0)
        return record, streams

    def test_timeout_and_cancel_reap_owned_command(self):
        for cancelled, outcome in ((False, "timeout"), (True, "cancelled")):
            with self.subTest(cancelled=cancelled):
                probe._CANCELLED = False
                record, _ = self.exercise("import time; time.sleep(30)", cancelled)
                self.assertEqual(record["outcome"], outcome)
                self.assertFalse(record["captureComplete"])

    def test_oversize_cancels_and_caps_capture(self):
        record, streams = self.exercise("import os,time; os.write(1,b'x'*200000); time.sleep(30)")
        self.assertEqual(record["outcome"], "output-limit")
        self.assertTrue(record["stdoutTruncated"])
        self.assertEqual(len(streams["stdout"]), probe.CAPTURE_LIMIT)

    def test_no_recording_or_arbitrary_command_boundary(self):
        with patch.object(probe.subprocess, "Popen") as spawn:
            for name in ("record", "attach", "launch", "sudo", "export", "list-devices", "/bin/sh"):
                with self.assertRaises(KeyError):
                    probe.run_command(name, time.monotonic() + 1)
            spawn.assert_not_called()
        for arguments in probe.COMMANDS.values():
            if arguments[:2] == ("/usr/bin/xcrun", "xctrace"):
                self.assertIn(arguments[2], ("help", "version", "list"))
                if arguments[2] == "list":
                    self.assertEqual(arguments[3:], ("templates",))
        with patch.dict(os.environ, {"SECRET_TEST_TOKEN": "never-export", "DEVELOPER_DIR": "/outside"}):
            self.assertNotIn("SECRET_TEST_TOKEN", probe.tool_environment())
            self.assertNotIn("DEVELOPER_DIR", probe.tool_environment())

    def test_capability_log_round_trip_cannot_become_workflow_command(self):
        raw = b"##[error]literal help\n::error::more help\r\n# heading"
        line = probe.capability_text("help-record", "stderr", raw)
        prefix = "Instruments capability text: "
        self.assertTrue(line.startswith(prefix))
        self.assertNotIn("##[", line)
        self.assertNotIn("\n", line)
        self.assertNotIn("\r", line)
        self.assertEqual(json.loads(line[len(prefix):]),
                         {"name": "help-record", "stream": "stderr", "text": raw.decode()})

    def test_manual_symlink_cannot_escape_confirmed_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "Xcode.app"
            developer = bundle / "Contents/Developer"
            manual = developer / "usr/share/man/man1/xctrace.1"
            manual.parent.mkdir(parents=True)
            outside = root / "outside"
            outside.write_text("must not be read")
            manual.symlink_to(outside)
            with patch.object(probe.subprocess, "Popen") as spawn:
                record, _ = probe.run_command("installed-manual", time.monotonic() + 1,
                                              (developer, bundle))
                self.assertEqual(record["outcome"], "path-outside-confirmed-xcode")
                spawn.assert_not_called()

    def test_cancel_after_pipe_eof_reaps_without_waiting_full_command_budget(self):
        original = subprocess.Popen
        children = []
        timers = []

        def spawn(_arguments, **options):
            child = original([sys.executable, "-I", "-B", "-c",
                              "import os,time; os.close(1); os.close(2); time.sleep(30)"], **options)
            children.append(child)
            timer = threading.Timer(0.2, lambda: probe.cancel(signal.SIGTERM, None))
            timer.start()
            timers.append(timer)
            return child

        started = time.monotonic()
        try:
            with patch.object(probe.subprocess, "Popen", side_effect=spawn):
                record, _ = probe.run_command("help", started + 4)
            self.assertEqual(record["outcome"], "cancelled")
            self.assertTrue(record["reaped"])
            self.assertLess(time.monotonic() - started, 2)
            self.assertIsNotNone(children[0].returncode)
        finally:
            for timer in timers:
                timer.cancel()
                timer.join()

    def test_late_cancellation_cannot_report_success(self):
        def collect(name, _deadline, _manual_paths=None):
            if name == "installed-manual":
                probe.cancel(signal.SIGTERM, None)
            return {"name": name, "outcome": "exited", "captureComplete": True}, {"stdout": b"", "stderr": b""}

        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(probe, "run_command", side_effect=collect), patch("builtins.print"):
                self.assertEqual(probe.probe(Path(temporary)), 130)


if __name__ == "__main__":
    unittest.main()
