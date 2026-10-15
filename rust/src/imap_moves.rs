//! Durable, owner-bound recovery for reviewed UIDPLUS moves on non-MOVE servers.
//! Only an explicit request can advance a write stage; restart never replays it.
use crate::{
    error::{Error, Result},
    imap::{MoveSession, Presence},
    service::{App, Context, connections},
    store::{Store, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

const UNRESOLVED_LIMIT: usize = 100;
const HISTORY_LIMIT: usize = 20;
const WRITE_BUDGET: Duration = Duration::from_secs(45);
const REVIEW_MILLIS: i64 = 5 * 60 * 1000;

pub(crate) fn connection_ref(mail: &Value) -> Result<String> {
    Ok(
        URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&json!([
            "imap-move-connection-v1",
            mail
        ]))?)),
    )
}

fn unfinished(record: &Value) -> bool {
    !matches!(string(record, "stage"), "completed" | "resolved")
}
fn records(config: &Value, owner: &str) -> Vec<Value> {
    config["imapMoveJournal"][owner]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn find(config: &Value, owner: &str, id: &str) -> Result<Value> {
    records(config, owner)
        .into_iter()
        .find(|record| record["id"] == id && record["accountId"] == owner)
        .ok_or_else(|| Error::new(404, "Move recovery record not found for this mailbox."))
}
fn source(message: &Value) -> Value {
    json!({"id":message["id"],"remoteId":message["remoteId"].as_str().filter(|value|!value.is_empty()).unwrap_or(string(message,"id")),"imapOrigin":message["imapOrigin"],
        "providerFolderId":message["providerFolderId"].as_str().filter(|value| !value.is_empty()).unwrap_or("INBOX"),
        "folder":message["folder"],"localOverrides":{"folder":message["localOverrides"]["folder"]}})
}
fn destination(value: &Value) -> Value {
    json!({"id":value["id"],"name":value["name"],"kind":value["kind"]})
}
fn mapping(record: &Value) -> Result<(u32, u32)> {
    let fields = record["mapping"]
        .as_array()
        .filter(|values| values.len() == 2)
        .ok_or_else(|| {
            Error::conflict(
                "The copy destination was not confirmed. Review this move in your provider.",
            )
        })?;
    let number = |value: &Value| {
        value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                Error::conflict(
                    "The copy destination was not confirmed. Review this move in your provider.",
                )
            })
    };
    Ok((number(&fields[0])?, number(&fields[1])?))
}
fn patch(record: &Value) -> Result<Value> {
    let (validity, uid) = mapping(record)?;
    let target = &record["destination"];
    Ok(
        json!({"remoteId":format!("imap:{validity}:{uid}"),"providerFolderId":target["id"],
        "providerFolderName":target["name"],"providerDeleted":false,"providerFolderMissing":false,
        "localFolderUndo":null,
        "imapModseq":null,"imapSyncConnection":null,"imapSyncEpoch":null,
        "folder":match string(target,"kind") { "inbox"=>"inbox", "trash"=>"trash", _=>"archive" }}),
    )
}

fn require_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(Error::conflict(
            "The reviewed move expired. Inspect its recovery record before continuing.",
        ))
    } else {
        Ok(())
    }
}
fn require_connection(config: &Value, record: &Value) -> Result<Value> {
    let owner = string(record, "accountId");
    let mail = connections(config)
        .get(owner)
        .cloned()
        .ok_or_else(|| Error::conflict("Reconnect this mailbox before checking its move."))?;
    if connection_ref(&mail)? != record["connectionRef"] {
        return Err(Error::conflict(
            "This mailbox connection changed. Review the saved move in its original provider.",
        ));
    }
    crate::imap_identity::require(&mail, &record["source"])?;
    Ok(mail)
}
fn require_source(db: &Store, record: &Value) -> Result<Value> {
    let current = db
        .get(string(record, "accountId"), string(&record["source"], "id"))?
        .ok_or_else(|| {
            Error::conflict(
                "The original cached message is unavailable. Review this move in your provider.",
            )
        })?;
    if source(&current) != record["source"] {
        return Err(Error::conflict(
            "The cached message changed. Review this move in your provider.",
        ));
    }
    Ok(current)
}
async fn initial_current(
    app: &App,
    mail: &Value,
    message: &Value,
    deadline: Instant,
) -> Result<()> {
    let (mail, message) = (mail.clone(), message.clone());
    app.db(move |db| {
        require_deadline(deadline)?;
        if connections(&db.settings()?).get(string(&mail, "email")) != Some(&mail) {
            return Err(Error::conflict("This mailbox connection changed."));
        }
        crate::imap_identity::require(&mail, &message)?;
        let proof = json!({"accountId": mail["email"], "source": source(&message)});
        require_source(db, &proof)?;
        ensure_clear(db, &mail, &message)
    })
    .await
}
fn target_available(db: &Store, record: &Value) -> Result<bool> {
    let Ok((validity, uid)) = mapping(record) else {
        return Ok(false);
    };
    let exists: bool = db.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE account=? AND id!=? AND json_extract(data,'$.imapOrigin')=? AND COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id)=? AND COALESCE(NULLIF(json_extract(data,'$.providerFolderId'),''),'INBOX')=?)",
        rusqlite::params![string(record,"accountId"),string(&record["source"],"id"),string(&record["source"],"imapOrigin"),format!("imap:{validity}:{uid}"),string(&record["destination"],"id")], |row|row.get(0))?;
    Ok(!exists)
}
fn require_current(db: &Store, expected: &Value, deadline: Instant) -> Result<Value> {
    require_deadline(deadline)?;
    let config = db.settings()?;
    if find(
        &config,
        string(expected, "accountId"),
        string(expected, "id"),
    )? != *expected
    {
        return Err(Error::conflict(
            "This move recovery record changed. Refresh it before continuing.",
        ));
    }
    let mail = require_connection(&config, expected)?;
    require_source(db, expected)?;
    Ok(mail)
}
fn replace(db: &Store, expected: &Value, mut next: Value) -> Result<Value> {
    let config = db.settings()?;
    let owner = string(expected, "accountId");
    let mut all = records(&config, owner);
    let entry = all
        .iter_mut()
        .find(|record| record["id"] == expected["id"])
        .ok_or_else(|| {
            Error::conflict("This move recovery record changed. Refresh it before continuing.")
        })?;
    if *entry != *expected {
        return Err(Error::conflict(
            "This move recovery record changed. Refresh it before continuing.",
        ));
    }
    next["operationRef"] = uuid::Uuid::new_v4().to_string().into();
    next["updatedAt"] = now().into();
    *entry = next.clone();
    let mut completed = 0usize;
    all.reverse();
    all.retain(|record| {
        unfinished(record) || {
            completed += 1;
            completed <= HISTORY_LIMIT
        }
    });
    all.reverse();
    crate::background::write_owner(db, "imapMoveJournal", owner, json!(all))?;
    Ok(next)
}

pub(crate) fn unresolved(owner: &str, id: &str) -> Error {
    let mut error = Error::new(
        409,
        "This non-atomic IMAP move needs review. There may be two copies or an unconfirmed source removal. Open Move recovery before attempting another move.",
    );
    error.body["code"] = "imap_move_unresolved".into();
    error.body["accountId"] = owner.into();
    error.body["operationId"] = id.into();
    error
}
pub(crate) fn ensure_clear(db: &Store, mail: &Value, message: &Value) -> Result<()> {
    let owner = string(mail, "email");
    let current = source(message);
    for record in records(&db.settings()?, owner)
        .iter()
        .filter(|record| unfinished(record))
    {
        let original = &record["source"];
        let same = original["imapOrigin"] == current["imapOrigin"]
            && (original["id"] == current["id"]
                || original["remoteId"] == current["remoteId"]
                    && original["providerFolderId"] == current["providerFolderId"]);
        let target = mapping(record).is_ok_and(|(validity, uid)| {
            original["imapOrigin"] == current["imapOrigin"]
                && current["remoteId"] == format!("imap:{validity}:{uid}")
                && current["providerFolderId"] == record["destination"]["id"]
        });
        if same || target {
            return Err(unresolved(owner, string(record, "id")));
        }
    }
    Ok(())
}

async fn advance(
    app: &App,
    record: &Value,
    stage: &str,
    confirmed: Option<(u32, u32)>,
    deadline: Instant,
) -> Result<Value> {
    let (record, stage) = (record.clone(), stage.to_owned());
    app.db(move |db| {
        db.transaction(|db| {
            require_current(db, &record, deadline)?;
            let mut next = record.clone();
            next["stage"] = stage.into();
            next["review"] = Value::Null;
            if let Some((validity, uid)) = confirmed {
                next["mapping"] = json!([validity, uid]);
            }
            replace(db, &record, next)
        })
    })
    .await
}
async fn check_current(app: &App, record: &Value, deadline: Instant) -> Result<()> {
    let record = record.clone();
    app.db(move |db| {
        require_current(db,&record,deadline)?;
        if mapping(&record).is_ok() && !target_available(db,&record)? {
            return Err(Error::conflict("The destination already has another cached copy. Review both copies in your provider; Morrow will not merge their local data."));
        }
        Ok(())
    }).await
}
async fn remove_source(
    app: &App,
    session: &mut MoveSession,
    mut record: Value,
    deadline: Instant,
    allow_removal: bool,
) -> Result<Value> {
    let mapped = mapping(&record)?;
    check_current(app, &record, deadline).await?;
    let mut state = session.verify(mapped, true).await?;
    if !state.destination {
        return Err(Error::conflict(
            "The confirmed destination copy is unavailable. No further removal was attempted.",
        ));
    }
    if state.source && !allow_removal {
        return Err(Error::conflict(
            "The source is present again. Check the provider and review a new removal confirmation.",
        ));
    }
    if state.source {
        if !state.source_deleted {
            record = advance(app, &record, "delete_pending", None, deadline).await?;
            session.mark_deleted().await?;
            record = advance(app, &record, "delete_confirmed", None, deadline).await?;
        }
        check_current(app, &record, deadline).await?;
        state = session.verify(mapped, true).await?;
        if !state.destination || state.source && !state.source_deleted {
            return Err(Error::conflict(
                "The provider copies changed. Review the move before removing anything else.",
            ));
        }
        if state.source {
            record = advance(app, &record, "expunge_pending", None, deadline).await?;
            session.expunge().await?;
        }
    }
    check_current(app, &record, deadline).await?;
    state = session.verify(mapped, false).await?;
    if state.source || !state.destination {
        return Err(Error::conflict(
            "The final provider move could not be confirmed.",
        ));
    }
    advance(app, &record, "provider_complete", None, deadline).await
}

/// Caller owns the mailbox gate and has reviewed the destination. Tests supply
/// a private loopback root; normal service callers pass no TLS override.
pub async fn organize_with_tls(
    app: &App,
    mail: &Value,
    message: &Value,
    target: &Value,
    mode: &str,
    connector: Option<&native_tls::TlsConnector>,
) -> Result<(Value, Option<String>)> {
    if !["move", "restoreTrash"].contains(&mode) {
        return Err(Error::invalid("IMAP supports folder moves."));
    }
    let deadline = Instant::now() + WRITE_BUDGET;
    let id = uuid::Uuid::new_v4().to_string();
    let created = Arc::new(AtomicBool::new(false));
    let work = async {
        initial_current(app, mail, message, deadline).await?;
        let owned;
        let tls = if let Some(connector) = connector {
            connector
        } else {
            owned = native_tls::TlsConnector::new()
                .map_err(|_| Error::new(502, "The provider connection could not be prepared."))?;
            &owned
        };
        let mut session = MoveSession::open(mail, message, target, tls).await?;
        if session.native || session.source == session.target {
            initial_current(app, mail, message, deadline).await?;
            let mapped = if session.source == session.target {
                (session.validity, session.uid)
            } else {
                session.native_move().await?
            };
            return Ok((
                patch(&json!({"mapping":[mapped.0,mapped.1],"destination":destination(target)}))?,
                None,
            ));
        }
        let owner = string(mail, "email").to_owned();
        let record = json!({"id":id,"operationRef":uuid::Uuid::new_v4().to_string(),"accountId":owner,
            "connectionRef":connection_ref(mail)?,"source":source(message),"destination":destination(target),
            "stage":"copy_pending","mapping":null,"review":null,"createdAt":now(),"updatedAt":now()});
        let (saved, original, reserved, created) = (
            mail.clone(),
            message.clone(),
            record.clone(),
            created.clone(),
        );
        app.db(move |db| {
            db.transaction(|db| {
                require_deadline(deadline)?;
                let config=db.settings()?;
                if connections(&config).get(string(&saved,"email")) != Some(&saved) { return Err(Error::conflict("This mailbox connection changed.")); }
                ensure_clear(db,&saved,&original)?;
                require_source(db,&reserved)?;
                let pending=config["imapMoveJournal"].as_object().into_iter().flat_map(|owners|owners.values())
                    .flat_map(|items|items.as_array().into_iter().flatten()).filter(|record|unfinished(record)).count();
                if pending>=UNRESOLVED_LIMIT {
                    let mut error=Error::conflict("Review an existing unfinished IMAP move before starting another. No provider move was attempted.");
                    error.body["code"]="imap_move_journal_full".into();return Err(error);
                }
                let owner=string(&reserved,"accountId");
                let mut all=records(&config,owner); all.push(reserved.clone());
                crate::background::write_owner(db,"imapMoveJournal",owner,json!(all))
            })?;
            created.store(true,Ordering::Release);
            Ok(())
        }).await?;
        session.prepare_copy().await?;
        check_current(app, &record, deadline).await?;
        let mapped = session.copy().await?;
        let record = advance(app, &record, "copy_confirmed", Some(mapped), deadline).await?;
        let record = remove_source(app, &mut session, record, deadline, true).await?;
        Ok((patch(&record)?, Some(id.clone())))
    };
    let result = tokio::time::timeout_at(deadline, work)
        .await
        .unwrap_or_else(|_| {
            Err(Error::new(
                502,
                "The provider move deadline expired. Check the provider before retrying.",
            ))
        });
    if result.is_err() && created.load(Ordering::Acquire) {
        Err(unresolved(string(mail, "email"), &id))
    } else {
        result
    }
}

/// Called inside the same Store transaction as the final cached-message update.
fn complete(db: &Store, owner: &str, id: &str) -> Result<()> {
    let record = find(&db.settings()?, owner, id)?;
    require_connection(&db.settings()?, &record)?;
    if record["stage"] != "provider_complete" {
        return Err(unresolved(owner, id));
    }
    if !target_available(db, &record)? {
        return Err(unresolved(owner, id));
    }
    let moved = db
        .get(owner, string(&record["source"], "id"))?
        .ok_or_else(|| unresolved(owner, id))?;
    let expected = patch(&record)?;
    if moved["remoteId"] != expected["remoteId"]
        || moved["providerFolderId"] != expected["providerFolderId"]
        || moved["imapOrigin"] != record["source"]["imapOrigin"]
    {
        return Err(unresolved(owner, id));
    }
    let mut next = record.clone();
    next["stage"] = "completed".into();
    next["completedAt"] = now().into();
    next["review"] = Value::Null;
    replace(db, &record, next)?;
    Ok(())
}

/// Atomically adopt an already confirmed provider result. This never performs
/// provider I/O and cannot turn an uncertain stage into a completed move.
pub fn apply_confirmed(db: &Store, owner: &str, id: &str) -> Result<Value> {
    db.transaction(|db| {
        let record = find(&db.settings()?, owner, id)?;
        require_connection(&db.settings()?, &record)?;
        let current = require_source(db, &record)?;
        if record["stage"] != "provider_complete" || !target_available(db, &record)? {
            return Err(unresolved(owner, id));
        }
        let mut changes = patch(&record)?;
        changes["localOverrides"] = Value::Object(
            current["localOverrides"]
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        changes["localOverrides"]["folder"] = false.into();
        let message = db
            .update(owner, string(&record["source"], "id"), &changes)?
            .ok_or_else(|| unresolved(owner, id))?;
        complete(db, owner, id)?;
        Ok(message)
    })
}

fn diagnostic(stage: &str) -> (&'static str, &'static str, &'static str) {
    match stage {
        "copy_pending" => (
            "uncertain",
            "copy_unconfirmed",
            "The copy result is unknown. A destination copy may exist. No automatic retry or source removal will run.",
        ),
        "copy_confirmed" => (
            "partial",
            "copy_confirmed",
            "The destination copy was confirmed. The original may remain; this multi-step move is not atomic.",
        ),
        "delete_pending" => (
            "uncertain",
            "delete_flag_unconfirmed",
            "The destination copy was confirmed, but the source deletion flag was not confirmed. Review both copies.",
        ),
        "delete_confirmed" => (
            "partial",
            "delete_flag_confirmed",
            "The source was marked for deletion, but its final removal was not confirmed. Review both folders.",
        ),
        "expunge_pending" => (
            "uncertain",
            "source_removal_unconfirmed",
            "The source removal result is unknown. Check the exact recorded copies before continuing.",
        ),
        "provider_complete" => (
            "providerComplete",
            "local_result_pending",
            "The provider move was confirmed. Its local cached result still needs review.",
        ),
        "completed" => (
            "completed",
            "completed",
            "The provider move and its local cached result were confirmed.",
        ),
        "resolved" => (
            "resolved",
            "reviewed_externally",
            "You marked this move reviewed in your provider. This action made no provider change and does not certify a successful move.",
        ),
        _ => (
            "uncertain",
            "unknown_stage",
            "The saved move state needs review in your provider. It will not be replayed.",
        ),
    }
}
fn review_current(record: &Value) -> bool {
    record["review"]["at"].as_i64().is_some_and(|at| {
        let elapsed = chrono::Utc::now().timestamp_millis().saturating_sub(at);
        (0..=REVIEW_MILLIS).contains(&elapsed)
    }) && !string(&record["review"], "ref").is_empty()
}
fn projection(db: &Store, config: &Value, record: &Value) -> Result<Value> {
    let (status, code, diagnostic) = diagnostic(string(record, "stage"));
    let message = db.get(string(record, "accountId"), string(&record["source"], "id"))?;
    let current = unfinished(record)
        && require_connection(config, record).is_ok()
        && require_source(db, record).is_ok();
    let available = target_available(db, record)?;
    let finish = if current
        && available
        && review_current(record)
        && record["review"]["destination"] == true
    {
        if record["review"]["source"] == true {
            json!("completeMove")
        } else {
            json!("applyConfirmedResult")
        }
    } else {
        Value::Null
    };
    Ok(
        json!({"id":record["id"],"operationRef":record["operationRef"],"accountId":record["accountId"],
        "connectionRef":record["connectionRef"],"messageId":record["source"]["id"],
        "subject":message.as_ref().map(|message|string(message,"subject")).unwrap_or(""),
        "sourceName":record["source"]["providerFolderId"],"targetName":record["destination"]["name"],
        "stage":record["stage"],"status":status,"createdAt":record["createdAt"],"updatedAt":record["updatedAt"],
        "diagnosticCode":if current && mapping(record).is_ok() && !available {"cached_destination_conflict"}else{code},
        "diagnostic":if current && mapping(record).is_ok() && !available {"Another cached copy already represents the destination. Review both copies in your provider; Morrow will not merge or delete their local data."}else{diagnostic},
        "canPreview":current && available && mapping(record).is_ok(),"canResolve":unfinished(record),
        "canFinish":!finish.is_null(),"finishAction":finish,
        "reviewRef":if review_current(record){record["review"]["ref"].clone()}else{Value::Null},"automaticRetry":false}),
    )
}
fn envelope(db: &Store, owner: &str, record: &Value) -> Result<Value> {
    let config = db.settings()?;
    let current = connections(&config)
        .get(owner)
        .cloned()
        .unwrap_or(Value::Null);
    Ok(
        json!({"accountId":owner,"connectionRef":connection_ref(&current)?,"operation":projection(db,&config,record)?}),
    )
}
fn require_reference(record: &Value, reference: &str) -> Result<()> {
    if reference.is_empty() || record["operationRef"] != reference {
        Err(Error::conflict(
            "This move recovery snapshot changed. Refresh it before continuing.",
        ))
    } else {
        Ok(())
    }
}

pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    handle_with_tls(app, ctx, None).await
}

/// Same owner-bound route implementation; only loopback fixtures supply a root.
pub async fn handle_with_tls(
    app: &App,
    ctx: &Context,
    connector: Option<&native_tls::TlsConnector>,
) -> Result<Option<Response>> {
    let parts = ctx.path.iter().map(String::as_str).collect::<Vec<_>>();
    if !matches!(
        parts.as_slice(),
        ["mail", "moves"] | ["mail", "moves", _, _]
    ) {
        return Ok(None);
    }
    let config = app.settings().await?;
    let owner = ctx.read_owner(&config, false)?;
    if owner == "demo" {
        return Err(Error::conflict("Choose a connected mailbox."));
    }
    if ctx.method == "GET" && parts.len() == 2 {
        let result=app.db(move |db| {
            let config=db.settings()?; let current=connections(&config).get(&owner).cloned().unwrap_or(Value::Null);
            let all=records(&config,&owner); let mut operations=Vec::new();
            for record in all.iter().rev().take(UNRESOLVED_LIMIT+HISTORY_LIMIT) {operations.push(projection(db,&config,record)?);}
            Ok(json!({"accountId":owner,"connectionRef":connection_ref(&current)?,"operations":operations}))
        }).await?;
        return Ok(Some(Json(result).into_response()));
    }
    if ctx.method != "POST" || parts.len() != 4 {
        return Err(Error::new(404, "Move recovery action not found."));
    }
    let _gate = app
        .0
        .mailbox
        .try_lock()
        .map_err(|_| Error::conflict("Another mailbox operation is running."))?;
    let (id, action, body) = (parts[2].to_owned(), parts[3].to_owned(), ctx.body.clone());
    let deadline = Instant::now() + WRITE_BUDGET;
    let owned = owner.clone();
    let lookup = id.clone();
    let input = body.clone();
    let record = app
        .db(move |db| {
            let record = find(&db.settings()?, &owned, &lookup)?;
            require_reference(&record, string(&input, "operationRef"))?;
            if !unfinished(&record) {
                return Err(Error::conflict(
                    "This move record is already completed or resolved.",
                ));
            }
            Ok(record)
        })
        .await?;
    let result = match action.as_str() {
        "resolve" => {
            if body["confirmed"] != true || body["resolution"] != "reviewedExternally" {
                return Err(Error::invalid(
                    "Confirm that you reviewed and resolved this move in your provider. This action only updates the local record.",
                ));
            }
            app.db(move |db| {
                db.transaction(|db| {
                    let mut next = record.clone();
                    next["stage"] = "resolved".into();
                    next["resolution"] = "reviewedExternally".into();
                    next["review"] = Value::Null;
                    let next = replace(db, &record, next)?;
                    envelope(db, &owner, &next)
                })
            })
            .await?
        }
        "preview" | "finish" => {
            let finish = action == "finish";
            let allow_removal = record["review"]["source"] == true;
            if finish
                && (body["confirmed"] != true
                    || !review_current(&record)
                    || string(&body, "reviewRef").is_empty()
                    || record["review"]["ref"] != body["reviewRef"]
                    || record["review"]["destination"] != true)
            {
                return Err(Error::invalid(
                    "Check the provider copies and confirm this exact recovery action first.",
                ));
            }
            let saved = record.clone();
            let (mail,mut record)=app.db(move |db| db.transaction(|db| {
                let mail=require_current(db,&saved,deadline)?;
                mapping(&saved)?;
                if finish && !target_available(db,&saved)? {return Err(Error::conflict("Another cached copy already represents the destination. Review this move in your provider."));}
                let mut next=saved.clone();next["review"]=Value::Null;
                Ok((mail,replace(db,&saved,next)?))
            })).await?;
            let error_owner = owner.clone();
            let error_id = id.clone();
            let work = async {
                let owned;
                let tls = if let Some(connector) = connector {
                    connector
                } else {
                    owned = native_tls::TlsConnector::new().map_err(|_| {
                        Error::new(502, "The provider connection could not be prepared.")
                    })?;
                    &owned
                };
                let mut session =
                    MoveSession::recovery(&mail, &record["source"], &record["destination"], tls)
                        .await?;
                check_current(app, &record, deadline).await?;
                if finish {
                    record =
                        remove_source(app, &mut session, record, deadline, allow_removal).await?;
                    app.db(move |db| {
                        db.transaction(|db| {
                            require_current(db, &record, deadline)?;
                            if !target_available(db, &record)? {
                                return Err(unresolved(&owner, &id));
                            }
                            let message = apply_confirmed(db, &owner, &id)?;
                            let latest = find(&db.settings()?, &owner, &id)?;
                            let mut value = envelope(db, &owner, &latest)?;
                            value["message"] = crate::pages::owned(&owner, message);
                            Ok(value)
                        })
                    })
                    .await
                } else {
                    let Presence {
                        source,
                        source_deleted,
                        destination,
                    } = session.verify(mapping(&record)?, false).await?;
                    app.db(move |db| db.transaction(|db| {
                        require_current(db,&record,deadline)?;
                        let mut next=record.clone();next["review"]=json!({"ref":uuid::Uuid::new_v4().to_string(),"at":chrono::Utc::now().timestamp_millis(),"source":source,"sourceDeleted":source_deleted,"destination":destination});
                        let next=replace(db,&record,next)?;envelope(db,&owner,&next)
                    })).await
                }
            };
            let result = tokio::time::timeout_at(deadline,work).await
                .unwrap_or_else(|_|Err(Error::new(502,"The provider check expired. Refresh the recovery record before another explicitly reviewed attempt.")));
            result.map_err(|error| {
                if finish {
                    unresolved(&error_owner, &error_id)
                } else {
                    error
                }
            })?
        }
        _ => return Err(Error::new(404, "Move recovery action not found.")),
    };
    Ok(Some(Json(result).into_response()))
}
