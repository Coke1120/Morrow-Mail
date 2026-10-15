//! Explicit custom-folder new-mail downloads. Status reads never contact the provider.
use crate::{
    background::{project, write_owner},
    error::{Error, Result},
    folders::connection_version,
    imap, mail,
    service::{App, Context, connections},
    store::{Store, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const LIMIT: usize = 20;
const PAGES_PER_ROUND: usize = 4;
const GROUP: &str = "imapFolderSync";

fn supported(mail: &Value) -> bool {
    ["", "imap"].contains(&string(mail, "provider"))
}

fn connection_token(mail: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(connection_version(mail).to_string().as_bytes())
    )
}

fn reviewed_connection(mail: &Value, input: &Value) -> Result<()> {
    if input["connectionVersion"] != connection_token(mail) {
        return Err(Error::conflict(
            "This mailbox connection changed. Reload the folder selection and review again.",
        ));
    }
    Ok(())
}

fn catalog_fresh(config: &Value, owner: &str, mail: &Value) -> bool {
    catalog_window(config, owner, mail).is_some_and(|(from, until)| {
        let now = chrono::Utc::now().timestamp_millis();
        from <= now && now < until
    })
}

fn catalog_window(config: &Value, owner: &str, mail: &Value) -> Option<(i64, i64)> {
    let catalog = &config["mailFolderCatalogs"][owner];
    if catalog["connection"] != connection_version(mail) || !catalog["errorCode"].is_null() {
        return None;
    }
    let at = chrono::DateTime::parse_from_rfc3339(string(catalog, "updatedAt")).ok()?;
    let millis = at.timestamp_millis();
    // Round the start inward, so a future fractional millisecond never becomes
    // an already-current catalog when represented in the notification clock.
    let from = millis.checked_add(i64::from(at.timestamp_subsec_nanos() % 1_000_000 != 0))?;
    Some((from, millis.checked_add(15 * 60 * 1000)?))
}

fn selectable(catalog: &[Value], folder: &Value) -> bool {
    let path = string(folder, "id");
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && folder["selectable"] == true
        && folder["editable"] == true
        && ["archive", "folder"].contains(&string(folder, "kind"))
        && folder["hidden"] != true
        && !catalog.iter().any(|parent| {
            ["spam", "trash", "virtual"].contains(&string(parent, "kind"))
                && (parent["id"] == folder["id"]
                    || !string(parent, "delimiter").is_empty()
                        && path.starts_with(&format!(
                            "{}{}",
                            string(parent, "id"),
                            string(parent, "delimiter")
                        )))
        })
}

/// Private notification input. Progress/attempt clocks are deliberately absent
/// from the identity; gates can pause an existing identity without clearing a
/// notification worker's authentication/protocol failure policy.
pub(crate) struct NotificationSelection {
    pub id: String,
    pub version: String,
    pub path: String,
    pub validity: Option<u32>,
    pub available: bool,
    pub not_before: i64,
    pub expires_at: i64,
}

pub(crate) fn notification_selections(
    config: &Value,
    owner: &str,
    connection: &Value,
) -> Vec<NotificationSelection> {
    let state = &config[GROUP][owner];
    let version = string(state, "version");
    if version.is_empty()
        || !supported(connection)
        || !imap::server_origin(connection).is_ok_and(|origin| state["origin"] == origin)
    {
        return Vec::new();
    }
    let catalog = config["mailFolderCatalogs"][owner]["folders"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let window = catalog_window(config, owner, connection);
    let mut seen = HashSet::new();
    state["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .take(LIMIT)
        .filter_map(|entry| {
            let path = string(entry, "path");
            let id = string(entry, "id");
            if id.is_empty()
                || path.is_empty()
                || path.eq_ignore_ascii_case("INBOX")
                || path.len() > 4096
                || path.chars().any(char::is_control)
                || !seen.insert(path)
            {
                return None;
            }
            let checkpoint = &entry["checkpoint"];
            let validity = (checkpoint["path"] == path
                && checkpoint["uid"]
                    .as_u64()
                    .is_some_and(|uid| uid <= u32::MAX as u64))
            .then(|| {
                let raw = checkpoint["validity"].as_str()?;
                (!raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()))
                    .then(|| raw.parse::<u32>().ok().filter(|value| *value > 0))
                    .flatten()
            })
            .flatten();
            let retry = if entry["nextRetryAt"].is_null() {
                Some(0)
            } else {
                chrono::DateTime::parse_from_rfc3339(string(entry, "nextRetryAt"))
                    .ok()
                    .and_then(|at| {
                        at.timestamp_millis()
                            .checked_add(i64::from(at.timestamp_subsec_nanos() % 1_000_000 != 0))
                    })
            };
            let available = validity.is_some()
                && window.is_some()
                && retry.is_some()
                && entry["blocked"] != true
                && !["folder_changed", "checkpoint_invalid"].contains(&string(entry, "errorCode"))
                && catalog
                    .iter()
                    .any(|folder| folder["id"] == path && selectable(&catalog, folder));
            let (from, until) = window.unwrap_or((0, 0));
            Some(NotificationSelection {
                id: id.into(),
                version: version.into(),
                path: path.into(),
                validity,
                available,
                not_before: from.max(retry.unwrap_or(0)),
                expires_at: until,
            })
        })
        .collect()
}

fn error_details(code: &str) -> (&'static str, &'static str) {
    match code {
        "connection_changed" => (
            "This selection belongs to a different IMAP server. Refresh folders and save your selection again; cached mail is retained.",
            "reselect",
        ),
        "folder_changed" => (
            "This folder was recreated or its UIDVALIDITY changed. Refresh folders and save the selection again to start a new recent-mail baseline. Cached mail is retained.",
            "reselect",
        ),
        "checkpoint_invalid" => (
            "This folder's saved progress is invalid. Refresh folders and save the selection again to start a new recent-mail baseline; cached mail is retained.",
            "reselect",
        ),
        "folder_unavailable" => (
            "This selected folder is missing or no longer selectable. Refresh folders and review the selection; cached mail is retained.",
            "refresh_folders",
        ),
        "catalog_stale" => (
            "Refresh the server folder list before downloading this folder.",
            "refresh_folders",
        ),
        "storage_error" => (
            "This page could not be saved. Check free disk space, then retry. Saved progress is retained.",
            "retry",
        ),
        "authorization" => (
            "Reconnect this mailbox, then retry the selected folders. Cached mail is retained.",
            "reconnect",
        ),
        "incomplete_page" => (
            "The provider did not return a complete page. Retry after checking the provider; no checkpoint was advanced.",
            "retry",
        ),
        "invalid_date" => (
            "The provider returned an invalid mailbox date. Correct the provider data, then retry; saved progress is retained.",
            "retry",
        ),
        "page_too_large" => (
            "The provider response exceeded the download limit. Check the provider, then retry; saved progress is retained.",
            "retry",
        ),
        "network_error" | "provider_unavailable" | "rate_limited" => (
            "This folder could not be reached. Morrow can retry on a later mailbox sync after the retry time; saved progress is retained.",
            "retry",
        ),
        _ => (
            "This folder could not finish syncing. Check the connection, then retry; saved progress is retained.",
            "retry",
        ),
    }
}

fn safe_code(code: &str) -> &str {
    if [
        "connection_changed",
        "folder_changed",
        "checkpoint_invalid",
        "folder_unavailable",
        "catalog_stale",
        "storage_error",
        "authorization",
        "incomplete_page",
        "invalid_date",
        "page_too_large",
        "network_error",
        "provider_unavailable",
        "rate_limited",
    ]
    .contains(&code)
    {
        code
    } else {
        "sync_failed"
    }
}

/// Safe, observational projection. A catalog timestamp never becomes a sync timestamp.
pub fn status(config: &Value, owner: &str) -> Value {
    let accounts = connections(config);
    let mail = &accounts[owner];
    let state = &config[GROUP][owner];
    let entries = state["folders"].as_array().cloned().unwrap_or_default();
    let catalog = config["mailFolderCatalogs"][owner]["folders"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let fresh = catalog_fresh(config, owner, mail);
    let same_origin = imap::server_origin(mail).is_ok_and(|origin| state["origin"] == origin);
    let mut paths = catalog
        .iter()
        .filter(|f| selectable(&catalog, f))
        .map(|f| string(f, "id").to_owned())
        .collect::<Vec<_>>();
    for entry in &entries {
        if !paths.iter().any(|path| *path == entry["path"]) {
            paths.push(string(entry, "path").to_owned());
        }
    }
    let rows = paths
        .into_iter()
        .map(|path| {
            let entry = entries.iter().find(|entry| entry["path"] == path);
            let available = fresh
                && catalog
                    .iter()
                    .any(|folder| folder["id"] == path && selectable(&catalog, folder));
            let mut row = entry.map_or_else(
                || json!({}),
                |entry| {
                    project(
                        entry,
                        &[
                            "lastAttemptAt",
                            "lastSuccessfulSyncAt",
                            "lastCaughtUpAt",
                            "more",
                            "errorCode",
                            "nextRetryAt",
                            "retryCount",
                        ],
                    )
                },
            );
            row["folderId"] = path.clone().into();
            row["name"] = path.into();
            row["selectionId"] = entry.map_or(Value::Null, |entry| entry["id"].clone());
            row["selected"] = entry.is_some().into();
            row["available"] = available.into();
            row["coverage"] = "recent_page_and_new_mail".into();
            row["olderHistoryIncluded"] = false.into();
            let incomplete = entry.is_some_and(|entry| entry["checkpoint"]["bootstrapIncomplete"] == true);
            row["recentPageIncomplete"] = incomplete.into();
            row["coverageWarning"] = if incomplete { json!("The initial recent-page scan reached its limit. Use history import to download the remaining older mail.") } else { Value::Null };
            row["flagRefresh"] = "bounded_cached_messages".into();
            row["status"] = if entry.is_none() {
                "unselected"
            } else if !same_origin {
                row["errorCode"] = "connection_changed".into();
                "blocked"
            } else if !fresh {
                row["errorCode"] = "catalog_stale".into();
                "blocked"
            } else if !available {
                row["errorCode"] = "folder_unavailable".into();
                "blocked"
            } else if entry.is_some_and(|entry| entry["blocked"] == true) {
                "blocked"
            } else if !row["errorCode"].is_null() {
                "retry"
            } else if row["lastSuccessfulSyncAt"].is_null() {
                "queued"
            } else if row["more"] == true {
                "catching_up"
            } else {
                "current"
            }
            .into();
            if !row["errorCode"].is_null() {
                row["errorCode"] = safe_code(string(&row, "errorCode")).to_owned().into();
                let (message, action) = error_details(string(&row, "errorCode"));
                row["error"] = message.into();
                row["recoveryAction"] = action.into();
            }
            row
        })
        .collect::<Vec<_>>();
    let interval = config["preferences"]["syncInterval"].as_i64().unwrap_or(0);
    json!({"accountId":owner,"supported":mail.is_object() && supported(mail),"connectionVersion":connection_token(mail),"selectionVersion":state["version"].as_str().unwrap_or(""),"automaticSyncEnabled":interval>0,"intervalMinutes":interval.max(0),"selectionLimit":LIMIT,"pagesPerRound":PAGES_PER_ROUND,"catalogFresh":fresh,"folders":rows})
}

pub fn statuses(config: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for (owner, mail) in connections(config).as_object().unwrap() {
        if supported(mail) {
            result.insert(owner.clone(), status(config, owner));
        }
    }
    result.into()
}

pub(crate) fn validate_sync_review(config: &Value, owner: &str, input: &Value) -> Result<()> {
    if input.get("folderSyncSelectionVersion").is_none()
        && input.get("folderSyncConnectionVersion").is_none()
    {
        return Ok(());
    }
    let accounts = connections(config);
    let mail = accounts
        .get(owner)
        .filter(|mail| supported(mail))
        .ok_or_else(|| Error::conflict("Choose a connected IMAP mailbox."))?;
    if input["folderSyncConnectionVersion"] != connection_token(mail)
        || input["folderSyncSelectionVersion"].as_str()
            != Some(config[GROUP][owner]["version"].as_str().unwrap_or(""))
    {
        return Err(Error::conflict(
            "This mailbox or folder selection changed. Reload and review before syncing.",
        ));
    }
    Ok(())
}

/// Save a reviewed local download selection. This never writes to an IMAP server.
pub fn select(db: &Store, owner: &str, input: &Value) -> Result<Value> {
    let config = db.settings()?;
    let accounts = connections(&config);
    let mail = accounts
        .get(owner)
        .filter(|mail| supported(mail))
        .ok_or_else(|| Error::conflict("Choose a connected IMAP mailbox."))?;
    reviewed_connection(mail, input)?;
    let origin = imap::server_origin(mail)?;
    let previous = &config[GROUP][owner];
    if input["selectionVersion"].as_str() != Some(previous["version"].as_str().unwrap_or("")) {
        return Err(Error::conflict(
            "This folder selection changed. Refresh and review again.",
        ));
    }
    let paths = input["folderIds"]
        .as_array()
        .filter(|paths| paths.len() <= LIMIT)
        .ok_or_else(|| Error::invalid("Select at most 20 custom IMAP folders."))?;
    if !paths.is_empty() && !catalog_fresh(&config, owner, mail) {
        return Err(Error::conflict(error_details("catalog_stale").0));
    }
    let catalog = config["mailFolderCatalogs"][owner]["folders"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut folders = Vec::new();
    for path in paths {
        let path = path
            .as_str()
            .ok_or_else(|| Error::invalid("Choose a valid custom IMAP folder."))?;
        if !seen.insert(path)
            || !catalog
                .iter()
                .any(|folder| folder["id"] == path && selectable(&catalog, folder))
        {
            return Err(Error::conflict(
                "This custom folder is unavailable. Refresh folders and review the selection.",
            ));
        }
        let existing = previous["folders"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| entry["path"] == path);
        let entry = existing.filter(|entry| previous["origin"] == origin && !["folder_changed", "checkpoint_invalid"].contains(&string(entry, "errorCode"))).cloned()
            .unwrap_or_else(|| json!({"id":uuid::Uuid::new_v4().to_string(),"path":path,"checkpoint":null,"more":false,"errorCode":null,"blocked":false}));
        folders.push(entry);
    }
    write_owner(
        db,
        GROUP,
        owner,
        json!({"origin":origin,"version":uuid::Uuid::new_v4().to_string(),"folders":folders}),
    )?;
    Ok(status(&db.settings()?, owner))
}

pub fn retry(db: &Store, owner: &str, input: &Value) -> Result<Value> {
    let config = db.settings()?;
    let accounts = connections(&config);
    let mail = accounts
        .get(owner)
        .filter(|mail| supported(mail))
        .ok_or_else(|| Error::conflict("Choose a connected IMAP mailbox."))?;
    reviewed_connection(mail, input)?;
    let mut state = config[GROUP][owner].clone();
    if !state.is_object()
        || input["selectionVersion"].as_str() != state["version"].as_str()
        || state["origin"] != imap::server_origin(mail)?
    {
        return Err(Error::conflict(
            "This folder selection changed. Refresh folders and save the selection again.",
        ));
    }
    let entry = state["folders"]
        .as_array_mut()
        .and_then(|folders| {
            folders.iter_mut().find(|entry| {
                input["selectionId"].is_string() && entry["id"] == input["selectionId"]
            })
        })
        .ok_or_else(|| Error::conflict("This folder is no longer selected."))?;
    if ["folder_changed", "checkpoint_invalid"].contains(&string(entry, "errorCode")) {
        return Err(Error::conflict(error_details(string(entry, "errorCode")).0));
    }
    entry["errorCode"] = Value::Null;
    entry["nextRetryAt"] = Value::Null;
    entry["retryCount"] = 0.into();
    entry["blocked"] = false.into();
    state["version"] = uuid::Uuid::new_v4().to_string().into();
    write_owner(db, GROUP, owner, state)?;
    Ok(status(&db.settings()?, owner))
}

fn selected(config: &Value, owner: &str, ticket: &Value) -> bool {
    let state = &config[GROUP][owner];
    state["version"] == ticket["version"]
        && state["folders"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| *entry == ticket["expected"]))
}

/// Called inside the same transaction that imports the messages and records their checkpoint.
pub(crate) fn validate_page(
    config: &Value,
    owner: &str,
    connection: &Value,
    ticket: &Value,
    checkpoint: &Value,
) -> Result<()> {
    if !selected(config, owner, ticket)
        || config[GROUP][owner]["origin"] != imap::server_origin(connection)?
        || checkpoint["path"] != ticket["expected"]["path"]
        || checkpoint["connection"] != connection_version(connection)
        || !checkpoint["uid"]
            .as_u64()
            .is_some_and(|uid| uid <= u32::MAX as u64)
        || !checkpoint["validity"]
            .as_str()
            .is_some_and(|v| v.parse::<u32>().is_ok_and(|v| v > 0))
        || ticket["expected"]["checkpoint"].is_object()
            && checkpoint["validity"] != ticket["expected"]["checkpoint"]["validity"]
    {
        return Err(Error::conflict(
            "This selected folder changed during sync. Saved progress is retained.",
        ));
    }
    Ok(())
}

pub(crate) fn commit_page(
    db: &Store,
    owner: &str,
    ticket: &Value,
    checkpoint: &Value,
) -> Result<()> {
    let config = db.settings()?;
    let mut state = config[GROUP][owner].clone();
    let entry = state["folders"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == ticket["expected"]["id"])
        .unwrap();
    let checked = now();
    entry["checkpoint"] = checkpoint.clone();
    entry["lastSuccessfulSyncAt"] = checked.clone().into();
    entry["more"] = checkpoint["more"].clone();
    if checkpoint["more"] != true {
        entry["lastCaughtUpAt"] = checked.into();
    }
    entry["errorCode"] = Value::Null;
    entry["nextRetryAt"] = Value::Null;
    entry["retryCount"] = 0.into();
    entry["blocked"] = false.into();
    write_owner(db, GROUP, owner, state)
}

fn failure(
    db: &Store,
    connection: &Value,
    ticket: &Value,
    error: &Error,
    stage: &str,
) -> Result<()> {
    let config = db.settings()?;
    let owner = string(connection, "email");
    if connections(&config).get(owner) != Some(connection) || !selected(&config, owner, ticket) {
        return Ok(());
    }
    let mut failed = crate::background::import_failure(
        error,
        stage,
        &ticket["expected"],
        chrono::Utc::now().timestamp_millis(),
    );
    if [
        "folder_changed",
        "checkpoint_invalid",
        "folder_unavailable",
        "catalog_stale",
    ]
    .contains(&string(&error.body, "code"))
    {
        failed["errorCode"] = error.body["code"].clone();
    } else if error.body["code"] == "provider_imap_mailbox_rejected" {
        failed["errorCode"] = "folder_unavailable".into();
    }
    let mut state = config[GROUP][owner].clone();
    let entry = state["folders"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == ticket["expected"]["id"])
        .unwrap();
    for key in ["errorCode", "nextRetryAt", "retryCount"] {
        entry[key] = failed[key].clone();
    }
    entry["blocked"] = (failed["status"] != "running"
        && !["folder_unavailable", "catalog_stale"].contains(&string(&failed, "errorCode")))
    .into();
    write_owner(db, GROUP, owner, state)
}

async fn run(
    app: &App,
    connection: &Value,
    expected_version: &Value,
    connector: Option<&native_tls::TlsConnector>,
) -> Result<()> {
    let owner = string(connection, "email");
    let config = app.settings().await?;
    let state = &config[GROUP][owner];
    if state["version"] != *expected_version
        || state["folders"].as_array().is_none_or(Vec::is_empty)
    {
        return Ok(());
    }
    if !supported(connection) || state["origin"] != imap::server_origin(connection)? {
        return Ok(());
    }
    let version = state["version"].clone();
    let mut entries = state["folders"].as_array().cloned().unwrap_or_default();
    entries
        .retain(|entry| entry["blocked"] != true && string(entry, "nextRetryAt") <= now().as_str());
    entries.sort_by(|a, b| {
        string(a, "lastAttemptAt")
            .cmp(string(b, "lastAttemptAt"))
            .then_with(|| string(a, "id").cmp(string(b, "id")))
    });
    for original in entries.into_iter().take(PAGES_PER_ROUND) {
        let (saved, version, original) = (connection.clone(), version.clone(), original.clone());
        let ticket = app
            .db(move |db| {
                let config = db.settings()?;
                let owner = string(&saved, "email");
                let ticket = json!({"version":version,"expected":original});
                if connections(&config).get(owner) != Some(&saved)
                    || !selected(&config, owner, &ticket)
                {
                    return Ok(None);
                }
                let mut state = config[GROUP][owner].clone();
                let entry = state["folders"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|entry| entry["id"] == ticket["expected"]["id"])
                    .unwrap();
                entry["lastAttemptAt"] = now().into();
                let ticket = json!({"version":ticket["version"],"expected":entry});
                write_owner(db, GROUP, owner, state)?;
                Ok(Some(ticket))
            })
            .await?;
        let Some(ticket) = ticket else {
            continue;
        };
        let mut stage = "fetch";
        let result = async {
            let config = app.settings().await?;
            let catalog = config["mailFolderCatalogs"][owner]["folders"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let code = if !catalog_fresh(&config, owner, connection) {
                Some("catalog_stale")
            } else if !catalog.iter().any(|folder| {
                folder["id"] == ticket["expected"]["path"] && selectable(&catalog, folder)
            }) {
                Some("folder_unavailable")
            } else {
                None
            };
            if let Some(code) = code {
                let mut error = Error::conflict(error_details(code).0);
                error.body["code"] = code.into();
                return Err(error);
            }
            if !selected(&config, owner, &ticket)
                || connections(&config).get(owner) != Some(connection)
            {
                return Err(Error::conflict("This folder selection changed."));
            }
            if let Some(error) = mail::read_backoff(&config, connection) {
                return Err(error);
            }
            let path = string(&ticket["expected"], "path");
            let mut checkpoint = ticket["expected"]["checkpoint"].clone();
            if !checkpoint.is_null()
                && (!checkpoint.is_object()
                    || checkpoint["path"] != path
                    || !checkpoint["uid"]
                        .as_u64()
                        .is_some_and(|uid| uid <= u32::MAX as u64)
                    || !checkpoint["validity"].as_str().is_some_and(|validity| {
                        validity.parse::<u32>().is_ok_and(|value| value > 0)
                    }))
            {
                let mut error = Error::conflict(error_details("checkpoint_invalid").0);
                error.body["code"] = "checkpoint_invalid".into();
                return Err(error);
            }
            // Same-server reconnects keep the UID boundary. EXAMINE must still prove UIDVALIDITY.
            if checkpoint.is_object() {
                checkpoint["connection"] = connection_version(connection);
            }
            let mut activity = app.0.activity.start(
                owner,
                "sync",
                "Fetching selected folder",
                &format!("{path} · up to 50 messages in this page"),
            );
            let page = if let Some(connector) = connector {
                imap::fetch_selected_page_cached_with_tls(
                    app,
                    connection,
                    path,
                    &checkpoint,
                    connector,
                )
                .await
            } else {
                imap::fetch_selected_page_cached(app, connection, path, &checkpoint).await
            };
            let page = mail::finish_read(app, connection, page).await;
            activity.finish(
                page.is_ok(),
                page.as_ref()
                    .ok()
                    .and_then(|page| page["messages"].as_array().map(Vec::len)),
            );
            let mut page = page?;
            page["selectedFolderSync"] = ticket.clone();
            stage = "commit";
            mail::commit_sync_page(app, owner, connection, &page).await
        }
        .await;
        if let Err(error) = result {
            let (connection, ticket) = (connection.clone(), ticket.clone());
            app.db(move |db| failure(db, &connection, &ticket, &error, stage))
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn sync(app: &App, connection: &Value, expected_version: &Value) -> Result<()> {
    run(app, connection, expected_version, None).await
}

/// Synthetic TLS fixtures use the same state machine with an explicit test root certificate.
pub async fn sync_with_tls(
    app: &App,
    connection: &Value,
    expected_version: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<()> {
    run(app, connection, expected_version, Some(connector)).await
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path = ctx
        .path
        .iter()
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let path = path.iter().map(String::as_str).collect::<Vec<_>>();
    if !matches!(
        (ctx.method.as_str(), path.as_slice()),
        ("GET" | "PUT", ["mail", "folders", "sync"])
            | ("POST", ["mail", "folders", "sync", "retry"])
    ) {
        return Ok(None);
    }
    let owner = ctx.read_owner(&app.settings().await?, false)?;
    let input = ctx.body.clone();
    // Selection changes deliberately do not wait for network I/O; commit revalidates their version.
    let method = ctx.method.clone();
    let value = app
        .db(move |db| match method.as_str() {
            "GET" => Ok(status(&db.settings()?, &owner)),
            "PUT" => select(db, &owner, &input),
            _ => retry(db, &owner, &input),
        })
        .await?;
    Ok(Some(Json(value).into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "selected-atomic@example.invalid";

    #[tokio::test]
    async fn selected_import_and_download_undo_commit_or_roll_back_together_per_owner() {
        const OTHER: &str = "selected-undo-other@example.invalid";
        const ID: &str = "stable-selected-local-id";
        fn snapshot(db: &Store) -> Result<Value> {
            Ok(json!({
                "message":db.get(OWNER,ID)?,"other":db.get(OTHER,ID)?,
                "selection":db.settings()?[GROUP],
                "coverage":crate::downloads::coverage(db,OWNER)?,
                "otherCoverage":crate::downloads::coverage(db,OTHER)?,
                "indexedBody":db.conn.query_row("SELECT body FROM search_documents WHERE account=? AND id=?",[OWNER,ID],|row|row.get::<_,String>(0))?
            }))
        }
        let root = std::env::temp_dir().join(format!(
            "morrow-selected-downloads-{}",
            uuid::Uuid::new_v4()
        ));
        let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
        let connection = json!({"email":OWNER,"provider":"imap","imapHost":"imap.example.invalid","imapPort":993,"connectionId":"one"});
        let saved = connection.clone();
        let selection = app.db(move |db| {
            let mut other = saved.clone(); other["email"] = OTHER.into();
            db.set_settings(&json!({"mailAccounts":{OWNER:saved,OTHER:other},"preferences":{"syncInterval":0},"mailFolderCatalogs":{OWNER:{"connection":connection_version(&saved),"updatedAt":now(),"folders":[{"id":"Projects","name":"Projects","kind":"archive","editable":true,"selectable":true}]}}}))?;
            select(db,OWNER,&json!({"folderIds":["Projects"],"selectionVersion":"","connectionVersion":connection_token(&saved)}))?;
            for mail in [&saved,&other] {
                let owner = string(mail,"email");
                let message = json!({"id":ID,"remoteId":"imap:55:1","providerFolderId":"Projects","imapOrigin":imap::server_origin(mail)?,"folder":"archive","body":"","contentIncomplete":true,"bodyTruncated":false,"read":true,"starred":false,"pending":true,"labels":["local-label"],"date":"2026-10-15T00:00:00.000Z"});
                db.upsert(owner,&message)?;
                let patch = crate::local_moves::patch(db,owner,&message,&json!({"folder":"inbox"}))?;
                let changed = db.update(owner,ID,&patch)?.unwrap();
                assert!(changed["localFolderUndo"]["token"].is_string());
            }
            Ok(db.settings()?[GROUP][OWNER].clone())
        }).await.unwrap();
        let page = json!({"messages":[{"id":"provider-page-id","remoteId":"imap:55:1","providerFolderId":"Projects","imapOrigin":imap::server_origin(&connection).unwrap(),"folder":"archive","body":"selectedafter","contentIncomplete":false,"bodyTruncated":false,"read":true,"starred":false,"date":"2026-10-15T00:00:00.000Z"}],"syncCheckpoint":{"path":"Projects","validity":"55","uid":1,"connection":connection_version(&connection),"more":false},"selectedFolderSync":{"version":selection["version"],"expected":selection["folders"][0]}});
        let before = app.db(snapshot).await.unwrap();
        assert_eq!(before["coverage"]["incompleteCount"], 1);
        app.db(|db| {
            db.conn.execute_batch("CREATE TEMP TRIGGER reject_selected_downloads BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'synthetic selected checkpoint failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(
            mail::commit_sync_page(&app, OWNER, &connection, &page)
                .await
                .is_err()
        );
        assert_eq!(
            app.db(snapshot).await.unwrap(),
            before,
            "A failed selected checkpoint must restore the original message, undo, index and coverage together."
        );
        app.db(|db| {
            db.conn
                .execute_batch("DROP TRIGGER reject_selected_downloads;")?;
            Ok(())
        })
        .await
        .unwrap();
        let mut stale = page.clone();
        stale["selectedFolderSync"]["version"] = "obsolete-selection".into();
        assert!(
            mail::commit_sync_page(&app, OWNER, &connection, &stale)
                .await
                .is_err()
        );
        let mut other_connection = connection.clone();
        other_connection["connectionId"] = "obsolete-connection".into();
        assert!(
            mail::commit_sync_page(&app, OWNER, &other_connection, &page)
                .await
                .is_err()
        );
        assert_eq!(
            app.db(snapshot).await.unwrap(),
            before,
            "Stale selection or connection cannot invalidate an unrelated local undo."
        );
        mail::commit_sync_page(&app, OWNER, &connection, &page)
            .await
            .unwrap();
        let committed = app.db(snapshot).await.unwrap();
        assert_eq!(committed["message"]["id"], ID);
        assert_eq!(committed["message"]["remoteId"], "imap:55:1");
        assert_eq!(committed["message"]["providerFolderId"], "Projects");
        assert_eq!(committed["message"]["folder"], "inbox");
        assert!(committed["message"]["localFolderUndo"].is_null());
        for key in ["read", "starred", "pending", "labels", "imapOrigin"] {
            assert_eq!(committed["message"][key], before["message"][key]);
        }
        assert_eq!(committed["message"]["body"], "selectedafter");
        assert_eq!(committed["indexedBody"], "selectedafter");
        assert_eq!(committed["coverage"]["incompleteCount"], 0);
        assert_eq!(committed["other"], before["other"]);
        assert_eq!(committed["otherCoverage"], before["otherCoverage"]);
        assert_eq!(
            committed["selection"][OWNER]["folders"][0]["checkpoint"]["uid"],
            1
        );
        let token = before["message"]["localFolderUndo"]["token"].clone();
        app.db(move |db| {
            let message = db.get(OWNER, ID)?.unwrap();
            assert_eq!(
                crate::local_moves::patch(db, OWNER, &message, &json!({"undoLocalMove":token}))
                    .unwrap_err()
                    .status,
                409
            );
            let folder = &status(&db.settings()?, OWNER)["folders"][0];
            assert_eq!(folder["coverage"], "recent_page_and_new_mail");
            assert_eq!(folder["olderHistoryIncluded"], false);
            Ok(())
        })
        .await
        .unwrap();
        drop(app);
        let db = Store::open(&root).unwrap();
        assert_eq!(snapshot(&db).unwrap(), committed);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn selected_messages_checkpoint_and_freshness_commit_atomically_and_reject_stale_tickets()
    {
        let root =
            std::env::temp_dir().join(format!("morrow-selected-atomic-{}", uuid::Uuid::new_v4()));
        let app = App::open(&root, 0, "fixture-token".into(), String::new()).unwrap();
        let connection = json!({"email":OWNER,"provider":"imap","imapHost":"imap.example.invalid","imapPort":993,"connectionId":"one"});
        let saved = connection.clone();
        let selection = app.db(move |db| {
            db.set_settings(&json!({"mailAccounts":{OWNER:saved},"mailFolderCatalogs":{OWNER:{"connection":connection_version(&saved),"updatedAt":now(),"folders":[{"id":"Projects","name":"Projects","kind":"archive","editable":true,"selectable":true}]}}}))?;
            select(db,OWNER,&json!({"folderIds":["Projects"],"selectionVersion":"","connectionVersion":connection_token(&saved)}))?;
            Ok(db.settings()?[GROUP][OWNER].clone())
        }).await.unwrap();
        let page = json!({"messages":[{"id":"imap-folder:UHJvamVjdHM:55:1","remoteId":"imap:55:1","providerFolderId":"Projects","imapOrigin":imap::server_origin(&connection).unwrap(),"folder":"archive","body":"Synthetic transaction proof","date":"2026-10-15T00:00:00.000Z"}],"syncCheckpoint":{"path":"Projects","validity":"55","uid":1,"connection":connection_version(&connection),"more":false},"selectedFolderSync":{"version":selection["version"],"expected":selection["folders"][0]}});
        app.db(|db| {
            db.conn.execute_batch("CREATE TEMP TRIGGER reject_selected_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END;")?;Ok(())
        }).await.unwrap();
        assert!(
            mail::commit_sync_page(&app, OWNER, &connection, &page)
                .await
                .is_err()
        );
        app.db(|db| {
            assert!(db.list(OWNER)?.is_empty());
            assert!(db.settings()?[GROUP][OWNER]["folders"][0]["checkpoint"].is_null());
            assert!(db.settings()?[GROUP][OWNER]["folders"][0]["lastSuccessfulSyncAt"].is_null());
            let indexed: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM search_documents WHERE account=?",
                [OWNER],
                |r| r.get(0),
            )?;
            assert_eq!(indexed, 0);
            db.conn
                .execute_batch("DROP TRIGGER reject_selected_settings;")?;
            Ok(())
        })
        .await
        .unwrap();
        let mut wrong = page.clone();
        wrong["messages"][0]["providerFolderId"] = "Other folder".into();
        assert!(
            mail::commit_sync_page(&app, OWNER, &connection, &wrong)
                .await
                .is_err()
        );
        mail::commit_sync_page(&app, OWNER, &connection, &page)
            .await
            .unwrap();
        let before = app.settings().await.unwrap()[GROUP][OWNER].clone();
        assert!(before["folders"][0]["lastSuccessfulSyncAt"].is_string());
        assert_eq!(before["folders"][0]["checkpoint"]["uid"], 1);
        assert!(
            mail::commit_sync_page(&app, OWNER, &connection, &page)
                .await
                .is_err(),
            "A completed ticket cannot replay"
        );
        assert_eq!(app.settings().await.unwrap()[GROUP][OWNER], before);
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn optional_sync_review_rejects_selection_or_connection_changes_and_combined_views() {
        let connection = json!({"provider":"imap","email":OWNER,"imapHost":"imap.example.invalid","imapPort":993,"connectionId":"one"});
        let config =
            json!({"mailAccounts":{OWNER:connection},GROUP:{OWNER:{"version":"version-one"}}});
        assert!(validate_sync_review(&config, OWNER, &json!({})).is_ok());
        let input = json!({"folderSyncSelectionVersion":"version-one","folderSyncConnectionVersion":connection_token(&connection)});
        assert!(validate_sync_review(&config, OWNER, &input).is_ok());
        assert!(validate_sync_review(&config, "all", &input).is_err());
        let mut changed = config.clone();
        changed[GROUP][OWNER]["version"] = "version-two".into();
        assert!(validate_sync_review(&changed, OWNER, &input).is_err());
        let mut changed = config.clone();
        changed["mailAccounts"][OWNER]["connectionId"] = "two".into();
        assert!(validate_sync_review(&changed, OWNER, &input).is_err());
        assert!(
            validate_sync_review(
                &config,
                OWNER,
                &json!({"folderSyncSelectionVersion":"version-one"})
            )
            .is_err()
        );
    }
}
