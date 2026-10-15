#!/usr/bin/env python3
"""Negative controls for evidence handling; these are not performance results."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("acceptance", Path(__file__).with_name("mailbox-acceptance.py"))
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)


def download(size):
    digest, body_bytes = acceptance.expected_download(size)
    return {"expectedMessages": size, "downloadedMessages": size, "verifiedBodies": size,
            "bodyBytes": body_bytes, "expectedSha256": digest, "actualSha256": digest, "duplicates": 0}


def protocol(size=1000):
    return {"schema": 1, "kind": "morrow-imap-acceptance", "status": "complete", "dataset": "imap-acceptance-v1", "result": {
        "size": size, "initialOwnerRows": 0, "seededOwnerRows": 0, "transport": "generated-trusted-loopback-tls",
        "download": download(size), "history": {"status": "complete", "pages": size // 50 + 1, "wallMs": 1,
            "disconnectPreservedCheckpoint": True, "restartPreservedCheckpoint": True},
        "newMail": {"expected": 120, "observed": 120, "bodyFetches": 120, "pages": 3, "wallMs": 1, "after": download(size + 120)},
        "flags": [{"enabled": enabled, "changedMessages": 4, "convergedMessages": 4, "rounds": 2,
                   "roundLimit": 3, "bodyFetches": 0, "wallMs": 1} for enabled in (True, False)],
        "reconnect": {"stalePageWrites": 0, "manualNewImportRequired": True, "sameOriginCachedRowsRetained": True,
                      "restartRetainedConnection": True}, "ownerIsolation": True, "providerWrites": 0}}


def native(system="macos"):
    return {"schema": 1, "kind": "morrow-native-mailbox-latency", "status": "complete", "platform": system,
        "measurement": "native-event-to-layout-display", "transport": "intercepted-fictional-only",
        "oracleControls": dict.fromkeys(acceptance.MAC_ORACLE_CONTROLS, True), "results": [
            {"size": size, "generatedRows": size, "pageSize": 50, "unexpectedRequests": 0, "ownerSelectionVerified": True,
             "samples": [{"action": action, "completion": "layout-and-display", "elapsedMs": 2,
                          "visibleRows": 8, "tableRows": 50, "ownerMatched": True, "renderedRowIdentityMatched": True,
                          "renderedReaderMatched": action == "select", "renderedSelectedRowIdentityMatched": action == "select",
                          "renderedReaderIdentityMatched": action == "select"} for action in acceptance.ACTIONS for _ in range(6)]}
            for size in acceptance.SIZES]}


def service(system="macos"):
    return {"status": "complete", "driver": "morrow-benchmark (Rust)", "platform": system,
        "binary": {"immutableCopy": True}, "results": [
            {"size": size, "checks": dict.fromkeys(acceptance.SERVICE_CHECKS, True), "serviceSampledMaxRSSBytes": 100,
             "idle": {"requestedSeconds": 30, "elapsedMs": 30001, "cpuDeltaMs": 30.001, "cpuPercentOfOneCore": 0.1,
                      "samples": [{"elapsedMs": 30000, "rssBytes": 100, "cpuMs": 31}]},
             **{key: {"samples": [{"ms": 1, "bytes": 100, "rssBytes": 100}] * 6, "warmP95Ms": 1} for key in ("state", "revision", "search", "page", "sender")}}
            for size in acceptance.SIZES]}


def policy():
    # Arbitrary test-only bounds, deliberately not product acceptance targets.
    return {"schema": 1, "platforms": {system: {str(size): {"serviceSampledMaxRSSBytes": 101,
        "serviceIdleCPUPercent": 0.2, "nativeWarmP95Ms": 3} for size in acceptance.SIZES} for system in acceptance.PLATFORMS}}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="morrow-acceptance-negative-")
        self.root = Path(self.temporary.name)
        self.serial = 0

    def tearDown(self):
        self.temporary.cleanup()

    def stage(self, kind, reports, *, source="source", mutate=False):
        self.serial += 1
        directory = self.root / str(self.serial)
        directory.mkdir()
        files = {"synthetic-test-only.rs": hashlib.sha256(source.encode()).hexdigest()}
        manifest = {"files": files, "digest": hashlib.sha256(acceptance.canonical(files)).hexdigest(),
                    "commit": "a" * 40, "tree": "b" * 40, "dirty": False}
        executable = directory / "synthetic-executable"
        executable.write_bytes(b"This is contract test data, not a measured program.")
        artifacts = []
        for index, report in enumerate(reports):
            path = directory / f"report-{index}.json"
            acceptance.write_new(path, report)
            artifacts.append({"file": path.name, "sha256": acceptance.sha(path), "role": "report"})
        acceptance.write_new(directory / "evidence.json", {"schema": 1, "stage": kind, "status": "complete",
            "source": manifest, "sourceAfter": manifest | ({"digest": "changed"} if mutate else {}),
            "exitCode": 0, "artifacts": artifacts, "binaries": [{"name": executable.name, "sha256": acceptance.sha(executable)}]})
        return directory

    def all_stages(self):
        return [self.stage("protocol", [protocol(size) for size in acceptance.SIZES])] + [
            self.stage(kind, [factory(system)]) for system in acceptance.PLATFORMS
            for kind, factory in (("service", service), ("native", native))]

    def test_complete_synthetic_contract_and_explicit_policy(self):
        result = acceptance.aggregate(self.all_stages(), policy())
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["missing"])

    def test_small_seeded_missing_or_wrong_bodies_cannot_claim_50k(self):
        original = protocol(50000)
        changes = [
            ("size", 120), ("seededOwnerRows", 50000), ("initialOwnerRows", 1),
            ("download.downloadedMessages", 50), ("download.verifiedBodies", 49999),
            ("download.actualSha256", "0" * 64), ("download.expectedSha256", "0" * 64),
            ("download.duplicates", 1), ("download.bodyBytes", 1024),
            ("download.downloadedMessages", True), ("ownerIsolation", False), ("providerWrites", 1),
            ("newMail.observed", 50), ("reconnect.stalePageWrites", 1),
        ]
        for field, value in changes:
            report = copy.deepcopy(original)
            parent = report["result"]
            terms = field.split(".")
            for term in terms[:-1]:
                parent = parent[term]
            parent[terms[-1]] = value
            with self.subTest(field=field), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_protocol(report, 50000)

    def test_http_or_unmounted_native_events_are_not_ui_latency(self):
        for field, value in (("measurement", "http-response"), ("platform", "linux"), ("status", "running")):
            report = native(); report[field] = value
            with self.subTest(field=field), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_native(report)
        for field, value in (("elapsedMs", float("nan")), ("visibleRows", 0), ("tableRows", 50000),
                             ("completion", "model-state-only"), ("ownerMatched", False), ("renderedRowIdentityMatched", False)):
            report = native(); report["results"][0]["samples"][0][field] = value
            with self.subTest(field=field), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_native(report)
        report = native(); report["results"][0]["samples"].pop()
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.verify_native(report)

    def test_mac_visible_reader_and_selected_row_controls_are_required(self):
        report = native(); del report["oracleControls"]
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.verify_native(report)
        for key in acceptance.MAC_ORACLE_CONTROLS:
            report = native(); report["oracleControls"][key] = False
            with self.subTest(key=key), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_native(report)
        for key in ("renderedSelectedRowIdentityMatched", "renderedReaderIdentityMatched"):
            report = native()
            selected = next(sample for sample in report["results"][0]["samples"] if sample["action"] == "select")
            selected[key] = False
            with self.subTest(key=key), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_native(report)

    def macos_source_fixture(self):
        root = self.root / "native-source"
        values = {
            "macos/Sources/MorrowMail/AppModel.swift": "private(set) var baseURL: URL?\n",
            "macos/Sources/MorrowMail/MailView.swift": "// fictional compiler input\n",
            "macos/Checks/MailboxLatency.swift": "// fictional entry\n",
            "package.json": '{"version":"0.0.0-fixture"}',
        }
        for name, value in values.items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(value)
        snapshot = {"files": {name: acceptance.sha(root / name) for name in values}}
        return root, snapshot

    def test_mac_compiler_set_rejects_ignored_added_removed_and_changed_inputs(self):
        root, snapshot = self.macos_source_fixture()
        originals = acceptance.macos_source_inputs(root, snapshot)
        ignored = root / "macos/Sources/MorrowMail/.env.provenance.swift"
        ignored.write_text("// ignored unexpected source must never be copied")
        # git's recorded manifest is unchanged while the actual glob includes
        # this input; require rejection before creating compiler copies.
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.prepare_macos_inputs(root, self.root / "rejected-inputs", snapshot)
        self.assertFalse((self.root / "rejected-inputs").exists())
        ignored.unlink()
        extra = root / "macos/Sources/MorrowMail/Added.swift"; extra.write_text("// added")
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.macos_source_inputs(root, snapshot)
        extra.unlink()
        view = root / "macos/Sources/MorrowMail/MailView.swift"; saved = view.read_bytes(); view.unlink()
        self.assertNotEqual(acceptance.macos_source_inputs(root, snapshot), originals)
        view.write_bytes(saved + b"// changed")
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.macos_source_inputs(root, snapshot)
        view.write_bytes(saved)
        inputs = self.root / "compiler-inputs"
        sources, captured_originals, captured_private = acceptance.prepare_macos_inputs(root, inputs, snapshot)
        self.assertEqual(captured_originals, originals)
        self.assertEqual({path.name for path in sources}, {"AppModel.swift", "MailView.swift", "MailboxLatency.swift"})
        self.assertEqual({path.parent for path in sources}, {inputs})
        self.assertEqual(acceptance.macos_private_inputs(inputs), captured_private)
        self.assertNotEqual(captured_private["AppModel.swift"], originals["macos/Sources/MorrowMail/AppModel.swift"])
        self.assertEqual(acceptance.macos_source_inputs(root, snapshot), originals)
        added = inputs / ".env.provenance.swift"; added.write_text("// private wildcard addition")
        self.assertNotEqual(acceptance.macos_private_inputs(inputs), captured_private)
        added.unlink()
        item = inputs / "MailView.swift"; saved = item.read_bytes(); item.unlink()
        self.assertNotEqual(acceptance.macos_private_inputs(inputs), captured_private)
        item.write_bytes(saved + b"// changed")
        self.assertNotEqual(acceptance.macos_private_inputs(inputs), captured_private)
        item.write_bytes(saved)
        self.assertEqual(acceptance.macos_private_inputs(inputs), captured_private)

    @unittest.skipIf(os.name == "nt", "POSIX symlink control; source guards also apply on Windows")
    def test_mac_compiler_inputs_reject_source_and_private_symlinks(self):
        root, snapshot = self.macos_source_fixture()
        source = root / "macos/Sources/MorrowMail/MailView.swift"
        retained = self.root / "retained.swift"; retained.write_bytes(source.read_bytes())
        source.unlink(); source.symlink_to(retained)
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.macos_source_inputs(root, snapshot)
        source.unlink(); source.write_bytes(retained.read_bytes())
        inputs = self.root / "compiler-inputs"
        acceptance.prepare_macos_inputs(root, inputs, snapshot)
        (inputs / "extra.swift").symlink_to(retained)
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.macos_private_inputs(inputs)

    def test_measured_mac_adapter_is_rehashed_and_required(self):
        evidence = self.stage("native", [native()])
        inputs = evidence / "compiler-inputs"; inputs.mkdir()
        adapter = inputs / "AppModel.swift"; adapter.write_text("// fictional non-executable adapter")
        saved = adapter.read_bytes()
        envelope = acceptance.read_json(evidence / "evidence.json")
        envelope["binaries"][0]["fixtureAdapterSha256"] = acceptance.sha(adapter)
        (evidence / "evidence.json").write_text(json.dumps(envelope))
        acceptance.checked_artifact(evidence)
        adapter.write_bytes(saved + b"// changed")
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.checked_artifact(evidence)
        adapter.write_bytes(saved); acceptance.checked_artifact(evidence)
        adapter.unlink()
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.checked_artifact(evidence)

    def test_service_omitted_checks_empty_samples_and_invented_quantiles_fail(self):
        for field, value in (("checks", {"counts": True}), ("state.samples", [{}] * 6), ("state.warmP95Ms", 0),
                             ("idle.elapsedMs", 5), ("idle.samples", []), ("idle.cpuPercentOfOneCore", 0),
                             ("serviceSampledMaxRSSBytes", 1)):
            report = service(); parent = report["results"][0]
            terms = field.split(".")
            for term in terms[:-1]: parent = parent[term]
            parent[terms[-1]] = value
            with self.subTest(field=field), self.assertRaises(acceptance.InvalidEvidence):
                acceptance.verify_service(report)

    def test_missing_platform_native_limits_remain_non_green_and_cli_exits_two(self):
        evidence = self.stage("protocol", [protocol(1000)])
        result = acceptance.aggregate([evidence])
        self.assertEqual(result["status"], "incomplete")
        self.assertIn("native:macos", result["missing"])
        self.assertIn("native:windows", result["missing"])
        self.assertIn("protocol:50000", result["missing"])
        self.assertIn("caller-approved-performance-limits", result["missing"])
        output = self.root / "aggregate.json"
        completed = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("mailbox-acceptance.py")),
            "aggregate", "--evidence", str(evidence), "--output", str(output)], capture_output=True, timeout=30)
        self.assertEqual(completed.returncode, 2, completed.stderr)
        self.assertEqual(acceptance.read_json(output)["status"], "incomplete")

    def test_changed_source_artifact_duplicate_and_mixed_commits_fail(self):
        evidence = self.stage("protocol", [protocol()], mutate=True)
        self.assertEqual(acceptance.aggregate([evidence])["status"], "failed")
        first = self.stage("protocol", [protocol()])
        other = self.stage("native", [native()], source="different")
        self.assertEqual(acceptance.aggregate([first, other])["status"], "failed")
        self.assertEqual(acceptance.aggregate([first, first])["status"], "failed")
        (first / "report-0.json").write_text("{}")
        self.assertEqual(acceptance.aggregate([first])["status"], "failed")
        binary_stage = self.stage("protocol", [protocol()])
        (binary_stage / "synthetic-executable").write_bytes(b"changed")
        self.assertEqual(acceptance.aggregate([binary_stage])["status"], "failed")

    def test_performance_failure_and_absent_limits_do_not_become_green(self):
        stages = self.all_stages()
        self.assertEqual(acceptance.aggregate(stages)["status"], "incomplete")
        limits = policy(); limits["platforms"]["macos"]["50000"]["nativeWarmP95Ms"] = 1
        result = acceptance.aggregate(stages, limits)
        self.assertEqual(result["status"], "failed")
        self.assertIn("macos:50000:native:next", result["exceeded"])
        limits = policy(); limits["platforms"]["windows"]["1000"]["serviceSampledMaxRSSBytes"] = "unbounded"
        self.assertEqual(acceptance.aggregate(stages, limits)["status"], "failed")

    def test_bounded_json_no_overwrite_and_path_escape(self):
        path = self.root / "report.json"
        acceptance.write_new(path, {"status": "original"})
        with self.assertRaises(FileExistsError):
            acceptance.write_new(path, {})
        path.write_text('{"value":NaN}')
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.read_json(path)
        path.write_text('{"status":"failed","status":"complete"}')
        with self.assertRaises(acceptance.InvalidEvidence):
            acceptance.read_json(path)
        evidence = self.stage("protocol", [protocol()])
        envelope = acceptance.read_json(evidence / "evidence.json")
        envelope["artifacts"][0]["file"] = "../report.json"
        (evidence / "evidence.json").write_text(json.dumps(envelope))
        self.assertEqual(acceptance.aggregate([evidence])["status"], "failed")

    @unittest.skipIf(os.name == "nt", "POSIX child cleanup control; Windows uses its owned taskkill tree")
    def test_timeout_reaps_the_actual_owned_fixture_process(self):
        pid = self.root / "owned.pid"
        program = "import os,time,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"
        with self.assertRaises(subprocess.TimeoutExpired):
            acceptance.run_command([sys.executable, "-c", program, str(pid)], self.root, "timeout.log", timeout=2)
        self.assertTrue(pid.exists(), "The synthetic process did not start before its deadline")
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid.read_text()), 0)


if __name__ == "__main__":
    unittest.main()
