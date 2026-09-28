use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use morrow_search::{
    background, mail, providers,
    service::App,
    store::{Store, merge, string},
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
fn connection(owner: &str) -> Value {
    json!({"email":owner,"provider":"google","connectionId":owner,"accessToken":format!("fixture-{owner}"),"expiresAt":chrono::Utc::now().timestamp_millis()+3600000,"grantedScopes":"https://www.googleapis.com/auth/gmail.modify"})
}
fn raw(id: &str, labels: Value) -> Value {
    json!({"id":id,"labelIds":labels,"internalDate":"1790553600000","payload":{"mimeType":"text/plain","headers":[{"name":"From","value":A},{"name":"To","value":"recipient@example.invalid"},{"name":"Subject","value":"Subject"}],"body":{"data":URL_SAFE_NO_PAD.encode("Remote body")}}})
}
fn remote(id: &str, labels: Value) -> Value {
    providers::normalize_google(&raw(id, labels)).unwrap()
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
    root: PathBuf,
    base: String,
    client: reqwest::Client,
    rows: Arc<Mutex<Vec<Value>>>,
    hits: Arc<Mutex<Vec<(String, url::Url)>>>,
    list_status: Arc<AtomicU16>,
    server: tokio::task::JoinHandle<()>,
    provider: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        self.provider.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("morrow-gmail-sync-{}", uuid::Uuid::new_v4()));
        let rows = Arc::new(Mutex::new(Vec::<Value>::new()));
        let hits = Arc::new(Mutex::new(Vec::new()));
        let remote_rows = rows.clone();
        let remote_hits = hits.clone();
        let list_status = Arc::new(AtomicU16::new(200));
        let remote_status = list_status.clone();
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
        let provider_client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()])
            .dns_resolver(Arc::new(LocalDns(listener.local_addr().unwrap())))
            .build()
            .unwrap();
        let provider = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let tls = tls.clone();
                let rows = remote_rows.clone();
                let hits = remote_hits.clone();
                let list_status = remote_status.clone();
                tokio::spawn(async move {
                    let mut stream = tls.accept(socket).await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    let end = loop {
                        let n = stream.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                        assert!(bytes.len() < 65536);
                        if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            break index + 4;
                        }
                    };
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    assert!(
                        headers
                            .to_ascii_lowercase()
                            .contains(&format!("authorization: bearer fixture-{A}\r\n"))
                    );
                    let first = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split(' ')
                        .collect::<Vec<_>>();
                    let method = first[0].to_owned();
                    let url = url::Url::parse(&format!("https://gmail.googleapis.com{}", first[1]))
                        .unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|n| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    assert!(length <= 256 * 1024);
                    while bytes.len() < end + length {
                        let n = stream.read(&mut buffer).await.unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buffer[..n]);
                    }
                    hits.lock().unwrap().push((method.clone(), url.clone()));
                    let status = if url.path().ends_with("/messages") {
                        list_status.load(Ordering::SeqCst)
                    } else {
                        200
                    };
                    if status != 200 {
                        let body = b"private quota response";
                        stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                        stream.write_all(body).await.unwrap();
                        return;
                    }
                    let result = if url.path().ends_with("/labels") {
                        json!({"labels":[{"id":"Label_1","name":"Old label","type":"user"},{"id":"Label_2","name":"New label","type":"user"}]})
                    } else if method == "POST" && url.path().ends_with("/messages/send") {
                        json!({"id":"accepted"})
                    } else if method == "POST" && url.path().ends_with("/modify") {
                        let change: Value =
                            serde_json::from_slice(&bytes[end..end + length]).unwrap();
                        let mut rows = rows.lock().unwrap();
                        let row = rows
                            .iter_mut()
                            .find(|row| {
                                url.path()
                                    .ends_with(&format!("/{}/modify", string(row, "id")))
                            })
                            .unwrap();
                        let labels = row["labelIds"].as_array_mut().unwrap();
                        labels.retain(|id| {
                            !change["removeLabelIds"].as_array().unwrap().contains(id)
                        });
                        for id in change["addLabelIds"].as_array().unwrap() {
                            if !labels.contains(id) {
                                labels.push(id.clone());
                            }
                        }
                        json!({"labelIds":labels})
                    } else if url.path().ends_with("/messages") {
                        json!({"messages":rows.lock().unwrap().iter().map(|row| json!({"id":row["id"]})).collect::<Vec<_>>(),"nextPageToken":"historical-page"})
                    } else {
                        rows.lock()
                            .unwrap()
                            .iter()
                            .find(|row| url.path().ends_with(&format!("/{}", string(row, "id"))))
                            .unwrap()
                            .clone()
                    };
                    let body = serde_json::to_vec(&result).unwrap();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                    let _ = stream.shutdown().await;
                });
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut app = App::open(&root, port, "native-fixture".into(), String::new()).unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = provider_client;
        app.db(|db| {
            db.set_settings(
                &json!({"mailAccounts":{A:connection(A),B:connection(B)},"activeAccount":B}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let router = app.router();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        Self {
            app,
            root,
            base: format!("http://127.0.0.1:{port}"),
            client,
            rows,
            hits,
            list_status,
            server,
            provider,
        }
    }
    async fn call(&self, method: &str, path: &str, owner: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .request(method.parse().unwrap(), format!("{}{path}", self.base))
            .bearer_auth("native-fixture")
            .header("x-genmail-account", owner)
            .header("x-morrow-view", "paged")
            .json(&body)
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }
    async fn message(&self, owner: &str, id: &str) -> Value {
        let owner = owner.to_owned();
        let id = id.to_owned();
        self.app
            .db(move |db| Ok(db.get(&owner, &id)?.unwrap_or(Value::Null)))
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn quota_limited_sync_retries_in_background_without_another_click() {
    let f = Fixture::new().await;
    f.list_status.store(429, Ordering::SeqCst);
    let (status, error) = f.call("POST", "/api/sync", A, json!({})).await;
    assert_eq!(status, 502);
    assert_eq!(error["code"], "rate_limited");
    assert!(error["nextRetryAt"].as_str().is_some());
    let calls = f.hits.lock().unwrap().len();
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 502);
    assert_eq!(f.hits.lock().unwrap().len(), calls);
    f.app
        .db(|db| {
            let mut errors = db.settings()?["backgroundSyncErrors"].clone();
            errors[0]["nextRetryAt"] = "2000-01-01T00:00:00.000Z".into();
            db.set_settings(&json!({"backgroundSyncErrors":errors}))
        })
        .await
        .unwrap();
    f.list_status.store(200, Ordering::SeqCst);
    background::tick(&f.app).await.unwrap();
    assert!(f.hits.lock().unwrap().len() > calls);
    assert_eq!(
        f.app.settings().await.unwrap()["backgroundSyncErrors"],
        json!([])
    );
}

#[tokio::test]
async fn sync_refreshes_remote_state_in_five_scopes_and_keeps_local_patches_and_owners() {
    let f = Fixture::new().await;
    *f.rows.lock().unwrap() = vec![
        raw("same", json!(["INBOX", "UNREAD", "Label_1"])),
        raw("sent", json!(["SENT"])),
        raw("draft", json!(["DRAFT"])),
    ];
    f.app.db(|db| {
        db.upsert(B, &remote("same", json!(["INBOX"])))?;
        let policy = morrow_search::policy::update(&db.settings()?["policy"], &json!({"triggers":{"onArrival":true,"inboxOnly":false},"folders":{"sent":true}}))?;
        db.set_settings(&json!({"policy":policy,"imports":{A:{"options":{"inbox":true,"sent":true,"allMail":true,"months":3},"since":"2026-06-27T00:00:00.000Z","before":"2026-09-27T00:00:00.000Z","folderIndex":0,"status":"complete","imported":0}}}))?; Ok(())
    }).await.unwrap();
    let other = f.message(B, "google:same").await;
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    let queries = f
        .hits
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, url)| url.path().ends_with("/messages"))
        .map(|(_, url)| {
            url.query_pairs()
                .into_owned()
                .collect::<std::collections::HashMap<_, _>>()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        queries
            .iter()
            .map(|q| q.get("labelIds").map(String::as_str))
            .collect::<Vec<_>>(),
        vec![
            Some("INBOX"),
            Some("SENT"),
            Some("DRAFT"),
            Some("STARRED"),
            None
        ]
    );
    assert!(queries.iter().all(|q| q["q"].starts_with("after:")
        && q["maxResults"] == "50"
        && !q.contains_key("pageToken")));
    f.app
        .db(|db| {
            assert_eq!(db.list(A)?.len(), 3);
            assert_eq!(
                db.settings()?["automation"][A]["jobs"][0]["messageIds"],
                json!(["google:same"])
            );
            assert_eq!(
                db.settings()?["automation"][A]["jobs"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            Ok(())
        })
        .await
        .unwrap();
    f.rows.lock().unwrap()[0] = raw("same", json!(["SENT", "STARRED", "Label_2"]));
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    let saved = f.message(A, "google:same").await;
    assert_eq!(saved["folder"], "sent");
    assert_eq!(saved["read"], true);
    assert_eq!(saved["starred"], true);
    assert_eq!(saved["labels"], json!(["New label"]));
    let (status, patch) = f.call("PATCH", "/api/messages/google:same", A, json!({"folder":"archive","read":true,"starred":false,"localOverrides":{"labels":true}})).await;
    assert_eq!(status, 200);
    assert_eq!(
        patch["message"]["localOverrides"],
        json!({"folder":true,"read":true,"starred":true})
    );
    f.rows.lock().unwrap()[0] = raw("same", json!(["INBOX", "UNREAD", "STARRED", "Label_1"]));
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    let saved = f.message(A, "google:same").await;
    assert_eq!(saved["folder"], "archive");
    assert_eq!(saved["read"], true);
    assert_eq!(saved["starred"], false);
    assert_eq!(saved["labels"], json!(["Old label"]));
    assert_eq!(
        saved["providerSnapshot"],
        json!({"folder":"inbox","read":false,"starred":true,"labels":["Old label"]})
    );
    assert_eq!(f.message(B, "google:same").await, other);
    assert_eq!(f.app.settings().await.unwrap()["activeAccount"], B);
    assert_eq!(
        f.call(
            "POST",
            "/api/messages/google:same/organize",
            A,
            json!({"mode":"move","destinationId":"INBOX","confirmed":true})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        f.message(A, "google:same").await["localOverrides"]["folder"],
        false
    );
    f.rows.lock().unwrap()[0] = raw("same", json!(["SENT"]));
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    assert_eq!(f.message(A, "google:same").await["folder"], "sent");
}

#[tokio::test]
async fn label_organization_retains_remote_sent_draft_snapshots_and_explicit_local_folders() {
    let f = Fixture::new().await;
    *f.rows.lock().unwrap() = vec![raw("same", json!(["SENT", "Label_1"]))];
    // Legacy rows without snapshots must receive one after organizing, too.
    f.app
        .db(|db| {
            db.upsert(A, &remote("same", json!(["SENT", "Label_1"])))?;
            Ok(())
        })
        .await
        .unwrap();
    let (status, result) = f
        .call(
            "POST",
            "/api/messages/google:same/organize",
            A,
            json!({"mode":"addLabel","destinationId":"Label_2","confirmed":true}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(result["message"]["folder"], "sent");
    assert_eq!(result["message"]["providerSent"], true);
    assert_eq!(result["message"]["providerDraft"], false);
    assert_eq!(result["message"]["providerSnapshot"]["folder"], "sent");
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    f.rows.lock().unwrap()[0] = raw("same", json!(["DRAFT", "SENT", "Label_1", "Label_2"]));
    let (status, result) = f
        .call(
            "POST",
            "/api/messages/google:same/organize",
            A,
            json!({"mode":"removeLabel","destinationId":"Label_1","confirmed":true}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(result["message"]["folder"], "drafts");
    assert_eq!(result["message"]["providerDraft"], true);
    assert_eq!(result["message"]["providerSnapshot"]["folder"], "drafts");
    let labels_before = result["message"]["providerSnapshot"]["labels"].clone();
    assert_eq!(
        f.call(
            "PATCH",
            "/api/messages/google:same",
            A,
            json!({"folder":"trash"})
        )
        .await
        .0,
        200
    );
    let (status, result) = f
        .call(
            "POST",
            "/api/messages/google:same/organize",
            A,
            json!({"mode":"addLabel","destinationId":"Label_1","confirmed":true}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(result["message"]["folder"], "trash");
    assert_eq!(result["message"]["providerSnapshot"]["folder"], "drafts");
    assert_eq!(
        result["message"]["providerSnapshot"]["labels"],
        labels_before
    );
    assert_eq!(result["message"]["localOverrides"]["folder"], true);
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    let saved = f.message(A, "google:same").await;
    assert_eq!(saved["folder"], "trash");
    assert_eq!(saved["providerSnapshot"]["folder"], "drafts");
}

#[test]
fn legacy_rows_heal_forced_folders_preserve_local_edits_and_attach_dual_label_sent_fingerprints() {
    let root = std::env::temp_dir().join(format!("morrow-gmail-merge-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    for (id, labels, local, next, expected) in [
        (
            "sent",
            json!(["SENT"]),
            json!({"folder":"inbox"}),
            json!(["SENT"]),
            "sent",
        ),
        (
            "inbox",
            json!(["INBOX"]),
            json!({"folder":"sent"}),
            json!(["INBOX"]),
            "inbox",
        ),
        (
            "draft",
            json!(["DRAFT"]),
            json!({"folder":"inbox"}),
            json!(["DRAFT"]),
            "drafts",
        ),
        (
            "archive",
            json!(["INBOX"]),
            json!({"folder":"archive"}),
            json!(["INBOX"]),
            "archive",
        ),
        (
            "trash",
            json!(["INBOX"]),
            json!({"folder":"trash"}),
            json!(["INBOX"]),
            "trash",
        ),
        (
            "edited",
            json!(["INBOX", "UNREAD", "STARRED"]),
            json!({"read":true,"starred":false,"labels":["Local label"],"providerFolderId":"kept-id","providerFolderName":"Kept name"}),
            json!(["SENT", "UNREAD", "STARRED"]),
            "sent",
        ),
    ] {
        db.upsert(A, &merge(remote(id, labels), &local)).unwrap();
        let mut next = remote(id, next);
        next["labels"] = json!(["Provider label"]);
        assert!(
            mail::import_messages(&db, &connection(A), &[next.clone(), next])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            db.get(A, &format!("google:{id}")).unwrap().unwrap()["folder"],
            expected
        );
    }
    let edited = db.get(A, "google:edited").unwrap().unwrap();
    assert_eq!(edited["read"], true);
    assert_eq!(edited["starred"], false);
    assert_eq!(edited["labels"], json!(["Local label"]));
    assert_eq!(edited["providerFolderId"], "kept-id");
    assert_eq!(edited["providerFolderName"], "Kept name");
    let sent = merge(
        remote("unused", json!(["SENT"])),
        &json!({"id":"sent:local-request","to":"original@example.invalid","bcc":"hidden@example.invalid","subject":"Saved subject","body":"Reviewed original","footer":{"text":"Signature"},"messageId":"<same@example.invalid>"}),
    );
    let fingerprint = mail::fingerprint(&sent).unwrap();
    db.upsert(A, &sent).unwrap();
    let remote_sent = merge(
        remote("raw-sent", json!(["INBOX", "SENT"])),
        &json!({"messageId":"<same@example.invalid>","body":"Provider transformed"}),
    );
    assert!(
        mail::import_messages(&db, &connection(A), &[remote_sent.clone(), remote_sent])
            .unwrap()
            .is_empty()
    );
    let saved = db.get(A, "sent:local-request").unwrap().unwrap();
    assert_eq!(mail::fingerprint(&saved).unwrap(), fingerprint);
    assert_eq!(saved["remoteId"], "google:raw-sent");
    assert!(db.get(A, "google:raw-sent").unwrap().is_none());
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn provider_draft_apis_reject_original_allow_local_copy_and_preserve_send_replay() {
    let f = Fixture::new().await;
    f.app
        .db(|db| {
            db.upsert(A, &remote("draft", json!(["DRAFT"])))?;
            Ok(())
        })
        .await
        .unwrap();
    let original = f.message(A, "google:draft").await;
    let content = json!({"to":"recipient@example.invalid","subject":"Reviewed copy","body":"Body"});
    for (path, body) in [
        (
            "/api/drafts",
            merge(content.clone(), &json!({"id":"google:draft"})),
        ),
        (
            "/api/send",
            merge(
                content.clone(),
                &json!({"draftId":"google:draft","requestId":"provider-draft-test"}),
            ),
        ),
    ] {
        let (status, result) = f.call("POST", path, A, body).await;
        assert_eq!(status, 409);
        assert!(string(&result, "error").contains("Copy it to a local draft"));
    }
    assert!(f.hits.lock().unwrap().is_empty());
    assert_eq!(f.message(A, "google:draft").await, original);
    assert_eq!(
        f.call(
            "POST",
            "/api/drafts",
            B,
            merge(content.clone(), &json!({"id":"google:draft"}))
        )
        .await
        .0,
        404
    );
    let (status, copy) = f
        .call(
            "POST",
            "/api/drafts",
            A,
            merge(
                content.clone(),
                &json!({"providerDraft":true,"remoteId":"google:draft"}),
            ),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(copy["message"]["accountId"], A);
    assert!(copy["message"]["providerDraft"].is_null());
    assert!(copy["message"]["remoteId"].is_null());
    let send = merge(
        content,
        &json!({"draftId":copy["message"]["id"],"requestId":"local-copy-test"}),
    );
    assert_eq!(f.call("POST", "/api/send", A, send.clone()).await.0, 200);
    assert_eq!(f.call("POST", "/api/send", A, send).await.0, 200);
    assert_eq!(
        f.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, url)| method == "POST" && url.path().ends_with("/messages/send"))
            .count(),
        1
    );
    assert_eq!(f.message(A, "google:draft").await, original);
}

#[tokio::test]
async fn malformed_all_mail_is_rejected_before_oauth_or_mailbox_connections() {
    let f = Fixture::new().await;
    for (path, body) in [
        (
            "/api/oauth/microsoft/start",
            json!({"clientId":"fixture-client","importOptions":{"allMail":"true"}}),
        ),
        (
            "/api/settings/mail",
            json!({"email":B,"imapHost":"127.0.0.1","imapPort":9,"smtpHost":"127.0.0.1","smtpPort":9,"password":"fixture","importOptions":{"allMail":"true"}}),
        ),
    ] {
        let (status, result) = f.call("POST", path, A, body).await;
        assert_eq!(status, 400);
        assert!(!string(&result, "error").is_empty());
    }
    assert!(f.hits.lock().unwrap().is_empty());
}
