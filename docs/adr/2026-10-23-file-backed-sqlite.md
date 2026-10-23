# File-backed mail SQLite

Morrow Mail 0.2.30 opened `mail.sqlite` with sql.js. That loads the whole file into a WASM heap and then into a JavaScript `Uint8Array`. On Leo's Mac mini the local file was about 1.79 GiB. Startup threw `RangeError: Array buffer allocation failed` inside `sql-wasm.js` before `BrowserWindow` ran, so the Dock showed a process and zero windows.

The checkpoint stays a normal SQLite file, and the `MORROWJ1` journals stay the same. `better-sqlite3` reads and writes pages. On open, the host copies `mail.sqlite` to `mail.sqlite.live` with `fs.promises.copyFile` and replays the journals into that working copy. The published checkpoint is not modified until the existing worker copies it, replays the sealed journal, fsyncs, and atomically renames the result. Existing mail is not rewritten or discarded. A failed open removes only a partial `.live` file.

`mail.sqlite.live` is disposable. A backup is still the checkpoint plus both journal files, taken with the app stopped. The working copy needs about as much free disk as the checkpoint. If the disk is full, startup shows an error and leaves the mailbox files in place.

If opening throws, the main process shows an "Opening your mailbox" window and then a Quit dialog with the error and the line "Your mailbox files were not deleted." Closing that opening window quits, so a failed start does not remain a windowless Dock process.

Packaged builds must rebuild `better-sqlite3` for Electron and unpack it from the asar (`asarUnpack` in `package.json`). `npm run check` uses the Node prebuild for the CI Node version. sql.js remains only so tests can still write an old checkpoint fixture.
