use morrow_search::{
    cli::{self, Command as CliCommand},
    service::App,
    store::Store,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("morrow-cli-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&path).unwrap();
        db.set_settings(&json!({"mailAccounts":{
            "a@example.invalid":{"provider":"google","email":"a@example.invalid","accessToken":"fixture-secret","connectionId":"a1"},
            "b@example.invalid":{"provider":"microsoft","email":"b@example.invalid","connectionId":"b1"}},
            "preferences":{"syncInterval":0,"displayName":"Fixture","signature":"Sent with fixture"},"policy":{"enabled":false}})).unwrap();
        for account in ["a@example.invalid", "b@example.invalid"] {
            for i in 0..65 {
                db.upsert(account,&json!({"id":format!("same-{i}"),"folder":"inbox","subject":"invoice fixture","body":format!("Private body {account}"),"date":"2026-09-25T00:00:00.000Z","read":false})).unwrap();
            }
        }
        drop(db);
        // Parallel process launches can briefly inherit a seed's flock until exec.
        // Confirm that the closed fixture can hand off its writer before testing it.
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join("writer.lock"))
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match lock.try_lock() {
                Ok(()) => {
                    lock.unlock().unwrap();
                    break;
                }
                Err(fs::TryLockError::WouldBlock) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "Closed fixture still holds its writer lock"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("Fixture writer handoff failed: {error}"),
            }
        }
        Self(path)
    }
    fn cli(&self, args: &[&str], input: Option<&Value>, code: i32) -> Value {
        // No shell and no credentials in the process arguments.
        let mut child = Command::new(env!("CARGO_BIN_EXE_morrow-service"));
        child
            .arg("cli")
            .args(args)
            .arg("--workspace")
            .arg(&self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = child.spawn().unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(input).unwrap().as_bytes())
                .unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn status_exposes_owned_incomplete_content_without_a_history_job() {
    let fixture = Fixture::new();
    let app = App::open(&fixture.0, 0, "fixture-native-token".into(), String::new()).unwrap();
    app.db(|db| {
        db.update(
            "a@example.invalid",
            "same-0",
            &json!({"contentIncomplete":true,"contentErrorCode":"google_mime_limit"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let status = cli::execute(
        &app,
        CliCommand::Status {
            account: "all".into(),
        },
    )
    .await
    .unwrap();
    let accounts = status["accounts"].as_array().unwrap();
    let a = accounts
        .iter()
        .find(|a| a["accountId"] == "a@example.invalid")
        .unwrap();
    let b = accounts
        .iter()
        .find(|a| a["accountId"] == "b@example.invalid")
        .unwrap();
    assert!(a["history"].is_null());
    assert_eq!(a["incompleteMessages"], 1);
    assert!(!a["contentWarning"].as_str().unwrap().is_empty());
    assert_eq!(b["incompleteMessages"], 0);
    assert_eq!(b["contentWarning"], "");
    assert!(!status.to_string().contains("fixture-secret"));
}
struct Server(Child);
impl Server {
    fn start(path: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_morrow-service"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        writeln!(
            child.stdin.as_mut().unwrap(),
            "{}",
            json!({"dataDirectory":path,"token":"a".repeat(64),"updateToken":"b".repeat(64)})
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(
            serde_json::from_str::<Value>(&line).unwrap()["port"]
                .as_u64()
                .unwrap()
                > 0
        );
        Self(child)
    }
    fn stop(&mut self) {
        drop(self.0.stdin.take());
        assert!(self.0.wait().unwrap().success());
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn executable_closed_and_running_app_share_owned_data_and_reviewed_send() {
    let fixture = Fixture::new();
    let accounts = fixture.cli(&["accounts"], None, 0);
    assert!(!accounts.to_string().contains("fixture-secret"));
    assert_eq!(accounts["data"]["accounts"].as_array().unwrap().len(), 3);
    for running in [false, true] {
        let mut server = running.then(|| Server::start(&fixture.0));
        let mut identities = std::collections::HashSet::new();
        for page in 1..=3 {
            let result = fixture.cli(
                &["list", "--account", "all", "--page", &page.to_string()],
                None,
                0,
            );
            assert_eq!(result["data"]["total"], 130);
            for row in result["data"]["messages"].as_array().unwrap() {
                assert!(row.get("body").is_none());
                assert!(identities.insert(row["viewId"].clone().to_string()));
            }
        }
        assert_eq!(identities.len(), 130);
        let a = fixture.cli(
            &["read", "--account", "A@example.invalid", "--id", "same-0"],
            None,
            0,
        );
        assert_eq!(
            a["data"]["message"]["body"],
            "Private body a@example.invalid"
        );
        assert_eq!(a["data"]["message"]["read"], false);
        let search = fixture.cli(
            &["search", "--account", "all", "--query", "invoice"],
            None,
            0,
        );
        assert_eq!(search["data"]["total"], 130);
        assert_eq!(search["data"]["mode"], "keyword");
        fixture.cli(&["read", "--account", "all", "--id", "same-0"], None, 3);
        fixture.cli(
            &[
                "read",
                "--account",
                "missing@example.invalid",
                "--id",
                "same-0",
            ],
            None,
            3,
        );
        let mut draft = json!({"to":"to@example.invalid","cc":"cc@example.invalid","bcc":"bcc@example.invalid","subject":"CLI fixture","body":"Explicit simulated send"});
        let saved = fixture.cli(
            &["draft", "--account", "demo", "--input", "-"],
            Some(&draft),
            0,
        );
        let id = saved["data"]["message"]["id"].as_str().unwrap();
        let review = fixture.cli(&["review", "--account", "demo", "--id", id], None, 0);
        assert_eq!(
            review["data"]["message"]["footer"]["text"],
            "Sent with fixture"
        );
        fixture.cli(&["send", "--input", "-"], Some(&review), 2);
        draft["id"] = id.into();
        draft["body"] = "Edited after review".into();
        fixture.cli(
            &["draft", "--account", "demo", "--input", "-"],
            Some(&draft),
            0,
        );
        fixture.cli(&["send", "--input", "-", "--confirm"], Some(&review), 3);
        let review = fixture.cli(&["review", "--account", "demo", "--id", id], None, 0);
        let sent = fixture.cli(&["send", "--input", "-", "--confirm"], Some(&review), 0);
        assert_eq!(sent["data"]["simulated"], true);
        for field in ["to", "cc", "bcc"] {
            assert_eq!(sent["data"]["message"][field], draft[field]);
        }
        let replay = fixture.cli(&["send", "--input", "-", "--confirm"], Some(&review), 0);
        assert_eq!(sent, replay);
        if let Some(server) = &mut server {
            server.stop();
            assert!(!fixture.0.join("cli.json").exists());
        }
    }
    let db = Store::open(&fixture.0).unwrap();
    assert_eq!(
        db.get("a@example.invalid", "same-0").unwrap().unwrap()["read"],
        false
    );
    fixture.cli(&["accounts"], None, 3); // No live endpoint: standalone must still honor the writer lock.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoped_token_origin_input_limits_and_stale_endpoint() {
    let fixture = Fixture::new();
    let mut server = Server::start(&fixture.0);
    let endpoint: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("cli.json")).unwrap()).unwrap();
    let base = format!("http://127.0.0.1:{}", endpoint["port"]);
    let token = endpoint["token"].as_str().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    for path in [
        "/api/state",
        "/api/settings/mail",
        "/api/backup",
        "/api/updates/install",
    ] {
        assert_eq!(
            client
                .post(format!("{base}{path}"))
                .bearer_auth(token)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    assert_eq!(
        client
            .post(format!("{base}/api/cli"))
            .json(&json!({"command":"accounts"}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(format!("{base}/api/cli"))
            .bearer_auth(token)
            .header("Origin", "https://example.invalid")
            .json(&json!({"command":"accounts"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(format!("{base}/api/cli"))
            .bearer_auth(token)
            .json(&json!({"command":"accounts","url":"https://example.invalid"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .post(format!("{base}/api/cli"))
            .bearer_auth(token)
            .json(&json!({"command":"settings"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .post(format!("{base}/api/cli"))
            .bearer_auth(token)
            .json(
                &json!({"command":"draft","account":"demo","message":{"body":"x".repeat(256*1024)}})
            )
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(fixture.0.join("cli.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let captured_health: Value = client
        .get(format!("{base}/api/cli/health?nonce={}", "c".repeat(64)))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(captured_health["proof"].as_str().unwrap().len(), 64);
    assert!(cli::healthy(&fixture.0).await.unwrap());
    assert_eq!(
        client
            .get(format!("{base}/api/cli/health"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let mut wrong = endpoint.clone();
    wrong["token"] = "0".repeat(64).into();
    fs::write(
        fixture.0.join("cli.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.cli(&["accounts"], None, 3)["status"], 409);
    assert!(!cli::healthy(&fixture.0).await.unwrap());
    fs::write(fixture.0.join("cli.json"), b"{").unwrap();
    assert!(!cli::healthy(&fixture.0).await.unwrap());
    fs::write(
        fixture.0.join("cli.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.0.join("cli.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        fixture.cli(&["accounts"], None, 2);
        fs::set_permissions(
            fixture.0.join("cli.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let copy = Fixture::new();
    morrow_search::store::private_file(
        &copy.0.join("cli.json"),
        &serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    morrow_search::store::private(&copy.0.join("cli.json"), false).unwrap();
    let saved = copy.cli(
        &["draft", "--account", "demo", "--input", "-"],
        Some(&json!({"to":"copy@example.invalid","body":"Only in copied workspace"})),
        0,
    );
    let id = saved["data"]["message"]["id"].as_str().unwrap();
    assert_eq!(
        fixture.cli(&["read", "--account", "demo", "--id", id], None, 1)["status"],
        404
    );
    copy.cli(&["read", "--account", "demo", "--id", id], None, 0);
    server.stop();
    morrow_search::store::private_file(
        &fixture.0.join("cli.json"),
        &serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    morrow_search::store::private(&fixture.0.join("cli.json"), false).unwrap();
    fixture.cli(&["accounts"], None, 0);
    // A process reusing a stale port must not receive the bearer or command contents.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut impostor = endpoint.clone();
    impostor["port"] = listener.local_addr().unwrap().port().into();
    fs::write(
        fixture.0.join("cli.json"),
        serde_json::to_vec(&impostor).unwrap(),
    )
    .unwrap();
    let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let received = observed.clone();
    let router =
        axum::Router::new().fallback(move |request: axum::http::Request<axum::body::Body>| {
            let received = received.clone();
            let captured = captured_health.clone();
            async move {
                let (parts, body) = request.into_parts();
                let body = axum::body::to_bytes(body, 256 * 1024).await.unwrap();
                received.lock().unwrap().push((parts.headers, body));
                axum::Json(captured)
            }
        });
    let fake = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    fixture.cli(
        &["draft", "--account", "demo", "--input", "-"],
        Some(&json!({"body":"Must not reach impostor"})),
        3,
    );
    {
        let requests = observed.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].0.contains_key("authorization"));
        assert!(requests[0].1.is_empty());
    }
    fake.abort();
    fs::remove_file(fixture.0.join("cli.json")).unwrap();
    fixture.cli(&["accounts", "--confirm"], None, 2);
    fixture.cli(&["list", "--account", "all", "--page", "0"], None, 2);
}

#[tokio::test]
async fn changed_sender_connection_and_uncertain_delivery_require_new_review() {
    let fixture = Fixture::new();
    let app = App::open(&fixture.0, 0, "fixture".into(), String::new()).unwrap();
    let saved = cli::execute(&app,CliCommand::Draft { account:"a@example.invalid".into(),message:json!({"to":"to@example.invalid","bcc":"hidden@example.invalid","body":"fixture"}) }).await.unwrap();
    let id = saved["message"]["id"].as_str().unwrap().to_owned();
    let review = cli::execute(
        &app,
        CliCommand::Review {
            account: "a@example.invalid".into(),
            id: id.clone(),
        },
    )
    .await
    .unwrap();
    app.db(|db| {
        db.set_settings(&json!({"preferences":{"displayName":"Changed"}}))?;
        Ok(())
    })
    .await
    .unwrap();
    let send = || {
        serde_json::from_value::<CliCommand>(
            json!({"command":"send","review":review,"confirm":true,"retry_unconfirmed":false}),
        )
        .unwrap()
    };
    assert_eq!(cli::execute(&app, send()).await.unwrap_err().status, 409);
    app.db(|db| { db.set_settings(&json!({"preferences":{"displayName":"Fixture"},"mailAccounts":{"a@example.invalid":{"connectionId":"a2"}}}))?; Ok(()) }).await.unwrap();
    assert_eq!(cli::execute(&app, send()).await.unwrap_err().status, 409);
    app.db(move |db| { let mut draft=db.get("a@example.invalid",&id)?.unwrap(); draft["deliveryStatus"]="unconfirmed".into(); draft["deliveryRequestId"]="uncertain-fixture-id".into(); db.upsert("a@example.invalid",&draft)?; db.set_settings(&json!({"deliveryAttempts":[{"account":"a@example.invalid","draftId":id,"requestId":"uncertain-fixture-id","payloadHash":"fixture"}]}))?; Ok(()) }).await.unwrap();
    let review = cli::execute(
        &app,
        CliCommand::Review {
            account: "a@example.invalid".into(),
            id: saved["message"]["id"].as_str().unwrap().into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(review["requestId"], "uncertain-fixture-id");
    assert_eq!(review["unconfirmed"], true);
    let send = serde_json::from_value::<CliCommand>(
        json!({"command":"send","review":review,"confirm":true,"retry_unconfirmed":false}),
    )
    .unwrap();
    let error = cli::execute(&app, send).await.unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["requiresSendReview"], true);
}

#[test]
fn cli_sync_plan_status_and_owned_attachments_work_with_the_running_service() {
    let fixture = Fixture::new();
    let mut server = Server::start(&fixture.0);
    let plan = fixture.cli(&["sync", "--account", "all", "--dry-run"], None, 0);
    assert_eq!(plan["data"]["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(plan["data"]["providerWrites"], false);
    let status = fixture.cli(&["status", "--account", "a@example.invalid"], None, 0);
    assert_eq!(status["data"]["accounts"].as_array().unwrap().len(), 1);
    assert!(!status.to_string().contains("fixture-secret"));
    assert!(!status.to_string().contains("b@example.invalid"));
    let file = fixture.0.join("報告📎.bin");
    fs::write(&file, b"fictional attachment").unwrap();
    let item = fixture.cli(
        &[
            "attachment-add",
            "--account",
            "a@example.invalid",
            "--file",
            file.to_str().unwrap(),
        ],
        None,
        0,
    )["data"]["attachment"]
        .clone();
    assert_eq!(item["name"], "報告📎.bin");
    let data = fixture.cli(
        &[
            "attachment-read",
            "--account",
            "a@example.invalid",
            "--id",
            item["id"].as_str().unwrap(),
        ],
        None,
        0,
    );
    assert_eq!(
        data["data"]["attachment"]["data"],
        "ZmljdGlvbmFsIGF0dGFjaG1lbnQ="
    );
    fixture.cli(
        &[
            "attachment-read",
            "--account",
            "b@example.invalid",
            "--id",
            item["id"].as_str().unwrap(),
        ],
        None,
        3,
    );
    let draft = fixture.cli(&["draft","--account","a@example.invalid","--input","-"],Some(&json!({"to":"b@example.invalid","subject":"Attachment","body":"One","attachments":[item]})),0)["data"]["message"].clone();
    let updated = fixture.cli(
        &["draft", "--account", "a@example.invalid", "--input", "-"],
        Some(
            &json!({"id":draft["id"],"to":"b@example.invalid","subject":"Attachment","body":"Two"}),
        ),
        0,
    );
    assert_eq!(
        updated["data"]["message"]["attachments"],
        draft["attachments"]
    );
    let removed = fixture.cli(&["draft","--account","a@example.invalid","--input","-"],Some(&json!({"id":draft["id"],"to":"b@example.invalid","subject":"Attachment","body":"Three","attachments":[]})),0);
    assert!(
        removed["data"]["message"]["attachments"].is_null()
            || removed["data"]["message"]["attachments"] == json!([])
    );
    server.stop();
    for running in [false, true] {
        let mut restarted = running.then(|| Server::start(&fixture.0));
        let download = fixture.cli(
            &[
                "attachment-read",
                "--account",
                "a@example.invalid",
                "--id",
                item["id"].as_str().unwrap(),
            ],
            None,
            0,
        );
        assert_eq!(
            download, data,
            "Removing a draft reference must retain its owned attachment after restart."
        );
        let reopened = fixture.cli(
            &[
                "read",
                "--account",
                "a@example.invalid",
                "--id",
                draft["id"].as_str().unwrap(),
            ],
            None,
            0,
        );
        assert_eq!(reopened["data"]["message"]["id"], draft["id"]);
        assert_eq!(
            reopened["data"]["message"]["accountId"],
            "a@example.invalid"
        );
        assert!(
            reopened["data"]["message"]["attachments"].is_null()
                || reopened["data"]["message"]["attachments"] == json!([])
        );
        if let Some(server) = restarted.as_mut() {
            server.stop();
        }
    }
    fixture.cli(&["sync", "--account", "demo"], None, 0);
}

#[test]
fn partial_sync_has_its_own_exit_code_and_never_claims_complete_coverage() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    db.set_settings(&json!({"mailAccounts":{"a@example.invalid":{"email":"a@example.invalid","provider":"imap","connectionId":"invalid-port","imapPort":0}}})).unwrap();
    drop(db);
    let result = fixture.cli(&["sync", "--account", "a@example.invalid"], None, 4);
    assert_eq!(result["data"]["status"], "partial");
    assert_eq!(result["data"]["errors"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["data"]["coverage"],
        "bounded-recent-and-cached-metadata"
    );
}
