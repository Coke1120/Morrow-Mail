//! Short-lived, account-bound hints for the native client's current mail page.
use crate::{
    error::{Error, Result},
    folders::connection_version,
    service::{App, Context, connections},
    store::string,
    validation,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

pub const LIMIT: usize = 51; // A 50-row page plus its retained selected reader.
const LIFETIME: Duration = Duration::from_secs(90);

#[derive(Default)]
pub(crate) struct View {
    generation: u64,
    received: Option<Instant>,
    entries: Vec<(String, String, Value)>,
}

fn eligible(message: &Value, connection: &Value) -> bool {
    let remote = message["remoteId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .unwrap_or(string(message, "id"));
    let prefix = match string(connection, "provider") {
        "google" => "google:",
        "microsoft" => "microsoft:",
        "" | "imap" => "imap:",
        _ => return false,
    };
    remote.starts_with(prefix)
        && (prefix != "imap:" || crate::imap_identity::matches(connection, message))
        && message["providerDeleted"] != true
        && (message["folder"] != "drafts" || message["providerDraft"] == true)
}

pub(crate) async fn publish(app: &App, context: &Context) -> Result<Value> {
    let generation = context.body["generation"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| Error::invalid("Invalid mail view generation."))?;
    let messages = context.body["messages"]
        .as_array()
        .filter(|rows| rows.len() <= LIMIT)
        .ok_or_else(|| Error::invalid("The mail view exceeds its message limit."))?
        .clone();
    let context = context.clone();
    let entries = app
        .db(move |db| {
            let config = db.settings()?;
            let scope = context.read_owner(&config, true)?;
            let live = connections(&config);
            let mut entries = Vec::new();
            let mut seen = HashSet::new();
            for message in messages {
                let owner = validation::text(&message["accountId"], "Mailbox", 320, false)?;
                let id = validation::text(&message["id"], "Message ID", 8192, false)?;
                if scope != "all" && owner != scope {
                    return Err(Error::conflict("The mail view contains another mailbox."));
                }
                let connection = live
                    .get(owner)
                    .ok_or_else(|| Error::conflict("This mailbox was disconnected."))?;
                if seen.insert((owner.to_owned(), id.to_owned()))
                    && let Some(cached) = db.get(owner, id)?
                    && eligible(&cached, connection)
                {
                    entries.push((
                        owner.to_owned(),
                        id.to_owned(),
                        connection_version(connection),
                    ));
                }
            }
            Ok(entries)
        })
        .await?;
    let mut view = app
        .0
        .sync_priority
        .lock()
        .map_err(|_| Error::new(503, "Restart the workspace."))?;
    // Keep the watermark even after expiry so a delayed request cannot revive an old view.
    let accepted = generation > view.generation;
    if accepted {
        *view = View {
            generation,
            received: Some(Instant::now()),
            entries,
        };
    }
    Ok(json!({"accepted":accepted}))
}

pub(crate) async fn messages(app: &App, connection: &Value) -> Result<Vec<Value>> {
    let owner = string(connection, "email").to_owned();
    let version = connection_version(connection);
    let ids = {
        let view = app
            .0
            .sync_priority
            .lock()
            .map_err(|_| Error::new(503, "Restart the workspace."))?;
        if !view
            .received
            .is_some_and(|received| received.elapsed() < LIFETIME)
        {
            return Ok(vec![]);
        }
        view.entries
            .iter()
            .filter(|(account, _, saved)| account == &owner && saved == &version)
            .map(|(_, id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    let connection = connection.clone();
    app.db(move |db| {
        if connections(&db.settings()?).get(&owner) != Some(&connection) {
            return Err(Error::conflict("This mailbox changed during sync."));
        }
        let mut messages = Vec::new();
        for id in ids {
            if let Some(message) = db.get(&owner, &id)?
                && eligible(&message, &connection)
            {
                messages.push(message);
            }
        }
        Ok(messages)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, Method};

    fn context(generation: u64, entries: Value) -> Context {
        let mut headers = HeaderMap::new();
        headers.insert("x-genmail-account", "view@example.invalid".parse().unwrap());
        Context {
            method: Method::POST,
            path: vec!["sync".into(), "priority".into()],
            body: json!({"generation":generation,"messages":entries}),
            query: json!({}),
            headers,
            owner: "view@example.invalid".into(),
            paged: true,
        }
    }

    #[tokio::test]
    async fn hints_expire_without_reviving_stale_generations_and_reject_changed_connections() {
        let root = std::env::temp_dir().join(format!("morrow-sync-view-{}", uuid::Uuid::new_v4()));
        let app = App::open(&root, 0, "fictional".into(), "".into()).unwrap();
        let mail = json!({"email":"view@example.invalid","provider":"imap","imapHost":"fixture.example.invalid","connectionId":"one"});
        let origin = crate::imap::server_origin(&mail).unwrap();
        let saved = mail.clone();
        app.db(move |db| {
            db.set_settings(&json!({"mailAccounts":{"view@example.invalid":saved}}))?;
            db.upsert(
                "view@example.invalid",
                &json!({"id":"imap:55:7","imapOrigin":origin,"folder":"inbox","body":"Fictional"}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let entry = json!({"accountId":"view@example.invalid","id":"imap:55:7"});
        assert_eq!(
            publish(&app, &context(5, json!([entry, entry])))
                .await
                .unwrap(),
            json!({"accepted":true})
        );
        assert_eq!(messages(&app, &mail).await.unwrap().len(), 1);
        app.0.sync_priority.lock().unwrap().received =
            Some(Instant::now() - LIFETIME - Duration::from_secs(1));
        assert!(messages(&app, &mail).await.unwrap().is_empty());
        assert_eq!(
            publish(&app, &context(5, json!([entry]))).await.unwrap(),
            json!({"accepted":false})
        );
        assert!(messages(&app, &mail).await.unwrap().is_empty());
        assert_eq!(
            publish(&app, &context(6, json!([entry]))).await.unwrap(),
            json!({"accepted":true})
        );
        let mut changed = mail.clone();
        changed["connectionId"] = "two".into();
        let saved = changed.clone();
        app.db(move |db| {
            db.set_settings(&json!({"mailAccounts":{"view@example.invalid":saved}}))?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(messages(&app, &changed).await.unwrap().is_empty());
        assert_eq!(messages(&app, &mail).await.unwrap_err().status, 409);
        assert_eq!(
            publish(&app, &context(7, json!(vec![entry.clone(); LIMIT + 1])))
                .await
                .unwrap_err()
                .status,
            400
        );
        let mut missing_owner = context(7, json!([entry]));
        missing_owner.headers.clear();
        assert_eq!(publish(&app, &missing_owner).await.unwrap_err().status, 409);
        assert_eq!(app.0.sync_priority.lock().unwrap().generation, 6);
        publish(&app, &context(7, json!([entry]))).await.unwrap();
        assert_eq!(messages(&app, &changed).await.unwrap().len(), 1);
        app.db(|db| {
            db.update(
                "view@example.invalid",
                "imap:55:7",
                &json!({"providerDeleted":true}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(messages(&app, &changed).await.unwrap().is_empty());
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
}
