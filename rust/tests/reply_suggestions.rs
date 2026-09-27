use axum::{Json, Router, extract::State, routing::post};
use morrow_search::{
    ai, learning, policy, reply_suggestions as suggestions,
    service::{App, Context},
    store::{Store, merge},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore};

const OWNER: &str = "owner@example.test";
const OTHER: &str = "other@example.test";
const REPLY: &str = r#"{"needsReply":true,"reason":"The sender asks for clarification.","reply":"Thank you. Could you clarify the proposed date?"}"#;
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        Self(
            std::env::temp_dir().join(format!("morrow-reply-suggestions-{}", uuid::Uuid::new_v4())),
        )
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone)]
struct Model {
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Value>>>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    hold: bool,
    text: String,
}
impl Model {
    fn new(hold: bool, text: &str) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            hold,
            text: text.into(),
        }
    }
}
struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(model: Model) -> Server {
    async fn respond(State(model): State<Model>, Json(input): Json<Value>) -> Json<Value> {
        model.calls.fetch_add(1, Ordering::SeqCst);
        model.requests.lock().await.push(input);
        model.entered.add_permits(1);
        if model.hold {
            model.release.acquire().await.unwrap().forget();
        }
        Json(json!({"choices":[{"message":{"content":model.text}}]}))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(respond))
                .with_state(model),
        )
        .await
        .unwrap();
    });
    Server { url, task }
}
fn message(id: &str) -> Value {
    json!({"id":id,"folder":"inbox","fromName":"Sender","fromEmail":"sender@example.test","to":OWNER,"cc":"cc@example.test","bcc":"PRIVATE BCC","subject":"PRIVATE SUBJECT","body":format!("Please review {id}"),"date":"2026-01-01T12:00:00Z","read":false,"starred":false})
}
fn seed(db: &Store, url: &str) {
    db.set_settings(&json!({"activeAccount":"all","mailAccounts":{OWNER:{"email":OWNER,"connectionId":"one"},OTHER:{"email":OTHER,"connectionId":"two"}},"preferences":{"syncInterval":0},"ai":{"baseUrl":url,"model":"fixture","apiKey":"PRIVATE API KEY","maxTokens":800},"policy":policy::update(&json!({}),&json!({"maxMessages":50,"folders":{"sent":true},"content":{"subject":false,"contacts":false}})).unwrap(),"workspaces":{OWNER:{"brain":{"voice":"Keep manual voice","notes":"Keep private notes"}}}})).unwrap();
    for owner in [OWNER, OTHER] {
        learning::update_settings(db, owner, &json!({"identity":{"displayName":if owner==OWNER{"Confirmed Alice"}else{"Confirmed Bob"},"aliases":["Reviewed alias"],"confirmed":true}})).unwrap();
    }
    db.upsert(OWNER, &message("target")).unwrap();
    db.upsert(
        OWNER,
        &merge(message("second"), &json!({"date":"2026-02-01T12:00:00Z"})),
    )
    .unwrap();
    db.upsert(
        OTHER,
        &merge(message("target"), &json!({"body":"OTHER OWNER PRIVATE"})),
    )
    .unwrap();
}
async fn app_at(directory: &Temporary, url: &str) -> App {
    let app = App::open(&directory.0, 3001, "fixture-bearer".into(), "".into()).unwrap();
    let url = url.to_owned();
    app.db(move |db| {
        seed(db, &url);
        Ok(())
    })
    .await
    .unwrap();
    app
}
fn enable(db: &Store) {
    suggestions::update_settings(
        db,
        OWNER,
        &json!({"enabled":true,"maxMessages":5,"tokenBudget":64000}),
    )
    .unwrap();
}
fn queue(db: &Store, ids: &[&str]) -> Value {
    let state = suggestions::preview(db, OWNER, &json!({"messageIds":ids})).unwrap();
    suggestions::run(db, OWNER, state["job"]["id"].as_str().unwrap()).unwrap();
    state["job"].clone()
}
fn approve_style(db: &Store) {
    db.upsert(OWNER,&merge(message("style-source"),&json!({"folder":"sent","fromEmail":OWNER,"date":(chrono::Utc::now()-chrono::Duration::hours(1)).to_rfc3339(),"body":"Hello, please review the proposed schedule and share your thoughts at your convenience. Thank you for your help."}))).unwrap();
    learning::update_settings(db, OWNER, &json!({"enabled":true})).unwrap();
    let prepared = learning::prepare(db, OWNER, false).unwrap();
    let mut value = db.settings().unwrap()["styleLearning"].clone();
    value[OWNER]["preview"]["status"] = "ready".into();
    db.set_settings(&json!({"styleLearning":value})).unwrap();
    learning::apply(
        db,
        OWNER,
        &json!({"previewId":prepared["id"],"voice":"Approved concise paragraphs."}),
    )
    .unwrap();
}
async fn call(app: &App, action: &str, owner: &str, body: Value) -> (u16, Value) {
    let mut headers = axum::http::HeaderMap::new();
    if !owner.is_empty() {
        headers.insert("x-genmail-account", owner.parse().unwrap());
    }
    let mut path = vec!["reply-suggestions".into()];
    if !action.is_empty() {
        path.push(action.into());
    }
    let ctx = Context {
        method: if action.is_empty() {
            axum::http::Method::GET
        } else {
            axum::http::Method::POST
        },
        path,
        body,
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    };
    match suggestions::handle(app, &ctx).await {
        Ok(Some(response)) => {
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }
        Err(e) => (e.status, json!({"error":e.to_string()})),
        _ => panic!("missing handler"),
    }
}
async fn state(app: &App) -> Value {
    app.db(|db| suggestions::state(db, OWNER)).await.unwrap()
}

#[tokio::test]
async fn owned_review_queues_without_model_then_runs_serial_bounded_context_and_returns_owned_draft()
 {
    let model = Model::new(false, REPLY);
    let server = serve(model.clone()).await;
    let directory = Temporary::new();
    let app = app_at(&directory, &server.url).await;
    for owner in ["", "all", "demo", "absent@example.test"] {
        assert_eq!(call(&app, "", owner, Value::Null).await.0, 409);
    }
    assert_eq!(
        call(&app, "preview", OWNER, json!({"messageIds":["target"]}))
            .await
            .0,
        403
    );
    app.db(|db| {enable(db); for i in 0..13 {db.upsert(OWNER,&merge(message(&format!("history-{i}")),&json!({"fromEmail":" SENDER@example.test ","date":format!("2026-03-{:02}T00:00:00Z",i+1)})))?;} db.upsert(OWNER,&merge(message("trash"),&json!({"folder":"trash","body":"TRASH PRIVATE"})))?; Ok(())}).await.unwrap();
    let (status, preview) = call(
        &app,
        "preview",
        OWNER,
        json!({"messageIds":["target","second"]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        preview["job"]["samples"][0]["history"]["matchedMessages"],
        15
    );
    assert_eq!(preview["job"]["samples"][0]["history"]["usedMessages"], 10);
    for secret in [
        "OTHER OWNER PRIVATE",
        "TRASH PRIVATE",
        "PRIVATE SUBJECT",
        "PRIVATE BCC",
        "PRIVATE API KEY",
        "sourceHash",
        "\"sources\"",
    ] {
        assert!(!preview.to_string().contains(secret));
    }
    assert_eq!(
        call(
            &app,
            "run",
            OWNER,
            json!({"previewId":preview["job"]["id"]})
        )
        .await
        .0,
        202
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        call(
            &app,
            "run",
            OWNER,
            json!({"previewId":preview["job"]["id"]})
        )
        .await
        .0,
        409
    );
    suggestions::tick(&app).await.unwrap();
    assert_eq!(state(&app).await["job"]["status"], "queued");
    suggestions::tick(&app).await.unwrap();
    suggestions::tick(&app).await.unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    let current = state(&app).await;
    assert_eq!(current["job"]["status"], "complete");
    let requests = model.requests.lock().await;
    let content: Value =
        serde_json::from_str(requests[0]["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["emails"].as_array().unwrap().len(), 10);
    assert_eq!(content["emails"][0]["body"], "Please review target");
    assert!(
        content["request"]
            .as_str()
            .unwrap()
            .contains("Confirmed Alice")
    );
    assert!(!content.to_string().contains("Confirmed Bob"));
    drop(requests);
    let id = &current["proposals"][0]["id"];
    assert_eq!(call(&app, "use", OTHER, json!({"id":id})).await.0, 404);
    let (status, used) = call(&app, "use", OWNER, json!({"id":id})).await;
    assert_eq!(status, 200);
    assert_eq!(used["message"]["accountId"], OWNER);
    assert_eq!(used["message"]["id"], "target");
    assert!(used["message"].get("bcc").is_none());
    assert_eq!(call(&app, "dismiss", OWNER, json!({"id":id})).await.0, 200);
    assert_eq!(state(&app).await["proposals"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn approved_style_permissions_source_recheck_and_brain_preservation() {
    let model = Model::new(false, REPLY);
    let server = serve(model.clone()).await;
    let directory = Temporary::new();
    let app = app_at(&directory, &server.url).await;
    let brain = app
        .db(|db| {
            enable(db);
            approve_style(db);
            queue(db, &["target"]);
            Ok(db.settings()?["workspaces"].clone())
        })
        .await
        .unwrap();
    suggestions::tick(&app).await.unwrap();
    let requests = model.requests.lock().await;
    let content: Value =
        serde_json::from_str(requests[0]["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        content["approvedWritingStyle"],
        "Approved concise paragraphs."
    );
    drop(requests);
    app.db(|db| {
        let m = merge(
            db.get(OWNER, "style-source")?.unwrap(),
            &json!({"body":"Changed sent sample"}),
        );
        db.upsert(OWNER, &m)?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        state(&app).await["proposals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for patch in [
        json!({"behaviors":{"memory":false}}),
        json!({"folders":{"sent":false}}),
    ] {
        app.db(move |db| {
            let p = policy::update(
                &db.settings()?["policy"],
                &json!({"behaviors":{"memory":true},"folders":{"sent":true}}),
            )?;
            db.set_settings(&json!({"policy":p}))?;
            approve_style(db);
            let p = policy::update(&db.settings()?["policy"], &patch)?;
            db.set_settings(&json!({"policy":p}))?;
            queue(db, &["target"]);
            Ok(())
        })
        .await
        .unwrap();
        suggestions::tick(&app).await.unwrap();
        let requests = model.requests.lock().await;
        let content: Value = serde_json::from_str(
            requests.last().unwrap()["messages"][1]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert!(content.get("approvedWritingStyle").is_none());
    }
    let after = app
        .db(|db| Ok(db.settings()?["workspaces"].clone()))
        .await
        .unwrap();
    assert_eq!(after, brain);
    app.db(|db| {
        let p = policy::update(
            &db.settings()?["policy"],
            &json!({"content":{"body":false}}),
        )?;
        db.set_settings(&json!({"policy":p}))?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        call(&app, "preview", OWNER, json!({"messageIds":["target"]}))
            .await
            .0,
        403
    );
}

#[tokio::test]
async fn source_identity_generation_model_connection_and_style_changes_reject_inflight_results() {
    for kind in 0..6 {
        let model = Model::new(true, REPLY);
        let server = serve(model.clone()).await;
        let directory = Temporary::new();
        let app = app_at(&directory, &server.url).await;
        app.db(|db| {
            enable(db);
            approve_style(db);
            queue(db, &["target"]);
            Ok(())
        })
        .await
        .unwrap();
        let cloned = app.clone();
        let task = tokio::spawn(async move { suggestions::tick(&cloned).await.unwrap() });
        tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        app.db(move |db| {
            match kind {
                0 | 5 => {
                    let id = if kind == 0 { "second" } else { "style-source" };
                    db.upsert(
                        OWNER,
                        &merge(
                            db.get(OWNER, id)?.unwrap(),
                            &json!({"body":"Changed context"}),
                        ),
                    )?;
                }
                1 => learning::update_settings(
                    db,
                    OWNER,
                    &json!({"identity":{"displayName":"Changed","aliases":[],"confirmed":true}}),
                )?,
                2 => {
                    ai::invalidate(db)?;
                    ai::invalidate(db)?;
                }
                3 => {
                    let value = merge(db.settings()?["ai"].clone(), &json!({"model":"changed"}));
                    db.set_settings(&json!({"ai":value}))?;
                }
                _ => {
                    let mut accounts = db.settings()?["mailAccounts"].clone();
                    accounts[OWNER]["connectionId"] = "replacement".into();
                    db.set_settings(&json!({"mailAccounts":accounts}))?;
                }
            }
            Ok(())
        })
        .await
        .unwrap();
        model.release.add_permits(1);
        task.await.unwrap();
        suggestions::tick(&app).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        assert!(
            state(&app).await["proposals"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app.db(|db| Ok(db.settings()?["replySuggestions"][OWNER]["job"]["status"].clone()))
                .await
                .unwrap(),
            "failed"
        );
    }
}

#[tokio::test]
async fn cancellation_and_shutdown_stop_network_results_without_replay() {
    for shutdown in [false, true] {
        let model = Model::new(true, REPLY);
        let server = serve(model.clone()).await;
        let directory = Temporary::new();
        let app = app_at(&directory, &server.url).await;
        app.db(|db| {
            enable(db);
            queue(db, &["target", "second"]);
            Ok(())
        })
        .await
        .unwrap();
        let cloned = app.clone();
        let task = tokio::spawn(async move { suggestions::tick(&cloned).await.unwrap() });
        tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        suggestions::tick(&app).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        if shutdown {
            suggestions::stop(&app);
        } else {
            assert_eq!(call(&app, "cancel", OWNER, json!({})).await.0, 200);
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        model.release.add_permits(1);
        suggestions::tick(&app).await.unwrap();
        assert!(
            state(&app).await["proposals"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn malformed_output_budgets_and_restart_keep_charges_but_never_retry() {
    let model = Model::new(false, "PRIVATE MODEL ERROR");
    let server = serve(model.clone()).await;
    let directory = Temporary::new();
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        enable(db);
        db.upsert(
            OWNER,
            &merge(message("target"), &json!({"body":"漢".repeat(5000)})),
        )?;
        suggestions::update_settings(db, OWNER, &json!({"tokenBudget":4000}))?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        call(&app, "preview", OWNER, json!({"messageIds":["target"]}))
            .await
            .0,
        409
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    app.db(|db| {
        enable(db);
        queue(db, &["target"]);
        Ok(())
    })
    .await
    .unwrap();
    suggestions::tick(&app).await.unwrap();
    suggestions::tick(&app).await.unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let current = state(&app).await;
    assert_eq!(current["job"]["status"], "failed");
    assert!(current["job"]["spentTokens"].as_u64().unwrap() > 0);
    assert!(!current.to_string().contains("PRIVATE MODEL ERROR"));
    app.db(|db| {
        queue(db, &["second"]);
        Ok(())
    })
    .await
    .unwrap();
    drop(app);
    let app = App::open(&directory.0, 3001, "fixture-bearer".into(), "".into()).unwrap();
    assert_eq!(state(&app).await["job"]["status"], "interrupted");
    suggestions::tick(&app).await.unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ready_proposals_survive_restart_but_stale_preview_excerpts_and_drafts_are_revoked() {
    let model = Model::new(false, REPLY);
    let server = serve(model.clone()).await;
    let directory = Temporary::new();
    let app = app_at(&directory, &server.url).await;
    app.db(|db| {
        enable(db);
        queue(db, &["target"]);
        Ok(())
    })
    .await
    .unwrap();
    suggestions::tick(&app).await.unwrap();
    let first = state(&app).await["proposals"][0].clone();
    drop(app);
    let app = App::open(&directory.0, 3001, "fixture-bearer".into(), "".into()).unwrap();
    assert_eq!(state(&app).await["proposals"][0]["id"], first["id"]);
    let preview = call(&app, "preview", OWNER, json!({"messageIds":["target"]}))
        .await
        .1;
    app.db(|db| {
        db.upsert(OWNER, &merge(message("second"), &json!({"folder":"trash"})))?;
        Ok(())
    })
    .await
    .unwrap();
    let current = state(&app).await;
    assert_eq!(current["job"]["reviewValid"], false);
    assert!(current["job"]["samples"].as_array().unwrap().is_empty());
    assert!(current["proposals"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &app,
            "run",
            OWNER,
            json!({"previewId":preview["job"]["id"]})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(&app, "use", OWNER, json!({"id":first["id"]})).await.0,
        409
    );
}
