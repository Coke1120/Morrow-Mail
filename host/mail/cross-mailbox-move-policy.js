"use strict";

// Root must independently approve Copy's exact head and the Move review before
// changing this gate. No renderer preference or environment variable enables it.
module.exports = Object.freeze({ enabled: false,
  reason: "Gmail source Move is prepared separately and remains disabled until verified Copy and its source-removal safety checks are approved." });
