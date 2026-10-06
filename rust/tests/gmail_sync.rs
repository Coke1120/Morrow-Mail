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
    detail_status: Arc<AtomicU16>,
    retry_after: Arc<Mutex<Option<String>>>,
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
        let detail_status = Arc::new(AtomicU16::new(200));
        let remote_detail_status = detail_status.clone();
        let retry_after = Arc::new(Mutex::new(None::<String>));
        let remote_retry_after = retry_after.clone();
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
                let detail_status = remote_detail_status.clone();
                let retry_after = remote_retry_after.clone();
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
                    let other_owner = headers
                        .to_ascii_lowercase()
                        .contains(&format!("authorization: bearer fixture-{B}\r\n"));
                    assert!(
                        other_owner
                            || headers
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
                    } else if url.path().ends_with("/deleted") {
                        detail_status.load(Ordering::SeqCst)
                    } else {
                        200
                    };
                    if status != 200 {
                        let body = b"private quota response";
                        let retry = retry_after
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|value| format!("Retry-After: {value}\r\n"))
                            .unwrap_or_default();
                        stream.write_all(format!("HTTP/1.1 {status} Fixture\r\n{retry}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
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
                        let label = url
                            .query_pairs()
                            .find(|(key, _)| key == "labelIds")
                            .map(|(_, value)| value.into_owned());
                        if url.query_pairs().any(|(key, _)| key == "pageToken") {
                            json!({"messages":[]})
                        } else {
                            json!({"messages":rows.lock().unwrap().iter().filter(|row| label.as_ref().is_none_or(|label| row["labelIds"].as_array().unwrap().contains(&json!(label)))).take(50).map(|row| json!({"id":row["id"]})).collect::<Vec<_>>(),"nextPageToken":"historical-page"})
                        }
                    } else {
                        let mut row = rows
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|row| url.path().ends_with(&format!("/{}", string(row, "id"))))
                            .unwrap()
                            .clone();
                        if other_owner {
                            row["payload"]["body"]["data"] =
                                URL_SAFE_NO_PAD.encode("Other account body").into();
                        }
                        if url
                            .query_pairs()
                            .any(|(key, value)| key == "format" && value == "minimal")
                        {
                            row.as_object_mut().unwrap().remove("payload");
                        }
                        row
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
            detail_status,
            retry_after,
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
            let mut backoffs = db.settings()?["mailReadBackoffs"].clone();
            backoffs[A]["nextRetryAt"] = "2000-01-01T00:00:00.000Z".into();
            db.set_settings(&json!({"backgroundSyncErrors":errors,"mailReadBackoffs":backoffs}))
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
    assert_eq!(saved["read"], false);
    assert_eq!(saved["starred"], false);
    assert_eq!(saved["labels"], json!(["Old label"]));
    assert_eq!(
        saved["providerSnapshot"],
        json!({"folder":"inbox","read":false,"starred":true,"labels":["Old label"]})
    );
    assert_ne!(saved["localOverrides"]["read"], true);
    assert_eq!(
        f.call(
            "PATCH",
            "/api/messages/google:same",
            A,
            json!({"read":true})
        )
        .await
        .0,
        200
    );
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    assert_eq!(f.message(A, "google:same").await["read"], true);
    f.rows.lock().unwrap()[0] = raw("same", json!(["INBOX", "STARRED", "Label_1"]));
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    assert_ne!(
        f.message(A, "google:same").await["localOverrides"]["read"],
        true
    );
    f.rows.lock().unwrap()[0] = raw("same", json!(["INBOX", "UNREAD", "STARRED", "Label_1"]));
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    assert_eq!(f.message(A, "google:same").await["read"], false);
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
    assert_eq!(labels_before, json!(["New label"]));
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
        json!(["New label", "Old label"])
    );
    assert_eq!(
        result["message"]["labels"],
        json!(["New label", "Old label"])
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

#[tokio::test]
async fn label_checklist_uses_one_validated_delta_without_changing_inbox_or_other_owners() {
    let f = Fixture::new().await;
    *f.rows.lock().unwrap() = vec![raw("same", json!(["INBOX", "SENT", "Label_1"]))];
    f.app
        .db(|db| {
            db.upsert(A, &remote("same", json!(["INBOX", "SENT", "Label_1"])))?;
            db.upsert(B, &remote("same", json!(["INBOX", "Label_1"])))?;
            Ok(())
        })
        .await
        .unwrap();
    let original_other = f
        .call("GET", "/api/messages/google:same", B, json!({}))
        .await
        .1;
    assert_eq!(
        f.call(
            "PATCH",
            "/api/messages/google:same",
            A,
            json!({"folder":"trash","pending":true})
        )
        .await
        .0,
        200
    );
    for payload in [
        json!({"mode":"labels","addLabelIds":["Label_2"],"removeLabelIds":["Label_1"]}),
        json!({"mode":"labels","addLabelIds":["INBOX"],"removeLabelIds":[],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":["unknown"],"removeLabelIds":[],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":["Label_2","Label_2"],"removeLabelIds":[],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":["Label_1"],"removeLabelIds":["Label_1"],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":[],"removeLabelIds":[],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":"Label_2","removeLabelIds":[],"confirmed":true}),
        json!({"mode":"labels","addLabelIds":vec!["Label_2";101],"removeLabelIds":[],"confirmed":true}),
    ] {
        assert_eq!(
            f.call("POST", "/api/messages/google:same/organize", A, payload)
                .await
                .0,
            400
        );
    }
    assert!(
        !f.hits
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "POST")
    );
    let (status, result) = f.call("POST", "/api/messages/google:same/organize", A, json!({"mode":"labels","addLabelIds":["Label_2"],"removeLabelIds":["Label_1"],"confirmed":true})).await;
    assert_eq!(status, 200);
    assert_eq!(result["message"]["accountId"], A);
    assert_eq!(result["message"]["id"], "google:same");
    assert_eq!(
        result["message"]["providerLabelIds"],
        json!(["INBOX", "SENT", "Label_2"])
    );
    assert_eq!(result["message"]["labels"], json!(["New label"]));
    assert_eq!(result["message"]["folder"], "trash");
    assert_eq!(result["message"]["pending"], true);
    assert_eq!(result["message"]["localOverrides"]["folder"], true);
    assert_eq!(
        f.call("GET", "/api/messages/google:same", B, json!({}))
            .await
            .1,
        original_other
    );
    assert_eq!(
        f.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, url)| method == "POST" && url.path().ends_with("/modify"))
            .count(),
        1
    );
}

#[tokio::test]
async fn read_quota_wait_is_shared_by_sync_history_and_catalog_without_extending_it() {
    for history_first in [false, true] {
        let f = Fixture::new().await;
        f.app
            .db(|db| {
                db.set_settings(&json!({"preferences":{"syncInterval":0}}))?;
                background::start_import(db, A, &json!({"allMail":true,"months":0}))
            })
            .await
            .unwrap();
        *f.retry_after.lock().unwrap() = Some("3600".into());
        f.list_status.store(429, Ordering::SeqCst);
        let before = chrono::Utc::now().timestamp_millis();
        if history_first {
            background::tick(&f.app).await.unwrap();
        } else {
            assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 502);
        }
        let wait = f.app.settings().await.unwrap()["mailReadBackoffs"][A].clone();
        let until = chrono::DateTime::parse_from_rfc3339(string(&wait, "nextRetryAt"))
            .unwrap()
            .timestamp_millis();
        assert!(until >= before + 3_600_000);
        assert_eq!(f.hits.lock().unwrap().len(), 1);
        let (status, error) = f.call("POST", "/api/sync", A, json!({})).await;
        assert_eq!(status, 502);
        assert_eq!(error["code"], "rate_limited");
        assert_eq!(error["nextRetryAt"], wait["nextRetryAt"]);
        assert!(!error.to_string().contains("private"));
        background::tick(&f.app).await.unwrap();
        let (status, error) = f.call("GET", "/api/mail/folders", A, json!({})).await;
        assert_eq!(status, 502);
        assert_eq!(error["nextRetryAt"], wait["nextRetryAt"]);
        assert_eq!(f.hits.lock().unwrap().len(), 1);
        assert_eq!(f.app.settings().await.unwrap()["mailReadBackoffs"][A], wait);
        let history = f
            .app
            .db(|db| background::import_status(db, A))
            .await
            .unwrap();
        assert_eq!(history["phase"], "retrying");
        assert_eq!(history["errorCode"], "rate_limited");
        assert_eq!(history["nextRetryAt"], wait["nextRetryAt"]);

        // Another owner can still refresh; reconnect/disconnect affects only its target.
        f.list_status.store(200, Ordering::SeqCst);
        assert_eq!(f.call("POST", "/api/sync", B, json!({})).await.0, 200);
        let calls = f.hits.lock().unwrap().len();
        assert!(calls > 1);
        f.app
            .db(|db| morrow_search::service::save_connection(db, &connection(A), true))
            .await
            .unwrap();
        assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
        assert!(f.hits.lock().unwrap().len() > calls);
        assert!(f.app.settings().await.unwrap()["mailReadBackoffs"][A].is_null());
        f.list_status.store(429, Ordering::SeqCst);
        f.call("POST", "/api/sync", A, json!({})).await;
        f.call("POST", "/api/sync", B, json!({})).await;
        let other_wait = f.app.settings().await.unwrap()["mailReadBackoffs"][B].clone();
        assert!(other_wait.is_object());
        assert_eq!(
            f.call("POST", "/api/account/disconnect", A, json!({}))
                .await
                .0,
            200
        );
        let config = f.app.settings().await.unwrap();
        assert!(config["mailReadBackoffs"][A].is_null());
        assert_eq!(config["mailReadBackoffs"][B], other_wait);
    }
}

#[tokio::test]
async fn refresh_deduplicates_scopes_reuses_bodies_and_keeps_drafts_and_owners_fresh() {
    let f = Fixture::new().await;
    for (prefix, labels) in [
        ("inbox", json!(["INBOX", "STARRED"])),
        ("sent", json!(["SENT"])),
        ("draft", json!(["DRAFT"])),
    ] {
        f.rows
            .lock()
            .unwrap()
            .extend((0..50).map(|i| raw(&format!("{prefix}{i}"), labels.clone())));
    }
    for expected_full in [150, 50] {
        f.hits.lock().unwrap().clear();
        assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
        let hits = f.hits.lock().unwrap();
        let bodies = hits
            .iter()
            .filter(|(_, url)| url.path().contains("/messages/"))
            .collect::<Vec<_>>();
        assert_eq!(hits.len(), 160);
        assert_eq!(bodies.len(), 150);
        assert_eq!(
            bodies
                .iter()
                .map(|(_, url)| url.path())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            150
        );
        assert_eq!(
            bodies
                .iter()
                .filter(|(_, url)| url
                    .query_pairs()
                    .any(|(key, value)| key == "format" && value == "full"))
                .count(),
            expected_full
        );
    }
    assert_eq!(f.message(A, "google:inbox0").await["body"], "Remote body");
    f.app
        .db(|db| {
            let mut old = db.get(A, "google:inbox0")?.unwrap();
            old.as_object_mut().unwrap().remove("bodyHtml");
            db.upsert(A, &old)
        })
        .await
        .unwrap();
    f.hits.lock().unwrap().clear();
    f.rows
        .lock()
        .unwrap()
        .iter_mut()
        .find(|row| row["id"] == "draft0")
        .unwrap()["payload"]["body"]["data"] = URL_SAFE_NO_PAD.encode("Edited draft").into();
    assert_eq!(f.call("POST", "/api/sync", A, json!({})).await.0, 200);
    assert_eq!(f.message(A, "google:draft0").await["body"], "Edited draft");
    assert!(f.hits.lock().unwrap().iter().any(|(_, url)| {
        url.path().ends_with("/inbox0")
            && url
                .query_pairs()
                .any(|(key, value)| key == "format" && value == "full")
    }));
    // The same provider ID in another account must fetch its own body.
    assert_eq!(f.call("POST", "/api/sync", B, json!({})).await.0, 200);
    assert_eq!(
        f.message(B, "google:inbox0").await["body"],
        "Other account body"
    );
    assert_eq!(f.message(A, "google:inbox0").await["body"], "Remote body");
}

#[tokio::test]
async fn only_missing_message_details_are_skipped_and_history_keeps_its_checkpoint() {
    for status in [404, 401, 429, 503] {
        let f = Fixture::new().await;
        *f.rows.lock().unwrap() = vec![
            raw("healthy", json!(["INBOX"])),
            raw("deleted", json!(["INBOX"])),
        ];
        f.detail_status.store(status, Ordering::SeqCst);
        f.app
            .db(|db| {
                db.set_settings(&json!({"preferences":{"syncInterval":0}}))?;
                background::start_import(db, A, &json!({"allMail":true,"months":0}))
            })
            .await
            .unwrap();
        background::tick(&f.app).await.unwrap();
        let history = f
            .app
            .db(|db| background::import_status(db, A))
            .await
            .unwrap();
        if status == 404 {
            assert_eq!(history["status"], "running");
            assert_eq!(history["pages"], 1);
            assert_eq!(history["imported"], 1);
            assert_eq!(f.message(A, "google:healthy").await["body"], "Remote body");
            assert_eq!(
                f.app.settings().await.unwrap()["imports"][A]["cursor"],
                "historical-page"
            );
            background::tick(&f.app).await.unwrap();
            assert_eq!(
                f.app
                    .db(|db| background::import_status(db, A))
                    .await
                    .unwrap()["status"],
                "complete"
            );
        } else {
            assert_eq!(history["pages"], 0);
            assert_eq!(
                history["errorCode"],
                match status {
                    401 => "authorization",
                    429 => "rate_limited",
                    _ => "provider_unavailable",
                }
            );
            assert!(f.message(A, "google:healthy").await.is_null());
        }
    }
}
