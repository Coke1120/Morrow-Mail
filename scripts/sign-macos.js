"use strict";

const { execFileSync } = require("node:child_process");

function createSigner({ signAsync, verify = execFileSync, platform = process.platform }) {
  return async function signMac(options) {
    if (platform !== "darwin" || options.platform !== "darwin") {
      throw new Error("macOS ad hoc signing requires a macOS host and darwin target");
    }
    // electron-builder calls mac.sign after bundle/resource edits and before ZIP
    // creation. osx-sign signs nested code inside-out, then seals the outer app.
    // Never use a discovered certificate or provisioning profile for this build.
    await signAsync({
      ...options,
      identity: "-",
      identityValidation: false,
      keychain: undefined,
      provisioningProfile: undefined,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      strictVerify: true,
    });
    // Fail the packaging operation before any archive/feed is published.
    verify("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", options.app], {
      stdio: "inherit",
    });
  };
}

module.exports = async function signMac(options) {
  const { signAsync } = require("@electron/osx-sign");
  return createSigner({ signAsync })(options);
};
module.exports.createSigner = createSigner;
