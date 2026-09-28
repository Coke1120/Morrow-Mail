"""Stage the archived JS checks with CURRENT Rust binaries, version and catalog.

Only the historical CI lane needs Python/Node. The fixed beta.16 application
checkout supplies the old implementation; no retired source ships in the app.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path


root = Path(__file__).resolve().parents[1]
harness_commit = "b5b69d4d276c086ba118583f464bac11341806a0"
harness = root / ".compatibility/harness"
baseline = root / ".compatibility/beta16"
if not (baseline / "server/store.js").is_file():
    sys.exit("Check out fixed beta.16 at .compatibility/beta16 first (see docs/JAVASCRIPT_RETIREMENT.md).")

for name in [
    "tests/node-compat.js",
    "tests/rust-search.test.js",
    "tests/rust-storage.test.js",
    "tests/rust-service.test.js",
    "scripts/test-rust-upgrade.js",
]:
    source = subprocess.check_output(["git", "show", f"{harness_commit}:{name}"], cwd=root)
    destination = harness / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source)

version = json.loads((root / "package.json").read_text())["version"]
(harness / "package.json").write_text(json.dumps({"type": "module", "version": version}) + "\n")
extension = ".exe" if sys.platform == "win32" else ""
for name in [
    f"rust/target/debug/morrow-service{extension}",
    f"rust/target/debug/examples/storage_contract{extension}",
    "rust/resources/catalog.json",
]:
    destination = harness / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, destination)

worker = Path(f"rust/target/release/morrow-search{extension}")
(baseline / worker).parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(root / worker, baseline / worker)
print(f"Historical checks {harness_commit}; current candidate version {version} staged.")
