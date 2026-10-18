//! Content-free progress. These records never authorize work or retries.
use crate::{
    error::{Error, Result},
    service::{App, connections},
    store::{now, string},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub struct Runtime {
    tasks: Mutex<Vec<Value>>,
}
pub struct Work<'a> {
    runtime: &'a Runtime,
    id: String,
    finished: bool,
}
fn pending(value: &Value) -> bool {
    ["queued", "running"].contains(&string(value, "status"))
}
fn phase(value: &Value) -> &str {
    match string(value, "status") {
        value @ ("queued" | "running" | "paused" | "complete" | "completed" | "failed"
        | "interrupted" | "cancelled") => value,
        _ => "interrupted",
    }
}
fn failure(phase: &str) -> bool {
    ["failed", "interrupted", "cancelled"].contains(&phase)
}
fn cancellable(task: &mut Value) {
    if task["status"] == "running" {
        task["cancellable"] = true.into();
    }
}
fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|v| *v <= 9_007_199_254_740_991)
}
fn timestamp(values: &[&Value]) -> Value {
    values
        .iter()
        .find_map(|value| {
            value
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        })
        .map(|date| {
            json!(
                date.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            )
        })
        .unwrap_or(Value::Null)
}
fn summary_status(job: &Value) -> &str {
    match string(job, "status") {
        "complete" | "completed" => "completed",
        status @ ("failed" | "cancelled" | "interrupted" | "skipped") => status,
        _ => "unknown",
    }
}
fn summary_diagnostic(status: &str, error: &str) -> (&'static str, String) {
    let (code, message) = match status {
        "completed" => ("completed", "The summary completed."),
        "cancelled" => (
            "cancelled",
            "The summary was cancelled before completion. Nothing was sent.",
        ),
        "interrupted" => (
            "interrupted",
            "The summary was interrupted before completion. Review the saved job details before generating again.",
        ),
        "skipped" => (
            "context_changed",
            "The summary context changed; this job was skipped. Review current permissions and sources before generating again.",
        ),
        "failed" => match error {
            "The summary timed out. Nothing was sent. Review Today before generating again." => (
                "summary_timeout",
                "The summary job timed out. Its running-time limit is 90 seconds. Nothing was sent. Review the model before generating again.",
            ),
            "The AI model did not respond within 45 seconds. Check model availability or use a faster model; no automatic retry was started." => {
                (
                    "model_timeout",
                    "The AI model did not respond within 45 seconds. Check model availability or use a faster model.",
                )
            }
            "Could not reach the AI model or read its response. Check your endpoint and model, then try again." => {
                (
                    "model_unreachable",
                    "Could not reach the AI model or read its response. Check your endpoint and model before generating again.",
                )
            }
            "The model response exceeded the 1 MB limit. Reduce the token limit." => (
                "response_too_large",
                "The model response exceeded the 1 MB limit. Reduce the response token limit before generating again.",
            ),
            "The AI model returned invalid JSON. Check that the endpoint supports chat completions." => {
                (
                    "model_invalid_json",
                    "The AI model returned invalid JSON. Check that the endpoint supports chat completions.",
                )
            }
            "The model returned an empty response. Try a different model." => (
                "model_empty_response",
                "The model returned an empty response. Review the selected model before generating again.",
            ),
            "The model returned an incomplete P0–P4 summary. Try fewer context messages or a higher response token limit." => {
                (
                    "summary_incomplete",
                    "The model returned an incomplete P0–P4 summary. Try fewer context messages or a higher response token limit.",
                )
            }
            "The model returned an ungrounded decision. Review its sources and generate again." => {
                (
                    "summary_ungrounded",
                    "The model returned an ungrounded decision. Review the source selection before generating again.",
                )
            }
            "Choose an AI model in Settings to use assistance with your mailbox."
            | "AI API base URL is required and must be at most 2048 characters."
            | "Enter a valid AI API base URL."
            | "Use an HTTP(S) base URL without credentials, query or fragment."
            | "Remote AI providers must use HTTPS. Local models may use HTTP on localhost."
            | "Choose a valid IANA time zone." => (
                "model_configuration",
                "The saved AI configuration could not be used. Review the model, endpoint and summary time zone in Settings.",
            ),
            "Invalid summary context." => (
                "summary_context_invalid",
                "The summary context could not be used. Review permissions and prepare a new preview.",
            ),
            "The workspace could not complete the database operation. Saved data has been retained." => {
                (
                    "storage_error",
                    "The workspace could not complete the database operation. Saved data has been retained.",
                )
            }
            "The workspace could not read or save its files. Check available space and permissions." => {
                (
                    "file_error",
                    "The workspace could not read or save its files. Check available space and permissions.",
                )
            }
            _ => {
                // Only this complete server-authored template may carry a number.
                // Do not pass through stored provider bodies, prefixes or suffixes.
                if let Some(status) = error
                    .strip_prefix("The AI provider returned HTTP ")
                    .and_then(|rest| rest.strip_suffix(". Check the model, endpoint, and API key."))
                    .filter(|status| {
                        status.len() == 3 && status.bytes().all(|b| b.is_ascii_digit())
                    })
                    .and_then(|status| status.parse::<u16>().ok())
                    .filter(|status| (100..=599).contains(status))
                {
                    return (
                        "model_http_error",
                        format!(
                            "The AI provider returned HTTP {status}. Check the model, endpoint, and API key."
                        ),
                    );
                }
                (
                    "unknown_failure",
                    "The summary could not complete. A safe failure reason was not recorded. Review the model and AI permissions before generating again.",
                )
            }
        },
        _ => (
            "unknown_status",
            "This summary job's outcome was not recorded in a recognized format.",
        ),
    };
    (code, message.into())
}
fn summary_job(owner: &str, job: &Value) -> Value {
    let status = summary_status(job);
    let (code, diagnostic) = summary_diagnostic(status, string(job, "error"));
    let id = job["id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            // An opaque account-bound reference, never a stored mail/provider id.
            format!(
                "{:x}",
                Sha256::digest(json!(["morrow-summary-activity-v1", owner, id]).to_string())
            )
        });
    let kind = match string(job, "kind") {
        kind @ ("manual" | "arrival" | "scheduled") => kind,
        _ => "unknown",
    };
    json!({
        "id":id,"accountId":owner,"kind":kind,"status":status,
        "createdAt":timestamp(&[&job["createdAt"]]),
        "startedAt":timestamp(&[&job["runningAt"]]),
        "finishedAt":timestamp(&[&job["finishedAt"],&job["completedAt"]]),
        "updatedAt":timestamp(&[&job["finishedAt"],&job["completedAt"],&job["updatedAt"]]),
        "messageCount":job["messageIds"].as_array().map(Vec::len),
        "diagnosticCode":code,"diagnostic":diagnostic,"automaticRetry":false
    })
}
fn retain(tasks: &mut Vec<Value>) {
    let mut excess = tasks
        .iter()
        .filter(|t| t["status"] != "running")
        .count()
        .saturating_sub(20);
    tasks.retain(|task| {
        if excess > 0 && task["status"] != "running" {
            excess -= 1;
            false
        } else {
            true
        }
    });
}
fn import_detail(job: &Value, phase: &str) -> String {
    let folders = if job["options"]["allMail"] == true {
        "All mail".to_owned()
    } else {
        [("inbox", "Inbox"), ("sent", "Sent")]
            .into_iter()
            .filter(|(key, _)| job["options"][*key] == true)
            .map(|(_, label)| label)
            .collect::<Vec<_>>()
            .join(" + ")
    };
    let months = count(&job["options"]["months"])
        .filter(|v| [1, 3, 6, 12].contains(v))
        .map(|v| format!("{v} months"))
        .unwrap_or_else(|| "Selected history range".into());
    let pages = count(&job["pages"])
        .map(|n| format!("{n} pages checked"))
        .unwrap_or_else(|| "Page count unknown".into());
    let processed = count(&job["processed"])
        .map(|n| format!("{n} messages checked"))
        .unwrap_or_else(|| "Checked message count unknown".into());
    let added = count(&job["imported"])
        .map(|n| format!("{n} new messages"))
        .unwrap_or_else(|| "New message count unknown".into());
    let retry_at = timestamp(&[&job["nextRetryAt"]]);
    let retry = format!(
        "Temporary interruption. Retry {} scheduled for {}. Retrying continues while Morrow is open; you can pause this import.",
        count(&job["retryCount"]).unwrap_or(0),
        retry_at.as_str().unwrap_or("")
    );
    let action = if job["phase"] == "retrying" && !retry_at.is_null() {
        retry.as_str()
    } else {
        match phase {
            "queued" => "Waiting for the next background page.",
            "running" => "Fetching the next history page.",
            _ => "Downloaded mail only.",
        }
    };
    let current = match string(job, "currentFolder") {
        "all" => " · Current folder: All mail",
        "inbox" => " · Current folder: Inbox",
        "sent" => " · Current folder: Sent",
        _ => "",
    };
    format!(
        "{months}{}{current} · {pages} · {processed} · {added}. {action}",
        if folders.is_empty() {
            String::new()
        } else {
            format!(" · {folders}")
        }
    )
}
impl Runtime {
    /// Label/detail are server-authored phase text, never provider/model output.
    pub fn start(&self, account: &str, kind: &str, label: &str, detail: &str) -> Work<'_> {
        let id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut tasks) = self.tasks.lock() {
            if kind == "sync" {
                tasks.retain(|task| {
                    task["accountId"] != account
                        || task["kind"] != "sync"
                        || !failure(string(task, "status"))
                });
            }
            tasks.push(json!({"id":id,"accountId":account,"kind":kind,"label":label,"detail":detail,"status":"running","completed":null,"total":null,"updatedAt":now()}));
        }
        Work {
            runtime: self,
            id,
            finished: false,
        }
    }
    pub fn snapshot(&self, config: &Value) -> Value {
        let live = connections(config);
        let mut tasks = self.tasks.lock().map(|v| v.clone()).unwrap_or_default();
        tasks.retain(|t| {
            string(t, "accountId").is_empty() || live.get(string(t, "accountId")).is_some()
        });
        for owner in live.as_object().into_iter().flat_map(|v| v.keys()) {
            if let Some(sync) = config["backgroundSyncErrors"]
                .as_array()
                .and_then(|errors| errors.iter().find(|error| error["accountId"] == *owner))
            {
                let retry_at = timestamp(&[&sync["nextRetryAt"]]);
                // Saved errors are projected from known codes, never stored provider text.
                let waiting = (sync["code"] == "rate_limited" && !retry_at.is_null())
                    || sync["code"] == "provider_quota_exceeded";
                let detail = if waiting {
                    format!(
                        "The provider request limit was reached. {} Keep Morrow open; downloaded mail is retained.",
                        retry_at
                            .as_str()
                            .map(|at| format!("Next retry: {at}."))
                            .unwrap_or_else(|| "Retry pending.".into())
                    )
                } else {
                    match string(sync, "code") {
                        "oauth_reconnect_required" => "Mailbox authorization is no longer valid. Reconnect this account in Settings; downloaded mail is retained.",
                        "outlook_sync_invalid" => "Outlook returned an invalid sync checkpoint. Reconnect this account in Settings to restart change tracking; downloaded mail is retained.",
                        "oauth_configuration" => "The provider rejected the OAuth app configuration. Check this account's OAuth client settings in Settings.",
                        "oauth_refresh_failed" => "Could not refresh mailbox authorization. Check your connection and refresh recent mail again; saved credentials are retained.",
                        _ => "Recent mail could not be fully refreshed. Check the connection and import settings, then refresh again; downloaded mail is retained.",
                    }.to_owned()
                };
                tasks.retain(|task| {
                    task["accountId"] != *owner
                        || task["kind"] != "sync"
                        || task["status"] == "running"
                });
                tasks.push(json!({"id":format!("sync:{owner}"),"accountId":owner,"kind":"sync","label":"Recent mail sync","status":if waiting {"queued"} else {"failed"},"detail":detail,"completed":null,"total":null,"updatedAt":timestamp(&[&sync["updatedAt"]]),"nextRetryAt":if waiting {retry_at} else {Value::Null},"retryCount":count(&sync["retryCount"])}));
            }
            let import = crate::background::import_status_from(config, owner);
            if import.is_object() {
                // Ordinary sync is not evidence that a history page is in flight.
                let fetching = tasks.iter().any(|t| {
                    t["accountId"] == *owner && t["kind"] == "import" && t["status"] == "running"
                });
                let status = if import["status"] == "running" {
                    if fetching { "running" } else { "queued" }
                } else {
                    phase(&import)
                };
                tasks.retain(|task| task["accountId"] != *owner || task["kind"] != "import");
                tasks.push(json!({"id":format!("import:{owner}"),"accountId":owner,"kind":"import","label":"Mail history","status":status,"completed":count(&import["processed"]),"total":null,"detail":import_detail(&import,status),"updatedAt":timestamp(&[&import["updatedAt"]]),"error":if failure(status) {import["error"].as_str().filter(|s|!s.is_empty()).map(|s|json!(s)).unwrap_or(json!("Import stopped. Review the connection and import settings before resuming."))} else if status == "paused" {json!("Import is paused. Review import settings to resume or start again.")} else {Value::Null}}));
            }
            let jobs = config["automation"][owner]["jobs"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let active: Vec<_> = jobs.iter().filter(|j| pending(j)).collect();
            if let Some(last) = active.last() {
                let mut task = json!({"id":format!("summaries:{owner}"),"accountId":owner,"kind":"ai","label":"AI summaries","status":if active.iter().any(|j|j["status"]=="running") {"running"} else {"queued"},"detail":format!("{} running · {} queued",active.iter().filter(|j|j["status"]=="running").count(),active.iter().filter(|j|j["status"]=="queued").count()),"completed":null,"total":active.len(),"updatedAt":timestamp(&[&last["updatedAt"],&last["runningAt"],&last["createdAt"]])});
                cancellable(&mut task);
                tasks.push(task);
            }
            if let Some(job) = jobs
                .iter()
                .rev()
                .find(|job| job.is_object() && !pending(job))
            {
                let summary = summary_job(owner, job);
                let status = string(&summary, "status");
                tasks.push(json!({"id":format!("last-summary:{owner}"),"accountId":owner,"kind":"ai","label":"Last AI summary","status":status,"detail":"Saved summary job details. This job is not retried automatically.","completed":if status == "completed"{Some(1)}else{None},"total":1,"updatedAt":timestamp(&[&summary["updatedAt"],&summary["startedAt"],&summary["createdAt"]]),"error":if status != "completed" {summary["diagnostic"].clone()} else {Value::Null},"summaryJob":summary}));
            }
            let style = &config["styleLearning"][owner]["preview"];
            if style.is_object() {
                let status = if ["prepared", "ready"].contains(&string(style, "status")) {
                    "complete"
                } else {
                    phase(style)
                };
                let mut task = json!({"id":format!("learning:{owner}"),"accountId":owner,"kind":"learning","label":"Writing-style learning","status":status,"detail":if style["status"]=="ready" {"Proposal ready. Review and save in Learning."} else if style["status"]=="prepared" {"Samples prepared. Waiting for your confirmation in Learning."} else if status == "running" {"Analyzing approved Sent samples."} else {"Review Learning before starting another analysis."},"completed":if style["status"]=="ready"{count(&style["sampleCount"])}else{None},"total":count(&style["sampleCount"]),"updatedAt":timestamp(&[&style["updatedAt"],&style["runningAt"],&style["completedAt"],&style["createdAt"]]),"error":if failure(status){json!("Learning did not complete. Review Learning; no automatic retry.")}else{Value::Null}});
                cancellable(&mut task);
                tasks.push(task);
            }
            if config["brainLearning"][owner]["status"] == "running" {
                let memory = &config["brainLearning"][owner];
                let mut task = json!({"id":format!("brain:{owner}"),"accountId":owner,"kind":"ai","label":"Memory analysis","status":"running","detail":"Reviewing permitted mail for memory suggestions. Nothing is saved until you accept it.","completed":null,"total":null,"updatedAt":timestamp(&[&memory["runningAt"],&memory["updatedAt"],&memory["lastAt"]])});
                cancellable(&mut task);
                tasks.push(task);
            }
            if config["replySuggestions"][owner]["job"]["status"] == "running" {
                let job = &config["replySuggestions"][owner]["job"];
                let mut task = json!({"id":format!("replies:{owner}"),"accountId":owner,"kind":"ai","label":"Reply suggestions","status":"running","detail":"Reviewing approved Inbox messages. Nothing is sent.","completed":count(&job["completed"]),"total":count(&job["sampleCount"]),"updatedAt":timestamp(&[&job["runningAt"],&job["updatedAt"],&job["createdAt"]])});
                cancellable(&mut task);
                tasks.push(task);
            }
        }
        let index = &config["searchIndex"];
        if let Some(sources) = index["sources"].as_array() {
            let completed = count(&index["completed"]).filter(|n| *n <= sources.len() as u64);
            let status = if index["status"] == "prepared" {
                "complete"
            } else {
                phase(index)
            };
            for owner in live.as_object().into_iter().flat_map(|v| v.keys()) {
                let owned: Vec<_> = sources
                    .iter()
                    .enumerate()
                    .filter(|(_, source)| source["account"] == *owner)
                    .map(|(i, _)| i as u64)
                    .collect();
                if owned.is_empty() {
                    continue;
                }
                let done = completed.map(|n| owned.iter().filter(|i| **i < n).count());
                let status = if status == "running" {
                    match completed {
                        Some(_) if done == Some(owned.len()) => "complete",
                        Some(n)
                            if sources
                                .get(n as usize)
                                .is_some_and(|item| item["account"] == *owner) =>
                        {
                            "running"
                        }
                        _ => "queued",
                    }
                } else {
                    status
                };
                let mut task = json!({"id":format!("semantic-index:{owner}"),"accountId":owner,"kind":"index","label":"Embedding index","status":status,"detail":if index["status"]=="prepared" {"Preview ready. Waiting for your confirmation in Search."} else {"Approved messages in the current batch; only downloaded mail is indexed."},"completed":done,"total":owned.len(),"updatedAt":timestamp(&[&index["updatedAt"],&index["createdAt"]]),"error":if failure(status){json!("Indexing did not complete. Review Search; retry only after reviewing a new batch.")}else{Value::Null}});
                cancellable(&mut task);
                tasks.push(task);
            }
        }
        tasks.sort_by(|a, b| {
            let rank = |v: &Value| match string(v, "status") {
                "running" => 0,
                "queued" => 1,
                "failed" | "interrupted" | "cancelled" => 2,
                "paused" => 3,
                _ => 4,
            };
            rank(a)
                .cmp(&rank(b))
                .then_with(|| string(b, "updatedAt").cmp(string(a, "updatedAt")))
        });
        json!({"tasks":tasks,"checkedAt":now()})
    }
}
impl Work<'_> {
    /// A server-authored error only; never pass provider bodies or model output.
    pub fn fail(&mut self, message: &str) {
        if self.finished {
            return;
        }
        self.update("failed", None);
        if let Ok(mut tasks) = self.runtime.tasks.lock()
            && let Some(task) = tasks.iter_mut().find(|t| t["id"] == self.id)
        {
            task["error"] = message.into();
            task["detail"] = "Request ended; review the error before trying again.".into();
        }
        self.finished = true;
    }
    pub fn finish(&mut self, success: bool, completed: Option<usize>) {
        if self.finished {
            return;
        }
        self.update(if success { "complete" } else { "failed" }, completed);
        self.finished = true;
    }
    fn update(&self, status: &str, completed: Option<usize>) {
        if let Ok(mut tasks) = self.runtime.tasks.lock()
            && let Some(position) = tasks.iter().position(|t| t["id"] == self.id)
        {
            let mut task = tasks.remove(position);
            task["status"] = status.into();
            task["updatedAt"] = now().into();
            task["completed"] = completed
                .filter(|n| *n as u64 <= 9_007_199_254_740_991)
                .into();
            if failure(status) {
                task["error"] = if status == "interrupted" {
                    "The operation was interrupted before a result could be confirmed. Review its page before trying again; no automatic retry was started."
                } else {
                    "Operation did not complete. Check its page or connection settings; no automatic retry was started here."
                }.into();
                task["detail"] = "Operation ended.".into();
            }
            tasks.push(task);
            retain(&mut tasks);
        }
    }
}
impl Drop for Work<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.update("interrupted", None);
        }
    }
}

type PublishedJob = Option<(String, String)>;
type Settle = Box<dyn FnOnce(PublishedJob) + Send>;

/// Marks a claimed job abandoned if its worker is dropped before a terminal write.
/// Drop sets the flag before taking the store lock so an in-flight claim can see it.
pub struct RunLease {
    abandoned: Arc<AtomicBool>,
    slot: Arc<Mutex<PublishedJob>>,
    settle: Option<Settle>,
}
#[derive(Clone)]
pub struct RunningGuard {
    abandoned: Arc<AtomicBool>,
    slot: Arc<Mutex<PublishedJob>>,
}
impl RunLease {
    pub fn on_drop(settle: impl FnOnce(PublishedJob) + Send + 'static) -> Self {
        Self {
            abandoned: Arc::new(AtomicBool::new(false)),
            slot: Arc::new(Mutex::new(None)),
            settle: Some(Box::new(settle)),
        }
    }
    pub fn guard(&self) -> RunningGuard {
        RunningGuard {
            abandoned: self.abandoned.clone(),
            slot: self.slot.clone(),
        }
    }
}
impl RunningGuard {
    /// Returns whether the worker was already dropped. Publish happens first.
    pub fn publish(&self, account: &str, id: &str) -> bool {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some((account.to_owned(), id.to_owned()));
        }
        self.abandoned.load(Ordering::Acquire)
    }
}
impl Drop for RunLease {
    fn drop(&mut self) {
        self.abandoned.store(true, Ordering::Release);
        let published = self.slot.lock().ok().and_then(|mut slot| slot.take());
        if let Some(settle) = self.settle.take() {
            settle(published);
        }
    }
}

const NOT_CANCELLABLE: &str = "That activity cannot be cancelled from here. Pause the import in Settings, or wait for the current mail fetch to finish.";

/// Cancels one persisted running activity. The owner comes from the activity id.
pub async fn cancel(app: &App, id: &str) -> Result<Value> {
    let Some((kind, owner)) = id.split_once(':') else {
        return Err(Error::conflict(NOT_CANCELLABLE));
    };
    if owner.is_empty()
        || owner == "all"
        || owner == "demo"
        || owner.len() > 254
        || owner.contains(['\n', '\r', '\0'])
    {
        return Err(Error::conflict("Choose an individual connected mailbox."));
    }
    let settings = app.settings().await?;
    if connections(&settings).get(owner).is_none() {
        return Err(Error::conflict("Choose an individual connected mailbox."));
    }
    let owner = owner.to_owned();
    // Publish while the Store is still locked, before a replacement can claim work.
    let changed = match kind {
        "summaries" => {
            let account = owner.clone();
            let cancel_app = app.clone();
            app.db(move |db| {
                let changed = crate::background::cancel_running_summaries(db, &account)?;
                if changed {
                    cancel_app.0.background.request_stop(&account, "summary");
                }
                Ok(changed)
            })
            .await?
        }
        "learning" => {
            let account = owner.clone();
            let cancel_app = app.clone();
            app.db(move |db| {
                let changed = crate::learning::cancel_running(db, &account)?;
                if changed {
                    cancel_app.0.background.request_stop(&account, "learning");
                }
                Ok(changed)
            })
            .await?
        }
        "brain" => {
            let account = owner.clone();
            let cancel_app = app.clone();
            app.db(move |db| {
                let changed = crate::brain::cancel_running(db, &account)?;
                if changed {
                    cancel_app.0.background.request_stop(&account, "brain");
                }
                Ok(changed)
            })
            .await?
        }
        "replies" => {
            let account = owner.clone();
            let cancel_app = app.clone();
            app.db(move |db| {
                let changed = crate::reply_suggestions::cancel_running(db, &account)?;
                if changed {
                    crate::reply_suggestions::signal_cancel(&cancel_app, &account);
                }
                Ok(changed)
            })
            .await?
        }
        "semantic-index" => {
            if settings["searchIndex"]["status"] != "running" {
                false
            } else {
                let job = string(&settings["searchIndex"], "id").to_owned();
                if job.is_empty() {
                    false
                } else {
                    app.db(move |db| crate::smart_search::control(db, "cancel", &job))
                        .await?;
                    app.0.smart.invalidate().await;
                    true
                }
            }
        }
        "sync" | "import" | "last-summary" => return Err(Error::conflict(NOT_CANCELLABLE)),
        _ => return Err(Error::conflict(NOT_CANCELLABLE)),
    };
    if !changed {
        return Err(Error::conflict("That activity is no longer running."));
    }
    let mut snapshot = app.0.activity.snapshot(&app.settings().await?);
    snapshot["cancelled"] = true.into();
    Ok(snapshot)
}
