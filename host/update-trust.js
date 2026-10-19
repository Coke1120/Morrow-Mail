"use strict";

// Existing legacy Ed25519 identity, retained by the authorized updater migration.
// Source: main 7df99b5a83c5c055cdef54c79552a48fe36125a3, legacy.zip:
// legacy/rust/resources/update-public-key.pem (already SPKI PEM).
// SPKI DER SHA256: 3acce483f67ca8e9baf5430da27630f7dca1daa7d7344d16e014619a8a15f918
// Only this PUBLIC key is bundled. No runtime/environment trust-root override.
module.exports = Object.freeze({ publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnQlgzV26Lkc2ReyHPMDSbCPYBg7OvMcbnLy2AR3MO68=
-----END PUBLIC KEY-----
` });
