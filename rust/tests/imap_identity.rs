use morrow_search::{background as jobs, mail, service, store::Store};
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
fn another_server_cannot_inherit_history_completeness_or_resume_an_unproven_cursor() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let first = connection("first.example.invalid", "one");
    let job = json!({"id":"old-job","connectionId":"one","status":"complete","options":{"allMail":true},"since":"2020-01-01","before":"2026-10-01","cursor":{"uid":42},"pages":12,"processed":600,"imported":600});
    db.set_settings(&json!({"mailAccounts":{OWNER:first},"imports":{OWNER:job}}))
        .unwrap();
    assert_eq!(
        jobs::import_status(&db, OWNER).unwrap()["status"],
        "complete"
    );
    let second = connection("second.example.invalid", "two");
    service::save_connection(&db, &second, true).unwrap();
    let status = jobs::import_status(&db, OWNER).unwrap();
    assert_eq!(status["status"], "paused");
    assert_eq!(status["errorCode"], "connection_changed");
    assert_eq!(status["recoveryAction"], "restart");
    assert_eq!(status["coverage"]["folders"], json!([]));
    assert!(status["processed"].is_null());
    assert!(status["nextRetryAt"].is_null());
    assert_eq!(db.settings().unwrap()["imports"][OWNER], job);

    // Missing generations on both sides are not a proof that an old cursor
    // belongs to the currently configured IMAP server.
    let mut legacy_mail = second.clone();
    legacy_mail.as_object_mut().unwrap().remove("connectionId");
    let mut legacy_job = job.clone();
    legacy_job.as_object_mut().unwrap().remove("connectionId");
    legacy_job["status"] = "paused".into();
    db.set_settings(&json!({"mailAccounts":{OWNER:legacy_mail},"imports":{OWNER:legacy_job}}))
        .unwrap();
    assert!(jobs::control_import(&db, OWNER, "resume").is_err());
    assert_eq!(db.settings().unwrap()["imports"][OWNER], legacy_job);
    legacy_job["status"] = "running".into();
    db.set_settings(&json!({"imports":{OWNER:legacy_job}}))
        .unwrap();
    jobs::apply_import_page(
        &db,
        OWNER,
        &legacy_job,
        &json!({"messages":[],"nextCursor":null}),
    )
    .unwrap();
    assert_eq!(db.settings().unwrap()["imports"][OWNER], legacy_job);
}

#[test]
fn reconnect_to_another_server_retains_old_cache_without_inheriting_local_state() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let first = connection("first.example.invalid", "one");
    db.set_settings(&json!({"mailAccounts":{OWNER:first}}))
        .unwrap();
    mail::import_messages(&db, &first, &[message(&first, "first server body")]).unwrap();
    db.update(OWNER, "imap:55:1", &json!({"folder":"archive","pending":true,"starred":true,"labels":["private local label"],"attachmentsLoaded":true,"attachments":[{"id":"retained-local-attachment"}]})).unwrap();
    let retained = db.get(OWNER, "imap:55:1").unwrap().unwrap();
    let second = connection("second.example.invalid", "two");
    service::save_connection(&db, &second, true).unwrap();
    let added =
        mail::import_messages(&db, &second, &[message(&second, "second server body")]).unwrap();
    assert_eq!(
        added.len(),
        1,
        "a different server must create a separate cached message"
    );
    assert_ne!(added[0], "imap:55:1");
    assert_eq!(db.get(OWNER, "imap:55:1").unwrap().unwrap(), retained);
    let fresh = db.get(OWNER, &added[0]).unwrap().unwrap();
    assert_eq!(fresh["body"], "second server body");
    assert_eq!(fresh["folder"], "inbox");
    assert_eq!(fresh["starred"], false);
    assert_ne!(fresh["pending"], true);
    assert_ne!(fresh["attachmentsLoaded"], true);
    assert_eq!(fresh["labels"], json!([]));
    assert!(
        mail::import_messages(&db, &second, &[message(&second, "second server body")])
            .unwrap()
            .is_empty()
    );
    assert_eq!(db.list(OWNER).unwrap().len(), 2);

    service::save_connection(&db, &first, true).unwrap();
    assert!(
        mail::import_messages(&db, &first, &[message(&first, "first server body")])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.get(OWNER, "imap:55:1").unwrap().unwrap()["pending"],
        true
    );
    assert_eq!(db.list(OWNER).unwrap().len(), 2);
}

#[test]
fn unproven_legacy_cache_is_never_adopted_by_a_new_connection() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let first = connection("new.example.invalid", "new");
    let mut legacy = message(&first, "retained unknown origin");
    legacy.as_object_mut().unwrap().remove("bodyConnection");
    legacy["pending"] = true.into();
    db.upsert(OWNER, &legacy).unwrap();
    service::save_connection(&db, &first, true).unwrap();
    let added = mail::import_messages(&db, &first, &[message(&first, "known new origin")]).unwrap();
    assert_eq!(
        added.len(),
        1,
        "a missing source proof must not be inferred from the current account"
    );
    assert_ne!(added[0], "imap:55:1");
    let retained = db.get(OWNER, "imap:55:1").unwrap().unwrap();
    assert_eq!(retained["body"], "retained unknown origin");
    assert_eq!(retained["pending"], true);
    assert_eq!(db.list(OWNER).unwrap().len(), 2);
}

#[test]
fn same_server_reconnect_keeps_legacy_identity_and_user_data() {
    let workspace = Workspace::new();
    let db = workspace.open();
    let first = connection("IMAP.Example.Invalid", "old");
    let mut legacy = message(&first, "legacy same server");
    legacy["pending"] = true.into();
    legacy["folder"] = "archive".into();
    db.upsert(OWNER, &legacy).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:first}}))
        .unwrap();
    drop(db);
    let db = workspace.open();
    let same = connection("imap.example.invalid", "new");
    service::save_connection(&db, &same, true).unwrap();
    assert!(
        mail::import_messages(&db, &same, &[message(&same, "refreshed body")])
            .unwrap()
            .is_empty()
    );
    let refreshed = db.get(OWNER, "imap:55:1").unwrap().unwrap();
    assert_eq!(refreshed["body"], "refreshed body");
    assert_eq!(refreshed["pending"], true);
    assert_eq!(refreshed["folder"], "archive");
    assert_eq!(db.list(OWNER).unwrap().len(), 1);
}
