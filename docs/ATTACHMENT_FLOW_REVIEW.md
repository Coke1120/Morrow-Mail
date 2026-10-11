# Attachment flow review — 11 October 2026

This follow-up starts from merged PR26/main
`654be0d7c65f4e76f8642f1cddf0ee7a4725c0a3` on a separate branch. It examines
picker cancellation, repeated attachment activation and page/account changes
during downloads. It does not replace the previous Back/Escape/focus fixes.

## Navigation during a Windows attachment save

`saveAttachment` sets `Shell::dialogOpen` after the Save dialog accepts a
destination and keeps it set while awaiting bytes and writing the quarantined
temporary file. Message reading, file pickers and most foreground operations
already respect that guard. The shared `Shell::navigate` entry omitted it, so a
sidebar destination could replace the account, page, cursor and selection during
the save. The download still uses its captured owner; this finding does not show
a cross-account attachment request.

[Pinned-main reproduction 38112026674](https://github.com/Coke1120/Morrow-Mail/actions/runs/38112026674)
passed on fixture commit `1dfa0b314aaf000e74b6df913637f2fc939574dd` before the
production change: the exact account/page/cursor/selection loss occurred during
the held response, and saved bytes/owner/quarantine checks passed afterwards.

The correction makes that shared navigation entry respect the existing guard.
Completion and failure continue releasing the guard through the existing save
path, so navigation resumes afterwards. The file-writing, account capture,
attachment validation and quarantine paths remain unchanged. Full native smoke
also exercises the shared entry while a real reader popup owns the guard.

## Bounded native evidence

`scripts/test-windows-attachment-flow.ps1` compiles WinUI and the real attachment
and navigation implementations in a private temporary source copy. Only that
copy receives alternate fixture startup, a scripted accepted destination and an
in-memory transport. It never starts the Rust service. Unexpected request paths,
methods and owners fail; the response contains nine fictional bytes. Its source
under `windows/Checks/` is excluded from the normal production source glob.

The checks exercise:

- An accepted destination supplied by the fixture, followed by a held download.
  Repeated save/upload attempts must not choose another path or start a request.
- Navigation to a different account while that response is held, retaining the
  selected message, page, cursors and generation in the candidate.
- Attempting to read another owner's duplicate message ID while the save is
  active, retaining the original selection and making no additional request.
- Captured download ownership, exact saved bytes and the NTFS `Zone.Identifier`
  marker; the existing destination remains intact before bytes arrive.
- Rejected attachment identity preserving the existing file/page and releasing
  the guard; navigation must work after completion/failure, without leftover
  temporary download files.

`-BaselineNavigation` substitutes only the pinned main `App.cpp` before applying
the same fixture startup seam. It requires the specific account/page/cursor and
selection replacement, rather than accepting an arbitrary failure as a
reproduction. Normal mode requires retained state. Each fixture process has a
30-second deadline, with exact-owned-process termination and a five-second reap
bound; its generated temporary directory is the only cleanup target.

The focused workflow verifies the candidate. To repeat the independent pinned
negative control intentionally, first fetch the pinned commit, then run
`./scripts/test-windows-attachment-flow.ps1 -BaselineNavigation`. Full native CI
continues running the unmodified transport/startup and the original strict gates;
final candidate results are attached to its draft PR.

This establishes native API/state behavior with synthetic data. It does not
establish actual keyboard or screen-reader operation, real picker acceptance or
cancellation, real HTTP/provider behavior, real-account draft persistence,
download cancellation after acceptance, or Mac attachment-picker acceptance. Existing composer tests
cover their separate busy/unsaved guards. No additional Mac production defect was
proven in this bounded review, so Mac code is unchanged. VoiceOver/Narrator on
hardware and cross-platform manual UX remain unverified.

### Native picker cancellation: bounded stop

The initial dedicated fixture compiled in
[38111236630](https://github.com/Coke1120/Morrow-Mail/actions/runs/38111236630)
but exceeded its 30-second process deadline before navigation assertions, with
buffered phase diagnostics missing. The instrumented
[38111497457](https://github.com/Coke1120/Morrow-Mail/actions/runs/38111497457)
confirmed native window startup and a visible owned Save dialog, then timed out.
[38111750349](https://github.com/Coke1120/Morrow-Mail/actions/runs/38111750349)
retained the cancellation callback until its result was known: the owned dialog's
`Close(ERROR_CANCELLED)` returned `S_OK`, but `Show` did not return before the
unchanged deadline. These are failed fixture attempts, not navigation
reproductions or evidence that a user's Cancel action is broken.

This callback experiment stops here. Its modal hooks are removed from the final
download-state fixture; accepted file selection is explicitly scripted. Any
future cancellation work must first establish a reliable, bounded interaction
with the fixture's own modal dialog and distinguish that from the application
state assertions. No accessibility/security setting was changed, no broad window
or process enumeration was used, and no real mailbox was opened.

## Separate unresolved timing and observation work

The [merged-main run 38108994176](https://github.com/Coke1120/Morrow-Mail/actions/runs/38108994176)
passed Mac acceptance (original reader phase 24.723 seconds), the mail-flow
fixture and all 40 complete network-zero extreme-reader samples. Windows build,
UI operations, 26 lifecycle controls and benchmark passed, but strict observation
failed in cases 2 and 3: `nativeAcquire`, error 87, unknown/null exit. All three UI
walkthroughs completed; relocation and release were skipped. This matches the
known first-acquire evidence gap; it does not prove normal process exit. The run
was not retried to obtain a green result.

Mac's retained 22.218-second load/29.865-second tail failure remains unresolved.
No new permitted attribution or bounded capture facility became available in
this review. The [existing engineering design](MAIL_FLOW_REVIEW.md#mac-extreme-html-stop-condition-and-engineering-design)
still requires an exact fixture WKWebView/process lifetime mapping, a permitted
targeted recorder, and verified readiness/flush/cancel/reap bounds before a
discriminating profile. There is no new renderer experiment or timing claim.

The [Windows lifecycle contract](MAIL_FLOW_REVIEW.md#windows-first-acquire-gap-separate-observation-design)
still requires a verified source ready before fixture launch, with lifetime/parent
identities, exit status and event-loss accounting. No WMI/ETW experiment, broad
trace, new privilege helper or security change is added. Original HTML semantics,
network isolation, cancellation/Back, the 30-second reader gate and strict
resource-observation gates are preserved.
