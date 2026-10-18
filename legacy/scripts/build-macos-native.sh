#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
export CARGO_INCREMENTAL=0
exec cargo run --manifest-path rust/Cargo.toml --locked --bin morrow-build -- macos "$@"
