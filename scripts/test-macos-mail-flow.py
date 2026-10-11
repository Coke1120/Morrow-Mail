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
    parser.add_argument("--baseline-search", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sources = root / "macos/Sources/MorrowMail"
    with tempfile.TemporaryDirectory(prefix="morrow-mail-flow-") as temporary:
        fixture = Path(temporary)
        model = (sources / "AppModel.swift").read_text()
        seam = "private(set) var baseURL: URL?"
        if model.count(seam) != 1:
            raise RuntimeError("Fixture-only transport initialization seam changed.")
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
        executable = fixture / "mail-flow-checks"
        environment = os.environ.copy()
        environment["MORROW_DATA_DIR"] = str(fixture / "fictional-workspace")
        bounded(["swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library",
                        *inputs, "-o", str(executable)],
                cwd=root, env=environment, timeout=180)
        bounded([str(executable), *(["--expect-baseline-reset"] if args.baseline_search else [])],
                cwd=fixture, env=environment, timeout=30)


if __name__ == "__main__":
    main()
