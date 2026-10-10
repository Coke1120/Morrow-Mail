#!/usr/bin/env python3
"""Bounded, metadata-only preflight for the fictional native reader fixture.

Invoke through morrow-native-check, which owns this process group and the reader's
unchanged 30-second deadline. This script never attaches, samples, or establishes
WebContent ownership. In particular, procinfo field shapes are not an authenticated
grammar: arbitrary argv/environment text must never become an ownership proof.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import selectors
import signal
import subprocess
import sys
import time


SCRIPT_STARTED = time.monotonic()
INTERNAL_SECONDS = 7.25  # Leave startup/serialization/reaping room inside Rust's 8s.
CAPTURE_LIMIT = 64 * 1024
MAX_CANDIDATES = 1
TOOL_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"}
WEB_CONTENT = (
    "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/"
    "com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"
)
FIELD_NAMES = ("pid", "unique pid", "ppid", "uid", "responsible pid", "responsible unique pid")
FIELD_PATTERN = re.compile(
    rb"[ \t]*(pid|unique pid|ppid|uid|responsible pid|responsible unique pid) = ([0-9]{1,20})[ \t]*"
)
_ACTIVE_CHILD = None


class ProbeCancelled(Exception):
    pass


def cancel_probe(_signum, _frame):
    raise ProbeCancelled()


def diagnostic_categories(raw):
    """Fixed categories only; never retain a diagnostic's variable text."""
    lowered = raw.lower()
    requires_root = any(phrase in lowered for phrase in (b"requires root", b"must be run as root"))
    denied = any(phrase in lowered for phrase in (b"operation not permitted", b"permission denied"))
    category = ("multiple-permission-diagnostics" if requires_root and denied else
                "requires-root" if requires_root else "permission-denied" if denied else "none")
    return {
        "permissionDiagnosticObserved": requires_root or denied,
        "permissionDiagnosticCategory": category,
        "commandTimeoutPolicyRejected": any(phrase in lowered for phrase in (
            b"not allowed set a command timeout", b"not allowed to set a command timeout",
        )),
    }


def run_tool(arguments, deadline, timeout=0.8):
    """No shell, inherited helper group, capped pipes, bounded kill/reap.

    Direct tools initially inherit the helper group that Rust terminates on reader
    completion or its deadline. This script never detaches a child; it also bounds
    and reaps every direct tool itself. A tool's internal descendants are not an
    ownership assertion made by this preflight.
    """
    global _ACTIVE_CHILD
    stop_at = min(deadline, time.monotonic() + timeout)
    info = {"exitCode": None, "timedOut": False, "truncated": False, "spawnFailed": False, "reaped": False}
    info.update(diagnostic_categories(b""))
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    if time.monotonic() >= stop_at:
        info["timedOut"] = True
        return info, b""
    process = None
    try:
        process = subprocess.Popen(
            arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=TOOL_ENV, close_fds=True,
        )
        _ACTIVE_CHILD = process
        with selectors.DefaultSelector() as selector:
            for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = stop_at - time.monotonic()
                if remaining <= 0:
                    info["timedOut"] = True
                    break
                for key, _events in selector.select(min(0.025, remaining)):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    destination = streams[key.data]
                    room = CAPTURE_LIMIT - len(destination)
                    destination.extend(chunk[:room])
                    if len(chunk) > room:
                        info["truncated"] = True
                        break
                if info["truncated"]:
                    break
            if not info["timedOut"] and not info["truncated"]:
                try:
                    process.wait(timeout=max(0.001, stop_at - time.monotonic()))
                except subprocess.TimeoutExpired:
                    info["timedOut"] = True
    except OSError:
        info["spawnFailed"] = True
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            # The outer Rust owner remains authoritative if an OS wait itself
            # cannot complete. Never turn metadata collection into an unbounded wait.
            try:
                process.wait(timeout=0.15)
            except subprocess.TimeoutExpired:
                info["timedOut"] = True
            info["exitCode"] = process.returncode
            info["reaped"] = process.returncode is not None
            for pipe in (process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
        _ACTIVE_CHILD = None
    info["stdoutBytes"] = len(streams["stdout"])
    info["stderrBytes"] = len(streams["stderr"])
    info.update(diagnostic_categories(bytes(streams["stdout"]) + bytes(streams["stderr"])))
    # stderr is never returned, printed, or persisted: tool errors can contain
    # untrusted process text. Only fixed categories and bounded counts survive.
    return info, bytes(streams["stdout"])


def successful(info):
    return info["exitCode"] == 0 and info["reaped"] and not any(info[key] for key in ("timedOut", "truncated", "spawnFailed"))


def sudo_timeout_true_capability(deadline):
    """Probe only a fixed no-work command, never a privileged metadata query.

    A successful sudo exit establishes this command's policy acceptance only.
    On cancellation/timeout, the existing runner can reap its direct sudo child;
    it cannot certify cleanup of an arbitrary privileged descendant. This sole
    permitted descendant is /usr/bin/true, which exits without performing work.
    Do not substitute launchctl, sample, a shell, or user-supplied arguments here.
    """
    result = {
        "scope": "fixed-true-command-only", "timeoutSeconds": 1,
        "metadataQueryAuthorized": False, "samplingAuthorized": False,
        "attempted": False, "status": "not-attempted-budget", "tool": None,
    }
    # Leave the sudo timeout room to act plus bounded supervisor capture/reap;
    # never reset the script's 7.25s or Rust's enclosing 8s/30s deadlines.
    if deadline - time.monotonic() < 3.5:
        return result
    result["attempted"] = True
    info, _raw = run_tool(["/usr/bin/sudo", "-n", "-T", "1", "/usr/bin/true"], deadline, 3.25)
    result["tool"] = info
    result["status"] = "inconclusive"
    if successful(info):
        result["status"] = "accepted-fixed-true"
    elif (info["exitCode"] is not None and info["reaped"]
          and not any(info[key] for key in ("timedOut", "truncated", "spawnFailed"))
          and info["commandTimeoutPolicyRejected"]):
        result["status"] = "timeout-policy-rejected"
    return result


def procinfo_shapes(raw):
    """Return fixed categories/counts and transient numeric observations only.

    No unknown labels or values are exported. Even recognized numeric values
    stay in memory; the report includes only comparisons with known PID inputs.
    Duplicate or out-of-range fields cannot produce a comparison result.
    """
    values = {name: [] for name in FIELD_NAMES}
    unknown = 0
    invalid = 0
    for line in raw.splitlines():
        match = FIELD_PATTERN.fullmatch(line)
        if match is None:
            unknown += bool(line.strip())
            continue
        name = match.group(1).decode("ascii")
        value = int(match.group(2))
        if value > (1 << 64) - 1:
            invalid += 1
            values[name].append(None)
        else:
            values[name].append(value)
    shapes = {name: {"count": len(found), "singleUnsigned64": len(found) == 1 and found[0] is not None}
              for name, found in values.items()}
    unique = {name: found[0] for name, found in values.items() if len(found) == 1 and found[0] is not None}
    return {"fields": shapes, "unknownLineCount": unknown, "invalidUnsignedCount": invalid}, unique


def comparisons(observed, subject_pid, reader_pid, reader_unique):
    def compare(name, expected):
        return observed[name] == expected if name in observed and expected is not None else None
    return {
        "pidMatchesSubject": compare("pid", subject_pid),
        "responsiblePidMatchesSelf": compare("responsible pid", subject_pid),
        "responsiblePidMatchesReader": compare("responsible pid", reader_pid),
        "responsibleUniquePidMatchesReader": compare("responsible unique pid", reader_unique),
        "comparisonIsOwnershipProof": False,
    }


# Public Darwin ABI, not private coalition/responsibility APIs. Fail closed if
# libproc returns any size other than the complete 136-byte public structure.
# https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
class ProcBsdInfo(ctypes.Structure):
    _fields_ = (
        [(name, ctypes.c_uint32) for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
        + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
        + [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")]
        + [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
    )


class ProcessMetadata:
    def __init__(self):
        self.library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.library.proc_pidinfo.restype = ctypes.c_int
        self.library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.library.proc_pidpath.restype = ctypes.c_int

    def identity(self, pid):
        info = ProcBsdInfo()
        if ctypes.sizeof(info) != 136:
            return None
        copied = self.library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))  # PROC_PIDTBSDINFO
        if copied != ctypes.sizeof(info) or info.pid != pid or info.start_sec == 0 or info.start_usec >= 1_000_000:
            return None
        path = ctypes.create_string_buffer(4096)  # PROC_PIDPATHINFO_MAXSIZE
        copied = self.library.proc_pidpath(pid, path, len(path))
        if copied <= 0 or copied >= len(path):
            return None
        try:
            executable = path.value.decode("utf-8", errors="strict")
        except UnicodeError:
            return None
        if not executable.startswith("/") or "\n" in executable or "\r" in executable:
            return None
        return {"pid": pid, "uid": info.uid, "parentPid": info.ppid,
                "startSeconds": info.start_sec, "startMicroseconds": info.start_usec,
                "executablePath": os.path.realpath(executable)}


def eligible_candidate(identity, reader, canonical_paths):
    return (identity is not None and identity["uid"] == reader["uid"]
            and identity["executablePath"] in canonical_paths
            and (identity["startSeconds"], identity["startMicroseconds"])
            > (reader["startSeconds"], reader["startMicroseconds"]))


def public_identity(identity, is_reader=False):
    if identity is None:
        return None
    result = {key: value for key, value in identity.items() if key != "executablePath"}
    if is_reader:
        # Do not publish an arbitrary executable path supplied through a PID.
        result["executablePathSha256"] = hashlib.sha256(identity["executablePath"].encode()).hexdigest()
    else:
        result["executablePath"] = identity["executablePath"]  # Already canonical system allowlist.
    return result


def fixed_plist_versions(path, keys):
    try:
        with open(path, "rb") as source:
            raw = source.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            return {"available": False}
        contents = plistlib.loads(raw)
        if not isinstance(contents, dict):
            return {"available": False}
        result = {"available": True}
        for key in keys:
            value = contents.get(key)
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._+()-]{1,128}", value):
                result[key] = value
        return result
    except (OSError, ValueError, TypeError, plistlib.InvalidFileException):
        return {"available": False}


def collect(reader_pid, deadline):
    result = {
        "schemaVersion": 1, "kind": "reader-ownership-preflight", "readerPid": reader_pid,
        "productionAcceptance": False, "attachmentAttempted": False,
        "ownershipStatus": "unresolved", "status": "metadata-unavailable",
        "reason": "reader-metadata-unavailable", "reader": None, "candidates": [],
        "candidateCount": 0, "candidatesTruncated": False,
        "tools": {}, "platform": {}, "webKit": {},
    }
    if sys.platform != "darwin":
        result["reason"] = "unsupported-platform"
        return result
    result["platform"] = fixed_plist_versions(
        "/System/Library/CoreServices/SystemVersion.plist", ("ProductVersion", "ProductBuildVersion"))
    result["webKit"] = fixed_plist_versions(
        "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist",
        ("CFBundleVersion", "CFBundleShortVersionString"))
    result["tools"]["available"] = {
        name: os.path.isfile(path) and os.access(path, os.X_OK) for name, path in (
            ("ps", "/bin/ps"), ("launchctl", "/bin/launchctl"),
            ("sudo", "/usr/bin/sudo"), ("sample", "/usr/bin/sample"), ("xcodebuild", "/usr/bin/xcodebuild"))
    }
    try:
        metadata = ProcessMetadata()
    except (OSError, AttributeError):
        return result
    reader = metadata.identity(reader_pid)
    if reader is None or reader["uid"] != os.getuid():
        return result
    result["reader"] = {"before": public_identity(reader, True)}
    canonical_paths = {os.path.realpath(WEB_CONTENT)}
    # Discovery reads only PID/UID/executable metadata. procinfo is reserved for
    # canonical same-user candidates born strictly after this fixture started.
    discovery, raw = run_tool(["/bin/ps", "-ww", "-axo", "pid=,uid=,comm="], deadline)
    result["tools"]["discovery"] = discovery
    candidates = []
    if successful(discovery):
        for line in raw.splitlines():
            fields = line.split(None, 2)
            if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
                continue
            if int(fields[1]) != reader["uid"]:
                continue
            try:
                path = fields[2].decode("utf-8", errors="strict")
            except UnicodeError:
                continue
            # ps may render the short executable name. It is discovery only;
            # libproc still has to return the exact canonical system path.
            if path != "com.apple.WebKit.WebContent" and os.path.realpath(path) not in canonical_paths:
                continue
            candidate = metadata.identity(int(fields[0]))
            if eligible_candidate(candidate, reader, canonical_paths):
                candidates.append(candidate)
    candidates.sort(key=lambda candidate: candidate["pid"])
    result["candidateCount"] = len(candidates)
    result["candidatesTruncated"] = len(candidates) > MAX_CANDIDATES

    def procinfo(pid):
        # First observe the runner's real permissions without escalating. A
        # runner-owned supervisor cannot reliably kill a privileged sudo child.
        tool, raw = run_tool(["/bin/launchctl", "procinfo", str(pid)], deadline, 1.0)
        tool["privilegeMode"] = "unprivileged"
        shapes, observed = procinfo_shapes(raw if successful(tool) else b"")
        return {"tool": tool, "shape": shapes}, observed

    reader_report, reader_observed = procinfo(reader_pid)
    reader_unique = reader_observed.get("unique pid")
    reader_report["observations"] = comparisons(reader_observed, reader_pid, reader_pid, reader_unique)
    result["reader"]["procinfo"] = reader_report
    # Ambiguous discovery is itself useful evidence. Do not query several
    # unrelated new processes in search of one that happens to match.
    for candidate in candidates if len(candidates) == 1 else []:
        if time.monotonic() >= deadline:
            break
        item = {"before": public_identity(candidate)}
        # Recheck immediately before querying to avoid a stale discovery PID.
        if metadata.identity(reader_pid) != reader or metadata.identity(candidate["pid"]) != candidate:
            item["identityStable"] = False
        else:
            report, observed = procinfo(candidate["pid"])
            report["observations"] = comparisons(observed, candidate["pid"], reader_pid, reader_unique)
            item["procinfo"] = report
            item["identityStable"] = metadata.identity(candidate["pid"]) == candidate
        result["candidates"].append(item)
    result["reader"]["identityStable"] = metadata.identity(reader_pid) == reader

    version_tool, raw = run_tool(["/usr/bin/xcodebuild", "-version"], deadline)
    version = re.fullmatch(rb"Xcode ([0-9.]{1,32})\nBuild version ([A-Za-z0-9.]{1,32})\n?", raw)
    result["tools"]["xcodeVersion"] = {"tool": version_tool}
    if successful(version_tool) and version:
        result["tools"]["xcodeVersion"].update({"version": version[1].decode(), "build": version[2].decode()})
    result["tools"]["sudoTimeoutTrueCapability"] = sudo_timeout_true_capability(deadline)
    result["status"] = "completed"
    result["reason"] = "preflight-observed"
    if time.monotonic() >= deadline:
        result.update(status="budget-exhausted", reason="budget-exhausted")
    elif not result["reader"]["identityStable"]:
        result["reason"] = "reader-identity-changed"
    elif not successful(discovery) or not successful(reader_report["tool"]):
        result.update(status="metadata-unavailable", reason="tool-metadata-unavailable")
    elif result["candidatesTruncated"]:
        result["reason"] = "candidate-limit"
    elif not candidates:
        result["reason"] = "no-canonical-webcontent-candidate"
    return result


def write_exclusive(path, result):
    data = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(data) > 128 * 1024:
        raise ValueError("report-too-large")
    # O_EXCL rejects both existing files and symlinks, including broken symlinks.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as destination:
        destination.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader-pid", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.reader_pid <= 0 or args.reader_pid > 2_147_483_647 or not args.output.is_absolute():
        parser.error("positive PID and absolute new output file required")
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, cancel_probe)
    try:
        result = collect(args.reader_pid, SCRIPT_STARTED + INTERNAL_SECONDS)
        result["elapsedMs"] = max(0, int((time.monotonic() - SCRIPT_STARTED) * 1000))
        write_exclusive(args.output, result)
    except ProbeCancelled:
        return 130
    except Exception:
        # Exception strings may include paths or tool/process text. Keep this
        # failure channel fixed; Rust retains the distinct missing-report state.
        print("Reader ownership preflight: report-failed", file=sys.stderr)
        return 1
    print("Reader ownership preflight: metadata recorded; ownership unresolved; attach=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
