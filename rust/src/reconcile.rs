//! Bounded metadata reconciliation for cached Gmail/IMAP mail outside recent pages.
use crate::{
    background::write_owner,
    error::{Error, Result},
    folders::connection_version,
    mail, providers,
    service::{App, connections},
    store::{Store, merge, string},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::HashMap;

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
pub async fn sync(
    app: &App,
    connection: &Value,
    fetched: &mut HashMap<String, Value>,
) -> Result<()> {
    let saved = connection.clone();
    let rows = app.db(move |db| batch(db, &saved)).await?;
    let messages: Vec<_> = rows.iter().map(|(_, m)| m.clone()).collect();
    let result = if connection["provider"] == "google" {
        let mut cached = HashMap::new();
        let mut ids = Vec::new();
        for message in &messages {
            let remote = message["remoteId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(string(message, "id"));
            let id = remote
                .strip_prefix("google:")
                .filter(|s| !s.is_empty())
                .ok_or_else(providers::remote_error)?;
            let mut value = message.clone();
            value["id"] = format!("google:{id}").into();
            cached.insert(id.to_owned(), value);
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
    } else {
        crate::imap::reconcile(connection, &messages).await
    };
    let result = mail::finish_read(app, connection, result).await?;
    let connection = connection.clone();
    app.db(move|db| db.transaction(|db| {
        let owner=string(&connection,"email");
        if connections(&db.settings()?).get(owner)!=Some(&connection) {return Err(Error::conflict("This mailbox changed during reconciliation."));}
        let available: Vec<_> = result.iter().filter(|m| m["providerDeleted"] != true && m["providerFolderMissing"] != true).cloned().collect();
        mail::import_messages(db,&connection,&available)?;
        for message in result.iter().filter(|m|m["providerDeleted"]==true || m["providerFolderMissing"]==true) {
            // Keep cached content and the user's local folder; never bind old UIDs to a new mailbox generation.
            db.update(owner,string(message,"id"),&json!({"providerDeleted":message["providerDeleted"]==true,"providerFolderMissing":true}))?;
        }
        let after=if rows.len()==50 { rows.last().unwrap().0 } else {0};
        write_owner(db,"mailReconcile",owner,json!({"connection":connection_version(&connection),"after":after,"checkedAt":crate::store::now()}))
    })).await
}
