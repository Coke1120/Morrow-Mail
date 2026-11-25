# Features manifests

Features entries live in individual JSON files in `renderer/features/`. To add an entry, create `900-<id>.json` with the fields `id`, `title`, `category`, and `blurb`. Use a unique lower-case kebab-case ID that matches the filename. Entries sort by the three-digit bucket and then by ID, so new entries can share bucket `900` without coordinating. Keep the existing filename when editing a claim.

Add or update the independent expectation under the same filename in `scripts/check-boot-path/features/`. The tuple is `[id, title, category, blurb]`. Review the copy against the shipped behavior, including limits and cancellation where relevant. The boot checks compare every field in order and verify that the catalog script loads before the app. The Wave 1 review exercises the rendered Features tab with synthetic data.

The synchronous Node generator uses the product manifests to create `renderer/features-catalog.js` as a classic script with the existing CommonJS and browser interfaces. Git ignores the generated file. Install, start, Timeline tests, and boot checks refresh it, and electron-builder's `beforePack` hook refreshes it before file collection. The existing `renderer/**/*` rule includes it in `app.asar`.

This change covers the Features catalog. Shortcuts, CLI help, renderer boot, and mail and IPC behavior keep their existing paths.
