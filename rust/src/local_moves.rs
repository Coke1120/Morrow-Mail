//! One server-authored local folder undo, invalidated by later location/connection changes.
use crate::{
    error::{Error, Result},
    service,
    store::{Store, merge, string},
};
use serde_json::{Value, json};

fn fingerprint(message: &Value) -> String {
    // Reading/star/pending/content edits are independent and must survive undo.
    crate::search_query::digest(&json!([
        message["id"],
        message["folder"],
        message["remoteId"],
        message["providerFolderId"],
        message["providerSnapshot"]["folder"],
        message["localOverrides"]["folder"],
        message["imapOrigin"],
        message["providerDeleted"],
        message["providerFolderMissing"]
    ]))
}

pub fn patch(db: &Store, owner: &str, message: &Value, body: &Value) -> Result<Value> {
    let connection = service::connections(&db.settings()?)[owner].clone();
    let version = crate::search_query::digest(&crate::folders::connection_version(&connection));
    if let Some(token) = body.get("undoLocalMove") {
        let undo = &message["localFolderUndo"];
        if body.as_object().is_none_or(|body| body.len() != 1)
            || !token.is_string()
            || string(undo, "token").is_empty()
            || undo["token"] != *token
            || undo["owner"] != owner
            || undo["connection"] != version
            || undo["expected"] != fingerprint(message)
            || undo["to"] != message["folder"]
            || !["inbox", "archive", "trash", "sent", "drafts", "spam"]
                .contains(&string(undo, "from"))
        {
            return Err(Error::conflict(
                "This local move can no longer be undone because the message or connection changed. Review its current local and provider locations.",
            ));
        }
        let mut overrides = message["localOverrides"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if undo["previousOverride"].is_null() {
            overrides.remove("folder");
        } else {
            overrides.insert("folder".into(), undo["previousOverride"].clone());
        }
        return Ok(
            json!({"folder":undo["from"],"localOverrides":overrides,"localFolderUndo":null}),
        );
    }
    let mut patch = service::message_patch(message, body)?;
    if patch.get("folder").is_some() && patch["folder"] != message["folder"] {
        let changed = merge(message.clone(), &patch);
        patch["localFolderUndo"] = json!({"token":uuid::Uuid::new_v4().to_string(),"owner":owner,"connection":version,"from":message["folder"],"to":patch["folder"],"previousOverride":message["localOverrides"]["folder"],"expected":fingerprint(&changed)});
    }
    Ok(patch)
}
