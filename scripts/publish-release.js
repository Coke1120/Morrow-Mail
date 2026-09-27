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

Month calendars, reviewed reminders and account-owned follow-up tools. Both packages are built from this same Git tag and pass the paired checks before publication.

What changed since 0.6.0-beta.13:
- A month calendar combines checked Google/Outlook calendars, shows cross-day/all-day events, and opens reviewed event creation when you click a date. Google supports notification or email reminders; Outlook supports notification reminders. These are provider-managed and work while Morrow is closed. No attendees or hidden reminder-email jobs are added.
- All history removes the import date cutoff for Gmail, Outlook and selectable IMAP folders, excluding Spam/Trash. Imports stay paged, checkpointed and resumable; this is not continuous delta/deletion mirroring.
- Pending is a separate local follow-up marker and account/combined list. It does not change provider stars or send notifications.
- Confirm your name/aliases in Learning, then preview and approve a bounded Reply Suggestions batch using permitted downloaded correspondence and approved style. Results are proposals; Use in Draft never sends. Suggest with History also includes your permitted Sent To/Cc correspondence.
- Out of Office reads and writes real Gmail vacation or Outlook automatic-reply settings after additional OAuth consent and review. Opening the tab or granting permission does not activate a response. IMAP is unsupported.
- Scheduled sends retain the reviewed owner, recipients, content and time. Morrow must stay open and connected. Up to 15 minutes late can catch up; later jobs become Missed and need review. Cancel before editing; uncertain deliveries are never automatically replayed.
- Fix equivalent Outlook Inbox/Sent next-page URLs and preserve a resized native list when changing reader layout. Retain encrypted accounts, drafts, backup and signed-update protections.

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
This is an ad-hoc signed/unnotarized macOS and unsigned Windows beta. Complete live-provider/model acceptance, minimum-OS/other-hardware acceptance, manual UI/IME/accessibility coverage and stable signing remain pending. A limited authorized Gmail walkthrough exercised self-addressed sending and one reviewed Learning proposal; the proposal was not applied and weekly learning stayed off. A real schedule was immediately cancelled before delivery. No live calendar event, Out of Office write or complete-history download was performed for this batch. Automated provider/model checks use isolated fixtures and do not establish provider approval or delivery reliability.

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
