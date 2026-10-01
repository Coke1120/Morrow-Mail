use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use morrow_search::{
    error::Result,
    search_query,
    service::{App, Context},
    smart_search,
    store::now,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinHandle};
const A: &str = "a@example.invalid";
const B: &str = "b@example.invalid";

struct Fixture {
    root: PathBuf,
    app: Option<App>,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("morrow-smart-{}", uuid::Uuid::new_v4()));
        let app = App::open(
            &root,
            3001,
            "fixture-token".into(),
            "fixture-update-token".into(),
        )
        .unwrap();
        app.db(|db|{db.set_settings(&json!({"mailAccounts":{A:{"email":A,"connectionId":"fixture-a"},B:{"email":B,"connectionId":"fixture-b"}},"policy":{"enabled":true,"folders":{"inbox":true,"sent":true,"archive":true},"content":{"body":true,"subject":true,"sender":true}}}))?;Ok(())}).await.unwrap();
        Self {
            root,
            app: Some(app),
        }
    }
    fn app(&self) -> &App {
        self.app.as_ref().unwrap()
    }
    async fn add(&self, account: &str, id: &str, patch: Value) {
        let account = account.to_owned();
        let mut message = json!({"id":id,"date":now(),"folder":"inbox","fromName":"Jane Doe","fromEmail":"jane@example.invalid","to":A,"cc":"copy@example.invalid","bcc":"private@example.invalid","subject":"報價 INV-1042","body":"請於本月付款，附上發票。 Café project payment timeline.","preview":"preview","read":false,"starred":true,"labels":["Finance"," White  Space "]});
        for (key, value) in patch.as_object().unwrap() {
            message[key] = value.clone();
        }
        self.app()
            .db(move |db| {
                db.upsert(&account, &message)?;
                Ok(())
            })
            .await
            .unwrap();
    }
    async fn request(&self, path: &str, body: Option<Value>, owner: &str) -> (u16, Value) {
        request(self.app(), path, body, owner).await
    }
    async fn setup(&self, base: &str, extra: Value) {
        let mut settings = json!({"enabled":true,"model":"fixture","baseUrl":base,"accounts":[A]});
        for (key, value) in extra.as_object().unwrap() {
            settings[key] = value.clone();
        }
        let (status, body) = self.request("settings", Some(settings), A).await;
        assert_eq!(status, 200, "{body}");
    }
    async fn preview_run(&self) -> Value {
        let (status, preview) = self.request("index/preview", Some(json!({})), A).await;
        assert_eq!(status, 200, "{preview}");
        let (status, result) = self
            .request(
                "index/run",
                Some(json!({"previewId":preview["job"]["id"]})),
                A,
            )
            .await;
        assert_eq!(status, 202, "{result}");
        preview
    }
    async fn vectors(&self) -> i64 {
        self.app()
            .db(|db| {
                Ok(db
                    .conn
                    .query_row("SELECT count(*) FROM search_vectors", [], |r| r.get(0))?)
            })
            .await
            .unwrap()
    }
    fn reopen(&mut self) {
        drop(self.app.take());
        self.app = Some(
            App::open(
                &self.root,
                3001,
                "fixture-token".into(),
                "fixture-update-token".into(),
            )
            .unwrap(),
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.app.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[tokio::test]
async fn empty_reconciliation_does_not_start_a_write_transaction() {
    let fixture = Fixture::new().await;
    fixture
        .app()
        .db(|db| {
            for enabled in [false, true] {
                db.set_settings(&json!({"searchAI":{"enabled":enabled}}))?;
                smart_search::reconcile(db)?;
                db.conn.execute_batch("PRAGMA query_only=ON")?;
                let result = smart_search::reconcile(db);
                db.conn.execute_batch("PRAGMA query_only=OFF")?;
                result?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn request(app: &App, path: &str, body: Option<Value>, owner: &str) -> (u16, Value) {
    let mut headers = HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    headers.insert("x-morrow-view", "paged".parse().unwrap());
    let ctx = Context {
        method: if body.is_some() {
            Method::POST
        } else {
            Method::GET
        },
        path: std::iter::once("search".to_owned())
            .chain(path.split('/').filter(|s| !s.is_empty()).map(str::to_owned))
            .collect(),
        body: body.unwrap_or_else(|| json!({})),
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    };
    let response = smart_search::handle(app, &ctx)
        .await
        .unwrap_or_else(|e| Some(e.into_response()))
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[derive(Clone)]
struct Model {
    seen: Arc<Mutex<Vec<Value>>>,
    mode: Arc<Mutex<String>>,
    hold: Arc<AtomicBool>,
    arrived: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            seen: Arc::new(Mutex::new(vec![])),
            mode: Arc::new(Mutex::new(String::new())),
            hold: Arc::new(AtomicBool::new(false)),
            arrived: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}
impl Model {
    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
    async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(5), self.arrived.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    fn finish(&self) {
        self.release.add_permits(1);
    }
}
async fn model(State(model): State<Model>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let authorization = request
        .headers()
        .get("authorization")
        .map(|s| s.to_str().unwrap().to_owned());
    let body: Value =
        serde_json::from_slice(&to_bytes(request.into_body(), 128 * 1024).await.unwrap()).unwrap();
    model
        .seen
        .lock()
        .unwrap()
        .push(json!({"path":path,"authorization":authorization,"body":body}));
    if model.hold.load(Ordering::Acquire) {
        model.arrived.add_permits(1);
        model.release.acquire().await.unwrap().forget();
    }
    let mode = model.mode.lock().unwrap().clone();
    if let Some(status) = mode.strip_prefix("http:") {
        return (
            StatusCode::from_u16(status.parse().unwrap()).unwrap(),
            "PRIVATE MODEL BODY fixture-key mail-content",
        )
            .into_response();
    }
    if mode == "redirect" {
        return (
            StatusCode::FOUND,
            [("location", "http://127.0.0.1:9/credential-leak")],
            "",
        )
            .into_response();
    }
    if mode == "failure" {
        return (
            StatusCode::BAD_GATEWAY,
            "fixture error with private contents",
        )
            .into_response();
    }
    if mode == "oversized" {
        return (
            StatusCode::OK,
            [("content-type", "application/json")],
            " ".repeat(8 * 1024 * 1024 + 1),
        )
            .into_response();
    }
    if mode == "invalid" {
        return Json(json!({"data":[{"index":0,"embedding":[0,0]}]})).into_response();
    }
    if mode == "duplicate" {
        return Json(json!({"data":[{"index":0,"embedding":[1,0]},{"index":0,"embedding":[0,1]}]}))
            .into_response();
    }
    let vectors = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|text| {
            let text = text.as_str().unwrap();
            if mode == "dimension" {
                json!([1, 0, 0])
            } else if text.contains("extra time") || text.contains("延期付款") {
                json!([1, 0])
            } else {
                json!([0, 1])
            }
        })
        .collect::<Vec<_>>();
    if path.ends_with("/api/embed") {
        Json(json!({"embeddings":vectors})).into_response()
    } else {
        Json(json!({"data":vectors.into_iter().enumerate().rev().map(|(index,embedding)|json!({"index":index as f64,"embedding":embedding})).collect::<Vec<_>>()})).into_response()
    }
}
async fn server(model: Model) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(self::model).with_state(model),
        )
        .await
        .unwrap();
    });
    (url, task)
}
fn expect_error(result: Result<search_query::Query>) {
    assert!(matches!(result,Err(error) if error.status==400));
}

#[test]
fn exact_parser_segments_and_cursor_contract() {
    let options=search_query::parse(&json!({"query":"  發票 from:\"Jane Doe\" is:unread after:2024-02-29  ","scope":"all","filters":{"label":" White  Space "}})).unwrap();
    assert_eq!(options.terms, vec!["发票"]);
    assert_eq!(
        options
            .conditions
            .iter()
            .map(|c| (&*c.key, &*c.value))
            .collect::<Vec<_>>(),
        vec![
            ("from", "jane doe"),
            ("is", "unread"),
            ("after", "2024-02-29"),
            ("label", "white space")
        ]
    );
    assert_eq!(
        options.chips[0],
        json!({"label":"from:\"Jane Doe\"","query":"發票  is:unread after:2024-02-29"})
    );
    for query in [
        "invoice\" OR *",
        "\"unfinished",
        "after:2026-02-30",
        "after:2026-2-03",
        "is:wrong",
        "is:READ",
        "in:missing",
        "from:",
        "from:\"\"",
        "unknown:thing",
    ] {
        expect_error(search_query::parse(&json!({"query":query})));
    }
    for input in [
        json!(null),
        json!([]),
        json!({"filters":null}),
        json!({"filters":{"x":"y"}}),
        json!({"query":"😀".repeat(251)}),
        json!({"query":"x ".repeat(25)}),
        json!({"page":2001}),
        json!({"page":-1}),
        json!({"page":1.5}),
        json!({"smart":1}),
        json!({"cachedOnly":"true"}),
        json!({"cursor":"x".repeat(8193)}),
    ] {
        expect_error(search_query::parse(&input));
    }
    assert_eq!(
        search_query::parse(&json!({"query":"\u{feff}Café\u{feff}發票\u{feff}"}))
            .unwrap()
            .terms,
        vec!["cafe", "发票"]
    );
    let segments = search_query::segments(
        "A <script>發票</script> and Café",
        &["发票".into(), "cafe".into()],
        180,
    );
    assert_eq!(
        segments
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["hit"] == true)
            .map(|s| s["text"].as_str().unwrap())
            .collect::<String>(),
        "發票Café"
    );
    let secret = [7; 32];
    let cursor = search_query::next_cursor("scope", 0, 60, &secret);
    assert_eq!(
        search_query::cursor_page(&cursor, "scope", &secret).unwrap(),
        1
    );
    assert!(search_query::cursor_page(&cursor, "changed", &secret).is_err());
    assert!(search_query::cursor_page(&(cursor + "x"), "scope", &secret).is_err());
    assert_eq!(search_query::next_cursor("scope", 1, 60, &secret), "");
}
#[tokio::test]
async fn lexical_http_scope_history_and_hmac_pages() {
    let fixture = Fixture::new().await;
    for i in 0..35 {
        fixture
            .add(
                A,
                &format!("m{i}"),
                json!({"date":format!("2026-09-25T00:00:{i:02}.000Z")}),
            )
            .await;
    }
    fixture.add(B, "m0", json!({"folder":"sent"})).await;
    fixture.add(B, "trash", json!({"folder":"trash"})).await;
    fixture
        .add("disconnected@example.invalid", "m0", json!({}))
        .await;
    assert_eq!(fixture.request("", Some(json!({})), "").await.0, 409);
    for query in [
        "付款",
        "发票",
        "發票",
        "票",
        "cafe",
        "INV-1042",
        "\"project payment\"",
        "付款 cafe",
        "from:\"Jane Doe\" to:private@example.invalid label:finance is:unread",
        "label:\"white space\"",
    ] {
        let (status, result) = fixture
            .request(
                "",
                Some(json!({"query":query,"scope":"all","sort":"newest"})),
                A,
            )
            .await;
        assert_eq!(status, 200, "{query}: {result}");
        assert_eq!(result["total"], 36, "{query}");
    }
    let (_, first) = fixture
        .request(
            "",
            Some(json!({"query":"付款","scope":"all","sort":"newest"})),
            A,
        )
        .await;
    assert_eq!(first["messages"].as_array().unwrap().len(), 30);
    assert!(
        first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m.get("body").is_none())
    );
    let (_, second) = fixture
        .request(
            "",
            Some(
                json!({"query":"付款","scope":"all","sort":"newest","cursor":first["nextCursor"]}),
            ),
            A,
        )
        .await;
    assert_eq!(second["messages"].as_array().unwrap().len(), 6);
    assert_eq!(second["page"], 1);
    let ids = first["messages"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["messages"].as_array().unwrap())
        .map(|v| v["viewId"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 36);
    assert_eq!(fixture.request("",Some(json!({"query":"付款","scope":"all","sort":"oldest","cursor":first["nextCursor"]})),A).await.0,409);
    assert_eq!(
        fixture
            .request("", Some(json!({"query":"in:trash","scope":"all"})), A)
            .await
            .1["total"],
        1
    );
    assert_eq!(
        fixture
            .request(
                "",
                Some(json!({"query":"付款","scope":"folder","folder":"inbox"})),
                B
            )
            .await
            .1["total"],
        0
    );
    assert_eq!(
        fixture
            .request(
                "",
                Some(json!({"query":"\"payment project\"","scope":"all"})),
                A
            )
            .await
            .1["total"],
        0
    );
    fixture
        .request(
            "preferences",
            Some(json!({"action":"save","value":{"query":"from:jane","scope":"all"}})),
            A,
        )
        .await;
    assert_eq!(
        fixture.request("preferences", None, A).await.1["saved"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture.request("preferences", None, B).await.1["saved"],
        json!([])
    );
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"mailAccounts":{A:{"email":A,"connectionId":"fixture-a"}}}))?;
            smart_search::reconcile(db)
        })
        .await
        .unwrap();
    assert_eq!(
        fixture
            .request("", Some(json!({"query":"付款","scope":"all"})), A)
            .await
            .1["total"],
        35
    );
    assert_eq!(fixture.request("", Some(json!({})), B).await.0, 409);
    assert_eq!(fixture.request("",Some(json!({"query":"付款","scope":"all","sort":"newest","cursor":first["nextCursor"]})),A).await.0,409);
    // Exercise the real Axum authentication/host/origin boundary as well.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = fixture.app().router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    for (auth, origin, expected) in [
        ("", "", 401),
        ("Bearer fixture-token", "https://hostile.invalid", 403),
        ("Bearer fixture-token", "", 200),
    ] {
        let result = client
            .post(format!("{url}/api/search"))
            .header("authorization", auth)
            .header("origin", origin)
            .header("x-genmail-account", A)
            .header("x-morrow-view", "paged")
            .json(&json!({"query":"付款","scope":"all"}))
            .send()
            .await
            .unwrap();
        assert_eq!(result.status().as_u16(), expected);
    }
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn normalization_expansion_retains_the_public_query_and_filter_limits() {
    let fixture = Fixture::new().await;
    let expanded = "ﷺ".repeat(100);
    fixture
        .add(A, "expanded", json!({"subject":expanded,"body":""}))
        .await;
    for input in [
        json!({"query":expanded,"scope":"account"}),
        json!({"filters":{"subject":expanded},"scope":"account"}),
    ] {
        let (status, result) = fixture.request("", Some(input), A).await;
        assert_eq!(status, 200, "{result}");
        assert_eq!(result["total"], 1);
    }
}
#[tokio::test]
async fn reviewed_index_permissions_incremental_queries_and_settings() {
    let mut fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    fixture.add(A,"payment",json!({"subject":"PRIVATE SUBJECT","body":"The customer asks for extra time to settle their bill."})).await;
    fixture
        .add(A, "meeting", json!({"body":"Team lunch and coffee."}))
        .await;
    fixture
        .add(B, "payment", json!({"body":"OTHER ACCOUNT SECRET"}))
        .await;
    fixture.app().db(|db|{db.set_settings(&json!({"policy":{"enabled":true,"content":{"subject":false,"sender":false,"body":true}}}))?;Ok(())}).await.unwrap();
    assert_eq!(
        fixture.request("index/preview", Some(json!({})), A).await.0,
        403
    );
    fixture
        .setup(
            &url,
            json!({"apiKey":"fixture-key","months":3.0,"tokenBudget":16000.0}),
        )
        .await;
    let preview = fixture.preview_run().await;
    assert_eq!(preview["job"]["sampleCount"], 2);
    assert_eq!(model.count(), 0);
    assert!(!preview.to_string().contains("PRIVATE SUBJECT"));
    assert!(!preview.to_string().contains("OTHER ACCOUNT"));
    assert!(!preview.to_string().contains("fixture-key"));
    let persisted = fixture.app().settings().await.unwrap()["searchIndex"].clone();
    assert!(!persisted.to_string().contains("customer"));
    assert!(persisted.get("sources").is_some());
    smart_search::tick(fixture.app()).await.unwrap();
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(fixture.request("settings", None, A).await.1["indexed"], 2);
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["status"],
        "complete"
    );
    assert_eq!(model.count(), 2);
    assert_eq!(
        fixture.request("index/preview", Some(json!({})), A).await.0,
        409
    );
    let sent = model.seen.lock().unwrap().clone();
    assert!(!json!(sent).to_string().contains("PRIVATE SUBJECT"));
    assert!(!json!(sent).to_string().contains("private@example"));
    assert!(!json!(sent).to_string().contains("OTHER ACCOUNT"));
    let query = json!({"query":"延期付款","scope":"all","smart":true});
    let (status, found) = fixture.request("", Some(query.clone()), A).await;
    assert_eq!(status, 200, "{found}");
    assert_eq!(found["messages"][0]["id"], "payment");
    assert_eq!(found["messages"][0]["accountId"], A);
    assert_eq!(found["messages"][0]["searchMatch"], "semantic");
    let count = model.count();
    fixture
        .request(
            "",
            Some(json!({"query":"延期付款","scope":"all","smart":true,"page":1})),
            A,
        )
        .await;
    assert_eq!(model.count(), count);
    fixture
        .app()
        .db(|db| {
            db.update(A, "payment", &json!({"read":true}))?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(fixture.request("settings", None, A).await.1["pending"], 0);
    fixture
        .app()
        .db(|db| {
            db.update(
                A,
                "payment",
                &json!({"body":"The customer asks for extra time to pay a new bill."}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(fixture.request("settings", None, A).await.1["pending"], 1);
    let preview = fixture.preview_run().await;
    assert_eq!(preview["job"]["sampleCount"], 1);
    smart_search::tick(fixture.app()).await.unwrap();
    fixture.reopen();
    assert_eq!(fixture.request("settings", None, A).await.1["indexed"], 2);
    let count = model.count();
    assert_eq!(
        fixture
            .request(
                "",
                Some(json!({"query":"延期付款","scope":"all","smart":true,"cachedOnly":true})),
                A
            )
            .await
            .0,
        409
    );
    assert_eq!(
        fixture
            .request(
                "",
                Some(json!({"query":"延期付款","scope":"all","smart":true,"page":1})),
                A
            )
            .await
            .0,
        409
    );
    assert_eq!(model.count(), count);
    assert_eq!(
        fixture
            .request("settings", Some(json!({"model":"different-model"})), A)
            .await
            .1["indexed"],
        0
    );
    assert_eq!(fixture.vectors().await, 0);
    assert_eq!(
        fixture.request("settings", None, A).await.1["settings"]["hasApiKey"],
        true
    );
    assert_eq!(
        fixture
            .request(
                "settings",
                Some(json!({"baseUrl":"https://new.example.invalid/v1"})),
                A
            )
            .await
            .1["settings"]["hasApiKey"],
        false
    );
    for patch in [
        json!({"baseUrl":"http://remote.invalid"}),
        json!({"baseUrl":"https://user:pass@host.invalid"}),
        json!({"baseUrl":"https://host.invalid/?key=x"}),
        json!({"apiKey":"bad\r\nkey"}),
        json!({"accounts":["unknown.invalid"]}),
        json!({"tokenBudget":3999}),
        json!({"tokenBudget":64001}),
        json!({"folders":{"invalid":true}}),
        json!({"content":{"sender":1}}),
        json!({"clearApiKey":"yes"}),
    ] {
        assert_eq!(
            fixture.request("settings", Some(patch.clone()), A).await.0,
            400,
            "{patch}"
        );
    }
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn queue_chunk_progress_pause_resume_cancel_restart_and_budget() {
    let mut fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    fixture
        .add(A, "long", json!({"subject":"","body":"x".repeat(20000)}))
        .await;
    fixture.setup(&url, json!({"tokenBudget":64000})).await;
    fixture.preview_run().await;
    smart_search::tick(fixture.app()).await.unwrap();
    let (_, state) = fixture.request("settings", None, A).await;
    assert_eq!(state["indexed"], 0);
    assert_eq!(state["job"]["part"], 16);
    assert_eq!(model.count(), 1);
    assert_eq!(
        model.seen.lock().unwrap()[0]["body"]["input"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
    assert_eq!(
        fixture.request("index/pause", Some(json!({})), A).await.0,
        200
    );
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 1);
    fixture.reopen();
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["status"],
        "paused"
    );
    assert_eq!(
        fixture.request("index/resume", Some(json!({})), A).await.0,
        202
    );
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 2);
    assert_eq!(fixture.request("settings", None, A).await.1["indexed"], 1);
    let seen = model.seen.lock().unwrap().clone();
    assert_eq!(seen[1]["body"]["input"].as_array().unwrap().len(), 6);
    fixture.request("index/clear", Some(json!({})), A).await;
    assert_eq!(fixture.vectors().await, 0);
    fixture.preview_run().await;
    fixture.reopen();
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["status"],
        "interrupted"
    );
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 2);
    fixture.request("index/resume", Some(json!({})), A).await;
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(fixture.vectors().await, 16);
    fixture.request("index/cancel", Some(json!({})), A).await;
    assert_eq!(fixture.vectors().await, 0);
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 3);
    fixture
        .request("settings", Some(json!({"tokenBudget":4000})), A)
        .await;
    assert_eq!(
        fixture.request("index/preview", Some(json!({})), A).await.0,
        409
    );
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn multi_message_chunk_progress_keeps_stamp_dimension_and_reviewed_budget() {
    for protocol in ["openai", "ollama"] {
        let fixture = Fixture::new().await;
        let model = Model::default();
        let (url, task) = server(model.clone()).await;
        let date = chrono::Utc::now();
        for (index, body) in [
            "short first".to_owned(),
            "x".repeat(20000),
            "short last".to_owned(),
        ]
        .into_iter()
        .enumerate()
        {
            fixture.add(A, &format!("mail-{index}"), json!({"subject":"", "body":body, "date":(date-chrono::Duration::seconds(index as i64)).to_rfc3339()})).await;
        }
        fixture
            .setup(&url, json!({"protocol":protocol,"tokenBudget":64000}))
            .await;
        let preview = fixture.preview_run().await;
        assert_eq!(preview["job"]["sampleCount"], 3);
        let stamp = fixture.app().settings().await.unwrap()["searchIndex"]["stamp"].clone();
        for (completed, part) in [(1, 0), (1, 16), (2, 0), (3, 0)] {
            smart_search::tick(fixture.app()).await.unwrap();
            let state = fixture.request("settings", None, A).await.1;
            assert_eq!(state["job"]["completed"], completed, "{protocol}: {state}");
            assert_eq!(state["job"]["part"], part, "{protocol}: {state}");
            assert_eq!(state["job"]["dimension"], 2);
            assert_eq!(
                fixture.app().settings().await.unwrap()["searchIndex"]["stamp"],
                stamp
            );
        }
        let state = fixture.request("settings", None, A).await.1;
        assert_eq!(state["job"]["status"], "complete");
        assert_eq!(
            state["job"]["spentTokens"],
            preview["job"]["estimatedTokens"]
        );
        assert_eq!(state["indexed"], 3);
        assert_eq!(fixture.vectors().await, 24);
        let seen = model.seen.lock().unwrap().clone();
        assert_eq!(
            seen.iter()
                .map(|request| request["body"]["input"].as_array().unwrap().len())
                .collect::<Vec<_>>(),
            vec![1, 16, 6, 1]
        );
        smart_search::tick(fixture.app()).await.unwrap();
        assert_eq!(
            model.count(),
            4,
            "Completed jobs never automatically rerun."
        );
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test]
async fn second_message_http_failure_retains_progress_and_safe_reason_without_retry() {
    for protocol in ["openai", "ollama"] {
        for (status, reason) in [
            (429, "rate limit"),
            (413, "input"),
            (401, "API key"),
            (503, "service"),
        ] {
            let fixture = Fixture::new().await;
            let model = Model::default();
            let (url, task) = server(model.clone()).await;
            fixture
                .add(A, "first", json!({"body":"first permitted message"}))
                .await;
            fixture
                .add(A, "second", json!({"body":"second permitted message"}))
                .await;
            fixture
                .setup(&url, json!({"protocol":protocol,"apiKey":"fixture-key"}))
                .await;
            fixture.preview_run().await;
            smart_search::tick(fixture.app()).await.unwrap();
            assert_eq!(
                fixture.request("settings", None, A).await.1["job"]["completed"],
                1
            );
            *model.mode.lock().unwrap() = format!("http:{status}");
            smart_search::tick(fixture.app()).await.unwrap();
            let (_, state) = fixture.request("settings", None, A).await;
            assert_eq!(state["job"]["status"], "failed");
            assert_eq!(state["job"]["completed"], 1);
            assert_eq!(state["indexed"], 1);
            assert_eq!(fixture.vectors().await, 1);
            let error = state["job"]["error"].as_str().unwrap();
            assert!(
                error.contains(&format!("HTTP {status}")),
                "{protocol}: {error}"
            );
            assert!(error.contains(reason), "{protocol}: {error}");
            for private in ["PRIVATE MODEL BODY", "fixture-key", "mail-content"] {
                assert!(!state.to_string().contains(private));
            }
            smart_search::tick(fixture.app()).await.unwrap();
            assert_eq!(model.count(), 2, "failed batches never retry themselves");
            task.abort();
            let _ = task.await;
        }
    }
}

#[tokio::test]
async fn embedding_transport_is_bounded_validates_shape_and_never_follows_redirects() {
    let fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    let mut config =
        json!({"baseUrl":url,"protocol":"openai","model":"fixture","apiKey":"fixture-only-key"});
    let input = vec!["extra time".into(), "coffee".into()];
    assert_eq!(
        smart_search::fetch_embeddings(fixture.app(), &config, &input)
            .await
            .unwrap(),
        vec![vec![1., 0.], vec![0., 1.]]
    );
    config["protocol"] = "ollama".into();
    assert_eq!(
        smart_search::fetch_embeddings(fixture.app(), &config, &input)
            .await
            .unwrap(),
        vec![vec![1., 0.], vec![0., 1.]]
    );
    let seen = model.seen.lock().unwrap().clone();
    assert_eq!(seen[1]["body"]["truncate"], false);
    assert_eq!(seen[0]["authorization"], "Bearer fixture-only-key");
    config["protocol"] = "openai".into();
    for (mode, reason) in [
        ("redirect", "HTTP 302"),
        ("failure", "HTTP 502"),
        ("invalid", "does not match its inputs"),
        ("duplicate", "does not match its inputs"),
        ("oversized", "exceeds 8 MiB"),
    ] {
        *model.mode.lock().unwrap() = mode.into();
        let error = smart_search::fetch_embeddings(fixture.app(), &config, &input)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(reason), "{mode}: {error}");
        assert!(!error.contains("private contents"));
    }
    let count = model.count();
    assert!(
        smart_search::fetch_embeddings(fixture.app(), &config, &vec!["input".into(); 17])
            .await
            .is_err()
    );
    assert!(
        smart_search::fetch_embeddings(fixture.app(), &config, &["x".repeat(9001)])
            .await
            .is_err()
    );
    config["baseUrl"] = "http://remote.invalid".into();
    assert!(
        smart_search::fetch_embeddings(fixture.app(), &config, &input)
            .await
            .is_err()
    );
    assert_eq!(model.count(), count);
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn inflight_index_and_query_discard_revocation_reconnect_source_clear_and_restore() {
    for change in ["policy", "connection", "message", "clear", "restore"] {
        let fixture = Fixture::new().await;
        let model = Model::default();
        let (url, task) = server(model.clone()).await;
        fixture.add(A, "x", json!({"body":"extra time"})).await;
        fixture.setup(&url, json!({})).await;
        fixture.preview_run().await;
        model.hold.store(true, Ordering::Release);
        let app = fixture.app().clone();
        let work = tokio::spawn(async move {
            smart_search::tick(&app).await.unwrap();
        });
        model.wait().await;
        match change {
            "policy" => fixture
                .app()
                .db(|db| {
                    db.set_settings(&json!({"policy":{"enabled":false}}))?;
                    smart_search::reconcile(db)
                })
                .await
                .unwrap(),
            "connection" => fixture
                .app()
                .db(|db| {
                    db.set_settings(
                        &json!({"mailAccounts":{A:{"email":A,"connectionId":"new-connection"}}}),
                    )?;
                    smart_search::reconcile(db)
                })
                .await
                .unwrap(),
            "message" => fixture
                .app()
                .db(|db| {
                    db.update(A, "x", &json!({"body":"changed"}))?;
                    Ok(())
                })
                .await
                .unwrap(),
            "clear" => {
                fixture.request("index/clear", Some(json!({})), A).await;
            }
            _ => fixture
                .app()
                .db(|db| {
                    let saved = db.settings()?["policy"].clone();
                    db.set_settings(&json!({"policy":{"enabled":false}}))?;
                    smart_search::reconcile(db)?;
                    db.set_settings(&json!({"policy":saved}))?;
                    smart_search::reconcile(db)
                })
                .await
                .unwrap(),
        }
        model.finish();
        work.await.unwrap();
        assert_eq!(fixture.vectors().await, 0, "{change}");
        smart_search::tick(fixture.app()).await.unwrap();
        assert_eq!(model.count(), 1, "failed work must never retry: {change}");
        model.hold.store(false, Ordering::Release);
        fixture
            .app()
            .db(|db| {
                db.set_settings(&json!({"policy":{"enabled":true}}))?;
                smart_search::reconcile(db)
            })
            .await
            .unwrap();
        fixture.preview_run().await;
        smart_search::tick(fixture.app()).await.unwrap();
        assert!(fixture.vectors().await > 0);
        model.hold.store(true, Ordering::Release);
        let app = fixture.app().clone();
        let query = tokio::spawn(async move {
            request(
                &app,
                "",
                Some(json!({"query":"延期付款","scope":"all","smart":true})),
                A,
            )
            .await
        });
        model.wait().await;
        match change {
            "policy" | "restore" => fixture
                .app()
                .db(|db| {
                    db.set_settings(&json!({"policy":{"enabled":false}}))?;
                    smart_search::reconcile(db)
                })
                .await
                .unwrap(),
            "connection" => fixture
                .app()
                .db(|db| {
                    db.set_settings(&json!({"mailAccounts":{}}))?;
                    smart_search::reconcile(db)
                })
                .await
                .unwrap(),
            "message" => fixture
                .app()
                .db(|db| {
                    db.update(A, "x", &json!({"folder":"trash"}))?;
                    Ok(())
                })
                .await
                .unwrap(),
            _ => {
                fixture.request("index/clear", Some(json!({})), A).await;
            }
        }
        model.finish();
        let (status, result) = query.await.unwrap();
        assert!([409, 502].contains(&status), "{change}: {status} {result}");
        assert!(result.get("messages").is_none());
        if change != "message" {
            assert_eq!(fixture.vectors().await, 0);
        }
        task.abort();
        let _ = task.await;
    }
}
#[tokio::test]
async fn failed_model_never_auto_retries_dimension_changes_fail_and_retries_obey_budget() {
    let fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    fixture
        .add(A, "x", json!({"body":"x".repeat(2500),"subject":""}))
        .await;
    fixture.setup(&url, json!({"tokenBudget":4000})).await;
    fixture.preview_run().await;
    *model.mode.lock().unwrap() = "failure".into();
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["status"],
        "failed"
    );
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 1);
    *model.mode.lock().unwrap() = "".into();
    fixture.request("index/resume", Some(json!({})), A).await;
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        model.count(),
        1,
        "retry cannot exceed remaining reviewed budget"
    );
    assert_eq!(fixture.vectors().await, 0);
    fixture.preview_run().await;
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(fixture.request("settings", None, A).await.1["indexed"], 1);
    fixture.add(A, "y", json!({"body":"coffee"})).await;
    fixture.preview_run().await;
    *model.mode.lock().unwrap() = "dimension".into();
    smart_search::tick(fixture.app()).await.unwrap();
    let (_, state) = fixture.request("settings", None, A).await;
    assert_eq!(state["job"]["status"], "failed");
    assert_eq!(state["indexed"], 1);
    assert!(
        state["job"]["error"]
            .as_str()
            .unwrap()
            .contains("dimensions")
    );
    assert_eq!(
        fixture
            .request(
                "",
                Some(json!({"query":"延期付款","scope":"all","smart":true})),
                A
            )
            .await
            .0,
        409
    );
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn semantic_hmac_pagination_and_concurrent_requests_reuse_one_paid_query() {
    let fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    fixture
        .app()
        .db(|db| {
            let mut settings = db.settings()?["policy"].clone();
            settings["maxMessages"] = 50.into();
            db.set_settings(&json!({"policy":settings}))?;
            Ok(())
        })
        .await
        .unwrap();
    for i in 0..36 {
        fixture
            .add(
                A,
                &format!("m{i:02}"),
                json!({"body":"extra time to settle the bill"}),
            )
            .await;
    }
    fixture.setup(&url, json!({"tokenBudget":64000})).await;
    fixture.preview_run().await;
    for _ in 0..36 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(fixture.request("settings", None, A).await.1["indexed"], 36);
    let count = model.count();
    let query = json!({"query":"延期付款","scope":"all","smart":true});
    let (one, two) = tokio::join!(
        fixture.request("", Some(query.clone()), A),
        fixture.request("", Some(query), A)
    );
    assert_eq!(one.0, 200, "{}", one.1);
    assert_eq!(two.0, 200);
    assert_eq!(model.count(), count + 1);
    assert_eq!(one.1["total"], 36);
    let (status, page) = fixture
        .request(
            "",
            Some(
                json!({"query":"延期付款","scope":"all","smart":true,"cursor":one.1["nextCursor"]}),
            ),
            A,
        )
        .await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["messages"].as_array().unwrap().len(), 6);
    assert_eq!(model.count(), count + 1);
    let ids = one.1["messages"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page["messages"].as_array().unwrap())
        .map(|m| m["viewId"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 36);
    fixture
        .app()
        .db(|db| {
            db.update(A, "m00", &json!({"body":"changed source"}))?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(fixture.request("",Some(json!({"query":"延期付款","scope":"all","smart":true,"cursor":one.1["nextCursor"]})),A).await.0,409);
    assert_eq!(model.count(), count + 1);
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn connection_probe_uses_unsaved_model_without_mail_settings_or_index_changes() {
    let fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    fixture.add(A, "probe-source", json!({})).await;
    fixture
        .setup(&url, json!({"apiKey":"saved-fixture-key"}))
        .await;
    fixture.preview_run().await;
    smart_search::tick(fixture.app()).await.unwrap();
    let before = fixture.app().db(|db| db.settings()).await.unwrap();
    let vectors = fixture.vectors().await;
    assert!(vectors > 0);
    model.seen.lock().unwrap().clear();
    let input = json!({"baseUrl":url,"model":"unsaved-model","protocol":"openai","apiKey":""});
    let (status, result) = fixture.request("test", Some(input.clone()), A).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result, json!({"ok":true,"dimensions":2}));
    let seen = model.seen.lock().unwrap().clone();
    assert_eq!(seen[0]["authorization"], "Bearer saved-fixture-key");
    assert_eq!(seen[0]["body"]["model"], "unsaved-model");
    assert_eq!(
        seen[0]["body"]["input"],
        json!(["Morrow Mail embedding connection test."])
    );
    for change in [
        json!({"baseUrl":format!("{url}/changed"),"protocol":"ollama"}),
        json!({"clearApiKey":true}),
    ] {
        let mut changed = input.clone();
        for (key, value) in change.as_object().unwrap() {
            changed[key] = value.clone();
        }
        assert_eq!(fixture.request("test", Some(changed), A).await.0, 200);
        assert!(model.seen.lock().unwrap().last().unwrap()["authorization"].is_null());
    }
    let count = model.count();
    for change in [
        json!({"model":""}),
        json!({"baseUrl":"http://remote.invalid"}),
        json!({"apiKey":"bad\r\nkey"}),
        json!({"input":"private body"}),
        json!({"enabled":true}),
    ] {
        let mut changed = input.clone();
        for (key, value) in change.as_object().unwrap() {
            changed[key] = value.clone();
        }
        assert_eq!(fixture.request("test", Some(changed), A).await.0, 400);
    }
    assert_eq!(model.count(), count);
    *model.mode.lock().unwrap() = "invalid".into();
    let (status, result) = fixture.request("test", Some(input.clone()), A).await;
    assert_eq!(status, 502);
    assert!(!result.to_string().contains("saved-fixture-key"));
    assert_eq!(fixture.app().db(|db| db.settings()).await.unwrap(), before);
    assert_eq!(fixture.vectors().await, vectors);
    *model.mode.lock().unwrap() = String::new();
    assert_eq!(fixture.request("test", Some(json!({})), A).await.0, 200);
    let saved_probe = model.seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(saved_probe["body"]["model"], before["searchAI"]["model"]);
    assert_eq!(saved_probe["authorization"], "Bearer saved-fixture-key");
    assert_eq!(
        saved_probe["body"]["input"],
        json!(["Morrow Mail embedding connection test."])
    );
    assert_eq!(fixture.app().db(|db| db.settings()).await.unwrap(), before);
    assert_eq!(fixture.vectors().await, vectors);
    model.hold.store(true, Ordering::Release);
    let app = fixture.app().clone();
    let first_input = input.clone();
    let pending = tokio::spawn(async move { request(&app, "test", Some(first_input), A).await });
    model.wait().await;
    assert_eq!(fixture.request("test", Some(input), A).await.0, 409);
    model.finish();
    assert_eq!(pending.await.unwrap().0, 200);
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn automatic_indexing_continues_across_batches_and_restart_with_daily_budget() {
    let mut fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    for id in ["one", "two", "three", "four"] {
        fixture.add(A, id, json!({"body":"x".repeat(1400)})).await;
    }
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"policy":{"maxMessages":1}}))?;
            Ok(())
        })
        .await
        .unwrap();
    fixture
        .setup(&url, json!({"autoIndex":true,"dailyTokenBudget":4000}))
        .await;
    for _ in 0..8 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    let before = model.count();
    assert!(
        before > 1 && before < 4,
        "successive batches stop at the daily cap: {before}"
    );
    let (_, status) = fixture.request("settings", None, A).await;
    assert!(status["automatic"]["spentToday"].as_u64().unwrap() <= 4000);
    assert_eq!(status["indexed"], before);
    fixture.reopen();
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        model.count(),
        before,
        "restarting cannot reset the daily allowance"
    );
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"searchDailyUsage":{"day":"2000-01-01","tokens":4000}}))?;
            Ok(())
        })
        .await
        .unwrap();
    for _ in 0..8 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(model.count(), 4);
    fixture
        .add(A, "new", json!({"body":"New downloaded mail"}))
        .await;
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"searchDailyUsage":{"day":"2000-01-01","tokens":4000}}))?;
            Ok(())
        })
        .await
        .unwrap();
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        model.count(),
        5,
        "new mail is picked up without another reviewed batch"
    );
    let (code, _) = fixture
        .request("settings", Some(json!({"autoIndex":false})), A)
        .await;
    assert_eq!(code, 200);
    let (_, status) = fixture.request("settings", None, A).await;
    assert_eq!(
        status["indexed"], 5,
        "stopping automation preserves vectors"
    );
    fixture.add(A, "disabled", json!({})).await;
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 5);
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":true})), A)
            .await
            .0,
        200
    );
    assert_eq!(
        fixture.request("index/clear", Some(json!({})), A).await.0,
        200
    );
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        model.count(),
        5,
        "clearing the index requires review before rebuilding"
    );
    assert_eq!(
        fixture.request("settings", None, A).await.1["automatic"]["approved"],
        false
    );
    task.abort();
}

#[tokio::test]
async fn all_downloaded_history_requires_review_and_distinguishes_skipped_from_daily_wait() {
    let mut fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    assert_eq!(
        fixture.request("settings", None, A).await.1["settings"]["months"],
        0
    );
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"searchAI":{"enabled":false}}))?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        fixture.request("settings", None, A).await.1["settings"]["months"],
        3,
        "an older implicit scope stays unchanged"
    );
    fixture
        .add(A, "old", json!({"date":"2020-01-01T00:00:00.000Z"}))
        .await;
    fixture
        .add(
            B,
            "old",
            json!({"date":"2020-01-01T00:00:00.000Z","body":"OTHER OWNER SECRET"}),
        )
        .await;
    fixture.add(A, "recent", json!({})).await;
    fixture
        .add(A, "oversized", json!({"body":"x".repeat(50_000)}))
        .await;
    fixture
        .add(A, "batch-limit", json!({"body":"x".repeat(5_000)}))
        .await;
    fixture
        .setup(
            &url,
            json!({"months":12,"autoIndex":true,"dailyTokenBudget":4000,"tokenBudget":4000}),
        )
        .await;
    fixture.reopen();
    assert_eq!(
        fixture.request("settings", None, A).await.1["settings"]["months"],
        12
    );
    assert_eq!(fixture.request("settings", None, A).await.1["eligible"], 3);
    assert_eq!(
        fixture
            .request("settings", Some(json!({"months":0})), A)
            .await
            .0,
        200
    );
    let (_, expanded) = fixture.request("settings", None, A).await;
    assert_eq!(expanded["eligible"], 4);
    assert_eq!(expanded["automatic"]["approved"], false);
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(
        model.count(),
        0,
        "scope expansion cannot use an old approval"
    );
    for invalid in [json!(-1), json!(0.5), json!(13)] {
        assert_eq!(
            fixture
                .request("settings", Some(json!({"months":invalid})), A)
                .await
                .0,
            400
        );
    }
    // Starting automatic mode also supersedes an unfinished manual preview.
    assert_eq!(
        fixture.request("index/preview", Some(json!({})), A).await.0,
        200
    );
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":true})), A)
            .await
            .0,
        200
    );
    for _ in 0..10 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    let (_, indexed) = fixture.request("settings", None, A).await;
    assert_eq!(indexed["indexed"], 2);
    assert_eq!(indexed["skipped"]["oversized"], 1);
    assert_eq!(indexed["skipped"]["batchBudget"], 1);
    assert_eq!(indexed["automatic"]["waitingForBudget"], false);
    assert_eq!(model.count(), 2);
    assert!(
        !json!(model.seen.lock().unwrap().clone())
            .to_string()
            .contains("OTHER OWNER")
    );
    fixture
        .add(
            A,
            "old",
            json!({"date":"2020-01-01T00:00:00.000Z","body":"Changed permitted text"}),
        )
        .await;
    for _ in 0..5 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(model.count(), 3, "only changed text is sent again");
    fixture.app().db(|db| { db.set_settings(&json!({"searchDailyUsage":{"day":chrono::Utc::now().format("%Y-%m-%d").to_string(),"tokens":3999}}))?; Ok(()) }).await.unwrap();
    fixture.add(A, "new", json!({})).await;
    let (_, waiting) = fixture.request("settings", None, A).await;
    assert_eq!(waiting["automatic"]["remainingToday"], 1);
    assert_eq!(
        waiting["automatic"]["waitingForBudget"], true,
        "a positive allowance can still be too small for the next request"
    );
    assert_eq!(
        waiting["skipped"], indexed["skipped"],
        "daily limits are not permanent exclusions"
    );
    fixture.reopen();
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 3);
    fixture
        .app()
        .db(|db| {
            db.set_settings(&json!({"searchDailyUsage":{"day":"2000-01-01","tokens":3999}}))?;
            Ok(())
        })
        .await
        .unwrap();
    for _ in 0..5 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(model.count(), 4);
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":false})), A)
            .await
            .0,
        200
    );
    fixture.add(A, "paused", json!({})).await;
    smart_search::tick(fixture.app()).await.unwrap();
    assert_eq!(model.count(), 4);
    assert_eq!(
        fixture.request("settings", None, A).await.1["indexed"],
        3,
        "pausing keeps completed valid indexes"
    );
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":true})), A)
            .await
            .0,
        200
    );
    for _ in 0..5 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(model.count(), 5);
    let (status, found) = fixture
        .request(
            "",
            Some(json!({"query":"INV-1042","scope":"all","smart":true})),
            A,
        )
        .await;
    assert_eq!(status, 200, "{found}");
    assert!(
        found["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "old"),
        "all-history vectors remain searchable"
    );
    task.abort();
}

#[tokio::test]
async fn automatic_chunks_finish_across_daily_limits_without_replaying_completed_parts() {
    let mut fixture = Fixture::new().await;
    let model = Model::default();
    let (url, task) = server(model.clone()).await;
    let body = (0..7000)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect::<String>();
    fixture.add(A, "long", json!({"body":body})).await;
    fixture
        .add(A, "chunk-too-large", json!({"body":"🐈".repeat(2500)}))
        .await;
    fixture
        .setup(&url, json!({"autoIndex":true,"dailyTokenBudget":4000}))
        .await;
    smart_search::tick(fixture.app()).await.unwrap();
    let (_, partial) = fixture.request("settings", None, A).await;
    let completed = partial["job"]["part"].as_u64().unwrap();
    assert!(completed > 0 && partial["indexed"] == 0);
    assert_eq!(partial["skipped"]["dailyLimit"], 1);
    assert!(partial["automatic"]["spentToday"].as_u64().unwrap() <= 4000);
    let calls = model.count();
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":false})), A)
            .await
            .0,
        200
    );
    assert_eq!(
        fixture
            .request("settings", Some(json!({"autoIndex":true})), A)
            .await
            .0,
        200
    );
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["part"],
        completed,
        "pause/continue preserves the chunk checkpoint"
    );
    fixture.reopen();
    for _ in 0..3 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    assert_eq!(
        model.count(),
        calls,
        "a same-day restart must not resend completed chunks"
    );
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["part"],
        completed
    );
    assert_eq!(
        fixture
            .request(
                "settings",
                Some(json!({"autoIndex":true,"dailyTokenBudget":4001})),
                A
            )
            .await
            .0,
        200
    );
    assert_eq!(
        fixture.request("settings", None, A).await.1["job"]["part"],
        completed,
        "raising the daily allowance keeps a waiting chunk checkpoint"
    );
    for _ in 0..5 {
        smart_search::tick(fixture.app()).await.unwrap();
    }
    for _ in 0..3 {
        fixture
            .app()
            .db(|db| {
                db.set_settings(&json!({"searchDailyUsage":{"day":"2000-01-01","tokens":4000}}))?;
                Ok(())
            })
            .await
            .unwrap();
        for _ in 0..5 {
            smart_search::tick(fixture.app()).await.unwrap();
        }
        let (_, status) = fixture.request("settings", None, A).await;
        assert!(status["automatic"]["spentToday"].as_u64().unwrap() <= 4001);
        if status["indexed"] == 1 {
            break;
        }
    }
    let (_, final_state) = fixture.request("settings", None, A).await;
    assert_eq!(final_state["indexed"], 1);
    assert_eq!(final_state["skipped"]["dailyLimit"], 1);
    assert_eq!(final_state["automatic"]["waitingForBudget"], false);
    {
        let seen = model.seen.lock().unwrap();
        let text = seen
            .iter()
            .flat_map(|request| request["body"]["input"].as_array().unwrap())
            .map(|part| part.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(
            text.len() > completed as usize,
            "later days finish the remaining chunks"
        );
        assert_eq!(
            text.len(),
            text.iter().collect::<std::collections::HashSet<_>>().len(),
            "completed overlapping chunks are never sent twice"
        );
    }
    for paused in [false, true] {
        fixture
            .app()
            .db(|db| {
                db.set_settings(&json!({"searchDailyUsage":{"day":"2000-01-01","tokens":0}}))?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            fixture
                .request(
                    "settings",
                    Some(json!({"autoIndex":true,"dailyTokenBudget":8000})),
                    A
                )
                .await
                .0,
            200
        );
        smart_search::tick(fixture.app()).await.unwrap();
        assert_eq!(
            fixture.request("settings", None, A).await.1["job"]["status"],
            "running"
        );
        if paused {
            assert_eq!(
                fixture
                    .request("settings", Some(json!({"autoIndex":false})), A)
                    .await
                    .0,
                200
            );
        }
        let calls = model.count();
        assert_eq!(
            fixture
                .request("settings", Some(json!({"dailyTokenBudget":4000})), A)
                .await
                .0,
            200
        );
        let (_, reduced) = fixture.request("settings", None, A).await;
        assert!(
            reduced["job"].is_null(),
            "a lower limit requeues automatic work even while running or paused"
        );
        assert_eq!(
            reduced["indexed"], 1,
            "completed mail vectors survive a lower limit"
        );
        assert_eq!(
            reduced["automatic"]["approved"], false,
            "requeued work needs explicit approval before possible paid replay"
        );
        if paused {
            assert_eq!(
                fixture
                    .request("settings", Some(json!({"autoIndex":true})), A)
                    .await
                    .0,
                200
            );
        }
        for _ in 0..3 {
            smart_search::tick(fixture.app()).await.unwrap();
        }
        assert_eq!(
            model.count(),
            calls,
            "a chunk above the new daily limit must not block the queue or call the model"
        );
        assert_eq!(
            fixture.request("settings", None, A).await.1["automatic"]["waitingForBudget"],
            false
        );
    }
    task.abort();
}
