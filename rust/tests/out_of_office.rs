use axum::{
    body::to_bytes,
    http::{HeaderMap, Method},
};
use morrow_search::{error, out_of_office, service, store};
use serde_json::{Value, json};
use service::{App, Context};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const OWNER: &str = "one@example.invalid";
fn input() -> Value {
    json!({"action":"save","confirmed":true,"mode":"scheduled","start":"2090-10-01T08:00:00.000Z","end":"2090-10-02T09:00:00.000Z",
        "subject":"Away","message":"<script>literal</script>\nBack soon.","externalMessage":"External only","audience":"contacts","restrictToDomain":false})
}
struct Fixture {
    root: PathBuf,
    task: tokio::task::JoinHandle<()>,
    calls: Arc<Mutex<Vec<Value>>>,
    raw: Arc<Mutex<Value>>,
    fail_write: Arc<Mutex<bool>>,
    race_after_reads: Arc<Mutex<u8>>,
    client: reqwest::Client,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new(provider: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("morrow-out-of-office-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let raw = Arc::new(Mutex::new(if provider == "google" {
            json!({"enableAutoReply":true,"responseBodyHtml":"<b>Provider formatted</b>","responseBodyPlainText":"stale alternative","responseSubject":"Original","restrictToContacts":true,"restrictToDomain":true,"startTime":"3810528000000","endTime":"3810614400000"})
        } else {
            json!({"status":"scheduled","internalReplyMessage":"<b>Inside</b>","externalReplyMessage":"<p>Outside</p>","externalAudience":"all","scheduledStartDateTime":{"dateTime":"2090-10-01T08:00:00.0000000","timeZone":"UTC"},"scheduledEndDateTime":{"dateTime":"2090-10-02T09:00:00","timeZone":"UTC"}})
        }));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_write = Arc::new(Mutex::new(false));
        let race_after_reads = Arc::new(Mutex::new(0));
        let hosts = ["gmail.googleapis.com", "graph.microsoft.com"];
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(hosts.map(str::to_owned).to_vec()).unwrap();
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(std::time::Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()]);
        for host in hosts {
            client = client.resolve(host, address);
        }
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let (saved, log, failing, race) = (
            raw.clone(),
            calls.clone(),
            fail_write.clone(),
            race_after_reads.clone(),
        );
        let google = provider == "google";
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let mut stream = acceptor.accept(socket).await.unwrap();
                let mut data = Vec::new();
                let mut buf = [0; 4096];
                let end = loop {
                    let count = stream.read(&mut buf).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&buf[..count]);
                    assert!(data.len() < 128 * 1024);
                    if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8(data[..end].to_vec()).unwrap();
                let first = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split(' ')
                    .collect::<Vec<_>>();
                let method = first[0];
                let path = first[1];
                assert!(
                    headers
                        .to_lowercase()
                        .contains("authorization: bearer private-token")
                );
                assert_eq!(
                    path,
                    if google {
                        "/gmail/v1/users/me/settings/vacation"
                    } else if method == "GET" {
                        "/v1.0/me/mailboxSettings/automaticRepliesSetting"
                    } else {
                        "/v1.0/me/mailboxSettings"
                    }
                );
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while data.len() < end + length {
                    let count = stream.read(&mut buf).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&buf[..count]);
                }
                let body: Value = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&data[end..end + length]).unwrap()
                };
                log.lock()
                    .unwrap()
                    .push(json!({"method":method,"path":path,"body":body}));
                let writing = method != "GET";
                if !writing {
                    let mut remaining = race.lock().unwrap();
                    if *remaining > 0 {
                        *remaining -= 1;
                        if *remaining == 0 {
                            saved.lock().unwrap()[if google {
                                "responseSubject"
                            } else {
                                "internalReplyMessage"
                            }] = "Changed on provider website".into();
                        }
                    }
                }
                let failed = writing && *failing.lock().unwrap();
                if writing && !failed {
                    let mut raw = saved.lock().unwrap();
                    *raw = if google {
                        body
                    } else {
                        store::merge(raw.clone(), &body["automaticRepliesSetting"])
                    };
                }
                let raw = saved.lock().unwrap().clone();
                let response = if failed {
                    json!({"error":"PRIVATE-PROVIDER-DETAIL"})
                } else if !google && writing {
                    json!({"automaticRepliesSetting":raw})
                } else {
                    raw
                };
                let bytes = serde_json::to_vec(&response).unwrap();
                let headers = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    if failed { 503 } else { 200 },
                    bytes.len()
                );
                stream.write_all(headers.as_bytes()).await.unwrap();
                stream.write_all(&bytes).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        Self {
            root,
            task,
            calls,
            raw,
            fail_write,
            race_after_reads,
            client: client.build().unwrap(),
        }
    }
    async fn app(&self, provider: &str, scope: &str) -> App {
        let mut app = App::open(
            &self.root.join("workspace"),
            32145,
            "fixture-token".into(),
            String::new(),
        )
        .unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = self.client.clone();
        let connection = json!({"provider":provider,"email":OWNER,"accessToken":"PRIVATE-TOKEN","refreshToken":"PRIVATE-REFRESH","expiresAt":chrono::Utc::now().timestamp_millis()+3600000,"grantedScopes":scope});
        app.db(move |db| db.set_settings(&json!({"mailAccounts":{OWNER:connection,"other@example.invalid":{"email":"other@example.invalid","provider":"imap","password":"PRIVATE-PASSWORD"}}})).map(|_|())).await.unwrap();
        app
    }
}
async fn call(app: &App, owner: &str, method: Method, body: Value) -> error::Result<Value> {
    let mut headers = HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    let context = Context {
        method,
        path: vec!["out-of-office".into()],
        body,
        query: json!({}),
        headers,
        owner: OWNER.into(),
        paged: true,
    };
    let response = out_of_office::handle(app, &context).await?.unwrap();
    Ok(serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap())
}

#[test]
fn validation_and_explicit_consent() {
    use out_of_office::{capability, provider_payload};
    assert_eq!(
        capability(
            &json!({"provider":"google","grantedScopes":"https://www.googleapis.com/auth/gmail.modify"}),
            OWNER
        )["canRead"],
        false
    );
    assert_eq!(
        capability(
            &json!({"provider":"microsoft","grantedScopes":"https://graph.microsoft.com/MailboxSettings.ReadWrite"}),
            OWNER
        )["canWrite"],
        true
    );
    for (key, value) in [
        ("confirmed", json!(false)),
        ("message", json!("")),
        ("message", json!("x".repeat(10001))),
        ("message", json!("bad\0")),
        ("subject", json!("bad\r\nsubject")),
        ("mode", json!("bad")),
        ("start", json!("2090-02-30T08:00:00Z")),
        ("start", json!("2090-10-03T08:00:00Z")),
        ("end", json!("2020-10-01T08:00:00Z")),
    ] {
        let mut body = input();
        body[key] = value;
        assert!(
            provider_payload("google", &body, chrono::Utc::now().timestamp_millis()).is_err(),
            "{key}"
        );
    }
    let payload = provider_payload("microsoft", &input(), 0).unwrap();
    assert_eq!(
        payload["automaticRepliesSetting"]["internalReplyMessage"],
        "&lt;script&gt;literal&lt;/script&gt;<br>Back soon."
    );
    let mut body = input();
    body["mode"] = "always".into();
    let payload = provider_payload("google", &body, 0).unwrap();
    for absent in ["responseBodyHtml", "startTime", "endTime"] {
        assert!(payload.get(absent).is_none());
    }
}

#[tokio::test]
async fn google_exact_owner_permission_gate_revision_and_disable_preserves_templates() {
    let f = Fixture::new("google").await;
    let app = f
        .app("google", "https://www.googleapis.com/auth/gmail.modify")
        .await;
    assert_eq!(
        call(&app, OWNER, Method::GET, Value::Null).await.unwrap()["requiresReconnect"],
        true
    );
    assert_eq!(
        call(&app, OWNER, Method::PUT, input())
            .await
            .unwrap_err()
            .status,
        403
    );
    for owner in ["", "all", "demo", "missing@example.invalid"] {
        assert_eq!(
            call(&app, owner, Method::GET, Value::Null)
                .await
                .unwrap_err()
                .status,
            409
        );
    }
    assert_eq!(
        call(&app, "other@example.invalid", Method::GET, Value::Null)
            .await
            .unwrap()["supported"],
        false
    );
    assert!(f.calls.lock().unwrap().is_empty());
    app.db(|db| {
        let mut config = db.settings()?;
        config["mailAccounts"][OWNER]["grantedScopes"] = out_of_office::GOOGLE_SCOPE.into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    let loaded = call(&app, OWNER, Method::GET, Value::Null).await.unwrap();
    assert_eq!(loaded["settings"]["message"], "Provider formatted");
    assert!(!loaded.to_string().contains("PRIVATE-"));
    let before = f.raw.lock().unwrap().clone();
    let disabled = call(
        &app,
        OWNER,
        Method::PUT,
        json!({"action":"disable","confirmed":true,"revision":loaded["revision"]}),
    )
    .await
    .unwrap();
    assert_eq!(disabled["settings"]["mode"], "disabled");
    let mut expected = before;
    expected["enableAutoReply"] = false.into();
    assert_eq!(*f.raw.lock().unwrap(), expected);
    let mut body = input();
    body["revision"] = loaded["revision"].clone();
    assert_eq!(
        call(&app, OWNER, Method::PUT, body.clone())
            .await
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        f.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["method"] == "PUT")
            .count(),
        1
    );
    body["revision"] = disabled["revision"].clone();
    {
        let _guard = app.0.mailbox.lock().await;
        assert_eq!(
            call(&app, OWNER, Method::PUT, body.clone())
                .await
                .unwrap_err()
                .status,
            409
        );
    }
    let result = call(&app, OWNER, Method::PUT, body).await.unwrap();
    assert_eq!(result["settings"]["start"], input()["start"]);
}

#[tokio::test]
async fn outlook_separate_messages_timezone_warning_and_failed_write_is_never_retried() {
    let f = Fixture::new("microsoft").await;
    let app = f.app("microsoft", out_of_office::MICROSOFT_SCOPE).await;
    let loaded = call(&app, OWNER, Method::GET, Value::Null).await.unwrap();
    assert_eq!(loaded["settings"]["message"], "Inside");
    assert_eq!(loaded["settings"]["externalMessage"], "Outside");
    assert_eq!(loaded["settings"]["start"], input()["start"]);
    f.raw.lock().unwrap()["scheduledStartDateTime"]["timeZone"] = "Pacific Standard Time".into();
    let unknown = call(&app, OWNER, Method::GET, Value::Null).await.unwrap();
    assert_eq!(unknown["settings"]["start"], "");
    assert!(
        unknown["scheduleWarning"]
            .as_str()
            .unwrap()
            .contains("Re-enter")
    );
    let mut body = input();
    body["revision"] = unknown["revision"].clone();
    let result = call(&app, OWNER, Method::PUT, body.clone()).await.unwrap();
    assert_eq!(result["settings"]["message"], input()["message"]);
    assert_eq!(
        result["settings"]["externalMessage"],
        input()["externalMessage"]
    );
    let before = f.raw.lock().unwrap().clone();
    let disabled = call(
        &app,
        OWNER,
        Method::PUT,
        json!({"action":"disable","confirmed":true,"revision":result["revision"]}),
    )
    .await
    .unwrap();
    let mut expected = before;
    expected["status"] = "disabled".into();
    assert_eq!(*f.raw.lock().unwrap(), expected);
    *f.fail_write.lock().unwrap() = true;
    body["revision"] = disabled["revision"].clone();
    let count = f.calls.lock().unwrap().len();
    let error = call(&app, OWNER, Method::PUT, body).await.unwrap_err();
    assert_eq!(error.status, 502);
    assert!(!error.to_string().contains("PRIVATE-"));
    assert!(error.to_string().contains("Refresh"));
    assert_eq!(f.calls.lock().unwrap().len() - count, 3);
}

#[tokio::test]
async fn provider_change_during_save_is_reported_before_writing() {
    for (provider, scope) in [
        ("google", out_of_office::GOOGLE_SCOPE),
        ("microsoft", out_of_office::MICROSOFT_SCOPE),
    ] {
        let f = Fixture::new(provider).await;
        let app = f.app(provider, scope).await;
        let loaded = call(&app, OWNER, Method::GET, Value::Null).await.unwrap();
        let mut body = input();
        body["revision"] = loaded["revision"].clone();
        *f.race_after_reads.lock().unwrap() = 2;
        assert_eq!(
            call(&app, OWNER, Method::PUT, body)
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(
            !f.calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call["method"] == "PUT" || call["method"] == "PATCH")
        );
    }
}
