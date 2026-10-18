# Legacy Morrow Mail (pre-Electron)

This folder is a **source snapshot** of the last public Rust / Swift / Windows
native Morrow Mail tree, taken from `Coke1120/Morrow-Mail` `main` at:

- Commit: `6b01225a1abfad6ce6478fd4b3ef090702d0f93f`
- Message: Integrate native mail fixes and controlled mailbox acceptance for 0.8.3 (#58)
- Snapshot date: 2026-10-18 (Asia/Hong_Kong)

On 2026-10-18 the public `Coke1120/Morrow-Mail` `main` was force-replaced with
the Electron rewrite previously developed in private `Coke1120/genmail-rea`
(rebranded as Morrow Mail). Git history of the native app is no longer on
`main`; this directory preserves the working tree so the old app can still be
browsed and built from source.

This is **not** a git submodule and does not retain the old `.git` history.
Old GitHub Releases / tags that pointed at the native builds were removed as
part of the cutover so "Latest" would not keep serving Rust/Swift installers.

Build / run instructions for this tree remain in the files under this folder
(`README.md` at the legacy root was renamed to `LEGACY_APP_README.md` if
present alongside this file; see also `AGENTS.md`, `macos/`, `rust/`, `windows/`).
