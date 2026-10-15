#!/usr/bin/env python3
"""Private-adapter and evidence negative controls; no WinUI execution claim."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("windows_latency", Path(__file__).with_name("windows-mailbox-latency.py"))
latency = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(latency)


def report():
    rows = []
    for size in latency.SIZES:
        samples, searches = [], []
        for repeat in range(6):
            for action in ("next", "previous", "select", "search"):
                page = 1 if action == "next" else 0
                count = 30 if action == "search" else 50
                first = 50 if action == "next" else 0
                total = size // 2 if action == "search" else size
                sample = {"action": action, "completion": "layout-and-display", "elapsedMs": 1,
                    "nativeEventObserved": True, "page": page, "tableRows": count, "visibleRows": 4,
                    "ownerMatched": True, "renderedRowIdentityMatched": True, "renderedReaderMatched": action == "select",
                    "firstOwnedRow": latency.owned_id(first), "observedPageLabel": f"Page {page + 1} · {total} messages"}
                if action == "select":
                    index = repeat % 2
                    sample.update(selectedOwnedRow=True, selectedOwner=latency.OWNERS[index], selectedViewId=latency.owned_id(index))
                if action == "search":
                    sample["queryMatched"] = True; searches.append(sample)
                else:
                    samples.append(sample)
        rows.append({"size": size, "generatedRows": size, "pageSize": 50, "searchPageSize": 30,
            "unexpectedRequests": 0, "ownerSelectionVerified": True, "interceptedRequests": 50,
            "samples": samples, "searchSamples": searches})
    return {"schema": 1, "kind": "morrow-native-mailbox-latency", "status": "complete", "platform": "windows",
        "version": "fictional-version", "measuredAt": "2026-01-01T00:00:00.000Z", "windowWidth": 1220,
        "windowHeight": 820, "windowScale": 1, "measurement": "native-event-to-layout-display",
        "transport": "intercepted-fictional-only", "results": rows,
        "offlineControls": dict.fromkeys(("serviceStartRejected", "sendRejected", "unknownOwnerRejected",
            "hostOperationRejected", "unsafeStatusMethodRejected"), True)}


class WindowsLatencyTests(unittest.TestCase):
    def test_private_copy_removes_network_and_launch_preserving_production_events(self):
        root = Path(__file__).resolve().parents[1]
        original_app = (root / "windows/App.cpp").read_bytes()
        original_service = (root / "windows/Service.cpp").read_bytes()
        with tempfile.TemporaryDirectory(prefix="morrow-native-adapter-") as temporary:
            inputs = Path(temporary) / "inputs"
            files = latency.prepare_inputs(root, inputs)
            app = (inputs / "windows/App.cpp").read_text()
            service = (inputs / "windows/Service.cpp").read_text()
            self.assertNotIn("WinHttpSendRequest(", service)
            self.assertNotIn("CreateProcessW(", service)
            self.assertNotIn("shell->start();", app)
            self.assertIn("morrow::startMailboxLatency(shell);", app)
            self.assertNotIn(r"Local\\org.morrowmail.desktop.WinUI", app)
            self.assertNotIn('FindWindowW(nullptr, L"Morrow Mail")', app)
            self.assertIn('FindWindowW(nullptr, L"Morrow fictional mailbox latency")', app)
            self.assertIn('SetCurrentProcessExplicitAppUserModelID(L"org.morrowmail.desktop.MailboxLatencyFixture")', app)
            self.assertEqual(service.count("++mailboxLatencyPendingRequests;"), 2)
            self.assertIn("if (responseStatus) *responseStatus = 200;", service)
            # These real handlers and layout/render methods remain byte-for-byte.
            for begin, end in (("void Shell::mailPage() {", "Json refreshedReaderMessage("),
                               ("IAsyncAction Shell::read(", "void Shell::showReaderStatus("),
                               ("void Shell::renderReader(", "IAsyncAction Shell::patch(")):
                before = original_app.decode().split(begin)[1].split(end)[0]
                after = app.split(begin)[1].split(end)[0]
                self.assertEqual(before, after)
            self.assertEqual(files, latency.compiler_manifest(inputs))
            (inputs / "windows/App.cpp").write_text("changed")
            self.assertNotEqual(files, latency.compiler_manifest(inputs))
            with self.assertRaises(FileExistsError):
                latency.prepare_inputs(root, inputs)
        self.assertEqual((root / "windows/App.cpp").read_bytes(), original_app)
        self.assertEqual((root / "windows/Service.cpp").read_bytes(), original_service)

    def test_private_project_places_generation_before_imports_without_changing_production_build(self):
        root = Path(__file__).resolve().parents[1]
        project = root / "windows/MorrowMail.vcxproj"
        builder = root / "scripts/build-windows-native.ps1"
        original_project, original_builder = project.read_bytes(), builder.read_bytes()
        with tempfile.TemporaryDirectory(prefix="morrow-native-generation-") as temporary:
            inputs = Path(temporary) / "inputs"
            files = latency.prepare_inputs(root, inputs)
            private = ET.parse(inputs / "windows/MorrowMail.vcxproj").getroot()
            ns = {"m": "http://schemas.microsoft.com/developer/msbuild/2003"}
            properties = private.find("m:PropertyGroup[@Label='Globals']", ns)
            expected = properties.find("m:MorrowMailboxLatencyGeneratedFilesDir", ns).text
            self.assertEqual(expected, "$(MSBuildThisFileDirectory)..\\build\\windows-native\\obj\\$(Platform)\\$(Configuration)\\mailbox-latency-generated\\")
            self.assertEqual(properties.find("m:GeneratedFilesDir", ns).text, "$(MorrowMailboxLatencyGeneratedFilesDir)")
            self.assertEqual(len(private.findall(".//m:GeneratedFilesDir", ns)), 1)
            self.assertLess(list(private).index(properties), min(list(private).index(node) for node in private.findall(".//m:Import", ns) if node in list(private)))
            guard = private.find("m:Target[@Name='CheckMailboxLatencyGeneratedFiles']", ns)
            self.assertEqual(guard.get("BeforeTargets"), "PrepareForBuild")
            self.assertEqual(guard.find("m:Error", ns).get("Condition"), "'$(GeneratedFilesDir)' != '$(MorrowMailboxLatencyGeneratedFilesDir)'")
            self.assertEqual((inputs / "scripts/build-windows-native.ps1").read_bytes(), original_builder)
            self.assertEqual(files, latency.compiler_manifest(inputs))
        self.assertEqual(project.read_bytes(), original_project)
        self.assertEqual(builder.read_bytes(), original_builder)

    def test_private_project_rejects_missing_ambiguous_or_preexisting_generation_configuration(self):
        source = (Path(__file__).resolve().parents[1] / "windows/MorrowMail.vcxproj").read_text(encoding="utf-8")
        marker = '  <PropertyGroup Label="Globals">'
        for changed in (source.replace(marker, "<PropertyGroup>"), source.replace(marker, marker + marker),
                        source.replace(marker, marker + "<GeneratedFilesDir>elsewhere</GeneratedFilesDir>"),
                        latency.private_project(source)):
            with self.subTest(source=changed[:80]), self.assertRaises(ValueError): latency.private_project(changed)

    def test_real_runner_keeps_manifest_gate_before_native_execution_for_generated_inputs(self):
        # Exercise the actual prepare/build/check/copy/run ordering, replacing
        # process execution only. This does not compile MSBuild or execute WinUI.
        common = latency.acceptance_module()
        for misplaced in (False, True):
            with self.subTest(misplaced=misplaced), tempfile.TemporaryDirectory(prefix="morrow-native-generation-run-") as temporary:
                output = Path(temporary) / "evidence"
                calls = []

                def controlled_process(command, directory, log, **options):
                    calls.append((command, log, options))
                    if log == "native-build.log":
                        self.assertEqual(command[-1], "-CompileOnly")
                        self.assertEqual(options["timeout"], 1200)
                        inputs = directory / "compiler-inputs"
                        ns = {"m": "http://schemas.microsoft.com/developer/msbuild/2003"}
                        project = ET.parse(inputs / "windows/MorrowMail.vcxproj").getroot()
                        configured = project.find(".//m:MorrowMailboxLatencyGeneratedFilesDir", ns).text
                        # Resolve the explicit fixture constants for this fake
                        # process only; real MSBuild evaluation is a CI gate.
                        configured = configured.replace("$(MSBuildThisFileDirectory)", str(inputs / "windows") + "/")
                        configured = configured.replace("$(Platform)", "x64").replace("$(Configuration)", "Release")
                        generated = Path(configured.replace("\\", "/")).resolve()
                        self.assertTrue(generated.is_relative_to(inputs / "build/windows-native"))
                        if misplaced:
                            generated = inputs / "windows/Generated Files"
                        header = generated / "winrt/Windows.Foundation.h"
                        header.parent.mkdir(parents=True)
                        header.write_text("// Fictional generated header; not compiled.\n")
                        runtime = inputs / "build/windows-native/bin/x64/Release"
                        runtime.mkdir(parents=True)
                        (runtime / "Morrow Mail.exe").write_bytes(b"fictional-non-executable-placeholder")
                        return 0
                    self.assertEqual(log, "native.log")
                    self.assertEqual(options["timeout"], 600)
                    # A controlled nonzero process result keeps fabricated
                    # execution from ever producing successful native evidence.
                    return 71

                args = type("Args", (), {"output": output, "pwsh": "fixture-pwsh"})()
                with mock.patch.object(latency.sys, "platform", "win32"), \
                     mock.patch.object(latency, "acceptance_module", return_value=common), \
                     mock.patch.object(common, "run_command", side_effect=controlled_process):
                    self.assertEqual(latency.run(args), 1)
                evidence = json.loads((output / "evidence.json").read_text(encoding="utf-8"))
                self.assertEqual(evidence["status"], "failed")
                self.assertEqual(evidence["source"]["digest"], evidence["sourceAfter"]["digest"])
                if misplaced:
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(evidence["error"], "Private compiler inputs changed during build")
                    self.assertIsNone(evidence["nativeProcessExitCode"])
                    self.assertFalse((output / "Morrow Mail.exe").exists())
                else:
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(evidence["error"], "WinUI latency process failed")
                    self.assertEqual(evidence["nativeProcessExitCode"], 71)
                    self.assertEqual((output / "Morrow Mail.exe").read_bytes(), b"fictional-non-executable-placeholder")

    def test_added_removed_compiler_inputs_fail_while_build_outputs_are_excluded(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="morrow-native-input-drift-") as temporary:
            inputs = Path(temporary) / "inputs"
            files = latency.prepare_inputs(root, inputs)
            added = inputs / "windows/Added.cpp"
            added.write_text("// New wildcard compiler input must invalidate the snapshot.\n")
            # Demonstrate the original blind spot, then require full enumeration.
            self.assertEqual(files, latency.manifest(inputs, files))
            self.assertNotEqual(files, latency.compiler_manifest(inputs))
            added.unlink()
            self.assertEqual(files, latency.compiler_manifest(inputs))
            original = inputs / "windows/App.cpp"
            saved = original.read_bytes(); original.unlink()
            self.assertNotEqual(files, latency.compiler_manifest(inputs))
            original.write_bytes(saved)
            self.assertEqual(files, latency.compiler_manifest(inputs))
            generated = inputs / "build/windows-native/obj/generated.cpp"
            generated.parent.mkdir(parents=True)
            generated.write_text("// Expected build output is not an input root.\n")
            self.assertEqual(files, latency.compiler_manifest(inputs))
            (inputs / "package.json").unlink()
            with self.assertRaises(ValueError): latency.compiler_manifest(inputs)

    def test_missing_duplicate_reversed_seams_and_symlinks_fail_closed(self):
        for source in ("no seam", "one seam one seam"):
            with self.assertRaises(ValueError): latency.replace_once(source, "one seam", "replacement")
        for source in ("begin only", "end begin", "begin begin end", "begin end end"):
            with self.assertRaises(ValueError): latency.replace_region(source, "begin", "end", "replacement")
        if os.name != "nt":
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); (root / "outside").write_text("private sentinel")
                (root / "link").symlink_to(root / "outside")
                with self.assertRaises(ValueError): latency.manifest(root)

    def test_complete_contract_includes_both_duplicate_id_owners_and_search(self):
        latency.verify_windows(report(), "fictional-version")

    def test_small_data_wrong_scope_and_missing_events_do_not_claim_native_evidence(self):
        for path, value in (
            (("status",), "running"), (("transport",), "real-http"), (("measurement",), "compositor-presentation"),
            (("version",), "stale"), (("results", 2, "generatedRows"), 120),
            (("offlineControls", "sendRejected"), False),
            (("results", 0, "unexpectedRequests"), 1), (("results", 0, "samples", 0, "nativeEventObserved"), False),
            (("results", 0, "samples", 0, "renderedRowIdentityMatched"), False),
            (("results", 0, "samples", 0, "observedPageLabel"), "Page 1 · 1000 messages"),
            (("results", 0, "samples", 0, "visibleRows"), 0),
            (("results", 0, "samples", 0, "elapsedMs"), float("nan")),
            (("results", 0, "samples", 5, "selectedOwner"), latency.OWNERS[0]),
            (("results", 0, "samples", 5, "renderedReaderMatched"), False),
            (("results", 0, "searchSamples", 0, "queryMatched"), False),
            (("results", 0, "searchSamples", 0, "tableRows"), 50),
            (("results", 0, "searchSamples", 0, "action"), "next"),
        ):
            value_report = report(); parent = value_report
            for term in path[:-1]: parent = parent[term]
            parent[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError): latency.verify_windows(value_report, "fictional-version")
        for field in ("samples", "searchSamples"):
            value_report = report(); value_report["results"][0][field].pop()
            with self.assertRaises(ValueError): latency.verify_windows(value_report, "fictional-version")

    def test_runtime_environment_drops_cloud_model_and_real_workspace_inputs(self):
        with mock.patch.dict(os.environ, {"SYSTEMROOT": "fictional-windows", "PATH": "fixture-os-path",
            "AWS_SECRET_ACCESS_KEY": "secret", "OPENAI_API_KEY": "secret", "MORROW_DATA_DIR": "private-workspace",
            "GENMAIL_TOKEN": "secret", "NODE_OPTIONS": "injected"}, clear=True):
            result = latency.native_environment(Path("fictional-workspace"), "fixture-version")
        self.assertEqual(set(result), {"SYSTEMROOT", "PATH", "MORROW_DATA_DIR", "MORROW_FIXTURE_VERSION"})
        self.assertEqual(result["MORROW_DATA_DIR"], "fictional-workspace")
        self.assertEqual(result["MORROW_FIXTURE_VERSION"], "fixture-version")

    def test_non_windows_run_stops_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "never-created"
            args = type("Args", (), {"output": output, "pwsh": "pwsh"})()
            with mock.patch.object(latency.sys, "platform", "linux"), self.assertRaises(ValueError): latency.run(args)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
