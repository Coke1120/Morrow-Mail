use base64::{Engine, engine::general_purpose::STANDARD};
use morrow_search::{attachments, content, drafts, mail, providers, scheduled, store::Store};
use serde_json::json;

#[test]
fn attachments_are_immutable_owned_reviewed_and_survive_restart_and_backup() {
    let root = std::env::temp_dir().join(format!("morrow-attachments-{}", uuid::Uuid::new_v4()));
    let backup = root.with_extension("backup");
    let db = Store::open(&root).unwrap();
    let owner = "a@example.invalid";
    db.set_settings(&json!({"mailAccounts":{owner:{"email":owner,"provider":"google","connectionId":"a"},"b@example.invalid":{"email":"b@example.invalid","provider":"google","connectionId":"b"}}})).unwrap();
    let bytes = b"fictional attachment\x00\xff";
    let item = attachments::save(
        &db,
        owner,
        "../../invoice\r\n.pdf",
        "application/pdf",
        "",
        bytes,
    )
    .unwrap();
    assert!(
        !item["name"]
            .as_str()
            .unwrap()
            .contains(['/', '\\', '\r', '\n'])
    );
    assert_eq!(
        attachments::save(
            &db,
            owner,
            "../../invoice\r\n.pdf",
            "application/pdf",
            "",
            bytes
        )
        .unwrap(),
        item
    );
    let mut message=content::content(&json!({"to":"b@example.invalid","bcc":"hidden@example.invalid","subject":"Fixture","body":"","attachments":[item]}),false).unwrap();
    attachments::resolve(&db, owner, &mut message, false).unwrap();
    assert!(attachments::resolve(&db, "b@example.invalid", &mut message.clone(), true).is_err());
    let fingerprint = mail::fingerprint(&message).unwrap();
    assert_ne!(fingerprint,mail::fingerprint(&json!({"to":"b@example.invalid","bcc":"hidden@example.invalid","subject":"Fixture","body":""})).unwrap());
    let metadata = message.clone();
    attachments::resolve(&db, owner, &mut message, true).unwrap();
    assert_eq!(mail::fingerprint(&message).unwrap(), fingerprint);
    let (mime, _) = providers::compose(&json!({"email":owner}), &message, false).unwrap();
    let formatted = mime.formatted();
    assert!(!String::from_utf8_lossy(&formatted).contains("Bcc:"));
    assert!(
        mime.envelope()
            .to()
            .iter()
            .any(|a| a.to_string() == "hidden@example.invalid")
    );
    let parsed = mail_parser::MessageParser::default()
        .parse(&formatted)
        .unwrap();
    assert_eq!(parsed.attachments().next().unwrap().contents(), bytes);
    db.transaction(|db| {
        assert_eq!(
            attachments::import(db, owner, &formatted)?
                .as_array()
                .unwrap()
                .len(),
            1
        );
        Ok(())
    })
    .unwrap();
    let mut saved = metadata.clone();
    saved["id"] = "source".into();
    saved["folder"] = "inbox".into();
    db.upsert(owner, &saved).unwrap();
    let forward = drafts::prepare(&db, owner, &json!({"messageId":"source","mode":"forward"}))
        .unwrap()["draft"]
        .clone();
    assert_eq!(forward["attachments"], metadata["attachments"]);
    assert!(forward["replyToId"].is_null());
    assert_eq!(forward["to"], "");
    let mut input = metadata.clone();
    input["requestId"] = "attachment-schedule".into();
    input["sendAt"] = (chrono::Utc::now() + chrono::Duration::hours(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .into();
    let job = scheduled::start(&db, owner, &input).unwrap();
    assert_eq!(
        job["job"]["payload"]["attachments"],
        metadata["attachments"]
    );
    let extra = attachments::save(&db, owner, "second.txt", "text/plain", "", b"changed").unwrap();
    input["attachments"] = json!([extra]);
    assert!(scheduled::start(&db, owner, &input).is_err());
    db.backup(&backup).unwrap();
    drop(db);
    for path in [&root, &backup] {
        let db = Store::open(path).unwrap();
        let mut restored = metadata.clone();
        attachments::resolve(&db, owner, &mut restored, true).unwrap();
        assert_eq!(
            STANDARD
                .decode(restored["attachments"][0]["data"].as_str().unwrap())
                .unwrap(),
            bytes
        );
        assert_eq!(mail::fingerprint(&restored).unwrap(), fingerprint);
        drop(db);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[test]
fn attachment_inputs_and_tampered_bytes_fail_closed() {
    let root = std::env::temp_dir().join(format!("morrow-attachments-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    for bad in [
        json!({"attachments":true}),
        json!({"attachments":[{"id":"../../secret"}]}),
        json!({"attachments":[{"id":"a".repeat(64)},{"id":"a".repeat(64)}]}),
    ] {
        assert!(attachments::references(&bad).is_err());
    }
    let item = attachments::save(&db, "owner", "CON.txt", "text/html;evil", "", b"safe").unwrap();
    assert_eq!(item["name"], "_CON.txt");
    assert_eq!(item["contentType"], "application/octet-stream");
    db.conn
        .execute("UPDATE mail_attachments SET bytes=?", [b"evil".as_slice()])
        .unwrap();
    assert!(attachments::resolve(&db, "owner", &mut json!({"attachments":[item]}), true).is_err());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
