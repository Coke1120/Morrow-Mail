use morrow_search::{error::Error, mail, store::Store, sync_profile};
use serde_json::json;

#[tokio::test]
async fn unchanged_import_skips_writes_flags_skip_fts_and_indexed_fields_refresh() {
    let root = std::env::temp_dir().join(format!("morrow-sync-storage-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    let connection = json!({"email":"fixture@example.invalid","provider":"google"});
    let message = json!({"id":"google:same","folder":"inbox","fromName":"Sender","fromEmail":"sender@example.invalid","to":"to@example.invalid","cc":"","bcc":"","subject":"Old invoice","body":"Private synthetic text only","labels":[],"date":"2026-10-12T00:00:00.000Z","read":false,"starred":false,"providerLabelIds":["INBOX","UNREAD"],"providerSent":false,"providerDraft":false});
    mail::import_messages(&db, &connection, &[message]).unwrap();
    let canonical = db
        .get("fixture@example.invalid", "google:same")
        .unwrap()
        .unwrap();
    let before = db.conn.total_changes();
    let (result, report) = sync_profile::capture(async {
        mail::import_messages(&db, &connection, std::slice::from_ref(&canonical))
    })
    .await;
    assert!(result.unwrap().is_empty());
    assert_eq!(db.conn.total_changes(), before);
    assert_eq!(report["counters"]["unchangedRows"], 1);
    let mut flags = canonical.clone();
    flags["read"] = true.into();
    flags["providerLabelIds"] = json!(["INBOX"]);
    let (result, report) =
        sync_profile::capture(async { mail::import_messages(&db, &connection, &[flags]) }).await;
    result.unwrap();
    assert!(report["counters"]["ftsTokenCalls"].is_null());
    let unread: i64 = db
        .conn
        .query_row(
            "SELECT unread FROM search_documents WHERE account=? AND id=?",
            ["fixture@example.invalid", "google:same"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unread, 0);
    for (field, text) in [
        ("subject", "Changedsubject"),
        ("body", "Changedbody"),
        ("fromName", "Changedname"),
        ("fromEmail", "Changedemail@example.invalid"),
        ("to", "Changedto@example.invalid"),
        ("cc", "Changedcc@example.invalid"),
        ("bcc", "Changedbcc@example.invalid"),
    ] {
        let (result, report) = sync_profile::capture(async {
            db.update(
                "fixture@example.invalid",
                "google:same",
                &json!({field:text}),
            )
        })
        .await;
        result.unwrap();
        assert_eq!(report["counters"]["ftsTokenCalls"], 5, "{field}");
        let found: bool = db
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM search_fts WHERE search_fts MATCH ?)",
                [text.split('@').next().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(found, "{field}");
    }
    let (result, report) = sync_profile::capture(async {
        db.update(
            "fixture@example.invalid",
            "google:same",
            &json!({"labels":["changedlabel"]}),
        )
    })
    .await;
    result.unwrap();
    assert_eq!(report["counters"]["ftsTokenCalls"], 5);
    let old = db.get("fixture@example.invalid", "google:same").unwrap();
    let failed: Result<(), Error> = db.transaction(|db| {
        db.update(
            "fixture@example.invalid",
            "google:same",
            &json!({"body":"rolledbacktoken"}),
        )?;
        db.set_settings(&json!({"gmailSync":{"fixture@example.invalid":{"historyId":"999"}}}))?;
        Err(Error::conflict("synthetic rollback"))
    });
    assert!(failed.is_err());
    assert_eq!(
        db.get("fixture@example.invalid", "google:same").unwrap(),
        old
    );
    assert!(db.settings().unwrap()["gmailSync"].is_null());
    assert!(
        !db.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM search_fts WHERE search_fts MATCH 'rolledbacktoken')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    // Startup replaces old trigger definitions without rebuilding populated FTS.
    db.conn.execute_batch("DROP TRIGGER search_message_update; CREATE TRIGGER search_message_update AFTER UPDATE ON messages BEGIN DELETE FROM search_documents WHERE rowid=old.rowid; END;").unwrap();
    drop(db);
    let db = Store::open(&root).unwrap();
    let (result, report) = sync_profile::capture(async {
        db.update(
            "fixture@example.invalid",
            "google:same",
            &json!({"starred":true}),
        )
    })
    .await;
    result.unwrap();
    assert!(report["counters"]["ftsTokenCalls"].is_null());
    assert_eq!(
        db.conn
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
