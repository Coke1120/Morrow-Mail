# SignPath wiring after approval

Windows Authenticode is not wired. `.github/workflows/release.yml` still builds and publishes unsigned NSIS and portable `.exe` files. Do not add a SignPath step, and do not commit an organization id, project slug, signing policy slug, or API token, until SignPath Foundation approves the subscription.

The public policy is [Code signing policy](../CODE_SIGNING_POLICY.md).

## When the subscription exists

1. In the SignPath project, copy the organization id, project slug, and signing policy slug. Store them as GitHub Actions repository variables. Leave those values out of the git tree.
2. Create an API token for a SignPath user who can submit signing requests. Store it as the Actions secret `SIGNPATH_API_TOKEN`. That secret is an API token. The code-signing private key stays with SignPath.
3. Split the Windows release job so GitHub Actions builds the unsigned artifacts on `windows-latest` before anything is published.
4. Upload the unsigned NSIS setup `.exe` and the portable `.exe` with `actions/upload-artifact`.
5. Submit each uploaded artifact with `signpath/github-action-submit-signing-request`. Pass `api-token` from `secrets.SIGNPATH_API_TOKEN`. Pass `organization-id`, `project-slug`, and `signing-policy-slug` from the repository variables created in step 1. Pass `github-artifact-id` from the upload step's `artifact-id` output. Set `wait-for-completion` and `output-artifact-directory` so the job receives the signed files.
6. Publish the signed files to GitHub Releases. Do not publish the unsigned copies as the release assets.
7. The maintainer, Leo Ho (GitHub user Coke1120), approves each signing request in SignPath before that signed file is released.
8. Leave `build.win.signAndEditExecutable` false for local `electron-builder` runs. Local builds stay unsigned and are not submitted.

Action reference: [SignPath GitHub trusted build system](https://docs.signpath.io/trusted-build-systems/github).
