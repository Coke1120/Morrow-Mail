use morrow_search::{drafts, service::App, store::Store};
use serde_json::{Value, json};

const OWNER: &str = "Owner@example.com";
const OTHER: &str = "other@example.com";

#[test]
fn draft_builders_retain_the_existing_client_contract() {
    let directory = std::env::temp_dir().join(format!("morrow-drafts-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&directory).unwrap();
    db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER}},"activeAccount":"demo"}))
        .unwrap();
    // Captured from the pre-migration client; shared with the Node compatibility checks.
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
