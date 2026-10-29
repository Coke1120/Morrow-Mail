# Release macOS job on the Mac mini

## Decision

The `release` workflow `macos` job runs on Leo’s Mac mini. Its runner labels are `self-hosted`, `macOS`, and `mac-mini`. The `windows` job stays on `windows-2022`. Pull-request and CI workflows stay on GitHub-hosted runners.

Registering that runner and applying the labels is separate operations work. This repository only selects the labels.

## Why

macOS release builds need a Mac. Leo approved moving only that release job off `macos-latest` onto the Mac mini. PR checks and the Windows release job stay on GitHub-hosted runners.

## Not in this change

No version bump, tag, or published release. No change to `ci.yml`, the Windows release job, signing, artifact names, or publish steps. The macOS job steps are unchanged, including the ARM64 ad hoc build.
