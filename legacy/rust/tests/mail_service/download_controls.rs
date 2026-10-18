use super::*;

#[tokio::test]
async fn local_undo_after_mark_read_preserves_read_and_never_replays_a_provider_write() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let calls = observed.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.method, "POST");
            assert_eq!(request.owner(), A);
            assert!(request.path.ends_with("/messages/same/modify"));
            assert_eq!(
                request.json(),
                json!({"addLabelIds":[],"removeLabelIds":["UNREAD"]})
            );
            Reply::Json(200, json!({"id":"same","labelIds":["INBOX"]}))
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "google")])).await;
    server.app.db(|db| {
        for owner in [A,B] {db.upsert(owner,&merge(cached("google:same",owner,"inbox"),&json!({"bodyHtml":"","bodyTruncated":false,"providerLabelIds":["INBOX","UNREAD"],"providerSnapshot":{"folder":"inbox","read":false,"starred":false}})))?;}
        Ok(())
    }).await.unwrap();
    for owner in ["", "all", "disconnected@example.invalid"] {
        assert_eq!(
            server
                .call("GET", "/api/downloads", owner, json!({}))
                .await
                .0,
            409
        );
    }
    assert_eq!(
        server.call("GET", "/api/downloads", A, json!({})).await.0,
        200
    );
    assert_eq!(
        server
            .call("GET", "/api/downloads/incomplete", A, json!({}))
            .await
            .0,
        200
    );
    let moved = server
        .call(
            "PATCH",
            "/api/messages/google%3Asame",
            A,
            json!({"folder":"archive"}),
        )
        .await;
    assert_eq!(moved.0, 200, "{}", moved.1);
    let token = moved.1["message"]["localFolderUndo"]["token"].clone();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "Inspecting downloads/local move must not contact a provider"
    );
    assert_eq!(
        server
            .call(
                "PATCH",
                "/api/messages/google%3Asame",
                A,
                json!({"read":true})
            )
            .await
            .0,
        200
    );
    for owner in ["", "all", B] {
        assert_eq!(
            server
                .call(
                    "PATCH",
                    "/api/messages/google%3Asame",
                    owner,
                    json!({"undoLocalMove":token})
                )
                .await
                .0,
            409
        );
    }
    let restored = server
        .call(
            "PATCH",
            "/api/messages/google%3Asame",
            A,
            json!({"undoLocalMove":token}),
        )
        .await;
    assert_eq!(restored.0, 200, "{}", restored.1);
    assert_eq!(restored.1["message"]["folder"], "inbox");
    assert_eq!(restored.1["message"]["read"], true);
    assert_eq!(
        server
            .call(
                "PATCH",
                "/api/messages/google%3Asame",
                A,
                json!({"undoLocalMove":token})
            )
            .await
            .0,
        409
    );
    let other = server
        .app
        .db(|db| Ok(db.get(B, "google:same")?.unwrap()))
        .await
        .unwrap();
    assert_eq!(other["read"], false);
    assert_eq!(other["folder"], "inbox");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "Only the explicit mark-read provider write is permitted"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn full_content_repair_is_explicit_owned_and_updates_download_coverage() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let fixture=Fixture::new(Arc::new(move |request| {
        let calls=observed.clone(); async move {
            calls.fetch_add(1,Ordering::SeqCst); assert_eq!(request.method,"GET"); assert_eq!(request.owner(),A);
            let url=url::Url::parse(&format!("https://fixture{}",request.path)).unwrap(); assert!(url.path().ends_with("/messages/same")); assert!(url.query_pairs().any(|(k,v)|k=="format"&&v=="raw"));
            let raw=b"From: fixture@example.invalid\r\nTo: a@example.invalid\r\nSubject: Repaired fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRepaired fictional body.";
            Reply::Json(200,json!({"id":"same","raw":URL_SAFE_NO_PAD.encode(raw)}))
        }.boxed()
    })).await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "google")])).await;
    server.app.db(|db| {for owner in [A,B] {db.upsert(owner,&merge(cached("google:same",owner,"inbox"),&json!({"contentIncomplete":true,"bodyTruncated":true,"hasAttachments":true})))?;} Ok(())}).await.unwrap();
    let before = server
        .call("GET", "/api/downloads/incomplete", A, json!({}))
        .await;
    assert_eq!(before.0, 200);
    assert_eq!(before.1["total"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let repaired = server
        .call(
            "POST",
            "/api/messages/google%3Asame/attachments",
            A,
            json!({"connectionRef":before.1["connectionRef"]}),
        )
        .await;
    assert_eq!(repaired.0, 200, "{}", repaired.1);
    assert_eq!(repaired.1["message"]["accountId"], A);
    assert_eq!(
        server
            .call("GET", "/api/downloads/incomplete", A, json!({}))
            .await
            .1["total"],
        0
    );
    assert_eq!(
        server
            .call("GET", "/api/downloads/incomplete", B, json!({}))
            .await
            .1["total"],
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.shutdown().await;
}

#[tokio::test]
async fn stale_download_page_after_reconnect_or_reconnect_back_never_reads_a_provider() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let fixture = Fixture::new(Arc::new(move |_| {
        let calls = observed.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Reply::Json(500, json!({"error":"Unexpected fixture provider request"}))
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "google")])).await;
    server
        .app
        .db(|db| {
            for owner in [A, B] {
                db.upsert(
                    owner,
                    &merge(
                        cached("google:same", owner, "inbox"),
                        &json!({"contentIncomplete":true,"hasAttachments":true}),
                    ),
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let page = server
        .call("GET", "/api/downloads/incomplete", A, json!({}))
        .await
        .1;
    let original = server.app.settings().await.unwrap()["mailAccounts"][A].clone();
    // Ordinary access/refresh-token rotation is not a reconnect.
    let rotated = merge(
        original.clone(),
        &json!({"accessToken":"rotated-fixture-access","refreshToken":"rotated-fixture-refresh"}),
    );
    let rotated_copy = rotated.clone();
    server
        .app
        .db(move |db| morrow_search::service::save_connection(db, &rotated_copy, false))
        .await
        .unwrap();
    assert_eq!(
        server.call("GET", "/api/downloads", A, json!({})).await.1["connectionRef"],
        page["connectionRef"]
    );
    for next in [rotated, original] {
        server
            .app
            .db(move |db| morrow_search::service::save_connection(db, &next, true))
            .await
            .unwrap();
        let before = server.app.settings().await.unwrap();
        let rows_before = server
            .app
            .db(|db| Ok((db.list(A)?, db.list(B)?)))
            .await
            .unwrap();
        let fresh = server
            .call("GET", "/api/downloads/incomplete", A, json!({}))
            .await
            .1;
        assert_ne!(fresh["connectionRef"], page["connectionRef"]);
        for reference in [
            page["connectionRef"].clone(),
            json!(""),
            Value::Null,
            json!(17),
        ] {
            let response = server
                .call(
                    "POST",
                    "/api/messages/google%3Asame/attachments",
                    A,
                    json!({"connectionRef":reference}),
                )
                .await;
            assert_eq!(response.0, 409, "{}", response.1);
        }
        assert_eq!(
            server
                .call(
                    "POST",
                    "/api/messages/google%3Asame/attachments",
                    B,
                    json!({"connectionRef":fresh["connectionRef"]})
                )
                .await
                .0,
            409,
            "An A page cannot repair B's duplicate ID"
        );
        assert_eq!(server.app.settings().await.unwrap(), before);
        assert_eq!(
            server
                .app
                .db(|db| Ok((db.list(A)?, db.list(B)?)))
                .await
                .unwrap(),
            rows_before
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    server.shutdown().await;
}

#[tokio::test]
async fn download_history_controls_reject_stale_connection_and_replaced_job_without_writes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let fixture = Fixture::new(Arc::new(move |_| {
        let calls = observed.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Reply::Json(500, json!({"error":"Unexpected fixture provider request"}))
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    let mut setup = config(&[(A, "google"), (B, "google")]);
    for owner in [A, B] {
        setup["imports"][owner] = json!({"id":"same-job-id","connectionId":setup["mailAccounts"][owner]["connectionId"],"status":"paused","options":{"months":3,"inbox":true,"sent":false,"allMail":false},"cursor":"retained-checkpoint"});
    }
    set(&server.app, setup).await;
    let initial = server.call("GET", "/api/downloads", A, json!({})).await.1;
    let stale = json!({"connectionRef":initial["connectionRef"],"jobRef":initial["jobRef"]});
    server
        .app
        .db(|db| {
            let mut config = db.settings()?;
            config["imports"][A]["id"] = "replacement-job".into();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    let current = server.call("GET", "/api/downloads", A, json!({})).await.1;
    assert_ne!(current["jobRef"], initial["jobRef"]);
    assert_eq!(current["connectionRef"], initial["connectionRef"]);
    let before = server.app.settings().await.unwrap();
    for action in ["pause", "resume"] {
        for body in [
            stale.clone(),
            json!({"connectionRef":current["connectionRef"]}),
            json!({"connectionRef":current["connectionRef"],"jobRef":""}),
            json!({"connectionRef":"","jobRef":current["jobRef"]}),
            json!({"connectionRef":Value::Null,"jobRef":current["jobRef"]}),
        ] {
            assert_eq!(
                server
                    .call("POST", &format!("/api/imports/{action}"), A, body)
                    .await
                    .0,
                409
            );
            assert_eq!(
                server.app.settings().await.unwrap(),
                before,
                "Rejected control must retain the exact checkpoint and other accounts"
            );
        }
        assert_eq!(
            server
                .call(
                    "POST",
                    &format!("/api/imports/{action}"),
                    B,
                    json!({"connectionRef":current["connectionRef"],"jobRef":current["jobRef"]})
                )
                .await
                .0,
            409
        );
    }
    let original = before["mailAccounts"][A].clone();
    server
        .app
        .db(move |db| morrow_search::service::save_connection(db, &original, true))
        .await
        .unwrap();
    let reconnected = server.app.settings().await.unwrap();
    for action in ["pause", "resume"] {
        assert_eq!(
            server
                .call(
                    "POST",
                    &format!("/api/imports/{action}"),
                    A,
                    json!({"connectionRef":current["connectionRef"],"jobRef":current["jobRef"]})
                )
                .await
                .0,
            409
        );
        assert_eq!(server.app.settings().await.unwrap(), reconnected);
    }
    // A fresh reviewed context controls the current job; replaying it cannot
    // affect the new job identity assigned by pause/resume.
    server
        .app
        .db(|db| {
            let mut config = db.settings()?;
            config["imports"][A]["connectionId"] =
                config["mailAccounts"][A]["connectionId"].clone();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    let fresh = server.call("GET", "/api/downloads", A, json!({})).await.1;
    let body = json!({"connectionRef":fresh["connectionRef"],"jobRef":fresh["jobRef"]});
    let resumed = server
        .call("POST", "/api/imports/resume", A, body.clone())
        .await;
    assert_eq!(resumed.0, 200, "{}", resumed.1);
    assert_eq!(
        server.app.settings().await.unwrap()["imports"][A]["status"],
        "running"
    );
    let after = server.app.settings().await.unwrap();
    assert_eq!(
        server.call("POST", "/api/imports/pause", A, body).await.0,
        409
    );
    assert_eq!(server.app.settings().await.unwrap(), after);
    // Compatibility: existing callers without a Downloads fence retain the
    // old pause route; this test performs no network/background runner.
    assert_eq!(
        server
            .call("POST", "/api/imports/pause", A, json!({}))
            .await
            .0,
        200
    );
    assert_eq!(
        server.app.settings().await.unwrap()["imports"][A]["status"],
        "paused"
    );
    assert_eq!(
        server.app.settings().await.unwrap()["imports"][B],
        before["imports"][B]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    server.shutdown().await;
}
