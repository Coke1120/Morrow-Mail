//! Public reconnect contracts against the parent fixture's loopback-only TLS provider.
use super::*;
use std::collections::HashMap;

const MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";
const VACATION: &str = "https://www.googleapis.com/auth/gmail.settings.basic";
const FRESH: &str = "fixture-recovered-access";

fn unauthorized() -> Reply {
    Reply::Json(
        401,
        json!({"error":{"code":401,"message":"PRIVATE_AUTH_DETAIL","errors":[{"reason":"authError"}]}}),
    )
}
fn form(request: &Request) -> HashMap<String, String> {
    url::form_urlencoded::parse(&request.body)
        .into_owned()
        .collect()
}
fn bearer(request: &Request) -> &str {
    request.headers["authorization"].to_str().unwrap()
}
fn refreshed_token(refresh: Option<&str>) -> Value {
    let mut token = json!({"access_token":FRESH,"expires_in":3600});
    if let Some(refresh) = refresh {
        token["refresh_token"] = refresh.into();
    }
    token
}
fn empty_read(request: &Request) -> Reply {
    assert_eq!(request.host(), "gmail.googleapis.com");
    assert_eq!(request.method, "GET");
    let path = request.path.split('?').next().unwrap();
    if path.ends_with("/profile") {
        Reply::Json(200, json!({"emailAddress":A,"historyId":"100"}))
    } else if path.ends_with("/labels") {
        Reply::Json(
            200,
            json!({"labels":[{"id":"INBOX","name":"INBOX","type":"system"},{"id":"TRASH","name":"TRASH","type":"system"}]}),
        )
    } else if path.ends_with("/messages") {
        Reply::Json(200, json!({"messages":[]}))
    } else if path.ends_with("/history") {
        Reply::Json(200, json!({"historyId":"100","history":[]}))
    } else {
        panic!("Unexpected synthetic read endpoint: {}", request.path)
    }
}
async fn seed_cache(app: &App) {
    app.db(|db| {
        for owner in [A, B] {
            db.upsert(owner, &cached("same", owner, "inbox"))?;
            db.upsert(owner, &cached("keep-draft", owner, "drafts"))?;
        }
        Ok(())
    })
    .await
    .unwrap();
}
async fn assert_cache(app: &App) {
    app.db(|db| {
        for owner in [A, B] {
            assert_eq!(db.get(owner, "same")?.unwrap()["body"], "Cached body");
            assert_eq!(db.get(owner, "keep-draft")?.unwrap()["folder"], "drafts");
        }
        Ok(())
    })
    .await
    .unwrap();
}
async fn expire_owner(app: &App) {
    app.db(|db| {
        let mut accounts = connections(&db.settings()?);
        accounts[A]["expiresAt"] = 0.into();
        db.set_settings(&json!({"mailAccounts":accounts}))?;
        Ok(())
    })
    .await
    .unwrap();
}
fn assert_safe(value: &Value) {
    let text = value.to_string();
    for secret in [
        "PRIVATE_AUTH_DETAIL",
        "PRIVATE_TOKEN_DETAIL",
        "fixture-secret",
        "refresh-a@",
        FRESH,
    ] {
        assert!(
            !text.contains(secret),
            "Public response exposed a synthetic credential/detail"
        );
    }
}

#[tokio::test]
async fn gmail_401_sync_recovers_once_and_persists_refresh_rotation_or_omission() {
    for returned in [None, Some(""), Some("rotated-refresh")] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let rejections = Arc::new(AtomicUsize::new(0));
        let (calls, denied) = (exchanges.clone(), rejections.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, denied) = (calls.clone(), denied.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    let fields = form(&request);
                    assert_eq!(fields["grant_type"], "refresh_token");
                    assert_eq!(fields["client_id"], "fixture-client");
                    assert_eq!(fields["client_secret"], "fixture-secret");
                    let index = calls.fetch_add(1, Ordering::SeqCst);
                    let expected = if index > 0 {
                        returned
                            .filter(|v| !v.is_empty())
                            .unwrap_or("refresh-a@example.invalid")
                    } else {
                        "refresh-a@example.invalid"
                    };
                    assert_eq!(fields["refresh_token"], expected);
                    return Reply::Json(200, refreshed_token(returned));
                }
                if bearer(&request) != format!("Bearer {FRESH}") {
                    assert_eq!(bearer(&request), format!("Bearer fixture-{A}"));
                    denied.fetch_add(1, Ordering::SeqCst);
                    return unauthorized();
                }
                empty_read(&request)
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let result = server.call("POST", "/api/sync", A, json!({})).await;
        assert_eq!(result.0, 200, "{}", result.1);
        assert_safe(&result.1);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(rejections.load(Ordering::SeqCst), 1);
        let saved = server.app.settings().await.unwrap();
        let expected = returned
            .filter(|v| !v.is_empty())
            .unwrap_or("refresh-a@example.invalid");
        assert_eq!(saved["mailAccounts"][A]["refreshToken"], expected);
        assert_eq!(saved["mailAccounts"][A]["accessToken"], FRESH);
        for key in ["connectionId", "clientId", "clientSecret", "grantedScopes"] {
            assert_eq!(
                saved["mailAccounts"][A][key],
                original["mailAccounts"][A][key]
            );
        }
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_eq!(saved["activeAccount"], B);
        assert_eq!(saved["backgroundSyncErrors"], json!([]));
        assert_cache(&server.app).await;
        server.shutdown().await;

        let server = fixture.start().await;
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"][A]["refreshToken"],
            expected
        );
        expire_owner(&server.app).await;
        let result = server.call("GET", "/api/mail/folders", A, json!({})).await;
        assert_eq!(result.0, 200, "{}", result.1);
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            2,
            "Restart uses the retained/rotated token without another sign-in"
        );
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_401_refresh_failures_preserve_owned_state_and_safe_recovery_actions() {
    for (mode, code, recovery) in [
        (0, "oauth_reconnect_required", "reconnect"),
        (1, "oauth_configuration", "configure"),
        (2, "oauth_refresh_failed", "retry"),
        (3, "oauth_refresh_failed", "retry"),
        (4, "oauth_refresh_failed", "retry"),
        (5, "oauth_refresh_failed", "retry"),
    ] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let (calls, resources) = (exchanges.clone(), reads.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, resources) = (calls.clone(), resources.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    assert_eq!(form(&request)["refresh_token"], "refresh-a@example.invalid");
                    calls.fetch_add(1, Ordering::SeqCst);
                    return match mode {
                        0 => Reply::Json(400, json!({"error":"invalid_grant","error_description":"PRIVATE_TOKEN_DETAIL"})),
                        1 => Reply::Json(401, json!({"error":"invalid_client","error_description":"PRIVATE_TOKEN_DETAIL"})),
                        2 => Reply::Json(503, json!({"error":"PRIVATE_TOKEN_DETAIL"})),
                        3 => Reply::Json(429, json!({"error":"PRIVATE_TOKEN_DETAIL"})),
                        4 => Reply::Lost,
                        _ => Reply::Json(200, json!({"access_token":"","expires_in":3600})),
                    };
                }
                resources.fetch_add(1, Ordering::SeqCst);
                unauthorized()
            }.boxed()
        })).await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let result = server.call("POST", "/api/sync", A, json!({})).await;
        assert_eq!(result.0, 502, "mode {mode}: {}", result.1);
        assert_eq!(result.1["code"], code);
        assert_eq!(result.1["recoveryAction"], recovery);
        assert_safe(&result.1);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "Failed exchange must not retry resource reads"
        );
        let saved = server.app.settings().await.unwrap();
        assert_eq!(saved["mailAccounts"], original["mailAccounts"]);
        assert_cache(&server.app).await;
        let state = server.call("GET", "/api/state", A, json!({})).await;
        assert_safe(&state.1);
        assert_eq!(state.1["syncErrors"][0]["code"], code);
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_401_budget_covers_the_entire_sync_including_a_later_endpoint() {
    let exchanges = Arc::new(AtomicUsize::new(0));
    let denied = Arc::new(AtomicUsize::new(0));
    let (calls, rejections) = (exchanges.clone(), denied.clone());
    let fixture = Fixture::new(Arc::new(move |request| {
        let (calls, rejections) = (calls.clone(), rejections.clone());
        async move {
            if request.host() == "oauth2.googleapis.com" {
                calls.fetch_add(1, Ordering::SeqCst);
                return Reply::Json(200, refreshed_token(None));
            }
            if bearer(&request) == format!("Bearer {FRESH}") && request.path.ends_with("/profile") {
                return empty_read(&request);
            }
            rejections.fetch_add(1, Ordering::SeqCst);
            unauthorized()
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "google")])).await;
    let result = server.call("POST", "/api/sync", A, json!({})).await;
    assert_eq!(result.0, 502);
    assert_eq!(result.1["code"], "oauth_reconnect_required");
    assert_eq!(result.1["recoveryAction"], "reconnect");
    assert_eq!(exchanges.load(Ordering::SeqCst), 1);
    assert_eq!(denied.load(Ordering::SeqCst), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn gmail_401_recovery_resumes_committed_bootstrap_scopes_without_duplicate_imports() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let seen = seen.clone();
        async move {
            if request.host() == "oauth2.googleapis.com" {
                seen.lock().unwrap().push("refresh".to_owned());
                return Reply::Json(200, refreshed_token(None));
            }
            let url =
                url::Url::parse(&format!("https://gmail.googleapis.com{}", request.path)).unwrap();
            let query = url.query_pairs().collect::<HashMap<_, _>>();
            if url.path().ends_with("/profile") {
                seen.lock().unwrap().push("profile".to_owned());
                return empty_read(&request);
            }
            if url.path().ends_with("/messages/committed") {
                seen.lock()
                    .unwrap()
                    .push(format!("detail:{}", query["format"]));
                return Reply::Json(
                    200,
                    google_message("committed", A, "Committed before refresh"),
                );
            }
            if url.path().ends_with("/messages") {
                let label = query.get("labelIds").map(|v| v.as_ref()).unwrap_or("ALL");
                let fresh = bearer(&request) == format!("Bearer {FRESH}");
                seen.lock().unwrap().push(format!("{label}:{fresh}"));
                if label == "SENT" && !fresh {
                    return unauthorized();
                }
                if label == "INBOX" {
                    return Reply::Json(200, json!({"messages":[{"id":"committed"}]}));
                }
                return Reply::Json(200, json!({"messages":[]}));
            }
            empty_read(&request)
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    let mut original = config(&[(A, "google"), (B, "google")]);
    // Sync only queues this synthetic arrival; this test never runs the AI worker.
    original["policy"] = json!({"enabled":true,"triggers":{"onArrival":true,"scheduledSummary":false},"behaviors":{"summary":true},"content":{"body":true},"folders":{"inbox":true}});
    set(&server.app, original.clone()).await;
    let result = server.call("POST", "/api/sync", A, json!({})).await;
    assert_eq!(result.0, 200, "{}", result.1);
    let events = events.lock().unwrap().clone();
    for event in [
        "refresh",
        "profile",
        "detail:full",
        "INBOX:false",
        "SENT:false",
        "SENT:true",
    ] {
        assert_eq!(
            events.iter().filter(|v| *v == event).count(),
            1,
            "{events:?}"
        );
    }
    assert!(
        events.iter().filter(|v| *v == "detail:minimal").count() <= 1,
        "The recovered round may reconcile the already committed row"
    );
    assert!(
        !events.iter().any(|v| v == "INBOX:true"),
        "Already committed Inbox must not be fetched again"
    );
    let saved = server.app.settings().await.unwrap();
    assert_eq!(saved["gmailSync"][A]["historyId"], "100");
    assert!(saved["gmailSync"][A]["bootstrap"].is_null());
    assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
    let jobs = saved["automation"][A]["jobs"].as_array().unwrap();
    assert_eq!(
        jobs.len(),
        1,
        "The committed Inbox arrival must not be queued twice"
    );
    assert_eq!(jobs[0]["messageIds"], json!(["google:committed"]));
    server
        .app
        .db(|db| {
            assert_eq!(
                db.get(A, "google:committed")?.unwrap()["body"],
                "Committed before refresh"
            );
            assert!(db.get(B, "google:committed")?.is_none());
            let count: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE account=? AND id=?",
                [A, "google:committed"],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(())
        })
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test]
async fn gmail_401_changed_connection_blocks_refresh_egress_or_stale_retry() {
    for hold_exchange in [false, true] {
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let exchanges = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let (hit, wait, calls, resources) = (
            entered.clone(),
            release.clone(),
            exchanges.clone(),
            reads.clone(),
        );
        let fixture = Fixture::new(Arc::new(move |request| {
            let (hit, wait, calls, resources) =
                (hit.clone(), wait.clone(), calls.clone(), resources.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if hold_exchange {
                        hit.add_permits(1);
                        wait_for(&wait).await;
                    }
                    return Reply::Json(200, refreshed_token(Some("stale-rotated-refresh")));
                }
                resources.fetch_add(1, Ordering::SeqCst);
                if !hold_exchange {
                    hit.add_permits(1);
                    wait_for(&wait).await;
                }
                unauthorized()
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let request = server.request("POST", "/api/sync", A, &json!({}));
        let task = tokio::spawn(async move { request.send().await.unwrap() });
        wait_for(&entered).await;
        // Fault injection bypasses the mailbox gate to exercise the connection CAS.
        server
            .app
            .db(move |db| {
                let mut accounts = connections(&db.settings()?);
                if hold_exchange {
                    accounts[A]["connectionId"] = "replacement-connection".into();
                }
                accounts[A]["accessToken"] = "replacement-access".into();
                accounts[A]["refreshToken"] = "replacement-refresh".into();
                db.set_settings(&json!({"mailAccounts":accounts}))?;
                Ok(())
            })
            .await
            .unwrap();
        release.add_permits(1);
        let result = task.await.unwrap();
        assert_eq!(result.status(), 502);
        assert_eq!(exchanges.load(Ordering::SeqCst), usize::from(hold_exchange));
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "No resource replay after the owned connection changed"
        );
        let saved = server.app.settings().await.unwrap();
        assert_eq!(
            saved["mailAccounts"][A]["refreshToken"],
            "replacement-refresh"
        );
        assert_eq!(
            saved["mailAccounts"][A]["accessToken"],
            "replacement-access"
        );
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_401_folder_and_raw_reads_recover_but_other_statuses_do_not_refresh() {
    for path in [
        "/api/mail/folders",
        "/api/mail/folders/manage",
        "/api/messages/google%3Aattached/attachments",
    ] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let (calls, resources) = (exchanges.clone(), reads.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, resources) = (calls.clone(), resources.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    calls.fetch_add(1, Ordering::SeqCst);
                    return Reply::Json(200, refreshed_token(None));
                }
                resources.fetch_add(1, Ordering::SeqCst);
                if bearer(&request) != format!("Bearer {FRESH}") { return unauthorized(); }
                if request.path.ends_with("?format=raw") {
                    let raw = "From: a@example.invalid\r\nTo: a@example.invalid\r\nSubject: Synthetic attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nRecovered owned body\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=fixture.txt\r\n\r\nSynthetic owned bytes\r\n--x--\r\n";
                    return Reply::Json(200, json!({"id":"attached","raw":URL_SAFE_NO_PAD.encode(raw)}));
                }
                empty_read(&request)
            }.boxed()
        })).await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        server
            .app
            .db(|db| {
                for owner in [A, B] {
                    db.upsert(
                        owner,
                        &merge(
                            cached("google:attached", owner, "inbox"),
                            &json!({"hasAttachments":true}),
                        ),
                    )?;
                }
                Ok(())
            })
            .await
            .unwrap();
        let method = if path.ends_with("/attachments") {
            "POST"
        } else {
            "GET"
        };
        let result = server.call(method, path, A, json!({})).await;
        assert_eq!(result.0, 200, "{path}: {}", result.1);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        if method == "POST" {
            assert_eq!(
                result.1["message"]["attachments"].as_array().unwrap().len(),
                1
            );
            let attachment = string(&result.1["message"]["attachments"][0], "id");
            assert_eq!(
                server
                    .call(
                        "GET",
                        &format!("/api/attachments/{attachment}"),
                        B,
                        json!({})
                    )
                    .await
                    .0,
                409
            );
            assert_eq!(server.call(method, path, A, json!({})).await.0, 200);
            assert_eq!(
                reads.load(Ordering::SeqCst),
                2,
                "Committed attachment bytes are reused locally"
            );
        }
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"][B],
            original["mailAccounts"][B]
        );
        server.shutdown().await;
    }
    for status in [403, 429, 503] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let (calls, resources) = (exchanges.clone(), reads.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, resources) = (calls.clone(), resources.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    calls.fetch_add(1, Ordering::SeqCst);
                    return Reply::Json(200, refreshed_token(None));
                }
                resources.fetch_add(1, Ordering::SeqCst);
                Reply::Json(status, json!({"error":{"message":"PRIVATE_AUTH_DETAIL"}}))
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        set(&server.app, config(&[(A, "google")])).await;
        let result = server.call("GET", "/api/mail/folders", A, json!({})).await;
        assert_ne!(result.0, 200);
        assert_eq!(exchanges.load(Ordering::SeqCst), 0);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_safe(&result.1);
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_401_never_replays_send_flags_or_provider_moves() {
    for operation in ["send", "flags", "trash"] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let (calls, mutations) = (exchanges.clone(), writes.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, mutations) = (calls.clone(), mutations.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    calls.fetch_add(1, Ordering::SeqCst);
                    return Reply::Json(200, refreshed_token(None));
                }
                assert_eq!(bearer(&request), format!("Bearer fixture-{A}"));
                if request.method == "GET" {
                    return empty_read(&request);
                }
                mutations.fetch_add(1, Ordering::SeqCst);
                let expected = match operation {
                    "send" => "/gmail/v1/users/me/messages/send",
                    "flags" => "/gmail/v1/users/me/messages/same/modify",
                    _ => "/gmail/v1/users/me/messages/same/trash",
                };
                assert_eq!(request.path, expected);
                unauthorized()
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        server
            .app
            .db(|db| {
                for owner in [A, B] {
                    db.upsert(owner, &cached("google:same", owner, "inbox"))?;
                }
                Ok(())
            })
            .await
            .unwrap();
        let result = match operation {
            "send" => {
                server
                    .call("POST", "/api/send", A, outgoing("no-auth-replay-send"))
                    .await
            }
            "flags" => {
                server
                    .call(
                        "PATCH",
                        "/api/messages/google%3Asame",
                        A,
                        json!({"read":true}),
                    )
                    .await
            }
            _ => {
                server
                    .call(
                        "POST",
                        "/api/messages/google%3Asame/organize",
                        A,
                        json!({"mode":"move","destinationId":"TRASH","confirmed":true}),
                    )
                    .await
            }
        };
        assert_ne!(result.0, 200, "{operation}: {}", result.1);
        assert_eq!(
            writes.load(Ordering::SeqCst),
            1,
            "No automatic provider write replay"
        );
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            0,
            "Resource-write 401 must not enter read recovery"
        );
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"],
            original["mailAccounts"]
        );
        assert_cache(&server.app).await;
        server
            .app
            .db(|db| {
                for owner in [A, B] {
                    let row = db.get(owner, "google:same")?.unwrap();
                    assert_eq!(row["folder"], "inbox");
                    assert_eq!(row["read"], false);
                }
                Ok(())
            })
            .await
            .unwrap();
        server.shutdown().await;
    }
}

async fn start_checkpointed_history(server: &Running) -> Value {
    let started = server
        .call(
            "POST",
            "/api/imports/start",
            A,
            json!({"months":0,"inbox":true,"sent":false}),
        )
        .await;
    assert_eq!(started.0, 200, "{}", started.1);
    // An owned persisted checkpoint from an earlier successful page, independent of wall time.
    server
        .app
        .db(|db| {
            let mut imports = db.settings()?["imports"].clone();
            imports[A]["recentSince"] = Value::Null;
            imports[A]["cursor"] = "saved-history-page".into();
            imports[A]["pages"] = 1.into();
            imports[A]["processed"] = 1.into();
            imports[A]["imported"] = 1.into();
            db.set_settings(&json!({"imports":imports}))?;
            db.upsert(A, &cached("prior-history-row", A, "inbox"))?;
            Ok(())
        })
        .await
        .unwrap();
    server.app.settings().await.unwrap()["imports"][A].clone()
}

fn assert_history_checkpoint(job: &Value, checkpoint: &Value) {
    for key in [
        "id",
        "cursor",
        "pages",
        "processed",
        "imported",
        "folderIndex",
        "since",
        "before",
        "recentSince",
        "visited",
        "options",
        "connectionId",
        "retryCount",
    ] {
        assert_eq!(job[key], checkpoint[key], "Saved history checkpoint {key}");
    }
}

#[tokio::test]
async fn gmail_history_resource_401_stops_until_manual_resume_without_refresh_or_page_retry() {
    for failure_at in ["list", "detail"] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let lists = Arc::new(Mutex::new(Vec::new()));
        let first_details = Arc::new(AtomicUsize::new(0));
        let resources = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let (calls, pages, details, reads, allow) = (
            exchanges.clone(),
            lists.clone(),
            first_details.clone(),
            resources.clone(),
            accepted.clone(),
        );
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, pages, details, reads, allow) = (
                calls.clone(), pages.clone(), details.clone(), reads.clone(), allow.clone(),
            );
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    calls.fetch_add(1, Ordering::SeqCst);
                    return Reply::Json(200, refreshed_token(None));
                }
                assert_eq!(request.host(), "gmail.googleapis.com");
                assert_eq!(request.method, "GET");
                assert_eq!(bearer(&request), format!("Bearer fixture-{A}"));
                reads.fetch_add(1, Ordering::SeqCst);
                let ready = allow.load(Ordering::SeqCst) == 1;
                let url = url::Url::parse(&format!("https://gmail.googleapis.com{}", request.path)).unwrap();
                if url.path().ends_with("/labels") { return empty_read(&request); }
                if url.path().ends_with("/messages") {
                    let query = url.query_pairs().collect::<HashMap<_, _>>();
                    assert_eq!(query["pageToken"], "saved-history-page");
                    pages.lock().unwrap().push(request.path.clone());
                    if failure_at == "list" && !ready { return unauthorized(); }
                    return Reply::Json(200, json!({"messages":[{"id":"partial-first"},{"id":"partial-second"}],"nextPageToken":"next-history-page"}));
                }
                let id = percent_encoding::percent_decode_str(url.path().rsplit('/').next().unwrap()).decode_utf8().unwrap();
                assert!(["partial-first", "partial-second"].contains(&id.as_ref()), "Unexpected synthetic detail endpoint: {}", request.path);
                if id == "partial-first" { details.fetch_add(1, Ordering::SeqCst); }
                if id == "partial-second" && !ready { return unauthorized(); }
                let mut row = google_message(&id, A, if ready { "Fresh manually resumed page" } else { "Discarded partial body" });
                row["internalDate"] = (chrono::Utc::now() - chrono::Duration::days(1)).timestamp_millis().to_string().into();
                Reply::Json(200, row)
            }.boxed()
        })).await;
        let server = fixture.start().await;
        let mut original = config(&[(A, "google"), (B, "google")]);
        original["preferences"]["syncInterval"] = 0.into();
        original["policy"] = json!({"enabled":false});
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let checkpoint = start_checkpointed_history(&server).await;
        morrow_search::background::tick(&server.app).await.unwrap();
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            0,
            "History {failure_at} 401 must stop before token egress"
        );
        assert_eq!(
            lists.lock().unwrap().len(),
            1,
            "History {failure_at} 401 must not retry the page in the same tick"
        );
        assert_eq!(
            first_details.load(Ordering::SeqCst),
            usize::from(failure_at == "detail")
        );
        let reads_before = resources.load(Ordering::SeqCst);
        let saved = server.app.settings().await.unwrap();
        let failed = saved["imports"][A].clone();
        assert_history_checkpoint(&failed, &checkpoint);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["errorCode"], "authorization");
        assert_eq!(failed["recoveryAction"], "reconnect");
        assert!(failed["nextRetryAt"].is_null());
        assert_safe(&failed);
        assert_eq!(saved["mailAccounts"], original["mailAccounts"]);
        server
            .app
            .db(|db| {
                assert!(db.get(A, "google:partial-first")?.is_none());
                assert!(db.get(A, "google:partial-second")?.is_none());
                assert!(db.get(A, "prior-history-row")?.is_some());
                Ok(())
            })
            .await
            .unwrap();
        assert_cache(&server.app).await;

        // Recovery at the provider is insufficient: failed authorization stays stopped.
        accepted.store(1, Ordering::SeqCst);
        for _ in 0..2 {
            morrow_search::background::tick(&server.app).await.unwrap();
        }
        assert_eq!(resources.load(Ordering::SeqCst), reads_before);
        assert_eq!(exchanges.load(Ordering::SeqCst), 0);
        assert_eq!(server.app.settings().await.unwrap()["imports"][A], failed);
        server.shutdown().await;
        let server = fixture.start().await;
        morrow_search::background::tick(&server.app).await.unwrap();
        assert_eq!(
            resources.load(Ordering::SeqCst),
            reads_before,
            "Restart must not retry the failed history page"
        );
        assert_eq!(exchanges.load(Ordering::SeqCst), 0);
        assert_eq!(server.app.settings().await.unwrap()["imports"][A], failed);
        assert_cache(&server.app).await;

        let resumed = server
            .call("POST", "/api/imports/resume", A, json!({}))
            .await;
        assert_eq!(resumed.0, 200, "{}", resumed.1);
        assert_safe(&resumed.1);
        let resumed_job = server.app.settings().await.unwrap()["imports"][A].clone();
        assert_ne!(resumed_job["id"], checkpoint["id"]);
        assert_eq!(resumed_job["cursor"], checkpoint["cursor"]);
        assert_eq!(resumed_job["status"], "running");
        assert_eq!(
            resources.load(Ordering::SeqCst),
            reads_before,
            "Explicit resume queues work; only the next tick may fetch it"
        );
        morrow_search::background::tick(&server.app).await.unwrap();
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            0,
            "Manual resume does not force refresh an unexpired access token"
        );
        let requests = lists.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0], requests[1],
            "Manual resume retains the exact owned cursor and date window"
        );
        assert_eq!(
            first_details.load(Ordering::SeqCst),
            1 + usize::from(failure_at == "detail"),
            "A partial body from the failed page must be fetched again after manual resume"
        );
        let saved = server.app.settings().await.unwrap();
        let job = &saved["imports"][A];
        assert_eq!(job["id"], resumed_job["id"]);
        assert_eq!(job["cursor"], "next-history-page");
        assert_eq!(job["folderIndex"], checkpoint["folderIndex"]);
        assert_eq!(
            job["pages"], 2,
            "Only the successful page advances progress"
        );
        assert_eq!(job["processed"], 3);
        assert_eq!(job["imported"], 3);
        assert_eq!(job["status"], "running");
        assert!(job["errorCode"].is_null());
        assert!(job["nextRetryAt"].is_null());
        assert_eq!(saved["mailAccounts"], original["mailAccounts"]);
        server
            .app
            .db(|db| {
                for id in ["google:partial-first", "google:partial-second"] {
                    assert_eq!(
                        db.get(A, id)?.unwrap()["body"],
                        "Fresh manually resumed page"
                    );
                    assert!(db.get(B, id)?.is_none());
                }
                assert!(db.get(A, "prior-history-row")?.is_some());
                Ok(())
            })
            .await
            .unwrap();
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_history_expired_token_failure_requires_manual_resume_before_another_exchange() {
    for (mode, code, recovery) in [
        (0, "authorization", "reconnect"),
        (1, "import_failed", "resume"),
        (2, "import_failed", "resume"),
        (3, "import_failed", "resume"),
        (4, "import_failed", "resume"),
        (5, "import_failed", "resume"),
    ] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let (calls, pages, allow) = (exchanges.clone(), reads.clone(), accepted.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (calls, pages, allow) = (calls.clone(), pages.clone(), allow.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    assert_eq!(request.method, "POST");
                    assert_eq!(request.path, "/token");
                    let fields = form(&request);
                    assert_eq!(fields["client_id"], "fixture-client");
                    assert_eq!(fields["client_secret"], "fixture-secret");
                    assert_eq!(fields["grant_type"], "refresh_token");
                    assert_eq!(fields["refresh_token"], "refresh-a@example.invalid");
                    calls.fetch_add(1, Ordering::SeqCst);
                    if allow.load(Ordering::SeqCst) == 1 {
                        return Reply::Json(200, refreshed_token(Some("manual-resume-refresh")));
                    }
                    return match mode {
                        0 => Reply::Json(400, json!({"error":"invalid_grant","error_description":"PRIVATE_TOKEN_DETAIL"})),
                        1 => Reply::Json(401, json!({"error":"invalid_client","error_description":"PRIVATE_TOKEN_DETAIL"})),
                        2 => Reply::Json(503, json!({"error":"PRIVATE_TOKEN_DETAIL"})),
                        3 => Reply::Json(429, json!({"error":"PRIVATE_TOKEN_DETAIL"})),
                        4 => Reply::Lost,
                        _ => Reply::Json(200, json!({"access_token":"","expires_in":3600})),
                    };
                }
                assert_eq!(request.host(), "gmail.googleapis.com");
                assert_eq!(request.method, "GET");
                assert_eq!(bearer(&request), format!("Bearer {FRESH}"));
                assert!(request.path.contains("pageToken=saved-history-page"));
                pages.fetch_add(1, Ordering::SeqCst);
                Reply::Json(200, json!({"messages":[],"nextPageToken":"after-manual-resume"}))
            }.boxed()
        })).await;
        let server = fixture.start().await;
        let mut original = config(&[(A, "google"), (B, "google")]);
        original["preferences"]["syncInterval"] = 0.into();
        original["policy"] = json!({"enabled":false});
        original["mailAccounts"][A]["expiresAt"] = 0.into();
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let checkpoint = start_checkpointed_history(&server).await;
        morrow_search::background::tick(&server.app).await.unwrap();
        let saved = server.app.settings().await.unwrap();
        let failed = saved["imports"][A].clone();
        assert_history_checkpoint(&failed, &checkpoint);
        assert_eq!(failed["status"], "failed", "mode {mode}");
        assert_eq!(failed["errorCode"], code, "mode {mode}");
        assert_eq!(failed["recoveryAction"], recovery, "mode {mode}");
        assert!(failed["nextRetryAt"].is_null());
        assert_safe(&failed);
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            1,
            "The normal expiry refresh is attempted only once"
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "Failed authentication cannot proceed to the history page"
        );
        assert_eq!(saved["mailAccounts"], original["mailAccounts"]);
        assert_cache(&server.app).await;

        accepted.store(1, Ordering::SeqCst);
        for _ in 0..2 {
            morrow_search::background::tick(&server.app).await.unwrap();
        }
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(server.app.settings().await.unwrap()["imports"][A], failed);
        server.shutdown().await;
        let server = fixture.start().await;
        morrow_search::background::tick(&server.app).await.unwrap();
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            1,
            "Restart must not retry a failed routine token refresh"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(server.app.settings().await.unwrap()["imports"][A], failed);

        let resumed = server
            .call("POST", "/api/imports/resume", A, json!({}))
            .await;
        assert_eq!(resumed.0, 200, "{}", resumed.1);
        assert_safe(&resumed.1);
        let resumed_job = server.app.settings().await.unwrap()["imports"][A].clone();
        assert_ne!(resumed_job["id"], checkpoint["id"]);
        assert_eq!(resumed_job["cursor"], checkpoint["cursor"]);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        morrow_search::background::tick(&server.app).await.unwrap();
        assert_eq!(
            exchanges.load(Ordering::SeqCst),
            2,
            "Explicit manual resume permits exactly one new expiry refresh"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let saved = server.app.settings().await.unwrap();
        let job = &saved["imports"][A];
        assert_eq!(job["id"], resumed_job["id"]);
        assert_eq!(job["cursor"], "after-manual-resume");
        assert_eq!(job["pages"], 2);
        assert_eq!(job["processed"], checkpoint["processed"]);
        assert_eq!(job["imported"], checkpoint["imported"]);
        assert_eq!(job["status"], "running");
        assert!(job["errorCode"].is_null());
        assert_eq!(
            saved["mailAccounts"][A]["refreshToken"],
            "manual-resume-refresh"
        );
        assert_eq!(
            saved["mailAccounts"][A]["connectionId"],
            original["mailAccounts"][A]["connectionId"]
        );
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_history_preemptive_expiry_refresh_can_read_the_original_checkpoint() {
    let exchanges = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let (calls, pages) = (exchanges.clone(), reads.clone());
    let fixture = Fixture::new(Arc::new(move |request| {
        let (calls, pages) = (calls.clone(), pages.clone());
        async move {
            if request.host() == "oauth2.googleapis.com" {
                assert_eq!(request.method, "POST");
                assert_eq!(request.path, "/token");
                let fields = form(&request);
                assert_eq!(fields["client_id"], "fixture-client");
                assert_eq!(fields["client_secret"], "fixture-secret");
                assert_eq!(fields["grant_type"], "refresh_token");
                assert_eq!(fields["refresh_token"], "refresh-a@example.invalid");
                calls.fetch_add(1, Ordering::SeqCst);
                return Reply::Json(200, refreshed_token(None));
            }
            assert_eq!(request.host(), "gmail.googleapis.com");
            assert_eq!(request.method, "GET");
            assert_eq!(bearer(&request), format!("Bearer {FRESH}"));
            assert!(request.path.contains("pageToken=saved-history-page"));
            pages.fetch_add(1, Ordering::SeqCst);
            Reply::Json(
                200,
                json!({"messages":[],"nextPageToken":"next-after-expiry"}),
            )
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    let mut original = config(&[(A, "google"), (B, "google")]);
    original["preferences"]["syncInterval"] = 0.into();
    original["policy"] = json!({"enabled":false});
    original["mailAccounts"][A]["expiresAt"] = 0.into();
    set(&server.app, original.clone()).await;
    seed_cache(&server.app).await;
    let checkpoint = start_checkpointed_history(&server).await;
    morrow_search::background::tick(&server.app).await.unwrap();
    assert_eq!(exchanges.load(Ordering::SeqCst), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let saved = server.app.settings().await.unwrap();
    let job = &saved["imports"][A];
    assert_eq!(job["id"], checkpoint["id"]);
    assert_eq!(job["cursor"], "next-after-expiry");
    assert_eq!(job["pages"], 2);
    assert_eq!(job["processed"], checkpoint["processed"]);
    assert_eq!(job["imported"], checkpoint["imported"]);
    assert_eq!(job["status"], "running");
    assert!(job["errorCode"].is_null());
    assert_eq!(saved["mailAccounts"][A]["accessToken"], FRESH);
    assert_eq!(
        saved["mailAccounts"][A]["refreshToken"],
        original["mailAccounts"][A]["refreshToken"]
    );
    assert_eq!(
        saved["mailAccounts"][A]["connectionId"],
        original["mailAccounts"][A]["connectionId"]
    );
    assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
    assert_cache(&server.app).await;
    server.shutdown().await;
}

#[tokio::test]
async fn gmail_401_read_recovery_does_not_expand_to_outlook_resource_requests() {
    let exchanges = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let (calls, resources) = (exchanges.clone(), reads.clone());
    let fixture = Fixture::new(Arc::new(move |request| {
        let (calls, resources) = (calls.clone(), resources.clone());
        async move {
            if request.host() == "login.microsoftonline.com" {
                calls.fetch_add(1, Ordering::SeqCst);
                return Reply::Json(200, refreshed_token(None));
            }
            assert_eq!(request.host(), "graph.microsoft.com");
            assert_eq!(request.method, "GET");
            resources.fetch_add(1, Ordering::SeqCst);
            unauthorized()
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    let original = config(&[(A, "microsoft"), (B, "google")]);
    set(&server.app, original.clone()).await;
    let result = server.call("GET", "/api/mail/folders", A, json!({})).await;
    assert_ne!(result.0, 200);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(exchanges.load(Ordering::SeqCst), 0);
    assert_eq!(
        server.app.settings().await.unwrap()["mailAccounts"],
        original["mailAccounts"]
    );
    server.shutdown().await;
}

async fn begin_oauth(server: &Running, body: Value) -> (String, String) {
    let started = server
        .call("POST", "/api/oauth/google/start", A, body)
        .await;
    assert_eq!(started.0, 200, "{}", started.1);
    let authorize = url::Url::parse(string(&started.1, "url")).unwrap();
    let response = server
        .client
        .get(format!(
            "{}{}?{}",
            server.base,
            authorize.path(),
            authorize.query().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let external = url::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    let query = external.query_pairs().collect::<HashMap<_, _>>();
    assert_eq!(query["prompt"], "consent");
    assert_eq!(query["access_type"], "offline");
    assert_eq!(query["code_challenge_method"], "S256");
    (
        format!(
            "{}/api/oauth/google/callback?state={}&code=fixture-code",
            server.base, query["state"]
        ),
        cookie,
    )
}
async fn finish_oauth(server: &Running, attempt: (String, String), connected: bool) -> url::Url {
    let response = server
        .client
        .get(attempt.0)
        .header("cookie", attempt.1)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    let destination = url::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(
        destination
            .query_pairs()
            .any(|(k, v)| k == "connected" && v == "google"),
        connected,
        "{destination}"
    );
    assert_eq!(
        destination
            .query_pairs()
            .any(|(k, _)| k == "connectionError"),
        !connected,
        "{destination}"
    );
    assert_safe(&json!(destination.as_str()));
    destination
}
fn oauth_credentials() -> Value {
    json!({"clientId":"fixture-client","clientSecret":"fixture-secret"})
}
fn oauth_fixture(tokens: Value, email: &'static str, exchanges: Arc<AtomicUsize>) -> Handler {
    Arc::new(move |request| {
        let (tokens, exchanges) = (tokens.clone(), exchanges.clone());
        async move {
            if request.host() == "oauth2.googleapis.com" {
                let fields = form(&request);
                assert_eq!(fields["grant_type"], "authorization_code");
                assert!((43..=128).contains(&fields["code_verifier"].len()));
                exchanges.fetch_add(1, Ordering::SeqCst);
                return Reply::Json(200, tokens);
            }
            if request.path.ends_with("/profile") {
                return Reply::Json(200, json!({"emailAddress":email}));
            }
            empty_read(&request)
        }
        .boxed()
    })
}

#[tokio::test]
async fn gmail_reconnect_same_grant_keeps_only_refresh_token_and_renews_after_restart() {
    for missing in [None, Some(""), Some("  \t ")] {
        let authorizations = Arc::new(AtomicUsize::new(0));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let (auth, renew) = (authorizations.clone(), refreshes.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (auth, renew) = (auth.clone(), renew.clone());
            async move {
                if request.host() == "oauth2.googleapis.com" {
                    let fields = form(&request);
                    if fields["grant_type"] == "authorization_code" {
                        auth.fetch_add(1, Ordering::SeqCst);
                        assert!((43..=128).contains(&fields["code_verifier"].len()));
                        let mut token = refreshed_token(missing);
                        token["scope"] = format!("  {MODIFY}  {VACATION} {MODIFY}  ").into();
                        return Reply::Json(200, token);
                    }
                    assert_eq!(fields["grant_type"], "refresh_token");
                    assert_eq!(fields["refresh_token"], "refresh-a@example.invalid");
                    assert_eq!(fields["client_id"], "fixture-client");
                    assert_eq!(fields["client_secret"], "fixture-secret");
                    renew.fetch_add(1, Ordering::SeqCst);
                    return Reply::Json(200, refreshed_token(Some("restart-rotated")));
                }
                if request.path.ends_with("/profile") {
                    return Reply::Json(200, json!({"emailAddress":"A@EXAMPLE.INVALID"}));
                }
                empty_read(&request)
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        let mut original = config(&[(A, "google"), (B, "google")]);
        original["mailAccounts"][A]["grantedScopes"] = format!("{VACATION} {MODIFY}").into();
        original["mailAccounts"][A]["expiresAt"] = 1.into();
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let attempt = begin_oauth(&server, oauth_credentials()).await;
        finish_oauth(&server, attempt, true).await;
        let saved = server.app.settings().await.unwrap();
        assert_eq!(saved["mailAccounts"].as_object().unwrap().len(), 2);
        assert_eq!(saved["mailAccounts"][A]["email"], A);
        assert_eq!(
            saved["mailAccounts"][A]["refreshToken"],
            "refresh-a@example.invalid"
        );
        assert_eq!(saved["mailAccounts"][A]["accessToken"], FRESH);
        assert!(
            saved["mailAccounts"][A]["expiresAt"].as_i64().unwrap()
                > chrono::Utc::now().timestamp_millis()
        );
        assert_eq!(
            saved["mailAccounts"][A]["grantedScopes"],
            format!("  {MODIFY}  {VACATION} {MODIFY}  ")
        );
        assert_ne!(
            saved["mailAccounts"][A]["connectionId"],
            original["mailAccounts"][A]["connectionId"]
        );
        assert_eq!(saved["mail"]["refreshToken"], "refresh-a@example.invalid");
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_eq!(authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(
            refreshes.load(Ordering::SeqCst),
            0,
            "Fallback must not perform a hidden refresh exchange"
        );
        assert_cache(&server.app).await;
        server.shutdown().await;
        let server = fixture.start().await;
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"][A]["refreshToken"],
            "refresh-a@example.invalid"
        );
        expire_owner(&server.app).await;
        assert_eq!(
            server
                .call("GET", "/api/mail/folders", A, json!({}))
                .await
                .0,
            200
        );
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"][A]["refreshToken"],
            "restart-rotated"
        );
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_reconnect_missing_refresh_rejects_mismatched_identity_or_grant_without_overwrite() {
    for case in [
        "new-owner",
        "provider",
        "client",
        "secret",
        "email",
        "purpose",
        "old-empty-token",
        "old-blank-token",
        "old-empty-client",
        "old-empty-scopes",
        "new-empty-scopes",
        "scope-expansion",
        "scope-contraction",
    ] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let mut original = config(&[(A, "google"), (B, "google")]);
        let mut tokens = refreshed_token(Some("  "));
        tokens["scope"] = MODIFY.into();
        let email = if case == "new-owner" { C } else { A };
        match case {
            "provider" => original["mailAccounts"][A]["provider"] = "microsoft".into(),
            "client" => original["mailAccounts"][A]["clientId"] = "different-client".into(),
            "secret" => original["mailAccounts"][A]["clientSecret"] = "different-secret".into(),
            "email" => original["mailAccounts"][A]["email"] = B.into(),
            "purpose" => original["mailAccounts"][A]["purpose"] = "calendar".into(),
            "old-empty-token" => original["mailAccounts"][A]["refreshToken"] = "".into(),
            "old-blank-token" => original["mailAccounts"][A]["refreshToken"] = " \t ".into(),
            "old-empty-client" => original["mailAccounts"][A]["clientId"] = "".into(),
            "old-empty-scopes" => original["mailAccounts"][A]["grantedScopes"] = " \t ".into(),
            "new-empty-scopes" => tokens["scope"] = " ".into(),
            "scope-expansion" => tokens["scope"] = format!("{MODIFY} {VACATION}").into(),
            "scope-contraction" => {
                original["mailAccounts"][A]["grantedScopes"] = format!("{MODIFY} {VACATION}").into()
            }
            _ => {}
        }
        let fixture = Fixture::new(oauth_fixture(tokens, email, exchanges.clone())).await;
        let server = fixture.start().await;
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let before = server.app.settings().await.unwrap();
        let attempt = begin_oauth(&server, oauth_credentials()).await;
        finish_oauth(&server, attempt, false).await;
        let saved = server.app.settings().await.unwrap();
        assert_eq!(saved["mailAccounts"], before["mailAccounts"], "{case}");
        assert_eq!(saved["mail"], before["mail"], "{case}");
        assert_eq!(saved["activeAccount"], before["activeAccount"], "{case}");
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_cache(&server.app).await;
        server.shutdown().await;
        let server = fixture.start().await;
        assert_eq!(
            server.app.settings().await.unwrap()["mailAccounts"],
            before["mailAccounts"],
            "{case} after restart"
        );
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_reconnect_new_refresh_token_takes_precedence_over_the_previous_grant() {
    let exchanges = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(oauth_fixture(
        merge(
            refreshed_token(Some("new-grant-refresh")),
            &json!({"scope":MODIFY}),
        ),
        A,
        exchanges.clone(),
    ))
    .await;
    let server = fixture.start().await;
    let mut original = config(&[(A, "google"), (B, "google")]);
    original["mailAccounts"][A]["clientId"] = "previous-client".into();
    original["mailAccounts"][A]["clientSecret"] = "previous-secret".into();
    original["mailAccounts"][A]["grantedScopes"] = format!("{MODIFY} {VACATION}").into();
    set(&server.app, original.clone()).await;
    seed_cache(&server.app).await;
    let attempt = begin_oauth(&server, oauth_credentials()).await;
    finish_oauth(&server, attempt, true).await;
    let saved = server.app.settings().await.unwrap();
    assert_eq!(
        saved["mailAccounts"][A]["refreshToken"],
        "new-grant-refresh"
    );
    assert_eq!(saved["mailAccounts"][A]["clientId"], "fixture-client");
    assert_eq!(saved["mailAccounts"][A]["clientSecret"], "fixture-secret");
    assert_eq!(saved["mailAccounts"][A]["grantedScopes"], MODIFY);
    assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
    assert_cache(&server.app).await;
    server.shutdown().await;
}

#[tokio::test]
async fn gmail_reconnect_open_attempt_rejects_changed_grant_but_uses_current_rotated_token() {
    for case in ["secret", "scope", "purpose", "rotation", "scope-order"] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let scopes = format!("{MODIFY} {VACATION}");
        let fixture = Fixture::new(oauth_fixture(
            merge(refreshed_token(None), &json!({"scope":scopes})),
            A,
            exchanges.clone(),
        ))
        .await;
        let server = fixture.start().await;
        let mut original = config(&[(A, "google"), (B, "google")]);
        original["mailAccounts"][A]["grantedScopes"] = scopes.clone().into();
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let attempt = begin_oauth(&server, oauth_credentials()).await;
        server
            .app
            .db(move |db| {
                let mut accounts = connections(&db.settings()?);
                match case {
                    "secret" => accounts[A]["clientSecret"] = "changed-during-browser".into(),
                    "scope" => accounts[A]["grantedScopes"] = MODIFY.into(),
                    "purpose" => accounts[A]["purpose"] = "calendar".into(),
                    "scope-order" => {
                        accounts[A]["grantedScopes"] =
                            format!(" {VACATION}  {MODIFY} {VACATION} ").into()
                    }
                    _ => {
                        accounts[A]["accessToken"] = "concurrent-rotated-access".into();
                        accounts[A]["refreshToken"] = "concurrent-rotated-refresh".into();
                        accounts[A]["expiresAt"] =
                            (chrono::Utc::now().timestamp_millis() + 7200000).into();
                    }
                }
                db.set_settings(&json!({"mailAccounts":accounts}))?;
                Ok(())
            })
            .await
            .unwrap();
        let before = server.app.settings().await.unwrap();
        let accepted = ["rotation", "scope-order"].contains(&case);
        finish_oauth(&server, attempt, accepted).await;
        let saved = server.app.settings().await.unwrap();
        if accepted {
            let expected = if case == "rotation" {
                "concurrent-rotated-refresh"
            } else {
                "refresh-a@example.invalid"
            };
            assert_eq!(saved["mailAccounts"][A]["refreshToken"], expected);
            assert_eq!(saved["mailAccounts"][A]["accessToken"], FRESH);
        } else {
            assert_eq!(saved["mailAccounts"], before["mailAccounts"], "{case}");
        }
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}

#[tokio::test]
async fn gmail_reconnect_out_of_office_scope_upgrade_requires_a_new_refresh_grant() {
    for new_refresh in [false, true] {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let token = merge(
            refreshed_token(new_refresh.then_some("upgraded-refresh")),
            &json!({"scope":format!("{MODIFY} {VACATION}")}),
        );
        let fixture = Fixture::new(oauth_fixture(token, A, exchanges.clone())).await;
        let server = fixture.start().await;
        let original = config(&[(A, "google"), (B, "google")]);
        set(&server.app, original.clone()).await;
        seed_cache(&server.app).await;
        let attempt = begin_oauth(&server, json!({"forAccount":A,"outOfOffice":true})).await;
        finish_oauth(&server, attempt, new_refresh).await;
        let saved = server.app.settings().await.unwrap();
        if new_refresh {
            assert_eq!(saved["mailAccounts"][A]["refreshToken"], "upgraded-refresh");
            assert_eq!(
                saved["mailAccounts"][A]["connectionId"],
                original["mailAccounts"][A]["connectionId"]
            );
            assert!(!string(&saved["mailAccounts"][A], "authorizationId").is_empty());
            assert_eq!(
                saved["mailAccounts"][A]["grantedScopes"],
                format!("{MODIFY} {VACATION}")
            );
        } else {
            assert_eq!(saved["mailAccounts"], original["mailAccounts"]);
            assert_eq!(saved["mail"], original["mail"]);
        }
        assert_eq!(saved["mailAccounts"][B], original["mailAccounts"][B]);
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_cache(&server.app).await;
        server.shutdown().await;
    }
}
