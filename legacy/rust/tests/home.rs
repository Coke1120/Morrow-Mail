use morrow_search::{home, service::App, workflows};
use serde_json::{Value, json};

const A: &str = "a@example.test";
const B: &str = "b@example.test";

async fn call(
    app: &App,
    method: &str,
    path: &str,
    owner: &str,
    body: Value,
) -> morrow_search::error::Result<Value> {
    let mut headers = axum::http::HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    let ctx = morrow_search::service::Context {
        method: method.parse().unwrap(),
        path: path
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect(),
        body,
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    };
    let result = workflows::handle(app, &ctx).await?.unwrap();
    let bytes = axum::body::to_bytes(result.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    Ok(serde_json::from_slice(&bytes).unwrap())
}

fn open(root: &std::path::Path) -> App {
    App::open(root, 3017, "fixture-token".into(), "fixture-update".into()).unwrap()
}

#[tokio::test]
async fn categories_todos_and_skill_schedules_stay_on_their_account_and_never_send() {
    let root = std::env::temp_dir().join(format!("morrow-home-test-{}", uuid::Uuid::new_v4()));
    let app = open(&root);
    app.db(|db| {
        db.set_settings(&json!({"mailAccounts":{
            A:{"email":A,"provider":"imap","connectionId":"one"},
            B:{"email":B,"provider":"imap","connectionId":"two"}
        }}))?;
        db.upsert(
            A,
            &json!({
                "id": "unread-1",
                "date": "2026-10-14T01:00:00.000Z",
                "fromEmail": "news@example.test",
                "subject": "Invoice waiting",
                "body": "SECRET-BODY",
                "folder": "inbox",
                "read": false
            }),
        )?;
        db.upsert(
            B,
            &json!({
                "id": "unread-1",
                "date": "2026-10-14T01:00:00.000Z",
                "subject": "Other mailbox",
                "body": "OTHER-SECRET",
                "folder": "inbox",
                "read": false
            }),
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let saved = call(
        &app,
        "POST",
        "workspace/categories/save",
        A,
        json!({"categories":[
            {"id":"invoices","name":"Invoices","description":"Bills to review","enabled":true,"priority":"P1"},
            {"name":"Later","description":"","enabled":false,"priority":""}
        ]}),
    )
    .await
    .unwrap();
    let categories = &saved["workspace"]["categories"];
    assert_eq!(categories.as_array().unwrap().len(), 2);
    assert_eq!(categories[0]["name"], "Invoices");
    assert!(categories[1]["id"].as_str().unwrap().len() > 8);
    assert_eq!(
        call(
            &app,
            "POST",
            "workspace/categories/save",
            B,
            json!({"categories":[{"name":"B only","enabled":true}]})
        )
        .await
        .unwrap()["workspace"]["categories"][0]["name"],
        "B only"
    );
    let moved = call(
        &app,
        "POST",
        "workspace/categories/reorder",
        A,
        json!({"ids":[categories[1]["id"], categories[0]["id"]]}),
    )
    .await
    .unwrap();
    assert_eq!(
        moved["workspace"]["categories"][0]["id"],
        categories[1]["id"]
    );
    assert_eq!(moved["workspace"]["categories"][1]["name"], "Invoices");
    let updated = call(
        &app,
        "POST",
        &format!(
            "workspace/categories/{}",
            categories[0]["id"].as_str().unwrap()
        ),
        A,
        json!({"description":"Bills and receipts"}),
    )
    .await
    .unwrap();
    assert_eq!(
        updated["workspace"]["categories"][1]["description"],
        "Bills and receipts"
    );
    let suggestion = call(
        &app,
        "POST",
        "workspace/categories/suggest",
        A,
        json!({"prompt":"Receipts"}),
    )
    .await
    .unwrap();
    assert_eq!(suggestion["stub"], true);
    assert_eq!(suggestion["saved"], false);
    assert!(
        call(
            &app,
            "POST",
            "workspace/categories/suggest",
            A,
            json!({"prompt":"Receipts"})
        )
        .await
        .unwrap()["workspace"]
            .is_null()
    );

    let before = app.state(A, true).await.unwrap();
    let todo = before["today"]["todos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|todo| todo["accountId"] == A && todo["messageId"] == "unread-1")
        .cloned()
        .expect("unread mail becomes a suggestion");
    assert_eq!(todo["categoryId"], "invoices");
    assert!(!before["today"].to_string().contains("SECRET-BODY"));
    assert!(
        call(
            &app,
            "POST",
            "workspace/todos/complete",
            A,
            json!({"id": todo["id"]})
        )
        .await
        .is_err()
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "workspace/todos/complete",
            A,
            json!({"id": todo["id"], "read": true, "confirm": true})
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    let completed = call(
        &app,
        "POST",
        "workspace/todos/complete",
        A,
        json!({"id": todo["id"], "confirm": true}),
    )
    .await
    .unwrap();
    assert!(
        completed["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != todo["id"])
    );
    assert!(
        completed["today"]["completedTodos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == todo["id"] && item["title"] == "Invoice waiting")
    );
    app.db(|db| {
        let message = db.get(A, "unread-1")?.unwrap();
        assert_eq!(message["read"], false);
        assert_eq!(message["body"], "SECRET-BODY");
        assert_eq!(message["folder"], "inbox");
        assert!(
            db.list(A)?
                .iter()
                .all(|message| message["folder"] != "drafts" && message["folder"] != "sent")
        );
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        call(
            &app,
            "POST",
            "workspace/todos/complete",
            B,
            json!({"id": todo["id"], "confirm": true})
        )
        .await
        .is_err()
    );
    let reopened = call(
        &app,
        "POST",
        "workspace/todos/reopen",
        A,
        json!({"id": todo["id"], "confirm": true}),
    )
    .await
    .unwrap();
    assert!(
        reopened["today"]["todos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == todo["id"])
    );

    drop(app);
    let app = open(&root);
    let restored = app.state(A, true).await.unwrap();
    assert_eq!(restored["workspace"]["categories"][1]["name"], "Invoices");
    assert_eq!(
        app.state(B, true).await.unwrap()["workspace"]["categories"][0]["name"],
        "B only"
    );

    let rejected = call(
        &app,
        "POST",
        "skills",
        A,
        json!({
            "name": "Reply helper",
            "instructions": "Draft a reply for review.",
            "autoExecute": true,
            "autoExecuteMode": "send",
            "schedule": {"enabled": true, "cadence": "interval", "time": "09:00", "timeZone": "UTC", "intervalHours": 1}
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(rejected.status, 400);
    assert!(rejected.to_string().to_ascii_lowercase().contains("review"));

    let saved_skill = call(
        &app,
        "POST",
        "skills",
        A,
        json!({
            "name": "Reply helper",
            "instructions": "Draft a reply for review.",
            "enabled": true,
            "autoExecute": true,
            "schedule": {"enabled": true, "cadence": "interval", "time": "09:00", "timeZone": "UTC", "intervalHours": 1}
        }),
    )
    .await
    .unwrap();
    let skill_id = saved_skill["workspace"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|skill| skill["name"] == "Reply helper")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        saved_skill["workspace"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|skill| skill["id"] == skill_id)
            .unwrap()["autoExecuteMode"],
        "review"
    );
    home::scheduled_tick(&app).await.unwrap();
    home::scheduled_tick(&app).await.unwrap();
    let queued = app.state(A, true).await.unwrap();
    let reviews = queued["workspace"]["skillReviews"].as_array().unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0]["skillId"], skill_id);
    assert_eq!(reviews[0]["source"], "schedule");
    assert_eq!(reviews[0]["status"], "queued");
    assert_eq!(reviews[0]["kind"], "propose-draft");
    assert!(
        reviews[0]["detail"]
            .as_str()
            .unwrap()
            .contains("Nothing was sent")
    );
    assert!(queued["workspace"]["brain"].is_null());
    app.db(|db| {
        let message = db.get(A, "unread-1")?.unwrap();
        assert_eq!(message["read"], false);
        assert_eq!(message["body"], "SECRET-BODY");
        assert!(
            db.list(A)?
                .iter()
                .all(|message| message["folder"] != "sent")
        );
        assert!(
            db.list(B)?
                .iter()
                .all(|message| message["subject"] == "Other mailbox")
        );
        Ok(())
    })
    .await
    .unwrap();

    let opened = call(
        &app,
        "POST",
        &format!(
            "workspace/skill-reviews/{}/open",
            reviews[0]["id"].as_str().unwrap()
        ),
        A,
        json!({"confirm": true}),
    )
    .await
    .unwrap();
    assert_eq!(opened["workspace"]["skillReviews"][0]["status"], "opened");
    let library = call(
        &app,
        "POST",
        "skills/library",
        A,
        json!({"libraryId": "waiting-on"}),
    )
    .await
    .unwrap();
    assert!(
        library["workspace"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|skill| skill["libraryId"] == "waiting-on" && skill["autoExecute"] == false)
    );
    assert!(
        library["workspace"]["skillLibrary"]
            .as_array()
            .unwrap()
            .iter()
            .any(|skill| skill["id"] == "waiting-on" && skill["installed"] == true)
    );
    assert!(
        call(
            &app,
            "POST",
            "skills/library",
            B,
            json!({"libraryId": "waiting-on"})
        )
        .await
        .unwrap()["workspace"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|skill| skill["libraryId"] == "waiting-on")
    );
    assert!(
        app.state(A, true).await.unwrap()["workspace"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|skill| skill["libraryId"] == "waiting-on")
            .count()
            == 1
    );
}
