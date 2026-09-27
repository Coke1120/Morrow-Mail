// Invoked only after every platform job passes. Failed uploads leave a draft.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import { verifyManifest } from '../server/update-trust.js';
import { join } from 'node:path';
const { version } = JSON.parse(readFileSync('package.json'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${version}` || !/^\d+\.\d+\.\d+-(?:alpha|beta)\.\d+$/.test(version)) throw new Error('Unsigned releases require an alpha or beta tag exactly matching package.json.');
const directory = 'release-artifacts';
const platforms = ['macos-arm64', 'windows-x64'];
const expected = platforms.flatMap(platform => [`Morrow-Mail-${version}-${platform}.zip`, `SHA256SUMS-${platform}.txt`]);
if (readdirSync(directory).sort().join('\n') !== [...expected].sort().join('\n')) throw new Error('Both platform archives and checksums are required.');
for (const platform of platforms) {
  const name = `Morrow-Mail-${version}-${platform}.zip`;
  const checksum = readFileSync(join(directory, `SHA256SUMS-${platform}.txt`), 'utf8');
  if (checksum !== `${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}  ${name}\n`) throw new Error(`Checksum mismatch: ${platform}`);
}
if (!process.env.MORROW_UPDATE_SIGNING_KEY) throw new Error('The update signing key is required before publishing.');
const manifest = Buffer.from(JSON.stringify({ version, platforms: Object.fromEntries(platforms.map(platform => {
  const name = `Morrow-Mail-${version}-${platform}.zip`, bytes = readFileSync(join(directory, name));
  return [platform, { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
})) }));
const signature = sign(null, manifest, process.env.MORROW_UPDATE_SIGNING_KEY).toString('base64');
verifyManifest(manifest, signature, version);
writeFileSync(join(directory, 'update-manifest.json'), manifest);
writeFileSync(join(directory, 'update-manifest.sig'), signature);
expected.push('update-manifest.json', 'update-manifest.sig');
const notes = `Morrow Mail ${version}

Clearer Settings, separate model panels and hourly update checks. Both packages are built from this same Git tag and pass the paired checks before publication.

What changed since 0.6.0-beta.14:
- Settings puts Add/Reconnect accounts first, groups General preferences, keeps permission Save/Discard visible, and collapses advanced/import/reconnect details. General still autosaves; credentials and permissions still require explicit saving.
- Model separates Chat & replies from Search embedding while retaining unsaved edits. Each has a clearly named connection test and save action. Search shows the saved embedding connection and a shortcut to edit it.
- Review & Index prepares a bounded preview and asks for confirmation before paid indexing. Supported Rust batches have separate Pause/Resume/Cancel controls; Clear index has its own destructive confirmation. Reviewed work continues in the background.
- Learning leads with the account, proposal and approved-style status. Missing prerequisites link to their settings. Confirmed identity, generating a proposal and Save Approved Style remain separate decisions; no automatic application is added.
- Yahoo / Yahoo HK setup fills the existing secure IMAP/SMTP server fields. Enter the complete email address and a Yahoo app password. The preset clears entered passwords and does not connect automatically. No Yahoo OAuth, calendar or Out of Office support is added; live Yahoo acceptance remains pending.
- Both clients check for updates at launch and once per hour while running, checking when due after returning from sleep/background. A red ! on Settings opens About when an update is available. Download and installation remain explicit.
- Existing encrypted accounts, cached mail, drafts, schedules, learning proposals, calendar retries, backup and signed-update protections are retained.

CLI quick start:
- macOS: '/Applications/Morrow Mail.app/Contents/Resources/morrow-service' cli --help
- Windows PowerShell, from the extracted app folder: & '.\\resources\\app\\runtime\\morrow-service.exe' cli --help
- Usage, JSON contracts, review/send examples and limits: https://github.com/Coke1120/Morrow-Mail/blob/v${version}/docs/CLI.md
- Configure accounts in the app first. External agents with workspace access are not restricted by the in-app AI context checkboxes; trust the agent and authorize each delivery. No CLI attachments, account setup, implicit sync or automatic retries.

Updating:
- **One-time manual update from beta.4 and earlier:** the GitHub repository was renamed to Coke1120/Morrow-Mail. Older update checks reject its API redirect; download and install this package manually. This release uses the canonical address for future in-app updates, with signature and redirect protections unchanged.
- Keep a verified workspace backup and close the old app before opening the new one. The workspace stays separate from the app; binary rollback never silently restores an older database over current data.
- The signed manifest, pinned Ed25519 key, exact platform/version checks and SHA-256 validation remain unchanged. Read-only installation directories retain the manual-download option.

OAuth setup:
- Additional Google scopes reuse the existing Desktop OAuth client; no new JSON is needed. The project owner adds gmail.settings.basic for Out of Office, or calendar.calendarlist.readonly + calendar.events for Calendar under Google Auth Platform → Data Access, then the user grants consent from the relevant Morrow screen. Calendar reminders require no additional email-send scope.
- Built-in Google Desktop OAuth remains available for Gmail and Google Calendar. Google Cloud API enablement, test-user access and provider verification remain publisher responsibilities; bundling the registration does not remove Testing restrictions.
- Outlook mail and Calendar use the bundled public Microsoft desktop registration by default; no user-supplied client ID, JSON or secret is required. Custom registrations remain available under Advanced. Organization policies may require administrator approval. Live Microsoft consent and Entra registration acceptance remain unverified; fixture checks do not establish provider approval.
- Bundled desktop app identifiers are extractable and are not user credentials. No mailbox tokens or private update signing key are shipped.

Packages:
- **macOS (Apple silicon, macOS 13.5+):** extract and move Morrow Mail.app to Applications. Fully native SwiftUI; ad-hoc signed and **not Apple notarized**.
- **Windows (x64, Windows 10/11):** extract the entire folder and run Morrow Mail.exe. Isolated Electron renderer; **unsigned prerelease**, which may show a SmartScreen warning.
- Both include their runtime. No Node or Rust installation is needed. Compare the supplied SHA-256 checksum before opening.

Beta limitations:
This is an ad-hoc signed/unnotarized macOS and unsigned Windows beta. Complete live-provider/model acceptance, minimum-OS/other-hardware acceptance, manual UI/IME/accessibility coverage and stable signing remain pending. This batch used fictional-account Settings walkthroughs and isolated checks, with no new live provider/model actions. Earlier limited Gmail acceptance is recorded separately in VERIFICATION.md and does not establish live Yahoo or comprehensive multi-provider acceptance. Automated provider/model checks use isolated fixtures and do not establish provider approval or delivery reliability.

Month view selects at most 12 calendars; bounded calendar reads fail visibly rather than silently showing truncated results. Provider/device settings determine actual reminder delivery. Sender-history context and reply batches use explicit message/body/token limits; they do not analyze an unlimited mailbox. Learning does not infer identity or apply a style without approval. Full provider delta/deletion sync, attachments/CID images, phishing/malware verdicts, sender blocking, app-wide AI spending caps and undo sending remain unsupported. Studio simulations stay labeled. Windows Tauri is not part of this release. See the tagged README.md, FEATURE_COVERAGE.md and VERIFICATION.md for checks and limits.

Support development: https://github.com/sponsors/Coke1120 · https://buymeacoffee.com/Coke1120
`;
writeFileSync('release-notes.md', notes);
const gh = args => execFileSync('gh', args, { encoding: 'utf8' });
const releases = JSON.parse(gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`]));
const existing = releases.find(release => release.tag_name === tag);
if (existing && !existing.draft) throw new Error('This release is already published; never replace public artifacts.');
if (!existing) gh(['release', 'create', tag, '--verify-tag', '--draft', '--prerelease', '--title', `Morrow Mail ${version}`, '--notes-file', 'release-notes.md']);
gh(['release', 'upload', tag, ...expected.map(file => join(directory, file)), '--clobber']);
const release = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,isDraft']));
if (!release.isDraft || release.assets.map(asset => asset.name).sort().join('\n') !== [...expected].sort().join('\n')) throw new Error('Release asset verification failed; kept as a draft.');
gh(['release', 'edit', tag, '--draft=false', '--prerelease', '--notes-file', 'release-notes.md']);
console.log(`Published ${tag} with both platforms.`);
