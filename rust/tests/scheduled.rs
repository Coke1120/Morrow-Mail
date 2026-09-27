use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use morrow_search::{
    mail, scheduled,
    service::{App, Context},
    store::{Store, now, string},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const A: &str = "a@example.invalid";
const B: &str = "b@example.invalid";
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("morrow-scheduled-{}", uuid::Uuid::new_v4()))
}
fn configure(db: &Store) {
    db.set_settings(&json!({"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"a","accessToken":"fixture-token","expiresAt":chrono::Utc::now().timestamp_millis()+3600000},B:{"email":B,"provider":"google","connectionId":"b"}},"activeAccount":B,"preferences":{"displayName":"Reviewed name","syncInterval":0}})).unwrap();
}
fn input(id: &str) -> Value {
    json!({"requestId":id,"sendAt":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"to":"to@example.invalid","cc":"cc@example.invalid","bcc":"hidden@example.invalid","subject":"Reviewed subject","body":"Reviewed body","footer":{"text":"Reviewed footer"}})
}
fn due(db: &Store, id: &str, minutes: i64) {
    let mut jobs = db.settings().unwrap()["scheduledSends"].clone();
    jobs.as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|j| j["id"] == id)
        .unwrap()["sendAt"] = (chrono::Utc::now() - chrono::Duration::minutes(minutes))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .into();
    db.set_settings(&json!({"scheduledSends":jobs})).unwrap();
}
fn context(path: &[&str], body: Value) -> Context {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-genmail-account", A.parse().unwrap());
    Context {
        method: axum::http::Method::POST,
        path: path.iter().map(|s| (*s).into()).collect(),
        body,
        query: json!({}),
        headers,
        owner: A.into(),
        paged: true,
    }
}

#[test]
fn schedule_creation_is_owned_idempotent_bounded_and_cancel_unlocks_the_saved_draft() {
    let path = root();
    let db = Store::open(&path).unwrap();
    configure(&db);
    let body = input("schedule-create");
    let result = scheduled::start(&db, A, &body).unwrap();
    let draft = string(&result["job"], "draftId");
    assert_eq!(result["message"]["accountId"], A);
    assert_eq!(result["message"]["scheduledSend"]["status"], "scheduled");
    assert_eq!(
        scheduled::start(&db, A, &body).unwrap()["job"]["id"],
        "schedule-create"
    );
    let mut changed = body.clone();
    changed["bcc"] = "different@example.invalid".into();
    assert_eq!(scheduled::start(&db, A, &changed).unwrap_err().status, 409);
    assert!(scheduled::guard_draft(&db, A, draft, None).is_err());
    assert!(
        scheduled::list(&db, B).unwrap()["scheduled"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        scheduled::cancel(&db, B, "schedule-create")
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        scheduled::cancel(&db, A, "schedule-create").unwrap()["message"]["scheduledSend"]["status"],
        "cancelled"
    );
    scheduled::guard_draft(&db, A, draft, None).unwrap();
    for owner in ["all", "demo", "missing@example.invalid"] {
        assert!(scheduled::start(&db, owner, &input("schedule-owner")).is_err());
    }
    for date in [
        "2026-02-30T12:00:00.000Z",
        "2099-01-01T12:00",
        "2000-01-01T00:00:00.000Z",
    ] {
        let mut value = input("schedule-time");
        value["sendAt"] = date.into();
        assert!(scheduled::start(&db, A, &value).is_err());
    }
    db.upsert(
        A,
        &json!({"id":"remote","folder":"drafts","providerDraft":true}),
    )
    .unwrap();
    let mut remote = input("schedule-remote");
    remote["draftId"] = "remote".into();
    assert!(scheduled::start(&db, A, &remote).is_err());
    assert_eq!(scheduled::start(&db, B, &remote).unwrap_err().status, 404);
    let stored = db.settings().unwrap()["scheduledSends"][0].clone();
    let pending: Vec<_> = (0..200)
        .map(|i| {
            let mut j = stored.clone();
            j["id"] = format!("pending-{i}").into();
            j["status"] = "scheduled".into();
            j
        })
        .collect();
    db.set_settings(&json!({"scheduledSends":pending})).unwrap();
    assert_eq!(
        scheduled::start(&db, A, &input("schedule-full"))
            .unwrap_err()
            .status,
        409
    );
    let history: Vec<_> = (0..150)
        .map(|i| {
            let mut j = stored.clone();
            j["id"] = format!("history-{i}").into();
            j
        })
        .collect();
    db.set_settings(&json!({"scheduledSends":history})).unwrap();
    scheduled::start(&db, A, &input("schedule-next")).unwrap();
    assert_eq!(
        db.settings().unwrap()["scheduledSends"]
            .as_array()
            .unwrap()
            .len(),
        101
    );
    drop(db);
    fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn restart_claims_require_existing_delivery_review_and_manual_send_cannot_bypass_schedule() {
    let path = root();
    let app = App::open(&path, 3011, String::new(), String::new()).unwrap();
    app.db(|db| {
        configure(db);
        scheduled::start(db, A, &input("schedule-crash"))?;
        Ok(())
    })
    .await
    .unwrap();
    let blocked = mail::handle(&app, &context(&["send"], input("schedule-crash")))
        .await
        .unwrap_err();
    assert_eq!(blocked.status, 409);
    let draft = app
        .db(|db| Ok(scheduled::list(db, A)?["scheduled"][0]["draftId"].clone()))
        .await
        .unwrap();
    let mut editing = input("irrelevant-request");
    editing["id"] = draft;
    assert_eq!(
        mail::handle(&app, &context(&["drafts"], editing))
            .await
            .unwrap_err()
            .status,
        409
    );
    app.db(|db| {
        let mut jobs = db.settings()?["scheduledSends"].clone();
        jobs[0]["status"] = "sending".into();
        db.set_settings(&json!({"scheduledSends":jobs}))?;
        Ok(())
    })
    .await
    .unwrap();
    drop(app);
    let app = App::open(&path, 3011, String::new(), String::new()).unwrap();
    let job = app
        .db(|db| {
            scheduled::recover(db)?;
            Ok(scheduled::list(db, A)?["scheduled"][0].clone())
        })
        .await
        .unwrap();
    assert_eq!(job["status"], "uncertain");
    assert_eq!(job["requiresSendReview"], true);
    let mut body = job["payload"].clone();
    body["requestId"] = job["id"].clone();
    body["draftId"] = job["draftId"].clone();
    let error = mail::handle(&app, &context(&["send"], body))
        .await
        .unwrap_err();
    assert_eq!(error.body["requiresSendReview"], true);
    scheduled::tick(&app).await.unwrap();
    assert_eq!(
        app.settings().await.unwrap()["deliveryAttempts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(app);
    fs::remove_dir_all(path).unwrap();
}

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
    app: App,
    path: PathBuf,
    calls: Arc<Mutex<Vec<String>>>,
    status: Arc<AtomicU16>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.path);
    }
}
impl Fixture {
    async fn new() -> Self {
        let path = root();
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tls = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
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
        let calls = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(AtomicU16::new(200));
        let received = calls.clone();
        let response = status.clone();
        let server = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let tls = tls.clone();
                let received = received.clone();
                let response = response.clone();
                tokio::spawn(async move {
                    let mut stream = tls.accept(socket).await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    let end = loop {
                        let count = stream.read(&mut buffer).await.unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                        assert!(bytes.len() < 262144);
                        if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    assert!(header.starts_with("POST /gmail/v1/users/me/messages/send "));
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer fixture-token\r\n")
                    );
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|n| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    while bytes.len() < end + length {
                        let count = stream.read(&mut buffer).await.unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                    }
                    let body: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                    let raw = URL_SAFE_NO_PAD
                        .decode(body["raw"].as_str().unwrap())
                        .unwrap();
                    received
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(raw).unwrap());
                    let status = response.load(Ordering::SeqCst);
                    let body = if status == 200 {
                        r#"{"id":"accepted"}"#
                    } else {
                        "private error"
                    };
                    stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    let _ = stream.shutdown().await;
                });
            }
        });
        let mut app = App::open(&path, 3011, String::new(), String::new()).unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = client;
        app.db(|db| {
            configure(db);
            Ok(())
        })
        .await
        .unwrap();
        Self {
            app,
            path,
            calls,
            status,
            server,
        }
    }
}

#[tokio::test]
async fn scheduled_delivery_reuses_mime_owner_and_uncertain_path_without_automatic_retry() {
    let f = Fixture::new().await;
    f.app
        .db(|db| {
            db.upsert(
                A,
                &json!({"id":"reply","folder":"inbox","messageId":"<original@example.invalid>"}),
            )?;
            let mut value = input("schedule-fixture");
            value["replyToId"] = "reply".into();
            scheduled::start(db, A, &value)?;
            db.set_settings(&json!({"preferences":{"displayName":"Changed after review"}}))?;
            db.update(
                A,
                "reply",
                &json!({"messageId":"<changed@example.invalid>"}),
            )?;
            due(db, "schedule-fixture", 0);
            Ok(())
        })
        .await
        .unwrap();
    let gate = f.app.0.mailbox.lock().await;
    scheduled::tick(&f.app).await.unwrap();
    assert!(f.calls.lock().unwrap().is_empty());
    drop(gate);
    scheduled::tick(&f.app).await.unwrap();
    scheduled::tick(&f.app).await.unwrap();
    assert_eq!(f.calls.lock().unwrap().len(), 1);
    let mime = f.calls.lock().unwrap()[0].clone();
    for value in [
        "Reviewed name",
        "a@example.invalid",
        "to@example.invalid",
        "cc@example.invalid",
        "hidden@example.invalid",
        "Reviewed subject",
        "Reviewed body",
        "Reviewed footer",
        "<original@example.invalid>",
    ] {
        assert!(mime.contains(value), "missing {value}: {mime}");
    }
    assert!(!mime.contains("Changed after review"));
    assert!(!mime.contains("<changed@example.invalid>"));
    f.app
        .db(|db| {
            assert_eq!(db.settings()?["activeAccount"], B);
            assert_eq!(scheduled::list(db, A)?["scheduled"][0]["status"], "sent");
            assert_eq!(
                db.get(A, "sent:schedule-fixture")?.unwrap()["fromName"],
                "Reviewed name"
            );
            scheduled::start(db, A, &input("schedule-failure"))?;
            due(db, "schedule-failure", 0);
            Ok(())
        })
        .await
        .unwrap();
    f.status.store(500, Ordering::SeqCst);
    scheduled::tick(&f.app).await.unwrap();
    scheduled::tick(&f.app).await.unwrap();
    assert_eq!(f.calls.lock().unwrap().len(), 2);
    f.app
        .db(|db| {
            scheduled::recover(db)?;
            let jobs = scheduled::list(db, A)?;
            assert_eq!(
                jobs["scheduled"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|j| j["id"] == "schedule-failure")
                    .unwrap()["status"],
                "uncertain"
            );
            assert_eq!(
                db.settings()?["deliveryAttempts"].as_array().unwrap().len(),
                1
            );
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn missed_or_changed_jobs_do_not_send_and_import_preserves_pending() {
    let path = root();
    let app = App::open(&path, 3011, String::new(), String::new()).unwrap();
    app.db(|db| {
        configure(db);
        scheduled::start(db, A, &input("schedule-missed"))?;
        due(db, "schedule-missed", 16);
        Ok(())
    })
    .await
    .unwrap();
    scheduled::tick(&app).await.unwrap();
    app.db(|db| {
        assert_eq!(scheduled::list(db, A)?["scheduled"][0]["status"], "missed");
        let result = scheduled::start(db, A, &input("schedule-changed"))?;
        db.update(
            A,
            string(&result["job"], "draftId"),
            &json!({"bcc":"changed@example.invalid"}),
        )?;
        due(db, "schedule-changed", 0);
        Ok(())
    })
    .await
    .unwrap();
    scheduled::tick(&app).await.unwrap();
    app.db(|db|{assert!(scheduled::list(db,A)?["scheduled"].as_array().unwrap().iter().any(|j|j["errorCode"]=="draft_changed"));db.upsert(A,&json!({"id":"google:pending","folder":"inbox","pending":true,"providerLabelIds":["INBOX"]}))?;mail::import_messages(db,&json!({"email":A,"provider":"google"}),&[json!({"id":"google:pending","folder":"sent","date":now(),"providerLabelIds":["SENT"],"pending":false})])?;assert_eq!(db.get(A,"google:pending")?.unwrap()["pending"],true);Ok(())}).await.unwrap();
    drop(app);
    fs::remove_dir_all(path).unwrap();
}
