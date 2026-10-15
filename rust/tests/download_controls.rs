//! Synthetic local stores only; these controls must not contact a provider/model.
use axum::{
    body::to_bytes,
    http::{HeaderMap, Method},
};
use morrow_search::{
    attachments, downloads, imap, local_moves, mail,
    service::{App, Context},
    store::{Store, merge},
};
use serde_json::{Value, json};
use std::path::PathBuf;

const A: &str = "downloads-a@example.invalid";
const B: &str = "downloads-b@example.invalid";
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(
            std::env::temp_dir().join(format!("morrow-download-controls-{}", uuid::Uuid::new_v4())),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn configure(db: &Store) {
    db.set_settings(&json!({"activeAccount":A,"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"fixture-a","accessToken":"PRIVATE-TOKEN"},B:{"email":B,"provider":"google","connectionId":"fixture-b"}},"preferences":{"syncInterval":0}})).unwrap();
}
fn message(id: &str) -> Value {
    json!({"id":id,"remoteId":id,"folder":"inbox","date":"2026-10-15T00:00:00Z","subject":"Fictional downloaded record","body":"PRIVATE-BODY 中文 🙂","bodyHtml":"<p>Fictional body</p>","bodyTruncated":false,"read":false,"providerLabelIds":["INBOX"],"providerSnapshot":{"folder":"inbox"}})
}
fn patch(db: &Store, owner: &str, id: &str, body: Value) -> Value {
    let current = db.get(owner, id).unwrap().unwrap();
    let patch = local_moves::patch(db, owner, &current, &body).unwrap();
    db.update(owner, id, &patch).unwrap().unwrap()
}
async fn get(
    app: &App,
    owner: &str,
    path: &[&str],
    page: Option<&str>,
) -> Result<Value, morrow_search::error::Error> {
    let mut headers = HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    let query = page.map(|page| json!({"page":page})).unwrap_or(json!({}));
    let context = Context {
        method: Method::GET,
        path: path.iter().map(|part| (*part).into()).collect(),
        body: json!({}),
        query,
        headers,
        owner: A.into(),
        paged: true,
    };
    let response = downloads::handle(app, &context).await?.unwrap();
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap())
}

#[test]
fn coverage_distinguishes_missing_shortened_and_unindexed_content_and_exact_logical_bytes() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    configure(&db);
    db.upsert(A, &message("google:same")).unwrap();
    db.upsert(B, &message("google:same")).unwrap();
    let mut missing = message("google:missing");
    missing.as_object_mut().unwrap().remove("body");
    db.upsert(A, &missing).unwrap();
    db.upsert(
        A,
        &merge(message("google:short"), &json!({"bodyTruncated":true})),
    )
    .unwrap();
    db.upsert(
        A,
        &merge(
            message("google:deleted"),
            &json!({"contentIncomplete":true,"providerDeleted":true}),
        ),
    )
    .unwrap();
    db.upsert(
        A,
        &merge(
            message("imap:old"),
            &json!({"contentIncomplete":true,"imapOrigin":"unbound"}),
        ),
    )
    .unwrap();
    attachments::save(&db, A, "one.bin", "application/octet-stream", "", &[1; 20]).unwrap();
    attachments::save(
        &db,
        B,
        "other.bin",
        "application/octet-stream",
        "",
        &[2; 40],
    )
    .unwrap();
    db.conn
        .execute(
            "DELETE FROM search_documents WHERE account=? AND id='google:missing'",
            [A],
        )
        .unwrap();
    let before = db.settings().unwrap();
    let status = downloads::snapshot(&db, A).unwrap();
    assert_eq!(status["cachedCount"], 5);
    assert_eq!(status["count"], 4);
    assert_eq!(status["indexPendingCount"], 1);
    assert_eq!(status["incompleteCount"], 3);
    assert_eq!(status["truncatedCount"], 1);
    assert_eq!(status["attachmentBytes"], 20);
    assert_eq!(status["attachmentCount"], 1);
    let expected: u64 = db
        .list(A)
        .unwrap()
        .iter()
        .map(|row| serde_json::to_vec(row).unwrap().len() as u64)
        .sum();
    assert_eq!(status["messageBytes"], expected);
    assert!(!status.to_string().contains("PRIVATE-"));
    assert_eq!(db.settings().unwrap(), before);
    let other = downloads::snapshot(&db, B).unwrap();
    assert_eq!(other["cachedCount"], 1);
    assert_eq!(other["attachmentBytes"], 40);
    let rows = downloads::incomplete(&db, A, 0).unwrap();
    assert_eq!(rows["total"], 4);
    for row in rows["items"].as_array().unwrap() {
        assert_eq!(row["accountId"], A);
        assert!(row.get("body").is_none() && row.get("bodyHtml").is_none());
        if ["google:deleted", "imap:old"].contains(&row["id"].as_str().unwrap()) {
            assert_eq!(row["canRepair"], false);
        }
    }
    db.update(A,"google:missing",&json!({"body":"Recovered body","bodyHtml":"","bodyTruncated":false,"contentIncomplete":false})).unwrap();
    assert_eq!(downloads::snapshot(&db, A).unwrap()["incompleteCount"], 2);
    assert_eq!(downloads::incomplete(&db, A, 0).unwrap()["total"], 3);
}

#[test]
fn repair_eligibility_requires_the_exact_current_imap_origin_without_adopting_old_rows() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    let connection = json!({"email":A,"provider":"imap","connectionId":"original-generation","imapHost":"imap.original.example.invalid","imapPort":993,"password":"PRIVATE-PASSWORD"});
    let origin = imap::server_origin(&connection).unwrap();
    let foreign = imap::server_origin(&merge(
        connection.clone(),
        &json!({"imapHost":"imap.other.example.invalid"}),
    ))
    .unwrap();
    db.set_settings(&json!({"mailAccounts":{A:connection,B:{"email":B,"provider":"imap","imapHost":"imap.original.example.invalid","imapPort":993,"connectionId":"other-owner"}}})).unwrap();
    for (name, marker) in [
        ("current", Some(origin.clone())),
        ("missing", None),
        ("unbound", Some("unbound".into())),
        ("foreign", Some(foreign)),
        ("empty", Some(String::new())),
    ] {
        let mut row = merge(
            message(&format!("imap:{name}")),
            &json!({"contentIncomplete":true}),
        );
        if let Some(marker) = marker {
            row["imapOrigin"] = marker.into();
        }
        db.upsert(A, &row).unwrap();
        db.upsert(B, &row).unwrap();
    }
    db.upsert(
        A,
        &merge(
            message("google:old-provider"),
            &json!({"contentIncomplete":true}),
        ),
    )
    .unwrap();
    let before = db.list(A).unwrap();
    let rows = downloads::incomplete(&db, A, 0).unwrap();
    assert_eq!(rows["total"], 6);
    for row in rows["items"].as_array().unwrap() {
        let current = row["id"] == "imap:current";
        assert_eq!(row["canRepair"], current, "{row}");
        if !current && row["id"] != "google:old-provider" {
            assert_eq!(row["errorCode"], "imap_origin_unverified");
            assert_eq!(row["recoveryAction"], "sync_or_reconnect_original");
        }
    }
    assert_eq!(
        db.list(A).unwrap(),
        before,
        "Read-only eligibility must never adopt or rewrite old rows"
    );
    assert!(
        downloads::incomplete(&db, B, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["canRepair"] == false),
        "An identical UID under another LOGIN is not the same origin"
    );
    let snapshot = downloads::snapshot(&db, A).unwrap();
    assert_eq!(snapshot["connectionRef"], rows["connectionRef"]);
    assert_eq!(
        snapshot["connectionRef"],
        morrow_search::service::safe_mail(&connection)["connectionRef"]
    );
    assert!(!snapshot.to_string().contains("PRIVATE-PASSWORD"));
    assert!(!snapshot.to_string().contains("original-generation"));
    // A password-only reconnect has the same IMAP origin but a new connection fence.
    let reconnected = merge(
        connection.clone(),
        &json!({"connectionId":"reconnected-generation","password":"NEW-PRIVATE-PASSWORD"}),
    );
    assert_eq!(imap::server_origin(&reconnected).unwrap(), origin);
    db.set_settings(&json!({"mailAccounts":{A:reconnected}}))
        .unwrap();
    let reloaded = downloads::incomplete(&db, A, 0).unwrap();
    assert_ne!(reloaded["connectionRef"], snapshot["connectionRef"]);
    assert!(
        reloaded["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "imap:current" && row["canRepair"] == true)
    );
    for patch in [
        json!({"imapHost":"imap.other.example.invalid"}),
        json!({"imapHost":""}),
        json!({"provider":"google"}),
    ] {
        db.set_settings(&json!({"mailAccounts":{A:merge(connection.clone(),&patch)}}))
            .unwrap();
        let changed = downloads::incomplete(&db, A, 0).unwrap();
        for row in changed["items"].as_array().unwrap() {
            let expected = if patch["provider"] == "google" {
                row["id"] == "google:old-provider"
            } else {
                patch["imapHost"] == "imap.other.example.invalid" && row["id"] == "imap:foreign"
            };
            assert_eq!(row["canRepair"], expected, "{patch}: {row}");
        }
    }
}

#[test]
fn a_saved_full_download_still_shortened_by_body_limits_is_not_offered_as_a_new_repair() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    configure(&db);
    db.upsert(
        A,
        &merge(
            message("google:limited"),
            &json!({"bodyTruncated":true,"attachmentsLoaded":true}),
        ),
    )
    .unwrap();
    db.upsert(
        A,
        &merge(
            message("google:retry"),
            &json!({"bodyTruncated":true,"attachmentsLoaded":true,"contentIncomplete":true}),
        ),
    )
    .unwrap();
    let page = downloads::incomplete(&db, A, 0).unwrap();
    assert_eq!(page["total"], 2);
    let rows = page["items"].as_array().unwrap();
    let limited = rows
        .iter()
        .find(|row| row["id"] == "google:limited")
        .unwrap();
    assert_eq!(limited["canRepair"], false);
    assert_eq!(limited["recoveryAction"], "check_original_mailbox");
    assert!(
        limited["reason"]
            .as_str()
            .unwrap()
            .contains("already saved")
    );
    assert_eq!(
        rows.iter().find(|row| row["id"] == "google:retry").unwrap()["canRepair"],
        true
    );
    assert_eq!(downloads::snapshot(&db, A).unwrap()["truncatedCount"], 1);
}

#[tokio::test]
async fn download_get_requires_explicit_connected_owner_and_bounds_every_page() {
    let fixture = Fixture::new();
    let app = App::open(&fixture.0, 0, String::new(), String::new()).unwrap();
    app.db(|db| {
        configure(db);
        for n in 0..65 {
            db.upsert(
                A,
                &merge(
                    message(&format!("google:{n:03}")),
                    &json!({"contentIncomplete":true}),
                ),
            )?;
        }
        db.upsert(
            B,
            &merge(message("google:000"), &json!({"contentIncomplete":true})),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    for owner in ["", "all", "demo", "disconnected@example.invalid"] {
        assert_eq!(
            get(&app, owner, &["downloads"], None)
                .await
                .unwrap_err()
                .status,
            409
        );
    }
    for invalid in ["-1", "1.5", "", "abc", "18446744073709551616", "+1"] {
        assert_eq!(
            get(&app, A, &["downloads", "incomplete"], Some(invalid))
                .await
                .unwrap_err()
                .status,
            400
        );
    }
    let mut identities = std::collections::HashSet::new();
    for page in 0..3 {
        let result = get(
            &app,
            A,
            &["downloads", "incomplete"],
            Some(&page.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(result["page"], page);
        assert_eq!(result["total"], 65);
        assert_eq!(result["pageSize"], 30);
        let rows = result["items"].as_array().unwrap();
        assert!(rows.len() <= 30);
        for row in rows {
            assert_eq!(row["accountId"], A);
            assert!(identities.insert(row["id"].as_str().unwrap().to_owned()));
        }
    }
    assert_eq!(identities.len(), 65);
    assert_eq!(
        get(
            &app,
            A,
            &["downloads", "incomplete"],
            Some("18446744073709551615")
        )
        .await
        .unwrap()["page"],
        2
    );
    let other = get(&app, B, &["downloads", "incomplete"], None)
        .await
        .unwrap();
    assert_eq!(other["total"], 1);
    assert_eq!(other["items"][0]["accountId"], B);
    app.db(|db| {
        db.set_settings(&json!({"mailAccounts":{B:{"email":B}}}))?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        get(&app, A, &["downloads"], None).await.unwrap_err().status,
        409
    );
}

#[test]
fn local_move_undo_survives_restart_is_owned_and_restores_draft_without_provider_work() {
    let fixture = Fixture::new();
    let token;
    {
        let db = Store::open(&fixture.0).unwrap();
        configure(&db);
        let original = merge(
            message("local-draft"),
            &json!({"folder":"drafts","localOverrides":{"read":true},"remoteId":null,"attachments":[{"id":"retained-attachment"}]}),
        );
        db.upsert(A, &original).unwrap();
        db.upsert(B, &original).unwrap();
        let moved = patch(
            &db,
            A,
            "local-draft",
            json!({"folder":"trash","localFolderUndo":{"token":"forged","from":"spam"}}),
        );
        token = moved["localFolderUndo"]["token"].clone();
        assert_ne!(token, "forged");
        assert_eq!(moved["folder"], "trash");
        assert!(
            local_moves::patch(
                &db,
                B,
                &db.get(B, "local-draft").unwrap().unwrap(),
                &json!({"undoLocalMove":token})
            )
            .is_err()
        );
    }
    {
        let db = Store::open(&fixture.0).unwrap();
        let restored = patch(&db, A, "local-draft", json!({"undoLocalMove":token}));
        assert_eq!(restored["folder"], "drafts");
        assert_eq!(restored["attachments"][0]["id"], "retained-attachment");
        assert_eq!(restored["localOverrides"]["read"], true);
        assert!(restored["localOverrides"]["folder"].is_null());
        assert!(restored["localFolderUndo"].is_null());
        assert!(local_moves::patch(&db, A, &restored, &json!({"undoLocalMove":token})).is_err());
        assert_eq!(
            db.get(B, "local-draft").unwrap().unwrap()["folder"],
            "drafts"
        );
    }
}

#[test]
fn local_undo_cannot_overwrite_new_moves_reimports_or_reconnected_mailboxes() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    configure(&db);
    for change in ["move", "away-and-back", "provider", "import", "connection"] {
        db.upsert(A, &message("google:same")).unwrap();
        let moved = patch(&db, A, "google:same", json!({"folder":"archive"}));
        let token = moved["localFolderUndo"]["token"].clone();
        match change {
            "move" => {
                patch(&db, A, "google:same", json!({"folder":"trash"}));
            }
            "away-and-back" => {
                patch(&db, A, "google:same", json!({"folder":"trash"}));
                patch(&db, A, "google:same", json!({"folder":"archive"}));
            }
            "provider" => {
                db.update(
                    A,
                    "google:same",
                    &json!({"folder":"sent","providerFolderId":"Sent"}),
                )
                .unwrap();
            }
            "import" => {
                let connection = db.settings().unwrap()["mailAccounts"][A].clone();
                mail::import_messages(&db, &connection, &[message("google:same")]).unwrap();
            }
            "connection" => {
                db.set_settings(&json!({"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"new"},B:{"email":B}}})).unwrap();
            }
            _ => unreachable!(),
        }
        let current = db.get(A, "google:same").unwrap().unwrap();
        assert!(
            local_moves::patch(&db, A, &current, &json!({"undoLocalMove":token})).is_err(),
            "{change}"
        );
        assert_eq!(db.get(A, "google:same").unwrap().unwrap(), current);
    }
}

#[test]
fn undo_only_reverts_last_local_folder_change_and_preserves_previous_override() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    configure(&db);
    let original = merge(
        message("google:override"),
        &json!({"folder":"archive","localOverrides":{"folder":true,"labels":true},"pending":true}),
    );
    db.upsert(A, &original).unwrap();
    let moved = patch(&db, A, "google:override", json!({"folder":"trash"}));
    let token = moved["localFolderUndo"]["token"].clone();
    assert!(
        local_moves::patch(
            &db,
            A,
            &moved,
            &json!({"undoLocalMove":token,"folder":"sent"})
        )
        .is_err()
    );
    db.update(
        A,
        "google:override",
        &json!({"read":true,"starred":true,"body":"Newly downloaded body"}),
    )
    .unwrap();
    patch(&db, A, "google:override", json!({"pending":false}));
    let restored = patch(&db, A, "google:override", json!({"undoLocalMove":token}));
    assert_eq!(restored["folder"], "archive");
    assert_eq!(restored["pending"], false);
    assert_eq!(restored["read"], true);
    assert_eq!(restored["starred"], true);
    assert_eq!(restored["body"], "Newly downloaded body");
    assert_eq!(restored["localOverrides"], original["localOverrides"]);
}
