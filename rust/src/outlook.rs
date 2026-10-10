//! Outlook change tracking and explicit flag writes. Checkpoints share the mail writer gate.
use crate::{
    background::write_owner,
    error::{Error, Result},
    folders::connection_version,
    mail, providers,
    service::{App, connections},
    store::{Store, merge, now, string},
};
use reqwest::Method;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const PREFER: &str =
    "outlook.body-content-type=\"html\", IdType=\"ImmutableId\", odata.maxpagesize=50";
const METADATA: &str =
    "id,isRead,flag,parentFolderId,isDraft,receivedDateTime,sentDateTime,createdDateTime";

fn remote_id(message: &Value) -> Result<&str> {
    message["remoteId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(message, "id"))
        .strip_prefix("microsoft:")
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .ok_or_else(|| Error::invalid("This message has no Outlook identity."))
}
fn current(db: &Store, mail: &Value) -> Result<()> {
    if connections(&db.settings()?).get(string(mail, "email")) != Some(mail) {
        return Err(Error::conflict("This mailbox changed during sync."));
    }
    Ok(())
}
fn cached(db: &Store, owner: &str, id: &str) -> Result<Option<Value>> {
    let row: Option<String> = db.conn.query_row(
        "SELECT data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? ORDER BY rowid DESC LIMIT 1",
        params![owner, format!("microsoft:{id}")], |row| row.get(0)).optional()?;
    row.map(|row| serde_json::from_str(&row).map_err(Into::into))
        .transpose()
}
async fn get(app: &App, mail: &Value, path: &str) -> Result<Value> {
    let result = providers::request(
        providers::api(&app.0.client, mail, Method::GET, path)?.header("Prefer", PREFER),
        8 * 1024 * 1024,
    )
    .await;
    match result {
        Ok(value) => Ok(value),
        // Concurrent successful metadata reads must not clear another read's quota deadline.
        Err(error) => mail::finish_read(app, mail, Err(error)).await,
    }
}
pub(crate) fn flags(raw: &Value) -> Result<Value> {
    let read = raw["isRead"]
        .as_bool()
        .ok_or_else(providers::remote_error)?;
    let flag = string(&raw["flag"], "flagStatus");
    if !["flagged", "notFlagged", "complete"].contains(&flag) {
        return Err(providers::remote_error());
    }
    Ok(json!({"read":read,"starred":flag=="flagged"}))
}
fn location(raw: &Value, folders: &[Value]) -> Result<Value> {
    let id = string(raw, "parentFolderId");
    if id.is_empty() {
        return Err(providers::remote_error());
    }
    let folder = folders.iter().find(|folder| folder["id"] == id);
    let kind = folder.map(|f| string(f, "kind")).unwrap_or("archive");
    let kind = if raw["isDraft"] == true && !["trash", "spam"].contains(&kind) {
        "drafts"
    } else {
        kind
    };
    let date = match kind {
        "sent" => "sentDateTime",
        "drafts" => "createdDateTime",
        _ => "receivedDateTime",
    };
    Ok(merge(
        flags(raw)?,
        &json!({"date":providers::microsoft_date(string(raw,date))?,"folder":kind,"providerFolderId":id,"providerFolderName":folder.map(|f|string(f,"name")).unwrap_or("Outlook folder"),"providerFolderMissing":false,"providerDeleted":false,"providerSent":kind=="sent","providerDraft":raw["isDraft"]==true}),
    ))
}
fn permitted(raw: &Value, folders: &[Value], job: &Value) -> Result<bool> {
    let Some(folder) = folders.iter().find(|f| f["id"] == raw["parentFolderId"]) else {
        return Ok(false);
    };
    let kind = string(folder, "kind");
    let options = &job["options"];
    let scope = if options["allMail"] == true {
        !["trash", "spam"].contains(&kind)
    } else if options.is_object() {
        options[kind] == true && ["inbox", "sent"].contains(&kind)
    } else {
        kind == "inbox"
    };
    let date = providers::microsoft_date(string(
        raw,
        if kind == "drafts" || (raw["isDraft"] == true && !["trash", "spam"].contains(&kind)) {
            "createdDateTime"
        } else if kind == "sent" {
            "sentDateTime"
        } else {
            "receivedDateTime"
        },
    ))?;
    Ok(scope && date.as_str() >= string(job, "since") && date.as_str() >= string(job, "syncSince"))
}

// Read the current immutable item, since delta can replay old events or report moves as removals.
async fn resolve(
    app: &App,
    connection: &Value,
    folders: &[Value],
    job: &Value,
    id: &str,
) -> Result<Option<Value>> {
    let owner = string(connection, "email").to_owned();
    let key = id.to_owned();
    let existing = app.db(move |db| cached(db, &owner, &key)).await?;
    let path = format!("/messages/{}", providers::component(id));
    let raw = match get(
        app,
        connection,
        &format!("{path}?$select={}", providers::MICROSOFT_METADATA_FIELDS),
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if error.provider_status == Some(404) => {
            return Ok(existing.map(|message| merge(message, &json!({"folder":"trash","providerDeleted":true,"providerFolderMissing":true,"providerFolderId":"","providerFolderName":"Deleted from Outlook (cached copy)","providerSent":false,"providerDraft":false}))));
        }
        Err(error) => return Err(error),
    };
    if raw["id"] != id {
        return Err(providers::remote_error());
    }
    let patch = location(&raw, folders)?;
    if existing.is_none() && !permitted(&raw, folders, job)? {
        return Ok(None);
    }
    let previous = existing.clone();
    let mut message = if let Some(existing) = existing.filter(|_| raw["isDraft"] != true) {
        existing
    } else {
        match providers::microsoft_message(&app.0.client, connection, &raw, string(&patch, "date"))
            .await
        {
            Ok(Some(message)) => message,
            Ok(None) => return Ok(None),
            Err(error) => return mail::finish_read(app, connection, Err(error)).await,
        }
    };
    message = merge(message, &patch);
    message["remoteId"] = format!("microsoft:{id}").into();
    if let Some(previous) = previous.as_ref().filter(|old| {
        old["localOverrides"]["folder"] == true
            && (string(old, "providerFolderId").is_empty()
                || old["providerFolderId"] == raw["parentFolderId"])
    }) {
        message["folder"] = previous["folder"].clone();
    } else if let Some(overrides) = message["localOverrides"].as_object_mut() {
        overrides.remove("folder");
    }
    message["providerSnapshot"] = merge(
        merge(json!({}), &message["providerSnapshot"]),
        &flags(&raw)?,
    );
    if let Some(overrides) = message["localOverrides"].as_object_mut() {
        for key in ["read", "starred"] {
            overrides.remove(key);
        }
    }
    Ok(Some(message))
}
fn save(db: &Store, connection: &Value, messages: &[Value]) -> Result<()> {
    current(db, connection)?;
    let owner = string(connection, "email");
    let mut arrivals = Vec::new();
    for message in messages {
        let mut message = message.clone();
        // Reuse sent-fingerprint matching before assigning a new local identity.
        if cached(db, owner, remote_id(&message)?)?.is_none() {
            mail::import_messages(db, connection, std::slice::from_ref(&message))?;
            if message["folder"] == "inbox"
                && string(&message, "date") >= string(&db.settings()?["imports"][owner], "before")
            {
                arrivals.push(string(&message, "id").to_owned());
            }
        }
        // Never replace local drafts, delivery records, or local-only markers during reconciliation.
        if let Some(existing) = cached(db, owner, remote_id(&message)?)? {
            if existing["folder"] == "drafts" && existing["providerDraft"] != true {
                continue;
            }
            if existing["localOverrides"]["folder"] == true
                && existing["providerFolderId"] == message["providerFolderId"]
                && message["providerDeleted"] != true
            {
                message["folder"] = existing["folder"].clone();
                if !message["localOverrides"].is_object() {
                    message["localOverrides"] = json!({});
                }
                message["localOverrides"]["folder"] = true.into();
            }
            for key in [
                "id",
                "pending",
                "lowPriority",
                "labels",
                "deliveryStatus",
                "messageId",
            ] {
                if let Some(value) = existing.get(key) {
                    message[key] = value.clone();
                }
            }
        }
        if db.get(owner, string(&message, "id"))?.as_ref() != Some(&message) {
            db.upsert(owner, &message)?;
        }
    }
    crate::background::arrivals(db, owner, &arrivals)
}
fn delta_url(folder: &str, next: &str) -> Result<url::Url> {
    let initial = url::Url::parse(&format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta",
        providers::component(folder)
    ))
    .unwrap();
    if next.is_empty() {
        return Ok(initial);
    }
    providers::validated_folder_next(next, &initial, folder, "messages/delta")
}
fn invalid_checkpoint() -> Error {
    let mut error = Error::new(
        502,
        "Outlook returned an invalid sync checkpoint. Reconnect this account to restart change tracking.",
    );
    error.body["code"] = "outlook_sync_invalid".into();
    error.body["recoveryAction"] = "reconnect".into();
    error
}
fn digest(value: &str) -> Value {
    json!(format!("{:x}", Sha256::digest(value.as_bytes())))
}

pub async fn sync(app: &App, connection: &Value) -> Result<()> {
    let owner = string(connection, "email");
    let config = app.settings().await?;
    let job = config["imports"][owner].clone();
    // Keep the newest Inbox/Sent responsive while the initial delta baseline is still paging.
    for folder in ["inbox", "sent"] {
        let selected = if job["options"].is_object() {
            job["options"]["allMail"] == true || job["options"][folder] == true
        } else {
            folder == "inbox"
        };
        if selected {
            let mut options = json!({"folder":folder});
            if !string(&job, "since").is_empty() {
                options["since"] = job["since"].clone();
            }
            let page = mail::fetch_page(app, connection, &options).await?;
            mail::commit_sync_page(app, owner, connection, &page).await?;
        }
    }
    let mut work = app.0.activity.start(owner, "sync", "Outlook sync cycle", "Checking one change page and up to 25 downloaded messages. Further cycles may be needed; this is not a full-mailbox completion indicator.");
    let mut state = config["outlookSync"][owner].clone();
    if state["connection"] != connection_version(connection) {
        state = json!({"connection":connection_version(connection),"coverageVersion":2,"checkpoints":{},"folderIndex":0,"reconcileAfter":""});
    } else if state["coverageVersion"] != 2 {
        // Older baselines could advance past uncached mail. Rebuild once within the
        // approved import window, retaining the original live-sync boundary.
        if let Some(checkpoints) = state["checkpoints"].as_object_mut() {
            for checkpoint in checkpoints.values_mut() {
                if checkpoint["blocked"] != true {
                    *checkpoint = json!({"before":checkpoint["before"],"initial":true});
                }
            }
        }
        state["coverageVersion"] = 2.into();
        state["reconcileAfter"] = "".into();
    }
    if state["catalogAt"].as_i64().unwrap_or(0) + 300_000 < chrono::Utc::now().timestamp_millis() {
        let folders = providers::microsoft_sync_folders(&app.0.client, connection).await;
        state["folders"] = json!(mail::finish_read(app, connection, folders).await?);
        state["catalogAt"] = chrono::Utc::now().timestamp_millis().into();
    }
    let folders = state["folders"]
        .as_array()
        .ok_or_else(providers::remote_error)?
        .clone();
    let selected: Vec<_> = folders
        .iter()
        .filter(|folder| {
            let kind = string(folder, "kind");
            if job["options"]["allMail"] == true {
                !["trash", "spam"].contains(&kind)
            } else if job["options"].is_object() {
                ["inbox", "sent"].contains(&kind) && job["options"][kind] == true
            } else {
                kind == "inbox"
            }
        })
        .collect();
    // ponytail: one folder page per poll; the persisted rotation covers larger folder trees.
    let start = state["folderIndex"].as_u64().unwrap_or(0) as usize;
    for offset in 0..selected.len().min(1) {
        let index = (start + offset) % selected.len();
        let id = string(selected[index], "id");
        let checkpoint = state["checkpoints"][id].clone();
        if checkpoint["blocked"] == true {
            return Err(invalid_checkpoint());
        }
        let next = string(&checkpoint, "url");
        let mut url = delta_url(id, next)?;
        if next.is_empty() {
            url.query_pairs_mut()
                .append_pair("$select", METADATA)
                .append_pair("$top", "50")
                .append_pair("$orderby", "receivedDateTime desc");
        }
        let result = get(
            app,
            connection,
            &format!(
                "{}?{}",
                url.path().strip_prefix("/v1.0/me").unwrap(),
                url.query().unwrap_or("")
            ),
        )
        .await;
        let result = match result {
            Err(error)
                if !next.is_empty()
                    && (error.provider_status == Some(410)
                        || error.body["code"] == "provider_sync_expired") =>
            {
                state["checkpoints"][id] = json!({"before":checkpoint["before"],"initial":true});
                state["reconcileAfter"] = "".into();
                persist(app, connection, &state, &[]).await?;
                continue;
            }
            Err(error) if error.provider_status == Some(404) => {
                state["catalogAt"] = 0.into();
                state["checkpoints"][id] = Value::Null;
                state["folderIndex"] = ((index + 1) % selected.len()).into();
                persist(app, connection, &state, &[]).await?;
                continue;
            }
            result => result?,
        };
        let validation = (|| -> Result<(&Vec<Value>, &str, bool)> {
            let rows = result["value"]
                .as_array()
                .filter(|rows| rows.len() <= 50)
                .ok_or_else(providers::remote_error)?;
            let more = result.get("@odata.nextLink").is_some();
            if more && result.get("@odata.deltaLink").is_some() {
                return Err(providers::remote_error());
            }
            let link = result[if more {
                "@odata.nextLink"
            } else {
                "@odata.deltaLink"
            }]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(providers::remote_error)?;
            let next_url = delta_url(id, link)?;
            if !next_url.query_pairs().any(|(key, value)| {
                key == if more { "$skiptoken" } else { "$deltatoken" } && !value.is_empty()
            }) {
                return Err(providers::remote_error());
            }
            if more
                && (link == url.as_str()
                    || checkpoint["visited"]
                        .as_array()
                        .is_some_and(|v| v.contains(&digest(link))))
            {
                return Err(providers::remote_error());
            }
            if rows
                .iter()
                .any(|row| string(row, "id").is_empty() || string(row, "id").len() > 4096)
            {
                return Err(providers::remote_error());
            }
            Ok((rows, link, more))
        })();
        let (rows, link, more) = match validation {
            Ok(value) => value,
            Err(_) => {
                state["checkpoints"][id] = merge(checkpoint, &json!({"blocked":true}));
                persist(app, connection, &state, &[]).await?;
                return Err(invalid_checkpoint());
            }
        };
        let before = checkpoint["before"].as_str().unwrap_or("");
        let before = if before.is_empty() {
            now()
        } else {
            before.to_owned()
        };
        let mut scope = job.clone();
        if !scope.is_object() {
            scope = json!({});
        }
        // A completed import approves this whole date range. For an incomplete
        // or paused import, only mail arriving after its original cutoff belongs
        // to live sync; never move that boundary forward when a token expires.
        if !next.is_empty() && checkpoint["initial"] != false {
            scope["syncSince"] = if job["options"].is_object() && job["status"] == "complete" {
                string(&job, "since").to_owned()
            } else if job["options"].is_object() && !string(&job, "before").is_empty() {
                string(&job, "before").to_owned()
            } else {
                before.clone()
            }
            .into();
        }
        let mut messages = Vec::new();
        for chunk in rows.chunks(4) {
            for result in futures_util::future::join_all(
                chunk
                    .iter()
                    .map(|row| resolve(app, connection, &folders, &scope, string(row, "id"))),
            )
            .await
            {
                if let Some(message) = result? {
                    messages.push(message);
                }
            }
        }
        let mut visited = checkpoint["visited"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if more {
            visited.push(digest(url.as_str()));
        } else {
            visited.clear();
        }
        state["checkpoints"][id] = json!({"url":link,"visited":visited,"initial":more && checkpoint["initial"]!=false,"before":before});
        state["folderIndex"] = ((index + 1) % selected.len()).into();
        persist(app, connection, &state, &messages).await?;
    }
    // Rolling checks also repair pre-checkpoint deletions and messages moved outside imported scopes.
    let owner = owner.to_owned();
    let after = string(&state, "reconcileAfter").to_owned();
    let rows = app.db(move |db| {
        db.conn.prepare("SELECT data FROM messages WHERE account=? AND id>? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'microsoft:%' ORDER BY id LIMIT 25")?
            .query_map(params![owner,after], |row| row.get::<_,String>(0))?.map(|row| Ok(serde_json::from_str::<Value>(&row?)?)).collect::<Result<Vec<_>>>()
    }).await?;
    for chunk in rows.chunks(4) {
        let mut messages = Vec::new();
        for result in
            futures_util::future::join_all(chunk.iter().map(|row| async {
                resolve(app, connection, &folders, &job, remote_id(row)?).await
            }))
            .await
        {
            if let Some(message) = result? {
                messages.push(message);
            }
        }
        state["reconcileAfter"] = chunk.last().unwrap()["id"].clone();
        persist(app, connection, &state, &messages).await?;
    }
    if rows.len() < 25 {
        state["reconcileAfter"] = "".into();
    }
    state["updatedAt"] = now().into();
    persist(app, connection, &state, &[]).await?;
    work.finish(true, None);
    Ok(())
}
async fn persist(app: &App, connection: &Value, state: &Value, messages: &[Value]) -> Result<()> {
    let (connection, state, messages) = (connection.clone(), state.clone(), messages.to_vec());
    app.db(move |db| {
        db.transaction(|db| {
            save(db, &connection, &messages)?;
            write_owner(db, "outlookSync", string(&connection, "email"), state)
        })
    })
    .await
}
