#!/usr/bin/env python3
"""Read installed Instruments capabilities; never start a recording or reader."""

import argparse
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time


TOTAL_SECONDS = 25.0
COMMAND_SECONDS = 4.0
CAPTURE_LIMIT = 64 * 1024
COMMANDS = {
    "developer-path": ("/usr/bin/xcode-select", "-p"),
    "xcode-version": ("/usr/bin/xcodebuild", "-version"),
    "tool-path": ("/usr/bin/xcrun", "--find", "xctrace"),
    "help": ("/usr/bin/xcrun", "xctrace", "help"),
    "version": ("/usr/bin/xcrun", "xctrace", "version"),
    "help-record": ("/usr/bin/xcrun", "xctrace", "help", "record"),
    "help-list": ("/usr/bin/xcrun", "xctrace", "help", "list"),
    "list-templates": ("/usr/bin/xcrun", "xctrace", "list", "templates"),
    "help-export": ("/usr/bin/xcrun", "xctrace", "help", "export"),
}
_CANCELLED = False


def cancel(_signum, _frame):
    global _CANCELLED
    _CANCELLED = True


def tool_environment():
    # Do not expose inherited CI credentials or change the selected Xcode.
    result = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"}
    for name in ("HOME", "TMPDIR"):
        if name in os.environ:
            result[name] = os.environ[name]
    return result


def run_command(name, deadline, manual_paths=None):
    """Only fixed metadata commands may reach the subprocess boundary."""
    if name not in COMMANDS and name != "installed-manual":
        raise KeyError(name)
    if _CANCELLED or time.monotonic() >= deadline - 0.25:
        return {"name": name, "outcome": "cancelled" if _CANCELLED else "budget-exhausted"}, {"stdout": b"", "stderr": b""}
    if name == "installed-manual":
        manual_status, arguments = manual_command(manual_paths)
        if arguments is None:
            return {"name": name, "outcome": manual_status}, {"stdout": b"", "stderr": b""}
    else:
        arguments = COMMANDS[name]  # Unknown commands fail before spawning.
    started = time.monotonic()
    stop_at = min(deadline - 0.25, started + COMMAND_SECONDS)
    result = {"name": name, "command": list(arguments), "outcome": "budget-exhausted",
              "exitCode": None, "reaped": False, "captureComplete": False,
              "stdoutTruncated": False, "stderrTruncated": False, "elapsedMs": 0}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    process = None
    if _CANCELLED or started >= stop_at:
        result["outcome"] = "cancelled" if _CANCELLED else "budget-exhausted"
        return result, buffers
    try:
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=tool_environment(), start_new_session=True, close_fds=True)
        result["outcome"] = "running"
        with selectors.DefaultSelector() as selector:
            for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                if _CANCELLED or time.monotonic() >= stop_at:
                    result["outcome"] = "cancelled" if _CANCELLED else "timeout"
                    break
                for key, _events in selector.select(min(0.025, max(0, stop_at - time.monotonic()))):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    room = CAPTURE_LIMIT - len(buffers[key.data])
                    buffers[key.data].extend(chunk[:room])
                    if len(chunk) > room:
                        result[key.data + "Truncated"] = True
                        result["outcome"] = "output-limit"
                        break
                if result["outcome"] == "output-limit":
                    break
            if result["outcome"] == "running":
                while True:
                    if _CANCELLED or time.monotonic() >= stop_at:
                        result["outcome"] = "cancelled" if _CANCELLED else "timeout"
                        break
                    try:
                        process.wait(timeout=min(0.025, max(0.001, stop_at - time.monotonic())))
                        result["outcome"] = "exited" if process.returncode == 0 else "nonzero-exit"
                        result["captureComplete"] = True
                        break
                    except subprocess.TimeoutExpired:
                        continue
    except OSError:
        result["outcome"] = "spawn-or-capture-failed"
    finally:
        if process is not None:
            if result["outcome"] not in ("exited", "nonzero-exit"):
                # This fresh, unprivileged group belongs to this metadata command.
                # No sudo, detached privileged worker, or foreign PID is involved.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                result["outcome"] = "cleanup-unverified"
            result["reaped"] = process.returncode is not None
            result["exitCode"] = process.returncode
            process.stdout.close()
            process.stderr.close()
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    return result, buffers


def advertised(raw, word):
    return re.search(rb"(?m)^[ \t]*(?:xctrace[ \t]+)?" + word.encode("ascii")
                     + rb"(?:[ \t:]|$)", raw) is not None


def confirmed_xcode_paths(developer_raw, tool_raw):
    """The selected developer directory and located executable must agree."""
    try:
        values = [raw.decode("utf-8").strip() for raw in (developer_raw, tool_raw)]
        if any(not value.startswith("/") or "\n" in value or "\r" in value for value in values):
            return None
        developer, tool = (Path(value).resolve(strict=True) for value in values)
        bundle = developer.parent.parent
        if (developer.name != "Developer" or developer.parent.name != "Contents"
                or bundle.suffix != ".app" or not developer.is_dir() or not tool.is_file()
                or not tool.is_relative_to(bundle)):
            return None
        return developer, bundle
    except (OSError, ValueError, UnicodeError):
        return None


def save_bytes(path, data):
    with path.open("xb") as output:
        os.chmod(path, 0o600)
        output.write(data)


def capability_text(name, stream, raw):
    # Escape both line breaks and legacy GitHub ##[...] workflow commands.
    # This remains ordinary JSON; json.loads restores the captured tool text.
    payload = json.dumps({"name": name, "stream": stream,
                          "text": bytes(raw).decode("utf-8", errors="replace")})
    return "Instruments capability text: " + payload.replace("#", "\\u0023")


def manual_command(paths):
    """Read a fixed manual path through the same bounded subprocess collector."""
    if paths is None:
        return "xcode-path-unverified", None
    developer, bundle = paths
    for suffix in ("xctrace.1", "xctrace.1.gz"):
        candidate = developer / "usr/share/man/man1" / suffix
        try:
            resolved = candidate.resolve(strict=True)
            if not resolved.is_relative_to(bundle) or not resolved.is_file():
                return "path-outside-confirmed-xcode", None
            # The only variable argument is this canonical, fixed-name file
            # inside the confirmed selected Xcode bundle. Never invoke man,
            # a pager, shell, trace recorder, or a user-supplied command.
            arguments = (("/usr/bin/gzip", "-cd", str(resolved)) if suffix.endswith(".gz")
                         else ("/bin/cat", str(resolved)))
            return "available", arguments
        except FileNotFoundError:
            continue
        except OSError:
            return "path-check-failed", None
    return "not-found-at-known-paths", None


def probe(directory):
    started = time.monotonic()
    deadline = started + TOTAL_SECONDS
    results = []

    def collect(name, enabled=True, manual_paths=None):
        if not enabled:
            results.append({"name": name, "outcome": "not-advertised"})
            return b""
        record, streams = run_command(name, deadline, manual_paths)
        results.append(record)
        for stream, raw in streams.items():
            save_bytes(directory / (name + "." + stream + ".txt"), raw)
            # Keep fixed tool documentation accessible through CI job logs as
            # well as artifacts, escaping modern and legacy workflow commands.
            print(capability_text(name, stream, raw), flush=True)
        is_help = name.startswith("help")
        readable = record["outcome"] == "exited" or (is_help and record["outcome"] == "nonzero-exit")
        if not readable or not record.get("captureComplete", False):
            return b""
        # Help commonly uses stderr. Keep raw streams separately, and inspect
        # both for these explicitly requested help commands, including usage
        # printed with nonzero exit. Its original outcome remains in the report.
        return (bytes(streams["stdout"]) + b"\n" + bytes(streams["stderr"])
                if is_help else bytes(streams["stdout"]))

    developer = collect("developer-path")
    collect("xcode-version")
    tool = collect("tool-path")
    paths = confirmed_xcode_paths(developer, tool)
    help_text = collect("help", paths is not None)
    collect("version", advertised(help_text, "version"))
    collect("help-record", advertised(help_text, "record"))
    list_help = collect("help-list", advertised(help_text, "list"))
    collect("list-templates", bool(re.search(rb"\btemplates\b", list_help)))
    collect("help-export", advertised(help_text, "export"))
    collect("installed-manual", manual_paths=paths)
    report = {"schemaVersion": 1, "kind": "reader-instruments-capabilities",
              "productionAcceptance": False, "recordingAttempted": False,
              "attachmentAttempted": False, "readerLaunched": False,
              "scope": "unverified", "webContentMapping": "unresolved",
              "cancelled": _CANCELLED,
              "elapsedMs": round((time.monotonic() - started) * 1000),
              "limits": {"collectionBudgetSeconds": TOTAL_SECONDS, "commandSeconds": COMMAND_SECONDS,
                         "bytesPerStream": CAPTURE_LIMIT},
              "commands": results}
    save_bytes(directory / "capabilities.json", (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps(report))
    # Unsupported capabilities remain evidence. Execution/capture/cleanup failure
    # fails this diagnostic; neither outcome is a claim about profiling permission.
    if _CANCELLED:
        return 130
    return 1 if any(record["outcome"] not in ("exited", "nonzero-exit", "not-advertised",
                                            "xcode-path-unverified", "not-found-at-known-paths")
                    for record in results) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This metadata preflight requires macOS.")
    if not arguments.output.is_absolute():
        parser.error("Output must be an absolute new directory.")
    arguments.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    return probe(arguments.output)


if __name__ == "__main__":
    sys.exit(main())
