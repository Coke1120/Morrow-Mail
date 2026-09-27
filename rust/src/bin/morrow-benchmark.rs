//! Fictional service benchmark; no Node, provider/model requests or implicit builds.
//! Required: --binary=PATH --output=NEW_REPORT.json. Optional flags retain the
//! normal JS driver's spellings; profiler/event-loop diagnostics are not ported.
use chrono::{SecondsFormat, TimeZone, Utc};
use morrow_search::store::{Store, private, random_bytes};
use reqwest::{Client, header};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitCode, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const ACCOUNTS: [&str; 2] = ["alpha@example.invalid", "beta@example.invalid"];
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const STOP_SECONDS: u64 = 75; // Production has a shared 65-second shutdown deadline.

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
fn elapsed(start: Instant) -> f64 {
    ms(start.elapsed())
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("Missing integer metadata field: {key}").into())
}

#[derive(Debug)]
struct Options {
    binary: PathBuf,
    output: PathBuf,
    sizes: Vec<usize>,
    idle_seconds: u64,
    missing: Option<usize>,
    rebuild_seconds: u64,
    revision_foreground: bool,
    probe: bool,
}
impl Options {
    fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut options = std::collections::HashMap::new();
        for argument in arguments {
            let (key, value) = argument
                .strip_prefix("--")
                .and_then(|s| s.split_once('='))
                .ok_or("Use --name=value options; --binary and --output are required.")?;
            check(
                [
                    "binary",
                    "output",
                    "sizes",
                    "idleSeconds",
                    "missingRows",
                    "rebuildMode",
                    "probeRevision",
                    "rebuildTimeoutSeconds",
                ]
                .contains(&key),
                "Unknown option. Native profiling and Node event-loop diagnostics are not implemented by this driver.",
            )?;
            check(
                !value.is_empty() && options.insert(key.to_owned(), value.to_owned()).is_none(),
                "Empty or duplicate benchmark option.",
            )?;
        }
        let get =
            |key: &str, default: &str| options.get(key).cloned().unwrap_or_else(|| default.into());
        let binary = PathBuf::from(options.get("binary").ok_or(
            "Specify --binary=PATH to an existing production service; no build is performed.",
        )?);
        let output =
            PathBuf::from(options.get("output").ok_or(
                "Specify --output=NEW_REPORT.json; existing reports are never overwritten.",
            )?);
        let sizes: Vec<usize> = get("sizes", "1000,10000,50000")
            .split(',')
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()?;
        check(
            !sizes.is_empty()
                && sizes.len() <= 3
                && sizes.iter().all(|n| (100..=50000).contains(n))
                && sizes.iter().collect::<HashSet<_>>().len() == sizes.len(),
            "Choose one to three distinct sizes from 100 to 50000.",
        )?;
        let idle_seconds = get("idleSeconds", "30").parse()?;
        check(
            idle_seconds <= 60,
            "idleSeconds must be an integer from 0 to 60.",
        )?;
        let missing = options
            .get("missingRows")
            .map(|s| s.parse::<usize>())
            .transpose()?;
        check(
            missing.is_none_or(|n| n > 0 && sizes.iter().all(|size| n <= *size)),
            "missingRows must be 1..size for every dataset.",
        )?;
        let rebuild_seconds = get("rebuildTimeoutSeconds", "180").parse()?;
        check(
            (1..=180).contains(&rebuild_seconds),
            "rebuildTimeoutSeconds must be 1..180.",
        )?;
        let mode = get("rebuildMode", "state");
        check(
            ["state", "revision"].contains(&mode.as_str()),
            "rebuildMode must be state or revision.",
        )?;
        let probe = get("probeRevision", "false");
        check(
            ["true", "false"].contains(&probe.as_str()),
            "probeRevision must be true or false.",
        )?;
        Ok(Self {
            binary,
            output,
            sizes,
            idle_seconds,
            missing,
            rebuild_seconds,
            revision_foreground: mode == "revision",
            probe: probe == "true",
        })
    }
}

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Result<Self> {
        let path = env::temp_dir()
            .canonicalize()?
            .join(format!("morrow-rust-benchmark-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        private(&path, true)?;
        Ok(Self(path))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Fixture cleanup failed at {}: {error}", self.0.display());
        }
    }
}

type Pipe = mpsc::Receiver<std::io::Result<Vec<u8>>>;
fn pipe(reader: impl Read + Send + 'static, limit: u64) -> Pipe {
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = reader
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = send.send(result);
    });
    receive
}
fn pipe_output(pipe: &Pipe, limit: usize) -> Result<Vec<u8>> {
    let bytes = pipe.recv_timeout(Duration::from_secs(2))??;
    check(
        bytes.len() <= limit,
        "Process output exceeded its bounded limit.",
    )?;
    Ok(bytes)
}
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}
fn capture(command: &mut Command, seconds: u64, limit: usize) -> Result<String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let output = pipe(
        child.stdout.take().ok_or("Missing process output.")?,
        limit as u64,
    );
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break check(status.success(), "A required OS/version command failed.");
            }
            Err(error) => break Err(error.into()),
            _ if Instant::now() >= deadline => {
                break Err("A required OS/version command timed out.".into());
            }
            _ => thread::sleep(Duration::from_millis(10)),
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result?;
    Ok(String::from_utf8(pipe_output(&output, limit)?)?)
}

#[derive(Clone, Copy)]
struct Sample {
    rss: u64,
    cpu: f64,
}
fn cpu_time(value: &str) -> Result<f64> {
    let (days, time) = value.split_once('-').unwrap_or(("0", value));
    let days: f64 = days.parse()?;
    let parts: Vec<f64> = time
        .split(':')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?;
    check(
        (2..=3).contains(&parts.len())
            && days.is_finite()
            && days >= 0.0
            && parts.iter().all(|n| n.is_finite() && *n >= 0.0),
        "Invalid OS CPU time.",
    )?;
    Ok((days * 86400.0 + parts.iter().fold(0.0, |sum, part| sum * 60.0 + part)) * 1000.0)
}
fn sample_blocking(pid: u32) -> Result<Sample> {
    let (rss, cpu) = if cfg!(windows) {
        let script = format!(
            "$ErrorActionPreference='Stop';$p=Get-Process -Id {pid};@{{rssBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}}|ConvertTo-Json -Compress"
        );
        let output = capture(
            command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]),
            10,
            4096,
        )?;
        let value: Value = serde_json::from_str(&output)?;
        (
            number(&value, "rssBytes")?,
            value["cpuMs"]
                .as_f64()
                .ok_or("Missing service CPU sample.")?,
        )
    } else {
        let output = capture(
            command("/bin/ps").args(["-o", "rss=", "-o", "time=", "-p", &pid.to_string()]),
            10,
            4096,
        )?;
        let parts: Vec<_> = output.split_whitespace().collect();
        check(parts.len() == 2, "Could not sample the service PID.")?;
        (
            parts[0]
                .parse::<u64>()?
                .checked_mul(1024)
                .ok_or("Invalid RSS sample.")?,
            cpu_time(parts[1])?,
        )
    };
    check(
        rss > 0 && cpu.is_finite() && cpu >= 0.0,
        "Invalid process sample.",
    )?;
    Ok(Sample { rss, cpu })
}
async fn sample(pid: u32) -> Result<Sample> {
    tokio::task::spawn_blocking(move || sample_blocking(pid)).await?
}

#[derive(Clone)]
struct Http {
    client: Client,
    base: String,
}
struct Response {
    data: Value,
    ms: f64,
    bytes: usize,
    phases: Value,
}
impl Http {
    async fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        budget: Duration,
    ) -> Result<Response> {
        let start = Instant::now();
        let url = format!("{}/api{path}", self.base);
        let request = match body {
            Some(body) => self.client.post(url).json(body),
            None => self.client.get(url),
        };
        let mut response = request.timeout(budget).send().await?;
        let headers_at = Instant::now();
        check(
            response.status() == 200,
            &format!("Fixture API rejected {path}."),
        )?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            check(
                bytes.len() + chunk.len() <= RESPONSE_LIMIT,
                "Response exceeded the metadata limit.",
            )?;
            bytes.extend_from_slice(&chunk);
        }
        let body_at = Instant::now();
        let data = serde_json::from_slice(&bytes)?;
        let complete = Instant::now();
        Ok(Response {
            data,
            ms: ms(complete - start),
            bytes: bytes.len(),
            phases: json!({
            "headersMs":ms(headers_at-start), "bodyMs":ms(body_at-headers_at), "parseMs":ms(complete-body_at)}),
        })
    }
    async fn normal(&self, path: &str, body: Option<&Value>) -> Result<Response> {
        self.request(path, body, Duration::from_secs(60)).await
    }
}
struct Service {
    child: Child,
    input: Option<ChildStdin>,
    stderr: Pipe,
    stdout: Pipe,
    http: Http,
    startup: f64,
    stopped: bool,
}
impl Service {
    fn start(executable: &Path, workspace: &Path) -> Result<Self> {
        let token: String = random_bytes::<32>()?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let mut headers = header::HeaderMap::new();
        let mut bearer = header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        bearer.set_sensitive(true);
        headers.insert(header::AUTHORIZATION, bearer);
        headers.insert("X-Genmail-Account", header::HeaderValue::from_static("all"));
        headers.insert("X-Morrow-View", header::HeaderValue::from_static("paged"));
        let client = Client::builder()
            .default_headers(headers)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()?;
        let start = Instant::now();
        let mut child = command(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take();
        let stderr = pipe(
            child.stderr.take().ok_or("Missing service error pipe.")?,
            8192,
        );
        let stdout = child.stdout.take().ok_or("Missing readiness pipe.")?;
        let (ready_send, ready) = mpsc::sync_channel(1);
        let (done_send, stdout_done) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let first = reader
                .by_ref()
                .take(8193)
                .read_until(b'\n', &mut line)
                .map(|_| line);
            let _ = ready_send.send(first);
            let mut trailing = Vec::new();
            let result = reader
                .take(8193)
                .read_to_end(&mut trailing)
                .map(|_| trailing);
            let _ = done_send.send(result);
        });
        let mut service = Self {
            child,
            input,
            stderr,
            stdout: stdout_done,
            http: Http {
                client,
                base: String::new(),
            },
            startup: 0.0,
            stopped: false,
        };
        // Configuration is private stdin only: no credentials/workspace in argv,
        // environment, benchmark output or error diagnostics.
        let input = service
            .input
            .as_mut()
            .ok_or("Missing private configuration pipe.")?;
        serde_json::to_writer(
            &mut *input,
            &json!({"token":token,"dataDirectory":workspace,"port":0,"parentPID":std::process::id()}),
        )?;
        input.write_all(b"\n")?;
        input.flush()?;
        let line = ready.recv_timeout(Duration::from_secs(60))??;
        check(
            line.len() <= 8192 && line.last() == Some(&b'\n'),
            "Invalid service readiness output.",
        )?;
        let port = number(&serde_json::from_slice::<Value>(&line)?, "port")?;
        check(
            (1..=65535).contains(&port),
            "Invalid service loopback port.",
        )?;
        service.http.base = format!("http://127.0.0.1:{port}");
        service.startup = elapsed(start);
        Ok(service)
    }
    fn stop(&mut self) -> Result<f64> {
        let start = Instant::now();
        self.input.take(); // Private-pipe EOF, not SIGTERM, is the measured path.
        loop {
            if let Some(status) = self.child.try_wait()? {
                self.stopped = true;
                check(status.success(), "Service shutdown returned a failure.")?;
                check(
                    pipe_output(&self.stderr, 8192)?.is_empty(),
                    "Service emitted unexpected diagnostics.",
                )?;
                check(
                    pipe_output(&self.stdout, 8192)?.is_empty(),
                    "Service emitted unexpected trailing output.",
                )?;
                return Ok(elapsed(start));
            }
            check(
                start.elapsed() < Duration::from_secs(STOP_SECONDS),
                "Service did not release its writer after private-pipe EOF.",
            )?;
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        if !self.stopped {
            self.input.take();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn fixture_message(index: usize) -> Value {
    let prefix = if index.is_multiple_of(10) {
        "請於本月付款。 Invoice payment. "
    } else {
        "Meeting notes and project timeline. "
    };
    let body = format!(
        "{prefix}{}",
        "x".repeat(1024 - prefix.encode_utf16().count())
    );
    json!({"id":format!("fixture-{}",index/2),"folder":if index.is_multiple_of(5){"sent"}else{"inbox"},
        "date":(Utc.with_ymd_and_hms(2026,1,1,0,0,0).unwrap()+chrono::Duration::seconds((index/4) as i64)).to_rfc3339_opts(SecondsFormat::Millis,true),
        "fromName":format!("Sender {}",index%100),"fromEmail":"sender@example.invalid","to":ACCOUNTS[index%2],
        "subject":if index.is_multiple_of(10){format!("發票 INV-{index}")}else{format!("Project update {index}")},
        "body":body,"preview":"Fictional benchmark mail","read":!index.is_multiple_of(3),"starred":index.is_multiple_of(7),"category":"primary","labels":[]})
}
fn seed(directory: &Path, size: usize) -> Result<Value> {
    let start = Instant::now();
    let store = Store::open(directory)?;
    let open_ms = elapsed(start);
    store.set_settings(&json!({"activeAccount":"all","mailAccounts":{
        ACCOUNTS[0]:{"email":ACCOUNTS[0],"provider":"imap","connectionId":ACCOUNTS[0]},
        ACCOUNTS[1]:{"email":ACCOUNTS[1],"provider":"imap","connectionId":ACCOUNTS[1]}},
        "preferences":{"syncInterval":0},"policy":{"enabled":false},"ai":null}))?;
    let start = Instant::now();
    let mut body_sizes = BTreeSet::new();
    store.transaction(|db| {
        for index in 0..size {
            let message = fixture_message(index);
            body_sizes.insert(message["body"].as_str().unwrap().len());
            db.upsert(ACCOUNTS[index % 2], &message)?;
        }
        Ok(())
    })?;
    check(
        store.index_remaining()? == 0,
        "Fixture seed did not produce a complete derived index.",
    )?;
    let seed_ms = elapsed(start);
    drop(store);
    Ok(
        json!({"rustEmptyOpenMs":open_ms,"rustSeedAndIndexMs":seed_ms,"bodyCodeUnits":1024,
        "bodyUTF8Bytes":body_sizes,"databaseBytesBeforeFirstServiceStart":fs::metadata(directory.join("genmail.sqlite"))?.len()}),
    )
}
fn sender_ids(size: usize) -> Vec<Value> {
    // Independent golden for the generated ASCII `Sender N` names: numeric N,
    // descending timestamp, ascending account and lexical provider ID. No call
    // into the production page sorter/collator is used as its own oracle.
    let mut indices: Vec<_> = (0..size).collect();
    indices.sort_by(|a, b| {
        (a % 100)
            .cmp(&(b % 100))
            .then_with(|| (b / 4).cmp(&(a / 4)))
            .then_with(|| ACCOUNTS[a % 2].cmp(ACCOUNTS[b % 2]))
            .then_with(|| format!("fixture-{}", a / 2).cmp(&format!("fixture-{}", b / 2)))
    });
    indices
        .into_iter()
        .take(50)
        .map(|i| json!(json!([ACCOUNTS[i % 2], format!("fixture-{}", i / 2)]).to_string()))
        .collect()
}
fn messages(data: &Value) -> Result<&Vec<Value>> {
    data["messages"]
        .as_array()
        .ok_or_else(|| "Missing metadata messages.".into())
}
fn verify_rows(data: &Value, total: usize, limit: usize) -> Result<()> {
    let actual = data.get("total").unwrap_or(&data["mailPage"]["total"]);
    check(
        actual.as_u64() == Some(total as u64),
        "Mailbox/search count differs from the fixture.",
    )?;
    let rows = messages(data)?;
    check(
        rows.len() == total.min(limit),
        "Metadata page has an unexpected size.",
    )?;
    let mut identities = HashSet::new();
    for row in rows {
        let owner = row["accountId"].as_str().ok_or("Unowned metadata row.")?;
        check(
            ACCOUNTS.contains(&owner),
            "Combined view leaked Demo or disconnected mail.",
        )?;
        let id = row["id"].as_str().ok_or("Missing provider identity.")?;
        let expected_identity = json!([owner, id]).to_string();
        check(
            row["viewId"].as_str() == Some(expected_identity.as_str())
                && identities.insert(row["viewId"].as_str().ok_or("Invalid UI identity.")?),
            "Colliding provider IDs lost their owned UI identity.",
        )?;
        let object = row.as_object().ok_or("Invalid metadata row.")?;
        check(
            ["body", "bodyHtml", "footer", "bcc", "attachments"]
                .iter()
                .all(|key| !object.contains_key(*key)),
            "List metadata leaked private body/attachment fields.",
        )?;
        if let Some(snippet) = row.get("searchSnippet") {
            let parts = snippet.as_array().ok_or("Invalid search snippet.")?;
            let count = parts
                .iter()
                .map(|part| part["text"].as_str().unwrap_or("").chars().count())
                .sum::<usize>();
            check(count <= 182, "Search snippet exceeded its bound.")?;
        }
    }
    check(
        !data.to_string().contains(&"x".repeat(256)),
        "Full fixture bodies leaked into metadata.",
    )
}
fn verify_revision(data: &Value) -> Result<()> {
    check(
        data["accountId"] == "all"
            && data["revision"].is_string()
            && data.get("messages").is_none(),
        "Revision response lost its lightweight combined-view contract.",
    )
}
fn verify_invoices(data: &Value, size: usize) -> Result<()> {
    check(
        data["engine"] == "rust",
        "Search did not use the Rust engine.",
    )?;
    for message in messages(data)? {
        let index = message["id"]
            .as_str()
            .and_then(|id| id.strip_prefix("fixture-"))
            .and_then(|id| id.parse::<usize>().ok())
            .ok_or("Invalid invoice identity.")?;
        check(
            message["accountId"] == ACCOUNTS[0]
                && index < size.div_ceil(2)
                && index.is_multiple_of(5),
            "Invoice query returned an unexpected owner or fixture ID.",
        )?;
    }
    Ok(())
}
async fn measure(
    http: &Http,
    pid: u32,
    path: &str,
    body: Option<Value>,
    verify: impl Fn(&Value) -> Result<()>,
    rss: &mut Vec<u64>,
) -> Result<Value> {
    let before = sample(pid).await?;
    let mut samples = Vec::new();
    for _ in 0..6 {
        let response = http.normal(path, body.as_ref()).await?;
        verify(&response.data)?;
        let process = sample(pid).await?;
        rss.push(process.rss);
        samples.push(json!({"ms":response.ms,"bytes":response.bytes,"phases":response.phases,"rssBytes":process.rss}));
    }
    let after = sample(pid).await?;
    let mut warm: Vec<_> = samples[1..]
        .iter()
        .map(|s| s["ms"].as_f64().unwrap())
        .collect();
    warm.sort_by(f64::total_cmp);
    Ok(
        json!({"firstMs":samples[0]["ms"],"warmP50Ms":warm[2],"warmP95Ms":warm[4],
        "payloadBytes":samples[5]["bytes"],"serviceCpuDeltaMs":(after.cpu-before.cpu).max(0.0),"serviceRSSBytes":after.rss,"samples":samples}),
    )
}
async fn idle(pid: u32, seconds: u64, rss: &mut Vec<u64>) -> Result<Value> {
    let start = Instant::now();
    let before = sample(pid).await?;
    let mut samples = Vec::new();
    let duration = Duration::from_secs(seconds);
    while start.elapsed() < duration {
        tokio::time::sleep(
            duration
                .saturating_sub(start.elapsed())
                .min(Duration::from_secs(1)),
        )
        .await;
        let process = sample(pid).await?;
        rss.push(process.rss);
        samples
            .push(json!({"elapsedMs":elapsed(start),"rssBytes":process.rss,"cpuMs":process.cpu}));
    }
    let after = sample(pid).await?;
    let elapsed_ms = elapsed(start);
    let cpu = (after.cpu - before.cpu).max(0.0);
    Ok(
        json!({"requestedSeconds":seconds,"elapsedMs":elapsed_ms,"cpuDeltaMs":cpu,
        "cpuPercentOfOneCore":if seconds==0 {Value::Null}else{json!(cpu/elapsed_ms*100.0)},
        "rssBeforeBytes":before.rss,"rssAfterBytes":after.rss,"samples":samples}),
    )
}
fn remove_derived(workspace: &Path, size: usize, requested: usize, full: bool) -> Result<usize> {
    // Service has exited. Reopening Store also verifies that its writer.lock is
    // released before this fixture-only mutation; startup readiness remains real.
    let store = Store::open(workspace)?;
    let total = store.transaction(|db| {
        let count: i64 = db.conn.query_row("SELECT count(*) FROM search_documents WHERE account IN (?,?)",ACCOUNTS,|r|r.get(0))?;
        if count != size as i64 { return Err(morrow_search::error::Error::invalid("Fixture index was incomplete before deletion.")); }
        let removed = if full { db.conn.execute("DELETE FROM search_documents",[])? } else {
            db.conn.execute("DELETE FROM search_documents WHERE rowid IN (SELECT rowid FROM search_documents WHERE account IN (?,?) ORDER BY rowid LIMIT ?)",params![ACCOUNTS[0],ACCOUNTS[1],requested as i64])?
        };
        db.conn.execute("DELETE FROM search_meta",[])?;
        Ok(removed)
    })?;
    let retained: i64 = store.conn.query_row(
        "SELECT count(*) FROM search_documents WHERE account IN (?,?)",
        ACCOUNTS,
        |r| r.get(0),
    )?;
    check(
        retained == (size - requested) as i64
            && if full {
                total >= size
            } else {
                total == requested
            },
        "Derived deletion did not match the requested scope.",
    )?;
    if full {
        check(
            store
                .conn
                .query_row("SELECT count(*) FROM search_documents", [], |r| {
                    r.get::<_, i64>(0)
                })?
                == 0,
            "Full loss retained derived rows.",
        )?;
    }
    Ok(total)
}
fn budget(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(1))
        .min(Duration::from_secs(60))
}
fn deadline_error(
    error: &(dyn std::error::Error + Send + Sync + 'static),
    deadline: Instant,
) -> bool {
    Instant::now() >= deadline
        && error
            .downcast_ref::<reqwest::Error>()
            .is_some_and(reqwest::Error::is_timeout)
}
async fn revision_probe(
    http: Http,
    deadline: Instant,
    start: Instant,
    stop: Arc<AtomicBool>,
) -> Result<Vec<Value>> {
    let mut samples = Vec::new();
    while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
        let started = elapsed(start);
        let response = match http
            .request("/state/revision", None, budget(deadline))
            .await
        {
            Ok(response) => response,
            Err(error) if deadline_error(error.as_ref(), deadline) => break,
            Err(error) => return Err(error),
        };
        verify_revision(&response.data)?;
        samples.push(json!({"startedMs":started,"completedMs":elapsed(start),"ms":response.ms,"bytes":response.bytes,"phases":response.phases}));
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(samples)
}
async fn rebuild(
    service: &Service,
    size: usize,
    missing: usize,
    options: &Options,
    rss: &mut Vec<u64>,
) -> Result<Value> {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(options.rebuild_seconds);
    let stop = Arc::new(AtomicBool::new(false));
    let probe = if options.probe {
        Some(tokio::spawn(revision_probe(
            service.http.clone(),
            deadline,
            start,
            stop.clone(),
        )))
    } else {
        None
    };
    let path = if options.revision_foreground {
        "/state/revision"
    } else {
        "/state"
    };
    let mut phase = "starting";
    let mut trace = Vec::new();
    let mut complete = false;
    let mut previous_coverage = size - missing;
    let mut previous_matches = 0;
    let outcome: Result<()> = async {
        while Instant::now() < deadline {
            let started = elapsed(start); let before = sample(service.child.id()).await?;
            if Instant::now() >= deadline { break; }
            phase = path;
            let foreground = service.http.request(path,None,budget(deadline)).await?;
            if options.revision_foreground { verify_revision(&foreground.data)?; } else { verify_rows(&foreground.data,size,50)?; }
            let foreground_end = elapsed(start);
            if Instant::now() >= deadline { break; }
            phase = "/search";
            let search = service.http.request("/search",Some(&json!({"query":"发票","scope":"all"})),budget(deadline)).await?;
            let matches = number(&search.data,"total")? as usize;
            check(matches <= size.div_ceil(10), "Index rebuild returned too many invoice matches.")?;
            verify_rows(&search.data,matches,30)?; verify_invoices(&search.data,size)?;
            let coverage = search.data["coverage"].as_array().ok_or("Missing index coverage.")?;
            let mut seen = HashSet::new(); let mut covered = 0usize;
            for row in coverage {
                let account = row["account"].as_str().ok_or("Missing coverage owner.")?;
                check(ACCOUNTS.contains(&account) && seen.insert(account), "Coverage crossed/duplicated accounts.")?;
                covered += number(row,"count")? as usize;
            }
            check(covered >= previous_coverage && covered <= size && matches >= previous_matches, "Index/search progress regressed or exceeded the fixture.")?;
            previous_coverage = covered; previous_matches = matches;
            let process = sample(service.child.id()).await?; rss.push(process.rss);
            trace.push(json!({"startedMs":started,"foregroundCompletedMs":foreground_end,"elapsedMs":elapsed(start),
                "foregroundPath":path,"foregroundMs":foreground.ms,"foregroundBytes":foreground.bytes,"foregroundPhases":foreground.phases,
                "searchMs":search.ms,"searchPhases":search.phases,"indexedMessages":covered,"invoiceMatches":matches,"warning":search.data["warning"],
                "cpuDeltaMs":(process.cpu-before.cpu).max(0.0),"cpuMs":process.cpu,"rssBytes":process.rss}));
            if covered == size && search.data["warning"] == "" {
                check(matches == size.div_ceil(10), "Completed index lost invoice matches.")?; complete = true; break;
            }
            phase = "between requests";
            tokio::time::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(100))).await;
        }
        Ok(())
    }.await;
    let observation_ms = elapsed(start);
    stop.store(true, Ordering::Relaxed);
    let probes = match probe {
        Some(probe) => probe.await??,
        None => Vec::new(),
    };
    if let Err(error) = outcome
        && !deadline_error(error.as_ref(), deadline)
    {
        return Err(error);
    }
    let mut report = json!({"status":if complete{"complete"}else{"timed_out"},"timeoutMs":options.rebuild_seconds*1000,
        "startupMs":service.startup,"foregroundPath":path,"concurrentRevisionProbes":options.probe,"trace":trace,
        "revisionProbes":probes,"driverEventLoop":null,"nativeSamplePath":null});
    if complete {
        report["completionMsAfterReadiness"] = observation_ms.into();
    } else {
        report["elapsedMsAfterReadiness"] = observation_ms.into();
        report["timeoutPhase"] = phase.into();
    }
    Ok(report)
}

async fn dataset(executable: &Path, size: usize, options: &Options) -> Result<Value> {
    let fixture = Temporary::new()?;
    let mut report = seed(&fixture.0, size)?;
    report["size"] = size.into();
    let mut service = Service::start(executable, &fixture.0)?;
    report["firstServiceStartupMs"] = service.startup.into();
    check(
        service.http.normal("/health", None).await?.data["status"] == "ok",
        "Service health failed.",
    )?;
    let first = service.http.normal("/state", None).await?;
    verify_rows(&first.data, size, 50)?;
    report["firstServiceStateMs"] = first.ms.into();
    report["firstServiceStateBytes"] = first.bytes.into();
    report["firstServiceStopMs"] = service.stop()?.into();
    drop(service);
    let mut service = Service::start(executable, &fixture.0)?;
    report["restartStartupMs"] = service.startup.into();
    let pid = service.child.id();
    let initial = sample(pid).await?;
    let mut rss = vec![initial.rss];
    let http = &service.http;
    report["state"] = measure(
        http,
        pid,
        "/state",
        None,
        |v| verify_rows(v, size, 50),
        &mut rss,
    )
    .await?;
    report["revision"] = measure(
        http,
        pid,
        "/state/revision",
        None,
        verify_revision,
        &mut rss,
    )
    .await?;
    report["search"] = measure(
        http,
        pid,
        "/search",
        Some(json!({"query":"发票","scope":"all"})),
        |v| {
            verify_rows(v, size.div_ceil(10), 30)?;
            verify_invoices(v, size)
        },
        &mut rss,
    )
    .await?;
    report["page"] = measure(
        http,
        pid,
        "/mail/page",
        Some(json!({"folder":"inbox","pageSize":50,"sort":"newest"})),
        |v| verify_rows(v, size - size.div_ceil(5), 50),
        &mut rss,
    )
    .await?;
    let golden = sender_ids(size);
    report["sender"] = measure(
        http,
        pid,
        "/mail/page",
        Some(json!({"pageSize":50,"sort":"sender","locale":"en"})),
        |v| {
            verify_rows(v, size, 50)?;
            check(
                messages(v)?
                    .iter()
                    .map(|m| m["viewId"].clone())
                    .collect::<Vec<_>>()
                    == golden,
                "Sender ordering differs from the independent fixture golden.",
            )
        },
        &mut rss,
    )
    .await?;
    let first = http
        .normal("/mail/page", Some(&json!({"pageSize":50})))
        .await?;
    verify_rows(&first.data, size, 50)?;
    check(
        first.data["nextCursor"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "Missing next-page cursor.",
    )?;
    let second = http
        .normal(
            "/mail/page",
            Some(&json!({"pageSize":50,"cursor":first.data["nextCursor"]})),
        )
        .await?;
    verify_rows(&second.data, size, 50)?;
    check(
        messages(&first.data)?
            .iter()
            .chain(messages(&second.data)?)
            .map(|m| m["viewId"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len()
            == 100,
        "Cursor pages duplicated or lost owned identities.",
    )?;
    report["idle"] = idle(pid, options.idle_seconds, &mut rss).await?;
    report["stopMs"] = service.stop()?.into();
    drop(service);
    let missing = options.missing.unwrap_or(size.min(1000));
    let full = options.missing == Some(size);
    let removed_total = remove_derived(&fixture.0, size, missing, full)?;
    let mut service = Service::start(executable, &fixture.0)?;
    let mut index = rebuild(&service, size, missing, options, &mut rss).await?;
    service.stop()?;
    drop(service);
    // Verify final durable state only after EOF and writer release. Do not run
    // backfill here: a timeout must remain a failed, partially rebuilt report.
    let store = Store::open(&fixture.0)?;
    for account in ACCOUNTS {
        check(
            store.conn.query_row(
                "SELECT count(*) FROM messages WHERE account=?",
                [account],
                |r| r.get::<_, i64>(0),
            )? == if account == ACCOUNTS[0] {
                size.div_ceil(2) as i64
            } else {
                (size / 2) as i64
            },
            "Rebuild altered source mailbox rows.",
        )?;
    }
    let complete = index["status"] == "complete";
    if complete {
        check(
            store.index_remaining()? == 0,
            "Rebuild completed before all accounts, including Demo, were indexed.",
        )?;
    }
    let settings = store.settings()?;
    check(
        settings["ai"].is_null()
            && settings["policy"]["enabled"] == false
            && settings["preferences"]["syncInterval"] == 0,
        "Fixture enabled provider/model work.",
    )?;
    check(
        settings["backgroundSyncErrors"].is_null() || settings["backgroundSyncErrors"] == json!([]),
        "Fixture recorded provider sync errors.",
    )?;
    drop(store);
    index["requestedMissingRows"] = missing.into();
    index["removedRows"] = missing.into();
    index["removedTotalDerivedRows"] = removed_total.into();
    index["retainedFixtureRows"] = (size - missing).into();
    index["fullIndexLoss"] = full.into();
    report["interruptedDerivedIndex"] = index;
    report["serviceInitialRSSBytes"] = initial.rss.into();
    report["serviceSampledMaxRSSBytes"] = rss.into_iter().max().unwrap().into();
    let driver = sample(std::process::id()).await?;
    report["driver"] = json!({"pid":std::process::id(),"rssBytes":driver.rss,"cpuMs":driver.cpu,
        "note":"Rust fixture writer/HTTP driver; excluded from service metrics. One driver process is reused across sizes, unlike the historical JS child-per-size driver."});
    report["checks"] = json!({"counts":true,"senderOrder":true,"boundedMetadata":true,"distinctOwnersAndCursorPages":true,"noDualWriter":true,
        "indexProgressMonotonic":true,"exactInvoiceIdentities":true,"indexRebuildCompleted":complete,"sourceRowsRetained":true,"providersAndModelsDisabled":true});
    Ok(report)
}

fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn save_report(file: &mut fs::File, report: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(report)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.set_len(bytes.len() as u64 + 1)?;
    file.sync_all()?;
    Ok(())
}
fn new_report(path: &Path) -> Result<fs::File> {
    fs::create_dir_all(path.parent().ok_or("Invalid report path.")?)?;
    Ok(fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?)
}
async fn run(options: Options) -> Result<bool> {
    check(
        cfg!(target_os = "macos") || cfg!(windows),
        "Service RSS/CPU sampling currently supports macOS and Windows; other platforms are not silently approximated.",
    )?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing project root.")?;
    let output = if options.output.is_absolute() {
        options.output.clone()
    } else {
        env::current_dir()?.join(&options.output)
    };
    let mut file = new_report(&output)?;
    let mut report = json!({"status":"running","measuredAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),
        "driver":"morrow-benchmark (Rust)","platform":env::consts::OS,"architecture":env::consts::ARCH,
        "logicalCPUs":thread::available_parallelism()?.get(),"results":[],
        "fixture":"mail-v1: two fictional accounts, colliding provider IDs, mixed Chinese/English, 1024 UTF-16-code-unit bodies; no provider/model calls.",
        "method":"Rust Store seeds and closes before an immutable copied service starts through private stdin. First service startup is NOT Node migration and includes no Node-produced backup. Restart uses the same Rust-produced workspace. First plus five warm requests per operation; nearest-rank warm p50/p95. OS RSS and cumulative CPU sample only the service PID; driver is reported separately. Idle has no HTTP requests. Derived rows are removed only after service exit and writer-lock acquisition. Explicit missingRows=size removes all derived rows, including Demo; the default deletes min(size,1000) real-account rows only. Rebuild requires full real-account coverage AND an empty global warning, then checks all durable rows after shutdown. Timeout progress is saved and exits unsuccessfully.",
        "profiling":{"rebuildForeground":if options.revision_foreground{"revision"}else{"state"},"concurrentRevisionProbes":options.probe,
            "nativeSampling":false,"driverEventLoop":null,"note":"Native sampling and Node event-loop diagnostics are not ported; unknown options are rejected. Header time includes client scheduling, loopback, service and DB queue. Concurrent probes and OS sampling alter workload. Rust uses blocking-pool OS sampling; the old JS driver sampled synchronously."},
        "limitations":"No Node migration/interoperability, UI/whole-app, real-account, paid-model, cold-OS-cache or latency-distribution acceptance claims. Five warm requests are a smoke benchmark. Partial rebuild does not establish full-loss behavior; missing-row/body-size scope is recorded. RSS is sampled, not guaranteed peak. OS CPU timer resolution may round small deltas to zero. Developer activity and filesystem caches affect results. The driver is reused across sizes. CPU model and total/free system memory are not collected; service RSS/CPU remain measured. Shutdown waits at most 75 seconds around the production 65-second drain, rather than the old driver's 15 seconds."});
    save_report(&mut file, &report)?;
    let outcome: Result<bool> = async {
        let package: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
        let version = package["version"].as_str().ok_or("Missing common package version.")?;
        let source = options.binary.canonicalize()?;
        check(source.is_file(),"The binary must be a regular file.")?;
        let snapshot = Temporary::new()?;
        let executable = snapshot.0.join(if cfg!(windows){"morrow-service.exe"}else{"morrow-service"});
        fs::copy(&source,&executable)?;
        let hash = digest(&executable)?;
        let actual = capture(command(&executable).arg("--version"),15,4096)?;
        check(actual.trim()==format!("Morrow Mail {version}"),"The copied service does not match the common package version.")?;
        report["binary"] = json!({"sha256":hash,"bytes":fs::metadata(&executable)?.len(),"version":actual.trim(),
            "buildMode":"caller-supplied; release/debug is not inferable from --version","immutableCopy":true});
        report["commit"] = capture(command("git").current_dir(root).args(["rev-parse","HEAD"]),10,4096)?.trim().into();
        report["dirtyAtStart"] = (!capture(command("git").current_dir(root).args(["status","--porcelain"]),10,1024*1024)?.trim().is_empty()).into();
        report["osVersion"] = if cfg!(windows) {
            capture(command("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","[Environment]::OSVersion.VersionString"]),10,4096)?.trim().into()
        } else { capture(command("/usr/bin/uname").arg("-r"),10,4096)?.trim().into() };
        save_report(&mut file,&report)?;
        let mut success = true;
        for size in &options.sizes {
            eprintln!("Rust benchmark: {size} fictional messages.");
            report["activeSize"] = (*size).into(); save_report(&mut file,&report)?;
            let result = dataset(&executable,*size,&options).await?;
            success &= result["checks"]["indexRebuildCompleted"]==true;
            check(digest(&executable)?==hash,"The immutable service snapshot changed during measurement.")?;
            report["results"].as_array_mut().unwrap().push(result);
            save_report(&mut file,&report)?;
        }
        report["dirtyAtEnd"] = (!capture(command("git").current_dir(root).args(["status","--porcelain"]),10,1024*1024)?.trim().is_empty()).into();
        Ok(success)
    }.await;
    report["completedAt"] = Utc::now()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .into();
    match outcome {
        Ok(success) => {
            report["status"] = if success { "complete" } else { "timed_out" }.into();
            report.as_object_mut().unwrap().remove("activeSize");
            save_report(&mut file, &report)?;
            println!("Saved {}", output.display());
            Ok(success)
        }
        Err(error) => {
            report["status"] = "failed".into();
            report["error"] = error.to_string().into();
            save_report(&mut file, &report)?;
            Err(error)
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let arguments: Result<Vec<_>> = env::args_os()
        .skip(1)
        .map(|arg| {
            arg.into_string()
                .map_err(|_| "Options must be UTF-8.".into())
        })
        .collect();
    let result = match arguments.and_then(Options::parse) {
        Ok(options) => run(options).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!("Derived-index rebuild exceeded its deadline; partial progress was saved.");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("Benchmark failed: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(extra: &[&str]) -> Result<Options> {
        Options::parse(
            [
                "--binary=/fixture/morrow-service",
                "--output=/fixture/new.json",
            ]
            .into_iter()
            .chain(extra.iter().copied())
            .map(str::to_owned),
        )
    }
    #[test]
    fn options_are_explicit_bounded_and_reject_silent_feature_loss() {
        assert!(Options::parse(Vec::<String>::new()).is_err());
        assert_eq!(options(&[]).unwrap().sizes, vec![1000, 10000, 50000]);
        for flag in [
            "--missingRows=0",
            "--missingRows=-1",
            "--missingRows=1.5",
            "--missingRows=NaN",
            "--missingRows=1001",
            "--sizes=99",
            "--sizes=1000,1000",
            "--idleSeconds=61",
            "--rebuildTimeoutSeconds=0",
            "--rebuildTimeoutSeconds=181",
            "--probeRevision=yes",
            "--rebuildMode=other",
            "--profileDir=/tmp/native",
        ] {
            assert!(options(&[flag]).is_err(), "{flag}");
        }
        let normal = options(&["--sizes=1000"]).unwrap();
        assert_eq!(normal.missing, None);
        let full = options(&["--sizes=1000", "--missingRows=1000"]).unwrap();
        assert_eq!(full.missing, Some(1000));
    }
    #[test]
    fn corpus_hashes_counts_and_numeric_sender_golden_are_independent() {
        let rows: Vec<_> = (0..1000).map(fixture_message).collect();
        assert_eq!(rows.iter().filter(|m| m["folder"] == "sent").count(), 200);
        assert_eq!(
            rows.iter()
                .filter(|m| m["subject"].as_str().unwrap().starts_with("發票"))
                .count(),
            100
        );
        assert!(
            rows.iter()
                .all(|m| m["body"].as_str().unwrap().encode_utf16().count() == 1024)
        );
        assert_eq!(rows[0]["id"], rows[1]["id"]);
        assert_ne!(rows[0]["to"], rows[1]["to"]);
        assert_eq!(rows[0]["date"], "2026-01-01T00:00:00.000Z");
        let ids = sender_ids(1000);
        assert_eq!(ids.len(), 50);
        assert_eq!(ids[0], json!([ACCOUNTS[0], "fixture-450"]).to_string());
        assert_eq!(ids[10], json!([ACCOUNTS[1], "fixture-450"]).to_string());
        assert!((cpu_time("01:02.34").unwrap() - 62340.0).abs() < 0.001);
        assert_eq!(cpu_time("1-02:03:04.50").unwrap(), 93784500.0);
        assert!(cpu_time("nan:0").is_err());
    }
    #[test]
    fn partial_full_loss_preserve_sources_and_other_accounts_as_declared() {
        let fixture = Temporary::new().unwrap();
        seed(&fixture.0, 100).unwrap();
        let db = Store::open(&fixture.0).unwrap();
        let demo = db.list("demo").unwrap().len();
        drop(db);
        assert_eq!(remove_derived(&fixture.0, 100, 100, false).unwrap(), 100);
        let db = Store::open(&fixture.0).unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM search_documents WHERE account='demo'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            demo as i64
        );
        while db.backfill_batch().unwrap() != 0 {}
        drop(db);
        assert_eq!(
            remove_derived(&fixture.0, 100, 100, true).unwrap(),
            100 + demo
        );
        let db = Store::open(&fixture.0).unwrap();
        assert_eq!(db.list(ACCOUNTS[0]).unwrap().len(), 50);
        assert_eq!(db.list(ACCOUNTS[1]).unwrap().len(), 50);
        assert_eq!(db.list("demo").unwrap().len(), demo);
        assert!(db.index_remaining().unwrap() > 0);
    }
    #[test]
    fn reports_never_overwrite_and_metadata_checks_reject_leaks() {
        let fixture = Temporary::new().unwrap();
        let path = fixture.0.join("report.json");
        let mut file = new_report(&path).unwrap();
        save_report(
            &mut file,
            &json!({"status":"timed_out","trace":[{"indexedMessages":1}]}),
        )
        .unwrap();
        drop(file);
        let original = fs::read(&path).unwrap();
        assert!(new_report(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let mut response = json!({"engine":"rust","total":1,"messages":[{"id":"fixture-0","accountId":ACCOUNTS[0],"viewId":json!([ACCOUNTS[0],"fixture-0"]).to_string()}]});
        verify_rows(&response, 1, 30).unwrap();
        verify_invoices(&response, 1000).unwrap();
        response["messages"][0]["bodyHtml"] = "private".into();
        assert!(verify_rows(&response, 1, 30).is_err());
        response["messages"][0]
            .as_object_mut()
            .unwrap()
            .remove("bodyHtml");
        response["messages"][0]["accountId"] = ACCOUNTS[1].into();
        assert!(verify_rows(&response, 1, 30).is_err());
        assert!(verify_invoices(&response, 1000).is_err());
    }
}
