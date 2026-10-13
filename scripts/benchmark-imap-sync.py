#!/usr/bin/env python3
"""Compare immutable pre-change reconciliation and current source using mock mail.

Only an isolated checkout, generated TLS, and fresh temporary SQLite stores are
used. The baseline adapter changes TLS transport injection, not the old sync
algorithm. Builds are sequential and reuse one Cargo target directory.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

BASE = "966823b948e923df1b7a587c0d08876dee8e9773"
ROOT = Path(__file__).resolve().parent.parent


def baseline_fixture():
    source = (ROOT / "rust/tests/imap.rs").read_text()
    prefix, rest = source.split("\nasync fn seed_changed_cache(", 1)
    helpers = "\nasync fn seed_changed_cache(" + rest.split(
        "\n#[tokio::test]", 1
    )[0]
    marker = "\n#[tokio::test]\n#[ignore = \"Explicit 50k synthetic"
    benchmark = marker + source.split(marker, 1)[1]
    return prefix + helpers + benchmark


def add_tls_adapter(checkout):
    path = checkout / "rust/src/reconcile.rs"
    source = path.read_text()
    adapter = "pub async fn sync_with_tls(" + source.split("pub async fn sync(", 1)[1]
    adapter = adapter.replace(
        "fetched: &mut HashMap<String, Value>,\n)",
        "fetched: &mut HashMap<String, Value>,\n    connector: &native_tls::TlsConnector,\n)",
        1,
    )
    original = "let result = fetch(app, connection, &messages, fetched).await?;"
    assert adapter.count(original) == 1
    adapter = adapter.replace(original,
        "let result = crate::imap::reconcile_priority_with_tls(connection, &messages, connector).await;\n"
        "    let result = mail::finish_read(app, connection, result).await?;", 1)
    path.write_text(source + "\n// Benchmark-only TLS injection; immutable original batch/save/checkpoint logic.\n" + adapter)
    (checkout / "rust/tests/imap.rs").write_text(baseline_fixture())


def run(checkout, output, target):
    env = os.environ | {
        "CARGO_INCREMENTAL": "0",
        "CARGO_TARGET_DIR": str(target),
        "MORROW_IMAP_BENCH_OUTPUT": str(output),
    }
    subprocess.run([
        "cargo", "test", "--manifest-path", str(checkout / "rust/Cargo.toml"),
        "--locked", "--test", "imap", "synthetic_changed_flags_benchmark",
        "--", "--ignored", "--exact", "--nocapture",
    ], env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = ROOT / "rust/target"
    with tempfile.TemporaryDirectory(prefix="morrow-sync-baseline-") as temporary:
        checkout = Path(temporary)
        archive = checkout / "source.tar"
        with archive.open("wb") as stream:
            subprocess.run(["git", "-C", str(ROOT), "archive", "--format=tar", BASE], stdout=stream, check=True)
        with tarfile.open(archive) as source:
            source.extractall(checkout, filter="data")
        add_tls_adapter(checkout)
        run(checkout, output / "baseline.json", target)
    run(ROOT, output / "incremental.json", target)
    report = {"baselineCommit": BASE, "reports": {
        name: json.loads((output / f"{name}.json").read_text())
        for name in ("baseline", "incremental")
    }}
    (output / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
