use futures_util::poll;
use morrow_search::{
    mail,
    service::{App, Context},
    store::{Store, merge},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::mpsc, task::Poll};

const OWNER: &str = "owner@example.invalid";
const OTHER: &str = "other@example.invalid";

fn draft(body: &str) -> Value {
    json!({"id":"saved","to":"to@example.invalid","cc":"cc@example.invalid","bcc":"hidden@example.invalid","subject":"Reviewed subject","body":body,"footer":{"text":"Reviewed footer"}})
}

fn fixture() -> (PathBuf, App) {
    let directory =
        std::env::temp_dir().join(format!("morrow-draft-concurrency-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER},OTHER:{"email":OTHER}},"activeAccount":OTHER,"preferences":{"syncInterval":0}}))
        .unwrap();
    db.upsert(
        OWNER,
        &merge(draft("Original text"), &json!({"folder":"drafts"})),
    )
    .unwrap();
    db.upsert(
        OTHER,
        &merge(draft("Other owner's text"), &json!({"folder":"drafts"})),
    )
    .unwrap();
    drop(db);
    let app = App::open(
        &directory,
        0,
        "fixture-bearer".into(),
        "fixture-update".into(),
    )
    .unwrap();
    (directory, app)
}

fn context(path: &str, body: Value) -> Context {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-genmail-account", OWNER.parse().unwrap());
    Context {
        method: axum::http::Method::POST,
        path: vec![path.into()],
        body,
        query: json!({}),
        headers,
        owner: OWNER.into(),
        paged: true,
    }
}

fn send_context() -> Context {
    // Native sends have no cliReviewHash to catch an intervening saved edit.
    context(
        "send",
        merge(
            draft("Original text"),
            &json!({"draftId":"saved","requestId":"reviewed-send-123"}),
        ),
    )
}

async fn hold_database(app: &App) -> (mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let app = app.clone();
    let blocked = tokio::spawn(async move {
        app.db(move |_| {
            entered_tx.send(()).unwrap();
            // Dropping the sender also releases this closure if a test assertion fails.
            let _ = release_rx.recv();
            Ok(())
        })
        .await
        .unwrap();
    });
    entered_rx.await.unwrap();
    (release_tx, blocked)
}

async fn assert_saved(app: &App, body: &'static str) {
    app.db(move |db| {
        let saved = db.get(OWNER, "saved")?.unwrap();
        assert_eq!(saved["body"], body);
        assert_eq!(saved["bcc"], "hidden@example.invalid");
        assert_eq!(saved["footer"]["text"], "Reviewed footer");
        assert_eq!(
            db.get(OTHER, "saved")?.unwrap()["body"],
            "Other owner's text"
        );
        assert!(db.get(OWNER, "sent:reviewed-send-123")?.is_none());
        assert!(
            db.settings()?["deliveryAttempts"]
                .as_array()
                .is_none_or(Vec::is_empty)
        );
        assert_eq!(db.settings()?["activeAccount"], OTHER);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn draft_save_is_rejected_while_send_preparation_waits_for_database() {
    let (directory, app) = fixture();
    let (release, blocked) = hold_database(&app).await;
    let send = send_context();
    let save = context("drafts", draft("New saved text"));

    // Poll the real handlers directly so transport account reads cannot obscure the queue.
    let mut sending = Box::pin(mail::handle(&app, &send));
    assert!(matches!(poll!(sending.as_mut()), Poll::Pending));
    assert!(app.0.mailbox.try_lock().is_err());
    assert!(app.0.sending.lock().unwrap().is_empty());
    let mut saving = Box::pin(mail::handle(&app, &save));
    match poll!(saving.as_mut()) {
        Poll::Ready(Err(error)) => assert_eq!(error.status, 409),
        _ => panic!("A save must fail before queuing behind send preparation."),
    }
    drop(saving);

    // Cancel while preparation is still queued: no attempt or provider delivery can run.
    drop(sending);
    release.send(()).unwrap();
    blocked.await.unwrap();
    assert_saved(&app, "Original text").await;
    assert!(app.0.sending.lock().unwrap().is_empty());

    let response = mail::handle(&app, &save).await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    assert_saved(&app, "New saved text").await;
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn queued_draft_save_holds_the_send_gate_until_the_write_finishes() {
    let (directory, app) = fixture();
    let (release, blocked) = hold_database(&app).await;
    let save = context("drafts", draft("New saved text"));
    let send = send_context();
    let mut saving = Box::pin(mail::handle(&app, &save));
    assert!(matches!(poll!(saving.as_mut()), Poll::Pending));
    assert!(app.0.mailbox.try_lock().is_err());
    let mut sending = Box::pin(mail::handle(&app, &send));
    match poll!(sending.as_mut()) {
        Poll::Ready(Err(error)) => assert_eq!(error.status, 409),
        _ => panic!("A send must fail while a draft save owns the gate."),
    }
    drop(sending);

    release.send(()).unwrap();
    blocked.await.unwrap();
    assert_eq!(saving.await.unwrap().unwrap().status(), 200);
    assert!(app.0.mailbox.try_lock().is_ok());
    assert!(app.0.sending.lock().unwrap().is_empty());
    assert_saved(&app, "New saved text").await;
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}
