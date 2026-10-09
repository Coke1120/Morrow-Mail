//! Persistent, account-bound history imports and summary scheduling.
use crate::{
    ai,
    error::{Error, Result},
    mail, policy, providers,
    service::{App, Context, connections},
    store::{Store, catalog, merge, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Months, SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{
        LazyLock,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
};
use tokio::sync::{Mutex, Notify};

pub struct Runtime {
    gate: Mutex<()>,
    stopped: AtomicBool,
    shutdown: Notify,
    last_sync: AtomicI64,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            gate: Mutex::new(()),
            stopped: AtomicBool::new(false),
            shutdown: Notify::new(),
            last_sync: AtomicI64::new(0),
        }
    }
}

pub const PRIORITY_GUIDE: &str = "P0: explicit emergency requiring immediate attention. P1: explicit action due today. P2: normal action or follow-up. P3: information with no action requested. P4: low-priority bulk/promotional mail. Use P2 when urgency is unclear; never invent a deadline or emergency. Priorities are suggestions for human review.";

pub fn priority_summary(raw: &str, messages: &[Value]) -> Result<Value> {
    let invalid = || {
        Error::new(
            502,
            "The model returned an incomplete P0–P4 summary. Try fewer context messages or a higher response token limit.",
        )
    };
    static FENCE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?s)^```(?:json)?\s*\n(.*?)\n```$").unwrap());
    let raw = FENCE.replace(raw.trim(), "$1");
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let entries = parsed["items"].as_array().ok_or_else(invalid)?;
    let ids: HashSet<&str> = messages.iter().map(|m| string(m, "id")).collect();
    let mut seen = HashSet::new();
    if entries.len() != ids.len() {
        return Err(invalid());
    }
    let mut items = Vec::new();
    for entry in entries {
        let id = string(entry, "messageId");
        let priority = string(entry, "priority");
        let summary = entry["summary"].as_str().ok_or_else(invalid)?;
        if !ids.contains(id)
            || !seen.insert(id)
            || !["P0", "P1", "P2", "P3", "P4"].contains(&priority)
            || summary.trim().is_empty()
            || summary.encode_utf16().count() > 4000
        {
            return Err(invalid());
        }
        items.push(json!({"messageId":id,"priority":priority,"summary":summary.trim()}));
    }
    items.sort_by(|a, b| string(a, "priority").cmp(string(b, "priority")));
    let text = ["P0", "P1", "P2", "P3", "P4"]
        .into_iter()
        .map(|priority| {
            let selected: Vec<_> = items
                .iter()
                .filter(|item| item["priority"] == priority)
                .collect();
            let lines = if selected.is_empty() {
                "—".into()
            } else {
                selected
                    .iter()
                    .map(|item| format!("• {}", string(item, "summary")))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!("{priority} ({})\n{lines}", selected.len())
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(json!({"items":items,"text":text}))
}

fn digest(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
pub(crate) fn write_owner(db: &Store, group: &str, account: &str, value: Value) -> Result<()> {
    let mut entries = merge(json!({}), &db.settings()?[group]);
    entries[account] = value;
    db.set_settings(&json!({group:entries}))?;
    Ok(())
}

pub fn import_options(input: &Value) -> Result<Value> {
    let fields = input
        .as_object()
        .ok_or_else(|| Error::invalid("Invalid import options."))?;
    if fields
        .keys()
        .any(|key| !["months", "inbox", "sent", "allMail"].contains(&key.as_str()))
    {
        return Err(Error::invalid("Invalid import options."));
    }
    let options = merge(
        json!({"months":3,"inbox":true,"sent":true,"allMail":false}),
        input,
    );
    if !options["months"]
        .as_u64()
        .is_some_and(|months| [0, 1, 3, 6, 12].contains(&months))
        || !options["inbox"].is_boolean()
        || !options["sent"].is_boolean()
        || !options["allMail"].is_boolean()
        || (options["inbox"] != true && options["sent"] != true && options["allMail"] != true)
    {
        return Err(Error::invalid(
            "Choose all history or 1, 3, 6, or 12 months and at least one folder.",
        ));
    }
    Ok(options)
}
pub fn months_ago(months: u32, timestamp: i64) -> Result<String> {
    DateTime::from_timestamp_millis(timestamp)
        .and_then(|date| date.checked_sub_months(Months::new(months)))
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| Error::invalid("Invalid import date."))
}
fn clear_import_failure() -> Value {
    json!({"error":"","errorCode":null,"recoveryAction":null,"nextRetryAt":null,"retryCount":0})
}
fn import_error_message(code: &str) -> Option<&'static str> {
    match code {
        "invalid_cursor" => Some(
            "The mailbox page changed or repeated. Start a new import; cached mail is retained.",
        ),
        "invalid_page" => Some(
            "The provider returned an invalid import page. Start a new import; cached mail is retained.",
        ),
        "storage_error" => Some(
            "Import could not save this page. Check available disk space, then resume. Saved progress is retained.",
        ),
        "authorization" => Some("Reconnect this mailbox, then start a new import."),
        "sent_unavailable" => Some(
            "This server does not identify a Sent folder. Choose Inbox only and start a new import.",
        ),
        "rate_limited" => Some("The provider is limiting requests. Saved progress is retained."),
        "provider_unavailable" => {
            Some("The provider is temporarily unavailable. Saved progress is retained.")
        }
        "network_error" => Some("The provider could not be reached. Saved progress is retained."),
        "import_failed" => Some(
            "Import could not finish this page. Check the connection, then resume. Saved progress is retained.",
        ),
        "connection_changed" => Some("Connection changed. Start a new import."),
        _ => None,
    }
}
pub(crate) fn import_failure(error: &Error, stage: &str, job: &Value, timestamp: i64) -> Value {
    let message = string(&error.body, "error");
    let status = error.provider_status.unwrap_or(error.status);
    let count = job["retryCount"].as_u64().unwrap_or(0);
    let quota_delay = (stage == "fetch")
        .then(|| providers::quota_retry_delay(error, count, timestamp))
        .flatten();
    let (code, action, retry) = if message == "Repeated import page."
        || message == "The IMAP folder changed. Start the import again."
    {
        ("invalid_cursor", "restart", false)
    } else if message == "Invalid import page." {
        ("invalid_page", "restart", false)
    } else if stage == "commit" {
        ("storage_error", "resume", false)
    } else if quota_delay.is_some() {
        ("rate_limited", "retry", true)
    } else if [401, 403].contains(&status) {
        ("authorization", "reconnect", false)
    } else if message.starts_with("This IMAP server does not identify a Sent folder.") {
        ("sent_unavailable", "restart", false)
    } else if stage == "fetch"
        && error
            .provider_status
            .is_some_and(|s| (500..=599).contains(&s))
    {
        ("provider_unavailable", "retry", true)
    } else if stage == "fetch" && error.body["code"] == "provider_network" {
        ("network_error", "retry", true)
    } else {
        ("import_failed", "resume", false)
    };
    let delay = retry.then(|| {
        quota_delay
            .unwrap_or([30_000, 120_000, 300_000, 900_000, 3_600_000][count.min(4) as usize])
            .max(error.retry_after.unwrap_or(0).saturating_sub(timestamp))
    });
    let retry_at = delay
        .and_then(|delay| DateTime::from_timestamp_millis(timestamp + delay))
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true));
    json!({"error":import_error_message(code).unwrap_or_default(),"errorCode":code,"status":if delay.is_some(){"running"}else{"failed"},"recoveryAction":action,"nextRetryAt":retry_at,"retryCount":count.saturating_add(u64::from(delay.is_some())),"updatedAt":DateTime::from_timestamp_millis(timestamp).unwrap().to_rfc3339_opts(SecondsFormat::Millis,true)})
}
pub fn start_import(db: &Store, account: &str, input: &Value) -> Result<()> {
    let options = import_options(input)?;
    let config = db.settings()?;
    let live = connections(&config);
    let connection = live
        .get(account)
        .ok_or_else(|| Error::invalid("Choose a connected mailbox."))?;
    if options["allMail"] == true
        && !["google", "microsoft", "imap", ""].contains(&string(connection, "provider"))
    {
        return Err(Error::invalid("Unsupported mailbox provider."));
    }
    let timestamp = Utc::now();
    let before = timestamp.to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut job = json!({"id":uuid::Uuid::new_v4().to_string(),"options":options,"since":if options["months"] == 0 { String::new() } else { months_ago(options["months"].as_u64().unwrap() as u32,timestamp.timestamp_millis())? },"before":before,"folderIndex":0,"cursor":null,"visited":[],"status":"running","imported":0,"pages":0,"processed":0,"updatedAt":before});
    job["recentSince"] = (timestamp - chrono::Duration::days(7))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .into();
    if let Some(identity) = connection.get("connectionId") {
        job["connectionId"] = identity.clone();
    }
    db.transaction(|db| {
        db.conn.execute(
            "DELETE FROM import_cursor_hashes WHERE account=?",
            [account],
        )?;
        write_owner(db, "imports", account, merge(job, &clear_import_failure()))
    })
}
pub fn control_import(db: &Store, account: &str, action: &str) -> Result<()> {
    let config = db.settings()?;
    let job = &config["imports"][account];
    if !job.is_object() || job["status"] == "complete" || !["pause", "resume"].contains(&action) {
        return Err(Error::invalid("No import to pause or resume."));
    }
    if action == "resume"
        && (connections(&config).get(account).is_none()
            || job["connectionId"] != connections(&config)[account]["connectionId"])
    {
        return Err(Error::invalid("Start a new import for this connection."));
    }
    write_owner(
        db,
        "imports",
        account,
        merge(
            job.clone(),
            &merge(
                clear_import_failure(),
                &json!({"id":uuid::Uuid::new_v4().to_string(),"status":if action=="pause"{"paused"}else{"running"},"updatedAt":now()}),
            ),
        ),
    )
}
pub fn import_status(db: &Store, account: &str) -> Result<Value> {
    Ok(import_status_from(&db.settings()?, account))
}
pub fn import_status_from(config: &Value, account: &str) -> Value {
    let live = connections(config);
    let mut job = config["imports"][account].clone();
    if !job.is_object() {
        return Value::Null;
    }
    if job["status"] == "running"
        && let Some(mail) = live.get(account)
        && job["connectionId"] == mail["connectionId"]
        && let Some(wait) = mail::read_backoff(config, mail)
        && string(&wait.body, "nextRetryAt") > string(&job, "nextRetryAt")
    {
        job = merge(
            job,
            &json!({"errorCode":"rate_limited","nextRetryAt":wait.body["nextRetryAt"],"retryCount":wait.body["retryCount"]}),
        );
    }
    let job = &job;
    let code = if import_error_message(string(job, "errorCode")).is_some() {
        string(job, "errorCode")
    } else if job["status"] == "failed" {
        "import_failed"
    } else {
        ""
    };
    let action = if job["status"] == "running" && !string(job, "nextRetryAt").is_empty() {
        Some("retry")
    } else if ["failed", "paused"].contains(&string(job, "status")) {
        Some(match code {
            "authorization" => "reconnect",
            "invalid_cursor" | "invalid_page" | "sent_unavailable" | "connection_changed" => {
                "restart"
            }
            _ => "resume",
        })
    } else {
        None
    };
    let provider = live.get(account).map(|mail| string(mail, "provider"));
    let coverage = json!({"provider":provider,"folders":import_folders(job),"excludes":["spam","trash"],"folderLimit":if job["options"]["allMail"] == true && matches!(provider, Some("microsoft" | "imap" | "")){Some(300)}else{None}});
    merge(
        project(
            job,
            &[
                "options",
                "since",
                "before",
                "status",
                "imported",
                "updatedAt",
                "error",
            ],
        ),
        &json!({"downloadStage":if !string(job,"recentSince").is_empty() && job["recentComplete"]!=true {"recent"}else{"older"},"coverage":coverage,"currentFolder":import_folders(job).get(job["folderIndex"].as_u64().unwrap_or(0) as usize),"phase":if job["status"]=="running"{if string(job,"nextRetryAt").is_empty(){"queued"}else{"retrying"}}else{string(job,"status")},"pages":job["pages"],"processed":job["processed"],"lastPageChecked":job["lastPageChecked"],"lastPageAdded":job["lastPageAdded"],"nextRetryAt":job["nextRetryAt"],"retryCount":job["retryCount"].as_u64().unwrap_or(0),"error":import_error_message(code).unwrap_or_default(),"errorCode":if code.is_empty(){Value::Null}else{json!(code)},"recoveryAction":action}),
    )
}
pub fn import_config(db: &Store, account: &str) -> Result<Value> {
    Ok(db.settings()?["imports"][account]["options"].clone())
}
pub(crate) fn project(value: &Value, keys: &[&str]) -> Value {
    let mut result = json!({});
    for key in keys {
        if let Some(value) = value.get(*key) {
            result[key] = value.clone();
        }
    }
    result
}
fn import_current(config: &Value, account: &str, job: &Value) -> bool {
    config["imports"][account]["id"] == job["id"]
        && config["imports"][account]["status"] == "running"
        && connections(config)
            .get(account)
            .is_some_and(|mail| mail["connectionId"] == job["connectionId"])
}
fn import_folders(job: &Value) -> Vec<&'static str> {
    if job["options"]["allMail"] == true {
        return vec!["all"];
    }
    ["inbox", "sent"]
        .into_iter()
        .filter(|folder| job["options"][folder] == true)
        .collect()
}

fn import_window(job: &Value) -> (&str, &str) {
    let recent = string(job, "recentSince");
    if !recent.is_empty() && recent > string(job, "since") && recent < string(job, "before") {
        if job["recentComplete"] == true {
            (string(job, "since"), recent)
        } else {
            (recent, string(job, "before"))
        }
    } else {
        (string(job, "since"), string(job, "before"))
    }
}

/// Commit the provider page and checkpoint together; stale network results never write.
pub fn apply_import_page(db: &Store, account: &str, job: &Value, result: &Value) -> Result<()> {
    db.transaction(|db| {
        let config = db.settings()?;
        if !import_current(&config,account,job) { return Ok(()); }
        let messages = result["messages"].as_array().filter(|messages| messages.len() <= 50).ok_or_else(|| Error::new(502,"Invalid import page."))?;
        let checked = messages.len() as u64;
        let cursor = result.get("nextCursor").filter(|cursor| !cursor.is_null() && **cursor != false && **cursor != "");
        let hash = cursor.map(digest).transpose()?;
        let repeated = if let Some(hash) = &hash {
            job["visited"].as_array().is_some_and(|visited| visited.contains(&json!(hash))) ||
                db.conn.query_row("SELECT EXISTS(SELECT 1 FROM import_cursor_hashes WHERE account=? AND digest=?)", rusqlite::params![account, hash], |row| row.get::<_, bool>(0))?
        } else { false };
        if cursor.is_some_and(|cursor| *cursor == job["cursor"]) || repeated { return Err(Error::new(502,"Repeated import page.")); }
        let (since, before) = import_window(job);
        let messages: Vec<_> = messages.iter().filter(|message| string(message,"date") >= since && string(message,"date") < before).cloned().collect();
        let imported = mail::import_messages(db,&connections(&config)[account],&messages)?.len();
        let folder_index = job["folderIndex"].as_u64().unwrap_or(0) + u64::from(cursor.is_none());
        if cursor.is_some() {
            for old in job["visited"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                db.conn.execute("INSERT OR IGNORE INTO import_cursor_hashes VALUES(?,?)", rusqlite::params![account, old])?;
            }
            if let Some(hash) = hash { db.conn.execute("INSERT OR IGNORE INTO import_cursor_hashes VALUES(?,?)", rusqlite::params![account, hash])?; }
        } else {
            db.conn.execute("DELETE FROM import_cursor_hashes WHERE account=?", [account])?;
        }
        let recent_done = folder_index as usize >= import_folders(job).len()
            && since != string(job, "since") && job["recentComplete"] != true;
        let mut next = merge(merge(job.clone(),&clear_import_failure()), &json!({"imported":job["imported"].as_u64().unwrap_or(0)+imported as u64,"pages":job["pages"].as_u64().map(|pages|pages+1),"processed":job["processed"].as_u64().map(|processed|processed+checked),"lastPageChecked":checked,"lastPageAdded":imported,"cursor":cursor,"visited":[],"folderIndex":folder_index,"status":if folder_index as usize>=import_folders(job).len(){"complete"}else{"running"},"updatedAt":now()}));
        if recent_done {
            next = merge(next, &json!({"recentComplete":true,"folderIndex":0,"cursor":null,"status":"running"}));
        }
        write_owner(db,"imports",account,next)
    })
}

async fn history_tick(app: &App) -> Result<()> {
    let Ok(_mailbox) = app.0.mailbox.try_lock() else {
        return Ok(());
    };
    let entry = app
        .db(|db| {
            let config = db.settings()?;
            let live = connections(&config);
            Ok(config["imports"]
                .as_object()
                .into_iter()
                .flat_map(|entries| entries.iter())
                .filter(|(account, job)| {
                    live.get(*account).is_some()
                        && (live[*account]["connectionId"] != job["connectionId"]
                            || mail::read_backoff(&config, &live[*account]).is_none())
                        && job["status"] == "running"
                        && (string(job, "nextRetryAt").is_empty()
                            || string(job, "nextRetryAt") <= now().as_str()
                            || live[*account]["connectionId"] != job["connectionId"])
                })
                .min_by(|a, b| string(a.1, "updatedAt").cmp(string(b.1, "updatedAt")))
                .map(|(account, job)| (account.clone(), job.clone())))
        })
        .await?;
    let Some((account, job)) = entry else {
        return Ok(());
    };
    if connections(&app.settings().await?)[&account]["connectionId"] != job["connectionId"] {
        return app.db(move |db| {
            let current=db.settings()?;
            if current["imports"][&account]["id"]==job["id"] && current["imports"][&account]["status"]=="running" && connections(&current)[&account]["connectionId"]!=job["connectionId"] {
                write_owner(db,"imports",&account,merge(merge(job,&clear_import_failure()),&json!({"status":"paused","error":"Connection changed. Start a new import.","errorCode":"connection_changed","recoveryAction":"restart","updatedAt":now()})))?;
            }
            Ok(())
        }).await;
    }
    let mut stage = "refresh";
    let work = async {
        let mail = mail::current_mail(app, &account).await?;
        if !import_current(&app.settings().await?, &account, &job) {
            return Ok(());
        }
        let folders = import_folders(&job);
        let folder = folders
            .get(job["folderIndex"].as_u64().unwrap_or(0) as usize)
            .ok_or_else(|| Error::invalid("Invalid import folder."))?;
        stage = "fetch";
        let (since, before) = import_window(&job);
        let result = mail::fetch_page(
            app,
            &mail,
            &json!({"folder":folder,"since":since,"before":before,"cursor":job["cursor"]}),
        )
        .await?;
        stage = "commit";
        let (account, job) = (account.clone(), job.clone());
        app.db(move |db| apply_import_page(db, &account, &job, &result))
            .await
    }
    .await;
    if let Err(error) = work {
        let failure = import_failure(&error, stage, &job, Utc::now().timestamp_millis());
        app.db(move |db| {
            if import_current(&db.settings()?, &account, &job) {
                write_owner(db, "imports", &account, merge(job, &failure))?;
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if ctx.method == axum::http::Method::POST
        && ctx.path.len() == 2
        && ctx.path[0].eq_ignore_ascii_case("summaries")
    {
        return manual_summary(app, ctx).await.map(Some);
    }
    if ctx.method != axum::http::Method::POST
        || ctx.path.len() != 2
        || !ctx.path[0].eq_ignore_ascii_case("imports")
    {
        return Ok(None);
    }
    let context = ctx.clone();
    let owner = app
        .db(move |db| {
            let config = db.settings()?;
            let account = context.read_owner(&config, false)?;
            if connections(&config).get(&account).is_none() {
                return Err(Error::conflict("Choose a connected mailbox."));
            }
            if context.path[1].eq_ignore_ascii_case("start") {
                start_import(db, &account, &context.body)?;
            } else {
                control_import(db, &account, &context.path[1].to_ascii_lowercase())?;
            }
            Ok(account)
        })
        .await?;
    Ok(Some(
        Json(app.state(&owner, ctx.paged).await?).into_response(),
    ))
}

/// Calendar-day keys avoid duplicate daily runs during a repeated DST hour.
pub fn summary_due(schedule: &Value, previous: &Value, timestamp: i64) -> Result<Value> {
    let config = serde_json::to_string(schedule)?;
    let same = previous["config"] == config;
    if schedule["cadence"] == "interval" {
        let last = if same {
            previous["lastAt"].as_i64()
        } else {
            Some(timestamp)
        };
        let hours = schedule["everyHours"]
            .as_i64()
            .filter(|hours| (1..=168).contains(hours))
            .ok_or_else(|| Error::invalid("Invalid summary interval."))?;
        return Ok(
            json!({"due":last.is_some_and(|last|timestamp>=last.saturating_add(hours*3600000)),"state":{"config":config,"lastAt":last.unwrap_or(timestamp)}}),
        );
    }
    let zone: chrono_tz::Tz = string(schedule, "timeZone")
        .parse()
        .map_err(|_| Error::invalid("Invalid summary time zone."))?;
    let date = DateTime::from_timestamp_millis(timestamp)
        .ok_or_else(|| Error::invalid("Invalid summary time."))?
        .with_timezone(&zone);
    let day = date.format("%Y-%m-%d").to_string();
    let previous_day = if same { string(previous, "day") } else { "" };
    Ok(
        json!({"due":date.format("%H:%M").to_string().as_str()>=string(schedule,"time") && day.as_str()>previous_day,"day":day,"state":{"config":config,"day":previous_day}}),
    )
}
fn owners(config: &Value) -> Vec<String> {
    let live = connections(config);
    if live.as_object().is_none_or(|live| live.is_empty()) {
        vec!["demo".into()]
    } else {
        live.as_object().unwrap().keys().cloned().collect()
    }
}
fn automation(config: &Value, account: &str) -> Value {
    merge(
        json!({"jobs":[],"schedule":{}}),
        &config["automation"][account],
    )
}
fn signature(config: &Value, account: &str) -> Result<String> {
    let preferences = merge(catalog()["preferences"].clone(), &config["preferences"]);
    let live = connections(config);
    let connection = &live[account];
    let identity = [
        string(connection, "connectionId"),
        string(connection, "email"),
        account,
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or(account);
    digest(&json!([
        policy::resolve(&config["policy"]),
        config["ai"],
        preferences["language"],
        preferences["translationLanguage"],
        preferences["replyTone"],
        identity
    ]))
}
fn enabled(policy: &Value, kind: &str) -> bool {
    let (trigger, behavior) = match kind {
        "arrival" => ("onArrival", "summary"),
        "scheduled" => ("scheduledSummary", "briefing"),
        "manual" => ("", "briefing"),
        _ => return false,
    };
    policy["enabled"] == true
        && (trigger.is_empty() || policy["triggers"][trigger] == true)
        && policy["behaviors"][behavior] == true
        && ["subject", "body", "sender"]
            .iter()
            .any(|field| policy["content"][field] == true)
}
fn eligible(policy: &Value, kind: &str, message: &Value) -> bool {
    enabled(policy, kind)
        && message.is_object()
        && !["drafts", "trash"].contains(&string(message, "folder"))
        && policy["folders"][string(message, "folder")] == true
        && (policy["triggers"]["inboxOnly"] != true || message["folder"] == "inbox")
        && (policy["triggers"]["starredOnly"] != true || message["starred"] == true)
}
fn sources(db: &Store, account: &str, ids: &[Value]) -> Result<Vec<Value>> {
    ids.iter()
        .map(|id| {
            db.get(account, id.as_str().unwrap_or(""))
                .map(|message| message.unwrap_or(Value::Null))
        })
        .collect()
}
fn source_digest(messages: &[Value], policy: &Value) -> Result<String> {
    let values: Vec<_> = messages
        .iter()
        .map(|message| {
            if message.is_null() {
                Value::Null
            } else {
                project(
                    &policy::redact(message, policy),
                    &[
                        "id",
                        "subject",
                        "body",
                        "fromName",
                        "fromEmail",
                        "to",
                        "date",
                    ],
                )
            }
        })
        .collect();
    digest(&json!(values))
}
fn pending(job: &Value) -> bool {
    ["queued", "running"].contains(&string(job, "status"))
}
fn summary_job(db: &Store, account: &str, kind: &str, ids: &[Value]) -> Result<Value> {
    let config = db.settings()?;
    Ok(
        json!({"id":uuid::Uuid::new_v4().to_string(),"kind":kind,"messageIds":ids,"signature":signature(&config,account)?,"generation":config["aiGeneration"].as_u64().unwrap_or(0),"sourceDigest":source_digest(&sources(db,account,ids)?,&policy::resolve(&config["policy"]))?,"createdAt":now(),"status":"queued"}),
    )
}
fn append(db: &Store, account: &str, kind: &str, ids: &[Value]) -> Result<()> {
    let config = db.settings()?;
    let mut value = automation(&config, account);
    let jobs = value["jobs"].as_array().cloned().unwrap_or_default();
    let current: Vec<_> = jobs.iter().filter(|job| pending(job)).cloned().collect();
    // ponytail: 100 pending jobs/account; overflow is visible for manual handling.
    if current.len() >= 100 {
        value["overflow"] = (value["overflow"].as_u64().unwrap_or(0) + 1).into();
    } else {
        let mut history: Vec<_> = jobs
            .iter()
            .filter(|job| !pending(job))
            .rev()
            .take(20)
            .cloned()
            .collect();
        history.reverse();
        history.extend(current);
        history.push(summary_job(db, account, kind, ids)?);
        value["jobs"] = history.into();
    }
    write_owner(db, "automation", account, value)
}
pub fn arrivals(db: &Store, account: &str, ids: &[String]) -> Result<()> {
    let config = db.settings()?;
    if !owners(&config).iter().any(|owner| owner == account) {
        return Ok(());
    }
    let policy = policy::resolve(&config["policy"]);
    if !enabled(&policy, "arrival") {
        return Ok(());
    }
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id)
            && db
                .get(account, id)?
                .is_some_and(|message| policy::matches_trigger(&policy, "onArrival", &message))
        {
            append(db, account, "arrival", &[json!(id)])?;
        }
    }
    Ok(())
}
fn valid_job(db: &Store, account: &str, job: &Value, config: &Value) -> Result<bool> {
    if !owners(config).iter().any(|owner| owner == account)
        || job["signature"] != signature(config, account)?
        || job.get("generation").is_some_and(|generation| {
            generation.as_u64() != Some(config["aiGeneration"].as_u64().unwrap_or(0))
        })
    {
        return Ok(false);
    }
    let Some(ids) = job["messageIds"].as_array() else {
        return Ok(false);
    };
    let policy = policy::resolve(&config["policy"]);
    if ids.is_empty()
        || ids.len() > policy["maxMessages"].as_u64().unwrap_or(8) as usize
        || !enabled(&policy, string(job, "kind"))
    {
        return Ok(false);
    }
    let messages = sources(db, account, ids)?;
    if messages
        .iter()
        .any(|message| !eligible(&policy, string(job, "kind"), message))
    {
        return Ok(false);
    }
    Ok(job["sourceDigest"] == source_digest(&messages, &policy)?)
}
pub fn reports(db: &Store, account: &str) -> Result<Value> {
    let config = db.settings()?;
    if account == "all" || !owners(&config).iter().any(|owner| owner == account) {
        return Ok(json!([]));
    }
    let value = automation(&config, account);
    let mut result = Vec::new();
    for job in value["jobs"].as_array().into_iter().flatten().rev() {
        if valid_job(db, account, job, &config)? {
            result.push(project(
                job,
                &[
                    "id",
                    "kind",
                    "messageIds",
                    "createdAt",
                    "completedAt",
                    "status",
                    "source",
                    "text",
                    "items",
                    "error",
                ],
            ));
            if result.len() == 20 {
                break;
            }
        }
    }
    Ok(result.into())
}
pub fn overflow(db: &Store, account: &str) -> Result<u64> {
    let config = db.settings()?;
    Ok(if owners(&config).iter().any(|owner| owner == account) {
        config["automation"][account]["overflow"]
            .as_u64()
            .unwrap_or(0)
    } else {
        0
    })
}
pub fn state(db: &Store, account: &str) -> Result<Value> {
    Ok(json!({"summaries":reports(db,account)?,"summaryOverflow":overflow(db,account)?}))
}
fn update_job(db: &Store, account: &str, id: &str, patch: &Value) -> Result<()> {
    let mut value = automation(&db.settings()?, account);
    let jobs: Vec<_> = value["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|job| {
            if job["id"] == id {
                merge(job.clone(), patch)
            } else {
                job.clone()
            }
        })
        .collect();
    let recent: HashSet<_> = jobs
        .iter()
        .filter(|job| !pending(job))
        .rev()
        .take(20)
        .map(|job| string(job, "id"))
        .collect();
    value["jobs"] = jobs
        .iter()
        .filter(|job| pending(job) || recent.contains(string(job, "id")))
        .cloned()
        .collect();
    write_owner(db, "automation", account, value)
}
/// Restore interrupted read retries, but never replay claimed paid work.
pub fn recover(db: &Store) -> Result<()> {
    let config = db.settings()?;
    let live = connections(&config);
    for (account, job) in config["imports"].as_object().into_iter().flatten() {
        let code = string(job, "errorCode");
        if job["status"] != "failed"
            || !["rate_limited", "network_error", "provider_unavailable"].contains(&code)
            || string(job, "connectionId").is_empty()
            || live[account]["connectionId"] != job["connectionId"]
        {
            continue;
        }
        // Old rate_limited records do not distinguish daily quotas: wait a day from the failure.
        let delay = chrono::Duration::hours(if code == "rate_limited" { 24 } else { 1 });
        let retry_at = DateTime::parse_from_rfc3339(string(job, "updatedAt"))
            .map(|date| date.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now())
            .checked_add_signed(delay)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        write_owner(
            db,
            "imports",
            account,
            merge(
                job.clone(),
                &json!({"status":"running","recoveryAction":"retry","nextRetryAt":retry_at,"updatedAt":now()}),
            ),
        )?;
    }
    for (account, value) in config["automation"].as_object().into_iter().flatten() {
        for job in value["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|job| job["status"] == "running")
        {
            update_job(
                db,
                account,
                string(job, "id"),
                &json!({"status":"interrupted","error":"Interrupted by app shutdown. Generate again manually if needed."}),
            )?;
        }
    }
    Ok(())
}
pub fn reset_schedules(db: &Store) -> Result<()> {
    reset_schedules_at(db, Utc::now().timestamp_millis())
}
fn reset_schedules_at(db: &Store, timestamp: i64) -> Result<()> {
    let config = db.settings()?;
    let schedule = &policy::resolve(&config["policy"])["summarySchedule"];
    for account in owners(&config) {
        let mut value = automation(&db.settings()?, &account);
        value["schedule"] = summary_due(schedule, &json!({}), timestamp)?["state"].clone();
        write_owner(db, "automation", &account, value)?;
    }
    Ok(())
}
pub fn schedule(db: &Store, timestamp: i64) -> Result<()> {
    let config = db.settings()?;
    let policy = policy::resolve(&config["policy"]);
    if !enabled(&policy, "scheduled") {
        return Ok(());
    }
    for account in owners(&config) {
        let ids = summary_ids(db, &account, &policy)?;
        if ids.is_empty() {
            continue;
        }
        let mut value = automation(&db.settings()?, &account);
        let due = summary_due(&policy["summarySchedule"], &value["schedule"], timestamp)?;
        if due["due"] == true {
            db.transaction(|db| {
                value["schedule"] = due["state"].clone();
                if let Some(day) = due.get("day") {
                    value["schedule"]["day"] = day.clone();
                }
                value["schedule"]["lastAt"] = timestamp.into();
                write_owner(db, "automation", &account, value)?;
                append(db, &account, "scheduled", &ids)
            })?;
        } else if value["schedule"] != due["state"] {
            value["schedule"] = due["state"].clone();
            write_owner(db, "automation", &account, value)?;
        }
    }
    Ok(())
}
fn summary_ids(db: &Store, account: &str, policy: &Value) -> Result<Vec<Value>> {
    let folders: Vec<_> = ["inbox", "sent", "archive"]
        .into_iter()
        .filter(|folder| {
            policy["folders"][folder] == true
                && (policy["triggers"]["inboxOnly"] != true || *folder == "inbox")
        })
        .collect();
    if folders.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id FROM messages WHERE account=? AND json_extract(data,'$.folder') IN ({}) {} ORDER BY COALESCE(json_extract(data,'$.pending'),0) DESC,COALESCE(json_extract(data,'$.starred'),0) DESC,COALESCE(json_extract(data,'$.read'),0) ASC,json_extract(data,'$.date') DESC,id LIMIT ?",
        vec!["?"; folders.len()].join(","),
        if policy["triggers"]["starredOnly"] == true {
            "AND json_extract(data,'$.starred')=1"
        } else {
            ""
        }
    );
    let mut params: Vec<rusqlite::types::Value> = vec![account.to_owned().into()];
    params.extend(
        folders
            .iter()
            .map(|folder| rusqlite::types::Value::Text((*folder).into())),
    );
    params.push(
        policy["maxMessages"]
            .as_i64()
            .unwrap_or(8)
            .clamp(1, 50)
            .into(),
    );
    Ok(db
        .conn
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(params), |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| row.map(Value::String))
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

async fn manual_summary(app: &App, ctx: &Context) -> Result<Response> {
    let action = ctx.path[1].to_ascii_lowercase();
    let fields = ctx
        .body
        .as_object()
        .ok_or_else(|| Error::invalid("Invalid summary request."))?;
    if !matches!(action.as_str(), "preview" | "generate")
        || (action == "preview" && !fields.is_empty())
        || (action == "generate"
            && (fields.len() != 1 || string(&ctx.body, "previewId").is_empty()))
    {
        return Err(Error::invalid(
            "Review a summary preview before generating.",
        ));
    }
    let _guard = if action == "generate" {
        Some(app.0.background.gate.try_lock().map_err(|_| {
            Error::conflict("Automatic assistance is busy. Try again when it finishes.")
        })?)
    } else {
        None
    };
    let shutdown = app.0.background.shutdown.notified();
    tokio::pin!(shutdown);
    shutdown.as_mut().enable();
    if app.0.background.stopped.load(Ordering::Acquire) {
        return Err(Error::conflict("The service is shutting down."));
    }
    let context = ctx.clone();
    let generating = action == "generate";
    let (account, job, model_context) = app.db(move |db| db.transaction(|db| {
        let config = db.settings()?;
        let account = context.read_owner(&config, false)?;
        if connections(&config).get(&account).is_none() {
            return Err(Error::conflict("Choose an individual connected mailbox."));
        }
        let policy = policy::resolve(&config["policy"]);
        policy::require(&policy, "briefing")?;
        if !enabled(&policy, "manual") {
            return Err(Error::new(403, "Allow subject, body or sender access in AI & privacy first."));
        }
        if string(&config["ai"], "baseUrl").is_empty() || string(&config["ai"], "model").is_empty() {
            return Err(Error::conflict("Save an AI model in Settings first."));
        }
        let mut value = automation(&config, &account);
        if value["jobs"].as_array().into_iter().flatten().any(|job| job["kind"] == "manual" && pending(job)) {
            return Err(Error::conflict("A manual summary is already in progress for this mailbox."));
        }
        if generating {
            let job = value["manualPreview"].clone();
            if job["id"] != context.body["previewId"] || job["kind"] != "manual" || !valid_job(db, &account, &job, &config)? {
                return Err(Error::conflict("The summary preview changed or expired. Review it again."));
            }
            let mut jobs = value["jobs"].as_array().cloned().unwrap_or_default();
            if jobs.iter().filter(|job| pending(job)).count() >= 100 {
                return Err(Error::conflict("The summary queue is full. Wait for current jobs to finish."));
            }
            jobs.push(job.clone());
            value["jobs"] = jobs.into(); value["manualPreview"] = Value::Null;
            write_owner(db, "automation", &account, value)?;
            let model_context = claim(db, &account, &job)?.ok_or_else(|| Error::conflict("The summary context changed. Review it again."))?;
            Ok((account, job, model_context))
        } else {
            let ids = summary_ids(db, &account, &policy)?;
            if ids.is_empty() {
                return Err(Error::conflict("No downloaded messages match the saved summary permissions and filters."));
            }
            let job = summary_job(db, &account, "manual", &ids)?;
            value["manualPreview"] = job.clone();
            write_owner(db, "automation", &account, value)?;
            let messages: Vec<_> = sources(db, &account, &ids)?.iter().map(|m| project(&policy::redact(m, &policy), &["id", "subject", "fromEmail", "folder", "date"])).collect();
            Ok((account.clone(), job.clone(), json!({"accountId":account,"previewId":job["id"],"messages":messages,"model":project(&config["ai"], &["baseUrl", "model"]),"content":policy["content"]})))
        }
    })).await?;
    if !generating {
        return Ok(Json(model_context).into_response());
    }
    let report_id = string(&job, "id").to_owned();
    tokio::select! {
        _ = &mut shutdown => return Err(Error::conflict("Summary interrupted by shutdown. Review before generating again.")),
        result = generate(app, &account, &job, &model_context) => {
            let owner = account.clone();
            app.db(move |db| finish(db, &owner, &job, &model_context, result)).await?;
        }
    }
    Ok(Json(
        app.db(move |db| {
            let config = db.settings()?;
            let value = automation(&config, &account);
            let report = value["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|job| job["id"] == report_id)
                .cloned()
                .unwrap_or(Value::Null);
            Ok(merge(
                state(db, &account)?,
                &project(&report, &["status", "error"]),
            ))
        })
        .await?,
    )
    .into_response())
}

fn claim(db: &Store, account: &str, job: &Value) -> Result<Option<Value>> {
    db.transaction(|db| {
        let config = db.settings()?;
        let value = automation(&config,account);
        if !value["jobs"].as_array().into_iter().flatten().any(|current|current["id"]==job["id"]&&current["status"]=="queued") { return Ok(None); }
        if !valid_job(db,account,job,&config)? {
            update_job(db,account,string(job,"id"),&json!({"status":"skipped","error":"Permissions, model, account or source messages changed."}))?;
            return Ok(None);
        }
        let policy = policy::resolve(&config["policy"]);
        // Authorize all sources before constructing any model context.
        let messages = job["messageIds"].as_array().unwrap().iter().map(|id|db.get(account,id.as_str().unwrap_or("")).map(|message|policy::redact(&message.unwrap_or(Value::Null),&policy))).collect::<Result<Vec<_>>>()?;
        let brain = crate::brain::context(db,&config,account,&Value::Null)?;
        let options = json!({"preferences":merge(catalog()["preferences"].clone(),&config["preferences"]),"brain":brain,"styleVoice":"","structuredSummary":true,"timeZone":policy["summarySchedule"]["timeZone"]});
        update_job(db,account,string(job,"id"),&json!({"status":"running"}))?;
        Ok(Some(json!({"ai":config["ai"],"messages":messages,"options":options,"generation":ai::generation(&config,account),"brain":options["brain"]})))
    })
}
async fn generate(app: &App, account: &str, job: &Value, context: &Value) -> Result<Value> {
    let messages = context["messages"]
        .as_array()
        .ok_or_else(|| Error::invalid("Invalid summary context."))?;
    let configured = !string(&context["ai"], "model").is_empty()
        && !string(&context["ai"], "baseUrl").is_empty();
    if !configured {
        if account != "demo" {
            return Err(Error::conflict(
                "Choose an AI model in Settings to use assistance with your mailbox.",
            ));
        }
        let text = ai::demo_assistance("summary", messages, "", &context["options"]);
        return Ok(merge(
            priority_summary(&text, messages)?,
            &json!({"source":"demo"}),
        ));
    }
    let action = if job["kind"] == "arrival" {
        "summary"
    } else {
        "briefing"
    };
    let result = ai::run_model(
        &app.0.client,
        &context["ai"],
        action,
        messages,
        "",
        &context["options"],
    )
    .await?;
    Ok(merge(
        priority_summary(string(&result, "text"), messages)?,
        &json!({"source":"model"}),
    ))
}
fn finish(
    db: &Store,
    account: &str,
    job: &Value,
    context: &Value,
    result: Result<Value>,
) -> Result<()> {
    db.transaction(|db| {
        let config = db.settings()?;
        let value = automation(&config, account);
        if !value["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|current| current["id"] == job["id"] && current["status"] == "running")
        {
            return Ok(());
        }
        let brain_changed =
            crate::brain::context(db, &config, account, &Value::Null)? != context["brain"];
        let patch = if !valid_job(db, account, job, &config)?
            || ai::generation(&config, account) != context["generation"]
            || brain_changed
        {
            json!({"status":"skipped","error":"Context changed; the result was discarded."})
        } else {
            match result {
                Ok(value) => merge(value, &json!({"status":"completed","completedAt":now()})),
                // generate returns server-authored diagnostics, never provider/model response bodies.
                Err(error) => json!({"status":"failed","error":error.to_string()}),
            }
        };
        update_job(db, account, string(job, "id"), &patch)
    })
}
async fn automation_tick(app: &App) -> Result<()> {
    let queued = app
        .db(|db| {
            schedule(db, Utc::now().timestamp_millis())?;
            let config = db.settings()?;
            let mut queued = Vec::new();
            for account in owners(&config) {
                for job in automation(&config, &account)["jobs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|job| job["status"] == "queued")
                {
                    queued.push((account.clone(), job.clone()));
                }
            }
            queued.sort_by(|a, b| string(&a.1, "createdAt").cmp(string(&b.1, "createdAt")));
            Ok(queued)
        })
        .await?;
    let mut count = 0;
    for (account, job) in queued {
        if app.0.background.stopped.load(Ordering::Acquire) || count >= 4 {
            break;
        }
        let (owner, queued_job) = (account.clone(), job.clone());
        let Some(context) = app.db(move |db| claim(db, &owner, &queued_job)).await? else {
            continue;
        };
        count += 1;
        let result = generate(app, &account, &job, &context).await;
        app.db(move |db| finish(db, &account, &job, &context, result))
            .await?;
    }
    Ok(())
}
/// Called by the sole service lifecycle owner, normally every thirty seconds.
pub async fn tick(app: &App) -> Result<()> {
    let runtime = &app.0.background;
    let Ok(_guard) = runtime.gate.try_lock() else {
        return Ok(());
    };
    if runtime.stopped.load(Ordering::Acquire) {
        return Ok(());
    }
    let shutdown = runtime.shutdown.notified();
    tokio::pin!(shutdown);
    shutdown.as_mut().enable();
    if runtime.stopped.load(Ordering::Acquire) {
        return Ok(());
    }
    tokio::select! {
        biased;
        _ = &mut shutdown => Ok(()),
        result = async {
            let config = app.settings().await?;
            let interval = config["preferences"]["syncInterval"].as_i64().unwrap_or(0);
            let timestamp = Utc::now().timestamp_millis();
            let scheduled = due_sync_accounts(&config, &now());
            let regular = interval>0 && timestamp>=runtime.last_sync.load(Ordering::Acquire).saturating_add(interval.saturating_mul(60000));
            if (regular || !scheduled.is_empty()) && let Ok(_mailbox) = app.0.mailbox.try_lock() {
                if regular {
                    // Claim only an acquired polling slot; a busy mailbox stays due for the next tick.
                    runtime.last_sync.store(timestamp,Ordering::Release);
                }
                let accounts: Vec<_> = if regular { connections(&config).as_object().unwrap().keys().cloned().collect() } else { scheduled };
                let _ = mail::sync_accounts(app,&accounts).await;
            }
            history_tick(app).await?;
            crate::learning::scheduled_tick(app).await?;
            crate::brain::scheduled_tick(app).await?;
            automation_tick(app).await
        } => result,
    }
}
fn due_sync_accounts(config: &Value, timestamp: &str) -> Vec<String> {
    let live = connections(config);
    config["backgroundSyncErrors"]
        .as_array()
        .into_iter()
        .flat_map(|errors| errors.iter())
        .filter(|error| {
            live.get(string(error, "accountId")).is_some()
                && ((error["code"] == "rate_limited"
                    && !string(error, "nextRetryAt").is_empty()
                    && string(error, "nextRetryAt") <= timestamp)
                    || error["code"] == "provider_quota_exceeded")
        })
        .map(|error| string(error, "accountId").to_owned())
        .collect()
}
pub fn stop(app: &App) {
    app.0.background.stopped.store(true, Ordering::Release);
    app.0.background.shutdown.notify_waiters();
}

#[cfg(test)]
mod history_retry_tests {
    use super::*;

    #[tokio::test]
    async fn busy_mailbox_keeps_regular_sync_due_until_the_next_tick() {
        let root = std::env::temp_dir().join(format!("morrow-busy-sync-{}", uuid::Uuid::new_v4()));
        let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
        let owner = "busy@example.invalid";
        app.db(move |db| {
            // No socket is opened: a fetched IMAP page fails on the invalid port.
            db.set_settings(&json!({"mailAccounts":{owner:{"email":owner,"provider":"imap","connectionId":"fixture","imapPort":0}},"preferences":{"syncInterval":1}}))?;
            Ok(())
        }).await.unwrap();
        let previous = Utc::now().timestamp_millis() - 120_000;
        app.0
            .background
            .last_sync
            .store(previous, Ordering::Release);
        let mailbox = app.0.mailbox.lock().await;
        tick(&app).await.unwrap();
        assert_eq!(app.0.background.last_sync.load(Ordering::Acquire), previous);
        assert!(app.settings().await.unwrap()["backgroundSyncErrors"].is_null());
        drop(mailbox);
        tick(&app).await.unwrap();
        let attempted = app.0.background.last_sync.load(Ordering::Acquire);
        assert!(attempted > previous);
        let errors = app.settings().await.unwrap()["backgroundSyncErrors"].clone();
        assert_eq!(errors.as_array().unwrap().len(), 1);
        assert_eq!(errors[0]["accountId"], owner);
        assert_eq!(errors[0]["code"], "mail_sync_failed");
        // A real attempt, even a failed read, still observes the configured interval.
        tick(&app).await.unwrap();
        assert_eq!(
            app.0.background.last_sync.load(Ordering::Acquire),
            attempted
        );
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quota_and_transient_reads_retry_without_exposing_details() {
        let mut network = Error::new(502, "private provider detail");
        network.body["code"] = "provider_network".into();
        let first = import_failure(&network, "fetch", &json!({}), 0);
        assert_eq!(first["status"], "running");
        assert_eq!(first["errorCode"], "network_error");
        assert_eq!(first["nextRetryAt"], "1970-01-01T00:00:30.000Z");
        assert!(!first.to_string().contains("private provider detail"));
        for stage in ["commit", "refresh"] {
            let result = import_failure(&network, stage, &json!({}), 0);
            assert_eq!(result["status"], "failed");
            assert!(result["nextRetryAt"].is_null());
            assert_eq!(result["recoveryAction"], "resume");
        }
        for (status, expected) in [
            (401, "reconnect"),
            (403, "reconnect"),
            (400, "resume"),
            (409, "resume"),
        ] {
            let mut error = Error::new(502, "private response");
            error.provider_status = Some(status);
            let result = import_failure(&error, "fetch", &json!({}), 0);
            assert_eq!(result["status"], "failed");
            assert_eq!(result["recoveryAction"], expected);
        }
        let mut quota = Error::new(502, "private quota detail");
        quota.provider_status = Some(403);
        quota.body["code"] = "provider_quota_exceeded".into();
        let result = import_failure(&quota, "fetch", &json!({}), 0);
        assert_eq!(result["errorCode"], "rate_limited");
        assert_eq!(result["status"], "running");
        assert_eq!(result["recoveryAction"], "retry");
        assert_eq!(result["nextRetryAt"], "1970-01-01T00:01:00.000Z");
        assert!(!result.to_string().contains("private quota detail"));
        let later = import_failure(
            &quota,
            "fetch",
            &json!({"errorCode":"network_error","retryCount":3}),
            0,
        );
        assert_eq!(later["status"], "running");
        assert_eq!(later["recoveryAction"], "retry");
        assert_eq!(later["nextRetryAt"], "1970-01-01T00:15:00.000Z");
        quota.body["code"] = "provider_daily_quota_exceeded".into();
        let daily = import_failure(&quota, "fetch", &json!({}), 0);
        assert_eq!(daily["errorCode"], "rate_limited");
        assert_eq!(daily["status"], "running");
        assert_eq!(daily["recoveryAction"], "retry");
        assert_eq!(daily["nextRetryAt"], "1970-01-02T00:00:00.000Z");
        for message in [
            "The provider returned an unreadable response.",
            "The provider response exceeds the size limit.",
        ] {
            let result = import_failure(&Error::new(502, message), "fetch", &json!({}), 0);
            assert_eq!(result["status"], "failed");
            assert!(result["nextRetryAt"].is_null());
        }
        for message in ["Invalid import page.", "Repeated import page."] {
            let result = import_failure(&Error::new(502, message), "commit", &json!({}), 0);
            assert_eq!(result["status"], "failed");
            assert_eq!(result["recoveryAction"], "restart");
        }
        let mut provider = Error::new(502, "private provider failure");
        provider.provider_status = Some(503);
        assert_eq!(
            import_failure(&provider, "commit", &json!({}), 0)["errorCode"],
            "storage_error"
        );
        for (count, seconds) in [
            (0_u64, 30),
            (1, 120),
            (2, 300),
            (3, 900),
            (4, 3600),
            (u64::MAX, 3600),
        ] {
            let result = import_failure(
                &provider,
                "fetch",
                &json!({"errorCode":"provider_unavailable","retryCount":count}),
                0,
            );
            assert_eq!(
                DateTime::parse_from_rfc3339(string(&result, "nextRetryAt"))
                    .unwrap()
                    .timestamp(),
                seconds
            );
            assert_eq!(result["retryCount"], count.saturating_add(1));
        }
    }

    #[test]
    fn only_due_connected_quota_syncs_are_scheduled() {
        let config = json!({"mailAccounts":{"due@example.com":{"email":"due@example.com"},"later@example.com":{"email":"later@example.com"},"legacy@example.com":{"email":"legacy@example.com"}},"backgroundSyncErrors":[
            {"accountId":"due@example.com","code":"rate_limited","nextRetryAt":"2026-01-01T00:00:00.000Z"},
            {"accountId":"later@example.com","code":"rate_limited","nextRetryAt":"2026-01-02T00:00:00.000Z"},
            {"accountId":"gone@example.com","code":"rate_limited","nextRetryAt":"2026-01-01T00:00:00.000Z"},
            {"accountId":"legacy@example.com","code":"provider_quota_exceeded"},
            {"accountId":"due@example.com","code":"oauth_reconnect_required","nextRetryAt":"2026-01-01T00:00:00.000Z"}
        ]});
        assert_eq!(
            due_sync_accounts(&config, "2026-01-01T00:00:00.000Z"),
            vec!["due@example.com", "legacy@example.com"]
        );
    }
}
