//! Connection-bound Gmail history with atomic message/page checkpoints.
use crate::{
    background::write_owner,
    error::{Error, Result},
    folders::connection_version,
    mail, providers,
    service::{App, connections},
    store::{merge, now, string},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

const SCOPES: [&str; 5] = ["inbox", "sent", "drafts", "starred", "all"];
fn invalid() -> Error {
    let mut error = Error::new(
        502,
        "Gmail returned an invalid change checkpoint. Saved mail and progress were retained. Reconnect or restart the import after the provider data is corrected.",
    );
    error.body["code"] = "gmail_sync_invalid".into();
    error
}
fn history_id(value: &Value) -> Result<u64> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .ok_or_else(invalid)
}
fn token(value: &Value) -> Result<Option<&str>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 8192 && !v.chars().any(char::is_control))
        .map(Some)
        .ok_or_else(invalid)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

async fn persist(
    app: &App,
    connection: &Value,
    previous: &Value,
    state: Value,
    messages: Vec<Value>,
    next: Option<String>,
    clear: bool,
) -> Result<()> {
    let (connection, previous) = (connection.clone(), previous.clone());
    app.db(move |db| db.transaction(|db| {
        let owner = string(&connection, "email");
        let config = db.settings()?;
        if connections(&config).get(owner) != Some(&connection) || config["gmailSync"][owner] != previous {
            return Err(Error::conflict("This Gmail connection or checkpoint changed during sync."));
        }
        if clear {
            if state["historyId"].is_null() { db.conn.execute("DELETE FROM mail_sync_cursor_hashes WHERE provider IN ('google_history','google_resync') AND account=?", [owner])?; }
            else { db.conn.execute("DELETE FROM mail_sync_cursor_hashes WHERE provider='google_history' AND account=?", [owner])?; }
        }
        if let Some(next) = next {
            let kind=if next.starts_with("resync:") {"google_resync"} else {"google_history"};
            let digest = hash(&next);
            if db.conn.query_row("SELECT EXISTS(SELECT 1 FROM mail_sync_cursor_hashes WHERE provider=? AND account=? AND digest=?)", params![kind,owner,digest], |r|r.get::<_,bool>(0))? {
                return Err(invalid());
            }
            db.conn.execute("INSERT INTO mail_sync_cursor_hashes VALUES(?,?,?)", params![kind,owner,digest])?;
        }
        let available = messages.iter().filter(|m|m["providerDeleted"]!=true).cloned().collect::<Vec<_>>();
        let ids = mail::import_messages(db, &connection, &available)?;
        for message in messages.iter().filter(|m|m["providerDeleted"]==true) {
            db.update(owner, string(message,"id"), &json!({"providerDeleted":true,"providerFolderMissing":true}))?;
        }
        let arrivals = ids.into_iter().filter(|id|db.get(owner,id).ok().flatten().is_some_and(|m|m["folder"]=="inbox" && (config["imports"][owner].is_null() || string(&m,"date")>=string(&config["imports"][owner],"before")))).collect::<Vec<_>>();
        crate::background::arrivals(db, owner, &arrivals)?;
        write_owner(db,"gmailSync",owner,state)
    })).await
}
async fn read(app: &App, connection: &Value, path: &str) -> Result<Value> {
    let result = providers::get(&app.0.client, connection, path).await;
    mail::finish_read(app, connection, result).await
}

fn changes(page: &Value, start: u64) -> Result<Vec<String>> {
    let end = history_id(&page["historyId"])?;
    if end < start {
        return Err(invalid());
    }
    let rows = if page["history"].is_null() {
        &[][..]
    } else {
        page["history"]
            .as_array()
            .filter(|r| r.len() <= 50)
            .ok_or_else(invalid)?
            .as_slice()
    };
    let mut ids = BTreeSet::new();
    let mut after = start;
    for row in rows {
        let id = history_id(&row["id"])?;
        if id <= after || id > end {
            return Err(invalid());
        }
        after = id;
        // Generic messages can duplicate the typed events; resolve current state
        // once per ID so delete/re-add and out-of-order label events are idempotent.
        for key in [
            "messagesAdded",
            "messagesDeleted",
            "labelsAdded",
            "labelsRemoved",
        ] {
            if let Some(entries) = row.get(key) {
                for event in entries.as_array().ok_or_else(invalid)? {
                    let id = string(&event["message"], "id");
                    if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
                        return Err(invalid());
                    }
                    ids.insert(id.to_owned());
                    if ids.len() > 1000 {
                        return Err(invalid());
                    }
                }
            }
        }
        if let Some(entries) = row.get("messages") {
            for event in entries.as_array().ok_or_else(invalid)? {
                let id = string(event, "id");
                if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
                    return Err(invalid());
                }
                ids.insert(id.to_owned());
                if ids.len() > 1000 {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(ids.into_iter().collect())
}
async fn resolve(
    app: &App,
    connection: &Value,
    ids: &[Value],
    fetched: &mut HashMap<String, Value>,
) -> Result<Vec<Value>> {
    if ids.len() > 50 {
        return Err(invalid());
    }
    let owner = string(connection, "email").to_owned();
    let keys = ids.to_vec();
    let existing = app.db(move |db| {
        let mut rows = HashMap::new();
        for id in keys {
            let id=id.as_str().ok_or_else(invalid)?;
            let raw:Option<String>=db.conn.query_row("SELECT data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? ORDER BY rowid DESC LIMIT 1",params![owner,format!("google:{id}")],|r|r.get(0)).optional()?;
            if let Some(raw)=raw { rows.insert(id.to_owned(),serde_json::from_str::<Value>(&raw)?); }
        }
        Ok(rows)
    }).await?;
    let cached = existing
        .iter()
        .filter(|(_, m)| mail::reusable_google_body(m))
        .map(|(id, m)| (id.clone(), m.clone()))
        .collect();
    let list = json!({"messages":ids.iter().map(|id|json!({"id":id})).collect::<Vec<_>>()});
    let page =
        providers::google_fetch_page(&app.0.client, connection, &list, &cached, fetched).await;
    let page = mail::finish_read(app, connection, page).await?;
    let mut messages = page["messages"].as_array().ok_or_else(invalid)?.clone();
    for message in &mut messages {
        // A successful owned detail read proves current availability, even when
        // history replays an identity previously marked unavailable.
        message["providerDeleted"] = false.into();
        message["providerFolderMissing"] = false.into();
        let id = string(message, "id")
            .strip_prefix("google:")
            .ok_or_else(invalid)?;
        fetched.insert(id.to_owned(), message.clone());
    }
    let job = app.settings().await?["imports"][string(connection, "email")].clone();
    messages.retain(|m| {
        existing.contains_key(string(m, "id").strip_prefix("google:").unwrap_or(""))
            || (m["providerLabelIds"]
                .as_array()
                .is_some_and(|labels| !labels.iter().any(|v| v == "SPAM" || v == "TRASH"))
                && string(m, "date") >= string(&job, "since"))
    });
    for id in ids {
        let id = id.as_str().ok_or_else(invalid)?;
        if !messages.iter().any(|m| m["id"] == format!("google:{id}"))
            && let Some(old) = existing.get(id)
        {
            // A detail 404 for an explicitly requested ID is deletion evidence;
            // absence from a bounded listing/history page is never evidence.
            messages.push(merge(
                old.clone(),
                &json!({"providerDeleted":true,"providerFolderMissing":true}),
            ));
        }
    }
    Ok(messages)
}

pub(crate) async fn sync(app: &App, connection: &Value) -> Result<()> {
    let result = sync_inner(app, connection).await;
    if result
        .as_ref()
        .is_err_and(|error| error.body["code"] == "gmail_sync_invalid")
    {
        let connection = connection.clone();
        app.db(move |db| {
            let config = db.settings()?;
            let owner = string(&connection, "email");
            if connections(&config).get(owner) == Some(&connection) {
                let mut state = config["gmailSync"][owner].clone();
                if state["connection"]!=connection_version(&connection) || state["version"]!=1 {
                    state=json!({"version":1,"connection":connection_version(&connection),"historyId":null,"liveSince":now()});
                }
                state["blocked"] = true.into();
                write_owner(db, "gmailSync", owner, state)?;
            }
            Ok(())
        })
        .await?;
    }
    result
}
async fn sync_inner(app: &App, connection: &Value) -> Result<()> {
    let _phase = crate::sync_profile::phase("gmailSync");
    let owner = string(connection, "email");
    let config = app.settings().await?;
    let job = config["imports"][owner].clone();
    let previous = config["gmailSync"][owner].clone();
    let mut saved = previous.clone();
    let mut state = previous.clone();
    if state["connection"] != connection_version(connection) || state["version"] != 1 {
        state = json!({"version":1,"connection":connection_version(connection),"historyId":null,"liveSince":now()});
    }
    let mut fetched = HashMap::new();
    crate::reconcile::priority(app, connection, &mut fetched).await?;
    if state["blocked"] == true {
        // Stop malformed-history retries while independent bounded reads keep
        // drafts/current views and cached flags fresh.
        let mut options = json!({"folder":"drafts"});
        if !string(&job, "since").is_empty() {
            options["since"] = job["since"].clone();
        }
        let page = mail::fetch_page_cached(app, connection, &options, &mut fetched).await?;
        mail::commit_sync_page(app, owner, connection, &page).await?;
        crate::reconcile::sync(app, connection, &mut fetched).await?;
        return Err(invalid());
    }
    if state["historyId"].is_null() && state["bootstrap"].is_null() {
        let profile = read(app, connection, "/profile").await?;
        history_id(&profile["historyId"])?;
        state["bootstrap"] = json!({"anchor":profile["historyId"],"index":0});
        fetched.clear();
        persist(app, connection, &saved, state.clone(), vec![], None, true).await?;
        saved = state.clone();
    }
    if state["bootstrap"].is_object() {
        history_id(&state["bootstrap"]["anchor"])?;
        let index = state["bootstrap"]["index"]
            .as_u64()
            .filter(|i| *i < 5)
            .ok_or_else(invalid)? as usize;
        for (index, folder) in SCOPES.iter().enumerate().skip(index) {
            let mut options = json!({"folder":folder});
            if !string(&job, "since").is_empty() {
                options["since"] = job["since"].clone();
            }
            let page = mail::fetch_page_cached(app, connection, &options, &mut fetched).await?;
            let messages = page["messages"].as_array().ok_or_else(invalid)?.clone();
            state["bootstrap"]["index"] = (index + 1).into();
            if index == 4 {
                state["historyId"] = state["bootstrap"]["anchor"].clone();
                state["bootstrap"] = Value::Null;
            }
            persist(
                app,
                connection,
                &saved,
                state.clone(),
                messages,
                None,
                false,
            )
            .await?;
            saved = state.clone();
        }
    } else {
        // Keep mutable provider drafts fresh even if no label/history event was emitted.
        let mut options = json!({"folder":"drafts"});
        if !string(&job, "since").is_empty() {
            options["since"] = job["since"].clone();
        }
        let page = mail::fetch_page_cached(app, connection, &options, &mut fetched).await?;
        mail::commit_sync_page(app, owner, connection, &page).await?;
        if state["pending"].is_null() {
            let start = history_id(&state["historyId"])?;
            let page_token = token(&state["pageToken"])?;
            let query = {
                let mut query = url::form_urlencoded::Serializer::new(String::new());
                query
                    .append_pair("startHistoryId", string(&state, "historyId"))
                    .append_pair("maxResults", "50");
                if let Some(token) = page_token {
                    query.append_pair("pageToken", token);
                }
                query.finish()
            };
            let result = read(app, connection, &format!("/history?{query}")).await;
            let page = match result {
                Err(error) if error.provider_status == Some(404) => {
                    // Retain the original live/import boundary. Recent scopes are
                    // reseeded and the permitted interval is repaired incrementally.
                    state["historyId"] = Value::Null;
                    state["pageToken"] = Value::Null;
                    state["pending"] = Value::Null;
                    state["resync"] = json!({"index":0,"cursor":null});
                    persist(app, connection, &saved, state, vec![], None, true).await?;
                    return Ok(());
                }
                result => result?,
            };
            let ids = changes(&page, start)?;
            let next = token(&page["nextPageToken"])?;
            if next.is_some_and(|v| Some(v) == page_token) {
                return Err(invalid());
            }
            state["pending"] = json!({"ids":ids,"next":next,"end":page["historyId"]});
        }
        let pending = state["pending"].clone();
        let ids = pending["ids"]
            .as_array()
            .filter(|v| v.len() <= 1000)
            .ok_or_else(invalid)?;
        let selected = &ids[..ids.len().min(50)];
        for id in selected {
            if let Some(id) = id.as_str() {
                fetched.remove(id);
            }
        }
        let messages = resolve(app, connection, selected, &mut fetched).await?;
        let next = token(&pending["next"])?;
        if ids.len() > 50 {
            state["pending"]["ids"] = json!(&ids[50..]);
            persist(
                app,
                connection,
                &saved,
                state.clone(),
                messages,
                None,
                false,
            )
            .await?;
        } else {
            state["pending"] = Value::Null;
            state["pageToken"] = json!(next);
            if next.is_none() {
                state["historyId"] = pending["end"].clone();
            }
            persist(
                app,
                connection,
                &saved,
                state.clone(),
                messages,
                next.map(|v| format!("history:{v}")),
                next.is_none(),
            )
            .await?;
        }
        saved = state.clone();
    }
    if state["resync"].is_object() {
        let index = state["resync"]["index"]
            .as_u64()
            .filter(|v| *v < 5)
            .ok_or_else(invalid)? as usize;
        let since = if job["status"] == "complete" {
            string(&job, "since")
        } else if !string(&job, "before").is_empty() {
            string(&job, "before")
        } else {
            string(&state, "liveSince")
        };
        let options =
            json!({"folder":SCOPES[index],"since":since,"cursor":state["resync"]["cursor"]});
        let page = mail::fetch_page_cached(app, connection, &options, &mut fetched).await?;
        let cursor = token(&page["nextCursor"])?;
        if cursor.is_some_and(|v| v == string(&options, "cursor")) {
            return Err(invalid());
        }
        let messages = page["messages"].as_array().ok_or_else(invalid)?.clone();
        if cursor.is_none() {
            state["resync"] = if index == 4 {
                Value::Null
            } else {
                json!({"index":index+1,"cursor":null})
            };
        } else {
            state["resync"]["cursor"] = json!(cursor);
        }
        // History and recovery pagination are independent and commit separately.
        persist(
            app,
            connection,
            &saved,
            state,
            messages,
            cursor.map(|v| format!("resync:{index}:{v}")),
            false,
        )
        .await?;
    }
    crate::reconcile::sync(app, connection, &mut fetched).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_is_typed_deduplicated_and_monotonic() {
        assert_eq!(changes(&json!({"historyId":"30","history":[{"id":"20","messagesAdded":[{"message":{"id":"a"}}],"labelsRemoved":[{"message":{"id":"a"}}]},{"id":"25","messagesDeleted":[{"message":{"id":"b"}}]}]}),10).unwrap(),vec!["a","b"]);
        for page in [
            json!({"historyId":"9"}),
            json!({"historyId":"30","history":[{"id":"20"},{"id":"20"}]}),
            json!({"historyId":"30","history":[{"id":"20","messagesAdded":[{"message":{"id":""}}]}]}),
        ] {
            assert!(changes(&page, 10).is_err());
        }
    }
}
