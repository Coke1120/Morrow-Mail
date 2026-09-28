//! Reviewed, source-bound memory. Manual notes and writing style stay independent.
use crate::{
    ai,
    error::{Error, Result},
    policy,
    service::{App, Context, save_workspace, valid_account, workspace},
    store::{Store, catalog, merge, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::HashSet;

fn proof(message: &Value) -> String {
    ai::hash(&json!([
        message["id"],
        message["date"],
        message["subject"],
        message["body"],
        message["fromName"],
        message["fromEmail"],
        message["to"]
    ]))
}

fn sources(
    db: &Store,
    owner: &str,
    ids: &[Value],
    policy: &Value,
    skill: &Value,
) -> Result<Option<Vec<Value>>> {
    let mut result = Vec::new();
    for id in ids {
        let Some(message) = db.get(owner, id.as_str().unwrap_or(""))? else {
            return Ok(None);
        };
        let folder = string(&message, "folder");
        if policy["folders"][folder] != true
            || (!skill["folders"].is_null() && skill["folders"][folder] != true)
        {
            return Ok(None);
        }
        result.push(json!({"id":id,"hash":proof(&policy::redact(&message, policy))}));
    }
    Ok(Some(result))
}

/// Shared by interactive, scheduled and batch AI; proofs never enter the model payload.
pub fn context(db: &Store, config: &Value, owner: &str, skill: &Value) -> Result<Value> {
    let policy = policy::resolve(&config["policy"]);
    let brain = &workspace(config, owner)["brain"];
    if !valid_account(config, owner)
        || policy["enabled"] != true
        || policy["behaviors"]["memory"] != true
        || !["contacts", "sender", "body", "subject"]
            .iter()
            .all(|key| policy["content"][key] == true)
        || !brain.is_object()
    {
        return Ok(Value::Null);
    }
    let mut result = json!({});
    if let Some(proofs) = sources(
        db,
        owner,
        brain["sourceMessageIds"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &policy,
        skill,
    )? {
        for key in ["voice", "notes", "contacts"] {
            if let Some(value) = brain.get(key) {
                result[key] = value.clone();
            }
        }
        result["sourceProofs"] = json!(proofs);
    }
    let mut facts = Vec::new();
    for fact in brain["facts"].as_array().into_iter().flatten().take(50) {
        let ids: Vec<_> = fact["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| s["id"].clone())
            .collect();
        if !ids.is_empty()
            && let Some(current) = sources(db, owner, &ids, &policy, skill)?
            && json!(current) == fact["sources"]
        {
            facts.push(fact.clone());
        }
    }
    result["facts"] = json!(facts);
    Ok(result)
}

fn validate(db: &Store, owner: &str, preview: &Value) -> Result<()> {
    let config = db.settings()?;
    if preview["account"] != owner
        || preview["action"] != "brain-suggestion"
        || preview["expiresAt"].as_i64().unwrap_or(0) < Utc::now().timestamp_millis()
        || !valid_account(&config, owner)
        || preview["generation"] != ai::generation(&config, owner)
    {
        return Err(Error::conflict(
            "Memory preview expired or its account/settings changed. Review a new preview.",
        ));
    }
    let policy = policy::resolve(&config["policy"]);
    policy::require(&policy, "memory")?;
    for previous in preview["messages"].as_array().into_iter().flatten() {
        let current = db
            .get(owner, string(previous, "id"))?
            .unwrap_or(Value::Null);
        if policy["folders"][string(&current, "folder")] != true
            || proof(&policy::redact(&current, &policy)) != proof(previous)
        {
            return Err(Error::conflict(
                "Source mail changed. Review a new memory preview.",
            ));
        }
    }
    Ok(())
}

async fn propose(
    app: &App,
    owner: &str,
    context: ai::AssistanceContext,
    expires: i64,
) -> Result<Value> {
    let response = ai::run_model(&app.0.client, &context.config["ai"], "memory", &context.messages, "",
            &json!({"preferences":merge(catalog()["preferences"].clone(), &context.config["preferences"]),"timeZone":context.policy["summarySchedule"]["timeZone"]})).await;
    let response = response?;
    let parsed: Value = serde_json::from_str(string(&response, "text"))
        .map_err(|_| Error::new(502, "The model returned invalid memory suggestions."))?;
    let items = parsed["items"]
        .as_array()
        .filter(|items| items.len() <= 8)
        .ok_or_else(|| Error::new(502, "The model returned invalid memory suggestions."))?;
    let mut facts = Vec::new();
    for item in items {
        let text = crate::validation::text(&item["text"], "Suggested memory", 500, false)?.trim();
        let ids = item["messageIds"]
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= context.messages.len())
            .ok_or_else(|| Error::new(502, "A suggested memory is missing its sources."))?;
        let mut proofs = Vec::new();
        let mut labels = Vec::new();
        let mut seen = HashSet::new();
        for id in ids {
            let source = context
                .messages
                .iter()
                .find(|m| m["id"] == *id)
                .ok_or_else(|| Error::new(502, "A suggested memory cites an unknown source."))?;
            if seen.insert(id.to_string()) {
                proofs.push(json!({"id":id,"hash":proof(source)}));
                labels.push(json!({"id":id,"subject":source["subject"],"date":source["date"]}));
            }
        }
        facts.push(json!({"id":uuid::Uuid::new_v4().to_string(),"text":text,"sources":proofs,"sourceLabels":labels,"createdAt":now()}));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let preview = json!({"id":id,"action":"brain-suggestion","account":owner,"generation":ai::generation(&context.config,owner),
            "messages":context.messages,"items":facts,"expiresAt":expires});
    Ok(preview)
}

fn automation(settings: &Value, owner: &str) -> Value {
    merge(
        json!({"enabled":false,"tokenBudget":16000}),
        &settings["brainLearning"][owner],
    )
}
fn write_automation(db: &Store, owner: &str, value: &Value) -> Result<()> {
    let mut all = db.settings()?["brainLearning"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    all.insert(owner.into(), value.clone());
    db.set_settings(&json!({"brainLearning":all}))?;
    Ok(())
}
pub fn initialize(db: &Store) -> Result<()> {
    let settings = db.settings()?;
    for (owner, value) in settings["brainLearning"].as_object().into_iter().flatten() {
        if value["status"] == "running" {
            let mut value = value.clone();
            value["status"] = "interrupted".into();
            value["error"] = "Analysis was interrupted. Tokens may have been used; use Suggest Memories to retry.".into();
            write_automation(db, owner, &value)?;
        }
    }
    Ok(())
}
fn visible(preview: &Value) -> Value {
    json!({"id":preview["id"],"items":preview["items"],"messageCount":preview["messages"].as_array().map_or(0,Vec::len)})
}
pub fn learning_state(db: &Store, owner: &str) -> Result<Value> {
    let value = automation(&db.settings()?, owner);
    let preview = &value["preview"];
    Ok(
        json!({"enabled":value["enabled"],"tokenBudget":value["tokenBudget"],"status":value["status"],"lastAt":value["lastAt"],"error":value["error"],"preview":if preview.is_object() && validate(db,owner,preview).is_ok(){visible(preview)}else{Value::Null}}),
    )
}
/// One reviewed proposal at a time; weekly opt-in authorizes generation, never application.
pub async fn scheduled_tick(app: &App) -> Result<()> {
    let work = app.db(|db| {
        let settings = db.settings()?;
        let now = Utc::now().timestamp_millis();
        for owner in crate::service::connections(&settings).as_object().unwrap().keys() {
            let mut value = automation(&settings,owner);
            if value["enabled"] != true || now < value["lastAt"].as_i64().unwrap_or(0).saturating_add(7*86400000)
                || (value["preview"].is_object() && validate(db,owner,&value["preview"]).is_ok()) { continue; }
            let Ok(mut context) = ai::context_for(db,"memory",&json!({}),owner) else { continue; };
            if string(&settings["ai"],"model").is_empty() || string(&settings["ai"],"baseUrl").is_empty()
                || !["subject","body","sender"].iter().all(|k| context.policy["content"][k] == true) { continue; }
            let budget = value["tokenBudget"].as_u64().unwrap_or(16000);
            let options = json!({"preferences":merge(catalog()["preferences"].clone(),&settings["preferences"]),"timeZone":context.policy["summarySchedule"]["timeZone"]});
            while !context.messages.is_empty() && serde_json::to_vec(&ai::model_payload(&context.config["ai"],"memory",&context.messages,"",&options)?)?.len() as u64 + context.config["ai"]["maxTokens"].as_u64().unwrap_or(1200) + 256 > budget { context.messages.pop(); }
            if context.messages.is_empty() { continue; }
            let fingerprint = ai::hash(&json!(context.messages.iter().map(proof).collect::<Vec<_>>()));
            if value["fingerprint"] == fingerprint { continue; }
            value["lastAt"] = now.into(); value["fingerprint"] = fingerprint.into(); value["status"] = "running".into(); value["error"] = "".into(); value["preview"] = Value::Null;
            write_automation(db,owner,&value)?;
            return Ok(Some((owner.clone(),context,value)));
        }
        Ok(None)
    }).await?;
    if let Some((owner, context, claim)) = work {
        let result = propose(app, &owner, context, i64::MAX).await;
        app.db(move |db| {
            let mut value = automation(&db.settings()?,&owner);
            if value != claim { return Ok(()); }
            match result {
                Ok(preview) if validate(db,&owner,&preview).is_ok() => { value["status"] = "ready".into(); value["preview"] = preview; }
                _ => { value["status"] = "failed".into(); value["error"] = "Memory analysis failed or its context changed. Review settings and use Suggest Memories to retry.".into(); }
            }
            write_automation(db,&owner,&value)
        }).await?;
    }
    Ok(())
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path: Vec<_> = ctx.path.iter().map(String::as_str).collect();
    if ctx.method == "DELETE"
        && let ["workspace", "brain", "facts", id] = path.as_slice()
    {
        let owner = ctx.owner.clone();
        let id = id.to_string();
        app.db(move |db| {
            db.transaction(|db| {
                let config = db.settings()?;
                if !valid_account(&config, &owner) {
                    return Err(Error::conflict("Choose a connected mailbox."));
                }
                let mut brain = workspace(&config, &owner)["brain"].clone();
                let mut facts = brain["facts"].as_array().cloned().unwrap_or_default();
                let count = facts.len();
                facts.retain(|fact| fact["id"] != id);
                if facts.len() == count {
                    return Err(Error::new(404, "Memory not found."));
                }
                brain["facts"] = json!(facts);
                save_workspace(db, &owner, &json!({"brain":brain}))?;
                ai::invalidate(db)
            })
        })
        .await?;
        return Ok(Some(
            Json(app.state(&ctx.owner, ctx.paged).await?).into_response(),
        ));
    }
    if ctx.method == "POST"
        && matches!(
            path.as_slice(),
            ["workspace", "brain", "settings" | "dismiss"]
        )
    {
        let owner = ctx.owner.clone();
        let input = ctx.body.clone();
        let settings_action = path[2] == "settings";
        app.db(move |db| {
            if !crate::service::connections(&db.settings()?)
                .get(&owner)
                .is_some_and(Value::is_object)
            {
                return Err(Error::conflict("Choose a connected mailbox."));
            }
            let mut value = automation(&db.settings()?, &owner);
            if settings_action {
                if !input.as_object().is_some_and(|v| {
                    v.len() == 2 && v.contains_key("enabled") && v.contains_key("tokenBudget")
                }) || !input["enabled"].is_boolean()
                    || !input["tokenBudget"]
                        .as_u64()
                        .is_some_and(|n| (4000..=64000).contains(&n))
                {
                    return Err(Error::invalid(
                        "Choose automatic memory updates and a 4,000–64,000 token budget.",
                    ));
                }
                value["enabled"] = input["enabled"].clone();
                value["tokenBudget"] = input["tokenBudget"].clone();
                // Saving opts in once; the first eligible sample can run on the next scheduler tick.
                value["status"] = "waiting".into();
                value["error"] = "".into();
            } else {
                if value["preview"]["id"] != input["previewId"] {
                    return Err(Error::conflict("Memory proposal changed. Refresh first."));
                }
                value["preview"] = Value::Null;
                value["status"] = "waiting".into();
            }
            write_automation(db, &owner, &value)
        })
        .await?;
        return Ok(Some(
            Json(app.state(&ctx.owner, ctx.paged).await?).into_response(),
        ));
    }
    if ctx.method != "POST"
        || !matches!(path.as_slice(), ["workspace", "brain", "preview" | "apply"])
    {
        return Ok(None);
    }
    let owner = ctx.owner.clone();
    if path[2] == "preview" {
        let account = owner.clone();
        let context = app
            .db(move |db| {
                let context = ai::context_for(db, "memory", &json!({}), &account)?;
                if string(&context.config["ai"], "model").is_empty()
                    || string(&context.config["ai"], "baseUrl").is_empty()
                {
                    return Err(Error::conflict(
                        "Save an AI model before suggesting memories.",
                    ));
                }
                if !["subject", "body", "sender"]
                    .iter()
                    .all(|key| context.policy["content"][key] == true)
                {
                    return Err(Error::new(
                        403,
                        "Memory suggestions require subject, body, sender and contact permissions.",
                    ));
                }
                Ok(context)
            })
            .await?;
        let preview = propose(app, &owner, context, Utc::now().timestamp_millis() + 600000).await?;
        let id = string(&preview, "id").to_owned();
        let runtime = app.0.clone();
        let visible = app.db(move |db| {
            validate(db, &owner, &preview)?;
            let mut previews = runtime.workflows.lock().map_err(|_| Error::new(503,"Previews are unavailable."))?;
            previews.retain(|_, p| p["expiresAt"].as_i64().unwrap_or(0) >= Utc::now().timestamp_millis());
            if previews.len() >= 100 { return Err(Error::new(429,"Too many previews. Dismiss old previews or wait ten minutes.")); }
            let visible = json!({"id":id,"items":preview["items"],"messageCount":preview["messages"].as_array().map_or(0,Vec::len)});
            previews.insert(id, preview);
            Ok(visible)
        }).await?;
        return Ok(Some(Json(json!({"preview":visible})).into_response()));
    }
    let input = ctx.body.clone();
    let runtime = app.0.clone();
    app.db(move |db| {
        let mut previews = runtime
            .workflows
            .lock()
            .map_err(|_| Error::new(503, "Previews are unavailable."))?;
        let id = string(&input, "previewId");
        let automatic = automation(&db.settings()?, &owner);
        let preview = previews
            .get(id)
            .cloned()
            .or_else(|| (automatic["preview"]["id"] == id).then(|| automatic["preview"].clone()))
            .ok_or_else(|| Error::conflict("Review a fresh memory preview."))?;
        let selected = input["itemIds"]
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= 8)
            .ok_or_else(|| Error::invalid("Select the memories you want to save."))?;
        db.transaction(|db| {
            validate(db, &owner, &preview)?;
            let config = db.settings()?;
            let mut brain = workspace(&config, &owner)["brain"].clone();
            if !brain.is_object() {
                brain = json!({});
            }
            let mut facts = brain["facts"].as_array().cloned().unwrap_or_default();
            for id in selected {
                let fact = preview["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["id"] == *id)
                    .ok_or_else(|| {
                        Error::invalid("Select only items from the reviewed preview.")
                    })?;
                if !facts.iter().any(|saved| {
                    saved["text"] == fact["text"] && saved["sources"] == fact["sources"]
                }) {
                    facts.push(fact.clone());
                }
            }
            if facts.len() > 50 {
                return Err(Error::conflict(
                    "Keep at most 50 reviewed memories. Remove old memories first.",
                ));
            }
            brain["facts"] = json!(facts);
            brain["updatedAt"] = now().into();
            if automatic["preview"]["id"] == id {
                let mut automatic = automatic.clone();
                automatic["preview"] = Value::Null;
                automatic["status"] = "waiting".into();
                write_automation(db, &owner, &automatic)?;
            }
            save_workspace(db, &owner, &json!({"brain":brain}))?;
            ai::invalidate(db)
        })?;
        previews.remove(id);
        Ok(())
    })
    .await?;
    Ok(Some(
        Json(app.state(&ctx.owner, ctx.paged).await?).into_response(),
    ))
}
