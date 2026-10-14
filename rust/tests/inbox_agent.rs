use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use morrow_search::{
    error::Error,
    inbox_agent, mail, policy,
    service::{App, Context},
    store::{merge, string},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore};

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-agent-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const OWNER: &str = "a@example.test";
const OTHER: &str = "b@example.test";

fn message(id: &str, owner: &str) -> Value {
    json!({
        "id": id,
        "folder": "inbox",
        "date": "2026-10-14T00:00:00.000Z",
        "fromName": "Sender",
        "fromEmail": owner,
        "to": "recipient@example.test",
        "subject": "Review Northstar",
        "body": "Hello, please review the proposed timetable.",
        "preview": "Please review",
        "read": false,
        "starred": false,
        "category": "primary",
        "labels": []
    })
}
fn settings(url: &str) -> Value {
    json!({
        "activeAccount": OWNER,
        "mailAccounts": {
            OWNER: {"email": OWNER, "connectionId": "one", "provider": "imap"},
            OTHER: {"email": OTHER, "connectionId": "two", "provider": "imap"}
        },
        "ai": {"baseUrl": url, "model": "fixture", "apiKey": "fixture-only", "maxTokens": 800},
        "policy": policy::update(&json!({}), &json!({"folders": {"sent": true}})).unwrap()
    })
}

#[derive(Clone)]
struct Script {
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Value>>>,
    held: Arc<Semaphore>,
    release: Arc<Semaphore>,
    status: u16,
}
impl Script {
    fn new(status: u16) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
            held: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            status,
        }
    }
}
struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn draft_marker(text: &str) -> Option<String> {
    let rest = text.split("DRAFT_ID ").nth(1)?;
    let id: String = rest
        .chars()
        .take_while(|character| {
            !character.is_whitespace() && *character != '.' && *character != '"'
        })
        .collect();
    if id.is_empty() { None } else { Some(id) }
}
fn model_text(content: &str) -> String {
    if content.contains("CANCEL_DRAFT") {
        if content.contains("DRAFT_ID") {
            return json!({"reply": "This reply should be discarded.", "tool": null}).to_string();
        }
        return json!({
            "reply": "Saving a draft.",
            "tool": {"name": "draft_compose", "arguments": {"to": "person@example.test", "subject": "Cancel draft subject", "body": "Do not keep this."}}
        })
        .to_string();
    }
    if content.contains("COMPOSE_TARGET") {
        if let Some(id) = draft_marker(content) {
            return json!({
                "reply": "Ready for your confirmation.",
                "tool": {"name": "propose_send", "arguments": {"draftId": id}}
            })
            .to_string();
        }
        return json!({
            "reply": "Drafting.",
            "tool": {"name": "draft_compose", "arguments": {"to": "person@example.test", "subject": "Agent confirm subject", "body": "Please review this draft."}}
        })
        .to_string();
    }
    if content.contains("ARCHIVE_TARGET") {
        return json!({
            "reply": "I can archive that after you confirm.",
            "tool": {"name": "propose_action", "arguments": {"messageId": "archive-me", "action": "archive"}}
        })
        .to_string();
    }
    if content.contains("SEND_DIRECT") {
        return json!({"reply": "Sending now.", "tool": {"name": "send_mail", "arguments": {}}})
            .to_string();
    }
    if content.contains("READ_TARGET") {
        if content.contains("READ_DONE") {
            return json!({"reply": "Second turn saw the message.", "tool": null}).to_string();
        }
        return json!({
            "reply": "Reading.",
            "tool": {"name": "read_mail", "arguments": {"id": "same"}}
        })
        .to_string();
    }
    json!({"reply": "Local reply only.", "tool": null}).to_string()
}
async fn model_server(script: Script) -> Server {
    async fn respond(
        State(script): State<Script>,
        Json(input): Json<Value>,
    ) -> axum::response::Response {
        script.calls.fetch_add(1, Ordering::SeqCst);
        let content = input["messages"]
            .as_array()
            .and_then(|messages| messages.get(1))
            .and_then(|message| message["content"].as_str())
            .unwrap_or("")
            .to_owned();
        script.requests.lock().await.push(input);
        if content.contains("CANCEL_DRAFT") && content.contains("DRAFT_ID") {
            script.held.add_permits(1);
            script.release.acquire().await.unwrap().forget();
        }
        if script.status != 200 {
            return (
                axum::http::StatusCode::from_u16(script.status).unwrap(),
                [("location", "http://127.0.0.1:1/never-follow")],
                "fixture error",
            )
                .into_response();
        }
        Json(json!({"choices": [{"message": {"content": model_text(&content)}}]})).into_response()
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/v1/chat/completions", post(respond))
        .with_state(script);
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Server {
        url: format!("{url}/v1"),
        task,
    }
}
async fn app_at(directory: &Temporary, url: &str) -> App {
    let app = App::open(&directory.0, 3001, "fixture-bearer".into(), "".into()).unwrap();
    let config = settings(url);
    app.db(move |db| {
        db.set_settings(&config)?;
        db.upsert(OWNER, &message("same", OWNER))?;
        db.upsert(
            OWNER,
            &merge(
                message("archive-me", OWNER),
                &json!({"subject": "Archive me", "body": "Please file this."}),
            ),
        )?;
        db.upsert(
            OTHER,
            &merge(
                message("same", OTHER),
                &json!({"body": "OTHER ACCOUNT PRIVATE", "subject": "Private other mailbox"}),
            ),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    app
}
fn context(method: &str, path: &str, owner: &str, body: Value) -> Context {
    let mut headers = axum::http::HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    Context {
        method: method.parse().unwrap(),
        path: path
            .split('/')
            .filter(|part| !part.is_empty())
            .map(String::from)
            .collect(),
        body,
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    }
}
async fn call(
    app: &App,
    method: &str,
    path: &str,
    owner: &str,
    body: Value,
) -> Result<Value, Error> {
    let response = inbox_agent::handle(app, &context(method, path, owner, body))
        .await?
        .expect("agent route");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    if !status.is_success() {
        let mut error = Error::new(
            status.as_u16(),
            value["error"].as_str().unwrap_or("Request failed."),
        );
        error.body = value;
        return Err(error);
    }
    Ok(value)
}
async fn messages(app: &App, owner: &str) -> Vec<Value> {
    let owner = owner.to_owned();
    app.db(move |db| db.list(&owner)).await.unwrap()
}
fn count_folder(rows: &[Value], folder: &str, subject: &str) -> usize {
    rows.iter()
        .filter(|message| message["folder"] == folder && message["subject"] == subject)
        .count()
}
fn local_envelope(value: &Value, owner: &str) {
    assert_eq!(value["transport"], "local-byo");
    assert_eq!(value["cloud"], false);
    assert_eq!(value["accountId"], owner);
    let encoded = value.to_string();
    assert!(!encoded.contains("fixture-only"));
    assert!(!encoded.contains("reviewHash"));
    assert!(!encoded.contains("sendBody"));
    assert!(!encoded.contains("cliReviewHash"));
}

#[test]
fn inbox_agent_source_has_no_cloud_agent_endpoints() {
    let source = include_str!("../src/inbox_agent.rs").to_ascii_lowercase();
    for banned in [
        "genspark",
        "wss://",
        "genteam",
        "genmail_ai",
        "websocket",
        "https://",
    ] {
        assert!(!source.contains(banned), "{banned}");
    }
    assert!(source.contains("local-byo"));
    assert!(source.contains("reviewed_send_body"));
    assert!(source.contains("propose_send"));
}

#[tokio::test]
async fn turns_persist_per_account_and_other_mail_stays_private() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    local_envelope(&started, OWNER);
    assert_eq!(script.calls.load(Ordering::SeqCst), 0);
    let id = string(&started["conversation"], "id").to_owned();
    let read = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "READ_TARGET please"}),
    )
    .await
    .unwrap();
    local_envelope(&read, OWNER);
    assert_eq!(script.calls.load(Ordering::SeqCst), 2);
    let turns = read["conversation"]["turns"].as_array().unwrap();
    assert!(turns.iter().any(|turn| {
        turn["text"]
            .as_str()
            .unwrap_or("")
            .contains("Second turn saw the message.")
    }));
    let requests = script.requests.lock().await;
    let joined = requests
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("READ_DONE"));
    assert!(!joined.contains("OTHER ACCOUNT PRIVATE"));
    assert!(!joined.contains("fixture-only"));
    assert!(
        joined.contains("cannot send mail")
            || requests[0]["messages"][0]["content"]
                .as_str()
                .unwrap_or("")
                .contains("cannot send")
    );
    drop(requests);
    drop(app);
    let app = App::open(&directory.0, 3001, "fixture-bearer".into(), "".into()).unwrap();
    let opened = call(
        &app,
        "GET",
        &format!("agent/conversations/{id}"),
        OWNER,
        json!({}),
    )
    .await
    .unwrap();
    local_envelope(&opened, OWNER);
    assert!(
        opened["conversation"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|turn| turn["role"] == "user"
                && turn["text"].as_str().unwrap_or("").contains("READ_TARGET"))
    );
    let missing = call(
        &app,
        "GET",
        &format!("agent/conversations/{id}"),
        OTHER,
        json!({}),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.status, 404);
    let other = call(&app, "GET", "agent/recents", OTHER, json!({}))
        .await
        .unwrap();
    local_envelope(&other, OTHER);
    assert!(
        other["recents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != id)
    );
    let rejected = call(&app, "POST", "agent/start", "all", json!({}))
        .await
        .unwrap_err();
    assert_eq!(rejected.status, 409);
    let blank = call(&app, "POST", "agent/start", "", json!({}))
        .await
        .unwrap_err();
    assert_eq!(blank.status, 409);
}

#[tokio::test]
async fn direct_send_tool_does_not_send() {
    let directory = Temporary::new();
    let server = model_server(Script::new(200)).await;
    let app = app_at(&directory, &server.url).await;
    let id = string(
        &call(&app, "POST", "agent/start", OWNER, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let sent_before = count_folder(&messages(&app, OWNER).await, "sent", "Review Northstar");
    let result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "SEND_DIRECT now"}),
    )
    .await
    .unwrap();
    local_envelope(&result, OWNER);
    assert_eq!(result["conversation"]["status"], "idle");
    assert!(result["conversation"]["pending"].is_null());
    let note = result["conversation"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .any(|turn| {
            turn["text"]
                .as_str()
                .unwrap_or("")
                .contains("Nothing was sent")
        });
    assert!(note);
    assert_eq!(
        count_folder(&messages(&app, OWNER).await, "sent", "Review Northstar"),
        sent_before
    );
    assert_eq!(
        count_folder(
            &messages(&app, OWNER).await,
            "drafts",
            "Agent confirm subject"
        ),
        0
    );
}

#[tokio::test]
async fn send_requires_confirm_and_a_changed_draft_cannot_be_confirmed() {
    let directory = Temporary::new();
    let server = model_server(Script::new(200)).await;
    let app = app_at(&directory, &server.url).await;
    let denied = call(&app, "POST", "agent/start", "demo", json!({}))
        .await
        .unwrap();
    let denied_id = string(&denied["conversation"], "id").to_owned();
    let proposed = call(
        &app,
        "POST",
        "agent/send",
        "demo",
        json!({"conversationId": denied_id, "text": "COMPOSE_TARGET deny"}),
    )
    .await
    .unwrap();
    local_envelope(&proposed, "demo");
    assert_eq!(proposed["conversation"]["status"], "awaiting");
    assert_eq!(proposed["conversation"]["pending"]["kind"], "send");
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "sent",
            "Agent confirm subject"
        ),
        0
    );
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "drafts",
            "Agent confirm subject"
        ),
        1
    );
    let proposal = string(&proposed["conversation"]["pending"], "id").to_owned();
    let dismissed = call(
        &app,
        "POST",
        "agent/answer",
        "demo",
        json!({"conversationId": denied_id, "proposalId": proposal, "decision": "deny"}),
    )
    .await
    .unwrap();
    assert_eq!(dismissed["result"]["applied"], false);
    assert_eq!(dismissed["conversation"]["status"], "idle");
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "sent",
            "Agent confirm subject"
        ),
        0
    );
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "drafts",
            "Agent confirm subject"
        ),
        1
    );

    let confirmed_id = string(
        &call(&app, "POST", "agent/start", "demo", json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        "demo",
        json!({"conversationId": confirmed_id, "text": "COMPOSE_TARGET send"}),
    )
    .await
    .unwrap();
    let proposal = string(&waiting["conversation"]["pending"], "id").to_owned();
    let sent = call(
        &app,
        "POST",
        "agent/answer",
        "demo",
        json!({"conversationId": confirmed_id, "proposalId": proposal, "decision": "confirm"}),
    )
    .await
    .unwrap();
    assert_eq!(sent["result"]["applied"], true);
    assert_eq!(sent["conversation"]["status"], "idle");
    assert!(
        sent["conversation"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|turn| turn["text"]
                .as_str()
                .unwrap_or("")
                .contains("local demo mailbox"))
    );
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "sent",
            "Agent confirm subject"
        ),
        1
    );
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "drafts",
            "Agent confirm subject"
        ),
        1
    );

    let stale_id = string(
        &call(&app, "POST", "agent/start", "demo", json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let stale = call(
        &app,
        "POST",
        "agent/send",
        "demo",
        json!({"conversationId": stale_id, "text": "COMPOSE_TARGET edit"}),
    )
    .await
    .unwrap();
    let draft_id = draft_marker(&stale.to_string()).unwrap();
    let response = mail::handle(
        &app,
        &context("POST", "drafts", "demo", json!({"id": draft_id, "to": "person@example.test", "subject": "Agent confirm subject", "body": "Changed after review."})),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(response.status().is_success());
    let error = call(&app, "POST", "agent/answer", "demo", json!({"conversationId": stale_id, "proposalId": stale["conversation"]["pending"]["id"], "decision": "confirm"})).await.unwrap_err();
    assert_eq!(error.status, 409);
    assert!(error.to_string().to_ascii_lowercase().contains("changed"));
    assert_eq!(
        count_folder(
            &messages(&app, "demo").await,
            "sent",
            "Agent confirm subject"
        ),
        1
    );
    let draft = app
        .db(move |db| Ok(db.get("demo", &draft_id)?.unwrap()))
        .await
        .unwrap();
    assert_eq!(draft["folder"], "drafts");
    assert_eq!(draft["body"], "Changed after review.");
}

#[tokio::test]
async fn archive_waits_for_confirm() {
    let directory = Temporary::new();
    let server = model_server(Script::new(200)).await;
    let app = app_at(&directory, &server.url).await;
    let id = string(
        &call(&app, "POST", "agent/start", OWNER, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "ARCHIVE_TARGET"}),
    )
    .await
    .unwrap();
    local_envelope(&waiting, OWNER);
    assert_eq!(waiting["conversation"]["pending"]["kind"], "action");
    assert_eq!(
        app.db(|db| Ok(db.get(OWNER, "archive-me")?.unwrap()["folder"].clone()))
            .await
            .unwrap(),
        "inbox"
    );
    let proposal = string(&waiting["conversation"]["pending"], "id").to_owned();
    let applied = call(
        &app,
        "POST",
        "agent/answer",
        OWNER,
        json!({"conversationId": id, "proposalId": proposal, "decision": "confirm"}),
    )
    .await
    .unwrap();
    assert_eq!(applied["result"]["applied"], true);
    assert_eq!(
        app.db(|db| Ok(db.get(OWNER, "archive-me")?.unwrap()["folder"].clone()))
            .await
            .unwrap(),
        "archive"
    );
}

#[tokio::test]
async fn cancel_discards_an_in_flight_draft() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    let id = string(
        &call(&app, "POST", "agent/start", OWNER, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let app_for_send = app.clone();
    let id_for_send = id.clone();
    let sending = tokio::spawn(async move {
        call(
            &app_for_send,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": id_for_send, "text": "CANCEL_DRAFT"}),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(8), script.held.acquire())
        .await
        .expect("model held the second step")
        .unwrap()
        .forget();
    let cancelled = call(
        &app,
        "POST",
        "agent/cancel",
        OWNER,
        json!({"conversationId": id}),
    )
    .await
    .unwrap();
    local_envelope(&cancelled, OWNER);
    script.release.add_permits(1);
    let finished = tokio::time::timeout(std::time::Duration::from_secs(8), sending)
        .await
        .expect("send returned")
        .unwrap()
        .unwrap();
    local_envelope(&finished, OWNER);
    assert_eq!(finished["conversation"]["status"], "idle");
    assert!(
        finished["conversation"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|turn| turn["text"]
                .as_str()
                .unwrap_or("")
                .contains("Cancelled. No mail was sent."))
    );
    assert_eq!(
        count_folder(
            &messages(&app, OWNER).await,
            "drafts",
            "Cancel draft subject"
        ),
        0
    );
    assert_eq!(
        count_folder(&messages(&app, OWNER).await, "sent", "Cancel draft subject"),
        0
    );
    drop(server);
}

#[tokio::test]
async fn ask_permission_blocks_the_model() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    let id = string(
        &call(&app, "POST", "agent/start", OWNER, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    app.db(|db| {
        let policy = policy::update(
            &db.settings()?["policy"],
            &json!({"behaviors": {"ask": false}}),
        )?;
        db.set_settings(&json!({"policy": policy}))?;
        Ok(())
    })
    .await
    .unwrap();
    let error = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Hello"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, 403);
    assert_eq!(script.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn configured_model_redirects_are_not_followed() {
    let directory = Temporary::new();
    let script = Script::new(302);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    let id = string(
        &call(&app, "POST", "agent/start", OWNER, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned();
    let error = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Hello"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, 502);
    assert!(error.to_string().contains("302"));
    assert_eq!(script.calls.load(Ordering::SeqCst), 1);
    let _ = server;
}
