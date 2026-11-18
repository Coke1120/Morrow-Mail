# Morrow Mail agent notes

## Branches and releases

- Open feature and fix PRs against `dev`. Do not merge or push to `main` or `production` unless Leo explicitly authorizes that destination.
- No GitHub auto-merge, force-push to `main` or `dev`, or production deploy on agent initiative.
- Record durable architecture or process decisions in [docs/adr/](docs/adr/). Keep lightweight UX backlog in Issues. These repo rules and ADRs take precedence over cross-repo habits in `leo-coding-prefs` and `projects.yaml`.
- Use the [security-audit skill](.cursor/skills/security-audit/SKILL.md) only when Leo explicitly asks for a security audit, pen-test, or full security review. Do not run full audit mode on routine PRs; reserve it for a requested full audit or artifacts.

## UI and help

- Match existing icon and Motion conventions. Preserve accessible labels, decorative-icon semantics, and reduced-motion behavior. Do not introduce a framework for a scoped UI fix.
- Update the Features catalog and affected help in the same change as user-facing behavior, including the CLI tab for bot/API/command changes. Keep capabilities, permission and cancellation limits, and examples aligned with handlers. Do not describe planned work as shipped.
- Add or update regression checks and validate the affected rendered tab with synthetic data before approval. Host tests alone do not verify UI or help.

## OAuth and provider writes

- Follow [docs/OAUTH.md](docs/OAUTH.md) and the [morrow-oauth skill](.agents/skills/morrow-oauth/SKILL.md). Keep Google Calendar consent separate. Existing Gmail OAuth IMAP accounts need reviewed migration before changing transport or credentials; never silently narrow scopes on IMAP/SMTP or assume a narrower request revoked existing grants.
- Use at most two Microsoft consent dialogs: Outlook IMAP/SMTP and the single Graph feature bundle; never mix those resources in authorization, exchange, or refresh. Reuse adequate grants, request missing access incrementally, and preserve credentials and grants after partial consent. Bot bridge grants stay separate.
- Out of Office is a reviewed provider write. Use the authorized provider or legacy grant without replacing a mailbox secret after partial consent. For IMAP, only install the `morrow-vacation` ManageSieve script (port 4190 after STARTTLS). Do not replace another active script or send local automatic replies.

## Credentials, consent, and sender identities

- Follow the [Keychain ADR](docs/adr/2026-10-27-keychain-read-deadlines.md). Mutate through the `secrets` facade. After awaited credential reads, recheck account incarnation, login/transport, revision, and Google client binding before token use or storage. Share in-flight reads only, never completed credential values. Do not add awaits to synchronous credential/SQLite compensation without a serialized design and race tests. Keep compatibility command deadlines; mock child processes and never access a real Keychain in tests.
- Keep AI consent channels aligned between the host and the actual first-party Settings and AI Setup preloads. Exercise the actual preload, Settings mount, and host validation with synthetic data. Preserve the explicit manual checkbox, separate background consent, saved-target token binding, and unknown-channel rejection. Do not use live AI, credentials, or user consent files in tests.
- Follow the [sender identity ADR](docs/adr/2026-10-26-sender-display-names.md). Preserve local aliases and display-name overrides through refresh; distinguish an empty override from an unset value. Freeze the chosen name with drafts and scheduled mail; never turn a display name into authorization or change provider settings/scopes for local names.
- Hydrate drafts using the separate validated `fromAddress`, not preview text. Preserve draft-cleanup and bot idempotency proofs for equivalent legacy metadata without weakening protection of newer edits. Check full historical display text against the separate address (or a valid parsed header); test the production provider formatter/parser, not just hand-quoted fixtures.

## Startup search repair

- Follow the [cooperative search index ADR](docs/adr/2026-10-27-cooperative-search-index.md). Keep mail reads closed until index verification. Never carry a write transaction or internal database admission across an await, or call UI observers inside admission.
- Preserve durable progress, resume markers, all three consistency tables, and journal/fsync. Use synthetic stores to prove restart, abort/close, concurrent access, and journal/process failure recovery.
