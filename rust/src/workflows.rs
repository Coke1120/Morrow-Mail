use crate::{
    ai::{self, fallback, truncate},
    content,
    error::{Error, Result},
    mail, policy,
    service::{App, Context, get_message, save_workspace, valid_account, workspace},
    store::{catalog, merge, now, string},
    validation,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Days, Local, SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

fn subject(message: &Value) -> &str {
    let text = string(message, "subject").trim();
    if text.is_empty() {
        "Subject not shared"
    } else {
        text
    }
}
fn excerpt(message: &Value) -> String {
    let text = string(message, "body")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        "Body not shared".into()
    } else {
        truncate(&text, 260)
    }
}
fn item(title: impl Into<String>, detail: impl Into<String>, message: Option<&Value>) -> Value {
    let mut value = json!({"title":title.into(),"detail":detail.into()});
    if let Some(m) = message.filter(|m| !string(m, "id").is_empty()) {
        value["messageId"] = m["id"].clone();
    }
    value
}
fn urgent(message: &Value) -> bool {
    static URGENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(urgent|deadline|action required|review|confirm|approval)\b").unwrap()
    });
    URGENT.is_match(&format!(
        "{} {}",
        string(message, "subject"),
        string(message, "body")
    ))
}
fn date(when: Option<&str>, time: DateTime<Utc>) -> Result<String> {
    let invalid = || Error::invalid("Choose a valid reminder or meeting date.");
    let time = if let Some(when) = when {
        DateTime::parse_from_rfc3339(when)
            .map_err(|_| invalid())?
            .with_timezone(&Utc)
    } else {
        let tomorrow = time
            .with_timezone(&Local)
            .date_naive()
            .checked_add_days(Days::new(1))
            .ok_or_else(invalid)?;
        let local = tomorrow.and_hms_opt(9, 0, 0).ok_or_else(invalid)?;
        Local
            .from_local_datetime(&local)
            .earliest()
            .ok_or_else(invalid)?
            .with_timezone(&Utc)
    };
    Ok(time.to_rfc3339_opts(SecondsFormat::Millis, true))
}
pub fn create_plan(
    action: &str,
    messages: &[Value],
    when: Option<&str>,
    time: DateTime<Utc>,
) -> Result<Value> {
    let feature = catalog()["features"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == action && f["mock"] == true)
        .ok_or_else(|| Error::invalid("Unknown simulated workflow."))?;
    let mut mail: Vec<&Value> = Vec::new();
    let mut positions = HashMap::new();
    for m in messages {
        let id = string(m, "id");
        if let Some(index) = positions.get(id) {
            mail[*index] = m;
        } else {
            positions.insert(id, mail.len());
            mail.push(m);
        }
    }
    let selected = mail.first().copied().unwrap_or(&Value::Null);
    if feature["context"] == "selected" && mail.is_empty() {
        return Err(Error::invalid(
            "Select a permitted message for this workflow.",
        ));
    }
    let mut plan = json!({"title":format!("Simulated · {}",string(feature,"label")),"summary":"Preview only. Applying saves changes inside Morrow; nothing is sent externally.","items":[],"changes":[],"records":{}});
    let mut items = Vec::new();
    let mut changes = Vec::new();
    let mut records = json!({});
    let inbox: Vec<_> = mail
        .iter()
        .copied()
        .filter(|m| m["folder"] == "inbox")
        .collect();
    match action {
        "triage" => {
            // ponytail: keyword/unread heuristic for simulation; real ranking needs reviewed model output.
            for m in inbox.iter().copied().filter(|m| {
                m["starred"] != true
                    && (urgent(m) || (m["read"] != true && m["category"] != "newsletters"))
            }) {
                items.push(item(subject(m),if urgent(m){"Sample priority: visible text mentions a review, decision, or deadline. Add a local star."}else{"Sample priority: an unread, non-newsletter message. Add a local star."},Some(m)));
                changes.push(json!({"messageId":m["id"],"patch":{"starred":true}}));
            }
        }
        "labels" => {
            for m in &inbox {
                let label = if m["category"] == "newsletters" {
                    "Newsletter"
                } else if urgent(m) {
                    "Follow up"
                } else {
                    "To review"
                };
                let mut labels = m["labels"].as_array().cloned().unwrap_or_default();
                if labels.iter().any(|v| v == label) {
                    continue;
                }
                labels.push(label.into());
                let mut unique = HashSet::new();
                labels.retain(|v| unique.insert(v.to_string()));
                items.push(item(
                    subject(m),
                    format!("Add the local label “{label}” using this sample rule."),
                    Some(m),
                ));
                changes.push(json!({"messageId":m["id"],"patch":{"labels":labels}}));
            }
        }
        "memory" => {
            let mut contacts = Vec::<Value>::new();
            let mut positions = HashMap::new();
            for m in &mail {
                let email = string(m, "fromEmail").trim();
                if email.is_empty() {
                    continue;
                }
                let contact = json!({"name":fallback(m,"fromName","Unknown").trim(),"email":email});
                let key = email.to_lowercase();
                if let Some(index) = positions.get(&key) {
                    contacts[*index] = contact;
                } else {
                    positions.insert(key, contacts.len());
                    contacts.push(contact);
                }
            }
            let writing: Vec<_> = mail
                .iter()
                .copied()
                .filter(|m| {
                    ["sent", "drafts"].contains(&string(m, "folder"))
                        && !string(m, "body").trim().is_empty()
                })
                .collect();
            let voice = if writing.is_empty() {
                "Unknown — no permitted sent or draft writing is available.".into()
            } else {
                let words: usize = writing
                    .iter()
                    .map(|m| string(m, "body").split_whitespace().count())
                    .sum();
                let average = (words as f64 / writing.len() as f64).round() as usize;
                let greeting = Regex::new(r"(?i)^(hi|hello|dear|hey)\b").unwrap();
                format!(
                    "Visible outgoing writing averages {average} words across {} permitted message(s). {} This is a sample observation, not a learned voice.",
                    writing.len(),
                    if writing
                        .iter()
                        .any(|m| greeting.is_match(string(m, "body").trim()))
                    {
                        "At least one starts with a greeting."
                    } else {
                        "No greeting pattern established."
                    }
                )
            };
            let mut unique = HashSet::new();
            let topics: Vec<_> = mail
                .iter()
                .map(|m| string(m, "subject").trim())
                .filter(|s| !s.is_empty() && unique.insert(*s))
                .take(3)
                .collect();
            let notes = format!(
                "Simulated notes from permitted email only. {} No external facts were added.",
                if topics.is_empty() {
                    "Topics unknown because no subjects were shared.".into()
                } else {
                    format!("Visible subjects: {}.", topics.join("; "))
                }
            );
            items = vec![
                item("Writing observations", voice.clone(), None),
                item(
                    "Contacts from visible sender fields",
                    if contacts.is_empty() {
                        "Unknown — no sender addresses were shared.".into()
                    } else {
                        contacts
                            .iter()
                            .map(|c| format!("{} <{}>", string(c, "name"), string(c, "email")))
                            .collect::<Vec<_>>()
                            .join("\n")
                    },
                    None,
                ),
                item("Notes to save", notes.clone(), None),
            ];
            records["brain"] = json!({"voice":voice,"contacts":contacts,"notes":notes});
        }
        "research" => {
            plan["summary"]="Simulated research structure using this email only. No web lookup or verified person/company research has occurred.".into();
            items = vec![
                item(
                    "Contact supplied in email",
                    format!(
                        "{} · {}",
                        fallback(selected, "fromName", "Unknown"),
                        fallback(selected, "fromEmail", "Unknown")
                    ),
                    Some(selected),
                ),
                item(
                    "Supplied context · unverified",
                    format!("{}\n{}", subject(selected), excerpt(selected)),
                    Some(selected),
                ),
                item(
                    "Role and company",
                    "Unknown. These details have not been verified; an email address alone does not establish them.",
                    None,
                ),
                item(
                    "Suggested research questions",
                    "Confirm their role, organization, goals, and the relevant project before relying on any assumptions.",
                    None,
                ),
            ];
        }
        "meeting" => {
            plan["summary"]="Simulated preparation from the selected email. No calendar availability has been checked and no meeting is created.".into();
            items = vec![
                item(
                    "Background",
                    format!("{}\n{}", subject(selected), excerpt(selected)),
                    Some(selected),
                ),
                item(
                    "Proposed agenda",
                    "1. Confirm the goal.\n2. Review the points in the email.\n3. Agree on owners and next steps.",
                    Some(selected),
                ),
                item(
                    "Questions to confirm",
                    "What needs a decision? Who should participate? Are there any explicit deadlines or missing materials?",
                    None,
                ),
            ];
        }
        "followup" | "schedule" => {
            let schedule = action == "schedule";
            let title = format!(
                "{}: {}",
                if schedule {
                    "Meeting proposal"
                } else {
                    "Follow up"
                },
                subject(selected)
            );
            let detail = if schedule {
                "Simulated local calendar proposal. Attendees and availability are unconfirmed; no invitations or external calendar entries will be created."
            } else {
                "Simulated local reminder. Review this email and decide whether a reply is needed; no email will be sent automatically."
            };
            let when = date(when, time)?;
            records[if schedule { "events" } else { "reminders" }] =
                json!([{"title":title,"detail":detail,"when":when,"messageId":selected["id"]}]);
            items.push(item(
                title,
                format!("{detail}\nProposed time: {when}"),
                Some(selected),
            ));
        }
        "cleanup" => {
            for m in inbox
                .iter()
                .copied()
                .filter(|m| m["category"] == "newsletters")
            {
                items.push(item(subject(m),"Archive this newsletter locally. It remains available in Archive; the provider mailbox is unchanged.",Some(m)));
                changes.push(json!({"messageId":m["id"],"patch":{"folder":"archive"}}));
            }
        }
        "unsubscribe" => {
            let title = format!("Unsubscribe review: {}", subject(selected));
            let detail = "Simulated request recorded locally only. You remain subscribed; no link is opened and no unsubscribe request is sent.";
            records["unsubscribed"] =
                json!([{"title":title,"detail":detail,"messageId":selected["id"]}]);
            items.push(item(title, detail, Some(selected)));
        }
        "attachments" => {
            plan["summary"]="Fictional attachment fixtures for a comparison demonstration. These files were not discovered in your email and are not real attachments.".into();
            items = vec![
                item(
                    "Fictional fixture · sample-brief-v1.txt",
                    "SAMPLE CONTENT: Scope: one landing page. Review: visual design. Delivery: date unknown.",
                    None,
                ),
                item(
                    "Fictional fixture · sample-brief-v2.txt",
                    "SAMPLE CONTENT: Scope: one landing page. Review: visual design and accessibility. Delivery: date unknown.",
                    None,
                ),
                item(
                    "Illustrative comparison",
                    "The fictional second version adds an accessibility review. Scope is unchanged and neither sample supplies a delivery date. No files were fetched.",
                    None,
                ),
            ];
        }
        "batchReplies" => {
            let drafts:Vec<_>=inbox.iter().copied().filter(|m|m["category"]!="newsletters"&&validation::email(&m["fromEmail"]).is_ok()).take(5).map(|m|{let subject=subject(m);json!({"to":string(m,"fromEmail").trim(),"subject":if subject.to_ascii_lowercase().starts_with("re:"){subject.into()}else{format!("Re: {subject}")},"body":format!("Hi {},\n\nThanks for your email{}. I’ll review the details and get back to you.\n\nBest,",fallback(m,"fromName","there").trim(),if string(m,"subject").trim().is_empty(){String::new()}else{format!(" about “{}”",string(m,"subject").trim())}),"replyToId":m["id"]})}).collect();
            items = drafts
                .iter()
                .map(|d| {
                    item(
                        format!("Draft to {}", string(d, "to")),
                        format!("{}\n\n{}", string(d, "subject"), string(d, "body")),
                        Some(&json!({"id":d["replyToId"]})),
                    )
                })
                .collect();
            records["drafts"] = json!(drafts);
            plan["summary"]="Create up to five separate local draft replies. Review and edit each draft before deciding whether to send it; this workflow never sends email.".into();
        }
        _ => return Err(Error::invalid("Unknown simulated workflow.")),
    }
    if items.is_empty() {
        items.push(item(
            "No matching messages",
            "No local changes are proposed for the permitted messages.",
            None,
        ));
    }
    plan["items"] = json!(items);
    plan["changes"] = json!(changes);
    plan["records"] = records;
    Ok(plan)
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if let Some(response) = crate::brain::handle(app, ctx).await? {
        return Ok(Some(response));
    }
    let route: Vec<_> = ctx.path.iter().map(|s| s.to_ascii_lowercase()).collect();
    let route: Vec<_> = route.iter().map(String::as_str).collect();
    let owner = ctx.owner.clone();
    let input = ctx.body.clone();
    let result = match (ctx.method.as_str(), route.as_slice()) {
        ("POST", ["workflows", "preview"]) => {
            let runtime = app.0.clone();
            app.db(move|db|{
            let action=string(&input,"action");let context=ai::context_for(db,action,&input,&owner)?;if context.feature["mock"]!=true{return Err(Error::invalid("This behavior uses the AI assistant, not a mock workflow."));}
            let time=Utc::now();if let Some(when)=input.get("when") && !when.as_str().and_then(|s|DateTime::parse_from_rfc3339(s).ok()).is_some_and(|date|date>time){return Err(Error::invalid("Choose a future date and time."));}
            let mut previews=runtime.workflows.lock().map_err(|_|Error::new(503,"Workflow previews are unavailable."))?;previews.retain(|_,p|p["expiresAt"].as_i64().unwrap_or(0)>=time.timestamp_millis());if previews.len()>=100{return Err(Error::new(429,"Too many pending previews. Apply a preview or wait ten minutes."));}
            let mut plan=create_plan(action,&context.messages,input["when"].as_str(),time)?;
            if action=="memory" && workspace(&context.config,&owner)["brain"].is_object() {
                plan["summary"]="Sample observations only. Your existing Brain will be retained; use Email Brain to review AI memory suggestions.".into();
                plan["records"].as_object_mut().unwrap().remove("brain");
            }let id=uuid::Uuid::new_v4().to_string();let preview=json!({"id":id,"action":action,"title":plan["title"],"summary":plan["summary"],"items":plan["items"],"createdAt":now()});
            previews.insert(id,merge(preview.clone(),&json!({"account":owner,"policy":context.policy,"generation":ai::generation(&context.config,&owner),"messages":context.messages,"plan":plan,"expiresAt":time.timestamp_millis()+600000})));Ok(json!({"preview":preview,"simulated":true}))
        }).await?
        }
        ("POST", ["workflows", "apply"]) => {
            let runtime = app.clone();
            app.db(move|db|{
            let mut previews=runtime.0.workflows.lock().map_err(|_|Error::new(503,"Workflow previews are unavailable."))?;let id=string(&input,"previewId");let preview=previews.get(id).ok_or_else(||Error::conflict("This preview expired or was already applied. Generate a fresh preview."))?.clone();
            if preview["expiresAt"].as_i64().unwrap_or(0)<Utc::now().timestamp_millis(){return Err(Error::conflict("This preview expired or was already applied. Generate a fresh preview."));}
            let config=db.settings()?;let policy=policy::resolve(&config["policy"]);if !valid_account(&config,&owner)||preview["account"]!=owner||preview["policy"]!=policy||preview["generation"]!=ai::generation(&config,&owner){return Err(Error::conflict("The account or permissions changed. Generate a fresh preview."));}policy::require(&policy,string(&preview,"action"))?;
            for previous in preview["messages"].as_array().into_iter().flatten(){let current=get_message(db,&owner,string(previous,"id"))?;if policy["folders"][string(&current,"folder")]!=true||policy::redact(&current,&policy)!=*previous{return Err(Error::conflict("A source message changed after this preview. Generate a fresh preview."));}mail::ensure_draft_idle(&runtime,&owner,string(&current,"id"))?;}
            db.transaction(|db|{
                let current=workspace(&config,&owner);let mut next=json!({});let plan=&preview["plan"];
                for change in plan["changes"].as_array().into_iter().flatten(){let mut patch=change["patch"].clone();if let Some(labels)=patch["labels"].as_array(){let current=get_message(db,&owner,string(change,"messageId"))?;let mut combined=current["labels"].as_array().cloned().unwrap_or_default();for label in labels{if !combined.contains(label){combined.push(label.clone());}}patch["labels"]=json!(combined);}db.update(&owner,string(change,"messageId"),&patch)?;}
                let created=now();for collection in ["reminders","events","unsubscribed"]{if let Some(records)=plan["records"][collection].as_array(){let mut values:Vec<_>=records.iter().map(|r|merge(r.clone(),&json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":created,"done":false,"simulated":true}))).collect();values.extend(current[collection].as_array().cloned().unwrap_or_default());values.truncate(100);next[collection]=json!(values);}}
                if plan["records"]["brain"].is_object(){let mut brain=merge(plan["records"]["brain"].clone(),&json!({"updatedAt":created,"sourceMessageIds":preview["messages"].as_array().into_iter().flatten().map(|m|m["id"].clone()).collect::<Vec<_>>(),"simulated":true}));
                    if current["brain"].is_object() {
                        // Existing reviewed/manual memory wins; simulation never replaces it.
                        brain=merge(brain,&current["brain"]);
                    }
                    next["brain"]=brain;}
                for(index,draft)in plan["records"]["drafts"].as_array().into_iter().flatten().enumerate(){let input=merge(draft.clone(),&json!({"footer":content::preferences_footer(&config["preferences"])?}));let value=content::content(&input,true)?;let outgoing=mail::outgoing(&config,&owner,&value,&json!({"id":format!("mock-draft:{id}:{index}"),"folder":"drafts","replyToId":draft["replyToId"]}));db.upsert(&owner,&outgoing)?;}
                let mut activity=vec![json!({"id":id,"action":preview["action"],"title":preview["title"],"detail":preview["summary"],"createdAt":created,"simulated":true})];activity.extend(current["activity"].as_array().cloned().unwrap_or_default());activity.truncate(100);next["activity"]=json!(activity);save_workspace(db,&owner,&next)?;Ok(())
            })?;previews.remove(id);Ok(())
        }).await?;
            let mut state = app.state(&ctx.owner, ctx.paged).await?;
            state["simulated"] = true.into();
            state
        }
        ("POST", ["skills"]) => {
            app.db(move|db|{
            let config=db.settings()?;if !valid_account(&config,&owner){return Err(Error::conflict("Choose a connected mailbox."));}let current=workspace(&config,&owner);let mut skills=current["skills"].as_array().cloned().unwrap_or_default();let existing=if input.get("id").is_some_and(|v|!v.is_null()&&v!=""){Some(skills.iter().position(|s|s["id"]==input["id"]).ok_or_else(||Error::new(404,"Skill not found."))?)}else{None};if existing.is_none()&&skills.len()>=20{return Err(Error::invalid("Keep at most 20 custom skills."));}
            let name=validation::text(&input["name"],"Skill name",80,false)?.trim();let instructions=validation::text(&input["instructions"],"Skill instructions",4000,false)?.trim();if input.get("enabled").is_some_and(|v|!v.is_boolean()){return Err(Error::invalid("Skill enabled must be true or false."));}
            let previous=existing.map(|i|skills[i].clone()).unwrap_or(Value::Null);let default_folders=json!({"inbox":true,"sent":false,"drafts":false,"archive":false,"trash":false});let folders=if input.get("folders").is_some_and(|v|!v.is_null()){policy::update(&json!({"folders":default_folders}),&json!({"folders":input["folders"]}))?["folders"].clone()}else{previous.get("folders").cloned().unwrap_or(default_folders)};
            let skill=json!({"id":previous.get("id").cloned().unwrap_or(json!(uuid::Uuid::new_v4().to_string())),"name":name,"instructions":instructions,"enabled":input.get("enabled").or_else(||previous.get("enabled")).cloned().unwrap_or(json!(true)),"folders":folders});if let Some(index)=existing{skills[index]=skill;}else{skills.push(skill);}save_workspace(db,&owner,&json!({"skills":skills}))?;ai::invalidate(db)
        }).await?;
            app.state(&ctx.owner, ctx.paged).await?
        }
        ("DELETE", ["skills", _]) => {
            let id = ctx.path[1].clone();
            app.db(move |db| {
                let config = db.settings()?;
                let current = workspace(&config, &owner);
                let mut skills = current["skills"].as_array().cloned().unwrap_or_default();
                let before = skills.len();
                skills.retain(|skill| skill["id"] != id);
                if before == skills.len() {
                    return Err(Error::new(404, "Skill not found."));
                }
                save_workspace(db, &owner, &json!({"skills":skills}))?;
                ai::invalidate(db)
            })
            .await?;
            app.state(&ctx.owner, ctx.paged).await?
        }
        ("POST", ["workspace", "brain"]) => {
            app.db(move|db|{let config=db.settings()?;if !valid_account(&config,&owner){return Err(Error::conflict("Choose a connected mailbox."));}let current=workspace(&config,&owner);let empty=json!("");let voice=validation::text(input.get("voice").filter(|v|!v.is_null()).unwrap_or(&empty),"Writing voice",2000,true)?;let notes=validation::text(input.get("notes").filter(|v|!v.is_null()).unwrap_or(&empty),"Brain notes",4000,true)?;let brain=merge(if current["brain"].is_object(){current["brain"].clone()}else{json!({})},&json!({"voice":voice,"notes":notes,"contacts":current["brain"].get("contacts").cloned().unwrap_or(json!([])),"updatedAt":now()}));save_workspace(db,&owner,&json!({"brain":brain}))?;ai::invalidate(db)}).await?;
            app.state(&ctx.owner, ctx.paged).await?
        }
        ("DELETE", ["workspace", "brain"]) => {
            app.db(move |db| {
                save_workspace(db, &owner, &json!({"brain":null}))?;
                ai::invalidate(db)
            })
            .await?;
            app.state(&ctx.owner, ctx.paged).await?
        }
        ("PATCH", ["workspace", _, _]) => {
            let collection = ctx.path[1].to_ascii_lowercase();
            let id = ctx.path[2].clone();
            app.db(move |db| {
                if !["reminders", "events"].contains(&collection.as_str()) {
                    return Err(Error::invalid("Unknown workspace collection."));
                }
                let config = db.settings()?;
                let current = workspace(&config, &owner);
                let mut records = current[&collection].as_array().cloned().unwrap_or_default();
                let record = records
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or_else(|| Error::new(404, "Workspace item not found."))?;
                let mut changed = false;
                for key in ["done", "cancelled"] {
                    if key == "cancelled" && collection != "events" {
                        continue;
                    }
                    if let Some(value) = input.get(key) {
                        if !value.is_boolean() {
                            return Err(Error::invalid("Workspace changes must be true or false."));
                        }
                        record[key] = value.clone();
                        changed = true;
                    }
                }
                if !changed {
                    return Err(Error::invalid(
                        "No supported workspace change was provided.",
                    ));
                }
                save_workspace(db, &owner, &json!({collection:records}))
            })
            .await?;
            app.state(&ctx.owner, ctx.paged).await?
        }
        _ => return Ok(None),
    };
    Ok(Some(Json(result).into_response()))
}
