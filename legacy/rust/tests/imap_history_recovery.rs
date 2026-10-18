//! Isolated transport failure and durable IMAP history retry. No live mailbox.
use morrow_search::{background, service::App};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const OWNER: &str = "imap-retry@example.invalid";

#[tokio::test]
async fn transient_imap_read_keeps_checkpoint_and_backoff_across_restart() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let root = std::env::temp_dir().join(format!(
        "morrow-imap-history-retry-{}",
        uuid::Uuid::new_v4()
    ));
    let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
    app.db(move |db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER,"provider":"imap","connectionId":"fixture-connection","imapHost":"127.0.0.1","imapPort":port,"password":"synthetic-unused-password"}},"preferences":{"syncInterval":0}}))?;
        background::start_import(db, OWNER, &json!({"months":0,"inbox":true,"sent":false}))?;
        let mut imports = db.settings()?["imports"].clone();
        imports[OWNER]["cursor"] = json!({"path":"INBOX","validity":"55","uid":11});
        imports[OWNER]["pages"] = 1.into();
        imports[OWNER]["imported"] = 50.into();
        db.set_settings(&json!({"imports":imports}))?;
        Ok(())
    }).await.unwrap();
    let initial = app.settings().await.unwrap()["imports"][OWNER].clone();
    background::tick(&app).await.unwrap();
    let first = app
        .db(|db| background::import_status(db, OWNER))
        .await
        .unwrap();
    assert_eq!(first["status"], "running");
    assert_eq!(first["errorCode"], "network_error");
    assert_eq!(first["retryCount"], 1);
    assert_ne!(first["nextRetryAt"], Value::Null);
    drop(app);
    let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
    app.db(background::recover).await.unwrap();
    background::tick(&app).await.unwrap();
    let after_restart = app
        .db(|db| background::import_status(db, OWNER))
        .await
        .unwrap();
    assert_eq!(after_restart["status"], "running");
    assert_eq!(after_restart["nextRetryAt"], first["nextRetryAt"]);
    assert_eq!(
        after_restart["retryCount"], 1,
        "Persisted backoff must defer the next attempt"
    );
    app.db(|db| {
        let mut imports = db.settings()?["imports"].clone();
        imports[OWNER]["nextRetryAt"] = "2000-01-01T00:00:00.000Z".into();
        db.set_settings(&json!({"imports":imports}))?;
        Ok(())
    })
    .await
    .unwrap();
    background::tick(&app).await.unwrap();
    let repeated = app
        .db(|db| background::import_status(db, OWNER))
        .await
        .unwrap();
    assert_eq!(repeated["status"], "running");
    assert_eq!(repeated["retryCount"], 2);
    let stored = app.settings().await.unwrap()["imports"][OWNER].clone();
    for key in [
        "cursor",
        "pages",
        "imported",
        "folderIndex",
        "recentSince",
        "before",
    ] {
        assert_eq!(stored[key], initial[key], "Retry must preserve {key}");
    }
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}
