#!/usr/bin/env python3
"""Controlled current-source mailbox acceptance; fictional fixtures only.

Run stages explicitly and sequentially in a dedicated output directory. Native
UI and service HTTP measurements are different evidence. Aggregate exits 2 when
evidence or caller-chosen performance limits are missing, and 1 for invalid or
failed evidence. No command connects to a real mailbox, sends mail, or uses AI.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
SIZES = (1000, 10000, 50000)
PLATFORMS = ("macos", "windows")
ACTIONS = ("next", "previous", "select")
MAC_ORACLE_CONTROLS = ("cellHiddenOwnerRejected", "cellForeignOwnerRejected", "cellForeignWindowRejected",
                       "containerLabelRejected", "wrongSelectedOwnerRejected", "wrongReaderOwnerRejected", "wrongReaderSubjectRejected",
                       "hiddenBodyRejected", "outsideReaderBodyRejected", "offscreenBodyRejected",
                       "hiddenAncestorRejected", "transparentAncestorRejected", "accessibilityHiddenBodyRejected", "offscreenWindowRejected")
SERVICE_CHECKS = ("counts", "senderOrder", "boundedMetadata", "distinctOwnersAndCursorPages", "noDualWriter",
                  "indexProgressMonotonic", "exactInvoiceIdentities", "indexRebuildCompleted", "sourceRowsRetained", "providersAndModelsDisabled")
MAX_JSON = 32 * 1024 * 1024


class InvalidEvidence(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidEvidence(message)


def number(value, *, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum


def integer(value, *, minimum=0):
    return type(value) is int and value >= minimum


def utc():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def read_json(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= MAX_JSON, "Missing or oversized JSON evidence")
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON evidence field")
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_keys,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError) as error:
        raise InvalidEvidence("Invalid JSON evidence") from error


def write_new(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def source_snapshot():
    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(ROOT), *arguments], timeout=15).decode().strip()
    names = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "--cached", "--others", "--exclude-standard", "-z"], timeout=15
    ).decode().split("\0")
    # Include untracked implementation files and public resources. Exclude docs
    # so recording results does not falsely invalidate the measured program.
    prefixes = ("rust/src/", "rust/tests/", "rust/resources/", "macos/Sources/", "macos/Checks/", "windows/", "scripts/")
    exact = {"rust/Cargo.toml", "rust/Cargo.lock", "package.json"}
    files = {}
    for name in sorted(set(names)):
        if not name or not (name in exact or name.startswith(prefixes)):
            continue
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), "Source files must be regular files")
        files[name] = sha(path)
    require(files, "No source files captured")
    return {"commit": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}"),
            "dirty": bool(git("status", "--porcelain")), "files": files,
            "digest": hashlib.sha256(canonical(files)).hexdigest()}


def macos_source_inputs(root, snapshot):
    """Match the actual Swift glob to captured source; reject ignored inputs."""
    root = Path(root)
    for name in ("macos", "macos/Sources", "macos/Sources/MorrowMail", "macos/Checks"):
        require((root / name).is_dir() and not (root / name).is_symlink(), "Native compiler roots must be regular directories")
    paths = sorted((root / "macos/Sources/MorrowMail").glob("*.swift"))
    require(paths and any(path.name == "AppModel.swift" for path in paths), "Missing native Swift sources")
    paths += [root / "macos/Checks/MailboxLatency.swift", root / "package.json"]
    files = {}
    for path in paths:
        name = path.relative_to(root).as_posix()
        # Do not read/copy an unexpected ignored .env.*.swift or other source.
        require(name in snapshot["files"], "Compiler input is absent from the captured source manifest")
        require(path.is_file() and not path.is_symlink(), "Native compiler sources must be regular files")
        digest = sha(path)
        require(digest == snapshot["files"][name], "Native compiler source changed before compilation")
        files[name] = digest
    return files


def macos_private_inputs(directory):
    """Complete private input set, including additions; build outputs live elsewhere."""
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), "Missing regular private compiler directory")
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), "Private compiler inputs cannot be symlinks")
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = sha(path)
    require(files and "AppModel.swift" in files and "package.json" in files, "Private compiler inputs are incomplete")
    return files


def prepare_macos_inputs(root, directory, snapshot):
    root, directory = Path(root), Path(directory)
    originals = macos_source_inputs(root, snapshot)
    require(len({Path(name).name for name in originals}) == len(originals), "Ambiguous private compiler input names")
    directory.mkdir(exist_ok=False)
    for name, digest in originals.items():
        target = directory / Path(name).name
        shutil.copy2(root / name, target)
        require(sha(target) == digest, "Compiler source changed while copying")
    adapter = directory / "AppModel.swift"
    model = adapter.read_text(encoding="utf-8")
    seam = "private(set) var baseURL: URL?"
    require(model.count(seam) == 1, "Existing fixture-only transport seam changed")
    adapter.write_text(model.replace(seam, seam + ' = URL(string: "http://127.0.0.1:18484")', 1), encoding="utf-8")
    private = macos_private_inputs(directory)
    # This exact enumerated set supplies the compiler, never a second broad glob.
    sources = [directory / Path(name).name for name in originals if name.endswith(".swift")]
    return sources, originals, private


@lru_cache(maxsize=8)
def expected_download(size):
    digest = hashlib.sha256()
    pairs = sorted((f"imap:55:{uid}", uid) for uid in range(1, size + 1))
    body_bytes = 0
    for identifier, uid in pairs:
        body = f"Acceptance UID {uid:010}: " + "x" * 1024
        body_bytes += len(body)
        digest.update(identifier.encode() + b"\0" + body.encode() + b"\0")
    return digest.hexdigest(), body_bytes


def verify_download(value, size):
    require(isinstance(value, dict), "Missing download result")
    for key in ("expectedMessages", "downloadedMessages", "verifiedBodies"):
        require(type(value.get(key)) is int and value[key] == size, f"Download {key} is not the actual dataset size")
    require(type(value.get("duplicates")) is int and value["duplicates"] == 0, "Duplicated provider identities")
    digest, body_bytes = expected_download(size)
    require(value.get("actualSha256") == digest == value.get("expectedSha256"), "Downloaded UID/body digest is incomplete or wrong")
    require(value.get("bodyBytes") == body_bytes, "Downloaded body byte count is wrong")


def verify_protocol(report, size):
    require(isinstance(report, dict), "Protocol report must be an object")
    require(report.get("schema") == 1 and report.get("kind") == "morrow-imap-acceptance", "Wrong protocol report schema")
    require(report.get("status") == "complete" and report.get("dataset") == "imap-acceptance-v1", "Protocol run did not complete")
    value = report.get("result", {})
    require(type(value.get("size")) is int and value["size"] == size and size in SIZES, "Wrong measured protocol size")
    require(type(value.get("initialOwnerRows")) is int and value["initialOwnerRows"] == 0, "Target mailbox was not initially empty")
    require(type(value.get("seededOwnerRows")) is int and value["seededOwnerRows"] == 0, "Seeded rows cannot prove download completeness")
    require(value.get("transport") == "generated-trusted-loopback-tls", "Unexpected protocol transport")
    verify_download(value.get("download"), size)
    history = value.get("history", {})
    require(history.get("status") == "complete" and integer(history.get("pages"), minimum=math.ceil(size / 50)), "History did not traverse the dataset")
    require(history.get("disconnectPreservedCheckpoint") is True and history.get("restartPreservedCheckpoint") is True, "History resume evidence missing")
    require(number(history.get("wallMs")), "Missing history duration")
    burst = value.get("newMail", {})
    require(all(type(burst.get(key)) is int and burst[key] == 120 for key in ("expected", "observed", "bodyFetches")), "New-mail burst was not downloaded exactly")
    require(burst.get("pages") == 3 and number(burst.get("wallMs")), "Burst paging evidence missing")
    verify_download(burst.get("after"), size + 120)
    flags = value.get("flags", [])
    require(isinstance(flags, list) and len(flags) == 2, "Both flag directions are required")
    for flag, enabled in zip(flags, (True, False)):
        require(flag.get("enabled") is enabled and flag.get("changedMessages") == 4 and flag.get("convergedMessages") == 4, "Flag convergence missing")
        require(integer(flag.get("rounds"), minimum=1) and integer(flag.get("roundLimit"), minimum=1)
                and flag["rounds"] <= flag["roundLimit"] and flag.get("bodyFetches") == 0
                and number(flag.get("wallMs")), "Invalid bounded flag evidence")
    reconnect = value.get("reconnect", {})
    require(reconnect.get("stalePageWrites") == 0 and all(reconnect.get(key) is True for key in (
        "manualNewImportRequired", "sameOriginCachedRowsRetained", "restartRetainedConnection")), "Reconnect ownership/checkpoint controls missing")
    require(value.get("ownerIsolation") is True and value.get("providerWrites") == 0, "Read-only owner isolation failed")
    return value


def verify_service(report):
    require(isinstance(report, dict), "Service report must be an object")
    require(report.get("status") == "complete" and report.get("driver") == "morrow-benchmark (Rust)", "Service benchmark incomplete")
    require(report.get("platform") in PLATFORMS, "Unsupported service resource sampler")
    require(report.get("binary", {}).get("immutableCopy") is True, "Service binary was not frozen")
    results = report.get("results", [])
    require(isinstance(results, list) and sorted(row.get("size", 0) for row in results) == list(SIZES), "Service sizes must be 1k/10k/50k")
    for row in results:
        require(all(row.get("checks", {}).get(key) is True for key in SERVICE_CHECKS), "Service correctness/rebuild checks failed or are missing")
        require(integer(row.get("serviceSampledMaxRSSBytes"), minimum=1), "Missing sampled service RSS")
        observed_rss = []
        idle = row.get("idle", {})
        require(number(idle.get("requestedSeconds"), minimum=30) and number(idle.get("elapsedMs"), minimum=30000)
                and number(idle.get("cpuDeltaMs")) and number(idle.get("cpuPercentOfOneCore")), "Missing 30-second idle CPU sample")
        require(math.isclose(idle["cpuPercentOfOneCore"], idle["cpuDeltaMs"] / idle["elapsedMs"] * 100, abs_tol=1e-8), "Idle CPU does not match its measured interval")
        samples = idle.get("samples", [])
        require(isinstance(samples, list) and samples, "Missing actual idle process samples")
        previous = -1
        for sample in samples:
            require(number(sample.get("elapsedMs")) and previous < sample["elapsedMs"] <= idle["elapsedMs"]
                    and integer(sample.get("rssBytes"), minimum=1) and number(sample.get("cpuMs")), "Invalid idle process sample")
            previous = sample["elapsedMs"]
            observed_rss.append(sample["rssBytes"])
        for operation in ("state", "revision", "search", "page", "sender"):
            metric = row.get(operation, {})
            samples = metric.get("samples", [])
            require(isinstance(samples, list) and len(samples) == 6 and number(metric.get("warmP95Ms")), "Incomplete service HTTP samples")
            for sample in samples:
                require(number(sample.get("ms")) and integer(sample.get("bytes"), minimum=1)
                        and integer(sample.get("rssBytes"), minimum=1), "Missing actual service HTTP/resource sample")
                observed_rss.append(sample["rssBytes"])
            require(math.isclose(metric["warmP95Ms"], percentile([sample["ms"] for sample in samples[1:]]), abs_tol=1e-8), "Service p95 does not match measured samples")
        require(row["serviceSampledMaxRSSBytes"] >= max(observed_rss), "Reported maximum RSS is below an observed service sample")
    return results


def verify_native(report):
    require(isinstance(report, dict), "Native report must be an object")
    require(report.get("schema") == 1 and report.get("kind") == "morrow-native-mailbox-latency", "Wrong native latency schema")
    require(report.get("status") == "complete" and report.get("platform") in PLATFORMS, "Native measurements incomplete")
    require(report.get("measurement") == "native-event-to-layout-display" and report.get("transport") == "intercepted-fictional-only", "HTTP timing cannot substitute for native UI events")
    if report["platform"] == "macos":
        require(all(report.get("oracleControls", {}).get(key) is True for key in MAC_ORACLE_CONTROLS),
                "Native visible selected-row/reader rejection controls are missing")
    results = report.get("results", [])
    require(isinstance(results, list) and sorted(row.get("size", 0) for row in results) == list(SIZES), "Native sizes must be 1k/10k/50k")
    for row in results:
        require(row.get("generatedRows") == row["size"] and row.get("pageSize") == 50, "Native fixture did not construct the stated dataset")
        require(row.get("unexpectedRequests") == 0 and row.get("ownerSelectionVerified") is True, "Native routing verification failed")
        samples = row.get("samples", [])
        require(isinstance(samples, list), "Missing native event samples")
        for action in ACTIONS:
            matching = [sample for sample in samples if sample.get("action") == action]
            require(len(matching) == 6, "Need one first plus five warm native events per action")
            for sample in matching:
                require(sample.get("completion") == "layout-and-display" and number(sample.get("elapsedMs"))
                        and integer(sample.get("visibleRows"), minimum=1) and sample["visibleRows"] <= 50
                        and sample.get("tableRows") == 50 and sample.get("ownerMatched") is True
                        and sample.get("renderedRowIdentityMatched") is True
                        and (action != "select" or sample.get("renderedReaderMatched") is True)
                        and (report["platform"] != "macos" or action != "select"
                             or sample.get("renderedSelectedRowIdentityMatched") is True
                             and sample.get("renderedReaderIdentityMatched") is True),
                        "Native sample lacks an observed mounted row/owner/display")
    return results


def checked_artifact(directory):
    directory = Path(directory).resolve()
    envelope = read_json(directory / "evidence.json")
    require(envelope.get("schema") == 1 and envelope.get("status") == "complete", "Stage execution failed or is incomplete")
    source = envelope.get("source", {})
    after = envelope.get("sourceAfter", {})
    for manifest in (source, after):
        require(isinstance(manifest.get("files"), dict) and manifest["files"]
                and hashlib.sha256(canonical(manifest["files"])).hexdigest() == manifest.get("digest"), "Source manifest digest mismatch")
        require(all(isinstance(manifest.get(key), str) and len(manifest[key]) == 40
                    and all(character in "0123456789abcdef" for character in manifest[key]) for key in ("commit", "tree"))
                and type(manifest.get("dirty")) is bool, "Missing exact source identity")
    require(after["digest"] == source["digest"] and after["commit"] == source["commit"], "Source changed during measurement")
    binaries = envelope.get("binaries", [])
    require(isinstance(binaries, list) and binaries, "Missing measured executable identity")
    for binary in binaries:
        name = binary.get("name", "")
        require(isinstance(name, str) and name and Path(name).name == name, "Executable must be inside its evidence directory")
        path = directory / name
        require(path.is_file() and not path.is_symlink() and sha(path) == binary.get("sha256"), "Measured executable bytes changed or are missing")
        if "fixtureAdapterSha256" in binary:
            # One fixed relative path, not a report-controlled path traversal.
            inputs = directory / "compiler-inputs"
            adapter = inputs / "AppModel.swift"
            require(inputs.is_dir() and not inputs.is_symlink() and adapter.is_file() and not adapter.is_symlink()
                    and sha(adapter) == binary["fixtureAdapterSha256"], "Measured native adapter bytes changed or are missing")
    reports = []
    for artifact in envelope.get("artifacts", []):
        name = artifact.get("file", "")
        require(isinstance(name, str) and Path(name).name == name, "Artifact must be inside its evidence directory")
        path = directory / name
        require(not path.is_symlink() and sha(path) == artifact.get("sha256"), "Artifact bytes changed")
        if artifact.get("role") == "report":
            reports.append(read_json(path))
    require(reports and envelope.get("exitCode") == 0, "Missing completed report/process status")
    return envelope, reports


def percentile(samples):
    values = sorted(samples)
    return values[math.ceil(len(values) * 0.95) - 1]


def aggregate(directories, limits=None):
    stages, source = {}, None
    errors, missing, exceeded = [], [], []
    metrics = {"service": {}, "native": {}}
    for directory in directories:
        try:
            envelope, reports = checked_artifact(directory)
            digest = envelope["source"]["digest"]
            require(source is None or source == digest, "Stages measure different source manifests")
            source = digest
            kind = envelope.get("stage")
            for report in reports:
                if kind == "protocol":
                    size = report.get("result", {}).get("size")
                    verify_protocol(report, size)
                    key = (kind, size)
                elif kind == "service":
                    rows = verify_service(report)
                    key = (kind, report["platform"])
                    metrics["service"][report["platform"]] = {str(row["size"]): {
                        "sampledMaxRSSBytes": row["serviceSampledMaxRSSBytes"],
                        "idleCPUPercentOfOneCore": row["idle"]["cpuPercentOfOneCore"]} for row in rows}
                elif kind == "native":
                    rows = verify_native(report)
                    key = (kind, report["platform"])
                    metrics["native"][report["platform"]] = {str(row["size"]): {
                        action: percentile([sample["elapsedMs"] for sample in row["samples"] if sample["action"] == action][1:])
                        for action in ACTIONS} for row in rows}
                else:
                    raise InvalidEvidence("Unknown evidence stage")
                require(key not in stages, "Duplicate stage/size/platform evidence")
                stages[key] = str(Path(directory).resolve())
        except (InvalidEvidence, AttributeError, KeyError, TypeError, OSError) as error:
            errors.append(str(error))
    for key in [("protocol", size) for size in SIZES] + [(kind, system) for kind in ("service", "native") for system in PLATFORMS]:
        if key not in stages:
            missing.append(":".join(map(str, key)))
    if limits is None:
        missing.append("caller-approved-performance-limits")
    else:
        try:
            require(limits.get("schema") == 1, "Wrong limit schema")
            for system in PLATFORMS:
                for size in SIZES:
                    bound = limits["platforms"][system][str(size)]
                    for name in ("serviceSampledMaxRSSBytes", "serviceIdleCPUPercent", "nativeWarmP95Ms"):
                        require(number(bound.get(name), minimum=0.000001), "Limits must be positive finite numbers")
                    resource = metrics["service"].get(system, {}).get(str(size))
                    if resource:
                        for measured, limit in (("sampledMaxRSSBytes", "serviceSampledMaxRSSBytes"), ("idleCPUPercentOfOneCore", "serviceIdleCPUPercent")):
                            if resource[measured] > bound[limit]:
                                exceeded.append(f"{system}:{size}:{measured}")
                    for action, value in metrics["native"].get(system, {}).get(str(size), {}).items():
                        if value > bound["nativeWarmP95Ms"]:
                            exceeded.append(f"{system}:{size}:native:{action}")
        except (InvalidEvidence, KeyError, TypeError) as error:
            errors.append("Invalid caller limit policy: " + str(error))
    status = "failed" if errors or exceeded else "incomplete" if missing else "complete"
    return {"schema": 1, "kind": "morrow-mailbox-acceptance", "status": status, "sourceDigest": source,
            "generatedAt": utc(), "missing": missing, "invalid": errors, "exceeded": exceeded, "metrics": metrics,
            "limitations": ["Controlled fictional fixtures, not live-account acceptance or a Thunderbird comparison.",
                            "Native metric ends at observed AppKit/WinUI layout/display, not compositor presentation.",
                            "Native service responses are intercepted; service HTTP cost is measured separately.",
                            "Five warm samples are a smoke distribution. RSS is sampled service-PID usage, not guaranteed peak or whole-app memory.",
                            "Protocol test drives production fetch/import/reconcile directly; it does not measure scheduler cadence, WAN, or attachments."]}


def run_command(command, directory, name, *, environment=None, timeout=7200):
    path = directory / name
    with path.open("xb") as log:
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        try:
            return process.wait(timeout=timeout)
        except BaseException:
            # Stop only this driver's owned process group before reaping its
            # leader. No process-name search or unrelated workspace cleanup.
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=log, stderr=log, timeout=15, check=False)
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            process.wait(timeout=15)
            raise


def execute_stage(args):
    directory = args.output.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    before = source_snapshot()
    artifacts, code, binaries = [], 1, []
    started = utc()
    start = time.monotonic()
    stage = args.command.removeprefix("run-")
    if stage == "native-macos":
        stage = "native"
    try:
        if args.command in ("run-protocol", "run-service"):
            cargo = args.cargo
            common = [cargo, "--manifest-path", str(ROOT / "rust/Cargo.toml")]
            env = os.environ | {"CARGO_INCREMENTAL": "0", "CARGO_TARGET_DIR": str(args.target.resolve())}
            if args.command == "run-protocol":
                require(len(set(args.sizes)) == len(args.sizes), "Protocol sizes must be distinct")
                code = run_command([common[0], "test", *common[1:], "--offline", "--locked", "--test", "imap",
                                    "--no-run", "--message-format=json"], directory, "build.log", environment=env)
                require(code == 0, "Protocol test build failed")
                executables = []
                for line in (directory / "build.log").read_text(encoding="utf-8").splitlines():
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    if message.get("reason") == "compiler-artifact" and message.get("target", {}).get("name") == "imap" and message.get("executable"):
                        executables.append(Path(message["executable"]))
                require(len(executables) == 1, "Could not identify the exact compiled IMAP test executable")
                binary = directory / ("imap-acceptance.exe" if os.name == "nt" else "imap-acceptance")
                shutil.copy2(executables[0], binary)
                binaries = [{"name": binary.name, "sha256": sha(binary)}]
                for size in args.sizes:
                    report = directory / f"protocol-{size}.json"
                    command = [str(binary), "acceptance::controlled_large_mailbox_acceptance", "--ignored", "--exact", "--nocapture"]
                    code = run_command(command, directory, f"protocol-{size}.log", environment=env | {
                        "MORROW_ACCEPTANCE_SIZE": str(size), "MORROW_ACCEPTANCE_OUTPUT": str(report)})
                    require(code == 0, f"Protocol execution failed for size {size}")
                    require(sha(binary) == binaries[0]["sha256"], "Protocol executable changed during measurement")
                    verify_protocol(read_json(report), size)
            else:
                require(sys.platform in ("darwin", "win32"), "The existing service resource sampler requires macOS or Windows")
                code = run_command([common[0], "build", *common[1:], "--offline", "--locked", "--release", "--bin", "morrow-service", "--bin", "morrow-benchmark"], directory, "build.log", environment=env)
                require(code == 0, "Service benchmark build failed")
                suffix = ".exe" if sys.platform == "win32" else ""
                binary = directory / ("morrow-service" + suffix)
                driver = directory / ("morrow-benchmark" + suffix)
                for path in (binary, driver):
                    shutil.copy2(args.target.resolve() / "release" / path.name, path)
                binaries = [{"name": path.name, "sha256": sha(path)} for path in (binary, driver)]
                code = run_command([str(driver), f"--binary={binary}", f"--output={directory / 'service.json'}", "--sizes=1000,10000,50000", "--idleSeconds=30"], directory, "service.log", environment=env)
                require(code == 0, "Service measurement failed")
                require(all(sha(directory / value["name"]) == value["sha256"] for value in binaries), "Service executable changed during measurement")
                verify_service(read_json(directory / "service.json"))
        else:
            require(sys.platform == "darwin", "Native AppKit measurement requires macOS and an active graphical session")
            binary = directory / "mailbox-native-latency"
            inputs = directory / "compiler-inputs"
            sources, original_inputs, private_inputs = prepare_macos_inputs(ROOT, inputs, before)
            adapter = inputs / "AppModel.swift"
            adapter_hash = private_inputs["AppModel.swift"]
            write_new(directory / "compiler-inputs.json", {"originals": original_inputs, "private": private_inputs})
            environment = os.environ | {"MORROW_DATA_DIR": str(directory / "fictional-workspace")}
            command = ["/usr/bin/xcrun", "swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library", "-O",
                       "-module-cache-path", str(directory / "module-cache"), *map(str, sources),
                       "-o", str(binary)]
            code = run_command(command, directory, "native-build.log", environment=environment, timeout=600)
            require(code == 0, "Native latency fixture did not compile")
            require(macos_source_inputs(ROOT, before) == original_inputs, "Native compiler source set changed during build")
            require(macos_private_inputs(inputs) == private_inputs, "Native private compiler inputs changed during build")
            binaries = [{"name": binary.name, "sha256": sha(binary), "fixtureAdapterSha256": adapter_hash}]
            version = read_json(inputs / "package.json")["version"]
            code = run_command([str(binary), "--output", str(directory / "native.json"), "--version", version], directory,
                               "native.log", environment=environment, timeout=600)
            require(code == 0, "Native action/display measurement failed")
            require(sha(binary) == binaries[0]["sha256"], "Native executable changed during measurement")
            require(macos_source_inputs(ROOT, before) == original_inputs, "Native compiler source set changed during measurement")
            require(macos_private_inputs(inputs) == private_inputs, "Native private compiler inputs changed during measurement")
            verify_native(read_json(directory / "native.json"))
        after = source_snapshot()
        require(before["digest"] == after["digest"], "Source changed during stage execution")
        status, error = "complete", None
    except (InvalidEvidence, OSError, subprocess.SubprocessError, ValueError, KeyboardInterrupt) as failure:
        status, error = "failed", str(failure)
        if isinstance(failure, KeyboardInterrupt):
            code, error = 130, "Stage interrupted; no acceptance result"
        else:
            code = code or 1
        after = source_snapshot()
    for path in sorted(directory.iterdir()):
        if path.suffix in (".json", ".log"):
            artifacts.append({"file": path.name, "sha256": sha(path), "bytes": path.stat().st_size,
                              "role": "metadata" if path.name == "compiler-inputs.json" else "report" if path.suffix == ".json" else "log"})
    envelope = {"schema": 1, "stage": stage, "status": status, "source": before, "sourceAfter": after,
                "startedAt": started, "finishedAt": utc(), "elapsedSeconds": time.monotonic() - start,
                "platform": platform.platform(), "exitCode": code, "binaries": binaries, "artifacts": artifacts}
    if error:
        envelope["error"] = error
    write_new(directory / "evidence.json", envelope)
    print(f"{status}: {directory / 'evidence.json'}")
    return 0 if status == "complete" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("run-protocol", "run-service", "run-native-macos"):
        stage = commands.add_parser(name)
        stage.add_argument("--output", type=Path, required=True, help="New evidence directory, never overwritten")
        if name != "run-native-macos":
            stage.add_argument("--target", type=Path, required=True, help="Explicit exclusive Cargo target; do not run stages concurrently")
            stage.add_argument("--cargo", default="cargo")
        if name == "run-protocol":
            stage.add_argument("--sizes", nargs="+", type=int, choices=SIZES, default=list(SIZES))
    gather = commands.add_parser("aggregate")
    gather.add_argument("--evidence", nargs="+", type=Path, required=True)
    gather.add_argument("--limits", type=Path, help="Caller-approved platform/size limits; absence is incomplete")
    gather.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "aggregate":
            result = aggregate(args.evidence, read_json(args.limits) if args.limits else None)
            write_new(args.output, result)
            print(f"{result['status']}: {args.output}")
            return {"complete": 0, "failed": 1, "incomplete": 2}[result["status"]]
        return execute_stage(args)
    except (InvalidEvidence, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
