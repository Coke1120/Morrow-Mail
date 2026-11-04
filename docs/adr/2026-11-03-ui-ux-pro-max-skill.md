# Repository-local UI/UX Pro Max

Status: accepted for repository-local use. Executing third-party code remains gated.

The requested source is `nextlevelbuilder/ui-ux-pro-max-skill`, pinned to
`713eef51b04efc98d6fa565323b495f7c9c89fd4` (upstream version 2.15.0, MIT).
Use `.agents/skills/ui-ux-pro-max/`, the Codex repository scope documented by
upstream's `templates/platforms/codex.json`.

The upstream CLI's normal path generates a skill and copies local assets, but it
also installs six sibling skills; legacy options download a release, and force
options can replace prior directories. Avoid running that installer. Copy only
the requested skill's 39 data files, four Python runtime files and MIT license.
Preserve the quick reference and render the upstream usage template as reference
documentation. Add a short Morrow-specific entry point and a source/hash manifest.
The skill contains 48 files totaling about 3.3 MB; this ADR is the 49th added file. No product
source, dependency, lockfile, CI workflow, personal/global configuration or hook
changes are included.

Static review found standard-library Python imports and local catalog reads.
The design-system module can write Markdown when explicitly asked to persist;
`--force` can overwrite prior output. No network clients, shell/process launch,
dynamic evaluation or credential reads were found in the four runtime files.
This scoped inspection is not a full security audit. Catalog links do not grant
permission to fetch remote assets or install dependencies.

Action-time confirmation remains required before executing downloaded installation
scripts or third-party skill code. The local entry point
states that requirement explicitly. All prepared validation uses self-authored
static parsing, source hashes and file/symlink checks; it does not import or run
upstream Python or TypeScript. Runtime search validation remains pending that
confirmation. Written accessibility guidance can be read and applied safely.

Keep repository rules and Morrow's current design ahead of catalog suggestions.
Updates must pin a new revision and repeat the content/scope review. Removing
`.agents/skills/ui-ux-pro-max/` fully removes this local installation; the app has
no runtime dependency on it.
