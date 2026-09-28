# Native Windows candidate

This directory is the unpackaged x64 WinUI 3 / C++/WinRT host. The production
Electron builder and release workflow remain separate until native feature,
upgrade and clean-machine acceptance pass. Nothing here publishes a release.

## Pinned build inputs

Verified against Microsoft documentation, NuGet metadata and the hosted-runner
inventories on **2026-09-28**:

| Input | Fixed selection |
| --- | --- |
| Windows App SDK release | **2.5.1**, current Stable channel |
| WinUI component | `Microsoft.WindowsAppSDK.WinUI` **2.3.9** |
| Foundation component | `Microsoft.WindowsAppSDK.Foundation` **2.3.12** |
| Interactive Experiences | `Microsoft.WindowsAppSDK.InteractiveExperiences` **2.1.9** |
| Base / Runtime | **2.0.4** / **2.5.1** |
| C++/WinRT | `Microsoft.Windows.CppWinRT` **3.0.260818.1** |
| Windows SDK headers/libraries | **10.0.26100.0** |
| NuGet SDK BuildTools / MSIX tools | **10.0.26100.4654** / **1.7.251221100** |
| WebView2 SDK, transitive from WinUI | **1.0.3719.77**; this is **not** the browser runtime |
| Compiler | Visual Studio **2022**, **v143**, serviced **14.4x** toolset, C++20 |
| API / manifest floor | Windows 10 **1809**, build **17763**, x64 |

The nine exact package versions are in [packages.config](packages.config), with
downloaded NuGet archive hashes in [packages.sha256.json](packages.sha256.json).
The build checks every archive hash after restore. The components are the
versions selected by the 2.5.1 metapackage, without unrelated AI/ML/Widgets
packages. In particular InteractiveExperiences **2.1.9** is explicit: the WinUI
minimum 2.1.8 is not a retrievable package. Do not replace exact versions with
floating ranges. Update the lock and hashes together when servicing the SDK.

The Windows API floor is not a promise of Microsoft support for an expired
Windows edition. Use an OS edition still in support. Neither a WinUI Visual
Studio extension, a developer licence, MSIX registration, administrator rights,
nor an installed Windows App Runtime is required to run this candidate.

Sources:

- [Windows App SDK channels and servicing](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/stable-channel)
- [2.x release notes, including 2.5.1](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/release-notes/windows-app-sdk-2-0?pivots=stable#version-251)
- [Official 2.5.1 package dependencies](https://api.nuget.org/v3-flatcontainer/microsoft.windowsappsdk/2.5.1/microsoft.windowsappsdk.nuspec)
- [Official WinUI component dependencies](https://api.nuget.org/v3-flatcontainer/microsoft.windowsappsdk.winui/2.3.9/microsoft.windowsappsdk.winui.nuspec)
- [C++/WinRT package](https://www.nuget.org/packages/Microsoft.Windows.CppWinRT/3.0.260818.1)
- [Microsoft self-contained deployment guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps)
- [Official unpackaged C++ WinUI project](https://github.com/microsoft/WindowsAppSDK-Samples/blob/main/Samples/SelfContainedDeployment/cpp/cpp-winui-unpackaged/SelfContainedDeployment.vcxproj)
- [Official hybrid CRT settings](https://github.com/microsoft/WindowsAppSDK-Samples/blob/main/Samples/SelfContainedDeployment/cpp/cpp-winui-unpackaged/HybridCRT.props)
- [Hosted Windows 2022 inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md), [Windows 2025 inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)

Both hosted images currently provide VS 2022 17.14 and SDK 10.0.26100.0.
Compiler servicing can change between image revisions; the builder reports the
actual `VCToolsVersion`. This deliberately fixes v143/14.4x, not an obsolete
compiler patch. CI must retain its image and compiler version with its results.

## Host source interface

`MorrowMail.vcxproj` includes **only `windows/*.cpp`** and `windows/*.h`, with
`pch.cpp` creating the forced `pch.h` precompiled header. Put native test programs
under a separate `Checks/` directory. Initially the host sources are `App.cpp`
and `Service.cpp`; `Compose.cpp`, `Workspace.cpp`, or `MainWindow.cpp` in the same
directory need no project edit.

The UI is programmatic. There are no application XAML, IDL, generated `App.g.h`,
custom WinRT types, or application `module.g.cpp`. C++/WinRT still generates
projections from the SDK's WinMD references. `App.cpp` owns:

```cpp
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    winrt::init_apartment(winrt::apartment_type::single_threaded);
    winrt::Microsoft::UI::Xaml::Application::Start([](auto&&) {
        winrt::make<App>(); // App derives from Microsoft::UI::Xaml::ApplicationT<App>.
    });
    return 0;
}
```

Retain the application/window and initialize `XamlControlsResources` in the
application's merged resource dictionaries at the start of `OnLaunched`, before
creating the shell. Application resources are not available during construction.
The programmatic Application also
implements `IXamlMetadataProvider`, forwarding both `GetXamlType` overloads and
`GetXmlnsDefinitions` to `XamlControlsXamlMetaDataProvider`; without generated
App.xaml code this is required for the controls' runtime templates.
The SDK supplies registration-free
WinRT initialization through its native auto-initializer; do not call the
framework-dependent bootstrapper or install MSIX packages at startup.

`Service` owns private-pipe bootstrap, fixed loopback HTTP, separate bearer/update
tokens and draining shutdown. No credentials belong in arguments, WebView2,
logging, project definitions, or output metadata. The host alone supplies the
workspace. The WinUI smoke contract is `--native-smoke` plus a temporary absolute
`MORROW_DATA_DIR` directly under the system temporary directory, named
`morrow-native-check-<GUID>` and containing `disposable-native-fixture` with the
exact text `Morrow native acceptance fixture`. On success write
`native-smoke-result.json` with `ok:true` and `mode:"fresh"` or `mode:"owned"`,
then exit 0 after draining the service. Normal launch never manufactures a result.

## Build and check (PowerShell, no Node)

Prerequisites: Windows x64, PowerShell 7.2+, VS 2022 Desktop development with C++,
SDK 10.0.26100.0, NuGet CLI and Rust 1.98+. Run from any directory:

```powershell
# Compile the native host without packaging or a Rust/notices input.
pwsh -File scripts/build-windows-native.ps1 -CompileOnly

# Full candidate: Rust resource check, service, notices and native packaging.
pwsh -File scripts/build-windows-native.ps1 -Zip
pwsh -File scripts/test-windows-native.ps1
pwsh -File scripts/test-windows-native.ps1 -UiSmoke
```

`-RustService C:\...\morrow-service.exe` uses an already built Windows executable
after matching `--version` to the common root `package.json`. Otherwise the builder
runs locked release Cargo directly. Before packaging it runs
`morrow-resources --check` and generates notices with
`morrow-notices --target x86_64-pc-windows-msvc`, saving its stdout as UTF-8 notices.
`-RustNotices C:\build-inputs\THIRD_PARTY_LICENSES.txt` may supply previously
reviewed Windows production Rust/OpenCC notices instead. Missing or invalid
notices stop packaging. No command here installs or invokes Node, npm, React,
Electron, or a browser build.

Only `build/windows-native/` is generated. Packaging preserves the updater layout:

```text
Morrow Mail-win32-x64/
  Morrow Mail.exe
  [self-contained Windows App SDK DLLs, resources and app-local VC CRT]
  resources/app/package.json
  resources/app/backend/package.json
  resources/app/backend/google-oauth.json  (optional trusted Desktop OAuth input)
  resources/app/runtime/morrow-service.exe
  resources/app/runtime/THIRD_PARTY_LICENSES.txt
  resources/app/runtime/[app-local VC CRT]
  licenses/windows/[SDK redistribution terms and locked package inventory]
```

The ZIP and SHA-256 sum stay under `build/windows-native/artifacts/`. The root
folder and executable names match the existing signed updater; no release assets,
signatures, deployment manifests or installed apps are replaced. The executable's
version resource and both package metadata files use the common `package.json`.

The host uses Microsoft's hybrid CRT. The builder additionally deploys the
**release x64 VC143 CRT DLLs from VS's redistributable directory**, beside both
executables, for the Rust service and SDK DLLs. It never copies debug CRTs or
system DLLs. Windows 10+ supplies the Universal CRT. Redistributing VC runtime
files remains subject to the Visual Studio redistribution licence; see
[Microsoft's deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/deploying-native-desktop-applications-visual-cpp?view=msvc-170).

Self-contained WinUI is not self-contained WebView2. The transitive WebView2 SDK
does not provide an Evergreen browser installation. This build does not download
or install that runtime and must keep the plain-text reader working when it is
absent. Any HTML reader remains a restricted, scriptless, isolated message view,
with no service bridge; the application itself remains native controls.

## Acceptance boundary

`test-windows-native.ps1` validates required layout, x64 PE images, matching
versions, app-local CRT, and absence of old runtime/private workspace payloads.
It then starts the real Rust service in a temporary workspace, verifies unauthenticated
401 and authenticated state, closes stdin and requires a clean drain. `-UiSmoke`
builds the Rust `native_fixture` example, runs fresh onboarding, an owned fictional
mailbox and its restart, and verifies the saved records after the UI exits. Each
UI run has a 180-second deadline and a checked completion result; timeout cleanup
targets only the launched PID. The helper and workspaces are never packaged.

The same three UI runs also write `test-results/windows-native-resource-N.json`.
A separate, owned PowerShell observer samples the UI and verified descendants
about once per second, with bounded output and explicit incomplete status. Reports
bind the UI/service hashes and OS to the observations. Working-set sums can count
shared pages more than once; private bytes are not private working set or macOS
memory footprint. Sampling can miss early peaks and short-lived processes, and
the observer adds overhead. Samples include the walkthrough's adversarial Reader
cases, not just ordinary reading. Fixed page/HTML readiness markers record time from
before process launch to stderr receipt, not compositor first paint. The fixture
pauses for two seconds after the initial page; these are individual observations,
not steady-idle measurements, a latency distribution or an Electron comparison.
The focused observer/pipe check runs without launching the app:

```powershell
pwsh -File scripts/test-windows-native.ps1 -ObservationsSelfTest
```

The PowerShell AST, all nine official NuGet archive hashes, project XML and explicit
package import paths were checked. Hosted `windows-2022` Rust checks, compilation,
packaging, private service startup/authentication/EOF drain, fresh onboarding,
foreground interaction guards and owned mail/workspace/Settings checks passed in
CI 36361496967 at `2f39ade`. Application startup was fixed by initializing resources in
`OnLaunched`. Exact-document matching fixed the reader's rejected Base64 HTML
navigation; initial and adversarial documents now load and the inline-script
sentinel passes. Native CSP observation now verifies blocked images, frames and
connections with scripting disabled. Retaining page labels fixed the expired
TextBlock reference. Continuously draining bounded stderr fixed the subsequent
harness stall; mounted plain text, empty HTML, stale navigation, browser closure
and failure fallback now pass in both owned and restart runs. Reader security
checks and deadlines remain unchanged. All four candidate jobs passed, including
the 1k/10k/50k service benchmark and both platforms' fixed beta.16 contracts and
actual upgrades. This is not a whole-app comparative performance baseline.
Separately run on
a clean supported Windows VM with no VS, no Windows App Runtime, offline startup,
ordinary-user permissions, and WebView2 absent. A hosted-runner pass alone cannot
establish those clean-machine conditions. There is no production cutover here.
