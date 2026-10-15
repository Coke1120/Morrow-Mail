use morrow_search::{error::Result, folders, imap, store::Store};
use serde_json::{Value, json};

const OWNER: &str = "folder-origin@example.invalid";
struct Workspace(std::path::PathBuf);
impl Workspace {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-folder-origin-{}", uuid::Uuid::new_v4())))
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
    json!({"email":OWNER,"provider":"imap","imapHost":host,"imapPort":993,"connectionId":generation,"password":"fictional-not-used"})
}
fn changes() -> Vec<Value> {
    vec![
        json!({"oldId":"Projects","newId":"Renamed","newName":"Renamed","uidValidity":55}),
        json!({"oldId":"Projects","newId":"","newName":""}),
    ]
}
fn message(id: &str, origin: Value) -> Value {
    json!({"id":id,"remoteId":"imap:55:7","imapOrigin":origin,"providerFolderId":"Projects","providerFolderName":"Projects","body":"retained cached body","folder":"archive","pending":true})
}
fn job(generation: Value) -> Value {
    json!({"id":"saved-history","connectionId":generation,"status":"paused","pages":5,"folderIndex":0,"cursor":{"version":1,"index":0,"folders":[{"path":"Projects","kind":"archive"}],"next":{"path":"Projects","validity":55,"uid":8}}})
}
fn apply(db: &Store, mail: &Value, change: &Value) -> Result<()> {
    folders::update_cache(
        db,
        mail["email"].as_str().unwrap(),
        mail,
        std::slice::from_ref(change),
        &[],
    )
}

#[test]
fn folder_changes_leave_foreign_and_unproven_cache_untouched() {
    for change in changes() {
        let workspace = Workspace::new();
        let db = workspace.open();
        let old = connection("old.example.invalid", "old");
        let current = connection("current.example.invalid", "current");
        let foreign = message("foreign", imap::server_origin(&old).unwrap().into());
        let unbound = message("unbound", "unbound".into());
        let mut missing = message("missing", Value::Null);
        missing.as_object_mut().unwrap().remove("imapOrigin");
        let live = message("live", imap::server_origin(&current).unwrap().into());
        for row in [&foreign, &unbound, &missing, &live] {
            db.upsert(OWNER, row).unwrap();
        }
        db.upsert("other@example.invalid", &live).unwrap();
        db.set_settings(&json!({"mailAccounts":{OWNER:current}}))
            .unwrap();
        apply(&db, &current, &change).unwrap();
        for row in [foreign, unbound, missing] {
            assert_eq!(
                db.get(OWNER, row["id"].as_str().unwrap()).unwrap().unwrap(),
                row
            );
        }
        assert_eq!(
            db.get("other@example.invalid", "live").unwrap().unwrap(),
            live
        );
        let changed = db.get(OWNER, "live").unwrap().unwrap();
        assert_eq!(changed["body"], live["body"]);
        assert_eq!(changed["folder"], "archive");
        assert_eq!(changed["pending"], true);
        if change["newName"] == "" {
            assert_eq!(changed["providerFolderMissing"], true);
        } else {
            assert_eq!(changed["providerFolderId"], "Renamed");
        }
    }
}

#[test]
fn folder_changes_leave_foreign_or_unversioned_history_untouched() {
    for change in changes() {
        for generation in [json!("old"), Value::Null, json!("")] {
            let workspace = Workspace::new();
            let db = workspace.open();
            let current = connection("current.example.invalid", "current");
            let retained = job(generation);
            db.set_settings(&json!({"mailAccounts":{OWNER:current},"imports":{OWNER:retained}}))
                .unwrap();
            apply(&db, &current, &change).unwrap();
            assert_eq!(db.settings().unwrap()["imports"][OWNER], retained);
        }
    }
}

#[test]
fn folder_changes_keep_current_history_progress_and_pause_semantics() {
    for change in changes() {
        let workspace = Workspace::new();
        let db = workspace.open();
        let current = connection("current.example.invalid", "current");
        db.set_settings(
            &json!({"mailAccounts":{OWNER:current},"imports":{OWNER:job(json!("current"))}}),
        )
        .unwrap();
        apply(&db, &current, &change).unwrap();
        let saved = db.settings().unwrap()["imports"][OWNER].clone();
        assert_eq!(saved["pages"], 5);
        if change["newName"] == "" {
            assert_eq!(saved["status"], "complete");
            assert!(saved["cursor"].is_null());
        } else {
            assert_eq!(saved["status"], "paused");
            assert_eq!(saved["cursor"]["next"]["path"], "Renamed");
        }
    }
}

#[test]
fn folder_changes_reject_a_replaced_captured_connection_before_local_writes() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let old = connection("old.example.invalid", "old");
    let current = connection("current.example.invalid", "current");
    let retained = message("old", imap::server_origin(&old).unwrap().into());
    db.upsert(OWNER, &retained).unwrap();
    db.set_settings(
        &json!({"mailAccounts":{OWNER:current},"imports":{OWNER:job(json!("current"))}}),
    )
    .unwrap();
    let before = db.settings().unwrap();
    let writes = db.conn.total_changes();
    for change in changes() {
        assert_eq!(apply(&db, &old, &change).unwrap_err().status, 409);
    }
    assert_eq!(db.settings().unwrap(), before);
    assert_eq!(db.get(OWNER, "old").unwrap().unwrap(), retained);
    assert_eq!(db.conn.total_changes(), writes);
}
