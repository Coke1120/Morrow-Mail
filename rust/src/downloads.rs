//! Observational, account-owned downloaded-content coverage. No provider work.
use crate::{
    background,
    error::{Error, Result},
    folders, imap, pages, search_query,
    service::{App, Context, connections},
    store::{Store, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::params;
use serde_json::{Value, json};

pub const PAGE_SIZE: u64 = 30;

/// Public comparison token, never the saved connection or its credentials.
/// Routine OAuth token refresh leaves this unchanged; reconnect changes it.
pub fn connection_ref(mail: &Value) -> String {
    search_query::digest(&json!([
        "download-connection-v1",
        folders::connection_version(mail)
    ]))
}

fn job_ref(config: &Value, owner: &str) -> Value {
    let id = string(&config["imports"][owner], "id");
    if id.is_empty() {
        Value::Null
    } else {
        json!(search_query::digest(&json!([
            "download-import-v1",
            owner,
            id
        ])))
    }
}

/// Downloads supplies these optional fences on existing explicit actions. Old
/// clients keep their existing routes; a present but empty/invalid fence fails.
/// Call under the mailbox gate before provider reads, or in the DB closure that
/// controls the import. Existing full-connection commit checks still apply.
pub(crate) fn require_context(
    config: &Value,
    owner: &str,
    input: &Value,
    import: bool,
) -> Result<()> {
    let Some(reference) = input.get("connectionRef") else {
        if input.get("jobRef").is_some() {
            return Err(Error::invalid(
                "A download connection reference is required.",
            ));
        }
        return Ok(());
    };
    let current = connections(config);
    if reference.as_str().is_none_or(str::is_empty)
        || current
            .get(owner)
            .is_none_or(|mail| reference != &connection_ref(mail))
    {
        return Err(Error::conflict(
            "This mailbox connection changed. Refresh Downloads before trying again.",
        ));
    }
    if import
        && (input["jobRef"].as_str().is_none_or(str::is_empty)
            || input["jobRef"] != job_ref(config, owner))
    {
        return Err(Error::conflict(
            "This history import changed. Refresh Downloads before trying again.",
        ));
    }
    Ok(())
}
// Match the persisted content markers and pre-marker IMAP placeholder. A cached
// header/preview is not proof that the body is available offline.
const INCOMPLETE: &str = "(COALESCE(json_extract(m.data,'$.contentIncomplete'),0)=1 OR COALESCE(json_type(m.data,'$.body'),'')!='text' OR json_extract(m.data,'$.body')='This message exceeds the 5 MB import limit. Open it in your original mailbox to read it.')";
const TRUNCATED: &str = "COALESCE(json_extract(m.data,'$.bodyTruncated'),0)=1";
const REMOTE: &str = "(COALESCE(NULLIF(json_extract(m.data,'$.remoteId'),''),m.id) LIKE 'google:%' OR COALESCE(NULLIF(json_extract(m.data,'$.remoteId'),''),m.id) LIKE 'microsoft:%' OR COALESCE(NULLIF(json_extract(m.data,'$.remoteId'),''),m.id) LIKE 'imap:%')";

pub fn initialize(db: &Store) -> Result<()> {
    let predicate = format!("{INCOMPLETE} OR {TRUNCATED}").replace("m.data", "data");
    db.conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS mail_download_incomplete ON messages(account,COALESCE(json_extract(data,'$.date'),'') DESC,id) WHERE {predicate}"))?;
    Ok(())
}

fn coverage_content_query() -> String {
    format!(
        "SELECT COALESCE(sum({INCOMPLETE}),0),COALESCE(sum(NOT {INCOMPLETE} AND {TRUNCATED}),0) FROM messages m INDEXED BY mail_download_incomplete WHERE m.account=? AND ({INCOMPLETE} OR {TRUNCATED})"
    )
}

fn incomplete_queries() -> (String, String) {
    let clause = format!("m.account=? AND {REMOTE} AND ({INCOMPLETE} OR {TRUNCATED})");
    // Other account-prefix indexes can otherwise win even though they scan all
    // of the owner's complete messages. Keep these reads on the partial index.
    (
        format!(
            "SELECT count(*) FROM messages m INDEXED BY mail_download_incomplete WHERE {clause}"
        ),
        format!(
            "SELECT m.data FROM messages m INDEXED BY mail_download_incomplete WHERE {clause} ORDER BY COALESCE(json_extract(m.data,'$.date'),'') DESC,m.id LIMIT ? OFFSET ?"
        ),
    )
}

pub fn coverage(db: &Store, owner: &str) -> Result<Value> {
    let mut result = db.conn.query_row("SELECT count(*),min(NULLIF(d.date,'')),max(NULLIF(d.date,'')) FROM search_documents d JOIN messages m ON m.account=d.account AND m.id=d.id WHERE d.account=?", [owner], |row| {
        Ok(json!({"account":owner,"count":row.get::<_,i64>(0)?,"oldest":row.get::<_,Option<String>>(1)?,"newest":row.get::<_,Option<String>>(2)?}))
    })?;
    let cached: i64 = db.conn.query_row(
        "SELECT count(*) FROM messages WHERE account=?",
        [owner],
        |row| row.get(0),
    )?;
    let (incomplete, truncated): (i64, i64) =
        db.conn
            .query_row(&coverage_content_query(), [owner], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
    result["cachedCount"] = cached.into();
    result["incompleteCount"] = incomplete.into();
    result["truncatedCount"] = truncated.into();
    result["indexPendingCount"] = (cached - result["count"].as_i64().unwrap_or(0)).into();
    Ok(result)
}

pub fn snapshot(db: &Store, owner: &str) -> Result<Value> {
    let config = db.settings()?;
    if connections(&config).get(owner).is_none() {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    let mut result = coverage(db, owner)?;
    let message_bytes: i64 = db.conn.query_row(
        "SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM messages WHERE account=?",
        [owner],
        |row| row.get(0),
    )?;
    let (count, bytes): (i64, i64) = db.conn.query_row(
        "SELECT count(*),COALESCE(sum(length(bytes)),0) FROM mail_attachments WHERE account=?",
        [owner],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    result["messageBytes"] = message_bytes.into();
    result["attachmentCount"] = count.into();
    result["attachmentBytes"] = bytes.into();
    result["accountId"] = owner.into();
    result["connectionRef"] = connection_ref(&connections(&config)[owner]).into();
    result["checkedAt"] = now().into();
    result["import"] = background::import_status_from(&config, owner);
    result["jobRef"] = job_ref(&config, owner);
    result["syncIntervalMinutes"] = config["preferences"]["syncInterval"]
        .as_u64()
        .unwrap_or(0)
        .into();
    result["storageDescription"] = "Message bytes are the stored UTF-8 message records, including bodies and metadata. Attachment bytes are all separately stored attachment data for this mailbox, including drafts and unreferenced copies. Search indexes, settings, SQLite overhead/free pages and backups are excluded; these are not disk usage or reclaimable-space estimates.".into();
    result["coverageDescription"] = "Downloaded records only, across all local folders. Date endpoints do not prove continuous or complete provider coverage. Incomplete or truncated content can be absent from search results. Attachments are not searched.".into();
    Ok(result)
}

pub fn incomplete(db: &Store, owner: &str, requested: u64) -> Result<Value> {
    let config = db.settings()?;
    let connected = connections(&config);
    let connection = connected
        .get(owner)
        .ok_or_else(|| Error::conflict("Choose a connected mailbox."))?;
    let provider = match string(connection, "provider") {
        "" => "imap",
        provider => provider,
    };
    let current_origin = if provider == "imap" {
        imap::server_origin(connection).ok()
    } else {
        None
    };
    let (count_sql, page_sql) = incomplete_queries();
    let total = db
        .conn
        .query_row(&count_sql, [owner], |row| row.get::<_, i64>(0))? as u64;
    let page = requested.min(total.saturating_sub(1) / PAGE_SIZE);
    let mut statement = db.conn.prepare(&page_sql)?;
    // SQLite COUNT is nonnegative i64; clamping bounds the offset below that count.
    let rows = statement.query_map(
        params![owner, PAGE_SIZE as i64, (page * PAGE_SIZE) as i64],
        |row| row.get::<_, String>(0),
    )?;
    let mut items = Vec::new();
    for row in rows {
        let source: Value = serde_json::from_str(&row?)?;
        let mut item = pages::owned(owner, pages::summary(&source));
        let remote = source["remoteId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| string(&source, "id"));
        let matching_provider = ["google", "microsoft", "imap"].contains(&provider)
            && remote.starts_with(&format!("{provider}:"));
        let unverified_imap = remote.starts_with("imap:")
            && (provider != "imap"
                || current_origin
                    .as_deref()
                    .is_none_or(|origin| source["imapOrigin"].as_str() != Some(origin)));
        let unavailable =
            source["providerDeleted"] == true || source["providerFolderMissing"] == true;
        let already_limited = source["attachmentsLoaded"] == true
            && source["providerDraft"] != true
            && crate::mail::cached_body_available(&source);
        item["canRepair"] =
            (matching_provider && !unverified_imap && !unavailable && !already_limited).into();
        item["recoveryAction"] = if unverified_imap {
            json!("sync_or_reconnect_original")
        } else if !matching_provider || unavailable || already_limited {
            json!("check_original_mailbox")
        } else {
            json!("download_content")
        };
        item["errorCode"] = if unverified_imap {
            json!("imap_origin_unverified")
        } else {
            Value::Null
        };
        item["reason"] = if unverified_imap { "This cached message's original IMAP server could not be verified. Reconnect the original server, or sync/import the current server and use its new copy." }
            else if !matching_provider { "This cached message belongs to another provider connection. Reconnect its original mailbox to download more content; the cached copy is retained." }
            else if unavailable { "The provider message or folder is unavailable. Check the original mailbox; the cached copy is retained." }
            else if already_limited { "A full-content download is already saved, but body-size limits still shorten this message. Read the full body in the original mailbox." }
            else if source["bodyTruncated"] == true && source["contentIncomplete"] != true { "Only part of this body is downloaded. A full-content download may still be limited by message size." }
            else { "Full message content is not available offline. Download it explicitly to retry; provider and message-size limits still apply." }.into();
        items.push(item);
    }
    Ok(
        json!({"accountId":owner,"connectionRef":connection_ref(connection),"page":page,"pageSize":PAGE_SIZE,"total":total,"hasNext":(page+1)*PAGE_SIZE<total,"items":items}),
    )
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if ctx.method != "GET"
        || !(ctx.path == ["downloads"] || ctx.path == ["downloads", "incomplete"])
    {
        return Ok(None);
    }
    let page = match ctx.query.get("page") {
        None => 0,
        Some(value) => value
            .as_str()
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| Error::invalid("Page must be a non-negative integer."))?,
    };
    let context = ctx.clone();
    let result = app
        .db(move |db| {
            let config = db.settings()?;
            let owner = context.read_owner(&config, false)?;
            if connections(&config).get(&owner).is_none() {
                return Err(Error::conflict("Choose a connected mailbox."));
            }
            if context.path.len() == 1 {
                snapshot(db, &owner)
            } else {
                incomplete(db, &owner, page)
            }
        })
        .await?;
    Ok(Some(Json(result).into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_content_queries_use_the_partial_account_index() {
        let root =
            std::env::temp_dir().join(format!("morrow-download-index-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&root).unwrap();
        let owner = rusqlite::types::Value::Text("fixture@example.invalid".into());
        let (count_sql, page_sql) = incomplete_queries();
        for (sql, bindings) in [
            (coverage_content_query(), vec![owner.clone()]),
            (count_sql, vec![owner.clone()]),
            (
                page_sql,
                vec![owner, (PAGE_SIZE as i64).into(), 0_i64.into()],
            ),
        ] {
            let mut statement = db
                .conn
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let details = statement
                .query_map(rusqlite::params_from_iter(bindings), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
                .join(" ");
            assert!(details.contains("mail_download_incomplete"), "{details}");
            assert!(!details.contains("TEMP B-TREE"), "{details}");
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
