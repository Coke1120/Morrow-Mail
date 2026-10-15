//! Real TLS protocol failures plus the production durable recovery route.
use super::*;
use axum::http::{HeaderMap, Method};
use morrow_search::{error::Result, imap_moves, service::Context};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

const OTHER: &str = "second@example.invalid";

#[derive(Clone)]
struct Scenario {
    capabilities: &'static str,
    failure: &'static str,
    source: bool,
    deleted: bool,
    destination: bool,
    destination_deleted: bool,
    destination_read: bool,
    destination_starred: bool,
    highest_modseq: Option<u64>,
    source_validity: u32,
    target_validity: u32,
    unrelated_deleted: bool,
    // Changes happen after the exact wire command, before its completion.
    change_connection_after_copy: bool,
}
impl Default for Scenario {
    fn default() -> Self {
        Self {
            capabilities: "IMAP4rev1 UIDPLUS",
            failure: "",
            source: true,
            deleted: false,
            destination: false,
            destination_deleted: false,
            destination_read: false,
            destination_starred: true,
            highest_modseq: None,
            source_validity: 55,
            target_validity: 99,
            unrelated_deleted: true,
            change_connection_after_copy: false,
        }
    }
}

struct MoveFixture {
    cache: CacheWorkspace,
    mail: Value,
    message: Value,
    connector: native_tls::TlsConnector,
    state: Arc<Mutex<Scenario>>,
    log: Log,
    stages: Log,
    failures: Log,
    active: Arc<AtomicUsize>,
    held: Arc<Notify>,
    release: Arc<Notify>,
    audit_app: Arc<Mutex<Option<morrow_search::service::App>>>,
    task: Option<JoinHandle<()>>,
}
impl Drop for MoveFixture {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl MoveFixture {
    async fn new(scenario: Scenario) -> Self {
        let (cert, acceptor) = tls();
        let connector = trusted(&cert);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mail = json!({"provider":"imap","email":OWNER,"password":"fictional-move-only","connectionId":"move-generation-a","imapHost":"127.0.0.1","imapPort":port});
        let cache = CacheWorkspace::new(&mail).await;
        let message = json!({"id":"stable-local","remoteId":"imap:55:7","imapOrigin":imap::server_origin(&mail).unwrap(),"providerFolderId":"INBOX","providerFolderName":"Inbox","folder":"inbox","subject":"Owned move fixture","body":"Downloaded body retained","date":"2026-01-01T00:00:00.000Z","pending":true,"starred":true,"localOverrides":{"folder":true,"labels":true},"labels":["local choice"]});
        let original = message.clone();
        let mut other = mail.clone();
        other["email"] = OTHER.into();
        cache
            .app()
            .db(move |db| {
                let mut config = db.settings()?;
                config["mailAccounts"][OTHER] = other;
                config["activeAccount"] = OTHER.into();
                db.set_settings(&config)?;
                db.upsert(OWNER, &original)?;
                let mut duplicate = original;
                duplicate["subject"] = "Other mailbox".into();
                db.upsert(OTHER, &duplicate)?;
                Ok(())
            })
            .await
            .unwrap();
        let state = Arc::new(Mutex::new(scenario));
        let log: Log = Default::default();
        let stages: Log = Default::default();
        let failures: Log = Default::default();
        let active = Arc::new(AtomicUsize::new(0));
        let held = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let audit_app = Arc::new(Mutex::new(Some(cache.app().clone())));
        let (
            saved_state,
            saved_log,
            saved_stages,
            saved_failures,
            saved_active,
            saved_held,
            saved_release,
            app,
        ) = (
            state.clone(),
            log.clone(),
            stages.clone(),
            failures.clone(),
            active.clone(),
            held.clone(),
            release.clone(),
            audit_app.clone(),
        );
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    incoming=listener.accept()=>{
                        let Ok((socket,_))=incoming else{break};
                        let (acceptor,state,log,stages,active,held,release,app)=(acceptor.clone(),saved_state.clone(),saved_log.clone(),saved_stages.clone(),saved_active.clone(),saved_held.clone(),saved_release.clone(),app.clone());
                        sessions.spawn(checked_session(async move {
                            let Ok(socket)=acceptor.accept(socket).await else{return Ok(())};
                            active.fetch_add(1,Ordering::SeqCst);let _active=ActiveImapSession(active);
                            session(socket,state,log,stages,held,release,app).await
                        },saved_failures.clone()));
                    }
                    _=sessions.join_next(),if !sessions.is_empty()=>{}
                }
            }
        });
        Self {
            cache,
            mail,
            message,
            connector,
            state,
            log,
            stages,
            failures,
            active,
            held,
            release,
            audit_app,
            task: Some(task),
        }
    }
    fn update(&self, update: impl FnOnce(&mut Scenario)) {
        update(&mut self.state.lock().unwrap());
    }
    fn commands(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn mutations(&self) -> Vec<String> {
        self.commands()
            .into_iter()
            .filter(|line| {
                line.starts_with("UID COPY ")
                    || line.starts_with("UID MOVE ")
                    || line.starts_with("UID STORE ")
                    || line.starts_with("UID EXPUNGE ")
                    || line == "EXPUNGE"
            })
            .collect()
    }
    async fn organize(&self) -> Result<(Value, Option<String>)> {
        imap_moves::organize_with_tls(
            self.cache.app(),
            &self.mail,
            &self.message,
            &json!({"id":"Archive","name":"Archive","kind":"archive"}),
            "move",
            Some(&self.connector),
        )
        .await
    }
    async fn records(&self) -> Vec<Value> {
        self.cache.app().settings().await.unwrap()["imapMoveJournal"][OWNER]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    async fn route(&self, method: Method, owner: &str, suffix: &str, body: Value) -> Result<Value> {
        let mut headers = HeaderMap::new();
        headers.insert("x-genmail-account", owner.parse().unwrap());
        let ctx = Context {
            method,
            path: format!("mail/moves{suffix}")
                .split('/')
                .map(str::to_owned)
                .collect(),
            body,
            query: json!({}),
            headers,
            owner: OTHER.into(),
            paged: true,
        };
        let response = imap_moves::handle_with_tls(self.cache.app(), &ctx, Some(&self.connector))
            .await?
            .unwrap();
        Ok(serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap())
    }
    async fn list(&self) -> Value {
        self.route(Method::GET, OWNER, "", json!({})).await.unwrap()
    }
    async fn preview(&self, op: &Value) -> Result<Value> {
        self.route(
            Method::POST,
            OWNER,
            &format!("/{}/preview", string(op, "id")),
            json!({"operationRef":op["operationRef"]}),
        )
        .await
    }
    async fn finish(&self, op: &Value) -> Result<Value> {
        self.route(
            Method::POST,
            OWNER,
            &format!("/{}/finish", string(op, "id")),
            json!({"operationRef":op["operationRef"],"reviewRef":op["reviewRef"],"confirmed":true}),
        )
        .await
    }
    async fn drained(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.active.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("The owned move socket was not dropped");
    }
    async fn restart(&mut self) {
        self.drained().await;
        let before = self.commands();
        drop(self.audit_app.lock().unwrap().take());
        drop(self.cache.app.take());
        let app = morrow_search::service::App::open(
            &self.cache.root,
            0,
            "fictional-reopened".into(),
            "".into(),
        )
        .unwrap();
        *self.audit_app.lock().unwrap() = Some(app.clone());
        self.cache.app = Some(app);
        assert!(!self.records().await.is_empty());
        assert_eq!(
            self.commands(),
            before,
            "Reopening must not replay a provider operation"
        );
    }
    async fn close(mut self) {
        self.release.notify_waiters();
        self.drained().await;
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        assert!(
            self.failures.lock().unwrap().is_empty(),
            "{:?}",
            self.failures.lock().unwrap()
        );
        assert!(
            self.state.lock().unwrap().unrelated_deleted,
            "An unrelated deleted UID was expunged"
        );
        drop(self.audit_app.lock().unwrap().take());
        drop(self.cache.app.take());
        std::fs::remove_dir_all(&self.cache.root).unwrap();
    }
}

async fn session<S: AsyncRead + AsyncWrite + Unpin>(
    socket: S,
    state: Arc<Mutex<Scenario>>,
    log: Log,
    stages: Log,
    held: Arc<Notify>,
    release: Arc<Notify>,
    app: Arc<Mutex<Option<morrow_search::service::App>>>,
) -> io::Result<()> {
    let mut socket = BufReader::new(socket);
    write(&mut socket, "* OK move fixture\r\n").await?;
    let mut selected = String::new();
    let mut writable = false;
    while let Some(line) = line(&mut socket).await? {
        let (tag, command) = line.split_once(' ').unwrap();
        log.lock().unwrap().push(command.into());
        let snapshot = state.lock().unwrap().clone();
        if command.starts_with("LOGIN ") {
            write(&mut socket, &format!("{tag} OK login\r\n")).await?;
        } else if command == "CAPABILITY" {
            write(
                &mut socket,
                &format!(
                    "* CAPABILITY {}\r\n{tag} OK capability\r\n",
                    snapshot.capabilities
                ),
            )
            .await?;
        } else if command.starts_with("EXAMINE ") || command.starts_with("SELECT ") {
            selected = command
                .split_once(' ')
                .unwrap()
                .1
                .trim_end_matches(" (CONDSTORE)")
                .trim_matches('"')
                .into();
            assert!(["INBOX", "Archive"].contains(&selected.as_str()));
            writable = command.starts_with("SELECT ");
            let validity = if selected == "INBOX" {
                snapshot.source_validity
            } else {
                snapshot.target_validity
            };
            let modseq = snapshot
                .highest_modseq
                .map(|value| format!("* OK [HIGHESTMODSEQ {value}] flags\r\n"))
                .unwrap_or_default();
            write(&mut socket,&format!("* 2 EXISTS\r\n* OK [UIDVALIDITY {validity}] validity\r\n{modseq}{tag} OK [{}] selected\r\n",if writable{"READ-WRITE"}else{"READ-ONLY"})).await?;
        } else if command.starts_with("UID FETCH ") {
            let uid = command
                .split_whitespace()
                .nth(2)
                .unwrap()
                .parse::<u32>()
                .unwrap();
            let query = command.splitn(4, ' ').nth(3).unwrap();
            assert!(["UID", "(UID FLAGS)", "(UID FLAGS MODSEQ)"].contains(&query));
            let exists = if selected == "INBOX" {
                assert_eq!(uid, 7);
                snapshot.source
            } else {
                assert_eq!(uid, 70);
                snapshot.destination
            };
            let deleted = if selected == "INBOX" {
                snapshot.deleted
            } else {
                snapshot.destination_deleted
            };
            if exists {
                let mut flags = Vec::new();
                if deleted {
                    flags.push("\\Deleted");
                }
                if selected != "INBOX" && snapshot.destination_read {
                    flags.push("\\Seen");
                }
                if selected == "INBOX" || snapshot.destination_starred {
                    flags.push("\\Flagged");
                }
                let flags = if query.contains("FLAGS") {
                    format!(" FLAGS ({})", flags.join(" "))
                } else {
                    String::new()
                };
                let modseq = if query.contains("MODSEQ") {
                    format!(" MODSEQ ({})", snapshot.highest_modseq.unwrap())
                } else {
                    String::new()
                };
                write(
                    &mut socket,
                    &format!("* 1 FETCH (UID {uid}{flags}{modseq})\r\n"),
                )
                .await?;
            }
            write(&mut socket, &format!("{tag} OK fetched\r\n")).await?;
        } else if command == "UID COPY 7 \"Archive\"" || command == "UID MOVE 7 \"Archive\"" {
            assert_eq!(selected, "INBOX");
            assert!(writable);
            let copying = command.starts_with("UID COPY");
            if copying {
                audit(&app, &stages, "copy_pending");
            }
            {
                let mut current = state.lock().unwrap();
                current.destination = true;
                if !copying {
                    current.source = false;
                }
            }
            if snapshot.change_connection_after_copy {
                app.lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .blocking(|db| {
                        let mut config = db.settings()?;
                        config["mailAccounts"][OWNER]["password"] = "rotated-fixture".into();
                        db.set_settings(&config)?;
                        Ok(())
                    })
                    .unwrap();
            }
            if snapshot.failure == "copy_disconnect" {
                return Ok(());
            }
            if snapshot.failure == "copy_hold" {
                held.notify_one();
                tokio::select! {_ = release.notified()=>{}, result=socket.fill_buf()=>{assert!(result?.is_empty());return Ok(());}}
            }
            if snapshot.failure == "copy_partial" {
                write(&mut socket, "* OK [COPYUID 99 7").await?;
                return Ok(());
            }
            let proof = match snapshot.failure {
                "copy_missing" => "".to_owned(),
                "copy_source" => "[COPYUID 99 8 70] ".into(),
                "copy_many_source" => "[COPYUID 99 7:8 70] ".into(),
                "copy_many_dest" => "[COPYUID 99 7 70:71] ".into(),
                "copy_zero" => "[COPYUID 0 7 70] ".into(),
                "copy_validity" => "[COPYUID 98 7 70] ".into(),
                "copy_conflict" => {
                    write(&mut socket, "* OK [COPYUID 99 7 71] earlier\r\n").await?;
                    "[COPYUID 99 7 70] ".into()
                }
                "copy_large" => format!("{} ", "X".repeat(140 * 1024)),
                _ => "[COPYUID 99 7 70] ".into(),
            };
            let result = if snapshot.failure == "copy_no" {
                "NO"
            } else {
                "OK"
            };
            let returned = if snapshot.failure == "copy_tag" {
                "OTHER"
            } else {
                tag
            };
            write(
                &mut socket,
                &format!("{returned} {result} {proof}copied\r\n"),
            )
            .await?;
        } else if command == "UID STORE 7 +FLAGS.SILENT (\\Deleted)" {
            assert_eq!(selected, "INBOX");
            assert!(writable);
            audit(&app, &stages, "delete_pending");
            if snapshot.failure == "store_no" {
                write(&mut socket, &format!("{tag} NO refused\r\n")).await?;
                continue;
            }
            state.lock().unwrap().deleted = true;
            if snapshot.failure == "store_disconnect" {
                return Ok(());
            }
            write(&mut socket, &format!("{tag} OK stored\r\n")).await?;
        } else if command == "UID EXPUNGE 7" {
            assert_eq!(selected, "INBOX");
            assert!(writable);
            audit(&app, &stages, "expunge_pending");
            assert!(snapshot.deleted);
            state.lock().unwrap().source = false;
            if snapshot.failure == "expunge_disconnect" {
                return Ok(());
            }
            write(
                &mut socket,
                &format!("* 1 EXPUNGE\r\n{tag} OK expunged\r\n"),
            )
            .await?;
        } else if command == "LOGOUT" {
            write(
                &mut socket,
                &format!("* BYE closing\r\n{tag} OK logout\r\n"),
            )
            .await?;
            return Ok(());
        } else {
            panic!("Unexpected recovery fixture command: {command}");
        }
    }
    Ok(())
}
fn audit(app: &Arc<Mutex<Option<morrow_search::service::App>>>, stages: &Log, expected: &str) {
    let actual = app
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .blocking(|db| {
            Ok(db.settings()?["imapMoveJournal"][OWNER]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["stage"]
                .as_str()
                .unwrap()
                .to_owned())
        })
        .unwrap();
    assert_eq!(
        actual, expected,
        "A provider mutation arrived before its durable intent"
    );
    stages.lock().unwrap().push(actual);
}

#[tokio::test]
async fn fallback_persists_each_intent_targets_one_uid_and_atomically_keeps_local_identity() {
    let fixture = MoveFixture::new(Scenario::default()).await;
    let (patch, id) = fixture.organize().await.unwrap();
    let id = id.unwrap();
    assert_eq!(patch["remoteId"], "imap:99:70");
    assert_eq!(fixture.records().await[0]["stage"], "provider_complete");
    let changed = fixture
        .cache
        .app()
        .db(move |db| imap_moves::apply_confirmed(db, OWNER, &id))
        .await
        .unwrap();
    assert_eq!(changed["id"], "stable-local");
    assert_eq!(changed["remoteId"], "imap:99:70");
    assert_eq!(changed["body"], "Downloaded body retained");
    assert_eq!(changed["pending"], true);
    assert_eq!(changed["starred"], true);
    assert_eq!(changed["labels"], json!(["local choice"]));
    assert_eq!(changed["localOverrides"]["labels"], true);
    assert_eq!(changed["localOverrides"]["folder"], false);
    assert_eq!(
        *fixture.stages.lock().unwrap(),
        vec!["copy_pending", "delete_pending", "expunge_pending"]
    );
    assert_eq!(
        fixture.mutations(),
        vec![
            "UID COPY 7 \"Archive\"",
            "UID STORE 7 +FLAGS.SILENT (\\Deleted)",
            "UID EXPUNGE 7"
        ]
    );
    let list = fixture.list().await;
    assert_eq!(list["operations"][0]["status"], "completed");
    assert_eq!(list["operations"][0]["automaticRetry"], false);
    assert_eq!(
        fixture
            .cache
            .app()
            .db(|db| db.get(OTHER, "stable-local"))
            .await
            .unwrap()
            .unwrap()["remoteId"],
        "imap:55:7"
    );
    fixture.close().await;
}

#[tokio::test]
async fn unknown_copy_proof_never_replays_copies_or_removes_source() {
    for failure in [
        "copy_disconnect",
        "copy_partial",
        "copy_missing",
        "copy_source",
        "copy_many_source",
        "copy_many_dest",
        "copy_zero",
        "copy_validity",
        "copy_conflict",
        "copy_no",
        "copy_tag",
        "copy_large",
    ] {
        let fixture = MoveFixture::new(Scenario {
            failure,
            ..Default::default()
        })
        .await;
        let error = fixture.organize().await.unwrap_err();
        assert_eq!(error.body["code"], "imap_move_unresolved", "{failure}");
        let list = fixture.list().await;
        let op = &list["operations"][0];
        assert_eq!(op["stage"], "copy_pending");
        assert_eq!(op["canPreview"], false);
        assert_eq!(op["canFinish"], false);
        assert!(fixture.preview(op).await.is_err());
        assert!(fixture.finish(op).await.is_err());
        assert_eq!(
            fixture.organize().await.unwrap_err().body["operationId"],
            op["id"]
        );
        assert_eq!(fixture.mutations(), vec!["UID COPY 7 \"Archive\""]);
        assert!(fixture.state.lock().unwrap().source);
        fixture.close().await;
    }
}

#[tokio::test]
async fn partial_store_failure_needs_fresh_one_use_review_and_never_copies_again() {
    let fixture = MoveFixture::new(Scenario {
        failure: "store_no",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    let op = fixture.list().await["operations"][0].clone();
    assert_eq!(op["stage"], "delete_pending");
    assert_eq!(op["canPreview"], true);
    assert_eq!(op["canFinish"], false);
    assert!(fixture.finish(&op).await.is_err());
    fixture.update(|state| state.failure = "");
    let review = fixture.preview(&op).await.unwrap()["operation"].clone();
    assert_eq!(review["finishAction"], "completeMove");
    assert_eq!(review["canFinish"], true);
    assert!(
        fixture.preview(&op).await.is_err(),
        "Old operation snapshots must not be reused"
    );
    let result = fixture.finish(&review).await.unwrap();
    assert_eq!(result["operation"]["status"], "completed");
    assert_eq!(result["message"]["id"], "stable-local");
    assert!(fixture.finish(&review).await.is_err());
    assert_eq!(
        fixture
            .mutations()
            .iter()
            .filter(|line| line.starts_with("UID COPY "))
            .count(),
        1
    );
    assert_eq!(
        fixture
            .mutations()
            .iter()
            .filter(|line| line.starts_with("UID EXPUNGE "))
            .count(),
        1
    );
    fixture.close().await;
}

#[tokio::test]
async fn expunge_unknown_can_only_apply_confirmed_result_without_new_provider_mutation() {
    let fixture = MoveFixture::new(Scenario {
        failure: "expunge_disconnect",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    let op = fixture.list().await["operations"][0].clone();
    assert_eq!(op["stage"], "expunge_pending");
    // Ordinary reconciliation of the now-expunged source writes these exact
    // missing flags. Recovery must not carry them to the verified destination.
    fixture
        .cache
        .app()
        .db(|db| {
            db.update(
                OWNER,
                "stable-local",
                &json!({"providerDeleted":true,"providerFolderMissing":true,"read":false}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    fixture.update(|state| state.failure = "");
    let before = fixture.mutations();
    let review = fixture.preview(&op).await.unwrap()["operation"].clone();
    assert_eq!(review["finishAction"], "applyConfirmedResult");
    let result = fixture.finish(&review).await.unwrap();
    assert_eq!(fixture.mutations(), before);
    assert_eq!(result["message"]["providerDeleted"], false);
    assert_eq!(result["message"]["providerFolderMissing"], false);
    assert_eq!(result["message"]["body"], "Downloaded body retained");
    assert_eq!(result["message"]["read"], false);
    assert_eq!(result["message"]["starred"], true);
    assert_eq!(result["message"]["pending"], true);
    fixture.close().await;
}

#[tokio::test]
async fn finish_rechecks_both_validities_exact_copies_and_reviewed_action_before_any_removal() {
    for change in [
        "source_validity",
        "target_validity",
        "target_absent",
        "target_deleted",
        "source_returns",
    ] {
        let initial = if change == "source_returns" {
            "expunge_disconnect"
        } else {
            "store_no"
        };
        let fixture = MoveFixture::new(Scenario {
            failure: initial,
            ..Default::default()
        })
        .await;
        fixture.organize().await.unwrap_err();
        fixture.update(|state| state.failure = "");
        let op = fixture.list().await["operations"][0].clone();
        let review = fixture.preview(&op).await.unwrap()["operation"].clone();
        fixture.update(|state| match change {
            "source_validity" => state.source_validity += 1,
            "target_validity" => state.target_validity += 1,
            "target_absent" => state.destination = false,
            "target_deleted" => state.destination_deleted = true,
            _ => {
                state.source = true;
                state.deleted = false;
            }
        });
        let before = fixture.mutations();
        assert!(fixture.finish(&review).await.is_err(), "{change}");
        assert_eq!(fixture.mutations(), before, "{change}");
        fixture.close().await;
    }
}

#[tokio::test]
async fn missing_uidplus_refuses_before_mutation_and_uncertain_native_move_never_copies() {
    for caps in ["IMAP4rev1", "IMAP4rev1 MOVE"] {
        let fixture = MoveFixture::new(Scenario {
            capabilities: caps,
            ..Default::default()
        })
        .await;
        assert_eq!(
            fixture.organize().await.unwrap_err().body["code"],
            "imap_move_requires_uidplus"
        );
        assert!(fixture.mutations().is_empty());
        assert!(fixture.records().await.is_empty());
        fixture.close().await;
    }
    let fixture = MoveFixture::new(Scenario {
        capabilities: "IMAP4rev1 UIDPLUS MOVE",
        failure: "copy_disconnect",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    assert_eq!(fixture.mutations(), vec!["UID MOVE 7 \"Archive\""]);
    assert!(fixture.records().await.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn cancelled_copy_survives_actual_workspace_reopen_without_replay_and_resolves_locally() {
    let mut fixture = MoveFixture::new(Scenario {
        failure: "copy_hold",
        ..Default::default()
    })
    .await;
    let (app, mail, message, tls) = (
        fixture.cache.app().clone(),
        fixture.mail.clone(),
        fixture.message.clone(),
        fixture.connector.clone(),
    );
    let worker = tokio::spawn(async move {
        imap_moves::organize_with_tls(
            &app,
            &mail,
            &message,
            &json!({"id":"Archive","name":"Archive","kind":"archive"}),
            "move",
            Some(&tls),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), fixture.held.notified())
        .await
        .unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    fixture.drained().await;
    let before = fixture.commands();
    let saved = fixture.records().await;
    assert_eq!(saved[0]["stage"], "copy_pending");
    assert_eq!(saved[0]["mapping"], Value::Null);
    fixture.restart().await;
    assert_eq!(fixture.records().await, saved);
    let op = fixture.list().await["operations"][0].clone();
    let result=fixture.route(Method::POST,OWNER,&format!("/{}/resolve",string(&op,"id")),json!({"operationRef":op["operationRef"],"confirmed":true,"resolution":"reviewedExternally"})).await.unwrap();
    assert_eq!(result["operation"]["status"], "resolved");
    assert_eq!(result["operation"]["diagnosticCode"], "reviewed_externally");
    assert_eq!(fixture.commands(), before);
    assert!(fixture.state.lock().unwrap().source);
    assert_eq!(
        fixture
            .cache
            .app()
            .db(|db| db.get(OWNER, "stable-local"))
            .await
            .unwrap()
            .unwrap()["remoteId"],
        "imap:55:7"
    );
    fixture.close().await;
}

#[tokio::test]
async fn real_45_second_write_deadline_drops_socket_and_leaves_one_unknown_copy() {
    let fixture = MoveFixture::new(Scenario {
        failure: "copy_hold",
        ..Default::default()
    })
    .await;
    let started = std::time::Instant::now();
    let error = tokio::time::timeout(Duration::from_secs(55), fixture.organize())
        .await
        .expect("The 45-second absolute operation budget did not end")
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_secs(44) && elapsed < Duration::from_secs(53),
        "{elapsed:?}"
    );
    assert_eq!(error.body["code"], "imap_move_unresolved");
    fixture.drained().await;
    assert_eq!(fixture.records().await[0]["stage"], "copy_pending");
    assert_eq!(fixture.mutations(), vec!["UID COPY 7 \"Archive\""]);
    fixture.close().await;
}

#[tokio::test]
async fn connection_rotation_after_copy_stops_before_deletion_and_keeps_explicit_local_resolution()
{
    let fixture = MoveFixture::new(Scenario {
        change_connection_after_copy: true,
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    assert_eq!(fixture.mutations(), vec!["UID COPY 7 \"Archive\""]);
    let before = fixture.commands();
    let list = fixture.list().await;
    let op = &list["operations"][0];
    assert_ne!(list["connectionRef"], op["connectionRef"]);
    assert_eq!(op["canPreview"], false);
    assert_eq!(op["canResolve"], true);
    assert!(fixture.preview(op).await.is_err());
    fixture.route(Method::POST,OWNER,&format!("/{}/resolve",string(op,"id")),json!({"operationRef":op["operationRef"],"confirmed":true,"resolution":"reviewedExternally"})).await.unwrap();
    assert_eq!(fixture.commands(), before);
    fixture.close().await;
}

#[tokio::test]
async fn stale_connection_source_or_cached_destination_rejects_finish_before_socket_or_removal() {
    for change in ["connection", "source", "cached_destination"] {
        let fixture = MoveFixture::new(Scenario {
            failure: "store_no",
            ..Default::default()
        })
        .await;
        fixture.organize().await.unwrap_err();
        fixture.update(|state| state.failure = "");
        let op = fixture.list().await["operations"][0].clone();
        let review = fixture.preview(&op).await.unwrap()["operation"].clone();
        fixture.drained().await;
        fixture
            .cache
            .app()
            .db(move |db| {
                match change {
                    "connection" => {
                        let mut config = db.settings()?;
                        config["mailAccounts"][OWNER]["connectionId"] = "replacement".into();
                        db.set_settings(&config)?;
                    }
                    "source" => {
                        db.update(OWNER, "stable-local", &json!({"folder":"archive"}))?;
                    }
                    _ => {
                        let mut row = db.get(OWNER, "stable-local")?.unwrap();
                        row["id"] = "downloaded-destination".into();
                        row["remoteId"] = "imap:99:70".into();
                        row["providerFolderId"] = "Archive".into();
                        row["pending"] = false.into();
                        db.upsert(OWNER, &row)?;
                    }
                }
                Ok(())
            })
            .await
            .unwrap();
        let before = fixture.commands();
        assert!(fixture.finish(&review).await.is_err(), "{change}");
        assert_eq!(fixture.commands(), before, "{change}");
        let list = fixture.list().await;
        assert_eq!(list["operations"][0]["canFinish"], false);
        if change == "cached_destination" {
            assert_eq!(list["operations"][0]["canPreview"], false);
            assert_eq!(
                list["operations"][0]["diagnosticCode"],
                "cached_destination_conflict"
            );
            assert!(
                fixture
                    .cache
                    .app()
                    .db(|db| db.get(OWNER, "downloaded-destination"))
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        fixture.close().await;
    }
}

#[tokio::test]
async fn expired_review_wrong_owner_and_cross_owner_refs_never_open_provider_connections() {
    let fixture = MoveFixture::new(Scenario {
        failure: "store_no",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    fixture.update(|state| state.failure = "");
    let op = fixture.list().await["operations"][0].clone();
    let review = fixture.preview(&op).await.unwrap()["operation"].clone();
    fixture.drained().await;
    let before = fixture.commands();
    for owner in ["all", "demo", "", "unknown@example.invalid"] {
        assert!(
            fixture
                .route(Method::GET, owner, "", json!({}))
                .await
                .is_err()
        );
    }
    let other = fixture
        .route(Method::GET, OTHER, "", json!({}))
        .await
        .unwrap();
    assert_eq!(other["accountId"], OTHER);
    assert_eq!(other["operations"], json!([]));
    assert_eq!(fixture.route(Method::POST,OTHER,&format!("/{}/finish",string(&review,"id")),json!({"operationRef":review["operationRef"],"reviewRef":review["reviewRef"],"confirmed":true})).await.unwrap_err().status,404);
    fixture
        .cache
        .app()
        .db(|db| {
            let mut config = db.settings()?;
            config["imapMoveJournal"][OWNER][0]["review"]["at"] =
                (chrono::Utc::now().timestamp_millis() - 301000).into();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(fixture.finish(&review).await.is_err());
    assert_eq!(fixture.list().await["operations"][0]["canFinish"], false);
    assert_eq!(fixture.commands(), before);
    fixture.close().await;
}

#[tokio::test]
async fn journal_capacity_is_global_reserved_before_mutation_and_never_evicts_unresolved() {
    let fixture = MoveFixture::new(Scenario::default()).await;
    let records=(0..100).map(|n|json!({"id":format!("unresolved-{n}"),"accountId":OTHER,"stage":"copy_pending","source":{"id":format!("gone-{n}")}})).collect::<Vec<_>>();
    let saved = records.clone();
    fixture
        .cache
        .app()
        .db(move |db| db.set_settings(&json!({"imapMoveJournal":{OTHER:saved}})))
        .await
        .unwrap();
    assert_eq!(
        fixture.organize().await.unwrap_err().body["code"],
        "imap_move_journal_full"
    );
    assert!(fixture.mutations().is_empty());
    assert!(fixture.records().await.is_empty());
    assert_eq!(
        fixture.cache.app().settings().await.unwrap()["imapMoveJournal"][OTHER],
        json!(records)
    );
    fixture.close().await;
}

#[tokio::test]
async fn final_cache_and_journal_adoption_roll_back_together_on_database_failure() {
    let fixture = MoveFixture::new(Scenario::default()).await;
    let (_, id) = fixture.organize().await.unwrap();
    let id = id.unwrap();
    let saved = id.clone();
    let result: Result<()> = fixture
        .cache
        .app()
        .db(move |db| {
            db.transaction(|db| {
                imap_moves::apply_confirmed(db, OWNER, &saved)?;
                Err(morrow_search::error::Error::conflict(
                    "Fixture rollback after local adoption",
                ))
            })
        })
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.records().await[0]["stage"], "provider_complete");
    assert_eq!(
        fixture
            .cache
            .app()
            .db(|db| db.get(OWNER, "stable-local"))
            .await
            .unwrap()
            .unwrap()["remoteId"],
        "imap:55:7"
    );
    fixture
        .cache
        .app()
        .db(move |db| imap_moves::apply_confirmed(db, OWNER, &id))
        .await
        .unwrap();
    assert_eq!(fixture.records().await[0]["stage"], "completed");
    fixture.close().await;
}

#[tokio::test]
async fn authenticated_journal_routes_require_named_headers_and_expose_only_safe_owned_metadata() {
    let fixture = MoveFixture::new(Scenario {
        failure: "copy_disconnect",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    fixture
        .cache
        .app()
        .db(|db| {
            let mut config = db.settings()?;
            config["imapMoveJournal"][OWNER][0]["rawError"] = "PRIVATE PROVIDER SECRET".into();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = fixture.cache.app().router();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    let url = format!("http://{address}/api/mail/moves");
    for header in [None, Some("all"), Some("demo")] {
        let mut request = client.get(&url).bearer_auth("fictional-cache");
        if let Some(header) = header {
            request = request.header("X-Genmail-Account", header);
        }
        assert_eq!(request.send().await.unwrap().status().as_u16(), 409);
    }
    assert_eq!(
        client
            .get(&url)
            .header("X-Genmail-Account", OWNER)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    let response = client
        .get(&url)
        .bearer_auth("fictional-cache")
        .header("X-Genmail-Account", OWNER)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let text = response.text().await.unwrap();
    for secret in [
        "PRIVATE PROVIDER SECRET",
        "fictional-move-only",
        "Downloaded body retained",
        OTHER,
    ] {
        assert!(!text.contains(secret), "Journal response leaked {secret}");
    }
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["accountId"], OWNER);
    assert_eq!(value["operations"][0]["accountId"], OWNER);
    task.abort();
    let _ = task.await;
    fixture.close().await;
}

#[test]
fn public_move_connection_fence_changes_on_same_host_credentials_or_generation_without_secrets() {
    let mail = json!({"provider":"imap","email":OWNER,"imapHost":"imap.example.invalid","imapPort":993,"password":"private-first","connectionId":"first"});
    let first = morrow_search::service::safe_mail(&mail);
    assert!(
        first["moveConnectionRef"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    for (field, value) in [
        ("password", "private-second"),
        ("connectionId", "second"),
        ("email", OTHER),
        ("imapHost", "different.example.invalid"),
    ] {
        let mut next = mail.clone();
        next[field] = value.into();
        let safe = morrow_search::service::safe_mail(&next);
        assert_ne!(
            safe["moveConnectionRef"], first["moveConnectionRef"],
            "{field}"
        );
        assert!(!safe.to_string().contains("private-"));
        assert!(safe.get("connectionId").is_none());
    }
    for mail in [
        Value::Null,
        json!({"provider":"google","email":OWNER,"accessToken":"PRIVATE"}),
    ] {
        assert_eq!(
            morrow_search::service::safe_mail(&mail)["moveConnectionRef"],
            Value::Null
        );
    }
}

#[tokio::test]
async fn bounded_history_retains_old_unresolved_records_while_pruning_only_terminal_history() {
    let fixture = MoveFixture::new(Scenario {
        failure: "copy_disconnect",
        ..Default::default()
    })
    .await;
    fixture.organize().await.unwrap_err();
    let record = fixture.records().await[0].clone();
    let mut old = record.clone();
    old["id"] = "older-unresolved".into();
    old["source"]["id"] = "unavailable-old-source".into();
    let retained = old.clone();
    let mut entries = vec![old];
    for n in 0..25 {
        let mut done = record.clone();
        done["id"] = format!("completed-{n}").into();
        done["stage"] = "completed".into();
        entries.push(done);
    }
    entries.push(record.clone());
    fixture
        .cache
        .app()
        .db(move |db| db.set_settings(&json!({"imapMoveJournal":{OWNER:entries}})))
        .await
        .unwrap();
    let before = fixture.commands();
    fixture.route(Method::POST,OWNER,&format!("/{}/resolve",string(&record,"id")),json!({"operationRef":record["operationRef"],"confirmed":true,"resolution":"reviewedExternally"})).await.unwrap();
    let after = fixture.records().await;
    assert_eq!(after.len(), 21);
    assert_eq!(after[0], retained);
    assert_eq!(
        after
            .iter()
            .filter(|row| row["stage"] == "completed" || row["stage"] == "resolved")
            .count(),
        20
    );
    assert_eq!(
        fixture.list().await["operations"].as_array().unwrap().len(),
        21
    );
    assert_eq!(fixture.commands(), before);
    fixture.close().await;
}

#[tokio::test]
async fn moved_message_cannot_reuse_a_source_folder_watermark_to_skip_real_destination_flags() {
    for native in [false, true] {
        let fixture = MoveFixture::new(Scenario {
            capabilities: if native {
                "IMAP4rev1 UIDPLUS MOVE"
            } else {
                "IMAP4rev1 UIDPLUS"
            },
            ..Default::default()
        })
        .await;
        fixture.update(|state| {
            state.capabilities = "IMAP4rev1 UIDPLUS CONDSTORE";
            state.highest_modseq = Some(300);
        });
        let proven = imap::reconcile_with_tls(
            &fixture.mail,
            std::slice::from_ref(&fixture.message),
            &fixture.connector,
        )
        .await
        .unwrap()
        .remove(0);
        assert_eq!(proven["imapModseq"], 300);
        let connection = proven["imapSyncConnection"].clone();
        fixture.update(|state| {
            state.capabilities = if native {
                "IMAP4rev1 UIDPLUS MOVE"
            } else {
                "IMAP4rev1 UIDPLUS"
            };
            state.highest_modseq = None;
        });
        fixture.cache.app().db(move|db|db.update(OWNER,"stable-local",&json!({"read":false,"starred":true,"providerSnapshot":{"read":false,"starred":true},"imapModseq":300,"imapSyncConnection":connection,"imapSyncEpoch":[null,null]}))).await.unwrap();
        let (patch, id) = fixture.organize().await.unwrap();
        let adopted = fixture
            .cache
            .app()
            .db(move |db| {
                if let Some(id) = id {
                    imap_moves::apply_confirmed(db, OWNER, &id)
                } else {
                    Ok(db.update(OWNER, "stable-local", &patch)?.unwrap())
                }
            })
            .await
            .unwrap();
        assert_eq!(adopted["read"], false);
        assert_eq!(adopted["starred"], true);
        assert_eq!(adopted["pending"], true);
        assert_eq!(adopted["body"], "Downloaded body retained");
        fixture.update(|state| {
            state.capabilities = "IMAP4rev1 UIDPLUS CONDSTORE";
            state.highest_modseq = Some(300);
            state.destination_read = true;
            state.destination_starred = false;
        });
        let before = fixture.mutations();
        fixture.log.lock().unwrap().clear();
        let rows = imap::reconcile_with_tls(
            &fixture.mail,
            std::slice::from_ref(&adopted),
            &fixture.connector,
        )
        .await
        .unwrap();
        assert!(
            fixture.mutations().is_empty(),
            "A flag refresh must remain read-only"
        );
        assert_eq!(
            rows[0]["read"], true,
            "Old source MODSEQ skipped destination flags (native={native})"
        );
        assert_eq!(rows[0]["starred"], false);
        assert_eq!(rows[0]["pending"], true);
        assert_eq!(rows[0]["body"], "Downloaded body retained");
        assert!(
            fixture
                .commands()
                .iter()
                .any(|line| line == "UID FETCH 70 (UID FLAGS MODSEQ)")
        );
        for key in ["imapModseq", "imapSyncConnection", "imapSyncEpoch"] {
            assert!(adopted[key].is_null(), "{key}");
        }
        assert!(!before.is_empty());
        fixture.close().await;
    }
}
