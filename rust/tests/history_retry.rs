use morrow_search::{background as jobs, service::App};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const OWNER: &str = "history@example.invalid";
struct LocalDns(std::net::SocketAddr);
impl reqwest::dns::Resolve for LocalDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let address = self.0;
        let allowed = name.as_str() == "gmail.googleapis.com";
        Box::pin(async move {
            if !allowed {
                return Err(std::io::Error::other("Non-fixture destination refused").into());
            }
            Ok(Box::new(std::iter::once(address)) as reqwest::dns::Addrs)
        })
    }
}
struct Fixture {
    app: Option<App>,
    root: PathBuf,
    status: Arc<AtomicU16>,
    calls: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("morrow-history-retry-{}", uuid::Uuid::new_v4()));
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["gmail.googleapis.com".into()]).unwrap();
        let tls = tokio_rustls::rustls::ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der())
                .into(),
        )
        .unwrap();
        let tls = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()])
            .dns_resolver(Arc::new(LocalDns(listener.local_addr().unwrap())))
            .build()
            .unwrap();
        let status = Arc::new(AtomicU16::new(429));
        let calls = Arc::new(AtomicUsize::new(0));
        let response_status = status.clone();
        let request_count = calls.clone();
        let server = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let tls = tls.clone();
                let status = response_status.clone();
                let calls = request_count.clone();
                tokio::spawn(async move {
                    let mut stream = tls.accept(socket).await.unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0; 2048];
                    loop {
                        let count = stream.read(&mut buffer).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..count]);
                        assert!(request.len() < 16_384);
                        if request.windows(4).any(|s| s == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let headers = String::from_utf8(request).unwrap();
                    assert!(headers.starts_with("GET /gmail/v1/users/me/messages?"));
                    assert!(
                        headers
                            .to_lowercase()
                            .contains("authorization: bearer fixture-token\r\n")
                    );
                    assert!(headers.contains("pageToken=private-checkpoint"));
                    calls.fetch_add(1, Ordering::SeqCst);
                    let status = status.load(Ordering::SeqCst);
                    if status == 0 {
                        return;
                    } // A broken local transport, never a live provider.
                    let body = match status {
                        200 => r#"{"messages":[]}"#,
                        403 => {
                            r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}],"message":"private provider body"}}"#
                        }
                        _ => "private provider body",
                    };
                    stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                    let _ = stream.shutdown().await;
                });
            }
        });
        let mut app = App::open(&root, 3011, String::new(), String::new()).unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = client;
        app.db(|db| {
            db.set_settings(&json!({"mailAccounts":{OWNER:{"email":OWNER,"provider":"google","connectionId":"original","accessToken":"fixture-token","expiresAt":chrono::Utc::now().timestamp_millis()+3600000}},"preferences":{"syncInterval":0}}))?;
            jobs::start_import(db, OWNER, &json!({"allMail":true}))?;
            let date = (chrono::Utc::now()-chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
            let job = db.settings()?["imports"][OWNER].clone();
            jobs::apply_import_page(db, OWNER, &job, &json!({"messages":[{"id":"google:first","date":date,"folder":"inbox"}],"nextCursor":"private-checkpoint"}))?;
            Ok(())
        }).await.unwrap();
        Self {
            app: Some(app),
            root,
            status,
            calls,
            server,
        }
    }
    fn app(&self) -> &App {
        self.app.as_ref().unwrap()
    }
    fn restart(&mut self) {
        let client = self.app().0.client.clone();
        drop(self.app.take());
        let mut app = App::open(&self.root, 3011, String::new(), String::new()).unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = client;
        self.app = Some(app);
    }
    async fn import(&self) -> Value {
        self.app()
            .db(|db| jobs::import_status(db, OWNER))
            .await
            .unwrap()
    }
    async fn due(&self) {
        self.app()
            .db(|db| {
                let mut imports = db.settings()?["imports"].clone();
                imports[OWNER]["nextRetryAt"] = "2000-01-01T00:00:00.000Z".into();
                db.set_settings(&json!({"imports":imports}))?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn actual_provider_reads_retry_durably_then_require_resume_and_keep_checkpoint() {
    let mut f = Fixture::new().await;
    for (count, (status, code, delay)) in [
        (429, "rate_limited", 30),
        (503, "provider_unavailable", 120),
        (0, "network_error", 300),
    ]
    .into_iter()
    .enumerate()
    {
        f.status.store(status, Ordering::SeqCst);
        let before = chrono::Utc::now();
        jobs::tick(f.app()).await.unwrap();
        let result = f.import().await;
        assert_eq!(result["status"], "running");
        assert_eq!(result["phase"], "retrying");
        assert_eq!(result["errorCode"], code);
        assert_eq!(result["retryCount"], count + 1);
        assert_eq!(result["recoveryAction"], "retry");
        let retry_at =
            chrono::DateTime::parse_from_rfc3339(result["nextRetryAt"].as_str().unwrap()).unwrap();
        assert!(retry_at.timestamp_millis() >= before.timestamp_millis() + delay * 1000);
        assert!(
            retry_at.timestamp_millis() <= chrono::Utc::now().timestamp_millis() + delay * 1000
        );
        assert_eq!(result["pages"], 1);
        assert_eq!(result["imported"], 1);
        assert!(!result.to_string().contains("private"));
        f.restart();
        f.app()
            .db(|db| {
                jobs::recover(db)?;
                assert_eq!(
                    db.settings()?["imports"][OWNER]["cursor"],
                    "private-checkpoint"
                );
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(f.import().await, result);
        let calls = f.calls.load(Ordering::SeqCst);
        jobs::tick(f.app()).await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), calls);
        f.due().await;
    }
    f.status.store(403, Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    let result = f.import().await;
    assert_eq!(result["status"], "failed");
    assert_eq!(result["errorCode"], "rate_limited");
    assert_eq!(result["recoveryAction"], "resume");
    assert_eq!(result["retryCount"], 3);
    assert!(result["nextRetryAt"].is_null());
    let calls = f.calls.load(Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.calls.load(Ordering::SeqCst), calls);
    f.app()
        .db(|db| jobs::control_import(db, OWNER, "resume"))
        .await
        .unwrap();
    assert_eq!(f.import().await["retryCount"], 0);
    f.status.store(200, Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    let result = f.import().await;
    assert_eq!(result["status"], "complete");
    assert_eq!(result["error"], "");
    assert!(result["errorCode"].is_null());
    assert_eq!(result["pages"], 2);
    assert_eq!(result["imported"], 1);
}

#[tokio::test]
async fn quota_retries_survive_restart_and_complete_without_manual_resume() {
    let mut f = Fixture::new().await;
    for (attempt, status) in [429, 403, 429].into_iter().enumerate() {
        f.status.store(status, Ordering::SeqCst);
        jobs::tick(f.app()).await.unwrap();
        let result = f.import().await;
        assert_eq!(result["status"], "running");
        assert_eq!(result["errorCode"], "rate_limited");
        assert_eq!(result["retryCount"], attempt + 1);
        assert!(result["nextRetryAt"].as_str().is_some());
        assert!(!result.to_string().contains("private"));
        if attempt == 0 {
            f.restart();
        }
        jobs::tick(f.app()).await.unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), attempt + 1);
        f.due().await;
    }
    f.status.store(200, Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.import().await["status"], "complete");
    assert_eq!(f.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn auth_failure_is_not_retried_and_reconnect_invalidates_delayed_work() {
    let f = Fixture::new().await;
    f.status.store(401, Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.import().await["status"], "failed");
    assert_eq!(f.import().await["recoveryAction"], "reconnect");
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    f.app()
        .db(|db| jobs::control_import(db, OWNER, "resume"))
        .await
        .unwrap();
    f.status.store(429, Ordering::SeqCst);
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.import().await["phase"], "retrying");
    f.app()
        .db(|db| {
            let mut accounts = db.settings()?["mailAccounts"].clone();
            accounts[OWNER]["connectionId"] = "reconnected".into();
            db.set_settings(&json!({"mailAccounts":accounts}))?;
            Ok(())
        })
        .await
        .unwrap();
    jobs::tick(f.app()).await.unwrap();
    assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    let result = f.import().await;
    assert_eq!(result["status"], "paused");
    assert_eq!(result["errorCode"], "connection_changed");
    assert_eq!(result["recoveryAction"], "restart");
    assert!(result["nextRetryAt"].is_null());
    assert!(
        f.app()
            .db(|db| jobs::control_import(db, OWNER, "resume"))
            .await
            .is_err()
    );
}

#[test]
fn stored_error_text_and_unrecognized_recovery_fields_never_leave_status_projection() {
    for code in [
        Value::Null,
        json!("RAW-PROVIDER-ERROR"),
        json!("authorization"),
        json!("invalid_cursor"),
    ] {
        let config = json!({"imports":{OWNER:{"status":"failed","options":{"inbox":true},"folderIndex":0,"error":"RAW-PROVIDER-ERROR secret-token private-id","errorCode":code,"recoveryAction":"secret-token"}}});
        let status = jobs::import_status_from(&config, OWNER);
        for secret in ["RAW-PROVIDER-ERROR", "secret-token", "private-id"] {
            assert!(!status.to_string().contains(secret));
        }
        assert_eq!(
            status["recoveryAction"],
            if code == "authorization" {
                "reconnect"
            } else if code == "invalid_cursor" {
                "restart"
            } else {
                "resume"
            }
        );
        assert!(!status["error"].as_str().unwrap().is_empty());
    }
}
