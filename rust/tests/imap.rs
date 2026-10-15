use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::FutureExt;
use lettre::transport::smtp::client::{Certificate, TlsParameters};
use morrow_search::{imap, store::string};
use serde_json::{Value, json};
use std::{
    future::Future,
    io,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{ServerConfig, crypto::ring, pki_types::PrivatePkcs8KeyDer},
};

const OWNER: &str = "owner@example.invalid";
const SENT: &str = "已寄件";
const SENT_WIRE: &str = "&XfJbxE72-";
const HEADER: &str = "From: Fixture <owner@example.invalid>\r\nTo: visible@example.invalid\r\nSubject: Fixture message\r\nDate: Wed, 23 Sep 2026 12:00:00 +0000\r\nMessage-ID: <fixture@example.invalid>\r\n";

#[path = "imap/read_session.rs"]
mod read_session;

#[tokio::test]
async fn refused_imap_connection_is_a_provider_failure_not_a_workspace_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mail = json!({"provider":"imap","email":OWNER,"imapHost":"127.0.0.1","imapPort":port,"password":"fictional-only"});
    let connector = native_tls::TlsConnector::new().unwrap();
    for result in [
        imap::folders_with_tls(&mail, &connector).await,
        imap::management_folders_with_tls(&mail, &connector).await,
    ] {
        let error = result.unwrap_err();
        assert_eq!(error.status, 502);
        assert_eq!(error.body["code"], "provider_network");
        assert_eq!(
            error.body["error"],
            morrow_search::providers::remote_error().body["error"]
        );
    }
}

#[tokio::test]
async fn custom_folder_writes_encode_names_protect_special_use_and_check_uidvalidity() {
    let fixture = ImapFixture::new(ImapScenario {
        extra_folders: "* LIST (\\Archive) \"/\" \"Protected archive\"\r\n",
        ..Default::default()
    })
    .await;
    let catalog = imap::management_folders_with_tls(&fixture.mail, &fixture.connector)
        .await
        .unwrap();
    assert!(
        catalog
            .iter()
            .any(|v| v["id"] == "Protected archive" && v["editable"] == false)
    );
    for id in ["INBOX", SENT, "Protected archive"] {
        assert!(
            imap::manage_folder_with_tls(&fixture.mail, "delete", id, "", &[], &fixture.connector)
                .await
                .is_err()
        );
    }
    assert!(!fixture.commands().iter().any(|v| v.starts_with("DELETE ")));
    let old = "項目 & stuff";
    let target = "已寄件/New";
    let changes = vec![json!({"oldId":old,"newName":target})];
    let applied = imap::manage_folder_with_tls(
        &fixture.mail,
        "rename",
        old,
        target,
        &changes,
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(applied[0]["uidValidity"], 55);
    assert!(
        fixture
            .commands()
            .iter()
            .any(|v| v == "RENAME \"&mAV27g- &- stuff\" \"&XfJbxE72-/New\"")
    );
    imap::manage_folder_with_tls(&fixture.mail, "create", "", target, &[], &fixture.connector)
        .await
        .unwrap();
    imap::manage_folder_with_tls(&fixture.mail, "delete", old, "", &[], &fixture.connector)
        .await
        .unwrap();
    assert!(
        imap::manage_folder_with_tls(
            &fixture.mail,
            "create",
            "",
            "bad\r\nDELETE INBOX",
            &[],
            &fixture.connector
        )
        .await
        .is_err()
    );
    fixture.update(|v| v.renamed_validity = Some(66));
    assert!(
        imap::manage_folder_with_tls(
            &fixture.mail,
            "move",
            old,
            target,
            &changes,
            &fixture.connector
        )
        .await
        .is_err()
    );
    fixture.update(|v| v.folder_write_failure = true);
    let before = fixture
        .commands()
        .iter()
        .filter(|v| v.starts_with("DELETE "))
        .count();
    assert!(
        imap::manage_folder_with_tls(&fixture.mail, "delete", old, "", &[], &fixture.connector)
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|v| v.starts_with("DELETE "))
            .count(),
        before + 1
    );
}
type Log = Arc<Mutex<Vec<String>>>;

async fn checked_session(future: impl Future<Output = io::Result<()>>, failures: Log) {
    match tokio::time::timeout(
        Duration::from_secs(60),
        AssertUnwindSafe(future).catch_unwind(),
    )
    .await
    {
        Ok(Ok(_)) => {} // Peer disconnects are expected in rejection tests.
        Ok(Err(_)) => failures
            .lock()
            .unwrap()
            .push("Protocol fixture assertion failed".into()),
        Err(_) => failures
            .lock()
            .unwrap()
            .push("Protocol fixture timed out".into()),
    }
}

fn tls() -> (Vec<u8>, TlsAcceptor) {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()]).unwrap();
    let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
        )
        .unwrap();
    (cert.der().to_vec(), TlsAcceptor::from(Arc::new(config)))
}
fn trusted(cert: &[u8]) -> native_tls::TlsConnector {
    native_tls::TlsConnector::builder()
        .add_root_certificate(native_tls::Certificate::from_der(cert).unwrap())
        .build()
        .unwrap()
}
fn smtp_trusted(cert: &[u8]) -> TlsParameters {
    TlsParameters::builder("127.0.0.1".into())
        .add_root_certificate(Certificate::from_der(cert.to_vec()).unwrap())
        .build()
        .unwrap()
}
async fn line<S: AsyncRead + Unpin>(stream: &mut BufReader<S>) -> io::Result<Option<String>> {
    let mut value = String::new();
    let size = stream.read_line(&mut value).await?;
    if size == 0 {
        return Ok(None);
    }
    assert!(size < 100000, "fixture command exceeded its bound");
    Ok(Some(value.trim_end_matches(['\r', '\n']).to_owned()))
}
async fn write<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut BufReader<S>,
    value: &str,
) -> io::Result<()> {
    stream.get_mut().write_all(value.as_bytes()).await?;
    stream.get_mut().flush().await
}

#[derive(Clone)]
struct ImapScenario {
    changed_uids: Option<Vec<u32>>,
    ignore_changed_since: bool,
    omit_changed_modseq: bool,
    pause_discovery: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    pause_flags: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    truncate_discovery: bool,
    highest_modseq: Option<u64>,
    changed_modseq: Option<u64>,
    extension_rejected: bool,
    enable_ignored: bool,
    nomodseq: bool,
    validity: u32,
    count: u32,
    capabilities: &'static str,
    sent: bool,
    auth_failure: bool,
    large: bool,
    oversized_body: bool,
    wrong_uid: bool,
    duplicate_uid: bool,
    oversized_header: bool,
    announced_body: Option<&'static str>,
    large_search: bool,
    body_size: usize,
    uidnext: Option<u32>,
    omit_uidnext: bool,
    search_ids: Option<Vec<u32>>,
    search_outside: bool,
    hidden_folders: usize,
    extra_folders: &'static str,
    list_completion: &'static str,
    examine_failure: Option<(&'static str, &'static str)>,
    mapping: Option<&'static str>,
    extra_mapping: Option<&'static str>,
    renamed_validity: Option<u32>,
    folder_write_failure: bool,
    fetch_failure: bool,
    remote_read: bool,
    remote_starred: bool,
    remote_draft: bool,
    missing_uid: Option<u32>,
    raw_message: Option<String>,
    internal_date: &'static str,
    omitted_metadata_uid: Option<u32>,
    absent_body_uid: Option<u32>,
    nil_body_uid: Option<u32>,
    expunged_uid: Option<u32>,
    recheck_failure: bool,
    disconnect_on_body: bool,
    truncated_body: bool,
    discovery_vanished: Option<DiscoveryVanished>,
}
#[derive(Clone, Copy)]
struct DiscoveryVanished {
    earlier: bool,
    uid: u32,
}
impl Default for ImapScenario {
    fn default() -> Self {
        Self {
            changed_uids: None,
            ignore_changed_since: false,
            omit_changed_modseq: false,
            pause_discovery: None,
            pause_flags: None,
            truncate_discovery: false,
            highest_modseq: None,
            changed_modseq: None,
            extension_rejected: false,
            enable_ignored: false,
            nomodseq: false,
            validity: 55,
            count: 60,
            capabilities: "IMAP4rev1 MOVE UIDPLUS",
            sent: true,
            auth_failure: false,
            large: false,
            oversized_body: false,
            wrong_uid: false,
            duplicate_uid: false,
            oversized_header: false,
            announced_body: None,
            large_search: false,
            body_size: 0,
            uidnext: None,
            omit_uidnext: false,
            search_ids: None,
            search_outside: false,
            hidden_folders: 1,
            extra_folders: "",
            list_completion: "OK",
            examine_failure: None,
            mapping: Some("88 7 19"),
            extra_mapping: None,
            renamed_validity: None,
            folder_write_failure: false,
            fetch_failure: false,
            remote_read: true,
            remote_starred: true,
            remote_draft: false,
            missing_uid: None,
            raw_message: None,
            internal_date: "23-Sep-2026 12:00:00 +0000",
            omitted_metadata_uid: None,
            absent_body_uid: None,
            nil_body_uid: None,
            expunged_uid: None,
            recheck_failure: false,
            disconnect_on_body: false,
            truncated_body: false,
            discovery_vanished: None,
        }
    }
}
struct ImapFixture {
    mail: Value,
    connector: native_tls::TlsConnector,
    state: Arc<Mutex<ImapScenario>>,
    log: Log,
    failures: Log,
    active_sessions: Arc<std::sync::atomic::AtomicUsize>,
    task: JoinHandle<()>,
}
struct ActiveImapSession(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for ActiveImapSession {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
impl Drop for ImapFixture {
    fn drop(&mut self) {
        self.task.abort();
        if !std::thread::panicking() {
            assert!(
                self.failures.lock().unwrap().is_empty(),
                "IMAP fixture task failed"
            );
        }
    }
}
impl ImapFixture {
    async fn new(state: ImapScenario) -> Self {
        let (cert, acceptor) = tls();
        let connector = trusted(&cert);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let failures = Arc::new(Mutex::new(Vec::new()));
        let saved_failures = failures.clone();
        let state = Arc::new(Mutex::new(state));
        let active_sessions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let saved_active_sessions = active_sessions.clone();
        let (saved_log, saved_state) = (log.clone(), state.clone());
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    result=listener.accept()=>{
                        let Ok((socket,_))=result else{break};
                        let (acceptor,log,state)=(acceptor.clone(),saved_log.clone(),saved_state.clone());
                        let active = saved_active_sessions.clone();
                        sessions.spawn(checked_session(async move {
                            let Ok(socket)=acceptor.accept(socket).await else{return Ok(())};
                            active.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let _active = ActiveImapSession(active);
                            imap_session(socket,state,log).await
                        }, saved_failures.clone()));
                    },
                    _=sessions.join_next(),if !sessions.is_empty()=>{}
                }
            }
        });
        Self {
            mail: json!({"provider":"imap","email":OWNER,"password":"fixture-password","imapHost":"127.0.0.1","imapPort":port}),
            connector,
            state,
            log,
            failures,
            active_sessions,
            task,
        }
    }
    fn commands(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn update(&self, change: impl FnOnce(&mut ImapScenario)) {
        change(&mut self.state.lock().unwrap());
    }
    async fn fetch(&self, options: Value) -> morrow_search::error::Result<Value> {
        imap::fetch_page_with_tls(&self.mail, &options, &self.connector).await
    }
    async fn organize(&self, destination: Value) -> morrow_search::error::Result<Value> {
        imap::organize_with_tls(
            &self.mail,
            &json!({"imapOrigin":imap::server_origin(&self.mail).unwrap(),"id":"stable-local","remoteId":"imap:55:7","providerFolderId":"INBOX"}),
            &destination,
            "move",
            &self.connector,
        )
        .await
    }
}

struct CacheWorkspace {
    root: std::path::PathBuf,
    app: Option<morrow_search::service::App>,
}
impl Drop for CacheWorkspace {
    fn drop(&mut self) {
        drop(self.app.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl CacheWorkspace {
    async fn new(mail: &Value) -> Self {
        let root = std::env::temp_dir().join(format!("morrow-imap-cache-{}", uuid::Uuid::new_v4()));
        let app = morrow_search::service::App::open(&root, 0, "fictional-cache".into(), "".into())
            .unwrap();
        let saved = mail.clone();
        app.db(move |db| db.set_settings(&json!({"mailAccounts":{OWNER:saved}})))
            .await
            .unwrap();
        Self {
            root,
            app: Some(app),
        }
    }
    fn app(&self) -> &morrow_search::service::App {
        self.app.as_ref().unwrap()
    }
    async fn page(&self, fixture: &ImapFixture, mail: &Value, folder: &str) -> Value {
        let page = imap::fetch_page_cached_with_tls(
            self.app(),
            mail,
            &json!({"folder":folder}),
            &fixture.connector,
        )
        .await
        .unwrap();
        let rows = page["messages"].as_array().unwrap().clone();
        let mail = mail.clone();
        self.app()
            .db(move |db| morrow_search::mail::import_messages(db, &mail, &rows))
            .await
            .unwrap();
        page
    }
}
fn body_requests(fixture: &ImapFixture) -> usize {
    fixture
        .commands()
        .iter()
        .filter(|command| command.contains("BODY.PEEK[]"))
        .count()
}

#[tokio::test]
async fn cached_imap_recent_pages_refresh_both_flag_directions_without_redownloading_bodies() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        ..Default::default()
    })
    .await;
    let workspace = CacheWorkspace::new(&fixture.mail).await;
    let first = workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(body_requests(&fixture), 1);
    let original = &first["messages"][0];
    assert_eq!(original["read"], true);
    fixture.update(|scenario| {
        scenario.remote_read = false;
        scenario.remote_starred = false;
    });
    let next = workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(body_requests(&fixture), 1);
    assert_eq!(next["messages"][0]["read"], false);
    assert_eq!(next["messages"][0]["starred"], false);
    for key in [
        "body",
        "bodyHtml",
        "bodyTruncated",
        "date",
        "senderDate",
        "bodyConnection",
        "bodySize",
    ] {
        assert_eq!(next["messages"][0][key], original[key], "{key}");
    }
    fixture.update(|scenario| scenario.remote_read = true);
    let again = workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(body_requests(&fixture), 1);
    assert_eq!(again["messages"][0]["read"], true);
    for patch in [
        json!({"bodyConnection":null}),
        json!({"contentIncomplete":true}),
        json!({"bodySize":0}),
        json!({"providerDraft":true}),
    ] {
        workspace
            .app()
            .db(move |db| {
                db.update(OWNER, "imap:55:1", &patch)?;
                Ok(())
            })
            .await
            .unwrap();
        let before = body_requests(&fixture);
        workspace.page(&fixture, &fixture.mail, "inbox").await;
        assert_eq!(
            body_requests(&fixture),
            before + 1,
            "Unknown, incomplete or draft bodies must fetch again"
        );
    }
    fixture.update(|scenario| scenario.remote_draft = true);
    let before = body_requests(&fixture);
    for _ in 0..2 {
        let draft = workspace.page(&fixture, &fixture.mail, "inbox").await;
        assert_eq!(draft["messages"][0]["providerDraft"], true);
    }
    assert_eq!(body_requests(&fixture), before + 2);
}

#[tokio::test]
async fn imap_body_reuse_requires_account_folder_uidvalidity_connection_size_and_header_identity() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        raw_message: Some(format!("{HEADER}\r\nFirst body.")),
        ..Default::default()
    })
    .await;
    let workspace = CacheWorkspace::new(&fixture.mail).await;
    workspace.page(&fixture, &fixture.mail, "inbox").await;
    workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(body_requests(&fixture), 1);
    let mut other = fixture.mail.clone();
    other["email"] = "other-cache@example.invalid".into();
    let second = other.clone();
    let primary = fixture.mail.clone();
    workspace
        .app()
        .db(move |db| {
            db.set_settings(
                &json!({"mailAccounts":{OWNER:primary,"other-cache@example.invalid":second}}),
            )
        })
        .await
        .unwrap();
    workspace.page(&fixture, &other, "inbox").await;
    assert_eq!(
        body_requests(&fixture),
        2,
        "A colliding UID from another account must fetch its own body"
    );
    workspace.page(&fixture, &fixture.mail, "sent").await;
    assert_eq!(
        body_requests(&fixture),
        3,
        "A colliding UID in Sent must fetch its own body"
    );
    workspace.page(&fixture, &fixture.mail, "sent").await;
    assert_eq!(body_requests(&fixture), 3);
    fixture.update(|scenario| scenario.validity = 56);
    let new_epoch = workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(new_epoch["messages"][0]["id"], "imap:56:1");
    assert_eq!(body_requests(&fixture), 4);
    let mut reconnected = fixture.mail.clone();
    reconnected["connectionId"] = "new-connection".into();
    let saved = reconnected.clone();
    workspace
        .app()
        .db(move |db| db.set_settings(&json!({"mailAccounts":{OWNER:saved}})))
        .await
        .unwrap();
    workspace.page(&fixture, &reconnected, "inbox").await;
    assert_eq!(body_requests(&fixture), 5);
    fixture.update(|scenario| {
        scenario.raw_message = Some(format!(
            "{}\r\nFirst body.",
            HEADER.replace("fixture@example", "changed@example")
        ))
    });
    let changed = workspace.page(&fixture, &reconnected, "inbox").await;
    assert_eq!(
        changed["messages"][0]["messageId"],
        "<changed@example.invalid>"
    );
    assert_eq!(
        body_requests(&fixture),
        6,
        "Even equal-sized body identities must be proven by current headers"
    );
    fixture.update(|scenario| {
        scenario
            .raw_message
            .as_mut()
            .unwrap()
            .push_str(" Longer body.")
    });
    let larger = workspace.page(&fixture, &reconnected, "inbox").await;
    assert!(string(&larger["messages"][0], "body").contains("Longer body"));
    assert_eq!(body_requests(&fixture), 7);
}
#[tokio::test]
async fn priority_body_proof_requires_complete_imap_headers_before_reusing_cached_content() {
    let raw = format!(
        "Message-ID: <fixture@example.invalid>\r\n{}{}\r\nFull body after a long header.",
        format!("X-Padding: {}\r\n", "x".repeat(120)).repeat(520),
        HEADER.replace("Message-ID: <fixture@example.invalid>\r\n", "")
    );
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        raw_message: Some(raw),
        ..Default::default()
    })
    .await;
    let workspace = CacheWorkspace::new(&fixture.mail).await;
    let first = workspace.page(&fixture, &fixture.mail, "inbox").await;
    assert_eq!(first["messages"][0]["subject"], "Fixture message");
    assert_eq!(first["messages"][0]["fromEmail"], OWNER);
    let second = workspace.page(&fixture, &fixture.mail, "inbox").await;
    for field in [
        "subject",
        "fromName",
        "fromEmail",
        "senderDate",
        "messageId",
        "body",
    ] {
        assert_eq!(
            second["messages"][0][field], first["messages"][0][field],
            "Truncated headers cannot replace complete {field}"
        );
    }
    assert_eq!(
        body_requests(&fixture),
        2,
        "A truncated header cannot prove reusable current metadata"
    );
    let header_commands = fixture
        .commands()
        .into_iter()
        .filter(|command| command.contains("BODY.PEEK[HEADER]<0.65536>"))
        .count();
    assert_eq!(header_commands, 2);
}
fn fixture_message(scenario: &ImapScenario, uid: &str) -> String {
    if let Some(raw) = &scenario.raw_message {
        raw.clone()
    } else if scenario.body_size > 0 {
        format!(
            "{HEADER}\r\n{{536870912}}\r\n{}",
            "x".repeat(scenario.body_size)
        )
    } else {
        format!("{HEADER}\r\nFixture body for UID {uid}.\r\n")
    }
}
async fn imap_session<S: AsyncRead + AsyncWrite + Unpin>(
    socket: S,
    state: Arc<Mutex<ImapScenario>>,
    log: Log,
) -> io::Result<()> {
    let mut stream = BufReader::new(socket);
    write(&mut stream, "* OK IMAP4rev1 fixture {8388000}\r\n").await?;
    while let Some(input) = line(&mut stream).await? {
        let (tag, command) = input.split_once(' ').unwrap();
        let upper = command.to_ascii_uppercase();
        log.lock().unwrap().push(command.into());
        let scenario = state.lock().unwrap().clone();
        if upper.starts_with("LOGIN ") {
            write(
                &mut stream,
                &format!(
                    "{tag} {} login\r\n",
                    if scenario.auth_failure { "NO" } else { "OK" }
                ),
            )
            .await?;
        } else if upper == "CAPABILITY" {
            write(
                &mut stream,
                &format!(
                    "* CAPABILITY {}\r\n{tag} OK capability\r\n",
                    scenario.capabilities
                ),
            )
            .await?;
        } else if upper == "ENABLE QRESYNC" {
            if scenario.extension_rejected {
                write(&mut stream, &format!("{tag} BAD unsupported\r\n")).await?;
            } else {
                write(
                    &mut stream,
                    &format!(
                        "{}\r\n{tag} OK enabled\r\n",
                        if scenario.enable_ignored {
                            "* ENABLED CONDSTORE"
                        } else {
                            "* ENABLED QRESYNC"
                        }
                    ),
                )
                .await?;
            }
        } else if upper.starts_with("LIST ") {
            let sent = if scenario.sent {
                format!("* LIST (\\Sent) \"/\" \"{SENT_WIRE}\"\r\n")
            } else {
                String::new()
            };
            let hidden = (0..scenario.hidden_folders)
                .map(|index| format!("* LIST (\\Noselect) \"/\" \"Hidden{index}\"\r\n"))
                .collect::<String>();
            write(&mut stream,&format!("* LIST () \"/\" \"INBOX\"\r\n{sent}* LIST () \"/\" \"&mAV27g- &- stuff\"\r\n{hidden}{}{tag} {} list\r\n",scenario.extra_folders,scenario.list_completion)).await?;
        } else if upper.starts_with("STATUS ") {
            let mailbox = command
                .strip_prefix("STATUS ")
                .unwrap()
                .split(" (")
                .next()
                .unwrap();
            let validity = if mailbox.contains("/New") {
                scenario.renamed_validity.unwrap_or(scenario.validity)
            } else {
                scenario.validity
            };
            write(&mut stream,&format!("* STATUS {mailbox} (MESSAGES {} UIDVALIDITY {validity})\r\n{tag} OK status\r\n",scenario.count)).await?;
        } else if upper.starts_with("CREATE ")
            || upper.starts_with("RENAME ")
            || upper.starts_with("DELETE ")
        {
            write(
                &mut stream,
                &format!(
                    "{tag} {} folder operation\r\n",
                    if scenario.folder_write_failure {
                        "NO"
                    } else {
                        "OK"
                    }
                ),
            )
            .await?;
        } else if upper.starts_with("EXAMINE ") || upper.starts_with("SELECT ") {
            if let Some((folder, response)) = scenario.examine_failure
                && command.ends_with(&format!("\"{folder}\""))
            {
                write(&mut stream, &format!("{tag} {response}\r\n")).await?;
                continue;
            }
            if scenario.extension_rejected && upper.ends_with("(CONDSTORE)") {
                write(&mut stream, &format!("{tag} BAD unsupported\r\n")).await?;
                continue;
            }
            let extension = if scenario.nomodseq {
                "* OK [NOMODSEQ] unavailable\r\n".to_owned()
            } else {
                scenario
                    .highest_modseq
                    .map(|v| format!("* OK [HIGHESTMODSEQ {v}] stable\r\n"))
                    .unwrap_or_default()
            };
            let next = if scenario.omit_uidnext {
                String::new()
            } else {
                format!(
                    "* OK [UIDNEXT {}] next\r\n",
                    scenario.uidnext.unwrap_or(scenario.count + 1)
                )
            };
            write(&mut stream,&format!("* FLAGS (\\Seen \\Flagged)\r\n* {} EXISTS\r\n* OK [UIDVALIDITY {}] stable\r\n{next}{extension}{tag} OK selected\r\n",scenario.count,scenario.validity)).await?;
        } else if upper.starts_with("UID SEARCH ") {
            if scenario.large_search {
                write(&mut stream, "* SEARCH").await?;
                for _ in 0..9 {
                    write(&mut stream, &" 1000000000".repeat(100000)).await?;
                }
                write(&mut stream, &format!("\r\n{tag} OK search\r\n")).await?;
                continue;
            }
            let (lower, upper) = command
                .rsplit_once("UID ")
                .unwrap()
                .1
                .split_once(':')
                .unwrap();
            let (lower, upper) = (lower.parse::<u32>().unwrap(), upper.parse::<u32>().unwrap());
            let ids = if scenario.search_outside {
                vec![upper + 1]
            } else {
                scenario
                    .search_ids
                    .unwrap_or_else(|| (lower..=upper.min(scenario.count)).collect())
            };
            // SEARCH dates are calendar days, independent of the Date header
            // and its normalized UTC instant (RFC 9051 section 6.4.4).
            let internal =
                chrono::DateTime::parse_from_str(scenario.internal_date, "%d-%b-%Y %H:%M:%S %z")
                    .unwrap()
                    .date_naive();
            let parsed = mail_parser::MessageParser::default()
                .parse(scenario.raw_message.as_deref().unwrap_or(HEADER).as_bytes());
            let sent = parsed
                .as_ref()
                .and_then(|message| message.date())
                .and_then(|date| {
                    chrono::NaiveDate::from_ymd_opt(
                        i32::from(date.year),
                        u32::from(date.month),
                        u32::from(date.day),
                    )
                });
            let terms: Vec<_> = command.split_whitespace().collect();
            let date_matches = terms.windows(2).all(|term| match term[0] {
                "SINCE" => {
                    internal >= chrono::NaiveDate::parse_from_str(term[1], "%d-%b-%Y").unwrap()
                }
                "BEFORE" => {
                    internal < chrono::NaiveDate::parse_from_str(term[1], "%d-%b-%Y").unwrap()
                }
                "SENTSINCE" => sent.is_some_and(|date| {
                    date >= chrono::NaiveDate::parse_from_str(term[1], "%d-%b-%Y").unwrap()
                }),
                "SENTBEFORE" => sent.is_some_and(|date| {
                    date < chrono::NaiveDate::parse_from_str(term[1], "%d-%b-%Y").unwrap()
                }),
                _ => true,
            });
            let ids = ids
                .into_iter()
                .filter(|_| date_matches)
                .filter(|id| scenario.search_outside || (*id >= lower && *id <= upper))
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(" ");
            write(
                &mut stream,
                &format!("* SEARCH {ids}\r\n{tag} OK search\r\n"),
            )
            .await?;
        } else if upper.starts_with("UID STORE ") {
            if scenario.folder_write_failure {
                write(&mut stream, &format!("{tag} NO rejected\r\n")).await?;
                continue;
            }
            {
                let mut value = state.lock().unwrap();
                let enabled = upper.contains("+FLAGS");
                if upper.contains("\\SEEN") {
                    value.remote_read = enabled;
                }
                if upper.contains("\\FLAGGED") {
                    value.remote_starred = enabled;
                }
            }
            write(&mut stream, &format!("{tag} OK stored\r\n")).await?;
        } else if upper.starts_with("UID FETCH ") {
            let args = command.splitn(4, ' ').collect::<Vec<_>>();
            let selected = args[2];
            let fields = args[3];
            if let Some(raw) = scenario
                .raw_message
                .as_ref()
                .filter(|_| fields == "(UID RFC822.SIZE)")
            {
                write(
                    &mut stream,
                    &format!("* 1 FETCH (UID {selected} RFC822.SIZE {})\r\n", raw.len()),
                )
                .await?;
            } else if fields.starts_with("(UID MODSEQ)") {
                if scenario.extension_rejected {
                    write(&mut stream, &format!("{tag} BAD unsupported\r\n")).await?;
                    continue;
                }
                if let Some((entered, resume)) = &scenario.pause_discovery {
                    entered.notify_one();
                    resume.notified().await;
                }
                if let Some(vanished) = scenario.discovery_vanished {
                    let marker = if vanished.earlier { "(EARLIER) " } else { "" };
                    write(
                        &mut stream,
                        &format!("* VANISHED {marker}{}\r\n", vanished.uid),
                    )
                    .await?;
                }
                let (lower, upper) = selected.split_once(':').unwrap();
                let (lower, upper) = (lower.parse::<u32>().unwrap(), upper.parse::<u32>().unwrap());
                assert!(upper >= lower && upper - lower < 1000);
                let since = fields
                    .split("CHANGEDSINCE ")
                    .nth(1)
                    .unwrap()
                    .trim_end_matches(')')
                    .parse::<u64>()
                    .unwrap();
                let modseq = scenario.changed_modseq.or(scenario.highest_modseq).unwrap();
                for uid in lower..=upper.min(scenario.count) {
                    let changed = scenario
                        .changed_uids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&uid));
                    let seq = if changed {
                        modseq
                    } else {
                        modseq.saturating_sub(1)
                    };
                    if (seq <= since && !scenario.ignore_changed_since)
                        || scenario.expunged_uid == Some(uid)
                    {
                        continue;
                    }
                    let uid = if scenario.wrong_uid { upper + 1 } else { uid };
                    let suffix = if scenario.omit_changed_modseq {
                        String::new()
                    } else {
                        format!(" MODSEQ ({seq})")
                    };
                    let row = format!("* 1 FETCH (UID {uid}{suffix})\r\n");
                    if scenario.truncate_discovery {
                        write(&mut stream, &row[..row.len() - 3]).await?;
                        return Ok(());
                    }
                    write(&mut stream, &row).await?;
                    if scenario.duplicate_uid {
                        write(&mut stream, &row).await?;
                    }
                }
            } else if fields.starts_with("(UID FLAGS") && !fields.contains("RFC822.SIZE") {
                if scenario.extension_rejected && fields.contains("MODSEQ") {
                    write(&mut stream, &format!("{tag} BAD unsupported\r\n")).await?;
                    continue;
                }
                if let Some((entered, resume)) = &scenario.pause_flags {
                    entered.notify_one();
                    resume.notified().await;
                }
                let since = fields
                    .split("CHANGEDSINCE ")
                    .nth(1)
                    .and_then(|v| v.split(|c: char| !c.is_ascii_digit()).next())
                    .and_then(|v| v.parse::<u64>().ok());
                if fields.contains("VANISHED")
                    && let Some(uid) = scenario.missing_uid
                {
                    write(&mut stream, &format!("* VANISHED (EARLIER) {uid}\r\n")).await?;
                }
                let highest = scenario.changed_modseq.or(scenario.highest_modseq);
                for (index, uid) in selected.split(',').enumerate() {
                    if scenario.missing_uid == uid.parse().ok() {
                        continue;
                    }
                    let changed = scenario
                        .changed_uids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&uid.parse().unwrap()));
                    let modseq =
                        highest.map(|seq| if changed { seq } else { seq.saturating_sub(1) });
                    if since.is_some_and(|since| modseq.is_some_and(|v| v <= since))
                        && !scenario.ignore_changed_since
                    {
                        continue;
                    }
                    let mut flags = vec!["\\Answered"];
                    if scenario.remote_read && changed {
                        flags.push("\\Seen");
                    }
                    if scenario.remote_starred && changed {
                        flags.push("\\Flagged");
                    }
                    write(
                        &mut stream,
                        &format!(
                            "* {} FETCH (UID {} FLAGS ({}){})\r\n",
                            index + 1,
                            uid,
                            flags.join(" "),
                            if fields.contains("MODSEQ") {
                                modseq.map(|v| format!(" MODSEQ ({v})")).unwrap_or_default()
                            } else {
                                String::new()
                            }
                        ),
                    )
                    .await?;
                }
            } else if fields.contains("RFC822.SIZE") {
                let mut header = if scenario.oversized_header {
                    "x".repeat(65537)
                } else if let Some(raw) = &scenario.raw_message {
                    raw.split_once("\r\n\r\n")
                        .map(|(header, _)| format!("{header}\r\n\r\n"))
                        .unwrap_or_else(|| format!("{HEADER}\r\n"))
                } else {
                    format!("{HEADER}\r\n")
                };
                if !scenario.oversized_header && header.len() > 65536 {
                    header.truncate(65536); // The long-header fixture uses ASCII.
                }
                let flags = [
                    scenario.remote_read.then_some("\\Seen"),
                    scenario.remote_starred.then_some("\\Flagged"),
                    scenario.remote_draft.then_some("\\Draft"),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
                for (index, uid) in selected.split(',').enumerate() {
                    if scenario.omitted_metadata_uid == uid.parse().ok() {
                        continue;
                    }
                    let uid = if scenario.wrong_uid {
                        "99999"
                    } else if scenario.duplicate_uid {
                        selected.split(',').next().unwrap()
                    } else {
                        uid
                    };
                    write(&mut stream,&format!("* {} FETCH (UID {uid} FLAGS ({flags}) RFC822.SIZE {} INTERNALDATE \"{}\" BODY[HEADER] {{{}}}\r\n{header})\r\n",index+1,if scenario.large{6*1024*1024}else{fixture_message(&scenario,uid).len()},scenario.internal_date,header.len())).await?;
                }
            } else if fields.contains("BODY.PEEK[]") {
                if scenario.disconnect_on_body {
                    return Ok(());
                }
                if scenario.absent_body_uid == selected.parse().ok() {
                    write(&mut stream, &format!("{tag} OK fetch\r\n")).await?;
                    continue;
                }
                if scenario.nil_body_uid == selected.parse().ok() {
                    write(
                        &mut stream,
                        &format!("* 1 FETCH (UID {selected} BODY[] NIL)\r\n{tag} OK fetch\r\n"),
                    )
                    .await?;
                    continue;
                }
                if let Some(size) = scenario.announced_body {
                    write(&mut stream, &format!("* 1 FETCH (UID {selected} BODY[] {{")).await?;
                    write(&mut stream, size).await?;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    write(&mut stream, "}\r").await?;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    write(&mut stream, "\n").await?;
                    // No literal payload is sent: a guarded client must close immediately.
                    assert!(line(&mut stream).await?.is_none());
                    return Ok(());
                }
                let mut body = if let Some(raw) = &scenario.raw_message {
                    let range = fields.split('<').nth(1).unwrap().split('>').next().unwrap();
                    let (start, count) = range.split_once('.').unwrap();
                    let start: usize = start.parse().unwrap();
                    let count: usize = count.parse().unwrap();
                    raw[start..raw.len().min(start + count)].to_owned()
                } else if scenario.oversized_body {
                    "x".repeat(5 * 1024 * 1024 + 1)
                } else {
                    fixture_message(&scenario, selected)
                };
                if scenario.truncated_body {
                    body.truncate(body.len().saturating_sub(2));
                }
                write(
                    &mut stream,
                    &format!(
                        "* 1 FETCH (UID {selected} BODY[] {{{}}}\r\n{body})\r\n",
                        body.len()
                    ),
                )
                .await?;
            } else {
                let sequence = if selected == "*" {
                    scenario.count.to_string()
                } else {
                    selected.to_owned()
                };
                for uid in sequence.split(',') {
                    if scenario.expunged_uid != uid.parse().ok() {
                        write(&mut stream, &format!("* 1 FETCH (UID {uid})\r\n")).await?;
                    }
                }
            }
            write(
                &mut stream,
                &format!(
                    "{tag} {} fetch\r\n",
                    if scenario.fetch_failure || (scenario.recheck_failure && fields == "UID") {
                        "NO"
                    } else {
                        "OK"
                    }
                ),
            )
            .await?;
        } else if upper.starts_with("UID MOVE ") {
            if let Some(mapping) = scenario.mapping {
                write(&mut stream, &format!("* OK [COPYUID {mapping}] moved\r\n")).await?;
            }
            let extra = scenario
                .extra_mapping
                .map(|mapping| format!("[COPYUID {mapping}] "))
                .unwrap_or_default();
            write(&mut stream, &format!("{tag} OK {extra}move completed\r\n")).await?;
        } else if upper == "LOGOUT" {
            write(
                &mut stream,
                &format!("* BYE fixture\r\n{tag} OK logout\r\n"),
            )
            .await?;
            break;
        } else {
            panic!("unexpected IMAP fixture command: {command}");
        }
    }
    Ok(())
}

#[tokio::test]
async fn imap_rejects_announced_literal_before_payload_and_bounds_search_responses() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        ..Default::default()
    })
    .await;
    for announced in [
        "536870912",
        "00000536870912",
        "99999999999999999999999999999999999",
    ] {
        fixture.update(|state| state.announced_body = Some(announced));
        let error = tokio::time::timeout(Duration::from_secs(2), fixture.fetch(json!({})))
            .await
            .expect("announced oversized literal must fail before waiting for its body")
            .unwrap_err();
        assert_eq!(error.status, 502);
        if announced.parse::<u32>().is_ok() {
            assert!(
                string(&error.body, "error").contains("8 MiB"),
                "announcement {announced}: {error:?}"
            );
        }
    }
    fixture.update(|state| {
        state.announced_body = None;
        state.large_search = true;
    });
    let error = fixture.fetch(json!({})).await.unwrap_err();
    assert_eq!(error.status, 502);
    assert!(string(&error.body, "error").contains("128 KiB"));
}

#[tokio::test]
async fn imap_guard_allows_large_uid_search_and_resets_for_each_body() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 100000,
        ..Default::default()
    })
    .await;
    let page = fixture.fetch(json!({})).await.unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 50);
    assert_eq!(page["nextCursor"]["uid"], 99951);
    assert!(
        fixture
            .commands()
            .iter()
            .any(|line| line == "UID SEARCH UID 91809:100000")
    );
    fixture.update(|state| {
        state.count = 2;
        state.body_size = 4 * 1024 * 1024;
    });
    let page = fixture.fetch(json!({})).await.unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    assert!(string(&page["messages"][0], "body").starts_with("{536870912}"));
}

#[tokio::test]
async fn imap_sparse_history_checkpoints_ranges_and_rejects_provider_bounds_violations() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        uidnext: Some(1_000_001),
        search_ids: Some(vec![1]),
        ..Default::default()
    })
    .await;
    let first = fixture.fetch(json!({})).await.unwrap();
    assert_eq!(first["messages"], json!([]));
    assert_eq!(first["nextCursor"]["uid"], 737857);
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|line| line.starts_with("UID SEARCH "))
            .count(),
        32
    );
    let second = fixture
        .fetch(json!({"cursor":first["nextCursor"]}))
        .await
        .unwrap();
    assert_eq!(second["nextCursor"]["uid"], 475713);
    let third = fixture
        .fetch(json!({"cursor":second["nextCursor"]}))
        .await
        .unwrap();
    let fourth = fixture
        .fetch(json!({"cursor":third["nextCursor"]}))
        .await
        .unwrap();
    assert_eq!(fourth["messages"].as_array().unwrap().len(), 1);
    assert_eq!(fourth["messages"][0]["remoteId"], "imap:55:1");
    assert!(fourth["nextCursor"].is_null());
    fixture.update(|state| {
        state.search_outside = true;
    });
    let error = fixture.fetch(json!({})).await.unwrap_err();
    assert_ne!(error.body["code"], "provider_network");
    fixture.update(|state| {
        state.search_outside = false;
        state.omit_uidnext = true;
    });
    assert_eq!(
        fixture.fetch(json!({})).await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        fixture
            .commands()
            .iter()
            .any(|line| line == "UID FETCH * UID")
    );
}

#[test]
fn modified_utf7_preserves_node_unicode_folder_identity_and_rejects_controls() {
    for (unicode, wire) in [
        (SENT, SENT_WIRE),
        ("項目 & stuff", "&mAV27g- &- stuff"),
        ("日本語", "&ZeVnLIqe-"),
        ("A&B", "A&-B"),
        ("~peter/mail/台北/日本語", "~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
    ] {
        assert_eq!(imap::encode_folder(unicode).unwrap(), wire);
        assert_eq!(imap::decode_folder(wire).unwrap(), unicode);
    }
    for value in ["📨郵件", "é", "a\"b\\c"] {
        assert_eq!(
            imap::decode_folder(&imap::encode_folder(value).unwrap()).unwrap(),
            value
        );
    }
    for value in ["", "unsafe\r\nUID MOVE 7 INBOX", "null\0", "tab\t"] {
        assert!(imap::encode_folder(value).is_err());
    }
    for value in ["&unclosed", "&A-", "&2AA-", "&AGE-", "raw郵件", "&AAAA-"] {
        assert!(imap::decode_folder(value).is_err(), "{value}");
    }
}

#[tokio::test]
async fn imap_tls_history_has_fifty_message_pages_unicode_sent_ids_and_validity_guards() {
    let fixture = ImapFixture::new(ImapScenario::default()).await;
    let folders = imap::folders_with_tls(&fixture.mail, &fixture.connector)
        .await
        .unwrap();
    assert_eq!(folders.len(), 3);
    assert!(
        folders
            .iter()
            .any(|folder| folder["id"] == SENT && folder["name"] == SENT)
    );
    let options = json!({"folder":"sent","since":"2026-06-01T00:00:00.000Z","before":"2026-09-24T00:00:00.000Z"});
    let page = fixture.fetch(options.clone()).await.unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 50);
    assert_eq!(
        page["nextCursor"],
        json!({"path":SENT,"validity":"55","uid":11})
    );
    let message = &page["messages"][0];
    assert_eq!(
        message["id"],
        format!("imap-folder:{}:55:60", URL_SAFE_NO_PAD.encode(SENT))
    );
    assert_eq!(message["remoteId"], "imap:55:60");
    assert_eq!(message["providerFolderId"], SENT);
    assert_eq!(message["read"], true);
    assert_eq!(message["starred"], true);
    let inbox = fixture.fetch(json!({})).await.unwrap();
    assert_eq!(inbox["messages"][0]["remoteId"], message["remoteId"]);
    assert_ne!(inbox["messages"][0]["id"], message["id"]);
    let mut next = options.clone();
    next["cursor"] = page["nextCursor"].clone();
    let second = fixture.fetch(next.clone()).await.unwrap();
    assert_eq!(second["messages"].as_array().unwrap().len(), 10);
    assert_eq!(second["nextCursor"], Value::Null);
    let commands = fixture.commands();
    assert!(
        commands
            .iter()
            .any(|line| line == &format!("EXAMINE \"{SENT_WIRE}\""))
    );
    assert!(
        commands
            .iter()
            .any(|line| line.contains("SINCE 31-May-2026 BEFORE 25-Sep-2026"))
    );
    assert!(commands.iter().any(|line| line.contains("UID 1:10")));
    assert!(
        !commands
            .iter()
            .any(|line| line.starts_with("SELECT ") || line.contains("STORE"))
    );
    fixture.update(|state| state.validity = 56);
    let before = fixture.commands().len();
    assert_eq!(fixture.fetch(next).await.unwrap_err().status, 409);
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|line| line.starts_with("UID SEARCH"))
    );
    fixture.update(|state| state.sent = false);
    assert_eq!(fixture.fetch(options).await.unwrap_err().status, 409);
}

#[tokio::test]
async fn oversized_mail_is_a_placeholder_and_provider_body_or_uid_violations_fail_closed() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        large: true,
        ..Default::default()
    })
    .await;
    let page = fixture.fetch(json!({})).await.unwrap();
    assert_eq!(page["messages"][0]["automated"], true);
    assert!(string(&page["messages"][0], "body").contains("5 MB"));
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|line| line.contains("BODY.PEEK[]"))
    );
    fixture.update(|state| {
        state.large = false;
        state.oversized_body = true;
    });
    assert!(fixture.fetch(json!({})).await.is_err());
    fixture.update(|state| {
        state.oversized_body = false;
        state.wrong_uid = true;
    });
    assert!(fixture.fetch(json!({})).await.is_err());
    fixture.update(|state| {
        state.wrong_uid = false;
    });
    let page = fixture
        .fetch(json!({"before":"2026-09-23T12:00:00.000Z"}))
        .await
        .unwrap();
    assert_eq!(page["messages"], json!([]));
    fixture.update(|state| state.oversized_header = true);
    assert!(fixture.fetch(json!({})).await.is_err());
    fixture.update(|state| {
        state.oversized_header = false;
        state.count = 2;
        state.duplicate_uid = true;
    });
    assert!(fixture.fetch(json!({})).await.is_err());
}

#[tokio::test]
async fn imap_folder_limit_counts_unselectable_entries_and_rejects_zero_uidvalidity() {
    let fixture = ImapFixture::new(ImapScenario {
        hidden_folders: 297,
        ..Default::default()
    })
    .await;
    assert_eq!(
        imap::folders_with_tls(&fixture.mail, &fixture.connector)
            .await
            .unwrap()
            .len(),
        3
    );
    fixture.update(|state| state.hidden_folders = 298);
    assert_eq!(
        imap::folders_with_tls(&fixture.mail, &fixture.connector)
            .await
            .unwrap_err()
            .status,
        502
    );
    fixture.update(|state| state.validity = 0);
    let before = fixture.commands().len();
    assert!(fixture.fetch(json!({})).await.is_err());
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|line| line.starts_with("UID SEARCH"))
    );
}

#[tokio::test]
async fn imap_move_validates_capabilities_validity_and_exact_copyuid_before_returning_patch() {
    let fixture = ImapFixture::new(ImapScenario {
        extra_folders: "* LIST (\\Trash) \"/\" \"Deleted\"\r\n",
        ..Default::default()
    })
    .await;
    let trash = imap::folders_with_tls(&fixture.mail, &fixture.connector)
        .await
        .unwrap()
        .into_iter()
        .find(|folder| folder["kind"] == "trash")
        .unwrap();
    assert_eq!(trash["id"], "Deleted");
    let destination = json!({"id":"項目 & stuff","name":"項目 & stuff","kind":"folder"});
    let patch = fixture.organize(destination.clone()).await.unwrap();
    assert_eq!(patch["remoteId"], "imap:88:19");
    assert_eq!(patch["providerFolderId"], destination["id"]);
    assert_eq!(patch["folder"], "archive");
    assert!(patch.get("id").is_none());
    assert!(
        fixture
            .commands()
            .iter()
            .any(|line| line == "UID MOVE 7 \"&mAV27g- &- stuff\"")
    );
    let trashed = imap::organize_with_tls(
        &fixture.mail,
        &json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"stable-local","remoteId":"imap:55:7","providerFolderId":SENT}),
        &trash,
        "move",
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(trashed["folder"], "trash");
    assert_eq!(trashed["remoteId"], "imap:88:19");
    {
        let mut scenario = fixture.state.lock().unwrap();
        scenario.validity = 88;
        scenario.mapping = Some("55 19 29");
    }
    let restored = imap::organize_with_tls(
        &fixture.mail,
        &json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"stable-local","remoteId":"imap:88:19","providerFolderId":"Deleted"}),
        &json!({"id":SENT,"name":SENT,"kind":"folder"}),
        "restoreTrash",
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(restored["remoteId"], "imap:55:29");
    assert_eq!(restored["providerFolderId"], SENT);
    {
        let mut scenario = fixture.state.lock().unwrap();
        scenario.validity = 55;
        scenario.mapping = Some("88 7 19");
    }
    assert!(
        fixture
            .commands()
            .iter()
            .any(|line| line == "UID MOVE 7 \"Deleted\"")
    );
    let before = fixture.commands().len();
    let same = imap::organize_with_tls(
        &fixture.mail,
        &json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"stable-local","remoteId":"imap:55:7","providerFolderId":SENT}),
        &json!({"id":SENT,"name":SENT,"kind":"folder"}),
        "move",
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(same["remoteId"], "imap:55:7");
    assert!(
        fixture.commands()[before..]
            .iter()
            .any(|line| line == &format!("SELECT \"{SENT_WIRE}\""))
    );
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|line| line.starts_with("UID MOVE"))
    );
    fixture.update(|state| state.extra_mapping = Some("88 7 20"));
    assert!(fixture.organize(destination.clone()).await.is_err());
    fixture.update(|state| state.extra_mapping = Some("88 7 19"));
    assert_eq!(
        fixture.organize(destination.clone()).await.unwrap()["remoteId"],
        "imap:88:19"
    );
    fixture.update(|state| state.extra_mapping = None);
    for capabilities in ["IMAP4rev1 MOVE", "IMAP4rev1 UIDPLUS"] {
        fixture.update(|state| state.capabilities = capabilities);
        assert!(
            !imap::folders_with_tls(&fixture.mail, &fixture.connector)
                .await
                .unwrap()
                .is_empty()
        );
        let before = fixture.commands().len();
        assert_eq!(
            fixture
                .organize(destination.clone())
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(
            !fixture.commands()[before..]
                .iter()
                .any(|line| line.starts_with("UID MOVE"))
        );
    }
    fixture.update(|state| {
        state.capabilities = "IMAP4rev1 MOVE UIDPLUS";
        state.validity = 99;
    });
    let before = fixture.commands().len();
    assert_eq!(
        fixture
            .organize(destination.clone())
            .await
            .unwrap_err()
            .status,
        409
    );
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|line| line.starts_with("UID MOVE"))
    );
    fixture.update(|state| state.validity = 55);
    for mapping in [
        None,
        Some("88 8 19"),
        Some("88 7 19:20"),
        Some("0 7 19"),
        Some("88 7 0"),
    ] {
        fixture.update(|state| state.mapping = mapping);
        let before = fixture.commands().len();
        assert!(fixture.organize(destination.clone()).await.is_err());
        assert_eq!(
            fixture.commands()[before..]
                .iter()
                .filter(|line| line.starts_with("UID MOVE"))
                .count(),
            1
        );
    }
    let before = fixture.commands().len();
    assert!(
        fixture
            .organize(json!({"id":"unsafe\r\nUID MOVE 7 INBOX"}))
            .await
            .is_err()
    );
    assert_eq!(before, fixture.commands().len());
}

#[tokio::test]
async fn imap_platform_tls_and_authentication_fail_closed_without_plaintext_fallback() {
    let fixture = ImapFixture::new(ImapScenario {
        auth_failure: true,
        ..Default::default()
    })
    .await;
    let error = fixture.fetch(json!({})).await.unwrap_err();
    assert_ne!(error.body["code"], "provider_network");
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|line| line.starts_with("EXAMINE"))
    );
    let before = fixture.commands().len();
    let error = imap::fetch_page(&fixture.mail, &json!({}))
        .await
        .unwrap_err();
    assert_ne!(error.body["code"], "provider_network");
    assert_eq!(fixture.commands().len(), before);
}

#[derive(Clone, Copy)]
enum SmtpScenario {
    Success,
    NoStartTls,
    RejectStartTls,
    RejectAuth,
    RejectRecipient,
}
struct SmtpFixture {
    mail: Value,
    cert: Vec<u8>,
    log: Log,
    failures: Log,
    data: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}
impl Drop for SmtpFixture {
    fn drop(&mut self) {
        self.task.abort();
        if !std::thread::panicking() {
            assert!(
                self.failures.lock().unwrap().is_empty(),
                "SMTP fixture task failed"
            );
        }
    }
}
impl SmtpFixture {
    async fn new(scenario: SmtpScenario) -> Self {
        let (cert, acceptor) = tls();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let failures = Arc::new(Mutex::new(Vec::new()));
        let saved_failures = failures.clone();
        let data = Arc::new(Mutex::new(Vec::new()));
        let (saved_log, saved_data) = (log.clone(), data.clone());
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    result=listener.accept()=>{
                        let Ok((socket,_))=result else{break};
                        let (acceptor,log,data)=(acceptor.clone(),saved_log.clone(),saved_data.clone());
                        sessions.spawn(checked_session(smtp_session(socket,acceptor,scenario,log,data), saved_failures.clone()));
                    },
                    _=sessions.join_next(),if !sessions.is_empty()=>{}
                }
            }
        });
        Self {
            mail: json!({"provider":"imap","email":OWNER,"password":"fixture-password","smtpHost":"127.0.0.1","smtpPort":port}),
            cert,
            log,
            failures,
            data,
            task,
        }
    }
    fn params(&self) -> TlsParameters {
        smtp_trusted(&self.cert)
    }
    fn commands(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}
async fn smtp_session(
    socket: TcpStream,
    acceptor: TlsAcceptor,
    scenario: SmtpScenario,
    log: Log,
    data: Arc<Mutex<Vec<String>>>,
) -> io::Result<()> {
    let mut stream = BufReader::new(socket);
    write(&mut stream, "220 fixture ESMTP\r\n").await?;
    while let Some(command) = line(&mut stream).await? {
        log.lock().unwrap().push(format!("clear:{command}"));
        if command.starts_with("EHLO ") {
            write(
                &mut stream,
                if matches!(scenario, SmtpScenario::NoStartTls) {
                    "250-fixture\r\n250 AUTH PLAIN\r\n"
                } else {
                    "250-fixture\r\n250 STARTTLS\r\n"
                },
            )
            .await?;
        } else if command == "STARTTLS" {
            if matches!(scenario, SmtpScenario::RejectStartTls) {
                write(&mut stream, "454 TLS unavailable\r\n").await?;
                return Ok(());
            }
            write(&mut stream, "220 Begin TLS\r\n").await?;
            break;
        } else if command == "QUIT" {
            write(&mut stream, "221 Bye\r\n").await?;
            return Ok(());
        } else {
            panic!("SMTP sent credentials/mail before TLS: {command}");
        }
    }
    let Ok(socket) = acceptor.accept(stream.into_inner()).await else {
        return Ok(());
    };
    let mut stream = BufReader::new(socket);
    while let Some(command) = line(&mut stream).await? {
        log.lock().unwrap().push(format!("tls:{command}"));
        if command.starts_with("EHLO ") {
            write(
                &mut stream,
                "250-fixture\r\n250-AUTH PLAIN\r\n250 SIZE 10000000\r\n",
            )
            .await?;
        } else if let Some(value) = command.strip_prefix("AUTH PLAIN ") {
            assert_eq!(
                STANDARD.decode(value).unwrap(),
                format!("\0{OWNER}\0fixture-password").as_bytes()
            );
            write(
                &mut stream,
                if matches!(scenario, SmtpScenario::RejectAuth) {
                    "535 Authentication failed\r\n"
                } else {
                    "235 Authentication succeeded\r\n"
                },
            )
            .await?;
        } else if command.starts_with("MAIL FROM:") || command == "NOOP" || command == "RSET" {
            write(&mut stream, "250 OK\r\n").await?;
        } else if command.starts_with("RCPT TO:") {
            write(
                &mut stream,
                if matches!(scenario, SmtpScenario::RejectRecipient) && command.contains("hidden") {
                    "550 Recipient rejected\r\n"
                } else {
                    "250 OK\r\n"
                },
            )
            .await?;
        } else if command == "DATA" {
            write(&mut stream, "354 End with dot\r\n").await?;
            let mut message = Vec::new();
            while let Some(line) = line(&mut stream).await? {
                if line == "." {
                    break;
                }
                message.push(line);
            }
            data.lock().unwrap().push(message.join("\r\n"));
            write(&mut stream, "250 Message accepted\r\n").await?;
        } else if command == "QUIT" {
            write(&mut stream, "221 Bye\r\n").await?;
            break;
        } else {
            panic!("unexpected SMTP fixture command: {command}");
        }
    }
    Ok(())
}
fn outgoing() -> Value {
    json!({"fromName":"Fixture Sender","to":"visible@example.invalid","cc":"copy@example.invalid","bcc":"hidden@example.invalid","subject":"Fixture only","body":"Local TLS fixture only.","replyMessageId":"<prior@example.invalid>"})
}

#[tokio::test]
async fn smtp_starttls_authentication_envelope_and_bcc_header_contract() {
    let fixture = SmtpFixture::new(SmtpScenario::Success).await;
    imap::verify_smtp_with_tls(&fixture.mail, fixture.params())
        .await
        .unwrap();
    let id = imap::send_with_tls(&fixture.mail, &outgoing(), fixture.params())
        .await
        .unwrap();
    assert!(!id.is_empty());
    let commands = fixture.commands();
    assert!(commands.iter().any(|line| line == "clear:STARTTLS"));
    assert!(
        commands
            .iter()
            .any(|line| line.starts_with("tls:AUTH PLAIN "))
    );
    assert!(!commands.iter().any(|line| line.starts_with("clear:AUTH")));
    for address in [
        "visible@example.invalid",
        "copy@example.invalid",
        "hidden@example.invalid",
    ] {
        assert!(
            commands
                .iter()
                .any(|line| line == &format!("tls:RCPT TO:<{address}>"))
        );
    }
    let data = fixture.data.lock().unwrap();
    assert_eq!(data.len(), 1);
    let headers = data[0].split("\r\n\r\n").next().unwrap().to_lowercase();
    assert!(!headers.contains("bcc:") && !headers.contains("hidden@example.invalid"));
    assert!(headers.contains("in-reply-to: <prior@example.invalid>"));
}

#[tokio::test]
async fn smtp_tls_auth_and_recipient_failures_do_not_downgrade_or_claim_success() {
    for scenario in [
        SmtpScenario::NoStartTls,
        SmtpScenario::RejectStartTls,
        SmtpScenario::RejectAuth,
        SmtpScenario::RejectRecipient,
    ] {
        let fixture = SmtpFixture::new(scenario).await;
        assert!(
            imap::send_with_tls(&fixture.mail, &outgoing(), fixture.params())
                .await
                .is_err()
        );
        assert!(
            !fixture
                .commands()
                .iter()
                .any(|line| line.starts_with("clear:AUTH") || line.starts_with("clear:MAIL"))
        );
        assert!(fixture.data.lock().unwrap().is_empty());
    }
    let fixture = SmtpFixture::new(SmtpScenario::Success).await;
    assert!(imap::verify_smtp(&fixture.mail).await.is_err());
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|line| line.starts_with("tls:AUTH"))
    );
}

#[tokio::test]
async fn full_history_imap_persists_folder_and_uid_checkpoints_excluding_special_subtrees() {
    let fixture=ImapFixture::new(ImapScenario { extra_folders: "* LIST () \"/\" \"INBOX\"\r\n* LIST (\\Drafts) \"/\" \"Drafts\"\r\n* LIST (\\Junk) \"/\" \"Junk\"\r\n* LIST () \"/\" \"Junk/Child\"\r\n* LIST (\\Trash) \"/\" \"Trash\"\r\n* LIST () \"/\" \"Trash/Child\"\r\n* LIST (\\All) \"/\" \"All\"\r\n* LIST (\\Flagged) \"/\" \"Flagged\"\r\n", ..Default::default() }).await;
    let mut options = json!({"folder":"all","since":"","before":"2027-01-01T00:00:00.000Z"});
    let first = fixture.fetch(options.clone()).await.unwrap();
    assert_eq!(first["messages"].as_array().unwrap().len(), 50);
    assert_eq!(first["nextCursor"]["folders"].as_array().unwrap().len(), 4);
    assert_eq!(first["nextCursor"]["next"]["uid"], 11);
    options["cursor"] = first["nextCursor"].clone();
    fixture.update(|s| s.validity = 56);
    assert_eq!(
        fixture.fetch(options.clone()).await.unwrap_err().status,
        409
    );
    fixture.update(|s| s.validity = 55);
    let mut cursor = first["nextCursor"].clone();
    let mut rows = first["messages"].as_array().unwrap().clone();
    let mut pages = 1;
    while !cursor.is_null() {
        options["cursor"] =
            serde_json::from_slice::<Value>(&serde_json::to_vec(&cursor).unwrap()).unwrap();
        let page = fixture.fetch(options.clone()).await.unwrap();
        rows.extend(page["messages"].as_array().unwrap().clone());
        cursor = page["nextCursor"].clone();
        pages += 1;
        assert!(pages <= 8);
    }
    assert_eq!(pages, 8);
    assert_eq!(rows.len(), 240);
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        240
    );
    assert_eq!(rows[60]["folder"], "sent");
    assert_eq!(rows[60]["providerSent"], true);
    assert_eq!(rows[60]["providerFolderId"], SENT);
    assert_eq!(rows[120]["folder"], "archive");
    assert_eq!(rows[180]["providerDraft"], true);
    let commands = fixture.commands();
    assert_eq!(
        commands.iter().filter(|s| s.starts_with("LIST ")).count(),
        1
    );
    for command in commands.iter().filter(|s| s.starts_with("EXAMINE ")) {
        for excluded in ["Junk", "Trash", "All", "Flagged", "Hidden"] {
            assert!(!command.contains(excluded));
        }
    }
    assert!(
        commands
            .iter()
            .filter(|s| s.starts_with("UID SEARCH "))
            .all(|s| !s.contains("SINCE"))
    );
}

#[tokio::test]
async fn imap_priority_checks_a_retained_reader_plus_fifty_rows_within_existing_batch_bounds() {
    let fixture = ImapFixture::new(ImapScenario::default()).await;
    let mut messages = vec![
        json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:60","providerFolderId":"INBOX","body":"selected cache","read":false}),
    ];
    messages.extend((1..=50).map(|uid| json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":format!("imap:55:{uid}"),"providerFolderId":"INBOX","body":"page cache","read":false})));
    assert_eq!(
        imap::reconcile_with_tls(&fixture.mail, &messages, &fixture.connector)
            .await
            .unwrap_err()
            .status,
        400,
        "The ordinary reconciliation limit must remain 50"
    );
    let result = imap::reconcile_priority_with_tls(&fixture.mail, &messages, &fixture.connector)
        .await
        .unwrap();
    assert_eq!(result.len(), 51);
    assert!(result.iter().all(|row| row["read"] == true));
    assert!(
        result
            .iter()
            .any(|row| row["id"] == "imap:55:60" && row["body"] == "selected cache")
    );
    let requests: Vec<_> = fixture
        .commands()
        .into_iter()
        .filter(|command| command.starts_with("UID FETCH "))
        .collect();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .split_whitespace()
            .nth(2)
            .unwrap()
            .split(',')
            .count(),
        50
    );
    assert_eq!(
        requests[1]
            .split_whitespace()
            .nth(2)
            .unwrap()
            .split(',')
            .count(),
        1
    );
    assert!(
        requests
            .iter()
            .all(|command| command.ends_with("(UID FLAGS)"))
    );
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|command| command.starts_with("UID STORE "))
    );

    let before = fixture.commands().len();
    let mut oversized = messages.clone();
    oversized
        .push(json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:59"}));
    assert_eq!(
        imap::reconcile_priority_with_tls(&fixture.mail, &oversized, &fixture.connector)
            .await
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        fixture.commands().len(),
        before,
        "Oversized hints make no provider request"
    );

    fixture.update(|scenario| {
        scenario.examine_failure = Some(("INBOX", "NO [UNAVAILABLE] Try later"))
    });
    for message in messages.iter_mut().take(50) {
        message["providerFolderId"] = SENT.into();
    }
    assert!(
        imap::reconcile_priority_with_tls(&fixture.mail, &messages, &fixture.connector)
            .await
            .is_err(),
        "A second-chunk failure must not return partially refreshed rows"
    );
}

#[tokio::test]
async fn imap_flags_and_attachment_reads_validate_generation_preserve_other_flags_and_do_not_replay()
 {
    let raw = format!(
        "{HEADER}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nHello\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=fixture.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8=\r\n--fixture--\r\n"
    );
    let fixture = ImapFixture::new(ImapScenario {
        raw_message: Some(raw.clone()),
        missing_uid: Some(2),
        ..Default::default()
    })
    .await;
    let message = json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1","providerFolderId":"INBOX","body":"cached","read":false,"starred":false});
    assert_eq!(
        imap::raw_message_with_tls(&fixture.mail, &message, &fixture.connector)
            .await
            .unwrap(),
        raw.as_bytes()
    );
    let confirmed = imap::write_flags_with_tls(
        &fixture.mail,
        &message,
        &json!({"read":false,"starred":true}),
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(confirmed, json!({"read":false,"starred":true}));
    let messages = vec![
        message.clone(),
        json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:2","body":"deleted cache"}),
        json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:12:1","body":"old generation"}),
    ];
    let result = imap::reconcile_with_tls(&fixture.mail, &messages, &fixture.connector)
        .await
        .unwrap();
    assert!(
        result
            .iter()
            .any(|m| m["id"] == "imap:55:1" && m["read"] == false && m["starred"] == true)
    );
    assert!(result.iter().any(|m| m["id"] == "imap:55:2"
        && m["providerDeleted"] == true
        && m["body"] == "deleted cache"));
    assert!(result.iter().any(|m| m["id"] == "imap:12:1"
        && m["providerFolderMissing"] == true
        && m["providerDeleted"] != true));
    fixture.update(|v| v.validity = 77);
    let writes = fixture
        .commands()
        .iter()
        .filter(|s| s.starts_with("UID STORE"))
        .count();
    assert!(
        imap::write_flags_with_tls(
            &fixture.mail,
            &message,
            &json!({"read":true}),
            &fixture.connector
        )
        .await
        .is_err()
    );
    assert!(
        imap::raw_message_with_tls(&fixture.mail, &message, &fixture.connector)
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|s| s.starts_with("UID STORE"))
            .count(),
        writes
    );
    assert!(
        fixture
            .commands()
            .iter()
            .filter(|s| s.starts_with("UID STORE"))
            .all(|s| s.contains("+FLAGS.SILENT") || s.contains("-FLAGS.SILENT"))
    );
    fixture.update(|v| {
        v.validity = 55;
        v.folder_write_failure = true;
    });
    assert!(
        imap::write_flags_with_tls(
            &fixture.mail,
            &message,
            &json!({"read":true}),
            &fixture.connector
        )
        .await
        .is_err()
    );
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|s| s.starts_with("UID STORE"))
            .count(),
        writes + 1
    );
}

#[tokio::test]
async fn missing_imap_folder_does_not_block_other_flags_or_erase_cached_mail() {
    let fixture = ImapFixture::new(ImapScenario {
        examine_failure: Some(("A-removed", "NO [NONEXISTENT] No such mailbox")),
        ..Default::default()
    })
    .await;
    let missing = json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1","providerFolderId":"A-removed","read":false,"body":"Retained cache","pending":true,"providerSnapshot":{"read":true}});
    let messages = vec![
        missing.clone(),
        json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:2","providerFolderId":"INBOX","read":false}),
    ];
    for _ in 0..2 {
        let result = imap::reconcile_with_tls(&fixture.mail, &messages, &fixture.connector)
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        let unavailable = result.iter().find(|m| m["id"] == missing["id"]).unwrap();
        assert_eq!(unavailable["providerFolderMissing"], true);
        assert_ne!(unavailable["providerDeleted"], true);
        for key in ["read", "body", "pending", "providerSnapshot"] {
            assert_eq!(unavailable[key], missing[key]);
        }
        assert_eq!(
            result.iter().find(|m| m["id"] == "imap:55:2").unwrap()["read"],
            true
        );
    }
    // A restored folder is rechecked and must still have the original UIDVALIDITY.
    fixture.update(|s| s.examine_failure = None);
    let result = imap::reconcile_with_tls(&fixture.mail, &messages, &fixture.connector)
        .await
        .unwrap();
    assert!(
        result
            .iter()
            .all(|m| m["providerFolderMissing"] == false && m["read"] == true)
    );
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|s| s.starts_with("UID STORE"))
    );
}

#[tokio::test]
async fn imap_folder_reconciliation_does_not_mistake_failed_reads_for_missing_folders() {
    for completion in ["NO", "BAD"] {
        let fixture = ImapFixture::new(ImapScenario {
            examine_failure: Some(("A-removed", "NO [NONEXISTENT] No such mailbox")),
            list_completion: completion,
            ..Default::default()
        })
        .await;
        let result = imap::reconcile_with_tls(
            &fixture.mail,
            &[json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1","providerFolderId":"A-removed"})],
            &fixture.connector,
        )
        .await;
        assert!(
            result.is_err(),
            "A failed LIST cannot establish that a folder is missing"
        );
        assert!(
            imap::folders_with_tls(&fixture.mail, &fixture.connector)
                .await
                .is_err()
        );
    }
    for (folder, response) in [
        ("INBOX", "NO [UNAVAILABLE] Try later"),
        ("A-removed", "BAD Cannot examine"),
    ] {
        let fixture = ImapFixture::new(ImapScenario {
            examine_failure: Some((folder, response)),
            ..Default::default()
        })
        .await;
        assert!(
            imap::reconcile_with_tls(
                &fixture.mail,
                &[json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1","providerFolderId":folder})],
                &fixture.connector
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn failed_fetch_completion_never_means_success_or_deleted_mail() {
    let fixture = ImapFixture::new(ImapScenario {
        fetch_failure: true,
        missing_uid: Some(1),
        raw_message: Some(format!("{HEADER}\r\nbody")),
        ..Default::default()
    })
    .await;
    let message = json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1","providerFolderId":"INBOX"});
    assert!(
        imap::reconcile_with_tls(
            &fixture.mail,
            std::slice::from_ref(&message),
            &fixture.connector
        )
        .await
        .is_err()
    );
    fixture.update(|s| s.missing_uid = None);
    assert!(
        imap::reconcile_with_tls(
            &fixture.mail,
            std::slice::from_ref(&message),
            &fixture.connector
        )
        .await
        .is_err()
    );
    assert!(
        imap::raw_message_with_tls(&fixture.mail, &message, &fixture.connector)
            .await
            .is_err()
    );
    assert!(fixture.fetch(json!({"folder":"inbox"})).await.is_err());
    assert!(
        imap::write_flags_with_tls(
            &fixture.mail,
            &message,
            &json!({"read":true}),
            &fixture.connector
        )
        .await
        .is_err()
    );
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|c| c.starts_with("UID STORE"))
    );
}

#[tokio::test]
async fn imap_history_uses_internaldate_across_recent_and_older_windows() {
    use morrow_search::{background, store::Store};
    for folder in ["inbox", "sent", "all"] {
        let fixture = ImapFixture::new(ImapScenario {
            count: 1,
            raw_message: Some(format!(
                "{}\r\nBackdated fixture body.\r\n",
                HEADER.replace("Wed, 23 Sep 2026", "Sun, 23 Aug 2026")
            )),
            ..Default::default()
        })
        .await;
        let root = std::env::temp_dir().join(format!("morrow-imap-dates-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&root).unwrap();
        let mut mail = fixture.mail.clone();
        mail["connectionId"] = "date-fixture".into();
        db.set_settings(&json!({"mailAccounts":{OWNER:mail},"preferences":{"syncInterval":0}}))
            .unwrap();
        background::start_import(&db, OWNER, &json!({"months":0,"inbox":folder=="inbox","sent":folder=="sent","allMail":folder=="all"})).unwrap();
        let mut imports = db.settings().unwrap()["imports"].clone();
        imports[OWNER]["before"] = "2026-09-27T00:00:00.000Z".into();
        imports[OWNER]["recentSince"] = "2026-09-20T00:00:00.000Z".into();
        db.set_settings(&json!({"imports":imports})).unwrap();
        for _ in 0..6 {
            let job = db.settings().unwrap()["imports"][OWNER].clone();
            if job["status"] == "complete" {
                break;
            }
            let (since, before) = if job["recentComplete"] == true {
                (&job["since"], &job["recentSince"])
            } else {
                (&job["recentSince"], &job["before"])
            };
            let page = fixture
                .fetch(
                    json!({"folder":folder,"since":since,"before":before,"cursor":job["cursor"]}),
                )
                .await
                .unwrap();
            background::apply_import_page(&db, OWNER, &job, &page).unwrap();
        }
        let saved = db.settings().unwrap()["imports"][OWNER].clone();
        let mut query = db
            .conn
            .prepare("SELECT data FROM messages WHERE account=?")
            .unwrap();
        let messages = query
            .query_map([OWNER], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap())
            .collect::<Vec<_>>();
        drop(query);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(saved["status"], "complete", "{folder}");
        assert_eq!(
            messages.len(),
            if folder == "all" { 3 } else { 1 },
            "{folder}"
        );
        for message in messages {
            assert_eq!(message["date"], "2026-09-23T12:00:00.000Z");
            assert_eq!(message["senderDate"], "2026-08-23T12:00:00.000Z");
        }
    }
}

#[tokio::test]
async fn imap_import_dates_cover_missing_headers_and_timezone_day_boundaries() {
    for folder in ["inbox", "sent"] {
        for header_date in ["", "Date: not a date\r\n"] {
            let header = HEADER.replace("Date: Wed, 23 Sep 2026 12:00:00 +0000\r\n", header_date);
            for (internal_date, expected) in [
                ("22-Sep-2026 23:30:00 -0200", "2026-09-23T01:30:00.000Z"),
                ("24-Sep-2026 00:30:00 +0200", "2026-09-23T22:30:00.000Z"),
            ] {
                let fixture = ImapFixture::new(ImapScenario {
                    count: 1,
                    internal_date,
                    raw_message: Some(format!("{header}\r\nSynthetic body\r\n")),
                    ..Default::default()
                })
                .await;
                let page = fixture.fetch(json!({"folder":folder,"since":"2026-09-23T00:00:00.000Z","before":"2026-09-24T00:00:00.000Z"})).await.unwrap();
                assert_eq!(
                    page["messages"].as_array().unwrap().len(),
                    1,
                    "{folder} {internal_date}"
                );
                assert_eq!(page["messages"][0]["date"], expected);
                assert!(page["messages"][0]["senderDate"].is_null());
                let excluded = fixture.fetch(json!({"folder":folder,"since":"2026-09-24T00:00:00.000Z","before":"2026-09-25T00:00:00.000Z"})).await.unwrap();
                assert!(excluded["messages"].as_array().unwrap().is_empty());
            }
        }
    }
}

#[tokio::test]
async fn imap_incomplete_success_retries_existing_uids_and_confirms_real_expunges() {
    for kind in ["metadata", "absent", "nil"] {
        let scenario = ImapScenario {
            count: 60,
            omitted_metadata_uid: (kind == "metadata").then_some(60),
            absent_body_uid: (kind == "absent").then_some(60),
            nil_body_uid: (kind == "nil").then_some(60),
            ..Default::default()
        };
        let fixture = ImapFixture::new(scenario).await;
        let failed = fixture.fetch(json!({})).await.unwrap_err();
        assert_eq!(failed.body["code"], "provider_incomplete_read", "{kind}");
        assert!(
            fixture
                .commands()
                .iter()
                .any(|command| command == "UID FETCH 60 UID")
        );
        fixture.update(|state| {
            state.omitted_metadata_uid = None;
            state.absent_body_uid = None;
            state.nil_body_uid = None;
        });
        let recovered = fixture.fetch(json!({})).await.unwrap();
        assert_eq!(recovered["messages"].as_array().unwrap().len(), 50);
        assert!(
            recovered["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["remoteId"] == "imap:55:60")
        );
        assert_eq!(recovered["nextCursor"]["uid"], 11);
        fixture.update(|state| {
            state.omitted_metadata_uid = (kind == "metadata").then_some(60);
            state.absent_body_uid = (kind == "absent").then_some(60);
            state.nil_body_uid = (kind == "nil").then_some(60);
            state.expunged_uid = Some(60);
            state.recheck_failure = true;
        });
        assert!(
            fixture.fetch(json!({})).await.is_err(),
            "A failed absence check is not proof of deletion"
        );
        fixture.update(|state| state.recheck_failure = false);
        let expunged = fixture.fetch(json!({})).await.unwrap();
        assert_eq!(expunged["messages"].as_array().unwrap().len(), 49, "{kind}");
        assert_eq!(expunged["nextCursor"]["uid"], 11);
    }
}

#[tokio::test]
async fn imap_truncated_success_is_not_committed_and_disconnects_remain_retryable() {
    let fixture = ImapFixture::new(ImapScenario {
        count: 1,
        truncated_body: true,
        ..Default::default()
    })
    .await;
    assert_eq!(
        fixture.fetch(json!({})).await.unwrap_err().body["code"],
        "provider_incomplete_read"
    );
    fixture.update(|state| {
        state.truncated_body = false;
        state.disconnect_on_body = true;
    });
    assert_eq!(
        fixture.fetch(json!({})).await.unwrap_err().body["code"],
        "provider_network"
    );
    fixture.update(|state| state.disconnect_on_body = false);
    assert_eq!(
        fixture.fetch(json!({})).await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn incremental_uid_pages_cover_bursts_and_reset_only_on_connection_or_uidvalidity_change() {
    let fixture = ImapFixture::new(ImapScenario::default()).await;
    let first = imap::fetch_page_with_tls(
        &fixture.mail,
        &json!({"folder":"inbox","incremental":true}),
        &fixture.connector,
    )
    .await
    .unwrap();
    let mut checkpoint = first["syncCheckpoint"].clone();
    assert_eq!(checkpoint["uid"], 60);
    fixture.update(|s| s.count = 180);
    let mut added = Vec::new();
    for (uid, more) in [(110, true), (160, true), (180, false)] {
        let page = imap::fetch_page_with_tls(
            &fixture.mail,
            &json!({"folder":"inbox","incremental":true,"syncCheckpoints":{"INBOX":checkpoint}}),
            &fixture.connector,
        )
        .await
        .unwrap();
        assert_eq!(page["syncCheckpoint"]["uid"], uid);
        assert_eq!(page["syncCheckpoint"]["more"], more);
        added.extend(
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| string(m, "id").to_owned()),
        );
        checkpoint = page["syncCheckpoint"].clone();
    }
    assert_eq!(added.len(), 120);
    assert_eq!(
        added.iter().collect::<std::collections::HashSet<_>>().len(),
        120
    );
    let before = fixture.commands().len();
    let page = imap::fetch_page_with_tls(
        &fixture.mail,
        &json!({"incremental":true,"syncCheckpoints":{"INBOX":checkpoint}}),
        &fixture.connector,
    )
    .await
    .unwrap();
    assert!(page["messages"].as_array().unwrap().is_empty());
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|c| c.starts_with("UID SEARCH") || c.starts_with("UID FETCH"))
    );
    fixture.update(|s| s.validity = 66);
    let reset = imap::fetch_page_with_tls(
        &fixture.mail,
        &json!({"incremental":true,"syncCheckpoints":{"INBOX":checkpoint}}),
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(reset["syncCheckpoint"]["validity"], "66");
    assert_eq!(reset["messages"].as_array().unwrap().len(), 50);
    let mut mail = fixture.mail.clone();
    mail["connectionId"] = "replacement".into();
    let reset = imap::fetch_page_with_tls(
        &mail,
        &json!({"incremental":true,"syncCheckpoints":{"INBOX":reset["syncCheckpoint"]}}),
        &fixture.connector,
    )
    .await
    .unwrap();
    assert_eq!(reset["messages"].as_array().unwrap().len(), 50);
}

#[tokio::test]
async fn capability_gated_modseq_and_vanished_do_not_treat_unchanged_omissions_as_deleted() {
    for qresync in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: if qresync {
                "IMAP4rev1 ENABLE CONDSTORE QRESYNC"
            } else {
                "IMAP4rev1 CONDSTORE"
            },
            highest_modseq: Some(10),
            remote_read: false,
            ..Default::default()
        })
        .await;
        let rows = vec![
            json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:2","body":"Owned synthetic cache","providerFolderId":"INBOX"}),
            json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:3","body":"Second owned cache","providerFolderId":"INBOX"}),
        ];
        let first = imap::reconcile_with_tls(&fixture.mail, &rows, &fixture.connector)
            .await
            .unwrap();
        assert!(first.iter().all(|m| m["imapModseq"] == 10));
        // Persisted imports record this remote snapshot. Raw reconcile output
        // alone is not a provider snapshot and must never authorize omissions.
        let first: Vec<_> = first
            .into_iter()
            .map(|mut row| {
                row["providerSnapshot"] = json!({"read":row["read"],"starred":row["starred"]});
                row
            })
            .collect();
        let unchanged = imap::reconcile_with_tls(&fixture.mail, &first, &fixture.connector)
            .await
            .unwrap();
        assert!(
            unchanged
                .iter()
                .all(|m| m["providerDeleted"] == false && m["read"] == false)
        );
        fixture.update(|s| {
            s.highest_modseq = Some(11);
            s.changed_modseq = Some(11);
            s.remote_read = true;
            s.missing_uid = Some(3);
            s.expunged_uid = Some(3);
        });
        let result = imap::reconcile_with_tls(&fixture.mail, &unchanged, &fixture.connector)
            .await
            .unwrap();
        assert!(
            result
                .iter()
                .any(|m| m["id"] == "imap:55:2" && m["read"] == true && m["imapModseq"] == 11)
        );
        assert!(result.iter().any(|m| m["id"] == "imap:55:3"
            && m["providerDeleted"] == true
            && m["body"] == "Second owned cache"));
        let commands = fixture.commands();
        assert!(commands.iter().any(|c| c.contains("CHANGEDSINCE 10")));
        assert_eq!(commands.iter().any(|c| c.contains("VANISHED")), qresync);
        assert!(!commands.iter().any(|c| c.starts_with("SELECT")));
    }
}

#[tokio::test]
async fn optional_extensions_fall_back_when_rejected_ignored_or_nomodseq() {
    for (reject, ignored, nomodseq) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 ENABLE CONDSTORE QRESYNC",
            highest_modseq: Some(10),
            extension_rejected: reject,
            enable_ignored: ignored,
            nomodseq,
            ..Default::default()
        })
        .await;
        let rows = vec![
            json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:2","providerFolderId":"INBOX"}),
        ];
        let result = imap::reconcile_with_tls(&fixture.mail, &rows, &fixture.connector)
            .await
            .unwrap_or_else(|error|panic!("reject={reject} ignored={ignored} nomodseq={nomodseq}: {error:?}; commands={:?}",fixture.commands().iter().filter(|c|!c.starts_with("LOGIN")).collect::<Vec<_>>()));
        assert_eq!(result[0]["read"], true);
        assert_ne!(result[0]["providerDeleted"], true);
        if reject || nomodseq {
            assert!(result[0]["imapModseq"].is_null());
        }
        if ignored {
            assert!(!fixture.commands().iter().any(|c| c.contains("VANISHED")));
        }
    }
}

async fn seed_changed_cache(
    fixture: &ImapFixture,
    cache: &CacheWorkspace,
    count: u32,
    warm_modseq: u64,
) -> Value {
    let proof = imap::reconcile_with_tls(
        &fixture.mail,
        &[json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1"})],
        &fixture.connector,
    )
    .await
    .unwrap()[0]["imapSyncConnection"]
        .clone();
    let saved_proof = proof.clone();
    let saved_origin = imap::server_origin(&fixture.mail).unwrap();
    let body = if count > 1000 {
        "Owned synthetic body ".repeat(100)
    } else {
        "Owned synthetic body".to_owned()
    };
    cache.app().db(move |db| db.transaction(|db| {
        if count>1000 {
            // Memoize identical fixture text during setup only. Timed sync uses
            // the restored production functions and all normal SQLite triggers.
            let flags=rusqlite::functions::FunctionFlags::SQLITE_UTF8|rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC|rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS;
            for (name, transform) in [("mail_normalize",morrow_search::normalize::normalize as fn(&str)->String),("mail_tokens",morrow_search::normalize::tokens)] {
                let cached=std::cell::RefCell::new(std::collections::HashMap::<String,String>::new());
                db.conn.create_scalar_function(name,1,flags,move |context| {
                    let mut cached=cached.borrow_mut();
                    let text=context.get::<Option<String>>(0)?.unwrap_or_default();
                    if let Some(value)=cached.get(&text) {return Ok(value.clone());}
                    let value=transform(&text);
                    if cached.len()<8 {cached.insert(text,value.clone());}
                    Ok(value)
                })?;
            }
        }
        let mut insert=db.conn.prepare("INSERT INTO messages(account,id,data) VALUES(?,?,?)")?;
        for uid in 1..=count {
            let row=json!({"imapOrigin":saved_origin,"id":format!("imap:55:{uid}"),"folder":"inbox","providerFolderId":"INBOX",
                "read":false,"starred":false,"pending":true,"body":body,"bodyHtml":"","labels":[],
                "providerSnapshot":{"read":false,"starred":false},"imapModseq":warm_modseq,"imapSyncConnection":saved_proof});
            insert.execute(rusqlite::params![OWNER,string(&row,"id"),serde_json::to_string(&row)?])?;
            if count>1000 && uid%10000==0 {eprintln!("synthetic_changed_flags_seed rows={uid}");}
        }
        drop(insert);
        if count>1000 {morrow_search::store::register_functions(&db.conn)?;}
        db.set_settings(&json!({"mailReconcile":{OWNER:{"connection":saved_proof,"after":0,"folder":"", "folders":{
            "INBOX":{"connection":saved_proof,"validity":55,"modseq":warm_modseq,"pending":[],"scan":null}}}}}))?;
        Ok(())
    })).await.unwrap();
    proof
}
async fn changed_sync(
    fixture: &ImapFixture,
    cache: &CacheWorkspace,
) -> morrow_search::error::Result<()> {
    morrow_search::reconcile::sync_with_tls(
        cache.app(),
        &fixture.mail,
        &mut Default::default(),
        &fixture.connector,
    )
    .await
}

#[tokio::test]
async fn unchanged_modseq_uses_remote_snapshot_and_legacy_or_invalid_proofs_reread_flags() {
    for qresync in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: if qresync {
                "IMAP4rev1 ENABLE CONDSTORE QRESYNC"
            } else {
                "IMAP4rev1 CONDSTORE"
            },
            highest_modseq: Some(10),
            remote_read: false,
            remote_starred: false,
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 1, 10).await;
        cache
            .app()
            .db(|db| {
                db.update(
                    OWNER,
                    "imap:55:1",
                    &json!({"read":true,"starred":true,"localOverrides":{"starred":true}}),
                )?;
                Ok(())
            })
            .await
            .unwrap();
        for _ in 0..2 {
            let row = cache
                .app()
                .db(|db| db.get(OWNER, "imap:55:1"))
                .await
                .unwrap()
                .unwrap();
            let result = imap::reconcile_with_tls(&fixture.mail, &[row], &fixture.connector)
                .await
                .unwrap();
            assert_eq!(result[0]["read"], false);
            assert_eq!(result[0]["starred"], false);
            let connection = fixture.mail.clone();
            cache
                .app()
                .db(move |db| {
                    morrow_search::mail::import_messages(db, &connection, &result)?;
                    let saved = db.get(OWNER, "imap:55:1")?.unwrap();
                    assert_eq!(saved["read"], false);
                    assert_eq!(saved["starred"], true);
                    assert_eq!(
                        saved["providerSnapshot"],
                        json!({"read":false,"starred":false})
                    );
                    assert_eq!(saved["localOverrides"]["starred"], true);
                    Ok(())
                })
                .await
                .unwrap();
        }
        for invalid in ["legacy", "connection", "rollback", "capability"] {
            let mut row = cache
                .app()
                .db(|db| db.get(OWNER, "imap:55:1"))
                .await
                .unwrap()
                .unwrap();
            match invalid {
                "legacy" => {
                    row.as_object_mut().unwrap().remove("providerSnapshot");
                }
                "connection" => row["imapSyncConnection"] = json!(["replaced"]),
                "rollback" => row["imapModseq"] = json!(11),
                _ => fixture.update(|s| s.capabilities = "IMAP4rev1"),
            }
            let before = fixture.commands().len();
            let result = imap::reconcile_with_tls(&fixture.mail, &[row], &fixture.connector)
                .await
                .unwrap();
            assert_eq!(result[0]["read"], false);
            assert_eq!(result[0]["starred"], false);
            assert!(
                fixture.commands()[before..]
                    .iter()
                    .any(|c| c.ends_with("(UID FLAGS MODSEQ)") || c.ends_with("(UID FLAGS)"))
            );
            assert!(
                !fixture.commands()[before..]
                    .iter()
                    .any(|c| c.contains("CHANGEDSINCE"))
            );
            if invalid == "capability" {
                assert!(result[0]["imapModseq"].is_null());
            }
        }
    }
}

#[tokio::test]
async fn legacy_folder_progress_uses_only_complete_valid_cached_modseq_proofs() {
    for valid in [true, false] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 500,
            highest_modseq: Some(11),
            changed_uids: Some(vec![400]),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 500, 10).await;
        cache
            .app()
            .db(move |db| {
                db.set_settings(&json!({"mailReconcile":{OWNER:{"folders":null}}}))?;
                if !valid {
                    db.update(
                        OWNER,
                        "imap:55:400",
                        &json!({"imapSyncConnection":["replaced"]}),
                    )?;
                }
                Ok(())
            })
            .await
            .unwrap();
        changed_sync(&fixture, &cache).await.unwrap();
        let row = cache
            .app()
            .db(|db| db.get(OWNER, "imap:55:400"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row["read"], valid);
        let state =
            cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]["INBOX"]
                .clone();
        assert_eq!(state["modseq"], if valid { 11 } else { 0 });
        assert_eq!(body_requests(&fixture), 0);
    }
}

#[tokio::test]
async fn restored_modseq_support_cannot_reuse_unvisited_flags_from_the_old_generation() {
    for capability_loss in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 120,
            highest_modseq: Some(11),
            changed_uids: Some(vec![]),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 120, 10).await;
        fixture.update(|s| {
            if capability_loss {
                s.capabilities = "IMAP4rev1";
            } else {
                s.nomodseq = true;
            }
        });
        changed_sync(&fixture, &cache).await.unwrap();
        let old = cache
            .app()
            .db(|db| db.get(OWNER, "imap:55:100"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            old["imapModseq"], 10,
            "unvisited cache retains old physical metadata"
        );
        fixture.update(|s| {
            s.capabilities = "IMAP4rev1 CONDSTORE";
            s.nomodseq = false;
            s.highest_modseq = Some(20);
            s.changed_modseq = Some(8);
            s.changed_uids = Some(vec![100]);
        });
        // New namespace is numerically below the old per-message watermark,
        // even though the current mailbox HIGHESTMODSEQ is larger.
        for _ in 0..2 {
            changed_sync(&fixture, &cache).await.unwrap();
        }
        let current = cache
            .app()
            .db(|db| db.get(OWNER, "imap:55:100"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current["read"], true);
        assert_eq!(current["starred"], true);
        assert_ne!(current["imapSyncEpoch"], old["imapSyncEpoch"]);
        assert_eq!(current["body"], old["body"]);
        assert_eq!(body_requests(&fixture), 0);
    }
}

#[tokio::test]
async fn changed_uid_queue_is_bounded_atomic_and_resumes_after_restart() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 120,
        highest_modseq: Some(11),
        ..Default::default()
    })
    .await;
    let mut cache = CacheWorkspace::new(&fixture.mail).await;
    seed_changed_cache(&fixture, &cache, 120, 10).await;
    let (result, profile) =
        morrow_search::sync_profile::capture(changed_sync(&fixture, &cache)).await;
    result.unwrap();
    assert!(profile["counters"]["messageWrites"].as_u64().unwrap() <= 50);
    let state = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
    assert_eq!(
        state["folders"]["INBOX"]["pending"]
            .as_array()
            .unwrap()
            .len(),
        70
    );
    assert_eq!(state["folders"]["INBOX"]["modseq"], 10);
    let last = cache
        .app()
        .db(|db| {
            Ok(db.conn.query_row(
                "SELECT rowid FROM messages WHERE account=? AND id='imap:55:50'",
                [OWNER],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(state["after"], last);
    drop(cache.app.take());
    cache.app = Some(
        morrow_search::service::App::open(&cache.root, 0, "fictional-cache".into(), "".into())
            .unwrap(),
    );
    for pending in [20, 0] {
        changed_sync(&fixture, &cache).await.unwrap();
        let state =
            cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]["INBOX"]
                .clone();
        assert_eq!(state["pending"].as_array().unwrap().len(), pending);
        assert_eq!(state["modseq"], if pending == 0 { 11 } else { 10 });
    }
    let saved = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert_eq!(saved.len(), 120);
    assert!(
        saved.iter().all(|m| m["read"] == true
            && m["pending"] == true
            && m["body"] == "Owned synthetic body")
    );
    assert_eq!(body_requests(&fixture), 0);
}

#[tokio::test]
async fn discovery_yields_across_sparse_uid_windows_and_limits_queued_uids() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 100_000,
        highest_modseq: Some(11),
        changed_uids: Some(vec![]),
        ..Default::default()
    })
    .await;
    let proof = imap::reconcile_with_tls(
        &fixture.mail,
        &[json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1"})],
        &fixture.connector,
    )
    .await
    .unwrap()[0]["imapSyncConnection"]
        .clone();
    let mut checkpoint =
        json!({"connection":proof,"validity":55,"modseq":10,"pending":[],"scan":null});
    for after in [32_000, 64_000, 96_000] {
        let before = fixture.commands().len();
        checkpoint = imap::discover_changes_with_tls(
            &fixture.mail,
            "INBOX",
            &checkpoint,
            &fixture.connector,
        )
        .await
        .unwrap();
        assert_eq!(checkpoint["scan"]["after"], after);
        assert_eq!(checkpoint["modseq"], 10);
        assert!(checkpoint["pending"].as_array().unwrap().is_empty());
        assert_eq!(
            fixture.commands()[before..]
                .iter()
                .filter(|c| c.contains("(UID MODSEQ)"))
                .count(),
            32
        );
    }
    fixture.update(|s| s.changed_uids = None);
    checkpoint =
        imap::discover_changes_with_tls(&fixture.mail, "INBOX", &checkpoint, &fixture.connector)
            .await
            .unwrap();
    assert_eq!(checkpoint["pending"].as_array().unwrap().len(), 1000);
    assert_eq!(checkpoint["scan"]["after"], 97_000);
    let before = fixture.commands().len();
    let same =
        imap::discover_changes_with_tls(&fixture.mail, "INBOX", &checkpoint, &fixture.connector)
            .await
            .unwrap();
    assert_eq!(same, checkpoint);
    assert!(
        !fixture.commands()[before..]
            .iter()
            .any(|c| c.starts_with("UID FETCH"))
    );
}

#[tokio::test]
async fn discovery_downgrades_and_generation_changes_discard_stale_queues() {
    for mode in [
        "capability",
        "nomodseq",
        "rejected",
        "ignored",
        "missing-modseq",
        "rollback",
        "validity",
        "connection",
    ] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 120,
            highest_modseq: Some(11),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 120, 10).await;
        changed_sync(&fixture, &cache).await.unwrap();
        let old = cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]["INBOX"]
            .clone();
        let mut connection = fixture.mail.clone();
        fixture.update(|s| match mode {
            "capability" => s.capabilities = "IMAP4rev1",
            "nomodseq" => s.nomodseq = true,
            "rejected" => s.extension_rejected = true,
            "ignored" => {
                s.ignore_changed_since = true;
                s.changed_uids = Some(vec![]);
            }
            "missing-modseq" => s.omit_changed_modseq = true,
            "rollback" => s.highest_modseq = Some(5),
            "validity" => s.validity = 66,
            _ => {}
        });
        // Rejected/ignored modifiers are detected on the next discovery query.
        let mut input = old.clone();
        if ["ignored", "missing-modseq"].contains(&mode) {
            input["pending"] = json!([]);
            input["scan"] = Value::Null;
        }
        if mode == "connection" {
            connection["connectionId"] = json!("replacement");
        }
        let state =
            imap::discover_changes_with_tls(&connection, "INBOX", &input, &fixture.connector)
                .await
                .unwrap();
        if [
            "capability",
            "nomodseq",
            "rejected",
            "ignored",
            "missing-modseq",
        ]
        .contains(&mode)
        {
            assert!(state["modseq"].is_null(), "{mode}: {state}");
            assert!(state["pending"].as_array().unwrap().is_empty());
        } else {
            assert_eq!(state["modseq"], 0);
            assert_eq!(state["scan"]["since"], 0);
            if mode == "validity" {
                assert_eq!(state["validity"], 66);
            }
            if mode == "connection" {
                assert_ne!(state["connection"], old["connection"]);
            }
        }
        if mode == "validity" {
            changed_sync(&fixture, &cache).await.unwrap();
            let row = cache
                .app()
                .db(|db| db.get(OWNER, "imap:55:51"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row["read"], false);
            assert_eq!(row["providerFolderMissing"], true);
            assert_eq!(row["body"], "Owned synthetic body");
            let progress = cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]
                ["INBOX"]
                .clone();
            assert_eq!(progress["validity"], 66, "new generation: {progress}");
            assert_eq!(progress["modseq"], 11, "new generation: {progress}");
            assert!(progress["pending"].as_array().unwrap().is_empty());
            assert!(progress["scan"].is_null());
            changed_sync(&fixture, &cache).await.unwrap();
            let again =
                cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]["INBOX"]
                    .clone();
            assert_eq!(again["validity"], 66);
            assert_eq!(
                again["modseq"], 11,
                "retained old mail reset progress: {again}"
            );
            assert!(again["pending"].as_array().unwrap().is_empty());
            let kept = cache
                .app()
                .db(|db| db.get(OWNER, "imap:55:51"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(kept["providerFolderMissing"], true);
            assert_eq!(kept["body"], "Owned synthetic body");
        }
    }
}

#[tokio::test]
async fn failed_discovery_flag_reads_and_database_writes_retain_all_progress() {
    for mode in ["wrong-uid", "duplicate-uid", "read-failure", "database"] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 100,
            highest_modseq: Some(11),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 100, 10).await;
        let before = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
        fixture.update(|s| match mode {
            "wrong-uid" => s.wrong_uid = true,
            "duplicate-uid" => s.duplicate_uid = true,
            "read-failure" => s.fetch_failure = true,
            _ => {}
        });
        if mode == "database" {
            cache.app().db(|db| {
                db.conn.execute_batch("CREATE TEMP TABLE sync_write_count(n INTEGER); INSERT INTO sync_write_count VALUES(0); CREATE TEMP TRIGGER reject_sync BEFORE UPDATE ON messages BEGIN UPDATE sync_write_count SET n=n+1; SELECT CASE WHEN (SELECT n FROM sync_write_count)=2 THEN RAISE(ABORT,'synthetic write failure') END; END;")?;
                Ok(())
            }).await.unwrap();
        }
        assert!(changed_sync(&fixture, &cache).await.is_err(), "{mode}");
        assert_eq!(
            cache.app().settings().await.unwrap()["mailReconcile"][OWNER],
            before
        );
        let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
        assert!(rows.iter().all(|row| row["read"] == false));
    }
}

#[tokio::test]
async fn changed_sync_rejects_concurrent_checkpoint_and_connection_replacement() {
    for replace_connection in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 10,
            highest_modseq: Some(11),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 10, 10).await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        fixture.update(|s| s.pause_discovery = Some((entered.clone(), resume.clone())));
        let (app, connection, connector) = (
            cache.app().clone(),
            fixture.mail.clone(),
            fixture.connector.clone(),
        );
        let task = tokio::spawn(async move {
            morrow_search::reconcile::sync_with_tls(
                &app,
                &connection,
                &mut Default::default(),
                &connector,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        cache
            .app()
            .db(move |db| {
                let mut config = db.settings()?;
                if replace_connection {
                    config["mailAccounts"][OWNER]["connectionId"] = json!("replaced");
                } else {
                    config["mailReconcile"][OWNER]["after"] = json!(123);
                }
                db.set_settings(&config)?;
                Ok(())
            })
            .await
            .unwrap();
        resume.notify_one();
        assert_eq!(task.await.unwrap().unwrap_err().status, 409);
        let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
        assert!(rows.iter().all(|row| row["read"] == false));
    }
}

#[tokio::test]
async fn capability_loss_between_discovery_and_flags_invalidates_modseq_progress() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 10,
        highest_modseq: Some(11),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    seed_changed_cache(&fixture, &cache, 10, 10).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    fixture.update(|s| s.pause_discovery = Some((entered.clone(), resume.clone())));
    let (app, connection, connector) = (
        cache.app().clone(),
        fixture.mail.clone(),
        fixture.connector.clone(),
    );
    let task = tokio::spawn(async move {
        morrow_search::reconcile::sync_with_tls(
            &app,
            &connection,
            &mut Default::default(),
            &connector,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    fixture.update(|s| {
        s.capabilities = "IMAP4rev1";
        s.pause_discovery = None;
    });
    resume.notify_one();
    task.await.unwrap().unwrap();
    let settings = cache.app().settings().await.unwrap();
    assert!(settings["mailReconcile"][OWNER]["folders"]["INBOX"]["modseq"].is_null());
    let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert!(
        rows.iter()
            .all(|row| row["read"] == true && row["imapModseq"].is_null())
    );
}

#[tokio::test]
async fn in_flight_reconciliation_preserves_new_provider_locations_and_confirmed_flags() {
    for moved in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 CONDSTORE",
            count: 10,
            highest_modseq: Some(11),
            ..Default::default()
        })
        .await;
        let cache = CacheWorkspace::new(&fixture.mail).await;
        seed_changed_cache(&fixture, &cache, 10, 10).await;
        let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        fixture.update(|s| s.pause_flags = Some((entered.clone(), resume.clone())));
        let (app, connection, connector) = (
            cache.app().clone(),
            fixture.mail.clone(),
            fixture.connector.clone(),
        );
        let task = tokio::spawn(async move {
            morrow_search::reconcile::sync_with_tls(
                &app,
                &connection,
                &mut Default::default(),
                &connector,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let patch = if moved {
            json!({"remoteId":"imap:55:101","providerFolderId":"Other"})
        } else {
            json!({"read":true,"providerSnapshot":{"read":true,"starred":false}})
        };
        let saved = patch.clone();
        cache
            .app()
            .db(move |db| {
                db.update(OWNER, "imap:55:1", &saved)?;
                Ok(())
            })
            .await
            .unwrap();
        resume.notify_one();
        assert_eq!(task.await.unwrap().unwrap_err().status, 409);
        assert_eq!(
            cache.app().settings().await.unwrap()["mailReconcile"][OWNER],
            checkpoint
        );
        let row = cache
            .app()
            .db(|db| db.get(OWNER, "imap:55:1"))
            .await
            .unwrap()
            .unwrap();
        for (key, value) in patch.as_object().unwrap() {
            assert_eq!(&row[key], value);
        }
    }
}

#[tokio::test]
async fn incremental_changes_keep_folder_and_account_identity_and_use_bounded_sql() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 500,
        highest_modseq: Some(11),
        changed_uids: Some(vec![400]),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    seed_changed_cache(&fixture, &cache, 500, 10).await;
    cache.app().db(|db| {
        let row=db.get(OWNER,"imap:55:400")?.unwrap();
        db.upsert("other@example.invalid",&row)?;
        let mut moved=row.clone(); moved["id"]=json!("stable-local"); moved["remoteId"]=json!("imap:55:400");
        moved["folder"]=json!("archive"); moved["providerFolderId"]=json!("Other");
        db.upsert(OWNER,&moved)?;
        let mut plan=db.conn.prepare("EXPLAIN QUERY PLAN SELECT rowid,data FROM messages WHERE account=? AND rowid>? ORDER BY rowid LIMIT 50")?;
        let details:Vec<String>=plan.query_map(rusqlite::params![OWNER,0],|row|row.get(3))?.collect::<Result<_,_>>()?;
        assert!(details.iter().any(|p|p.contains("mail_reconcile")&&p.contains("rowid>")),"{details:?}");
        assert!(!details.iter().any(|p|p.contains("TEMP B-TREE")));
        Ok(())
    }).await.unwrap();
    changed_sync(&fixture, &cache).await.unwrap();
    cache
        .app()
        .db(|db| {
            assert_eq!(db.get(OWNER, "imap:55:400")?.unwrap()["read"], true);
            assert_eq!(
                db.get("other@example.invalid", "imap:55:400")?.unwrap()["read"],
                false
            );
            assert_eq!(db.get(OWNER, "stable-local")?.unwrap()["read"], false);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(body_requests(&fixture), 0);
    fixture.update(|s| {
        s.highest_modseq = Some(12);
        s.remote_read = false;
        s.remote_starred = false;
    });
    // Discovery fairly rotates the two cached provider folders. Other is
    // checked next, then INBOX, independent of the ordinary row rotation.
    changed_sync(&fixture, &cache).await.unwrap();
    changed_sync(&fixture, &cache).await.unwrap();
    let row = cache
        .app()
        .db(|db| db.get(OWNER, "imap:55:400"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row["read"], false);
    assert_eq!(row["starred"], false);
    assert_eq!(
        row["providerSnapshot"],
        json!({"read":false,"starred":false})
    );
}

#[tokio::test]
async fn reconnect_to_another_origin_never_reuses_old_body_flags_or_reconciliation_rows() {
    let first = ImapFixture::new(ImapScenario {
        count: 1,
        raw_message: Some(format!("{HEADER}\r\nOld retained content.")),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&first.mail).await;
    cache.page(&first, &first.mail, "inbox").await;
    cache
        .app()
        .db(|db| {
            db.update(
                OWNER,
                "imap:55:1",
                &json!({"pending":true,"folder":"archive","starred":true}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let retained = cache
        .app()
        .db(|db| db.get(OWNER, "imap:55:1"))
        .await
        .unwrap()
        .unwrap();
    let second = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 1,
        highest_modseq: Some(10),
        raw_message: Some(format!("{HEADER}\r\nNew provider content.")),
        remote_read: false,
        remote_starred: false,
        ..Default::default()
    })
    .await;
    let connection = second.mail.clone();
    cache
        .app()
        .db(move |db| db.set_settings(&json!({"mailAccounts":{OWNER:connection}})))
        .await
        .unwrap();
    cache.page(&second, &second.mail, "inbox").await;
    assert_eq!(body_requests(&first), 1);
    assert_eq!(
        body_requests(&second),
        1,
        "same UID/Message-ID must not reuse another server's body"
    );
    second.update(|scenario| {
        scenario.highest_modseq = Some(11);
        scenario.remote_read = true;
    });
    changed_sync(&second, &cache).await.unwrap();
    let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter().find(|row| row["id"] == "imap:55:1").unwrap(),
        &retained
    );
    let live = rows.iter().find(|row| row["id"] != "imap:55:1").unwrap();
    assert_eq!(live["read"], true);
    assert_eq!(live["starred"], false);
    assert_ne!(live["pending"], true);
    assert!(string(live, "body").contains("New provider content."));
    assert_eq!(
        live["imapOrigin"],
        imap::server_origin(&second.mail).unwrap()
    );
    assert_eq!(
        body_requests(&second),
        1,
        "reconciliation must remain flags-only"
    );
}

#[tokio::test]
async fn folder_rotation_wraps_to_the_folder_that_sorts_before_inbox() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 2,
        highest_modseq: Some(11),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    let origin = imap::server_origin(&fixture.mail).unwrap();
    cache
        .app()
        .db(move |db| {
            for (uid, folder) in [(1, "Archive"), (2, "INBOX")] {
                let row = json!({
                    "id": format!("imap:55:{uid}"),
                    "imapOrigin": origin,
                    "folder": if folder == "INBOX" { "inbox" } else { "archive" },
                    "providerFolderId": folder,
                    "read": false,
                    "starred": false,
                    "pending": true,
                    "body": "Owned synthetic body",
                    "bodyHtml": "",
                    "labels": [],
                    "providerSnapshot": {"read": false, "starred": false}
                });
                db.upsert(OWNER, &row)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut seen = Vec::new();
    for _ in 0..3 {
        changed_sync(&fixture, &cache).await.unwrap();
        let settings = cache.app().settings().await.unwrap();
        seen.push(string(&settings["mailReconcile"][OWNER], "folder").to_owned());
    }
    assert_eq!(seen, ["Archive", "INBOX", "Archive"]);
}

#[tokio::test]
async fn discovery_accepts_async_vanished_expunge_and_still_rejects_earlier() {
    for earlier in [false, true] {
        let fixture = ImapFixture::new(ImapScenario {
            capabilities: "IMAP4rev1 ENABLE CONDSTORE QRESYNC",
            count: 20,
            highest_modseq: Some(11),
            changed_uids: Some(vec![5]),
            discovery_vanished: Some(DiscoveryVanished { earlier, uid: 4 }),
            ..Default::default()
        })
        .await;
        let proof = imap::reconcile_with_tls(
            &fixture.mail,
            &[json!({"imapOrigin":imap::server_origin(&fixture.mail).unwrap(),"id":"imap:55:1"})],
            &fixture.connector,
        )
        .await
        .unwrap()[0]["imapSyncConnection"]
            .clone();
        let checkpoint =
            json!({"connection":proof,"validity":55,"modseq":10,"pending":[],"scan":null});
        let result = imap::discover_changes_with_tls(
            &fixture.mail,
            "INBOX",
            &checkpoint,
            &fixture.connector,
        )
        .await;
        if earlier {
            assert_eq!(result.unwrap_err().body["code"], "provider_incomplete_read");
        } else {
            let state = result.unwrap();
            assert!(
                state["pending"].as_array().unwrap().contains(&json!(5)),
                "async expunge must not abort discovery: {state}"
            );
            assert_eq!(state["modseq"], 10);
            assert!(state["scan"].is_object());
        }
    }
}

#[tokio::test]
async fn full_changed_queue_still_advances_nonoverlapping_rotation() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 110,
        highest_modseq: Some(11),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    let proof = seed_changed_cache(&fixture, &cache, 110, 10).await;
    let pending: Vec<_> = (51..=110).map(|uid| json!(uid)).collect();
    cache
        .app()
        .db(move |db| {
            let mut settings = db.settings()?;
            settings["mailReconcile"][OWNER] = json!({
                "connection": proof,
                "after": 0,
                "folder": "INBOX",
                "capabilityEnabled": true,
                "folders": {
                    "INBOX": {
                        "connection": proof,
                        "validity": 55,
                        "modseq": 10,
                        "pending": pending,
                        "scan": {"since": 10, "target": 11, "upper": 110, "after": 110},
                        "enabled": true
                    }
                }
            });
            db.set_settings(&settings)?;
            Ok(())
        })
        .await
        .unwrap();
    changed_sync(&fixture, &cache).await.unwrap();
    let state = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
    let head = cache
        .app()
        .db(|db| {
            Ok(db.conn.query_row(
                "SELECT rowid FROM messages WHERE account=? AND id='imap:55:1'",
                [OWNER],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    let message = |id: &str| {
        let id = id.to_owned();
        cache.app().db(move |db| db.get(OWNER, &id))
    };
    assert_eq!(state["after"], head);
    assert_eq!(state["folders"]["INBOX"]["pending"][0], 100);
    assert_eq!(message("imap:55:1").await.unwrap().unwrap()["read"], true);
    assert_eq!(message("imap:55:2").await.unwrap().unwrap()["read"], false);
    assert_eq!(message("imap:55:51").await.unwrap().unwrap()["read"], true);
    assert_eq!(
        message("imap:55:100").await.unwrap().unwrap()["read"],
        false
    );
}

#[tokio::test]
#[ignore = "Explicit synthetic sync benchmark; local TLS fixtures only"]
async fn synthetic_imap_sync_benchmark() {
    let fixture = ImapFixture::new(ImapScenario {
        body_size: 2048,
        ..Default::default()
    })
    .await;
    let root = std::env::temp_dir().join(format!("morrow-imap-bench-{}", uuid::Uuid::new_v4()));
    let app = morrow_search::service::App::open(&root, 0, "fixture".into(), String::new()).unwrap();
    let connection = fixture.mail.clone();
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:connection}}))?;
        Ok(())
    })
    .await
    .unwrap();
    let mut checkpoint = Value::Null;
    let mut samples = Vec::new();
    for round in 0..6 {
        let before = fixture.commands().len();
        let begin = std::time::Instant::now();
        let (result, profile) = morrow_search::sync_profile::capture(async {
            let page = imap::fetch_page_cached_with_tls(
                &app,
                &fixture.mail,
                &json!({"incremental":true,"syncCheckpoints":{"INBOX":checkpoint}}),
                &fixture.connector,
            )
            .await?;
            let messages = page["messages"].as_array().unwrap().clone();
            let connection = fixture.mail.clone();
            app.db(move |db| {
                morrow_search::mail::import_messages(db, &connection, &messages)?;
                Ok(())
            })
            .await?;
            let cached = app.db(|db| db.list(OWNER)).await?;
            let rows = imap::reconcile_with_tls(&fixture.mail, &cached, &fixture.connector).await?;
            let connection = fixture.mail.clone();
            app.db(move |db| {
                morrow_search::mail::import_messages(db, &connection, &rows)?;
                Ok(())
            })
            .await?;
            Ok::<_, morrow_search::error::Error>(page["syncCheckpoint"].clone())
        })
        .await;
        checkpoint = result.unwrap();
        samples.push(json!({"round":round,"wallMs":begin.elapsed().as_secs_f64()*1000.0,"commands":fixture.commands().len()-before,"profile":profile}));
    }
    println!(
        "synthetic_imap_benchmark {}",
        json!({"provider":"imap","samples":samples,"scope":"50 cached immutable rows and bounded flag reconciliation; local TLS fixture only, excludes native UI and real-provider latency."})
    );
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[ignore = "Explicit 50k synthetic flag benchmark; local TLS and temporary stores only"]
async fn synthetic_changed_flags_benchmark() {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE",
        count: 50_000,
        highest_modseq: Some(11),
        changed_uids: Some(vec![25_000]),
        remote_read: true,
        remote_starred: true,
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    let start_seed = std::time::Instant::now();
    seed_changed_cache(&fixture, &cache, 50_000, 10).await;
    let seed_ms = start_seed.elapsed().as_secs_f64() * 1000.0;
    cache.app().db(|db| {
        db.conn.execute_batch("CREATE TEMP TABLE bench_counts(writes INTEGER,text_changes INTEGER); INSERT INTO bench_counts VALUES(0,0);
            CREATE TEMP TRIGGER bench_message AFTER UPDATE ON messages BEGIN UPDATE bench_counts SET writes=writes+1; END;
            CREATE TEMP TRIGGER bench_text AFTER UPDATE ON search_documents WHEN old.body IS NOT new.body OR old.subject IS NOT new.subject BEGIN UPDATE bench_counts SET text_changes=text_changes+1; END;")?;
        Ok(())
    }).await.unwrap();
    let before = fixture.commands().len();
    let (result, profile) = morrow_search::sync_profile::capture(async {
        for round in 1..=1000 {
            changed_sync(&fixture, &cache).await?;
            let row = cache
                .app()
                .db(|db| db.get(OWNER, "imap:55:25000"))
                .await?
                .unwrap();
            if row["read"] == true && row["starred"] == true {
                assert_eq!(row["providerSnapshot"], json!({"read":true,"starred":true}));
                assert_eq!(row["pending"], true);
                assert_eq!(row["body"].as_str().unwrap().len(), 2100);
                return Ok::<_, morrow_search::error::Error>(round);
            }
            if round % 100 == 0 {
                eprintln!("synthetic_changed_flags_progress rounds={round}");
            }
        }
        panic!("synthetic flag change was not synchronized within 1000 rounds");
    })
    .await;
    let rounds = result.unwrap();
    let commands = fixture.commands();
    let commands = &commands[before..];
    let counts = cache
        .app()
        .db(|db| {
            Ok(db
                .conn
                .query_row("SELECT writes,text_changes FROM bench_counts", [], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?)
        })
        .await
        .unwrap();
    let report = json!({"fixture":{"cachedMessages":50_000,"changedUid":25_000,"bodyBytes":2100,"initialModseq":10,"remoteModseq":11},
        "rounds":rounds,"profile":profile,"commands":commands.len(),
        "discoveryCommands":commands.iter().filter(|c|c.contains("(UID MODSEQ)")).count(),
        "bodyRequests":body_requests(&fixture),"messageWrites":counts.0,"indexedTextChanges":counts.1,"seedMs":seed_ms,
        "scope":"Warm synthetic cache/checkpoint, local TLS, debug build; excludes polling intervals, WAN, real accounts and native UI."});
    println!("synthetic_changed_flags_benchmark {report}");
    if let Some(path) = std::env::var_os("MORROW_IMAP_BENCH_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}
