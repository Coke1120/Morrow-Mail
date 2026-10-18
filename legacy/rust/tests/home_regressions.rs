//! Today lifecycle regressions use fictional stores only, without model/provider calls.
use base64::Engine;
use morrow_search::{
    background, home, policy,
    service::{App, Context},
    store::{Store, now},
    workflows,
};
use serde_json::{Value, json};
use std::path::PathBuf;

const A: &str = "home-review-a@example.test";
const B: &str = "home-review-b@example.test";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-home-regression-{}", uuid::Uuid::new_v4())))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn configure(db: &Store) {
    let configured = policy::update(
        &json!({}),
        &json!({
            "enabled": true,
            "triggers": {"onArrival": true, "inboxOnly": true, "starredOnly": false},
            "behaviors": {"summary": true},
            "folders": {"inbox": true},
            "content": {"subject": true, "body": true, "sender": true},
            "maxMessages": 8
        }),
    )
    .unwrap();
    db.set_settings(&json!({
        "activeAccount": A,
        "mailAccounts": {
            A: {"email": A, "provider": "imap", "connectionId": "review-a"},
            B: {"email": B, "provider": "imap", "connectionId": "review-b"}
        },
        "policy": configured
    }))
    .unwrap();
}

fn message(id: &str, date: &str, read: bool) -> Value {
    json!({
        "id": id, "date": date, "folder": "inbox", "read": read,
        "subject": format!("Fictional request {id}"),
        "fromEmail": "sender@example.test", "to": A,
        "body": "Fictional review-only message. No delivery is requested."
    })
}

async fn call(app: &App, method: &str, path: &str, owner: &str, body: Value) -> Value {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-genmail-account", owner.parse().unwrap());
    let ctx = Context {
        method: method.parse().unwrap(),
        path: path
            .split('/')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect(),
        body,
        query: json!({}),
        headers,
        owner: owner.to_owned(),
        paged: true,
    };
    let response = workflows::handle(app, &ctx).await.unwrap().unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn completing_eight_unread_suggestions_should_expose_the_ninth() {
    let root = Fixture::new();
    let app = App::open(
        &root.0,
        3017,
        "fixture-token".into(),
        "fixture-update".into(),
    )
    .unwrap();
    app.db(|db| {
        configure(db);
        for i in 1..=9 {
            db.upsert(
                A,
                &message(
                    &format!("m{i:02}"),
                    &format!("2026-10-14T{i:02}:00:00.000Z"),
                    false,
                ),
            )?;
        }
        // Same provider ID in B must never participate in A's completion state.
        db.upsert(B, &message("m09", "2026-10-14T09:00:00.000Z", false))?;
        Ok(())
    })
    .await
    .unwrap();
    let mut state = app.state(A, true).await.unwrap();
    assert_eq!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["accountId"] == A)
            .count(),
        8
    );
    for _ in 0..8 {
        let todo = state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["accountId"] == A)
            .unwrap()
            .clone();
        state = call(
            &app,
            "POST",
            "workspace/todos/complete",
            A,
            json!({"id": todo["id"], "confirm": true}),
        )
        .await;
    }
    let a_todos: Vec<_> = state["today"]["todos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["accountId"] == A)
        .collect();
    let unread = app
        .db(|db| Ok(db.list(A)?.iter().filter(|m| m["read"] == false).count()))
        .await
        .unwrap();
    eprintln!(
        "completed_latest_8: remaining_unread={unread}, a_todos={}, b_todos={}",
        a_todos.len(),
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["accountId"] == B)
            .count()
    );
    assert_eq!(unread, 9, "Completion must not mark mail read");
    assert!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["accountId"] == B && t["messageId"] == "m09")
    );
    assert!(
        a_todos.iter().any(|todo| todo["messageId"] == "m01"),
        "Completing the newest eight must expose the next unread request"
    );
}

fn summary_status_scenario(next_status: &str) {
    let root = Fixture::new();
    let db = Store::open(&root.0).unwrap();
    configure(&db);
    db.upsert(
        A,
        &message("completed-source", "2026-10-14T10:00:00.000Z", true),
    )
    .unwrap();
    db.upsert(A, &message("new-source", "2026-10-14T11:00:00.000Z", true))
        .unwrap();
    background::arrivals(&db, A, &["completed-source".into()]).unwrap();
    let mut automation = db.settings().unwrap()["automation"].clone();
    let first = &mut automation[A]["jobs"][0];
    first["createdAt"] = json!("2026-10-14T10:01:00.000Z");
    first["completedAt"] = json!("2026-10-14T10:02:00.000Z");
    first["status"] = json!("completed");
    first["items"] = json!([{"messageId": "completed-source", "priority": "P1", "summary": "Please review the fictional request."}]);
    first["text"] = json!("Fictional completed summary.");
    db.set_settings(&json!({"automation": automation})).unwrap();
    let before = background::reports(&db, A).unwrap();
    assert_eq!(
        home::todos_from_reports(&db, &db.settings().unwrap(), A, &before)
            .unwrap()
            .len(),
        1
    );

    background::arrivals(&db, A, &["new-source".into()]).unwrap();
    let mut automation = db.settings().unwrap()["automation"].clone();
    let next = &mut automation[A]["jobs"][1];
    next["createdAt"] = json!("2026-10-14T11:01:00.000Z");
    next["status"] = json!(next_status);
    db.set_settings(&json!({"automation": automation})).unwrap();
    let reports = background::reports(&db, A).unwrap();
    assert_eq!(
        reports.as_array().unwrap().len(),
        2,
        "Both jobs are still valid for this account, policy and source fingerprint"
    );
    let daily = background::daily_reports(&reports);
    assert_eq!(
        daily[0]["items"].as_array().unwrap().len(),
        1,
        "The existing completed item is preserved in the daily projection"
    );
    assert_eq!(daily[0]["status"], next_status);
    let after = home::todos_from_reports(&db, &db.settings().unwrap(), A, &reports).unwrap();
    eprintln!(
        "new_summary_status={next_status}: validated_jobs={}, retained_daily_items={}, todos={}",
        reports.as_array().unwrap().len(),
        daily[0]["items"].as_array().unwrap().len(),
        after.len()
    );
    assert!(
        after
            .iter()
            .any(|todo| todo["messageId"] == "completed-source"),
        "A newer non-completed job must not hide an already validated completed summary suggestion"
    );
    db.update(
        A,
        "completed-source",
        &json!({"body": "Changed fictional source."}),
    )
    .unwrap();
    let invalidated = background::reports(&db, A).unwrap();
    assert!(
        home::todos_from_reports(&db, &db.settings().unwrap(), A, &invalidated)
            .unwrap()
            .is_empty(),
        "A changed source must still withdraw its old summary suggestion"
    );
}

#[test]
fn queued_summary_should_keep_previous_completed_suggestion() {
    summary_status_scenario("queued");
}

#[test]
fn failed_summary_should_keep_previous_completed_suggestion() {
    summary_status_scenario("failed");
}

#[tokio::test]
async fn completed_todos_and_schedule_reviews_survive_restart_and_remain_account_owned() {
    let root = Fixture::new();
    let app = App::open(
        &root.0,
        3017,
        "fixture-token".into(),
        "fixture-update".into(),
    )
    .unwrap();
    app.db(|db| {
        configure(db);
        db.upsert(A, &message("same-id", &now(), false))?;
        db.upsert(B, &message("same-id", &now(), false))?;
        Ok(())
    })
    .await
    .unwrap();
    let state = app.state(A, true).await.unwrap();
    let todo = state["today"]["todos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["accountId"] == A)
        .unwrap()
        .clone();
    call(
        &app,
        "POST",
        "workspace/todos/complete",
        A,
        json!({"id": todo["id"], "confirm": true}),
    )
    .await;
    let state = call(&app, "POST", "skills", A, json!({
        "name": "Fictional review skill", "instructions": "Draft a fictional reply for review.",
        "autoExecute": true,
        "schedule": {"enabled": true, "cadence": "interval", "time": "09:00", "timeZone": "UTC", "intervalHours": 1}
    })).await;
    let skill_id = state["workspace"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "Fictional review skill")
        .unwrap()["id"]
        .clone();
    home::scheduled_tick(&app).await.unwrap();
    drop(app);
    let app = App::open(
        &root.0,
        3017,
        "fixture-token".into(),
        "fixture-update".into(),
    )
    .unwrap();
    home::scheduled_tick(&app).await.unwrap();
    let state = app.state(A, true).await.unwrap();
    assert!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["accountId"] != A)
    );
    assert!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["accountId"] == B)
    );
    assert_eq!(
        state["workspace"]["skillReviews"].as_array().unwrap().len(),
        1
    );
    assert_eq!(state["workspace"]["skillReviews"][0]["skillId"], skill_id);
    assert!(app.state(B, true).await.unwrap()["workspace"]["skillReviews"].is_null());
    let reopened = call(
        &app,
        "POST",
        "workspace/todos/reopen",
        A,
        json!({"id": todo["id"], "confirm": true}),
    )
    .await;
    assert!(
        reopened["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["accountId"] == A && t["id"] == todo["id"])
    );
    app.db(|db| {
        for owner in [A, B] {
            let messages = db.list(owner)?;
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0]["read"], false);
            assert_eq!(messages[0]["folder"], "inbox");
        }
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn importer_derived_long_imap_identity_should_allow_todo_completion() {
    let root = Fixture::new();
    let app = App::open(
        &root.0,
        3017,
        "fixture-token".into(),
        "fixture-update".into(),
    )
    .unwrap();
    // Use the IMAP importer's local ID construction. Import permits paths
    // up to 4096 bytes. Moving back to Inbox retains this original local ID.
    let folder_path = "Archive/Customer-projects/".repeat(18);
    assert!(folder_path.len() < 4096);
    let local_id = format!(
        "imap-folder:{}:55:7",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(folder_path.as_bytes())
    );
    let fixture_id = local_id.clone();
    app.db(move |db| {
        configure(db);
        let mut original = message(&fixture_id, "2026-10-14T10:00:00.000Z", false);
        original["folder"] = json!("archive");
        original["remoteId"] = json!("imap:55:7");
        db.upsert(A, &original)?;
        // Provider moves likewise patch by the original ID.
        db.update(
            A,
            &fixture_id,
            &json!({"folder": "inbox", "remoteId": "imap:99:9"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let state = app.state(A, true).await.unwrap();
    let todo = state["today"]["todos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["accountId"] == A)
        .unwrap()
        .clone();
    assert_eq!(todo["messageId"], local_id);
    assert_eq!(todo["id"].as_str().unwrap().len(), 69);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-genmail-account", A.parse().unwrap());
    let context = Context {
        method: axum::http::Method::POST,
        path: vec!["workspace".into(), "todos".into(), "complete".into()],
        body: json!({"id": todo["id"], "confirm": true}),
        query: json!({}),
        headers,
        owner: A.into(),
        paged: true,
    };
    let response = workflows::handle(&app, &context).await;
    if let Err(error) = &response {
        eprintln!(
            "long_imap_id: folder_bytes={}, message_id_chars={}, generated_todo_id_chars={}, complete_status={}, error={}",
            folder_path.len(),
            local_id.len(),
            todo["id"].as_str().unwrap().len(),
            error.status,
            error
        );
    }
    assert!(
        response.is_ok(),
        "A server-generated suggestion for a valid importer-derived local ID must be completable"
    );
}

#[tokio::test]
async fn legacy_completions_remain_hidden_and_reopen_with_either_identity() {
    let root = Fixture::new();
    let app = App::open(
        &root.0,
        3017,
        "fixture-token".into(),
        "fixture-update".into(),
    )
    .unwrap();
    let legacy = format!("{A}\nsame-id\nfollow-up");
    let legacy_saved = legacy.clone();
    app.db(move |db| {
        configure(db);
        db.upsert(A, &message("same-id", &now(), false))?;
        db.upsert(B, &message("same-id", &now(), false))?;
        morrow_search::service::save_workspace(db, A, &json!({"todoCompletions": {
            legacy_saved: {"completedAt": now(), "messageId": "same-id", "categoryId": "follow-up"}
        }}))?;
        Ok(())
    }).await.unwrap();
    let state = app.state(A, true).await.unwrap();
    assert!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["accountId"] != A)
    );
    assert!(
        state["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["accountId"] == B)
    );
    let complete = state["today"]["completedTodos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["accountId"] == A)
        .unwrap();
    let bounded_id = complete["id"].clone();
    assert_eq!(bounded_id.as_str().unwrap().len(), 69);
    let reopened = call(
        &app,
        "POST",
        "workspace/todos/reopen",
        A,
        json!({"id": bounded_id, "confirm": true}),
    )
    .await;
    assert!(
        reopened["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == bounded_id)
    );
    // A window still holding the old short identity can complete/reopen safely.
    let completed = call(
        &app,
        "POST",
        "workspace/todos/complete",
        A,
        json!({"id": legacy, "confirm": true}),
    )
    .await;
    assert_eq!(completed["today"]["completedTodos"][0]["id"], bounded_id);
    let reopened = call(
        &app,
        "POST",
        "workspace/todos/reopen",
        A,
        json!({"id": legacy, "confirm": true}),
    )
    .await;
    assert!(
        reopened["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == bounded_id)
    );
}
