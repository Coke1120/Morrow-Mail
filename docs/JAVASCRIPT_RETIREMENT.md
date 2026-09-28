# JavaScript source retirement

The owner requested removal of unused JavaScript after the native cutover. Current
tracked source has no `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts` or `.tsx` files. The
React/browser UI, Electron host, Node service, npm build/test tools and lockfile
are retired. `package.json` remains product metadata and the common version
source, without npm scripts or dependencies. SwiftUI starts/backups through Rust
only; WinUI already did so. Existing data and published binaries are unchanged.

This is **not zero JavaScript execution**:

- The macOS HTML reader still uses two app-owned WebKit expressions for height
  and scroll position. They remain necessary to preserve automatic sizing and
  nested scrolling. Email scripts stay disabled, with no token or script bridge.
- Native reader security fixtures use app-controlled script probes to verify
  that email scripts, external resources and unsafe navigation remain blocked.
- Two explicitly ignored Rust tests invoke the historical Node updater and HTML
  sanitizer. The isolated compatibility lane also runs archived storage/search/
  service and actual installer/restart/backup checks. Normal native builds and
  tests do not need Node, npm or Python.
- JavaScript-looking hostile markup in sanitizer fixtures is test data; removing
  it would weaken the security checks.

No fixed-height reader redesign is included. Browser/Electron development is no
longer supported from current source. Manual Windows UI/accessibility, minimum
OS, live-provider and stable distribution-signing gates remain outstanding as
recorded in `VERIFICATION.md`; source removal does not mark those gates passed.

## Immutable compatibility inputs

| Input | Commit |
| --- | --- |
| Fixed beta.16 application, original updater and npm lockfile | `7ab30cbb3e496118513a98f8211ec66481e282c4` |
| Final JS test harness before retirement | `b5b69d4d276c086ba118583f464bac11341806a0` |

`scripts/prepare-historical-checks.py` retrieves only the five harness files
from that exact Git object into ignored `.compatibility/harness`. It supplies
the **current** version, catalog, debug service/storage-contract binary and
release search worker. Node modules are installed only in the fixed beta.16
checkout. The old application remains the comparison oracle; current native
packages remain the upgrade destinations. The historical release/signing gate
is still required on both platforms.

For local reproduction, materialize beta.16 into an isolated
`.compatibility/beta16` directory from the pinned commit, then run from the
repository root (Node 22.13+, Python 3, Rust 1.98+):

```sh
git fetch --no-tags origin b5b69d4d276c086ba118583f464bac11341806a0
npm ci --ignore-scripts --prefix .compatibility/beta16
cargo build --manifest-path rust/Cargo.toml --locked --example storage_contract --bin morrow-service
cargo build --manifest-path rust/Cargo.toml --locked --release --bin morrow-search
python3 scripts/prepare-historical-checks.py
export MORROW_NODE_COMPAT_ROOT="$PWD/.compatibility/beta16"
export MORROW_TEST_RUST=1
cargo test --manifest-path rust/Cargo.toml --locked --lib historical_node_validator_accepts_native_layout -- --ignored
cargo test --manifest-path rust/Cargo.toml --locked --test message_html node_and_rust_share_safe_reader_semantics -- --ignored
(cd .compatibility/harness && node --test tests/rust-search.test.js tests/rust-storage.test.js tests/rust-service.test.js)
node .compatibility/harness/scripts/test-rust-upgrade.js --candidate="$PWD/build/macos-native/Morrow Mail.app" --compatibility-root="$MORROW_NODE_COMPAT_ROOT"
```

On Windows the final candidate is the complete native `Morrow Mail-win32-x64`
folder; the workflow shows the equivalent PowerShell commands. All checks use
isolated fictional workspaces, fixture keys and loopback providers. Never point
them at a real mailbox workspace. Generated historical checkouts and existing
ignored build/dependency directories are not committed or packaged. Old resource
manifest paths remain valid provenance references to their recorded Git commits.
