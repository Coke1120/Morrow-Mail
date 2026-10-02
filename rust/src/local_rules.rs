//! Explicitly reviewed local markers; never provider moves or automatic actions.
use crate::{
    ai,
    error::{Error, Result},
    pages,
    service::{App, Context, connections, save_workspace, workspace},
    store::{Store, string},
    validation,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use serde_json::{Value, json};

fn rule(input: &Value) -> Result<Value> {
    let condition = validation::text(&input["condition"], "Condition", 30, false)?;
    let action = validation::text(&input["action"], "Local action", 30, false)?;
    if !["sender", "domain", "subject"].contains(&condition)
        || !["starred", "pending", "lowPriority"].contains(&action)
    {
        return Err(Error::invalid(
            "Choose a sender, domain or subject condition and a local marker.",
        ));
    }
    let value = validation::text(&input["value"], "Match text", 254, false)?
        .trim()
        .to_lowercase();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(Error::invalid(
            "Enter match text without control characters.",
        ));
    }
    if condition == "sender" {
        validation::email(&json!(value))?;
    }
    if condition == "domain"
        && (value.contains(['@', ' ', '/', ':'])
            || !value.contains('.')
            || value.starts_with('.')
            || value.ends_with('.'))
    {
        return Err(Error::invalid(
            "Enter an exact sender domain, such as example.com.",
        ));
    }
    Ok(json!({"condition":condition,"value":value,"action":action}))
}
fn matches(message: &Value, rule: &Value) -> bool {
    let sender = string(message, "fromEmail").trim().to_lowercase();
    match string(rule, "condition") {
        "sender" => sender == string(rule, "value"),
        "domain" => sender
            .rsplit_once('@')
            .is_some_and(|(_, domain)| domain == string(rule, "value")),
        "subject" => string(message, "subject")
            .to_lowercase()
            .contains(string(rule, "value")),
        _ => false,
    }
}
fn live_settings(db: &Store, owner: &str) -> Result<Value> {
    let settings = db.settings()?;
    if owner == "demo" || connections(&settings).get(owner).is_none() {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    Ok(settings)
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if ctx.path.first().map(String::as_str) != Some("workspace")
        || ctx.path.get(1).map(String::as_str) != Some("rules")
    {
        return Ok(None);
    }
    let context = ctx.clone();
    let owner = app
        .db(move |db| {
            let settings = db.settings()?;
            let owner = context.read_owner(&settings, false)?;
            if owner == "demo" {
                return Err(Error::conflict("Choose a connected mailbox."));
            }
            Ok(owner)
        })
        .await?;
    let input = ctx.body.clone();
    let value = match (
        ctx.method.as_str(),
        ctx.path.len(),
        ctx.path.get(2).map(String::as_str),
    ) {
        ("GET", 2, _) => app.db(move |db| Ok(json!({"rules": workspace(&live_settings(db, &owner)?, &owner)["rules"].as_array().cloned().unwrap_or_default()}))).await?,
        ("POST", 3, Some("preview")) => {
            let rule = rule(&input)?;
            let id = uuid::Uuid::new_v4().to_string();
            let preview = app.db(move |db| {
                let settings = live_settings(db, &owner)?;
                // ponytail: inspect newest 500 downloaded Inbox rows per manual review; add indexed full-mailbox matching if needed.
                let mut statement = db.conn.prepare("SELECT data FROM messages WHERE account=? AND json_extract(data,'$.folder')='inbox' ORDER BY json_extract(data,'$.date') DESC,id LIMIT 500")?;
                let rows = statement.query_map([&owner], |row| row.get::<_, String>(0))?;
                let mut messages = Vec::new();
                let mut scanned = 0;
                for row in rows { let message: Value = serde_json::from_str(&row?)?; scanned += 1; if matches(&message, &rule) { let mut source=pages::summary(&message); source["hash"]=ai::hash(&message).into(); messages.push(source); } }
                Ok(json!({"id":id,"action":"local-rule","account":owner,"connection":connections(&settings)[&owner]["connectionId"],"rule":rule,"scanned":scanned,"messages":messages,"expiresAt":Utc::now().timestamp_millis()+600_000}))
            }).await?;
            let response = json!({"previewId":preview["id"],"accountId":preview["account"],"rule":preview["rule"],"scanned":preview["scanned"],"messages":preview["messages"].as_array().unwrap().iter().map(|m| pages::owned(string(&preview,"account"),pages::summary(m))).collect::<Vec<_>>()});
            let mut reviews = app
                .0
                .workflows
                .lock()
                .map_err(|_| Error::new(500, "Review lock failed."))?;
            reviews.retain(|_, p| {
                p["expiresAt"].as_i64().unwrap_or(0) > Utc::now().timestamp_millis()
            });
            if reviews.len() >= 200 {
                return Err(Error::conflict(
                    "Too many pending reviews. Try again later.",
                ));
            }
            reviews.insert(string(&preview, "id").to_owned(), preview);
            response
        }
        ("POST", 3, Some("apply")) => {
            let preview = app
                .0
                .workflows
                .lock()
                .map_err(|_| Error::new(500, "Review lock failed."))?
                .remove(string(&input, "previewId"))
                .ok_or_else(|| Error::conflict("Review a new rule preview."))?;
            app.db(move |db| apply(db, &owner, &preview)).await?
        }
        ("DELETE", 3, Some(id)) => {
            let id = id.to_owned();
            app.db(move |db| {
                let mut rules = workspace(&live_settings(db, &owner)?, &owner)["rules"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                rules.retain(|r| r["id"] != id);
                save_workspace(db, &owner, &json!({"rules":rules}))?;
                Ok(json!({"removed":true}))
            })
            .await?
        }
        _ => return Err(Error::new(404, "Rule route not found.")),
    };
    Ok(Some(Json(value).into_response()))
}
fn apply(db: &Store, owner: &str, preview: &Value) -> Result<Value> {
    let settings = live_settings(db, owner)?;
    if preview["action"] != "local-rule"
        || preview["account"] != owner
        || connections(&settings).get(owner).is_none()
        || preview["connection"] != connections(&settings)[owner]["connectionId"]
        || preview["expiresAt"].as_i64().unwrap_or(0) <= Utc::now().timestamp_millis()
    {
        return Err(Error::conflict(
            "Rule preview expired or its mailbox changed. Review again.",
        ));
    }
    let rule = rule(&preview["rule"])?;
    let messages = preview["messages"]
        .as_array()
        .ok_or_else(|| Error::invalid("Invalid rule preview."))?;
    let mut rules = workspace(&settings, owner)["rules"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !rules.iter().any(|r| {
        r["condition"] == rule["condition"]
            && r["value"] == rule["value"]
            && r["action"] == rule["action"]
    }) {
        if rules.len() >= 30 {
            return Err(Error::conflict(
                "Remove a saved rule before adding another (limit 30).",
            ));
        }
        let mut saved = rule.clone();
        saved["id"] = uuid::Uuid::new_v4().to_string().into();
        rules.push(saved);
    }
    db.transaction(|db| {
        let mut current_messages = Vec::new();
        for previous in messages {
            let current = db
                .get(owner, string(previous, "id"))?
                .ok_or_else(|| Error::conflict("Source mail changed. Review again."))?;
            if previous["hash"] != ai::hash(&current) {
                return Err(Error::conflict("Source mail changed. Review again."));
            }
            current_messages.push(current);
        }
        for message in &current_messages {
            let mut patch = json!({});
            let action = string(&rule, "action");
            patch[action] = true.into();
            if action == "starred" && message["providerLabelIds"].is_array() {
                let mut overrides = message["localOverrides"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                overrides.insert("starred".into(), true.into());
                patch["localOverrides"] = overrides.into();
            }
            db.update(owner, string(message, "id"), &patch)?;
        }
        save_workspace(db, owner, &json!({"rules":rules}))?;
        Ok(json!({"applied":messages.len(),"accountId":owner}))
    })
}
