#!/usr/bin/env python3
"""Native review workspace checks with an intercepted fictional transport only."""
import os
import sys
from pathlib import Path
import subprocess
import tempfile

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
        for name in ["ReviewWorkspaceState.swift", "ReplySuggestionsView.swift"]:
            overrides[name] = fixture / name
            overrides[name].write_bytes(subprocess.check_output(["git", "show", "8f9130737e297338abba1925db3453a30496bd68:macos/Sources/MorrowMail/" + name], cwd=root))
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
    if baseline:
        environment["MORROW_REVIEW_BASELINE"] = "1"
    executable = fixture / "review-check"
    subprocess.run(["swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library", "-module-cache-path", str(fixture / "module-cache"), *inputs, "-o", str(executable)], cwd=root, env=environment, check=True, timeout=180)
    subprocess.run([str(executable)], cwd=fixture, env=environment, check=True, timeout=45)
