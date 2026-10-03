//! Reviewed embedding batches and bounded HTTP search. All durable queue entries
//! contain identities/hashes only; text is reconstructed after permission checks.
use crate::{
    error::{Error, Result},
    pages, policy,
    search_query::{self as query, Query},
    service::{App, Context, connections},
    store::{Store, merge, now, string},
    validation,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{Months, SecondsFormat, Utc};
use futures_util::StreamExt;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as Sql};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, watch};
use zeroize::Zeroizing;

// Bump when permitted-text construction, chunking or vector normalization changes.
const INDEX_VERSION: u32 = 1;

#[derive(Default)]
pub struct SmartState {
    worker: Mutex<()>,
    scan: Mutex<String>,
    query_gate: Mutex<()>,
    test_gate: Mutex<()>,
    cache: Mutex<VecDeque<CachedQuery>>,
    initialized: AtomicBool,
    cancellation: watch::Sender<u64>,
}
impl SmartState {
    /// Hosts may call this after a permission/connection mutation to stop HTTP
    /// immediately; persisted generation checks remain the authority on results.
    pub async fn invalidate(&self) {
        self.cancellation
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        self.cache.lock().await.clear();
    }
}
struct CachedQuery {
    key: String,
    stamp: String,
    vector: Zeroizing<Vec<f64>>,
    until: Instant,
}
fn defaults() -> Value {
    json!({"enabled":false,"autoIndex":false,"dailyTokenBudget":100000,"baseUrl":"http://127.0.0.1:11434/v1","model":"","protocol":"openai","accounts":[],"months":0,"tokenBudget":16000,"folders":{"inbox":true,"sent":true,"archive":true,"drafts":false,"trash":false},"content":{"subject":true,"body":true,"sender":false}})
}
fn config(settings: &Value) -> Value {
    let defaults = defaults();
    let mut result = merge(defaults.clone(), &settings["searchAI"]);
    // Keep an older implicit three-month scope until its owner reviews expansion.
    if settings["searchAI"].is_object() && settings["searchAI"]["months"].is_null() {
        result["months"] = 3.into();
    }
    for group in ["folders", "content"] {
        result[group] = merge(defaults[group].clone(), &settings["searchAI"][group]);
    }
    result
}
fn scope_stamp(settings: &Value) -> String {
    let mut value = config(settings);
    value
        .as_object_mut()
        .unwrap()
        .retain(|key, _| !matches!(key.as_str(), "autoIndex" | "dailyTokenBudget"));
    let live = connections(settings);
    let identities = value["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|account| {
            let account = account.as_str().unwrap_or("");
            json!([
                account,
                live[account]
                    .get("connectionId")
                    .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                    .unwrap_or(&live[account])
            ])
        })
        .collect::<Vec<_>>();
    query::digest(&json!([
        INDEX_VERSION,
        value,
        policy::resolve(&settings["policy"]),
        identities
    ]))
}
pub(crate) fn ask_stamp(settings: &Value) -> String {
    stamp(settings)
}
pub(crate) async fn ask(app: &App, owner: &str, prompt: &str) -> Result<Value> {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "x-genmail-account",
        owner
            .parse()
            .map_err(|_| Error::invalid("Invalid mailbox."))?,
    );
    let context = Context {
        method: axum::http::Method::POST,
        path: vec!["search".into()],
        body: json!({"query":prompt,"scope":"account","smart":true}),
        query: json!({}),
        headers,
        owner: owner.into(),
        paged: true,
    };
    let mut options = query::parse(&json!({"scope":"account","smart":true}))?;
    options.query = validation::text(&json!(prompt), "Ask question", 500, false)?
        .trim()
        .into();
    options.terms = vec![crate::normalize::normalize(&options.query)];
    search(app, &context, options).await
}
fn stamp(settings: &Value) -> String {
    query::digest(&json!([
        scope_stamp(settings),
        settings["searchGeneration"]
    ]))
}
fn since(value: &Value) -> String {
    if value["months"] == 0 {
        return String::new();
    }
    Utc::now()
        .checked_sub_months(Months::new(value["months"].as_u64().unwrap_or(3) as u32))
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn permitted(value: &Value, policy: &Value, live: &Value, account: &str) -> bool {
    value["enabled"] == true
        && policy["enabled"] == true
        && live.get(account).is_some()
        && value["accounts"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == account))
}
fn allowed_folders(value: &Value, policy: &Value) -> Vec<String> {
    ["inbox", "sent", "archive", "drafts", "trash"]
        .into_iter()
        .filter(|folder| value["folders"][*folder] == true && policy["folders"][*folder] == true)
        .map(str::to_owned)
        .collect()
}
// Only selected fields enter the source projection, even for local indexing.
fn projection(value: &Value, policy: &Value) -> String {
    let mut fields = Vec::new();
    if value["content"]["sender"] == true && policy["content"]["sender"] == true {
        fields.extend(["fromName", "fromEmail", "to", "cc", "bcc"]);
    }
    if value["content"]["subject"] == true && policy["content"]["subject"] == true {
        fields.push("subject");
    }
    if value["content"]["body"] == true && policy["content"]["body"] == true {
        fields.push("body");
    }
    format!(
        "json_object({})",
        fields
            .iter()
            .flat_map(|field| [
                format!("'{field}'"),
                format!("COALESCE(json_extract(m.data,'$.{field}'),'')")
            ])
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn source_text(projected: &str) -> Result<Option<(String, String)>> {
    let message: Value = serde_json::from_str(projected)?;
    let mut fields = Vec::new();
    if message.get("fromName").is_some() {
        fields.push(
            ["fromName", "fromEmail", "to", "cc", "bcc"]
                .into_iter()
                .map(|key| string(&message, key))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    for key in ["subject", "body"] {
        if message.get(key).is_some() {
            fields.push(string(&message, key).to_owned());
        }
    }
    let text = fields.join("\n").trim().to_owned();
    Ok((!text.is_empty()).then(|| (query::digest(&json!(text)), text)))
}
fn source(
    db: &Store,
    settings: &Value,
    account: &str,
    id: &str,
) -> Result<Option<(String, String)>> {
    let value = config(settings);
    let policy = policy::resolve(&settings["policy"]);
    if !permitted(&value, &policy, &connections(settings), account) {
        return Ok(None);
    }
    let folders = allowed_folders(&value, &policy);
    let sql = format!(
        "SELECT {} FROM messages m WHERE m.account=? AND m.id=? AND json_extract(m.data,'$.date')>=? AND json_extract(m.data,'$.folder') IN ({})",
        projection(&value, &policy),
        query::placeholders(folders.len())
    );
    let mut params: Vec<Sql> = vec![
        account.to_owned().into(),
        id.to_owned().into(),
        since(&value).into(),
    ];
    params.extend(folders.into_iter().map(Sql::Text));
    db.conn
        .query_row(&sql, params_from_iter(params), |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .map(|text| source_text(&text))
        .transpose()
        .map(Option::flatten)
}
/// Call in the same DB critical section as changes to permissions/connections.
/// Pending chunks belong only to the current, explicitly reviewed queue.
pub fn reconcile(db: &Store) -> Result<()> {
    let mut settings = db.settings()?;
    let scope = scope_stamp(&settings);
    // A revoke/restore cycle must not revive an old in-flight request or cache.
    if settings["searchScope"] != scope {
        settings = db.set_settings(
            &json!({"searchScope":scope,"searchGeneration":uuid::Uuid::new_v4().to_string()}),
        )?;
    }
    // SQLite's unconditional DELETE dirties an empty table too. Keep idle
    // reconciliation read-only after recording any permission generation change.
    if !db
        .conn
        .query_row("SELECT EXISTS(SELECT 1 FROM search_vectors)", [], |row| {
            row.get::<_, bool>(0)
        })?
    {
        return Ok(());
    }
    let value = config(&settings);
    let identity = stamp(&settings);
    let policy = policy::resolve(&settings["policy"]);
    if value["enabled"] != true || policy["enabled"] != true {
        db.conn.execute("DELETE FROM search_vectors", [])?;
        return Ok(());
    }
    let pending = if settings["searchIndex"]["stamp"] == identity
        && !matches!(
            string(&settings["searchIndex"], "status"),
            "cancelled" | "complete"
        ) {
        format!(
            "pending:{}:{identity}",
            string(&settings["searchIndex"], "id")
        )
    } else {
        String::new()
    };
    db.conn.execute(
        "DELETE FROM search_vectors WHERE stamp<>? AND stamp<>?",
        params![identity, pending],
    )?;
    // Revoke vectors when their source leaves the permitted time/folder scope.
    let folders = allowed_folders(&value, &policy);
    let sql = format!(
        "DELETE FROM search_vectors WHERE NOT EXISTS(SELECT 1 FROM messages m WHERE m.account=search_vectors.account AND m.id=search_vectors.id AND json_extract(m.data,'$.date')>=? AND json_extract(m.data,'$.folder') IN ({}))",
        query::placeholders(folders.len())
    );
    let mut params: Vec<Sql> = vec![since(&value).into()];
    params.extend(folders.into_iter().map(Sql::Text));
    db.conn.execute(&sql, params_from_iter(params))?;
    Ok(())
}
struct Inventory {
    eligible: u64,
    ready: u64,
    sources: Vec<Value>,
    samples: Vec<Value>,
    tokens: u64,
    pieces: usize,
    oversized: u64,
    over_budget: u64,
    daily_limit: u64,
    budget_blocked: u64,
}
fn chunks(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut output = Vec::new();
    for start in (0..chars.len()).step_by(920) {
        let end = (start + 1000).min(chars.len());
        output.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
    }
    output
}
fn inventory(db: &Store, preview: bool) -> Result<Inventory> {
    inventory_with_budget(db, preview, None)
}
fn inventory_with_budget(db: &Store, preview: bool, remaining: Option<u64>) -> Result<Inventory> {
    reconcile(db)?;
    let settings = db.settings()?;
    let value = config(&settings);
    let policy = policy::resolve(&settings["policy"]);
    let live = connections(&settings);
    let identity = stamp(&settings);
    let mut inventory = Inventory {
        eligible: 0,
        ready: 0,
        sources: vec![],
        samples: vec![],
        tokens: 0,
        pieces: 0,
        oversized: 0,
        over_budget: 0,
        daily_limit: 0,
        budget_blocked: 0,
    };
    if value["enabled"] != true || policy["enabled"] != true {
        return Ok(inventory);
    }
    let folders = allowed_folders(&value, &policy);
    let sql = format!(
        "SELECT m.id,{},(SELECT hash FROM search_vectors v WHERE v.account=m.account AND v.id=m.id AND v.stamp=? LIMIT 1) FROM messages m WHERE m.account=? AND json_extract(m.data,'$.date')>=? AND json_extract(m.data,'$.folder') IN ({}) ORDER BY json_extract(m.data,'$.date') DESC,m.id",
        projection(&value, &policy),
        query::placeholders(folders.len())
    );
    let mut statement = db.conn.prepare(&sql)?;
    for account in value["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|a| permitted(&value, &policy, &live, a))
    {
        let mut params: Vec<Sql> = vec![
            identity.clone().into(),
            account.to_owned().into(),
            since(&value).into(),
        ];
        params.extend(folders.iter().cloned().map(Sql::Text));
        let mut rows = statement.query(params_from_iter(params))?;
        while let Some(row) = rows.next()? {
            let Some((hash, text)) = source_text(&row.get::<_, String>(1)?)? else {
                continue;
            };
            inventory.eligible += 1;
            if row.get::<_, Option<String>>(2)?.as_deref() == Some(&hash) {
                inventory.ready += 1;
                continue;
            }
            // At most 50 chunks can ever be sent for one reviewed source.
            if text.chars().count() > 46_080 {
                inventory.oversized += 1;
                continue;
            }
            let parts = chunks(&text);
            let cost = parts.iter().map(|p| p.len() as u64 + 128).sum::<u64>();
            let budget = value["tokenBudget"].as_u64().unwrap_or(16000);
            if parts.len() > 50 {
                inventory.oversized += 1;
                continue;
            }
            if cost > budget {
                inventory.over_budget += 1;
                continue;
            }
            if remaining.is_some()
                && value["autoIndex"] == true
                && parts.iter().any(|p| {
                    p.len() as u64 + 128 > value["dailyTokenBudget"].as_u64().unwrap_or(100000)
                })
            {
                inventory.daily_limit += 1;
                continue;
            }
            if parts[0].len() as u64 + 128 > remaining.unwrap_or(u64::MAX) {
                inventory.budget_blocked += 1;
                continue;
            }
            if !preview {
                continue;
            }
            if inventory.sources.len()
                >= policy["maxMessages"].as_u64().unwrap_or(20).min(50) as usize
                || inventory.pieces + parts.len() > 50
                || inventory.tokens + cost > budget
            {
                continue;
            }
            inventory
                .sources
                .push(json!({"account":account,"id":row.get::<_,String>(0)?,"hash":hash}));
            inventory.tokens += cost;
            inventory.pieces += parts.len();
            if inventory.samples.len() < 3 {
                inventory.samples.push(
                    json!({"account":account,"text":text.chars().take(1500).collect::<String>()}),
                );
            }
        }
    }
    Ok(inventory)
}
pub fn state(db: &Store) -> Result<Value> {
    let remaining = daily_remaining(&db.settings()?);
    let inventory = inventory_with_budget(db, false, Some(remaining))?;
    let settings = db.settings()?;
    let mut value = config(&settings);
    let local = url::Url::parse(string(&value, "baseUrl")).is_ok_and(|url| {
        url.host_str()
            .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]"].contains(&host))
    });
    value["hasApiKey"] = (!string(&value, "apiKey").is_empty()).into();
    value.as_object_mut().unwrap().remove("apiKey");
    let mut job = settings["searchIndex"].clone();
    if job["stamp"] != stamp(&settings) {
        job = Value::Null;
    } else if let Some(object) = job.as_object_mut() {
        let count = object
            .get("sources")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        for key in ["stamp", "sources", "inflight"] {
            object.remove(key);
        }
        object.insert("sampleCount".into(), count.into());
    }
    let pending = inventory.eligible - inventory.ready;
    let skipped = inventory.oversized + inventory.over_budget + inventory.daily_limit;
    let waiting = automatic_approved(&settings)
        && !["paused", "failed", "interrupted", "cancelled", "prepared"]
            .contains(&string(&job, "status"))
        && pending > skipped
        && (job["status"] == "budget_wait" || inventory.budget_blocked == pending - skipped);
    Ok(
        json!({"settings":value,"eligible":inventory.eligible,"indexed":inventory.ready,"pending":pending,"skipped":{"oversized":inventory.oversized,"batchBudget":inventory.over_budget,"dailyLimit":inventory.daily_limit},"job":job,"permitted":policy::resolve(&settings["policy"])["enabled"],"local":local,"automatic":{ "approved":automatic_approved(&settings), "spentToday":daily_spent(&settings), "remainingToday":daily_remaining(&settings),"waitingForBudget":waiting},"indexVersion":INDEX_VERSION}),
    )
}
fn settings_input(db: &Store, input: &Value) -> Result<Value> {
    let defaults = defaults();
    let object = input
        .as_object()
        .filter(|object| {
            object.keys().all(|key| {
                defaults.get(key).is_some() || ["apiKey", "clearApiKey"].contains(&key.as_str())
            })
        })
        .ok_or_else(|| Error::invalid("Invalid smart search settings."))?;
    let settings = db.settings()?;
    let previous = config(&settings);
    let mut next = merge(previous.clone(), input);
    next["baseUrl"] = validation::api_base(&next["baseUrl"])?.into();
    let live = connections(&settings);
    if !next["autoIndex"].is_boolean()
        || !next["dailyTokenBudget"]
            .as_u64()
            .is_some_and(|n| (4000..=2_000_000).contains(&n))
        || !next["enabled"].is_boolean()
        || next["model"].as_str().is_none_or(|s| {
            s.encode_utf16().count() > 200 || (next["enabled"] == true && s.trim().is_empty())
        })
        || !["openai", "ollama"].contains(&string(&next, "protocol"))
        || !next["months"]
            .as_f64()
            .is_some_and(|n| [0.0, 1.0, 3.0, 6.0, 12.0].contains(&n))
        || !next["tokenBudget"]
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && (4000.0..=64000.0).contains(&n))
    {
        return Err(Error::invalid(
            "Choose a model, all downloaded mail or a 1/3/6/12-month range, and a 4,000–64,000 token budget.",
        ));
    }
    next["months"] = (next["months"].as_f64().unwrap() as u64).into();
    next["tokenBudget"] = (next["tokenBudget"].as_f64().unwrap() as u64).into();
    let accounts = next["accounts"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| Error::invalid("Select connected accounts for smart search."))?;
    let mut selected = Vec::new();
    for account in accounts {
        let account = account
            .as_str()
            .ok_or_else(|| Error::invalid("Select connected accounts for smart search."))?;
        if live.get(account).is_none()
            && !previous["accounts"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == account))
        {
            return Err(Error::invalid(
                "Select connected accounts for smart search.",
            ));
        }
        if live.get(account).is_some() && !selected.iter().any(|id| id == account) {
            selected.push(account.to_owned());
        }
    }
    next["accounts"] = json!(selected);
    for group in ["folders", "content"] {
        if next[group].as_object().is_none_or(|v| {
            v.iter()
                .any(|(key, value)| defaults[group].get(key).is_none() || !value.is_boolean())
        }) {
            return Err(Error::invalid("Use valid scope checkboxes."));
        }
        next[group] = merge(defaults[group].clone(), &next[group]);
    }
    if next["enabled"] == true
        && (selected.is_empty()
            || ["folders", "content"].iter().any(|group| {
                !next[*group]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|v| v == true)
            }))
    {
        return Err(Error::invalid(
            "Select at least one account, folder and content field.",
        ));
    }
    if object.get("clearApiKey").is_some_and(|v| !v.is_boolean())
        || object.get("apiKey").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| s.encode_utf16().count() > 4096 || s.contains(['\r', '\n']))
        })
    {
        return Err(Error::invalid(
            "Invalid embedding API key or clear-key option.",
        ));
    }
    next["apiKey"] = if input["clearApiKey"] == true {
        json!("")
    } else if !string(input, "apiKey").is_empty() {
        input["apiKey"].clone()
    } else if validation::api_base(&previous["baseUrl"]).is_ok_and(|saved| saved == next["baseUrl"])
    {
        json!(string(&previous, "apiKey"))
    } else {
        json!("")
    };
    next.as_object_mut().unwrap().remove("clearApiKey");
    Ok(next)
}
pub fn update(db: &Store, input: &Value) -> Result<()> {
    let previous = db.settings()?;
    let next = settings_input(db, input)?;
    db.transaction(|db| {
        db.set_settings(&json!({"searchAI":next}))?;
        let settings = db.settings()?;
        if scope_stamp(&previous) != scope_stamp(&settings) {
            db.set_settings(
                &json!({"searchIndex":null,"searchGeneration":uuid::Uuid::new_v4().to_string()}),
            )?;
        } else if settings["searchIndex"]["automatic"] == true
            && next["dailyTokenBudget"].as_u64().unwrap_or(100000)
                < config(&previous)["dailyTokenBudget"]
                    .as_u64()
                    .unwrap_or(100000)
        {
            // Requeue within the lower limit; renewed approval covers uncertain work.
            db.set_settings(&json!({"searchIndex":null,"searchAutomaticApproval":null}))?;
        }
        if input["autoIndex"] == true {
            db.set_settings(&json!({"searchAutomaticApproval":scope_stamp(&settings)}))?;
            let job = db.settings()?["searchIndex"].clone();
            if job["automatic"] == true
                && ["paused", "budget_wait"].contains(&string(&job, "status"))
                && job["spentTokens"].as_u64().unwrap_or(0) < job["budget"].as_u64().unwrap_or(0)
            {
                control(db, "resume", string(&job, "id"))?;
            } else if job["status"] != "running" {
                db.set_settings(&json!({"searchIndex":null}))?;
            }
        } else if next["autoIndex"] != true {
            let mut job = db.settings()?["searchIndex"].clone();
            if job["automatic"] == true
                && ["running", "budget_wait"].contains(&string(&job, "status"))
            {
                job["status"] = "paused".into();
                job["runId"] = uuid::Uuid::new_v4().to_string().into();
                job.as_object_mut().unwrap().remove("inflight");
                db.set_settings(&json!({"searchIndex":job}))?;
            }
        }
        reconcile(db)
    })
}
pub fn preview(db: &Store) -> Result<Value> {
    let settings = db.settings()?;
    if settings["searchIndex"]["status"] == "running" {
        return Err(Error::conflict("Wait for the current indexing batch."));
    }
    let value = config(&settings);
    if value["enabled"] != true || policy::resolve(&settings["policy"])["enabled"] != true {
        return Err(Error::new(403, "Enable smart search and AI access first."));
    }
    let inventory = inventory(db, true)?;
    if inventory.sources.is_empty() {
        return Err(Error::conflict(
            if inventory.oversized + inventory.over_budget > 0 {
                "Remaining messages exceed this batch budget or 50 chunks per message. Keyword search still covers them; increase the budget where possible."
            } else {
                "No new permitted mail needs indexing. Check the selected scope and global AI permissions."
            },
        ));
    }
    let job = json!({"id":uuid::Uuid::new_v4().to_string(),"stamp":stamp(&db.settings()?),"status":"prepared","sources":inventory.sources,"estimatedTokens":inventory.tokens,"chunks":inventory.pieces,"completed":0,"part":0,"spentTokens":0,"budget":value["tokenBudget"],"eligible":inventory.eligible,"indexed":inventory.ready,"oversized":inventory.oversized + inventory.over_budget,"createdAt":now()});
    db.set_settings(&json!({"searchIndex":job}))?;
    reconcile(db)?;
    let mut result = state(db)?;
    result["samples"] = json!(inventory.samples);
    Ok(result)
}
fn daily_spent(settings: &Value) -> u64 {
    if settings["searchDailyUsage"]["day"] == Utc::now().format("%Y-%m-%d").to_string() {
        settings["searchDailyUsage"]["tokens"].as_u64().unwrap_or(0)
    } else {
        0
    }
}
fn daily_remaining(settings: &Value) -> u64 {
    config(settings)["dailyTokenBudget"]
        .as_u64()
        .unwrap_or(100000)
        .saturating_sub(daily_spent(settings))
}
fn automatic_approved(settings: &Value) -> bool {
    let value = config(settings);
    value["enabled"] == true
        && value["autoIndex"] == true
        && policy::resolve(&settings["policy"])["enabled"] == true
        && settings["searchAutomaticApproval"] == scope_stamp(settings)
}
fn schedule_automatic(db: &Store) -> Result<()> {
    let settings = db.settings()?;
    if !automatic_approved(&settings) {
        return Ok(());
    }
    let job = &settings["searchIndex"];
    let day = Utc::now().format("%Y-%m-%d").to_string();
    if job["status"] == "budget_wait"
        && job["automatic"] == true
        && daily_remaining(&settings) > 0
        && (string(job, "budgetDay") != day || string(&settings["searchDailyUsage"], "day") != day)
    {
        let mut job = check_job(&settings, string(job, "id"), &["budget_wait"])?;
        job["status"] = "running".into();
        db.set_settings(&json!({"searchIndex":job}))?;
        return Ok(());
    }
    if !job.is_null() && job["status"] != "complete" {
        return Ok(());
    }
    let remaining = daily_remaining(&settings);
    if remaining == 0 {
        return Ok(());
    }
    let inventory = inventory_with_budget(db, true, Some(remaining))?;
    if inventory.sources.is_empty() {
        return Ok(());
    }
    let job = json!({"id":uuid::Uuid::new_v4().to_string(),"runId":uuid::Uuid::new_v4().to_string(),"stamp":stamp(&settings),"status":"running","automatic":true,"sources":inventory.sources,"estimatedTokens":inventory.tokens,"chunks":inventory.pieces,"completed":0,"part":0,"spentTokens":0,"budget":inventory.tokens,"oversized":inventory.oversized,"createdAt":now()});
    db.set_settings(&json!({"searchIndex":job}))?;
    Ok(())
}
fn check_job(settings: &Value, id: &str, status: &[&str]) -> Result<Value> {
    let job = &settings["searchIndex"];
    if string(job, "id") != id
        || job["stamp"] != stamp(settings)
        || !status.contains(&string(job, "status"))
    {
        return Err(Error::conflict(
            "Index scope changed. Prepare a fresh indexing preview.",
        ));
    }
    Ok(job.clone())
}
pub fn control(db: &Store, action: &str, id: &str) -> Result<()> {
    let settings = db.settings()?;
    let statuses = match action {
        "run" => vec!["prepared"],
        "pause" => vec!["running", "budget_wait"],
        "resume" => vec!["paused", "interrupted", "failed", "budget_wait"],
        "cancel" => vec![
            "prepared",
            "running",
            "paused",
            "interrupted",
            "failed",
            "budget_wait",
        ],
        _ => return Err(Error::invalid("Unknown indexing action.")),
    };
    let mut job = check_job(&settings, id, &statuses)?;
    if action == "resume"
        && job["spentTokens"].as_u64().unwrap_or(0) >= job["budget"].as_u64().unwrap_or(0)
    {
        return Err(Error::conflict(
            "This reviewed budget is exhausted. Preview another batch to authorize more tokens.",
        ));
    }
    job["status"] = match action {
        "run" | "resume" => "running",
        "pause" => "paused",
        _ => "cancelled",
    }
    .into();
    job["updatedAt"] = now().into();
    job["error"] = json!("");
    // A new run token prevents late responses from an earlier pause/resume cycle.
    job["runId"] = uuid::Uuid::new_v4().to_string().into();
    job.as_object_mut().unwrap().remove("inflight");
    db.set_settings(&json!({"searchIndex":job}))?;
    reconcile(db)
}
fn transport_error() -> Error {
    Error::new(
        502,
        "Embedding request failed or was cancelled. Check the connection and model service.",
    )
}
fn http_error(status: u16) -> Error {
    // Never return the model's error body: it may echo keys or private mail.
    let reason = match status {
        401 | 403 => "Check the API key and model access.",
        404 => "Check the base URL, model name and protocol.",
        413 => "The service rejected the input size. Check the embedding model input limits.",
        400 | 422 => "Check the embedding model, protocol and input limits.",
        429 => "The service reported a rate limit. Check its quota and retry explicitly later.",
        500..=599 => "The embedding service failed. Check that the model service is available.",
        _ => "Check the embedding endpoint and model settings.",
    };
    Error::new(
        502,
        &format!("Embedding request rejected (HTTP {status}). {reason}"),
    )
}
fn response_error() -> Error {
    Error::new(502, "Embedding response does not match its inputs.")
}
fn unit_vector(value: &Value) -> Result<Vec<f64>> {
    let invalid = || Error::new(502, "The embedding model returned an invalid vector.");
    let vector = value
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or_else(invalid)?
        .iter()
        .map(|v| v.as_f64().filter(|v| v.is_finite()).ok_or_else(invalid))
        .collect::<Result<Vec<_>>>()?;
    let norm = vector.iter().fold(0.0_f64, |norm, x| norm.hypot(*x));
    if norm == 0.0 || !norm.is_finite() {
        return Err(Error::new(
            502,
            "The embedding model returned an empty vector.",
        ));
    }
    Ok(vector.into_iter().map(|x| x / norm).collect())
}
/// Host-owned URL validation and client policy are rechecked at the transport boundary.
pub async fn fetch_embeddings(app: &App, value: &Value, input: &[String]) -> Result<Vec<Vec<f64>>> {
    if input.is_empty()
        || input.len() > 16
        || input
            .iter()
            .any(|s| s.is_empty() || s.chars().count() > 9000)
        || input.iter().map(String::len).sum::<usize>() > 64000
    {
        return Err(Error::invalid(
            "Embedding input exceeds the reviewed request bounds.",
        ));
    }
    let base = validation::api_base(&value["baseUrl"])?;
    validation::text(&value["model"], "Embedding model", 200, false)?;
    if value.get("apiKey").is_some_and(|key| {
        key.as_str()
            .is_none_or(|key| key.encode_utf16().count() > 4096 || key.contains(['\r', '\n']))
    }) {
        return Err(Error::invalid("Invalid embedding API key."));
    }
    let ollama = value["protocol"] == "ollama";
    if !["openai", "ollama"].contains(&string(value, "protocol"))
        || string(value, "model").trim().is_empty()
    {
        return Err(Error::invalid("Choose an embedding model and protocol."));
    }
    let mut body = json!({"model":value["model"],"input":input});
    if ollama {
        body["truncate"] = false.into();
    } else {
        body["encoding_format"] = "float".into();
    }
    let payload = serde_json::to_vec(&body)?;
    if payload.len() > 128 * 1024 {
        return Err(Error::invalid("Embedding payload exceeds 128 KiB."));
    }
    let mut request = app
        .0
        .client
        .post(format!(
            "{base}{}",
            if ollama { "/api/embed" } else { "/embeddings" }
        ))
        .timeout(Duration::from_secs(45))
        .header("content-type", "application/json")
        .body(payload);
    if !string(value, "apiKey").is_empty() {
        request = request.bearer_auth(string(value, "apiKey"));
    }
    let response = request.send().await.map_err(|_| transport_error())?;
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > 8 * 1024 * 1024)
    {
        return Err(Error::new(502, "Embedding response exceeds 8 MiB."));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| transport_error())?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(Error::new(502, "Embedding response exceeds 8 MiB."));
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(502, "Embedding response is not valid JSON."))?;
    let vectors = if ollama {
        response["embeddings"]
            .as_array()
            .filter(|v| v.len() == input.len())
            .ok_or_else(response_error)?
            .clone()
    } else {
        let data = response["data"]
            .as_array()
            .filter(|v| v.len() == input.len())
            .ok_or_else(response_error)?;
        let mut vectors = vec![Value::Null; input.len()];
        for item in data {
            let index = item["index"]
                .as_f64()
                .filter(|i| i.fract() == 0.0 && *i >= 0.0 && *i < input.len() as f64)
                .ok_or_else(response_error)? as usize;
            if !vectors[index].is_null() {
                return Err(response_error());
            }
            vectors[index] = item["embedding"].clone();
        }
        vectors
    };
    let vectors = vectors
        .iter()
        .map(unit_vector)
        .collect::<Result<Vec<_>>>()?;
    if vectors.iter().any(|v| v.len() != vectors[0].len()) {
        return Err(Error::new(502, "The model changed embedding dimensions."));
    }
    Ok(vectors)
}
async fn initialize(app: &App) -> Result<()> {
    if app.0.smart.initialized.load(Ordering::Acquire) {
        return Ok(());
    }
    // Initialization is guarded by the worker mutex so restart never races /run.
    let _guard = app.0.smart.worker.lock().await;
    if app.0.smart.initialized.load(Ordering::Acquire) {
        return Ok(());
    }
    app.db(|db|{let settings=db.settings()?;let mut job=settings["searchIndex"].clone();if job["status"]=="running" && (job["automatic"]!=true || !job["inflight"].is_null()){job["status"]="interrupted".into();job["error"]="Indexing was interrupted. No automatic retry was made; resume explicitly or preview another batch.".into();job["runId"]=uuid::Uuid::new_v4().to_string().into();job.as_object_mut().unwrap().remove("inflight");db.set_settings(&json!({"searchIndex":job}))?;}reconcile(db)}).await?;
    app.0.smart.initialized.store(true, Ordering::Release);
    Ok(())
}
fn pending_stamp(job: &Value) -> String {
    format!("pending:{}:{}", string(job, "id"), string(job, "stamp"))
}
struct Work {
    job: Value,
    item: Value,
    value: Value,
    parts: Vec<String>,
    offset: usize,
    total: usize,
}
fn prepare_work(db: &Store) -> Result<Option<Work>> {
    reconcile(db)?;
    let settings = db.settings()?;
    let mut job = settings["searchIndex"].clone();
    if job["status"] != "running" {
        return Ok(None);
    }
    let id = string(&job, "id").to_owned();
    check_job(&settings, &id, &["running"])?;
    let completed = job["completed"].as_u64().unwrap_or(0) as usize;
    let sources = job["sources"]
        .as_array()
        .ok_or_else(|| Error::conflict("Invalid indexing queue. Prepare a fresh preview."))?;
    if completed >= sources.len() {
        job["status"] = "complete".into();
        db.set_settings(&json!({"searchIndex":job}))?;
        return Ok(None);
    }
    let item = sources[completed].clone();
    let Some((hash, text)) = source(db, &settings, string(&item, "account"), string(&item, "id"))?
    else {
        return Err(Error::conflict("Index scope or source changed."));
    };
    if item["hash"] != hash {
        return Err(Error::conflict("Index scope or source changed."));
    }
    if text.chars().count() > 46_080 {
        return Err(Error::conflict("Source exceeds the reviewed chunk limit."));
    }
    let parts = chunks(&text);
    let offset = job["part"].as_u64().unwrap_or(0) as usize;
    if offset >= parts.len() || parts.len() > 50 {
        return Err(Error::conflict(
            "Invalid indexing progress. Prepare a fresh preview.",
        ));
    }
    let total = parts.len();
    let mut remaining = if job["automatic"] == true {
        daily_remaining(&settings)
    } else {
        u64::MAX
    };
    let parts = parts
        .into_iter()
        .skip(offset)
        .take(16)
        .take_while(|p| {
            let cost = p.len() as u64 + 128;
            if cost > remaining {
                return false;
            }
            remaining -= cost;
            true
        })
        .collect::<Vec<_>>();
    let cost = parts.iter().map(|p| p.len() as u64 + 128).sum::<u64>();
    let spent = job["spentTokens"].as_u64().unwrap_or(0);
    if spent + cost > job["budget"].as_u64().unwrap_or(0) {
        return Err(Error::conflict(
            "This reviewed budget is exhausted. Preview another batch to authorize more tokens.",
        ));
    }
    if job["automatic"] == true {
        if !automatic_approved(&settings) {
            return Err(Error::conflict(
                "Automatic indexing scope changed. Review and save Search settings again.",
            ));
        }
        if parts.is_empty() {
            job["status"] = "budget_wait".into();
            job["budgetDay"] = Utc::now().format("%Y-%m-%d").to_string().into();
            db.set_settings(&json!({"searchIndex":job}))?;
            return Ok(None);
        }
        db.set_settings(&json!({"searchDailyUsage":{"day":Utc::now().format("%Y-%m-%d").to_string(),"tokens":daily_spent(&settings)+cost}}))?;
    }
    job["spentTokens"] = (spent + cost).into();
    job["inflight"] = json!({"part":offset,"chunks":parts.len()});
    job["updatedAt"] = now().into();
    db.set_settings(&json!({"searchIndex":job}))?;
    Ok(Some(Work {
        job,
        item,
        value: config(&settings),
        parts,
        offset,
        total,
    }))
}
fn accept_work(db: &Store, work: &Work, vectors: &[Vec<f64>]) -> Result<()> {
    let settings = db.settings()?;
    let mut job = check_job(&settings, string(&work.job, "id"), &["running"])?;
    if job["runId"] != work.job["runId"]
        || job["completed"] != work.job["completed"]
        || job["part"] != work.job["part"]
    {
        return Err(Error::conflict("Indexing was paused or cancelled."));
    }
    let account = string(&work.item, "account");
    let id = string(&work.item, "id");
    if source(db, &settings, account, id)?.is_none_or(|(hash, _)| work.item["hash"] != hash) {
        return Err(Error::conflict("Index scope or source changed."));
    }
    let identity = string(&job, "stamp").to_owned();
    let staging = pending_stamp(&job);
    let dimension = vectors.first().map_or(0, Vec::len);
    let previous: Option<i64> = db
        .conn
        .query_row(
            "SELECT json_array_length(vector) FROM search_vectors WHERE stamp=? OR stamp=? LIMIT 1",
            params![identity, staging],
            |row| row.get(0),
        )
        .optional()?;
    if dimension == 0
        || previous.is_some_and(|n| n != dimension as i64)
        || vectors.iter().any(|v| v.len() != dimension)
    {
        return Err(Error::conflict(
            "Embedding dimensions changed. Clear the index and rebuild with one model.",
        ));
    }
    db.transaction(|db| {
        if work.offset == 0 {
            db.conn.execute(
                "DELETE FROM search_vectors WHERE account=? AND id=?",
                params![account, id],
            )?;
        }
        for (index, vector) in vectors.iter().enumerate() {
            db.conn.execute(
                "INSERT INTO search_vectors(account,id,part,stamp,hash,vector) VALUES(?,?,?,?,?,?)",
                params![
                    account,
                    id,
                    (work.offset + index) as i64,
                    staging,
                    string(&work.item, "hash"),
                    serde_json::to_string(vector)?
                ],
            )?;
        }
        let next = work.offset + vectors.len();
        if next == work.total {
            db.conn.execute(
                "UPDATE search_vectors SET stamp=? WHERE account=? AND id=? AND stamp=?",
                params![identity, account, id, staging],
            )?;
            job["completed"] = (job["completed"].as_u64().unwrap_or(0) + 1).into();
            job["part"] = 0.into();
        } else {
            job["part"] = next.into();
        }
        if job["completed"].as_u64().unwrap_or(0) as usize
            == job["sources"].as_array().map_or(0, Vec::len)
        {
            job["status"] = "complete".into();
        }
        job["dimension"] = dimension.into();
        job["updatedAt"] = now().into();
        job.as_object_mut().unwrap().remove("inflight");
        db.set_settings(&json!({"searchIndex":job}))?;
        Ok(())
    })
}
/// One bounded request per tick; a failed/paused/interrupted queue never retries itself.
pub async fn tick(app: &App) -> Result<()> {
    initialize(app).await?;
    let identity = app
        .db(|db| {
            reconcile(db)?;
            Ok(stamp(&db.settings()?))
        })
        .await?;
    app.0
        .smart
        .cache
        .lock()
        .await
        .retain(|entry| entry.stamp == identity && entry.until > Instant::now());
    let Ok(_guard) = app.0.smart.worker.try_lock() else {
        return Ok(());
    };
    let mut cancelled = app.0.smart.cancellation.subscribe();
    let mut scan = app.0.smart.scan.lock().await;
    let previous = scan.clone();
    let (expected, work, revision) = app
        .db(move |db| {
            let key = format!("{}:{}", db.revision()?, Utc::now().format("%Y-%m-%d"));
            if key != previous {
                schedule_automatic(db)?;
            }
            let job = db.settings()?["searchIndex"].clone();
            let work = prepare_work(db);
            Ok((
                (job["id"].clone(), job["runId"].clone()),
                work,
                format!("{}:{}", db.revision()?, Utc::now().format("%Y-%m-%d")),
            ))
        })
        .await?;
    *scan = revision;
    let (work, result) = match work {
        Ok(Some(work)) => {
            let result = tokio::select! {biased; _=cancelled.changed()=>Err(transport_error()),result=fetch_embeddings(app,&work.value,&work.parts)=>result};
            (Some(work), result)
        }
        Ok(None) => return Ok(()),
        Err(error) => (None, Err(error)),
    };
    let result = match (work, result) {
        (Some(work), Ok(vectors)) => app.db(move |db| accept_work(db, &work, &vectors)).await,
        (_, Err(error)) => Err(error),
        _ => Ok(()),
    };
    if let Err(error) = result {
        app.db(move|db|{let settings=db.settings()?;let mut job=settings["searchIndex"].clone();if job["status"]=="running"&&job["id"]==expected.0&&job["runId"]==expected.1{job["status"]="failed".into();job["error"]=format!("{} Completed valid entries are retained. Tokens may have been used; retry explicitly.",error).into();job.as_object_mut().unwrap().remove("inflight");db.set_settings(&json!({"searchIndex":job}))?;}reconcile(db)}).await?;
    }
    Ok(())
}
struct Entry {
    account: String,
    id: String,
    date: String,
    vector: Vec<f64>,
}
struct Snapshot {
    settings: Value,
    identity: String,
    revision: String,
    accounts: Vec<String>,
    entries: Vec<Entry>,
}
fn search_accounts(ctx: &Context, settings: &Value, options: &Query) -> Result<Vec<String>> {
    let owner = ctx.read_owner(settings, true)?;
    let accounts = if options.scope == "all" || owner == "all" {
        connections(settings)
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    } else {
        vec![owner]
    };
    if accounts.len() > 100 {
        return Err(Error::invalid("Search at most 100 connected accounts."));
    }
    Ok(accounts)
}
fn semantic_snapshot(db: &Store, ctx: &Context, options: &Query) -> Result<Snapshot> {
    reconcile(db)?;
    let settings = db.settings()?;
    let value = config(&settings);
    let policy = policy::resolve(&settings["policy"]);
    let live = connections(&settings);
    let identity = stamp(&settings);
    let accounts = search_accounts(ctx, &settings, options)?;
    if value["enabled"] != true || policy["enabled"] != true {
        return Err(Error::new(
            403,
            "Smart search is disabled. Use keyword search or enable it in Settings.",
        ));
    }
    let permitted = accounts
        .iter()
        .filter(|account| permitted(&value, &policy, &live, account))
        .cloned()
        .collect::<Vec<_>>();
    let (clause, parameters) = query::where_clause(
        &permitted,
        &options.conditions,
        (options.scope == "folder").then_some(options.folder.as_str()),
    )?;
    let folders = allowed_folders(&value, &policy);
    let mut parameters: Vec<Sql> = std::iter::once(identity.clone().into())
        .chain(parameters)
        .chain(std::iter::once(since(&value).into()))
        .collect();
    parameters.extend(folders.iter().cloned().map(Sql::Text));
    let sql = format!(
        "SELECT v.account,v.id,v.hash,v.vector,d.date,{} FROM search_vectors v JOIN search_documents d ON d.account=v.account AND d.id=v.id JOIN messages m ON m.account=d.account AND m.id=d.id WHERE v.stamp=? AND {clause} AND d.date>=? AND d.folder IN ({}) ORDER BY v.account,v.id,v.part LIMIT 12001",
        projection(&value, &policy),
        query::placeholders(folders.len())
    );
    let mut statement = db.conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(parameters))?;
    let mut entries = Vec::new();
    let mut count = 0;
    let mut scalars = 0;
    // ponytail: exact cosine scan is bounded to 12,000 chunks / 4M scalars;
    // replace with an audited ANN index only when measured scopes require it.
    while let Some(row) = rows.next()? {
        count += 1;
        if count > 12000 {
            return Err(Error::conflict(
                "Narrow the account, date or folder filters to search fewer than 12,000 indexed chunks.",
            ));
        }
        let Some((hash, _)) = source_text(&row.get::<_, String>(5)?)? else {
            continue;
        };
        if hash != row.get::<_, String>(2)? {
            continue;
        }
        let vector: Value = serde_json::from_str(&row.get::<_, String>(3)?)
            .map_err(|_| Error::conflict("Invalid semantic index. Clear the index and rebuild."))?;
        let vector = unit_vector(&vector)
            .map_err(|_| Error::conflict("Invalid semantic index. Clear the index and rebuild."))?;
        scalars += vector.len();
        if scalars > 4_000_000 {
            return Err(Error::conflict(
                "Narrow the search scope; this model's indexed vectors exceed the bounded search budget.",
            ));
        }
        entries.push(Entry {
            account: row.get(0)?,
            id: row.get(1)?,
            date: row.get(4)?,
            vector,
        });
    }
    Ok(Snapshot {
        settings,
        identity,
        revision: db.revision()?,
        accounts,
        entries,
    })
}
fn validate_snapshot(db: &Store, snapshot: &Snapshot) -> Result<()> {
    if stamp(&db.settings()?) != snapshot.identity {
        reconcile(db)?;
        return Err(Error::conflict(
            "AI permissions, model or accounts changed. Search again.",
        ));
    }
    let cutoff = since(&config(&snapshot.settings));
    if db.revision()? != snapshot.revision
        || snapshot.entries.iter().any(|entry| entry.date < cutoff)
    {
        return Err(Error::conflict(
            "Mail changed during search. Search again for current results.",
        ));
    }
    Ok(())
}
fn rank(db: &Store, options: &Query, snapshot: &Snapshot, vector: &[f64]) -> Result<Value> {
    validate_snapshot(db, snapshot)?;
    let mut semantic: HashMap<(String, String), (f64, String)> = HashMap::new();
    for row in &snapshot.entries {
        if row.vector.len() != vector.len() {
            return Err(Error::conflict(
                "Embedding dimensions changed. Clear the index and rebuild with one model.",
            ));
        }
        let score: f64 = row.vector.iter().zip(vector).map(|(a, b)| a * b).sum();
        if score > 0.0 {
            let entry = semantic
                .entry((row.account.clone(), row.id.clone()))
                .or_insert((score, row.date.clone()));
            if score > entry.0 {
                entry.0 = score;
            }
        }
    }
    let mut semantic = semantic.into_iter().collect::<Vec<_>>();
    semantic.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then_with(|| a.0.cmp(&b.0)));
    semantic.truncate(200);
    let keywords = query::lexical(db, options, &snapshot.accounts, true)?;
    let mut ranked: HashMap<(String, String), (f64, String, String)> = HashMap::new();
    for (index, row) in keywords["rows"].as_array().unwrap().iter().enumerate() {
        let account = string(row, "account");
        let id = string(row, "id");
        let date: String = db.conn.query_row(
            "SELECT date FROM search_documents WHERE account=? AND id=?",
            params![account, id],
            |row| row.get(0),
        )?;
        ranked.insert(
            (account.into(), id.into()),
            (1.0 / (61 + index) as f64, "keyword".into(), date),
        );
    }
    for (index, (key, (_, date))) in semantic.into_iter().enumerate() {
        if let Some(previous) = ranked.get_mut(&key) {
            previous.0 += 1.0 / (61 + index) as f64;
            previous.1 = "keyword + semantic".into();
        } else {
            ranked.insert(key, (1.0 / (61 + index) as f64, "semantic".into(), date));
        }
    }
    let mut ranked = ranked.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        match options.sort.as_str() {
            "oldest" => a.1.2.cmp(&b.1.2),
            "newest" => b.1.2.cmp(&a.1.2),
            _ => b.1.0.total_cmp(&a.1.0),
        }
        .then_with(|| a.0.cmp(&b.0))
    });
    Ok(
        json!({"total":ranked.len(),"rows":ranked.into_iter().skip(options.page as usize*30).take(30).map(|((account,id),(_,matched,_))|json!({"account":account,"id":id,"match":matched})).collect::<Vec<_>>(),"warning":"Ranked candidates: up to 200 keyword and 200 semantic matches. Semantic coverage is limited to your approved, indexed mail; use keyword mode for exhaustive results."}),
    )
}
fn response(
    db: &Store,
    ctx: &Context,
    options: &Query,
    accounts: &[String],
    result: Value,
    secret: &[u8; 32],
) -> Result<Value> {
    let mut messages = Vec::new();
    for row in result["rows"]
        .as_array()
        .ok_or_else(|| Error::new(500, "Invalid search results."))?
    {
        let account = string(row, "account");
        let message = db
            .get(account, string(row, "id"))?
            .ok_or_else(|| Error::conflict("Mail changed. Search again."))?;
        let mut output = pages::owned(
            account,
            if ctx.paged {
                pages::summary(&message)
            } else {
                message.clone()
            },
        );
        output["searchMatch"] = if string(row, "match").is_empty() {
            json!("keyword")
        } else {
            row["match"].clone()
        };
        output["searchSubject"] = query::segments(string(&message, "subject"), &options.terms, 140);
        output["searchSnippet"] = query::segments(
            if string(&message, "body").is_empty() {
                string(&message, "preview")
            } else {
                string(&message, "body")
            },
            &options.terms,
            180,
        );
        messages.push(output);
    }
    let revision = db.revision()?;
    let scope = query::cursor_scope(options, accounts, &revision, &stamp(&db.settings()?));
    Ok(
        json!({"messages":messages,"total":result["total"],"page":options.page,"pageSize":30,"chips":options.chips,"coverage":query::coverage(db,accounts)?,"warning":string(&result,"warning"),"mode":if options.smart{"hybrid"}else{"keyword"},"engine":"rust","revision":revision,"nextCursor":query::next_cursor(&scope,options.page,result["total"].as_u64().unwrap_or(0),secret)}),
    )
}
fn apply_cursor(
    db: &Store,
    ctx: &Context,
    options: &mut Query,
    secret: &[u8; 32],
) -> Result<Vec<String>> {
    let settings = db.settings()?;
    let accounts = search_accounts(ctx, &settings, options)?;
    if !options.cursor.is_empty() {
        let scope = query::cursor_scope(options, &accounts, &db.revision()?, &stamp(&settings));
        let page = query::cursor_page(&options.cursor, &scope, secret)?;
        if ctx.body.get("page").is_some() && options.page != page {
            return Err(Error::conflict("Search page and cursor do not match."));
        }
        options.page = page;
    }
    Ok(accounts)
}
async fn search(app: &App, ctx: &Context, mut options: Query) -> Result<Value> {
    let secret = app.0.page_secret;
    if !options.smart || options.terms.is_empty() {
        let ctx = ctx.clone();
        return app
            .db(move |db| {
                let accounts = apply_cursor(db, &ctx, &mut options, &secret)?;
                let result = query::lexical(db, &options, &accounts, false)?;
                response(db, &ctx, &options, &accounts, result, &secret)
            })
            .await;
    }
    // Coalesce simultaneous identical paid queries; cache lookup happens inside this gate.
    let _gate = app.0.smart.query_gate.lock().await;
    let mut cancelled = app.0.smart.cancellation.subscribe();
    let ctx_clone = ctx.clone();
    let (options, snapshot) = app
        .db(move |db| {
            reconcile(db)?;
            apply_cursor(db, &ctx_clone, &mut options, &secret)?;
            let snapshot = semantic_snapshot(db, &ctx_clone, &options)?;
            Ok((options, snapshot))
        })
        .await?;
    if snapshot.entries.is_empty() {
        let ctx = ctx.clone();
        return app.db(move|db|{validate_snapshot(db,&snapshot)?;let mut result=query::lexical(db,&options,&snapshot.accounts,false)?;result["warning"]="No current semantic index matches this scope. Showing keyword matches; index permitted mail in Settings → Search.".into();response(db,&ctx,&options,&snapshot.accounts,result,&secret)}).await;
    }
    let key = query::digest(&json!([snapshot.identity, options.terms.join(" ")]));
    let vector = {
        let mut cache = app.0.smart.cache.lock().await;
        cache.retain(|entry| entry.stamp == snapshot.identity && entry.until > Instant::now());
        cache
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.vector.clone())
    };
    let vector = if let Some(vector) = vector {
        vector
    } else {
        if options.cached_only || options.page > 0 || !options.cursor.is_empty() {
            return Err(Error::conflict(
                "Press Search again to refresh semantic results; the query cache expired.",
            ));
        }
        let value = config(&snapshot.settings);
        let text = vec![options.terms.join(" ")];
        let result = tokio::select! {biased; _=cancelled.changed()=>Err(transport_error()),result=fetch_embeddings(app,&value,&text)=>result}?;
        let vector = Zeroizing::new(result.into_iter().next().ok_or_else(transport_error)?);
        let identity = snapshot.identity.clone();
        let revision = snapshot.revision.clone();
        app.db(move |db| {
            if stamp(&db.settings()?) != identity || db.revision()? != revision {
                reconcile(db)?;
                return Err(Error::conflict(
                    "Search scope or source changed. Search again.",
                ));
            }
            Ok(())
        })
        .await?;
        let mut cache = app.0.smart.cache.lock().await;
        cache.push_back(CachedQuery {
            key,
            stamp: snapshot.identity.clone(),
            vector: vector.clone(),
            until: Instant::now() + Duration::from_secs(300),
        });
        while cache.len() > 20 {
            cache.pop_front();
        }
        vector
    };
    let ctx = ctx.clone();
    app.db(move |db| {
        let result = rank(db, &options, &snapshot, &vector)?;
        response(db, &ctx, &options, &snapshot.accounts, result, &secret)
    })
    .await
}
fn preferences(db: &Store, ctx: &Context) -> Result<Value> {
    let settings = db.settings()?;
    let owner = ctx.read_owner(&settings, true)?;
    let mut previous = settings["searchHistory"]
        .get(&owner)
        .cloned()
        .unwrap_or_else(|| json!({"recent":[],"saved":[]}));
    if ctx.method == axum::http::Method::GET {
        return Ok(previous);
    }
    let action = string(&ctx.body, "action");
    if !["recent", "save", "remove", "clear"].contains(&action) {
        return Err(Error::invalid("Unknown search history action."));
    }
    if action == "clear" {
        previous["recent"] = json!([]);
    } else {
        let options = query::parse(ctx.body.get("value").unwrap_or(&json!({})))?;
        let entry = options.entry();
        let field = if action == "recent" {
            "recent"
        } else {
            "saved"
        };
        let mut entries = previous[field].as_array().cloned().unwrap_or_default();
        entries.retain(|item| item != &entry);
        if action != "remove" {
            entries.insert(0, entry);
            entries.truncate(if action == "recent" { 10 } else { 20 });
        }
        previous[field] = json!(entries);
    }
    let mut history = merge(json!({}), &settings["searchHistory"]);
    history[&owner] = previous.clone();
    db.set_settings(&json!({"searchHistory":history}))?;
    Ok(previous)
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path = ctx
        .path
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let route = path.iter().map(String::as_str).collect::<Vec<_>>();
    if route.first() != Some(&"search") {
        return Ok(None);
    }
    initialize(app).await?;
    let mut status = StatusCode::OK;
    let result = match (ctx.method.as_str(), route.as_slice()) {
        ("POST", ["search"]) => search(app, ctx, query::parse(&ctx.body)?).await?,
        ("GET" | "POST", ["search", "preferences"]) => {
            let ctx = ctx.clone();
            app.db(move |db| preferences(db, &ctx)).await?
        }
        ("GET", ["search", "settings"]) => app.db(state).await?,
        ("POST", ["search", "settings"]) => {
            let input = ctx.body.clone();
            let result = app
                .db(move |db| {
                    update(db, &input)?;
                    state(db)
                })
                .await?;
            app.0
                .smart
                .cancellation
                .send_modify(|generation| *generation = generation.wrapping_add(1));
            app.0.smart.cache.lock().await.clear();
            result
        }
        ("POST", ["search", "test"]) => {
            let _gate =
                app.0.smart.test_gate.try_lock().map_err(|_| {
                    Error::conflict("An embedding connection test is already running.")
                })?;
            let mut input = ctx.body.clone();
            if input.as_object().is_none_or(|v| {
                v.keys().any(|key| {
                    !["baseUrl", "model", "protocol", "apiKey", "clearApiKey"]
                        .contains(&key.as_str())
                })
            }) {
                return Err(Error::invalid("Invalid embedding test settings."));
            }
            // The fixed probe is independent of mail permissions and index scope.
            input["enabled"] = false.into();
            let value = app.db(move |db| settings_input(db, &input)).await?;
            let result = fetch_embeddings(
                app,
                &value,
                &["Morrow Mail embedding connection test.".into()],
            )
            .await?;
            json!({"ok":true,"dimensions":result[0].len()})
        }
        ("POST", ["search", "index", "preview"]) => app.db(preview).await?,
        ("POST", ["search", "index", "clear"]) => {
            let result=app.db(|db|{db.transaction(|db|{db.conn.execute("DELETE FROM search_vectors",[])?;db.set_settings(&json!({"searchIndex":null,"searchAutomaticApproval":null,"searchGeneration":uuid::Uuid::new_v4().to_string()}))?;Ok(())})?;state(db)}).await?;
            app.0
                .smart
                .cancellation
                .send_modify(|generation| *generation = generation.wrapping_add(1));
            app.0.smart.cache.lock().await.clear();
            result
        }
        (
            "POST",
            [
                "search",
                "index",
                action @ ("run" | "pause" | "resume" | "cancel"),
            ],
        ) => {
            let action = action.to_string();
            if action == "run" || action == "resume" {
                status = StatusCode::ACCEPTED;
            }
            let input = ctx.body.clone();
            let result = app
                .db(move |db| {
                    let id = if input.get("previewId").is_some() {
                        validation::text(&input["previewId"], "Preview ID", 100, false)?.to_owned()
                    } else if action == "run" {
                        return Err(Error::invalid("Preview the indexing batch first."));
                    } else {
                        string(&db.settings()?["searchIndex"], "id").to_owned()
                    };
                    control(db, &action, &id)?;
                    state(db)
                })
                .await?;
            app.0
                .smart
                .cancellation
                .send_modify(|generation| *generation = generation.wrapping_add(1));
            result
        }
        _ => return Ok(None),
    };
    Ok(Some((status, Json(result)).into_response()))
}
