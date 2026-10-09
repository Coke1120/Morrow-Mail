use morrow_search::{mail, pages, providers, store::Store};
use serde_json::json;

#[test]
fn provider_text_limits_report_truncation_at_the_actual_boundary() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    for length in [99999, 100000, 100001] {
        let body = "文".repeat(length);
        let mime = providers::mime(
            format!("Content-Type: text/plain; charset=utf-8\r\n\r\n{body}").as_bytes(),
        )
        .unwrap();
        let google = providers::normalize_google(&json!({"id":"long","payload":{"mimeType":"text/plain","body":{"data":URL_SAFE_NO_PAD.encode(body.as_bytes())}}})).unwrap();
        let microsoft = providers::normalize_microsoft(
            &json!({"id":"long","body":{"contentType":"text","content":body}}),
        )
        .unwrap();
        for message in [mime, google, microsoft] {
            assert_eq!(
                message["body"].as_str().unwrap().chars().count(),
                length.min(100000)
            );
            assert_eq!(message["bodyTruncated"], length > 100000);
        }
    }
    // Each individual MIME part is below the cap, but their combined text is not.
    let part = URL_SAFE_NO_PAD.encode("x".repeat(60000));
    let google = providers::normalize_google(&json!({"id":"parts","payload":{"parts":[{"mimeType":"text/plain","body":{"data":part}},{"mimeType":"text/plain","body":{"data":part}}]}})).unwrap();
    assert_eq!(google["bodyTruncated"], true);
}

#[test]
fn reconnect_uses_cached_account_casing_and_rejects_ambiguous_legacy_accounts() {
    use morrow_search::service::{reconnect_address, save_connection};
    let directory = std::env::temp_dir().join(format!("morrow-reconnect-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    let owner = "Leo@example.com";
    let other = "other@example.com";
    save_connection(&db, &json!({"email":owner,"provider":"imap"}), true).unwrap();
    save_connection(&db, &json!({"email":other,"provider":"imap"}), true).unwrap();
    for account in [owner, other] {
        db.upsert(
            account,
            &json!({"id":"same","folder":"drafts","body":account}),
        )
        .unwrap();
    }
    // Disconnect retains both owners' rows, while removing only the target connection.
    db.set_settings(
        &json!({"mailAccounts":{other:{"email":other,"provider":"imap"}},"mail":{"email":other}}),
    )
    .unwrap();
    drop(db);
    let db = Store::open(&directory).unwrap();
    let canonical = reconnect_address(&db, "leo@EXAMPLE.com").unwrap();
    assert_eq!(canonical, owner);
    save_connection(&db, &json!({"email":canonical,"provider":"imap"}), true).unwrap();
    assert_eq!(db.get(&canonical, "same").unwrap().unwrap()["body"], owner);
    assert_eq!(db.get(other, "same").unwrap().unwrap()["body"], other);
    assert_eq!(
        db.settings().unwrap()["mailAccounts"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reconnect_address(&db, "new@example.com").unwrap(),
        "new@example.com"
    );
    db.upsert(
        "leo@example.com",
        &json!({"id":"same","body":"Conflicting legacy data"}),
    )
    .unwrap();
    assert_eq!(
        reconnect_address(&db, "leo@example.com")
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        db.get("leo@example.com", "same").unwrap().unwrap()["body"],
        "Conflicting legacy data"
    );
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn remote_read_changes_replace_stale_flags_without_losing_local_edits_or_owners() {
    let directory = std::env::temp_dir().join(format!("morrow-read-sync-{}", uuid::Uuid::new_v4()));
    let mut db = Store::open(&directory).unwrap();
    let owner = "a@example.invalid";
    let other = "b@example.invalid";
    for provider in ["microsoft", "imap", "google"] {
        for initial in [false, true] {
            let id = format!("{provider}:{initial}");
            let connection = json!({"email":owner,"provider":provider});
            let mut message = json!({"id":id,"folder":"inbox","providerFolderId":"INBOX","body":"Downloaded body","read":initial,"starred":false,"labels":[]});
            if provider == "google" {
                message["providerLabelIds"] = if initial {
                    json!(["INBOX"])
                } else {
                    json!(["INBOX", "UNREAD"])
                };
            }
            for account in [owner, other] {
                mail::import_messages(
                    &db,
                    &json!({"email":account,"provider":provider}),
                    std::slice::from_ref(&message),
                )
                .unwrap();
            }
            let untouched = db.get(other, &id).unwrap().unwrap();
            let mut remote = message.clone();
            remote["read"] = (!initial).into();
            if provider == "google" {
                remote["providerLabelIds"] = if initial {
                    json!(["INBOX", "UNREAD"])
                } else {
                    json!(["INBOX"])
                };
            }
            mail::import_messages(&db, &connection, std::slice::from_ref(&remote)).unwrap();
            assert_eq!(
                db.get(owner, &id).unwrap().unwrap()["read"],
                !initial,
                "{provider}: remote change"
            );
            mail::import_messages(&db, &connection, std::slice::from_ref(&message)).unwrap();
            assert_eq!(db.get(owner, &id).unwrap().unwrap()["read"], initial);

            db.update(
                owner,
                &id,
                &json!({"read":!initial,"starred":true,"pending":true,"lowPriority":true}),
            )
            .unwrap();
            mail::import_messages(&db, &connection, std::slice::from_ref(&message)).unwrap();
            assert_eq!(
                db.get(owner, &id).unwrap().unwrap()["read"],
                if provider == "microsoft" {
                    initial
                } else {
                    !initial
                },
                "{provider}: Outlook is authoritative; other providers retain local edits"
            );
            let mut partial = message.clone();
            partial.as_object_mut().unwrap().remove("read");
            mail::import_messages(&db, &connection, &[partial]).unwrap();
            let saved = db.get(owner, &id).unwrap().unwrap();
            assert_eq!(
                saved["read"],
                if provider == "microsoft" {
                    initial
                } else {
                    !initial
                }
            );
            assert_eq!(saved["providerSnapshot"]["read"], initial);

            drop(db);
            db = Store::open(&directory).unwrap();
            mail::import_messages(&db, &connection, std::slice::from_ref(&message)).unwrap();
            assert_eq!(
                db.get(owner, &id).unwrap().unwrap()["read"],
                if provider == "microsoft" {
                    initial
                } else {
                    !initial
                }
            );
            // Once the server catches up, its next change must not be hidden by an old override.
            mail::import_messages(&db, &connection, &[remote]).unwrap();
            mail::import_messages(&db, &connection, std::slice::from_ref(&message)).unwrap();
            let saved = db.get(owner, &id).unwrap().unwrap();
            assert_eq!(
                saved["read"], initial,
                "{provider}: obsolete override released"
            );
            for key in ["starred", "pending", "lowPriority"] {
                assert_eq!(
                    saved[key],
                    !(provider == "microsoft" && key == "starred"),
                    "{provider}: retain {key}"
                );
            }
            assert_eq!(db.get(other, &id).unwrap().unwrap(), untouched);

            // Old caches without a read snapshot adopt the fetched server value on first refresh.
            let legacy_id = format!("{provider}:legacy-{initial}");
            message["id"] = legacy_id.clone().into();
            db.upsert(owner, &message).unwrap();
            message["read"] = (!initial).into();
            if provider == "google" {
                message["providerLabelIds"] = if initial {
                    json!(["INBOX", "UNREAD"])
                } else {
                    json!(["INBOX"])
                };
            }
            mail::import_messages(&db, &connection, &[message]).unwrap();
            assert_eq!(
                db.get(owner, &legacy_id).unwrap().unwrap()["read"],
                !initial,
                "{provider}: legacy cache"
            );
        }
    }
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reimport_updates_provider_membership_without_losing_local_changes_or_other_owners() {
    let directory =
        std::env::temp_dir().join(format!("morrow-import-folders-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    let owner = "a@example.invalid";
    let other = "b@example.invalid";
    let message = json!({"id":"microsoft:same","folder":"inbox","body":"Downloaded body","providerFolderId":"old-folder","providerFolderName":"Old folder","read":false,"starred":false,"labels":[]});
    for account in [owner, other] {
        mail::import_messages(
            &db,
            &json!({"email":account,"provider":"microsoft"}),
            std::slice::from_ref(&message),
        )
        .unwrap();
    }
    let untouched = db.get(other, "microsoft:same").unwrap().unwrap();
    db.update(owner, "microsoft:same", &json!({"folder":"trash","read":true,"starred":true,"pending":true,"lowPriority":true,"labels":["Local label"]})).unwrap();
    let mut moved = message.clone();
    moved["providerFolderId"] = "new-folder".into();
    moved["providerFolderName"] = "New folder".into();
    moved["body"] = "Refreshed body".into();
    assert!(
        mail::import_messages(
            &db,
            &json!({"email":owner,"provider":"microsoft"}),
            &[moved]
        )
        .unwrap()
        .is_empty()
    );
    let saved = db.get(owner, "microsoft:same").unwrap().unwrap();
    assert_eq!(saved["providerFolderId"], "new-folder");
    assert_eq!(saved["providerFolderName"], "New folder");
    assert_eq!(saved["folder"], "trash");
    assert_eq!(saved["body"], "Refreshed body");
    for key in ["read", "starred", "pending", "lowPriority"] {
        assert_eq!(saved[key], !["read", "starred"].contains(&key), "{key}");
    }
    assert_eq!(saved["labels"], json!(["Local label"]));
    assert_eq!(db.get(other, "microsoft:same").unwrap().unwrap(), untouched);
    for (account, folder, total) in [
        (owner, "old-folder", 0),
        (owner, "new-folder", 1),
        (other, "old-folder", 1),
        (other, "new-folder", 0),
    ] {
        let page = pages::page(
            &db,
            &[account.into()],
            &json!({"folder":format!("provider:{folder}")}),
            &[7; 32],
        )
        .unwrap();
        assert_eq!(page["total"], total, "{account}: {folder}");
    }
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn imports_keep_owner_local_identity_and_delivery_fingerprint() {
    let directory =
        std::env::temp_dir().join(format!("morrow-import-test-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    let mail = json!({"email":"a@example.test","provider":"microsoft"});
    let other = json!({"email":"b@example.test","provider":"microsoft"});
    let message = json!({"id":"microsoft:same","folder":"inbox","body":"original","read":false,"starred":false,"labels":[]});
    assert_eq!(
        mail::import_messages(&db, &mail, std::slice::from_ref(&message)).unwrap(),
        vec!["microsoft:same"]
    );
    mail::import_messages(&db, &other, std::slice::from_ref(&message)).unwrap();
    db.update("a@example.test","microsoft:same",&json!({"folder":"archive","read":true,"starred":true,"remoteId":"microsoft:moved","providerFolderId":"destination"})).unwrap();
    let moved = json!({"id":"microsoft:moved","folder":"inbox","read":false,"starred":false,"labels":[],"body":"refreshed"});
    assert!(
        mail::import_messages(&db, &mail, &[moved])
            .unwrap()
            .is_empty()
    );
    let saved = db.get("a@example.test", "microsoft:same").unwrap().unwrap();
    assert_eq!(saved["body"], "refreshed");
    assert_eq!(saved["folder"], "archive");
    assert_eq!(saved["read"], false);
    assert!(
        db.get("a@example.test", "microsoft:moved")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        db.get("b@example.test", "microsoft:same").unwrap().unwrap()["read"],
        false
    );
    let sent = json!({"id":"sent:request-123","folder":"sent","to":"to@example.test","cc":"","bcc":"hidden@example.test","subject":"Saved","body":"Reviewed text","messageId":"<same@example.test>","read":true});
    let fingerprint = mail::fingerprint(&sent).unwrap();
    db.upsert("a@example.test", &sent).unwrap();
    let remote = json!({"id":"microsoft:provider-sent","folder":"sent","fromEmail":"a@example.test","messageId":"<same@example.test>","to":"provider text","body":"provider transform"});
    assert!(
        mail::import_messages(&db, &mail, &[remote])
            .unwrap()
            .is_empty()
    );
    let saved = db
        .get("a@example.test", "sent:request-123")
        .unwrap()
        .unwrap();
    assert_eq!(mail::fingerprint(&saved).unwrap(), fingerprint);
    assert_eq!(saved["remoteId"], "microsoft:provider-sent");
    db.update(
        "a@example.test",
        "sent:request-123",
        &json!({"providerFolderId":"sent-folder","providerFolderName":"Sent"}),
    )
    .unwrap();
    let moved_sent = json!({"id":"microsoft:provider-sent","folder":"archive","body":"Provider representation","providerFolderId":"project-folder","providerFolderName":"Project"});
    mail::import_messages(&db, &mail, &[moved_sent]).unwrap();
    let saved = db
        .get("a@example.test", "sent:request-123")
        .unwrap()
        .unwrap();
    assert_eq!(mail::fingerprint(&saved).unwrap(), fingerprint);
    assert_eq!(saved["providerFolderId"], "project-folder");
    assert_eq!(saved["providerFolderName"], "Project");
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn mime_delivery_preserves_bcc_in_provider_api_and_hides_it_from_smtp_headers() {
    let mail = json!({"email":"sender@example.test"});
    let value = json!({"to":"visible@example.test","cc":"copy@example.test","bcc":"hidden@example.test","subject":"中文 subject","body":"正文","fromName":"寄件人","replyMessageId":"<original@example.test>","footer":{"text":"Signature","html":""}});
    let (smtp, _) = providers::compose(&mail, &value, false).unwrap();
    let smtp_raw = smtp.formatted();
    let smtp_text = String::from_utf8_lossy(&smtp_raw);
    assert!(!smtp_text.to_ascii_lowercase().contains("bcc:"));
    assert!(!smtp_text.contains("hidden@example.test"));
    assert_eq!(smtp.envelope().to().len(), 3);
    let (api, id) = providers::compose(&mail, &value, true).unwrap();
    let bytes = api.formatted();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(raw.contains("Bcc: hidden@example.test"));
    assert!(raw.contains("In-Reply-To: <original@example.test>"));
    let parsed = providers::mime(&bytes).unwrap();
    assert_eq!(parsed["subject"], "中文 subject");
    assert_eq!(parsed["bcc"], "hidden@example.test");
    assert_eq!(parsed["messageId"], id);
    assert!(
        parsed["body"]
            .as_str()
            .unwrap()
            .contains("正文\n\nSignature")
    );
}
#[test]
fn oauth_pkce_and_cursor_boundaries() {
    let google = providers::oauth_start(
        "google",
        &json!({"clientId":"fixture","clientSecret":"public-installed-secret"}),
        "http://localhost:12345/api/oauth/google/callback",
        "mail",
    )
    .unwrap();
    let url = url::Url::parse(google["url"].as_str().unwrap()).unwrap();
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(query["scope"].contains("gmail.modify"));
    assert!(!query["scope"].contains("calendar"));
    assert!(!query.values().any(|v| v == "public-installed-secret"));
    let calendar = providers::oauth_start(
        "google",
        &json!({"clientId":"fixture"}),
        "http://localhost:12345/api/calendar-oauth/google/callback",
        "calendar",
    )
    .unwrap();
    assert!(!calendar["url"].as_str().unwrap().contains("gmail"));
    assert_ne!(calendar["state"], google["state"]);
    let original =
        url::Url::parse("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages").unwrap();
    assert!(
        providers::validated_next(
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50",
            &original
        )
        .is_ok()
    );
    for path in [
        "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
        "https://evil.example/v1.0/me/mailFolders/inbox/messages",
        "https://user@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages",
    ] {
        assert!(providers::validated_next(path, &original).is_err());
    }
    for folder in ["inbox", "sentitems"] {
        let original = url::Url::parse(&format!(
            "https://graph.microsoft.com/v1.0/me/mailFolders/{folder}/messages"
        ))
        .unwrap();
        let query = "$top=50&$skip=50&$orderby=receivedDateTime%20desc&$filter=receivedDateTime%20ge%202026-06-24T00:00:00Z&$select=id,body";
        for path in [
            original.path().to_owned(),
            format!("/v1.0/me/mailFolders('{folder}')/messages"),
        ] {
            let cursor = format!("https://graph.microsoft.com{path}?{query}");
            let parsed = providers::validated_mail_next(&cursor, &original).unwrap();
            assert_eq!(parsed.as_str(), cursor);
            assert_eq!(parsed.query(), Some(query));
            if path != original.path() {
                assert!(providers::validated_next(&cursor, &original).is_err());
            }
        }
    }
    for cursor in [
        "https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages?$folder=inbox",
        "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/extra",
        "https://graph.microsoft.com/v1.0/me/mailFolders('%69nbox')/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders('opaque-id')/messages",
        "http://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages",
        "https://evil.example/v1.0/me/mailFolders('inbox')/messages",
        "https://graph.microsoft.com:444/v1.0/me/mailFolders('inbox')/messages",
        "https://user:secret@graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages#fragment",
    ] {
        assert!(
            providers::validated_mail_next(cursor, &original).is_err(),
            "{cursor}"
        );
    }
    assert!(
        providers::validated_mail_next(
            &format!("{}?$skip={}", original, "x".repeat(8192)),
            &original
        )
        .is_err()
    );
}

#[test]
fn out_of_office_scope_is_explicit_and_preserves_organize_and_calendar() {
    for (provider, scope) in [
        (
            "google",
            "https://www.googleapis.com/auth/gmail.settings.basic",
        ),
        ("microsoft", "MailboxSettings.ReadWrite"),
    ] {
        for organize in [false, true] {
            let base = providers::oauth_start(
                provider,
                &json!({"clientId":"fixture","organize":organize}),
                "http://localhost/callback",
                "mail",
            )
            .unwrap();
            let url = url::Url::parse(base["url"].as_str().unwrap()).unwrap();
            let query = url
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            assert!(query["scope"].contains(if provider == "google" {
                "https://www.googleapis.com/auth/gmail.modify"
            } else {
                "Mail.ReadWrite"
            }));
            if provider == "microsoft" {
                assert!(query["scope"].contains("Mail.Send"));
            }
            let opted = providers::oauth_start(
                provider,
                &json!({"clientId":"fixture","organize":organize,"outOfOffice":true}),
                "http://localhost/callback",
                "mail",
            )
            .unwrap();
            assert_eq!(
                opted["config"]["mailScope"],
                format!("{} {scope}", base["config"]["mailScope"].as_str().unwrap())
            );
            let calendar = providers::oauth_start(
                provider,
                &json!({"clientId":"fixture","organize":organize,"outOfOffice":true}),
                "http://localhost/callback",
                "calendar",
            )
            .unwrap();
            assert!(
                !calendar["url"]
                    .as_str()
                    .unwrap()
                    .contains("MailboxSettings")
            );
            assert!(!calendar["url"].as_str().unwrap().contains("settings.basic"));
        }
    }
}
