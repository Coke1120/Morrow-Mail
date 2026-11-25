"use strict";

// Deadlines are in milliseconds. The durable SQLite fixtures need additional
// Windows I/O headroom. Zero preserves fixtures without an outer deadline.
const windows = process.platform === "win32";

function mailbox(run) {
  run("check-oauth-reliability.js");
  run("check-feature-oauth-recovery.js");
  run("check-gmail-auth-retry.js", windows ? 90_000 : 30_000);
  run("check-outlook-sync-auth.js");
  run("check-mail-columns.js");
  run("check-mail-view.js");
  run("check-reader-table-columns.js");
  run("check-mail-selection.js");
  run("check-dsn-redraft.js");
  run("check-folder-chips.js");
  run("check-to-me-filter.js");
  run("check-sidebar-accounts.js");
  run("check-cross-mailbox-copy.js");
  run("check-cross-mailbox-protocol.js");
  run("check-cross-mailbox-engine.js");
  run("check-cross-mailbox-move.js");
  // Source Move reopens SQLite across 14 engine processes.
  run("check-cross-mailbox-move-engine.js", windows ? 90_000 : 30_000);
  run("check-cross-mailbox-move-ui.js");
  run("check-cross-mailbox-copy-ui.js");
  run("check-message-context-owner.js");
  run("check-message-context-menu.js");
  run("check-local-folders.js");
  run("check-local-folders-ui.js");
  // MBOX runs 25 serial MIME, restart and fsync cases.
  run("check-mbox-import.js", windows ? 90_000 : 30_000);
  run("check-mbox-import-ui.js");
  run("check-mbox-import-host.js");
  run("check-mail-shortcut-target.js");
  run("check-mail-delete-selection.js");
  run("check-mail-status-columns.js");
  run("check-bot-mail-actions.js", 90_000);
  run("check-bot-send-confirm-ui.js");
  run("check-mail-list-layout.js");
  run("check-google-onboarding-startup.js");
  run("check-google-onboarding.js");
  run("check-google-client-switching.js");
  run("check-google-oauth-default-ui.js");
  run("check-account-settings.js");
  run("check-attachment-transfers.js");
  run("check-pdf-preview.js");
  run("check-forward-attachments.js");
  run("check-responsive-attachments.js");
  run("check-sent-followup.js");
  run("check-gmail-cache.js");
  run("check-gmail-engine.js");
  run("check-gmail-mail-api-ui.js");
  run("check-gmail-error-diagnostics.js");
}

function startup(run) {
  run("check-reviewed-mail-flows.js", 90_000);
  run("check-fresh-review-fixes.js");
  run("check-mail-performance.js");
  run("check-residual-mail-work.js", windows ? 90_000 : 60_000);
  run("check-mail-phase-two.js");
  run("check-checkpoint-observer.js");
  run("check-startup-preparation.js");
  // The 300-row startup/recovery fixture has exceeded 180 s on Windows.
  run("check-startup-upgrade.js", windows ? 300_000 : 180_000);
  run("check-keychain-reads.js");
  run("check-outbox.js");
  run("check-agent-todos.js");
  run("check-agent-card-view.js");
  run("check-agent-learning.js");
  run("check-agent-safety-review.js");
  run("check-agent-actions.js");
  run("check-send-previews.js");
  run("check-reply-history.js");
  run("check-reply-selection.js");
  run("check-reader-local-time.js");
  run("check-ui-editor-feedback.js", 15_000);
  run("check-calendar-keyboard-followup.js", 15_000);
  run("check-body-sync-status.js", 15_000);
  run("check-undo-sync-races.js", 15_000);
  run("check-wave1-review.js", 15_000);
  run("check-wave2-page-review.js", 15_000);
  run("check-wave3-page-review.js", 15_000);
  run("check-unread-hold.js", 15_000);
  run("check-recipient-suggest.js");
  run("check-brain-persona.js", 0);
  run("check-signed-update-manifest.js", 0);
  run("check-update-installer.js", 0);
  run("check-update-launcher.js", 0);
  run("check-update-publisher.js", 0);
  run("check-update-quiescence.js", 0);
  run("check-update-macos.js", 0);
  run("check-update-windows.js", 0);
  run("check-update-schedule.js", 0);
  run("check-release-preflight.js", 0);
  run("check-release-publication.js", 0);
  run("check-changelog.js", 0);
  run("check-mail-discovery.js", 0);
}

function integration(run) {
  run("check-compose-spelling.js");
  run("check-message-summary.js");
  run("check-account-calendar-attachments.js");
  run("check-account-liveness.js");
  run("check-index-opening-control.js", 15_000);
  run("check-search-index-rebuild.js", 120_000);
  run("check-startup-credential-quit.js", 120_000);
  run("check-whole-list-filter.js", windows ? 90_000 : 30_000);
  run("check-whole-mailbox-filter-renderer.js");
  run("check-mcp.js");
  run("check-mcp-ui.js");
  run("check-bot-proactive.js");
  run("check-bot-proactive-ui.js");
  run("check-hermes-webhook.js");
  run("check-ipc-diagnostics.js");
  run("check-bot-provider-metadata.js");
  run("check-reconnect-calendar-preservation.js");
  run("check-chatgpt.js");
  run("check-chatgpt-ui.js");
  run("check-ai-settings-ownership.js");
  run("check-imap-client-errors.js");
  run("check-ai-consent.js");
  run("check-ai-consent-settings.js");
  run("check-brain-refresh.js");
  run("check-subject-prefixes.js");
  run("check-gmail-mail-api.js");
  run("check-folder-management.js");
  run("check-folder-recovery.js");
  run("check-folder-management-channel.js");
  run("check-gmail-dispositions.js");
  run("check-gmail-reply-backfill.js", windows ? 90_000 : 30_000);
  run("check-imap-dispositions.js", windows ? 90_000 : 30_000);
  run("check-sender-names.js");
  run("check-wave4-ux.js");
  run("check-mail-decoding.js", windows ? 90_000 : 30_000);
  run("check-list-unsubscribe.js");
  run("check-unsubscribe-dkim.js");
  run("check-unsubscribe-post.js");
  run("check-unsubscribe-source.js");
  run("check-gmail-raw-bounds.js");
  run("check-unsubscribe-integration.js");
  run("check-unsubscribe-browser.js");
  run("timeline.test.js");
  run("check-mail-notifications.js");
  run("check-mail-notifications-sync.js");
  run("check-mail-notifications-ui.js");
}

module.exports = { mailbox, startup, integration };
