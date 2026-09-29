use axum::{Json, Router, extract::State, routing::post};
use morrow_search::{
    ai, background as jobs, policy,
    service::{App, Context},
    store::{Store, now},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, time::Duration};
use tokio::sync::{mpsc, oneshot};

const A: &str = "a@example.invalid";
const B: &str = "b@example.invalid";
fn directory() -> PathBuf {
    std::env::temp_dir().join(format!("morrow-background-{}", uuid::Uuid::new_v4()))
}
fn timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}
fn configure(db: &Store) {
    db.set_settings(&json!({"mailAccounts":{
        A:{"email":A,"provider":"imap","connectionId":"connection-a"},
        B:{"email":B,"provider":"imap","connectionId":"connection-b"}
    },"preferences":{"syncInterval":0},"policy":policy::update(&json!({}),&json!({"triggers":{"onArrival":true,"scheduledSummary":false},"summarySchedule":{"cadence":"daily","time":"09:00","timeZone":"Asia/Hong_Kong","everyHours":4}})).unwrap()})).unwrap();
    for account in [A, B] {
        db.upsert(account,&json!({"id":"same","folder":"inbox","date":now(),"fromName":"Private sender","fromEmail":account,"to":"recipient@example.invalid","subject":"Private subject","body":format!("Body from {account}"),"read":false,"starred":true,"category":"primary","labels":[]})).unwrap();
    }
}

#[test]
fn dates_dst_clock_rollback_and_strict_summary_contract() {
    assert_eq!(
        jobs::months_ago(1, timestamp("2024-03-31T12:00:00Z")).unwrap(),
        "2024-02-29T12:00:00.000Z"
    );
    assert_eq!(
        jobs::months_ago(3, timestamp("2026-01-31T12:00:00Z")).unwrap(),
        "2025-10-31T12:00:00.000Z"
    );
    for input in [
        Value::Null,
        json!([]),
        json!({"months":2}),
        json!({"inbox":false,"sent":false}),
        json!({"sent":1}),
        json!({"allMail":"true"}),
        json!({"allMail":true,"inbox":1}),
        json!({"unknown":true}),
    ] {
        assert_eq!(jobs::import_options(&input).unwrap_err().status, 400);
    }
    let daily =
        json!({"cadence":"daily","time":"09:00","everyHours":4,"timeZone":"Asia/Hong_Kong"});
    assert_eq!(
        jobs::summary_due(&daily, &json!({}), timestamp("2026-09-24T00:59:59Z")).unwrap()["due"],
        false
    );
    let first = jobs::summary_due(&daily, &json!({}), timestamp("2026-09-24T01:00:00Z")).unwrap();
    assert_eq!(first["due"], true);
    let mut completed = first["state"].clone();
    completed["day"] = first["day"].clone();
    for value in ["2026-09-24T23:00:00Z", "2026-09-23T02:00:00Z"] {
        assert_eq!(
            jobs::summary_due(&daily, &completed, timestamp(value)).unwrap()["due"],
            false
        );
    }
    assert_eq!(
        jobs::summary_due(&daily, &completed, timestamp("2026-09-25T01:00:00Z")).unwrap()["due"],
        true
    );
    let dst =
        json!({"cadence":"daily","time":"01:30","everyHours":4,"timeZone":"America/New_York"});
    let first = jobs::summary_due(&dst, &json!({}), timestamp("2026-11-01T05:30:00Z")).unwrap();
    let mut completed = first["state"].clone();
    completed["day"] = first["day"].clone();
    assert_eq!(first["due"], true);
    assert_eq!(
        jobs::summary_due(&dst, &completed, timestamp("2026-11-01T06:30:00Z")).unwrap()["due"],
        false
    );
    let mut spring = dst.clone();
    spring["time"] = "02:30".into();
    assert_eq!(
        jobs::summary_due(&spring, &json!({}), timestamp("2026-03-08T07:00:00Z")).unwrap()["due"],
        true
    );
    let mut interval = daily.clone();
    interval["cadence"] = "interval".into();
    let first = jobs::summary_due(&interval, &json!({}), 0).unwrap();
    for time in [-1, 4 * 3600000 - 1] {
        assert_eq!(
            jobs::summary_due(&interval, &first["state"], time).unwrap()["due"],
            false
        );
    }
    assert_eq!(
        jobs::summary_due(&interval, &first["state"], 4 * 3600000).unwrap()["due"],
        true
    );
    interval["everyHours"] = 1.into();
    assert_eq!(
        jobs::summary_due(&interval, &first["state"], 4 * 3600000).unwrap()["due"],
        false
    );
    let messages = vec![json!({"id":"a"}), json!({"id":"b"})];
    let items = json!({"items":[{"messageId":"a","priority":"P4","summary":"Newsletter"},{"messageId":"b","priority":"P1","summary":"  Reply today  "}]});
    let result = jobs::priority_summary(&format!("```json\n{items}\n```"), &messages).unwrap();
    assert_eq!(result["items"][0]["messageId"], "b");
    assert_eq!(result["items"][0]["summary"], "Reply today");
    assert!(result["text"].as_str().unwrap().contains("P0 (0)\n—"));
    for raw in ["invalid".into(),"{}".into(),json!({"items":[items["items"][0]]}).to_string(),json!({"items":[items["items"][0],items["items"][0]]}).to_string(),json!({"items":[items["items"][0],{"messageId":"invented","priority":"P1","summary":"No"}]}).to_string()] {
        assert_eq!(jobs::priority_summary(&raw,&messages).unwrap_err().status,502);
    }
}

#[test]
fn gmail_all_mail_scope_and_progress_are_durable_safe_and_backward_compatible() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    assert_eq!(jobs::import_options(&json!({})).unwrap()["allMail"], false);
    let options = json!({"allMail":true,"inbox":false,"sent":false});
    assert_eq!(jobs::import_options(&options).unwrap()["allMail"], true);
    let before = db.settings().unwrap();
    jobs::start_import(&db, A, &options).unwrap();
    assert_eq!(jobs::import_status(&db, A).unwrap()["currentFolder"], "all");
    let mut accounts = before["mailAccounts"].clone();
    accounts[A]["provider"] = "google".into();
    accounts[B]["provider"] = "microsoft".into();
    db.set_settings(&json!({"mailAccounts":accounts})).unwrap();
    jobs::start_import(&db, B, &options).unwrap();
    assert_eq!(jobs::import_status(&db, B).unwrap()["currentFolder"], "all");
    jobs::start_import(&db, A, &options).unwrap();
    let status = jobs::import_status(&db, A).unwrap();
    assert_eq!(status["currentFolder"], "all");
    assert_eq!(status["phase"], "queued");
    assert_eq!(status["pages"], 0);
    assert_eq!(status["processed"], 0);
    assert!(status["lastPageChecked"].is_null());
    let date = (chrono::Utc::now() - chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let sent = json!({"id":"sent","date":date,"folder":"sent","starred":true,"labels":["SENT","STARRED","Project"]});
    let draft = json!({"id":"draft","date":date,"folder":"drafts","providerDraft":true,"labels":["DRAFT","Project"]});
    let job = db.settings().unwrap()["imports"][A].clone();
    jobs::apply_import_page(&db, A, &job, &json!({"messages":[sent,draft,{"id":"too-old","date":"2020-01-01T00:00:00.000Z","folder":"inbox"}],"nextCursor":"private-provider-cursor"})).unwrap();
    let status = jobs::import_status(&db, A).unwrap();
    assert_eq!(status["pages"], 1);
    assert_eq!(status["processed"], 3);
    assert_eq!(status["imported"], 2);
    assert_eq!(status["lastPageChecked"], 3);
    assert_eq!(status["lastPageAdded"], 2);
    assert_eq!(
        db.get(A, "sent").unwrap().unwrap()["labels"],
        sent["labels"]
    );
    assert_eq!(db.get(A, "draft").unwrap().unwrap()["providerDraft"], true);
    assert!(db.get(A, "too-old").unwrap().is_none());
    assert!(db.get(B, "sent").unwrap().is_none());
    jobs::control_import(&db, A, "pause").unwrap();
    assert_eq!(jobs::import_status(&db, A).unwrap()["phase"], "paused");
    drop(db);
    let db = Store::open(&root).unwrap();
    assert_eq!(jobs::import_status(&db, A).unwrap()["processed"], 3);
    jobs::control_import(&db, A, "resume").unwrap();
    let job = db.settings().unwrap()["imports"][A].clone();
    assert_eq!(job["cursor"], "private-provider-cursor");
    jobs::apply_import_page(&db, A, &job, &json!({"messages":[sent],"nextCursor":null})).unwrap();
    let status = jobs::import_status(&db, A).unwrap();
    assert_eq!(status["status"], "complete");
    assert_eq!(status["phase"], "complete");
    assert!(status["currentFolder"].is_null());
    assert_eq!(status["pages"], 2);
    assert_eq!(status["processed"], 4);
    assert_eq!(status["imported"], 2);
    assert_eq!(status["lastPageChecked"], 1);
    assert_eq!(status["lastPageAdded"], 0);
    for key in ["cursor", "visited", "connectionId", "id", "total"] {
        assert!(status.get(key).is_none());
    }
    assert!(!status.to_string().contains("private-provider-cursor"));

    jobs::start_import(&db, B, &json!({})).unwrap();
    let mut imports = db.settings().unwrap()["imports"].clone();
    imports[B].as_object_mut().unwrap().remove("pages");
    imports[B].as_object_mut().unwrap().remove("processed");
    imports[B]["options"]
        .as_object_mut()
        .unwrap()
        .remove("allMail");
    imports[B]["imported"] = 20.into();
    db.set_settings(&json!({"imports":imports})).unwrap();
    drop(db);
    let db = Store::open(&root).unwrap();
    let job = db.settings().unwrap()["imports"][B].clone();
    jobs::apply_import_page(&db, B, &job, &json!({"messages":[sent],"nextCursor":null})).unwrap();
    let status = jobs::import_status(&db, B).unwrap();
    assert_eq!(status["currentFolder"], "sent");
    assert!(status["pages"].is_null());
    assert!(status["processed"].is_null());
    assert_eq!(status["imported"], 21);
    assert_eq!(status["lastPageChecked"], 1);
    assert_eq!(status["lastPageAdded"], 1);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn history_checkpoints_atomic_pages_pause_resume_reconnect_and_cursor_loops() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    jobs::start_import(&db, A, &json!({"months":3,"inbox":true,"sent":true})).unwrap();
    let first = db.settings().unwrap()["imports"][A].clone();
    let date = (chrono::Utc::now() - chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let page = |id: &str, cursor: Value| json!({"messages":[{"id":id,"date":date,"folder":"inbox","subject":"history"}],"nextCursor":cursor});
    jobs::apply_import_page(&db, A, &first, &page("inbox-1", json!("a"))).unwrap();
    assert_eq!(jobs::import_status(&db, A).unwrap()["imported"], 1);
    assert_eq!(jobs::import_status(&db, A).unwrap()["pages"], 1);
    assert_eq!(jobs::import_status(&db, A).unwrap()["processed"], 1);
    assert!(
        jobs::reports(&db, A)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(db.get(B, "inbox-1").unwrap().is_none());
    jobs::control_import(&db, A, "pause").unwrap();
    jobs::apply_import_page(&db, A, &first, &page("stale", Value::Null)).unwrap();
    assert!(db.get(A, "stale").unwrap().is_none());
    jobs::control_import(&db, A, "resume").unwrap();
    drop(db);
    let db = Store::open(&root).unwrap();
    let resumed = db.settings().unwrap()["imports"][A].clone();
    assert_ne!(first["id"], resumed["id"]);
    assert_eq!(resumed["cursor"], "a");
    jobs::apply_import_page(&db, A, &resumed, &page("inbox-2", Value::Null)).unwrap();
    let sent = db.settings().unwrap()["imports"][A].clone();
    assert_eq!(sent["folderIndex"], 1);
    let mut result = page("sent-1", Value::Null);
    result["messages"][0]["folder"] = "sent".into();
    jobs::apply_import_page(&db, A, &sent, &result).unwrap();
    assert_eq!(jobs::import_status(&db, A).unwrap()["status"], "complete");
    assert_eq!(jobs::import_status(&db, A).unwrap()["imported"], 3);
    assert_eq!(jobs::import_status(&db, A).unwrap()["pages"], 3);
    assert_eq!(jobs::import_status(&db, A).unwrap()["processed"], 3);
    assert!(jobs::control_import(&db, A, "resume").is_err());
    jobs::start_import(&db, A, &json!({})).unwrap();
    let job = db.settings().unwrap()["imports"][A].clone();
    let mut invalid = page("rollback", json!("next"));
    invalid["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"date":date,"folder":"inbox"}));
    assert!(jobs::apply_import_page(&db, A, &job, &invalid).is_err());
    assert!(db.get(A, "rollback").unwrap().is_none());
    assert_eq!(db.settings().unwrap()["imports"][A], job);
    for cursor in ["a", "b"] {
        let job = db.settings().unwrap()["imports"][A].clone();
        jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":cursor})).unwrap();
    }
    let job = db.settings().unwrap()["imports"][A].clone();
    assert!(
        jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":"a"})).is_err()
    );
    assert!(
        jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":"b"})).is_err()
    );
    let mut accounts = db.settings().unwrap()["mailAccounts"].clone();
    accounts[A]["connectionId"] = "new".into();
    db.set_settings(&json!({"mailAccounts":accounts})).unwrap();
    jobs::apply_import_page(&db, A, &job, &page("wrong-generation", Value::Null)).unwrap();
    assert!(db.get(A, "wrong-generation").unwrap().is_none());
    assert!(jobs::control_import(&db, A, "resume").is_err());
    let safe = jobs::import_status(&db, A).unwrap();
    assert!(
        safe.get("connectionId").is_none()
            && safe.get("cursor").is_none()
            && safe.get("visited").is_none()
    );
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unlimited_import_tracks_many_cursors_outside_settings_and_cleans_up() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    jobs::start_import(&db, A, &json!({"months":0,"inbox":true,"sent":false})).unwrap();
    let initial_size = db.settings().unwrap().to_string().len();
    for n in 0..256 {
        let job = db.settings().unwrap()["imports"][A].clone();
        jobs::apply_import_page(
            &db,
            A,
            &job,
            &json!({"messages":[],"nextCursor":format!("page-{n}")}),
        )
        .unwrap();
        assert!(
            db.settings().unwrap()["imports"][A]["visited"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert!(db.settings().unwrap().to_string().len() < initial_size + 1000);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM import_cursor_hashes WHERE account=?",
            [A],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 256);
    let job = db.settings().unwrap()["imports"][A].clone();
    assert!(
        jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":"page-0"}))
            .is_err()
    );
    jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":null})).unwrap();
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM import_cursor_hashes WHERE account=?",
            [A],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn scheduled_claims_survive_restart_and_never_replay() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    let policy = policy::update(
        &db.settings().unwrap()["policy"],
        &json!({"triggers":{"scheduledSummary":true}}),
    )
    .unwrap();
    db.set_settings(&json!({"policy":policy})).unwrap();
    let time = timestamp("2026-09-24T01:00:00Z");
    jobs::schedule(&db, time).unwrap();
    jobs::schedule(&db, time).unwrap();
    assert_eq!(jobs::reports(&db, A).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(
        jobs::reports(&db, B).unwrap()[0]["messageIds"],
        json!(["same"])
    );
    for view in [A, B, "all"] {
        let state = morrow_search::service::state(&db, view, true, &[0; 32]).unwrap();
        let reports = state["today"]["summaries"].as_array().unwrap();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().any(|r| r["accountId"] == A));
        assert!(reports.iter().any(|r| r["accountId"] == B));
        assert_ne!(reports[0]["id"], reports[1]["id"]);
    }
    assert_eq!(jobs::reports(&db, "all").unwrap(), json!([]));
    assert_eq!(jobs::reports(&db, "demo").unwrap(), json!([]));
    let mut state = db.settings().unwrap()["automation"].clone();
    state[A]["jobs"][0]["status"] = "running".into();
    db.set_settings(&json!({"automation":state})).unwrap();
    drop(db);
    let db = Store::open(&root).unwrap();
    jobs::recover(&db).unwrap();
    jobs::schedule(&db, time).unwrap();
    assert_eq!(jobs::reports(&db, A).unwrap()[0]["status"], "interrupted");
    assert_eq!(jobs::reports(&db, A).unwrap().as_array().unwrap().len(), 1);
    jobs::schedule(&db, time + 86400000).unwrap();
    assert_eq!(jobs::reports(&db, A).unwrap().as_array().unwrap().len(), 2);
    let policy = policy::update(
        &db.settings().unwrap()["policy"],
        &json!({"content":{"body":false}}),
    )
    .unwrap();
    db.set_settings(&json!({"policy":policy})).unwrap();
    assert_eq!(jobs::reports(&db, A).unwrap(), json!([]));
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persisted_node_summary_fingerprints_remain_compatible() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    db.update(A, "same", &json!({"date":"2026-09-24T00:00:00.000Z"}))
        .unwrap();
    jobs::arrivals(&db, A, &["same".into()]).unwrap();
    let mut value = db.settings().unwrap()["automation"].clone();
    let job = &mut value[A]["jobs"][0];
    // Produced by server/automation.js against the same isolated fixture.
    assert_eq!(
        job["signature"],
        "f42bb4b3ddcc6e8da7247e9616a5c70f9c9481c2bca717d12157611995c8deeb"
    );
    assert_eq!(
        job["sourceDigest"],
        "4c5fad75309d7e85d8fc907c3a0a5b3ce483b61b69d9b160bea42cddd2d1b0bc"
    );
    job.as_object_mut().unwrap().remove("generation");
    db.set_settings(&json!({"automation":value})).unwrap();
    assert_eq!(jobs::reports(&db, A).unwrap().as_array().unwrap().len(), 1);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

type Call = (Value, oneshot::Sender<Value>);
async fn model(
    State(sender): State<mpsc::Sender<Call>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let (response, wait) = oneshot::channel();
    sender.send((payload, response)).await.unwrap();
    Json(wait.await.unwrap_or(json!({"error":"fixture cancelled"})))
}
async fn fake_model() -> (String, mpsc::Receiver<Call>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = mpsc::channel(8);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(model))
                .with_state(sender),
        )
        .await
        .unwrap()
    });
    (format!("http://127.0.0.1:{port}/v1"), receiver, server)
}
fn response(payload: &Value) -> Value {
    let input: Value =
        serde_json::from_str(payload["messages"][1]["content"].as_str().unwrap()).unwrap();
    let items: Vec<_> = input["emails"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |email| json!({"messageId":email["messageId"],"priority":"P2","summary":email["body"]}),
        )
        .collect();
    json!({"choices":[{"message":{"content":json!({"items":items}).to_string()}}],"usage":{"total_tokens":12}})
}
async fn next_call(receiver: &mut mpsc::Receiver<Call>) -> Call {
    // Windows CI can spend several seconds committing the durable claim before HTTP.
    tokio::time::timeout(Duration::from_secs(30), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn app_fixture(url: String) -> (App, PathBuf) {
    let root = directory();
    let app = App::open(&root, 3011, String::new(), String::new()).unwrap();
    app.db(move |db| {
        configure(db);
        let policy = policy::update(
            &db.settings()?["policy"],
            &json!({"content":{"subject":false,"sender":false}}),
        )?;
        db.set_settings(
            &json!({"ai":{"baseUrl":url,"model":"fixture","maxTokens":800},"policy":policy}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    (app, root)
}
fn run_tick(app: &App) -> tokio::task::JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move { jobs::tick(&app).await.unwrap() })
}

#[tokio::test]
async fn paid_calls_are_serial_bounded_owner_redacted_and_claimed_before_network() {
    let (url, mut calls, server) = fake_model().await;
    let (app, root) = app_fixture(url).await;
    app.db(|db| {
        for _ in 0..3 {
            jobs::arrivals(db, A, &["same".into()])?;
            jobs::arrivals(db, B, &["same".into()])?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let worker = run_tick(&app);
    for _ in 0..4 {
        let (payload, release) = next_call(&mut calls).await;
        assert!(!payload.to_string().contains("Private subject"));
        assert!(!payload.to_string().contains("Private sender"));
        assert!(
            payload["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("Asia/Hong_Kong")
        );
        assert!(
            payload["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("untrusted")
        );
        let config = app.settings().await.unwrap();
        let running: Vec<_> = [A, B]
            .into_iter()
            .flat_map(|account| {
                config["automation"][account]["jobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|job| job["status"] == "running")
                    .map(move |_| account)
            })
            .collect();
        assert_eq!(running.len(), 1);
        assert!(
            payload
                .to_string()
                .contains(&format!("Body from {}", running[0]))
        );
        assert!(!payload.to_string().contains(&format!(
            "Body from {}",
            if running[0] == A { B } else { A }
        )));
        jobs::tick(&app).await.unwrap(); // A concurrent tick cannot claim the next queued job.
        assert!(calls.try_recv().is_err());
        release.send(response(&payload)).unwrap();
    }
    worker.await.unwrap();
    assert!(calls.try_recv().is_err());
    let config = app.settings().await.unwrap();
    assert_eq!(
        [A, B]
            .iter()
            .flat_map(|account| config["automation"][account]["jobs"].as_array().unwrap())
            .filter(|job| job["status"] == "completed")
            .count(),
        4
    );
    assert_eq!(
        [A, B]
            .iter()
            .flat_map(|account| config["automation"][account]["jobs"].as_array().unwrap())
            .filter(|job| job["status"] == "queued")
            .count(),
        2
    );
    server.abort();
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn source_permissions_models_connections_and_transient_generation_discard_results() {
    for change in [
        "body",
        "policy",
        "model",
        "connection",
        "disconnect",
        "generation",
    ] {
        let (url, mut calls, server) = fake_model().await;
        let (app, root) = app_fixture(url).await;
        app.db(|db| jobs::arrivals(db, A, &["same".into()]))
            .await
            .unwrap();
        let worker = run_tick(&app);
        let (payload, release) = next_call(&mut calls).await;
        app.db(move |db| {
            let mut config = db.settings()?;
            match change {
                "body" => {
                    db.update(A, "same", &json!({"body":"Changed source"}))?;
                }
                "policy" => {
                    config["policy"]["enabled"] = false.into();
                    db.set_settings(&json!({"policy":config["policy"]}))?;
                }
                "model" => {
                    config["ai"]["model"] = "new-model".into();
                    db.set_settings(&json!({"ai":config["ai"]}))?;
                }
                "connection" => {
                    config["mailAccounts"][A]["connectionId"] = "new".into();
                    db.set_settings(&json!({"mailAccounts":config["mailAccounts"]}))?;
                }
                "disconnect" => {
                    config["mailAccounts"].as_object_mut().unwrap().remove(A);
                    db.set_settings(&json!({"mailAccounts":config["mailAccounts"]}))?;
                }
                "generation" => {
                    ai::invalidate(db)?;
                }
                _ => unreachable!(),
            }
            Ok(())
        })
        .await
        .unwrap();
        release.send(response(&payload)).unwrap();
        worker.await.unwrap();
        assert_eq!(
            app.settings().await.unwrap()["automation"][A]["jobs"][0]["status"],
            "skipped",
            "{change}"
        );
        assert_eq!(app.db(|db| jobs::reports(db, A)).await.unwrap(), json!([]));
        jobs::tick(&app).await.unwrap();
        assert!(calls.try_recv().is_err());
        server.abort();
        drop(app);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn failed_or_shutdown_model_calls_never_retry_and_overflow_stays_visible() {
    let (url, mut calls, server) = fake_model().await;
    let (app, root) = app_fixture(url).await;
    app.db(|db| jobs::arrivals(db, A, &["same".into()]))
        .await
        .unwrap();
    let worker = run_tick(&app);
    let (_, release) = next_call(&mut calls).await;
    release
        .send(json!({"privateError":"fixture secret"}))
        .unwrap();
    worker.await.unwrap();
    jobs::tick(&app).await.unwrap();
    assert!(calls.try_recv().is_err());
    let reports = app.db(|db| jobs::reports(db, A)).await.unwrap();
    assert_eq!(reports[0]["status"], "failed");
    assert!(!reports.to_string().contains("fixture secret"));
    app.db(|db| jobs::arrivals(db, A, &["same".into()]))
        .await
        .unwrap();
    let worker = run_tick(&app);
    let (_, release) = next_call(&mut calls).await;
    jobs::stop(&app);
    tokio::time::timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap();
    drop(release);
    drop(app);
    let app = App::open(&root, 3011, String::new(), String::new()).unwrap();
    assert_eq!(
        app.db(|db| jobs::reports(db, A)).await.unwrap()[0]["status"],
        "interrupted"
    );
    jobs::tick(&app).await.unwrap();
    assert!(calls.try_recv().is_err());
    server.abort();
    drop(app);
    fs::remove_dir_all(root).unwrap();

    let root = directory();
    let app = App::open(&root, 3011, String::new(), String::new()).unwrap();
    app.db(|db| {
        db.set_settings(
            &json!({"policy":policy::update(&json!({}),&json!({"triggers":{"onArrival":true}}))?}),
        )?;
        let id = db
            .list("demo")?
            .iter()
            .find(|message| message["folder"] == "inbox")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        for _ in 0..101 {
            jobs::arrivals(db, "demo", std::slice::from_ref(&id))?;
        }
        assert_eq!(jobs::overflow(db, "demo")?, 1);
        assert_eq!(
            db.settings()?["automation"]["demo"]["jobs"]
                .as_array()
                .unwrap()
                .len(),
            100
        );
        Ok(())
    })
    .await
    .unwrap();
    for _ in 0..25 {
        jobs::tick(&app).await.unwrap();
    }
    let config = app.settings().await.unwrap();
    let history = config["automation"]["demo"]["jobs"].as_array().unwrap();
    assert_eq!(history.len(), 20);
    assert!(
        history
            .iter()
            .all(|job| job["status"] == "completed" && job["source"] == "demo")
    );
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn brain_value_and_sources_outside_summary_context_are_rechecked() {
    for change in ["source-body", "source-folder", "brain-edit", "brain-delete"] {
        let (url, mut calls, server) = fake_model().await;
        let (app, root) = app_fixture(url).await;
        app.db(|db|{
            let config=db.settings()?;
            let policy=policy::update(&config["policy"],&json!({"content":{"subject":true,"sender":true},"folders":{"sent":true}}))?;
            db.set_settings(&json!({"policy":policy}))?;
            db.upsert(A,&json!({"id":"brain-source","folder":"sent","date":now(),"subject":"Approved source","body":"Approved source body","fromEmail":A,"to":B}))?;
            morrow_search::service::save_workspace(db,A,&json!({"brain":{"sourceMessageIds":["brain-source"],"voice":"approved fixture style","notes":"approved fixture note","contacts":[]}}))?;
            jobs::arrivals(db,A,&["same".into()])
        }).await.unwrap();
        let worker = run_tick(&app);
        let (payload, release) = next_call(&mut calls).await;
        let input: Value =
            serde_json::from_str(payload["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(input["writingContext"]["voice"], "approved fixture style");
        assert_eq!(input["emails"].as_array().unwrap().len(), 1);
        assert_eq!(input["emails"][0]["messageId"], "same");
        app.db(move |db| {
            match change {
                "source-body" => {
                    db.update(
                        A,
                        "brain-source",
                        &json!({"body":"Changed source outside the summary"}),
                    )?;
                }
                "source-folder" => {
                    db.update(A, "brain-source", &json!({"folder":"trash"}))?;
                }
                "brain-edit" => {
                    morrow_search::service::save_workspace(
                        db,
                        A,
                        &json!({"brain":{"sourceMessageIds":["brain-source"],"voice":"changed"}}),
                    )?;
                }
                "brain-delete" => {
                    morrow_search::service::save_workspace(db, A, &json!({"brain":null}))?;
                }
                _ => unreachable!(),
            }
            Ok(())
        })
        .await
        .unwrap();
        release.send(response(&payload)).unwrap();
        worker.await.unwrap();
        assert_eq!(
            app.settings().await.unwrap()["automation"][A]["jobs"][0]["status"],
            "skipped",
            "{change}"
        );
        server.abort();
        drop(app);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn imports_require_owner_header_and_background_respects_mailbox_gate() {
    let root = directory();
    let app = App::open(&root, 3011, String::new(), String::new()).unwrap();
    app.db(|db| {
        configure(db);
        Ok(())
    })
    .await
    .unwrap();
    let mut context = Context {
        method: axum::http::Method::POST,
        path: vec!["imports".into(), "start".into()],
        body: json!({}),
        query: json!({}),
        headers: Default::default(),
        owner: A.into(),
        paged: true,
    };
    assert_eq!(jobs::handle(&app, &context).await.unwrap_err().status, 409);
    context
        .headers
        .insert("x-genmail-account", "all".parse().unwrap());
    assert_eq!(jobs::handle(&app, &context).await.unwrap_err().status, 409);
    context
        .headers
        .insert("x-genmail-account", A.parse().unwrap());
    jobs::handle(&app, &context).await.unwrap();
    let gate = app.0.mailbox.lock().await;
    jobs::tick(&app).await.unwrap();
    drop(gate);
    let status = app.db(|db| jobs::import_status(db, A)).await.unwrap();
    assert_eq!(status["phase"], "queued");
    assert_eq!(status["pages"], 0);
    assert_eq!(status["processed"], 0);
    assert_eq!(
        app.db(|db| jobs::import_status(db, A)).await.unwrap()["status"],
        "running"
    );
    app.db(|db| {
        let mut accounts = db.settings()?["mailAccounts"].clone();
        accounts[A]["connectionId"] = "changed".into();
        db.set_settings(&json!({"mailAccounts":accounts}))?;
        Ok(())
    })
    .await
    .unwrap();
    jobs::tick(&app).await.unwrap();
    assert_eq!(
        app.db(|db| jobs::import_status(db, A)).await.unwrap()["status"],
        "paused"
    );
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unlimited_history_preserves_old_mail_checkpoint_and_fixed_upper_bound() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    jobs::start_import(&db, A, &json!({"months":0,"allMail":true})).unwrap();
    let job = db.settings().unwrap()["imports"][A].clone();
    assert_eq!(job["since"], "");
    let before = job["before"].clone();
    let cursor = json!({"version":1,"folders":[{"path":"INBOX","kind":"inbox"}],"index":0,"next":{"path":"INBOX","validity":"55","uid":51}});
    jobs::apply_import_page(&db,A,&job,&json!({"messages":[{"id":"old","folder":"inbox","date":"1999-01-01T00:00:00.000Z"},{"id":"future","folder":"inbox","date":"2099-01-01T00:00:00.000Z"}],"nextCursor":cursor})).unwrap();
    assert!(db.get(A, "old").unwrap().is_some());
    assert!(db.get(A, "future").unwrap().is_none());
    jobs::control_import(&db, A, "pause").unwrap();
    drop(db);
    let db = Store::open(&root).unwrap();
    jobs::control_import(&db, A, "resume").unwrap();
    let job = db.settings().unwrap()["imports"][A].clone();
    assert_eq!(job["since"], "");
    assert_eq!(job["before"], before);
    assert_eq!(job["cursor"], cursor);
    jobs::apply_import_page(&db, A, &job, &json!({"messages":[],"nextCursor":null})).unwrap();
    let status = jobs::import_status(&db, A).unwrap();
    assert_eq!(status["status"], "complete");
    assert_eq!(status["imported"], 1);
    assert!(status.get("cursor").is_none());
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn briefing_includes_older_pending_and_starred_mail_before_recent_bulk() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    configure(&db);
    let policy = policy::update(
        &db.settings().unwrap()["policy"],
        &json!({"maxMessages":2,"triggers":{"scheduledSummary":true}}),
    )
    .unwrap();
    db.set_settings(&json!({"policy":policy})).unwrap();
    db.upsert(A,&json!({"id":"older-pending","folder":"inbox","pending":true,"read":true,"date":"2026-08-01","body":"Review the request"})).unwrap();
    db.upsert(A,&json!({"id":"recent-bulk","folder":"inbox","read":false,"date":"2026-10-01","body":"Weekly newsletter"})).unwrap();
    jobs::schedule(&db, timestamp("2026-09-24T01:00:00Z")).unwrap();
    assert_eq!(
        jobs::reports(&db, A).unwrap()[0]["messageIds"],
        json!(["older-pending", "same"])
    );
    let manual = ai::context_for(&db, "briefing", &json!({}), A).unwrap();
    assert_eq!(
        manual
            .messages
            .iter()
            .map(|m| m["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("older-pending"), json!("same")]
    );
    drop(db);
    fs::remove_dir_all(root).unwrap();
}
