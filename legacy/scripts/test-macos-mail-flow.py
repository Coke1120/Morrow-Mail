#!/usr/bin/env python3
"""Bounded native view checks with fictional URLProtocol responses, no service."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile


def bounded(arguments, *, cwd, env, timeout):
    process = subprocess.Popen(arguments, cwd=cwd, env=env, start_new_session=True)
    try:
        status = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # This group was created by this driver, not discovered from system data.
        # Kill before reaping its leader so compiler children cannot outlive a
        # timed-out compile, then bound the leader's cleanup wait as well.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        raise
    if status:
        raise subprocess.CalledProcessError(status, arguments)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--baseline-search", action="store_true")
    mode.add_argument("--download-repair-negative-control", action="store_true",
                      help="Privately omit the repair's shared refresh and require the stale-reader regression.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sources = root / "macos/Sources/MorrowMail"
    with tempfile.TemporaryDirectory(prefix="morrow-mail-flow-") as temporary:
        fixture = Path(temporary)
        model = (sources / "AppModel.swift").read_text()
        seam = "private(set) var baseURL: URL?"
        if model.count(seam) != 1:
            raise RuntimeError("Fixture-only transport initialization seam changed.")
        if args.download_repair_negative_control:
            # Mutation control, not a claim that the historical UI was executed:
            # keep the actual owner-bound download, omit only its shared refresh.
            anchor = "        // Invalidate a pre-download reload; do not coalesce this read into it or"
            if model.count(anchor) != 1:
                raise RuntimeError("The private repair negative-control seam changed.")
            model = model.replace(anchor, "        return\n" + anchor, 1)
        # Only the initial URL changes in this private compiler input. The
        # injected session intercepts every request and rejects unexpected paths.
        # No service is started and no real mailbox/data directory is opened.
        (fixture / "AppModel.swift").write_text(model.replace(
            seam, seam + ' = URL(string: "http://127.0.0.1:18484")', 1))
        inputs = [str(path) for path in sorted(sources.glob("*.swift"))
                  if path.name != "AppModel.swift"
                  and not (args.baseline_search and path.name == "SearchView.swift")]
        inputs.append(str(fixture / "AppModel.swift"))
        if args.baseline_search:
            search = subprocess.run([
                "git", "show", "8159b9dda81a938cd2b51258351a69f064f68a7c:macos/Sources/MorrowMail/SearchView.swift"
            ], cwd=root, check=True, capture_output=True, text=True, timeout=15).stdout
            (fixture / "SearchView.swift").write_text(search)
            inputs.append(str(fixture / "SearchView.swift"))
        inputs.append(str(root / "macos/Checks/MailFlowAssertions.swift"))
        inputs.append(str(root / "macos/Checks/DownloadRepairAssertions.swift"))
        executable = fixture / "mail-flow-checks"
        environment = os.environ.copy()
        environment["MORROW_DATA_DIR"] = str(fixture / "fictional-workspace")
        bounded(["swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library",
                        *inputs, "-o", str(executable)],
                cwd=root, env=environment, timeout=180)
        if args.download_repair_negative_control:
            bounded([str(executable), "--download-repair", "--expect-download-repair-regression"],
                    cwd=fixture, env=environment, timeout=30)
        else:
            bounded([str(executable), *(["--expect-baseline-reset"] if args.baseline_search else [])],
                    cwd=fixture, env=environment, timeout=30)
        if not args.baseline_search and not args.download_repair_negative_control:
            bounded([str(executable), "--download-repair"],
                    cwd=fixture, env=environment, timeout=30)


if __name__ == "__main__":
    main()
