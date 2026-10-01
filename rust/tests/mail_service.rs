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

#[tokio::test]
async fn automatic_folder_catalogs_are_owned_durable_and_keep_offline_names() {
    let reads = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(0));
    let (counted, response_mode) = (reads.clone(), mode.clone());
    let fixture = Fixture::new(Arc::new(move |request| {
        let (reads, mode) = (counted.clone(), response_mode.clone());
        async move {
            assert_eq!(request.method, "GET", "Metadata refresh must never write to a provider");
            reads.fetch_add(1, Ordering::SeqCst);
            match mode.load(Ordering::SeqCst) {
                1 => return Reply::Lost,
                2 => return Reply::Json(401, json!({"error":"private authorization detail"})),
                3 => return Reply::Json(403, json!({"error":{"errors":[{"reason":"dailyLimitExceeded","message":"private quota detail"}]}})),
                4 => return Reply::Json(200, json!({"labels":"malformed"})),
                _ => {}
            }
            if request.host() == "gmail.googleapis.com" {
                assert_eq!(request.path, "/gmail/v1/users/me/labels");
                return Reply::Json(200, json!({"labels":[{"id":"INBOX","name":"Inbox","type":"system"},{"id":"same","name":format!("Projects/中文/{}",request.owner()),"type":"user"}]}));
            }
            assert_eq!(request.owner(), C);
            let url = url::Url::parse(&format!("https://{}{}", request.host(), request.path)).unwrap();
            Reply::Json(200, match url.path() {
                "/v1.0/me/mailFolders" => json!({"value":[{"id":"inbox","displayName":"Inbox","childFolderCount":0},{"id":"junk","displayName":"Junk","childFolderCount":0},{"id":"trash","displayName":"Deleted","childFolderCount":0},{"id":"project","displayName":"Projects","childFolderCount":1}]}),
                "/v1.0/me/mailFolders/project/childFolders" => json!({"value":[{"id":"child","displayName":"中文","childFolderCount":0}]}),
                "/v1.0/me/mailFolders/inbox" => json!({"id":"inbox"}),
                "/v1.0/me/mailFolders/junkemail" => json!({"id":"junk"}),
                "/v1.0/me/mailFolders/deleteditems" => json!({"id":"trash"}),
                other => panic!("Unexpected folder request: {other}"),
            })
        }.boxed()
    })).await;
    let server = fixture.start().await;
    set(
        &server.app,
        config(&[(A, "google"), (B, "google"), (C, "microsoft")]),
    )
    .await;
    let (_, initial) = server.call("GET", "/api/state", "all", json!({})).await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "Reading local state cannot start provider work"
    );
    assert_eq!(initial["serverFolders"][A]["folders"], json!([]));
    morrow_search::folders::tick(&server.app).await.unwrap();
    let count = reads.load(Ordering::SeqCst);
    assert!(count > 0);
    let (_, state) = server.call("GET", "/api/state", "all", json!({})).await;
    assert!(
        state["serverFolders"][A]["folders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == "same" && f["name"] == format!("Projects/中文/{A}"))
    );
    assert!(
        state["serverFolders"][B]["folders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == "same" && f["name"] == format!("Projects/中文/{B}"))
    );
    assert!(
        state["serverFolders"][C]["folders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == "child" && f["name"] == "Projects / 中文")
    );
    for secret in ["fixture-secret", "refresh-", "accessToken", "connection-"] {
        assert!(!state["serverFolders"].to_string().contains(secret));
    }
    morrow_search::folders::tick(&server.app).await.unwrap();
    server.call("GET", "/api/activity", "all", json!({})).await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        count,
        "Fresh metadata must not be downloaded again"
    );
    server.shutdown().await;
    let server = fixture.start().await;
    let (_, restored) = server.call("GET", "/api/state", A, json!({})).await;
    assert_eq!(restored["serverFolders"], state["serverFolders"]);
    assert_eq!(reads.load(Ordering::SeqCst), count);
    assert!(
        !fs::read(fixture.root.join("workspace/genmail.sqlite"))
            .unwrap()
            .windows("Projects/中文".len())
            .any(|v| v == "Projects/中文".as_bytes())
    );
    for failure_mode in [1, 2, 3, 4] {
        mode.store(failure_mode, Ordering::SeqCst);
        // A new authorization must refresh even if the previous catalog is fresh/blocked.
        server
            .app
            .db(move |db| {
                let mut config = db.settings()?;
                config["mailAccounts"][A]["connectionId"] =
                    format!("generation-{failure_mode}").into();
                db.set_settings(&config)?;
                Ok(())
            })
            .await
            .unwrap();
        let (_, stale) = server.call("GET", "/api/state", A, json!({})).await;
        assert_eq!(stale["serverFolders"][A]["stale"], true);
        assert!(stale["serverFolders"][A]["errorCode"].is_null());
        assert!(stale["serverFolders"][A]["nextRetryAt"].is_null());
        assert_eq!(
            stale["serverFolders"][A]["folders"],
            state["serverFolders"][A]["folders"]
        );
        let before = reads.load(Ordering::SeqCst);
        morrow_search::folders::tick(&server.app).await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), before + 1);
        let (_, offline) = server.call("GET", "/api/state", A, json!({})).await;
        assert_eq!(
            offline["serverFolders"][A]["folders"],
            state["serverFolders"][A]["folders"]
        );
        assert!(!offline["serverFolders"].to_string().contains("private"));
        let expected_retry = u64::from([1, 3].contains(&failure_mode));
        assert_eq!(
            server.app.settings().await.unwrap()["mailFolderCatalogs"][A]["retryCount"],
            expected_retry,
            "New connections must not inherit a previous connection's retry count"
        );
        if failure_mode == 3 {
            let due = chrono::DateTime::parse_from_rfc3339(string(
                &offline["serverFolders"][A],
                "nextRetryAt",
            ))
            .unwrap();
            assert!(due.timestamp() - chrono::Utc::now().timestamp() >= 86_399);
        }
        morrow_search::folders::tick(&server.app).await.unwrap();
        assert_eq!(
            reads.load(Ordering::SeqCst),
            before + 1,
            "Respect retry pacing and block auth/malformed response retries"
        );
    }
    mode.store(0, Ordering::SeqCst);
    server
        .app
        .db(|db| {
            let mut config = db.settings()?;
            config["mailAccounts"][A]["connectionId"] = "reconnected".into();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    morrow_search::folders::tick(&server.app).await.unwrap();
    let (_, recovered) = server.call("GET", "/api/state", A, json!({})).await;
    assert!(recovered["serverFolders"][A]["errorCode"].is_null());
    assert_eq!(
        server
            .call("POST", "/api/account/disconnect", A, json!({}))
            .await
            .0,
        200
    );
    let (_, disconnected) = server.call("GET", "/api/state", B, json!({})).await;
    assert!(disconnected["serverFolders"].get(A).is_none());
    assert_eq!(disconnected["serverFolders"][B], state["serverFolders"][B]);
}

#[tokio::test]
async fn reviewed_folder_management_is_owned_single_use_and_preserves_cached_mail() {
    let labels = Arc::new(Mutex::new(vec![
        json!({"id":"INBOX","name":"Inbox","type":"system"}),
        json!({"id":"p","name":"Projects","type":"user"}),
        json!({"id":"c","name":"Projects/Child","type":"user"}),
        json!({"id":"d","name":"Done","type":"user"}),
    ]));
    let graph = Arc::new(Mutex::new(vec![
        json!({"id":"inbox-id","displayName":"Inbox","parent":""}),
        json!({"id":"junk-id","displayName":"Junk","parent":""}),
        json!({"id":"trash-id","displayName":"Deleted","parent":""}),
        json!({"id":"draft-id","displayName":"草稿","parent":""}),
        json!({"id":"p","displayName":"Projects","parent":""}),
        json!({"id":"c","displayName":"Child","parent":"p"}),
        json!({"id":"d","displayName":"Done","parent":""}),
    ]));
    let writes = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let lost = Arc::new(AtomicUsize::new(0));
    let (remote_labels, remote_graph, counted, read_count, lose) = (
        labels.clone(),
        graph.clone(),
        writes.clone(),
        reads.clone(),
        lost.clone(),
    );
    let fixture=Fixture::new(Arc::new(move |request| {
        let (labels,graph,writes,reads,lost)=(remote_labels.clone(),remote_graph.clone(),counted.clone(),read_count.clone(),lose.clone());
        async move {
            let url=url::Url::parse(&format!("https://{}{}",request.host(),request.path)).unwrap();let path=url.path();
            if request.method=="GET" { reads.fetch_add(1,Ordering::SeqCst); }
            if request.host()=="gmail.googleapis.com" {
                assert!([A,B].contains(&request.owner()));
                let mut labels=labels.lock().unwrap();
                if request.method=="GET" { assert_eq!(path,"/gmail/v1/users/me/labels");return Reply::Json(200,json!({"labels":*labels})); }
                assert_eq!(request.owner(),A);writes.fetch_add(1,Ordering::SeqCst);
                let response=match request.method.as_str() {
                    "POST"=>{let v=json!({"id":"created","name":request.json()["name"],"type":"user"});labels.push(v.clone());Reply::Json(200,v)},
                    "PATCH"=>{let id=path.rsplit('/').next().unwrap();let item=labels.iter_mut().find(|l|l["id"]==id).unwrap();item["name"]=request.json()["name"].clone();Reply::Json(200,item.clone())},
                    "DELETE"=>{let id=path.rsplit('/').next().unwrap();labels.retain(|l|l["id"]!=id);Reply::Empty(204)},
                    _=>panic!("Unexpected label request"),
                };
                return if lost.load(Ordering::SeqCst)>0{Reply::Lost}else{response};
            }
            assert_eq!(request.owner(),C);
            let mut graph=graph.lock().unwrap();
            let suffix=path.strip_prefix("/v1.0/me/mailFolders").unwrap();
            if request.method=="GET" {
                if !suffix.is_empty() && !suffix.ends_with("/childFolders") {
                    return match suffix { "/inbox"=>Reply::Json(200,json!({"id":"inbox-id"})),"/junkemail"=>Reply::Json(200,json!({"id":"junk-id"})),"/deleteditems"=>Reply::Json(200,json!({"id":"trash-id"})),"/drafts"=>Reply::Json(200,json!({"id":"draft-id"})),_=>Reply::Json(404,json!({"error":{"code":"ErrorItemNotFound"}})) };
                }
                let parent=suffix.strip_suffix("/childFolders").unwrap_or("").trim_start_matches('/');
                let values=graph.iter().filter(|v|v["parent"]==parent).map(|v|merge(v.clone(),&json!({"childFolderCount":graph.iter().filter(|c|c["parent"]==v["id"]).count(),"totalItemCount":2,"isHidden":false}))).collect::<Vec<_>>();
                return Reply::Json(200,json!({"value":values}));
            }
            writes.fetch_add(1,Ordering::SeqCst);let body=if request.body.is_empty(){json!({})}else{request.json()};
            let id=suffix.trim_start_matches('/').split('/').next().unwrap();
            match request.method.as_str() {
                "POST" if suffix.ends_with("/move")=>{let item=graph.iter_mut().find(|v|v["id"]==id).unwrap();item["parent"]=if body["destinationId"]=="msgfolderroot"{json!("")}else{body["destinationId"].clone()};Reply::Json(200,item.clone())},
                "POST"=>{let v=json!({"id":"created-graph","displayName":body["displayName"],"parent":if suffix.ends_with("/childFolders"){id}else{""}});graph.push(v.clone());Reply::Json(201,v)},
                "PATCH"=>{let item=graph.iter_mut().find(|v|v["id"]==id).unwrap();item["displayName"]=body["displayName"].clone();Reply::Json(200,item.clone())},
                "DELETE"=>{let mut removed=vec![id.to_owned()];loop {let next=graph.iter().filter(|v|removed.contains(&string(v,"parent").to_owned())&&!removed.contains(&string(v,"id").to_owned())).map(|v|string(v,"id").to_owned()).collect::<Vec<_>>();if next.is_empty(){break;}removed.extend(next);}graph.retain(|v|!removed.contains(&string(v,"id").to_owned()));Reply::Empty(204)},
                _=>panic!("Unexpected folder request"),
            }
        }.boxed()
    })).await;
    let server = fixture.start().await;
    set(
        &server.app,
        config(&[(A, "google"), (B, "google"), (C, "microsoft")]),
    )
    .await;
    server.app.db(|db|{for owner in [A,B]{db.upsert(owner,&merge(cached("google:same",owner,"archive"),&json!({"providerLabelIds":["p","c"],"labels":["Projects","Projects/Child"],"providerSnapshot":{"labels":["Projects","Projects/Child"]},"pending":true})))?;}db.upsert(C,&merge(cached("microsoft:same",C,"archive"),&json!({"providerFolderId":"c","pending":true})))?;Ok(())}).await.unwrap();
    assert_eq!(
        server
            .call(
                "POST",
                "/api/mail/folders/preview",
                "all",
                json!({"operation":"delete","id":"p"})
            )
            .await
            .0,
        409
    );
    let missing = server
        .client
        .post(format!("{}/api/mail/folders/preview", server.base))
        .bearer_auth(NATIVE)
        .json(&json!({"operation":"delete","id":"p"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 409);
    for owner in [A, C] {
        let (status, catalog) = server
            .call("GET", "/api/mail/folders/manage", owner, json!({}))
            .await;
        assert_eq!(status, 200);
        assert_eq!(catalog["accountId"], owner);
        if owner == C {
            assert!(
                catalog["folders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["id"] == "draft-id" && v["editable"] == false)
            );
        }
        for input in [
            json!({"operation":"create","name":"New","parentId":"d"}),
            json!({"operation":"rename","id":"p","name":"Renamed"}),
            json!({"operation":"move","id":"p","parentId":"d"}),
            json!({"operation":"delete","id":"p"}),
        ] {
            let before = writes.load(Ordering::SeqCst);
            let (status, preview) = server
                .call("POST", "/api/mail/folders/preview", owner, input)
                .await;
            assert_eq!(status, 200, "{preview}");
            assert_eq!(writes.load(Ordering::SeqCst), before);
            let apply = json!({"previewId":preview["previewId"],"confirmed":true});
            if owner == A {
                assert_eq!(
                    server
                        .call("POST", "/api/mail/folders/apply", B, apply.clone())
                        .await
                        .0,
                    409
                );
            }
            assert_eq!(
                server
                    .call(
                        "POST",
                        "/api/mail/folders/apply",
                        owner,
                        json!({"previewId":preview["previewId"]})
                    )
                    .await
                    .0,
                400
            );
            let (status, changed) = server
                .call("POST", "/api/mail/folders/apply", owner, apply.clone())
                .await;
            assert_eq!(status, 200, "{changed}");
            assert_eq!(
                server
                    .call("POST", "/api/mail/folders/apply", owner, apply)
                    .await
                    .0,
                409
            );
            assert!(writes.load(Ordering::SeqCst) > before);
        }
    }
    server
        .app
        .db(|db| {
            assert_eq!(
                db.get(A, "google:same")?.unwrap()["providerLabelIds"],
                json!(["c"])
            );
            assert_eq!(
                db.get(A, "google:same")?.unwrap()["labels"],
                json!(["Done/Renamed/Child"])
            );
            assert_eq!(
                db.get(B, "google:same")?.unwrap()["labels"],
                json!(["Projects", "Projects/Child"])
            );
            let m = db.get(C, "microsoft:same")?.unwrap();
            assert_eq!(m["providerFolderMissing"], true);
            assert_eq!(m["pending"], true);
            Ok(())
        })
        .await
        .unwrap();
    let (_, stale) = server
        .call(
            "POST",
            "/api/mail/folders/preview",
            A,
            json!({"operation":"rename","id":"d","name":"Another"}),
        )
        .await;
    labels
        .lock()
        .unwrap()
        .iter_mut()
        .find(|v| v["id"] == "d")
        .unwrap()["name"] = "External change".into();
    let before = writes.load(Ordering::SeqCst);
    assert_eq!(
        server
            .call(
                "POST",
                "/api/mail/folders/apply",
                A,
                json!({"previewId":stale["previewId"],"confirmed":true})
            )
            .await
            .0,
        409
    );
    assert_eq!(writes.load(Ordering::SeqCst), before);
    let (_, preview) = server
        .call(
            "POST",
            "/api/mail/folders/preview",
            A,
            json!({"operation":"rename","id":"d","name":"Lost response"}),
        )
        .await;
    lost.store(1, Ordering::SeqCst);
    let apply = json!({"previewId":preview["previewId"],"confirmed":true});
    assert_eq!(
        server
            .call("POST", "/api/mail/folders/apply", A, apply.clone())
            .await
            .0,
        502
    );
    assert_eq!(
        server
            .call("POST", "/api/mail/folders/apply", A, apply)
            .await
            .0,
        409
    );
    assert_eq!(writes.load(Ordering::SeqCst), before + 1);
    lost.store(0, Ordering::SeqCst);
    let (_, preview) = server
        .call(
            "POST",
            "/api/mail/folders/preview",
            A,
            json!({"operation":"rename","id":"d","name":"Reconnect guard"}),
        )
        .await;
    let mut reconnected = connection("google", A);
    reconnected["connectionId"] = "replaced-connection".into();
    set(&server.app, json!({"mailAccounts":{A:reconnected}})).await;
    let before = writes.load(Ordering::SeqCst);
    assert_eq!(
        server
            .call(
                "POST",
                "/api/mail/folders/apply",
                A,
                json!({"previewId":preview["previewId"],"confirmed":true})
            )
            .await
            .0,
        409
    );
    assert_eq!(writes.load(Ordering::SeqCst), before);
    let read_before = reads.load(Ordering::SeqCst);
    let mut readonly = connection("google", B);
    readonly["grantedScopes"] = "https://www.googleapis.com/auth/gmail.readonly".into();
    set(&server.app, json!({"mailAccounts":{B:readonly}})).await;
    assert_eq!(
        server
            .call(
                "POST",
                "/api/mail/folders/preview",
                B,
                json!({"operation":"create","name":"Forbidden"})
            )
            .await
            .0,
        403
    );
    assert_eq!(reads.load(Ordering::SeqCst), read_before);
    assert_eq!(
        server
            .call(
                "POST",
                "/api/messages/microsoft%3Asame/organize",
                C,
                json!({"destinationId":"inbox-id","mode":"move","confirmed":true})
            )
            .await
            .0,
        409
    );
    server.shutdown().await;
}
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
async fn trash_undo_is_one_minute_owned_single_use_and_restores_provider_location() {
    let writes = Arc::new(AtomicUsize::new(0));
    let counted = writes.clone();
    let labels = Arc::new(Mutex::new(json!(["INBOX", "UNREAD", "Label_1"])));
    let remote_labels = labels.clone();
    let parent = Arc::new(Mutex::new("custom-id".to_owned()));
    let remote_parent = parent.clone();
    let lose_undo = Arc::new(AtomicUsize::new(0));
    let lose = lose_undo.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let counted = counted.clone(); let labels = remote_labels.clone(); let parent = remote_parent.clone(); let lose = lose.clone();
        async move {
            let path = url::Url::parse(&format!("https://{}{}", request.host(), request.path)).unwrap();
            if request.host() == "gmail.googleapis.com" {
                assert_eq!(request.owner(), A);
                if path.path().ends_with("/labels") { return Reply::Json(200, json!({"labels":[{"id":"TRASH","name":"Bin","type":"system"},{"id":"Label_1","name":"Keep me","type":"user"}]})); }
                if request.method == "GET" { return Reply::Json(200, json!({"id":"same","labelIds":labels.lock().unwrap().clone()})); }
                counted.fetch_add(1, Ordering::SeqCst);
                if path.path().ends_with("/trash") {
                    assert_eq!(request.headers["content-length"], "0");
                    *labels.lock().unwrap() = json!(["TRASH","UNREAD","Label_1"]);
                } else {
                    assert_eq!(path.path(), "/gmail/v1/users/me/messages/same/modify");
                    assert_eq!(request.json(), json!({"addLabelIds":["INBOX"],"removeLabelIds":["TRASH","SPAM"]}));
                    if lose.load(Ordering::SeqCst) != 0 { return Reply::Lost; }
                    *labels.lock().unwrap() = json!(["INBOX","UNREAD","Label_1"]);
                }
                return Reply::Json(200, json!({"labelIds":labels.lock().unwrap().clone()}));
            }
            assert_eq!(request.owner(), C);
            match path.path() {
                "/v1.0/me/mailFolders" => Reply::Json(200, json!({"value":[{"id":"custom-id","displayName":"Projects"},{"id":"deleted-id","displayName":"Deleted Items"},{"id":"inbox-id","displayName":"Inbox"},{"id":"junk-id","displayName":"Junk"}]})),
                "/v1.0/me/mailFolders/inbox" => Reply::Json(200, json!({"id":"inbox-id"})),
                "/v1.0/me/mailFolders/junkemail" => Reply::Json(200, json!({"id":"junk-id"})),
                "/v1.0/me/mailFolders/deleteditems" => Reply::Json(200, json!({"id":"deleted-id"})),
                "/v1.0/me/messages/same" | "/v1.0/me/messages/moved" => Reply::Json(200, json!({"id":"same","parentFolderId":parent.lock().unwrap().clone()})),
                "/v1.0/me/messages/same/move" | "/v1.0/me/messages/moved/move" => {
                    assert_eq!(request.headers["prefer"], "IdType=\"ImmutableId\"");
                    counted.fetch_add(1, Ordering::SeqCst);
                    *parent.lock().unwrap() = string(&request.json(), "destinationId").to_owned();
                    Reply::Json(201, json!({"id":"moved","parentFolderId":parent.lock().unwrap().clone()}))
                }
                _ => panic!("Unexpected fixture path {}", path.path()),
            }
        }.boxed()
    })).await;
    let server = fixture.start().await;
    set(
        &server.app,
        config(&[(A, "google"), (B, "google"), (C, "microsoft")]),
    )
    .await;
    server.app.db(|db| {
        for owner in [A,B] { db.upsert(owner, &merge(cached("google:same",owner,"archive"), &json!({"localOverrides":{"folder":true},"pending":true,"labels":["Local label"]})))?; }
        db.upsert(C, &merge(cached("microsoft:same",C,"archive"), &json!({"providerFolderId":"custom-id"})))?;
        Ok(())
    }).await.unwrap();
    for (account, id) in [(A, "google%3Asame"), (C, "microsoft%3Asame")] {
        let path = format!("/api/messages/{id}");
        for invalid in ["", "all", "disconnected@example.invalid"] {
            assert_eq!(
                server
                    .call("POST", &(path.clone() + "/trash"), invalid, json!({}))
                    .await
                    .0,
                409
            );
        }
        let moved = server
            .call(
                "POST",
                &(path.clone() + "/trash"),
                account,
                json!({"destinationId":"forged"}),
            )
            .await;
        assert_eq!(moved.0, 200, "{}", moved.1);
        assert_eq!(moved.1["message"]["folder"], "trash");
        assert_eq!(moved.1["undoSeconds"], 60);
        let undo = json!({"undoToken":moved.1["undoToken"],"destinationId":"forged","original":{"folder":"sent"}});
        assert_ne!(
            server
                .call("POST", &(path.clone() + "/undo-trash"), "all", undo.clone())
                .await
                .0,
            200
        );
        if account == A {
            assert_eq!(
                server
                    .call("POST", &(path.clone() + "/undo-trash"), B, undo.clone())
                    .await
                    .0,
                409
            );
        }
        let restored = server
            .call(
                "POST",
                &(path.clone() + "/undo-trash"),
                account,
                undo.clone(),
            )
            .await;
        assert_eq!(restored.0, 200, "{}", restored.1);
        assert_eq!(restored.1["message"]["folder"], "archive");
        assert_eq!(
            restored.1["message"]["id"],
            if account == A {
                "google:same"
            } else {
                "microsoft:same"
            }
        );
        if account == A {
            assert_eq!(restored.1["message"]["pending"], true);
            assert_eq!(restored.1["message"]["localOverrides"]["folder"], true);
            assert_eq!(
                restored.1["message"]["providerLabelIds"],
                json!(["INBOX", "UNREAD", "Label_1"])
            );
        } else {
            assert_eq!(restored.1["message"]["providerFolderId"], "custom-id");
        }
        assert_eq!(
            server
                .call("POST", &(path + "/undo-trash"), account, undo)
                .await
                .0,
            409
        );
    }
    assert_eq!(writes.load(Ordering::SeqCst), 4);
    let move_again = || server.call("POST", "/api/messages/google%3Asame/trash", A, json!({}));
    let expired = move_again().await;
    assert_eq!(expired.0, 200);
    server
        .app
        .0
        .trash_undo
        .lock()
        .unwrap()
        .get_mut(string(&expired.1, "undoToken"))
        .unwrap()
        .expires = std::time::Instant::now() - Duration::from_secs(1);
    assert_eq!(
        server
            .call(
                "POST",
                "/api/messages/google%3Asame/undo-trash",
                A,
                json!({"undoToken":expired.1["undoToken"]})
            )
            .await
            .0,
        409
    );
    *labels.lock().unwrap() = json!(["INBOX", "UNREAD", "Label_1"]);
    let disconnected = move_again().await;
    assert_eq!(disconnected.0, 200);
    server
        .app
        .db(|db| {
            let mut settings = db.settings()?;
            settings["mailAccounts"][A]["accessToken"] = "changed".into();
            db.set_settings(&settings)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        server
            .call(
                "POST",
                "/api/messages/google%3Asame/undo-trash",
                A,
                json!({"undoToken":disconnected.1["undoToken"]})
            )
            .await
            .0,
        409
    );
    set(
        &server.app,
        config(&[(A, "google"), (B, "google"), (C, "microsoft")]),
    )
    .await;
    *labels.lock().unwrap() = json!(["INBOX", "UNREAD", "Label_1"]);
    let uncertain = move_again().await;
    assert_eq!(uncertain.0, 200);
    lose_undo.store(1, Ordering::SeqCst);
    let body = json!({"undoToken":uncertain.1["undoToken"]});
    assert_eq!(
        server
            .call(
                "POST",
                "/api/messages/google%3Asame/undo-trash",
                A,
                body.clone()
            )
            .await
            .0,
        502
    );
    let before = writes.load(Ordering::SeqCst);
    assert_eq!(
        server
            .call("POST", "/api/messages/google%3Asame/undo-trash", A, body)
            .await
            .0,
        409
    );
    assert_eq!(writes.load(Ordering::SeqCst), before);
    server
        .app
        .db(|db| {
            assert_eq!(db.get(A, "google:same")?.unwrap()["folder"], "trash");
            assert_eq!(db.get(B, "google:same")?.unwrap()["folder"], "archive");
            Ok(())
        })
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test]
async fn gmail_trash_failures_keep_safe_diagnostics_and_owned_cache() {
    let outcome = Arc::new(AtomicUsize::new(0));
    let current = outcome.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let counted = writes.clone();
    let fixture = Fixture::new(Arc::new(move |request| {
        let current = current.clone();
        let counted = counted.clone();
        async move {
            assert_eq!(request.owner(), A);
            if request.path.ends_with("/labels") {
                assert_eq!(request.method, "GET");
                return Reply::Json(200, json!({"labels":[{"id":"TRASH","name":"TRASH","type":"system"}]}));
            }
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/gmail/v1/users/me/messages/same/trash");
            assert!(request.body.is_empty());
            counted.fetch_add(1, Ordering::SeqCst);
            let (status, reason) = match current.load(Ordering::SeqCst) {
                0 => (403, "insufficientPermissions"),
                1 => (403, "userRateLimitExceeded"),
                2 => (401, "authError"),
                3 => (429, "rateLimitExceeded"),
                4 => (404, "notFound"),
                5 => (503, "backendError"),
                _ => return Reply::Lost,
            };
            Reply::Json(status, json!({"error":{"message":"private-provider-detail fixture-secret","errors":[{"reason":reason}]}}))
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
                db.upsert(owner, &cached("google:same", owner, "inbox"))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    for (index, status, expected) in [
        (0, Some(403), "approve mail access"),
        (1, Some(403), "limiting requests"),
        (2, Some(401), "Reconnect this account"),
        (3, Some(429), "rate limiting"),
        (4, Some(404), "provider rejected"),
        (5, Some(503), "could not be confirmed"),
        (6, None, "could not be confirmed"),
    ] {
        outcome.store(index, Ordering::SeqCst);
        let (api_status, result) = server
            .call(
                "POST",
                "/api/messages/google%3Asame/organize",
                A,
                json!({"mode":"move","destinationId":"TRASH","confirmed":true}),
            )
            .await;
        assert_eq!(api_status, 502, "{result}");
        assert!(string(&result, "error").contains(expected), "{result}");
        assert!(string(&result, "error").contains("cached copy is retained"));
        assert_eq!(result["providerStatus"].as_u64(), status);
        assert!(!result.to_string().contains("private-provider-detail"));
        assert!(!result.to_string().contains("fixture-secret"));
        if index == 0 {
            assert_eq!(result["code"], "provider_permission_denied");
            assert_eq!(result["recoveryAction"], "reconnect");
        } else if index == 1 {
            assert_eq!(result["code"], "provider_quota_exceeded");
            assert!(result.get("recoveryAction").is_none());
        }
        assert_eq!(writes.load(Ordering::SeqCst), index + 1);
        server
            .app
            .db(|db| {
                for owner in [A, B] {
                    assert_eq!(
                        db.get(owner, "google:same")?.unwrap(),
                        cached("google:same", owner, "inbox")
                    );
                }
                Ok(())
            })
            .await
            .unwrap();
    }
    server.shutdown().await;
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
                            {"id":"TRASH","name":"Bin","type":"system"},
                            {"id":"Label_1","name":"Spam","type":"user"}
                        ]}),
                    );
                }
                assert_eq!(request.method, "POST");
                if url.path().ends_with("/trash") {
                    assert!(request.body.is_empty());
                    assert_eq!(request.headers["content-length"], "0");
                    return Reply::Json(200, json!({"labelIds":["TRASH","Label_1"]}));
                }
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
                        {"id":"junk-id","displayName":"垃圾郵件"},
                        {"id":"deleted-id","displayName":"Deleted Items"}
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
                "/v1.0/me/mailFolders/deleteditems" => Reply::Json(200, json!({"id":"deleted-id"})),
                "/v1.0/me/messages/remote" => {
                    assert_eq!(request.headers["prefer"], "IdType=\"ImmutableId\"");
                    Reply::Json(200, json!({"id":"remote","parentFolderId":"inbox-id"}))
                }
                "/v1.0/me/messages/remote/move" => {
                    assert_eq!(request.method, "POST");
                    assert_eq!(request.headers["prefer"], "IdType=\"ImmutableId\"");
                    let destination = request.json()["destinationId"].as_str().unwrap().to_owned();
                    assert!(["junk-id", "deleted-id"].contains(&destination.as_str()));
                    Reply::Json(201, json!({"id":"remote","parentFolderId":destination}))
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
            json!({"id":"TRASH","name":"Trash","kind":"trash"}),
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
    let trashed = providers::organize(&fixture.client, &google, &message, &folders[3], "move")
        .await
        .unwrap();
    assert_eq!(trashed["folder"], "trash");
    assert_eq!(trashed["providerLabelIds"], json!(["TRASH", "Label_1"]));
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
    assert_eq!(folders[3]["kind"], "trash");
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
    let trashed = providers::organize(
        &fixture.client,
        &microsoft,
        &json!({"id":"microsoft:local","remoteId":"microsoft:remote"}),
        &folders[3],
        "move",
    )
    .await
    .unwrap();
    assert_eq!(trashed["folder"], "trash");
    assert_eq!(trashed["providerFolderId"], "deleted-id");
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
        5
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
        if path.path()=="/v1.0/me/mailFolders/deleteditems"{return Reply::Json(200,json!({"id":"trash-id"}));}
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
    assert!(query["scope"].contains("gmail.modify"));
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
            } else if url.path()=="/v1.0/me/mailFolders/p%3D/childFolders" { json!({"value":[{"id":"c=","displayName":"Child"}]}) } else if ["/v1.0/me/mailFolders/j%3D/childFolders","/v1.0/me/mailFolders/t%3D/childFolders"].contains(&url.path()) { json!({"value":[]}) } else {
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
    let folders = providers::folders(&fixture.client, &mail).await.unwrap();
    assert!(
        folders
            .iter()
            .any(|folder| folder["id"] == "t=" && folder["kind"] == "trash")
    );
    assert!(
        folders
            .iter()
            .any(|folder| folder["id"] == "c=" && folder["name"] == "Projects / Child")
    );
    assert!(!providers::can_organize(&mail));
}
