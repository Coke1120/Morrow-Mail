use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use morrow_search::{attachments, drafts, mail, providers, reconcile, service::App, store::Store};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const A: &str = "cache-a@example.invalid";
const B: &str = "cache-b@example.invalid";
const LARGE: &str =
    "This message exceeds the 5 MB import limit. Open it in your original mailbox to read it.";

fn directory() -> PathBuf {
    std::env::temp_dir().join(format!("morrow-fetch-cache-{}", uuid::Uuid::new_v4()))
}
fn connection() -> Value {
    json!({"email":A,"provider":"google","connectionId":"cache-fixture","accessToken":"fixture-token","expiresAt":4102444800000_i64,"grantedScopes":"https://www.googleapis.com/auth/gmail.readonly"})
}
fn raw(id: &str, labels: Value, text: &str) -> Value {
    json!({"id":id,"internalDate":"1791504000000","labelIds":labels,"payload":{"mimeType":"text/plain","headers":[{"name":"From","value":"sender@example.invalid"},{"name":"Reply-To","value":"support@example.invalid"},{"name":"To","value":A},{"name":"Subject","value":"Fixture"}],"body":{"data":URL_SAFE_NO_PAD.encode(text)}}})
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
    app: Option<App>,
    root: PathBuf,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    fn app(&self) -> &App {
        self.app.as_ref().unwrap()
    }
    async fn new(handler: impl Fn(&url::Url) -> Value + Send + Sync + 'static) -> Self {
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
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()])
            .dns_resolver(Arc::new(LocalDns(listener.local_addr().unwrap())))
            .build()
            .unwrap();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut stream = acceptor.accept(socket).await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    while !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                        let count = stream.read(&mut buffer).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        assert!(bytes.len() < 65536);
                    }
                    let request = String::from_utf8(bytes).unwrap();
                    let line = request
                        .lines()
                        .next()
                        .unwrap()
                        .split(' ')
                        .collect::<Vec<_>>();
                    assert_eq!(line[0], "GET");
                    assert!(
                        request
                            .to_ascii_lowercase()
                            .contains("authorization: bearer fixture-token\r\n")
                    );
                    let url = url::Url::parse(&format!("https://gmail.googleapis.com{}", line[1]))
                        .unwrap();
                    let body = serde_json::to_vec(&handler(&url)).unwrap();
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(headers.as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                    stream.shutdown().await.unwrap();
                });
            }
        });
        let root = directory();
        let mut app =
            App::open(&root, 0, "fixture-service".into(), "fixture-updater".into()).unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = client;
        app.db(|db| {
            db.set_settings(
                &json!({"mailAccounts":{A:connection()},"preferences":{"syncInterval":0}}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
        Self {
            app: Some(app),
            root,
            task,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        drop(self.app.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn downloaded_immutable_body_survives_provider_limit_refresh_restart_and_cached_reload() {
    for provider in ["imap", "microsoft", "google"] {
        let root = directory();
        let db = Store::open(&root).unwrap();
        let id = format!("{provider}:55:7");
        let connection = json!({"email":A,"provider":provider});
        let remote = json!({"id":id,"remoteId":id,"providerFolderId":"INBOX","folder":"inbox","date":"2026-10-09T00:00:00.000Z","body":LARGE,"bodyHtml":"","bodyTruncated":false,"preview":LARGE,"hasAttachments":true,"contentIncomplete":true,"contentErrorCode":format!("{provider}_size_limit"),"read":false,"starred":false,"labels":[],"providerLabelIds":["INBOX"]});
        mail::import_messages(&db, &connection, std::slice::from_ref(&remote)).unwrap();
        db.upsert(B, &remote).unwrap();
        let item = attachments::save(&db, A, "fixture.txt", "text/plain", "", b"Attachment bytes")
            .unwrap();
        db.update(A,&id,&json!({"attachmentsLoaded":true,"attachments":[item],"body":"Downloaded text","bodyHtml":"<p>Downloaded text</p>","preview":"Downloaded text","contentIncomplete":false,"contentErrorCode":null})).unwrap();
        let mut refreshed = remote.clone();
        refreshed["read"] = true.into();
        mail::import_messages(&db, &connection, &[refreshed]).unwrap();
        let saved = db.get(A, &id).unwrap().unwrap();
        assert_eq!(saved["body"], "Downloaded text");
        assert_eq!(saved["bodyHtml"], "<p>Downloaded text</p>");
        assert_eq!(saved["preview"], "Downloaded text");
        assert_eq!(saved["read"], true);
        assert_eq!(saved["attachments"], json!([item]));
        assert_eq!(saved["attachmentsLoaded"], true);
        assert_eq!(saved["contentIncomplete"], false);
        assert!(saved["contentErrorCode"].is_null());
        assert_eq!(db.get(B, &id).unwrap().unwrap(), remote);
        drop(db);
        let app = App::open(&root, 0, "fixture".into(), "fixture-update".into()).unwrap();
        // No connection is configured: this must be a complete-cache read with no network.
        let loaded = attachments::download(&app, A, &id).await.unwrap();
        assert_eq!(loaded["body"], "Downloaded text");
        assert_eq!(loaded["attachments"], json!([item]));
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn legacy_placeholder_and_mutable_draft_do_not_keep_a_completed_download_latch() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    let connection = json!({"email":A,"provider":"imap"});
    let previous = json!({"id":"imap:55:9","remoteId":"imap:55:9","providerFolderId":"INBOX","folder":"inbox","body":LARGE,"bodyHtml":"","bodyTruncated":false,"attachments":[],"attachmentsLoaded":true});
    db.upsert(A, &previous).unwrap();
    drop(db);
    let app = App::open(&root, 0, "fixture".into(), "fixture-update".into()).unwrap();
    // A legacy bad latch must attempt recovery, hence fail for this deliberately disconnected fixture.
    assert!(attachments::download(&app, A, "imap:55:9").await.is_err());
    drop(app);
    let db = Store::open(&root).unwrap();
    db.update(
        A,
        "imap:55:9",
        &json!({"body":"Earlier downloaded draft","providerDraft":true}),
    )
    .unwrap();
    let next = json!({"id":"imap:55:9","remoteId":"imap:55:9","providerFolderId":"INBOX","folder":"drafts","providerDraft":true,"body":LARGE,"bodyHtml":"","bodyTruncated":false,"contentIncomplete":true,"contentErrorCode":"imap_size_limit"});
    mail::import_messages(&db, &connection, &[next]).unwrap();
    let saved = db.get(A, "imap:55:9").unwrap().unwrap();
    assert_eq!(saved["body"], LARGE);
    assert_eq!(saved["contentIncomplete"], true);
    assert_ne!(saved["attachmentsLoaded"], true);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn contradictory_message_id_does_not_attach_previous_downloaded_content_to_a_new_message() {
    let root = directory();
    let db = Store::open(&root).unwrap();
    let connection = json!({"email":A,"provider":"imap"});
    db.upsert(A,&json!({"id":"imap:55:11","remoteId":"imap:55:11","providerFolderId":"INBOX","folder":"inbox","messageId":"<old@example.invalid>","body":"Previous connection's downloaded body","bodyHtml":"<p>Previous body</p>","bodyTruncated":false,"attachmentsLoaded":true,"attachments":[],"contentIncomplete":false})).unwrap();
    // A reconnected IMAP server can reuse a mailbox UID tuple for a different Message-ID.
    let incoming = json!({"id":"imap:55:11","remoteId":"imap:55:11","providerFolderId":"INBOX","folder":"inbox","messageId":"<new@example.invalid>","body":LARGE,"bodyHtml":"","bodyTruncated":false,"contentIncomplete":true,"contentErrorCode":"imap_size_limit"});
    mail::import_messages(&db, &connection, &[incoming]).unwrap();
    let saved = db.get(A, "imap:55:11").unwrap().unwrap();
    assert_eq!(saved["messageId"], "<new@example.invalid>");
    assert_eq!(saved["body"], LARGE);
    assert_eq!(saved["contentIncomplete"], true);
    assert_ne!(saved["attachmentsLoaded"], true);
    assert!(saved["attachments"].is_null());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn gmail_reconciliation_repairs_reply_target_and_reloads_mutable_provider_drafts() {
    let rows = Arc::new(Mutex::new(raw("old", json!(["INBOX"]), "Recovered body")));
    let formats = Arc::new(Mutex::new(Vec::<String>::new()));
    let remote = rows.clone();
    let calls = formats.clone();
    let fixture=Fixture::new(move |url| {
        if url.path().ends_with("/labels") { return json!({"labels":[]}); }
        assert!(url.path().ends_with("/messages/old"));
        let format=url.query_pairs().find(|(key,_)|key=="format").unwrap().1.into_owned();
        calls.lock().unwrap().push(format.clone());
        let value=remote.lock().unwrap().clone();
        if format=="minimal" { json!({"id":value["id"],"labelIds":value["labelIds"],"internalDate":value["internalDate"]}) } else { value }
    }).await;
    let mut old = providers::normalize_google(&rows.lock().unwrap()).unwrap();
    for key in ["providerSnapshot", "bodyHtml", "bodyTruncated", "replyTo"] {
        old.as_object_mut().unwrap().remove(key);
    }
    let other = old.clone();
    fixture
        .app()
        .db(move |db| {
            db.upsert(A, &old)?;
            db.upsert(B, &old)?;
            Ok(())
        })
        .await
        .unwrap();
    reconcile::sync(fixture.app(), &connection(), &mut HashMap::new())
        .await
        .unwrap();
    let reply = fixture
        .app()
        .db(|db| drafts::prepare(db, A, &json!({"messageId":"google:old","mode":"reply"})))
        .await
        .unwrap();
    assert_eq!(reply["draft"]["to"], "support@example.invalid");
    fixture
        .app()
        .db(move |db| {
            assert_eq!(db.get(B, "google:old")?, Some(other));
            Ok(())
        })
        .await
        .unwrap();
    reconcile::sync(fixture.app(), &connection(), &mut HashMap::new())
        .await
        .unwrap();
    *rows.lock().unwrap() = raw("old", json!(["DRAFT"]), "Changed provider draft");
    reconcile::sync(fixture.app(), &connection(), &mut HashMap::new())
        .await
        .unwrap();
    let saved = fixture
        .app()
        .db(|db| db.get(A, "google:old"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved["body"], "Changed provider draft");
    assert_eq!(saved["providerDraft"], true);
    assert_eq!(
        *formats.lock().unwrap(),
        vec!["full", "minimal", "minimal", "full"]
    );
}

#[tokio::test]
async fn gmail_recent_cache_requires_schema_and_only_reuses_confirmed_limit_placeholders() {
    let ids = [
        "missing-reply",
        "unknown-limit",
        "forged-limit",
        "known-limit",
        "complete",
    ];
    let calls = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let hits = calls.clone();
    let fixture = Fixture::new(move |url| {
        if url.path().ends_with("/labels") {
            return json!({"labels":[]});
        }
        if url.path().ends_with("/messages") {
            return json!({"messages":ids.map(|id|json!({"id":id}))});
        }
        let id =
            percent_encoding::percent_decode_str(url.path_segments().unwrap().next_back().unwrap())
                .decode_utf8()
                .unwrap()
                .into_owned();
        let format = url
            .query_pairs()
            .find(|(key, _)| key == "format")
            .unwrap()
            .1
            .into_owned();
        hits.lock().unwrap().insert(id.to_owned(), format.clone());
        let value = raw(&id, json!(["INBOX"]), "Remote full body");
        if format == "minimal" {
            json!({"id":id,"internalDate":value["internalDate"],"labelIds":["INBOX"]})
        } else {
            value
        }
    })
    .await;
    fixture
        .app()
        .db(move |db| {
            for id in ids {
                let value = providers::normalize_google(&raw(id, json!(["INBOX"]), "Cached body"))?;
                mail::import_messages(db, &connection(), &[value])?;
                let key = format!("google:{id}");
                let mut stored = db.get(A, &key)?.unwrap();
                match id {
                    "missing-reply" => {
                        stored.as_object_mut().unwrap().remove("replyTo");
                        stored["contentIncomplete"] = true.into();
                        stored["contentErrorCode"] = "google_mime_limit".into();
                        stored["hasAttachments"] = true.into();
                        stored["bodyTruncated"] = true.into();
                    }
                    "unknown-limit" => {
                        stored["contentIncomplete"] = true.into();
                        stored["contentErrorCode"] = "unrecognized".into();
                        stored["hasAttachments"] = true.into();
                        stored["bodyTruncated"] = true.into();
                    }
                    "forged-limit" | "known-limit" => {
                        stored["contentIncomplete"] = true.into();
                        stored["contentErrorCode"] = "google_mime_limit".into();
                        stored["hasAttachments"] = true.into();
                        stored["bodyTruncated"] = (id == "known-limit").into();
                    }
                    _ => {}
                }
                db.upsert(A, &stored)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let page = mail::fetch_page(fixture.app(), &connection(), &json!({"folder":"inbox"}))
        .await
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 5);
    let calls = calls.lock().unwrap();
    for id in ["missing-reply", "unknown-limit", "forged-limit"] {
        assert_eq!(calls[id], "full", "{id}");
    }
    for id in ["known-limit", "complete"] {
        assert_eq!(calls[id], "minimal", "{id}");
    }
}

#[tokio::test]
async fn explicit_raw_recovery_clears_incomplete_latch_and_repairs_headers_without_changing_provider_date()
 {
    let hits = Arc::new(Mutex::new(0usize));
    let calls = hits.clone();
    let fixture=Fixture::new(move |url| {
        assert!(url.path().ends_with("/messages/raw"));
        assert!(url.query_pairs().any(|(key,value)|key=="format"&&value=="raw"));
        let mut calls=calls.lock().unwrap(); *calls+=1;
        if *calls==1 { return json!({"id":"raw","raw":false}); }
        json!({"id":"raw","raw":URL_SAFE_NO_PAD.encode(format!("From: sender@example.invalid\r\nReply-To: support@example.invalid\r\nTo: {A}\r\nCc: copied@example.invalid\r\nDate: Wed, 01 Jan 1969 00:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRecovered raw body"))})
    }).await;
    fixture.app().db(|db| {
        db.upsert(A,&json!({"id":"google:raw","folder":"inbox","body":"Placeholder","bodyHtml":"","bodyTruncated":true,"date":"2026-10-09T00:00:00.000Z","attachments":[],"attachmentsLoaded":true,"contentIncomplete":true,"contentErrorCode":"google_size_limit","to":"reviewed@example.invalid","bcc":"private@example.invalid"}))?;
        Ok(())
    }).await.unwrap();
    assert!(
        attachments::download(fixture.app(), A, "google:raw")
            .await
            .is_err()
    );
    let failed = fixture
        .app()
        .db(|db| db.get(A, "google:raw"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed["contentIncomplete"], true);
    assert_eq!(failed["contentErrorCode"], "google_size_limit");
    let restored = attachments::download(fixture.app(), A, "google:raw")
        .await
        .unwrap();
    assert_eq!(restored["body"], "Recovered raw body");
    assert_eq!(restored["replyTo"], "support@example.invalid");
    assert_eq!(restored["date"], "2026-10-09T00:00:00.000Z");
    assert_eq!(restored["to"], "reviewed@example.invalid");
    assert_eq!(restored["bcc"], "private@example.invalid");
    assert_eq!(restored["cc"], "copied@example.invalid");
    assert_eq!(restored["contentIncomplete"], false);
    assert!(restored["contentErrorCode"].is_null());
    assert_eq!(restored["attachmentsLoaded"], true);
    assert_eq!(
        attachments::download(fixture.app(), A, "google:raw")
            .await
            .unwrap(),
        restored
    );
    assert_eq!(*hits.lock().unwrap(), 2);
}

#[tokio::test]
async fn forwarding_repairs_an_incomplete_download_even_when_attachments_were_already_loaded() {
    let fixture=Fixture::new(|url| {
        assert!(url.path().ends_with("/messages/forward"));
        assert!(url.query_pairs().any(|(key,value)|key=="format"&&value=="raw"));
        json!({"id":"forward","raw":URL_SAFE_NO_PAD.encode("From: sender@example.invalid\r\nSubject: Forward source\r\nContent-Type: text/plain\r\n\r\nActual forwarding text")})
    }).await;
    fixture.app().db(|db| {
        db.upsert(A,&json!({"id":"google:forward","folder":"inbox","subject":"Fixture","body":LARGE,"bodyHtml":"","bodyTruncated":false,"attachments":[],"attachmentsLoaded":true,"hasAttachments":true,"contentIncomplete":true,"contentErrorCode":"google_size_limit"}))?;
        Ok(())
    }).await.unwrap();
    let context = morrow_search::service::Context {
        method: axum::http::Method::POST,
        path: vec!["drafts".into(), "prepare".into()],
        body: json!({"messageId":"google:forward","mode":"forward"}),
        query: json!({}),
        headers: axum::http::HeaderMap::from_iter([(
            "x-genmail-account".parse().unwrap(),
            A.parse().unwrap(),
        )]),
        owner: A.into(),
        paged: true,
    };
    let response = mail::handle(fixture.app(), &context)
        .await
        .unwrap()
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    let body = result["draft"]["body"].as_str().unwrap();
    assert!(body.contains("Actual forwarding text"));
    assert!(!body.contains(LARGE));
}
