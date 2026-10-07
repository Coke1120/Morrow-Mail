//! Content-free progress. These records never authorize work or retries.
use crate::{
    service::connections,
    store::{now, string},
};
use serde_json::{Value, json};
use std::sync::Mutex;

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
        | "interrupted") => value,
        _ => "interrupted",
    }
}
fn failure(phase: &str) -> bool {
    ["failed", "interrupted"].contains(&phase)
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
                tasks.push(json!({"id":format!("summaries:{owner}"),"accountId":owner,"kind":"ai","label":"AI summaries","status":if active.iter().any(|j|j["status"]=="running") {"running"} else {"queued"},"detail":format!("{} running · {} queued",active.iter().filter(|j|j["status"]=="running").count(),active.iter().filter(|j|j["status"]=="queued").count()),"completed":null,"total":active.len(),"updatedAt":timestamp(&[&last["updatedAt"],&last["createdAt"]])}));
            }
            if let Some(job) = jobs
                .iter()
                .rev()
                .find(|job| job.is_object() && !pending(job))
            {
                let status = phase(job);
                tasks.push(json!({"id":format!("last-summary:{owner}"),"accountId":owner,"kind":"ai","label":"Last AI summary","status":status,"detail":if job["status"]=="skipped" {"Context changed; the result was discarded. Review Summaries to run again."} else {"Results in AI Studio → Summaries"},"completed":if ["complete","completed"].contains(&status){Some(1)}else{None},"total":1,"updatedAt":timestamp(&[&job["updatedAt"],&job["completedAt"],&job["createdAt"]]),"error":if failure(status) {json!("Analysis did not complete. Review Summaries; no automatic retry.")} else {Value::Null}}));
            }
            let style = &config["styleLearning"][owner]["preview"];
            if style.is_object() {
                let status = if ["prepared", "ready"].contains(&string(style, "status")) {
                    "complete"
                } else {
                    phase(style)
                };
                tasks.push(json!({"id":format!("learning:{owner}"),"accountId":owner,"kind":"learning","label":"Writing-style learning","status":status,"detail":if style["status"]=="ready" {"Proposal ready. Review and save in Learning."} else if style["status"]=="prepared" {"Samples prepared. Waiting for your confirmation in Learning."} else if status == "running" {"Analyzing approved Sent samples."} else {"Review Learning before starting another analysis."},"completed":if style["status"]=="ready"{count(&style["sampleCount"])}else{None},"total":count(&style["sampleCount"]),"updatedAt":timestamp(&[&style["updatedAt"],&style["completedAt"],&style["createdAt"]]),"error":if failure(status){json!("Learning did not complete. Review Learning; no automatic retry.")}else{Value::Null}}));
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
                tasks.push(json!({"id":format!("semantic-index:{owner}"),"accountId":owner,"kind":"index","label":"Embedding index","status":status,"detail":if index["status"]=="prepared" {"Preview ready. Waiting for your confirmation in Search."} else {"Approved messages in the current batch; only downloaded mail is indexed."},"completed":done,"total":owned.len(),"updatedAt":timestamp(&[&index["updatedAt"],&index["createdAt"]]),"error":if failure(status){json!("Indexing did not complete. Review Search; retry only after reviewing a new batch.")}else{Value::Null}}));
            }
        }
        tasks.sort_by(|a, b| {
            let rank = |v: &Value| match string(v, "status") {
                "running" => 0,
                "queued" => 1,
                "failed" | "interrupted" => 2,
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
