#!/usr/bin/env python3
"""Native review workspace checks with an intercepted fictional transport only."""
import os
import secrets
import sys
from pathlib import Path
import subprocess
import tempfile


def run_fixture(command, *, cwd, environment, mode, nonce, timeout=45, output=None):
    """Require completed native assertions, including a status-0 early-exit check."""
    sink = output if output is not None else sys.stdout.buffer
    try:
        result = subprocess.run(command, cwd=cwd, env=environment, check=False,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        sink.write(error.output or b"")
        sink.flush()
        raise
    sink.write(result.stdout)
    sink.flush()
    result.check_returncode()
    lines = result.stdout.splitlines()
    expected = f"MORROW_REVIEW_COMPLETE {mode} {nonce}".encode()
    receipts = [line for line in lines if line.startswith(b"MORROW_REVIEW_COMPLETE ")]
    if receipts != [expected]:
        raise RuntimeError(f"{mode} review fixture exited 0 without exactly one matching completion receipt (found {len(receipts)})")
    if mode == "production":
        completed = lines[:lines.index(expected)]
        for identifier in ("reader.replyMenu", "reader.organizeMenu", "reader.moreMenu", "reader.aiMenu"):
            receipt = f"Menu tracking complete: {identifier} begins=1 ended=true inspected=true".encode()
            if receipt not in completed:
                raise RuntimeError("Production review fixture lacks native menu completion before its final receipt: " + identifier)
    return result


def completion_receipt_controls():
    """Real Python subprocesses exercise only the driver's completion contract."""
    import io

    nonce = "0123456789abcdef0123456789abcdef"
    final = f"MORROW_REVIEW_COMPLETE production {nonce}\n".encode()
    baseline = f"MORROW_REVIEW_COMPLETE baseline {nonce}\n".encode()
    menus = b"".join(f"Menu tracking complete: {identifier} begins=1 ended=true inspected=true\n".encode()
                     for identifier in ("reader.replyMenu", "reader.organizeMenu", "reader.moreMenu", "reader.aiMenu"))
    prelude = "Synthetic child output, including UTF-8: 完成\n".encode()
    cases = [
        ("baseline completion", "baseline", prelude + baseline, 0, None),
        ("production completion", "production", prelude + menus + final, 0, None),
        ("status-0 premature exit", "production", prelude, 0, RuntimeError),
        ("wrong mode", "production", menus + baseline, 0, RuntimeError),
        ("wrong nonce", "production", menus + final.replace(nonce.encode(), b"0" * 32), 0, RuntimeError),
        ("duplicate completion", "production", menus + final + final, 0, RuntimeError),
        ("truncated completion", "production", menus + final[:-4], 0, RuntimeError),
        ("missing menu", "production", menus.split(b"\n", 1)[1] + final, 0, RuntimeError),
        ("incomplete menu", "production", menus.replace(b"begins=1", b"begins=0", 1) + final, 0, RuntimeError),
        ("early final receipt", "production", final + menus, 0, RuntimeError),
        ("nonzero with receipts", "production", menus + final, 23, subprocess.CalledProcessError),
    ]
    for name, mode, payload, code, expected_error in cases:
        sink = io.BytesIO()
        split = payload.find(b"\n") + 1
        command = [sys.executable, "-c", "import sys\n"
                   "sys.stderr.buffer.write(" + repr(payload[:split]) + ")\n"
                   "sys.stderr.flush()\n"
                   "sys.stdout.buffer.write(" + repr(payload[split:]) + ")\n"
                   "sys.exit(" + str(code) + ")"]
        failure = None
        try:
            run_fixture(command, cwd=None, environment=os.environ.copy(), mode=mode, nonce=nonce, output=sink)
        except Exception as error:
            failure = error
        if (expected_error is None and failure is not None) or (expected_error is not None and not isinstance(failure, expected_error)):
            raise AssertionError("Completion control failed: " + name) from failure
        if sink.getvalue() != payload:
            raise AssertionError("Completion control lost child output: " + name)
    sink = io.BytesIO()
    command = [sys.executable, "-c", "import sys, time; print('before timeout', flush=True); print('timeout stderr', file=sys.stderr, flush=True); time.sleep(5)"]
    try:
        run_fixture(command, cwd=None, environment=os.environ.copy(), mode="production", nonce=nonce, timeout=1, output=sink)
    except subprocess.TimeoutExpired:
        if sink.getvalue() != b"before timeout\ntimeout stderr\n":
            raise AssertionError("Timeout lost child output")
    else:
        raise AssertionError("A timed-out child passed completion")
    print("Review completion controls: 2 complete subprocesses and 10 premature/mismatched/incomplete/nonzero/timeout negatives passed; logs retained. No AppKit execution.")


if sys.argv[1:] == ["--completion-receipt-controls"]:
    completion_receipt_controls()
    raise SystemExit(0)

root = Path(__file__).resolve().parents[1]
sources = root / "macos/Sources/MorrowMail"
baseline = sys.argv[1:] == ["--baseline-lifecycle"]
if sys.argv[1:] and not baseline:
    raise ValueError("Unknown review fixture option")
with tempfile.TemporaryDirectory(prefix="morrow-review-check-") as temporary:
    fixture = Path(temporary)
    overrides = {}
    if baseline:
        # Immutable failed candidate, used only for synthetic negative controls.
        # Today shares the current reply editor; keep the baseline consumer
        # with its original view rather than mixing it with the current API.
        for name in ["ReviewWorkspaceState.swift", "ReplySuggestionsView.swift", "TodayView.swift"]:
            overrides[name] = fixture / name
            overrides[name].write_bytes(subprocess.check_output(["git", "show", "8f9130737e297338abba1925db3453a30496bd68:macos/Sources/MorrowMail/" + name], cwd=root))
        # The old Today file declared this helper privately; current Models
        # provides the identical property. Adapt only that duplicate in the
        # temporary baseline copy, leaving its lifecycle handlers untouched.
        property_body = b"var isObject: Bool { if case .object = self { return true }; return false }"
        duplicate = b"private extension JSON { " + property_body + b" }\n"
        today = overrides["TodayView.swift"].read_bytes()
        models = (sources / "Models.swift").read_bytes()
        if (today.count(duplicate) != 1 or today.count(b"var isObject:") != 1
                or models.count(property_body) != 1 or models.count(b"var isObject:") != 1):
            raise RuntimeError("The baseline Today JSON helper compatibility seam changed")
        overrides["TodayView.swift"].write_bytes(today.replace(duplicate, b"", 1))
    model = (sources / "AppModel.swift").read_text()
    seam = "private(set) var baseURL: URL?"
    if model.count(seam) != 1:
        raise RuntimeError("The private fixture initialization seam changed")
    (fixture / "AppModel.swift").write_text(model.replace(seam, seam + ' = URL(string: "http://127.0.0.1:18484")', 1))
    inputs = [str(overrides.get(p.name, p)) for p in sorted(sources.glob("*.swift")) if p.name != "AppModel.swift"]
    # Exercise the exact production Button action, including AppModel.perform
    # and the service request/reload. No handwritten replica of its handler.
    view = overrides.get("ReplySuggestionsView.swift", sources / "ReplySuggestionsView.swift").read_text()
    marker = 'Button("Skip suggestion") {'
    if view.count(marker) != 1:
        raise RuntimeError("The production Skip action seam changed")
    action = view.split(marker, 1)[1].split('}.disabled(', 1)[0]
    invoke = fixture / "InvokeReviewSkip.swift"
    invoke.write_text('''import SwiftUI
@MainActor func invokeReviewSkip(_ proposal: JSON, model: AppModel) async throws {
    let review = model.review, owner = model.review.owner(proposal)
''' + action + '''
    let deadline = Date().addingTimeInterval(5)
    while (model.busy || review.writing) && Date() < deadline { try await Task.sleep(nanoseconds:20_000_000) }
    if model.busy || review.writing { throw APIError("Synthetic Skip handler did not complete") }
}
''')
    inputs.append(str(invoke))
    inputs += [str(fixture / "AppModel.swift"), str(root / "macos/Checks/ReviewWorkspaceFixtures.swift"), str(root / "macos/Checks/ReviewWorkspaceAssertions.swift")]
    environment = os.environ.copy()
    environment["MORROW_DATA_DIR"] = str(fixture / "fictional-workspace")
    environment["MORROW_REVIEW_COMPLETION_NONCE"] = secrets.token_hex(16)
    if baseline:
        environment["MORROW_REVIEW_BASELINE"] = "1"
    else:
        environment.pop("MORROW_REVIEW_BASELINE", None)
    executable = fixture / "review-check"
    subprocess.run(["swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library", "-module-cache-path", str(fixture / "module-cache"), *inputs, "-o", str(executable)], cwd=root, env=environment, check=True, timeout=180)
    run_fixture([str(executable)], cwd=fixture, environment=environment, mode="baseline" if baseline else "production",
                nonce=environment["MORROW_REVIEW_COMPLETION_NONCE"], timeout=45)
