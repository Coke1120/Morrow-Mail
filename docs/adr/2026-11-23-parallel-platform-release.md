# Parallel platform release builds

## Decision

Windows and macOS build and stage in parallel on their native runners with
`contents: read`. Only the Ubuntu `publish` job has `contents: write`. It starts
after both builds succeed. All three jobs check out `github.sha` with credential
persistence disabled. The publisher uses Node 20 and installs dependencies from
the lockfile with `npm ci --ignore-scripts`.

The builds upload `release-windows-${{ github.run_attempt }}` and
`release-macos-${{ github.run_attempt }}`. The publisher downloads those exact
names from the current workflow run into their respective staging directories.
It verifies both sets of provenance against the current run and attempt, checks
the asset digests, update feeds, and signed macOS manifest, then creates one
draft. It promotes the draft after verifying the uploaded assets. Release
downloads use the [stable filenames](2026-10-22-stable-release-asset-names.md).

## Recovery

An incomplete pair from a partial rerun blocks publication. After a failed
build or missing artifact, use **Re-run all jobs** to generate both artifacts
in the same attempt. An existing draft or published release for the tag blocks
publication and requires operator review.
