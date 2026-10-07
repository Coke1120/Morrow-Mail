use morrow_search::{drafts, service::App, store::Store};
use serde_json::{Value, json};

const OWNER: &str = "Owner@example.com";
const OTHER: &str = "other@example.com";

#[test]
fn replies_use_provider_reply_to_and_truncated_forwards_disclose_missing_text() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use morrow_search::providers;
    let directory = std::env::temp_dir().join(format!("morrow-reply-to-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER}}}))
        .unwrap();
    let raw = format!(
        "From: notify@example.com\r\nReply-To: Support <support@example.com>, {OWNER}\r\nTo: {OWNER}, team@example.com\r\nCc: support@example.com, cc@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMessage"
    );
    let google = json!({"id":"same","labelIds":["INBOX"],"payload":{"mimeType":"text/plain","headers":[{"name":"From","value":"notify@example.com"},{"name":"Reply-To","value":format!("support@example.com, {OWNER}")},{"name":"To","value":format!("{OWNER}, team@example.com")},{"name":"Cc","value":"support@example.com, cc@example.com"},{"name":"Bcc","value":"secret@example.com"}],"body":{"data":URL_SAFE_NO_PAD.encode("Message")}}});
    let microsoft = json!({"id":"same","from":{"emailAddress":{"address":"notify@example.com"}},"replyTo":[{"emailAddress":{"address":"support@example.com"}},{"emailAddress":{"address":OWNER}}],"toRecipients":[{"emailAddress":{"address":OWNER}},{"emailAddress":{"address":"team@example.com"}}],"ccRecipients":[{"emailAddress":{"address":"support@example.com"}},{"emailAddress":{"address":"cc@example.com"}}],"bccRecipients":[{"emailAddress":{"address":"secret@example.com"}}],"body":{"contentType":"text","content":"Message"}});
    for mut message in [
        providers::mime(raw.as_bytes()).unwrap(),
        providers::normalize_google(&google).unwrap(),
        providers::normalize_microsoft(&microsoft).unwrap(),
    ] {
        message["id"] = "same".into();
        message["folder"] = "inbox".into();
        db.upsert(OWNER, &message).unwrap();
        let prepare = |mode| {
            drafts::prepare(&db, OWNER, &json!({"messageId":"same","mode":mode})).unwrap()["draft"]
                .clone()
        };
        assert_eq!(
            prepare("reply")["to"],
            format!("support@example.com, {OWNER}")
        );
        let all = prepare("replyAll");
        assert_eq!(all["to"], "support@example.com, team@example.com");
        assert_eq!(all["cc"], "cc@example.com");
        assert_eq!(all["bcc"], "");
        message["replyTo"] = "".into();
        db.upsert(OWNER, &message).unwrap();
        assert_eq!(prepare("reply")["to"], "notify@example.com");
        message["replyTo"] = "support@example.com".into();
        message["folder"] = "sent".into();
        db.upsert(OWNER, &message).unwrap();
        assert_eq!(prepare("reply")["to"], format!("{OWNER}, team@example.com"));
        message["bodyTruncated"] = true.into();
        message["body"] = "😀".repeat(100000).into();
        db.upsert(OWNER, &message).unwrap();
        let forward = prepare("forward");
        assert!(
            forward["body"]
                .as_str()
                .unwrap()
                .contains("text was truncated")
        );
        assert_eq!(forward["to"], "");
        assert_eq!(forward["bcc"], "");
        assert!(forward.get("replyToId").is_none());
        assert!(forward["body"].as_str().unwrap().encode_utf16().count() <= 100000);
        assert!(morrow_search::content::content(&forward, true).is_ok());
        message["folder"] = "drafts".into();
        message["providerDraft"] = true.into();
        db.upsert(OWNER, &message).unwrap();
        let copied = prepare("copy");
        assert!(
            copied["body"]
                .as_str()
                .unwrap()
                .starts_with("[Downloaded message text was truncated.")
        );
        assert!(morrow_search::content::content(&copied, true).is_ok());
    }
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reply_history_is_bounded_owned_plain_text_and_read_only() {
    let directory =
        std::env::temp_dir().join(format!("morrow-reply-history-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER},OTHER:{"email":OTHER}}}))
        .unwrap();
    for i in 0..22 {
        db.upsert(OWNER, &json!({"id":format!("mail-{i}"),"accountId":OTHER,"body":format!("Owned {i}\n> Quoted history"),"bodyHtml":"<script>hostile</script>","bcc":"private@example.com","replyToId":if i == 21 { String::new() } else { format!("mail-{}",i+1) }})).unwrap();
    }
    db.upsert(
        OTHER,
        &json!({"id":"mail-0","body":"Other owner's private text"}),
    )
    .unwrap();
    let result = drafts::history(&db, OWNER, "mail-0").unwrap();
    assert_eq!(result["messages"].as_array().unwrap().len(), 20);
    assert_eq!(result["limited"], true);
    for (i, message) in result["messages"].as_array().unwrap().iter().enumerate() {
        assert_eq!(message["accountId"], OWNER);
        assert_eq!(message["id"], format!("mail-{i}"));
        assert_eq!(message["body"], format!("Owned {i}\n> Quoted history"));
        assert!(message.get("bodyHtml").is_none() && message.get("bcc").is_none());
    }
    assert_eq!(
        drafts::history(&db, OWNER, "mail-21").unwrap()["limited"],
        false
    );
    db.upsert(
        OWNER,
        &json!({"id":"cycle","replyToId":"cycle","body":"Cycle"}),
    )
    .unwrap();
    let cycle = drafts::history(&db, OWNER, "cycle").unwrap();
    assert_eq!(cycle["messages"].as_array().unwrap().len(), 1);
    assert_eq!(cycle["limited"], true);
    db.upsert(
        OWNER,
        &json!({"id":"missing-parent","replyToId":"other-only","body":"Retained original"}),
    )
    .unwrap();
    db.upsert(OTHER, &json!({"id":"other-only","body":"Do not disclose"}))
        .unwrap();
    let partial = drafts::history(&db, OWNER, "missing-parent").unwrap();
    assert_eq!(partial["messages"].as_array().unwrap().len(), 1);
    assert_eq!(partial["limited"], true);
    for owner in ["", "all", "disconnected@example.com"] {
        assert!(drafts::history(&db, owner, "mail-0").is_err());
    }
    assert_eq!(
        drafts::history(&db, OWNER, "missing").unwrap_err().status,
        404
    );
    assert!(db.get(OWNER, "mail-0").unwrap().unwrap()["read"].is_null());
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn draft_builders_retain_the_existing_client_contract() {
    let directory = std::env::temp_dir().join(format!("morrow-drafts-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER}},"activeAccount":"demo"}))
        .unwrap();
    // Captured from the pre-migration client; retained as a native migration contract.
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/draft-prepare.json")).unwrap();
    for case in cases {
        let owner = case["owner"].as_str().unwrap();
        db.upsert(owner, &case["message"]).unwrap();
        let before = db.settings().unwrap();
        let result = drafts::prepare(&db, owner, &case["input"]).unwrap();
        assert_eq!(result, case["expected"], "{}", case["name"]);
        assert_eq!(db.settings().unwrap(), before);
        assert_eq!(db.get(owner, "same").unwrap().unwrap(), case["message"]);
    }
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn preparing_a_draft_requires_the_explicit_owner_and_does_not_write_or_send() {
    let directory =
        std::env::temp_dir().join(format!("morrow-draft-http-{}", uuid::Uuid::new_v4()));
    let app = App::open(
        &directory,
        0,
        "fixture-bearer".into(),
        "fixture-update".into(),
    )
    .unwrap();
    app.db(|db| {
        db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER},OTHER:{"email":OTHER}},"activeAccount":OTHER,"preferences":{"syncInterval":0}}))?;
        for (owner,body) in [(OWNER,"Owned body"),(OTHER,"Other private body")] {
            db.upsert(owner,&json!({"id":"same","accountId":OTHER,"folder":"inbox","subject":"Subject","fromEmail":"sender@example.com","body":body}))?;
        }
        db.upsert(OWNER,&json!({"id":"provider","folder":"drafts","providerDraft":true,"to":"to@example.com","bcc":"bcc@example.com","body":"Unsent text"}))?;
        db.upsert(OWNER,&json!({"id":"local","folder":"drafts","body":"Saved text"}))?;
        Ok(())
    }).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/api/drafts/prepare",
        listener.local_addr().unwrap()
    );
    let router = app.router();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    let history_endpoint = endpoint.replace("/drafts/prepare", "/messages/same/history");
    for (owner, status) in [
        ("", 409),
        ("all", 409),
        ("disconnected@example.com", 409),
        (OWNER, 200),
        (OTHER, 200),
    ] {
        let response = client
            .get(&history_endpoint)
            .bearer_auth("fixture-bearer")
            .header("x-genmail-account", owner)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        if status == 200 {
            let history: Value = response.json().await.unwrap();
            assert_eq!(history["messages"][0]["accountId"], owner);
            assert_eq!(
                history["messages"][0]["body"],
                if owner == OWNER {
                    "Owned body"
                } else {
                    "Other private body"
                }
            );
        }
    }
    assert_eq!(
        client.get(&history_endpoint).send().await.unwrap().status(),
        401
    );
    let input = json!({"messageId":"same","mode":"forward"});
    let request = || {
        client
            .post(&endpoint)
            .bearer_auth("fixture-bearer")
            .header("x-genmail-account", OWNER)
    };
    assert_eq!(
        client
            .post(&endpoint)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        request()
            .header("origin", "https://evil.invalid")
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for owner in ["", "all", "disconnected@example.com"] {
        assert_eq!(
            client
                .post(&endpoint)
                .bearer_auth("fixture-bearer")
                .header("x-genmail-account", owner)
                .json(&input)
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
    }
    let result: Value = request()
        .json(&input)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(result["draft"]["accountId"], OWNER);
    assert!(
        result["draft"]["body"]
            .as_str()
            .unwrap()
            .contains("Owned body")
    );
    assert!(!result.to_string().contains("Other private body"));
    for bad in [
        json!({"messageId":"same","mode":"forward","body":"injected"}),
        json!({"messageId":"same","mode":"reply","accountId":OTHER}),
        json!({"messageId":"same","mode":"reply","body":null}),
        json!({"messageId":"same","mode":"reply","body":"😀".repeat(50001)}),
        json!({"messageId":"same","mode":"unknown"}),
        json!({"mode":"reply"}),
    ] {
        assert_eq!(
            request().json(&bad).send().await.unwrap().status(),
            400,
            "{bad}"
        );
    }
    assert_eq!(
        request()
            .json(&json!({"messageId":"missing","mode":"reply"}))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    for (id, mode) in [
        ("local", "copy"),
        ("provider", "reply"),
        ("local", "forward"),
        ("same", "copy"),
    ] {
        assert_eq!(
            request()
                .json(&json!({"messageId":id,"mode":mode}))
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
    }
    let copied: Value = request()
        .json(&json!({"messageId":"provider","mode":"copy"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(copied["draft"]["bcc"], "bcc@example.com");
    assert_eq!(copied["draft"]["sourceDraft"], true);
    assert!(copied["draft"].get("id").is_none());
    app.db(|db| {
        assert_eq!(db.settings()?["activeAccount"], OTHER);
        assert_eq!(db.list(OWNER)?.len(), 3);
        assert_eq!(db.get(OWNER, "provider")?.unwrap()["body"], "Unsent text");
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .post(endpoint.replace("/drafts/prepare", "/account/disconnect"))
            .bearer_auth("fixture-bearer")
            .header("x-genmail-account", OWNER)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(request().json(&input).send().await.unwrap().status(), 409);
    server.abort();
    let _ = server.await;
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}
