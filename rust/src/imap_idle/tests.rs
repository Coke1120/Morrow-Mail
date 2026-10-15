use super::*;
use crate::{error::Error, imap::IdleOutcome};
use futures_util::FutureExt;
use serde_json::json;
use std::{
    io,
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Notify, oneshot},
    task::JoinHandle,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{ServerConfig, crypto::ring, pki_types::PrivatePkcs8KeyDer},
};

const OWNER: &str = "idle@example.invalid";

fn inbox_key(owner: &str) -> ScopeKey {
    (owner.into(), "INBOX".into())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Changed,
    MixedCase,
    Quiet,
    Keepalive,
    Missing,
    Lookalike,
    LoginNo,
    InitNo,
    InitBad,
    InitWrongTag,
    HoldInit,
    Closed,
    Partial,
    Oversized,
    DoneNo,
    DoneWrongTag,
    HoldDone,
    Flood,
    Sync,
}

struct State {
    mode: Mode,
    owner_modes: Mutex<BTreeMap<String, Mode>>,
    folders: Mutex<BTreeMap<String, (u32, String)>>,
    examinations: Mutex<Vec<(String, String)>>,
    completed_leases: Mutex<Vec<(String, String)>>,
    owner_active: Mutex<BTreeMap<String, usize>>,
    owner_peak: Mutex<BTreeMap<String, usize>>,
    commands: Mutex<Vec<(String, String, Instant)>>,
    failures: Mutex<Vec<&'static str>>,
    connections: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    pulse: Notify,
}
struct Fixture {
    state: Arc<State>,
    connector: native_tls::TlsConnector,
    port: u16,
    stop: Option<oneshot::Sender<()>>,
    job: Option<JoinHandle<()>>,
}
impl Fixture {
    async fn new(mode: Mode) -> Self {
        let certified = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let connector = native_tls::TlsConnector::builder()
            .add_root_certificate(native_tls::Certificate::from_der(certified.cert.der()).unwrap())
            .build()
            .unwrap();
        let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![certified.cert.der().clone()],
                PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()).into(),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(State {
            mode,
            owner_modes: Mutex::new(BTreeMap::new()),
            folders: Mutex::new(
                std::iter::once(("Projects".into(), (77, String::new())))
                    .chain((0..20).map(|n| (format!("F{n:02}"), (77, String::new()))))
                    .collect(),
            ),
            examinations: Mutex::new(Vec::new()),
            completed_leases: Mutex::new(Vec::new()),
            owner_active: Mutex::new(BTreeMap::new()),
            owner_peak: Mutex::new(BTreeMap::new()),
            commands: Mutex::new(Vec::new()),
            failures: Mutex::new(Vec::new()),
            connections: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            pulse: Notify::new(),
        });
        let (stop, mut stopped) = oneshot::channel();
        let server_state = state.clone();
        let job = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let state = server_state.clone();
                        let acceptor = acceptor.clone();
                        tasks.spawn(async move {
                            let result = tokio::time::timeout(Duration::from_secs(15),
                                AssertUnwindSafe(serve(socket, acceptor, state.clone())).catch_unwind()).await;
                            if !matches!(result, Ok(Ok(_))) {
                                state.failures.lock().unwrap().push("TLS fixture panicked or exceeded its deadline");
                            }
                        });
                    }
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
            tasks.shutdown().await;
        });
        Self {
            state,
            connector,
            port,
            stop: Some(stop),
            job: Some(job),
        }
    }
    fn mail(&self, owner: &str) -> Value {
        json!({"provider":"imap","email":owner,"imapHost":"127.0.0.1",
            "imapPort":self.port,"password":"fictional-idle-only","connectionId":"idle-fixture"})
    }
    fn count(&self, command: &str) -> usize {
        self.state
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, value, _)| value == command)
            .count()
    }
    async fn until(&self, ready: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let notified = self.state.pulse.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if ready() {
                    break;
                }
                notified.await;
            }
        })
        .await
        .expect("fixture condition did not become true");
    }
    async fn drained(&self) {
        self.until(|| self.state.active.load(Ordering::SeqCst) == 0)
            .await;
    }
    async fn close(mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.job.take().unwrap().await.unwrap();
        assert!(self.state.failures.lock().unwrap().is_empty());
        assert_eq!(self.state.active.load(Ordering::SeqCst), 0);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(job) = self.job.take() {
            job.abort();
        }
    }
}

fn record(state: &State, owner: &str, command: &str) {
    let mut commands = state.commands.lock().unwrap();
    assert!(commands.len() < 512, "fixture command flood");
    commands.push((owner.into(), command.into(), Instant::now()));
    drop(commands);
    state.pulse.notify_waiters();
}

async fn serve(socket: TcpStream, acceptor: TlsAcceptor, state: Arc<State>) -> io::Result<()> {
    struct Active {
        state: Arc<State>,
        owner: String,
    }
    impl Drop for Active {
        fn drop(&mut self) {
            self.state.active.fetch_sub(1, Ordering::SeqCst);
            if !self.owner.is_empty() {
                *self
                    .state
                    .owner_active
                    .lock()
                    .unwrap()
                    .get_mut(&self.owner)
                    .unwrap() -= 1;
            }
            self.state.pulse.notify_waiters();
        }
    }
    state.connections.fetch_add(1, Ordering::SeqCst);
    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    state.peak.fetch_max(active, Ordering::SeqCst);
    state.pulse.notify_waiters();
    let mut active = Active {
        state: state.clone(),
        owner: String::new(),
    };
    let stream = acceptor.accept(socket).await?;
    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();
    writer.write_all(b"* OK fictional IDLE fixture\r\n").await?;
    writer.flush().await?;
    let mut owner = String::new();
    let mut selected = String::new();
    while let Some(line) = lines.next_line().await? {
        assert!(line.len() < 1024);
        let (tag, command) = line.split_once(' ').expect("tagged command");
        let kind = command.split_whitespace().next().unwrap();
        if kind == "LOGIN" {
            owner = command
                .split_whitespace()
                .nth(1)
                .unwrap()
                .trim_matches('"')
                .to_owned();
            active.owner = owner.clone();
            let mut counts = state.owner_active.lock().unwrap();
            let count = counts.entry(owner.clone()).or_default();
            *count += 1;
            let mut peaks = state.owner_peak.lock().unwrap();
            let peak = peaks.entry(owner.clone()).or_default();
            *peak = (*peak).max(*count);
        }
        let mode = state
            .owner_modes
            .lock()
            .unwrap()
            .get(&owner)
            .copied()
            .unwrap_or(state.mode);
        record(&state, &owner, kind);
        match kind {
            "LOGIN" => {
                let result = if mode == Mode::LoginNo {
                    "NO rejected"
                } else {
                    "OK logged in"
                };
                writer
                    .write_all(format!("{tag} {result}\r\n").as_bytes())
                    .await?;
            }
            "CAPABILITY" => {
                let idle = match mode {
                    Mode::Missing => "",
                    Mode::Lookalike => "XIDLE IDLEMORE",
                    Mode::MixedCase => "iDlE",
                    _ => "IDLE",
                };
                writer
                    .write_all(
                        format!("* CAPABILITY IMAP4rev1 {idle}\r\n{tag} OK capabilities\r\n")
                            .as_bytes(),
                    )
                    .await?;
            }
            "LIST" => {
                assert_eq!(command, "LIST \"\" \"*\"");
                let folders = state.folders.lock().unwrap().clone();
                writer
                    .write_all(b"* LIST (\\Inbox) \"/\" \"INBOX\"\r\n")
                    .await?;
                for (path, (_, attributes)) in folders {
                    writer
                        .write_all(format!("* LIST ({attributes}) \"/\" \"{path}\"\r\n").as_bytes())
                        .await?;
                }
                writer
                    .write_all(format!("{tag} OK listed\r\n").as_bytes())
                    .await?;
            }
            "EXAMINE" => {
                selected = command
                    .strip_prefix("EXAMINE \"")
                    .unwrap()
                    .strip_suffix('"')
                    .unwrap()
                    .into();
                let validity = if selected == "INBOX" {
                    77
                } else {
                    state.folders.lock().unwrap()[&selected].0
                };
                state
                    .examinations
                    .lock()
                    .unwrap()
                    .push((owner.clone(), selected.clone()));
                state.pulse.notify_waiters();
                writer.write_all(format!("* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY {validity}] fixed\r\n* OK [UIDNEXT 2] next\r\n{tag} OK [READ-ONLY] selected\r\n").as_bytes()).await?;
            }
            "UID" if mode == Mode::Sync => {
                let headers = format!(
                    "From: Sender <sender@example.invalid>\r\nTo: {owner}\r\nSubject: Synthetic idle arrival\r\nDate: Thu, 15 Oct 2026 00:00:00 +0000\r\nMessage-ID: <idle-arrival@example.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
                );
                let body = format!("{headers}Synthetic notification body.\r\n");
                if command == "UID SEARCH UID 1:1" {
                    writer
                        .write_all(format!("* SEARCH 1\r\n{tag} OK found\r\n").as_bytes())
                        .await?;
                } else if command
                    == "UID FETCH 1 (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER]<0.65536>)"
                {
                    writer.write_all(format!("* 1 FETCH (UID 1 FLAGS () RFC822.SIZE {} INTERNALDATE \"15-Oct-2026 00:00:00 +0000\" BODY[HEADER] {{{}}}\r\n{})\r\n{tag} OK metadata\r\n", body.len(), headers.len(), headers).as_bytes()).await?;
                } else if command == "UID FETCH 1 (UID BODY.PEEK[]<0.5242881>)" {
                    writer
                        .write_all(
                            format!(
                                "* 1 FETCH (UID 1 BODY[] {{{}}}\r\n{})\r\n{tag} OK body\r\n",
                                body.len(),
                                body
                            )
                            .as_bytes(),
                        )
                        .await?;
                } else {
                    assert_eq!(command, "UID FETCH 1 (UID FLAGS)");
                    writer
                        .write_all(
                            format!("* 1 FETCH (UID 1 FLAGS ())\r\n{tag} OK flags\r\n").as_bytes(),
                        )
                        .await?;
                }
            }
            "LOGOUT" if mode == Mode::Sync => {
                assert_eq!(command, "LOGOUT");
                writer
                    .write_all(format!("* BYE completed\r\n{tag} OK logout\r\n").as_bytes())
                    .await?;
                writer.flush().await?;
                return Ok(());
            }
            "IDLE" => {
                assert_eq!(command, "IDLE");
                if matches!(mode, Mode::InitNo | Mode::InitBad | Mode::InitWrongTag) {
                    let reply = match mode {
                        Mode::InitNo => format!("{tag} NO PRIVATE rejected\r\n"),
                        Mode::InitBad => format!("{tag} BAD PRIVATE rejected\r\n"),
                        _ => "wrong-tag NO PRIVATE rejected\r\n".into(),
                    };
                    writer.write_all(reply.as_bytes()).await?;
                    writer.flush().await?;
                    assert!(
                        lines.next_line().await?.is_none(),
                        "commands after rejected IDLE"
                    );
                    return Ok(());
                }
                if mode == Mode::Closed {
                    return Ok(());
                }
                if mode == Mode::HoldInit {
                    assert!(
                        lines.next_line().await?.is_none(),
                        "DONE before continuation"
                    );
                    return Ok(());
                }
                writer.write_all(b"+ idling\r\n").await?;
                record(&state, &owner, "CONTINUE");
                if mode == Mode::Partial {
                    writer.write_all(b"* 2 EXI").await?;
                    writer.flush().await?;
                    return Ok(());
                }
                if mode == Mode::Oversized {
                    writer
                        .write_all(b"* 1 FETCH (BODY[] {999999999}\r\n")
                        .await?;
                    writer.flush().await?;
                    assert!(lines.next_line().await?.is_none());
                    return Ok(());
                }
                if !matches!(mode, Mode::Quiet | Mode::Keepalive) {
                    let notifications = if mode == Mode::Flood { 1000 } else { 1 };
                    for _ in 0..notifications {
                        writer.write_all(b"* 2 EXISTS\r\n").await?;
                    }
                }
                writer.flush().await?;
                let mut keepalive = tokio::time::interval(Duration::from_millis(10));
                let next = loop {
                    tokio::select! {
                        line = lines.next_line() => break line?,
                        _ = keepalive.tick(), if mode == Mode::Keepalive => {
                            writer.write_all(b"* OK still here\r\n").await?;
                            writer.flush().await?;
                        }
                    }
                };
                let Some(done) = next else { return Ok(()) };
                assert_eq!(done, "DONE", "only DONE may leave IDLE");
                record(&state, &owner, "DONE");
                if mode == Mode::HoldDone {
                    assert!(lines.next_line().await?.is_none());
                    return Ok(());
                }
                let reply = match mode {
                    Mode::DoneNo => format!("{tag} NO PRIVATE completion\r\n"),
                    Mode::DoneWrongTag => "wrong-tag OK PRIVATE completion\r\n".into(),
                    _ => format!("{tag} OK idle complete\r\n"),
                };
                writer.write_all(reply.as_bytes()).await?;
                writer.flush().await?;
                if !matches!(mode, Mode::DoneNo | Mode::DoneWrongTag) {
                    state
                        .completed_leases
                        .lock()
                        .unwrap()
                        .push((owner.clone(), selected.clone()));
                    state.pulse.notify_waiters();
                }
                // Close the server's completed lease before accepting its
                // replacement, so peak counts do not include an unread EOF.
                writer.shutdown().await?;
                return Ok(());
            }
            _ => panic!("unexpected command in notification-only fixture"),
        }
        writer.flush().await?;
    }
    Ok(())
}

fn workspace() -> (App, PathBuf) {
    let path = std::env::temp_dir().join(format!("morrow-idle-{}", uuid::Uuid::new_v4()));
    let app = App::open(&path, 0, "fictional-only".into(), "fictional-update".into()).unwrap();
    (app, path)
}
fn close_workspace(app: App, path: PathBuf) {
    drop(app);
    std::fs::remove_dir_all(path).unwrap();
}
async fn enabled(app: &App, mail: Value) {
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:mail},"preferences":{"syncInterval":30}}))?;
        Ok(())
    })
    .await
    .unwrap();
}
fn fast_policy() -> Policy {
    Policy {
        lease: Duration::from_secs(2),
        hint_interval: Duration::from_millis(200),
        retry_min: Duration::from_millis(150),
        retry_max: Duration::from_millis(600),
    }
}
async fn start_manager(
    app: &App,
    fixture: &Fixture,
    policy: Policy,
) -> (watch::Sender<bool>, mpsc::Receiver<Hint>, JoinHandle<()>) {
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let (stop, stopped) = watch::channel(false);
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    let app = app.clone();
    let connector = fixture.connector.clone();
    let job =
        tokio::spawn(
            async move { manage(&app, settings, stopped, connector, sender, policy).await },
        );
    (stop, receiver, job)
}
async fn stop_manager(stop: watch::Sender<bool>, job: JoinHandle<()>, fixture: &Fixture) {
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), job)
        .await
        .unwrap()
        .unwrap();
    fixture.drained().await;
}

#[tokio::test]
async fn idle_exact_capability_and_checked_done_only_produce_a_hint() {
    for mode in [Mode::Changed, Mode::MixedCase] {
        let fixture = Fixture::new(mode).await;
        assert_eq!(
            crate::imap::idle_inbox_with_tls(
                &fixture.mail(OWNER),
                Some(77),
                &fixture.connector,
                Duration::from_secs(4)
            )
            .await
            .unwrap(),
            IdleOutcome::Changed
        );
        fixture.drained().await;
        let commands = fixture
            .state
            .commands
            .lock()
            .unwrap()
            .iter()
            .map(|(_, command, _)| command.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            commands,
            ["LOGIN", "CAPABILITY", "EXAMINE", "IDLE", "CONTINUE", "DONE"]
        );
        assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn unsupported_and_rejected_idle_never_reconnect_or_send_done_before_continuation() {
    for mode in [Mode::Missing, Mode::Lookalike, Mode::InitNo, Mode::InitBad] {
        let fixture = Fixture::new(mode).await;
        assert_eq!(
            crate::imap::idle_inbox_with_tls(
                &fixture.mail(OWNER),
                None,
                &fixture.connector,
                Duration::from_secs(4)
            )
            .await
            .unwrap(),
            IdleOutcome::Unsupported
        );
        fixture.drained().await;
        assert_eq!(fixture.count("DONE"), 0);
        assert_eq!(
            fixture.count("EXAMINE"),
            usize::from(matches!(mode, Mode::InitNo | Mode::InitBad))
        );
        assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn idle_protocol_partial_response_and_done_failures_never_publish_success() {
    for mode in [
        Mode::InitWrongTag,
        Mode::Partial,
        Mode::Oversized,
        Mode::DoneNo,
        Mode::DoneWrongTag,
        Mode::HoldDone,
    ] {
        let fixture = Fixture::new(mode).await;
        let error = crate::imap::idle_inbox_with_tls(
            &fixture.mail(OWNER),
            Some(77),
            &fixture.connector,
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
        assert!(!error.body.to_string().contains("PRIVATE"));
        fixture.drained().await;
        assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn idle_absolute_lease_expires_despite_keepalives_and_validity_is_checked() {
    let fixture = Fixture::new(Mode::Keepalive).await;
    let started = Instant::now();
    let budget = Duration::from_secs(2);
    assert_eq!(
        crate::imap::idle_inbox_with_tls(
            &fixture.mail(OWNER),
            Some(77),
            &fixture.connector,
            budget
        )
        .await
        .unwrap(),
        IdleOutcome::LeaseEnded
    );
    assert!(started.elapsed() >= Duration::from_millis(1500));
    assert!(started.elapsed() < Duration::from_secs(5));
    fixture.drained().await;
    assert_eq!(fixture.count("DONE"), 1);
    let error = crate::imap::idle_inbox_with_tls(
        &fixture.mail(OWNER),
        Some(78),
        &fixture.connector,
        Duration::from_secs(4),
    )
    .await
    .unwrap_err();
    assert_eq!(error.body["code"], "imap_idle_mailbox_changed");
    fixture.drained().await;
    assert_eq!(fixture.count("IDLE"), 1);
    fixture.close().await;
}

#[tokio::test]
async fn dropping_idle_during_init_wait_or_done_closes_owned_socket() {
    for (mode, phase) in [
        (Mode::HoldInit, "IDLE"),
        (Mode::Quiet, "CONTINUE"),
        (Mode::HoldDone, "DONE"),
    ] {
        let fixture = Fixture::new(mode).await;
        let mail = fixture.mail(OWNER);
        let connector = fixture.connector.clone();
        let job = tokio::spawn(async move {
            crate::imap::idle_inbox_with_tls(&mail, None, &connector, Duration::from_secs(10)).await
        });
        fixture.until(|| fixture.count(phase) == 1).await;
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        fixture.drained().await;
        assert_eq!(fixture.count("DONE"), usize::from(mode == Mode::HoldDone));
        assert_eq!(fixture.count("LOGIN"), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn idle_settings_keep_owner_epochs_across_aba_without_restarting_on_unrelated_edits() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    enabled(&app, fixture.mail(OWNER)).await;
    let original = app
        .db(|db| Ok(db.idle_settings.0.borrow().scopes[&inbox_key(OWNER)].clone()))
        .await
        .unwrap();
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let (_stop, stopped) = watch::channel(false);
    let worker = tokio::spawn(lease(
        app.clone(),
        original.clone(),
        settings,
        stopped,
        fixture.connector.clone(),
        Duration::from_secs(10),
    ));
    fixture.until(|| fixture.count("CONTINUE") == 1).await;
    app.db(|db| {
        let mut config = db.settings()?;
        config["preferences"]["theme"] = "dark".into();
        config["backgroundJobs"] = json!([]);
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(still_current(&app, &original).await);
    let other = fixture.mail("other@example.invalid");
    app.db(move |db| {
        let mut config = db.settings()?;
        config["mailAccounts"]["other@example.invalid"] = other;
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(still_current(&app, &original).await);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(!worker.is_finished());
    assert_eq!(fixture.count("LOGIN"), 1);
    let mail = fixture.mail(OWNER);
    app.db(move |db| {
        let mut config = db.settings()?;
        let mut replacement = mail.clone();
        replacement["password"] = "another-fictional-value".into();
        config["mailAccounts"][OWNER] = replacement;
        db.set_settings(&config)?;
        config["mailAccounts"][OWNER] = mail;
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(!still_current(&app, &original).await);
    let renewed = app
        .db(|db| Ok(db.idle_settings.0.borrow().scopes[&inbox_key(OWNER)].clone()))
        .await
        .unwrap();
    assert!(renewed.generation > original.generation);
    assert_eq!(renewed.connection, original.connection);
    let (_, outcome) = tokio::time::timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap();
    assert!(outcome.is_none());
    fixture.drained().await;
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 1);
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn speculative_settings_rollback_cannot_authorize_a_socket() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    let (stop, _hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    let (written, ready) = oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let mail = fixture.mail(OWNER);
    let writing = app.clone();
    let transaction = tokio::spawn(async move {
        writing
            .db(move |db| {
                db.transaction(|db| {
                    db.set_settings(
                        &json!({"mailAccounts":{OWNER:mail},"preferences":{"syncInterval":30}}),
                    )?;
                    written.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(5)).unwrap();
                    Err::<(), _>(Error::conflict("fixture rollback"))
                })
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    assert!(transaction.await.unwrap().is_err());
    app.db(|db| {
        assert!(db.idle_settings.0.borrow().scopes.is_empty());
        assert!(desired(&db.settings()?).scopes.is_empty());
        Ok(())
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
    enabled(&app, fixture.mail(OWNER)).await;
    fixture.until(|| fixture.count("CONTINUE") == 1).await;
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn watcher_revokes_disable_disconnect_credentials_origin_and_inbox_scope_immediately() {
    for change in ["disable", "disconnect", "password", "origin", "scope"] {
        let fixture = Fixture::new(Mode::Quiet).await;
        let (app, path) = workspace();
        let original = fixture.mail(OWNER);
        enabled(&app, original.clone()).await;
        let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
        let scope = settings.borrow().scopes[&inbox_key(OWNER)].clone();
        let (_stop, stopped) = watch::channel(false);
        let worker = tokio::spawn(lease(
            app.clone(),
            scope,
            settings,
            stopped,
            fixture.connector.clone(),
            Duration::from_secs(10),
        ));
        fixture.until(|| fixture.count("CONTINUE") == 1).await;
        app.db(move |db| {
            let mut config = db.settings()?;
            match change {
                "disable" => config["preferences"]["syncInterval"] = 0.into(),
                "disconnect" => { config["mailAccounts"][OWNER] = Value::Null; config["mail"] = Value::Null; },
                "password" => config["mailAccounts"][OWNER]["password"] = "new-fictional".into(),
                "origin" => config["mailAccounts"][OWNER]["imapHost"] = "other.example.invalid".into(),
                _ => config["imports"] = json!({OWNER:{"connectionId":original["connectionId"],"options":{"inbox":false,"sent":true}}}),
            }
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
        let (_, result) = tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_none(), "revoked worker must not publish a result");
        fixture.drained().await;
        assert_eq!(fixture.count("DONE"), 0);
        assert_eq!(fixture.count("LOGIN"), 1);
        close_workspace(app, path);
        fixture.close().await;
    }
}

#[tokio::test]
async fn idle_uses_no_mailbox_gate_and_watches_only_each_owners_saved_inbox_scope() {
    let fixture = Fixture::new(Mode::Changed).await;
    let (app, path) = workspace();
    let mail = fixture.mail(OWNER);
    let sent_only = fixture.mail("sent-only@example.invalid");
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:mail,"sent-only@example.invalid":sent_only},
            "preferences":{"syncInterval":30},"imports":{"sent-only@example.invalid":{"connectionId":sent_only["connectionId"],"options":{"sent":true}}}}))?;
        Ok(())
    }).await.unwrap();
    let gate = app.0.mailbox.lock().await;
    let (stop, mut hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    let hint = tokio::time::timeout(Duration::from_secs(3), hints.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hint.scope.owner, OWNER);
    assert!(
        fixture
            .state
            .commands
            .lock()
            .unwrap()
            .iter()
            .all(|(owner, _, _)| owner == OWNER)
    );
    assert!(app.0.mailbox.try_lock().is_err());
    drop(hint);
    drop(gate);
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn idle_socket_limit_fair_rotation_and_shutdown_are_owned() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    let mut accounts = serde_json::Map::new();
    for number in 0..6 {
        let owner = format!("owner-{number}@example.invalid");
        accounts.insert(owner.clone(), fixture.mail(&owner));
    }
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":accounts,"preferences":{"syncInterval":30}}))?;
        Ok(())
    })
    .await
    .unwrap();
    let (stop, _hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    fixture
        .until(|| {
            fixture
                .state
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, command, _)| command == "LOGIN")
                .map(|(owner, _, _)| owner)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == 6
        })
        .await;
    assert!(fixture.state.peak.load(Ordering::SeqCst) <= SOCKET_LIMIT);
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn dropping_service_idle_task_aborts_and_drains_its_children_without_a_mailbox_lock() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    enabled(&app, fixture.mail(OWNER)).await;
    let (_stop, stopped) = watch::channel(false);
    let worker_app = app.clone();
    let connector = fixture.connector.clone();
    let worker = tokio::spawn(async move {
        run_with_policy(
            &worker_app,
            stopped,
            connector,
            Policy {
                lease: Duration::from_secs(10),
                ..fast_policy()
            },
        )
        .await;
    });
    fixture.until(|| fixture.count("CONTINUE") == 1).await;
    assert!(app.0.mailbox.try_lock().is_ok());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    fixture.drained().await;
    app.db(|_| Ok(())).await.unwrap();
    assert!(app.0.mailbox.try_lock().is_ok());
    assert_eq!(fixture.count("LOGIN"), 1);
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn notification_connect_and_real_sync_consumer_respect_owned_persisted_read_backoff() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    let mail = fixture.mail(OWNER);
    let other = fixture.mail("other@example.invalid");
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:mail,"other@example.invalid":other},
            "preferences":{"syncInterval":30},
            "imports":{"other@example.invalid":{"connectionId":other["connectionId"],"options":{"sent":true}}},
            "mailReadBackoffs":{OWNER:{"connection":crate::folders::connection_version(&mail),
                "nextRetryAt":"2099-01-01T00:00:00.000Z","retryCount":4}},
            "backgroundSyncErrors":[{"accountId":"other@example.invalid","code":"mail_sync_failed","error":"fixture retained"}]}))?;
        Ok(())
    }).await.unwrap();
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let scope = settings.borrow().scopes[&inbox_key(OWNER)].clone();
    let error = ready_to_connect(&app, &scope).await.unwrap_err();
    assert_eq!(error.body["code"], "rate_limited");
    let (_stop, stopped) = watch::channel(false);
    let (_, result) = lease(
        app.clone(),
        scope.clone(),
        settings.clone(),
        stopped.clone(),
        fixture.connector.clone(),
        Duration::from_secs(2),
    )
    .await;
    assert!(
        result.is_none(),
        "The persisted wait also revokes the lease before it opens a socket"
    );
    let pending = Pending::default();
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    sender
        .send(pending.claim(scope).unwrap())
        .await
        .unwrap_or_else(|_| panic!("fixture channel closed"));
    drop(sender);
    consume(&app, settings, stopped, receiver).await;
    let config = app.settings().await.unwrap();
    let errors = config["backgroundSyncErrors"].as_array().unwrap();
    assert_eq!(
        errors.len(),
        1,
        "An ineligible hint does not start a sync or rewrite unrelated errors"
    );
    assert_eq!(
        config["mailReadBackoffs"][OWNER]["nextRetryAt"],
        "2099-01-01T00:00:00.000Z"
    );
    assert!(
        errors
            .iter()
            .any(|error| error["accountId"] == "other@example.invalid"
                && error["error"] == "fixture retained")
    );
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
    assert!(app.0.mailbox.try_lock().is_ok());
    assert!(pending.0.lock().unwrap().is_empty());
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn notification_flood_coalesces_through_inflight_hint_and_respects_debounce() {
    let fixture = Fixture::new(Mode::Flood).await;
    let (app, path) = workspace();
    enabled(&app, fixture.mail(OWNER)).await;
    let (stop, mut hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    let first = tokio::time::timeout(Duration::from_secs(3), hints.recv())
        .await
        .unwrap()
        .unwrap();
    fixture.until(|| fixture.count("DONE") >= 3).await;
    assert!(
        hints.try_recv().is_err(),
        "duplicate owner hints must coalesce while pending or running"
    );
    let logins = fixture
        .state
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, command, _)| command == "LOGIN")
        .map(|(_, _, at)| *at)
        .collect::<Vec<_>>();
    assert!(
        logins
            .windows(2)
            .all(|pair| pair[1].duration_since(pair[0]) >= Duration::from_millis(200))
    );
    drop(first);
    let next = tokio::time::timeout(Duration::from_secs(3), hints.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.scope.owner, OWNER);
    drop(next);
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, path);
    fixture.close().await;
}

#[tokio::test]
async fn transport_failure_backs_off_but_capability_auth_and_protocol_failures_do_not_retry() {
    let fixture = Fixture::new(Mode::Closed).await;
    let (app, path) = workspace();
    enabled(&app, fixture.mail(OWNER)).await;
    let (stop, mut hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    fixture.until(|| fixture.count("IDLE") >= 3).await;
    let logins = fixture
        .state
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, command, _)| command == "LOGIN")
        .map(|(_, _, at)| *at)
        .collect::<Vec<_>>();
    assert!(logins[1].duration_since(logins[0]) >= Duration::from_millis(150));
    assert!(logins[2].duration_since(logins[1]) >= Duration::from_millis(300));
    assert!(hints.try_recv().is_err());
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, path);
    fixture.close().await;
    for mode in [Mode::Missing, Mode::LoginNo, Mode::DoneWrongTag] {
        let fixture = Fixture::new(mode).await;
        let (app, path) = workspace();
        enabled(&app, fixture.mail(OWNER)).await;
        let (stop, mut hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
        fixture.until(|| fixture.count("LOGIN") == 1).await;
        fixture.drained().await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(fixture.count("LOGIN"), 1);
        assert!(hints.try_recv().is_err());
        stop_manager(stop, manager, &fixture).await;
        close_workspace(app, path);
        fixture.close().await;
    }
}

#[tokio::test]
async fn stale_hint_waiting_for_mailbox_gate_cannot_start_a_read_after_aba() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, path) = workspace();
    enabled(&app, fixture.mail(OWNER)).await;
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let scope = settings.borrow().scopes[&inbox_key(OWNER)].clone();
    let pending = Pending::default();
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    sender
        .send(pending.claim(scope).unwrap())
        .await
        .unwrap_or_else(|_| panic!("closed fixture channel"));
    let (stop, stopped) = watch::channel(false);
    let gate = app.0.mailbox.lock().await;
    let consumer_app = app.clone();
    let worker =
        tokio::spawn(async move { consume(&consumer_app, settings, stopped, receiver).await });
    tokio::task::yield_now().await;
    app.db(|db| {
        db.set_settings(&json!({"preferences":{"syncInterval":0}}))?;
        db.set_settings(&json!({"preferences":{"syncInterval":30}}))?;
        Ok(())
    })
    .await
    .unwrap();
    drop(gate);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !pending.0.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
    assert!(app.0.mailbox.try_lock().is_ok());
    stop.send(true).unwrap();
    worker.await.unwrap();
    drop(sender);
    close_workspace(app, path);
    fixture.close().await;
}

#[test]
fn pending_hints_are_bounded_and_owned_until_dropped() {
    let pending = Pending::default();
    let mut hints = Vec::new();
    for number in 0..SOCKET_LIMIT {
        let scope = Scope {
            owner: format!("owner-{number}@example.invalid"),
            connection: Value::Null,
            origin: "fictional".into(),
            path: "INBOX".into(),
            selection: None,
            owner_generation: 1,
            validity: None,
            generation: 1,
        };
        hints.push(pending.claim(scope.clone()).unwrap());
        assert!(pending.claim(scope).is_none());
    }
    let extra = Scope {
        owner: "extra@example.invalid".into(),
        connection: Value::Null,
        origin: "fictional".into(),
        path: "INBOX".into(),
        selection: None,
        owner_generation: 2,
        validity: None,
        generation: 2,
    };
    assert!(pending.claim(extra.clone()).is_none());
    drop(hints.pop());
    assert!(pending.claim(extra).is_some());
    drop(hints);
    assert!(pending.0.lock().unwrap().is_empty());
}

#[test]
fn notification_scope_uses_only_the_current_import_and_saved_uidvalidity_format() {
    let mail = json!({"provider":"imap","email":OWNER,"imapHost":"mail.example.invalid",
        "password":"fictional","connectionId":"current"});
    let mut config = json!({"mailAccounts":{OWNER:mail},"preferences":{"syncInterval":30},
        "imports":{OWNER:{"connectionId":"obsolete","options":{"sent":true}}},
        "imapSync":{OWNER:{"folders":{"INBOX":{"connection":crate::folders::connection_version(&mail),"validity":"77"}}}}});
    let scope = desired(&config).scopes.remove(&inbox_key(OWNER)).unwrap();
    assert_eq!(scope.validity, Some(77));
    assert_eq!(scope.connection, mail);
    config["imports"][OWNER]["connectionId"] = "current".into();
    assert!(
        desired(&config).scopes.is_empty(),
        "current Sent-only scope excludes Inbox"
    );
    config["imports"][OWNER]["options"]["inbox"] = true.into();
    for (value, expected) in [
        (json!(77), Some(77)),
        (json!("77"), Some(77)),
        (json!("0"), None),
        (json!("+77"), None),
        (json!("4294967296"), None),
        (Value::Null, None),
    ] {
        config["imapSync"][OWNER]["folders"]["INBOX"]["validity"] = value;
        assert_eq!(
            desired(&config).scopes[&inbox_key(OWNER)].validity,
            expected
        );
    }
    config["imapSync"][OWNER]["folders"]["INBOX"]["validity"] = "77".into();
    config["imapSync"][OWNER]["folders"]["INBOX"]["connection"] = json!(["obsolete"]);
    assert_eq!(desired(&config).scopes[&inbox_key(OWNER)].validity, None);
}

#[tokio::test]
async fn update_quiescing_pauses_owned_leases_then_resumes_or_shuts_down() {
    for resume in [true, false] {
        let fixture = Fixture::new(Mode::Quiet).await;
        let (app, path) = workspace();
        enabled(&app, fixture.mail(OWNER)).await;
        let (stop, _hints, manager) = start_manager(
            &app,
            &fixture,
            Policy {
                lease: Duration::from_secs(10),
                ..fast_policy()
            },
        )
        .await;
        fixture.until(|| fixture.count("CONTINUE") == 1).await;
        app.0.restarting.store(true, Ordering::Release);
        fixture.drained().await;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(
            !manager.is_finished(),
            "quiescing must not end the service worker"
        );
        assert_eq!(fixture.count("LOGIN"), 1);
        assert_eq!(
            fixture.count("DONE"),
            0,
            "cancellation closes the read-only socket"
        );
        if resume {
            app.0.restarting.store(false, Ordering::Release);
            fixture.until(|| fixture.count("CONTINUE") == 2).await;
        }
        stop_manager(stop, manager, &fixture).await;
        assert_eq!(fixture.count("LOGIN"), if resume { 2 } else { 1 });
        assert!(app.0.mailbox.try_lock().is_ok());
        close_workspace(app, path);
        fixture.close().await;
    }
}

#[tokio::test]
async fn quiescing_preserves_blocked_generations_and_transport_retry_deadlines() {
    for mode in [
        Mode::Missing,
        Mode::LoginNo,
        Mode::DoneWrongTag,
        Mode::Closed,
    ] {
        let fixture = Fixture::new(mode).await;
        let (app, path) = workspace();
        enabled(&app, fixture.mail(OWNER)).await;
        let policy = Policy {
            retry_min: Duration::from_secs(4),
            retry_max: Duration::from_secs(8),
            ..fast_policy()
        };
        let (stop, mut hints, manager) = start_manager(&app, &fixture, policy).await;
        fixture.until(|| fixture.count("LOGIN") == 1).await;
        fixture.drained().await;
        app.0.restarting.store(true, Ordering::Release);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!manager.is_finished());
        assert_eq!(fixture.count("LOGIN"), 1);
        app.0.restarting.store(false, Ordering::Release);
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(
            fixture.count("LOGIN"),
            1,
            "pause must not reset failure policy"
        );
        assert!(hints.try_recv().is_err());
        if mode == Mode::Closed {
            fixture.until(|| fixture.count("LOGIN") == 2).await;
            let at = fixture
                .state
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, command, _)| command == "LOGIN")
                .map(|(_, _, at)| *at)
                .collect::<Vec<_>>();
            assert!(at[1].duration_since(at[0]) >= policy.retry_min);
        }
        stop_manager(stop, manager, &fixture).await;
        close_workspace(app, path);
        fixture.close().await;
    }
}

#[tokio::test]
async fn a_real_notification_sync_only_queues_the_existing_opted_in_arrival_policy() {
    for arrival in [false, true] {
        let fixture = Fixture::new(Mode::Sync).await;
        let (app, path) = workspace();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model_url = format!("http://{}", listener.local_addr().unwrap());
        let model_calls = Arc::new(AtomicUsize::new(0));
        let calls = model_calls.clone();
        let router = axum::Router::new().fallback(move || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        });
        let (model_stop, stopped_model) = oneshot::channel();
        let model = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped_model.await;
                })
                .await
                .unwrap();
        });
        let mail = fixture.mail(OWNER);
        let other = fixture.mail("other@example.invalid");
        app.db(move |db| {
            let policy = crate::policy::update(&json!({}), &json!({
                "enabled":true,"triggers":{"onArrival":arrival,"scheduledSummary":false,"starredOnly":false,"inboxOnly":true},
                "behaviors":{"summary":true},"content":{"subject":true,"body":true},"folders":{"inbox":true}
            }))?;
            db.set_settings(&json!({"mailAccounts":{OWNER:mail,"other@example.invalid":other},
                "activeAccount":"other@example.invalid","preferences":{"syncInterval":30},"policy":policy,
                "ai":{"baseUrl":model_url,"model":"fictional-trap","apiKey":"fictional"},
                "imapSync":{OWNER:{"folders":{"INBOX":{"connection":crate::folders::connection_version(&mail),"validity":"77","uid":0,"more":false}}}}
            }))?;
            Ok(())
        }).await.unwrap();
        let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
        let scope = settings.borrow().scopes[&inbox_key(OWNER)].clone();
        assert_eq!(scope.validity, Some(77));
        let (stop, stopped) = watch::channel(false);
        let (scope, result) = lease(
            app.clone(),
            scope,
            settings.clone(),
            stopped.clone(),
            fixture.connector.clone(),
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(result.unwrap().unwrap(), IdleOutcome::Changed);
        let pending = Pending::default();
        let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
        app.0.restarting.store(true, Ordering::Release);
        sender
            .send(pending.claim(scope.clone()).unwrap())
            .await
            .unwrap_or_else(|_| panic!("closed hint channel"));
        let worker_app = app.clone();
        let connector = fixture.connector.clone();
        let consumer = tokio::spawn(async move {
            consume_with_tls(&worker_app, settings, stopped, receiver, Some(&connector)).await;
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !pending.0.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !consumer.is_finished(),
            "a paused hint must not terminate the consumer"
        );
        assert_eq!(
            fixture.count("LOGIN"),
            1,
            "quiescing must not start a sync connection"
        );
        app.0.restarting.store(false, Ordering::Release);
        sender
            .send(pending.claim(scope).unwrap())
            .await
            .unwrap_or_else(|_| panic!("consumer did not resume"));
        drop(sender);
        tokio::time::timeout(Duration::from_secs(8), consumer)
            .await
            .unwrap()
            .unwrap();
        drop(stop);
        fixture.drained().await;
        app.db(move |db| {
            let rows = db.list(OWNER)?;
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["subject"], "Synthetic idle arrival");
            assert_eq!(
                rows[0]["body"].as_str().unwrap().trim(),
                "Synthetic notification body."
            );
            assert!(db.list("other@example.invalid")?.is_empty());
            let config = db.settings()?;
            assert!(
                config["backgroundSyncErrors"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(config["imapSync"][OWNER]["folders"]["INBOX"]["uid"], 1);
            let jobs = config["automation"][OWNER]["jobs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert_eq!(jobs.len(), usize::from(arrival));
            if arrival {
                assert_eq!(jobs[0]["kind"], "arrival");
                assert_eq!(jobs[0]["status"], "queued");
                assert_eq!(jobs[0]["messageIds"], json!([rows[0]["id"]]));
                assert!(jobs[0]["startedAt"].is_null());
            }
            assert!(config["automation"]["other@example.invalid"].is_null());
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            fixture.count("UID") >= 4,
            "successful sync must read and reconcile real fixture mail"
        );
        assert_eq!(fixture.count("IDLE"), 1);
        assert_eq!(fixture.count("DONE"), 1);
        assert!(
            fixture
                .state
                .commands
                .lock()
                .unwrap()
                .iter()
                .all(|(owner, _, _)| owner == OWNER)
        );
        assert_eq!(model_calls.load(Ordering::SeqCst), 0);
        assert!(pending.0.lock().unwrap().is_empty());
        model_stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), model)
            .await
            .unwrap()
            .unwrap();
        close_workspace(app, path);
        fixture.close().await;
    }
}

mod selected;
