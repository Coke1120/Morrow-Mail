//! A UID belongs to one IMAP endpoint/login, independently of reconnect credentials.
use crate::{
    error::{Error, Result},
    store::Store,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(crate) const UNBOUND: &str = "unbound";

pub(crate) fn saved_origin(version: &Value) -> Option<String> {
    let parts = version.as_array().filter(|parts| parts.len() == 7)?;
    if !parts[2].is_null()
        && !parts[2]
            .as_str()
            .is_some_and(|provider| ["", "imap"].contains(&provider))
    {
        return None;
    }
    let mut mail = json!({"email":parts[3],"imapHost":parts[5]});
    if !parts[6].is_null() {
        mail["imapPort"] = parts[6].clone();
    }
    crate::imap::server_origin(&mail).ok()
}

/// An explicit marker wins; unbound rows can never be adopted by a later login.
/// Older rows need their own saved transport evidence, not today's settings.
pub(crate) fn message_origin(message: &Value) -> Option<String> {
    if let Some(origin) = message.get("imapOrigin") {
        return origin
            .as_str()
            .filter(|origin| *origin != UNBOUND)
            .map(str::to_owned);
    }
    let body = saved_origin(&message["bodyConnection"]);
    let flags = saved_origin(&message["imapSyncConnection"]);
    if !message["bodyConnection"].is_null() && body.is_none()
        || !message["imapSyncConnection"].is_null() && flags.is_none()
    {
        return None;
    }
    match (body, flags) {
        (Some(body), Some(flags)) if body != flags => None,
        (Some(origin), _) | (_, Some(origin)) => Some(origin),
        _ => None,
    }
}
pub(crate) fn matches(mail: &Value, message: &Value) -> bool {
    crate::imap::server_origin(mail)
        .ok()
        .is_some_and(|origin| message_origin(message).as_deref() == Some(origin.as_str()))
}
pub(crate) fn require(mail: &Value, message: &Value) -> Result<()> {
    if matches(mail, message) {
        Ok(())
    } else {
        let mut error = Error::conflict(
            "This cached message belongs to another or unverified IMAP server. Its downloaded content is retained. Reconnect its original server, or sync/import this server and use the new copy.",
        );
        error.body["code"] = "imap_origin_unverified".into();
        error.body["recoveryAction"] = "sync_or_reconnect_original".into();
        Err(error)
    }
}

/// Keep existing local IDs/references; namespace only a newly colliding identity.
pub(crate) fn available_id(db: &Store, owner: &str, id: &str, origin: &str) -> Result<String> {
    if db.get(owner, id)?.is_none() {
        return Ok(id.to_owned());
    }
    let id = format!("imap-origin:{origin}:{}", URL_SAFE_NO_PAD.encode(id));
    if db.get(owner, &id)?.is_some() {
        return Err(Error::conflict(
            "The cached IMAP identity conflicts with this import. Cached mail is retained; restart the import after checking this account.",
        ));
    }
    Ok(id)
}

/// One transaction, bounded metadata batches, no renames or content hydration.
/// The partial index makes subsequent opens inspect only newly introduced legacy rows.
pub(crate) fn migrate(db: &Store) -> Result<()> {
    db.transaction(|db| {
        db.conn.execute_batch("CREATE INDEX IF NOT EXISTS mail_imap_origin ON messages(account,json_extract(data,'$.imapOrigin'),COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id),COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX'));
            CREATE INDEX IF NOT EXISTS mail_imap_unbound ON messages(account) WHERE json_extract(data,'$.imapOrigin') IS NULL AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'imap:%';")?;
        loop {
            let rows: Vec<(i64, String)> = db.conn.prepare(
                "SELECT rowid,json_object('bodyConnection',json_extract(data,'$.bodyConnection'),'imapSyncConnection',json_extract(data,'$.imapSyncConnection')) FROM messages INDEXED BY mail_imap_unbound WHERE json_extract(data,'$.imapOrigin') IS NULL AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id) LIKE 'imap:%' LIMIT 100",
            )?.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
            if rows.is_empty() { break; }
            for (rowid, metadata) in rows {
                let origin = message_origin(&serde_json::from_str::<Value>(&metadata)?)
                    .unwrap_or_else(|| UNBOUND.to_owned());
                db.conn.execute("UPDATE messages SET data=json_set(data,'$.imapOrigin',?) WHERE rowid=?", params![origin,rowid])?;
            }
        }
        Ok(())
    })
}

pub(crate) fn existing(
    db: &Store,
    owner: &str,
    remote: &str,
    folder: &str,
    origin: &str,
) -> Result<Option<Value>> {
    let raw: Option<String> = db.conn.query_row(
        "SELECT data FROM messages WHERE account=? AND json_extract(data,'$.imapOrigin')=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=? ORDER BY rowid DESC LIMIT 1",
        params![owner,origin,remote,folder], |row| row.get(0),
    ).optional()?;
    if let Some(raw) = raw {
        return Ok(Some(serde_json::from_str(&raw)?));
    }
    // A library caller may have inserted a pre-marker fixture after Store::open.
    // Only the row's own evidence can preserve its legacy identity.
    let mut query = db.conn.prepare("SELECT data FROM messages WHERE account=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=? AND json_extract(data,'$.imapOrigin') IS NULL ORDER BY rowid DESC")?;
    for raw in query.query_map(params![owner, remote, folder], |row| {
        row.get::<_, String>(0)
    })? {
        let message: Value = serde_json::from_str(&raw?)?;
        if message_origin(&message).as_deref() == Some(origin) {
            return Ok(Some(message));
        }
    }
    Ok(None)
}
