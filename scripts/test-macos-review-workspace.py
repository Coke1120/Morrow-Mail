#!/usr/bin/env python3
"""Native review workspace checks with an intercepted fictional transport only."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
sources = root / "macos/Sources/MorrowMail"
with tempfile.TemporaryDirectory(prefix="morrow-review-check-") as temporary:
    fixture = Path(temporary)
    model = (sources / "AppModel.swift").read_text()
    seam = "private(set) var baseURL: URL?"
    if model.count(seam) != 1:
        raise RuntimeError("The private fixture initialization seam changed")
    (fixture / "AppModel.swift").write_text(model.replace(seam, seam + ' = URL(string: "http://127.0.0.1:18484")', 1))
    inputs = [str(p) for p in sorted(sources.glob("*.swift")) if p.name != "AppModel.swift"]
    inputs += [str(fixture / "AppModel.swift"), str(root / "macos/Checks/ReviewWorkspaceFixtures.swift"), str(root / "macos/Checks/ReviewWorkspaceAssertions.swift")]
    environment = os.environ.copy()
    environment["MORROW_DATA_DIR"] = str(fixture / "fictional-workspace")
    executable = fixture / "review-check"
    subprocess.run(["swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library", "-module-cache-path", str(fixture / "module-cache"), *inputs, "-o", str(executable)], cwd=root, env=environment, check=True, timeout=180)
    subprocess.run([str(executable)], cwd=fixture, env=environment, check=True, timeout=45)
