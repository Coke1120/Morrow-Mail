# 2026-11-01 — Platform bots receive raw cached-mail notifications

Status: Accepted for implementation; release follows normal review.

## Decision

Grok Bot and Hermes Agent share the existing scoped HTTP bridge. Grants without a platform retain `grok_bot`. Add an optional per-grant background webhook delivery while the Electron app is open, awake and listening. Keep all existing pull operations and permissions.

Push avoids requiring a platform bot to poll continuously. It delivers bounded cached records, with untrusted-mail markers and the existing text projector. The platform bot owns decisions: ignore, ask a human, read again, propose a draft or send only through a separately granted operation. The delivery path imports no Agent, model or mail-action module and ignores webhook response bodies.

## Consent and destination

Use a separate, initially empty Bot access background checkbox tied to the reviewed webhook, platform and data/schedule configuration. AI consent version 1 binds a saved model destination; it cannot authorize a different bot webhook. This data-only bridge permission therefore remains separate and has its own stop/revoke path and disclosure in `AI_DATA_USE.md`. No scope change or new provider grant is needed.

Accept only private Tailscale HTTPS with checked/pinned tailnet DNS answers, or exact loopback destinations. Reject public routing, redirects and URL credentials. Keep Funnel off. Store the optional webhook bearer via the existing secrets facade, independently of the inbound bearer verifier. Native storage failures fail closed; diagnostics contain fixed results only.

## Consequences

The timer shares a pure local-time cron utility with skill schedules, never their execution path. It participates in update quiescence and pauses/cancels on sleep/quit/access changes. Secure reads revalidate before POST. Delivered bytes cannot be recalled.

This is a recent-cache digest, not a mailbox replication or exactly-once protocol. A bounded successful-ID history, deterministic delivery IDs, durable next slots and two attempts per slot limit repeat traffic without persisting raw payloads. Receivers deduplicate IDs. Window/cursor changes, lost acknowledgements, restarts, size caps and retention limits are disclosed in `BOT_BRIDGE.md` and Features → CLI. Activity records delivery outcomes. Synthetic host/DOM/transport tests never use real mail, bot deployments or credentials.
