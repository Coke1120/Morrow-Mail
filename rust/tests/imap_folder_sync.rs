use morrow_search::{
    imap_folder_sync as selected,
    service::{App, Context},
    store::{Store, now},
};
use serde_json::{Value, json};

const OWNER: &str = "owner@example.invalid";
const OTHER: &str = "other@example.invalid";

fn connection(owner: &str) -> Value {
    json!({"provider":"imap","email":owner,"connectionId":"fixture-one","imapHost":"imap.example.invalid","imapPort":993,"password":"fictional-unused-password"})
}
fn version(mail: &Value) -> Value {
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
fn config() -> Value {
    let mail = connection(OWNER);
    let folder = |id: &str, kind: &str, selectable: bool, editable: bool| json!({"id":id,"name":id,"kind":kind,"selectable":selectable,"editable":editable,"delimiter":"/"});
    json!({"mailAccounts":{OWNER:mail,OTHER:connection(OTHER)},"preferences":{"syncInterval":5},"mailFolderCatalogs":{OWNER:{"connection":version(&mail),"updatedAt":now(),"folders":[
        folder("Projects","archive",true,true),folder("項目 & stuff","archive",true,true),folder("INBOX","inbox",true,false),folder("Hidden","archive",false,true),folder("Junk","spam",true,false),folder("Junk/Child","archive",true,true),folder("All","virtual",true,false),folder("Protected","archive",true,false),folder("bad\r\nFETCH","archive",true,true)
    ]}}})
}
fn open() -> (std::path::PathBuf, Store) {
    let root =
        std::env::temp_dir().join(format!("morrow-folder-selection-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    db.set_settings(&config()).unwrap();
    (root, db)
}

fn save(db: &Store, owner: &str, input: &Value) -> morrow_search::error::Result<Value> {
    let mut input = input.clone();
    input["connectionVersion"] =
        selected::status(&db.settings()?, owner)["connectionVersion"].clone();
    selected::select(db, owner, &input)
}

#[test]
fn selected_folders_require_current_catalog_generation_and_custom_selectable_identity() {
    let (root, db) = open();
    let initial = selected::status(&db.settings().unwrap(), OWNER);
    assert_eq!(initial["folders"].as_array().unwrap().len(), 2);
    assert_eq!(initial["selectionVersion"], "");
    for paths in [
        json!(["INBOX"]),
        json!(["Hidden"]),
        json!(["Junk/Child"]),
        json!(["Protected"]),
        json!(["Missing"]),
        json!(["bad\r\nFETCH"]),
        json!(["Projects", "Projects"]),
        json!([true]),
        json!(vec!["Projects"; 21]),
    ] {
        assert!(
            save(
                &db,
                OWNER,
                &json!({"folderIds":paths,"selectionVersion":""})
            )
            .is_err()
        );
    }
    let first = save(
        &db,
        OWNER,
        &json!({"folderIds":["Projects"],"selectionVersion":""}),
    )
    .unwrap();
    let id = first["folders"][0]["selectionId"].clone();
    assert_eq!(first["folders"][0]["status"], "queued");
    assert!(save(&db, OWNER, &json!({"folderIds":[],"selectionVersion":""})).is_err());
    assert!(db.settings().unwrap()["imapFolderSync"][OTHER].is_null());
    let saved = save(&db, OWNER, &json!({"folderIds":["Projects","項目 & stuff"],"selectionVersion":first["selectionVersion"]})).unwrap();
    assert_eq!(saved["folders"][0]["selectionId"], id);
    db.set_settings(
        &json!({"mailFolderCatalogs":{OWNER:{"updatedAt":"2000-01-01T00:00:00.000Z"}}}),
    )
    .unwrap();
    assert!(
        save(
            &db,
            OWNER,
            &json!({"folderIds":["Projects"],"selectionVersion":saved["selectionVersion"]})
        )
        .is_err()
    );
    let cancelled = save(
        &db,
        OWNER,
        &json!({"folderIds":[],"selectionVersion":saved["selectionVersion"]}),
    )
    .unwrap();
    assert!(
        cancelled["folders"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["selected"] == false)
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn status_reads_preserve_timestamps_and_redact_private_state_and_provider_errors() {
    let (root, db) = open();
    save(
        &db,
        OWNER,
        &json!({"folderIds":["Projects"],"selectionVersion":""}),
    )
    .unwrap();
    let mut state = db.settings().unwrap()["imapFolderSync"].clone();
    state[OWNER]["folders"][0]["lastSuccessfulSyncAt"] = "2026-01-01T00:00:00.000Z".into();
    state[OWNER]["folders"][0]["lastCaughtUpAt"] = "2026-01-01T00:00:00.000Z".into();
    state[OWNER]["folders"][0]["checkpoint"] = json!({"private":"PRIVATE_CHECKPOINT"});
    state[OWNER]["folders"][0]["errorCode"] = "PRIVATE_PROVIDER_TEXT".into();
    state[OWNER]["folders"][0]["error"] = "PRIVATE_ERROR_TEXT".into();
    db.set_settings(&json!({"imapFolderSync":state})).unwrap();
    let before = db.conn.total_changes();
    let one = selected::status(&db.settings().unwrap(), OWNER);
    let two = selected::status(&db.settings().unwrap(), OWNER);
    assert_eq!(one, two);
    assert_eq!(db.conn.total_changes(), before);
    let encoded = one.to_string();
    for secret in [
        "PRIVATE_",
        "fictional-unused-password",
        "imap.example.invalid",
        "fixture-one",
        "checkpoint",
        "\"origin\"",
    ] {
        assert!(!encoded.contains(secret));
    }
    assert_eq!(
        one["folders"][0]["lastSuccessfulSyncAt"],
        "2026-01-01T00:00:00.000Z"
    );
    assert_eq!(one["folders"][0]["errorCode"], "sync_failed");
    assert_eq!(one["folders"][0]["olderHistoryIncluded"], false);
    drop(db);
    let db = Store::open(&root).unwrap();
    assert_eq!(selected::status(&db.settings().unwrap(), OWNER), one);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reconnect_preserves_same_source_selection_but_changed_server_requires_explicit_save() {
    let (root, db) = open();
    let saved = save(
        &db,
        OWNER,
        &json!({"folderIds":["Projects"],"selectionVersion":""}),
    )
    .unwrap();
    let id = saved["folders"][0]["selectionId"].clone();
    let mut mail = connection(OWNER);
    mail["connectionId"] = "fixture-reconnect".into();
    mail["password"] = "new-fictional-password".into();
    let mut changed = db.settings().unwrap();
    changed["mailAccounts"][OWNER] = mail.clone();
    changed["mailFolderCatalogs"][OWNER]["connection"] = version(&mail);
    changed["mailFolderCatalogs"][OWNER]["updatedAt"] = now().into();
    db.set_settings(&changed).unwrap();
    assert!(selected::select(&db, OWNER, &json!({"folderIds":["Projects"],"selectionVersion":saved["selectionVersion"],"connectionVersion":saved["connectionVersion"]})).is_err(), "A stale client cannot save after reconnect");
    let current = save(
        &db,
        OWNER,
        &json!({"folderIds":["Projects"],"selectionVersion":saved["selectionVersion"]}),
    )
    .unwrap();
    assert_eq!(current["folders"][0]["selectionId"], id);
    mail["imapHost"] = "different.example.invalid".into();
    let mut changed = db.settings().unwrap();
    changed["mailAccounts"][OWNER] = mail.clone();
    changed["mailFolderCatalogs"][OWNER]["connection"] = version(&mail);
    changed["mailFolderCatalogs"][OWNER]["updatedAt"] = now().into();
    db.set_settings(&changed).unwrap();
    let blocked = selected::status(&db.settings().unwrap(), OWNER);
    assert_eq!(blocked["folders"][0]["errorCode"], "connection_changed");
    assert!(
        selected::retry(
            &db,
            OWNER,
            &json!({"selectionId":id,"selectionVersion":current["selectionVersion"]})
        )
        .is_err()
    );
    let replaced = save(
        &db,
        OWNER,
        &json!({"folderIds":["Projects"],"selectionVersion":current["selectionVersion"]}),
    )
    .unwrap();
    assert_ne!(replaced["folders"][0]["selectionId"], id);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

async fn call(
    app: &App,
    method: &str,
    owner: &str,
    mut input: Value,
) -> morrow_search::error::Result<Value> {
    if method == "PUT" {
        input["connectionVersion"] =
            selected::status(&app.settings().await?, owner)["connectionVersion"].clone();
    }
    let mut headers = axum::http::HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    let ctx = Context {
        method: method.parse().unwrap(),
        path: vec!["mail".into(), "folders".into(), "sync".into()],
        body: input,
        query: json!({}),
        headers,
        owner: OTHER.into(),
        paged: true,
    };
    let response = selected::handle(app, &ctx).await?.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
        .await
        .unwrap();
    Ok(serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn selection_routes_require_explicit_owner_and_never_use_the_global_view_or_network() {
    let root = std::env::temp_dir().join(format!("morrow-folder-route-{}", uuid::Uuid::new_v4()));
    let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
    app.db(|db| db.set_settings(&config())).await.unwrap();
    for owner in ["", "all", "unknown@example.invalid"] {
        for method in ["GET", "PUT"] {
            assert!(
                call(
                    &app,
                    method,
                    owner,
                    json!({"selectionVersion":"","folderIds":[]})
                )
                .await
                .is_err()
            );
        }
    }
    let saved = call(
        &app,
        "PUT",
        OWNER,
        json!({"selectionVersion":"","folderIds":["Projects"]}),
    )
    .await
    .unwrap();
    assert_eq!(saved["accountId"], OWNER);
    assert_eq!(saved["folders"][0]["status"], "queued");
    assert!(app.settings().await.unwrap()["imapFolderSync"][OTHER].is_null());
    let before = app.settings().await.unwrap();
    assert_eq!(call(&app, "GET", OWNER, json!({})).await.unwrap(), saved);
    assert_eq!(app.settings().await.unwrap(), before);
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}
