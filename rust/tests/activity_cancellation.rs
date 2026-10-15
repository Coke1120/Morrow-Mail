//! Synthetic cancellation contracts for the three persisted AI activity kinds.
//! Model and service requests stay on ephemeral loopback listeners. Channels, not
//! sleeps, select the claim/publication and response/terminal-write orderings.
use axum::{Json, Router, extract::State, routing::post};
use morrow_search::{
    brain, learning, policy, reply_suggestions as replies,
    service::App,
    store::{Store, merge, now, string},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const A: &str = "a@activity.example.invalid";
const B: &str = "b@activity.example.invalid";
const TOKEN: &str = "synthetic-activity-bearer";
const WAIT: Duration = Duration::from_secs(20);
const OLD: &str = "2000-01-01T00:00:00.000Z";
const VOICE: &str = "Use clear short paragraphs and a reviewed greeting.";
const MEMORY: &str =
    r#"{"items":[{"text":"Review the fictional timetable.","messageIds":["inbox"]}]}"#;
const REPLY: &str = r#"{"needsReply":true,"reason":"A fictional date needs review.","reply":"Could you clarify the proposed date?"}"#;

#[derive(Clone, Copy, Debug)]
enum Kind {
    Style,
    Brain,
    Replies,
}
const KINDS: [Kind; 3] = [Kind::Style, Kind::Brain, Kind::Replies];
impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Style => "styleLearning",
            Self::Brain => "brainLearning",
            Self::Replies => "replySuggestions",
        }
    }
    fn activity(self, owner: &str) -> String {
        let kind = match self {
            Self::Style => "learning",
            Self::Brain => "brain",
            Self::Replies => "replies",
        };
        format!("{kind}:{owner}")
    }
    fn row<'a>(self, settings: &'a Value, owner: &str) -> &'a Value {
        let value = &settings[self.key()][owner];
        match self {
            Self::Style => &value["preview"],
            Self::Brain => value,
            Self::Replies => &value["job"],
        }
    }
    fn row_mut<'a>(self, settings: &'a mut Value, owner: &str) -> &'a mut Value {
        let value = &mut settings[self.key()][owner];
        match self {
            Self::Style => &mut value["preview"],
            Self::Brain => value,
            Self::Replies => &mut value["job"],
        }
    }
    fn response(self) -> &'static str {
        match self {
            Self::Style => VOICE,
            Self::Brain => MEMORY,
            Self::Replies => REPLY,
        }
    }
    fn expire(self, db: &Store) -> morrow_search::error::Result<()> {
        match self {
            Self::Style => learning::expire_running(db),
            Self::Brain => brain::expire_running(db),
            Self::Replies => replies::expire_running(db),
        }
    }
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct ModelRequest {
    payload: Value,
    respond: oneshot::Sender<String>,
}
#[derive(Clone)]
struct Model {
    calls: Arc<AtomicUsize>,
    requests: mpsc::Sender<ModelRequest>,
}
async fn model(State(model): State<Model>, Json(payload): Json<Value>) -> Json<Value> {
    let (respond, response) = oneshot::channel();
    model.calls.fetch_add(1, Ordering::SeqCst);
    model
        .requests
        .send(ModelRequest { payload, respond })
        .await
        .unwrap();
    let text = response.await.unwrap_or_default();
    Json(json!({"choices":[{"message":{"content":text}}]}))
}

struct Fixture {
    directory: Temporary,
    app: App,
    api: String,
    client: reqwest::Client,
    api_task: tokio::task::JoinHandle<()>,
    model_task: tokio::task::JoinHandle<()>,
    api_stop: oneshot::Sender<()>,
    model_stop: oneshot::Sender<()>,
    requests: mpsc::Receiver<ModelRequest>,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = Temporary(std::env::temp_dir().join(format!(
            "morrow-activity-cancellation-{}",
            uuid::Uuid::new_v4()
        )));
        let model_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model_url = format!("http://{}/v1", model_listener.local_addr().unwrap());
        let (requests, receiver) = mpsc::channel(8);
        let calls = Arc::new(AtomicUsize::new(0));
        let state = Model {
            calls: calls.clone(),
            requests,
        };
        let (model_stop, stopped_model) = oneshot::channel();
        let model_task = tokio::spawn(async move {
            axum::serve(
                model_listener,
                Router::new()
                    .route("/v1/chat/completions", post(model))
                    .with_state(state),
            )
            .with_graceful_shutdown(async {
                let _ = stopped_model.await;
            })
            .await
            .unwrap();
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = App::open(&directory.0, address.port(), TOKEN.into(), "".into()).unwrap();
        app.db(move |db| {
            db.set_settings(&json!({
                "activeAccount":"all",
                "mailAccounts":{A:{"email":A,"connectionId":"a","provider":"imap"},B:{"email":B,"connectionId":"b","provider":"imap"}},
                "preferences":{"syncInterval":0},
                "ai":{"baseUrl":model_url,"model":"loopback-fixture","apiKey":"fictional-only","maxTokens":800},
                "policy":policy::update(&json!({}),&json!({"folders":{"sent":true},"maxMessages":20}))?,
                "brainLearning":{A:{"enabled":false,"tokenBudget":16000,"status":"waiting"},B:{"enabled":false,"tokenBudget":16000,"status":"waiting"}},
                "workspaces":{A:{"brain":{"notes":"Keep A manual notes"}},B:{"brain":{"notes":"Keep B manual notes"}}}
            }))?;
            for owner in [A, B] {
                let marker = if owner == A { "OWNER_A_EVIDENCE" } else { "OWNER_B_EVIDENCE" };
                let message = json!({"id":"inbox","folder":"inbox","fromEmail":"sender@example.invalid","to":owner,"subject":"Fictional timetable","body":format!("{marker}: Please review the proposed timetable and clarify the date."),"date":(chrono::Utc::now()-chrono::Duration::hours(1)).to_rfc3339(),"read":false});
                db.upsert(owner, &message)?;
                db.upsert(owner, &merge(message.clone(), &json!({"id":"sent","folder":"sent","fromEmail":owner,"to":"recipient@example.invalid","body":format!("{marker}: Hello, I would appreciate your thoughts on the proposed timetable. Thank you for reviewing the details and sharing your comments.")})))?;
                db.upsert(owner, &merge(message, &json!({"id":"retained-draft","folder":"drafts","body":format!("User draft for {owner}; retain exactly.")})))?;
                learning::update_settings(db, owner, &json!({"enabled":true,"tokenBudget":16000,"identity":{"displayName":"Fixture Owner","confirmed":true,"aliases":[]}}))?;
                replies::update_settings(db, owner, &json!({"enabled":true,"maxMessages":5,"tokenBudget":64000}))?;
            }
            Ok(())
        }).await.unwrap();
        let router = app.router();
        let (api_stop, stopped_api) = oneshot::channel();
        let api_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped_api.await;
                })
                .await
                .unwrap();
        });
        Self {
            directory,
            app,
            api: format!("http://{address}/api"),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(WAIT)
                .build()
                .unwrap(),
            api_task,
            model_task,
            api_stop,
            model_stop,
            requests: receiver,
            calls,
        }
    }
    async fn next(&mut self) -> ModelRequest {
        self.next_for(A).await
    }
    async fn next_for(&mut self, owner: &str) -> ModelRequest {
        let request = tokio::time::timeout(WAIT, self.requests.recv())
            .await
            .expect("model dispatch must reach the loopback fixture")
            .unwrap();
        let (included, excluded) = if owner == A {
            ("OWNER_A_EVIDENCE", "OWNER_B_EVIDENCE")
        } else {
            ("OWNER_B_EVIDENCE", "OWNER_A_EVIDENCE")
        };
        assert!(request.payload.to_string().contains(included));
        assert!(!request.payload.to_string().contains(excluded));
        request
    }
    async fn post(&self, path: &str, owner: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}/{path}", self.api))
            .bearer_auth(TOKEN)
            .header("x-genmail-account", owner)
            .json(&body)
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }
    async fn cancel(&self, kind: Kind, owner: &str) -> (u16, Value) {
        // The combined page is not an owner: the captured activity id selects it.
        self.post("activity/cancel", "all", json!({"id":kind.activity(owner)}))
            .await
    }
    async fn close(self) {
        let Self {
            directory,
            app,
            api_task,
            model_task,
            api_stop,
            model_stop,
            client,
            ..
        } = self;
        drop(client);
        api_stop.send(()).unwrap();
        tokio::time::timeout(WAIT, api_task).await.unwrap().unwrap();
        drop(app);
        model_stop.send(()).unwrap();
        tokio::time::timeout(WAIT, model_task)
            .await
            .unwrap()
            .unwrap();
        // Close the writer and join service tasks before deleting SQLite on Windows.
        std::fs::remove_dir_all(&directory.0).unwrap();
    }
}

async fn prepare(app: &App, kind: Kind) -> String {
    app.db(move |db| match kind {
        Kind::Style => Ok(string(&learning::prepare(db, A, false)?, "id").to_owned()),
        Kind::Brain => {
            let mut settings = db.settings()?;
            settings["brainLearning"][A]["enabled"] = true.into();
            db.set_settings(&json!({"brainLearning":settings["brainLearning"]}))?;
            Ok(String::new())
        }
        Kind::Replies => {
            let preview = replies::preview(db, A, &json!({"messageIds":["inbox"]}))?;
            let id = string(&preview["job"], "id").to_owned();
            replies::run(db, A, &id)?;
            Ok(id)
        }
    })
    .await
    .unwrap()
}
type Work = Pin<Box<dyn Future<Output = morrow_search::error::Result<()>> + Send>>;
fn work(app: App, kind: Kind, id: String) -> Work {
    Box::pin(async move {
        match kind {
            Kind::Style => learning::generate(&app, A, &id).await,
            Kind::Brain => brain::scheduled_tick(&app).await,
            Kind::Replies => replies::tick(&app).await,
        }
    })
}
async fn join(
    work: tokio::task::JoinHandle<morrow_search::error::Result<()>>,
) -> morrow_search::error::Result<()> {
    tokio::time::timeout(WAIT, work)
        .await
        .expect("worker must finish without waiting for the held model response")
        .unwrap()
}
fn no_result(settings: &Value, kind: Kind) {
    match kind {
        Kind::Style => assert!(kind.row(settings, A)["voice"].is_null()),
        Kind::Brain => assert!(kind.row(settings, A)["preview"].is_null()),
        Kind::Replies => assert!(
            settings["replySuggestions"][A]["proposals"]
                .as_array()
                .is_none_or(Vec::is_empty)
        ),
    }
}
async fn preserved(app: &App) {
    app.db(|db| {
        let settings = db.settings()?;
        assert!(
            settings["deliveryAttempts"]
                .as_array()
                .is_none_or(Vec::is_empty)
        );
        for owner in [A, B] {
            assert_eq!(
                db.get(owner, "retained-draft")?.unwrap()["body"],
                format!("User draft for {owner}; retain exactly.")
            );
            assert_eq!(
                db.list(owner)?
                    .iter()
                    .filter(|message| message["folder"] == "drafts")
                    .count(),
                1
            );
            assert!(settings["workspaces"][owner]["brain"]["facts"].is_null());
            assert_eq!(
                settings["workspaces"][owner]["brain"]["notes"],
                if owner == A {
                    "Keep A manual notes"
                } else {
                    "Keep B manual notes"
                }
            );
            assert!(settings["styleLearning"][owner]["profile"].is_null());
        }
        Ok(())
    })
    .await
    .unwrap();
}
async fn subsequent_request(fixture: &mut Fixture, kind: Kind) {
    if matches!(kind, Kind::Brain) {
        // This is the real manual retry offered after a cancelled weekly analysis.
        // Do not manufacture a second weekly claim by rewinding lastAt/fingerprint.
        let client = fixture.client.clone();
        let url = format!("{}/workspace/brain/preview", fixture.api);
        let next = tokio::spawn(async move {
            client
                .post(url)
                .bearer_auth(TOKEN)
                .header("x-genmail-account", A)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
        });
        fixture.next().await.respond.send(MEMORY.into()).unwrap();
        let response = tokio::time::timeout(WAIT, next).await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        let result: Value = response.json().await.unwrap();
        assert_eq!(result["preview"]["items"].as_array().unwrap().len(), 1);
    } else {
        let id = prepare(&fixture.app, kind).await;
        let next = tokio::spawn(work(fixture.app.clone(), kind, id));
        fixture
            .next()
            .await
            .respond
            .send(kind.response().into())
            .unwrap();
        join(next).await.unwrap();
        let settings = fixture.app.settings().await.unwrap();
        assert_eq!(
            kind.row(&settings, A)["status"],
            if matches!(kind, Kind::Style) {
                "ready"
            } else {
                "complete"
            }
        );
    }
    preserved(&fixture.app).await;
}

// Holds only the actual Store mutex, not App::db's permit. A first poll of work
// can therefore submit its non-cancellable spawn_blocking claim behind this lock.
async fn held_store(app: &App) -> (std::sync::mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
    let (entered, acquired) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let app = app.clone();
    let holder = tokio::task::spawn_blocking(move || {
        app.blocking(|_| {
            entered.send(()).unwrap();
            wait.recv_timeout(WAIT)
                .expect("release the synthetic Store barrier");
            Ok(())
        })
        .unwrap();
    });
    tokio::time::timeout(WAIT, acquired).await.unwrap().unwrap();
    (release, holder)
}
fn poll_once<F: Future + ?Sized>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

#[tokio::test]
async fn runtime_stop_registration_retains_owner_kind_wildcard_and_lifetime_boundaries() {
    let runtime = morrow_search::background::Runtime::default();
    let dropped = runtime.stop_requested(A, "learning");
    let mut a_style = Box::pin(runtime.stop_requested(A, "learning"));
    let mut b_style = Box::pin(runtime.stop_requested(B, "learning"));
    let mut a_brain = Box::pin(runtime.stop_requested(A, "brain"));
    drop(dropped);
    runtime.request_stop(A, "learning");
    assert!(poll_once(a_style.as_mut()).is_ready());
    assert!(poll_once(b_style.as_mut()).is_pending());
    assert!(poll_once(a_brain.as_mut()).is_pending());
    runtime.request_stop(B, "brain");
    assert!(poll_once(b_style.as_mut()).is_pending());
    assert!(poll_once(a_brain.as_mut()).is_pending());

    let mut late = Box::pin(runtime.stop_requested(A, "learning"));
    assert!(
        poll_once(late.as_mut()).is_pending(),
        "new work cannot consume an older cancellation"
    );
    runtime.request_stop("*", "learning");
    assert!(poll_once(late.as_mut()).is_ready());
    assert!(poll_once(b_style.as_mut()).is_ready());
    assert!(poll_once(a_brain.as_mut()).is_pending());
    runtime.request_stop(A, "*");
    assert!(poll_once(a_brain.as_mut()).is_ready());

    let mut any_owner = Box::pin(runtime.stop_requested("", "brain"));
    runtime.request_stop(B, "brain");
    assert!(poll_once(any_owner.as_mut()).is_ready());
    let mut any_kind = Box::pin(runtime.stop_requested(A, ""));
    runtime.request_stop(A, "summary");
    assert!(poll_once(any_kind.as_mut()).is_ready());
}

#[tokio::test]
async fn dropped_style_brain_reply_claims_settle_even_when_the_db_claim_publishes_later() {
    for kind in KINDS {
        let mut fixture = Fixture::new().await;
        let id = prepare(&fixture.app, kind).await;
        let before = fixture.app.settings().await.unwrap();
        let (release, holder) = held_store(&fixture.app).await;
        let mut pending = work(fixture.app.clone(), kind, id);
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        drop(pending); // No published id yet; the later claim must observe abandonment.
        release.send(()).unwrap();
        holder.await.unwrap();
        let settings = fixture.app.settings().await.unwrap();
        assert_eq!(kind.row(&settings, A)["status"], "cancelled", "{kind:?}");
        assert_eq!(settings[kind.key()][B], before[kind.key()][B]);
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
        no_result(&settings, kind);
        subsequent_request(&mut fixture, kind).await;
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn dropped_style_brain_reply_workers_release_owned_activity_without_late_results() {
    for kind in KINDS {
        let mut fixture = Fixture::new().await;
        let id = prepare(&fixture.app, kind).await;
        let before = fixture.app.settings().await.unwrap();
        let pending = tokio::spawn(work(fixture.app.clone(), kind, id));
        let late = fixture.next().await;
        assert_eq!(
            kind.row(&fixture.app.settings().await.unwrap(), A)["status"],
            "running"
        );
        pending.abort();
        assert!(
            tokio::time::timeout(WAIT, pending)
                .await
                .unwrap()
                .unwrap_err()
                .is_cancelled()
        );
        let settings = fixture.app.settings().await.unwrap();
        assert_eq!(kind.row(&settings, A)["status"], "cancelled", "{kind:?}");
        assert_eq!(settings[kind.key()][B], before[kind.key()][B]);
        no_result(&settings, kind);
        let _ = late.respond.send(kind.response().into());
        subsequent_request(&mut fixture, kind).await;
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
        fixture.close().await;
    }
}

#[tokio::test]
async fn activity_cancel_route_targets_each_running_ai_kind_and_allows_reviewed_retry() {
    for kind in KINDS {
        let mut fixture = Fixture::new().await;
        let id = prepare(&fixture.app, kind).await;
        let before = fixture.app.settings().await.unwrap();
        let pending = tokio::spawn(work(fixture.app.clone(), kind, id));
        let late = fixture.next().await;
        assert_eq!(fixture.cancel(kind, B).await.0, 409);
        assert_eq!(fixture.cancel(kind, "all").await.0, 409);
        assert_eq!(
            kind.row(&fixture.app.settings().await.unwrap(), A)["status"],
            "running"
        );
        let cancelled = fixture.cancel(kind, A).await;
        assert_eq!(cancelled.0, 200, "{kind:?}: {}", cancelled.1);
        assert_eq!(cancelled.1["cancelled"], true);
        join(pending).await.unwrap(); // Completion occurs while the response is still held.
        let settings = fixture.app.settings().await.unwrap();
        assert_eq!(kind.row(&settings, A)["status"], "cancelled");
        assert_eq!(settings[kind.key()][B], before[kind.key()][B]);
        no_result(&settings, kind);
        let _ = late.respond.send(kind.response().into());
        subsequent_request(&mut fixture, kind).await;
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
        fixture.close().await;
    }
}

#[tokio::test]
async fn consecutive_owned_style_cancels_are_not_lost_when_workers_resume_after_both_requests() {
    let mut fixture = Fixture::new().await;
    let first_id = prepare(&fixture.app, Kind::Style).await;
    let second_id = fixture
        .app
        .db(|db| Ok(string(&learning::prepare(db, B, false)?, "id").to_owned()))
        .await
        .unwrap();
    let mut first = work(fixture.app.clone(), Kind::Style, first_id);
    let app = fixture.app.clone();
    let mut second = Box::pin(async move { learning::generate(&app, B, &second_id).await });

    // Manual style requests are independent production routes, not scheduled
    // Brain work behind the global background gate. Drive each to the model,
    // then retain (without polling) both request futures while handling cancels.
    // This is a deterministic version of a worker not being scheduled between
    // two route requests; no artificial second persisted running row is needed.
    let first_response = tokio::select! {
        request = fixture.next_for(A) => request,
        result = &mut first => panic!("first style worker ended before model dispatch: {result:?}"),
    };
    let second_response = tokio::select! {
        request = fixture.next_for(B) => request,
        result = &mut second => panic!("second style worker ended before model dispatch: {result:?}"),
    };
    assert_eq!(fixture.cancel(Kind::Style, A).await.0, 200);
    assert_eq!(fixture.cancel(Kind::Style, B).await.0, 200);
    let cancelled = fixture.app.settings().await.unwrap();
    for owner in [A, B] {
        assert_eq!(
            cancelled["styleLearning"][owner]["preview"]["status"],
            "cancelled"
        );
    }
    let completed =
        tokio::time::timeout(WAIT, async { tokio::join!(&mut first, &mut second) }).await;

    // Settle and close every local resource even if the assertion detects the
    // lost cancellation. Late successful model output must remain unpublishable.
    drop(first);
    drop(second);
    let _ = first_response.respond.send("Discard A late voice".into());
    let _ = second_response.respond.send("Discard B late voice".into());
    assert_eq!(
        fixture.app.settings().await.unwrap()["styleLearning"],
        cancelled["styleLearning"]
    );
    preserved(&fixture.app).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.close().await;
    let (first, second) = completed.expect("both owner-specific cancellations must remain observable after subsequent cancel requests; neither may wait for model output");
    first.unwrap();
    second.unwrap();
}

#[tokio::test]
async fn reply_cancel_survives_another_owners_settings_save_without_cross_owner_stops() {
    let mut fixture = Fixture::new().await;
    let id = prepare(&fixture.app, Kind::Replies).await;
    let mut pending = work(fixture.app.clone(), Kind::Replies, id);
    let late = tokio::select! {
        request = fixture.next() => request,
        result = &mut pending => panic!("reply worker ended before model dispatch: {result:?}"),
    };

    // A settings save for a different account is a real cancel-signal publisher,
    // even when that account has no active reply batch. It must not stop A.
    assert_eq!(
        fixture
            .post("reply-suggestions/settings", B, json!({"enabled":false}))
            .await
            .0,
        200
    );
    assert!(poll_once(pending.as_mut()).is_pending());
    assert_eq!(
        Kind::Replies.row(&fixture.app.settings().await.unwrap(), A)["status"],
        "running"
    );

    assert_eq!(fixture.cancel(Kind::Replies, A).await.0, 200);
    let cancelled = fixture.app.settings().await.unwrap()["replySuggestions"][A].clone();
    assert_eq!(cancelled["job"]["status"], "cancelled");
    assert_eq!(
        fixture
            .post("reply-suggestions/settings", B, json!({"enabled":true}))
            .await
            .0,
        200
    );
    let completed = tokio::time::timeout(WAIT, &mut pending).await;
    drop(pending);
    let _ = late.respond.send(REPLY.into());
    assert_eq!(
        fixture.app.settings().await.unwrap()["replySuggestions"][A],
        cancelled
    );
    preserved(&fixture.app).await;
    if completed.is_ok() {
        subsequent_request(&mut fixture, Kind::Replies).await;
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    }
    fixture.close().await;
    completed.expect("an unrelated settings signal must not erase A's earlier cancellation or retain the shared reply gate until model completion").unwrap();
}

#[tokio::test]
async fn delayed_reply_settings_completion_keeps_the_new_automatic_batch_running() {
    let mut fixture = Fixture::new().await;
    let previous = prepare(&fixture.app, Kind::Replies).await;
    let before = fixture.app.settings().await.unwrap();
    let app = fixture.app.clone();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-genmail-account", A.parse().unwrap());
    let context = morrow_search::service::Context {
        method: axum::http::Method::POST,
        path: vec!["reply-suggestions".into(), "settings".into()],
        body: json!({"enabled":true,"automatic":true,"maxMessages":1,"tokenBudget":64000,"dailyTokenBudget":100000}),
        query: json!({}),
        headers,
        owner: A.into(),
        paged: true,
    };
    // Exercise the production route handler directly so its executor continuation
    // can be held after the actual settings transaction. No approval is seeded.
    let mut save = Box::pin(replies::handle(&app, &context));
    let (release, holder) = held_store(&app).await;
    assert!(poll_once(save.as_mut()).is_pending());
    release.send(()).unwrap();
    tokio::time::timeout(WAIT, holder).await.unwrap().unwrap();
    // App::db's single permit is released by the blocking closure, not by polling
    // the handler again. This read therefore proves that settings committed.
    let committed = app.settings().await.unwrap();
    assert_eq!(
        committed["replySuggestions"][A]["settings"]["automatic"],
        true
    );
    assert!(!string(&committed["replySuggestions"][A], "automaticApproval").is_empty());
    assert!(committed["replySuggestions"][A]["job"].is_null());
    assert_eq!(
        committed["replySuggestions"][B],
        before["replySuggestions"][B]
    );
    assert_eq!(
        app.db(|db| replies::state(db, A)).await.unwrap()["automaticReady"],
        true
    );

    // The service's normal reply tick may run while the handler is unpolled.
    // Let schedule_automatic, preview/run and claim establish the new batch.
    let mut pending = work(app.clone(), Kind::Replies, String::new());
    let response = tokio::select! {
        request = fixture.next() => request,
        result = &mut pending => panic!("automatic reply ended before model dispatch: {result:?}"),
    };
    let claimed = app.settings().await.unwrap();
    let replacement = string(Kind::Replies.row(&claimed, A), "id").to_owned();
    assert_ne!(replacement, previous);
    assert_eq!(Kind::Replies.row(&claimed, A)["automatic"], true);
    assert_eq!(Kind::Replies.row(&claimed, A)["status"], "running");
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        tokio::time::timeout(WAIT, &mut save)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .status(),
        200
    );
    drop(save);

    let mut ended = match poll_once(pending.as_mut()) {
        Poll::Ready(result) => Some(result),
        Poll::Pending => None,
    };
    // Pending alone could be a cancellation waiting to commit its terminal row.
    let held = app.settings().await.unwrap();
    if ended.is_none()
        && let Poll::Ready(result) = poll_once(pending.as_mut())
    {
        ended = Some(result);
    }
    let stopped_before_response = ended.is_some();
    let _ = response.respond.send(REPLY.into());
    let outcome = match ended {
        Some(result) => result,
        None => tokio::time::timeout(WAIT, &mut pending).await.unwrap(),
    };
    drop(pending);
    let finished = app.settings().await.unwrap();
    assert_eq!(
        finished["replySuggestions"][B],
        before["replySuggestions"][B]
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    preserved(&app).await;
    drop(app);
    fixture.close().await;

    assert_eq!(Kind::Replies.row(&held, A)["id"], replacement);
    assert_eq!(
        Kind::Replies.row(&held, A)["status"],
        "running",
        "a delayed settings completion must not cancel the automatic batch created after its settings transaction"
    );
    assert!(!stopped_before_response);
    outcome.unwrap();
    assert_eq!(Kind::Replies.row(&finished, A)["id"], replacement);
    assert_eq!(Kind::Replies.row(&finished, A)["status"], "complete");
    assert_eq!(
        finished["replySuggestions"][A]["proposals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn delayed_activity_cancel_completion_keeps_the_new_style_preview_running() {
    let mut fixture = Fixture::new().await;
    let original = prepare(&fixture.app, Kind::Style).await;
    let before = fixture.app.settings().await.unwrap();
    let app = fixture.app.clone();
    let mut old = work(app.clone(), Kind::Style, original.clone());
    let old_response = tokio::select! {
        request = fixture.next() => request,
        result = &mut old => panic!("old style worker ended before model dispatch: {result:?}"),
    };
    let activity = Kind::Style.activity(A);
    // This is the production API operation, paused at its two App::db awaits.
    // A second authorized API request may prepare/generate a new preview after
    // the cancellation transaction; this is not a native-UI click-through claim.
    let mut cancel = Box::pin(morrow_search::activity::cancel(&app, &activity));
    let (release, holder) = held_store(&app).await;
    assert!(poll_once(cancel.as_mut()).is_pending());
    release.send(()).unwrap();
    tokio::time::timeout(WAIT, holder).await.unwrap().unwrap();
    let validated = app.settings().await.unwrap();
    assert_eq!(Kind::Style.row(&validated, A)["status"], "running");

    let (release, holder) = held_store(&app).await;
    assert!(poll_once(cancel.as_mut()).is_pending());
    release.send(()).unwrap();
    tokio::time::timeout(WAIT, holder).await.unwrap().unwrap();
    let committed = app.settings().await.unwrap();
    assert_eq!(Kind::Style.row(&committed, A)["id"], original);
    assert_eq!(Kind::Style.row(&committed, A)["status"], "cancelled");

    let replacement = prepare(&app, Kind::Style).await;
    assert_ne!(replacement, original);
    let mut pending = work(app.clone(), Kind::Style, replacement.clone());
    let response = tokio::select! {
        request = fixture.next() => request,
        result = &mut pending => panic!("new style worker ended before model dispatch: {result:?}"),
    };
    let claimed = app.settings().await.unwrap();
    assert_eq!(Kind::Style.row(&claimed, A)["id"], replacement);
    assert_eq!(Kind::Style.row(&claimed, A)["status"], "running");
    assert_eq!(
        tokio::time::timeout(WAIT, &mut cancel)
            .await
            .unwrap()
            .unwrap()["cancelled"],
        true
    );
    drop(cancel);
    tokio::time::timeout(WAIT, &mut old).await.unwrap().unwrap();
    drop(old);
    let _ = old_response.respond.send("Discard this old voice".into());
    assert_eq!(
        app.settings().await.unwrap()["styleLearning"],
        claimed["styleLearning"],
        "settling the cancelled old worker must not mutate the replacement or B"
    );

    let mut ended = match poll_once(pending.as_mut()) {
        Poll::Ready(result) => Some(result),
        Poll::Pending => None,
    };
    let held = app.settings().await.unwrap();
    if ended.is_none()
        && let Poll::Ready(result) = poll_once(pending.as_mut())
    {
        ended = Some(result);
    }
    let stopped_before_response = ended.is_some();
    let _ = response.respond.send(VOICE.into());
    let outcome = match ended {
        Some(result) => result,
        None => tokio::time::timeout(WAIT, &mut pending).await.unwrap(),
    };
    drop(pending);
    let finished = app.settings().await.unwrap();
    assert_eq!(finished["styleLearning"][B], before["styleLearning"][B]);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    preserved(&app).await;
    drop(app);
    fixture.close().await;

    assert_eq!(Kind::Style.row(&held, A)["id"], replacement);
    assert_eq!(
        Kind::Style.row(&held, A)["status"],
        "running",
        "a delayed activity cancellation completion must not cancel a newer prepared style preview"
    );
    assert!(!stopped_before_response);
    outcome.unwrap();
    assert_eq!(Kind::Style.row(&finished, A)["id"], replacement);
    assert_eq!(Kind::Style.row(&finished, A)["status"], "ready");
    assert_eq!(Kind::Style.row(&finished, A)["voice"], VOICE);
}

#[tokio::test]
async fn expired_style_brain_reply_claims_reject_held_model_results_and_preserve_the_failure() {
    for kind in KINDS {
        let mut fixture = Fixture::new().await;
        let id = prepare(&fixture.app, kind).await;
        let before = fixture.app.settings().await.unwrap();
        let pending = tokio::spawn(work(fixture.app.clone(), kind, id));
        let late = fixture.next().await;
        let failed = fixture
            .app
            .db(move |db| {
                let mut settings = db.settings()?;
                kind.row_mut(&mut settings, A)["runningAt"] = OLD.into();
                db.set_settings(&json!({(kind.key()):settings[kind.key()]}))?;
                kind.expire(db)?;
                Ok(kind.row(&db.settings()?, A).clone())
            })
            .await
            .unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(string(&failed, "error").contains("timed out"));
        late.respond.send(kind.response().into()).unwrap();
        let result = join(pending).await;
        if matches!(kind, Kind::Style) {
            assert_eq!(result.unwrap_err().status, 502);
        } else {
            result.unwrap();
        }
        let settings = fixture.app.settings().await.unwrap();
        assert_eq!(
            kind.row(&settings, A),
            &failed,
            "{kind:?}: late result or Drop changed terminal failure"
        );
        assert_eq!(settings[kind.key()][B], before[kind.key()][B]);
        no_result(&settings, kind);
        subsequent_request(&mut fixture, kind).await;
        fixture.close().await;
    }
}

#[tokio::test]
async fn old_style_worker_drop_does_not_cancel_the_new_preview_or_another_owner() {
    let mut fixture = Fixture::new().await;
    let id = prepare(&fixture.app, Kind::Style).await;
    let old = tokio::spawn(work(fixture.app.clone(), Kind::Style, id.clone()));
    let old_response = fixture.next().await;
    fixture
        .app
        .db(|db| {
            let mut settings = db.settings()?;
            settings["styleLearning"][A]["preview"]["runningAt"] = OLD.into();
            db.set_settings(&json!({"styleLearning":settings["styleLearning"]}))?;
            learning::expire_running(db)
        })
        .await
        .unwrap();
    let replacement = prepare(&fixture.app, Kind::Style).await;
    assert_ne!(replacement, id);
    let new = tokio::spawn(work(fixture.app.clone(), Kind::Style, replacement.clone()));
    let new_response = fixture.next().await;
    let before_drop = fixture.app.settings().await.unwrap();
    old.abort();
    assert!(
        tokio::time::timeout(WAIT, old)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert_eq!(
        fixture.app.settings().await.unwrap()["styleLearning"],
        before_drop["styleLearning"]
    );
    let _ = old_response.respond.send("Discard this old voice".into());
    new_response.respond.send(VOICE.into()).unwrap();
    join(new).await.unwrap();
    let settings = fixture.app.settings().await.unwrap();
    assert_eq!(settings["styleLearning"][A]["preview"]["id"], replacement);
    assert_eq!(settings["styleLearning"][A]["preview"]["voice"], VOICE);
    preserved(&fixture.app).await;
    fixture.close().await;
}

#[tokio::test]
async fn old_reply_worker_drop_keeps_the_replacement_batch_and_releases_its_runtime_gate() {
    let mut fixture = Fixture::new().await;
    let id = prepare(&fixture.app, Kind::Replies).await;
    let old = tokio::spawn(work(fixture.app.clone(), Kind::Replies, id.clone()));
    let old_response = fixture.next().await;
    fixture
        .app
        .db(|db| {
            let mut settings = db.settings()?;
            settings["replySuggestions"][A]["job"]["runningAt"] = OLD.into();
            db.set_settings(&json!({"replySuggestions":settings["replySuggestions"]}))?;
            replies::expire_running(db)
        })
        .await
        .unwrap();
    let replacement = prepare(&fixture.app, Kind::Replies).await;
    assert_ne!(replacement, id);
    replies::tick(&fixture.app).await.unwrap(); // The old in-flight tick still owns its gate.
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    let before_drop = fixture.app.settings().await.unwrap();
    old.abort();
    assert!(
        tokio::time::timeout(WAIT, old)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert_eq!(
        fixture.app.settings().await.unwrap()["replySuggestions"],
        before_drop["replySuggestions"]
    );
    let _ = old_response.respond.send(REPLY.into());
    let new = tokio::spawn(work(
        fixture.app.clone(),
        Kind::Replies,
        replacement.clone(),
    ));
    fixture.next().await.respond.send(REPLY.into()).unwrap();
    join(new).await.unwrap();
    let settings = fixture.app.settings().await.unwrap();
    assert_eq!(settings["replySuggestions"][A]["job"]["id"], replacement);
    assert_eq!(settings["replySuggestions"][A]["job"]["status"], "complete");
    assert_eq!(
        settings["replySuggestions"][A]["proposals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    preserved(&fixture.app).await;
    fixture.close().await;
}

#[tokio::test]
async fn stale_ai_activity_sweeps_keep_fresh_future_terminal_and_unrelated_state() {
    let fixture = Fixture::new().await;
    fixture.app.db(|db| {
        let fresh = now();
        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let rows = [
            ("old@example.invalid", "running", OLD),
            ("missing@example.invalid", "running", ""),
            ("malformed@example.invalid", "running", "not-a-timestamp"),
            ("fresh@example.invalid", "running", fresh.as_str()),
            ("future@example.invalid", "running", future.as_str()),
            ("queued@example.invalid", "queued", OLD),
            ("terminal@example.invalid", "cancelled", OLD),
        ];
        let mut settings = db.settings()?;
        settings["imports"] = json!({A:{"status":"running","cursor":"keep-import-cursor"}});
        for kind in KINDS {
            for (owner, status, stamp) in rows {
                settings[kind.key()][owner] = match kind {
                    Kind::Style => json!({"preview":{"id":owner,"status":status,"runningAt":stamp}}),
                    Kind::Brain => json!({"enabled":false,"status":status,"runningAt":stamp}),
                    Kind::Replies => json!({"job":{"id":owner,"status":status,"runningAt":stamp,"inflight":true}}),
                };
            }
        }
        db.set_settings(&settings)?;
        let before = db.settings()?;
        for kind in KINDS {
            kind.expire(db)?;
            let after = db.settings()?;
            for (owner, status, stamp) in rows {
                let row = kind.row(&after, owner);
                if status == "running" && [OLD, "", "not-a-timestamp"].contains(&stamp) {
                    assert_eq!(row["status"], "failed", "{kind:?}: {owner}");
                    assert!(string(row, "error").contains("timed out"));
                    if matches!(kind, Kind::Replies) {
                        assert!(row["inflight"].is_null());
                    }
                } else {
                    assert_eq!(row, kind.row(&before, owner), "{kind:?}: {owner}");
                }
            }
            assert_eq!(after["imports"], before["imports"]);
            assert_eq!(after["workspaces"], before["workspaces"]);
        }
        Ok(())
    }).await.unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    fixture.close().await;
}
