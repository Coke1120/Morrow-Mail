use crate::{
    content,
    error::{Error, Result},
    imap, pages, providers,
    service::{
        App, Context, canonical_address, connections, get_message, save_connection, valid_account,
    },
    store::{Store, merge, now, string},
    validation,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub struct TrashUndo {
    pub expires: std::time::Instant,
    owner: String,
    original: Value,
    connection: Value,
    destination: Value,
    moved: Value,
}

pub fn ensure_draft_idle(app: &App, owner: &str, id: &str) -> Result<()> {
    if app
        .0
        .sending
        .lock()
        .map_err(|_| Error::new(503, "Restart the workspace."))?
        .contains(&(owner.to_owned(), id.to_owned()))
    {
        Err(Error::conflict(
            "This draft is being sent. Wait for sending to finish.",
        ))
    } else {
        Ok(())
    }
}
pub async fn current_mail(app: &App, owner: &str) -> Result<Value> {
    let accounts = connections(&app.settings().await?);
    let original = accounts
        .get(owner)
        .cloned()
        .ok_or_else(|| Error::conflict("Connect a mailbox first."))?;
    if ["", "imap"].contains(&string(&original, "provider")) {
        return Ok(original);
    }
    let mut refreshed = providers::refresh(&app.0.client, &original)
        .await
        .map_err(|error| {
            let (status, code, message, recovery) = match string(&error.body, "code") {
                "oauth_reconnect_required" => (401, "oauth_reconnect_required", "Mailbox authorization is no longer valid. Reconnect this account in Settings; cached mail is retained.", "reconnect"),
                "oauth_configuration" => (502, "oauth_configuration", "The provider rejected the OAuth app configuration. Check this account's OAuth client settings.", "configure"),
                _ => (502, "oauth_refresh_failed", "Could not refresh mailbox authorization. Saved account credentials are retained. Check your connection and try again shortly.", "retry"),
            };
            let mut safe = Error::new(status, message);
            safe.body["code"] = code.into();
            safe.body["recoveryAction"] = recovery.into();
            safe
        })?;
    refreshed["email"] = owner.into();
    let owner = owner.to_owned();
    let result = refreshed.clone();
    app.db(move |db| {
        if connections(&db.settings()?).get(&owner) != Some(&original) {
            return Err(Error::conflict(
                "The mailbox connection changed. Try again.",
            ));
        }
        if refreshed != original {
            save_connection(db, &refreshed, false)?;
        }
        Ok(())
    })
    .await?;
    Ok(result)
}
pub(crate) fn read_backoff(config: &Value, mail: &Value) -> Option<Error> {
    let owner = string(mail, "email");
    let version = crate::folders::connection_version(mail);
    if connections(config)
        .get(owner)
        .is_none_or(|current| crate::folders::connection_version(current) != version)
    {
        return None;
    }
    let shared = &config["mailReadBackoffs"][owner];
    let job = &config["imports"][owner];
    let folders = &config["mailFolderCatalogs"][owner];
    let sync = config["backgroundSyncErrors"]
        .as_array()
        .and_then(|errors| {
            errors
                .iter()
                .find(|error| error["accountId"] == owner && error["code"] == "rate_limited")
        });
    // Respect persisted pre-upgrade cooldowns as well as the shared read deadline.
    let (backoff, retry) = [
        (shared["connection"] == version).then_some(shared),
        (job["connectionId"] == mail["connectionId"] && job["errorCode"] == "rate_limited")
            .then_some(job),
        (folders["connection"] == version && folders["errorCode"] == "rate_limited")
            .then_some(folders),
        sync,
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| {
        let retry = chrono::DateTime::parse_from_rfc3339(string(value, "nextRetryAt"))
            .ok()?
            .timestamp_millis();
        (retry > chrono::Utc::now().timestamp_millis()).then_some((value, retry))
    })
    .max_by_key(|(_, retry)| *retry)?;
    let mut error = Error::new(
        502,
        "The provider request limit was reached. Morrow will retry automatically while the app is open.",
    );
    error.provider_status = Some(429);
    error.retry_after = Some(retry);
    error.body = merge(
        error.body,
        &json!({"accountId":owner,"code":"rate_limited","recoveryAction":"retry","nextRetryAt":backoff["nextRetryAt"],"retryCount":backoff["retryCount"]}),
    );
    Some(error)
}

pub(crate) async fn finish_read<T: Send + 'static>(
    app: &App,
    mail: &Value,
    result: Result<T>,
) -> Result<T> {
    let mail = mail.clone();
    app.db(move |db| {
        let config = db.settings()?;
        let owner = string(&mail, "email");
        let version = crate::folders::connection_version(&mail);
        if connections(&config).get(owner).is_none_or(|current| crate::folders::connection_version(current) != version) {
            return Err(Error::conflict("This mailbox changed during the provider read."));
        }
        let previous = &config["mailReadBackoffs"][owner];
        let mut result = result;
        if let Err(error) = &mut result {
            let job = &config["imports"][owner];
            let folders = &config["mailFolderCatalogs"][owner];
            let sync = config["backgroundSyncErrors"].as_array().and_then(|errors| errors.iter().find(|error| error["accountId"] == owner));
            let count = [
                (previous["connection"] == version).then_some(previous),
                (job["connectionId"] == mail["connectionId"]).then_some(job),
                (folders["connection"] == version).then_some(folders),
                sync,
            ].into_iter().flatten().filter_map(|value| value["retryCount"].as_u64()).max().unwrap_or(0);
            let timestamp = chrono::Utc::now();
            if let Some(delay) = providers::quota_retry_delay(error, count, timestamp.timestamp_millis()) {
                let retry = timestamp + chrono::Duration::milliseconds(delay);
                error.retry_after = Some(retry.timestamp_millis());
                crate::background::write_owner(db, "mailReadBackoffs", owner, json!({"connection":version,"nextRetryAt":retry.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"retryCount":count.saturating_add(1)}))?;
            }
        } else if previous.is_object() {
            crate::background::write_owner(db, "mailReadBackoffs", owner, Value::Null)?;
        }
        Ok(result)
    }).await?
}

pub async fn fetch_page(app: &App, mail: &Value, options: &Value) -> Result<Value> {
    fetch_page_cached(app, mail, options, &mut HashMap::new()).await
}
async fn fetch_page_cached(
    app: &App,
    mail: &Value,
    options: &Value,
    fetched: &mut HashMap<String, Value>,
) -> Result<Value> {
    if let Some(error) = read_backoff(&app.settings().await?, mail) {
        return Err(error);
    }
    let folder = options["folder"].as_str().unwrap_or("inbox");
    let mut work = app.0.activity.start(
        string(mail, "email"),
        if string(options, "before").is_empty() {
            "sync"
        } else {
            "import"
        },
        "Fetching mail",
        &format!("{folder} · up to 50 messages in this page"),
    );
    let result = async {
        if mail["provider"] == "google" {
            let list = providers::google_list(&app.0.client, mail, options).await?;
            let ids = list["messages"].as_array().into_iter().flatten()
                .map(|entry| string(entry, "id").to_owned())
                .filter(|id| !fetched.contains_key(id)).collect::<Vec<_>>();
            let owner = string(mail, "email").to_owned();
            let cached = app.db(move |db| {
                let mut cached = HashMap::new();
                for id in ids {
                    let raw: Option<String> = db.conn.query_row("SELECT data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? LIMIT 1", params![owner, format!("google:{id}")], |row| row.get(0)).optional()?;
                    if let Some(raw) = raw {
                        let value: Value = serde_json::from_str(&raw)?;
                        if value["providerSnapshot"].is_object() && value["body"].is_string() && value["bodyHtml"].is_string() && value["providerDraft"] != true {
                            cached.insert(id, value);
                        }
                    }
                }
                Ok(cached)
            }).await?;
            let page = providers::google_fetch_page(&app.0.client, mail, &list, &cached, fetched).await?;
            Ok(page)
        } else if ["", "imap"].contains(&string(mail, "provider")) {
            imap::fetch_page(mail, options).await
        } else {
            providers::fetch_page(&app.0.client, mail, options).await
        }
    }.await;
    // Initial IMAP connection checks are not yet a saved account.
    let result = if connections(&app.settings().await?).get(string(mail, "email")) == Some(mail) {
        finish_read(app, mail, result).await
    } else {
        result
    };
    work.finish(
        result.is_ok(),
        result
            .as_ref()
            .ok()
            .and_then(|page| page["messages"].as_array().map(Vec::len)),
    );
    result
}
pub(crate) fn google_import_state(message: &Value, existing: Option<&Value>) -> Value {
    let fields = ["folder", "read", "starred", "labels"];
    let mut snapshot = json!({});
    for key in fields {
        if let Some(value) = message.get(key) {
            snapshot[key] = value.clone();
        }
    }
    let mut overrides = existing
        .and_then(|v| v["localOverrides"].as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(existing) = existing {
        for key in fields {
            let local = if let Some(previous) = existing["providerSnapshot"].get(key) {
                existing.get(key).is_some_and(|value| value != previous)
            } else if key == "labels" {
                existing[key]
                    .as_array()
                    .is_some_and(|labels| !labels.is_empty())
            } else if let Some(raw) = existing["providerLabelIds"].as_array() {
                let previous = match key {
                    "folder" => json!(providers::google_folder(&existing["providerLabelIds"])),
                    "read" => json!(!raw.iter().any(|v| v == "UNREAD")),
                    _ => json!(raw.iter().any(|v| v == "STARRED")),
                };
                existing.get(key).is_some_and(|value| *value != previous)
                    && (key != "folder"
                        || ["archive", "trash"].contains(&string(existing, "folder")))
            } else {
                key == "folder" && ["archive", "trash"].contains(&string(existing, "folder"))
            };
            if local {
                overrides.insert(key.into(), true.into());
            }
        }
    }
    let mut result = snapshot.clone();
    result["providerSnapshot"] = snapshot;
    result["localOverrides"] = Value::Object(overrides);
    for key in ["providerLabelIds", "providerSent", "providerDraft"] {
        if let Some(value) = message.get(key) {
            result[key] = value.clone();
        }
    }
    if let Some(existing) = existing {
        for key in fields {
            if result["localOverrides"][key] == true
                && let Some(value) = existing.get(key)
            {
                result[key] = value.clone();
            }
        }
    }
    result
}

fn import_read_state(message: &Value, existing: Option<&Value>, imported: &mut Value) {
    let previous = existing.and_then(|value| {
        value["providerSnapshot"]["read"].as_bool().or_else(|| {
            value["providerLabelIds"]
                .as_array()
                .map(|labels| !labels.iter().any(|label| label == "UNREAD"))
        })
    });
    let remote = message["read"].as_bool();
    if let Some(snapshot) = remote.or(previous) {
        if !imported["providerSnapshot"].is_object() {
            imported["providerSnapshot"] = json!({});
        }
        imported["providerSnapshot"]["read"] = snapshot.into();
    }
    if let Some(remote) = remote {
        // Keep local edits while the provider is unchanged; a newly observed
        // provider value wins, and convergence releases obsolete overrides.
        let read = if previous == Some(remote) {
            existing
                .and_then(|value| value["read"].as_bool())
                .unwrap_or(remote)
        } else {
            remote
        };
        imported["read"] = read.into();
        if read == remote
            && let Some(overrides) = imported["localOverrides"].as_object_mut()
        {
            overrides.remove("read");
        }
    }
}

pub fn import_messages(db: &Store, mail: &Value, messages: &[Value]) -> Result<Vec<String>> {
    let account = string(mail, "email");
    let is_imap = ["", "imap"].contains(&string(mail, "provider"));
    let mut new_ids = Vec::new();
    db.transaction(|db|{for message in messages{let remote=message["remoteId"].as_str().filter(|s|!s.is_empty()).unwrap_or(string(message,"id"));let folder=message["providerFolderId"].as_str().filter(|s|!s.is_empty()).unwrap_or("INBOX");
        let existing:Option<String>=db.conn.query_row("SELECT data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? AND (?=0 OR COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=?) ORDER BY rowid DESC LIMIT 1",params![account,remote,is_imap,folder],|row|row.get(0)).optional()?;
        let mut existing=existing.map(|s|serde_json::from_str::<Value>(&s)).transpose()?;
        if existing.is_none()&&(message["folder"]=="sent"||(mail["provider"]=="google"&&message["providerSent"]==true))&&string(message,"fromEmail").eq_ignore_ascii_case(account)&&!string(message,"messageId").is_empty(){let local:Option<String>=db.conn.query_row("SELECT data FROM messages WHERE account=? AND id LIKE 'sent:%' AND COALESCE(json_extract(data,'$.remoteId'),'')='' AND json_extract(data,'$.messageId')=? LIMIT 1",params![account,string(message,"messageId")],|row|row.get(0)).optional()?;existing=local.map(|s|serde_json::from_str(&s)).transpose()?;}
        if existing.is_none()&&db.get(account,string(message,"id"))?.is_none(){new_ids.push(string(message,"id").to_owned());}
        let mut value=message.clone();if let Some(existing)=&existing{if string(existing,"id").starts_with("sent:"){value=merge(value,existing);}for key in ["id","folder","read","starred","labels","pending","lowPriority"]{if let Some(entry)=existing.get(key){value[key]=entry.clone();}}value["remoteId"]=existing["remoteId"].as_str().filter(|s|!s.is_empty()).unwrap_or(remote).into();
            // Provider locations describe the fetched message, independently of local folder overrides.
            // Bounded refreshes that omit location metadata retain the last known provider location.
            for key in ["providerFolderId", "providerFolderName"] {
                if let Some(entry) = message.get(key).filter(|v| !v.is_null())
                    .or_else(|| existing.get(key).filter(|v| !v.is_null())) {
                    value[key] = entry.clone();
                }
            }
        }
        if mail["provider"]=="google"{value=merge(value,&google_import_state(message,existing.as_ref()));}
        import_read_state(message, existing.as_ref(), &mut value);
        db.upsert(account,&value)?;
    }Ok(())})?;
    Ok(new_ids)
}
pub fn outgoing(config: &Value, owner: &str, value: &Value, extra: &Value) -> Value {
    let address = if owner == "demo" {
        "alex@genmail.example"
    } else {
        owner
    };
    let name = string(&config["preferences"], "displayName");
    merge(
        merge(
            json!({"id":uuid::Uuid::new_v4().to_string(),"fromName":if !name.is_empty(){name}else if owner=="demo"{"Alex Morgan"}else{address},"fromEmail":address,"date":now(),"read":true,"starred":false,"category":"primary","labels":[]}),
            value,
        ),
        &merge(
            json!({"preview":providers::preview(string(value,"body"))}),
            extra,
        ),
    )
}
pub fn fingerprint(message: &Value) -> Result<String> {
    let mut payload = json!({"to":message["to"],"subject":message["subject"],"body":message["body"],"replyToId":string(message,"replyToId")});
    for key in ["cc", "bcc"] {
        if !string(message, key).is_empty() {
            payload[key] = message[key].clone();
        }
    }
    if !string(&message["footer"], "text").is_empty()
        || !string(&message["footer"], "html").is_empty()
    {
        payload["footer"] = message["footer"].clone();
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&payload)?)
    ))
}
fn attempts(config: &Value) -> Vec<Value> {
    config["deliveryAttempts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn review(db: &Store, owner: &str, attempt: &Value, status: u16) -> Result<Error> {
    let mut error = Error::new(
        status,
        "Delivery could not be confirmed. This draft is saved. Check your provider’s Sent folder before explicitly retrying; retrying may send a duplicate.",
    );
    error.body = merge(
        error.body,
        &json!({"requiresSendReview":true,"draftId":attempt["draftId"],"deliveryRequestId":attempt["requestId"],"message":db.get(owner,string(attempt,"draftId"))?.map(|message|pages::owned(owner,message))}),
    );
    Ok(error)
}
async fn send(app: &App, ctx: &Context) -> Result<Value> {
    let _mailbox = app.0.mailbox.try_lock().map_err(|_| {
        Error::conflict("Another mailbox operation is running. Try again when it finishes.")
    })?;
    send_locked(app, ctx, None).await
}
// The scheduler holds the same mailbox gate before calling this shared path.
pub(crate) async fn send_locked(
    app: &App,
    ctx: &Context,
    scheduled: Option<Value>,
) -> Result<Value> {
    let input = ctx.body.clone();
    let mut value = content::content(&input, false)?;
    if let Some(job) = &scheduled
        && input.get("footer").is_some()
        && input["footer"] == job["payload"]["footer"]
    {
        value["footer"] = job["payload"]["footer"].clone();
    }
    let request = validation::text(&input["requestId"], "Send request ID", 100, false)?.to_owned();
    if request.len() < 8
        || !request
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(Error::invalid("Invalid send request ID."));
    }
    if input
        .get("retryUnconfirmed")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(Error::invalid("Delivery review must be true or false."));
    }
    let owner = ctx.owner.clone();
    let request_clone = request.clone();
    let initial_value = value.clone();
    let input_clone = input.clone();
    let scheduled_review = scheduled.clone();
    let prepared=app.db(move|db|{
        let config=db.settings()?;if !valid_account(&config,&owner){return Err(Error::conflict("This account was disconnected."));}
        crate::scheduled::guard_send(db,&owner,&input_clone,scheduled_review.as_ref().map(|j|string(j,"id")))?;
        if let Some(job)=&scheduled_review { crate::scheduled::validate_review(db,&owner,&input_clone,job)?; }
        if !string(&input_clone,"draftId").is_empty() && db.get(&owner,string(&input_clone,"draftId"))?.is_some_and(|draft|draft["providerDraft"]==true) {return Err(Error::conflict("This is a read-only provider draft. Copy it to a local draft before editing or sending."));}
        let previous=attempts(&config).into_iter().find(|a|a["account"]==owner&&(a["requestId"]==request_clone||!string(&input_clone,"draftId").is_empty()&&a["draftId"]==input_clone["draftId"]));
        let mut value=initial_value;value["replyToId"]=input_clone.get("replyToId").cloned().unwrap_or(json!(""));
        // An already persisted footer is the reviewed payload; preserve its exact text across serializer upgrades.
        if let Some(attempt)=&previous
 && let Some(draft)=db.get(&owner,string(attempt,"draftId"))?
 && input_clone.get("footer").is_some()&&input_clone["footer"]==draft["footer"] {value["footer"]=draft["footer"].clone();}
        let hash=fingerprint(&value)?;let sent_id=format!("sent:{request_clone}");if let Some(sent)=db.get(&owner,&sent_id)?{let mut comparable=value.clone();if input_clone.get("footer").is_some()&&input_clone["footer"]==sent["footer"]{comparable["footer"]=sent["footer"].clone();}
if fingerprint(&sent)?!=fingerprint(&comparable)?{return Err(Error::conflict("This send request ID was already used for different text. Start a new draft."));}return Ok(json!({"sent":sent}));}
        crate::cli::guard_review(db,&owner,&input_clone)?;
        if let Some(previous)=&previous{if input_clone["retryUnconfirmed"]!=true||previous["requestId"]!=request_clone{return Err(review(db,&owner,previous,409)?);}
if previous["payloadHash"]!=hash{return Err(Error::conflict("This draft has an unconfirmed delivery with different text. Check Sent and reopen the saved draft before retrying."));}}
        let draft_id=if !string(&input_clone,"draftId").is_empty(){let id=validation::text(&input_clone["draftId"],"Draft ID",8192,false)?;if get_message(db,&owner,id)?["folder"]!="drafts"{return Err(Error::invalid("Only saved drafts can be sent."));}id.to_owned()}else if let Some(previous)=&previous{string(previous,"draftId").into()}else if owner!="demo"{format!("outbox:{request_clone}")}else{String::new()};
        let original=if !string(&input_clone,"replyToId").is_empty(){get_message(db,&owner,string(&input_clone,"replyToId"))?}else{Value::Null};
        if previous.is_none()&&owner!="demo"&&attempts(&config).len()>=1000{return Err(Error::conflict("Too many unconfirmed deliveries. Review saved drafts before sending more."));}
        Ok(json!({"value":value,"draftId":draft_id,"sentId":sent_id,"original":original,"previous":previous,"payloadHash":hash}))
    }).await?;
    if let Some(sent) = prepared.get("sent") {
        return Ok(
            json!({"message":pages::owned(&ctx.owner,sent.clone()),"simulated":ctx.owner=="demo"}),
        );
    }
    value = prepared["value"].clone();
    if let Some(job) = &scheduled {
        value["fromName"] = job["fromName"].clone();
    }
    let draft_id = string(&prepared, "draftId").to_owned();
    struct Sending {
        app: App,
        key: (String, String),
    }
    impl Drop for Sending {
        fn drop(&mut self) {
            if let Ok(mut sending) = self.app.0.sending.lock() {
                sending.remove(&self.key);
            }
        }
    }
    let key = (ctx.owner.clone(), draft_id.clone());
    if !app
        .0
        .sending
        .lock()
        .map_err(|_| Error::new(503, "Restart the workspace."))?
        .insert(key.clone())
    {
        return Err(Error::conflict("This draft is already being sent."));
    }
    let _sending = Sending {
        app: app.clone(),
        key,
    };
    let mut attempt = Value::Null;
    let mut message_id = String::new();
    if ctx.owner != "demo" {
        let mail = current_mail(app, &ctx.owner).await?;
        attempt = if prepared["previous"].is_null() {
            json!({"account":ctx.owner,"requestId":request,"draftId":draft_id,"payloadHash":prepared["payloadHash"],"createdAt":now()})
        } else {
            prepared["previous"].clone()
        };
        let owner = ctx.owner.clone();
        let saved_attempt = attempt.clone();
        let mut draft_value = value.clone();
        let reply = string(&value, "replyToId").to_owned();
        let request_clone = request.clone();
        let draft = draft_id.clone();
        let reviewed_input = input.clone();
        let send_settings=app.db(move|db|db.transaction(|db|{crate::cli::guard_review(db,&owner,&reviewed_input)?;let config=db.settings()?;let mut extra=json!({"id":draft,"folder":"drafts","deliveryStatus":"unconfirmed","deliveryRequestId":request_clone});if !reply.is_empty(){extra["replyToId"]=reply.into();}draft_value.as_object_mut().unwrap().remove("replyToId");db.upsert(&owner,&outgoing(&config,&owner,&draft_value,&extra))?;let mut pending=attempts(&config);if !pending.iter().any(|a|a["account"]==owner&&a["requestId"]==saved_attempt["requestId"]){pending.push(saved_attempt);}db.set_settings(&json!({"deliveryAttempts":pending}))?;Ok(config)})).await?;
        let mut message = value.clone();
        message["fromName"] = scheduled
            .as_ref()
            .map(|job| job["fromName"].clone())
            .unwrap_or_else(|| string(&send_settings["preferences"], "displayName").into());
        message["replyMessageId"] = scheduled
            .as_ref()
            .map(|job| job["replyMessageId"].clone())
            .unwrap_or_else(|| {
                string(&prepared["original"], "messageId")
                    .replace(['\r', '\n'], "")
                    .into()
            });
        let result = if ["", "imap"].contains(&string(&mail, "provider")) {
            imap::send(&mail, &message).await
        } else {
            providers::send(&app.0.client, &mail, &message).await
        };
        match result {
            Ok(id) => message_id = id,
            Err(_) => {
                let owner = ctx.owner.clone();
                return Err(app.db(move |db| review(db, &owner, &attempt, 502)).await?);
            }
        }
    }
    let owner = ctx.owner.clone();
    let original_attempt = attempt.clone();
    let sent_id = prepared["sentId"].clone();
    let request_clone = request.clone();
    let result = app
        .db(move |db| {
            db.transaction(|db| {
                let config = db.settings()?;
                if owner == "demo" {
                    crate::cli::guard_review(db, &owner, &input)?;
                }
                let mut extra = json!({"id":sent_id,"folder":"sent","messageId":message_id});
                let reply = string(&value, "replyToId");
                if !reply.is_empty() {
                    extra["replyToId"] = reply.into();
                }
                value.as_object_mut().unwrap().remove("replyToId");
                let message = outgoing(&config, &owner, &value, &extra);
                db.upsert(&owner, &message)?;
                if !draft_id.is_empty() {
                    db.delete(&owner, &draft_id)?;
                }
                if !original_attempt.is_null() {
                    let pending = attempts(&config)
                        .into_iter()
                        .filter(|a| !(a["account"] == owner && a["requestId"] == request_clone))
                        .collect::<Vec<_>>();
                    db.set_settings(&json!({"deliveryAttempts":pending}))?;
                }
                Ok(pages::owned(&owner, message))
            })
        })
        .await;
    match result {
        Ok(message) => Ok(json!({"message":message,"simulated":ctx.owner=="demo"})),
        Err(error) => {
            if attempt.is_null() {
                Err(error)
            } else {
                let owner = ctx.owner.clone();
                Err(app.db(move |db| review(db, &owner, &attempt, 502)).await?)
            }
        }
    }
}
pub(crate) async fn remote_folders(app: &App, mail: &Value) -> Result<Vec<Value>> {
    if let Some(error) = read_backoff(&app.settings().await?, mail) {
        return Err(error);
    }
    let folders = if ["", "imap"].contains(&string(mail, "provider")) {
        imap::folders(mail).await
    } else {
        providers::folders(&app.0.client, mail).await
    };
    let folders = finish_read(app, mail, folders).await?;
    let (connection, saved) = (mail.clone(), folders.clone());
    app.db(move |db| crate::folders::remember(db, &connection, &saved))
        .await?;
    Ok(folders)
}
pub async fn sync_accounts(app: &App, owners: &[String]) -> Result<Value> {
    sync(app, owners).await
}
fn sync_failure(owner: &str, error: &Error, previous: &Value) -> Value {
    let count = previous["retryCount"].as_u64().unwrap_or(0);
    let timestamp = chrono::Utc::now();
    if let Some(delay) = providers::quota_retry_delay(error, count, timestamp.timestamp_millis()) {
        let next = (timestamp + chrono::Duration::milliseconds(delay))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        return json!({"accountId":owner,"code":"rate_limited","recoveryAction":"retry","error":"The provider request limit was reached. Morrow will retry automatically while the app is open.","nextRetryAt":next,"retryCount":count.saturating_add(1)});
    }
    if [
        "oauth_reconnect_required",
        "oauth_configuration",
        "oauth_refresh_failed",
    ]
    .contains(&string(&error.body, "code"))
    {
        return merge(json!({"accountId":owner}), &error.body);
    }
    if error.provider_status == Some(401) {
        return json!({"accountId":owner,"code":"oauth_reconnect_required","recoveryAction":"reconnect","error":"The provider rejected mailbox authorization. Reconnect this account in Settings; cached mail is retained."});
    }
    json!({"accountId":owner,"code":"mail_sync_failed","recoveryAction":"retry","error":"Sync could not finish. Saved mail and account credentials are retained. Check your connection and try again."})
}
fn sync_warning(page: &Value) -> Option<&'static str> {
    (page["nextCursor"].is_object()
        && page["messages"].as_array().is_some_and(|rows| rows.len() < 50))
    .then_some("This sparse IMAP mailbox exceeded the scan limit. Mail sync is incomplete; enable history import in Settings to continue from saved checkpoints.")
}
async fn commit_sync_page(app: &App, owner: &str, mail: &Value, page: &Value) -> Result<()> {
    let messages = page["messages"]
        .as_array()
        .ok_or_else(providers::remote_error)?
        .clone();
    let owner = owner.to_owned();
    let mail = mail.clone();
    app.db(move |db| {
        if connections(&db.settings()?).get(&owner) != Some(&mail) {
            return Err(Error::conflict("This mailbox changed during sync."));
        }
        db.transaction(|db| {
            let ids = import_messages(db, &mail, &messages)?;
            let config = db.settings()?;
            let job = &config["imports"][&owner];
            let arrivals = ids
                .into_iter()
                .filter(|id| {
                    db.get(&owner, id).ok().flatten().is_some_and(|message| {
                        message["folder"] == "inbox"
                            && (job.is_null() || string(&message, "date") >= string(job, "before"))
                    })
                })
                .collect::<Vec<_>>();
            crate::background::arrivals(db, &owner, &arrivals)
        })
    })
    .await
}
pub async fn sync(app: &App, owners: &[String]) -> Result<Value> {
    let mut errors = Vec::new();
    for owner in owners {
        let config = app.settings().await?;
        if let Some(mail) = connections(&config).get(owner)
            && let Some(error) = read_backoff(&config, mail)
        {
            errors.push(error.body);
            continue;
        }
        let previous = config["backgroundSyncErrors"]
            .as_array()
            .and_then(|errors| errors.iter().find(|error| error["accountId"] == *owner))
            .cloned()
            .unwrap_or(Value::Null);
        if previous["code"] == "rate_limited"
            && !string(&previous, "nextRetryAt").is_empty()
            && string(&previous, "nextRetryAt") > now().as_str()
        {
            errors.push(previous);
            continue;
        }
        let work = async {
            let mail = current_mail(app, owner).await?;
            let config = app.settings().await?;
            let job = &config["imports"][owner];
            let options = &job["options"];
            let folders = if mail["provider"] == "google" {
                vec!["inbox", "sent", "drafts", "starred", "all"]
            } else if options.is_object() {
                ["inbox", "sent"]
                    .into_iter()
                    .filter(|folder| options["allMail"] == true || options[*folder] == true)
                    .collect::<Vec<_>>()
            } else {
                vec!["inbox"]
            };
            let mut warning = None;
            let mut fetched = HashMap::new();
            for folder in folders {
                let mut input = json!({"folder":folder});
                if !string(job, "since").is_empty() {
                    input["since"] = job["since"].clone();
                }
                // Refresh is deliberately bounded to the newest provider page in each
                // scope. Complete, resumable pagination belongs to the reviewed history
                // importer, which persists checkpoints and provider backoff metadata.
                let page = fetch_page_cached(app, &mail, &input, &mut fetched).await?;
                warning = warning.or(sync_warning(&page));
                commit_sync_page(app, owner, &mail, &page).await?;
            }
            Ok(warning)
        };
        match work.await {
            Ok(None) => {}
            Ok(Some(warning)) => errors.push(json!({"accountId":owner,"error":warning})),
            Err(error) => errors.push(sync_failure(owner, &error, &previous)),
        }
    }
    let owners = owners.to_vec();
    let saved = errors.clone();
    app.db(move |db| {
        let config = db.settings()?;
        let mut all = config["backgroundSyncErrors"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        all.retain(|e| !owners.iter().any(|owner| e["accountId"] == *owner));
        all.extend(saved);
        db.set_settings(&json!({"backgroundSyncErrors":all}))?;
        Ok(())
    })
    .await?;
    Ok(json!(errors))
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let parts = ctx
        .path
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let path = parts.iter().map(String::as_str).collect::<Vec<_>>();
    let body = ctx.body.clone();
    let owner = ctx.owner.clone();
    let result = match (ctx.method.as_str(), path.as_slice()) {
        ("POST", ["send"]) => send(app, ctx).await?,
        ("POST", ["drafts", "prepare"]) => {
            app.db(move |db| crate::drafts::prepare(db, &owner, &body))
                .await?
        }
        ("POST", ["drafts"]) => {
            let value = content::content(&body, true)?;
            // Keep the idle check and queued write in the same gate as send preparation.
            let _mailbox = app.0.mailbox.try_lock().map_err(|_| {
                Error::conflict("Another mailbox operation is running. Try again when it finishes.")
            })?;
            ensure_draft_idle(app, &owner, string(&body, "id"))?;
            app.db(move |db| {
                let config = db.settings()?;
                if !valid_account(&config, &owner) {
                    return Err(Error::conflict("This account was disconnected."));
                }
                let id = if string(&body, "id").is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    let id = validation::text(&body["id"], "Draft ID", 8192, false)?;
                    let existing = get_message(db, &owner, id)?;
                    if existing["providerDraft"] == true {
                        return Err(Error::conflict("This is a read-only provider draft. Copy it to a local draft before editing or sending."));
                    }
                    if existing["folder"] != "drafts" {
                        return Err(Error::invalid("Only drafts can be edited."));
                    }
                    id.into()
                };
                if attempts(&config)
                    .iter()
                    .any(|a| a["account"] == owner && a["draftId"] == id)
                {
                    return Err(Error::conflict(
                        "This draft has an unconfirmed delivery. Check Sent before retrying.",
                    ));
                }
                crate::scheduled::guard_draft(db, &owner, &id, None)?;
                let mut extra = json!({"id":id,"folder":"drafts"});
                if !string(&body, "replyToId").is_empty() {
                    get_message(db, &owner, string(&body, "replyToId"))?;
                    extra["replyToId"] = body["replyToId"].clone();
                }
                let message = outgoing(&config, &owner, &value, &extra);
                db.upsert(&owner, &message)?;
                Ok(json!({"message":pages::owned(&owner,message)}))
            })
            .await?
        }
        ("POST", ["account", "disconnect"]) => {
            let _gate = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
            let selected = app
                .db(move |db| {
                    db.transaction(|db| {
                        let config = db.settings()?;
                        let mut accounts = connections(&config);
                        if accounts.as_object_mut().unwrap().remove(&owner).is_none() {
                            return Err(Error::conflict("Choose a connected mailbox."));
                        }
                        let fallback = accounts
                            .as_object()
                            .unwrap()
                            .keys()
                            .next()
                            .cloned()
                            .unwrap_or("demo".into());
                        let selected = if crate::service::active_account(&config) == owner {
                            fallback.clone()
                        } else {
                            crate::service::active_account(&config)
                        };
                        let mail = accounts
                            .get(string(&config["mail"], "email"))
                            .or(accounts.get(&fallback))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let errors = config["backgroundSyncErrors"]
                            .as_array()
                            .map(|errors| errors.iter().filter(|error| error["accountId"] != owner).cloned().collect::<Vec<_>>())
                            .unwrap_or_default();
                        let mut backoffs = merge(json!({}), &config["mailReadBackoffs"]);
                        backoffs.as_object_mut().unwrap().remove(&owner);
                        db.set_settings(
                            &json!({"mailAccounts":accounts,"mail":mail,"activeAccount":selected,"backgroundSyncErrors":errors,"mailReadBackoffs":backoffs}),
                        )?;
                        crate::ai::invalidate(db)?;
                        crate::smart_search::reconcile(db)?;
                        Ok(selected)
                    })
                })
                .await?;
            app.0.smart.invalidate().await;
            app.state(&selected, ctx.paged).await?
        }
        ("POST", ["settings", "mail"]) => {
            let _gate = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
            let config = app.settings().await?;
            let address = canonical_address(&config, &validation::email(&body["email"])?);
            let mut mail = json!({"provider":"imap","email":address,"imapHost":validation::hostname(&body["imapHost"],"IMAP host")?,"smtpHost":validation::hostname(&body["smtpHost"],"SMTP host")?});
            for (key, default) in [("imapPort", 993), ("smtpPort", 465)] {
                let number = if body.get(key).is_none() || body[key] == 0 || body[key] == "" {
                    default
                } else {
                    body[key]
                        .as_u64()
                        .or_else(|| body[key].as_str().and_then(|s| s.parse().ok()))
                        .filter(|n| *n > 0 && *n <= 65535)
                        .ok_or_else(|| Error::invalid("Enter a valid port number."))?
                };
                mail[key] = number.into();
            }
            let accounts = connections(&config);
            let existing = &accounts[&address];
            let same = existing["email"] == address
                && existing["provider"] == "imap"
                && ["imapHost", "imapPort", "smtpHost", "smtpPort"]
                    .iter()
                    .all(|key| existing[*key] == mail[*key]);
            let password = if !string(&body, "password").is_empty() {
                &body["password"]
            } else if same {
                &existing["password"]
            } else {
                &Value::Null
            };
            mail["password"] = validation::text(password, "Mailbox password", 4096, false)?.into();
            let options = body.get("importOptions").cloned();
            if let Some(options) = &options {
                crate::background::import_options(options)?;
            }
            imap::verify_smtp(&mail).await?;
            let input = if let Some(options) = &options {
                json!({"folder":if options["allMail"]==true{"all"}else if options["inbox"]!=false{"inbox"}else{"sent"},"since":(chrono::Utc::now()-chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)})
            } else {
                json!({})
            };
            let page = fetch_page(app, &mail, &input).await?;
            let select = address.clone();
            app.db(move |db| {
                db.transaction(|db| {
                    if options.is_none() {
                        import_messages(
                            db,
                            &mail,
                            page["messages"]
                                .as_array()
                                .ok_or_else(providers::remote_error)?,
                        )?;
                    }
                    save_connection(db, &mail, true)?;
                    if let Some(options) = &options {
                        crate::background::start_import(db, &address, options)?;
                    } else if let Some(warning) = sync_warning(&page) {
                        let mut errors = db.settings()?["backgroundSyncErrors"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        errors.retain(|error| error["accountId"] != address);
                        errors.push(json!({"accountId":address,"error":warning}));
                        db.set_settings(&json!({"backgroundSyncErrors":errors}))?;
                    }
                    Ok(())
                })
            })
            .await?;
            app.state(&select, ctx.paged).await?
        }
        ("POST", ["sync"]) => {
            let _gate = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
            let owners = if owner == "all" {
                connections(&app.settings().await?)
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect()
            } else if owner == "demo" {
                vec![]
            } else {
                vec![owner.clone()]
            };
            let errors = sync(app, &owners).await?;
            if owner != "all" && !errors.as_array().unwrap().is_empty() {
                let mut error = Error::new(502, string(&errors[0], "error"));
                error.body = errors[0].clone();
                return Err(error);
            }
            let mut state = app.state(&owner, ctx.paged).await?;
            state["syncErrors"] = errors;
            state
        }
        ("GET", ["mail", "folders"]) => {
            let _gate = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
            let owner = ctx.read_owner(&app.settings().await?, false)?;
            if owner == "demo" {
                return Err(Error::conflict("Choose a connected mailbox."));
            }
            let mail = current_mail(app, &owner).await?;
            let folders = remote_folders(app, &mail).await?;
            let updated = app.settings().await?["mailFolderCatalogs"][&owner]["updatedAt"].clone();
            json!({"folders":folders,"provider":mail.get("provider").cloned().unwrap_or(json!("imap")),"accountId":owner,"updatedAt":updated})
        }
        (
            "POST",
            [
                "messages",
                _,
                action @ ("organize" | "trash" | "undo-trash"),
            ],
        ) => {
            let _gate = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
            let undoing = *action == "undo-trash";
            let trashing = *action == "trash";
            let mode = if undoing {
                "restoreTrash"
            } else if trashing {
                "move"
            } else {
                string(&body, "mode")
            };
            if *action == "organize"
                && (!["move", "addLabel", "removeLabel", "labels"].contains(&mode)
                    || body["confirmed"] != true)
            {
                return Err(Error::invalid(
                    "Review and confirm this provider change first.",
                ));
            }
            let id = ctx.path[1].clone();
            let message = app.db(move |db| get_message(db, &owner, &id)).await?;
            if message["providerFolderMissing"] == true {
                return Err(Error::conflict(
                    "This cached message's provider folder is unavailable. Check the provider and sync before another move.",
                ));
            }
            let undo = if undoing {
                let mut entries = app
                    .0
                    .trash_undo
                    .lock()
                    .map_err(|_| Error::new(503, "Restart the workspace."))?;
                entries.retain(|_, entry| entry.expires > std::time::Instant::now());
                let token = string(&body, "undoToken");
                let entry = entries.get(token).ok_or_else(|| {
                    Error::conflict("The one-minute Trash undo has expired or was already used.")
                })?;
                if entry.owner != ctx.owner || entry.original["id"] != message["id"] {
                    return Err(Error::conflict("Choose the message's owning mailbox."));
                }
                Some(entries.remove(token).unwrap())
            } else {
                None
            };
            if let Some(undo) = &undo {
                if connections(&app.settings().await?).get(&ctx.owner) != Some(&undo.connection) {
                    return Err(Error::conflict(
                        "This mailbox connection changed. Restore the message in your provider.",
                    ));
                }
                for key in ["remoteId", "providerFolderId", "folder"] {
                    if message[key] != undo.moved[key] {
                        return Err(Error::conflict(
                            "This message moved again. Restore it in your provider.",
                        ));
                    }
                }
            }
            let mail = current_mail(app, &ctx.owner).await?;
            let folders = remote_folders(app, &mail).await?;
            let mut destination = if mode == "labels" {
                if mail["provider"] != "google" {
                    return Err(Error::invalid("Only Gmail supports message labels."));
                }
                let mut seen = std::collections::HashSet::new();
                for key in ["addLabelIds", "removeLabelIds"] {
                    let ids = body[key]
                        .as_array()
                        .filter(|ids| ids.len() <= 100)
                        .ok_or_else(|| {
                            Error::invalid("Choose up to 100 labels to add or remove.")
                        })?;
                    for id in ids {
                        let id = id.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                            Error::invalid("Choose a current custom Gmail label.")
                        })?;
                        if !seen.insert(id)
                            || !folders
                                .iter()
                                .any(|f| f["id"] == id && f["kind"] == "label")
                        {
                            return Err(Error::invalid(
                                "Choose distinct current custom Gmail labels from this mailbox.",
                            ));
                        }
                    }
                }
                if seen.is_empty() {
                    return Err(Error::invalid("Select a label change first."));
                }
                json!({"kind":"label","addLabelIds":body["addLabelIds"],"removeLabelIds":body["removeLabelIds"]})
            } else if undo.as_ref().is_some_and(|entry| {
                mail["provider"] == "google" && entry.destination["kind"] == "restoreTrash"
            }) {
                undo.as_ref().unwrap().destination.clone()
            } else {
                folders
                    .iter()
                    .find(|f| {
                        if trashing {
                            f["kind"] == "trash"
                        } else if let Some(undo) = &undo {
                            f["id"] == undo.destination["id"]
                        } else {
                            f["id"] == body["destinationId"]
                        }
                    })
                    .cloned()
                    .ok_or_else(|| {
                        Error::invalid("Choose a current folder or label from this mailbox.")
                    })?
            };
            if let Some(undo) = &undo {
                destination["undoFrom"] = undo.moved["providerFolderId"].clone();
            }
            let origin = if trashing {
                if mail["provider"] == "google" || mail["provider"] == "microsoft" {
                    providers::trash_origin(&app.0.client, &mail, &message).await?
                } else {
                    json!({"id": message["providerFolderId"].as_str().filter(|s| !s.is_empty()).unwrap_or("INBOX")})
                }
            } else {
                Value::Null
            };
            if trashing && mail["provider"] == "microsoft" {
                destination["sourceBeforeTrash"] = origin["id"].clone();
            }
            if trashing && origin["id"] == destination["id"] {
                return Err(Error::conflict(
                    "This message is already in provider Trash.",
                ));
            }
            if trashing
                && mail["provider"] != "google"
                && !folders.iter().any(|folder| folder["id"] == origin["id"])
            {
                return Err(Error::conflict(
                    "The original provider folder could not be verified. Refresh before moving this message.",
                ));
            }
            let mut patch = if ["", "imap"].contains(&string(&mail, "provider")) {
                imap::organize(&mail, &message, &destination, mode).await
            } else {
                providers::organize(&app.0.client, &mail, &message, &destination, mode).await
            }
            .map_err(|error| {
                let code = string(&error.body, "code");
                let reason = match code {
                    "provider_permission_denied" if mail["provider"] == "google" =>
                        "Gmail denied this change because the required permission was not granted. Sign in again with this account and approve mail access in your browser.".to_owned(),
                    "provider_quota_exceeded" | "provider_daily_quota_exceeded" =>
                        "The provider is limiting requests. Wait before reviewing another attempt.".to_owned(),
                    _ if error.provider_status.is_some_and(|status| status < 500) => error.to_string(),
                    _ => "The provider change could not be confirmed.".to_owned(),
                };
                let status = error.provider_status.map(|status| format!(" Provider HTTP status: {status}.")).unwrap_or_default();
                let mut safe = Error::new(502, &format!("{reason}{status} Your cached copy is retained. Check your provider before retrying."));
                safe.provider_status = error.provider_status;
                if let Some(status) = error.provider_status {
                    safe.body["providerStatus"] = status.into();
                }
                if !code.is_empty() {
                    safe.body["code"] = code.into();
                }
                if code == "provider_permission_denied" || error.provider_status == Some(401) {
                    safe.body["recoveryAction"] = "reconnect".into();
                }
                safe
            })?;
            if trashing && patch["folder"] != "trash" {
                return Err(Error::new(
                    502,
                    "The provider Trash move could not be confirmed. Your cached copy is retained.",
                ));
            }
            let google = mail["provider"] == "google";
            let moving = mode == "move" || undoing;
            let owner = ctx.owner.clone();
            let original = json!({"id":message["id"],"folder":message["folder"],"localOverrides":{"folder":message["localOverrides"]["folder"]}});
            let connection = mail.clone();
            let restore = undo.map(|entry| entry.original);
            let mut result = app
                .db(move |db| {
                    if connections(&db.settings()?).get(&owner) != Some(&mail) {
                        return Err(Error::conflict("This mailbox changed during organization."));
                    }
                    let current = get_message(db, &owner, string(&message, "id"))?;
                    if current.get("remoteId") != message.get("remoteId") {
                        return Err(Error::conflict(
                            "This message changed during organization. Refresh your mailbox.",
                        ));
                    }
                    if google {
                        let remote_folder =
                            providers::google_folder(&patch["providerLabelIds"]).to_owned();
                        let labels: Vec<Value> = patch["providerLabelIds"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|id| {
                                folders
                                    .iter()
                                    .find(|folder| folder["id"] == *id && folder["kind"] == "label")
                            })
                            .map(|folder| folder["name"].clone())
                            .collect();
                        patch["providerSnapshot"] = Value::Object(
                            current["providerSnapshot"]
                                .as_object()
                                .cloned()
                                .unwrap_or_default(),
                        );
                        patch["providerSnapshot"]["folder"] = remote_folder.clone().into();
                        patch["providerSnapshot"]["labels"] = json!(labels);
                        if current["localOverrides"]["labels"] != true {
                            patch["labels"] = json!(labels);
                        }
                        if moving {
                            patch["localOverrides"] = Value::Object(
                                current["localOverrides"]
                                    .as_object()
                                    .cloned()
                                    .unwrap_or_default(),
                            );
                            patch["localOverrides"]["folder"] = false.into();
                        }
                        patch["folder"] = if !moving && current["localOverrides"]["folder"] == true
                        {
                            current["folder"].clone()
                        } else {
                            remote_folder.into()
                        };
                    }
                    if let Some(original) = restore {
                        patch["folder"] = original["folder"].clone();
                        if google {
                            patch["localOverrides"]["folder"] =
                                original["localOverrides"]["folder"]
                                    .as_bool()
                                    .unwrap_or(false)
                                    .into();
                        }
                    }
                    let changed = db
                        .update(&owner, string(&message, "id"), &patch)?
                        .ok_or_else(|| Error::new(404, "Message not found."))?;
                    Ok(json!({"message":pages::owned(&owner,changed)}))
                })
                .await?;
            if trashing {
                let token = crate::service::hex_token()?;
                let mut entries = app
                    .0
                    .trash_undo
                    .lock()
                    .map_err(|_| Error::new(503, "Restart the workspace."))?;
                entries.retain(|_, entry| entry.expires > std::time::Instant::now());
                // ponytail: retain the latest 100 deletes for this one-minute desktop undo window.
                if entries.len() >= 100
                    && let Some(oldest) = entries
                        .iter()
                        .min_by_key(|(_, entry)| entry.expires)
                        .map(|(key, _)| key.clone())
                {
                    entries.remove(&oldest);
                }
                entries.insert(
                    token.clone(),
                    TrashUndo {
                        expires: std::time::Instant::now() + std::time::Duration::from_secs(60),
                        owner: ctx.owner.clone(),
                        original,
                        connection,
                        destination: origin,
                        moved: json!({"remoteId":result["message"]["remoteId"],"providerFolderId":result["message"]["providerFolderId"],"folder":result["message"]["folder"]}),
                    },
                );
                result["undoToken"] = token.into();
                result["undoSeconds"] = 60.into();
            }
            result
        }
        _ => return Ok(None),
    };
    Ok(Some(Json(result).into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_mail_imap_refresh_attempts_a_fetch() {
        let root =
            std::env::temp_dir().join(format!("morrow-all-mail-refresh-{}", uuid::Uuid::new_v4()));
        let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
        let owner = "imap@example.invalid";
        app.db(move |db| {
            // Invalid port fails before networking; an empty scope must not report success.
            db.set_settings(&json!({"mailAccounts":{owner:{"email":owner,"provider":"imap","connectionId":"fixture","imapPort":0}},"imports":{owner:{"options":{"allMail":true,"inbox":false,"sent":false}}}}))?;
            Ok(())
        }).await.unwrap();
        let errors = sync(&app, &[owner.into()]).await.unwrap();
        assert_eq!(errors.as_array().unwrap().len(), 1);
        assert_eq!(errors[0]["accountId"], owner);
        assert_eq!(errors[0]["code"], "mail_sync_failed");
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_cooldowns_apply_only_to_the_saved_connection() {
        let owner = "reconnect@example.invalid";
        let saved = json!({"email":owner,"provider":"google","connectionId":"previous"});
        let candidate = json!({"email":owner,"provider":"imap","imapHost":"imap.example.invalid","imapPort":993});
        let until = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let version = crate::folders::connection_version(&saved);
        for source in [
            json!({"mailReadBackoffs":{owner:{"connection":version,"nextRetryAt":until}}}),
            json!({"imports":{owner:{"connectionId":"previous","errorCode":"rate_limited","nextRetryAt":until}}}),
            json!({"mailFolderCatalogs":{owner:{"connection":version,"errorCode":"rate_limited","nextRetryAt":until}}}),
            json!({"backgroundSyncErrors":[{"accountId":owner,"code":"rate_limited","nextRetryAt":until}]}),
        ] {
            let mut config = merge(json!({"mailAccounts":{owner:saved.clone()}}), &source);
            assert!(read_backoff(&config, &saved).is_some());
            assert!(read_backoff(&config, &candidate).is_none());
            config["mailAccounts"] = json!({});
            assert!(read_backoff(&config, &candidate).is_none());
        }
    }
    #[test]
    fn sync_quota_failure_schedules_retry_without_reconnecting() {
        let mut quota = Error::new(502, "private provider detail");
        quota.provider_status = Some(429);
        let failure = sync_failure("one@example.com", &quota, &json!({"retryCount":2}));
        assert_eq!(failure["code"], "rate_limited");
        assert_eq!(failure["retryCount"], 3);
        assert_eq!(failure["recoveryAction"], "retry");
        assert!(failure["nextRetryAt"].as_str().is_some());
        assert!(!failure.to_string().contains("private provider detail"));
        quota.provider_status = Some(401);
        assert_eq!(
            sync_failure("one@example.com", &quota, &Value::Null)["recoveryAction"],
            "reconnect"
        );
    }
    #[test]
    fn sparse_imap_scan_never_reports_complete_sync() {
        assert!(sync_warning(&json!({"messages":[],"nextCursor":{"uid":42}})).is_some());
        assert!(
            sync_warning(&json!({"messages":[{"id":"one"}],"nextCursor":{"uid":42}})).is_some()
        );
        assert!(sync_warning(&json!({"messages":[],"nextCursor":null})).is_none());
        assert!(sync_warning(&json!({"messages":[],"nextCursor":"google-page"})).is_none());
        assert!(sync_warning(&json!({"messages":[],"nextCursor":""})).is_none());
        assert!(
            sync_warning(&json!({"messages":vec![json!({});50],"nextCursor":{"uid":42}})).is_none()
        );
    }
}
