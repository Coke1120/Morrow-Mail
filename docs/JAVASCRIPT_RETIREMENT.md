# JavaScript retirement

The owner explicitly authorized retiring both application JavaScript and the
historical Node CI after the native cutover. Tracked source has no `.js`, `.jsx`,
`.cjs`, `.mjs`, `.ts` or `.tsx` files. React, Electron, the Node service, npm tools,
lockfile, archived harness retrieval and Rust-to-Node oracle calls are removed.
`package.json` remains version/product metadata without scripts or dependencies.

## Native application and checks

Rust owns the service and business logic; SwiftUI and WinUI 3/C++/WinRT own the
native interfaces. Isolated WebKit/WebView2 render sanitized email HTML. This
does not make the entire repository Rust, nor remove the system web engines.

Both readers use a **480-point bounded viewport with native scrolling**. macOS
no longer uses height/scroll JavaScript or custom wheel forwarding; long HTML
scrolls inside the viewport instead of expanding the whole message pane.
Plain text, reviewed links, per-message image consent, nonpersistent storage,
CSP and disabled email scripts remain.

macOS checks use WebKit find/selection, snapshots and native wheel events.
Windows checks use native DOM protocol operations and enforced CSP audit events
for image/frame blocks. They verify disabled scripts, sentinel attributes,
resource/navigation denial, plain-text fallback and disposal. `connect-src 'none'`
is checked in the mounted policy; the old host-JS fetch probe is gone,
so the check does not claim runtime fetch evidence.

No app or check calls a host JavaScript execution API. Deliberately malicious
`<script>`, `javascript:` and event-handler strings remain **inert security test
data**. Removing those would weaken tests for email isolation. No current build
or test requires Node/npm. Platform renderers and hosted CI actions remain
external tools; this is a source/runtime retirement, not a claim about every
third-party tool's implementation language.

## Historical CI retirement and remaining evidence

Both workflows have removed the historical Node jobs. The paired release job
still requires successful macOS and Windows native jobs and signed provenance;
the existing publisher, production update public key and package layouts remain.
Native Rust sanitizer, persistence, signature/download/installer/rollback tests
and native UI checks remain. The sanitizer corpus now has active Rust checks.

CI no longer executes the original beta.16 Node installer or compares old
storage/search/service/sanitizer implementations with current Rust. Previous
results remain historical evidence only. This loss of ongoing interoperability
coverage is explicit; native tests do not establish fresh old-client acceptance.

The retired application/harness source remains in Git history at
`b5b69d4d276c086ba118583f464bac11341806a0`; the former beta.16 reference is
`7ab30cbb3e496118513a98f8211ec66481e282c4`. The intermediate archived CI is recorded
at `d22990b68113100cb84d7433b7d9867f2ab0d049`. Historical resource-manifest paths
remain provenance references to their recorded commits.

Ignored historical checkouts, dependency/build directories and private workspaces
are not committed or packaged. Existing user data and published binaries are
unchanged. Manual Windows visual/accessibility, clean-machine, live-provider and
stable distribution-signing gates remain outstanding in `VERIFICATION.md`.
