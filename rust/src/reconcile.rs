//! Bounded metadata reconciliation for cached Gmail/IMAP mail outside recent pages.
use crate::{
    background::write_owner,
    error::{Error, Result},
    folders::connection_version,
    mail, providers,
    service::{App, connections},
    store::{Store, merge, string},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;

const BACKGROUND_BATCH: usize = 50;

fn batch(db: &Store, connection: &Value) -> Result<Vec<(i64, Value)>> {
    let owner = string(connection, "email");
    let settings = db.settings()?;
    let checkpoint = &settings["mailReconcile"][owner];
    let after = if checkpoint["connection"] == connection_version(connection) {
        checkpoint["after"].as_i64().unwrap_or(0)
    } else {
        0
    };
    let prefix = if connection["provider"] == "google" {
        "google:%"
    } else {
        "imap:%"
    };
    let mut query=db.conn.prepare("SELECT rowid,data FROM messages WHERE account=? AND rowid>? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE ? AND COALESCE(json_extract(data,'$.providerDeleted'),0)=0 AND (json_extract(data,'$.folder')!='drafts' OR json_extract(data,'$.providerDraft')=1) ORDER BY rowid LIMIT 50")?;
    query
        .query_map(params![owner, after, prefix], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (id, data) = row?;
            Ok((id, serde_json::from_str(&data)?))
        })
        .collect()
}
fn flag_epoch(checkpoint: &Value, folder: &str) -> Value {
    json!([
        checkpoint["capabilityEpoch"],
        checkpoint["folders"][folder]["flagEpoch"]
    ])
}
fn message_folder(message: &Value) -> &str {
    message["providerFolderId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("INBOX")
}
fn obsolete_uid_validity(message: &Value, folder_state: &Value) -> bool {
    let Some(live) = folder_state["validity"].as_u64().filter(|value| *value > 0) else {
        return false;
    };
    let remote = message["remoteId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| message["id"].as_str().unwrap_or(""));
    let mut parts = remote.split(':');
    parts.next() == Some("imap")
        && parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|validity| validity > 0 && validity != live)
}
fn bind_flag_epochs(messages: &mut [Value], checkpoint: &Value) {
    for message in messages {
        let epoch = flag_epoch(checkpoint, message_folder(message));
        let legacy = message["imapSyncEpoch"].is_null() && epoch == json!([null, null]);
        if !legacy && message["imapSyncEpoch"] != epoch {
            message["imapModseq"] = Value::Null;
        }
        message["imapSyncEpoch"] = epoch;
    }
}
async fn fetch(
    app: &App,
    connection: &Value,
    messages: &[Value],
    fetched: &mut HashMap<String, Value>,
    connector: Option<&native_tls::TlsConnector>,
) -> Result<Vec<Value>> {
    let result = if connection["provider"] == "google" {
        let mut cached = HashMap::new();
        let mut ids = Vec::new();
        for message in messages {
            let remote = message["remoteId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(string(message, "id"));
            let id = remote
                .strip_prefix("google:")
                .filter(|s| !s.is_empty())
                .ok_or_else(providers::remote_error)?;
            if mail::reusable_google_body(message) {
                let mut value = message.clone();
                value["id"] = format!("google:{id}").into();
                cached.insert(id.to_owned(), value);
            }
            ids.push(json!({"id":id}));
        }
        providers::google_fetch_page(
            &app.0.client,
            connection,
            &json!({"messages":ids}),
            &cached,
            fetched,
        )
        .await
        .map(|page| {
            let found = page["messages"].as_array().unwrap().clone();
            messages
                .iter()
                .map(|old| {
                    let remote = old["remoteId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(string(old, "id"));
                    found
                        .iter()
                        .find(|m| m["id"] == remote)
                        .cloned()
                        .unwrap_or_else(|| {
                            merge(
                                old.clone(),
                                &json!({"providerDeleted":true,"providerFolderMissing":true}),
                            )
                        })
                })
                .collect::<Vec<_>>()
        })
    } else if messages.is_empty() {
        Ok(vec![])
    } else if let Some(connector) = connector {
        crate::imap::reconcile_priority_with_tls(connection, messages, connector).await
    } else {
        crate::imap::reconcile_priority(connection, messages).await
    };
    mail::finish_read(app, connection, result).await
}
fn save(db: &Store, connection: &Value, result: &[Value], proposed: Option<&Value>) -> Result<()> {
    let owner = string(connection, "email");
    let config = db.settings()?;
    if connections(&config).get(owner) != Some(connection) {
        return Err(Error::conflict(
            "This mailbox changed during reconciliation.",
        ));
    }
    if ["", "imap"].contains(&string(connection, "provider")) {
        let current_checkpoint = &config["mailReconcile"][owner];
        let checkpoint = proposed.unwrap_or(current_checkpoint);
        for message in result {
            let current = db.get(owner, string(message, "id"))?.ok_or_else(|| {
                Error::conflict("This cached message changed during reconciliation.")
            })?;
            let remote = |m: &Value| {
                m["remoteId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(string(m, "id"))
                    .to_owned()
            };
            let folder = |m: &Value| {
                m["providerFolderId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("INBOX")
                    .to_owned()
            };
            if remote(&current) != remote(message)
                || folder(&current) != folder(message)
                || current["providerSnapshot"] != message["providerSnapshot"]
                || message["imapSyncEpoch"] != flag_epoch(checkpoint, message_folder(message))
            {
                return Err(Error::conflict(
                    "This message's provider state changed during reconciliation.",
                ));
            }
        }
    }
    let available: Vec<_> = result
        .iter()
        .filter(|m| m["providerDeleted"] != true && m["providerFolderMissing"] != true)
        .cloned()
        .collect();
    mail::import_messages(db, connection, &available)?;
    for message in result
        .iter()
        .filter(|m| m["providerDeleted"] == true || m["providerFolderMissing"] == true)
    {
        // Keep cached content and the user's local folder; never bind old UIDs to a new mailbox generation.
        db.update(owner, string(message, "id"), &json!({"providerDeleted":message["providerDeleted"]==true,"providerFolderMissing":true}))?;
    }
    Ok(())
}
pub(crate) async fn priority(
    app: &App,
    connection: &Value,
    fetched: &mut HashMap<String, Value>,
) -> Result<()> {
    let mut messages = crate::sync_priority::messages(app, connection).await?;
    if messages.is_empty() {
        return Ok(());
    }
    if ["", "imap"].contains(&string(connection, "provider")) {
        let config = app.settings().await?;
        let checkpoint = &config["mailReconcile"][string(connection, "email")];
        bind_flag_epochs(&mut messages, checkpoint);
    }
    let result = fetch(app, connection, &messages, fetched, None).await?;
    let connection = connection.clone();
    // Priority work never consumes or advances the background rotation's checkpoint.
    app.db(move |db| db.transaction(|db| save(db, &connection, &result, None)))
        .await
}
pub async fn sync(
    app: &App,
    connection: &Value,
    fetched: &mut HashMap<String, Value>,
) -> Result<()> {
    sync_inner(app, connection, fetched, None).await
}
pub async fn sync_with_tls(
    app: &App,
    connection: &Value,
    fetched: &mut HashMap<String, Value>,
    connector: &native_tls::TlsConnector,
) -> Result<()> {
    sync_inner(app, connection, fetched, Some(connector)).await
}

fn next_folder(db: &Store, connection: &Value, checkpoint: &Value) -> Result<Option<String>> {
    let owner = string(connection, "email");
    let previous = string(checkpoint, "folder");
    if checkpoint["folders"][previous]["pending"]
        .as_array()
        .is_some_and(|uids| !uids.is_empty())
        || checkpoint["folders"][previous]["scan"].is_object()
    {
        return Ok(Some(previous.to_owned()));
    }
    // Seek the membership index, rather than DISTINCT/grouping every cached row.
    let folder: Option<String> = db.conn.query_row(
        "SELECT folder_id FROM mail_provider_memberships WHERE account=? AND folder_id>? ORDER BY folder_id LIMIT 1",
        params![owner, previous], |row| row.get(0),
    ).optional()?;
    if folder.is_some() {
        return Ok(folder);
    }
    let first: Option<String> = db.conn.query_row(
        "SELECT folder_id FROM mail_provider_memberships WHERE account=? ORDER BY folder_id LIMIT 1",
        params![owner],
        |row| row.get(0),
    ).optional()?;
    if first.is_some() {
        return Ok(first);
    }
    inbox_for_rows_missing_folder_index(db, owner)
}

fn inbox_for_rows_missing_folder_index(db: &Store, owner: &str) -> Result<Option<String>> {
    let cached: bool = db.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'imap:%')",
        [owner], |row| row.get(0),
    )?;
    Ok(cached.then(|| "INBOX".to_owned()))
}

fn legacy_folder_checkpoint(
    db: &Store,
    connection: &Value,
    folder: &str,
    epoch: &Value,
) -> Result<Value> {
    let owner = string(connection, "email");
    let remote: Option<String> = db.conn.query_row(
        "SELECT COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'imap:%' AND COALESCE(json_extract(data,'$.providerDeleted'),0)=0 ORDER BY rowid LIMIT 1",
        params![owner, folder], |row| row.get(0),
    ).optional()?;
    let Some(validity) = remote
        .as_deref()
        .and_then(|remote| remote.split(':').nth(1))
        .and_then(|validity| validity.parse::<u32>().ok())
        .filter(|v| *v > 0)
    else {
        return Ok(Value::Null);
    };
    // One-time migration of existing per-message proofs, without hydrating the
    // mailbox. Any unproven row forces a conservative backfill from MODSEQ zero.
    // SQLite integers cannot exactly represent the upper half of u64 MODSEQs;
    // those values deliberately fall back rather than round up and skip changes.
    let version = connection_version(connection);
    let minimum: Option<i64> = db.conn.query_row(
        "SELECT MIN(CASE WHEN json_extract(data,'$.imapSyncConnection')=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE ? AND COALESCE(json_extract(data,'$.imapSyncEpoch'),'[null,null]')=? AND typeof(json_extract(data,'$.imapModseq'))='integer' AND json_extract(data,'$.imapModseq')>0 AND json_type(data,'$.providerSnapshot.read') IN ('true','false') AND json_type(data,'$.providerSnapshot.starred') IN ('true','false') THEN json_extract(data,'$.imapModseq') ELSE 0 END) FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'imap:%' AND COALESCE(json_extract(data,'$.providerDeleted'),0)=0",
        params![serde_json::to_string(&version)?,format!("imap:{validity}:%"),serde_json::to_string(epoch)?,owner,folder], |row| row.get(0),
    )?;
    Ok(if let Some(minimum) = minimum.filter(|v| *v > 0) {
        json!({"connection":version,"validity":validity,"modseq":minimum,"pending":[],"scan":null})
    } else {
        Value::Null
    })
}

fn release_rotation_slot(rows: &mut Vec<(i64, Value)>, consumed: &mut usize, covered: bool) {
    if !covered && rows.len() == BACKGROUND_BATCH {
        rows.pop();
        *consumed -= 1;
    }
}

fn changed_rows(
    db: &Store,
    connection: &Value,
    folder: &str,
    state: &mut Value,
    rotation_head: Option<i64>,
) -> Result<Vec<(i64, Value)>> {
    let validity = state["validity"].as_u64().unwrap();
    let pending = state["pending"].as_array().unwrap();
    let mut rows = Vec::new();
    let mut consumed = 0;
    let mut rotation_covered = rotation_head.is_none();
    let mut query = db.conn.prepare(
        "SELECT rowid,data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=? AND COALESCE(json_extract(data,'$.providerDeleted'),0)=0 ORDER BY rowid DESC LIMIT 1",
    )?;
    for uid in pending {
        if rows.len() == BACKGROUND_BATCH && rotation_covered {
            break;
        }
        let remote = format!("imap:{validity}:{}", uid.as_u64().unwrap());
        let row: Option<(i64, String)> = query
            .query_row(
                params![string(connection, "email"), remote, folder],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if rows.len() == BACKGROUND_BATCH {
            if row
                .as_ref()
                .is_some_and(|(id, _)| rotation_head == Some(*id))
            {
                rotation_covered = true;
                break;
            }
            continue;
        }
        consumed += 1;
        if let Some((id, value)) = row {
            if rotation_head == Some(id) {
                rotation_covered = true;
            }
            let mut message: Value = serde_json::from_str(&value)?;
            // Discovery has selected this UID independently of its old per-row
            // watermark. Read authoritative flags, including after a reset.
            message["imapModseq"] = Value::Null;
            rows.push((id, message));
        }
    }
    release_rotation_slot(&mut rows, &mut consumed, rotation_covered);
    state["pending"] = json!(&pending[consumed..]);
    if state["pending"].as_array().unwrap().is_empty()
        && state["scan"].is_object()
        && state["scan"]["after"] == state["scan"]["upper"]
    {
        // The scan's original EXAMINE boundary is safe only after every queued
        // cached UID was applied (or shown absent locally) in this transaction.
        state["modseq"] = state["scan"]["target"].clone();
        state["scan"] = Value::Null;
    }
    Ok(rows)
}

async fn sync_inner(
    app: &App,
    connection: &Value,
    fetched: &mut HashMap<String, Value>,
    connector: Option<&native_tls::TlsConnector>,
) -> Result<()> {
    let saved = connection.clone();
    let (rotation, expected, mut checkpoint, folder) = app
        .db(move |db| {
            let expected = db.settings()?["mailReconcile"][string(&saved, "email")].clone();
            let checkpoint = if expected["connection"] == connection_version(&saved) {
                expected.clone()
            } else {
                json!({"connection":connection_version(&saved),"after":0})
            };
            let folder = if ["", "imap"].contains(&string(&saved, "provider")) {
                next_folder(db, &saved, &checkpoint)?
            } else {
                None
            };
            let mut checkpoint = checkpoint;
            if let Some(folder) = &folder
                && !checkpoint["folders"][folder].is_object()
            {
                let initial =
                    legacy_folder_checkpoint(db, &saved, folder, &flag_epoch(&checkpoint, folder))?;
                if initial.is_object() {
                    if !checkpoint["folders"].is_object() {
                        checkpoint["folders"] = json!({});
                    }
                    checkpoint["folders"][folder] = initial;
                }
            }
            Ok((batch(db, &saved)?, expected, checkpoint, folder))
        })
        .await?;
    let mut rows = Vec::new();
    if let Some(folder) = folder {
        if checkpoint["folders"][&folder].is_object()
            && checkpoint["folders"][&folder]["capabilityEpoch"] != checkpoint["capabilityEpoch"]
        {
            checkpoint["folders"][&folder] = Value::Null;
        }
        let previous = &checkpoint["folders"][&folder];
        let discovery = if let Some(connector) = connector {
            crate::imap::discover_changes_with_tls(connection, &folder, previous, connector).await
        } else {
            crate::imap::discover_changes(connection, &folder, previous).await
        };
        let mut state = match mail::finish_read(app, connection, discovery).await {
            Ok(state) => Some(state),
            // Rolling reconciliation verifies whether a rejected folder is
            // truly missing before recording it; discovery never invents that proof.
            Err(error) if error.body["code"] == "provider_imap_mailbox_rejected" => None,
            Err(error) => return Err(error),
        };
        if let Some(mut state) = state.take() {
            if state["enabled"] == false && checkpoint["capabilityEnabled"] != false {
                checkpoint["capabilityEpoch"] = uuid::Uuid::new_v4().to_string().into();
            }
            checkpoint["capabilityEnabled"] = state["enabled"].clone();
            state["capabilityEpoch"] = checkpoint["capabilityEpoch"].clone();
            let saved = connection.clone();
            let path = folder.clone();
            let rotation_head = rotation.first().map(|row| row.0);
            (rows, state) = app
                .db(move |db| {
                    let rows = changed_rows(db, &saved, &path, &mut state, rotation_head)?;
                    Ok((rows, state))
                })
                .await?;
            if !checkpoint["folders"].is_object() {
                checkpoint["folders"] = json!({});
            }
            checkpoint["folders"][&folder] = state;
        } else if checkpoint["folders"].is_object() {
            checkpoint["folders"]
                .as_object_mut()
                .unwrap()
                .remove(&folder);
        }
        checkpoint["folder"] = folder.into();
    }
    let mut consumed = 0;
    for row in &rotation {
        if !rows.iter().any(|(id, _)| *id == row.0) {
            if rows.len() == BACKGROUND_BATCH {
                break;
            }
            rows.push(row.clone());
        }
        consumed += 1;
    }
    if consumed > 0 {
        checkpoint["after"] = if consumed == rotation.len() && rotation.len() < BACKGROUND_BATCH {
            json!(0)
        } else {
            json!(rotation[consumed - 1].0)
        };
    } else if rotation.is_empty() {
        checkpoint["after"] = json!(0);
    }
    let mut messages: Vec<_> = rows.iter().map(|(_, m)| m.clone()).collect();
    if ["", "imap"].contains(&string(connection, "provider")) {
        bind_flag_epochs(&mut messages, &checkpoint);
    }
    let mut result = fetch(app, connection, &messages, fetched, connector).await?;
    // Capabilities/generation can change between discovery and flag retrieval.
    // An authoritative basic read repairs flags but cannot certify MODSEQ progress.
    for message in &result {
        let folder = message["providerFolderId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("INBOX");
        let obsolete = obsolete_uid_validity(message, &checkpoint["folders"][folder]);
        if checkpoint["folders"][folder].is_object()
            && message["providerDeleted"] != true
            && !obsolete
            && (message["providerFolderMissing"] == true
                || !message["imapModseq"].as_u64().is_some_and(|v| v > 0)
                || message["imapSyncConnection"] != connection_version(connection))
        {
            if !checkpoint["folders"][folder]["modseq"].is_null() {
                checkpoint["folders"][folder]["flagEpoch"] =
                    uuid::Uuid::new_v4().to_string().into();
                if checkpoint["capabilityEnabled"] != false {
                    checkpoint["capabilityEpoch"] = uuid::Uuid::new_v4().to_string().into();
                    checkpoint["capabilityEnabled"] = false.into();
                }
            }
            checkpoint["folders"][folder]["modseq"] = Value::Null;
            checkpoint["folders"][folder]["scan"] = Value::Null;
            checkpoint["folders"][folder]["pending"] = json!([]);
        }
    }
    if ["", "imap"].contains(&string(connection, "provider")) {
        // Basic flags are authoritative but carry no reusable MODSEQ proof.
        // Bind them to the invalidated generation before the atomic save.
        for message in &mut result {
            message["imapSyncEpoch"] = flag_epoch(&checkpoint, message_folder(message));
        }
    }
    let connection = connection.clone();
    app.db(move |db| {
        db.transaction(|db| {
            let owner = string(&connection, "email");
            if db.settings()?["mailReconcile"][owner] != expected {
                return Err(Error::conflict(
                    "This reconciliation checkpoint changed during sync.",
                ));
            }
            save(db, &connection, &result, Some(&checkpoint))?;
            checkpoint["checkedAt"] = crate::store::now().into();
            write_owner(db, "mailReconcile", owner, checkpoint)
        })
    })
    .await
}
