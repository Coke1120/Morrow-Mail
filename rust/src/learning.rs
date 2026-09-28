use crate::{
    ai::{hash, model_payload, run_model, truncate},
    error::{Error, Result},
    policy,
    service::{App, Context, connections},
    store::{Store, merge, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Months, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::LazyLock,
};

fn defaults() -> Value {
    json!({"enabled":false,"weekly":false,"months":3,"maxSamples":50,"tokenBudget":16000})
}
fn empty_identity() -> Value {
    json!({"displayName":"","aliases":[],"confirmed":false})
}
fn checked_identity(input: &Value) -> Result<Value> {
    if !input.as_object().is_some_and(|map| {
        map.len() == 3
            && map
                .keys()
                .all(|key| ["displayName", "aliases", "confirmed"].contains(&key.as_str()))
    }) || !input["confirmed"].is_boolean()
        || !input["aliases"]
            .as_array()
            .is_some_and(|aliases| aliases.len() <= 10)
    {
        return Err(Error::invalid(
            "Provide a display name, up to 10 aliases and explicit identity confirmation.",
        ));
    }
    fn name(value: &Value, empty: bool) -> Result<String> {
        let text = crate::validation::text(value, "Name", 100, empty)?;
        if text
            .chars()
            .any(|c| c.is_control() || ['\u{2028}', '\u{2029}'].contains(&c))
        {
            return Err(Error::invalid(
                "Names must be single-line text of 1–100 characters.",
            ));
        }
        Ok(text.trim().to_owned())
    }
    let display_name = name(&input["displayName"], input["confirmed"] != true)?;
    let mut seen = HashSet::from([display_name.to_lowercase()]);
    let mut aliases = Vec::new();
    for input in input["aliases"].as_array().unwrap() {
        let alias = name(input, false)?;
        if seen.insert(alias.to_lowercase()) {
            aliases.push(alias);
        }
    }
    Ok(json!({"displayName":display_name,"aliases":aliases,"confirmed":input["confirmed"]}))
}
/// Explicit account-owned context only. Callers must still enforce AI/content permissions.
pub fn identity(settings: &Value, owner: &str) -> Value {
    let value = checked_identity(&settings["styleLearning"][owner]["settings"]["identity"])
        .unwrap_or_else(|_| empty_identity());
    if !["all", "demo"].contains(&owner)
        && connections(settings)
            .get(owner)
            .is_some_and(Value::is_object)
        && value["confirmed"] == true
    {
        json!({"displayName":value["displayName"],"aliases":value["aliases"]})
    } else {
        Value::Null
    }
}
fn config(settings: &Value, owner: &str) -> Value {
    let mut options = merge(defaults(), &settings["styleLearning"][owner]["settings"]);
    options["identity"] =
        checked_identity(&options["identity"]).unwrap_or_else(|_| empty_identity());
    options
}
fn style_options(settings: &Value, owner: &str) -> Value {
    let mut options = config(settings, owner);
    options.as_object_mut().unwrap().remove("identity");
    options
}
fn read(settings: &Value, owner: &str) -> Value {
    merge(
        json!({"settings":defaults()}),
        &settings["styleLearning"][owner],
    )
}
fn write(db: &Store, owner: &str, value: Value) -> Result<()> {
    let mut learning = db.settings()?["styleLearning"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    learning.insert(owner.into(), value);
    db.set_settings(&json!({"styleLearning":learning}))?;
    Ok(())
}
fn permitted(settings: &Value, owner: &str) -> bool {
    let policy = policy::resolve(&settings["policy"]);
    connections(settings).get(owner).is_some()
        && config(settings, owner)["enabled"] == true
        && policy["enabled"] == true
        && policy["behaviors"]["memory"] == true
        && policy["folders"]["sent"] == true
        && policy["content"]["body"] == true
}
fn stamp(settings: &Value, owner: &str) -> String {
    let connections = connections(settings);
    let connection = &connections[owner];
    hash(&json!([
        connection
            .get("connectionId")
            .unwrap_or(&connection["email"]),
        settings["ai"],
        policy::resolve(&settings["policy"]),
        settings["preferences"],
        style_options(settings, owner)
    ]))
}
// ponytail: deterministic quote/signature heuristics; samples remain reviewable because mail formats vary.
pub fn own_text(body: &str) -> String {
    static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*>").unwrap());
    static CUT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?im)\n(?:On .{3,200}wrote:|在.{3,200}(?:寫道|写道)[：:]|[-_ ]{2,}(?:Original Message|Forwarded message|原始郵件|轉寄郵件)|From:\s|寄件者[：:]|--\s*$|Sent from my |Get Outlook for |CONFIDENTIAL(?:ITY)?\b|DISCLAIMER\b|免責聲明|保密聲明)").unwrap()
    });
    let text = body
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .filter(|line| !QUOTE.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    CUT.split(&text).next().unwrap_or("").trim().to_owned()
}
fn source(db: &Store, owner: &str, id: &str) -> Result<Value> {
    Ok(match db.get(owner, id)? {
        Some(m)
            if m["folder"] == "sent"
                && string(&m, "fromEmail").eq_ignore_ascii_case(owner)
                && m["automated"] != true =>
        {
            json!(own_text(string(&m, "body")))
        }
        _ => Value::Null,
    })
}
fn sources_valid(db: &Store, owner: &str, sources: &Value) -> Result<bool> {
    let Some(items) = sources.as_array() else {
        return Ok(false);
    };
    for item in items {
        if item["hash"] != hash(&source(db, owner, string(item, "id"))?) {
            return Ok(false);
        }
    }
    Ok(true)
}
fn valid(db: &Store, settings: &Value, owner: &str, preview: &Value) -> Result<bool> {
    Ok(permitted(settings, owner)
        && preview.is_object()
        && preview["stamp"] == stamp(settings, owner)
        && preview
            .get("generation")
            .is_none_or(|v| *v == settings["aiGeneration"])
        && (preview["baseProfile"].is_null()
            || (preview["baseProfile"] == read(settings, owner)["profile"]
                && sources_valid(db, owner, &preview["baseProfile"]["sources"])?))
        && sources_valid(db, owner, &preview["sources"])?)
}
pub fn voice(db: &Store, settings: &Value, owner: &str) -> Result<String> {
    let profile = &settings["styleLearning"][owner]["profile"];
    Ok(
        if permitted(settings, owner)
            && profile.is_object()
            && sources_valid(db, owner, &profile["sources"])?
        {
            string(profile, "voice").into()
        } else {
            String::new()
        },
    )
}
/// Conservative projection when source data is unavailable. Use state_with_store for the UI.
pub fn state(settings: &Value, owner: &str) -> Value {
    let value = read(settings, owner);
    let profile = &value["profile"];
    json!({"settings":config(settings,owner),"permitted":permitted(settings,owner),"profile":if profile.is_object(){json!({"voice":profile["voice"],"updatedAt":profile["updatedAt"],"active":false})}else{Value::Null},"preview":null,"lastWeeklyAt":value.get("lastWeeklyAt").cloned().unwrap_or(Value::Null)})
}
pub fn state_with_store(db: &Store, settings: &Value, owner: &str) -> Result<Value> {
    let mut state = state(settings, owner);
    let value = read(settings, owner);
    let preview = &value["preview"];
    if state["profile"].is_object() {
        state["profile"]["active"] = (!voice(db, settings, owner)?.is_empty()).into();
    }
    if valid(db, settings, owner, preview)? {
        let mut visible = json!({});
        for key in [
            "id",
            "status",
            "createdAt",
            "incremental",
            "eligible",
            "sampleCount",
            "effectiveCap",
            "estimatedTokens",
            "tokenBudget",
            "voice",
            "usage",
            "error",
        ] {
            if let Some(value) = preview.get(key) {
                visible[key] = value.clone();
            }
        }
        visible["samples"] = json!(
            preview["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| json!({"body":i["body"]}))
                .collect::<Vec<_>>()
        );
        state["preview"] = visible;
    }
    Ok(state)
}
pub fn initialize(db: &Store) -> Result<()> {
    let settings = db.settings()?;
    for (owner, value) in settings["styleLearning"].as_object().into_iter().flatten() {
        if value["preview"]["status"] == "running" {
            let mut value = value.clone();
            value["preview"]["status"] = "interrupted".into();
            value["preview"]["error"] =
                "Interrupted by shutdown. Tokens may have been used. Prepare new samples to retry."
                    .into();
            write(db, owner, value)?;
        }
    }
    Ok(())
}
pub fn update_settings(db: &Store, owner: &str, input: &Value) -> Result<()> {
    update_settings_at(db, owner, input, Utc::now())
}
pub fn update_settings_at(
    db: &Store,
    owner: &str,
    input: &Value,
    time: DateTime<Utc>,
) -> Result<()> {
    let settings = db.settings()?;
    if connections(&settings).get(owner).is_none() {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    if !input.as_object().is_some_and(|map| {
        map.keys()
            .all(|key| key == "identity" || defaults().get(key).is_some())
    }) {
        return Err(Error::invalid("Invalid style settings."));
    }
    let previous = config(&settings, owner);
    let mut next = merge(previous.clone(), input);
    if input.get("identity").is_some() {
        next["identity"] = checked_identity(&input["identity"])?;
    }
    if !next["enabled"].is_boolean()
        || !next["weekly"].is_boolean()
        || !next["months"]
            .as_u64()
            .is_some_and(|n| [1, 3, 6, 12].contains(&n))
        || !next["maxSamples"]
            .as_u64()
            .is_some_and(|n| (1..=50).contains(&n))
        || !next["tokenBudget"]
            .as_u64()
            .is_some_and(|n| (4000..=64000).contains(&n))
    {
        return Err(Error::invalid(
            "Choose 1–50 samples and a 4,000–64,000 token budget.",
        ));
    }
    if next["weekly"] == true && next["enabled"] != true {
        return Err(Error::invalid(
            "Enable style learning before weekly updates.",
        ));
    }
    let mut current = read(&settings, owner);
    let identity_changed = next["identity"] != previous["identity"];
    if identity_changed {
        current["preview"] = Value::Null;
    }
    if input
        .as_object()
        .unwrap()
        .keys()
        .any(|key| key != "identity")
    {
        if next["weekly"] == true && previous["weekly"] != true {
            current["weeklySince"] = time.to_rfc3339_opts(SecondsFormat::Millis, true).into();
        }
        current["preview"] = Value::Null;
        current["lastWeeklyAt"] = if next["weekly"] == true && previous["weekly"] != true {
            time.timestamp_millis().saturating_sub(7 * 86400000).into()
        } else {
            time.timestamp_millis().into()
        };
    }
    current["settings"] = next;
    db.transaction(|db| {
        write(db, owner, current)?;
        if identity_changed {
            crate::ai::invalidate(db)?;
        }
        Ok(())
    })
}
fn model_settings(settings: &Value) -> Value {
    merge(
        settings["ai"].clone(),
        &json!({"maxTokens":settings["ai"]["maxTokens"].as_u64().unwrap_or(1200).min(1200)}),
    )
}
fn model_options(settings: &Value, baseline: &Value) -> Value {
    json!({"preferences":settings.get("preferences").cloned().unwrap_or(json!({})),"includeUsage":true,"previousStyle":baseline.get("voice").cloned().unwrap_or(Value::Null)})
}
fn estimate(settings: &Value, messages: &[Value], baseline: &Value) -> Result<usize> {
    let ai = model_settings(settings);
    Ok(serde_json::to_vec(&model_payload(
        &ai,
        "style",
        messages,
        "",
        &model_options(settings, baseline),
    )?)?
    .len()
        + 256
        + ai["maxTokens"].as_u64().unwrap_or(1200) as usize)
}
pub fn prepare(db: &Store, owner: &str, incremental: bool) -> Result<Value> {
    prepare_at(db, owner, incremental, Utc::now())
}
pub fn prepare_at(
    db: &Store,
    owner: &str,
    incremental: bool,
    time: DateTime<Utc>,
) -> Result<Value> {
    let settings = db.settings()?;
    if !permitted(&settings, owner) {
        return Err(Error::new(
            403,
            "Enable style learning, Email Brain, Sent folder and email body access in AI permissions.",
        ));
    }
    let current = read(&settings, owner);
    let options = config(&settings, owner);
    if string(&settings["ai"], "baseUrl").is_empty() || string(&settings["ai"], "model").is_empty()
    {
        return Err(Error::conflict("Configure an AI model first."));
    }
    if current["preview"]["status"] == "running" {
        return Err(Error::conflict("Style analysis is already running."));
    }
    let end = time.to_rfc3339_opts(SecondsFormat::Millis, true);
    let start = time
        .checked_sub_months(Months::new(options["months"].as_u64().unwrap_or(3) as u32))
        .ok_or_else(|| Error::invalid("Invalid learning date."))?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let since = if incremental {
        [
            start.as_str(),
            string(&current, "analyzedThrough"),
            string(&current, "weeklySince"),
        ]
        .into_iter()
        .max()
        .unwrap_or(&start)
    } else {
        &start
    };
    let baseline = if incremental && !voice(db, &settings, owner)?.is_empty() {
        current["profile"].clone()
    } else {
        Value::Null
    };
    if baseline["sources"].as_array().map_or(0, Vec::len) > 150 {
        return Err(Error::conflict(
            "Run a full style analysis to refresh the accumulated sample sources.",
        ));
    }
    let mut seen = HashSet::new();
    let mut buckets: Vec<VecDeque<(Value, String)>> = Vec::new();
    let mut positions = HashMap::<String, usize>::new();
    for m in db.list(owner)? {
        if string(&m, "date") < since || string(&m, "date") >= end.as_str() {
            continue;
        }
        let body = source(db, owner, string(&m, "id"))?;
        let Some(body) = body
            .as_str()
            .filter(|body| body.encode_utf16().count() >= 40)
        else {
            continue;
        };
        let normalized = body
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !seen.insert(hash(&json!(normalized))) {
            continue;
        }
        let key = format!(
            "{}:{}",
            truncate(string(&m, "date"), 7),
            string(&m, "to").to_lowercase()
        );
        let index = *positions.entry(key).or_insert_with(|| {
            buckets.push(VecDeque::new());
            buckets.len() - 1
        });
        buckets[index].push_back((m.clone(), body.into()));
    }
    let cap = options["maxSamples"]
        .as_u64()
        .unwrap_or(50)
        .min(
            policy::resolve(&settings["policy"])["maxMessages"]
                .as_u64()
                .unwrap_or(8),
        )
        .min(50) as usize;
    let mut sources = Vec::new();
    let mut messages = Vec::new();
    'samples: loop {
        let mut any = false;
        for bucket in &mut buckets {
            let Some((m, body)) = bucket.pop_front() else {
                continue;
            };
            any = true;
            if sources.len() >= cap {
                break 'samples;
            }
            let candidate = json!({"body":truncate(&body,6000)});
            messages.push(candidate.clone());
            if estimate(&settings, &messages, &baseline)?
                > options["tokenBudget"].as_u64().unwrap_or(16000) as usize
            {
                messages.pop();
                continue;
            }
            sources.push(json!({"id":m["id"],"hash":hash(&json!(body)),"body":candidate["body"]}));
        }
        if !any {
            break;
        }
    }
    if sources.is_empty() {
        return Err(Error::conflict(
            "No useful Sent samples fit your dates, permissions and budget. Import Sent mail or increase the budget.",
        ));
    }
    let preview = json!({"id":uuid::Uuid::new_v4().to_string(),"status":"prepared","createdAt":end,"through":end,"incremental":incremental,"baseProfile":baseline,"stamp":stamp(&settings,owner),"generation":settings["aiGeneration"],"sources":sources,"eligible":seen.len(),"sampleCount":sources.len(),"effectiveCap":cap,"estimatedTokens":estimate(&settings,&messages,&baseline)?,"tokenBudget":options["tokenBudget"]});
    write(db, owner, merge(current, &json!({"preview":preview})))?;
    Ok(preview)
}
pub async fn generate(app: &App, owner: &str, id: &str) -> Result<()> {
    let owner = owner.to_owned();
    let id = id.to_owned();
    let account = owner.clone();
    let expected = id.clone();
    let (preview, settings) = app
        .db(move |db| {
            let settings = db.settings()?;
            let current = read(&settings, &account);
            let preview = current["preview"].clone();
            if !valid(db, &settings, &account, &preview)?
                || preview["id"] != expected
                || preview["status"] != "prepared"
            {
                return Err(Error::conflict(
                    "Preview expired or was already used. Prepare fresh samples.",
                ));
            }
            write(
                db,
                &account,
                merge(
                    current,
                    &json!({"preview":merge(preview.clone(),&json!({"status":"running"}))}),
                ),
            )?;
            Ok((preview, settings))
        })
        .await?;
    let messages: Vec<_> = preview["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| json!({"body":i["body"]}))
        .collect();
    let result = run_model(
        &app.0.client,
        &model_settings(&settings),
        "style",
        &messages,
        "",
        &model_options(&settings, &preview["baseProfile"]),
    )
    .await;
    app.db(move|db|{
        let settings=db.settings()?;let current=read(&settings,&owner);
        let success=result.ok().filter(|result|{let voice=string(result,"text").trim();!voice.is_empty()&&voice.encode_utf16().count()<=2000});
        if let Some(result)=success.filter(|_|current["preview"]["id"]==id&&current["preview"]["status"]=="running") && valid(db,&settings,&owner,&preview)?{write(db,&owner,merge(current,&json!({"analyzedThrough":preview["through"],"preview":merge(preview.clone(),&json!({"status":"ready","voice":string(&result,"text").trim(),"usage":result["usage"]}))})))?;return Ok(());}
        if current["preview"]["id"]==id{write(db,&owner,merge(current,&json!({"preview":merge(preview,&json!({"status":"failed","error":"Analysis failed or its context changed. Tokens may have been used. Prepare a new preview to retry explicitly."}))})))?;}
        Err(Error::new(502,"Style analysis failed or its context changed. Check settings and prepare fresh samples; tokens may have been used."))
    }).await
}
pub fn apply(db: &Store, owner: &str, input: &Value) -> Result<()> {
    let settings = db.settings()?;
    let value = read(&settings, owner);
    let preview = &value["preview"];
    if !valid(db, &settings, owner, preview)?
        || preview["id"] != input["previewId"]
        || preview["status"] != "ready"
    {
        return Err(Error::conflict(
            "Prepare and analyze fresh samples before saving.",
        ));
    }
    let voice = crate::validation::text(&input["voice"], "Style guide", 2000, false)?.trim();
    let mut sources = preview["baseProfile"]["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for item in preview["sources"].as_array().into_iter().flatten() {
        sources.retain(|old| old["id"] != item["id"]);
        sources.push(json!({"id":item["id"],"hash":item["hash"]}));
    }
    let profile = json!({"voice":voice,"updatedAt":now(),"sources":sources});
    write(
        db,
        owner,
        merge(value, &json!({"profile":profile,"preview":null})),
    )
}
pub fn clear(db: &Store, owner: &str) -> Result<()> {
    let settings = db.settings()?;
    if !crate::service::valid_account(&settings, owner) {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    write(
        db,
        owner,
        json!({"settings":merge(config(&settings,owner),&json!({"enabled":false,"weekly":false}))}),
    )
}
pub async fn scheduled_tick(app: &App) -> Result<()> {
    let work = app
        .db(|db| {
            let settings = db.settings()?;
            let time = Utc::now();
            for (owner, _) in settings["styleLearning"].as_object().into_iter().flatten() {
                let value = read(&settings, owner);
                if !permitted(&settings, owner)
                    || config(&settings, owner)["weekly"] != true
                    || time.timestamp_millis()
                        < value["lastWeeklyAt"]
                            .as_i64()
                            .unwrap_or(time.timestamp_millis())
                            .saturating_add(7 * 86400000)
                    || (valid(db, &settings, owner, &value["preview"])?
                        && ["prepared", "running", "ready"]
                            .contains(&string(&value["preview"], "status")))
                {
                    continue;
                }
                write(
                    db,
                    owner,
                    merge(value, &json!({"lastWeeklyAt":time.timestamp_millis()})),
                )?;
                let incremental = !voice(db, &settings, owner)?.is_empty();
                return Ok(prepare_at(db, owner, incremental, time)
                    .ok()
                    .map(|p| (owner.clone(), string(&p, "id").to_owned())));
            }
            Ok(None)
        })
        .await?;
    if let Some((owner, id)) = work {
        let _ = generate(app, &owner, &id).await;
    }
    Ok(())
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let route: Vec<_> = ctx.path.iter().map(|s| s.to_ascii_lowercase()).collect();
    let route: Vec<_> = route.iter().map(String::as_str).collect();
    let owner = ctx.owner.clone();
    let body = ctx.body.clone();
    match (ctx.method.as_str(), route.as_slice()) {
        ("POST", ["style", "settings"]) => {
            app.db(move |db| update_settings(db, &owner, &body)).await?
        }
        ("POST", ["style", "preview"]) => {
            app.db(move |db| prepare(db, &owner, false)).await?;
        }
        ("POST", ["style", "generate"]) => {
            generate(app, &owner, string(&body, "previewId")).await?
        }
        ("POST", ["style", "apply"]) => app.db(move |db| apply(db, &owner, &body)).await?,
        ("DELETE", ["style", "profile"]) => app.db(move |db| clear(db, &owner)).await?,
        _ => return Ok(None),
    }
    Ok(Some(
        Json(app.state(&ctx.owner, ctx.paged).await?).into_response(),
    ))
}
