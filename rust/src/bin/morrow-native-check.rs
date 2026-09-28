//! Node-free Swift client acceptance with the unmodified production Rust service.
//! This checks Rust→Rust persistence. The historical Node harness still checks
//! Node↔Rust interoperability; this driver does not replace that evidence.
use chrono::{DateTime, SecondsFormat};
use morrow_search::{oauth::parse_google_oauth, store::Store};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    env,
    error::Error,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, ExitCode, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const ACCOUNTS: [&str; 2] = ["first@native-rust.invalid", "second@native-rust.invalid"];
const ACCESS: &str = "fixture-native-rust-access";
const REFRESH: &str = "fixture-native-rust-refresh";
const DRAFT_BODY: &str = "Saved fixture draft; no provider delivery is performed.";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Result<Self> {
        let path = env::temp_dir()
            .canonicalize()?
            .join(format!("morrow-swift-rust-check-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the exclusive directory created above, never a caller's workspace.
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not remove native fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

struct Running {
    child: Child,
    completed: bool,
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.completed {
            #[cfg(unix)]
            // Each command has its own process group. On failure/timeout also
            // terminate its fixture service, never a user's existing app/service.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn command(root: &Path, program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(root)
        .env("MACOSX_DEPLOYMENT_TARGET", "13.5")
        .env("CARGO_INCREMENTAL", "0")
        .stdin(Stdio::null());
    command
}

fn capture(command: &mut Command, seconds: u64, limit: u64) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut running = Running {
        child: command
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
        completed: false,
    };
    let stdout = running
        .child
        .stdout
        .take()
        .ok_or("Missing command output pipe.")?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = send.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut output = None;
    loop {
        if output.is_none() {
            match receive.try_recv() {
                Ok(bytes) => {
                    let bytes = bytes?;
                    check(
                        bytes.len() as u64 <= limit,
                        "Command output exceeded its limit.",
                    )?;
                    output = Some(bytes);
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("Command output reader failed.".into());
                }
            }
        }
        if let Some(status) = running.child.try_wait()? {
            check(
                status.success(),
                &format!(
                    "{} failed ({status}).",
                    command.get_program().to_string_lossy()
                ),
            )?;
            if let Some(bytes) = output {
                running.completed = true;
                return String::from_utf8(bytes).map_err(Into::into);
            }
        }
        check(
            Instant::now() < deadline,
            &format!(
                "{} exceeded its {seconds}s deadline.",
                command.get_program().to_string_lossy()
            ),
        )?;
        thread::sleep(Duration::from_millis(25));
    }
}

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned().into())
    }
}

fn artifact(output: &str, name: &str) -> Result<PathBuf> {
    let mut path = None;
    for line in output.lines() {
        let item: Value = serde_json::from_str(line)?;
        if item["reason"] == "compiler-artifact"
            && item["target"]["name"] == name
            && let Some(executable) = item["executable"].as_str()
        {
            path = Some(PathBuf::from(executable));
        }
    }
    path.ok_or_else(|| format!("Cargo did not report the {name} executable.").into())
}

// Native loopback sentinel. A TCP connection alone
// also fails this check, so an incomplete resource request cannot escape counting.
struct ReaderNetwork {
    port: u16,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<std::io::Result<usize>>>,
}
impl ReaderNetwork {
    fn start() -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_millis(100)))?;
                        stream.set_write_timeout(Some(Duration::from_millis(100)))?;
                        let mut ignored = [0u8; 4096];
                        let _ = stream.read(&mut ignored);
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nblocked content");
                        // One connection already disproves network-zero; stop
                        // without allowing unsolicited traffic to prolong cleanup.
                        return Ok(1);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        // Drain connections queued before the child exited.
                        if stopped.load(Ordering::Acquire) {
                            return Ok(0);
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => return Err(error),
                }
            }
        });
        Ok(Self {
            port,
            stop,
            worker: Some(worker),
        })
    }
    fn finish(mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        let connections = self
            .worker
            .take()
            .ok_or("Reader network observer missing.")?
            .join()
            .map_err(|_| "Reader network observer failed.")??;
        check(
            connections == 0,
            "Email triggered an unsolicited loopback connection.",
        )
    }
}
impl Drop for ReaderNetwork {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn compile_check(root: &Path, fixture: &Path, name: &str, arguments: &[&str]) -> Result<PathBuf> {
    let executable = fixture.join(name);
    print!(
        "{}",
        capture(
            command(root, "swiftc")
                .args(["-target", "arm64-apple-macosx13.5"])
                .args(arguments)
                .arg("-o")
                .arg(&executable),
            180,
            1024 * 1024
        )?
    );
    Ok(executable)
}

fn existing_native_checks(root: &Path, fixture: &Path) -> Result<()> {
    let workspace = fixture.join("auxiliary-workspace");
    let models = compile_check(
        root,
        fixture,
        "models-checks",
        &[
            "macos/Sources/MorrowMail/Models.swift",
            "macos/Checks/main.swift",
        ],
    )?;
    print!(
        "{}",
        capture(
            command(root, models).env("MORROW_DATA_DIR", &workspace),
            30,
            1024 * 1024
        )?
    );

    let reader = compile_check(
        root,
        fixture,
        "reader-checks",
        &[
            "-parse-as-library",
            "macos/Sources/MorrowMail/Models.swift",
            "macos/Sources/MorrowMail/MessageBodyView.swift",
            "macos/Checks/MessageHTML.swift",
        ],
    )?;
    let network = ReaderNetwork::start()?;
    print!(
        "{}",
        capture(
            command(root, reader)
                .arg(network.port.to_string())
                .env("MORROW_DATA_DIR", &workspace),
            30,
            1024 * 1024
        )?
    );
    network.finish()?;
    println!("Native reader: zero unsolicited loopback connections.");

    let window = compile_check(
        root,
        fixture,
        "window-checks",
        &[
            "-D",
            "MORROW_WINDOW_CHECKS",
            "-parse-as-library",
            "macos/Sources/MorrowMail/Models.swift",
            "macos/Sources/MorrowMail/AppModel.swift",
            "macos/Sources/MorrowMail/MorrowMailApp.swift",
            "macos/Sources/MorrowMail/CalendarView.swift",
            "macos/Checks/WindowAssertions.swift",
        ],
    )?;
    print!(
        "{}",
        capture(
            command(root, window).env("MORROW_DATA_DIR", &workspace),
            30,
            1024 * 1024
        )?
    );
    Ok(())
}

fn service(root: &Path, existing: Option<&Path>) -> Result<PathBuf> {
    let mut build = command(root, "cargo");
    build.args([
        "build",
        "--manifest-path",
        "rust/Cargo.toml",
        "--locked",
        "--message-format=json-render-diagnostics",
        "--bin",
        "morrow-resources",
    ]);
    if existing.is_none() {
        build.args(["--bin", "morrow-service"]);
    }
    // Actual Cargo artifacts respect CARGO_TARGET_DIR and cached builds. An
    // explicit existing service skips its build entirely, including release apps.
    let output = capture(&mut build, 900, 16 * 1024 * 1024)?;
    print!(
        "{}",
        capture(
            command(root, artifact(&output, "morrow-resources")?).arg("--check"),
            30,
            4096
        )?
    );
    match existing {
        Some(path) => {
            check(
                path.is_absolute(),
                "--service requires an absolute executable path.",
            )?;
            Ok(path.canonicalize()?)
        }
        None => artifact(&output, "morrow-service"),
    }
}

fn seed(directory: &Path) -> Result<()> {
    let store = Store::open(directory)?;
    let mut connections = serde_json::Map::new();
    for email in ACCOUNTS {
        connections.insert(
            email.into(),
            json!({"provider":"google", "email":email,
            "connectionId":format!("fixture-{email}"), "clientId":"fixture-client",
            "accessToken":ACCESS, "refreshToken":REFRESH, "expiresAt":4_102_444_800_000_i64}),
        );
    }
    let baseline = DateTime::parse_from_rfc3339("2026-09-25T00:00:00.000Z")?;
    store.transaction(|db| {
        db.set_settings(&json!({"mailAccounts":connections, "mail":connections[ACCOUNTS[0]],
            "activeAccount":"demo", "preferences":{"syncInterval":0,"markReadOnOpen":true,"sort":"newest"},
            "ai":null, "policy":{"enabled":false}, "calendars":{}, "imports":{}, "smartSearch":{"enabled":false}}))?;
        for email in ACCOUNTS {
            for index in 0..65 {
                db.upsert(email, &json!({
                    "id":if index == 0 { "google:shared".to_owned() } else { format!("google:fixture-{index:03}") },
                    "fromName":format!("Sender {}", index % 7), "fromEmail":format!("sender{}@example.invalid", index % 7),
                    "to":email, "subject":format!("Thread {}", 64 - index), "preview":format!("Cached fixture {index}"),
                    "body":format!("Owned by {email}: fixture {index}. ").repeat(100),
                    "date":(baseline - chrono::Duration::minutes(index)).to_rfc3339_opts(SecondsFormat::Millis, true),
                    "folder":"inbox", "category":"primary", "read":index % 3 != 0,
                    "starred":index > 0 && index % 9 == 0, "labels":[],
                    "footer":{"text":"Fixture footer excluded from list metadata", "html":""}
                }))?;
            }
        }
        db.upsert(ACCOUNTS[0], &json!({"id":"google:provider-draft", "folder":"drafts", "providerDraft":true,
            "to":"\"Fixture, Recipient\" <to@example.invalid>", "cc":"cc@example.invalid", "bcc":"hidden@example.invalid",
            "subject":"Provider draft fixture", "body":"Original provider draft; never sent.", "date":"2026-09-25T00:00:00.000Z"}))?;
        Ok(())
    })?;
    // The exclusive Rust writer is dropped before starting the Swift client.
    Ok(())
}

fn verify_store(directory: &Path, backup: bool) -> Result<()> {
    for name in ["genmail.sqlite", "encryption.key"] {
        check(
            directory.join(name).is_file(),
            "Native persistence omitted the database or encryption key.",
        )?;
    }
    let store = Store::open(directory)?;
    let settings = store.settings()?;
    let connections = settings["mailAccounts"]
        .as_object()
        .ok_or("Saved account map is missing.")?;
    let expected = if backup {
        &ACCOUNTS[..]
    } else {
        &ACCOUNTS[1..]
    };
    let mut owners: Vec<_> = connections.keys().map(String::as_str).collect();
    owners.sort_unstable();
    check(
        owners == expected,
        "Persistence changed account connection isolation.",
    )?;
    for owner in expected {
        check(
            connections[*owner]["accessToken"] == ACCESS
                && connections[*owner]["refreshToken"] == REFRESH,
            "Saved fixture credentials did not decrypt or changed.",
        )?;
    }
    check(
        settings["preferences"]["syncInterval"] == 0
            && settings["policy"]["enabled"] == false
            && settings["ai"].is_null(),
        "Persistence enabled provider sync or model work.",
    )?;
    check(
        settings["calendars"].is_null()
            || settings["calendars"]
                .as_object()
                .is_some_and(|map| map.values().all(|v| v.is_null() || v == false)),
        "Fixture unexpectedly connected a calendar.",
    )?;
    check(
        settings["backgroundSyncErrors"].is_null() || settings["backgroundSyncErrors"] == json!([]),
        "Fixture recorded unexpected provider sync errors.",
    )?;
    for owner in ACCOUNTS {
        let messages = store.list(owner)?;
        check(
            messages
                .iter()
                .filter(|message| message["folder"] == "inbox")
                .count()
                == 65,
            "Persistence lost cached inbox messages.",
        )?;
        let shared = store
            .get(owner, "google:shared")?
            .ok_or("An owned duplicate ID was lost.")?;
        check(
            shared["body"]
                .as_str()
                .is_some_and(|body| body.contains(&format!("Owned by {owner}"))),
            "Persistence crossed duplicate message owners.",
        )?;
    }
    let draft = store
        .list(ACCOUNTS[0])?
        .into_iter()
        .find(|message| message["subject"] == "Native Rust owned draft")
        .ok_or("Saved native draft was lost.")?;
    check(
        draft["folder"] == "drafts"
            && draft["bcc"] == "hidden@example.invalid"
            && draft["body"] == DRAFT_BODY,
        "Saved draft payload or Bcc changed.",
    )?;
    let id = draft["id"]
        .as_str()
        .ok_or("Saved draft identity is missing.")?;
    check(
        store.get(ACCOUNTS[1], id)?.is_none(),
        "Saved draft crossed accounts.",
    )?;
    if backup {
        check(
            settings["activeAccount"] == ACCOUNTS[1]
                && settings["preferences"]["language"] == "繁體中文"
                && settings["preferences"]["translationLanguage"] == "日本語",
            "Online backup lost the reviewed preferences or selected account.",
        )?;
        check(
            store.get(ACCOUNTS[0], "google:shared")?.unwrap()["starred"] == true
                && store.get(ACCOUNTS[1], "google:shared")?.unwrap()["starred"] == false,
            "Online backup lost the owner-specific starred patch.",
        )?;
    }
    Ok(())
}

fn run() -> Result<()> {
    check(
        cfg!(target_os = "macos") && env::consts::ARCH == "aarch64",
        "Native acceptance requires macOS arm64 and Apple's Swift tools.",
    )?;
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    let existing = match arguments.as_slice() {
        [] => None,
        [flag, path] if flag == "--service" && Path::new(path).is_absolute() => {
            Some(Path::new(path))
        }
        _ => {
            return Err("Usage: morrow-native-check [--service ABSOLUTE_PRODUCTION_BINARY]".into());
        }
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing repository root.")?;
    let package = fs::read(root.join("package.json"))?;
    let metadata: Value = serde_json::from_slice(&package)?;
    let version = metadata["version"]
        .as_str()
        .ok_or("Missing common package version.")?;
    check(
        Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$")?.is_match(version),
        "Invalid common package version.",
    )?;
    let fixture = Fixture::new()?;
    existing_native_checks(root, &fixture.0)?;
    let binary = service(root, existing)?;
    check(
        capture(command(root, &binary).arg("--version"), 15, 4096)?.trim()
            == format!("Morrow Mail {version}"),
        "The service and common package versions differ.",
    )?;
    check(
        capture(
            command(root, "/usr/bin/lipo").arg("-archs").arg(&binary),
            15,
            4096,
        )?
        .trim()
            == "arm64",
        "Use the production macOS arm64 service.",
    )?;
    let contents = fixture.0.join("Checks.app/Contents");
    let resources = contents.join("Resources");
    let backend = resources.join("backend");
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(&backend)?;
    fs::copy(binary, resources.join("morrow-service"))?;
    fs::write(backend.join("package.json"), package)?;
    // Hard-coded fictional installed-app client; never read OAuth build secrets
    // or credentials from the invoking shell, application bundle or real data.
    let oauth = parse_google_oauth(
        r#"{"installed":{"client_id":"fixture.apps.googleusercontent.com","client_secret":"fixture-native-rust-desktop-secret"}}"#,
    )?;
    fs::write(
        backend.join("google-oauth.json"),
        serde_json::to_vec(&json!({"installed":{
        "client_id":oauth["clientId"], "client_secret":oauth["clientSecret"]}}))?,
    )?;
    let short = version.split('-').next().unwrap();
    let identity = uuid::Uuid::new_v4().simple().to_string();
    fs::write(
        contents.join("Info.plist"),
        format!(
            r#"<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.morrowmail.rustchecks.{identity}</string>
<key>CFBundleExecutable</key><string>checks</string>
<key>CFBundleVersion</key><string>{short}</string>
<key>MorrowReleaseVersion</key><string>{version}</string>
<key>MorrowServiceRuntime</key><string>rust</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
</dict></plist>"#
        ),
    )?;
    let directory = fixture.0.join("data");
    seed(&directory)?;
    let key = fs::read(directory.join("encryption.key"))?;
    let client = contents.join("MacOS/checks");
    print!(
        "{}",
        capture(
            command(root, "swiftc")
                .args([
                    "-parse-as-library",
                    "-target",
                    "arm64-apple-macosx13.5",
                    "macos/Sources/MorrowMail/Models.swift",
                    "macos/Sources/MorrowMail/AppModel.swift",
                    "macos/Checks/RustIntegration.swift",
                    "-o"
                ])
                .arg(&client),
            180,
            1024 * 1024
        )?
    );
    println!("Running the unchanged Swift native acceptance in a private fictional workspace.");
    print!(
        "{}",
        capture(
            command(root, &client).env("MORROW_DATA_DIR", &directory),
            180,
            1024 * 1024
        )?
    );
    // Swift already waits for each service shutdown. Opening both stores now
    // also requires the exclusive writer lock; no dual-writer test shortcut.
    verify_store(&directory, false)?;
    let backup = fixture.0.join("native-backup");
    verify_store(&backup, true)?;
    check(
        fs::read(directory.join("encryption.key"))? == key
            && fs::read(backup.join("encryption.key"))? == key,
        "Native acceptance or backup replaced the original fixture encryption key.",
    )?;
    println!(
        "Native acceptance passed: existing Models, HTML reader/network-zero and WindowAssertions checks; production Rust service, unchanged Swift client, Rust→Rust encrypted persistence and online backup, lifecycle and account isolation. Fictional data only; Node interoperability is covered separately by the historical harness."
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Native acceptance failed: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_network_observer_rejects_unsolicited_traffic() {
        ReaderNetwork::start().unwrap().finish().unwrap();
        let observer = ReaderNetwork::start().unwrap();
        let mut client =
            std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, observer.port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        // The observer deliberately closes after one bounded read. It may reset
        // a late/partially read request; successful HTTP delivery is not its
        // contract. Wait for a response or close, then verify the actual finding.
        let _ = client.write_all(b"GET /image HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        let _ = client.read(&mut [0u8; 1]);
        drop(client);
        assert_eq!(
            observer.finish().unwrap_err().to_string(),
            "Email triggered an unsolicited loopback connection."
        );
    }

    #[test]
    fn seed_retains_native_contract_and_exclusive_ownership() {
        let fixture = Fixture::new().unwrap();
        let path = fixture.0.join("data");
        seed(&path).unwrap();
        let store = Store::open(&path).unwrap();
        let settings = store.settings().unwrap();
        assert_eq!(settings["activeAccount"], "demo");
        assert_eq!(settings["preferences"]["syncInterval"], 0);
        assert_eq!(settings["policy"]["enabled"], false);
        assert!(settings["ai"].is_null());
        for owner in ACCOUNTS {
            assert_eq!(settings["mailAccounts"][owner]["accessToken"], ACCESS);
            assert_eq!(
                store
                    .list(owner)
                    .unwrap()
                    .iter()
                    .filter(|m| m["folder"] == "inbox")
                    .count(),
                65
            );
            let shared = store.get(owner, "google:shared").unwrap().unwrap();
            assert_eq!(shared["date"], "2026-09-25T00:00:00.000Z");
            assert_eq!(
                shared["body"],
                format!("Owned by {owner}: fixture 0. ").repeat(100)
            );
            assert_eq!(shared["read"], false);
            assert_eq!(shared["starred"], false);
        }
        assert_eq!(
            store
                .get(ACCOUNTS[0], "google:provider-draft")
                .unwrap()
                .unwrap()["bcc"],
            "hidden@example.invalid"
        );
        assert!(
            store
                .get(ACCOUNTS[1], "google:provider-draft")
                .unwrap()
                .is_none()
        );
        assert!(!store.list("demo").unwrap().is_empty());
        assert!(Store::open(&path).is_err());
        drop(store);
        assert!(verify_store(&path, false).is_err()); // Untouched seeds cannot pass final acceptance.
        assert!(verify_store(&fixture.0.join("missing-backup"), true).is_err());
        assert!(!fixture.0.join("missing-backup").exists());
    }

    #[test]
    fn cargo_artifacts_respect_actual_paths() {
        let output = "{\"reason\":\"compiler-artifact\",\"target\":{\"name\":\"other\"},\"executable\":\"/wrong\"}\n{\"reason\":\"compiler-artifact\",\"target\":{\"name\":\"morrow-service\"},\"executable\":\"/tmp/custom output/debug/morrow-service\"}\n{\"reason\":\"build-finished\",\"success\":true}\n";
        assert_eq!(
            artifact(output, "morrow-service").unwrap(),
            PathBuf::from("/tmp/custom output/debug/morrow-service")
        );
        assert!(artifact(output, "missing").is_err());
    }

    #[test]
    fn persistence_checks_distinguish_live_disconnect_from_online_snapshot() {
        let fixture = Fixture::new().unwrap();
        let live = fixture.0.join("data");
        let backup = fixture.0.join("native-backup");
        seed(&live).unwrap();
        let store = Store::open(&live).unwrap();
        let mut settings = store.settings().unwrap();
        settings["activeAccount"] = ACCOUNTS[1].into();
        settings["preferences"]["language"] = "繁體中文".into();
        settings["preferences"]["translationLanguage"] = "日本語".into();
        store.set_settings(&settings).unwrap();
        store.upsert(ACCOUNTS[0], &json!({"id":"outbox:fixture", "folder":"drafts",
            "subject":"Native Rust owned draft", "body":DRAFT_BODY, "bcc":"hidden@example.invalid"})).unwrap();
        store
            .update(ACCOUNTS[0], "google:shared", &json!({"starred":true}))
            .unwrap();
        store.backup(&backup).unwrap();
        settings["mailAccounts"]
            .as_object_mut()
            .unwrap()
            .remove(ACCOUNTS[0]);
        settings["mail"] = settings["mailAccounts"][ACCOUNTS[1]].clone();
        store.set_settings(&settings).unwrap();
        drop(store);
        verify_store(&live, false).unwrap();
        verify_store(&backup, true).unwrap();
        assert!(verify_store(&live, true).is_err());
        assert!(verify_store(&backup, false).is_err());
        let store = Store::open(&backup).unwrap();
        store
            .update(ACCOUNTS[0], "outbox:fixture", &json!({"bcc":""}))
            .unwrap();
        drop(store);
        assert!(verify_store(&backup, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn command_failures_limits_and_deadlines_are_enforced() {
        let root = Path::new("/");
        assert_eq!(
            capture(
                command(root, "/bin/sh").args(["-c", "printf fixture"]),
                5,
                64
            )
            .unwrap(),
            "fixture"
        );
        assert!(capture(command(root, "/bin/sh").args(["-c", "exit 7"]), 5, 64).is_err());
        assert!(
            capture(
                command(root, "/bin/sh").args(["-c", "printf toolong"]),
                5,
                3
            )
            .is_err()
        );
        let started = Instant::now();
        assert!(capture(command(root, "/bin/sleep").arg("10"), 1, 64).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
