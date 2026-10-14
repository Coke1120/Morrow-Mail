//! Per-account mail categories, local Today suggestions, and skill review queues.
//!
//! Schedules never call a model, send mail, or write Email Brain. `autoExecute`
//! only means a due skill may be added to the review queue.

use crate::{
    ai,
    error::{Error, Result},
    service::{App, Context, save_workspace, valid_account, workspace},
    store::{Store, catalog, now, string},
    validation,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

const MAX_CATEGORIES: usize = 20;
const MAX_SKILLS: usize = 20;
const MAX_TODOS: usize = 20;
const MAX_REVIEWS: usize = 30;
const REVIEW_DETAIL: &str = "Queued for review. Nothing was sent and Email Brain was not changed.";
// The partial index contains only unread Inbox metadata. Exclusions run before
// LIMIT so completed/summary rows cannot occupy the next eight suggestion slots.
const UNREAD_INBOX_SQL: &str = "SELECT id,json_extract(data,'$.subject') FROM messages INDEXED BY mail_unread_inbox WHERE account=?1 AND COALESCE(json_extract(data,'$.folder'),'')='inbox' AND NOT COALESCE(json_extract(data,'$.read'),0) AND id NOT IN (SELECT value FROM json_each(?2)) ORDER BY COALESCE(json_extract(data,'$.date'),'') DESC,id LIMIT 8";

pub fn categories(config: &Value, owner: &str) -> Value {
    if !valid_account(config, owner) {
        return json!([]);
    }
    match config["workspaces"][owner]
        .get("categories")
        .and_then(Value::as_array)
    {
        Some(items) => json!(normalize_categories(items)),
        None => json!(default_categories()),
    }
}

pub fn library(config: &Value, owner: &str) -> Value {
    if !valid_account(config, owner) {
        return json!([]);
    }
    let skills = workspace(config, owner)["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    json!(
        library_definitions()
            .into_iter()
            .map(|skill| {
                let id = string(&skill, "id");
                let installed = skills
                    .iter()
                    .any(|saved| saved["id"] == id || saved["libraryId"] == id);
                json!({
                    "id": id,
                    "name": skill["name"],
                    "instructions": skill["instructions"],
                    "installed": installed,
                })
            })
            .collect::<Vec<_>>()
    )
}

pub fn todos_from_reports(
    db: &Store,
    config: &Value,
    account: &str,
    reports: &Value,
) -> Result<Vec<Value>> {
    let categories = categories(config, account);
    let categories = categories.as_array().cloned().unwrap_or_default();
    if !categories
        .iter()
        .any(|category| category["enabled"] == true)
    {
        return Ok(Vec::new());
    }
    let summary_items = summary_items(reports);
    let completed = completion_ids(config, account);
    let unread_category = pick_category(&categories, "P2").unwrap();
    let mut excluded: HashSet<String> = summary_items
        .iter()
        .take(40)
        .map(|item| string(item, "messageId").to_owned())
        .collect();
    for entry in workspace(config, account)["todoCompletions"]
        .as_object()
        .into_iter()
        .flat_map(|entries| entries.values())
    {
        if entry["categoryId"] == unread_category["id"] {
            excluded.insert(string(entry, "messageId").to_owned());
        }
    }
    let unread = unread_inbox(db, account, &excluded)?;
    let mut messages = HashMap::new();
    for item in &summary_items {
        let id = string(item, "messageId");
        if id.is_empty() {
            continue;
        }
        if let Some(message) = db.get(account, id)? {
            messages.insert(id.to_owned(), message);
        }
    }
    for message in &unread {
        messages
            .entry(string(message, "id").to_owned())
            .or_insert_with(|| message.clone());
    }
    Ok(assemble_todos(
        account,
        &categories,
        &summary_items,
        &unread,
        &messages,
        &completed,
    ))
}

pub async fn scheduled_tick(app: &App) -> Result<()> {
    let now_ms = Utc::now().timestamp_millis();
    app.db(move |db| enqueue_due(db, now_ms)).await
}

pub fn finish_skill(
    db: &Store,
    owner: &str,
    input: &Value,
    previous: &Value,
    mut skill: Value,
) -> Result<Value> {
    if let Some(mode) = input
        .get("autoExecuteMode")
        .filter(|value| !value.is_null())
        && mode != "review"
    {
        return Err(Error::invalid(
            "Skill schedules can only queue a review. They cannot send mail or update Email Brain.",
        ));
    }
    let auto = match input.get("autoExecute") {
        Some(Value::Bool(value)) => *value,
        None | Some(Value::Null) => previous["autoExecute"].as_bool().unwrap_or(false),
        _ => return Err(Error::invalid("Skill review queue must be true or false.")),
    };
    let trigger = match input.get("trigger") {
        Some(Value::Null) | None => string(previous, "trigger").trim().to_owned(),
        Some(value) => validation::text(value, "Skill trigger", 240, true)?
            .trim()
            .to_owned(),
    };
    let schedule = match input.get("schedule") {
        Some(Value::Null) => None,
        Some(value) => Some(parse_schedule(value)?),
        None => previous
            .get("schedule")
            .filter(|value| value.is_object())
            .cloned(),
    };
    let schedule_changed = previous.get("schedule").filter(|value| value.is_object())
        != schedule.as_ref()
        && input.get("schedule").is_some();
    skill["autoExecute"] = json!(auto);
    skill["autoExecuteMode"] = json!("review");
    skill["trigger"] = json!(trigger);
    if let Some(library_id) = previous.get("libraryId").filter(|value| value.is_string()) {
        skill["libraryId"] = library_id.clone();
    }
    match &schedule {
        Some(schedule) => skill["schedule"] = schedule.clone(),
        None => {
            skill.as_object_mut().unwrap().remove("schedule");
        }
    }
    if schedule_changed {
        clear_cursor(db, owner, string(&skill, "id"))?;
    }
    Ok(skill)
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let route: Vec<String> = ctx
        .path
        .iter()
        .map(|part| part.to_ascii_lowercase())
        .collect();
    let route: Vec<&str> = route.iter().map(String::as_str).collect();
    let owner = ctx.owner.clone();
    let input = ctx.body.clone();
    match (ctx.method.as_str(), route.as_slice()) {
        ("POST", ["workspace", "categories", "suggest"]) => {
            return Ok(Some(Json(suggest_category(&input)?).into_response()));
        }
        ("POST", ["workspace", "categories"]) => {
            app.db(move |db| db.transaction(|db| add_category(db, &owner, &input)))
                .await?;
        }
        ("POST", ["workspace", "categories", "save"]) => {
            app.db(move |db| db.transaction(|db| save_categories(db, &owner, &input)))
                .await?;
        }
        ("POST", ["workspace", "categories", "reorder"]) => {
            app.db(move |db| db.transaction(|db| reorder_categories(db, &owner, &input)))
                .await?;
        }
        ("POST", ["workspace", "categories", "reset"]) => {
            app.db(move |db| db.transaction(|db| reset_categories(db, &owner)))
                .await?;
        }
        ("POST", ["workspace", "categories", _]) => {
            let id = ctx.path[2].clone();
            app.db(move |db| db.transaction(|db| update_category(db, &owner, &id, &input)))
                .await?;
        }
        ("DELETE", ["workspace", "categories", _]) => {
            let id = ctx.path[2].clone();
            app.db(move |db| db.transaction(|db| delete_category(db, &owner, &id)))
                .await?;
        }
        ("POST", ["workspace", "todos", "complete"]) => {
            app.db(move |db| db.transaction(|db| complete_todo(db, &owner, &input)))
                .await?;
        }
        ("POST", ["workspace", "todos", "reopen"]) => {
            app.db(move |db| db.transaction(|db| reopen_todo(db, &owner, &input)))
                .await?;
        }
        ("POST", ["skills", "library"]) => {
            app.db(move |db| db.transaction(|db| install_library(db, &owner, &input)))
                .await?;
        }
        ("POST", ["skills", _, "schedule"]) => {
            let id = ctx.path[1].clone();
            app.db(move |db| db.transaction(|db| set_schedule(db, &owner, &id, &input)))
                .await?;
        }
        ("DELETE", ["skills", _, "schedule"]) => {
            let id = ctx.path[1].clone();
            app.db(move |db| db.transaction(|db| delete_schedule(db, &owner, &id)))
                .await?;
        }
        ("POST", ["skills", _, "auto-execute"]) => {
            let id = ctx.path[1].clone();
            app.db(move |db| db.transaction(|db| set_auto_execute(db, &owner, &id, &input)))
                .await?;
        }
        ("POST", ["skills", _, "trigger"]) => {
            let id = ctx.path[1].clone();
            app.db(move |db| db.transaction(|db| set_trigger(db, &owner, &id, &input)))
                .await?;
        }
        ("POST", ["workspace", "skill-reviews"]) => {
            app.db(move |db| db.transaction(|db| queue_review(db, &owner, &input)))
                .await?;
        }
        ("POST", ["workspace", "skill-reviews", _, "open"]) => {
            let id = ctx.path[2].clone();
            app.db(move |db| db.transaction(|db| open_review(db, &owner, &id, &input)))
                .await?;
        }
        ("POST", ["workspace", "skill-reviews", _, "dismiss"]) => {
            let id = ctx.path[2].clone();
            app.db(move |db| db.transaction(|db| dismiss_review(db, &owner, &id, &input)))
                .await?;
        }
        _ => return Ok(None),
    }
    Ok(Some(
        Json(app.state(&ctx.owner, ctx.paged).await?).into_response(),
    ))
}

fn default_categories() -> Vec<Value> {
    vec![
        category(
            "reply-today",
            "Reply today",
            "Mail that asks for a reply today.",
            "P1",
        ),
        category(
            "decision",
            "Needs a decision",
            "Explicit emergencies or decisions.",
            "P0",
        ),
        category(
            "follow-up",
            "Follow up",
            "Normal action or follow-up.",
            "P2",
        ),
        category(
            "read-later",
            "Read later",
            "Information with no requested action.",
            "P3",
        ),
        category(
            "low-priority",
            "Low priority",
            "Bulk or promotional mail.",
            "P4",
        ),
    ]
}

fn category(id: &str, name: &str, description: &str, priority: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "description": description,
        "enabled": true,
        "priority": priority,
    })
}

fn library_definitions() -> Vec<Value> {
    let mut items = catalog()["skills"].as_array().cloned().unwrap_or_default();
    items.push(json!({
        "id": "waiting-on",
        "name": "Waiting on others",
        "instructions": "List messages where someone else owes a reply. Do not draft or send mail. Cite subjects only.",
        "enabled": true,
        "folders": {"inbox": true, "sent": true, "drafts": false, "archive": false, "trash": false}
    }));
    items
}

fn normalize_categories(items: &[Value]) -> Vec<Value> {
    let mut categories = Vec::new();
    let mut seen = HashSet::new();
    for item in items.iter().take(MAX_CATEGORIES) {
        let id = string(item, "id").trim();
        let name = string(item, "name").trim();
        if id.is_empty() || name.is_empty() || !seen.insert(id.to_owned()) {
            continue;
        }
        categories.push(json!({
            "id": id,
            "name": name,
            "description": string(item, "description").trim(),
            "enabled": item["enabled"] != false,
            "priority": canonical_priority(string(item, "priority")),
        }));
    }
    categories
}

fn canonical_priority(value: &str) -> &str {
    if ["P0", "P1", "P2", "P3", "P4"].contains(&value) {
        value
    } else {
        ""
    }
}

fn require_owner(db: &Store, owner: &str) -> Result<Value> {
    let config = db.settings()?;
    if !valid_account(&config, owner) {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    Ok(config)
}

fn load_categories(config: &Value, owner: &str) -> Vec<Value> {
    categories(config, owner)
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn store_categories(db: &Store, owner: &str, categories: Vec<Value>) -> Result<()> {
    save_workspace(db, owner, &json!({"categories": categories}))
}

fn category_name(input: &Value) -> Result<String> {
    Ok(
        validation::text(&input["name"], "Category name", 80, false)?
            .trim()
            .to_owned(),
    )
}

fn category_description(input: &Value) -> Result<String> {
    match input.get("description") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(value) => Ok(validation::text(value, "Category description", 240, true)?
            .trim()
            .to_owned()),
    }
}

fn category_enabled(input: &Value, default: bool) -> Result<bool> {
    match input.get("enabled") {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(Error::invalid("Category enabled must be true or false.")),
    }
}

fn category_priority(input: &Value, default: &str) -> Result<String> {
    match input.get("priority") {
        None | Some(Value::Null) => Ok(canonical_priority(default).to_owned()),
        Some(Value::String(value)) if value.is_empty() || canonical_priority(value) == value => {
            Ok(value.clone())
        }
        _ => Err(Error::invalid(
            "Category priority must be empty or P0, P1, P2, P3, or P4.",
        )),
    }
}

fn duplicate_name(categories: &[Value], name: &str, except: Option<&str>) -> bool {
    categories.iter().any(|category| {
        except != Some(string(category, "id"))
            && string(category, "name").trim().eq_ignore_ascii_case(name)
    })
}

fn add_category(db: &Store, owner: &str, input: &Value) -> Result<()> {
    let config = require_owner(db, owner)?;
    let name = category_name(input)?;
    let mut categories = load_categories(&config, owner);
    if categories.len() >= MAX_CATEGORIES {
        return Err(Error::invalid("Keep at most 20 categories."));
    }
    if duplicate_name(&categories, &name, None) {
        return Err(Error::invalid(
            "That category name is already saved for this mailbox.",
        ));
    }
    categories.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": name,
        "description": category_description(input)?,
        "enabled": category_enabled(input, true)?,
        "priority": category_priority(input, "")?,
    }));
    store_categories(db, owner, categories)
}

fn update_category(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    let config = require_owner(db, owner)?;
    let mut categories = load_categories(&config, owner);
    let index = categories
        .iter()
        .position(|category| category["id"] == id)
        .ok_or_else(|| Error::new(404, "Category not found."))?;
    let name = match input.get("name") {
        None | Some(Value::Null) => string(&categories[index], "name").to_owned(),
        Some(_) => category_name(input)?,
    };
    if duplicate_name(&categories, &name, Some(id)) {
        return Err(Error::invalid(
            "That category name is already saved for this mailbox.",
        ));
    }
    let description = match input.get("description") {
        None | Some(Value::Null) => string(&categories[index], "description").to_owned(),
        Some(_) => category_description(input)?,
    };
    let enabled = category_enabled(input, categories[index]["enabled"] == true)?;
    let priority = category_priority(input, string(&categories[index], "priority"))?;
    categories[index] = json!({
        "id": id,
        "name": name,
        "description": description,
        "enabled": enabled,
        "priority": priority,
    });
    store_categories(db, owner, categories)
}

fn delete_category(db: &Store, owner: &str, id: &str) -> Result<()> {
    let config = require_owner(db, owner)?;
    let mut categories = load_categories(&config, owner);
    let before = categories.len();
    categories.retain(|category| category["id"] != id);
    if categories.len() == before {
        return Err(Error::new(404, "Category not found."));
    }
    store_categories(db, owner, categories)
}

fn reorder_categories(db: &Store, owner: &str, input: &Value) -> Result<()> {
    let config = require_owner(db, owner)?;
    let categories = load_categories(&config, owner);
    let ids = input["ids"]
        .as_array()
        .ok_or_else(|| Error::invalid("Category order must list every saved id."))?;
    if ids.len() != categories.len() {
        return Err(Error::invalid("Category order must list every saved id."));
    }
    let mut next = Vec::new();
    for id in ids {
        let id = id
            .as_str()
            .ok_or_else(|| Error::invalid("Category order must list every saved id."))?;
        let category = categories
            .iter()
            .find(|category| category["id"] == id)
            .ok_or_else(|| Error::invalid("Category order must list every saved id."))?;
        if next.iter().any(|saved: &Value| saved["id"] == id) {
            return Err(Error::invalid("Category order must list every saved id."));
        }
        next.push(category.clone());
    }
    store_categories(db, owner, next)
}

fn save_categories(db: &Store, owner: &str, input: &Value) -> Result<()> {
    require_owner(db, owner)?;
    let items = input["categories"]
        .as_array()
        .ok_or_else(|| Error::invalid("Save the full category list."))?;
    if items.len() > MAX_CATEGORIES {
        return Err(Error::invalid("Keep at most 20 categories."));
    }
    let mut categories = Vec::new();
    for item in items {
        let name = category_name(item)?;
        if duplicate_name(&categories, &name, None) {
            return Err(Error::invalid(
                "That category name is already saved for this mailbox.",
            ));
        }
        let id = match item.get("id") {
            None | Some(Value::Null) => uuid::Uuid::new_v4().to_string(),
            Some(Value::String(value)) if value.trim().is_empty() => {
                uuid::Uuid::new_v4().to_string()
            }
            Some(value) => {
                let id = validation::text(value, "Category ID", 80, false)?.trim();
                if id.contains(['/', '\\', '\n', '\r']) {
                    return Err(Error::invalid(
                        "Category ID contains unsupported characters.",
                    ));
                }
                id.to_owned()
            }
        };
        if categories.iter().any(|category| category["id"] == id) {
            return Err(Error::invalid("Category IDs must be unique."));
        }
        categories.push(json!({
            "id": id,
            "name": name,
            "description": category_description(item)?,
            "enabled": category_enabled(item, true)?,
            "priority": category_priority(item, "")?,
        }));
    }
    store_categories(db, owner, categories)
}

fn reset_categories(db: &Store, owner: &str) -> Result<()> {
    require_owner(db, owner)?;
    store_categories(db, owner, default_categories())
}

fn suggest_category(input: &Value) -> Result<Value> {
    let name = validation::text(&input["prompt"], "Category prompt", 80, false)?
        .trim()
        .to_owned();
    Ok(json!({
        "stub": true,
        "saved": false,
        "suggestion": {
            "name": name,
            "description": "Draft only. Add it yourself if you want to keep it. No model was called.",
            "enabled": true,
            "priority": ""
        }
    }))
}

fn summary_items(reports: &Value) -> Vec<Value> {
    // reports() already validates ownership, permissions and source digests.
    // A daily card's status describes its newest job, not its retained content.
    let completed: Vec<_> = reports
        .as_array()
        .into_iter()
        .flatten()
        .filter(|job| job["status"] == "completed")
        .cloned()
        .collect();
    crate::background::daily_reports(&json!(completed))
        .into_iter()
        .next()
        .and_then(|card| card["items"].as_array().cloned())
        .unwrap_or_default()
}

fn unread_inbox(db: &Store, account: &str, excluded: &HashSet<String>) -> Result<Vec<Value>> {
    let excluded = serde_json::to_string(excluded)?;
    let mut statement = db.conn.prepare(UNREAD_INBOX_SQL)?;
    let rows = statement.query_map([account, &excluded], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "subject": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            "folder": "inbox",
            "read": false,
        }))
    })?;
    rows.map(|row| row.map_err(Into::into)).collect()
}

fn todo_id(account: &str, message_id: &str, category_id: &str) -> String {
    format!(
        "todo:{}",
        ai::hash(&json!([account, message_id, category_id]))
    )
}

fn legacy_todo_id(account: &str, message_id: &str, category_id: &str) -> String {
    format!("{account}\n{message_id}\n{category_id}")
}

fn completion_id(account: &str, saved_id: &str, entry: &Value) -> String {
    let message_id = string(entry, "messageId");
    let category_id = string(entry, "categoryId");
    if message_id.is_empty() || category_id.is_empty() {
        saved_id.to_owned()
    } else {
        todo_id(account, message_id, category_id)
    }
}

fn completion_ids(config: &Value, owner: &str) -> HashSet<String> {
    workspace(config, owner)["todoCompletions"]
        .as_object()
        .map(|entries| {
            entries
                .iter()
                .map(|(id, entry)| completion_id(owner, id, entry))
                .collect()
        })
        .unwrap_or_default()
}

fn pick_category<'a>(categories: &'a [Value], priority: &str) -> Option<&'a Value> {
    let enabled: Vec<_> = categories
        .iter()
        .filter(|category| category["enabled"] == true)
        .collect();
    if !priority.is_empty()
        && let Some(category) = enabled
            .iter()
            .copied()
            .find(|category| category["priority"] == priority)
    {
        return Some(category);
    }
    enabled.first().copied()
}

fn assemble_todos(
    account: &str,
    categories: &[Value],
    summary_items: &[Value],
    unread: &[Value],
    messages: &HashMap<String, Value>,
    completed: &HashSet<String>,
) -> Vec<Value> {
    let mut todos = Vec::new();
    let mut seen = HashSet::new();
    for item in summary_items.iter().take(40) {
        let message_id = string(item, "messageId");
        if message_id.is_empty() || !seen.insert(message_id.to_owned()) {
            continue;
        }
        let priority = canonical_priority(string(item, "priority"));
        let Some(category) = pick_category(categories, priority) else {
            continue;
        };
        let detail = string(item, "summary").trim();
        let detail = if detail.is_empty() {
            "Saved summary."
        } else {
            detail
        };
        push_todo(
            &mut todos,
            account,
            category,
            message_id,
            messages.get(message_id),
            TodoSource {
                kind: "summary",
                priority,
                detail,
            },
        );
    }
    for message in unread.iter().take(8) {
        let message_id = string(message, "id");
        if message_id.is_empty() || !seen.insert(message_id.to_owned()) {
            continue;
        }
        let Some(category) = pick_category(categories, "P2") else {
            continue;
        };
        push_todo(
            &mut todos,
            account,
            category,
            message_id,
            Some(message),
            TodoSource {
                kind: "mail",
                priority: "",
                detail: "Unread Inbox message. Suggested from local mail; no model was called.",
            },
        );
    }
    todos.retain(|todo| !completed.contains(string(todo, "id")));
    todos.sort_by(|left, right| {
        priority_rank(string(left, "priority")).cmp(&priority_rank(string(right, "priority")))
    });
    todos.truncate(MAX_TODOS);
    todos
}

struct TodoSource<'a> {
    kind: &'a str,
    priority: &'a str,
    detail: &'a str,
}

fn push_todo(
    todos: &mut Vec<Value>,
    account: &str,
    category: &Value,
    message_id: &str,
    message: Option<&Value>,
    source: TodoSource<'_>,
) {
    let title = message
        .map(|message| string(message, "subject").trim())
        .filter(|title| !title.is_empty())
        .unwrap_or("Subject not shared");
    let can_mark_read =
        message.is_some_and(|message| message["folder"] == "inbox" && message["read"] != true);
    todos.push(json!({
        "id": todo_id(account, message_id, string(category, "id")),
        "accountId": account,
        "messageId": message_id,
        "categoryId": category["id"],
        "categoryName": category["name"],
        "title": title,
        "detail": clip(source.detail),
        "source": source.kind,
        "priority": source.priority,
        "messagePresent": message.is_some(),
        "canMarkRead": can_mark_read,
    }));
}

fn clip(value: &str) -> String {
    value.trim().chars().take(240).collect()
}

fn priority_rank(priority: &str) -> u8 {
    match priority {
        "P0" => 0,
        "P1" => 1,
        "P2" => 2,
        "P3" => 3,
        "P4" => 4,
        _ => 5,
    }
}

fn reject_mail_mutation(input: &Value) -> Result<()> {
    if ["read", "markRead", "send", "archive", "brain", "folder"]
        .iter()
        .any(|key| input.get(*key).is_some())
    {
        return Err(Error::invalid(
            "This action does not change mail, send anything, or update Email Brain.",
        ));
    }
    Ok(())
}

fn require_confirm(input: &Value, message: &str) -> Result<()> {
    if input["confirm"] == true {
        Ok(())
    } else {
        Err(Error::invalid(message))
    }
}

fn complete_todo(db: &Store, owner: &str, input: &Value) -> Result<()> {
    reject_mail_mutation(input)?;
    require_confirm(input, "Confirm this suggestion before completing it.")?;
    let id = validation::text(&input["id"], "Suggestion", 512, false)?;
    let config = require_owner(db, owner)?;
    let reports = crate::background::reports(db, owner)?;
    let todos = todos_from_reports(db, &config, owner, &reports)?;
    let todo = todos
        .iter()
        .find(|todo| {
            todo["accountId"] == owner
                && (todo["id"] == id
                    || legacy_todo_id(owner, string(todo, "messageId"), string(todo, "categoryId"))
                        == id)
        })
        .ok_or_else(|| Error::new(404, "Suggestion not found."))?;
    let mut completions = workspace(&config, owner)["todoCompletions"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    completions.insert(
        string(todo, "id").to_owned(),
        json!({
            "completedAt": now(),
            "messageId": todo["messageId"],
            "categoryId": todo["categoryId"],
        }),
    );
    prune_completions(&mut completions);
    save_workspace(db, owner, &json!({"todoCompletions": completions}))
}

fn reopen_todo(db: &Store, owner: &str, input: &Value) -> Result<()> {
    reject_mail_mutation(input)?;
    require_confirm(input, "Confirm this suggestion before reopening it.")?;
    let id = validation::text(&input["id"], "Suggestion", 512, false)?;
    let config = require_owner(db, owner)?;
    let mut completions = workspace(&config, owner)["todoCompletions"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let before = completions.len();
    completions.retain(|saved_id, entry| {
        saved_id != id
            && completion_id(owner, saved_id, entry) != id
            && legacy_todo_id(
                owner,
                string(entry, "messageId"),
                string(entry, "categoryId"),
            ) != id
    });
    if completions.len() == before {
        return Err(Error::new(404, "Completed suggestion not found."));
    }
    save_workspace(db, owner, &json!({"todoCompletions": completions}))
}

pub fn completed_todos(db: &Store, config: &Value, account: &str) -> Result<Vec<Value>> {
    if !valid_account(config, account) {
        return Ok(Vec::new());
    }
    let mut items: Vec<Value> = workspace(config, account)["todoCompletions"]
        .as_object()
        .map(|entries| {
            entries
                .iter()
                .map(|(id, value)| {
                    json!({
                        "id": completion_id(account, id, value),
                        "accountId": account,
                        "messageId": value["messageId"],
                        "categoryId": value["categoryId"],
                        "completedAt": value["completedAt"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|left, right| string(right, "completedAt").cmp(string(left, "completedAt")));
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(string(item, "id").to_owned()));
    items.truncate(20);
    for item in &mut items {
        let message_id = string(item, "messageId");
        let title = match db.get(account, message_id)? {
            Some(message) => {
                let subject = string(&message, "subject").trim();
                if subject.is_empty() {
                    "Subject not shared".to_owned()
                } else {
                    subject.to_owned()
                }
            }
            None => "Subject not shared".to_owned(),
        };
        item["title"] = json!(title);
        let category_id = string(item, "categoryId").to_owned();
        let category_name = categories(config, account)
            .as_array()
            .and_then(|items| items.iter().find(|category| category["id"] == category_id))
            .map(|category| string(category, "name").to_owned())
            .unwrap_or_default();
        item["categoryName"] = json!(category_name);
    }
    Ok(items)
}

fn prune_completions(completions: &mut Map<String, Value>) {
    if completions.len() <= 200 {
        return;
    }
    let mut keys: Vec<_> = completions
        .iter()
        .map(|(key, value)| (string(value, "completedAt").to_owned(), key.clone()))
        .collect();
    keys.sort();
    let extra = keys.len() - 200;
    for (_, key) in keys.into_iter().take(extra) {
        completions.remove(&key);
    }
}

fn whole_number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value.as_f64().and_then(|number| {
            (number.fract() == 0.0 && (0.0..=168.0).contains(&number)).then_some(number as u64)
        })
    })
}

fn parse_schedule(input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err(Error::invalid("Skill schedule must be an object."));
    }
    let enabled = input["enabled"]
        .as_bool()
        .ok_or_else(|| Error::invalid("Skill schedule enabled must be true or false."))?;
    let cadence = input["cadence"]
        .as_str()
        .filter(|value| *value == "daily" || *value == "interval")
        .ok_or_else(|| Error::invalid("Skill schedule cadence must be daily or interval."))?;
    let time = match input.get("time") {
        None | Some(Value::Null) => "09:00",
        Some(value) => validation::text(value, "Skill schedule time", 5, false)?,
    };
    if time.len() != 5 || chrono::NaiveTime::parse_from_str(time, "%H:%M").is_err() {
        return Err(Error::invalid("Skill schedule time must be HH:MM."));
    }
    let zone = match input.get("timeZone") {
        None | Some(Value::Null) => "UTC",
        Some(value) => validation::text(value, "Skill schedule time zone", 100, false)?,
    };
    if zone.parse::<chrono_tz::Tz>().is_err() {
        return Err(Error::invalid(
            "Skill schedule time zone must be an IANA name.",
        ));
    }
    let hours = match input.get("intervalHours") {
        None | Some(Value::Null) => 24,
        Some(value) => whole_number(value)
            .filter(|hours| (1..=168).contains(hours))
            .ok_or_else(|| Error::invalid("Skill schedule interval must be 1–168 hours."))?,
    };
    Ok(json!({
        "enabled": enabled,
        "cadence": cadence,
        "time": time,
        "timeZone": zone,
        "intervalHours": hours,
    }))
}

fn clear_cursor(db: &Store, owner: &str, skill_id: &str) -> Result<()> {
    if skill_id.is_empty() {
        return Ok(());
    }
    let config = db.settings()?;
    let mut cursors = workspace(&config, owner)["skillScheduleCursors"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if cursors.remove(skill_id).is_some() {
        save_workspace(db, owner, &json!({"skillScheduleCursors": cursors}))?;
    }
    Ok(())
}

fn mutate_skill(
    db: &Store,
    owner: &str,
    id: &str,
    mutate: impl FnOnce(&mut Value) -> Result<()>,
) -> Result<()> {
    let config = require_owner(db, owner)?;
    let mut skills = workspace(&config, owner)["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let index = skills
        .iter()
        .position(|skill| skill["id"] == id)
        .ok_or_else(|| Error::new(404, "Skill not found."))?;
    mutate(&mut skills[index])?;
    save_workspace(db, owner, &json!({"skills": skills}))?;
    Ok(())
}

fn set_schedule(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    let schedule = parse_schedule(input)?;
    let mut changed = false;
    mutate_skill(db, owner, id, |skill| {
        changed = skill.get("schedule") != Some(&schedule);
        skill["schedule"] = schedule;
        skill["autoExecuteMode"] = json!("review");
        Ok(())
    })?;
    if changed {
        clear_cursor(db, owner, id)?;
    }
    Ok(())
}

fn delete_schedule(db: &Store, owner: &str, id: &str) -> Result<()> {
    mutate_skill(db, owner, id, |skill| {
        skill.as_object_mut().unwrap().remove("schedule");
        skill["autoExecuteMode"] = json!("review");
        Ok(())
    })?;
    clear_cursor(db, owner, id)
}

fn set_auto_execute(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    if input.get("autoExecuteMode").is_some() && input["autoExecuteMode"] != "review" {
        return Err(Error::invalid(
            "Skill schedules can only queue a review. They cannot send mail or update Email Brain.",
        ));
    }
    let enabled = input["enabled"]
        .as_bool()
        .ok_or_else(|| Error::invalid("Skill review queue must be true or false."))?;
    mutate_skill(db, owner, id, |skill| {
        skill["autoExecute"] = json!(enabled);
        skill["autoExecuteMode"] = json!("review");
        Ok(())
    })
}

fn set_trigger(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    let trigger = validation::text(&input["text"], "Skill trigger", 240, true)?
        .trim()
        .to_owned();
    mutate_skill(db, owner, id, |skill| {
        skill["trigger"] = json!(trigger);
        Ok(())
    })
}

fn install_library(db: &Store, owner: &str, input: &Value) -> Result<()> {
    let id = validation::text(&input["libraryId"], "Library skill", 80, false)?;
    let definition = library_definitions()
        .into_iter()
        .find(|skill| skill["id"] == id)
        .ok_or_else(|| Error::new(404, "Library skill not found."))?;
    let config = require_owner(db, owner)?;
    let mut skills = workspace(&config, owner)["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if skills
        .iter()
        .any(|skill| skill["id"] == id || skill["libraryId"] == id)
    {
        return Err(Error::conflict(
            "That library skill is already installed for this mailbox.",
        ));
    }
    if skills.len() >= MAX_SKILLS {
        return Err(Error::invalid("Keep at most 20 custom skills."));
    }
    skills.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "libraryId": id,
        "name": definition["name"],
        "instructions": definition["instructions"],
        "enabled": definition["enabled"] != false,
        "folders": definition["folders"],
        "autoExecute": false,
        "autoExecuteMode": "review",
        "trigger": "",
    }));
    save_workspace(db, owner, &json!({"skills": skills}))?;
    ai::invalidate(db)
}

fn reviews_of(config: &Value, owner: &str) -> Vec<Value> {
    workspace(config, owner)["skillReviews"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn review_item(skill: &Value, source: &str) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "skillId": skill["id"],
        "skillName": skill["name"],
        "kind": proposal_kind(string(skill, "instructions")),
        "status": "queued",
        "source": source,
        "createdAt": now(),
        "detail": REVIEW_DETAIL,
    })
}

fn proposal_kind(instructions: &str) -> &'static str {
    let lower = instructions.to_ascii_lowercase();
    if lower.contains("do not draft") || lower.contains("do not send") {
        return "propose-action";
    }
    if lower.contains("draft") || lower.contains("reply") || lower.contains("compose") {
        "propose-draft"
    } else {
        "propose-action"
    }
}

fn queue_review(db: &Store, owner: &str, input: &Value) -> Result<()> {
    reject_mail_mutation(input)?;
    require_confirm(input, "Confirm before queueing this skill for review.")?;
    let skill_id = validation::text(&input["skillId"], "Skill", 80, false)?;
    let config = require_owner(db, owner)?;
    let skills = workspace(&config, owner)["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let skill = skills
        .iter()
        .find(|skill| skill["id"] == skill_id)
        .ok_or_else(|| Error::new(404, "Skill not found."))?;
    if skill["enabled"] == false {
        return Err(Error::new(
            403,
            "Enable the skill before queueing a review.",
        ));
    }
    let mut reviews = reviews_of(&config, owner);
    if reviews.iter().any(|review| review["skillId"] == skill_id) {
        return Err(Error::conflict("This skill already has a review waiting."));
    }
    if reviews.len() >= MAX_REVIEWS {
        return Err(Error::invalid("Dismiss a queued skill review first."));
    }
    reviews.push(review_item(skill, "manual"));
    save_workspace(db, owner, &json!({"skillReviews": reviews}))
}

fn open_review(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    reject_mail_mutation(input)?;
    require_confirm(input, "Confirm before opening this skill review.")?;
    let config = require_owner(db, owner)?;
    let mut reviews = reviews_of(&config, owner);
    let review = reviews
        .iter_mut()
        .find(|review| review["id"] == id)
        .ok_or_else(|| Error::new(404, "Skill review not found."))?;
    review["status"] = json!("opened");
    save_workspace(db, owner, &json!({"skillReviews": reviews}))
}

fn dismiss_review(db: &Store, owner: &str, id: &str, input: &Value) -> Result<()> {
    reject_mail_mutation(input)?;
    require_confirm(input, "Confirm before dismissing this skill review.")?;
    let config = require_owner(db, owner)?;
    let mut reviews = reviews_of(&config, owner);
    let before = reviews.len();
    reviews.retain(|review| review["id"] != id);
    if reviews.len() == before {
        return Err(Error::new(404, "Skill review not found."));
    }
    save_workspace(db, owner, &json!({"skillReviews": reviews}))
}

fn enqueue_due(db: &Store, now_ms: i64) -> Result<()> {
    let owners: Vec<String> = crate::service::connections(&db.settings()?)
        .as_object()
        .map(|accounts| accounts.keys().cloned().collect())
        .unwrap_or_default();
    for owner in owners {
        db.transaction(|db| enqueue_owner(db, &owner, now_ms))?;
    }
    Ok(())
}

fn enqueue_owner(db: &Store, owner: &str, now_ms: i64) -> Result<()> {
    let config = db.settings()?;
    if crate::service::connections(&config).get(owner).is_none() {
        return Ok(());
    }
    let current = workspace(&config, owner);
    let skills = current["skills"].as_array().cloned().unwrap_or_default();
    let mut reviews = current["skillReviews"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut cursors = current["skillScheduleCursors"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut changed = false;
    for skill in &skills {
        if skill["enabled"] == false || skill["autoExecute"] != true {
            continue;
        }
        let Some(schedule) = skill
            .get("schedule")
            .filter(|schedule| schedule.is_object())
        else {
            continue;
        };
        let id = string(skill, "id");
        if id.is_empty() {
            continue;
        }
        let last = cursors
            .get(id)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !schedule_due(schedule, &last, now_ms) {
            continue;
        }
        // A review already waiting consumes this slot. Dismissing it does not immediately queue another.
        if reviews.iter().any(|review| review["skillId"] == id) {
            cursors.insert(id.to_owned(), json!(now()));
            changed = true;
            continue;
        }
        if reviews.len() >= MAX_REVIEWS {
            continue;
        }
        reviews.push(review_item(skill, "schedule"));
        cursors.insert(id.to_owned(), json!(now()));
        changed = true;
    }
    if changed {
        save_workspace(
            db,
            owner,
            &json!({"skillReviews": reviews, "skillScheduleCursors": cursors}),
        )?;
    }
    Ok(())
}

fn schedule_due(schedule: &Value, last_queued_at: &str, now_ms: i64) -> bool {
    if schedule["enabled"] != true {
        return false;
    }
    let last = DateTime::parse_from_rfc3339(last_queued_at)
        .ok()
        .map(|date| date.timestamp_millis());
    if schedule["cadence"] == "interval" {
        let Some(hours) = schedule["intervalHours"]
            .as_i64()
            .filter(|hours| (1..=168).contains(hours))
        else {
            return false;
        };
        return last
            .is_none_or(|last| now_ms >= last.saturating_add(hours.saturating_mul(3_600_000)));
    }
    if schedule["cadence"] != "daily" {
        return false;
    }
    let Ok(zone) = string(schedule, "timeZone").parse::<chrono_tz::Tz>() else {
        return false;
    };
    let Some(date) = DateTime::from_timestamp_millis(now_ms) else {
        return false;
    };
    let local = date.with_timezone(&zone);
    if local.format("%H:%M").to_string().as_str() < string(schedule, "time") {
        return false;
    }
    let day = local.format("%Y-%m-%d").to_string();
    let last_day = last
        .and_then(DateTime::from_timestamp_millis)
        .map(|stamp| stamp.with_timezone(&zone).format("%Y-%m-%d").to_string());
    last_day.as_deref() != Some(day.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn unread_query_uses_a_bounded_index_window_before_loading_subjects() {
        use rusqlite::StatementStatus;
        let root = std::env::temp_dir().join(format!("morrow-home-index-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&root).unwrap();
        let owner = "query@example.test";
        db.transaction(|db| {
            let mut statement = db.prepare_message_upsert()?;
            for index in 0..5000 {
                let message = json!({
                    "id": format!("other-{index:05}"),
                    "folder": if index < 4000 { "archive" } else { "inbox" },
                    "date": "2026-10-14T11:00:00.000Z",
                    "read": index >= 4000,
                    "subject": "Fictional cached mail",
                    "body": "Fictional body. ".repeat(100),
                });
                db.upsert_prepared(owner, &message, &mut statement)?;
            }
            for index in 0..40 {
                db.upsert_prepared(
                    owner,
                    &json!({
                        "id": format!("unread-{index:02}"), "folder": "inbox",
                        "date": "2026-10-14T10:00:00.000Z", "read": false,
                        "subject": "Fictional unread mail", "body": "Not projected"
                    }),
                    &mut statement,
                )?;
            }
            Ok(())
        })
        .unwrap();
        let excluded: HashSet<_> = (0..32).map(|index| format!("unread-{index:02}")).collect();
        let excluded_json = serde_json::to_string(&excluded).unwrap();
        {
            let mut plan = db
                .conn
                .prepare(&format!("EXPLAIN QUERY PLAN {UNREAD_INBOX_SQL}"))
                .unwrap();
            let details = plan
                .query_map([owner, &excluded_json], |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                details
                    .iter()
                    .any(|detail| detail.contains("mail_unread_inbox")),
                "{details:?}"
            );
            assert!(
                !details.iter().any(|detail| detail.contains("TEMP B-TREE")),
                "{details:?}"
            );
            let mut query = db.conn.prepare(UNREAD_INBOX_SQL).unwrap();
            let ids = query
                .query_map([owner, &excluded_json], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                ids,
                (32..40)
                    .map(|index| format!("unread-{index:02}"))
                    .collect::<Vec<_>>()
            );
            assert_eq!(query.get_status(StatementStatus::Sort), 0);
            assert!(
                query.get_status(StatementStatus::VmStep) < 2500,
                "Work must depend on the bounded unread/excluded window, not the 5,000 cached read/archive bodies"
            );
        }
        let messages = unread_inbox(&db, owner, &excluded).unwrap();
        assert_eq!(messages.len(), 8);
        assert!(messages.iter().all(|message| message.get("body").is_none()));
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn stamp(hour: u32) -> i64 {
        chrono_tz::UTC
            .with_ymd_and_hms(2026, 10, 14, hour, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn daily_schedule_waits_for_local_time_and_does_not_repeat_the_same_day() {
        let schedule = json!({
            "enabled": true,
            "cadence": "daily",
            "time": "09:00",
            "timeZone": "UTC",
            "intervalHours": 24
        });
        assert!(!schedule_due(&schedule, "", stamp(8)));
        assert!(schedule_due(&schedule, "", stamp(10)));
        let queued_at = DateTime::from_timestamp_millis(stamp(10))
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(!schedule_due(&schedule, &queued_at, stamp(11)));
        assert!(schedule_due(&schedule, "", stamp(10)) && schedule["enabled"] == true);
    }

    #[test]
    fn interval_schedule_uses_the_saved_cursor() {
        let schedule = json!({
            "enabled": true,
            "cadence": "interval",
            "time": "09:00",
            "timeZone": "UTC",
            "intervalHours": 2
        });
        assert!(schedule_due(&schedule, "", stamp(8)));
        let queued_at = DateTime::from_timestamp_millis(stamp(8))
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(!schedule_due(&schedule, &queued_at, stamp(9)));
        assert!(schedule_due(&schedule, &queued_at, stamp(11)));
        let mut disabled = schedule.clone();
        disabled["enabled"] = json!(false);
        assert!(!schedule_due(&disabled, "", stamp(12)));
    }

    #[test]
    fn todos_use_summary_priority_and_omit_message_bodies() {
        let categories = default_categories();
        let summary = json!({
            "id": "m1",
            "folder": "inbox",
            "read": false,
            "subject": "Need a decision",
            "body": "SECRET-BODY"
        });
        let unread = json!({
            "id": "m2",
            "folder": "inbox",
            "read": false,
            "subject": "Unread note",
            "body": "SECRET-BODY"
        });
        let mut messages = HashMap::new();
        messages.insert("m1".into(), summary);
        messages.insert("m2".into(), unread.clone());
        let items = vec![json!({"messageId": "m1", "priority": "P0", "summary": "Decide today"})];
        let todos = assemble_todos(
            "a@example.test",
            &categories,
            &items,
            std::slice::from_ref(&unread),
            &messages,
            &HashSet::new(),
        );
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0]["categoryId"], "decision");
        assert_eq!(todos[0]["source"], "summary");
        assert_eq!(todos[0]["detail"], "Decide today");
        assert_eq!(todos[0]["canMarkRead"], true);
        assert_eq!(todos[1]["source"], "mail");
        assert_eq!(todos[1]["categoryId"], "follow-up");
        let rendered = serde_json::to_string(&todos).unwrap();
        assert!(!rendered.contains("SECRET-BODY"));
        let completed = HashSet::from([todos[0]["id"].as_str().unwrap().to_owned()]);
        let remaining = assemble_todos(
            "a@example.test",
            &categories,
            &items,
            std::slice::from_ref(&unread),
            &messages,
            &completed,
        );
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["messageId"], "m2");
    }
}
