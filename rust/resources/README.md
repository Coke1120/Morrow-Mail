# Canonical static resources, version 1

`catalog.json` and `opencc.json` are the checked-in source data, not build outputs.
Their bytes are unchanged from the previous Node generator. `manifest.json` fixes
the resource/schema versions, exact sizes and SHA-256 hashes, original source
commit, package versions, redistribution terms and source archive URLs. No Node,
npm package, network request or local timezone is needed to validate or export them.

From the repository root:

```sh
cargo run --manifest-path rust/Cargo.toml --locked --bin morrow-resources -- --check
cargo test --manifest-path rust/Cargo.toml --locked --bin morrow-resources
# Optional byte-for-byte export to a new directory; existing paths are rejected.
cargo run --manifest-path rust/Cargo.toml --locked --bin morrow-resources -- --output /tmp/morrow-static-v1
```

The Rust service embeds these JSON paths. Their original JavaScript sources and
generator are retained at the exact historical commits in `manifest.json`; those
paths are provenance references, not dependencies on current source. Policy time
zone is resolved at runtime; the portable catalog retains `UTC`. No JS generator
or npm wrapper is needed to validate/export the current resources.

The normalization test covers every unique key in the pinned OpenCC dictionaries
plus the four existing Unicode/segmentation edge cases: 5,343 inputs in total. Its
golden digest was captured from the old `normalizeSearch` / `searchTokens` using
opencc-js 1.4.2 before this migration. The manifest specifies ordering and JSON
encoding, so the entire golden comparison runs without JavaScript. Changing only
the digest to hide a mismatch is not an accepted resource update.

## Redistribution and provenance

The catalog is Morrow Mail data under the repository's MIT license. The OpenCC
resource was produced from the `hk2s` preset in opencc-js **1.4.2**, incorporating
opencc-data **1.4.2**. Dictionary flattening and serialization are recorded in the
manifest; no dictionary entries, chain order, defaults or search versions changed.

Keep all three existing, byte-identical upstream notices in source and packaged
third-party notices:

| Checked-in file | Original opencc-js archive path |
| --- | --- |
| `OPENCC-JS-LICENSE.txt` | `LICENSE` (MIT) |
| `OPENCC-DATA-LICENSE.txt` | `LICENSES/Apache-2.0.txt` |
| `OPENCC-NOTICES.md` | `THIRD_PARTY_LICENSES.md` |

A Node-free license collector reads these files and package/version/source
metadata from `manifest.json`; it must not inspect `node_modules`. Their checksums
are validated along with the data, so a missing or modified notice fails the check.

For an intentional data update, review the upstream source and notices, replace
only the affected canonical files, increment `resourceVersion` and the checker's
supported version, and update hashes and independent golden evidence together.
Do not add a second editable copy or regenerate defaults from the compatibility
service. Retain any storage/index migration required by a normalization change.
