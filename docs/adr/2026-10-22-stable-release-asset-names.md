# Stable release download names

## Decision

GitHub Release assets that people download use stable filenames. The release tag (`v` plus the package version) isolates each copy. This repository does not publish a second, versioned copy of the same bytes.

- Windows NSIS: `Morrow-Mail-Setup.exe` and `Morrow-Mail-Setup.exe.blockmap`
- Windows portable: `Morrow-Mail.exe`
- macOS: `Morrow-Mail-arm64-mac.zip` and `Morrow-Mail-arm64-mac.zip.blockmap`

`latest.yml` names the NSIS setup. `latest-mac.yml` names the zip. The signed macOS manifest URL is `https://github.com/Coke1120/Morrow-Mail/releases/download/vX.Y.Z/Morrow-Mail-${arch}-mac.zip`. electron-builder `artifactName` patterns produce those files directly. Staging still requires `path`, `files[0].url`, sha512, and size to match the staged bytes.

## Why

Manual download names that repeat the version are awkward, and the tag already distinguishes releases. electron-updater does not need a versioned twin: it reads the filename from the feed and requests the blockmap as that name plus `.blockmap`. When it looks up the previous blockmap it rewrites the version inside `/releases/download/vX.Y.Z/`, which still contains the version. After two stable-name releases, differential updates keep working. The first Windows hop away from a versioned installer name falls back to a full download.

The signed macOS verifier binds the manifest URL to one filename. Shipping clients that still expect `Morrow-Mail-X.Y.Z-arch-mac.zip` cannot authenticate the stable-name manifest. Those Macs need one manual install. Changing the published name without changing `artifactURL` and the download allowlist would make new manifests fail their own check. A parallel versioned asset would keep old Macs updating only if the signed URL stayed on the versioned name, which leaves the version in the human-facing asset list. This change keeps one name per asset.

## Not in this change

No package version bump. No edit to an in-flight v0.2.27 release. The installed program name stays `Morrow Mail`. Windows stays on electron-updater. The portable exe stays out of `latest.yml`.
