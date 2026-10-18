use morrow_search::{error::Error, pages, search_query, store::Store};
use rusqlite::StatementStatus;
use serde_json::{Value, json};
use std::fs;

const A: &str = "a@example.invalid";
const B: &str = "b@example.invalid";

fn assert_folder(db: &Store, owner: &str, folder: &str, expected: &[&str]) {
    let page = pages::page(
        db,
        &[owner.into()],
        &json!({"folder":format!("provider:{folder}")}),
        &[7; 32],
    )
    .unwrap();
    assert_eq!(page["total"], expected.len());
    let mut ids = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            assert_eq!(message["accountId"], owner);
            assert!(message.get("body").is_none());
            message["id"].as_str().unwrap()
        })
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, expected);
}

#[test]
fn provider_memberships_follow_owned_writes_rollback_and_deletion() {
    let root = std::env::temp_dir().join(format!("morrow-memberships-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    db.upsert(A, &json!({"id":"same","folder":"inbox","providerFolderId":"Finance","providerLabelIds":["Finance","Finance","Other"],"body":"Downloaded mail"})).unwrap();
    db.upsert(B, &json!({"id":"same","folder":"archive","providerFolderId":"Finance","providerLabelIds":["Finance"],"body":"Other owner's mail"})).unwrap();
    db.upsert(A, &json!({"id":"outlook","folder":"archive","providerFolderId":"Finance","body":"Folder mail"})).unwrap();
    db.upsert(
        A,
        &json!({"id":"local","folder":"inbox","labels":["Finance"]}),
    )
    .unwrap();
    assert_folder(&db, A, "Finance", &["outlook", "same"]);
    assert_folder(&db, B, "Finance", &["same"]);
    assert_folder(&db, A, "Other", &["same"]);
    let query = search_query::parse(&json!({"folder":"provider:Finance"})).unwrap();
    assert_eq!(
        search_query::lexical(&db, &query, &[A.into()], false).unwrap()["total"],
        2
    );
    assert!(search_query::lexical(&db, &query, &[A.into(), B.into()], false).is_err());
    assert!(
        pages::page(
            &db,
            &[A.into(), B.into()],
            &json!({"folder":"provider:Finance"}),
            &[7; 32]
        )
        .is_err()
    );

    // Local folder/read markers do not change the provider's membership.
    db.update(
        A,
        "outlook",
        &json!({"folder":"trash","read":true,"pending":true}),
    )
    .unwrap();
    assert_folder(&db, A, "Finance", &["outlook", "same"]);
    let failed: Result<(), Error> = db.transaction(|db| {
        db.update(
            A,
            "same",
            &json!({"providerFolderId":"Rolled back","providerLabelIds":[]}),
        )?;
        db.delete(B, "same")?;
        Err(Error::conflict("Fixture rollback"))
    });
    assert!(failed.is_err());
    assert_folder(&db, A, "Finance", &["outlook", "same"]);
    assert_folder(&db, B, "Finance", &["same"]);
    assert_folder(&db, A, "Rolled back", &[]);

    // Imports and provider moves use this same upsert path, replacing old membership.
    db.upsert(A, &json!({"id":"same","folder":"archive","providerFolderId":"Moved","providerLabelIds":["Moved","新標籤"]})).unwrap();
    assert_folder(&db, A, "Finance", &["outlook"]);
    assert_folder(&db, A, "Other", &[]);
    assert_folder(&db, A, "Moved", &["same"]);
    assert_folder(&db, A, "新標籤", &["same"]);
    assert_folder(&db, B, "Finance", &["same"]);
    db.delete(A, "same").unwrap();
    assert_folder(&db, A, "Moved", &[]);
    assert_folder(&db, B, "Finance", &["same"]);
    // A later row must not inherit memberships left by a deleted rowid.
    db.upsert(A, &json!({"id":"replacement","folder":"inbox"}))
        .unwrap();
    assert_folder(&db, A, "新標籤", &[]);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_memberships_backfill_without_changing_mail_and_survive_search_recovery() {
    let root = std::env::temp_dir().join(format!(
        "morrow-membership-migration-{}",
        uuid::Uuid::new_v4()
    ));
    let path = root.join("data");
    let backup = root.join("backup");
    let db = Store::open(&path).unwrap();
    for (id, location, labels) in [
        (
            "same",
            json!("Finance"),
            json!(["Finance", "Finance", "Case", "case", 1, null]),
        ),
        ("numeric", json!(1), json!([1, true, {"nested":"Finance"}])),
        ("scalar", Value::Null, json!("Finance")),
        ("missing", Value::Null, Value::Null),
    ] {
        db.upsert(A, &json!({"id":id,"folder":"inbox","providerFolderId":location,"providerLabelIds":labels,"body":"Preserved cached body"})).unwrap();
    }
    db.upsert(B, &json!({"id":"same","providerFolderId":"Finance"}))
        .unwrap();
    let before = db.list(A).unwrap();
    let settings = db.settings().unwrap();
    // Simulate a pre-upgrade store and an independently incomplete keyword index.
    db.conn.execute_batch("DROP TRIGGER mail_provider_insert; DROP TRIGGER mail_provider_update; DROP TRIGGER mail_provider_delete; DROP TABLE mail_provider_memberships; DELETE FROM search_documents; DELETE FROM search_meta;").unwrap();
    drop(db);
    let key = fs::read(path.join("encryption.key")).unwrap();
    let db = Store::open(&path).unwrap();
    assert_eq!(db.list(A).unwrap(), before);
    assert_eq!(db.settings().unwrap(), settings);
    assert_eq!(fs::read(path.join("encryption.key")).unwrap(), key);
    assert!(db.index_remaining().unwrap() > 0);
    assert_folder(&db, A, "Finance", &["same", "scalar"]);
    assert_folder(&db, B, "Finance", &["same"]);
    assert_folder(&db, A, "Case", &["same"]);
    assert_folder(&db, A, "case", &["same"]);
    assert_folder(&db, A, "1", &[]);
    // Match the previous JSON predicate for legacy scalar/null/non-text values.
    for folder in ["Finance", "Case", "case", "1", "missing"] {
        let old: i64 = db.conn.query_row("SELECT count(*) FROM messages WHERE account=? AND (json_extract(data,'$.providerFolderId')=? OR EXISTS(SELECT 1 FROM json_each(data,'$.providerLabelIds') WHERE value=?))", [A, folder, folder], |row| row.get(0)).unwrap();
        let new: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM mail_provider_memberships WHERE account=? AND folder_id=?",
                [A, folder],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new, old);
    }
    while db.index_remaining().unwrap() > 0 {
        db.backfill_batch().unwrap();
    }
    assert_folder(&db, A, "Finance", &["same", "scalar"]);
    db.update(
        A,
        "same",
        &json!({"providerFolderId":"New folder","providerLabelIds":[]}),
    )
    .unwrap();
    assert_folder(&db, A, "Finance", &["scalar"]);
    db.backup(&backup).unwrap();
    drop(db);
    for workspace in [&path, &backup] {
        let db = Store::open(workspace).unwrap();
        assert_folder(&db, A, "Finance", &["scalar"]);
        assert_folder(&db, A, "New folder", &["same"]);
        assert_folder(&db, B, "Finance", &["same"]);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_pages_keep_sorts_cursors_and_indexed_account_lookup() {
    let root =
        std::env::temp_dir().join(format!("morrow-membership-pages-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    db.transaction(|db| {
        for i in 0..120 {
            for owner in [A, B] {
                let labels = if owner == B || i % 3 == 0 { json!(["Target", "Target"]) } else { json!(["Other"]) };
                db.upsert(owner, &json!({"id":format!("same-{i:03}"),"date":format!("2026-10-01T00:{:02}:{:02}Z",i/60,i%60),"fromName":format!("Sender {i}"),"subject":format!("Subject {}",120-i),"folder":"inbox","read":i%2==0,"starred":i%4==0,"providerLabelIds":labels,"body":"Downloaded body"}))?;
            }
        }
        Ok(())
    }).unwrap();
    for sort in ["newest", "oldest", "sender", "subject", "unread", "starred"] {
        let options = json!({"folder":"provider:Target","sort":sort,"pageSize":100});
        let expected = pages::page(&db, &[A.into()], &options, &[7; 32]).unwrap();
        assert_eq!(expected["total"], 40);
        let mut cursor = String::new();
        let mut actual = Vec::new();
        loop {
            let page = pages::page(
                &db,
                &[A.into()],
                &json!({"folder":"provider:Target","sort":sort,"pageSize":7,"cursor":cursor}),
                &[7; 32],
            )
            .unwrap();
            assert_eq!(page["total"], 40);
            actual.extend(page["messages"].as_array().unwrap().iter().cloned());
            cursor = page["nextCursor"].as_str().unwrap().into();
            if cursor.is_empty() {
                break;
            }
        }
        assert_eq!(json!(actual), expected["messages"]);
        assert_eq!(
            pages::page(
                &db,
                &[A.into()],
                &json!({"folder":"provider:Target","sort":sort,"pageSize":7,"offset":14}),
                &[7; 32]
            )
            .unwrap()["messages"],
            json!(&actual[14..21])
        );
    }
    assert_eq!(
        pages::page(
            &db,
            &[A.into()],
            &json!({"folder":"provider:Target","unreadOnly":true}),
            &[7; 32]
        )
        .unwrap()["total"],
        20
    );
    let query =
        search_query::parse(&json!({"folder":"provider:Target","query":"Downloaded"})).unwrap();
    assert_eq!(
        search_query::lexical(&db, &query, &[A.into()], false).unwrap()["total"],
        40
    );
    assert_eq!(
        search_query::lexical(&db, &query, &[B.into()], false).unwrap()["total"],
        120
    );
    let mut statement = db.conn.prepare(pages::PROVIDER_FOLDER_ROWS).unwrap();
    let ids = statement
        .query_map([A, "Target"], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(ids.len(), 40);
    assert_eq!(
        statement.get_status(StatementStatus::FullscanStep),
        0,
        "provider membership lookup must use its account/folder index"
    );
    drop(statement);
    drop(db);
    fs::remove_dir_all(root).unwrap();
}
