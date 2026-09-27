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
    mapping: Option<&'static str>,
    extra_mapping: Option<&'static str>,
}
impl Default for ImapScenario {
    fn default() -> Self {
        Self {
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
            mapping: Some("88 7 19"),
            extra_mapping: None,
        }
    }
}
struct ImapFixture {
    mail: Value,
    connector: native_tls::TlsConnector,
    state: Arc<Mutex<ImapScenario>>,
    log: Log,
    failures: Log,
    task: JoinHandle<()>,
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
        let (saved_log, saved_state) = (log.clone(), state.clone());
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    result=listener.accept()=>{
                        let Ok((socket,_))=result else{break};
                        let (acceptor,log,state)=(acceptor.clone(),saved_log.clone(),saved_state.clone());
                        sessions.spawn(checked_session(async move {
                            let Ok(socket)=acceptor.accept(socket).await else{return Ok(())};
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
            &json!({"id":"stable-local","remoteId":"imap:55:7","providerFolderId":"INBOX"}),
            &destination,
            "move",
            &self.connector,
        )
        .await
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
        } else if upper.starts_with("LIST ") {
            let sent = if scenario.sent {
                format!("* LIST (\\Sent) \"/\" \"{SENT_WIRE}\"\r\n")
            } else {
                String::new()
            };
            let hidden = (0..scenario.hidden_folders)
                .map(|index| format!("* LIST (\\Noselect) \"/\" \"Hidden{index}\"\r\n"))
                .collect::<String>();
            write(&mut stream,&format!("* LIST () \"/\" \"INBOX\"\r\n{sent}* LIST () \"/\" \"&mAV27g- &- stuff\"\r\n{hidden}{}{tag} OK list\r\n",scenario.extra_folders)).await?;
        } else if upper.starts_with("EXAMINE ") || upper.starts_with("SELECT ") {
            let next = if scenario.omit_uidnext {
                String::new()
            } else {
                format!(
                    "* OK [UIDNEXT {}] next\r\n",
                    scenario.uidnext.unwrap_or(scenario.count + 1)
                )
            };
            write(&mut stream,&format!("* FLAGS (\\Seen \\Flagged)\r\n* {} EXISTS\r\n* OK [UIDVALIDITY {}] stable\r\n{next}{tag} OK selected\r\n",scenario.count,scenario.validity)).await?;
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
            let ids = ids
                .into_iter()
                .filter(|id| scenario.search_outside || (*id >= lower && *id <= upper))
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(" ");
            write(
                &mut stream,
                &format!("* SEARCH {ids}\r\n{tag} OK search\r\n"),
            )
            .await?;
        } else if upper.starts_with("UID FETCH ") {
            let args = command.splitn(4, ' ').collect::<Vec<_>>();
            let selected = args[2];
            let fields = args[3];
            if fields.contains("RFC822.SIZE") {
                let header = if scenario.oversized_header {
                    "x".repeat(65537)
                } else {
                    HEADER.to_owned()
                };
                for (index, uid) in selected.split(',').enumerate() {
                    let uid = if scenario.wrong_uid {
                        "99999"
                    } else if scenario.duplicate_uid {
                        selected.split(',').next().unwrap()
                    } else {
                        uid
                    };
                    write(&mut stream,&format!("* {} FETCH (UID {uid} FLAGS (\\Seen \\Flagged) RFC822.SIZE {} INTERNALDATE \"23-Sep-2026 12:00:00 +0000\" BODY[HEADER] {{{}}}\r\n{header})\r\n",index+1,if scenario.large{6*1024*1024}else{HEADER.len()+50},header.len())).await?;
                }
            } else if fields.contains("BODY.PEEK[]") {
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
                let body = if scenario.oversized_body {
                    "x".repeat(5 * 1024 * 1024 + 1)
                } else if scenario.body_size > 0 {
                    format!(
                        "{HEADER}\r\n{{536870912}}\r\n{}",
                        "x".repeat(scenario.body_size)
                    )
                } else {
                    format!("{HEADER}\r\nFixture body for UID {selected}.\r\n")
                };
                write(
                    &mut stream,
                    &format!(
                        "* 1 FETCH (UID {selected} BODY[] {{{}}}\r\n{body})\r\n",
                        body.len()
                    ),
                )
                .await?;
            } else {
                let uid = if selected == "*" {
                    scenario.count.to_string()
                } else {
                    selected.to_owned()
                };
                write(&mut stream, &format!("* 1 FETCH (UID {uid})\r\n")).await?;
            }
            write(&mut stream, &format!("{tag} OK fetch\r\n")).await?;
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
    assert!(fixture.fetch(json!({})).await.is_err());
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
            .any(|line| line.contains("SENTSINCE 01-Jun-2026 SENTBEFORE 25-Sep-2026"))
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
    let fixture = ImapFixture::new(ImapScenario::default()).await;
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
    let before = fixture.commands().len();
    let same = imap::organize_with_tls(
        &fixture.mail,
        &json!({"id":"stable-local","remoteId":"imap:55:7","providerFolderId":SENT}),
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
    assert!(fixture.fetch(json!({})).await.is_err());
    assert!(
        !fixture
            .commands()
            .iter()
            .any(|line| line.starts_with("EXAMINE"))
    );
    let before = fixture.commands().len();
    assert!(imap::fetch_page(&fixture.mail, &json!({})).await.is_err());
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
