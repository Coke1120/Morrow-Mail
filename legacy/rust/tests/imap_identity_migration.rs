use morrow_search::store::Store;
use serde_json::{Value, json};

const OWNER: &str = "identity@example.invalid";

struct Workspace(std::path::PathBuf);
impl Workspace {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-imap-origin-{}", uuid::Uuid::new_v4())))
    }
    fn open(&self) -> Store {
        Store::open(&self.0).unwrap()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn connection(host: &str, generation: &str) -> Value {
    json!({"email":OWNER,"provider":"imap","imapHost":host,"imapPort":993,"smtpHost":"smtp.example.invalid","smtpPort":465,"connectionId":generation,"password":"fictional-not-used"})
}
fn provenance(mail: &Value) -> Value {
    json!([
        mail["connectionId"],
        mail["authorizationId"],
        mail["provider"],
        mail["email"],
        mail["clientId"],
        mail["imapHost"],
        mail["imapPort"]
    ])
}
fn message(mail: &Value, body: &str) -> Value {
    json!({"id":"imap:55:1","remoteId":"imap:55:1","providerFolderId":"INBOX","folder":"inbox","date":"2026-10-01T00:00:00.000Z","subject":"same UID and Message-ID","messageId":"<same@example.invalid>","body":body,"bodyHtml":"","bodyTruncated":false,"read":false,"starred":false,"labels":[],"bodyConnection":provenance(mail),"bodySize":123})
}

#[test]
fn origin_uses_actual_login_and_endpoint_without_credentials_or_smtp() {
    use morrow_search::imap::server_origin;
    let base = connection("IMAP.Example.Invalid.", "one");
    let origin = server_origin(&base).unwrap();
    let mut same = connection("imap.example.invalid", "two");
    same.as_object_mut().unwrap().remove("imapPort");
    same["password"] = "rotated-secret".into();
    same["smtpHost"] = "new-smtp.example.invalid".into();
    assert_eq!(server_origin(&same).unwrap(), origin);
    assert!(!origin.contains("secret"));
    for patch in [
        json!({"imapPort":1993}),
        json!({"imapHost":"other.example.invalid"}),
        json!({"email":"Identity@example.invalid"}),
    ] {
        assert_ne!(
            server_origin(&morrow_search::store::merge(base.clone(), &patch)).unwrap(),
            origin
        );
    }
    for patch in [
        json!({"imapPort":0}),
        json!({"imapHost":"https://imap.example.invalid"}),
    ] {
        assert!(server_origin(&morrow_search::store::merge(base.clone(), &patch)).is_err());
    }
}

#[test]
fn folder_catalog_reconnect_requires_proven_same_origin() {
    let original = connection("IMAP.Example.Invalid.", "one");
    let mut current = connection("imap.example.invalid", "two");
    current.as_object_mut().unwrap().remove("imapPort");
    let mut config = json!({"mailAccounts":{OWNER:current},"mailFolderCatalogs":{OWNER:{"provider":"imap","connection":provenance(&original),"folders":[{"id":"projects","name":"Projects","hidden":true,"selectable":true}]}}});
    let retained = morrow_search::folders::cached_catalogs(&config);
    assert_eq!(retained[OWNER]["stale"], true);
    assert_eq!(retained[OWNER]["managementFolders"][0]["hidden"], true);
    config["mailAccounts"][OWNER]["imapHost"] = "another.example.invalid".into();
    let changed = morrow_search::folders::cached_catalogs(&config);
    assert_eq!(changed[OWNER]["managementFolders"], json!([]));
    config["mailFolderCatalogs"][OWNER]["connection"] = Value::Null;
    config["mailAccounts"][OWNER]["imapHost"] = Value::Null;
    let unproven = morrow_search::folders::cached_catalogs(&config);
    assert_eq!(unproven[OWNER]["managementFolders"], json!([]));
}

#[test]
fn starting_unversioned_imap_import_requires_reconnect_without_replacing_progress() {
    use morrow_search::background as jobs;
    let workspace = Workspace::new();
    let db = workspace.open();
    let saved = json!({"id":"old-job","status":"paused","cursor":{"uid":42},"pages":5,"connectionId":"old"});
    for generation in [Value::Null, json!(""), json!("   ")] {
        let mut mail = connection("fixture.example.invalid", "old");
        mail["connectionId"] = generation;
        for job in [Value::Null, saved.clone()] {
            db.set_settings(&json!({"mailAccounts":{OWNER:mail},"imports":{OWNER:job}}))
                .unwrap();
            let before = db.settings().unwrap();
            let changes = db.conn.total_changes();
            let error =
                jobs::start_import(&db, OWNER, &json!({"months":0,"inbox":true})).unwrap_err();
            assert_eq!(error.status, 409);
            assert_eq!(error.body["code"], "imap_connection_unverified");
            assert_eq!(error.body["recoveryAction"], "reconnect");
            assert_eq!(db.settings().unwrap(), before);
            assert_eq!(
                db.conn.total_changes(),
                changes,
                "no job or checkpoint writes"
            );
        }
    }
    for provider in ["google", "microsoft"] {
        db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER,"provider":provider}},"imports":{OWNER:null}})).unwrap();
        jobs::start_import(&db, OWNER, &json!({"months":0,"inbox":true})).unwrap();
        assert_eq!(
            db.settings().unwrap()["imports"][OWNER]["status"],
            "running"
        );
    }
}

#[test]
fn migration_retains_references_and_checkpoints_but_never_infers_unknown_or_conflicting_sources() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let old = connection("old.example.invalid", "old");
    let current = connection("current.example.invalid", "current");
    let mut known = message(&old, "known body");
    known["pending"] = true.into();
    db.upsert(OWNER, &known).unwrap();
    let mut conflict = known.clone();
    conflict["id"] = "imap:55:2".into();
    conflict["remoteId"] = "imap:55:2".into();
    conflict["imapSyncConnection"] = provenance(&current);
    db.upsert(OWNER, &conflict).unwrap();
    let mut unknown = known.clone();
    unknown["id"] = "imap:55:3".into();
    unknown["remoteId"] = "imap:55:3".into();
    unknown.as_object_mut().unwrap().remove("bodyConnection");
    db.upsert(OWNER, &unknown).unwrap();
    let mut unproven = vec!["imap:55:2".to_owned(), "imap:55:3".to_owned()];
    for (index, malformed) in [json!(7), json!(true), json!({}), json!([])]
        .into_iter()
        .enumerate()
    {
        let id = format!("imap:55:{}", index + 4);
        let mut row = known.clone();
        row["id"] = id.clone().into();
        row["remoteId"] = id.clone().into();
        row["bodyConnection"][2] = malformed;
        db.upsert(OWNER, &row).unwrap();
        unproven.push(id);
    }
    let draft = json!({"id":"local-draft","folder":"drafts","replyToId":"imap:55:1","body":"private draft"});
    db.upsert(OWNER, &draft).unwrap();
    let settings = json!({"mailAccounts":{OWNER:current},"imports":{OWNER:{"connectionId":"old","cursor":{"uid":40},"status":"paused"}},"imapSync":{OWNER:{"folders":{"INBOX":{"uid":99,"connection":provenance(&old)}}}},"deliveryAttempts":[{"account":OWNER,"requestId":"uncertain","draftId":"local-draft"}]});
    db.set_settings(&settings).unwrap();
    let settings = db.settings().unwrap();
    drop(db);
    let db = workspace.open();
    assert_eq!(db.settings().unwrap(), settings);
    assert_eq!(db.get(OWNER, "local-draft").unwrap().unwrap(), draft);
    let migrated = db.get(OWNER, "imap:55:1").unwrap().unwrap();
    assert_eq!(
        migrated["imapOrigin"],
        morrow_search::imap::server_origin(&old).unwrap()
    );
    assert_ne!(
        migrated["imapOrigin"],
        morrow_search::imap::server_origin(&current).unwrap()
    );
    let mut expected = known;
    expected["imapOrigin"] = migrated["imapOrigin"].clone();
    assert_eq!(migrated, expected);
    for id in unproven {
        assert_eq!(
            db.get(OWNER, &id).unwrap().unwrap()["imapOrigin"],
            "unbound"
        );
    }
    let rows = db.list(OWNER).unwrap();
    drop(db);
    let db = workspace.open();
    assert_eq!(
        db.list(OWNER).unwrap(),
        rows,
        "migration must be idempotent"
    );
}

#[test]
fn migration_failure_rolls_back_all_origin_markers_and_preserves_cache() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let mail = connection("same.example.invalid", "one");
    let first = message(&mail, "first");
    let mut second = first.clone();
    second["id"] = "imap:55:2".into();
    second["remoteId"] = "imap:55:2".into();
    db.upsert(OWNER, &first).unwrap();
    db.upsert(OWNER, &second).unwrap();
    db.conn
        .execute("UPDATE morrow_schema SET version=1", [])
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER reject_origin_migration BEFORE UPDATE ON messages WHEN new.id='imap:55:2' BEGIN SELECT RAISE(ABORT,'synthetic migration interruption'); END;").unwrap();
    drop(db);
    assert!(Store::open(&workspace.0).is_err());
    let conn = rusqlite::Connection::open(workspace.0.join("genmail.sqlite")).unwrap();
    let marked: u32 = conn
        .query_row(
            "SELECT count(*) FROM messages WHERE json_extract(data,'$.imapOrigin') IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marked, 0, "partial origin migration must roll back");
    let version: i64 = conn
        .query_row("SELECT version FROM morrow_schema", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        version, 1,
        "the schema fence must roll back with message migration"
    );
    conn.execute_batch("DROP TRIGGER reject_origin_migration")
        .unwrap();
    drop(conn);
    let db = workspace.open();
    let versions: Vec<i64> = db
        .conn
        .prepare("SELECT version FROM morrow_schema")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(versions, [2]);
    assert_eq!(
        db.get(OWNER, "imap:55:1").unwrap().unwrap()["body"],
        first["body"]
    );
    assert_eq!(
        db.get(OWNER, "imap:55:2").unwrap().unwrap()["body"],
        second["body"]
    );
}

#[test]
fn schema_rejects_future_empty_or_multiple_markers_without_migrating() {
    for sql in [
        "UPDATE morrow_schema SET version=999",
        "DELETE FROM morrow_schema",
        "INSERT INTO morrow_schema VALUES(1)",
        "UPDATE morrow_schema SET version=1; INSERT INTO morrow_schema VALUES(999)",
        "DROP TABLE morrow_schema; CREATE TABLE morrow_schema(version TEXT); INSERT INTO morrow_schema VALUES('invalid')",
    ] {
        let workspace = Workspace::new();
        let db = workspace.open();
        db.conn.execute_batch(sql).unwrap();
        drop(db);
        let before = std::fs::read(workspace.0.join("genmail.sqlite")).unwrap();
        assert!(Store::open(&workspace.0).is_err());
        assert_eq!(
            std::fs::read(workspace.0.join("genmail.sqlite")).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn other_or_unknown_origin_blocks_reads_flags_moves_and_reconciliation_before_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut live = connection("127.0.0.1", "live");
    live["imapPort"] = listener.local_addr().unwrap().port().into();
    let old = message(&connection("old.example.invalid", "old"), "old cache");
    let mut unknown = old.clone();
    unknown.as_object_mut().unwrap().remove("bodyConnection");
    let connector = native_tls::TlsConnector::new().unwrap();
    for row in [old, unknown] {
        let mut errors = vec![
            morrow_search::imap::raw_message_with_tls(&live, &row, &connector)
                .await
                .unwrap_err(),
            morrow_search::imap::write_flags_with_tls(
                &live,
                &row,
                &json!({"read":true}),
                &connector,
            )
            .await
            .unwrap_err(),
            morrow_search::imap::organize_with_tls(
                &live,
                &row,
                &json!({"id":"Archive"}),
                "move",
                &connector,
            )
            .await
            .unwrap_err(),
            morrow_search::imap::reconcile_with_tls(&live, std::slice::from_ref(&row), &connector)
                .await
                .unwrap_err(),
            morrow_search::imap::reconcile_priority_with_tls(&live, &[row], &connector)
                .await
                .unwrap_err(),
        ];
        for error in errors.drain(..) {
            assert_eq!(error.status, 409);
            assert_eq!(error.body["code"], "imap_origin_unverified");
            assert_eq!(error.body["recoveryAction"], "sync_or_reconnect_original");
        }
    }
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
