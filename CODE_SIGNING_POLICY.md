# Code signing policy

Status: pending approval until subscribed. No Morrow Mail release is SignPath-signed yet. `.github/workflows/release.yml` still publishes unsigned Windows builds, and `build.win.signAndEditExecutable` stays `false`.

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

[SignPath.io](https://signpath.io) · [SignPath Foundation](https://signpath.org)

## What will be signed

Windows NSIS setup `.exe` and portable `.exe` files built from this repository and attached to [GitHub Releases](https://github.com/Coke1120/Morrow-Mail/releases).

macOS zip builds are outside this policy. They stay unsigned.

## Build

Signed files are produced by GitHub Actions only, on the `windows-latest` runner in `.github/workflows/release.yml`, from the public source in this repository.

There is no local private key. SignPath holds the code-signing key. It is not stored in this repository, in GitHub Actions secrets, or on a maintainer machine. A build from a developer machine is unsigned and is not submitted for signing.

The NSIS installer may contain upstream open-source libraries. Those libraries are not signed with this project's certificate.

Windows product name metadata is `Morrow Mail`. Product version metadata is the `version` field in `package.json` for that release.

## Team roles

Morrow Mail has one maintainer: Leo Ho, GitHub user [Coke1120](https://github.com/Coke1120). That account holds every signing role.

- Authors: [Coke1120](https://github.com/Coke1120)
- Reviewers: [Coke1120](https://github.com/Coke1120). External pull requests are reviewed by the maintainer before merge.
- Approvers: [Coke1120](https://github.com/Coke1120). Each signing request is explicitly approved by the maintainer.

The maintainer must keep multi-factor authentication enabled on GitHub and on SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Morrow Mail does not include telemetry. OAuth and the bot bridge run only when the user starts them:

- OAuth runs when the user signs in to Google or Microsoft, and mail sync or send goes to the account the user connected.
- The bot bridge stays off until the user turns it on in Settings. It binds to `127.0.0.1` only.
- A packaged install contacts the public GitHub Releases feed to look for updates after the person launches it, and again when they choose Check for updates. `npm start` does not run that check.

## Distribution

https://github.com/Coke1120/Morrow-Mail/releases

The NSIS installer registers an uninstaller. The portable `.exe` does not install.
