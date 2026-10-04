use morrow_search::{
    folders::{plan, update_cache},
    store::Store,
};
use serde_json::json;

#[test]
fn creating_a_folder_does_not_read_message_content() {
    use rusqlite::ffi;
    use std::ffi::{CStr, c_char, c_void};
    unsafe extern "C" fn deny_message_reads(
        _: *mut c_void,
        action: i32,
        table: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
    ) -> i32 {
        if action == ffi::SQLITE_READ
            && !table.is_null()
            && unsafe { CStr::from_ptr(table) }.to_bytes() == b"messages"
        {
            ffi::SQLITE_DENY
        } else {
            ffi::SQLITE_OK
        }
    }
    let root = std::env::temp_dir().join(format!("morrow-empty-folder-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    db.upsert(
        "a",
        &json!({"id":"cached","body":"Unrelated downloaded mail","providerLabelIds":["old"]}),
    )
    .unwrap();
    let before = db.get("a", "cached").unwrap();
    db.set_settings(&json!({"imports":{"a":{"status":"paused","cursor":{"folders":[{"path":"INBOX"}],"index":0}}}})).unwrap();
    // Enforce the operation's DB budget, independent of mailbox size or timing.
    // The callback has no borrowed state and lives for the entire registration.
    unsafe {
        assert_eq!(
            ffi::sqlite3_set_authorizer(
                db.conn.handle(),
                Some(deny_message_reads),
                std::ptr::null_mut()
            ),
            ffi::SQLITE_OK
        );
    }
    let result = update_cache(
        &db,
        "a",
        "google",
        &[],
        &[json!({"id":"new","name":"New","kind":"label"})],
    );
    unsafe {
        assert_eq!(
            ffi::sqlite3_set_authorizer(db.conn.handle(), None, std::ptr::null_mut()),
            ffi::SQLITE_OK
        );
    }
    result.unwrap();
    assert_eq!(db.get("a", "cached").unwrap(), before);
    assert_eq!(db.settings().unwrap()["imports"]["a"]["status"], "paused");
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn hierarchy_validation_and_owned_cache_reconciliation() {
    let catalog = vec![
        json!({"id":"INBOX","name":"Inbox","kind":"inbox","editable":false,"delimiter":"/"}),
        json!({"id":"p","name":"Projects","leafName":"Projects","parentId":"","editable":true,"delimiter":"/","kind":"label"}),
        json!({"id":"c","name":"Projects/中文","leafName":"中文","parentId":"p","editable":true,"delimiter":"/","kind":"label"}),
        json!({"id":"d","name":"Done","leafName":"Done","parentId":"","editable":true,"delimiter":"/","kind":"label"}),
    ];
    for input in [
        json!({"operation":"delete","id":"INBOX"}),
        json!({"operation":"move","id":"p","parentId":"c"}),
        json!({"operation":"create","name":"done"}),
        json!({"operation":"create","name":"a/b"}),
        json!({"operation":"create","name":"INBOX"}),
        json!({"operation":"create","name":"injection\r\n"}),
        json!({"operation":"create","name":"x","parentId":{}}),
    ] {
        assert!(plan("google", &catalog, &input).is_err(), "{input}");
    }
    let moved = plan(
        "google",
        &catalog,
        &json!({"operation":"move","id":"p","parentId":"d"}),
    )
    .unwrap();
    assert_eq!(moved["affectedCount"], 2);
    assert_eq!(moved["changes"][1]["newName"], "Done/Projects/中文");
    assert_eq!(
        plan("google", &catalog, &json!({"operation":"delete","id":"p"})).unwrap()["affectedCount"],
        1
    );
    let mut many = catalog.clone();
    many.extend((0..50).map(|i|json!({"id":format!("child{i}"),"name":format!("Projects/{i}"),"leafName":i.to_string(),"parentId":"p","editable":true,"delimiter":"/"})));
    assert!(
        plan(
            "google",
            &many,
            &json!({"operation":"rename","id":"p","name":"Large"})
        )
        .is_err()
    );
    let graph = catalog
        .iter()
        .map(|f| {
            let mut v = f.clone();
            v["delimiter"] = " / ".into();
            if v["id"] == "c" {
                v["name"] = "Projects / 中文".into();
            }
            v
        })
        .collect::<Vec<_>>();
    assert_eq!(
        plan("microsoft", &graph, &json!({"operation":"delete","id":"p"})).unwrap()["affectedCount"],
        2
    );
    let mut protected = graph.clone();
    protected[2]["editable"] = false.into();
    assert!(
        plan(
            "microsoft",
            &protected,
            &json!({"operation":"delete","id":"p"})
        )
        .is_err()
    );
    let mut flat = catalog.clone();
    flat[1]["delimiter"] = "".into();
    assert!(
        plan(
            "imap",
            &flat,
            &json!({"operation":"move","id":"p","parentId":"d"})
        )
        .is_err()
    );
    let implicit = vec![
        json!({"id":"Implicit/Child","name":"Implicit/Child","leafName":"Child","parentId":"Implicit","delimiter":"/","editable":true}),
    ];
    let namespaces = vec![
        json!({"id":"INBOX","kind":"inbox","name":"INBOX","delimiter":"/","editable":false}),
        json!({"id":"Shared","name":"Shared","delimiter":".","editable":true}),
    ];
    assert_eq!(
        plan(
            "imap",
            &namespaces,
            &json!({"operation":"create","name":"Child","parentId":"Shared"})
        )
        .unwrap()["name"],
        "Shared.Child"
    );
    assert_eq!(
        plan(
            "imap",
            &implicit,
            &json!({"operation":"rename","id":"Implicit/Child","name":"Renamed"})
        )
        .unwrap()["name"],
        "Implicit/Renamed"
    );

    let root = std::env::temp_dir().join(format!("morrow-folders-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    for account in ["a", "b"] {
        db.upsert(account,&json!({"id":"same","providerLabelIds":["p","c"],"labels":["Projects","Projects/中文"],"pending":true,"providerSnapshot":{"read":false,"labels":["Projects","Projects/中文"]}})).unwrap();
        db.upsert(account,&json!({"id":"local","providerLabelIds":["p"],"labels":["My local name"],"localOverrides":{"labels":true}})).unwrap();
    }
    let deltas = vec![json!({"oldId":"p","newName":"Renamed","newId":"p"})];
    let mut renamed = catalog.clone();
    renamed[1]["name"] = "Renamed".into();
    update_cache(&db, "a", "google", &deltas, &renamed).unwrap();
    assert_eq!(
        db.get("a", "same").unwrap().unwrap()["labels"],
        json!(["Renamed", "Projects/中文"])
    );
    assert_eq!(
        db.get("a", "local").unwrap().unwrap()["labels"],
        json!(["My local name"])
    );
    assert_eq!(
        db.get("b", "same").unwrap().unwrap()["labels"],
        json!(["Projects", "Projects/中文"])
    );
    assert!(db.get("a", "same").unwrap().unwrap()["pending"] == true);
    for account in ["a", "b"] {
        db.upsert(account,&json!({"id":"imap:55:7","remoteId":"imap:55:7","providerFolderId":"Old","pending":true,"folder":"archive"})).unwrap();
    }
    db.set_settings(&json!({"imports":{"a":{"status":"paused","pages":5,"folderIndex":0,"cursor":{"version":1,"index":1,"folders":[{"path":"INBOX","kind":"inbox"},{"path":"Old","kind":"archive"},{"path":"Other","kind":"archive"}],"next":{"path":"Old","validity":55,"uid":8}}},"b":{"status":"paused","cursor":{"untouched":true}}}})).unwrap();
    update_cache(
        &db,
        "a",
        "imap",
        &[json!({"oldId":"Old","newName":"New","newId":"New","uidValidity":55})],
        &[],
    )
    .unwrap();
    assert_eq!(
        db.get("a", "imap:55:7").unwrap().unwrap()["providerFolderId"],
        "New"
    );
    assert_eq!(
        db.get("b", "imap:55:7").unwrap().unwrap()["providerFolderId"],
        "Old"
    );
    assert_eq!(
        db.settings().unwrap()["imports"]["a"]["cursor"]["next"]["path"],
        "New"
    );
    update_cache(
        &db,
        "a",
        "imap",
        &[json!({"oldId":"New","newName":"","newId":""})],
        &[],
    )
    .unwrap();
    let saved = db.settings().unwrap();
    let job = &saved["imports"]["a"];
    assert_eq!(job["status"], "paused");
    assert_eq!(job["pages"], 5);
    assert_eq!(job["cursor"]["index"], 1);
    assert_eq!(job["cursor"]["folders"][1]["path"], "Other");
    assert!(job["cursor"]["next"].is_null());
    assert_eq!(saved["imports"]["b"]["cursor"], json!({"untouched":true}));
    assert_eq!(
        db.get("a", "imap:55:7").unwrap().unwrap()["providerFolderMissing"],
        true
    );
    assert_eq!(db.get("a", "imap:55:7").unwrap().unwrap()["pending"], true);
    update_cache(
        &db,
        "b",
        "imap",
        &[json!({"oldId":"Old","newName":"New","newId":"New","uidValidity":66})],
        &[],
    )
    .unwrap();
    assert_eq!(
        db.get("b", "imap:55:7").unwrap().unwrap()["providerFolderMissing"],
        true
    );
    assert_eq!(
        db.get("b", "imap:55:7").unwrap().unwrap()["providerFolderId"],
        "Old"
    );
    update_cache(
        &db,
        "a",
        "imap",
        &[json!({"oldId":"Other","newName":"","newId":""})],
        &[],
    )
    .unwrap();
    assert_eq!(db.settings().unwrap()["imports"]["a"]["status"], "complete");
    assert!(db.settings().unwrap()["imports"]["a"]["cursor"].is_null());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
