use morrow_search::{
    local_rules, mail, pages,
    service::{App, Context},
    store::Store,
};
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
    let ctx = Context {
        method: method.parse().unwrap(),
        path: path.split('/').map(str::to_owned).collect(),
        body,
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    };
    let result = local_rules::handle(app, &ctx).await?.unwrap();
    let bytes = axum::body::to_bytes(result.into_body(), 1024 * 1024)
        .await
        .unwrap();
    Ok(serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn reviewed_rules_are_atomic_owned_single_use_and_markers_survive_import() {
    let root = std::env::temp_dir().join(format!("morrow-rule-test-{}", uuid::Uuid::new_v4()));
    let app = App::open(&root, 3001, "fixture-token".into(), "fixture-update".into()).unwrap();
    app.db(|db| {
        db.set_settings(&json!({"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"one"},B:{"email":B,"connectionId":"two"}}}))?;
        for owner in [A,B] { for id in ["same","second"] { db.upsert(owner,&json!({"id":id,"date":"2026-10-03","fromEmail":"News@Example.COM","subject":"Update","body":"PRIVATE BODY","folder":"inbox","providerLabelIds":["INBOX"]}))?; } }
        db.upsert(A,&json!({"id":"suffix","fromEmail":"news@otherexample.com","folder":"inbox"}))?;
        Ok(())
    }).await.unwrap();
    for owner in ["", "all", "demo"] {
        assert!(
            call(&app, "GET", "workspace/rules", owner, json!({}))
                .await
                .is_err()
        );
    }
    let rule = json!({"condition":"domain","value":"EXAMPLE.COM","action":"lowPriority"});
    let preview = call(&app, "POST", "workspace/rules/preview", A, rule.clone())
        .await
        .unwrap();
    assert_eq!(preview["messages"].as_array().unwrap().len(), 2);
    assert!(!preview.to_string().contains("PRIVATE BODY"));
    assert_eq!(
        app.db(|db| Ok(pages::stats(db, &[A.into(), B.into()])?[A]["counts"]["later"].clone()))
            .await
            .unwrap(),
        0
    );
    app.db(|db| {
        db.update(A, "second", &json!({"read":true}))?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "workspace/rules/apply",
            A,
            json!({"previewId":preview["previewId"]})
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(
        app.db(|db| Ok(db.get(A, "same")?.unwrap()["lowPriority"].clone()))
            .await
            .unwrap(),
        Value::Null
    );
    let preview = call(&app, "POST", "workspace/rules/preview", A, rule.clone())
        .await
        .unwrap();
    let request = json!({"previewId":preview["previewId"]});
    assert_eq!(
        call(&app, "POST", "workspace/rules/apply", A, request.clone())
            .await
            .unwrap()["applied"],
        2
    );
    assert!(
        call(&app, "POST", "workspace/rules/apply", A, request)
            .await
            .is_err()
    );
    app.db(|db| {
        assert_eq!(db.get(B, "same")?.unwrap()["lowPriority"], Value::Null);
        assert_eq!(db.get(A, "same")?.unwrap()["localOverrides"], Value::Null);
        let original = db.get(A, "same")?.unwrap();
        let mail = json!({"email":A,"provider":"google"});
        let mut incoming = original.clone();
        incoming.as_object_mut().unwrap().remove("lowPriority");
        mail::import_messages(db, &mail, &[incoming])?;
        assert_eq!(db.get(A, "same")?.unwrap()["lowPriority"], true);
        assert_eq!(
            pages::stats(db, &[A.into(), B.into()])?[A]["counts"]["later"],
            2
        );
        let page = pages::page(
            db,
            &[A.into(), B.into()],
            &json!({"folder":"later"}),
            &[4; 32],
        )?;
        assert_eq!(page["messages"].as_array().unwrap().len(), 2);
        assert!(
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["accountId"] == A && m["lowPriority"] == true)
        );
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        call(&app, "GET", "workspace/rules", B, json!({}))
            .await
            .unwrap()["rules"],
        json!([])
    );
    let preview = call(&app, "POST", "workspace/rules/preview", A, rule)
        .await
        .unwrap();
    app.db(|db| {
        let mut accounts = db.settings()?["mailAccounts"].clone();
        accounts[A]["connectionId"] = "reconnected".into();
        db.set_settings(&json!({"mailAccounts":accounts}))?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "workspace/rules/apply",
            A,
            json!({"previewId":preview["previewId"]})
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    assert!(
        call(
            &app,
            "POST",
            "workspace/rules/preview",
            A,
            json!({"condition":"domain","value":"com","action":"delete"})
        )
        .await
        .is_err()
    );
    drop(app);
    let db = Store::open(&root).unwrap();
    assert_eq!(db.get(A, "same").unwrap().unwrap()["lowPriority"], true);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
