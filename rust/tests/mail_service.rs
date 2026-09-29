//! Mail acceptance uses generated TLS certificates and a resolver that never leaves loopback.
use axum::http::HeaderMap;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{FutureExt, future::BoxFuture};
use morrow_search::{
    ai, providers,
    service::{App, connections},
    store::{merge, string},
};
use serde_json::{Value, json};
use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Semaphore, oneshot},
    task::JoinSet,
};

const A: &str = "a@example.invalid";
const B: &str = "b@example.invalid";
const C: &str = "c@example.invalid";
const NATIVE: &str = "fixture-native-token";
const HOSTS: &[&str] = &[
    "gmail.googleapis.com",
    "graph.microsoft.com",
    "oauth2.googleapis.com",
    "login.microsoftonline.com",
];
#[derive(Clone)]
struct Request {
    method: String,
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}
impl Request {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
    fn host(&self) -> &str {
        self.headers["host"].to_str().unwrap()
    }
    fn owner(&self) -> &str {
        self.headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("Bearer fixture-")
            .unwrap()
    }
    fn mime(&self) -> Vec<u8> {
        if self.host() == "gmail.googleapis.com" {
            URL_SAFE_NO_PAD.decode(string(&self.json(), "raw")).unwrap()
        } else {
            STANDARD.decode(&self.body).unwrap()
        }
    }
    fn parsed_mail(&self) -> Value {
        providers::mime(&self.mime()).unwrap()
    }
}
enum Reply {
    Json(u16, Value),
    Empty(u16),
    Lost,
}
type Handler = Arc<dyn Fn(Request) -> BoxFuture<'static, Reply> + Send + Sync>;
struct LocalDns(SocketAddr);
impl reqwest::dns::Resolve for LocalDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let address = self.0;
        let allowed = HOSTS.contains(&name.as_str());
        Box::pin(async move {
            if !allowed {
                return Err(std::io::Error::other("Non-fixture destination refused").into());
            }
            Ok(Box::new(std::iter::once(address)) as reqwest::dns::Addrs)
        })
    }
}
struct Fixture {
    root: PathBuf,
    client: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new(handler: Handler) -> Self {
        let root =
            std::env::temp_dir().join(format!("morrow-mail-acceptance-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(
            HOSTS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();
        let config = tokio_rustls::rustls::ServerConfig::builder_with_provider(Arc::new(
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
        let tls = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .dns_resolver(Arc::new(LocalDns(address)))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()])
            .build()
            .unwrap();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{let(socket,_)=accepted.unwrap();let tls=tls.clone();let handler=handler.clone();children.spawn(async move{
                        let mut stream=tls.accept(socket).await.unwrap();let mut bytes=Vec::new();let mut chunk=[0;4096];let end;
                        loop{let n=stream.read(&mut chunk).await.unwrap();if n==0{return;}bytes.extend_from_slice(&chunk[..n]);if let Some(i)=bytes.windows(4).position(|v|v==b"\r\n\r\n"){end=i+4;break;}assert!(bytes.len()<65536);}
                        let header=std::str::from_utf8(&bytes[..end]).unwrap();let mut lines=header.split("\r\n");let first=lines.next().unwrap().split(' ').collect::<Vec<_>>();let method=first[0].to_owned();let path=first[1].to_owned();let mut headers=HeaderMap::new();
                        for line in lines {if let Some((k,v))=line.split_once(':'){headers.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),v.trim().parse().unwrap());}}
                        let length=headers.get("content-length").map(|v|v.to_str().unwrap().parse::<usize>().unwrap()).unwrap_or(0);assert!(length<=256*1024);
                        while bytes.len()<end+length{let n=stream.read(&mut chunk).await.unwrap();assert!(n>0);bytes.extend_from_slice(&chunk[..n]);}
                        let request=Request{method,path,headers,body:bytes[end..end+length].to_vec()};
                        let(status,body)=match handler(request).await{Reply::Json(status,value)=>(status,serde_json::to_vec(&value).unwrap()),Reply::Empty(status)=>(status,vec![]),Reply::Lost=>return};
                        let header=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());stream.write_all(header.as_bytes()).await.unwrap();stream.write_all(&body).await.unwrap();let _=stream.shutdown().await;
                    });},
                    finished=children.join_next(),if !children.is_empty()=>{finished.unwrap().unwrap();}
                }
            }
        });
        Self { root, client, task }
    }
    async fn start(&self) -> Running {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut app = App::open(
            &self.root.join("workspace"),
            port,
            NATIVE.into(),
            String::new(),
        )
        .unwrap();
        Arc::get_mut(&mut app.0).unwrap().client = self.client.clone();
        let router = app.router();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Running {
            app,
            base: format!("http://127.0.0.1:{port}"),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(10))
                .pool_max_idle_per_host(0)
                .build()
                .unwrap(),
            stop: Some(stop),
            task: Some(task),
        }
    }
}
struct Running {
    app: App,
    base: String,
    client: reqwest::Client,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Running {
    async fn shutdown(mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.task.take().unwrap().await.unwrap();
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        owner: &str,
        body: &Value,
    ) -> reqwest::RequestBuilder {
        self.client
            .request(method.parse().unwrap(), format!("{}{path}", self.base))
            .bearer_auth(NATIVE)
            .header("x-genmail-account", owner)
            .header("x-morrow-view", "paged")
            .json(body)
    }
    async fn call(&self, method: &str, path: &str, owner: &str, body: Value) -> (u16, Value) {
        let response = self
            .request(method, path, owner, &body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let value = response.json().await.unwrap();
        (status, value)
    }
}
async fn set(app: &App, value: Value) {
    app.db(move |db| {
        db.set_settings(&value)?;
        Ok(())
    })
    .await
    .unwrap();
}
fn connection(provider: &str, owner: &str) -> Value {
    json!({"email":owner,"provider":provider,"connectionId":format!("connection-{owner}"),"accessToken":format!("fixture-{owner}"),"refreshToken":format!("refresh-{owner}"),"clientId":"fixture-client","clientSecret":"fixture-secret","expiresAt":chrono::Utc::now().timestamp_millis()+3600000,"grantedScopes":if provider=="google"{"https://www.googleapis.com/auth/gmail.modify"}else{"User.Read Mail.ReadWrite Mail.Send"}})
}
fn config(entries: &[(&str, &str)]) -> Value {
    let accounts = entries
        .iter()
        .map(|(owner, provider)| (owner.to_string(), connection(provider, owner)))
        .collect::<serde_json::Map<_, _>>();
    json!({"mailAccounts":accounts,"mail":accounts[entries[0].0],"activeAccount":entries.last().unwrap().0,"preferences":{"displayName":"Fixture Sender"}})
}
fn cached(id: &str, owner: &str, folder: &str) -> Value {
    json!({"id":id,"fromName":"Fixture","fromEmail":owner,"to":owner,"subject":"Original","body":"Cached body","preview":"Cached body","folder":folder,"date":"2026-09-25T00:00:00.000Z","read":false,"starred":false,"category":"primary","labels":[],"messageId":format!("<original-{owner}>")})
}
fn outgoing(id: &str) -> Value {
    json!({"requestId":id,"to":"visible@example.invalid","cc":"copy@example.invalid","bcc":"hidden@example.invalid","subject":"Reviewed subject 中文","body":"Reviewed body\n第二行","replyToId":"same","footer":{"text":"Signature","html":""}})
}
fn google_message(id: &str, owner: &str, body: &str) -> Value {
    json!({"id":id,"internalDate":"1790294400000","labelIds":["INBOX","UNREAD"],"payload":{"mimeType":"text/plain","headers":[{"name":"From","value":format!("Fixture <{owner}>")},{"name":"To","value":owner},{"name":"Subject","value":"Synced subject"},{"name":"Message-ID","value":format!("<remote-{id}@example.invalid>")}],"body":{"data":URL_SAFE_NO_PAD.encode(body)}}})
}
fn microsoft_message(id: &str, owner: &str, body: &str) -> Value {
    json!({"id":id,"from":{"emailAddress":{"name":"Fixture","address":owner}},"toRecipients":[{"emailAddress":{"address":owner}}],"subject":"Synced subject","body":{"contentType":"text","content":body},"receivedDateTime":"2026-09-25T00:00:00Z","isRead":false,"flag":{"flagStatus":"notFlagged"},"internetMessageId":format!("<remote-{id}@example.invalid>")})
}
async fn wait_for(gate: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(5), gate.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

#[tokio::test]
async fn provider_spam_folders_moves_and_restore() {
    for (labels, folder) in [
        (json!(["TRASH", "SPAM", "DRAFT"]), "trash"),
        (json!(["SPAM", "DRAFT", "INBOX", "SENT"]), "spam"),
    ] {
        assert_eq!(providers::google_folder(&labels), folder);
        assert_eq!(
            providers::normalize_google(&json!({"id":"same","labelIds":labels})).unwrap()["folder"],
            folder
        );
    }
    let calls = Arc::new(Mutex::new(Vec::<Request>::new()));
    let captured = calls.clone();
    let invalid_junk = Arc::new(AtomicUsize::new(0));
    let invalid = invalid_junk.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let captured = captured.clone();
        let invalid = invalid.clone();
        async move {
            captured.lock().unwrap().push(request.clone());
            let url =
                url::Url::parse(&format!("https://{}{}", request.host(), request.path)).unwrap();
            if request.host() == "gmail.googleapis.com" {
                assert_eq!(request.owner(), A);
                if url.path().ends_with("/labels") {
                    return Reply::Json(
                        200,
                        json!({"labels":[
                            {"id":"SPAM","name":"SPAM","type":"system"},
                            {"id":"TRASH","name":"TRASH","type":"system"},
                            {"id":"Label_1","name":"Spam","type":"user"}
                        ]}),
                    );
                }
                assert_eq!(request.method, "POST");
                assert_eq!(url.path(), "/gmail/v1/users/me/messages/remote/modify");
                let body = request.json();
                let target = if body["addLabelIds"] == json!(["SPAM"]) {
                    assert_eq!(body["removeLabelIds"], json!(["INBOX"]));
                    "SPAM"
                } else {
                    assert_eq!(
                        body,
                        json!({"addLabelIds":["INBOX"],"removeLabelIds":["SPAM"]})
                    );
                    "INBOX"
                };
                return Reply::Json(
                    200,
                    json!({"labelIds":["UNREAD","STARRED","SENT","Label_1",target]}),
                );
            }
            assert_eq!(request.owner(), B);
            match url.path() {
                "/v1.0/me/mailFolders" => Reply::Json(
                    200,
                    json!({"value":[
                        {"id":"inbox-id","displayName":"Inbox"},
                        {"id":"custom-id","displayName":"Junk Email"},
                        {"id":"junk-id","displayName":"垃圾郵件"}
                    ]}),
                ),
                "/v1.0/me/mailFolders/inbox" => Reply::Json(200, json!({"id":"inbox-id"})),
                "/v1.0/me/mailFolders/junkemail" => Reply::Json(
                    200,
                    if invalid.load(Ordering::SeqCst) == 0 {
                        json!({"id":"junk-id"})
                    } else {
                        json!({"id":null})
                    },
                ),
                "/v1.0/me/messages/remote" => {
                    assert_eq!(request.headers["prefer"], "IdType=\"ImmutableId\"");
                    Reply::Json(200, json!({"id":"remote","parentFolderId":"inbox-id"}))
                }
                "/v1.0/me/messages/remote/move" => {
                    assert_eq!(request.method, "POST");
                    assert_eq!(request.headers["prefer"], "IdType=\"ImmutableId\"");
                    assert_eq!(request.json(), json!({"destinationId":"junk-id"}));
                    Reply::Json(201, json!({"id":"remote","parentFolderId":"junk-id"}))
                }
                _ => panic!("Unexpected fixture request: {}", request.path),
            }
        }
        .boxed()
    }))
    .await;
    let google = connection("google", A);
    let folders = providers::folders(&fixture.client, &google).await.unwrap();
    assert_eq!(
        folders,
        vec![
            json!({"id":"INBOX","name":"Inbox","kind":"inbox"}),
            json!({"id":"__archive","name":"Archive (remove Inbox)","kind":"archive"}),
            json!({"id":"SPAM","name":"Spam","kind":"spam"}),
            json!({"id":"Label_1","name":"Spam","kind":"label"}),
        ]
    );
    let message = json!({"id":"google:local","remoteId":"google:remote"});
    let count = calls.lock().unwrap().len();
    for mode in ["addLabel", "removeLabel"] {
        assert!(
            providers::organize(&fixture.client, &google, &message, &folders[2], mode)
                .await
                .is_err()
        );
    }
    let mut readonly = google.clone();
    readonly["grantedScopes"] = "https://www.googleapis.com/auth/gmail.readonly".into();
    assert_eq!(
        providers::organize(&fixture.client, &readonly, &message, &folders[2], "move")
            .await
            .unwrap_err()
            .status,
        403
    );
    assert_eq!(calls.lock().unwrap().len(), count);
    let moved = providers::organize(&fixture.client, &google, &message, &folders[2], "move")
        .await
        .unwrap();
    assert_eq!(moved["folder"], "spam");
    assert_eq!(moved["providerSent"], true);
    assert_eq!(
        moved["providerLabelIds"],
        json!(["UNREAD", "STARRED", "SENT", "Label_1", "SPAM"])
    );
    let restored = providers::organize(&fixture.client, &google, &message, &folders[0], "move")
        .await
        .unwrap();
    assert_eq!(restored["folder"], "inbox");
    assert_eq!(
        restored["providerLabelIds"],
        json!(["UNREAD", "STARRED", "SENT", "Label_1", "INBOX"])
    );
    assert_eq!(message["id"], "google:local");

    let microsoft = connection("microsoft", B);
    let folders = providers::folders(&fixture.client, &microsoft)
        .await
        .unwrap();
    assert_eq!(folders[1]["kind"], "folder");
    assert_eq!(
        folders[2],
        json!({"id":"junk-id","name":"垃圾郵件","kind":"spam"})
    );
    let moved = providers::organize(
        &fixture.client,
        &microsoft,
        &json!({"id":"microsoft:local","remoteId":"microsoft:remote"}),
        &folders[2],
        "move",
    )
    .await
    .unwrap();
    assert_eq!(moved["folder"], "spam");
    assert_eq!(moved["remoteId"], "microsoft:remote");
    assert_eq!(moved["providerFolderId"], "junk-id");
    invalid_junk.store(1, Ordering::SeqCst);
    assert!(
        providers::folders(&fixture.client, &microsoft)
            .await
            .is_err()
    );
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "POST")
            .count(),
        3
    );
}

#[tokio::test]
async fn both_provider_send_routes_preserve_bcc_owner_reply_and_idempotency() {
    let received = Arc::new(Mutex::new(Vec::<Request>::new()));
    let captured = received.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let captured = captured.clone();
        async move {
            assert_eq!(request.method, "POST");
            assert!(
                request.path.ends_with("/messages/send") || request.path == "/v1.0/me/sendMail"
            );
            let ms = request.host() == "graph.microsoft.com";
            captured.lock().unwrap().push(request);
            if ms {
                Reply::Empty(202)
            } else {
                Reply::Json(200, json!({"id":"accepted"}))
            }
        }
        .boxed()
    }))
    .await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "microsoft")])).await;
    server
        .app
        .db(|db| {
            for owner in [A, B] {
                db.upsert(owner, &cached("same", owner, "inbox"))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    for owner in ["", "all", "disconnected@example.invalid"] {
        assert_eq!(
            server
                .call("POST", "/api/send", owner, outgoing("send-invalid-123"))
                .await
                .0,
            409
        );
    }
    assert!(received.lock().unwrap().is_empty());
    for (owner, provider) in [(A, "google"), (B, "microsoft")] {
        let body = outgoing(&format!("send-{provider}-123"));
        let saved = server
            .call("POST", "/api/drafts", owner, body.clone())
            .await;
        assert_eq!(saved.0, 200, "{}", saved.1);
        let draft = string(&saved.1["message"], "id");
        let send = merge(body.clone(), &json!({"draftId":draft}));
        let sent = server.call("POST", "/api/send", owner, send.clone()).await;
        assert_eq!(sent.0, 200, "{}", sent.1);
        assert_eq!(sent.1["message"]["accountId"], owner);
        assert_eq!(sent.1["message"]["fromEmail"], owner);
        assert_eq!(sent.1["message"]["bcc"], "hidden@example.invalid");
        assert_eq!(sent.1["simulated"], false);
        let request = received.lock().unwrap().last().unwrap().clone();
        assert_eq!(request.owner(), owner);
        let parsed = request.parsed_mail();
        assert_eq!(parsed["fromEmail"], owner);
        assert_eq!(parsed["to"], body["to"]);
        assert_eq!(parsed["cc"], body["cc"]);
        assert_eq!(parsed["bcc"], body["bcc"]);
        assert_eq!(parsed["subject"], body["subject"]);
        assert_eq!(parsed["body"], "Reviewed body\n第二行\n\nSignature");
        let mime = String::from_utf8(request.mime()).unwrap();
        assert!(mime.contains(&format!("In-Reply-To: <original-{owner}>")));
        assert!(mime.contains("Bcc: hidden@example.invalid"));
        let replay = server.call("POST", "/api/send", owner, send.clone()).await;
        assert_eq!(replay, sent);
        for key in ["to", "cc", "bcc"] {
            let changed = merge(send.clone(), &json!({key:"different@example.invalid"}));
            assert_eq!(
                server.call("POST", "/api/send", owner, changed).await.0,
                409
            );
        }
        let owner = owner.to_owned();
        let draft = draft.to_owned();
        server
            .app
            .db(move |db| {
                assert!(db.get(&owner, &draft)?.is_none());
                assert_eq!(db.get(&owner, "same")?.unwrap()["folder"], "inbox");
                Ok(())
            })
            .await
            .unwrap();
    }
    assert_eq!(received.lock().unwrap().len(), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn uncertain_delivery_is_durable_before_network_and_requires_exact_review_after_restart() {
    for provider in ["google", "microsoft"] {
        let received = Arc::new(Mutex::new(Vec::<Request>::new()));
        let captured = received.clone();
        let entered = Arc::new(Semaphore::new(0));
        let started = entered.clone();
        let release = Arc::new(Semaphore::new(0));
        let finish = release.clone();
        let fixture = Fixture::new(Arc::new(move |request| {
            let captured = captured.clone();
            let started = started.clone();
            let finish = finish.clone();
            async move {
                let first = {
                    let mut calls = captured.lock().unwrap();
                    calls.push(request.clone());
                    calls.len() == 1
                };
                if first {
                    started.add_permits(1);
                    finish.acquire().await.unwrap().forget();
                    Reply::Lost
                } else if request.host() == "graph.microsoft.com" {
                    Reply::Empty(202)
                } else {
                    Reply::Json(200, json!({"id":"accepted"}))
                }
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        set(&server.app, config(&[(A, provider), (B, "google")])).await;
        server
            .app
            .db(|db| {
                db.upsert(A, &cached("same", A, "inbox"))?;
                Ok(())
            })
            .await
            .unwrap();
        let body = outgoing("uncertain-request-123");
        let request = server.request("POST", "/api/send", A, &body);
        let pending = tokio::spawn(async move { request.send().await.unwrap() });
        wait_for(&entered).await;
        let saved = server
            .app
            .db(|db| {
                let config = db.settings()?;
                let record = &config["deliveryAttempts"][0];
                assert_eq!(record["account"], A);
                assert_eq!(record["requestId"], "uncertain-request-123");
                let draft = db.get(A, string(record, "draftId"))?.unwrap();
                assert_eq!(draft["deliveryStatus"], "unconfirmed");
                assert_eq!(draft["bcc"], "hidden@example.invalid");
                assert_eq!(draft["body"], "Reviewed body\n第二行");
                assert!(db.get(A, "sent:uncertain-request-123")?.is_none());
                Ok(json!({"record":record,"draft":draft}))
            })
            .await
            .unwrap();
        assert_eq!(
            server
                .call("POST", "/api/account/disconnect", A, json!({}))
                .await
                .0,
            409
        );
        assert_eq!(
            server.call("POST", "/api/send", A, body.clone()).await.0,
            409
        );
        release.add_permits(1);
        let failed = pending.await.unwrap();
        assert_eq!(failed.status(), 502);
        let failed: Value = failed.json().await.unwrap();
        assert_eq!(failed["requiresSendReview"], true);
        assert_eq!(failed["draftId"], saved["record"]["draftId"]);
        assert_eq!(failed["deliveryRequestId"], "uncertain-request-123");
        assert!(!failed.to_string().contains("fixture-secret"));
        assert_eq!(
            received.lock().unwrap().len(),
            1,
            "a dropped delivery response must not resend"
        );
        assert_eq!(
            server.call("POST", "/api/send", A, body.clone()).await.0,
            409
        );
        server.shutdown().await;
        let server = fixture.start().await;
        let persisted = server.app.settings().await.unwrap();
        assert_eq!(persisted["deliveryAttempts"][0], saved["record"]);
        server
            .app
            .db(|db| {
                assert!(db.get(A, "sent:uncertain-request-123")?.is_none());
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            server.call("POST", "/api/send", A, body.clone()).await.0,
            409
        );
        let review = merge(
            body.clone(),
            &json!({"draftId":failed["draftId"],"retryUnconfirmed":true}),
        );
        for changed in [
            json!({"bcc":"changed@example.invalid"}),
            json!({"body":"Changed text"}),
            json!({"requestId":"different-request-456"}),
        ] {
            assert_eq!(
                server
                    .call("POST", "/api/send", A, merge(review.clone(), &changed))
                    .await
                    .0,
                409
            );
        }
        let edit = merge(body.clone(), &json!({"id":failed["draftId"]}));
        assert_eq!(server.call("POST", "/api/drafts", A, edit).await.0, 409);
        assert_eq!(received.lock().unwrap().len(), 1);
        let retried = server.call("POST", "/api/send", A, review.clone()).await;
        assert_eq!(retried.0, 200, "{}", retried.1);
        assert_eq!(retried.1["message"]["id"], "sent:uncertain-request-123");
        assert_eq!(retried.1["message"]["bcc"], "hidden@example.invalid");
        assert!(
            server.app.settings().await.unwrap()["deliveryAttempts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        {
            let calls = received.lock().unwrap();
            assert_eq!(calls.len(), 2);
            let first = calls[0].parsed_mail();
            let second = calls[1].parsed_mail();
            for key in ["fromEmail", "to", "cc", "bcc", "subject", "body"] {
                assert_eq!(first[key], second[key], "retried {key}");
            }
        }
        assert_eq!(
            server.call("POST", "/api/send", A, review.clone()).await,
            retried
        );
        server.shutdown().await;
        let server = fixture.start().await;
        assert_eq!(server.call("POST", "/api/send", A, review).await, retried);
        assert_eq!(received.lock().unwrap().len(), 2);
        server.shutdown().await;
    }
}

#[tokio::test]
async fn sync_combined_owners_keep_local_patches_and_stable_ids_after_provider_moves() {
    let version = Arc::new(AtomicUsize::new(0));
    let current = version.clone();
    let moved = Arc::new(AtomicUsize::new(0));
    let changed = moved.clone();
    let calls = Arc::new(Mutex::new(Vec::<Request>::new()));
    let captured = calls.clone();
    let fixture=Fixture::new(Arc::new(move|request|{let current=current.clone();let changed=changed.clone();let captured=captured.clone();async move{let owner=request.owner().to_owned();let path=url::Url::parse(&format!("https://{}{}",request.host(),request.path)).unwrap();captured.lock().unwrap().push(request.clone());let body=format!("Remote body {} for {owner}",current.load(Ordering::SeqCst));
        if request.host()=="gmail.googleapis.com"{assert_eq!(request.method,"GET");if path.path().ends_with("/labels"){return Reply::Json(200,json!({"labels":[]}));}
        if path.path().ends_with("/messages"){return Reply::Json(200,json!({"messages":[{"id":"same"}]}));}return Reply::Json(200,google_message("same",&owner,&body));}
        if path.path()=="/v1.0/me/mailFolders"{return Reply::Json(200,json!({"value":[{"id":"inbox-id","displayName":"Inbox","childFolderCount":0},{"id":"archive-id","displayName":"Archive","childFolderCount":0}]}));}
        if path.path()=="/v1.0/me/mailFolders/inbox"{return Reply::Json(200,json!({"id":"inbox-id"}));}
        if path.path()=="/v1.0/me/mailFolders/junkemail"{return Reply::Json(200,json!({"id":"junk-id"}));}
        if path.path().ends_with("/messages/same/move"){assert_eq!(request.method,"POST");assert_eq!(request.json()["destinationId"],"archive-id");assert_eq!(request.headers["prefer"],"IdType=\"ImmutableId\"");changed.store(1,Ordering::SeqCst);return Reply::Json(201,json!({"id":"moved-id","parentFolderId":"archive-id"}));}
        if path.path().ends_with("/messages/same"){return Reply::Json(200,json!({"id":"same","parentFolderId":"inbox-id"}));}
        assert_eq!(path.path(),"/v1.0/me/mailFolders/inbox/messages");assert!(request.headers["prefer"].to_str().unwrap().contains("IdType=\"ImmutableId\""));Reply::Json(200,json!({"value":[microsoft_message(if changed.load(Ordering::SeqCst)>0{"moved-id"}else{"same"},&owner,&body)]}))
    }.boxed()})).await;
    let server = fixture.start().await;
    set(
        &server.app,
        config(&[(A, "google"), (B, "google"), (C, "microsoft")]),
    )
    .await;
    let first = server.call("POST", "/api/sync", "all", json!({})).await;
    assert_eq!(first.0, 200, "{}", first.1);
    assert_eq!(first.1["messages"].as_array().unwrap().len(), 3);
    assert!(
        first.1["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["accountId"] != "demo")
    );
    let ids = first.1["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["viewId"].clone())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 3);
    assert_eq!(
        server
            .call(
                "PATCH",
                "/api/messages/google%3Asame",
                A,
                json!({"read":true,"starred":true,"folder":"archive"})
            )
            .await
            .0,
        200
    );
    server
        .app
        .db(|db| {
            db.update(A, "google:same", &json!({"labels":["Local reviewed"]}))?;
            Ok(())
        })
        .await
        .unwrap();
    let denied = server
        .call(
            "POST",
            "/api/messages/microsoft%3Asame/organize",
            C,
            json!({"mode":"move","destinationId":"archive-id","confirmed":false}),
        )
        .await;
    assert_eq!(denied.0, 400);
    let moved_result = server
        .call(
            "POST",
            "/api/messages/microsoft%3Asame/organize",
            C,
            json!({"mode":"move","destinationId":"archive-id","confirmed":true}),
        )
        .await;
    assert_eq!(moved_result.0, 200, "{}", moved_result.1);
    assert_eq!(moved_result.1["message"]["id"], "microsoft:same");
    assert_eq!(moved_result.1["message"]["remoteId"], "microsoft:moved-id");
    version.store(1, Ordering::SeqCst);
    let refreshed = server.call("POST", "/api/sync", "all", json!({})).await;
    assert_eq!(refreshed.0, 200, "{}", refreshed.1);
    server
        .app
        .db(|db| {
            let a = db.get(A, "google:same")?.unwrap();
            let b = db.get(B, "google:same")?.unwrap();
            let c = db.get(C, "microsoft:same")?.unwrap();
            assert_eq!(a["folder"], "archive");
            assert_eq!(a["read"], true);
            assert_eq!(a["starred"], true);
            assert_eq!(a["labels"], json!(["Local reviewed"]));
            assert_eq!(a["body"], format!("Remote body 1 for {A}"));
            assert_eq!(b["folder"], "inbox");
            assert_eq!(b["read"], false);
            assert_eq!(b["starred"], false);
            assert_eq!(b["body"], format!("Remote body 1 for {B}"));
            assert_eq!(c["folder"], "archive");
            assert_eq!(c["providerFolderId"], "archive-id");
            assert_eq!(c["remoteId"], "microsoft:moved-id");
            assert!(db.get(C, "microsoft:moved-id")?.is_none());
            assert_eq!(db.list(C)?.len(), 1);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "POST")
            .count(),
        1,
        "only the explicitly confirmed fixture move writes"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn oauth_reconnect_canonicalizes_identity_revokes_generation_and_disconnect_keeps_cache() {
    let token_calls = Arc::new(AtomicUsize::new(0));
    let count = token_calls.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let count = count.clone();
        async move {
            if request.host() == "oauth2.googleapis.com" {
                assert_eq!(request.method, "POST");
                let form = url::form_urlencoded::parse(&request.body)
                    .collect::<std::collections::HashMap<_, _>>();
                assert_eq!(form["grant_type"], "authorization_code");
                assert!((43..=128).contains(&form["code_verifier"].len()));
                count.fetch_add(1, Ordering::SeqCst);
                return Reply::Json(200, json!({"access_token":format!("fixture-{A}"),"refresh_token":"new-refresh-token","expires_in":3600}));
            }
            if request.path.ends_with("/profile") {
                return Reply::Json(200, json!({"emailAddress":"A@EXAMPLE.INVALID"}));
            }
            if request.path.contains("/messages?") {
                return Reply::Json(200, json!({"messages":[]}));
            }
            panic!("Unexpected fixture endpoint: {}", request.path);
        }.boxed()
    })).await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "microsoft")])).await;
    server
        .app
        .db(|db| {
            db.upsert(A, &cached("same", A, "inbox"))?;
            db.upsert(A, &cached("draft", A, "drafts"))?;
            db.upsert(B, &cached("same", B, "inbox"))?;
            db.set_settings(&json!({"backgroundSyncErrors":[{"accountId":A,"code":"rate_limited","nextRetryAt":"2099-01-01T00:00:00.000Z"},{"accountId":B,"code":"rate_limited","nextRetryAt":"2099-01-01T00:00:00.000Z"}]}))?;
            Ok(())
        })
        .await
        .unwrap();
    let before = server.app.settings().await.unwrap();
    let old_generation = ai::generation(&before, A);
    let old_connection = before["mailAccounts"][A]["connectionId"].clone();
    let preview = server
        .call(
            "POST",
            "/api/workflows/preview",
            A,
            json!({"action":"research","messageId":"same"}),
        )
        .await;
    assert_eq!(preview.0, 200);
    let started = server
        .call(
            "POST",
            "/api/oauth/google/start",
            A,
            json!({"clientId":"fixture-client","clientSecret":"fixture-secret"}),
        )
        .await;
    assert_eq!(started.0, 200);
    let authorize = url::Url::parse(string(&started.1, "url")).unwrap();
    let auth = server
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
    assert_eq!(auth.status(), 302);
    let cookie = auth.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let external = url::Url::parse(auth.headers()["location"].to_str().unwrap()).unwrap();
    let query = external
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(query["scope"].contains("gmail.send"));
    let callback = format!(
        "{}/api/oauth/google/callback?state={}&code=fixture-code",
        server.base, query["state"]
    );
    let response = server
        .client
        .get(&callback)
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    let location = url::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    assert!(
        location
            .query_pairs()
            .any(|(key, value)| key == "connected" && value == "google")
    );
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);
    let after = server.app.settings().await.unwrap();
    assert_eq!(connections(&after).as_object().unwrap().len(), 2);
    assert!(after["mailAccounts"].get("A@EXAMPLE.INVALID").is_none());
    assert_ne!(after["mailAccounts"][A]["connectionId"], old_connection);
    assert_ne!(ai::generation(&after, A), old_generation);
    assert_eq!(after["mailAccounts"][B], before["mailAccounts"][B]);
    assert_eq!(after["backgroundSyncErrors"].as_array().unwrap().len(), 1);
    assert_eq!(after["backgroundSyncErrors"][0]["accountId"], B);
    assert_eq!(
        after["mailAccounts"][A]["refreshToken"],
        "new-refresh-token"
    );
    assert_eq!(
        server
            .call(
                "POST",
                "/api/workflows/apply",
                A,
                json!({"previewId":preview.1["preview"]["id"]})
            )
            .await
            .0,
        409
    );
    let replay = server.client.get(callback).send().await.unwrap();
    assert_eq!(replay.status(), 302);
    assert!(
        replay.headers()["location"]
            .to_str()
            .unwrap()
            .contains("connectionError=")
    );
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);
    server.app.db(|db| {
        let mut errors = db.settings()?["backgroundSyncErrors"].as_array().cloned().unwrap();
        errors.push(json!({"accountId":A,"code":"rate_limited","nextRetryAt":"2099-01-01T00:00:00.000Z"}));
        db.set_settings(&json!({"backgroundSyncErrors":errors}))
    }).await.unwrap();
    let disconnected = server
        .call("POST", "/api/account/disconnect", A, json!({}))
        .await;
    assert_eq!(disconnected.0, 200);
    assert!(!disconnected.1.to_string().contains("new-refresh-token"));
    let final_settings = server.app.settings().await.unwrap();
    assert!(final_settings["mailAccounts"].get(A).is_none());
    assert_eq!(final_settings["mailAccounts"][B], before["mailAccounts"][B]);
    assert_eq!(
        final_settings["backgroundSyncErrors"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(final_settings["backgroundSyncErrors"][0]["accountId"], B);
    assert_ne!(
        ai::generation(&final_settings, A),
        ai::generation(&after, A)
    );
    assert_eq!(
        server
            .call("POST", "/api/send", A, outgoing("disconnected-send-123"))
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .call("POST", "/api/drafts", A, json!({"body":"Rejected"}))
            .await
            .0,
        409
    );
    server
        .app
        .db(|db| {
            assert!(db.get(A, "same")?.is_some());
            assert!(db.get(A, "draft")?.is_some());
            assert!(db.get(B, "same")?.is_some());
            Ok(())
        })
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test]
async fn stale_oauth_and_busy_callback_keep_the_newer_connection() {
    let fixture = Fixture::new(Arc::new(|request| async move {
        if request.host() == "oauth2.googleapis.com" {
            return Reply::Json(200, json!({"access_token":"fixture-new","refresh_token":"fixture-refresh","expires_in":3600}));
        }
        if request.path.ends_with("/profile") { return Reply::Json(200, json!({"emailAddress":A})); }
        if request.path.contains("/messages?") { return Reply::Json(200, json!({"messages":[]})); }
        panic!("Unexpected OAuth fixture endpoint: {}", request.path);
    }.boxed())).await;
    let server = fixture.start().await;
    set(&server.app, config(&[(A, "google"), (B, "microsoft")])).await;
    let original_b = server.app.settings().await.unwrap()["mailAccounts"][B].clone();
    async fn attempt(server: &Running) -> (String, String) {
        let started = server
            .call(
                "POST",
                "/api/oauth/google/start",
                A,
                json!({"clientId":"fixture-client","clientSecret":"fixture-secret"}),
            )
            .await;
        assert_eq!(started.0, 200);
        let url = url::Url::parse(string(&started.1, "url")).unwrap();
        let auth = server
            .client
            .get(format!(
                "{}{}?{}",
                server.base,
                url.path(),
                url.query().unwrap()
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(auth.status(), 302);
        let cookie = auth.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let state = url.query_pairs().find(|(key, _)| key == "state").unwrap().1;
        (
            format!(
                "{}/api/oauth/google/callback?state={state}&code=fixture-code",
                server.base
            ),
            cookie,
        )
    }
    let (stale_url, stale_cookie) = attempt(&server).await;
    server
        .app
        .db(|db| {
            let mut accounts = connections(&db.settings()?);
            accounts[A]["connectionId"] = "newer-connection".into();
            accounts[A]["refreshToken"] = "newer-refresh".into();
            db.set_settings(&json!({"mailAccounts":accounts}))?;
            Ok(())
        })
        .await
        .unwrap();
    let stale = server
        .client
        .get(&stale_url)
        .header("cookie", stale_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 302);
    assert!(
        stale.headers()["location"]
            .to_str()
            .unwrap()
            .contains("connectionError=")
    );
    let current = server.app.settings().await.unwrap();
    assert_eq!(
        current["mailAccounts"][A]["connectionId"],
        "newer-connection"
    );
    assert_eq!(current["mailAccounts"][A]["refreshToken"], "newer-refresh");
    assert_eq!(current["mailAccounts"][B], original_b);

    let (retry_url, retry_cookie) = attempt(&server).await;
    let guard = server.app.0.mailbox.lock().await;
    let busy = server
        .client
        .get(&retry_url)
        .header("cookie", &retry_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), 409);
    drop(guard);
    let retry = server
        .client
        .get(&retry_url)
        .header("cookie", retry_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), 302);
    assert!(
        retry.headers()["location"]
            .to_str()
            .unwrap()
            .contains("connected=google")
    );
    server.shutdown().await;
}

#[tokio::test]
async fn refresh_rotation_is_account_bound_and_changed_connection_discards_sync() {
    let entered = Arc::new(Semaphore::new(0));
    let started = entered.clone();
    let release = Arc::new(Semaphore::new(0));
    let finish = release.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let started = started.clone();
        let finish = finish.clone();
        let calls = calls.clone();
        async move {
            if request.host() == "oauth2.googleapis.com" {
                calls.fetch_add(1, Ordering::SeqCst);
                let form = url::form_urlencoded::parse(&request.body)
                    .collect::<std::collections::HashMap<_, _>>();
                assert_eq!(form["grant_type"], "refresh_token");
                assert_eq!(form["refresh_token"], format!("refresh-{A}"));
                started.add_permits(1);
                finish.acquire().await.unwrap().forget();
                return Reply::Json(200, json!({"access_token":format!("fixture-{A}"),"refresh_token":"rotated-refresh","expires_in":3600}));
            }
            if request.path.ends_with("/labels") {
                assert_eq!(request.method, "GET");
                return Reply::Json(200, json!({"labels":[]}));
            }
            if request.path.contains("/messages?") {
                return Reply::Json(200, json!({"messages":[{"id":"fresh"}]}));
            }
            Reply::Json(200, google_message("fresh", A, "Fresh body"))
        }.boxed()
    })).await;
    let server = fixture.start().await;
    let mut settings = config(&[(A, "google"), (B, "microsoft")]);
    settings["mailAccounts"][A]["expiresAt"] = 0.into();
    set(&server.app, settings.clone()).await;
    let request = server.request("POST", "/api/sync", A, &json!({}));
    let pending = tokio::spawn(async move { request.send().await.unwrap() });
    wait_for(&entered).await;
    assert_eq!(
        server
            .call("POST", "/api/account/disconnect", A, json!({}))
            .await
            .0,
        409
    );
    // Fault injection at the database boundary represents a connection replacement during refresh.
    server
        .app
        .db(|db| {
            let mut settings = db.settings()?;
            settings["mailAccounts"][A]["connectionId"] = "replacement".into();
            db.set_settings(&json!({"mailAccounts":settings["mailAccounts"]}))?;
            Ok(())
        })
        .await
        .unwrap();
    release.add_permits(1);
    assert_eq!(pending.await.unwrap().status(), 502);
    let after = server.app.settings().await.unwrap();
    assert_eq!(after["mailAccounts"][A]["connectionId"], "replacement");
    assert_eq!(
        after["mailAccounts"][A]["refreshToken"],
        settings["mailAccounts"][A]["refreshToken"]
    );
    assert_eq!(after["mailAccounts"][B], settings["mailAccounts"][B]);
    server
        .app
        .db(|db| {
            assert!(db.get(A, "google:fresh")?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    release.add_permits(1);
    let synced = server.call("POST", "/api/sync", A, json!({})).await;
    assert_eq!(synced.0, 200, "{}", synced.1);
    let after = server.app.settings().await.unwrap();
    assert_eq!(after["mailAccounts"][A]["refreshToken"], "rotated-refresh");
    assert_eq!(after["mailAccounts"][A]["connectionId"], "replacement");
    assert_eq!(after["mailAccounts"][B], settings["mailAccounts"][B]);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn oauth_refresh_failures_preserve_accounts_and_only_revoked_grants_require_reconnect() {
    for provider in ["google", "microsoft"] {
        let mode = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let (kind, count) = (mode.clone(), calls.clone());
        let fixture = Fixture::new(Arc::new(move |request| {
            let (kind, count) = (kind.clone(), count.clone());
            async move {
                assert!(["oauth2.googleapis.com", "login.microsoftonline.com"].contains(&request.host()));
                let form = url::form_urlencoded::parse(&request.body).collect::<std::collections::HashMap<_,_>>();
                assert_eq!(form["grant_type"], "refresh_token");
                assert_eq!(form["refresh_token"], format!("refresh-{A}"));
                assert_eq!(form["client_id"], "fixture-client");
                count.fetch_add(1, Ordering::SeqCst);
                match kind.load(Ordering::SeqCst) {
                    0 => Reply::Lost,
                    1 => Reply::Json(503, json!({"error":"PRIVATE_PROVIDER_SECRET"})),
                    2 => Reply::Json(429, json!({"error":"PRIVATE_PROVIDER_SECRET"})),
                    3 => Reply::Json(400, json!({"error":"invalid_grant","error_description":"PRIVATE_PROVIDER_SECRET"})),
                    4 => Reply::Json(401, json!({"error":"invalid_client","error_description":"PRIVATE_PROVIDER_SECRET"})),
                    5 => Reply::Json(200, json!({"access_token":"","expires_in":3600})),
                    _ => Reply::Json(400, json!({"error":"invalid_grant","error_description":"PRIVATE_PROVIDER_SECRET".repeat(4000)})),
                }
            }.boxed()
        })).await;
        let server = fixture.start().await;
        let mut settings = config(&[(A, provider), (B, "microsoft")]);
        settings["mailAccounts"][A]["expiresAt"] = 0.into();
        set(&server.app, settings.clone()).await;
        for (value, code, recovery) in [
            (0, "oauth_refresh_failed", "retry"),
            (1, "oauth_refresh_failed", "retry"),
            (2, "oauth_refresh_failed", "retry"),
            (3, "oauth_reconnect_required", "reconnect"),
            (4, "oauth_configuration", "configure"),
            (5, "oauth_refresh_failed", "retry"),
            (6, "oauth_refresh_failed", "retry"),
        ] {
            mode.store(value, Ordering::SeqCst);
            let before = calls.load(Ordering::SeqCst);
            let result = server.call("POST", "/api/sync", A, json!({})).await;
            assert_eq!(result.0, 502, "{}", result.1);
            assert_eq!(result.1["code"], code);
            assert_eq!(result.1["recoveryAction"], recovery);
            assert_eq!(calls.load(Ordering::SeqCst), before + 1);
            if recovery != "reconnect" {
                assert!(
                    !string(&result.1, "error")
                        .to_lowercase()
                        .contains("reconnect")
                );
                assert!(
                    !string(&result.1, "error")
                        .to_lowercase()
                        .contains("expired")
                );
            }
            let state = server.call("GET", "/api/state", A, json!({})).await;
            assert_eq!(state.0, 200, "{}", state.1);
            assert_eq!(state.1["settings"]["mail"]["configured"], true);
            assert_eq!(state.1["syncErrors"][0]["code"], code);
            for secret in ["PRIVATE_PROVIDER_SECRET", "refresh-", "fixture-secret"] {
                assert!(!state.1.to_string().contains(secret));
                assert!(!result.1.to_string().contains(secret));
            }
            assert_eq!(
                server.app.settings().await.unwrap()["mailAccounts"],
                settings["mailAccounts"]
            );
        }
        let mut without_refresh = settings["mailAccounts"].clone();
        without_refresh[A]
            .as_object_mut()
            .unwrap()
            .remove("refreshToken");
        set(&server.app, json!({"mailAccounts":without_refresh})).await;
        let before = calls.load(Ordering::SeqCst);
        let missing = server.call("GET", "/api/mail/folders", A, json!({})).await;
        assert_eq!(missing.0, 401);
        assert_eq!(missing.1["code"], "oauth_reconnect_required");
        assert_eq!(calls.load(Ordering::SeqCst), before);
        set(&server.app, settings.clone()).await;
        server.shutdown().await;
        let reopened = fixture.start().await;
        assert_eq!(
            reopened.app.settings().await.unwrap()["mailAccounts"],
            settings["mailAccounts"]
        );
        reopened.shutdown().await;
    }
}

#[tokio::test]
async fn oauth_refresh_after_restart_retains_rotation_omission_clients_scopes_and_owner() {
    for provider in ["google", "microsoft"] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let fixture = Fixture::new(Arc::new(move |request| {
            let count = count.clone();
            async move {
                assert!(
                    ["oauth2.googleapis.com", "login.microsoftonline.com"]
                        .contains(&request.host())
                );
                let form = url::form_urlencoded::parse(&request.body)
                    .collect::<std::collections::HashMap<_, _>>();
                let n = count.fetch_add(1, Ordering::SeqCst);
                assert_eq!(form["grant_type"], "refresh_token");
                assert_eq!(
                    form["refresh_token"],
                    if n > 1 {
                        "rotated-refresh".to_owned()
                    } else {
                        format!("refresh-{A}")
                    }
                );
                assert_eq!(form["client_secret"], "fixture-secret");
                let mut tokens = json!({"access_token":"fresh-access","expires_in":"3600"});
                if n == 1 {
                    tokens["refresh_token"] = "rotated-refresh".into();
                }
                Reply::Json(200, tokens)
            }
            .boxed()
        }))
        .await;
        let server = fixture.start().await;
        let mut settings = config(&[(A, provider), (B, "microsoft")]);
        settings["mailAccounts"][A]["expiresAt"] = 0.into();
        settings["mailAccounts"][A]["mailScope"] = "custom-retained-scope".into();
        set(&server.app, settings.clone()).await;
        server.shutdown().await;
        let server = fixture.start().await;
        let before = chrono::Utc::now().timestamp_millis();
        let refreshed = morrow_search::mail::current_mail(&server.app, A)
            .await
            .unwrap();
        assert_eq!(
            refreshed["refreshToken"],
            settings["mailAccounts"][A]["refreshToken"]
        );
        assert!(refreshed["expiresAt"].as_i64().unwrap() >= before + 3_600_000);
        assert!(
            refreshed["expiresAt"].as_i64().unwrap()
                <= chrono::Utc::now().timestamp_millis() + 3_600_000
        );
        for key in [
            "clientId",
            "clientSecret",
            "grantedScopes",
            "mailScope",
            "connectionId",
        ] {
            assert_eq!(refreshed[key], settings["mailAccounts"][A][key]);
        }
        let saved = server.app.settings().await.unwrap();
        assert_eq!(saved["mailAccounts"][B], settings["mailAccounts"][B]);
        assert_eq!(saved["activeAccount"], settings["activeAccount"]);
        assert_eq!(saved["mail"], refreshed);
        server.shutdown().await;
        let server = fixture.start().await;
        assert_eq!(
            morrow_search::mail::current_mail(&server.app, A)
                .await
                .unwrap(),
            refreshed
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server
            .app
            .db(|db| {
                let mut accounts = connections(&db.settings()?);
                accounts[A]["expiresAt"] = 0.into();
                db.set_settings(&json!({"mailAccounts":accounts}))?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            morrow_search::mail::current_mail(&server.app, A)
                .await
                .unwrap()["refreshToken"],
            "rotated-refresh"
        );
        server.shutdown().await;
        let server = fixture.start().await;
        assert_eq!(
            connections(&server.app.settings().await.unwrap())[A]["refreshToken"],
            "rotated-refresh"
        );
        server.shutdown().await;
    }
}

#[tokio::test]
async fn full_history_microsoft_traverses_folders_with_private_checkpoints_and_exclusions() {
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let saved = calls.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let saved = saved.clone(); async move {
            assert_eq!(request.host(),"graph.microsoft.com");
            let url=url::Url::parse(&format!("https://graph.microsoft.com{}",request.path)).unwrap();
            saved.lock().unwrap().push(url.path().to_owned());
            let known = match url.path() {
                "/v1.0/me/mailFolders/inbox"=>Some("i="), "/v1.0/me/mailFolders/sentitems"=>Some("s="), "/v1.0/me/mailFolders/drafts"=>Some("d="), "/v1.0/me/mailFolders/junkemail"=>Some("j="), "/v1.0/me/mailFolders/deleteditems"=>Some("t="), _=>None,
            };
            let value=if let Some(id)=known {json!({"id":id})} else if url.path()=="/v1.0/me/mailFolders" {
                json!({"value":[{"id":"i=","displayName":"Inbox"},{"id":"s=","displayName":"Sent"},{"id":"d=","displayName":"Drafts"},{"id":"p=","displayName":"Projects","childFolderCount":1},{"id":"j=","displayName":"Junk","childFolderCount":2},{"id":"t=","displayName":"Trash","childFolderCount":3}]})
            } else if url.path()=="/v1.0/me/mailFolders/p%3D/childFolders" { json!({"value":[{"id":"c=","displayName":"Child"}]}) } else {
                let id = if url.path().contains("('i=')") { "i=" } else { match url.path().split('/').nth(4).unwrap() {"i%3D"=>"i=","s%3D"=>"s=","d%3D"=>"d=","p%3D"=>"p=","c%3D"=>"c=", _=>panic!("Excluded or unknown folder was fetched")}};
                let query=url.query_pairs().collect::<std::collections::HashMap<_,_>>(); assert_eq!(query["$top"],"50"); assert!(!query["$filter"].contains(" ge ")); assert!(query["$filter"].contains(" lt 2026-")); assert!(request.headers["prefer"].to_str().unwrap().contains("ImmutableId"));
                let mut row=microsoft_message(id,A,"Fixture only"); row["receivedDateTime"]="2000-01-01T00:00:00Z".into(); row["sentDateTime"]="2000-01-02T00:00:00Z".into(); row["createdDateTime"]="2000-01-03T00:00:00Z".into(); row["isDraft"]=(id=="d=").into();
                let next=if id=="i=" && !query.contains_key("$skip") {json!(format!("https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages?{}&$skip=50",url.query().unwrap()))} else {Value::Null};
                json!({"value":if id=="p="{vec![]}else{vec![row]},"@odata.nextLink":next})
            };
            Reply::Json(200,value)
        }.boxed()
    })).await;
    let mail =
        json!({"provider":"microsoft","accessToken":"fixture-token","grantedScopes":"Mail.Read"});
    let mut options = json!({"folder":"all","since":"","before":"2026-09-27T00:00:00.000Z"});
    let first = providers::fetch_page(&fixture.client, &mail, &options)
        .await
        .unwrap();
    assert_eq!(first["messages"][0]["folder"], "inbox");
    assert_eq!(first["nextCursor"]["folders"].as_array().unwrap().len(), 5);
    let count = calls.lock().unwrap().len();
    for next in [
        "https://evil.invalid/v1.0/me/mailFolders/i%3D/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders('s=')/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages/extra",
        "https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages#fragment",
    ] {
        options["cursor"] = first["nextCursor"].clone();
        options["cursor"]["next"] = next.into();
        assert!(
            providers::fetch_page(&fixture.client, &mail, &options)
                .await
                .is_err()
        );
    }
    assert_eq!(calls.lock().unwrap().len(), count);
    let mut messages = first["messages"].as_array().unwrap().clone();
    let mut cursor = first["nextCursor"].clone();
    let mut pages = 1;
    while !cursor.is_null() {
        options["cursor"] =
            serde_json::from_slice::<Value>(&serde_json::to_vec(&cursor).unwrap()).unwrap();
        let page = providers::fetch_page(&fixture.client, &mail, &options)
            .await
            .unwrap();
        messages.extend(page["messages"].as_array().unwrap().clone());
        cursor = page["nextCursor"].clone();
        pages += 1;
        assert!(pages <= 6);
    }
    assert_eq!(pages, 6);
    assert_eq!(
        messages
            .iter()
            .map(|v| v["folder"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["inbox", "inbox", "sent", "drafts", "archive"]
    );
    assert_eq!(messages[2]["providerSent"], true);
    assert_eq!(messages[3]["providerDraft"], true);
    assert_eq!(messages[3]["date"], "2000-01-03T00:00:00.000Z");
    assert_eq!(messages[4]["providerFolderName"], "Projects / Child");
    assert_eq!(messages[4]["providerFolderId"], "c=");
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|s| *s == "/v1.0/me/mailFolders")
            .count(),
        1
    );
    assert_eq!(
        providers::folders(&fixture.client, &mail)
            .await
            .unwrap_err()
            .status,
        403
    );
}
