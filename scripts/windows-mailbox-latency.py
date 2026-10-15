#!/usr/bin/env python3
"""Opt-in WinUI action-to-layout fixture; requires the mailbox acceptance harness.

Only private compiler copies change. No service starts, all service transport is
intercepted, and no real mailbox/model/provider credentials are accepted. This
does not run release gates or assert compositor/whole-app/real-service latency.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SIZES = (1000, 10000, 50000)
OWNERS = ("alpha@latency.invalid", "beta@latency.invalid")
REQUEST = "IAsyncOperation<Json> Service::request(hstring path, hstring owner, hstring method, Json body, bool hostOperation) {"
STATUS_REQUEST = "IAsyncOperation<Json> Service::requestWithStatus(hstring path, hstring owner, hstring method, Json body) {"
BLOCKING = "Json Service::requestBlocking(hstring const& path, hstring const& owner, hstring const& method, Json const& body, bool hostOperation, unsigned* responseStatus) {"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def replace_once(source, before, after):
    require(source.count(before) == 1, "Private fixture seam changed or is ambiguous: " + before)
    return source.replace(before, after, 1)


def replace_region(source, begin, end, replacement):
    require(source.count(begin) == 1 and source.count(end) == 1, "Private transport boundary changed or is ambiguous")
    first, last = source.index(begin), source.index(end)
    require(first < last, "Private transport boundaries are reversed")
    return source[:first] + replacement + source[last:]


def manifest(directory, names=None):
    directory = Path(directory)
    paths = (directory / name for name in names) if names is not None else sorted(directory.rglob("*"))
    files = {}
    for path in paths:
        require(not path.is_symlink(), "Fixture compiler/runtime inputs cannot be symlinks")
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = digest(path)
    require(files, "Fixture compiler/runtime files are missing")
    return files


def compiler_manifest(directory):
    """Enumerate every fixed input root; only generated build/ is excluded.

    Rehashing the previous list alone misses a newly added windows/*.cpp, which
    the production vcxproj wildcard would compile. Enumerate again after every
    build/run, including additions and removals, while leaving build outputs out.
    """
    directory = Path(directory)
    files = {}
    for name in ("windows", "scripts", "assets"):
        root = directory / name
        require(root.is_dir() and not root.is_symlink(), "Missing regular compiler input root")
        files.update({f"{name}/{path}": value for path, value in manifest(root).items()})
    package = directory / "package.json"
    require(package.is_file() and not package.is_symlink(), "Missing regular compiler metadata")
    files["package.json"] = digest(package)
    return dict(sorted(files.items()))


def private_project(source):
    """Keep CppWinRT generation outside the immutable private input roots.

    The pinned package documents GeneratedFilesDir as its projection/include
    directory. Set it before SDK imports rather than relying on their IntDir
    evaluation order; verify the final property when MSBuild starts the build.
    """
    require("GeneratedFilesDir" not in source and "CheckMailboxLatencyGeneratedFiles" not in source,
            "Private fixture generated-file configuration changed")
    directory = r"$(MSBuildThisFileDirectory)..\build\windows-native\obj\$(Platform)\$(Configuration)\mailbox-latency-generated" + "\\"
    source = replace_once(source, '  <PropertyGroup Label="Globals">',
        '  <PropertyGroup Label="Globals">\n'
        f'    <MorrowMailboxLatencyGeneratedFilesDir>{directory}</MorrowMailboxLatencyGeneratedFilesDir>\n'
        '    <GeneratedFilesDir>$(MorrowMailboxLatencyGeneratedFilesDir)</GeneratedFilesDir>')
    return replace_once(source, "</Project>",
        '  <Target Name="CheckMailboxLatencyGeneratedFiles" BeforeTargets="PrepareForBuild">\n'
        '    <Error Condition="\'$(GeneratedFilesDir)\' != \'$(MorrowMailboxLatencyGeneratedFilesDir)\'" '
        'Text="Mailbox latency fixture generated-file output changed." />\n'
        '    <Message Importance="High" Text="Mailbox latency fixture CppWinRT output: '
        'build/windows-native/obj/$(Platform)/$(Configuration)/mailbox-latency-generated/" />\n'
        '  </Target>\n</Project>')


def prepare_inputs(root, directory):
    """Copy existing build inputs and make exact, testable fixture-only edits."""
    root, directory = Path(root), Path(directory)
    directory.mkdir(exist_ok=False)
    # Validate before copy so an unexpected link cannot pull private data in.
    manifest(root / "windows")
    shutil.copytree(root / "windows", directory / "windows")
    for name in ("scripts/build-windows-native.ps1", "assets/brand/morrow.ico", "package.json"):
        source = root / name
        require(source.is_file() and not source.is_symlink(), "Missing regular fixture build input")
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    native = directory / "windows"
    project = native / "MorrowMail.vcxproj"
    project.write_text(private_project(project.read_text(encoding="utf-8")), encoding="utf-8", newline="\n")
    shutil.copy2(native / "Checks/MailboxLatency.cpp", native / "MailboxLatency.cpp")
    app = (native / "App.cpp").read_text(encoding="utf-8")
    app = replace_once(app, "shell = std::make_shared<morrow::Shell>(); shell->start();",
                       "shell = std::make_shared<morrow::Shell>(); morrow::startMailboxLatency(shell);")
    app = replace_once(app, "struct MorrowApplication :",
                       "namespace morrow { winrt::fire_and_forget startMailboxLatency(std::shared_ptr<Shell>); }\nstruct MorrowApplication :")
    app = replace_once(app, r"Local\\org.morrowmail.desktop.WinUI", r"Local\\org.morrowmail.desktop.MailboxLatencyFixture")
    app = replace_once(app, 'FindWindowW(nullptr, L"Morrow Mail")',
                       'FindWindowW(nullptr, L"Morrow fictional mailbox latency")')
    app = replace_once(app, 'SetCurrentProcessExplicitAppUserModelID(L"org.morrowmail.desktop")',
                       'SetCurrentProcessExplicitAppUserModelID(L"org.morrowmail.desktop.MailboxLatencyFixture")')
    (native / "App.cpp").write_text(app, encoding="utf-8", newline="\n")
    service = (native / "Service.cpp").read_text(encoding="utf-8")
    service = replace_region(service, "IAsyncAction Service::start() {", "bool Service::alive() const",
        'void mailboxLatencyRejectStart();\nIAsyncAction Service::start() {\n    mailboxLatencyRejectStart();\n    co_return;\n}\n')
    # One shared replacement covers BOTH public request entry points; their real
    # async scheduling, lifetimes and write counters remain production code.
    service = replace_region(service, BLOCKING, "Json Service::clientState() const {",
        "Json mailboxLatencyRequest(hstring const&, hstring const&, hstring const&, Json const&, bool);\n" + BLOCKING + "\n"
        "    auto result = mailboxLatencyRequest(path, owner, method, body, hostOperation);\n"
        "    if (responseStatus) *responseStatus = 200;\n    return result;\n}\n")
    registration = "\n    ++mailboxLatencyPendingRequests;\n    struct PendingFixtureRequest { ~PendingFixtureRequest() { --mailboxLatencyPendingRequests; } } pendingFixtureRequest;"
    service = replace_once(service, REQUEST, "extern std::atomic_uint mailboxLatencyPendingRequests;\n" + REQUEST + registration)
    service = replace_once(service, STATUS_REQUEST, STATUS_REQUEST + registration)
    require("WinHttpSendRequest(" not in service and "CreateProcessW(" not in service,
            "Private adapter still has an executable network/process launch path")
    (native / "Service.cpp").write_text(service, encoding="utf-8", newline="\n")
    return compiler_manifest(directory)


def finite(value, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum


def owned_id(index):
    return f"{OWNERS[index % 2]}:imap:55:{index // 2 + 1}"


def verify_windows(report, version):
    require(isinstance(report, dict) and report.get("schema") == 1 and report.get("status") == "complete"
            and report.get("kind") == "morrow-native-mailbox-latency" and report.get("platform") == "windows", "Windows native stage is incomplete")
    require(report.get("version") == version and isinstance(report.get("measuredAt"), str), "Missing native version/time")
    datetime.fromisoformat(report["measuredAt"].replace("Z", "+00:00"))
    require(report.get("measurement") == "native-event-to-layout-display" and report.get("transport") == "intercepted-fictional-only", "Unexpected native measurement boundary")
    controls = report.get("offlineControls", {})
    require(all(controls.get(key) is True for key in ("serviceStartRejected", "sendRejected", "unknownOwnerRejected",
            "hostOperationRejected", "unsafeStatusMethodRejected")), "Offline boundary negative controls are missing")
    require(finite(report.get("windowWidth"), 800) and finite(report.get("windowHeight"), 500)
            and finite(report.get("windowScale"), 0.1), "Missing mounted window geometry")
    rows = report.get("results")
    require(isinstance(rows, list) and [row.get("size") for row in rows] == list(SIZES), "All actual generated dataset sizes are required")
    for row in rows:
        size = row["size"]
        require(row.get("generatedRows") == size and row.get("pageSize") == 50 and row.get("searchPageSize") == 30
                and row.get("unexpectedRequests") == 0 and row.get("ownerSelectionVerified") is True
                and type(row.get("interceptedRequests")) is int and row["interceptedRequests"] > 0, "Missing controlled dataset/transport evidence")
        samples = row.get("samples", [])
        require(isinstance(samples, list) and len(samples) == 18, "Missing native action samples")
        require([sample.get("action") for sample in samples] == [action for _ in range(6) for action in ("next", "previous", "select")], "Native action sequence changed")
        searches = row.get("searchSamples", [])
        require(isinstance(searches, list) and len(searches) == 6, "Missing separate native search samples")
        for index, sample in enumerate(samples + searches):
            action = sample.get("action")
            page = 1 if action == "next" else 0
            count = 30 if action == "search" else 50
            first = 50 if action == "next" else 0
            total = size // 2 if action == "search" else size
            require(action in ("next", "previous", "select", "search") and finite(sample.get("elapsedMs"))
                    and sample.get("completion") == "layout-and-display" and sample.get("nativeEventObserved") is True
                    and sample.get("page") == page and sample.get("tableRows") == count
                    and type(sample.get("visibleRows")) is int and 2 <= sample["visibleRows"] <= count
                    and sample.get("ownerMatched") is True and sample.get("renderedRowIdentityMatched") is True
                    and sample.get("firstOwnedRow") == owned_id(first)
                    and sample.get("observedPageLabel") == f"Page {page + 1} · {total} messages", "Native sample lacks its actual event/mounted owned page")
            if action == "select":
                selected = (index // 3) % 2
                require(sample.get("renderedReaderMatched") is True and sample.get("selectedOwnedRow") is True
                        and sample.get("selectedOwner") == OWNERS[selected] and sample.get("selectedViewId") == owned_id(selected), "Duplicate-ID selection/reader owner was not observed")
            elif index >= 18:
                require(action == "search" and sample.get("queryMatched") is True, "Search input/event/results were not observed")


def native_environment(workspace, version):
    # Same OS-only allowlist as the existing native smoke runner, plus only our
    # fictional workspace/version. Do not forward cloud/mail/model credentials.
    names = {name.lower() for name in ("SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "TEMP", "TMP", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
        "CommonProgramFiles(x86)", "CommonProgramW6432", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "OS", "SESSIONNAME", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH")}
    result = {key: value for key, value in os.environ.items() if key.lower() in names}
    result.update(MORROW_DATA_DIR=str(workspace), MORROW_FIXTURE_VERSION=version)
    return result


def acceptance_module():
    path = ROOT / "scripts/mailbox-acceptance.py"
    require(path.is_file(), "Stack this unit on the acceptance-harness branch before running it")
    spec = importlib.util.spec_from_file_location("mailbox_acceptance", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def run(args):
    require(sys.platform == "win32", "WinUI measurement requires Windows x64, the pinned SDK and an interactive desktop")
    common = acceptance_module()
    directory = args.output.resolve()
    require(not directory.is_relative_to(ROOT), "Native evidence must be outside the source checkout")
    directory.mkdir(parents=True, exist_ok=False)
    before = common.source_snapshot(); started = common.utc(); start = time.monotonic()
    code, status, error, binaries, artifacts, process_code = 1, "failed", None, [], [], None
    try:
        inputs = directory / "compiler-inputs"
        compiler_files = prepare_inputs(ROOT, inputs)
        common.write_new(directory / "compiler-inputs.json", compiler_files)
        command = [args.pwsh, "-NoProfile", "-NonInteractive", "-File", str(inputs / "scripts/build-windows-native.ps1"), "-CompileOnly"]
        code = common.run_command(command, directory, "native-build.log", timeout=1200)
        require(code == 0, "Private WinUI latency fixture did not compile")
        require(compiler_manifest(inputs) == compiler_files, "Private compiler inputs changed during build")
        source_runtime = inputs / "build/windows-native/bin/x64/Release"
        runtime_files = manifest(source_runtime)
        # Execute the frozen copy, with its self-contained native dependencies.
        for name in runtime_files:
            target = directory / name
            require(not target.exists(), "Native runtime path collides with evidence")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_runtime / name, target)
        require(manifest(directory, runtime_files) == runtime_files, "Runtime copy changed")
        common.write_new(directory / "native-runtime.json", runtime_files)
        binary = directory / "Morrow Mail.exe"
        require(binary.is_file(), "Compiled native fixture executable is missing")
        binaries = [{"name": name, "sha256": value} for name, value in runtime_files.items()
                    if Path(name).name == name and Path(name).suffix.lower() in (".exe", ".dll")]
        workspace = directory / "fictional-workspace"; workspace.mkdir()
        (workspace / "mailbox-latency-fixture").write_text("Morrow synthetic mailbox latency v1", encoding="utf-8")
        version = common.read_json(ROOT / "package.json")["version"]
        code = common.run_command([str(binary), "--native-smoke"], directory, "native.log",
                                  environment=native_environment(workspace, version), timeout=600)
        process_code = code
        if (workspace / "native.json").is_file():
            shutil.copy2(workspace / "native.json", directory / "native.json")
        require(code == 0, "WinUI latency process failed")
        report = common.read_json(directory / "native.json")
        verify_windows(report, version); common.verify_native(report)
        require(manifest(directory, runtime_files) == runtime_files, "Measured native runtime changed")
        require(compiler_manifest(inputs) == compiler_files, "Fixture adapter changed during measurement")
        status = "complete"
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError, KeyboardInterrupt) as failure:
        error = "Native stage interrupted; not an acceptance result" if isinstance(failure, KeyboardInterrupt) else str(failure)
        code = 130 if isinstance(failure, KeyboardInterrupt) else code or 1
    after = common.source_snapshot()
    if before["digest"] != after["digest"] or before["commit"] != after["commit"]:
        status, code, error = "failed", 1, "Source changed during native measurement"
    for name in ("native-build.log", "native.log", "compiler-inputs.json", "native-runtime.json", "native.json"):
        path = directory / name
        if path.is_file():
            artifacts.append({"file": name, "sha256": digest(path), "bytes": path.stat().st_size,
                              "role": "report" if name == "native.json" else "metadata" if path.suffix == ".json" else "log"})
    envelope = {"schema": 1, "stage": "native", "status": status, "source": before, "sourceAfter": after,
                "startedAt": started, "finishedAt": common.utc(), "elapsedSeconds": time.monotonic() - start,
                "platform": "windows", "exitCode": code, "nativeProcessExitCode": process_code, "binaries": binaries, "artifacts": artifacts}
    if error: envelope["error"] = error
    common.write_new(directory / "evidence.json", envelope)
    print(f"{status}: {directory / 'evidence.json'}")
    return 0 if status == "complete" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory, outside the checkout")
    parser.add_argument("--pwsh", default="pwsh")
    args = parser.parse_args()
    try:
        return run(args)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr); return 1


if __name__ == "__main__":
    raise SystemExit(main())
