# Workflows pending restore

Root `.github/workflows/` was relocated here for the 2026-10-18 public force-push
because the available GitHub tokens lacked the `workflow` scope required to create
or update Actions workflow files on `Coke1120/Morrow-Mail`.

To restore CI/release on the public repo, move these files back to
`.github/workflows/` with a token that has the `workflow` scope, e.g.:

```bash
mkdir -p .github/workflows
git mv .github/workflows-pending/*.yml .github/workflows/
git commit -m "Restore GitHub Actions workflows on public Morrow-Mail"
git push
```

Files: `ci.yml`, `release.yml`.
