"use strict";

// Release trust anchor. Populate only through reviewed source change with the
// operator-approved Ed25519 PUBLIC key. Never load a key from the network,
// environment, renderer, or user settings. No production key has been approved.
// Empty deliberately disables authenticated macOS updates; no ShipIt fallback.
module.exports = Object.freeze({ publicKey: "" });
