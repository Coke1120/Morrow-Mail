//! Immutable, account-owned attachment bytes; message JSON contains metadata only.
use crate::{
    error::{Error, Result},
    service::{App, Context, connections, get_message},
    store::{Store, string},
    validation,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use mail_parser::{MessageParser, MimeHeaders};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_RAW_BYTES: usize = 80 * 1024 * 1024;
pub const MAX_COUNT: usize = 100;

fn filename(name: &str) -> String {
    let mut safe: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).take(180).collect();
    safe.truncate(safe.floor_char_boundary(180));
    let safe = safe.trim_matches([' ', '.']);
    let stem = safe
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if safe.is_empty() {
        "attachment.bin".into()
    } else if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        format!("_{safe}")
    } else {
        safe.into()
    }
}

pub fn save(
    db: &Store,
    owner: &str,
    name: &str,
    mime: &str,
    cid: &str,
    bytes: &[u8],
) -> Result<Value> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::invalid("An attachment exceeds the 50 MiB limit."));
    }
    let name = filename(name);
    let mime = if mime.len() <= 100
        && mime.contains('/')
        && mime
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/!#$&^_.+-".contains(&b))
    {
        mime.to_ascii_lowercase()
    } else {
        "application/octet-stream".into()
    };
    let cid: String = cid
        .trim_matches(['<', '>'])
        .chars()
        .filter(|c| !c.is_control())
        .take(512)
        .collect();
    let hash = format!("{:x}", Sha256::digest(bytes));
    let id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([name, mime, cid, hash]))?)
    );
    let metadata = json!({"id":id,"name":name,"contentType":mime,"contentId":cid,"size":bytes.len(),"sha256":hash});
    db.conn.execute(
        "INSERT OR IGNORE INTO mail_attachments(account,id,metadata,bytes) VALUES(?,?,?,?)",
        params![owner, id, metadata.to_string(), bytes],
    )?;
    Ok(metadata)
}

pub fn references(input: &Value) -> Result<Value> {
    let empty = vec![];
    let values = match input.get("attachments") {
        None => &empty,
        Some(value) => value
            .as_array()
            .ok_or_else(|| Error::invalid("Invalid attachments."))?,
    };
    if values.len() > MAX_COUNT {
        return Err(Error::invalid("Use at most 100 attachments."));
    }
    let mut ids = std::collections::HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let id = string(value, "id");
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) || !ids.insert(id) {
            return Err(Error::invalid("Invalid or repeated attachment identity."));
        }
        result.push(json!({"id":id}));
    }
    Ok(json!(result))
}

pub fn resolve(db: &Store, owner: &str, input: &mut Value, bytes: bool) -> Result<()> {
    let refs = references(input)?;
    if refs.as_array().unwrap().is_empty() {
        input.as_object_mut().unwrap().remove("attachments");
        return Ok(());
    }
    let mut attachments = Vec::new();
    let mut total = 0u64;
    for item in refs.as_array().unwrap() {
        let id = string(item, "id");
        let raw: Option<String> = db
            .conn
            .query_row(
                "SELECT metadata FROM mail_attachments WHERE account=? AND id=?",
                params![owner, id],
                |r| r.get(0),
            )
            .optional()?;
        let mut value: Value = serde_json::from_str(&raw.ok_or_else(|| Error::conflict("An attachment is unavailable in this mailbox. Add it again before saving or sending."))?)?;
        total = total
            .checked_add(
                value["size"]
                    .as_u64()
                    .ok_or_else(|| Error::conflict("Invalid attachment metadata."))?,
            )
            .ok_or_else(|| Error::invalid("Attachments exceed the size limit."))?;
        if total > MAX_BYTES as u64 {
            return Err(Error::invalid("Attachments together exceed 50 MiB."));
        }
        if bytes {
            let data: Vec<u8> = db.conn.query_row(
                "SELECT bytes FROM mail_attachments WHERE account=? AND id=?",
                params![owner, id],
                |r| r.get(0),
            )?;
            if data.len() as u64 != value["size"].as_u64().unwrap()
                || format!("{:x}", Sha256::digest(&data)) != string(&value, "sha256")
            {
                return Err(Error::conflict(
                    "Attachment integrity check failed. Restore a verified backup.",
                ));
            }
            value["data"] = STANDARD.encode(data).into();
        }
        attachments.push(value);
    }
    input["attachments"] = json!(attachments);
    Ok(())
}

pub fn import(db: &Store, owner: &str, raw: &[u8]) -> Result<Value> {
    if raw.len() > MAX_RAW_BYTES {
        return Err(Error::invalid(
            "This message exceeds the 80 MiB download limit.",
        ));
    }
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(crate::providers::remote_error)?;
    let mut result = Vec::new();
    let mut total = 0;
    for part in parsed.attachments() {
        total += part.len();
        if result.len() >= MAX_COUNT || total > MAX_BYTES {
            return Err(Error::invalid(
                "This message exceeds 100 attachments or 50 MiB of attachment data.",
            ));
        }
        let mime = part
            .content_type()
            .map(|t| {
                format!(
                    "{}/{}",
                    t.c_type,
                    t.c_subtype.as_deref().unwrap_or("octet-stream")
                )
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        let metadata = save(
            db,
            owner,
            part.attachment_name().unwrap_or("attachment.bin"),
            &mime,
            part.content_id().unwrap_or_default(),
            part.contents(),
        )?;
        if !result.contains(&metadata) {
            result.push(metadata);
        }
    }
    Ok(json!(result))
}

fn reader_copy(db: &Store, owner: &str, message: Value) -> Result<Value> {
    let mut hydrated = message.clone();
    resolve(db, owner, &mut hydrated, true)?;
    let mut result = message;
    let mut html = string(&result, "bodyHtml").to_owned();
    // ponytail: inline HTML stays below WebView2’s 2 MB NavigateToString limit; larger files remain downloadable.
    let mut budget = 0;
    for item in hydrated["attachments"].as_array().into_iter().flatten() {
        let cid = string(item, "contentId");
        let data = STANDARD
            .decode(string(item, "data"))
            .map_err(|_| Error::conflict("Invalid attachment data."))?;
        let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if data.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            "image/gif"
        } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            continue;
        };
        budget += data.len();
        if cid.is_empty() || budget > 1024 * 1024 {
            continue;
        }
        let needle = format!("src=\"cid:{}\"", crate::content::escape_html(cid));
        let count = html.matches(&needle).count();
        if count > 0
            && html
                .len()
                .saturating_add(count.saturating_mul(string(item, "data").len() + 64))
                <= 1536 * 1024
        {
            html = html.replace(
                &needle,
                &format!("src=\"data:{mime};base64,{}\"", string(item, "data")),
            );
            result["inlineImages"] = true.into();
        }
    }
    result["bodyHtml"] = html.into();
    Ok(result)
}

pub async fn download(app: &App, owner: &str, id: &str) -> Result<Value> {
    let (account, key) = (owner.to_owned(), id.to_owned());
    let message = app.db(move |db| get_message(db, &account, &key)).await?;
    if message["attachmentsLoaded"] == true
        && message["providerDraft"] != true
        && crate::mail::cached_body_available(&message)
        || message["folder"] == "drafts" && message["providerDraft"] != true
    {
        let account = owner.to_owned();
        return app.db(move |db| reader_copy(db, &account, message)).await;
    }
    let connection = crate::mail::current_mail(app, owner).await?;
    if let Some(error) = crate::mail::read_backoff(&app.settings().await?, &connection) {
        return Err(error);
    }
    let raw = if ["", "imap"].contains(&string(&connection, "provider")) {
        crate::imap::raw_message(&connection, &message).await
    } else {
        crate::providers::raw_message(&app.0.client, &connection, &message).await
    };
    let raw = crate::mail::finish_read(app, &connection, raw).await?;
    let (account, key) = (owner.to_owned(), id.to_owned());
    app.db(move |db| {
        db.transaction(|db| {
            if connections(&db.settings()?).get(&account) != Some(&connection) {
                return Err(Error::conflict(
                    "This mailbox changed during the attachment download.",
                ));
            }
            let current = get_message(db, &account, &key)?;
            for field in ["remoteId", "providerFolderId", "messageId"] {
                if current[field] != message[field] {
                    return Err(Error::conflict(
                        "This message moved or changed. Refresh before downloading attachments.",
                    ));
                }
            }
            let attachments = import(db, &account, &raw)?;
            let parsed=crate::providers::mime(&raw)?;
            let mut patch=json!({"attachments":attachments,"attachmentsLoaded":true,"hasAttachments":!attachments.as_array().unwrap().is_empty(),"contentIncomplete":false,"contentErrorCode":null});
            for key in ["body","bodyHtml","bodyTruncated","preview","replyTo"] {if let Some(value)=parsed.get(key){patch[key]=value.clone();}}
            for key in ["to","cc","bcc"] {if !current[key].is_string() && let Some(value)=parsed.get(key){patch[key]=value.clone();}}
            let updated = db.update(&account,&key,&patch)?
                .ok_or_else(|| Error::conflict("This message is unavailable."))?;
            reader_copy(db, &account, updated)
        })
    })
    .await
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path: Vec<_> = ctx.path.iter().map(String::as_str).collect();
    if !matches!(
        (ctx.method.as_str(), path.as_slice()),
        ("POST", ["attachments"])
            | ("GET", ["attachments", _])
            | ("POST", ["messages", _, "attachments"])
    ) {
        return Ok(None);
    }
    let owner = ctx.read_owner(&app.settings().await?, false)?;
    let result = match (ctx.method.as_str(), path.as_slice()) {
        ("POST", ["attachments"]) => {
            let data = validation::text(
                &ctx.body["data"],
                "Attachment",
                MAX_BYTES.div_ceil(3) * 4,
                true,
            )?;
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| Error::invalid("Invalid attachment encoding."))?;
            let name = validation::text(&ctx.body["name"], "Filename", 1024, false)?.to_owned();
            let mime = ctx.body["contentType"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .to_owned();
            app.db(move |db| {
                if !crate::service::valid_account(&db.settings()?, &owner) {
                    return Err(Error::conflict("This account was disconnected."));
                }
                Ok(json!({"attachment":save(db,&owner,&name,&mime,"",&bytes)?}))
            })
            .await?
        }
        ("GET", ["attachments", id]) => {
            let id = id.to_string();
            app.db(move |db| {
                if !crate::service::valid_account(&db.settings()?, &owner) {
                    return Err(Error::conflict("This account was disconnected."));
                }
                let mut value = json!({"attachments":[{"id":id}]});
                resolve(db, &owner, &mut value, true)?;
                Ok(json!({"attachment":value["attachments"][0]}))
            })
            .await?
        }
        (_, ["messages", id, "attachments"]) => {
            let _gate = app.0.mailbox.try_lock().map_err(|_| {
                Error::conflict("Another mailbox operation is running. Try again when it finishes.")
            })?;
            json!({"message":crate::pages::owned(&owner,download(app,&owner,id).await?)})
        }
        _ => unreachable!(),
    };
    Ok(Some(Json(result).into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cid_rasters_are_ephemeral_and_repeated_references_stay_bounded() {
        let root = std::env::temp_dir().join(format!("morrow-cid-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&root).unwrap();
        let png = save(
            &db,
            "owner",
            "photo.png",
            "image/png",
            "photo",
            b"\x89PNG\r\n\x1a\nfixture",
        )
        .unwrap();
        let svg = save(
            &db,
            "owner",
            "evil.svg",
            "image/svg+xml",
            "evil",
            b"<svg onload='bad()'/>",
        )
        .unwrap();
        let message = json!({"attachments":[png,svg],"bodyHtml":"<img src=\"cid:photo\"><img src=\"cid:evil\">"});
        let reader = reader_copy(&db, "owner", message.clone()).unwrap();
        assert_eq!(reader["inlineImages"], true);
        assert!(string(&reader, "bodyHtml").contains("data:image/png;base64,"));
        assert!(string(&reader, "bodyHtml").contains("cid:evil"));
        assert!(!reader.to_string().contains("onload"));
        assert!(!message.to_string().contains("data:"));
        assert!(reader["attachments"][0].get("data").is_none());
        let mut huge = vec![0; 1024 * 1024];
        huge[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let large = save(&db, "owner", "large.png", "image/png", "large", &huge).unwrap();
        let reader = reader_copy(
            &db,
            "owner",
            json!({"attachments":[large],"bodyHtml":"<img src=\"cid:large\">".repeat(1000)}),
        )
        .unwrap();
        assert!(string(&reader, "bodyHtml").len() <= 1536 * 1024);
        assert!(reader["inlineImages"].is_null());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
