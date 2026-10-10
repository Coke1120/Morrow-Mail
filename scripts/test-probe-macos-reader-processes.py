#!/usr/bin/env python3
"""Regression checks for metadata redaction, identity filtering and bounded tools."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("reader_probe", Path(__file__).with_name("probe-macos-reader-processes.py"))
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class ReaderProbeTests(unittest.TestCase):
    def test_procinfo_never_exports_raw_values_or_unknown_fields(self):
        raw = (b"unknown-secret-label = hidden-secret-value\n"
               b"responsible pid = 1234567\nresponsible unique pid = 987654321\n"
               b"args = fake\n  uid = 9001\n")
        shape, transient = PROBE.procinfo_shapes(raw)
        report = {"shape": shape, "observations": PROBE.comparisons(transient, 1234567, 1234567, 987654321)}
        encoded = json.dumps(report)
        for forbidden in ("unknown-secret", "hidden-secret", "1234567", "987654321", "9001", "args", "fake"):
            self.assertNotIn(forbidden, encoded)
        self.assertTrue(report["observations"]["responsiblePidMatchesReader"])
        self.assertFalse(report["observations"]["comparisonIsOwnershipProof"])
        self.assertEqual(shape["unknownLineCount"], 2)

    def test_duplicates_overflow_and_partial_fields_cannot_compare(self):
        shape, transient = PROBE.procinfo_shapes(
            b"responsible pid = 12\nresponsible pid = 12\n"
            b"unique pid = 18446744073709551616\n"
            b"prefix responsible unique pid = 91\npid = 12 suffix\n"
        )
        self.assertEqual(shape["fields"]["responsible pid"]["count"], 2)
        self.assertFalse(shape["fields"]["responsible pid"]["singleUnsigned64"])
        self.assertEqual(shape["invalidUnsignedCount"], 1)
        self.assertEqual(transient, {})
        self.assertIsNone(PROBE.comparisons(transient, 12, 12, None)["responsiblePidMatchesReader"])

    def test_candidate_requires_newer_start_same_uid_and_exact_path(self):
        reader = {"uid": 501, "startSeconds": 100, "startMicroseconds": 20}
        candidate = {"uid": 501, "startSeconds": 100, "startMicroseconds": 21,
                     "executablePath": "/System/exact-WebContent"}
        paths = {"/System/exact-WebContent"}
        self.assertTrue(PROBE.eligible_candidate(candidate, reader, paths))
        for change in ({"uid": 502}, {"startSeconds": 99}, {"startMicroseconds": 20},
                       {"executablePath": "/tmp/exact-WebContent"}):
            self.assertFalse(PROBE.eligible_candidate(dict(candidate, **change), reader, paths))

    def test_public_reader_identity_does_not_export_arbitrary_path(self):
        exported = PROBE.public_identity({"pid": 2, "executablePath": "/private/secret-reader-name"}, True)
        self.assertNotIn("secret-reader-name", json.dumps(exported))
        self.assertEqual(len(exported["executablePathSha256"]), 64)

    def test_preflight_only_queries_unique_new_candidate_without_privileged_metadata(self):
        reader = {"pid": 10, "uid": 501, "parentPid": 1, "startSeconds": 100,
                  "startMicroseconds": 20, "executablePath": "/tmp/reader-checks"}
        candidate = dict(reader, pid=11, startMicroseconds=21, executablePath=os.path.realpath(PROBE.WEB_CONTENT))
        other = dict(candidate, pid=12)
        identities = {10: reader, 11: candidate, 12: other}
        metadata = mock.Mock()
        metadata.identity.side_effect = identities.get
        for candidate_count in (1, 2):
            calls = []

            def tool(arguments, _deadline, _timeout=0.8):
                calls.append(arguments)
                info = {"exitCode": 0, "timedOut": False, "truncated": False, "spawnFailed": False, "reaped": True}
                if arguments[0] == "/bin/ps":
                    raw = b"11 501 com.apple.WebKit.WebContent\n"
                    if candidate_count == 2:
                        raw += b"12 501 com.apple.WebKit.WebContent\n"
                elif arguments[0] == "/bin/launchctl":
                    raw = b"unique pid = 101\nresponsible pid = 10\nresponsible unique pid = 101\n"
                else:
                    raw = b"Xcode 16.2\nBuild version 16C5032a\n"
                return info, raw

            with (mock.patch.object(PROBE.sys, "platform", "darwin"),
                  mock.patch.object(PROBE, "ProcessMetadata", return_value=metadata),
                  mock.patch.object(PROBE.os, "getuid", return_value=501),
                  mock.patch.object(PROBE, "fixed_plist_versions", return_value={"available": False}),
                  mock.patch.object(PROBE, "run_tool", side_effect=tool)):
                result = PROBE.collect(10, time.monotonic() + 10)
            self.assertEqual(result["ownershipStatus"], "unresolved")
            self.assertFalse(result["attachmentAttempted"])
            self.assertEqual(result["candidateCount"], candidate_count)
            sudo_calls = [call for call in calls if call[0] == "/usr/bin/sudo"]
            self.assertEqual(sudo_calls, [["/usr/bin/sudo", "-n", "-T", "1", "/usr/bin/true"]])
            queried = [call[-1] for call in calls if call[0] == "/bin/launchctl"]
            self.assertEqual(queried, ["10", "11"] if candidate_count == 1 else ["10"])
            if candidate_count == 2:
                self.assertEqual(result["reason"], "candidate-limit")

    def test_permission_categories_disambiguate_without_exporting_text(self):
        cases = (
            (b"private-value: procinfo requires root privileges", "requires-root", False),
            (b"private-value: Permission denied", "permission-denied", False),
            (b"requires root; Operation not permitted", "multiple-permission-diagnostics", False),
            (b"sudo: sorry, you are not allowed set a command timeout", "none", True),
            (b"sudo: sorry, you are not allowed to set a command timeout", "none", True),
            (b"unknown private-value", "none", False),
        )
        for raw, category, rejected in cases:
            with self.subTest(category=category, rejected=rejected):
                result = PROBE.diagnostic_categories(raw)
                self.assertEqual(result["permissionDiagnosticCategory"], category)
                self.assertEqual(result["commandTimeoutPolicyRejected"], rejected)
                self.assertNotIn("private-value", json.dumps(result))

    def test_sudo_capability_is_fixed_true_only_and_not_query_authorization(self):
        valid = {"exitCode": 0, "reaped": True, "timedOut": False, "truncated": False,
                 "spawnFailed": False, "commandTimeoutPolicyRejected": False}
        cases = (
            ({}, "accepted-fixed-true"),
            ({"exitCode": 1, "commandTimeoutPolicyRejected": True}, "timeout-policy-rejected"),
            ({"timedOut": True}, "inconclusive"),
            ({"truncated": True}, "inconclusive"),
            ({"reaped": False}, "inconclusive"),
            ({"spawnFailed": True}, "inconclusive"),
            ({"exitCode": 1}, "inconclusive"),
        )
        for change, expected in cases:
            with (self.subTest(change=change), mock.patch.object(PROBE.time, "monotonic", return_value=100),
                  mock.patch.object(PROBE, "run_tool", return_value=(dict(valid, **change), b"")) as tool):
                result = PROBE.sudo_timeout_true_capability(104)
                self.assertEqual(result["status"], expected)
                self.assertFalse(result["metadataQueryAuthorized"])
                self.assertFalse(result["samplingAuthorized"])
                self.assertEqual(result["scope"], "fixed-true-command-only")
                tool.assert_called_once_with(["/usr/bin/sudo", "-n", "-T", "1", "/usr/bin/true"], 104, 3.25)

    def test_sudo_capability_skips_insufficient_budget_and_propagates_cancel(self):
        with (mock.patch.object(PROBE.time, "monotonic", return_value=100),
              mock.patch.object(PROBE, "run_tool") as tool):
            result = PROBE.sudo_timeout_true_capability(103.49)
            self.assertFalse(result["attempted"])
            self.assertEqual(result["status"], "not-attempted-budget")
            tool.assert_not_called()
        with (mock.patch.object(PROBE.time, "monotonic", return_value=100),
              mock.patch.object(PROBE, "run_tool", side_effect=PROBE.ProbeCancelled)):
            with self.assertRaises(PROBE.ProbeCancelled):
                PROBE.sudo_timeout_true_capability(104)

    def test_report_never_overwrites_files_or_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            PROBE.write_exclusive(path, {"fixed": True})
            self.assertEqual(json.loads(path.read_text()), {"fixed": True})
            with self.assertRaises(FileExistsError):
                PROBE.write_exclusive(path, {"replacement": True})
            link = Path(directory) / "link.json"
            link.symlink_to(Path(directory) / "nonexistent.json")
            with self.assertRaises(FileExistsError):
                PROBE.write_exclusive(link, {"replacement": True})
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_subprocess_output_limit_kills_and_reaps(self):
        info, raw = PROBE.run_tool(
            [sys.executable, "-c", "import os; os.write(1, b'x' * 200000)"],
            time.monotonic() + 3, 2,
        )
        self.assertTrue(info["truncated"])
        self.assertLessEqual(len(raw), PROBE.CAPTURE_LIMIT)
        self.assertIsNotNone(info["exitCode"])
        self.assertIsNone(PROBE._ACTIVE_CHILD)

    def test_subprocess_deadline_kills_and_reaps(self):
        started = time.monotonic()
        info, _raw = PROBE.run_tool(
            [sys.executable, "-c", "import time; time.sleep(60)"], started + 0.1, 0.1,
        )
        self.assertTrue(info["timedOut"])
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(info["exitCode"])
        self.assertIsNone(PROBE._ACTIVE_CHILD)


if __name__ == "__main__":
    unittest.main()
