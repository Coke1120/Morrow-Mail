//! Explicit, account-bound flag writes; uncertain writes require a fresh read, never replay.
use crate::{
    error::{Error, Result},
    mail, pages, providers,
    service::{App, Context, connections, get_message},
    store::{merge, string},
};
use reqwest::Method;
use serde_json::{Value, json};
fn identity(message: &Value) -> &str {
    message["remoteId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .unwrap_or(string(message, "id"))
}
pub async fn patch(app: &App, ctx: &Context) -> Result<Value> {
    let _gate = app.0.mailbox.try_lock().map_err(|_| {
        Error::conflict("Another mailbox operation is running. Try again when it finishes.")
    })?;
    let (owner, id, body) = (ctx.owner.clone(), ctx.path[1].clone(), ctx.body.clone());
    mail::ensure_draft_idle(app, &owner, &id)?;
    let (message, mut patch) = app
        .db(move |db| {
            let message = get_message(db, &owner, &id)?;
            crate::scheduled::guard_draft(db, &owner, &id, None)?;
            let patch = crate::service::message_patch(&message, &body)?;
            Ok((message, patch))
        })
        .await?;
    let connection = mail::current_mail(app, &ctx.owner).await?;
    if !providers::can_organize(&connection) {
        let mut error = Error::new(
            403,
            "Reconnect this account in Settings with mail organization permission to sync read and starred changes.",
        );
        error.body["recoveryAction"] = "reconnect".into();
        return Err(error);
    }
    if message["providerDeleted"] == true || message["providerFolderMissing"] == true {
        return Err(Error::conflict(
            "This message is unavailable on the server. The cached copy is retained.",
        ));
    }
    let confirmed = match string(&connection, "provider") {
        "google" => {
            let id = identity(&message)
                .strip_prefix("google:")
                .filter(|id| !id.is_empty())
                .ok_or_else(providers::remote_error)?;
            let mut add = Vec::new();
            let mut remove = Vec::new();
            for (key, label, invert) in [("read", "UNREAD", true), ("starred", "STARRED", false)] {
                if let Some(value) = patch[key].as_bool() {
                    if value != invert {
                        add.push(label);
                    } else {
                        remove.push(label);
                    }
                }
            }
            let result = providers::request(
                providers::api(
                    &app.0.client,
                    &connection,
                    Method::POST,
                    &format!("/messages/{}/modify", providers::component(id)),
                )?
                .json(&json!({"addLabelIds":add,"removeLabelIds":remove})),
                1024 * 1024,
            )
            .await
            .map_err(|_| uncertain())?;
            if result["id"] != id || !result["labelIds"].is_array() {
                return Err(uncertain());
            }
            let labels = result["labelIds"].as_array().unwrap();
            json!({"read":!labels.contains(&json!("UNREAD")),"starred":labels.contains(&json!("STARRED"))})
        }
        "microsoft" => {
            let id = identity(&message)
                .strip_prefix("microsoft:")
                .filter(|id| !id.is_empty())
                .ok_or_else(providers::remote_error)?;
            let mut changes = json!({});
            if let Some(read) = patch.get("read") {
                changes["isRead"] = read.clone();
            }
            if let Some(star) = patch.get("starred") {
                changes["flag"] = json!({"flagStatus":if star==true {"flagged"}else{"notFlagged"}});
            }
            let result = providers::request(
                providers::api(
                    &app.0.client,
                    &connection,
                    Method::PATCH,
                    &format!("/messages/{}", providers::component(id)),
                )?
                .header("Prefer", "IdType=\"ImmutableId\"")
                .json(&changes),
                8 * 1024 * 1024,
            )
            .await
            .map_err(|_| uncertain())?;
            if result["id"] != id {
                return Err(uncertain());
            }
            crate::outlook::flags(&result)?
        }
        "" | "imap" => crate::imap::write_flags(&connection, &message, &patch)
            .await
            .map_err(|_| uncertain())?,
        _ => return Err(Error::conflict("This mailbox connection changed.")),
    };
    for key in ["read", "starred"] {
        if patch.get(key).is_some_and(|v| *v != confirmed[key]) {
            return Err(uncertain());
        }
    }
    let mut overrides = message["localOverrides"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for key in ["read", "starred"] {
        if patch.get(key).is_some() || message[key] == confirmed[key] {
            overrides.remove(key);
            patch[key] = confirmed[key].clone();
        } else if overrides.get(key) != Some(&json!(true)) {
            patch[key] = confirmed[key].clone();
        }
    }
    if patch.get("folder").is_some() {
        overrides.insert("folder".into(), true.into());
    }
    patch["localOverrides"] = json!(overrides);
    patch["providerSnapshot"] = merge(merge(json!({}), &message["providerSnapshot"]), &confirmed);
    let (owner, id) = (ctx.owner.clone(), ctx.path[1].clone());
    app.db(move |db| {
        if connections(&db.settings()?).get(&owner) != Some(&connection) {
            return Err(Error::conflict(
                "This mailbox changed during the provider update.",
            ));
        }
        let current = get_message(db, &owner, &id)?;
        if identity(&current) != identity(&message)
            || current["providerFolderId"] != message["providerFolderId"]
        {
            return Err(Error::conflict(
                "This message moved during the provider update. Sync before trying again.",
            ));
        }
        Ok(json!({"message":pages::owned(&owner,db.update(&owner,&id,&patch)?.unwrap())}))
    })
    .await
}
fn uncertain() -> Error {
    Error::new(
        502,
        "The provider change could not be confirmed. Sync to check its current state before trying again.",
    )
}
