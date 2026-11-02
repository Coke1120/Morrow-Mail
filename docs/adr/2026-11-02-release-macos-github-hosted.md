# Standard GitHub-hosted macOS release runner

## Decision

After the already-started v0.3.17 release, use the standard GitHub-hosted
`macos-15` ARM64 runner for future macOS release jobs. Leo authorized this move
because the public repository's standard hosted compute is free and release
availability should not depend on his Mac mini being online.

The label pins macOS 15 instead of following `macos-latest`. It does not select a
larger runner. GitHub's [standard runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
lists `macos-15` as ARM64 and standard public-repository compute as free and
unlimited. Storage and paid larger runners have separate billing; this decision
does not promise that every Actions-related charge is free. Verified 2026-11-02.

## Compatibility and validation

Keep Node 20, the existing setuptools prerequisite, the explicit ARM64 build,
the ad hoc signer, strict bundle/archive verification, signed update manifest,
paired Windows/macOS publication and all artifact names. Assert the native Node
architecture before installing dependencies. Windows remains on `windows-2022`.

Release-workflow PRs run a separate `macos-release-check` on the same standard
image: install dependencies, run the checks, build the ARM64 package and verify
the extracted ZIP. This job has read-only repository permission, no release or
OAuth secrets, and no publishing, upload or app-launch step. Its path filter
limits this additional package build to changes in these workflows. The normal
Linux and Windows checks remain in place.

The in-flight v0.3.17 workflow remains unchanged at its tagged source commit.
This workflow-only change does not bump the version, move its tag or republish
that release. It supersedes [the Mac mini selection](2026-10-29-release-macos-self-hosted.md)
without unregistering or uninstalling the existing runner service.
