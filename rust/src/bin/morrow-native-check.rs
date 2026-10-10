//! Node-free Swift client acceptance with the unmodified production Rust service.
//! This checks Rust→Rust persistence. Historical Node interoperability CI is
//! retired; this driver does not establish old-client upgrade acceptance.
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
        Arc, Mutex,
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

const READER_BATCH_SAMPLES: usize = 40;
const READER_SAMPLE_LOG_LIMIT: usize = 1024 * 1024;
const READER_WRAP_SAMPLES_PER_POLICY: usize = 6;
const READER_WRAP_POLICIES: [(&str, &str); 2] = [
    ("break-word", "READER_DIAGNOSTIC_BREAK_WORD"),
    ("normal", "READER_DIAGNOSTIC_NORMAL"),
];
const READER_VISIBILITY_PAIRS: usize = 3;
const READER_VISIBILITY_POLICIES: [(&str, &str); 2] = [
    (
        "baseline-presentation",
        "READER_DIAGNOSTIC_BASELINE_PRESENTATION",
    ),
    (
        "foreground-prepared",
        "READER_DIAGNOSTIC_FOREGROUND_PRESENTATION",
    ),
];
const READER_STRUCTURE_PAIRS: usize = 3;
const READER_STRUCTURE_POLICIES: [(&str, &str, u8); 2] = [
    (
        "baseline-structure",
        "READER_DIAGNOSTIC_BASELINE_STRUCTURE",
        0,
    ),
    ("nested-inline", "READER_DIAGNOSTIC_NESTED_INLINE", 2),
];
const READER_RENDERING_PAIRS: usize = 3;
const READER_RENDERING_POLICIES: [(&str, &str, bool); 2] = [
    (
        "baseline-rendering",
        "READER_DIAGNOSTIC_BASELINE_RENDERING",
        false,
    ),
    (
        "suppressed-rendering",
        "READER_DIAGNOSTIC_SUPPRESSED_RENDERING",
        true,
    ),
];

#[derive(Clone, Copy)]
enum ReaderDiagnostic<'a> {
    Wrap(&'a str),
    Visibility(&'a str),
    Structure(&'a str),
    Rendering(&'a str),
    OwnershipPreflight,
}

#[derive(Default)]
struct SampleLog {
    bytes: Vec<u8>,
    exceeded: bool,
    failed: bool,
    finished: bool,
    eof: bool,
}

// Separate from capture(): the full acceptance gate remains unchanged. Keep a
// bounded copy while draining both pipes so timeout/nonzero samples retain the
// last trace, and a noisy child cannot exhaust memory or deadlock on stderr.
fn sample_log_reader(
    mut pipe: impl Read + Send + 'static,
    limit: usize,
    stopped: Arc<AtomicBool>,
) -> (Arc<Mutex<SampleLog>>, thread::JoinHandle<()>) {
    let state = Arc::new(Mutex::new(SampleLog::default()));
    let output = state.clone();
    let worker = thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => {
                    output.lock().unwrap().eof = true;
                    break;
                }
                Ok(count) => {
                    let mut log = output.lock().unwrap();
                    let retained = count.min(limit.saturating_sub(log.bytes.len()));
                    log.bytes.extend_from_slice(&buffer[..retained]);
                    if retained < count {
                        log.exceeded = true;
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if stopped.load(Ordering::Acquire) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(_) => {
                    output.lock().unwrap().failed = true;
                    break;
                }
            }
        }
        output.lock().unwrap().finished = true;
    });
    (state, worker)
}

#[cfg(unix)]
fn nonblocking_sample_pipe(pipe: &impl std::os::fd::AsRawFd) -> Result<()> {
    let fd = pipe.as_raw_fd();
    // Only our newly created pipe, never an inherited app/service descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

struct SampleProcess {
    outcome: &'static str,
    capture_complete: bool,
    elapsed_ms: u128,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

struct ReaderOwnershipProbe {
    root: PathBuf,
    directory: PathBuf,
    reader_pid: Option<u32>,
    cancelled: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<std::result::Result<SampleProcess, String>>>,
    result: Option<std::result::Result<SampleProcess, String>>,
}

const READER_PREFLIGHT_ENVIRONMENT: [&str; 16] = [
    "PATH",
    "HOME",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_COLLATE",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "SECURITYSESSIONID",
    "__CF_USER_TEXT_ENCODING",
    "LC_PAPER",
];

fn isolate_reader_preflight_environment(command: &mut Command) -> &mut Command {
    command.env_clear();
    for name in READER_PREFLIGHT_ENVIRONMENT {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}

impl ReaderOwnershipProbe {
    fn new(root: &Path, directory: &Path) -> Self {
        Self {
            root: root.to_owned(),
            directory: directory.to_owned(),
            reader_pid: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            worker: None,
            result: None,
        }
    }

    fn observe(&mut self, reader_pid: u32, stderr: &[u8]) {
        self.reader_pid = Some(reader_pid);
        if self.worker.is_some()
            || self.result.is_some()
            || !reader_adversarial_loading_observed(stderr)
        {
            return;
        }
        let root = self.root.clone();
        let output = self.directory.join("ownership.json");
        let cancelled = self.cancelled.clone();
        self.worker = Some(thread::spawn(move || {
            reader_sample_process_controlled(
                isolate_reader_preflight_environment(&mut command(&root, "python3"))
                    .args(["-I", "-B", "scripts/probe-macos-reader-processes.py"])
                    .arg("--reader-pid")
                    .arg(reader_pid.to_string())
                    .arg("--output")
                    .arg(output),
                Duration::from_secs(8),
                128 * 1024,
                Some(cancelled),
                None,
            )
            .map_err(|error| error.to_string())
        }));
    }

    fn finish(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            self.result = Some(
                worker
                    .join()
                    .unwrap_or_else(|_| Err("Ownership probe worker failed.".to_owned())),
            );
        }
    }
}

impl Drop for ReaderOwnershipProbe {
    fn drop(&mut self) {
        self.finish();
    }
}

fn reader_adversarial_loading_observed(stderr: &[u8]) -> bool {
    let prefix = "Native macOS reader: trace phase=adversarial-text ";
    let mut update_end_ms = None;
    // A pipe snapshot can end partway through a trace. Only complete newline
    // frames may establish the update boundary or trigger the one-shot observer.
    for frame in String::from_utf8_lossy(stderr).split_inclusive('\n') {
        let Some(line) = frame.strip_suffix('\n') else {
            continue;
        };
        let Some(event) = line.strip_prefix(prefix) else {
            continue;
        };
        let Some((event, elapsed)) = event.rsplit_once(" +") else {
            continue;
        };
        let Some(elapsed) = elapsed.strip_suffix(" ms") else {
            continue;
        };
        if elapsed.is_empty() || !elapsed.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(elapsed) = elapsed.parse::<u64>() else {
            continue;
        };
        if event == "fixture-update-request end; SwiftUI navigation/layout may still be pending" {
            update_end_ms = Some(elapsed);
        } else if update_end_ms.is_some_and(|end| elapsed >= end)
            && matches!(
                event,
                "navigation-loading reader=initial value=true"
                    | "marker-wait-begin marker=Bounded adversarial tail loading=true"
            )
        {
            return true;
        }
    }
    false
}

fn reader_sample_process(
    command: &mut Command,
    duration: Duration,
    limit: usize,
) -> Result<SampleProcess> {
    reader_sample_process_controlled(command, duration, limit, None, None)
}

fn reader_sample_process_controlled(
    command: &mut Command,
    duration: Duration,
    limit: usize,
    cancelled: Option<Arc<AtomicBool>>,
    mut observer: Option<&mut ReaderOwnershipProbe>,
) -> Result<SampleProcess> {
    check(
        !cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire)),
        "Ownership probe cancelled before startup.",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // Start before spawn: startup and the warm-view preparation count against
    // the same wall-clock deadline as the adversarial render.
    let started = Instant::now();
    let deadline = started + duration;
    let mut running = Running {
        child: command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
        completed: false,
    };
    let stdout = running
        .child
        .stdout
        .take()
        .ok_or("Missing sample stdout.")?;
    let stderr = running
        .child
        .stderr
        .take()
        .ok_or("Missing sample stderr.")?;
    #[cfg(unix)]
    {
        nonblocking_sample_pipe(&stdout)?;
        nonblocking_sample_pipe(&stderr)?;
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let (stdout, stdout_worker) = sample_log_reader(stdout, limit, stopped.clone());
    let (stderr, stderr_worker) = sample_log_reader(stderr, limit, stopped.clone());
    if let Some(observer) = observer.as_deref_mut() {
        observer.reader_pid = Some(running.child.id());
    }
    let mut exit_status = None;
    let mut outcome = loop {
        if cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
        {
            break "cancelled";
        }
        if exit_status.is_none() {
            match running.child.try_wait() {
                Ok(status) => exit_status = status,
                Err(_) => break "wait-failed",
            }
        }
        if exit_status.is_none()
            && let Some(observer) = observer.as_deref_mut()
        {
            observer.observe(running.child.id(), &stderr.lock().unwrap().bytes);
        }
        let out = stdout.lock().unwrap();
        let err = stderr.lock().unwrap();
        if out.exceeded || err.exceeded {
            break "output-limit";
        }
        if out.failed || err.failed {
            break "capture-failed";
        }
        if Instant::now() >= deadline {
            break "timeout";
        }
        if let Some(status) = exit_status {
            if !status.success() {
                break "nonzero-exit";
            }
            if out.finished && err.finished {
                running.completed = true;
                break "exited";
            }
        }
        drop(out);
        drop(err);
        thread::sleep(Duration::from_millis(5));
    };
    // Kill/reap this process group before a caller stops its network sentinel.
    // This also closes inherited pipes after a timeout or failed child.
    drop(running);
    // The reader's deadline has already been decided and its process reaped.
    // Cancel/reap the separate metadata worker before ending the network sentinel.
    if let Some(observer) = observer {
        observer.finish();
    }
    stopped.store(true, Ordering::Release);
    let drain_deadline = Instant::now() + Duration::from_secs(1);
    while !(stdout_worker.is_finished() && stderr_worker.is_finished())
        && Instant::now() < drain_deadline
    {
        thread::sleep(Duration::from_millis(2));
    }
    // Nonblocking Unix readers finish even if a misbehaving descendant retained
    // a pipe. Never join a blocked reader and turn a 30s gate into an unbounded wait.
    let mut capture_complete = true;
    for worker in [stdout_worker, stderr_worker] {
        if !worker.is_finished() || worker.join().is_err() {
            capture_complete = false;
        }
    }
    let mut stdout = stdout.lock().unwrap();
    let mut stderr = stderr.lock().unwrap();
    if (stdout.exceeded || stderr.exceeded) && outcome == "exited" {
        outcome = "output-limit";
    }
    capture_complete &= stdout.eof
        && stderr.eof
        && !stdout.failed
        && !stderr.failed
        && !stdout.exceeded
        && !stderr.exceeded;
    // Preserve the original timeout/nonzero finding. Capture completeness is
    // independent evidence, including readers stopped without reaching EOF.
    if !capture_complete && outcome == "exited" {
        outcome = "capture-failed";
    }
    Ok(SampleProcess {
        outcome,
        capture_complete,
        elapsed_ms: started.elapsed().as_millis(),
        exit_code: exit_status.and_then(|status| status.code()),
        stdout: std::mem::take(&mut stdout.bytes),
        stderr: std::mem::take(&mut stderr.bytes),
        stdout_truncated: stdout.exceeded,
        stderr_truncated: stderr.exceeded,
    })
}

fn validate_reader_sample(bytes: &[u8], mode: &str) -> Result<Value> {
    let text = std::str::from_utf8(bytes)?;
    check(
        text.lines().count() == 1,
        "Expected exactly one child JSON line.",
    )?;
    // serde's typed map rejects duplicate keys; Value alone would silently keep
    // the last value and could accept an ambiguous child result.
    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ChildResult {
        schema_version: u32,
        kind: String,
        mode: String,
        status: String,
        text_characters: u32,
        column_width_px: u32,
        process_elapsed_ms: Value,
        adversarial_elapsed_ms: Value,
        warmup_elapsed_ms: Value,
        same_web_view: Value,
        error: Value,
    }
    let child: ChildResult = serde_json::from_str(text)?;
    let value = serde_json::to_value(child)?;
    let finite_time = |value: &Value| {
        value
            .as_f64()
            .is_some_and(|time| time.is_finite() && time >= 0.0)
    };
    check(
        value["schemaVersion"] == 1
            && value["kind"] == "reader-adversarial"
            && value["mode"] == mode
            && matches!(mode, "cold-view" | "warm-view")
            && value["textCharacters"] == 180_000
            && value["columnWidthPx"] == 1
            && finite_time(&value["processElapsedMs"])
            && (value["adversarialElapsedMs"].is_null()
                || finite_time(&value["adversarialElapsedMs"]))
            && (value["warmupElapsedMs"].is_null() || finite_time(&value["warmupElapsedMs"]))
            && (value["sameWebView"].is_null() || value["sameWebView"].is_boolean())
            && (value["error"].is_null() || value["error"].is_string())
            && matches!(value["status"].as_str(), Some("passed" | "failed")),
        "Child result does not match the fixed adversarial contract.",
    )?;
    check(
        value["status"] == "passed",
        "Child reported a failed sample.",
    )?;
    check(
        finite_time(&value["adversarialElapsedMs"])
            && value["sameWebView"] == true
            && value["error"].is_null()
            && match mode {
                "cold-view" => value["warmupElapsedMs"].is_null(),
                "warm-view" => finite_time(&value["warmupElapsedMs"]),
                _ => false,
            },
        "Successful child result omitted its timing or same-view evidence.",
    )?;
    Ok(value)
}

fn write_sample_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn save_reader_sample(
    directory: &Path,
    sequence: usize,
    mode: &str,
    process: Result<SampleProcess>,
    network: Result<()>,
) -> Result<Value> {
    save_reader_sample_with_policy(directory, sequence, mode, process, network, None)
}

fn reader_sample_prefix(sequence: usize, diagnostic_policy: Option<&str>) -> String {
    match diagnostic_policy {
        Some(policy) => format!("Reader wrap diagnostic {policy} sample {sequence:02}"),
        None => format!("Reader batch sample {sequence:02}"),
    }
}

fn reader_diagnostic_policy_observed(stderr: &[u8], policy: &str) -> bool {
    reader_diagnostic_control_observed(stderr, policy, "wrapping")
}

fn reader_diagnostic_control_observed(stderr: &[u8], policy: &str, control: &str) -> bool {
    let text = String::from_utf8_lossy(stderr);
    let marker = format!("diagnostic-{control}-control");
    let markers: Vec<_> = text
        .lines()
        .filter(|line| line.starts_with("Native macOS reader: ") && line.contains(&marker))
        .collect();
    let prefix = format!(
        "Native macOS reader: trace phase=setup diagnostic-{control}-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 +"
    );
    markers.len() == 1
        && markers[0]
            .strip_prefix(&prefix)
            .and_then(|suffix| suffix.strip_suffix(" ms"))
            .is_some_and(|elapsed| {
                !elapsed.is_empty() && elapsed.bytes().all(|byte| byte.is_ascii_digit())
            })
}

fn reader_structure_depth(policy: &str) -> Option<u8> {
    READER_STRUCTURE_POLICIES
        .iter()
        .find(|(expected, _, _)| *expected == policy)
        .map(|(_, _, depth)| *depth)
}

fn reader_structure_control_observed(stderr: &[u8], policy: &str) -> bool {
    let Some(depth) = reader_structure_depth(policy) else {
        return false;
    };
    let text = String::from_utf8_lossy(stderr);
    let markers: Vec<_> = text
        .lines()
        .filter(|line| {
            line.starts_with("Native macOS reader: ")
                && line.contains("diagnostic-structure-control")
        })
        .collect();
    let prefix = format!(
        "Native macOS reader: trace phase=setup diagnostic-structure-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 wrapperDepth={depth} +"
    );
    markers.len() == 1
        && markers[0]
            .strip_prefix(&prefix)
            .and_then(|tail| tail.strip_suffix(" ms"))
            .is_some_and(|elapsed| {
                !elapsed.is_empty() && elapsed.bytes().all(|byte| byte.is_ascii_digit())
            })
}

fn reader_structure_evidence(stderr: &[u8], policy: &str) -> Result<Value> {
    let depth = reader_structure_depth(policy).ok_or("Unknown structure policy.")?;
    check(
        reader_structure_control_observed(stderr, policy),
        "Missing or conflicting structure control marker.",
    )?;
    let text = std::str::from_utf8(stderr)?;
    let marker = |name: &str| -> Result<(usize, &str)> {
        let matches: Vec<_> = text
            .lines()
            .enumerate()
            .filter(|(_, line)| line.starts_with("Native macOS reader: ") && line.contains(name))
            .collect();
        check(
            matches.len() == 1,
            "Missing or duplicate structure publication/update marker.",
        )?;
        Ok(matches[0])
    };
    let (startup_index, startup) = marker("diagnostic-structure-control")?;
    let (publish_index, publish) = marker("structure-adversarial-publish")?;
    let (request_index, request) = marker("fixture-update-request begin")?;
    let (request_end_index, request_end) = marker("fixture-update-request end")?;
    check(
        startup_index < publish_index
            && publish_index < request_index
            && request_index < request_end_index,
        "Structure policy publication must precede the actual adversarial update request.",
    )?;
    let publish_pattern = Regex::new(&format!(
        r"^Native macOS reader: trace phase=adversarial-text structure-adversarial-publish policy={} wrapperDepth={depth} \+([0-9]+) ms$",
        regex::escape(policy)
    ))?;
    let publish = publish_pattern
        .captures(publish)
        .ok_or("Invalid structure publication policy or wrapper depth.")?;
    let request_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=([0-9]+) viewportHeight=([0-9]+) windowWidth=([0-9]+) \+([0-9]+) ms$",
    )?;
    let request = request_pattern
        .captures(request)
        .ok_or("Invalid structure adversarial request trace.")?;
    let request_end_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending \+([0-9]+) ms$",
    )?;
    let request_end = request_end_pattern
        .captures(request_end)
        .ok_or("Invalid structure update completion trace.")?;
    let startup_ms = startup
        .rsplit_once(" +")
        .and_then(|(_, tail)| tail.strip_suffix(" ms"))
        .ok_or("Invalid structure startup timestamp.")?
        .parse::<u64>()?;
    let publish_ms = publish[1].parse::<u64>()?;
    let request_ms = request[4].parse::<u64>()?;
    let request_end_ms = request_end[1].parse::<u64>()?;
    check(
        startup_ms <= publish_ms && publish_ms <= request_ms && request_ms <= request_end_ms,
        "Structure timestamps are not monotonic.",
    )?;
    Ok(
        json!({"wrapperDepth":depth,"startupElapsedMs":startup_ms,"publishElapsedMs":publish_ms,
        "requestElapsedMs":request_ms,"requestEndElapsedMs":request_end_ms,
        "viewportWidth":request[1].parse::<u64>()?,"viewportHeight":request[2].parse::<u64>()?,
        "windowWidth":request[3].parse::<u64>()?}),
    )
}

fn reader_rendering_setting(policy: &str) -> Option<bool> {
    READER_RENDERING_POLICIES
        .iter()
        .find(|(expected, _, _)| *expected == policy)
        .map(|(_, _, setting)| *setting)
}

fn reader_rendering_control_observed(stderr: &[u8], policy: &str) -> bool {
    let Some(setting) = reader_rendering_setting(policy) else {
        return false;
    };
    let text = String::from_utf8_lossy(stderr);
    let markers: Vec<_> = text
        .lines()
        .filter(|line| {
            line.starts_with("Native macOS reader: ")
                && line.contains("diagnostic-rendering-control")
        })
        .collect();
    let prefix = format!(
        "Native macOS reader: trace phase=setup diagnostic-rendering-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 requestedSuppressesIncrementalRendering={setting} +"
    );
    markers.len() == 1
        && markers[0]
            .strip_prefix(&prefix)
            .and_then(|tail| tail.strip_suffix(" ms"))
            .is_some_and(|elapsed| {
                !elapsed.is_empty() && elapsed.bytes().all(|byte| byte.is_ascii_digit())
            })
}

fn reader_rendering_evidence(stderr: &[u8], policy: &str) -> Result<Value> {
    let setting = reader_rendering_setting(policy).ok_or("Unknown rendering policy.")?;
    check(
        reader_rendering_control_observed(stderr, policy),
        "Missing or conflicting rendering control marker.",
    )?;
    let text = std::str::from_utf8(stderr)?;
    let marker = |name: &str| -> Result<(usize, &str)> {
        let matches: Vec<_> = text
            .lines()
            .enumerate()
            .filter(|(_, line)| line.starts_with("Native macOS reader: ") && line.contains(name))
            .collect();
        check(
            matches.len() == 1,
            "Missing or duplicate rendering configuration/update marker.",
        )?;
        Ok(matches[0])
    };
    check(
        text.lines()
            .filter(|line| {
                line.starts_with("Native macOS reader: ")
                    && line.contains("rendering-configuration")
            })
            .count()
            == 3,
        "Expected exactly three actual rendering configuration readbacks.",
    )?;
    let (startup_index, startup) = marker("diagnostic-rendering-control")?;
    let startup_ms = startup
        .rsplit_once(" +")
        .and_then(|(_, tail)| tail.strip_suffix(" ms"))
        .ok_or("Invalid rendering startup timestamp.")?
        .parse::<u64>()?;
    let mut readbacks = Vec::new();
    let mut positions = Vec::new();
    for (stage, phase) in [
        ("first-view-discovered", "initial-load"),
        ("before-adversarial", "adversarial-text"),
        ("after-adversarial-marker", "adversarial-text"),
    ] {
        let (index, line) = marker(&format!(
            "rendering-configuration policy={policy} stage={stage} "
        ))?;
        let pattern = Regex::new(&format!(
            r"^Native macOS reader: trace phase={phase} rendering-configuration policy={} stage={stage} suppressesIncrementalRendering=(true|false) sameWebView=(true|false) \+([0-9]+) ms$",
            regex::escape(policy)
        ))?;
        let captured = pattern
            .captures(line)
            .ok_or("Invalid actual rendering configuration readback.")?;
        let elapsed = captured[3].parse::<u64>()?;
        positions.push((index, elapsed));
        readbacks.push(json!({"stage":stage,"elapsedMs":elapsed,"suppressesIncrementalRendering":&captured[1] == "true", "sameWebView":&captured[2] == "true"}));
    }
    let (request_index, request) = marker("fixture-update-request begin")?;
    let (request_end_index, request_end) = marker("fixture-update-request end")?;
    let (marker_index, marker_end) = marker("marker-wait-end marker=Bounded adversarial tail ")?;
    let request_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=([0-9]+) viewportHeight=([0-9]+) windowWidth=([0-9]+) \+([0-9]+) ms$",
    )?;
    let request = request_pattern
        .captures(request)
        .ok_or("Invalid rendering adversarial request trace.")?;
    let request_end_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending \+([0-9]+) ms$",
    )?;
    let request_end = request_end_pattern
        .captures(request_end)
        .ok_or("Invalid rendering update completion trace.")?;
    let marker_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text marker-wait-end marker=Bounded adversarial tail polls=([0-9]+) durationMs=([0-9]+) width=([0-9]+) height=([0-9]+) \+([0-9]+) ms$",
    )?;
    let marker_end = marker_pattern
        .captures(marker_end)
        .ok_or("Invalid rendering adversarial marker completion.")?;
    let request_ms = request[4].parse::<u64>()?;
    let request_end_ms = request_end[1].parse::<u64>()?;
    let marker_ms = marker_end[5].parse::<u64>()?;
    let ordered = [
        (startup_index, startup_ms),
        positions[0],
        positions[1],
        (request_index, request_ms),
        (request_end_index, request_end_ms),
        (marker_index, marker_ms),
        positions[2],
    ];
    check(
        ordered
            .windows(2)
            .all(|pair| pair[0].0 < pair[1].0 && pair[0].1 <= pair[1].1),
        "Rendering readbacks must bracket the actual adversarial update and marker completion.",
    )?;
    Ok(
        json!({"requestedConfig":setting,"configurationProperty":"suppressesIncrementalRendering",
        "configurationForced":true,"readbackScope":"WKWebView.configuration",
        "actualConfigurationMatchesRequested":readbacks.iter().all(|readback| readback["suppressesIncrementalRendering"] == setting),
        "sameWebView":readbacks.iter().all(|readback| readback["sameWebView"] == true),
        "startupElapsedMs":startup_ms,"requestElapsedMs":request_ms,"requestEndElapsedMs":request_end_ms,
        "markerElapsedMs":marker_ms,"readbacks":readbacks}),
    )
}

fn reader_visibility_evidence(stderr: &[u8], policy: &str) -> Result<Value> {
    check(
        READER_VISIBILITY_POLICIES
            .iter()
            .any(|(expected, _)| *expected == policy),
        "Unknown visibility policy.",
    )?;
    check(
        reader_diagnostic_control_observed(stderr, policy, "visibility"),
        "Missing or conflicting visibility control marker.",
    )?;
    let text = std::str::from_utf8(stderr)?;
    let marker = |name: &str| -> Result<(usize, &str)> {
        let matches: Vec<_> = text
            .lines()
            .enumerate()
            .filter(|(_, line)| line.starts_with("Native macOS reader: ") && line.contains(name))
            .collect();
        check(
            matches.len() == 1,
            "Missing or duplicate visibility preparation/publication marker.",
        )?;
        Ok(matches[0])
    };
    let (startup_index, startup) = marker("diagnostic-visibility-control")?;
    let (state_index, state) = marker("visibility-state")?;
    let (publish_index, publish) = marker("visibility-adversarial-publish")?;
    let (request_index, request) = marker("fixture-update-request begin")?;
    let (request_end_index, request_end) = marker("fixture-update-request end")?;
    check(
        startup_index < state_index
            && state_index < publish_index
            && publish_index < request_index
            && request_index < request_end_index,
        "Visibility preparation must precede the actual adversarial update request.",
    )?;
    let escaped_policy = regex::escape(policy);
    let state_pattern = Regex::new(&format!(
        "^Native macOS reader: trace phase=focused-warmup visibility-state policy={escaped_policy} stage=before-adversarial attached=(true|false) hidden=(true|false) positiveBounds=(true|false) appActive=(true|false) windowKey=(true|false) windowVisible=(true|false) occlusionVisible=(true|false) sameWebView=(true|false) \\+([0-9]+) ms$"
    ))?;
    let state = state_pattern
        .captures(state)
        .ok_or("Invalid visibility state flags or policy.")?;
    let publish_pattern = Regex::new(&format!(
        "^Native macOS reader: trace phase=adversarial-text visibility-adversarial-publish policy={escaped_policy} \\+([0-9]+) ms$"
    ))?;
    let publish = publish_pattern
        .captures(publish)
        .ok_or("Invalid visibility publication policy.")?;
    let request_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=([0-9]+) viewportHeight=([0-9]+) windowWidth=([0-9]+) \+([0-9]+) ms$",
    )?;
    let request = request_pattern
        .captures(request)
        .ok_or("Invalid adversarial update request trace.")?;
    let request_end_pattern = Regex::new(
        r"^Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending \+([0-9]+) ms$",
    )?;
    let request_end = request_end_pattern
        .captures(request_end)
        .ok_or("Invalid adversarial update completion trace.")?;
    let startup_ms = startup
        .rsplit_once(" +")
        .and_then(|(_, tail)| tail.strip_suffix(" ms"))
        .ok_or("Invalid visibility startup timestamp.")?
        .parse::<u64>()?;
    let state_ms = state[9].parse::<u64>()?;
    let publish_ms = publish[1].parse::<u64>()?;
    let request_ms = request[4].parse::<u64>()?;
    let request_end_ms = request_end[1].parse::<u64>()?;
    check(
        startup_ms <= state_ms
            && state_ms <= publish_ms
            && publish_ms <= request_ms
            && request_ms <= request_end_ms,
        "Visibility timestamps are not monotonic.",
    )?;
    let keys = [
        "attached",
        "hidden",
        "positiveBounds",
        "appActive",
        "windowKey",
        "windowVisible",
        "occlusionVisible",
        "sameWebView",
    ];
    let mut evidence = json!({"startupElapsedMs":startup_ms,"stateElapsedMs":state_ms,"publishElapsedMs":publish_ms,
        "requestElapsedMs":request_ms,"requestEndElapsedMs":request_end_ms,
        "viewportWidth":request[1].parse::<u64>()?,"viewportHeight":request[2].parse::<u64>()?,"windowWidth":request[3].parse::<u64>()?});
    for (index, key) in keys.iter().enumerate() {
        evidence[*key] = json!(&state[index + 1] == "true");
    }
    evidence["foregroundReady"] =
        json!(keys.iter().all(|key| evidence[*key] == (*key != "hidden")));
    Ok(evidence)
}

fn save_reader_sample_with_policy(
    directory: &Path,
    sequence: usize,
    mode: &str,
    process: Result<SampleProcess>,
    network: Result<()>,
    diagnostic_policy: Option<&str>,
) -> Result<Value> {
    save_reader_sample_with_diagnostic(
        directory,
        sequence,
        mode,
        process,
        network,
        diagnostic_policy.map(ReaderDiagnostic::Wrap),
    )
}

fn save_reader_sample_with_diagnostic(
    directory: &Path,
    sequence: usize,
    mode: &str,
    process: Result<SampleProcess>,
    network: Result<()>,
    diagnostic: Option<ReaderDiagnostic<'_>>,
) -> Result<Value> {
    let mut errors = Vec::new();
    let (stdout, stderr, parent) = match process {
        Ok(process) => {
            if process.outcome != "exited" {
                errors.push(format!("parent:{}", process.outcome));
            }
            if !process.capture_complete {
                errors.push("parent:capture-incomplete".to_owned());
            }
            let parent = json!({"outcome": process.outcome, "elapsedMs": process.elapsed_ms,
                "captureComplete": process.capture_complete,
                "exitCode": process.exit_code, "stdoutBytes": process.stdout.len(),
                "stderrBytes": process.stderr.len(), "stdoutTruncated": process.stdout_truncated,
                "stderrTruncated": process.stderr_truncated});
            (process.stdout, process.stderr, parent)
        }
        Err(error) => {
            errors.push(format!("parent setup failed: {error}"));
            (
                Vec::new(),
                Vec::new(),
                json!({"outcome":"setup-failed", "captureComplete":false}),
            )
        }
    };
    if let Err(error) = validate_reader_sample(&stdout, mode) {
        errors.push(format!("child: {error}"));
    }
    let network_zero = network.is_ok();
    if let Err(error) = network {
        errors.push(format!("network: {error}"));
    }
    let diagnostic_policy_observed = diagnostic.map(|diagnostic| match diagnostic {
        ReaderDiagnostic::Wrap(policy) => reader_diagnostic_policy_observed(&stderr, policy),
        ReaderDiagnostic::Visibility(policy) => {
            reader_diagnostic_control_observed(&stderr, policy, "visibility")
        }
        ReaderDiagnostic::OwnershipPreflight => reader_adversarial_loading_observed(&stderr),
        ReaderDiagnostic::Structure(policy) => reader_structure_control_observed(&stderr, policy),
        ReaderDiagnostic::Rendering(policy) => reader_rendering_control_observed(&stderr, policy),
    });
    if diagnostic_policy_observed == Some(false) {
        errors.push("diagnostic: missing or conflicting compiled-policy trace".to_owned());
    }
    if matches!(diagnostic, Some(ReaderDiagnostic::OwnershipPreflight)) && mode != "warm-view" {
        errors.push("diagnostic: ownership preflight requires warm-view".to_owned());
    }
    let visibility_evidence = if let Some(ReaderDiagnostic::Visibility(policy)) = diagnostic {
        if mode != "warm-view" {
            errors.push("diagnostic: visibility controls require warm-view".to_owned());
        }
        match reader_visibility_evidence(&stderr, policy) {
            Ok(evidence) => {
                if evidence["sameWebView"] != true {
                    errors.push(
                        "diagnostic: visibility control replaced its warmup WebView".to_owned(),
                    );
                }
                if policy == "foreground-prepared" && evidence["foregroundReady"] != true {
                    errors.push(
                        "diagnostic: foreground preparation conditions were not met".to_owned(),
                    );
                }
                Some(evidence)
            }
            Err(error) => {
                errors.push(format!("diagnostic visibility: {error}"));
                None
            }
        }
    } else {
        None
    };
    let structure_evidence = if let Some(ReaderDiagnostic::Structure(policy)) = diagnostic {
        if mode != "warm-view" {
            errors.push("diagnostic: structure controls require warm-view".to_owned());
        }
        match reader_structure_evidence(&stderr, policy) {
            Ok(evidence) => Some(evidence),
            Err(error) => {
                errors.push(format!("diagnostic structure: {error}"));
                None
            }
        }
    } else {
        None
    };
    let rendering_evidence = if let Some(ReaderDiagnostic::Rendering(policy)) = diagnostic {
        if mode != "warm-view" {
            errors.push("diagnostic: rendering controls require warm-view".to_owned());
        }
        match reader_rendering_evidence(&stderr, policy) {
            Ok(evidence) => {
                if evidence["actualConfigurationMatchesRequested"] != true
                    || evidence["sameWebView"] != true
                {
                    errors.push(
                        "diagnostic: actual rendering configuration or WebView identity changed"
                            .to_owned(),
                    );
                }
                Some(evidence)
            }
            Err(error) => {
                errors.push(format!("diagnostic rendering: {error}"));
                None
            }
        }
    } else {
        None
    };
    write_sample_file(&directory.join("stdout.log"), &stdout)?;
    write_sample_file(&directory.join("stderr.log"), &stderr)?;
    let mut result = json!({"schemaVersion":1, "kind":"reader-adversarial-sample",
        "sequence":sequence, "mode":mode, "status":if errors.is_empty() {"passed"} else {"failed"},
        "parent":parent, "networkZero":network_zero,
        "childResult":serde_json::from_slice::<Value>(&stdout).ok(), "errors":errors});
    if let Some(diagnostic) = diagnostic {
        let (policy, kind) = match diagnostic {
            ReaderDiagnostic::Wrap(policy) => (policy, "reader-wrap-diagnostic-sample"),
            ReaderDiagnostic::Visibility(policy) => (policy, "reader-visibility-diagnostic-sample"),
            ReaderDiagnostic::Structure(policy) => (policy, "reader-structure-diagnostic-sample"),
            ReaderDiagnostic::Rendering(policy) => (policy, "reader-rendering-diagnostic-sample"),
            ReaderDiagnostic::OwnershipPreflight => {
                ("ownership-preflight", "reader-ownership-preflight-sample")
            }
        };
        result["kind"] = json!(kind);
        result["diagnosticPolicy"] = json!(policy);
        result["diagnosticPolicyObserved"] = json!(diagnostic_policy_observed);
        result["productionAcceptance"] = json!(false);
        if matches!(diagnostic, ReaderDiagnostic::Visibility(_)) {
            result["visibilityEvidence"] = json!(visibility_evidence);
            result["pair"] = json!(sequence.div_ceil(2));
        }
        if matches!(diagnostic, ReaderDiagnostic::OwnershipPreflight) {
            result["environmentIsolated"] = json!(true);
            result["baselineEnvironmentEquivalent"] = json!(false);
        }
        if let ReaderDiagnostic::Structure(policy) = diagnostic {
            result["wrapperDepth"] = json!(reader_structure_depth(policy));
            result["structureEvidence"] = json!(structure_evidence);
            result["pair"] = json!(sequence.div_ceil(2));
        }
        if let ReaderDiagnostic::Rendering(policy) = diagnostic {
            result["requestedConfig"] = json!(reader_rendering_setting(policy));
            result["configurationForced"] = json!(true);
            result["readbackScope"] = json!("WKWebView.configuration");
            result["renderingEvidence"] = json!(rendering_evidence);
            result["pair"] = json!(sequence.div_ceil(2));
        }
    }
    write_sample_file(
        &directory.join("result.json"),
        &serde_json::to_vec_pretty(&result)?,
    )?;
    // Public fixture-only traces survive in the terminal CI log even when the
    // artifact download is unavailable. Prefix each line, bound individual lines.
    let prefix = match diagnostic {
        Some(ReaderDiagnostic::Wrap(policy)) => reader_sample_prefix(sequence, Some(policy)),
        Some(ReaderDiagnostic::Visibility(policy)) => {
            format!("Reader visibility diagnostic {policy} sample {sequence:02}")
        }
        Some(ReaderDiagnostic::OwnershipPreflight) => {
            format!("Reader ownership preflight sample {sequence:02}")
        }
        Some(ReaderDiagnostic::Structure(policy)) => {
            format!("Reader structure diagnostic {policy} sample {sequence:02}")
        }
        Some(ReaderDiagnostic::Rendering(policy)) => {
            format!("Reader rendering diagnostic {policy} sample {sequence:02}")
        }
        None => reader_sample_prefix(sequence, None),
    };
    for line in String::from_utf8_lossy(&stderr)
        .lines()
        .filter(|line| line.starts_with("Native macOS reader: "))
        .take(120)
    {
        println!("{prefix}: {}", line.chars().take(1024).collect::<String>());
    }
    println!("{prefix} result: {result}");
    Ok(result)
}

fn reader_batch_evidence_complete(output: &Path, samples: &[Value]) -> bool {
    reader_series_evidence_complete(output, samples, READER_BATCH_SAMPLES, None)
}

fn reader_series_evidence_complete(
    output: &Path,
    samples: &[Value],
    expected_samples: usize,
    diagnostic_policy: Option<&str>,
) -> bool {
    samples.len() == expected_samples
        && samples.iter().enumerate().all(|(index, sample)| {
            let sequence = index + 1;
            let mode = if index % 2 == 0 {
                "cold-view"
            } else {
                "warm-view"
            };
            let directory = output.join(format!("sample-{sequence:02}-{mode}"));
            sample["sequence"] == sequence
                && sample["mode"] == mode
                && match diagnostic_policy {
                    Some(policy) => {
                        sample["kind"] == "reader-wrap-diagnostic-sample"
                            && sample["diagnosticPolicy"] == policy
                            && sample["productionAcceptance"] == false
                    }
                    None => {
                        sample["kind"] == "reader-adversarial-sample"
                            && sample.get("diagnosticPolicy").is_none()
                    }
                }
                && ["result.json", "stdout.log", "stderr.log"]
                    .iter()
                    .all(|name| directory.join(name).is_file())
                && fs::read(directory.join("result.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .as_ref()
                    == Some(sample)
        })
}

fn collect_reader_sample(
    root: &Path,
    reader: &Path,
    mode: &str,
) -> (Result<SampleProcess>, Result<()>) {
    let mut network_result = Err("Network sentinel was not started.".into());
    let process = (|| {
        // Fresh private path, process and sentinel for every attempt. A warm
        // sample only warms its own WebView; no process is reused across samples.
        let workspace = Fixture::new()?;
        let network = ReaderNetwork::start()?;
        let process = reader_sample_process(
            command(root, reader)
                .arg(network.port.to_string())
                .args(["--adversarial", mode])
                .env("MORROW_DATA_DIR", &workspace.0),
            Duration::from_secs(30),
            READER_SAMPLE_LOG_LIMIT,
        );
        network_result = network.finish();
        process
    })();
    (process, network_result)
}

fn reader_adversarial_batch(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader batch requires an absolute new output directory.",
    )?;
    // Exclusive creation rejects an existing directory or symlink. Never reuse
    // old evidence, overwrite a prior run, or recursively create caller paths.
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let reader = compile_check(
        root,
        &fixture.0,
        "reader-checks",
        &[
            "-parse-as-library",
            "macos/Sources/MorrowMail/Models.swift",
            "macos/Sources/MorrowMail/MessageBodyView.swift",
            "macos/Checks/MessageHTML.swift",
        ],
    )?;
    let mut samples = Vec::new();
    for index in 0..READER_BATCH_SAMPLES {
        let sequence = index + 1;
        let mode = if index % 2 == 0 {
            "cold-view"
        } else {
            "warm-view"
        };
        let directory = output.join(format!("sample-{sequence:02}-{mode}"));
        fs::create_dir(&directory)?;
        let (process, network_result) = collect_reader_sample(root, &reader, mode);
        samples.push(save_reader_sample(
            &directory,
            sequence,
            mode,
            process,
            network_result,
        )?);
    }
    let passed = samples
        .iter()
        .filter(|sample| sample["status"] == "passed")
        .count();
    let complete = reader_batch_evidence_complete(output, &samples);
    let summary = json!({"schemaVersion":1,"kind":"reader-adversarial-batch",
        "status":if complete && passed == READER_BATCH_SAMPLES {"passed"} else {"failed"},
        "expectedSamples":READER_BATCH_SAMPLES,"completedSamples":samples.len(),
        "passedSamples":passed,"failedSamples":samples.len()-passed,"complete":complete,
        "wholeProcessDeadlineMs":30_000,"textCharacters":180_000,"columnWidthPx":1,"samples":samples});
    write_sample_file(
        &output.join("batch.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader batch completed: {passed}/{READER_BATCH_SAMPLES} passed; complete={complete}; {}",
        output.display()
    );
    check(
        complete && passed == READER_BATCH_SAMPLES,
        "Reader adversarial batch failed; all attempted samples and logs retained.",
    )
}

fn reader_wrap_diagnostic(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader wrapping diagnostic requires an absolute new output directory.",
    )?;
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let mut policies = Vec::new();
    for (policy, define) in READER_WRAP_POLICIES {
        let directory = output.join(policy);
        fs::create_dir(&directory)?;
        let executable = format!("reader-wrap-{policy}");
        let reader = compile_check(
            root,
            &fixture.0,
            &executable,
            &[
                "-parse-as-library",
                "-D",
                define,
                "macos/Sources/MorrowMail/Models.swift",
                "macos/Sources/MorrowMail/MessageBodyView.swift",
                "macos/Checks/MessageHTML.swift",
            ],
        );
        let mut samples = Vec::new();
        for index in 0..READER_WRAP_SAMPLES_PER_POLICY {
            let sequence = index + 1;
            let mode = if index % 2 == 0 {
                "cold-view"
            } else {
                "warm-view"
            };
            let sample_directory = directory.join(format!("sample-{sequence:02}-{mode}"));
            fs::create_dir(&sample_directory)?;
            let (process, network) = match &reader {
                Ok(reader) => collect_reader_sample(root, reader, mode),
                Err(error) => (
                    Err(format!("Diagnostic fixture compile failed: {error}").into()),
                    Err("Network sentinel was not started.".into()),
                ),
            };
            samples.push(save_reader_sample_with_policy(
                &sample_directory,
                sequence,
                mode,
                process,
                network,
                Some(policy),
            )?);
        }
        let complete = reader_series_evidence_complete(
            &directory,
            &samples,
            READER_WRAP_SAMPLES_PER_POLICY,
            Some(policy),
        );
        let passed = samples
            .iter()
            .filter(|sample| sample["status"] == "passed")
            .count();
        let summary = json!({"schemaVersion":1,"kind":"reader-wrap-diagnostic-policy",
            "diagnosticPolicy":policy,"compileDefine":define,"compiledExecutable":executable,
            "compileSucceeded":reader.is_ok(),"productionAcceptance":false,
            "status":if complete && passed == READER_WRAP_SAMPLES_PER_POLICY {"passed"} else {"failed"},
            "expectedSamples":READER_WRAP_SAMPLES_PER_POLICY,"completedSamples":samples.len(),
            "passedSamples":passed,"failedSamples":samples.len()-passed,"complete":complete,
            "wholeProcessDeadlineMs":30_000,"textCharacters":180_000,"columnWidthPx":1,"samples":samples});
        write_sample_file(
            &directory.join("policy.json"),
            &serde_json::to_vec_pretty(&summary)?,
        )?;
        println!(
            "Reader wrap diagnostic {policy} completed: {passed}/{READER_WRAP_SAMPLES_PER_POLICY} passed; complete={complete}; productionAcceptance=false"
        );
        policies.push(summary);
    }
    let complete = policies.len() == READER_WRAP_POLICIES.len()
        && policies
            .iter()
            .zip(READER_WRAP_POLICIES)
            .all(|(summary, (policy, _))| {
                let directory = output.join(policy);
                summary["complete"] == true
                    && summary["samples"].as_array().is_some_and(|samples| {
                        reader_series_evidence_complete(
                            &directory,
                            samples,
                            READER_WRAP_SAMPLES_PER_POLICY,
                            Some(policy),
                        )
                    })
                    && fs::read(directory.join("policy.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                        .as_ref()
                        == Some(summary)
            });
    let passed = complete && policies.iter().all(|policy| policy["status"] == "passed");
    let completed_samples: u64 = policies
        .iter()
        .filter_map(|policy| policy["completedSamples"].as_u64())
        .sum();
    let passed_samples: u64 = policies
        .iter()
        .filter_map(|policy| policy["passedSamples"].as_u64())
        .sum();
    let summary = json!({"schemaVersion":1,"kind":"reader-wrap-diagnostic",
        "productionAcceptance":false,"status":if passed {"passed"} else {"failed"},
        "expectedSamples":READER_WRAP_POLICIES.len()*READER_WRAP_SAMPLES_PER_POLICY,
        "completedSamples":completed_samples,"passedSamples":passed_samples,"failedSamples":completed_samples-passed_samples,
        "complete":complete,"policies":policies});
    write_sample_file(
        &output.join("diagnostic.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader wrap diagnostic completed: passed={passed}; complete={complete}; productionAcceptance=false; {}",
        output.display()
    );
    check(
        passed,
        "Reader wrapping diagnostic failed; all attempted control samples and logs retained.",
    )
}

fn reader_visibility_evidence_complete(output: &Path, samples: &[Value]) -> bool {
    samples.len() == READER_VISIBILITY_PAIRS * READER_VISIBILITY_POLICIES.len()
        && samples.iter().enumerate().all(|(index, sample)| {
            let sequence = index + 1;
            let (policy, _) = READER_VISIBILITY_POLICIES[index % READER_VISIBILITY_POLICIES.len()];
            let directory = output
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            sample["sequence"] == sequence
                && sample["pair"] == index / 2 + 1
                && sample["mode"] == "warm-view"
                && sample["kind"] == "reader-visibility-diagnostic-sample"
                && sample["diagnosticPolicy"] == policy
                && sample["productionAcceptance"] == false
                && ["result.json", "stdout.log", "stderr.log"]
                    .iter()
                    .all(|name| directory.join(name).is_file())
                && fs::read(directory.join("result.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .as_ref()
                    == Some(sample)
        })
}

fn reader_visibility_diagnostic(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader visibility diagnostic requires an absolute new output directory.",
    )?;
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let mut readers = Vec::new();
    let mut policies = Vec::new();
    for (policy, define) in READER_VISIBILITY_POLICIES {
        fs::create_dir(output.join(policy))?;
        let executable = format!("reader-visibility-{policy}");
        let reader = compile_check(
            root,
            &fixture.0,
            &executable,
            &[
                "-parse-as-library",
                "-D",
                define,
                "macos/Sources/MorrowMail/Models.swift",
                "macos/Sources/MorrowMail/MessageBodyView.swift",
                "macos/Checks/MessageHTML.swift",
            ],
        );
        policies.push(
            json!({"schemaVersion":1,"kind":"reader-visibility-diagnostic-policy",
            "diagnosticPolicy":policy,"compileDefine":define,"compiledExecutable":executable,
            "compileSucceeded":reader.is_ok(),"productionAcceptance":false,
            "expectedSamples":READER_VISIBILITY_PAIRS,"mode":"warm-view"}),
        );
        readers.push(reader);
    }
    let expected_samples = READER_VISIBILITY_PAIRS * READER_VISIBILITY_POLICIES.len();
    let mut samples = Vec::new();
    for index in 0..expected_samples {
        let sequence = index + 1;
        let policy_index = index % READER_VISIBILITY_POLICIES.len();
        let (policy, _) = READER_VISIBILITY_POLICIES[policy_index];
        let directory = output
            .join(policy)
            .join(format!("sample-{sequence:02}-warm-view"));
        fs::create_dir(&directory)?;
        let (process, network) = match &readers[policy_index] {
            Ok(reader) => collect_reader_sample(root, reader, "warm-view"),
            Err(error) => (
                Err(format!("Diagnostic fixture compile failed: {error}").into()),
                Err("Network sentinel was not started.".into()),
            ),
        };
        samples.push(save_reader_sample_with_diagnostic(
            &directory,
            sequence,
            "warm-view",
            process,
            network,
            Some(ReaderDiagnostic::Visibility(policy)),
        )?);
    }
    let complete = reader_visibility_evidence_complete(output, &samples);
    for (summary, (policy, _)) in policies.iter_mut().zip(READER_VISIBILITY_POLICIES) {
        let policy_samples: Vec<_> = samples
            .iter()
            .filter(|sample| sample["diagnosticPolicy"] == policy)
            .cloned()
            .collect();
        let passed = policy_samples
            .iter()
            .filter(|sample| sample["status"] == "passed")
            .count();
        summary["completedSamples"] = json!(policy_samples.len());
        summary["passedSamples"] = json!(passed);
        summary["failedSamples"] = json!(policy_samples.len() - passed);
        summary["status"] = json!(if complete && passed == READER_VISIBILITY_PAIRS {
            "passed"
        } else {
            "failed"
        });
        summary["samples"] = json!(policy_samples);
        write_sample_file(
            &output.join(policy).join("policy.json"),
            &serde_json::to_vec_pretty(summary)?,
        )?;
    }
    let passed = samples
        .iter()
        .filter(|sample| sample["status"] == "passed")
        .count();
    let summary = json!({"schemaVersion":1,"kind":"reader-visibility-diagnostic",
        "productionAcceptance":false,"status":if complete && passed == expected_samples {"passed"} else {"failed"},
        "expectedPairs":READER_VISIBILITY_PAIRS,"expectedSamples":expected_samples,"mode":"warm-view",
        "completedSamples":samples.len(),"passedSamples":passed,"failedSamples":samples.len()-passed,
        "wholeProcessDeadlineMs":30_000,"textCharacters":180_000,"columnWidthPx":1,
        "complete":complete,"policies":policies,"samples":samples});
    write_sample_file(
        &output.join("diagnostic.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader visibility diagnostic completed: {passed}/{expected_samples} passed; complete={complete}; productionAcceptance=false; {}",
        output.display()
    );
    check(
        complete && passed == expected_samples,
        "Reader visibility diagnostic failed; all attempted control samples and logs retained.",
    )
}

fn reader_structure_evidence_complete(output: &Path, samples: &[Value]) -> bool {
    samples.len() == READER_STRUCTURE_PAIRS * READER_STRUCTURE_POLICIES.len()
        && samples.iter().enumerate().all(|(index, sample)| {
            let sequence = index + 1;
            let (policy, _, depth) =
                READER_STRUCTURE_POLICIES[index % READER_STRUCTURE_POLICIES.len()];
            let directory = output
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            sample["sequence"] == sequence
                && sample["pair"] == index / 2 + 1
                && sample["mode"] == "warm-view"
                && sample["kind"] == "reader-structure-diagnostic-sample"
                && sample["diagnosticPolicy"] == policy
                && sample["wrapperDepth"] == depth
                && sample["productionAcceptance"] == false
                && ["result.json", "stdout.log", "stderr.log"]
                    .iter()
                    .all(|name| directory.join(name).is_file())
                && fs::read(directory.join("result.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .as_ref()
                    == Some(sample)
        })
}

fn reader_structure_diagnostic(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader structure diagnostic requires an absolute new output directory.",
    )?;
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let mut readers = Vec::new();
    let mut policies = Vec::new();
    for (policy, define, depth) in READER_STRUCTURE_POLICIES {
        fs::create_dir(output.join(policy))?;
        let executable = format!("reader-structure-{policy}");
        let reader = compile_check(
            root,
            &fixture.0,
            &executable,
            &[
                "-parse-as-library",
                "-D",
                define,
                "macos/Sources/MorrowMail/Models.swift",
                "macos/Sources/MorrowMail/MessageBodyView.swift",
                "macos/Checks/MessageHTML.swift",
            ],
        );
        policies.push(json!({"schemaVersion":1,"kind":"reader-structure-diagnostic-policy",
            "diagnosticPolicy":policy,"wrapperDepth":depth,"compileDefine":define,"compiledExecutable":executable,
            "compileSucceeded":reader.is_ok(),"productionAcceptance":false,
            "expectedSamples":READER_STRUCTURE_PAIRS,"mode":"warm-view"}));
        readers.push(reader);
    }
    let expected_samples = READER_STRUCTURE_PAIRS * READER_STRUCTURE_POLICIES.len();
    let mut samples = Vec::new();
    for index in 0..expected_samples {
        let sequence = index + 1;
        let policy_index = index % READER_STRUCTURE_POLICIES.len();
        let (policy, _, _) = READER_STRUCTURE_POLICIES[policy_index];
        let directory = output
            .join(policy)
            .join(format!("sample-{sequence:02}-warm-view"));
        fs::create_dir(&directory)?;
        let (process, network) = match &readers[policy_index] {
            Ok(reader) => collect_reader_sample(root, reader, "warm-view"),
            Err(error) => (
                Err(format!("Diagnostic fixture compile failed: {error}").into()),
                Err("Network sentinel was not started.".into()),
            ),
        };
        samples.push(save_reader_sample_with_diagnostic(
            &directory,
            sequence,
            "warm-view",
            process,
            network,
            Some(ReaderDiagnostic::Structure(policy)),
        )?);
    }
    let complete = reader_structure_evidence_complete(output, &samples);
    for (summary, (policy, _, _)) in policies.iter_mut().zip(READER_STRUCTURE_POLICIES) {
        let policy_samples: Vec<_> = samples
            .iter()
            .filter(|sample| sample["diagnosticPolicy"] == policy)
            .cloned()
            .collect();
        let passed = policy_samples
            .iter()
            .filter(|sample| sample["status"] == "passed")
            .count();
        summary["completedSamples"] = json!(policy_samples.len());
        summary["passedSamples"] = json!(passed);
        summary["failedSamples"] = json!(policy_samples.len() - passed);
        summary["status"] = json!(if complete && passed == READER_STRUCTURE_PAIRS {
            "passed"
        } else {
            "failed"
        });
        summary["samples"] = json!(policy_samples);
        write_sample_file(
            &output.join(policy).join("policy.json"),
            &serde_json::to_vec_pretty(summary)?,
        )?;
    }
    let passed = samples
        .iter()
        .filter(|sample| sample["status"] == "passed")
        .count();
    let summary = json!({"schemaVersion":1,"kind":"reader-structure-diagnostic",
        "productionAcceptance":false,"status":if complete && passed == expected_samples {"passed"} else {"failed"},
        "expectedPairs":READER_STRUCTURE_PAIRS,"expectedSamples":expected_samples,"mode":"warm-view",
        "completedSamples":samples.len(),"passedSamples":passed,"failedSamples":samples.len()-passed,
        "wholeProcessDeadlineMs":30_000,"textCharacters":180_000,"columnWidthPx":1,
        "complete":complete,"policies":policies,"samples":samples});
    write_sample_file(
        &output.join("diagnostic.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader structure diagnostic completed: {passed}/{expected_samples} passed; complete={complete}; productionAcceptance=false; {}",
        output.display()
    );
    check(
        complete && passed == expected_samples,
        "Reader structure diagnostic failed; all attempted control samples and logs retained.",
    )
}

fn reader_rendering_evidence_complete(output: &Path, samples: &[Value]) -> bool {
    samples.len() == READER_RENDERING_PAIRS * READER_RENDERING_POLICIES.len()
        && samples.iter().enumerate().all(|(index, sample)| {
            let sequence = index + 1;
            let (policy, _, setting) =
                READER_RENDERING_POLICIES[index % READER_RENDERING_POLICIES.len()];
            let directory = output
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            sample["sequence"] == sequence
                && sample["pair"] == index / 2 + 1
                && sample["mode"] == "warm-view"
                && sample["kind"] == "reader-rendering-diagnostic-sample"
                && sample["diagnosticPolicy"] == policy
                && sample["requestedConfig"] == setting
                && sample["configurationForced"] == true
                && sample["readbackScope"] == "WKWebView.configuration"
                && sample["productionAcceptance"] == false
                && ["result.json", "stdout.log", "stderr.log"]
                    .iter()
                    .all(|name| directory.join(name).is_file())
                && fs::read(directory.join("result.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .as_ref()
                    == Some(sample)
        })
}

fn reader_rendering_diagnostic(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader rendering diagnostic requires an absolute new output directory.",
    )?;
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let mut readers = Vec::new();
    let mut policies = Vec::new();
    for (policy, define, setting) in READER_RENDERING_POLICIES {
        fs::create_dir(output.join(policy))?;
        let executable = format!("reader-rendering-{policy}");
        let reader = compile_check(
            root,
            &fixture.0,
            &executable,
            &[
                "-parse-as-library",
                "-D",
                define,
                "macos/Sources/MorrowMail/Models.swift",
                "macos/Sources/MorrowMail/MessageBodyView.swift",
                "macos/Checks/MessageHTML.swift",
            ],
        );
        policies.push(json!({"schemaVersion":1,"kind":"reader-rendering-diagnostic-policy",
            "diagnosticPolicy":policy,"requestedConfig":setting,"configurationForced":true,
            "configurationProperty":"suppressesIncrementalRendering","readbackScope":"WKWebView.configuration",
            "compileDefine":define,"compiledExecutable":executable,"compileSucceeded":reader.is_ok(),
            "productionAcceptance":false,"expectedSamples":READER_RENDERING_PAIRS,"mode":"warm-view"}));
        readers.push(reader);
    }
    let expected_samples = READER_RENDERING_PAIRS * READER_RENDERING_POLICIES.len();
    let mut samples = Vec::new();
    for index in 0..expected_samples {
        let sequence = index + 1;
        let policy_index = index % READER_RENDERING_POLICIES.len();
        let (policy, _, _) = READER_RENDERING_POLICIES[policy_index];
        let directory = output
            .join(policy)
            .join(format!("sample-{sequence:02}-warm-view"));
        fs::create_dir(&directory)?;
        let (process, network) = match &readers[policy_index] {
            Ok(reader) => collect_reader_sample(root, reader, "warm-view"),
            Err(error) => (
                Err(format!("Diagnostic fixture compile failed: {error}").into()),
                Err("Network sentinel was not started.".into()),
            ),
        };
        samples.push(save_reader_sample_with_diagnostic(
            &directory,
            sequence,
            "warm-view",
            process,
            network,
            Some(ReaderDiagnostic::Rendering(policy)),
        )?);
    }
    let complete = reader_rendering_evidence_complete(output, &samples);
    for (summary, (policy, _, _)) in policies.iter_mut().zip(READER_RENDERING_POLICIES) {
        let policy_samples: Vec<_> = samples
            .iter()
            .filter(|sample| sample["diagnosticPolicy"] == policy)
            .cloned()
            .collect();
        let passed = policy_samples
            .iter()
            .filter(|sample| sample["status"] == "passed")
            .count();
        summary["completedSamples"] = json!(policy_samples.len());
        summary["passedSamples"] = json!(passed);
        summary["failedSamples"] = json!(policy_samples.len() - passed);
        summary["status"] = json!(if complete && passed == READER_RENDERING_PAIRS {
            "passed"
        } else {
            "failed"
        });
        summary["samples"] = json!(policy_samples);
        write_sample_file(
            &output.join(policy).join("policy.json"),
            &serde_json::to_vec_pretty(summary)?,
        )?;
    }
    let passed = samples
        .iter()
        .filter(|sample| sample["status"] == "passed")
        .count();
    let summary = json!({"schemaVersion":1,"kind":"reader-rendering-diagnostic",
        "productionAcceptance":false,"configurationProperty":"suppressesIncrementalRendering",
        "configurationForced":true,"readbackScope":"WKWebView.configuration",
        "status":if complete && passed == expected_samples {"passed"} else {"failed"},
        "expectedPairs":READER_RENDERING_PAIRS,"expectedSamples":expected_samples,"mode":"warm-view",
        "completedSamples":samples.len(),"passedSamples":passed,"failedSamples":samples.len()-passed,
        "wholeProcessDeadlineMs":30_000,"textCharacters":180_000,"columnWidthPx":1,
        "complete":complete,"policies":policies,"samples":samples});
    write_sample_file(
        &output.join("diagnostic.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader rendering diagnostic completed: {passed}/{expected_samples} passed; complete={complete}; productionAcceptance=false; {}",
        output.display()
    );
    check(
        complete && passed == expected_samples,
        "Reader rendering diagnostic failed; all attempted control samples and logs retained.",
    )
}

fn read_ownership_preflight_report(path: &Path, reader_pid: u32) -> Result<Value> {
    check(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "Ownership report must be a regular file.",
    )?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    check(
        bytes.len() <= 128 * 1024,
        "Ownership report exceeded its size limit.",
    )?;
    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Report {
        schema_version: u32,
        kind: String,
        reader_pid: u32,
        production_acceptance: bool,
        attachment_attempted: bool,
        status: String,
        ownership_status: String,
        reason: String,
        elapsed_ms: f64,
        #[serde(flatten)]
        evidence: serde_json::Map<String, Value>,
    }
    let report: Report = serde_json::from_slice(&bytes)?;
    check(
        report.schema_version == 1
            && report.kind == "reader-ownership-preflight"
            && report.reader_pid > 0
            && report.reader_pid == reader_pid
            && !report.production_acceptance
            && !report.attachment_attempted
            && report.ownership_status == "unresolved"
            && matches!(
                report.status.as_str(),
                "completed" | "budget-exhausted" | "metadata-unavailable"
            )
            && matches!(
                report.reason.as_str(),
                "preflight-observed"
                    | "unsupported-platform"
                    | "reader-metadata-unavailable"
                    | "reader-identity-changed"
                    | "no-canonical-webcontent-candidate"
                    | "candidate-limit"
                    | "budget-exhausted"
                    | "tool-metadata-unavailable"
            )
            && report.elapsed_ms.is_finite()
            && report.elapsed_ms >= 0.0
            && report.elapsed_ms <= 8_000.0
            && report.evidence.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "tools"
                        | "platform"
                        | "webKit"
                        | "reader"
                        | "candidates"
                        | "candidateCount"
                        | "candidatesTruncated"
                )
            }),
        "Ownership report does not match the metadata-only preflight contract.",
    )?;
    serde_json::to_value(report).map_err(Into::into)
}

fn save_reader_ownership_probe(probe: &mut ReaderOwnershipProbe) -> Result<Value> {
    probe.finish();
    let mut errors = Vec::new();
    let (parent, stdout, stderr) = match probe.result.take() {
        Some(Ok(process)) => {
            if process.outcome != "exited" || !process.capture_complete {
                errors.push(format!("probe:{}", process.outcome));
            }
            (
                json!({"outcome":process.outcome,"elapsedMs":process.elapsed_ms,"exitCode":process.exit_code,
                "captureComplete":process.capture_complete,"stdoutTruncated":process.stdout_truncated,
                "stderrTruncated":process.stderr_truncated}),
                process.stdout,
                process.stderr,
            )
        }
        Some(Err(error)) => {
            errors.push(format!("probe startup: {error}"));
            (json!({"outcome":"setup-failed"}), Vec::new(), Vec::new())
        }
        None => {
            errors.push("probe: adversarial loading trigger was not observed".to_owned());
            (json!({"outcome":"not-started"}), Vec::new(), Vec::new())
        }
    };
    write_sample_file(&probe.directory.join("stdout.log"), &stdout)?;
    write_sample_file(&probe.directory.join("stderr.log"), &stderr)?;
    let report = match probe.reader_pid {
        Some(reader_pid) => match read_ownership_preflight_report(
            &probe.directory.join("ownership.json"),
            reader_pid,
        ) {
            Ok(report) => {
                if report["status"] != "completed" {
                    errors.push("probe: metadata observation incomplete".to_owned());
                }
                Some(report)
            }
            Err(error) => {
                errors.push(format!("probe report: {error}"));
                None
            }
        },
        None => {
            errors.push("probe: reader process was not started".to_owned());
            None
        }
    };
    let result = json!({"schemaVersion":1,"kind":"reader-ownership-preflight-observation",
        "productionAcceptance":false,"attachmentAttempted":false,"ownershipStatus":"unresolved",
        "environmentIsolated":true,"readerPid":probe.reader_pid,
        "status":if errors.is_empty() {"completed"} else {"failed"},"parent":parent,"report":report,"errors":errors});
    write_sample_file(
        &probe.directory.join("result.json"),
        &serde_json::to_vec_pretty(&result)?,
    )?;
    for (stream, bytes) in [("stdout", stdout), ("stderr", stderr)] {
        for line in String::from_utf8_lossy(&bytes).lines().take(40) {
            println!(
                "Reader ownership preflight {stream}: {}",
                line.chars().take(512).collect::<String>()
            );
        }
    }
    println!("Reader ownership preflight observation: {result}");
    Ok(result)
}

fn reader_ownership_preflight(root: &Path, output: &Path) -> Result<()> {
    check(
        output.is_absolute(),
        "Reader ownership preflight requires an absolute new output directory.",
    )?;
    fs::create_dir(output)?;
    let fixture = Fixture::new()?;
    let reader_directory = output.join("reader");
    let probe_directory = output.join("probe");
    fs::create_dir(&reader_directory)?;
    fs::create_dir(&probe_directory)?;
    let mut probe = ReaderOwnershipProbe::new(root, &probe_directory);
    let mut network_result = Err("Network sentinel was not started.".into());
    let process = (|| {
        let reader = compile_check(
            root,
            &fixture.0,
            "reader-checks",
            &[
                "-parse-as-library",
                "macos/Sources/MorrowMail/Models.swift",
                "macos/Sources/MorrowMail/MessageBodyView.swift",
                "macos/Checks/MessageHTML.swift",
            ],
        )?;
        let workspace = Fixture::new()?;
        let network = ReaderNetwork::start()?;
        let process = reader_sample_process_controlled(
            isolate_reader_preflight_environment(&mut command(root, reader))
                .arg(network.port.to_string())
                .args(["--adversarial", "warm-view"])
                .env("MORROW_DATA_DIR", &workspace.0),
            Duration::from_secs(30),
            READER_SAMPLE_LOG_LIMIT,
            None,
            Some(&mut probe),
        );
        probe.finish();
        network_result = network.finish();
        process
    })();
    let reader = save_reader_sample_with_diagnostic(
        &reader_directory,
        1,
        "warm-view",
        process,
        network_result,
        Some(ReaderDiagnostic::OwnershipPreflight),
    )?;
    let observation = save_reader_ownership_probe(&mut probe)?;
    let completed = reader["status"] == "passed" && observation["status"] == "completed";
    let summary = json!({"schemaVersion":1,"kind":"reader-ownership-preflight-run",
        "productionAcceptance":false,"attachmentAttempted":false,"ownershipStatus":"unresolved",
        "environmentIsolated":true,"baselineEnvironmentEquivalent":false,
        "status":if completed {"completed"} else {"failed"},"reader":reader,"observation":observation,
        "wholeReaderDeadlineMs":30_000,"wholeProbeDeadlineMs":8_000,"mode":"warm-view",
        "textCharacters":180_000,"columnWidthPx":1});
    write_sample_file(
        &output.join("preflight.json"),
        &serde_json::to_vec_pretty(&summary)?,
    )?;
    println!(
        "Reader ownership preflight completed: completed={completed}; ownershipStatus=unresolved; productionAcceptance=false; {}",
        output.display()
    );
    check(
        completed,
        "Reader ownership preflight incomplete; reader and metadata findings retained separately.",
    )
}

fn existing_native_checks(root: &Path, fixture: &Path) -> Result<()> {
    let workspace = fixture.join("auxiliary-workspace");
    let models = compile_check(
        root,
        fixture,
        "models-checks",
        &[
            "macos/Sources/MorrowMail/Models.swift",
            "macos/Sources/MorrowMail/FolderPicker.swift",
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

    let mut sources: Vec<_> = fs::read_dir(root.join("macos/Sources/MorrowMail"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<_>>()?;
    sources.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "swift")
    });
    sources.sort();
    let mut arguments = vec![
        "-D".to_string(),
        "MORROW_WINDOW_CHECKS".to_string(),
        "-parse-as-library".to_string(),
    ];
    arguments.extend(
        sources
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
    arguments.push("macos/Checks/WindowAssertions.swift".to_string());
    let window = compile_check(
        root,
        fixture,
        "window-checks",
        &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
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
            "grantedScopes":"https://www.googleapis.com/auth/gmail.modify",
            "accessToken":ACCESS, "refreshToken":REFRESH, "expiresAt":4_102_444_800_000_i64}),
        );
    }
    // Local-only message IDs keep native UI checks offline; provider writes use TLS fixtures in mail_service tests.
    let baseline = DateTime::parse_from_rfc3339("2026-09-25T00:00:00.000Z")?;
    let catalogs = ACCOUNTS.iter().map(|owner| {
        let mail = &connections[*owner];
        ((*owner).to_owned(), json!({"connection":[mail["connectionId"],mail["authorizationId"],mail["provider"],mail["email"],mail["clientId"],mail["imapHost"],mail["imapPort"]],
            "provider":"google","folders":[{"id":"native-label","name":format!("Projects/中文/{owner}"),"kind":"label","editable":true}],
            "updatedAt":"2026-09-25T00:00:00.000Z","nextRetryAt":"2099-01-01T00:00:00.000Z","blocked":false}))
    }).collect::<serde_json::Map<_, _>>();
    store.transaction(|db| {
        db.set_settings(&json!({"mailAccounts":connections, "mail":connections[ACCOUNTS[0]],
            "mailFolderCatalogs":catalogs,
            "activeAccount":"demo", "preferences":{"syncInterval":0,"markReadOnOpen":true,"sort":"newest"},
            "ai":null, "policy":{"enabled":false}, "calendars":{}, "imports":{}, "smartSearch":{"enabled":false}}))?;
        for email in ACCOUNTS {
            for index in 0..65 {
                db.upsert(email, &json!({
                    "id":if index == 0 { "fixture:shared".to_owned() } else { format!("fixture:message-{index:03}") },
                    "fromName":format!("Sender {}", index % 7), "fromEmail":format!("sender{}@example.invalid", index % 7),
                    "to":email, "subject":format!("Thread {}", 64 - index), "preview":format!("Cached fixture {index}"),
                    "body":format!("Owned by {email}: fixture {index}. ").repeat(100),
                    "date":(baseline - chrono::Duration::minutes(index)).to_rfc3339_opts(SecondsFormat::Millis, true),
                    "folder":"inbox", "category":"primary", "hasAttachments":false, "read":index % 3 != 0,
                    "starred":index > 0 && index % 9 == 0, "labels":[],
                    "footer":{"text":"Fixture footer excluded from list metadata", "html":""}
                }))?;
            }
        }
        db.upsert(ACCOUNTS[0], &json!({"id":"fixture:provider-draft", "folder":"drafts", "providerDraft":true, "hasAttachments":false,
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
            .get(owner, "fixture:shared")?
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
            store.get(ACCOUNTS[0], "fixture:shared")?.unwrap()["starred"] == true
                && store.get(ACCOUNTS[1], "fixture:shared")?.unwrap()["starred"] == false,
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
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing repository root.")?;
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-adversarial-batch"
    {
        return reader_adversarial_batch(root, Path::new(path));
    }
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-wrap-diagnostic"
    {
        return reader_wrap_diagnostic(root, Path::new(path));
    }
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-visibility-diagnostic"
    {
        return reader_visibility_diagnostic(root, Path::new(path));
    }
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-ownership-preflight"
    {
        return reader_ownership_preflight(root, Path::new(path));
    }
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-structure-diagnostic"
    {
        return reader_structure_diagnostic(root, Path::new(path));
    }
    if let [flag, path] = arguments.as_slice()
        && flag == "--reader-rendering-diagnostic"
    {
        return reader_rendering_diagnostic(root, Path::new(path));
    }
    let existing = match arguments.as_slice() {
        [] => None,
        [flag, path] if flag == "--service" && Path::new(path).is_absolute() => {
            Some(Path::new(path))
        }
        _ => {
            return Err("Usage: morrow-native-check [--service ABSOLUTE_PRODUCTION_BINARY | --reader-adversarial-batch ABSOLUTE_NEW_DIRECTORY | --reader-wrap-diagnostic ABSOLUTE_NEW_DIRECTORY | --reader-visibility-diagnostic ABSOLUTE_NEW_DIRECTORY | --reader-ownership-preflight ABSOLUTE_NEW_DIRECTORY | --reader-structure-diagnostic ABSOLUTE_NEW_DIRECTORY | --reader-rendering-diagnostic ABSOLUTE_NEW_DIRECTORY]".into());
        }
    };
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
    // Exercise the actual SwiftUI sheet/window/delegate quit path. Only the
    // install-ready response is fictional; never prepare an owner's update.
    let model_source = fs::read_to_string(root.join("macos/Sources/MorrowMail/AppModel.swift"))?;
    let injection = "config.timeoutIntervalForRequest = 65";
    check(
        model_source.matches(injection).count() == 1,
        "Update quit fixture transport injection changed.",
    )?;
    let fixture_model = fixture.0.join("UpdateRestartAppModel.swift");
    fs::write(
        &fixture_model,
        model_source.replacen(
            injection,
            &format!(
                "config.protocolClasses = [PreparedInstallerProtocol.self]\n        {injection}"
            ),
            1,
        ),
    )?;
    let quit_client = compile_check(
        root,
        &fixture.0,
        "Checks.app/Contents/MacOS/checks",
        &[
            "-D",
            "MORROW_WINDOW_CHECKS",
            "-parse-as-library",
            "macos/Sources/MorrowMail/Models.swift",
            fixture_model
                .to_str()
                .ok_or("Invalid fixture model path.")?,
            "macos/Sources/MorrowMail/MorrowMailApp.swift",
            "macos/Sources/MorrowMail/CalendarView.swift",
            "macos/Checks/UpdateRestartAssertions.swift",
        ],
    )?;
    let quit_result = fixture.0.join("quit-result.txt");
    print!(
        "{}",
        capture(
            command(root, quit_client)
                .current_dir(&fixture.0)
                .env("MORROW_DATA_DIR", fixture.0.join("update-quit-data"))
                .env("MORROW_QUIT_RESULT", &quit_result),
            30,
            1024 * 1024,
        )?
    );
    check(
        fs::read_to_string(quit_result)? == "Automatic update quit passed",
        "Update restart did not close its sheet/window and stop the service.",
    )?;
    println!(
        "Native update: prepared installer automatically quits with Settings open; no real installation."
    );
    let directory = fixture.0.join("data");
    seed(&directory)?;
    let key = fs::read(directory.join("encryption.key"))?;
    let client = contents.join("MacOS/checks");
    let mut sources: Vec<_> = fs::read_dir(root.join("macos/Sources/MorrowMail"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<_>>()?;
    sources.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "swift")
    });
    sources.sort();
    print!(
        "{}",
        capture(
            command(root, "swiftc")
                .args([
                    "-D",
                    "MORROW_WINDOW_CHECKS",
                    "-parse-as-library",
                    "-target",
                    "arm64-apple-macosx13.5",
                ])
                .args(sources)
                .args(["macos/Checks/RustIntegration.swift", "-o"])
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
        "Native acceptance passed: existing Models, HTML reader/network-zero and WindowAssertions checks; production Rust service, unchanged Swift client, Rust→Rust encrypted persistence and online backup, lifecycle and account isolation. Fictional data only; Historical Node interoperability CI is retired; old-client upgrades are not exercised."
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

    fn reader_child_result(mode: &str) -> Value {
        json!({"schemaVersion":1,"kind":"reader-adversarial","mode":mode,"status":"passed",
            "textCharacters":180_000,"columnWidthPx":1,"processElapsedMs":12,
            "adversarialElapsedMs":10,"warmupElapsedMs":if mode == "warm-view" {json!(2)} else {Value::Null},
            "sameWebView":true,"error":null})
    }

    fn completed_reader_process(stdout: Vec<u8>) -> SampleProcess {
        SampleProcess {
            outcome: "exited",
            capture_complete: true,
            elapsed_ms: 15,
            exit_code: Some(0),
            stdout,
            stderr: b"Native macOS reader: retained fixture trace\n".to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    fn structure_trace(policy: &str) -> String {
        let depth = reader_structure_depth(policy).unwrap();
        format!(
            "Native macOS reader: trace phase=setup diagnostic-structure-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 wrapperDepth={depth} +0 ms\nNative macOS reader: trace phase=adversarial-text structure-adversarial-publish policy={policy} wrapperDepth={depth} +5 ms\nNative macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=690 viewportHeight=440 windowWidth=720 +5 ms\nNative macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +6 ms\n"
        )
    }

    #[test]
    fn reader_structure_requires_matching_policy_depth_and_actual_update_order() {
        let fixture = Fixture::new().unwrap();
        for (policy, _, depth) in READER_STRUCTURE_POLICIES {
            let trace = structure_trace(policy);
            assert!(reader_structure_control_observed(trace.as_bytes(), policy));
            assert_eq!(
                reader_structure_evidence(trace.as_bytes(), policy).unwrap()["wrapperDepth"],
                depth
            );
            let lines: Vec<_> = trace.lines().collect();
            for invalid in [
                trace.replace(policy, "other-policy"),
                trace.replace(&format!("wrapperDepth={depth}"), "wrapperDepth=1"),
                trace.replace("180000", "18000"),
                trace.replace("columnWidthPx=1", "columnWidthPx=2"),
                trace.replace(
                    "diagnostic-structure-control",
                    "diagnostic-wrapping-control",
                ),
                trace.replace("+6 ms", "+4 ms"),
                format!("{}\n{}\n{}\n{}\n", lines[0], lines[2], lines[1], lines[3]),
                format!("{}\n{}\n{}\n{}\n", lines[0], lines[1], lines[3], lines[2]),
                format!("{}\n{}\n{}\n", lines[0], lines[2], lines[3]),
                format!("{trace}{}\n", lines[0]),
                format!("{trace}{}\n", lines[2]),
            ] {
                assert!(reader_structure_evidence(invalid.as_bytes(), policy).is_err());
            }
            for mode in ["cold-view", "warm-view"] {
                let directory = fixture.0.join(format!("{policy}-{mode}"));
                fs::create_dir(&directory).unwrap();
                let mut process = completed_reader_process(
                    serde_json::to_vec(&reader_child_result(mode)).unwrap(),
                );
                process.stderr = trace.as_bytes().to_vec();
                let sample = save_reader_sample_with_diagnostic(
                    &directory,
                    1,
                    mode,
                    Ok(process),
                    Ok(()),
                    Some(ReaderDiagnostic::Structure(policy)),
                )
                .unwrap();
                assert_eq!(
                    sample["status"],
                    if mode == "warm-view" {
                        "passed"
                    } else {
                        "failed"
                    }
                );
                assert_eq!(sample["structureEvidence"]["wrapperDepth"], depth);
                assert_eq!(sample["productionAcceptance"], false);
            }
        }
    }

    #[test]
    fn reader_structure_retains_six_warm_pairs_without_other_diagnostic_evidence() {
        let fixture = Fixture::new().unwrap();
        for (policy, _, _) in READER_STRUCTURE_POLICIES {
            fs::create_dir(fixture.0.join(policy)).unwrap();
        }
        let mut samples = Vec::new();
        for index in 0..READER_STRUCTURE_PAIRS * READER_STRUCTURE_POLICIES.len() {
            let sequence = index + 1;
            let (policy, _, _) = READER_STRUCTURE_POLICIES[index % READER_STRUCTURE_POLICIES.len()];
            let directory = fixture
                .0
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            fs::create_dir(&directory).unwrap();
            let mut process = completed_reader_process(
                serde_json::to_vec(&reader_child_result("warm-view")).unwrap(),
            );
            process.stderr = structure_trace(policy).into_bytes();
            if index == 0 {
                process.outcome = "timeout";
            }
            samples.push(
                save_reader_sample_with_diagnostic(
                    &directory,
                    sequence,
                    "warm-view",
                    Ok(process),
                    Ok(()),
                    Some(ReaderDiagnostic::Structure(policy)),
                )
                .unwrap(),
            );
        }
        assert_eq!(samples.len(), 6);
        assert_eq!(samples[0]["status"], "failed");
        assert_eq!(samples[5]["status"], "passed");
        assert!(samples.iter().all(|sample| sample["mode"] == "warm-view"
            && sample["childResult"].as_object().unwrap().len() == 11));
        assert!(reader_structure_evidence_complete(&fixture.0, &samples));
        assert!(!reader_structure_evidence_complete(
            &fixture.0,
            &samples[..5]
        ));
        assert!(!reader_batch_evidence_complete(&fixture.0, &samples));
        assert!(!reader_series_evidence_complete(
            &fixture.0, &samples, 6, None
        ));
        assert!(!reader_series_evidence_complete(
            &fixture.0,
            &samples,
            6,
            Some("break-word")
        ));
        assert!(!reader_visibility_evidence_complete(&fixture.0, &samples));
        let first_result = fixture
            .0
            .join("baseline-structure/sample-01-warm-view/result.json");
        for (field, invalid) in [
            ("mode", json!("cold-view")),
            ("pair", json!(2)),
            ("wrapperDepth", json!(2)),
            ("diagnosticPolicy", json!("nested-inline")),
            ("kind", json!("reader-wrap-diagnostic-sample")),
            ("kind", json!("reader-visibility-diagnostic-sample")),
            ("kind", json!("reader-adversarial-sample")),
        ] {
            let original = samples[0][field].clone();
            samples[0][field] = invalid;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
            assert!(!reader_structure_evidence_complete(&fixture.0, &samples));
            samples[0][field] = original;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
        }
        assert!(reader_structure_evidence_complete(&fixture.0, &samples));
        fs::remove_file(
            fixture
                .0
                .join("nested-inline/sample-06-warm-view/stderr.log"),
        )
        .unwrap();
        assert!(!reader_structure_evidence_complete(&fixture.0, &samples));
        assert!(reader_structure_diagnostic(&fixture.0, &fixture.0).is_err());
        assert!(reader_structure_diagnostic(&fixture.0, Path::new("relative-output")).is_err());
    }

    fn rendering_trace(policy: &str) -> String {
        let setting = reader_rendering_setting(policy).unwrap();
        format!(
            "Native macOS reader: trace phase=setup diagnostic-rendering-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 requestedSuppressesIncrementalRendering={setting} +0 ms\n\
Native macOS reader: trace phase=initial-load rendering-configuration policy={policy} stage=first-view-discovered suppressesIncrementalRendering={setting} sameWebView=true +1 ms\n\
Native macOS reader: trace phase=adversarial-text rendering-configuration policy={policy} stage=before-adversarial suppressesIncrementalRendering={setting} sameWebView=true +5 ms\n\
Native macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=690 viewportHeight=440 windowWidth=720 +5 ms\n\
Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +6 ms\n\
Native macOS reader: trace phase=adversarial-text marker-wait-end marker=Bounded adversarial tail polls=100 durationMs=1000 width=690 height=440 +10 ms\n\
Native macOS reader: trace phase=adversarial-text rendering-configuration policy={policy} stage=after-adversarial-marker suppressesIncrementalRendering={setting} sameWebView=true +10 ms\n"
        )
    }

    #[test]
    fn reader_rendering_requires_three_actual_readbacks_bracketing_update_and_marker() {
        let fixture = Fixture::new().unwrap();
        for (policy, _, setting) in READER_RENDERING_POLICIES {
            let trace = rendering_trace(policy);
            assert!(reader_rendering_control_observed(trace.as_bytes(), policy));
            let evidence = reader_rendering_evidence(trace.as_bytes(), policy).unwrap();
            assert_eq!(evidence["requestedConfig"], setting);
            assert_eq!(evidence["configurationForced"], true);
            assert_eq!(evidence["readbackScope"], "WKWebView.configuration");
            assert_eq!(evidence["actualConfigurationMatchesRequested"], true);
            assert_eq!(evidence["sameWebView"], true);
            assert_eq!(evidence["readbacks"].as_array().unwrap().len(), 3);
            let lines: Vec<_> = trace.lines().collect();
            for invalid in [
                trace.replace(policy, "other-policy"),
                trace.replace(
                    &format!("requestedSuppressesIncrementalRendering={setting}"),
                    &format!("requestedSuppressesIncrementalRendering={}", !setting),
                ),
                trace.replace("180000", "18000"),
                trace.replace("columnWidthPx=1", "columnWidthPx=2"),
                trace.replace(
                    "diagnostic-rendering-control",
                    "diagnostic-structure-control",
                ),
                trace.replace(
                    "phase=initial-load rendering-configuration",
                    "phase=focused-warmup rendering-configuration",
                ),
                trace.replace("+6 ms", "+4 ms"),
                trace.replace("marker=Bounded adversarial tail", "marker=Ordinary warmup"),
                trace.replace("sameWebView=true", "sameWebView=unknown"),
                format!("{trace}{}\n", lines[0]),
                format!("{trace}{}\n", lines[1]),
                format!("{trace}{}\n", lines[3]),
                format!("{trace}{}\n", lines[5]),
                lines
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| *index != 1)
                    .map(|(_, line)| format!("{line}\n"))
                    .collect::<String>(),
                [0, 1, 3, 2, 4, 5, 6].map(|index| lines[index]).join("\n"),
                [0, 1, 2, 4, 3, 5, 6].map(|index| lines[index]).join("\n"),
                [0, 1, 2, 3, 4, 6, 5].map(|index| lines[index]).join("\n"),
            ] {
                assert!(reader_rendering_evidence(invalid.as_bytes(), policy).is_err());
            }
            for (index, stage) in [
                "first-view-discovered",
                "before-adversarial",
                "after-adversarial-marker",
            ]
            .iter()
            .enumerate()
            {
                for (changed_field, changed_value, evidence_field) in [
                    (
                        "suppressesIncrementalRendering",
                        (!setting).to_string(),
                        "actualConfigurationMatchesRequested",
                    ),
                    ("sameWebView", "false".to_owned(), "sameWebView"),
                ] {
                    let mut changed_lines = lines
                        .iter()
                        .map(|line| (*line).to_owned())
                        .collect::<Vec<_>>();
                    let line = changed_lines
                        .iter_mut()
                        .find(|line| line.contains(&format!("stage={stage} ")))
                        .unwrap();
                    let original_value = if changed_field == "sameWebView" {
                        true
                    } else {
                        setting
                    };
                    *line = line.replace(
                        &format!("{changed_field}={original_value}"),
                        &format!("{changed_field}={changed_value}"),
                    );
                    let changed_trace = changed_lines.join("\n");
                    let evidence =
                        reader_rendering_evidence(changed_trace.as_bytes(), policy).unwrap();
                    assert_eq!(evidence[evidence_field], false);
                    let directory = fixture.0.join(format!("{policy}-{index}-{changed_field}"));
                    fs::create_dir(&directory).unwrap();
                    let mut process = completed_reader_process(
                        serde_json::to_vec(&reader_child_result("warm-view")).unwrap(),
                    );
                    process.stderr = changed_trace.into_bytes();
                    let sample = save_reader_sample_with_diagnostic(
                        &directory,
                        1,
                        "warm-view",
                        Ok(process),
                        Ok(()),
                        Some(ReaderDiagnostic::Rendering(policy)),
                    )
                    .unwrap();
                    assert_eq!(sample["status"], "failed");
                    assert_eq!(sample["renderingEvidence"], evidence);
                }
            }
            for mode in ["cold-view", "warm-view"] {
                let directory = fixture.0.join(format!("{policy}-{mode}"));
                fs::create_dir(&directory).unwrap();
                let mut process = completed_reader_process(
                    serde_json::to_vec(&reader_child_result(mode)).unwrap(),
                );
                process.stderr = trace.as_bytes().to_vec();
                let sample = save_reader_sample_with_diagnostic(
                    &directory,
                    1,
                    mode,
                    Ok(process),
                    Ok(()),
                    Some(ReaderDiagnostic::Rendering(policy)),
                )
                .unwrap();
                assert_eq!(
                    sample["status"],
                    if mode == "warm-view" {
                        "passed"
                    } else {
                        "failed"
                    }
                );
                assert_eq!(sample["requestedConfig"], setting);
                assert_eq!(sample["productionAcceptance"], false);
            }
            assert!(reader_structure_evidence(trace.as_bytes(), "baseline-structure").is_err());
            assert!(reader_visibility_evidence(trace.as_bytes(), "baseline-presentation").is_err());
            assert!(!reader_diagnostic_policy_observed(
                trace.as_bytes(),
                "break-word"
            ));
            assert!(
                reader_rendering_evidence(structure_trace("baseline-structure").as_bytes(), policy)
                    .is_err()
            );
        }
    }

    #[test]
    fn reader_rendering_retains_six_forced_configuration_warm_pairs_as_separate_evidence() {
        let fixture = Fixture::new().unwrap();
        assert_eq!(READER_BATCH_SAMPLES, 40);
        assert_eq!(
            READER_RENDERING_POLICIES[0],
            (
                "baseline-rendering",
                "READER_DIAGNOSTIC_BASELINE_RENDERING",
                false
            )
        );
        assert_eq!(
            READER_RENDERING_POLICIES[1],
            (
                "suppressed-rendering",
                "READER_DIAGNOSTIC_SUPPRESSED_RENDERING",
                true
            )
        );
        for (policy, _, _) in READER_RENDERING_POLICIES {
            fs::create_dir(fixture.0.join(policy)).unwrap();
        }
        let mut samples = Vec::new();
        for index in 0..READER_RENDERING_PAIRS * READER_RENDERING_POLICIES.len() {
            let sequence = index + 1;
            let (policy, _, _) = READER_RENDERING_POLICIES[index % READER_RENDERING_POLICIES.len()];
            let directory = fixture
                .0
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            fs::create_dir(&directory).unwrap();
            let mut process = completed_reader_process(
                serde_json::to_vec(&reader_child_result("warm-view")).unwrap(),
            );
            process.stderr = rendering_trace(policy).into_bytes();
            if index == 0 {
                process.outcome = "timeout";
            }
            samples.push(
                save_reader_sample_with_diagnostic(
                    &directory,
                    sequence,
                    "warm-view",
                    Ok(process),
                    Ok(()),
                    Some(ReaderDiagnostic::Rendering(policy)),
                )
                .unwrap(),
            );
        }
        assert_eq!(samples.len(), 6);
        assert_eq!(samples[0]["status"], "failed");
        assert_eq!(samples[0]["parent"]["outcome"], "timeout");
        assert_eq!(samples[5]["status"], "passed");
        assert!(samples.iter().all(|sample| sample["mode"] == "warm-view"
            && sample["childResult"].as_object().unwrap().len() == 11));
        assert!(reader_rendering_evidence_complete(&fixture.0, &samples));
        assert!(!reader_rendering_evidence_complete(
            &fixture.0,
            &samples[..5]
        ));
        assert!(!reader_batch_evidence_complete(&fixture.0, &samples));
        assert!(!reader_series_evidence_complete(
            &fixture.0, &samples, 6, None
        ));
        assert!(!reader_series_evidence_complete(
            &fixture.0,
            &samples,
            6,
            Some("break-word")
        ));
        assert!(!reader_visibility_evidence_complete(&fixture.0, &samples));
        assert!(!reader_structure_evidence_complete(&fixture.0, &samples));
        let first_result = fixture
            .0
            .join("baseline-rendering/sample-01-warm-view/result.json");
        for (field, invalid) in [
            ("mode", json!("cold-view")),
            ("pair", json!(2)),
            ("requestedConfig", json!(true)),
            ("configurationForced", json!(false)),
            ("readbackScope", json!("live-renderer-state")),
            ("diagnosticPolicy", json!("suppressed-rendering")),
            ("productionAcceptance", json!(true)),
            ("kind", json!("reader-wrap-diagnostic-sample")),
            ("kind", json!("reader-visibility-diagnostic-sample")),
            ("kind", json!("reader-structure-diagnostic-sample")),
            ("kind", json!("reader-adversarial-sample")),
        ] {
            let original = samples[0][field].clone();
            samples[0][field] = invalid;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
            assert!(!reader_rendering_evidence_complete(&fixture.0, &samples));
            samples[0][field] = original;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
        }
        assert!(reader_rendering_evidence_complete(&fixture.0, &samples));
        fs::remove_file(
            fixture
                .0
                .join("suppressed-rendering/sample-06-warm-view/stderr.log"),
        )
        .unwrap();
        assert!(!reader_rendering_evidence_complete(&fixture.0, &samples));
        assert!(reader_rendering_diagnostic(&fixture.0, &fixture.0).is_err());
        assert!(reader_rendering_diagnostic(&fixture.0, Path::new("relative-output")).is_err());
    }

    #[test]
    fn reader_ownership_preflight_requires_bounded_metadata_only_report() {
        let fixture = Fixture::new().unwrap();
        let report_path = fixture.0.join("report.json");
        let valid = json!({"schemaVersion":1,"kind":"reader-ownership-preflight","readerPid":42,
            "productionAcceptance":false,"attachmentAttempted":false,"status":"completed",
            "ownershipStatus":"unresolved","reason":"preflight-observed","elapsedMs":1,
            "candidateCount":0,"candidates":[]});
        fs::write(&report_path, serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(
            read_ownership_preflight_report(&report_path, 42).unwrap()["ownershipStatus"],
            "unresolved"
        );
        for (field, wrong) in [
            ("readerPid", json!(43)),
            ("attachmentAttempted", json!(true)),
            ("productionAcceptance", json!(true)),
            ("ownershipStatus", json!("verified")),
            ("status", json!("passed")),
            ("elapsedMs", json!(8_001)),
            ("elapsedMs", json!(-1)),
            ("reason", json!("unvalidated-tool-output")),
            ("environment", json!("unapproved-field")),
        ] {
            let mut report = valid.clone();
            report[field] = wrong;
            fs::write(&report_path, serde_json::to_vec(&report).unwrap()).unwrap();
            assert!(read_ownership_preflight_report(&report_path, 42).is_err());
        }
        fs::write(
            &report_path,
            format!("{{\"attachmentAttempted\":true,{}", &valid.to_string()[1..]),
        )
        .unwrap();
        assert!(read_ownership_preflight_report(&report_path, 42).is_err());
        fs::write(&report_path, vec![b' '; 128 * 1024 + 1]).unwrap();
        assert!(read_ownership_preflight_report(&report_path, 42).is_err());
        assert!(read_ownership_preflight_report(&fixture.0, 42).is_err());
        assert!(reader_ownership_preflight(&fixture.0, &fixture.0).is_err());
        assert!(reader_ownership_preflight(&fixture.0, Path::new("relative-output")).is_err());
    }

    #[test]
    fn reader_ownership_trigger_and_environment_are_scoped() {
        let update = "Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +122 ms\n";
        let marker = "Native macOS reader: trace phase=adversarial-text marker-wait-begin marker=Bounded adversarial tail loading=true +123 ms\n";
        let trace = format!("{update}{marker}");
        assert!(reader_adversarial_loading_observed(trace.as_bytes()));
        assert!(!reader_adversarial_loading_observed(marker.as_bytes()));
        for invalid in [
            trace.replace("loading=true", "loading=false"),
            trace.replace("adversarial-text", "focused-warmup"),
            trace.replace("Bounded adversarial tail", "warmup marker"),
            trace.replace("123 ms", "unknown ms"),
        ] {
            assert!(!reader_adversarial_loading_observed(invalid.as_bytes()));
        }
        let mut child = Command::new("fixture");
        child.env("MORROW_PREFLIGHT_TEST_SECRET", "fictional-do-not-inherit");
        isolate_reader_preflight_environment(&mut child).env("MORROW_DATA_DIR", "/fixture-only");
        assert!(child.get_envs().all(|(key, _)| {
            key == "MORROW_DATA_DIR"
                || READER_PREFLIGHT_ENVIRONMENT
                    .iter()
                    .any(|allowed| key == *allowed)
        }));
        assert!(
            !child
                .get_envs()
                .any(|(key, _)| key == "MORROW_PREFLIGHT_TEST_SECRET")
        );
    }

    #[test]
    fn reader_ownership_trigger_handles_native_false_then_true_and_partial_frames() {
        // Native PR25 job 114241956649: SwiftUI has not started navigation at
        // marker-wait-begin (+1832); KVO reports real loading seven ms later.
        let before = concat!(
            "Native macOS reader: trace phase=initial-load navigation-loading reader=initial value=true +643 ms\n",
            "Native macOS reader: trace phase=focused-warmup marker-wait-begin marker=Focused reader warmup loading=true +645 ms\n",
            "Native macOS reader: trace phase=focused-warmup navigation-loading reader=initial value=false +1760 ms\n",
            "Native macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=705 viewportHeight=480 windowWidth=720 +1830 ms\n",
            "Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +1832 ms\n",
            "Native macOS reader: trace phase=adversarial-text marker-wait-begin marker=Bounded adversarial tail loading=false +1832 ms\n",
        );
        let loading = "Native macOS reader: trace phase=adversarial-text navigation-loading reader=initial value=true +1839 ms\n";
        let trace = format!("{before}{loading}");
        for length in 0..trace.len() {
            assert!(
                !reader_adversarial_loading_observed(&trace.as_bytes()[..length]),
                "Premature trigger at partial byte {length}"
            );
        }
        assert!(reader_adversarial_loading_observed(trace.as_bytes()));
        for invalid_loading in [
            loading.replace("reader=initial", "reader=replacement"),
            loading.replace("adversarial-text", "focused-warmup"),
            loading.replace("value=true", "value=false"),
            loading.replace("1839 ms", "1831 ms"),
            loading.replace("1839 ms", "incomplete"),
        ] {
            assert!(!reader_adversarial_loading_observed(
                format!("{before}{invalid_loading}").as_bytes()
            ));
        }
        assert!(!reader_adversarial_loading_observed(
            format!("{loading}{before}").as_bytes()
        ));
        let incomplete_update = before.replace(
            "+1832 ms\nNative macOS reader: trace phase=adversarial-text marker",
            "+1832 msNative macOS reader: trace phase=adversarial-text marker",
        );
        assert!(!reader_adversarial_loading_observed(
            format!("{incomplete_update}{loading}").as_bytes()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reader_ownership_probe_is_single_shot_and_cancelled_without_masking_reader() {
        let fixture = Fixture::new().unwrap();
        fs::create_dir(fixture.0.join("scripts")).unwrap();
        fs::write(
            fixture.0.join("scripts/probe-macos-reader-processes.py"),
            r#"import pathlib, sys, time
output = pathlib.Path(sys.argv[sys.argv.index('--output') + 1])
with output.with_name('started.txt').open('x') as started:
    started.write('one owned probe')
print('fixture metadata probe started', flush=True)
time.sleep(10)
"#,
        )
        .unwrap();
        let probe_directory = fixture.0.join("probe");
        fs::create_dir(&probe_directory).unwrap();
        let mut probe = ReaderOwnershipProbe::new(&fixture.0, &probe_directory);
        let script = "printf 'Native macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +1832 ms\\nNative macOS reader: trace phase=adversarial-text marker-wait-begin marker=Bounded adversarial tail loading=false +1832 ms\\nNative macOS reader: trace phase=adversarial-text navigation-loading reader=initial value=' >&2; sleep 0.05; printf 'true +1839 ms\\nNative macOS reader: trace phase=adversarial-text navigation-loading reader=initial value=true +1840 ms\\n' >&2; sleep 0.5; printf '%s\\n' \"$1\"";
        let process = reader_sample_process_controlled(
            command(&fixture.0, "/bin/sh").args([
                "-c",
                script,
                "fixture",
                &reader_child_result("warm-view").to_string(),
            ]),
            Duration::from_secs(2),
            4096,
            None,
            Some(&mut probe),
        )
        .unwrap();
        assert_eq!(process.outcome, "exited");
        assert!(
            process.elapsed_ms < 2_000,
            "Probe cancellation extended the reader gate"
        );
        assert!(probe.worker.is_none(), "Probe worker was not joined/reaped");
        assert_eq!(
            fs::read_to_string(probe_directory.join("started.txt")).unwrap(),
            "one owned probe"
        );
        let reader_directory = fixture.0.join("reader");
        fs::create_dir(&reader_directory).unwrap();
        let reader = save_reader_sample_with_diagnostic(
            &reader_directory,
            1,
            "warm-view",
            Ok(process),
            Ok(()),
            Some(ReaderDiagnostic::OwnershipPreflight),
        )
        .unwrap();
        let observation = save_reader_ownership_probe(&mut probe).unwrap();
        assert_eq!(reader["status"], "passed");
        assert_eq!(reader["environmentIsolated"], true);
        assert_eq!(observation["status"], "failed");
        assert_eq!(observation["parent"]["outcome"], "cancelled");
        assert_eq!(observation["ownershipStatus"], "unresolved");
        assert!(
            !fs::read(probe_directory.join("stdout.log"))
                .unwrap()
                .is_empty()
        );
    }

    fn visibility_trace(policy: &str, foreground_ready: bool) -> String {
        let active = if foreground_ready { "true" } else { "false" };
        format!(
            "Native macOS reader: trace phase=setup diagnostic-visibility-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 +0 ms\nNative macOS reader: trace phase=focused-warmup visibility-state policy={policy} stage=before-adversarial attached=true hidden=false positiveBounds=true appActive={active} windowKey={active} windowVisible=true occlusionVisible={active} sameWebView=true +5 ms\nNative macOS reader: trace phase=adversarial-text visibility-adversarial-publish policy={policy} +6 ms\nNative macOS reader: trace phase=adversarial-text fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=690 viewportHeight=440 windowWidth=720 +6 ms\nNative macOS reader: trace phase=adversarial-text fixture-update-request end; SwiftUI navigation/layout may still be pending +7 ms\n"
        )
    }

    #[test]
    fn reader_visibility_requires_ordered_exact_state_and_foreground_readiness() {
        let fixture = Fixture::new().unwrap();
        let foreground = visibility_trace("foreground-prepared", true);
        let background = visibility_trace("baseline-presentation", false);
        let evidence =
            reader_visibility_evidence(background.as_bytes(), "baseline-presentation").unwrap();
        assert_eq!(evidence["windowVisible"], true);
        assert_eq!(evidence["appActive"], false);
        assert_eq!(evidence["foregroundReady"], false);
        assert_eq!(
            reader_visibility_evidence(foreground.as_bytes(), "foreground-prepared").unwrap()["foregroundReady"],
            true
        );
        let lines: Vec<_> = foreground.lines().collect();
        for invalid in [
            foreground.replace("foreground-prepared", "baseline-presentation"),
            foreground.replace(
                "diagnostic-visibility-control",
                "diagnostic-wrapping-control",
            ),
            foreground.replace("windowKey=true", "windowKey=unknown"),
            foreground.replace("+6 ms", "+4 ms"),
            format!("{}\n{}\n{}\n", lines[0], lines[2], lines[1]),
            format!(
                "{}\n{}\n{}\n{}\n{}\n",
                lines[0], lines[3], lines[1], lines[2], lines[4]
            ),
            format!(
                "{}\n{}\n{}\n{}\n{}\n",
                lines[0], lines[1], lines[2], lines[4], lines[3]
            ),
            format!("{foreground}{}\n", lines[1]),
            format!("{}\n{}\n", lines[0], lines[2]),
        ] {
            assert!(reader_visibility_evidence(invalid.as_bytes(), "foreground-prepared").is_err());
        }
        for (index, (policy, trace, mode, expected)) in [
            (
                "foreground-prepared",
                foreground.clone(),
                "warm-view",
                "passed",
            ),
            ("baseline-presentation", background, "warm-view", "passed"),
            (
                "foreground-prepared",
                visibility_trace("foreground-prepared", false),
                "warm-view",
                "failed",
            ),
            (
                "foreground-prepared",
                foreground.clone(),
                "cold-view",
                "failed",
            ),
            (
                "foreground-prepared",
                foreground.replace("sameWebView=true", "sameWebView=false"),
                "warm-view",
                "failed",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let directory = fixture.0.join(format!("sample-{index}"));
            fs::create_dir(&directory).unwrap();
            let mut process =
                completed_reader_process(serde_json::to_vec(&reader_child_result(mode)).unwrap());
            process.stderr = trace.into_bytes();
            let record = save_reader_sample_with_diagnostic(
                &directory,
                1,
                mode,
                Ok(process),
                Ok(()),
                Some(ReaderDiagnostic::Visibility(policy)),
            )
            .unwrap();
            assert_eq!(record["status"], expected);
            assert!(
                record["visibilityEvidence"].is_object(),
                "Keep observed flags even for failed preparation"
            );
            assert_eq!(record["productionAcceptance"], false);
        }
    }

    #[test]
    fn reader_visibility_retains_six_warm_pairs_and_rejects_other_evidence_families() {
        let fixture = Fixture::new().unwrap();
        for (policy, _) in READER_VISIBILITY_POLICIES {
            fs::create_dir(fixture.0.join(policy)).unwrap();
        }
        let mut samples = Vec::new();
        for index in 0..READER_VISIBILITY_PAIRS * READER_VISIBILITY_POLICIES.len() {
            let sequence = index + 1;
            let (policy, _) = READER_VISIBILITY_POLICIES[index % READER_VISIBILITY_POLICIES.len()];
            let directory = fixture
                .0
                .join(policy)
                .join(format!("sample-{sequence:02}-warm-view"));
            fs::create_dir(&directory).unwrap();
            let mut process = completed_reader_process(
                serde_json::to_vec(&reader_child_result("warm-view")).unwrap(),
            );
            process.stderr = visibility_trace(policy, policy == "foreground-prepared").into_bytes();
            if index == 0 {
                process.outcome = "timeout";
            }
            samples.push(
                save_reader_sample_with_diagnostic(
                    &directory,
                    sequence,
                    "warm-view",
                    Ok(process),
                    Ok(()),
                    Some(ReaderDiagnostic::Visibility(policy)),
                )
                .unwrap(),
            );
        }
        assert_eq!(samples.len(), 6);
        assert_eq!(samples[0]["status"], "failed");
        assert_eq!(samples[5]["status"], "passed");
        assert!(samples.iter().all(|sample| sample["mode"] == "warm-view"));
        assert!(reader_visibility_evidence_complete(&fixture.0, &samples));
        assert!(!reader_visibility_evidence_complete(
            &fixture.0,
            &samples[..5]
        ));
        assert!(!reader_batch_evidence_complete(&fixture.0, &samples));
        assert!(!reader_series_evidence_complete(
            &fixture.0,
            &samples,
            6,
            Some("break-word")
        ));
        let first_result = fixture
            .0
            .join("baseline-presentation/sample-01-warm-view/result.json");
        for (field, invalid) in [
            ("mode", json!("cold-view")),
            ("pair", json!(2)),
            ("diagnosticPolicy", json!("foreground-prepared")),
            ("kind", json!("reader-wrap-diagnostic-sample")),
            ("kind", json!("reader-adversarial-sample")),
        ] {
            let original = samples[0][field].clone();
            samples[0][field] = invalid;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
            assert!(!reader_visibility_evidence_complete(&fixture.0, &samples));
            samples[0][field] = original;
            fs::write(&first_result, serde_json::to_vec(&samples[0]).unwrap()).unwrap();
        }
        assert!(reader_visibility_evidence_complete(&fixture.0, &samples));
        fs::remove_file(
            fixture
                .0
                .join("foreground-prepared/sample-06-warm-view/stderr.log"),
        )
        .unwrap();
        assert!(!reader_visibility_evidence_complete(&fixture.0, &samples));
        assert!(reader_visibility_diagnostic(&fixture.0, &fixture.0).is_err());
        assert!(reader_visibility_diagnostic(&fixture.0, Path::new("relative-output")).is_err());
    }

    #[test]
    fn reader_wrap_diagnostic_requires_unambiguous_compiled_policy_trace() {
        let fixture = Fixture::new().unwrap();
        let marker = "Native macOS reader: trace phase=setup diagnostic-wrapping-control policy=break-word acceptance=false textCharacters=180000 columnWidthPx=1 +0 ms\n";
        let cases = [
            (marker.to_owned(), true),
            (String::new(), false),
            (marker.replace("break-word", "normal"), false),
            (marker.replace("acceptance=false", "acceptance=true"), false),
            (marker.replace("180000", "18000"), false),
            (format!("{marker}{marker}"), false),
            (
                format!("{marker}{}", marker.replace("break-word", "normal")),
                false,
            ),
        ];
        for (index, (stderr, observed)) in cases.into_iter().enumerate() {
            let directory = fixture.0.join(format!("sample-{index}"));
            fs::create_dir(&directory).unwrap();
            let mut process = completed_reader_process(
                serde_json::to_vec(&reader_child_result("cold-view")).unwrap(),
            );
            process.stderr = stderr.into_bytes();
            let result = save_reader_sample_with_policy(
                &directory,
                1,
                "cold-view",
                Ok(process),
                Ok(()),
                Some("break-word"),
            )
            .unwrap();
            assert_eq!(result["diagnosticPolicyObserved"], observed);
            assert_eq!(result["status"], if observed { "passed" } else { "failed" });
            assert_eq!(result["productionAcceptance"], false);
        }
    }

    #[test]
    fn reader_wrap_diagnostic_retains_twelve_controls_without_baseline_contamination() {
        let fixture = Fixture::new().unwrap();
        let mut records = 0;
        let mut terminal_lines = format!("{} result: baseline\n", reader_sample_prefix(1, None));
        for (policy, _) in READER_WRAP_POLICIES {
            let directory = fixture.0.join(policy);
            fs::create_dir(&directory).unwrap();
            let mut samples = Vec::new();
            for index in 0..READER_WRAP_SAMPLES_PER_POLICY {
                let sequence = index + 1;
                let mode = if index % 2 == 0 {
                    "cold-view"
                } else {
                    "warm-view"
                };
                let sample_directory = directory.join(format!("sample-{sequence:02}-{mode}"));
                fs::create_dir(&sample_directory).unwrap();
                let mut process = completed_reader_process(
                    serde_json::to_vec(&reader_child_result(mode)).unwrap(),
                );
                process.stderr = format!("Native macOS reader: trace phase=setup diagnostic-wrapping-control policy={policy} acceptance=false textCharacters=180000 columnWidthPx=1 +1 ms\n").into_bytes();
                if index == 0 {
                    process.outcome = "timeout";
                }
                let result = save_reader_sample_with_policy(
                    &sample_directory,
                    sequence,
                    mode,
                    Ok(process),
                    Ok(()),
                    Some(policy),
                )
                .unwrap();
                assert_eq!(result["kind"], "reader-wrap-diagnostic-sample");
                assert_eq!(result["diagnosticPolicy"], policy);
                assert_eq!(result["childResult"].as_object().unwrap().len(), 11);
                samples.push(result);
                records += 1;
                terminal_lines.push_str(&format!(
                    "{} result: control\n",
                    reader_sample_prefix(sequence, Some(policy))
                ));
            }
            assert_eq!(samples[0]["status"], "failed");
            assert_eq!(samples.last().unwrap()["status"], "passed");
            assert!(reader_series_evidence_complete(
                &directory,
                &samples,
                READER_WRAP_SAMPLES_PER_POLICY,
                Some(policy)
            ));
            assert!(!reader_series_evidence_complete(
                &directory,
                &samples,
                READER_WRAP_SAMPLES_PER_POLICY,
                Some("other-policy")
            ));
            assert!(!reader_series_evidence_complete(
                &directory,
                &samples,
                READER_WRAP_SAMPLES_PER_POLICY,
                None
            ));
            assert!(!reader_batch_evidence_complete(&directory, &samples));
            samples[0]
                .as_object_mut()
                .unwrap()
                .remove("diagnosticPolicy");
            fs::write(
                directory.join("sample-01-cold-view/result.json"),
                serde_json::to_vec(&samples[0]).unwrap(),
            )
            .unwrap();
            assert!(!reader_series_evidence_complete(
                &directory,
                &samples,
                READER_WRAP_SAMPLES_PER_POLICY,
                Some(policy)
            ));
            samples[0]["diagnosticPolicy"] = json!(policy);
            fs::write(
                directory.join("sample-01-cold-view/result.json"),
                serde_json::to_vec(&samples[0]).unwrap(),
            )
            .unwrap();
            fs::remove_file(directory.join("sample-06-warm-view/stderr.log")).unwrap();
            assert!(!reader_series_evidence_complete(
                &directory,
                &samples,
                READER_WRAP_SAMPLES_PER_POLICY,
                Some(policy)
            ));
        }
        assert_eq!(records, 12);
        assert_eq!(
            terminal_lines
                .lines()
                .filter(|line| line.starts_with("Reader batch sample "))
                .count(),
            1
        );
        assert!(reader_wrap_diagnostic(&fixture.0, &fixture.0).is_err());
        assert!(reader_wrap_diagnostic(&fixture.0, Path::new("relative-output")).is_err());
    }

    #[test]
    fn reader_sample_retains_primary_failure_and_incomplete_capture_evidence() {
        let fixture = Fixture::new().unwrap();
        for outcome in ["timeout", "nonzero-exit", "capture-failed"] {
            let directory = fixture.0.join(outcome);
            fs::create_dir(&directory).unwrap();
            let mut process = completed_reader_process(
                serde_json::to_vec(&reader_child_result("cold-view")).unwrap(),
            );
            process.outcome = outcome;
            process.capture_complete = false;
            let record =
                save_reader_sample(&directory, 1, "cold-view", Ok(process), Ok(())).unwrap();
            assert_eq!(record["status"], "failed");
            assert_eq!(record["parent"]["outcome"], outcome);
            assert_eq!(record["parent"]["captureComplete"], false);
            let errors = record["errors"].as_array().unwrap();
            assert!(errors.contains(&json!(format!("parent:{outcome}"))));
            assert!(errors.contains(&json!("parent:capture-incomplete")));
            assert!(!fs::read(directory.join("stderr.log")).unwrap().is_empty());
        }
    }

    #[test]
    fn reader_sample_requires_exact_success_and_same_view_timing_evidence() {
        for mode in ["cold-view", "warm-view"] {
            let valid = reader_child_result(mode);
            validate_reader_sample(&serde_json::to_vec(&valid).unwrap(), mode).unwrap();
            for (field, value) in [
                ("schemaVersion", json!(2)),
                ("kind", json!("unrelated")),
                ("mode", json!("other-view")),
                ("status", json!("failed")),
                ("textCharacters", json!(179_999)),
                ("columnWidthPx", json!(2)),
                ("processElapsedMs", json!(-1)),
                ("processElapsedMs", json!("12")),
                ("adversarialElapsedMs", Value::Null),
                ("adversarialElapsedMs", json!(-1)),
                ("sameWebView", json!(false)),
                ("error", json!("fixture failure")),
            ] {
                let mut invalid = valid.clone();
                invalid[field] = value;
                assert!(
                    validate_reader_sample(&serde_json::to_vec(&invalid).unwrap(), mode).is_err(),
                    "accepted {field}: {invalid}"
                );
            }
            for field in valid.as_object().unwrap().keys() {
                let mut missing = valid.clone();
                missing.as_object_mut().unwrap().remove(field);
                assert!(
                    validate_reader_sample(&serde_json::to_vec(&missing).unwrap(), mode).is_err(),
                    "accepted missing {field}"
                );
            }
            let mut wrong_warmup = valid.clone();
            wrong_warmup["warmupElapsedMs"] = if mode == "cold-view" {
                json!(1)
            } else {
                Value::Null
            };
            assert!(
                validate_reader_sample(&serde_json::to_vec(&wrong_warmup).unwrap(), mode).is_err()
            );
            let mut unknown = valid.clone();
            unknown["extra"] = json!(true);
            assert!(validate_reader_sample(&serde_json::to_vec(&unknown).unwrap(), mode).is_err());
            let duplicate = format!("{{\"status\":\"failed\",{}", &valid.to_string()[1..]);
            assert!(validate_reader_sample(duplicate.as_bytes(), mode).is_err());
            let extra_line = format!("{valid}\n{valid}\n");
            assert!(validate_reader_sample(extra_line.as_bytes(), mode).is_err());
        }
        assert!(validate_reader_sample(b"", "cold-view").is_err());
        assert!(validate_reader_sample(b"{\"partial\":", "cold-view").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reader_sample_retains_nonzero_timeout_and_bounded_pipe_output() {
        let fixture = Fixture::new().unwrap();
        let child_result = reader_child_result("cold-view").to_string();
        let cases = [
            (
                "printf '%s\\n' \"$1\"; printf 'Native macOS reader: nonzero trace\\n' >&2; exit 7",
                Duration::from_secs(2),
                4096,
                "nonzero-exit",
            ),
            (
                "printf '%s\\n' \"$1\"; printf 'Native macOS reader: before stall\\n' >&2; sleep 10",
                Duration::from_millis(200),
                4096,
                "timeout",
            ),
            (
                "printf 'Native macOS reader: before overflow\\n' >&2; while :; do printf 'bounded-fixture-output-'; done",
                Duration::from_secs(2),
                512,
                "output-limit",
            ),
            (
                "printf '%s\\n' \"$1\"; while :; do printf 'bounded-fixture-error-' >&2; done",
                Duration::from_secs(2),
                512,
                "output-limit",
            ),
        ];
        for (index, (script, duration, limit, expected)) in cases.into_iter().enumerate() {
            let result = reader_sample_process(
                command(&fixture.0, "/bin/sh").args(["-c", script, "fixture", &child_result]),
                duration,
                limit,
            )
            .unwrap();
            assert_eq!(result.outcome, expected);
            assert!(
                result.elapsed_ms < 3_000,
                "cleanup exceeded bounded duration"
            );
            assert!(result.stdout.len() <= limit && result.stderr.len() <= limit);
            assert!(!result.stderr.is_empty(), "lost pre-failure stderr");
            let directory = fixture.0.join(format!("sample-{index}"));
            fs::create_dir(&directory).unwrap();
            let record =
                save_reader_sample(&directory, index + 1, "cold-view", Ok(result), Ok(())).unwrap();
            assert_eq!(record["status"], "failed");
            assert_eq!(record["parent"]["outcome"], expected);
            assert!(!fs::read(directory.join("stderr.log")).unwrap().is_empty());
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(directory.join("result.json")).unwrap())
                    .unwrap(),
                record
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn reader_sample_success_requires_parent_exit_and_valid_child_result() {
        let fixture = Fixture::new().unwrap();
        let valid = reader_child_result("warm-view").to_string();
        for (index, (output, expected)) in [
            (&*valid, "passed"),
            ("not a child JSON result", "failed"),
            ("", "failed"),
        ]
        .into_iter()
        .enumerate()
        {
            let process = reader_sample_process(
                command(&fixture.0, "/bin/sh").args([
                    "-c",
                    "printf '%s\\n' \"$1\"",
                    "fixture",
                    output,
                ]),
                Duration::from_secs(2),
                4096,
            )
            .unwrap();
            assert_eq!(process.outcome, "exited");
            assert_eq!(process.exit_code, Some(0));
            let directory = fixture.0.join(format!("sample-{index}"));
            fs::create_dir(&directory).unwrap();
            let record =
                save_reader_sample(&directory, index + 1, "warm-view", Ok(process), Ok(()))
                    .unwrap();
            assert_eq!(record["status"], expected);
        }
    }

    #[test]
    fn reader_sample_rejects_network_traffic_even_when_child_passes() {
        let fixture = Fixture::new().unwrap();
        let network = ReaderNetwork::start().unwrap();
        let client =
            std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, network.port)).unwrap();
        drop(client);
        let process = completed_reader_process(
            serde_json::to_vec(&reader_child_result("cold-view")).unwrap(),
        );
        let record =
            save_reader_sample(&fixture.0, 1, "cold-view", Ok(process), network.finish()).unwrap();
        assert_eq!(record["status"], "failed");
        assert_eq!(record["networkZero"], false);
        assert_eq!(record["childResult"]["status"], "passed");
        assert!(
            record["errors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| error.as_str().unwrap().starts_with("network:"))
        );
        // Evidence is exclusive and cannot silently overwrite an earlier sample.
        assert!(write_sample_file(&fixture.0.join("result.json"), b"overwritten").is_err());
    }

    #[test]
    fn reader_batch_retains_all_failures_and_rejects_missing_evidence() {
        let fixture = Fixture::new().unwrap();
        let mut samples = Vec::new();
        for index in 0..READER_BATCH_SAMPLES {
            let sequence = index + 1;
            let mode = if index % 2 == 0 {
                "cold-view"
            } else {
                "warm-view"
            };
            let directory = fixture.0.join(format!("sample-{sequence:02}-{mode}"));
            fs::create_dir(&directory).unwrap();
            let process = if index == 0 {
                Err("fake spawn failure".into())
            } else {
                Ok(completed_reader_process(
                    serde_json::to_vec(&reader_child_result(mode)).unwrap(),
                ))
            };
            samples.push(save_reader_sample(&directory, sequence, mode, process, Ok(())).unwrap());
        }
        assert_eq!(samples[0]["status"], "failed");
        assert_eq!(samples.last().unwrap()["status"], "passed");
        assert!(reader_batch_evidence_complete(&fixture.0, &samples));
        assert!(!reader_batch_evidence_complete(&fixture.0, &samples[1..]));
        fs::remove_file(fixture.0.join("sample-40-warm-view/stderr.log")).unwrap();
        assert!(!reader_batch_evidence_complete(&fixture.0, &samples));
        assert!(reader_adversarial_batch(&fixture.0, &fixture.0).is_err());
        assert!(reader_adversarial_batch(&fixture.0, Path::new("relative-output")).is_err());
    }

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
            assert!(
                settings["mailFolderCatalogs"][owner]["folders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|folder| folder["editable"].is_boolean()),
                "Fixture catalogs must already include management metadata to avoid provider refresh."
            );
            assert_eq!(
                store
                    .list(owner)
                    .unwrap()
                    .iter()
                    .filter(|m| m["folder"] == "inbox")
                    .count(),
                65
            );
            let shared = store.get(owner, "fixture:shared").unwrap().unwrap();
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
                .get(ACCOUNTS[0], "fixture:provider-draft")
                .unwrap()
                .unwrap()["bcc"],
            "hidden@example.invalid"
        );
        assert!(
            store
                .get(ACCOUNTS[1], "fixture:provider-draft")
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
            .update(ACCOUNTS[0], "fixture:shared", &json!({"starred":true}))
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
