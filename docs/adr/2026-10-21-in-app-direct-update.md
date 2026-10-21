# In-app direct update with optional elevation

## Decision

The macOS signed updater installs into a normal `/Applications` or `~/Applications` bundle when this process can create a private sibling directory. `fs.access` is not enough to refuse that install.

When the parent is exactly `/Applications` (`root:admin`, mode includes group write, not world-writable, no extra allow ACL, not a symlink) and this process cannot create that sibling (`EACCES` or `EPERM`), Install asks for administrator authorization with the system dialog (`osascript` `do shell script … with administrator privileges`) and then performs the same verified replace. The prompt runs only after the candidate passes manifest, hash, quarantine, codesign, and `assessBundleTrust`. Authorization creates a user-owned `0700` staging directory. A later bundle rename that the process cannot do uses the same dialog. The script does not change the mode of `/Applications`, does not delete quarantine, and does not disable Gatekeeper.

Finder “Show downloaded update” remains the fallback when the user cancels authorization, authorization fails, the parent is not that canonical folder, the volume is read-only, the parent is symlinked, an extra allow ACL is present, or assessment returns `UPDATE_MANUAL_TRUST`.

## Why

`validateParent` mapped every `fs.access(W_OK|X_OK)` failure to `UPDATE_MANUAL_LOCATION` before `mkdtemp`. The UI string was “The installation folder is not writable by this app. Use Show downloaded update…”. That is not the staging-create failure (different sentence) and not the untrusted-writer or ACL failures (different sentences).

`/Applications` is `root:admin` mode `0775`. `trustedParent` already allows that folder. Write access is the `admin` group. Terminal for an admin user passes `access(W_OK)` and can create files there. The packaged app’s process often does not: Finder launch credentials and macOS App Management do not match a login shell, and `access()` on the Applications firmlink can disagree with a real create. The updater treated that as a permanent manual install and told the user no permissions would be changed.

A translocated bundle can emit the same access failure because the target is the running bundle’s parent and the message does not include the path. A translocation mount is not `/Applications` and is not authorized here; Finder stays the fallback. The failure that prompted this change was followed by a process running from `/Applications/Morrow Mail.app`.

## Not in this change

No privileged helper tool, no Windows electron-updater change, no quarantine stripping, no Gatekeeper bypass, and no directory mode change on `/Applications`.
