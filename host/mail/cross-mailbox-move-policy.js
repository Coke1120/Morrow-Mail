"use strict";

// Enabled after verified Copy and independent Move ownership/journal review.
// The coordinator still checks source/provider/review/receipt authority; no
// renderer preference or environment variable can widen supported sources.
module.exports = Object.freeze({ enabled: true,
  reason: "Gmail API source Move requires verified Copy and a separate explicit Gmail Trash review. Other connected source providers remain Copy-only." });
