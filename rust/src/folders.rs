//! Reviewed, account-bound provider folder/label management. No write retries.
use crate::{
    error::{Error, Result},
    imap, mail, providers,
    service::{App, Context, connections},
    store::{Store, merge, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

pub struct Review {
    expires: Instant,
    owner: String,
    connection: Value,
    input: Value,
    plan: Value,
}
fn imap_mail(mail: &Value) -> bool {
    ["", "imap"].contains(&string(mail, "provider"))
}
async fn catalog(app: &App, mail: &Value) -> Result<Vec<Value>> {
    if imap_mail(mail) {
        imap::management_folders(mail).await
    } else {
        providers::management_folders(&app.0.client, mail).await
    }
}
fn descendant(catalog: &[Value], child: &Value, source: &Value, provider: &str) -> bool {
    if child["id"] == source["id"] {
        return true;
    }
    if provider != "microsoft" {
        let delimiter = string(source, "delimiter");
        return !delimiter.is_empty()
            && string(child, "name")
                .starts_with(&format!("{}{delimiter}", string(source, "name")));
    }
    let mut parent = string(child, "parentId");
    let mut seen = HashSet::new();
    while !parent.is_empty() && seen.insert(parent) {
        if parent == string(source, "id") {
            return true;
        }
        parent = catalog
            .iter()
            .find(|f| string(f, "id") == parent)
            .map(|f| string(f, "parentId"))
            .unwrap_or("");
    }
    false
}
pub fn plan(provider: &str, catalog: &[Value], input: &Value) -> Result<Value> {
    if input.as_object().is_none_or(|fields| {
        fields
            .keys()
            .any(|k| !["operation", "id", "name", "parentId"].contains(&k.as_str()))
            || fields.values().any(|v| !v.is_string())
    }) {
        return Err(Error::invalid("Invalid folder request."));
    }
    let operation = string(input, "operation");
    if !["create", "rename", "move", "delete"].contains(&operation) {
        return Err(Error::invalid("Choose a folder operation."));
    }
    let source = if operation == "create" {
        json!({})
    } else {
        catalog
            .iter()
            .find(|f| f["id"] == input["id"] && f["editable"] == true)
            .cloned()
            .ok_or_else(|| {
                Error::conflict("Choose a custom label or folder. System folders are protected.")
            })?
    };
    let parent_id = if operation == "rename" {
        string(&source, "parentId")
    } else {
        string(input, "parentId")
    };
    let parent = if parent_id.is_empty()
        || operation == "rename"
            && provider != "microsoft"
            && !catalog.iter().any(|f| string(f, "id") == parent_id)
    {
        json!({})
    } else {
        catalog
            .iter()
            .find(|f| {
                string(f, "id") == parent_id
                    && (provider != "google" || f["editable"] == true)
                    && !["virtual", "trash", "spam"].contains(&string(f, "kind"))
                    && f["hidden"] != true
            })
            .cloned()
            .ok_or_else(|| {
                Error::conflict("The parent folder is unavailable. Refresh and review again.")
            })?
    };
    if operation != "create"
        && !parent_id.is_empty()
        && descendant(catalog, &parent, &source, provider)
    {
        return Err(Error::invalid(
            "A folder cannot be moved into itself or one of its children.",
        ));
    }
    let delimiter = if provider == "google" {
        "/"
    } else if provider == "microsoft" {
        " / "
    } else if operation != "create" {
        string(&source, "delimiter")
    } else {
        catalog
            .iter()
            .find(|f| f["kind"] == "inbox")
            .map(|f| string(f, "delimiter"))
            .unwrap_or("")
    };
    if provider == "imap"
        && operation != "rename"
        && operation != "delete"
        && !parent_id.is_empty()
        && (delimiter.is_empty() || string(&parent, "delimiter") != delimiter)
    {
        return Err(Error::invalid(
            "These IMAP namespaces do not support that hierarchy move.",
        ));
    }
    let leaf = if ["create", "rename"].contains(&operation) {
        string(input, "name")
    } else {
        string(&source, "leafName")
    };
    if operation != "delete"
        && (leaf.trim() != leaf
            || leaf.is_empty()
            || leaf.encode_utf16().count() > 255
            || leaf.chars().any(char::is_control)
            || [".", ".."].contains(&leaf)
            || provider != "microsoft" && !delimiter.is_empty() && leaf.contains(delimiter))
    {
        return Err(Error::invalid(
            "Enter a name of 1–255 characters without control characters or a hierarchy separator.",
        ));
    }
    // Rename retains an implicit Gmail/IMAP parent even when no parent entry exists.
    let prefix = if operation == "rename" && provider != "microsoft" && !delimiter.is_empty() {
        string(&source, "name")
            .rsplit_once(delimiter)
            .map(|(p, _)| p)
            .unwrap_or("")
    } else {
        string(&parent, "name")
    };
    let name = if operation == "delete" {
        String::new()
    } else if prefix.is_empty() {
        leaf.to_owned()
    } else {
        format!("{prefix}{delimiter}{leaf}")
    };
    if name.encode_utf16().count() > 512 {
        return Err(Error::invalid(
            "The complete folder path exceeds 512 characters.",
        ));
    }
    if operation != "delete"
        && provider == "google"
        && ([
            "INBOX",
            "SENT",
            "DRAFT",
            "DRAFTS",
            "TRASH",
            "SPAM",
            "UNREAD",
            "STARRED",
            "IMPORTANT",
            "CHAT",
        ]
        .iter()
        .any(|v| name.eq_ignore_ascii_case(v))
            || name.to_ascii_uppercase().starts_with("CATEGORY_"))
    {
        return Err(Error::invalid("That name belongs to a Gmail system label."));
    }
    let affected = catalog
        .iter()
        .filter(|f| {
            operation != "create"
                && (f["id"] == source["id"] || operation != "delete" || provider == "microsoft")
                && descendant(catalog, f, &source, provider)
        })
        .collect::<Vec<_>>();
    if ["rename", "move", "delete"].contains(&operation)
        && affected.iter().any(|f| f["editable"] != true)
    {
        return Err(Error::conflict(
            "This hierarchy contains a protected system folder.",
        ));
    }
    // ponytail: Gmail has no atomic subtree rename; bound one reviewed action to 50 writes.
    if provider == "google" && affected.len() > 50 {
        return Err(Error::invalid(
            "Manage at most 50 nested Gmail labels in one reviewed change.",
        ));
    }
    let changes = affected.iter().map(|folder| {
        let target = if operation=="delete" { String::new() } else { format!("{name}{}", string(folder,"name").strip_prefix(string(&source,"name")).unwrap_or("")) };
        json!({"oldId":folder["id"],"oldName":folder["name"],"newName":target,"selectable":folder["selectable"]})
    }).collect::<Vec<_>>();
    let targets = if operation == "create" {
        vec![name.as_str()]
    } else {
        changes.iter().map(|c| string(c, "newName")).collect()
    };
    if operation != "delete"
        && (targets.iter().any(|target| {
            catalog.iter().any(|f| {
                !affected.iter().any(|old| old["id"] == f["id"])
                    && string(f, "name").to_lowercase() == target.to_lowercase()
            })
        }) || changes.iter().any(|c| c["oldName"] == c["newName"]))
    {
        return Err(Error::conflict(
            "The destination already exists, or the folder has not changed.",
        ));
    }
    let impact = if operation == "delete" {
        if provider == "google" {
            "Removes this label from provider mail. Messages and other labels remain; nested labels keep their names."
        } else if provider == "microsoft" {
            "Deletes this provider folder, its contents and child folders. Cached messages and drafts remain on this device."
        } else {
            "Permanently deletes this IMAP mailbox and its messages. Child mailboxes remain. Cached messages and drafts remain on this device."
        }
    } else {
        "Changes the provider hierarchy, including the listed nested labels/folders. Cached message identities and drafts are retained."
    };
    Ok(
        json!({"operation":operation,"sourceId":source["id"],"sourceName":source["name"],"parentId":parent_id,"name":name,"leafName":leaf,
        "changes":changes,"impact":impact,"affectedCount":affected.len().max(1),"messageCount":if operation=="delete"{source["totalItemCount"].clone()}else{Value::Null}}),
    )
}
async fn reviewed_plan(app: &App, mail: &Value, input: &Value) -> Result<Value> {
    let catalog = catalog(app, mail).await?;
    let provider = if imap_mail(mail) {
        "imap"
    } else {
        string(mail, "provider")
    };
    let mut result = plan(provider, &catalog, input)?;
    if imap_mail(mail)
        && input["operation"] == "delete"
        && catalog
            .iter()
            .any(|f| f["id"] == input["id"] && f["selectable"] == true)
    {
        let status = imap::folder_status(mail, string(input, "id")).await?;
        result["messageCount"] = status["totalItemCount"].clone();
        result["uidValidity"] = status["uidValidity"].clone();
    }
    Ok(result)
}
pub fn update_cache(
    db: &Store,
    owner: &str,
    provider: &str,
    changes: &[Value],
    catalog: &[Value],
) -> Result<()> {
    db.transaction(|db| {
        for mut message in db.list(owner)? {
            let before = message.clone();
            if provider == "google" {
                if let Some(ids) = message["providerLabelIds"].as_array().cloned() {
                    if !changes.iter().any(|c| ids.contains(&c["oldId"])) {
                        continue;
                    }
                    let ids = ids
                        .into_iter()
                        .filter(|id| {
                            !changes
                                .iter()
                                .any(|c| c["oldId"] == *id && c["newName"] == "")
                        })
                        .collect::<Vec<_>>();
                    let labels = ids
                        .iter()
                        .filter_map(|id| {
                            catalog
                                .iter()
                                .find(|f| f["id"] == *id && f["kind"] == "label")
                        })
                        .map(|f| f["name"].clone())
                        .collect::<Vec<_>>();
                    let incoming = merge(
                        merge(message.clone(), &message["providerSnapshot"]),
                        &json!({"providerLabelIds":ids,"labels":labels}),
                    );
                    message = merge(
                        message.clone(),
                        &mail::google_import_state(&incoming, Some(&message)),
                    );
                }
            } else if let Some(change) = changes
                .iter()
                .find(|c| c["oldId"] == message["providerFolderId"])
            {
                if change["newName"] == "" {
                    message["providerFolderMissing"] = true.into();
                } else {
                    if provider == "imap"
                        && change["uidValidity"].as_u64().is_some_and(|v| {
                            string(&message, "remoteId")
                                .split(':')
                                .nth(1)
                                .and_then(|s| s.parse::<u64>().ok())
                                != Some(v)
                        })
                    {
                        message["providerFolderMissing"] = true.into();
                    } else {
                        message["providerFolderId"] = change["newId"].clone();
                        message["providerFolderName"] = change["newName"].clone();
                        message["providerFolderMissing"] = false.into();
                    }
                }
            }
            if before != message {
                db.upsert(owner, &message)?;
            }
        }
        // Keep unrelated checkpoints and the pause state; deleted mailboxes leave the traversal.
        let mut imports = db.settings()?["imports"].clone();
        if let Some(folders) = imports[owner]["cursor"]["folders"].as_array().cloned() {
            let key = if provider == "imap" { "path" } else { "id" };
            let old_index = imports[owner]["cursor"]["index"].as_u64().unwrap_or(0) as usize;
            let mut next = Vec::new();
            let mut index = old_index;
            for (position, mut folder) in folders.into_iter().enumerate() {
                if let Some(change) = changes.iter().find(|c| c["oldId"] == folder[key]) {
                    if change["newName"] == "" {
                        if position < old_index {
                            index = index.saturating_sub(1);
                        }
                        if position == old_index {
                            imports[owner]["cursor"]["next"] = Value::Null;
                        }
                        continue;
                    }
                    folder[key] = change["newId"].clone();
                    if provider == "microsoft" {
                        folder["name"] = change["newName"].clone();
                        if position == old_index && change["oldId"] != change["newId"] {
                            imports[owner]["cursor"]["next"] = Value::Null;
                        }
                    } else if imports[owner]["cursor"]["next"]["path"] == change["oldId"] {
                        imports[owner]["cursor"]["next"]["path"] = change["newId"].clone();
                    }
                }
                next.push(folder);
            }
            if index >= next.len() {
                imports[owner]["cursor"] = Value::Null;
                imports[owner]["folderIndex"] =
                    (imports[owner]["folderIndex"].as_u64().unwrap_or(0) + 1).into();
                imports[owner]["status"] = "complete".into();
            } else {
                imports[owner]["cursor"]["folders"] = json!(next);
                imports[owner]["cursor"]["index"] = index.into();
            }
            db.set_settings(&json!({"imports":imports}))?;
        }
        Ok(())
    })
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path = ctx
        .path
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let path = path.iter().map(String::as_str).collect::<Vec<_>>();
    if !matches!(
        (ctx.method.as_str(), path.as_slice()),
        ("GET", ["mail", "folders", "manage"]) | ("POST", ["mail", "folders", "preview" | "apply"])
    ) {
        return Ok(None);
    }
    let _gate = app
        .0
        .mailbox
        .try_lock()
        .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
    let owner = ctx.read_owner(&app.settings().await?, false)?;
    if owner == "demo" {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    if ctx.method.as_str() == "GET" {
        let mail = mail::current_mail(app, &owner).await?;
        let folders = catalog(app, &mail).await?;
        return Ok(Some(Json(json!({"accountId":owner,"provider":if imap_mail(&mail){"imap"}else{string(&mail,"provider")},"canManage":providers::can_organize(&mail),"folders":folders})).into_response()));
    }
    let mail = mail::current_mail(app, &owner).await?;
    if !providers::can_organize(&mail) {
        return Err(Error::new(
            403,
            "Reconnect this mailbox and approve mail write permission before managing labels/folders.",
        ));
    }
    if path[2] == "preview" {
        let plan = reviewed_plan(app, &mail, &ctx.body).await?;
        let token = crate::service::hex_token()?;
        let mut reviews = app
            .0
            .folder_reviews
            .lock()
            .map_err(|_| Error::new(503, "Restart the workspace."))?;
        reviews.retain(|_, r| r.expires > Instant::now());
        if reviews.len() >= 32 {
            return Err(Error::conflict(
                "Too many open folder reviews. Close an older review and try again later.",
            ));
        }
        reviews.insert(
            token.clone(),
            Review {
                expires: Instant::now() + Duration::from_secs(600),
                owner: owner.clone(),
                connection: mail,
                input: ctx.body.clone(),
                plan: plan.clone(),
            },
        );
        return Ok(Some(
            Json(json!({"accountId":owner,"previewId":token,"plan":plan})).into_response(),
        ));
    }
    if ctx.body["confirmed"] != true
        || ctx.body.as_object().is_none_or(|v| {
            v.keys()
                .any(|k| !["previewId", "confirmed"].contains(&k.as_str()))
        })
    {
        return Err(Error::invalid(
            "Review and confirm the provider change first.",
        ));
    }
    let review = {
        let mut reviews = app
            .0
            .folder_reviews
            .lock()
            .map_err(|_| Error::new(503, "Restart the workspace."))?;
        let token = string(&ctx.body, "previewId");
        let review = reviews.get(token).ok_or_else(|| {
            Error::conflict("This review expired or was already used. Refresh and review again.")
        })?;
        if review.owner != owner || review.expires <= Instant::now() || review.connection != mail {
            return Err(Error::conflict(
                "The owning connection changed. Refresh and review again.",
            ));
        }
        reviews.remove(token).unwrap()
    };
    if reviewed_plan(app, &mail, &review.input).await? != review.plan {
        return Err(Error::conflict(
            "The provider hierarchy changed. Refresh and review again.",
        ));
    }
    let provider = if imap_mail(&mail) {
        "imap"
    } else {
        string(&mail, "provider")
    };
    let operation = string(&review.plan, "operation");
    let mut changes = review.plan["changes"].as_array().unwrap().clone();
    let work = async {
        if provider == "imap" {
            changes = imap::manage_folder(
                &mail,
                operation,
                string(&review.plan, "sourceId"),
                string(&review.plan, "name"),
                &changes,
            )
            .await?;
        } else if provider == "google" && ["rename", "move"].contains(&operation) {
            for change in &changes {
                let result = providers::manage_folder(
                    &app.0.client,
                    &mail,
                    operation,
                    string(change, "oldId"),
                    string(change, "newName"),
                    "",
                )
                .await?;
                if result["id"] != change["oldId"] {
                    return Err(providers::remote_error());
                }
            }
        } else {
            providers::manage_folder(
                &app.0.client,
                &mail,
                operation,
                string(&review.plan, "sourceId"),
                if provider == "google" {
                    string(&review.plan, "name")
                } else {
                    string(&review.plan, "leafName")
                },
                string(&review.plan, "parentId"),
            )
            .await?;
        }
        let catalog = catalog(app, &mail).await?;
        if operation == "create" && !catalog.iter().any(|f| f["name"] == review.plan["name"]) {
            return Err(providers::remote_error());
        }
        for change in &mut changes {
            if change["newName"] == "" {
                if catalog.iter().any(|f| {
                    f["id"] == change["oldId"]
                        && (provider == "google"
                            || provider == "imap" && f["selectable"] == true
                            || provider == "microsoft" && f["name"] == change["oldName"])
                }) {
                    return Err(providers::remote_error());
                }
                change["newId"] = "".into();
                continue;
            }
            let matching = catalog
                .iter()
                .filter(|f| f["name"] == change["newName"])
                .collect::<Vec<_>>();
            if matching.len() != 1 || provider == "google" && matching[0]["id"] != change["oldId"] {
                return Err(providers::remote_error());
            }
            change["newId"] = matching[0]["id"].clone();
        }
        let (account, connection, deltas, next) = (
            owner.clone(),
            mail.clone(),
            changes.clone(),
            catalog.clone(),
        );
        let cached_provider = provider.to_owned();
        app.db(move |db| {
            if connections(&db.settings()?).get(&account) != Some(&connection) {
                return Err(Error::conflict(
                    "The mailbox changed during this provider operation.",
                ));
            }
            update_cache(db, &account, &cached_provider, &deltas, &next)
        })
        .await?;
        let selection = changes
            .iter()
            .find(|c| c["oldId"] == review.plan["sourceId"])
            .map(|c| c["newId"].clone())
            .unwrap_or(json!(""));
        Ok(json!({"accountId":owner,"provider":provider,"folders":catalog,"selectionId":selection,"changes":changes}))
    }
    .await;
    let result = work.map_err(|_|Error::new(502,"The provider change could not be fully confirmed and may already have applied. Refresh the folder list and check your provider before another review; this action will not retry automatically."))?;
    Ok(Some(Json(result).into_response()))
}
