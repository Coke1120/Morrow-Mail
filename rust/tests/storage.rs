use morrow_search::{error::Error, store::Store};
use serde_json::json;
use std::fs;

#[test]
fn transactions_lock_backup_and_recovery() {
    let root = std::env::temp_dir().join(format!("morrow-rust-storage-{}", uuid::Uuid::new_v4()));
    let path = root.join("data");
    let store = Store::open(&path).unwrap();
    assert!(Store::open(&path).is_err());
    let legacy = rusqlite::Connection::open(path.join("genmail.sqlite")).unwrap();
    legacy
        .busy_timeout(std::time::Duration::from_millis(10))
        .unwrap();
    assert!(
        legacy
            .execute("UPDATE settings SET value=value WHERE id=1", [])
            .is_err(),
        "legacy Node SQLite writers must also be excluded"
    );
    drop(legacy);
    let message = json!({"id":"same", "folder":"inbox", "body":"私人內容", "subject":"發票", "date":"2026-09-25T00:00:00.000Z"});
    store.transaction(|store| { store.upsert("a@example.invalid", &message)?; store.upsert("b@example.invalid", &message)?; store.set_settings(&json!({"fixtureCredential":"fixture-only", "calendarRequests":{"retry-id":{"status":"pending","title":"keep original"}}}))?; Ok(()) }).unwrap();
    let before = store.revision().unwrap();
    let failed: Result<(), Error> = store.transaction(|store| {
        store.update("a@example.invalid", "same", &json!({"body":"rollback"}))?;
        store.transaction(|store| {
            store.delete("b@example.invalid", "same")?;
            Ok(())
        })?;
        Err(Error::conflict("fixture rollback"))
    });
    assert!(failed.is_err());
    assert_ne!(before, store.revision().unwrap());
    assert_eq!(
        store.get("a@example.invalid", "same").unwrap(),
        Some(message.clone())
    );
    assert_eq!(
        store.get("b@example.invalid", "same").unwrap(),
        Some(message)
    );
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), Error> = store.transaction(|db| {
            db.set_settings(&json!({"panicWrite":true}))?;
            panic!("fixture panic before commit");
        });
    }));
    assert!(panicked.is_err());
    assert!(store.settings().unwrap()["panicWrite"].is_null());
    let pages: i64 = store
        .conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    store
        .conn
        .pragma_update(None, "max_page_count", pages + 1)
        .unwrap();
    let full = store.transaction(|db| {
        db.set_settings(&json!({"diskFullWrite":true}))?;
        db.upsert(
            "a@example.invalid",
            &json!({"id":"disk-full", "folder":"inbox", "opaqueFixture":"x".repeat(1024 * 1024)}),
        )?;
        Ok(())
    });
    assert!(
        full.is_err(),
        "SQLite disk-full injection must fail the transaction"
    );
    assert!(store.settings().unwrap()["diskFullWrite"].is_null());
    assert!(
        store
            .get("a@example.invalid", "disk-full")
            .unwrap()
            .is_none()
    );
    store
        .conn
        .pragma_update(None, "max_page_count", 2147483646_i64)
        .unwrap();
    store
        .transaction(|db| {
            db.set_settings(&json!({"afterFault":true}))?;
            Ok(())
        })
        .unwrap();
    fs::write(
        path.join("pending-calendar.json"),
        b"{\"requestId\":\"same-retry\"}",
    )
    .unwrap();
    fs::write(
        path.join("client-state.json"),
        b"{\"morrow.pendingCalendar\":\"same-retry\"}",
    )
    .unwrap();
    let backup = root.join("backup");
    store.backup(&backup).unwrap();
    let snapshot = fs::read(backup.join("genmail.sqlite")).unwrap();
    assert!(store.backup(&backup).is_err());
    assert_eq!(snapshot, fs::read(backup.join("genmail.sqlite")).unwrap());
    let restored = Store::open(&backup).unwrap();
    assert_eq!(restored.settings().unwrap(), store.settings().unwrap());
    assert_eq!(
        fs::read(backup.join("pending-calendar.json")).unwrap(),
        fs::read(path.join("pending-calendar.json")).unwrap()
    );
    assert_eq!(
        fs::read(backup.join("client-state.json")).unwrap(),
        fs::read(path.join("client-state.json")).unwrap()
    );
    assert!(!String::from_utf8_lossy(&snapshot).contains("fixture-only"));
    drop(restored);
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.settings().unwrap()["calendarRequests"]["retry-id"]["title"],
        "keep original"
    );
    drop(reopened);
    let original = fs::read(path.join("encryption.key")).unwrap();
    fs::write(path.join("encryption.key"), [0u8; 32]).unwrap();
    let before = fs::read(path.join("genmail.sqlite")).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(before, fs::read(path.join("genmail.sqlite")).unwrap());
    fs::remove_file(path.join("encryption.key")).unwrap();
    assert!(Store::open(&path).is_err());
    assert!(!path.join("encryption.key").exists());
    fs::write(path.join("encryption.key"), original).unwrap();
    let db = rusqlite::Connection::open(path.join("genmail.sqlite")).unwrap();
    db.execute("UPDATE morrow_schema SET version=999", [])
        .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn partial_index_keeps_all_metadata_pages_consistent_during_backfill() {
    use morrow_search::pages;
    let root = std::env::temp_dir().join(format!("morrow-partial-index-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    let owners = vec![
        "a@example.invalid".to_owned(),
        "b@example.invalid".to_owned(),
    ];
    for owner in &owners {
        for i in 0..6 {
            db.upsert(owner, &json!({"id":format!("same-{i}"),"subject":format!("Subject {i}"),"fromName":format!("Sender {i}"),"date":"2026-09-01T00:00:00.000Z","folder":"inbox","read":i%2==0,"starred":i%3==0,"body":"Full body retained"})).unwrap();
        }
    }
    let stats = pages::stats(&db, &owners).unwrap();
    let sorts = ["newest", "oldest", "sender", "subject", "unread", "starred"];
    let expected = sorts.map(|sort| {
        pages::page(&db, &owners, &json!({"sort":sort}), &[0; 32]).unwrap()["messages"].clone()
    });
    for (i, sort) in sorts.iter().enumerate() {
        assert_eq!(
            pages::page(
                &db,
                &owners,
                &json!({"sort":sort,"offset":5,"pageSize":3}),
                &[0; 32]
            )
            .unwrap()["messages"],
            json!(&expected[i].as_array().unwrap()[5..8])
        );
    }
    for offset in [
        json!(-1),
        json!(1.5),
        json!("5"),
        json!(null),
        json!(200001),
    ] {
        assert!(pages::page(&db, &owners, &json!({"offset":offset}), &[0; 32]).is_err());
    }
    db.conn
        .execute(
            "DELETE FROM search_documents WHERE account=? AND id IN ('same-0','same-4')",
            [&owners[0]],
        )
        .unwrap();
    // A crash/corrupt derived table can leave its old completion marker behind.
    drop(db);
    let db = Store::open(&root).unwrap();
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM search_meta", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(pages::stats(&db, &owners).unwrap(), stats);
    for (i, sort) in sorts.iter().enumerate() {
        assert_eq!(
            pages::page(&db, &owners, &json!({"sort":sort}), &[0; 32]).unwrap()["messages"],
            expected[i]
        );
    }
    assert_eq!(db.backfill_batch().unwrap(), 0);
    assert_eq!(pages::stats(&db, &owners).unwrap(), stats);
    db.conn
        .execute_batch("DELETE FROM search_documents; DELETE FROM search_meta;")
        .unwrap();
    assert_eq!(pages::stats(&db, &owners).unwrap(), stats);
    for (i, sort) in sorts.iter().enumerate() {
        assert_eq!(
            pages::page(&db, &owners, &json!({"sort":sort}), &[0; 32]).unwrap()["messages"],
            expected[i]
        );
    }
    db.update(&owners[0], "same-1", &json!({"read":true}))
        .unwrap();
    assert_eq!(pages::stats(&db, &owners).unwrap()[&owners[0]]["unread"], 2);
    assert_eq!(db.backfill_batch().unwrap(), 0);
    assert_eq!(pages::stats(&db, &owners).unwrap()[&owners[0]]["unread"], 2);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn pending_marker_keeps_owner_and_metadata_during_index_recovery() {
    use morrow_search::{pages, search_query};
    let root = std::env::temp_dir().join(format!("morrow-pending-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    let accounts = vec![
        "a@example.invalid".to_owned(),
        "b@example.invalid".to_owned(),
    ];
    let message = json!({"id":"same","folder":"inbox","subject":"Follow up","body":"Private text","date":"2026-09-27T00:00:00Z","pending":true});
    db.upsert(&accounts[0], &message).unwrap();
    db.upsert(
        &accounts[1],
        &json!({"id":"same","folder":"inbox","pending":false}),
    )
    .unwrap();
    for rebuilding in [false, true] {
        if rebuilding {
            db.conn
                .execute_batch("DELETE FROM search_documents; DELETE FROM search_meta;")
                .unwrap();
        }
        let page = pages::page(&db, &accounts, &json!({"folder":"pending"}), &[42; 32]).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["messages"][0]["accountId"], accounts[0]);
        assert_eq!(page["messages"][0]["pending"], true);
        assert!(page["messages"][0].get("body").is_none());
        assert_eq!(
            pages::stats(&db, &accounts).unwrap()[&accounts[0]]["counts"]["pending"],
            1
        );
    }
    while db.index_remaining().unwrap() > 0 {
        db.backfill_batch().unwrap();
    }
    let query = search_query::parse(&json!({"query":"is:pending","scope":"all"})).unwrap();
    assert_eq!(
        search_query::lexical(&db, &query, &accounts, false).unwrap()["total"],
        1
    );
    db.update(&accounts[0], "same", &json!({"folder":"spam"}))
        .unwrap();
    assert_eq!(
        pages::page(&db, &accounts, &json!({"folder":"pending"}), &[42; 32]).unwrap()["total"],
        0
    );
    drop(db);
    fs::remove_dir_all(root).unwrap();
}
