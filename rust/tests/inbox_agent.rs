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
        let decoded: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
        let reply = decoded["untrustedDraftSuggestion"]["body"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| model_text(&content));
        Json(json!({"choices": [{"message": {"content": reply}}]})).into_response()
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

#[tokio::test]
async fn review_history_must_not_resend_revoked_body() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.update(
            OWNER,
            "same",
            &json!({"body": "REVOKED_BODY_CANARY_123", "preview": "REVOKED_BODY_CANARY_123"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "READ_TARGET please"}),
    )
    .await
    .unwrap();
    assert_eq!(script.calls.load(Ordering::SeqCst), 2);
    app.db(|db| {
        let policy = policy::update(&db.settings()?["policy"], &json!({"content": {"body": false, "sender": false, "subject": false}, "folders": {"inbox": false}}))?;
        db.set_settings(&json!({"policy": policy}))?;
        morrow_search::ai::invalidate(db)?;
        Ok(())
    }).await.unwrap();
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Continue without reading more mail."}),
    )
    .await
    .unwrap();
    let requests = script.requests.lock().await;
    assert_eq!(requests.len(), 3);
    let next_prompt = requests[2]["messages"][1]["content"].as_str().unwrap();
    assert!(
        !next_prompt.contains("REVOKED_BODY_CANARY_123"),
        "revoked mail body was sent in the next model request: {next_prompt}"
    );
}

#[derive(Clone)]
struct ReviewSequence {
    replies: Arc<Vec<Value>>,
    requests: Arc<Mutex<Vec<Value>>>,
    index: Arc<AtomicUsize>,
}
async fn review_model_sequence(replies: Vec<Value>) -> (Server, ReviewSequence) {
    async fn respond(
        State(script): State<ReviewSequence>,
        Json(input): Json<Value>,
    ) -> Json<Value> {
        let content: Value =
            serde_json::from_str(input["messages"][1]["content"].as_str().unwrap_or("{}")).unwrap();
        script.requests.lock().await.push(input);
        if let Some(body) = content["untrustedDraftSuggestion"]["body"].as_str() {
            return Json(json!({"choices":[{"message":{"content":body}}]}));
        }
        let index = script.index.fetch_add(1, Ordering::SeqCst);
        let reply = script
            .replies
            .get(index)
            .cloned()
            .unwrap_or(json!({"reply": "Finished.", "tool": null}));
        Json(json!({"choices": [{"message": {"content": reply.to_string()}}]}))
    }
    let script = ReviewSequence {
        replies: Arc::new(replies),
        requests: Arc::new(Mutex::new(Vec::new())),
        index: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/v1/chat/completions", post(respond))
        .with_state(script.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (Server { url, task }, script)
}

#[tokio::test]
async fn review_send_proposal_must_honor_draft_content_permissions() {
    let directory = Temporary::new();
    let (server, script) = review_model_sequence(vec![json!({"reply": "Please review.", "tool": {"name": "propose_send", "arguments": {"draftId": "private-draft"}}})]).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.upsert(OWNER, &merge(message("private-draft", OWNER), &json!({"folder": "drafts", "to": "hidden-recipient@example.test", "subject": "HIDDEN_DRAFT_SUBJECT_CANARY", "body": "Private draft text."})))?;
        let policy = policy::update(&db.settings()?["policy"], &json!({"folders": {"drafts": false}, "content": {"subject": false, "sender": false}}))?;
        db.set_settings(&json!({"policy": policy}))?;
        Ok(())
    }).await.unwrap();
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Review draft private-draft."}),
    )
    .await
    .unwrap();
    assert!(waiting["conversation"]["pending"].is_null());
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Continue."}),
    )
    .await
    .unwrap();
    let requests = script.requests.lock().await;
    let next_prompt = requests.last().unwrap()["messages"][1]["content"]
        .as_str()
        .unwrap();
    assert!(
        !next_prompt.contains("HIDDEN_DRAFT_SUBJECT_CANARY")
            && !next_prompt.contains("hidden-recipient@example.test"),
        "propose_send leaked fields excluded from AI access: {next_prompt}"
    );
}

#[tokio::test]
async fn review_cancel_must_preserve_user_edits_to_agent_draft() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    let send_app = app.clone();
    let send_id = id.clone();
    let sending = tokio::spawn(async move {
        call(
            &send_app,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": send_id, "text": "CANCEL_DRAFT"}),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(8), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(
        !messages(&app, OWNER)
            .await
            .iter()
            .any(|m| m["folder"] == "drafts"),
        "provisional drafts must remain private until turn commit"
    );
    app.db(|db| {
        db.upsert(
            OWNER,
            &merge(message("user-draft", OWNER), &json!({"folder":"drafts"})),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let draft_id = "user-draft".to_owned();
    let response = mail::handle(&app, &context("POST", "drafts", OWNER, json!({"id": draft_id, "to": "person@example.test", "subject": "User revised draft", "body": "USER_AUTHORED_EDIT_CANARY"}))).await.unwrap().unwrap();
    assert!(response.status().is_success());
    call(
        &app,
        "POST",
        "agent/cancel",
        OWNER,
        json!({"conversationId": id}),
    )
    .await
    .unwrap();
    script.release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(8), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let saved = app.db(move |db| db.get(OWNER, &draft_id)).await.unwrap();
    assert!(
        saved
            .as_ref()
            .is_some_and(|m| m["body"] == "USER_AUTHORED_EDIT_CANARY"),
        "cancelling the agent deleted a user-edited draft: {saved:?}"
    );
}

#[tokio::test]
async fn review_list_mail_must_honor_context_message_cap() {
    let directory = Temporary::new();
    let (server, script) = review_model_sequence(vec![json!({"reply": "Listing.", "tool": {"name": "list_mail", "arguments": {"folder": "inbox", "limit": 20}}})]).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        let policy = policy::update(&db.settings()?["policy"], &json!({"maxMessages": 1}))?;
        db.set_settings(&json!({"policy": policy}))?;
        for i in 0..5 {
            db.upsert(
                OWNER,
                &merge(
                    message(&format!("cap-{i}"), OWNER),
                    &json!({"subject": format!("CAP_CANARY_{i}")}),
                ),
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "List recent messages."}),
    )
    .await
    .unwrap();
    let requests = script.requests.lock().await;
    assert_eq!(requests.len(), 2);
    let next_prompt = requests[1]["messages"][1]["content"].as_str().unwrap();
    let seen = (0..5)
        .filter(|i| next_prompt.contains(&format!("CAP_CANARY_{i}")))
        .count();
    assert!(
        seen <= 1,
        "maxMessages=1, but model saw {seen} synthetic message subjects: {next_prompt}"
    );
}

#[tokio::test]
async fn review_draft_reply_must_use_explicit_reply_to() {
    let directory = Temporary::new();
    let (server, _script) = review_model_sequence(vec![json!({"reply": "Drafting a reply.", "tool": {"name": "draft_reply", "arguments": {"messageId": "same", "body": "Synthetic response."}}})]).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.update(
            OWNER,
            "same",
            &json!({"fromEmail": "no-reply@example.test", "replyTo": "support@example.test"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Please draft a response."}),
    )
    .await
    .unwrap();
    let draft = messages(&app, OWNER)
        .await
        .into_iter()
        .find(|m| m["folder"] == "drafts")
        .unwrap();
    assert_eq!(
        draft["to"], "support@example.test",
        "Inbox Agent ignored the source message's explicit Reply-To header"
    );
}

#[tokio::test]
async fn review_draft_compose_must_accept_omitted_optional_subject() {
    let directory = Temporary::new();
    let (server, _script) = review_model_sequence(vec![json!({"reply": "Drafting.", "tool": {"name": "draft_compose", "arguments": {"to": "person@example.test", "body": "Synthetic response without a subject."}}})]).await;
    let app = app_at(&directory, &server.url).await;
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    let result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Draft a short message."}),
    )
    .await;
    assert!(
        result.is_ok(),
        "The system tool contract marks subject optional, but omitted subject failed: {result:?}"
    );
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .any(|m| m["folder"] == "drafts")
    );
}

// Append to a review-only harness that includes PR44's rust/tests/inbox_agent.rs.
// Synthetic account, cached messages, and loopback model only; no provider calls.
#[tokio::test]
async fn review_action_proposal_must_expire_after_reconnect() {
    let directory = Temporary::new();
    let server = model_server(Script::new(200)).await;
    let app = app_at(&directory, &server.url).await;
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    let proposed = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "ARCHIVE_TARGET"}),
    )
    .await
    .unwrap();
    assert_eq!(proposed["conversation"]["pending"]["kind"], "action");
    assert_eq!(proposed["conversation"]["status"], "awaiting");
    app.db(|db| {
        let mut config = db.settings()?;
        config["mailAccounts"][OWNER]["connectionId"] = json!("new-connection-after-review");
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    let answered = call(
        &app,
        "POST",
        "agent/answer",
        OWNER,
        json!({
            "conversationId": id,
            "proposalId": proposed["conversation"]["pending"]["id"],
            "decision": "confirm"
        }),
    )
    .await;
    let current = app
        .db(|db| Ok(db.get(OWNER, "archive-me")?.unwrap()))
        .await
        .unwrap();
    assert!(
        answered.is_err() && current["folder"] == "inbox",
        "An action reviewed under the old connection must be rejected; answer accepted={}, folder={}",
        answered.is_ok(),
        current["folder"]
    );
}

#[tokio::test]
async fn review_action_proposal_must_expire_after_source_change() {
    let directory = Temporary::new();
    let server = model_server(Script::new(200)).await;
    let app = app_at(&directory, &server.url).await;
    let started = call(&app, "POST", "agent/start", OWNER, json!({}))
        .await
        .unwrap();
    let id = string(&started["conversation"], "id").to_owned();
    let proposed = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "ARCHIVE_TARGET"}),
    )
    .await
    .unwrap();
    app.db(|db| {
        let message = db.get(OWNER, "archive-me")?.unwrap();
        db.upsert(
            OWNER,
            &merge(
                message,
                &json!({
                    "subject": "Changed after proposal: urgent work remains",
                    "body": "Do not treat the old summary as current."
                }),
            ),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let answered = call(
        &app,
        "POST",
        "agent/answer",
        OWNER,
        json!({
            "conversationId": id,
            "proposalId": proposed["conversation"]["pending"]["id"],
            "decision": "confirm"
        }),
    )
    .await;
    let current = app
        .db(|db| Ok(db.get(OWNER, "archive-me")?.unwrap()))
        .await
        .unwrap();
    assert!(
        answered.is_err() && current["folder"] == "inbox",
        "An action with stale reviewed source must be rejected; answer accepted={}, current subject={}, folder={}",
        answered.is_ok(),
        current["subject"],
        current["folder"]
    );
}

// Append/include after rust/tests/inbox_agent.rs's fixture helpers.
// Independent adversarial regressions for PR #44. Temporary fictional stores,
// loopback model servers, and demo-only send confirmation; no provider traffic.
// The parent owns compilation/integration so builds remain serialized.

#[derive(Clone)]
struct AdversarialModel {
    replies: Arc<Vec<String>>,
    requests: Arc<Mutex<Vec<Value>>>,
    index: Arc<AtomicUsize>,
    hold_at: Option<usize>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

async fn adversarial_model(
    replies: Vec<String>,
    hold_at: Option<usize>,
) -> (Server, AdversarialModel) {
    async fn respond(
        State(script): State<AdversarialModel>,
        Json(input): Json<Value>,
    ) -> Json<Value> {
        let index = script.index.fetch_add(1, Ordering::SeqCst);
        script.requests.lock().await.push(input);
        if script.hold_at == Some(index) {
            script.entered.add_permits(1);
            script.release.acquire().await.unwrap().forget();
        }
        let reply = script.replies.get(index).cloned().unwrap_or_else(|| {
            json!({"reply": "Finished fixture work.", "tool": null}).to_string()
        });
        Json(json!({"choices": [{"message": {"content": reply}}]}))
    }
    let script = AdversarialModel {
        replies: Arc::new(replies),
        requests: Arc::new(Mutex::new(Vec::new())),
        index: Arc::new(AtomicUsize::new(0)),
        hold_at,
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/v1/chat/completions", post(respond))
        .with_state(script.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (Server { url, task }, script)
}

fn adversarial_tool(name: &str, arguments: Value) -> String {
    json!({"reply": "Fixture planning step.", "tool": {"name": name, "arguments": arguments}})
        .to_string()
}

async fn adversarial_conversation(app: &App, owner: &str) -> String {
    string(
        &call(app, "POST", "agent/start", owner, json!({}))
            .await
            .unwrap()["conversation"],
        "id",
    )
    .to_owned()
}

async fn adversarial_wait(script: &AdversarialModel) {
    tokio::time::timeout(std::time::Duration::from_secs(8), script.entered.acquire())
        .await
        .expect("fixture must reach the intended model call")
        .unwrap()
        .forget();
}

async fn adversarial_cap_fixture(app: &App) {
    app.db(|db| {
        let policy = policy::update(&db.settings()?["policy"], &json!({"maxMessages": 1}))?;
        db.set_settings(&json!({"policy": policy}))?;
        db.update(
            OWNER,
            "same",
            &json!({
                "date": "2026-10-14T02:00:00.000Z",
                "subject": "FIRST_AGGREGATE_CANARY",
                "body": "FIRST_AGGREGATE_CANARY"
            }),
        )?;
        db.update(
            OWNER,
            "archive-me",
            &json!({
                "date": "2026-10-14T01:00:00.000Z",
                "subject": "SECOND_AGGREGATE_CANARY",
                "body": "SECOND_AGGREGATE_CANARY"
            }),
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn adversarial_message_cap_is_a_union_across_list_search_and_read() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![
            adversarial_tool("list_mail", json!({"folder": "inbox", "limit": 1})),
            adversarial_tool("search_mail", json!({"query": "SECOND_AGGREGATE_CANARY"})),
            adversarial_tool("read_mail", json!({"id": "archive-me"})),
        ],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    adversarial_cap_fixture(&app).await;
    let id = adversarial_conversation(&app, OWNER).await;
    // Refusing the over-budget read is also a valid safety outcome.
    let _result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Review recent messages."}),
    )
    .await;
    // A fourth request makes the third tool's result observable too.
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Continue without another tool."}),
    )
    .await
    .unwrap();
    let requests = script.requests.lock().await;
    assert_eq!(requests.len(), 4);
    assert!(requests[1].to_string().contains("FIRST_AGGREGATE_CANARY"));
    for request in requests.iter() {
        let prompt = request["messages"][1]["content"].as_str().unwrap();
        assert!(
            !(prompt.contains("FIRST_AGGREGATE_CANARY")
                && prompt.contains("SECOND_AGGREGATE_CANARY")),
            "maxMessages=1 was exceeded by the union of tool results/history: {prompt}"
        );
    }
}

#[tokio::test]
async fn adversarial_history_cannot_reset_the_message_cap_each_turn() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![
            adversarial_tool("read_mail", json!({"id": "same"})),
            json!({"reply": "First source read.", "tool": null}).to_string(),
            adversarial_tool("read_mail", json!({"id": "archive-me"})),
        ],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    adversarial_cap_fixture(&app).await;
    let id = adversarial_conversation(&app, OWNER).await;
    for text in ["Read the first selected item.", "Read a different item."] {
        let _result = call(
            &app,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": id, "text": text}),
        )
        .await;
    }
    let requests = script.requests.lock().await;
    assert!((3..=4).contains(&requests.len()));
    assert!(requests[1].to_string().contains("FIRST_AGGREGATE_CANARY"));
    for request in requests.iter() {
        let prompt = request["messages"][1]["content"].as_str().unwrap();
        assert!(
            !(prompt.contains("FIRST_AGGREGATE_CANARY")
                && prompt.contains("SECOND_AGGREGATE_CANARY")),
            "a previous turn's mail and a new read exceeded maxMessages=1: {prompt}"
        );
    }
}

#[tokio::test]
async fn adversarial_shared_writer_cannot_add_a_second_source_over_the_planner_cap() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![
            adversarial_tool("read_mail", json!({"id": "same"})),
            adversarial_tool(
                "draft_reply",
                json!({"messageId": "archive-me", "body": "Candidate for another message."}),
            ),
        ],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    adversarial_cap_fixture(&app).await;
    let id = adversarial_conversation(&app, OWNER).await;
    let _result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Read mail, then draft a response."}),
    )
    .await;
    let requests = script.requests.lock().await;
    assert_eq!(
        requests.len(),
        2,
        "the shared writer started after the planner already used the one-message budget"
    );
    assert!(requests[1].to_string().contains("FIRST_AGGREGATE_CANARY"));
    assert!(
        requests
            .iter()
            .all(|request| !request.to_string().contains("SECOND_AGGREGATE_CANARY"))
    );
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .all(|message| message["folder"] != "drafts")
    );
}

#[tokio::test]
async fn adversarial_reconnect_or_model_change_cannot_start_the_shared_writer() {
    for model_change in [false, true] {
        let directory = Temporary::new();
        let (server, script) = adversarial_model(
            vec![adversarial_tool("draft_compose", json!({
                "to": "person@example.test", "subject": "Stale planner", "body": "Stale candidate."
            }))],
            Some(0),
        )
        .await;
        let (replacement, replacement_script) = adversarial_model(vec![], None).await;
        let app = app_at(&directory, &server.url).await;
        let id = adversarial_conversation(&app, OWNER).await;
        let send_app = app.clone();
        let sending = tokio::spawn(async move {
            call(
                &send_app,
                "POST",
                "agent/send",
                OWNER,
                json!({"conversationId": id, "text": "Draft a short reply."}),
            )
            .await
        });
        adversarial_wait(&script).await;
        let replacement_url = replacement.url.clone();
        app.db(move |db| {
            let mut config = db.settings()?;
            if model_change {
                config["ai"]["baseUrl"] = replacement_url.into();
                config["ai"]["apiKey"] = "replacement-fixture-only".into();
            } else {
                config["mailAccounts"][OWNER]["connectionId"] = "replacement-connection".into();
            }
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
        script.release.add_permits(1);
        let _discarded = tokio::time::timeout(std::time::Duration::from_secs(8), sending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            script.index.load(Ordering::SeqCst),
            1,
            "a stale planner result started another call on the old endpoint"
        );
        assert_eq!(
            replacement_script.index.load(Ordering::SeqCst),
            0,
            "a stale planner result was sent to the replacement model"
        );
        assert!(
            messages(&app, OWNER)
                .await
                .iter()
                .all(|message| message["folder"] != "drafts")
        );
    }
}

#[tokio::test]
async fn adversarial_cancel_while_second_writer_runs_discards_all_staged_drafts_promptly() {
    let directory = Temporary::new();
    let compose = |subject| {
        adversarial_tool(
            "draft_compose",
            json!({
                "to": "person@example.test", "subject": subject, "body": "Planner candidate."
            }),
        )
    };
    let (server, script) = adversarial_model(
        vec![
            compose("First staged draft"),
            "First staged writer body.".into(),
            compose("Second staged draft"),
            "Second staged writer body.".into(),
        ],
        Some(3),
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    let id = adversarial_conversation(&app, OWNER).await;
    let send_app = app.clone();
    let send_id = id.clone();
    let mut sending = tokio::spawn(async move {
        call(
            &send_app,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": send_id, "text": "Draft two separate messages."}),
        )
        .await
    });
    adversarial_wait(&script).await;
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .all(|message| message["folder"] != "drafts"),
        "uncommitted draft became visible while a later writer was running"
    );
    call(
        &app,
        "POST",
        "agent/cancel",
        OWNER,
        json!({"conversationId": id}),
    )
    .await
    .unwrap();
    let completion = tokio::time::timeout(std::time::Duration::from_secs(3), &mut sending).await;
    // Release even on failure, so the fixture never retains a held connection.
    script.release.add_permits(1);
    if completion.is_err() {
        sending.abort();
    }
    completion
        .expect("cancel waited for the second writer response")
        .unwrap()
        .unwrap();
    assert_eq!(script.index.load(Ordering::SeqCst), 4);
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .all(|message| message["folder"] != "drafts")
    );
}

#[tokio::test]
async fn adversarial_permission_revocation_during_writer_discards_output_and_next_egress() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![
            adversarial_tool(
                "draft_reply",
                json!({"messageId": "same", "body": "Reply candidate."}),
            ),
            "REVOKED_WRITER_RESULT_CANARY".into(),
        ],
        Some(1),
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    let id = adversarial_conversation(&app, OWNER).await;
    let send_app = app.clone();
    let send_id = id.clone();
    let sending = tokio::spawn(async move {
        call(
            &send_app,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": send_id, "text": "Draft a response."}),
        )
        .await
    });
    adversarial_wait(&script).await;
    app.db(|db| {
        let policy = policy::update(
            &db.settings()?["policy"],
            &json!({"content": {"body": false}, "folders": {"inbox": false}}),
        )?;
        db.set_settings(&json!({"policy": policy}))?;
        morrow_search::ai::invalidate(db)?;
        Ok(())
    })
    .await
    .unwrap();
    script.release.add_permits(1);
    let _discarded = tokio::time::timeout(std::time::Duration::from_secs(8), sending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        script.index.load(Ordering::SeqCst),
        2,
        "writer output escaped into another model round after permissions changed"
    );
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .all(|message| message["folder"] != "drafts")
    );
    let opened = call(
        &app,
        "GET",
        &format!("agent/conversations/{id}"),
        OWNER,
        json!({}),
    )
    .await
    .unwrap();
    assert!(!opened.to_string().contains("REVOKED_WRITER_RESULT_CANARY"));
}

#[tokio::test]
async fn adversarial_reply_to_change_during_writer_invalidates_prepared_recipient() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![
            adversarial_tool(
                "draft_reply",
                json!({"messageId": "same", "body": "Reply candidate."}),
            ),
            "Response produced for the old reply destination.".into(),
        ],
        Some(1),
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.update(
            OWNER,
            "same",
            &json!({"replyTo": "old-support@example.test"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let id = adversarial_conversation(&app, OWNER).await;
    let send_app = app.clone();
    let sending = tokio::spawn(async move {
        call(
            &send_app,
            "POST",
            "agent/send",
            OWNER,
            json!({"conversationId": id, "text": "Draft a response to the selected source."}),
        )
        .await
    });
    adversarial_wait(&script).await;
    app.db(|db| {
        // policy::redact omits this field, although drafts::prepare uses it.
        db.update(
            OWNER,
            "same",
            &json!({"replyTo": "replacement-support@example.test"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    script.release.add_permits(1);
    let _discarded = tokio::time::timeout(std::time::Duration::from_secs(8), sending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        script.index.load(Ordering::SeqCst),
        2,
        "stale writer result was forwarded to another planner round"
    );
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .all(|message| message["folder"] != "drafts"),
        "a reply prepared under the old Reply-To was committed after its source changed"
    );
}

#[tokio::test]
async fn adversarial_reconnect_resets_mail_derived_history_before_new_endpoint_egress() {
    let directory = Temporary::new();
    let (server, script) = adversarial_model(
        vec![adversarial_tool("read_mail", json!({"id": "same"}))],
        None,
    )
    .await;
    let (replacement, replacement_script) = adversarial_model(vec![], None).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.update(
            OWNER,
            "same",
            &json!({"body": "OLD_CONNECTION_BODY_CANARY"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let id = adversarial_conversation(&app, OWNER).await;
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Read the selected message."}),
    )
    .await
    .unwrap();
    assert!(
        script.requests.lock().await[1]
            .to_string()
            .contains("OLD_CONNECTION_BODY_CANARY")
    );
    let url = replacement.url.clone();
    app.db(move |db| {
        let mut config = db.settings()?;
        config["mailAccounts"][OWNER]["connectionId"] = "new-mail-connection".into();
        config["ai"]["baseUrl"] = url.into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Continue without reading mail."}),
    )
    .await
    .unwrap();
    let requests = replacement_script.requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(
        !requests[0]
            .to_string()
            .contains("OLD_CONNECTION_BODY_CANARY"),
        "old mail history was replayed to a replacement endpoint"
    );
}

#[tokio::test]
async fn adversarial_send_review_contains_full_body_footer_and_owned_attachments() {
    let directory = Temporary::new();
    let (server, _script) = adversarial_model(
        vec![adversarial_tool(
            "propose_send",
            json!({"draftId": "complete-review"}),
        )],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    let body = format!("{} FULL_REVIEW_TAIL_CANARY", "Body ".repeat(700));
    let expected_body = body.clone();
    app.db(move |db| {
        db.set_settings(&json!({"preferences": {"displayName": "Reviewed Sender", "signature": "EFFECTIVE_FOOTER_CANARY", "signatureFormat": "plain"}}))?;
        let attachment = morrow_search::attachments::save(db, "demo", "reviewed-attachment.txt", "text/plain", "", b"fictional attachment bytes")?;
        db.upsert("demo", &merge(message("complete-review", "demo"), &json!({
            "folder": "drafts", "to": "to@example.test", "cc": "cc@example.test", "bcc": "bcc@example.test",
            "subject": "Full reviewed payload", "body": body, "attachments": [attachment]
        })))?;
        Ok(())
    }).await.unwrap();
    let id = adversarial_conversation(&app, "demo").await;
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        "demo",
        json!({"conversationId": id, "text": "Review the saved draft."}),
    )
    .await
    .unwrap();
    let preview = &waiting["conversation"]["pending"]["preview"];
    assert_eq!(preview["body"], expected_body);
    assert_eq!(preview["complete"], true);
    assert_ne!(preview["bodyTruncated"], true);
    assert_eq!(preview["fromName"], "Reviewed Sender");
    assert_eq!(preview["bcc"], "bcc@example.test");
    assert_eq!(preview["footer"]["text"], "EFFECTIVE_FOOTER_CANARY");
    assert_eq!(preview["attachments"][0]["name"], "reviewed-attachment.txt");
    assert!(preview["attachments"][0]["size"].as_u64().unwrap() > 0);
    assert!(
        preview["attachments"][0].get("data").is_none(),
        "attachment bytes do not belong in the review JSON"
    );
}

#[tokio::test]
async fn adversarial_footer_or_attachment_changes_invalidate_send_confirmation() {
    // Demo sends are a local simulation even if a regression accidentally accepts.
    for attachment_change in [false, true] {
        let directory = Temporary::new();
        let (server, _script) = adversarial_model(
            vec![adversarial_tool(
                "propose_send",
                json!({"draftId": "bound-review"}),
            )],
            None,
        )
        .await;
        let app = app_at(&directory, &server.url).await;
        app.db(|db| {
            db.set_settings(&json!({"preferences": {"signature": "Original effective footer", "signatureFormat": "plain"}}))?;
            let attachment = morrow_search::attachments::save(db, "demo", "original.txt", "text/plain", "", b"original fictional bytes")?;
            db.upsert("demo", &merge(message("bound-review", "demo"), &json!({"folder": "drafts", "attachments": [attachment]})))?;
            Ok(())
        }).await.unwrap();
        let id = adversarial_conversation(&app, "demo").await;
        let waiting = call(
            &app,
            "POST",
            "agent/send",
            "demo",
            json!({"conversationId": id, "text": "Review draft for sending."}),
        )
        .await
        .unwrap();
        assert_eq!(waiting["conversation"]["pending"]["kind"], "send");
        app.db(move |db| {
            if attachment_change {
                let replacement = morrow_search::attachments::save(
                    db,
                    "demo",
                    "replacement.txt",
                    "text/plain",
                    "",
                    b"changed fictional bytes",
                )?;
                db.update(
                    "demo",
                    "bound-review",
                    &json!({"attachments": [replacement]}),
                )?;
            } else {
                db.set_settings(
                    &json!({"preferences": {"signature": "Changed effective footer"}}),
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let result = call(&app, "POST", "agent/answer", "demo", json!({
            "conversationId": id, "proposalId": waiting["conversation"]["pending"]["id"], "decision": "confirm"
        })).await;
        assert!(
            result.is_err(),
            "changed footer/attachment accepted under old review"
        );
        assert!(
            messages(&app, "demo")
                .await
                .iter()
                .all(|message| message["folder"] != "sent"
                    || message["subject"] != "Review Northstar")
        );
        assert!(
            app.db(|db| db.get("demo", "bound-review"))
                .await
                .unwrap()
                .is_some()
        );
    }
}

#[tokio::test]
async fn agent_writer_reuses_shared_context_without_disclosing_it_to_planner() {
    const VOICE: &str = "AGENT_VOICE_CANARY: Use concise paragraphs.";
    const GUARDRAIL: &str = "AGENT_GUARDRAIL_CANARY: Never invent a price.";
    const RULE: &str = "AGENT_RULE_CANARY: Close with Kind regards.";
    const DISABLED: &str = "AGENT_DISABLED_RULE_CANARY";
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        morrow_search::service::save_workspace(
            db,
            OWNER,
            &json!({"brain": {
                "voice":VOICE,"guardrails":GUARDRAIL,"writingRules":[
                    {"id":"enabled","text":RULE,"enabled":true,"source":"user"},
                    {"id":"disabled","text":DISABLED,"enabled":false,"source":"user"}
                ]
            }}),
        )
    })
    .await
    .unwrap();
    morrow_search::ai::assistance(
        &app,
        &json!({"action":"write","prompt":"Draft a short note."}),
        OWNER,
        None,
    )
    .await
    .unwrap();
    let shared_rules = script.requests.lock().await[0].to_string().contains(RULE);
    let id = adversarial_conversation(&app, OWNER).await;
    let result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId":id,"text":"COMPOSE_TARGET please draft a note."}),
    )
    .await
    .unwrap();
    assert_eq!(result["conversation"]["status"], "awaiting");
    let requests = script.requests.lock().await;
    let mut writer_count = 0;
    for request in &requests[1..] {
        let content: Value =
            serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
        let encoded = content.to_string();
        if content.get("untrustedDraftSuggestion").is_some() {
            writer_count += 1;
            assert!(encoded.contains(VOICE));
            assert!(encoded.contains(GUARDRAIL));
            assert_eq!(
                encoded.contains(RULE),
                shared_rules,
                "merged writing rules must use the same shared payload path"
            );
            assert_eq!(content["request"], "COMPOSE_TARGET please draft a note.");
            assert_eq!(
                content["untrustedDraftSuggestion"]["body"],
                "Please review this draft."
            );
        } else {
            assert!(
                !encoded.contains(VOICE) && !encoded.contains(GUARDRAIL) && !encoded.contains(RULE)
            );
        }
        assert!(!encoded.contains(DISABLED));
    }
    assert_eq!(writer_count, 1);
    drop(requests);
    assert!(
        messages(&app, OWNER)
            .await
            .iter()
            .any(|m| m["folder"] == "drafts" && m["body"] == "Please review this draft.")
    );
}

#[tokio::test]
async fn writer_respects_memory_permission_and_existing_user_drafts_survive_cancel() {
    let directory = Temporary::new();
    let script = Script::new(200);
    let server = model_server(script.clone()).await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        morrow_search::service::save_workspace(
            db,
            OWNER,
            &json!({"brain":{"voice":"WITHHELD_VOICE_CANARY"}}),
        )?;
        let policy = policy::update(
            &db.settings()?["policy"],
            &json!({"behaviors":{"memory":false}}),
        )?;
        db.set_settings(&json!({"policy":policy}))?;
        Ok(())
    })
    .await
    .unwrap();
    let id = adversarial_conversation(&app, OWNER).await;
    let result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId":id,"text":"COMPOSE_TARGET please."}),
    )
    .await
    .unwrap();
    let draft_id = string(&result["conversation"]["pending"], "draftId").to_owned();
    assert!(
        script
            .requests
            .lock()
            .await
            .iter()
            .all(|request| !request.to_string().contains("WITHHELD_VOICE_CANARY"))
    );
    let saved = mail::handle(&app, &context("POST","drafts",OWNER,json!({"id":draft_id,"to":"person@example.test","subject":"User saved version","body":"ADOPTED_USER_BODY"}))).await.unwrap().unwrap();
    assert!(saved.status().is_success());
    call(
        &app,
        "POST",
        "agent/cancel",
        OWNER,
        json!({"conversationId":id}),
    )
    .await
    .unwrap();
    assert_eq!(
        app.db(move |db| Ok(db.get(OWNER, &draft_id)?.unwrap()["body"].clone()))
            .await
            .unwrap(),
        "ADOPTED_USER_BODY"
    );
}

#[tokio::test]
async fn deleting_a_source_discards_derived_model_history_but_retains_local_history() {
    let directory = Temporary::new();
    let (server, script) = review_model_sequence(vec![
        json!({"reply":"Reading.","tool":{"name":"read_mail","arguments":{"id":"same"}}}),
    ])
    .await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.update(OWNER, "same", &json!({"body":"DELETED_SOURCE_CANARY"}))?;
        Ok(())
    })
    .await
    .unwrap();
    let id = adversarial_conversation(&app, OWNER).await;
    call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId":id,"text":"Read the selected mail."}),
    )
    .await
    .unwrap();
    app.db(|db| {
        db.delete(OWNER, "same")?;
        Ok(())
    })
    .await
    .unwrap();
    let result = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId":id,"text":"Continue without reading mail."}),
    )
    .await
    .unwrap();
    assert!(
        result.to_string().contains("DELETED_SOURCE_CANARY"),
        "local conversation history remains user-visible"
    );
    let requests = script.requests.lock().await;
    assert!(
        !requests
            .last()
            .unwrap()
            .to_string()
            .contains("DELETED_SOURCE_CANARY")
    );
}

// Append after adversarial-tests-snippet.rs and the Inbox Agent fixture helpers.
// Deterministically changes the reviewed source after apply_confirm's first DB
// check but before the normal message PATCH. No production hooks/provider calls.
#[tokio::test]
async fn adversarial_action_source_changes_after_confirm_prepare_before_patch() {
    let directory = Temporary::new();
    let (server, _script) = adversarial_model(
        vec![adversarial_tool(
            "propose_action",
            json!({"messageId": "archive-me", "action": "archive"}),
        )],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    let id = adversarial_conversation(&app, OWNER).await;
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        OWNER,
        json!({"conversationId": id, "text": "Propose archiving the selected message."}),
    )
    .await
    .unwrap();
    assert_eq!(waiting["conversation"]["pending"]["kind"], "action");

    // App.db uses one FIFO semaphore permit. Hold that permit while queuing
    // confirmation's prepare, then the source mutation. Confirmation's later
    // PATCH necessarily queues after the mutation.
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocking_app = app.clone();
    let blocking = tokio::spawn(async move {
        blocking_app
            .db(move |_| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(8))
                    .unwrap();
                Ok(())
            })
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(8), entered_rx)
        .await
        .unwrap()
        .unwrap();
    let mut confirming = Box::pin(call(
        &app,
        "POST",
        "agent/answer",
        OWNER,
        json!({
            "conversationId": id, "proposalId": waiting["conversation"]["pending"]["id"], "decision": "confirm"
        }),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(confirming.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let mut mutation = Box::pin(app.db(|db| {
        db.update(
            OWNER,
            "archive-me",
            &json!({
                "subject": "Changed between confirmation prepare and PATCH",
                "body": "The old source proof must no longer apply."
            }),
        )?;
        Ok(())
    }));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(mutation.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release_tx.send(()).unwrap();
    let (confirmed, changed, released) =
        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            tokio::join!(confirming, mutation, blocking)
        })
        .await
        .unwrap();
    changed.unwrap();
    released.unwrap().unwrap();
    let current = app
        .db(|db| db.get(OWNER, "archive-me"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current["subject"],
        "Changed between confirmation prepare and PATCH"
    );
    assert!(
        confirmed.is_err(),
        "confirmation reused the earlier source check after a queued mutation"
    );
    assert_eq!(
        current["folder"], "inbox",
        "the stale action reached the final mutation"
    );
}

#[tokio::test]
async fn incomplete_legacy_send_review_is_rejected_by_the_server() {
    let directory = Temporary::new();
    let (server, _script) = adversarial_model(
        vec![adversarial_tool(
            "propose_send",
            json!({"draftId":"legacy-reviewed-draft"}),
        )],
        None,
    )
    .await;
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        db.upsert(
            "demo",
            &merge(
                message("legacy-reviewed-draft", "demo"),
                &json!({
                    "folder":"drafts","body":"A full synthetic body that must be reviewed.",
                    "footer":{"text":"Explicit footer", "html":""}
                }),
            ),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let id = adversarial_conversation(&app, "demo").await;
    let waiting = call(
        &app,
        "POST",
        "agent/send",
        "demo",
        json!({
            "conversationId":id,"text":"Review the saved draft."
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        waiting["conversation"]["pending"]["preview"]["complete"],
        true
    );
    let stored_id = id.clone();
    app.db(move |db| {
        let encoded: String = db.conn.query_row(
            "SELECT data FROM inbox_agent WHERE account=? AND id=?",
            rusqlite::params!["demo", stored_id],
            |row| row.get(0),
        )?;
        let mut conversation: Value = serde_json::from_str(&encoded)?;
        // Reproduce the old persisted preview contract without changing the valid payload hash.
        conversation["pending"]["preview"]
            .as_object_mut()
            .unwrap()
            .remove("complete");
        conversation["pending"]["preview"]["bodyTruncated"] = true.into();
        conversation["pending"]["preview"]["body"] = "A full synthetic".into();
        db.conn.execute(
            "UPDATE inbox_agent SET data=? WHERE account=? AND id=?",
            rusqlite::params![conversation.to_string(), "demo", stored_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let result = call(&app, "POST", "agent/answer", "demo", json!({
        "conversationId":id,"proposalId":waiting["conversation"]["pending"]["id"],"decision":"confirm"
    })).await;
    assert_eq!(
        result.unwrap_err().status,
        409,
        "An old excerpt-only review must fail even for a direct API client"
    );
    assert!(
        app.db(|db| db.get("demo", "legacy-reviewed-draft"))
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        messages(&app, "demo")
            .await
            .iter()
            .all(|m| m["folder"] != "sent" || m["subject"] != "Review Northstar")
    );
}
