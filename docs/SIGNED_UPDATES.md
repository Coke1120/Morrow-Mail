# Signed macOS updates (draft implementation)

This migration restores the legacy updater's independent release-authentication model for macOS. Windows retains electron-updater. It does not import legacy accounts, data, UI, or any private signing key. It retains the legacy public signing identity.

The application embeds the existing legacy Ed25519 public key in `host/update-trust.js`, recovered verbatim from `legacy.zip` at main commit `7df99b5a83c5c055cdef54c79552a48fe36125a3`, path `legacy/rust/resources/update-public-key.pem`, and cross-checked against snapshot `d7b140e2797834882559f81456ce57bbc03d551d`. It is already SPKI PEM; no conversion or new identity is needed. Environment variables, downloaded manifests, and local preferences cannot choose the root. No production private key was read, generated or configured.

The legacy snapshot at `d7b140e2797834882559f81456ce57bbc03d551d` contains `legacy/rust/src/updater.rs` and `legacy/macos/Sources/MorrowMail/AppModel.swift`. Its Ed25519 manifest authenticated the archive independently of ad hoc bundle signing. This is distinct from the Electron 0.2.4/0.2.5 Squirrel path, which validates a new app against the installed app's designated requirement. No verification bypass or weak designated requirement is part of this migration.

## What is authenticated

The detached Ed25519 signature covers the exact UTF-8 bytes of the JSON file, including its final newline. The signature file contains standard base64 encoding of the 64-byte signature and a final newline. Do not reformat the JSON after signing.

```json
{
  "schemaVersion": 1,
  "version": "0.2.6",
  "platform": "darwin",
  "arch": "arm64",
  "url": "https://github.com/Coke1120/Morrow-Mail/releases/download/v0.2.6/Morrow-Mail-0.2.6-arm64-mac.zip",
  "size": 123456789,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

This is an illustrative schema, not a publishable manifest. Only stable `major.minor.patch` versions are accepted. Artifact URLs are bound to the exact repository, tag, version, architecture and filename; archive bytes are bound by both length and SHA-256. The maximum ZIP size is 750 MiB. Other schema fields are rejected. A version below the running app is rejected, and the same signed version reports up to date without download or installation. After a successful installation the new bundled version becomes the replay floor. There is no independent persistent monotonic counter: a server withholding a newer release is not detectable by a timeless manifest, and manually reinstalling an older app lowers that local version floor.

Upload these as a pair alongside the exact archive:

- `update-manifest-macos-arm64.json`
- `update-manifest-macos-arm64.json.sig`
- `Morrow-Mail-VERSION-arm64-mac.zip`

The signature authenticates the publisher holding the approved key. Strict macOS bundle verification separately checks that the bundle's resource/code seals are intact. Neither an Ed25519 manifest nor an ad hoc codesign signature establishes Apple Developer ID identity or notarization. New downloads without quarantine receive an active quarantine attribute; an existing valid attribute and its system-managed flags are preserved exactly, without resetting user authorization. Copying the attribute is mandatory. The installer runs `spctl --assess --type execute` before helper handoff, before replacement and before each launch, including recovery launches. Rejection or timeout stops installation or launch; a correct Ed25519 signature does not override system policy. Gatekeeper and quarantine continue to apply. Never remove quarantine, disable Gatekeeper, weaken designated requirements, or launch a system-blocked app to make a test pass.

## Offline publication tooling

The generator does not upload, discover credentials, create keys, or modify workflows. Only a future authorized release operator supplies existing signing and public-key files explicitly. The key is not passed as command-line text. Only the public key was inspected and embedded; no production private key or secret value was inspected or configured.

After building and strict-verifying the final ARM64 app and ZIP, with `package.json` already at the release version:

```bash
node scripts/create-update-manifest.js \
  --artifact 'dist/Morrow Mail-0.2.6-arm64-mac.zip' \
  --version 0.2.6 \
  --private-key /approved/protected/path/update-signing-key.pem \
  --public-key /approved/path/update-public-key.pem \
  --out-dir /fresh/output/directory
```

Replace example paths and version. The local ZIP may contain spaces; the signed GitHub asset URL uses dashes. The generator requires a fresh output directory, a nonempty regular artifact, a matching Ed25519 pair and a matching package version. It hashes the actual final archive and verifies its own generated signature. It does not establish build provenance or inspect the ZIP contents: the release pipeline must bind the reviewed source SHA, package version, finished strict-verified ZIP, manifest pair, and published bytes to the same build. Never rebuild or re-sign the app after creating its archive manifest. Never publish partial output after an error. Do not replace an existing published signed pair or tag.

## Release workflow gate

The workflow now builds both platforms with `--publish never`. Before dependency installation it requires a committed Ed25519 public root in `host/update-trust.js` and the presence of the `MORROW_UPDATE_SIGNING_KEY` Actions secret (PKCS#8 PEM). The legacy public root is bundled; missing or mismatched private-key configuration still blocks publication. No production private key was read, generated or configured. There is no public-key environment override.

Windows receives only a boolean indicating secret availability. macOS verifies the freshly extracted final archive in a separate secret-free step. Archive, identity, architecture or strict codesign failure blocks publication. The build-host `spctl` result is reported separately: explicit assessment denial (exit 3) or the configured execFile timeout permits authenticated ad hoc distribution with manual-install limitations, without authorizing execution. Missing/inaccessible tools, other exit codes, output overflow and unexpected signals remain fatal verification errors. The next step signs the manifest with the private key in memory. Staging binds both platforms to the same source SHA, version, workflow run and attempt. The publisher rejects existing releases and mismatched tags, validates feeds and the manifest, uploads a draft, downloads every asset to compare hashes and sizes, and promotes only the complete verified set. Failure after draft creation retains the draft for review; reruns do not overwrite it. Windows still uses unsigned binaries and electron-updater, but publication now waits for the paired macOS gate.

The historical public key at `d7b140e2797834882559f81456ce57bbc03d551d:legacy/rust/resources/update-public-key.pem` has Ed25519 SPKI SHA-256 fingerprint `3acce483f67ca8e9baf5430da27630f7dca1daa7d7344d16e014619a8a15f918`. Legacy workflow source used the same secret name. The authorized legacy migration now retains this exact public root. Historical source does not prove the private counterpart is still configured or controlled.

This workflow supports authenticated ad hoc distribution without Apple Developer Program membership. It does not promise notarization or unattended installation. Build-host policy acceptance is not destination-Mac authorization. Release notes explicitly explain manual installation; the app distinguishes a verified download from an installed update. The installation-time policy checks, quarantine preservation and user handoff remain mandatory and unchanged.

The workflow has only been tested offline with fixture keys and a mocked GitHub API. It has not been executed or published. Native transition validation and successful signing with the configured private secret remain unverified. The owner reports that `MORROW_UPDATE_SIGNING_KEY` exists; its match is checked only by the authorized release job’s **Sign final macOS archive manifest** step, before staging/upload. That step derives the public key, compares it to the bundled root, and verifies the generated signature; missing or mismatched credentials fail closed.

## Migration and recovery

Electron 0.2.4 and 0.2.5 cannot gain the new verifier before their existing updater accepts an update. A release containing this code does not repair that earlier trust check remotely. Plan one manual bridge installation from the official release, with the app fully quit and existing user data left in place. Users must follow normal macOS protections; a Gatekeeper block is not permission to bypass it. The bridge embeds the legacy public key, but needs a new-format signed release before it can consume subsequent updates. Legacy `update-manifest.json` with a `platforms` map and PR104 `update-manifest-macos-arm64.json` are different schemas and asset names: key/signature compatibility does not make old release payloads installable through the new feed.

Installation must wait for draft persistence and orderly service/application exit, stage on the same filesystem, retain the old app as a recoverable backup, and replace only the application bundle. It must not move/delete mail, profile, credentials or userData. A candidate that fails to start can be rolled back when it is known to have exited; an unconfirmed but potentially running candidate requires explicit recovery rather than renaming a live app. Preserve the backup and diagnostics on an uncertain outcome. The installed app may be owned by the current user or root. A private `~/Applications` remains supported. The standard canonical `/Applications` owned by root:admin (UID 0, GID 80), including mode 0775, is also eligible when this process actually has write/search access and can create private staging. Additional allow ACLs, world-writable directories, other shared writable groups, or symlinked parents require manual installation. No escalation or directory permission change is attempted.

This explicitly trusts the system's root/admin installation administrators; it does not claim protection against malicious root or another administrator with control of `/Applications`. Parent, staging and original app device/inode identities are pinned at handoff and checked again after exit. Replacement and rollback recheck identities and refuse a destination that has appeared unexpectedly, preserving unrelated files and the backup. These are race detection checks, not an atomic no-replace native transaction or a security boundary against concurrent privileged writers. Native `/Applications` ACL and concurrent-operation tests remain required.

When preflight needs system authorization or write access, the current app resumes and the UI reports **Manual installation required**. **Show downloaded update** revalidates the signed manifest, archive hash/size and quarantine before revealing the ZIP in Finder; it does not open the candidate, quit, replace anything or report installation success. Save work and quit before using Finder's normal installation and system authorization flow. Missing public-key configuration exposes only **Open official releases**, never a claim that an archive was authenticated.

A failed `spctl` assessment describes that candidate's current automated assessment; it is not evidence that a user never approved a historical app. Apple documents user-managed app exceptions in [Safely open apps on your Mac](https://support.apple.com/en-us/102445). The updater does not infer, create or erase those exceptions, and does not directly execute a rejected app. Automatic installation still requires a successful assessment; manual system interaction remains the user's decision.

Nonsecret transaction status is retained in the exact sibling `.morrow-update-…/journal.json`; `previous.app` is the backup. For `recovery-required`, close the candidate and confirm its processes have stopped before inspecting the recorded target and verifying the backup with `codesign --verify --deep --strict`. Restore only that reviewed backup through normal Finder operations. Do not use wildcard deletion/replacement commands. Failed candidates and journals are retained; no automatic cleanup touches them.

ZIP entries containing `._*` or `__MACOSX` AppleDouble metadata are rejected during directory validation, before creating extraction output. Such archives require repackaging; metadata is never extracted as sealed bundle resources.

Two filesystem renames are not a single crash-atomic transaction: a power loss between renames can require recovery from the retained backup.

## Validation before release

Run the repository checks and focused suites from the exact reviewed commit:

```bash
npm run check
node scripts/check-update-publisher.js
```

The publisher suite generates keys only in memory, signs fixture bytes, verifies with the actual application manifest verifier, and checks key mismatch, wrong algorithm, tampering, version mismatch, symlink input and output collision. It proves the byte-level publisher/verifier contract; it does not prove macOS native installation. Other updater suites cover transport, archive attacks, interruption, repeated requests and rollback. Review their actual results before release; mocked Linux checks cannot establish native codesign or launch behavior.

MBA test handoff must record the reviewed commit SHA and use a disposable macOS account/profile with no real mail or credentials. Native integration is pending until root supplies that SHA and the test-specific bridge/candidate artifacts; do not test against the user's installed production copy. Test fixture keys must be confined to these disposable test builds and never committed as a release root.

1. Build the reviewed bridge and a greater-version candidate ARM64 app locally with publishing disabled. Keep the same test public key embedded in both disposable copies. Record exact source SHAs, version pair, ZIP SHA-256 and size. Create the candidate manifest using the fixture private key. Exercise the verifier/installer harness with these local fixtures; do not add arbitrary production feed overrides to make fixtures work.
2. Check the packaged and freshly extracted candidate before launching anything:

   ```bash
   CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --arm64 --publish never
   codesign --verify --deep --strict --verbose=2 'dist/mac-arm64/Morrow Mail.app'
   codesign -d -r- --verbose=4 'dist/mac-arm64/Morrow Mail.app'
   ```

   Extract the ZIP into a fresh temporary directory with `ditto -x -k`, then repeat both `codesign` commands on its app. Record success/errors without removing quarantine or changing trust policy. A blocked launch ends the native launch test and is reported as a blocker.
3. With only a disposable local draft, exercise a normal greater-version install. Confirm the draft survives, the old app/service exits before replacement, the candidate starts, and the retained backup is identifiable. Confirm data paths are unchanged.
4. Exercise concurrent Install clicks, interrupted downloads and quit refusal. There must be at most one installer transaction; no replacement while old processes remain alive; no partial download accepted as an archive. Never kill or manipulate the real user's processes.
5. Inject candidate launch failure and failure between replacement steps in the test harness; confirm safe rollback/relaunch or an explicit recovery-required state with backup retained. Also test a candidate which remains alive but never reports readiness: do not overwrite a running candidate during recovery.
6. Reject a modified manifest, wrong fixture signer, malformed/extra schema fields, older/equal version, wrong architecture, changed hash/length, ZIP traversal and escaping symlinks. Verify bundle tampering fails strict codesign validation on macOS. A valid archive may contain internal Electron framework symlinks; it must not be allowed to write through them or escape staging.
7. Separately demonstrate the old Electron update failure/one-time manual bridge boundary with disposable copies. Do not claim 0.2.4 → bridge works through ShipIt without a real successful transition. Then test bridge → signed candidate. Repeat ordinary Windows NSIS update checks independently; this macOS migration must not alter that provider.

A real hosted end-to-end test requires an approved release-signing configuration and a controlled publication plan. Do not upload test manifests into the production stable feed or treat offline harness success as a hosted production update success.

MBA previously confirmed strict-signature/tamper checks, hash/extraction checks, real child exit and filesystem rollback with simulated launch/rename failures. Gatekeeper rejected the fixture, so true restart/readiness, draft preservation and end-to-end updating remain unverified. Re-test quarantine creation and policy rejection on the new commit without bypassing macOS protections.

The latest legacy-flow follow-up needs native tests on a disposable, normally writable `/Applications` installation, a standard-user permission denial, ACL/symlink/path-change rejection, preserved quarantine flags, Finder handoff, and real bridge-to-candidate restart/readiness/draft persistence. No change to the Windows update provider is intended.

## Owner signing configuration

The only owner-held credential needed for manifest authentication is the existing `MORROW_UPDATE_SIGNING_KEY`: Ed25519 PKCS#8 PEM matching the bundled public root. In GitHub, open **Coke1120/Morrow-Mail → Settings → Secrets and variables → Actions → Repository secrets**. If that name already exists with the original key, leave it in place; GitHub does not reveal existing secret values. Do not paste a private key into chat. If absent, restore the original private key from the owner's protected backup via **New repository secret**. If it exists only in Actions, it can still sign there; it does not need to be exported.

Archive evidence: `legacy/.github/workflows/check.yml:255` passes this secret to `morrow-publish`; `legacy/rust/src/bin/morrow-publish.rs:250–265` parses PKCS#8, signs exact manifest bytes, base64-encodes the 64-byte signature, and verifies against its compiled public key. The new publisher uses the same algorithm and encoding, with the new Electron manifest schema. Offline tests pin the original SPKI fingerprint and reject unrelated fixture private keys; they cannot prove possession of the original private key.

If the original private key is truly lost, its public key cannot recover it. Generating a replacement is a deliberate key rotation requiring a new bundled public root and bridge distribution; merely changing the secret breaks signature verification. No replacement production key has been generated by this work.

The former release-time Gatekeeper blocker has been replaced by a policy report after strict integrity verification. This changes permission to distribute authenticated bytes, not permission to install or execute. No Apple account or additional credential is required for this ad hoc distribution workflow. The destination Mac can still require user approval or refuse execution, in which case the updater does not bypass it.

Only if the original identity is irrecoverably lost and a key rotation is chosen, the owner can run this locally on their Mac, outside the repository, with Node already installed. This creates a fresh private directory and refuses to overwrite an existing one; it prints no key material. This instruction was not executed to create production credentials.

```bash
node <<'NODE'
const fs = require('node:fs');
const { generateKeyPairSync } = require('node:crypto');
const directory = 'morrow-update-keys';
fs.mkdirSync(directory, { mode: 0o700 });
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
fs.writeFileSync(directory + '/private.pem', privateKey, { mode: 0o600, flag: 'wx' });
fs.writeFileSync(directory + '/public.pem', publicKey, { mode: 0o644, flag: 'wx' });
NODE
```

Back up `private.pem` securely and enter its complete PEM only in the GitHub secret field, never chat or Git. Share only `public.pem` for the reviewed source change and bridge/key-rotation plan. Do not replace the existing secret merely to experiment. References: [GitHub repository secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Node key generation](https://nodejs.org/api/crypto.html#cryptogeneratekeypairsynctype-options).
