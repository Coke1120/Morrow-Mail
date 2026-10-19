"use strict";

const assert = require("node:assert/strict");
const { createSigner } = require("./sign-macos");

async function run() {
  const config = require("../package.json").build;
  assert.equal(config.mac.sign, "./scripts/sign-macos.js");
  assert.notEqual(config.mac.identity, null, "null bypasses the custom signer in electron-builder 25");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.afterPack, "./scripts/windows-icon.js");
  const optionsForFile = () => ({ hardenedRuntime: false });
  const options = { app: "/tmp/fixture with spaces.app", platform: "darwin",
    identity: "must-not-use", keychain: "must-not-use", provisioningProfile: "must-not-use",
    optionsForFile };
  const calls = [];
  await createSigner({ platform: "darwin", signAsync: async (actual) => {
    assert.equal(actual.identity, "-");
    assert.equal(actual.identityValidation, false);
    assert.equal(actual.preAutoEntitlements, false);
    assert.equal(actual.preEmbedProvisioningProfile, false);
    assert.equal(actual.strictVerify, true);
    assert.equal(actual.keychain, undefined);
    assert.equal(actual.provisioningProfile, undefined);
    assert.equal(actual.optionsForFile, optionsForFile);
    calls.push("sign");
  }, verify: (command, args) => {
    assert.deepEqual(calls, ["sign"]);
    assert.equal(command, "/usr/bin/codesign");
    assert.deepEqual(args, ["--verify", "--deep", "--strict", "--verbose=2", options.app]);
    calls.push("verify");
  } })(options);
  assert.deepEqual(calls, ["sign", "verify"]);
  await assert.rejects(createSigner({ platform: "darwin",
    signAsync: async () => { throw new Error("sign failed"); },
    verify: () => assert.fail("must not verify after a failed signature"),
  })(options), /sign failed/);
  await assert.rejects(createSigner({ platform: "darwin", signAsync: async () => {},
    verify: () => { throw new Error("invalid resource seal"); },
  })(options), /invalid resource seal/);
  await assert.rejects(createSigner({ platform: "linux",
    signAsync: async () => assert.fail("must not pretend to sign on Linux"),
  })(options), /macOS host/);
  console.log("macos-sign-hook-ok (mocked; native macOS verification still required)");
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
