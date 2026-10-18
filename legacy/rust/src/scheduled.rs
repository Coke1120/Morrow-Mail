//! Reviewed future sends, using the ordinary delivery and uncertain-send ledger.
use crate::{
    content,
    error::{Error, Result},
    mail, pages,
    service::{App, Context, connections, get_message},
    store::{Store, merge, now, string},
    validation,
};
use axum::{
    Json,
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

const GRACE_MS: i64 = 15 * 60_000;
fn active(job: &Value) -> bool {
    ["scheduled", "sending", "uncertain"].contains(&string(job, "status"))
}
fn jobs(db: &Store) -> Result<Vec<Value>> {
    Ok(db.settings()?["scheduledSends"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}
fn write(db: &Store, values: Vec<Value>) -> Result<()> {
    let mut history: Vec<_> = values.iter().filter(|j| !active(j)).cloned().collect();
    history.sort_by(|a, b| string(b, "updatedAt").cmp(string(a, "updatedAt")));
    history.truncate(100);
    let mut values: Vec<_> = values.into_iter().filter(active).collect();
    values.extend(history);
    db.set_settings(&json!({"scheduledSends":values}))?;
    Ok(())
}
fn owned(db: &Store, owner: &str, id: &str) -> Result<Value> {
    jobs(db)?
        .into_iter()
        .find(|j| j["accountId"] == owner && j["id"] == id)
        .ok_or_else(|| Error::new(404, "Scheduled send not found."))
}
fn real_owner(db: &Store, owner: &str) -> Result<Value> {
    if ["", "all", "demo"].contains(&owner) {
        return Err(Error::conflict("Choose a connected sending mailbox."));
    }
    connections(&db.settings()?)
        .get(owner)
        .cloned()
        .ok_or_else(|| Error::conflict("Choose a connected sending mailbox."))
}
fn error_text(code: &str) -> Option<&'static str> {
    match code {
        "missed" => Some(
            "The scheduled time was missed by more than 15 minutes. Review and schedule a new time.",
        ),
        "connection_changed" => {
            Some("The mailbox connection changed. Review this draft and schedule again.")
        }
        "draft_changed" => Some("The saved draft changed. Review it and schedule again."),
        "uncertain" => Some(
            "Delivery could not be confirmed. Check Sent before explicitly retrying the saved draft; retrying may send a duplicate.",
        ),
        _ => None,
    }
}
fn project(job: &Value) -> Value {
    let mut value = json!({});
    for key in [
        "id",
        "accountId",
        "draftId",
        "sendAt",
        "status",
        "createdAt",
        "updatedAt",
        "claimedAt",
        "sentAt",
        "payload",
        "fromName",
    ] {
        value[key] = job[key].clone();
    }
    value["requestId"] = job["id"].clone();
    value["requiresSendReview"] = (job["status"] == "uncertain").into();
    let error = error_text(string(job, "errorCode"));
    value["error"] = error.unwrap_or_default().into();
    value["errorCode"] = if error.is_some() {
        job["errorCode"].clone()
    } else {
        Value::Null
    };
    value
}
fn result(db: &Store, job: &Value) -> Result<Value> {
    let owner = string(job, "accountId");
    Ok(
        json!({"job":project(job),"message":db.get(owner,string(job,"draftId"))?.map(|m|pages::owned(owner,m)),"appOpenRequired":true,"lateGraceMinutes":15}),
    )
}
pub fn list(db: &Store, owner: &str) -> Result<Value> {
    real_owner(db, owner)?;
    let mut values: Vec<_> = jobs(db)?
        .into_iter()
        .filter(|j| j["accountId"] == owner)
        .map(|j| project(&j))
        .collect();
    values.sort_by(|a, b| string(a, "sendAt").cmp(string(b, "sendAt")));
    Ok(json!({"scheduled":values,"appOpenRequired":true,"lateGraceMinutes":15}))
}
pub fn guard_draft(db: &Store, owner: &str, draft: &str, allowed: Option<&str>) -> Result<()> {
    if draft.is_empty() {
        return Ok(());
    }
    if let Some(job) = jobs(db)?.iter().find(|j| {
        j["accountId"] == owner
            && j["draftId"] == draft
            && ["scheduled", "sending"].contains(&string(j, "status"))
    }) && !(job["status"] == "sending" && allowed == Some(string(job, "id")))
    {
        return Err(Error::conflict(
            "Cancel the scheduled send before editing or sending this draft.",
        ));
    }
    Ok(())
}
pub(crate) fn guard_send(
    db: &Store,
    owner: &str,
    input: &Value,
    allowed: Option<&str>,
) -> Result<()> {
    guard_draft(db, owner, string(input, "draftId"), allowed)?;
    if let Some(job) = jobs(db)?
        .iter()
        .find(|j| j["accountId"] == owner && j["id"] == input["requestId"])
    {
        guard_draft(db, owner, string(job, "draftId"), allowed)?;
    }
    Ok(())
}
pub(crate) fn validate_review(
    db: &Store,
    owner: &str,
    input: &Value,
    reviewed: &Value,
) -> Result<()> {
    let current = owned(db, owner, string(reviewed, "id"))?;
    if current["status"] != "sending"
        || current["payloadHash"] != reviewed["payloadHash"]
        || current["draftId"] != input["draftId"]
        || current["id"] != input["requestId"]
        || mail::fingerprint(input)? != string(&current, "payloadHash")
    {
        return Err(Error::conflict(
            "The scheduled message changed. Review it before sending.",
        ));
    }
    Ok(())
}
pub fn start(db: &Store, owner: &str, input: &Value) -> Result<Value> {
    db.transaction(|db| {
        let connection=real_owner(db,owner)?;
        let fields=input.as_object().ok_or_else(||Error::invalid("Invalid scheduled message."))?;
        if fields.keys().any(|key|!["sendAt","requestId","draftId","to","cc","bcc","subject","body","footer","replyToId","attachments"].contains(&key.as_str())) { return Err(Error::invalid("Invalid scheduled message.")); }
        let id=validation::text(&input["requestId"],"Send request ID",100,false)?;
        if id.len()<8 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-') { return Err(Error::invalid("Invalid send request ID.")); }
        let at=DateTime::parse_from_rfc3339(string(input,"sendAt")).map_err(|_|Error::invalid("Choose a valid send time in UTC."))?;
        if at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis,true)!=string(input,"sendAt") { return Err(Error::invalid("Choose a valid send time in UTC.")); }
        let mut payload=content::content(input,false)?;crate::attachments::resolve(db,owner,&mut payload,false)?;
        let reply=string(input,"replyToId"); payload["replyToId"]=reply.into();
        let hash=mail::fingerprint(&payload)?;
        let draft_id=if string(input,"draftId").is_empty(){format!("outbox:scheduled:{id}")}else{validation::text(&input["draftId"],"Draft ID",8192,false)?.to_owned()};
        let previous=jobs(db)?;
        if let Some(job)=previous.iter().find(|j|j["accountId"]==owner && j["id"]==id) {
            if job["payloadHash"]!=hash || job["sendAt"]!=input["sendAt"] || job["draftId"]!=draft_id { return Err(Error::conflict("This schedule request was already used for different content or time.")); }
            return result(db,job);
        }
        if at.timestamp_millis()<=Utc::now().timestamp_millis() { return Err(Error::invalid("Choose a future send time.")); }
        if previous.iter().filter(|j|active(j)).count()>=200 { return Err(Error::conflict("Review or cancel existing scheduled sends before scheduling more.")); }
        if db.get(owner,&format!("sent:{id}"))?.is_some() { return Err(Error::conflict("This request was already sent. Start a new draft.")); }
        guard_draft(db,owner,&draft_id,None)?;
        if !string(input,"draftId").is_empty() {
            let draft=get_message(db,owner,&draft_id)?;
            if draft["folder"]!="drafts" || draft["providerDraft"]==true { return Err(Error::conflict("Copy provider drafts to a local draft before scheduling.")); }
        }
        let config=db.settings()?;
        if config["deliveryAttempts"].as_array().into_iter().flatten().any(|a|a["account"]==owner && (a["requestId"]==id || a["draftId"]==draft_id)) { return Err(Error::conflict("Review the unconfirmed delivery before scheduling this draft.")); }
        let original=if reply.is_empty(){Value::Null}else{get_message(db,owner,reply)?};
        let date=now();
        let job=json!({"id":id,"accountId":owner,"draftId":draft_id,"sendAt":input["sendAt"],"status":"scheduled","createdAt":date,"updatedAt":date,"connectionId":connection["connectionId"],"payload":payload,"payloadHash":hash,"fromName":string(&config["preferences"],"displayName"),"replyMessageId":string(&original,"messageId").replace(['\r','\n'],"")});
        db.upsert(owner,&mail::outgoing(&config,owner,&payload,&json!({"id":draft_id,"folder":"drafts","fromName":job["fromName"],"scheduledSend":{"id":id,"sendAt":job["sendAt"],"status":"scheduled"}})))?;
        let mut next=previous;next.push(job.clone());write(db,next)?;result(db,&job)
    })
}
pub fn cancel(db: &Store, owner: &str, id: &str) -> Result<Value> {
    db.transaction(|db| {
        real_owner(db, owner)?;
        let job = owned(db, owner, id)?;
        if job["status"] == "cancelled" {
            return result(db, &job);
        }
        if !["scheduled", "missed", "blocked"].contains(&string(&job, "status")) {
            return Err(Error::conflict(
                "This send has already started. Check Sent and review its delivery status.",
            ));
        }
        finish(db, &job, "cancelled", None)?;
        result(db, &owned(db, owner, id)?)
    })
}
pub(crate) fn resolve_delivery(db: &Store, owner: &str, request: &str) -> Result<()> {
    if let Some(job) = jobs(db)?
        .into_iter()
        .find(|j| j["accountId"] == owner && j["id"] == request)
    {
        if job["status"] != "uncertain" {
            return Err(Error::conflict(
                "Refresh Outbox before closing this delivery.",
            ));
        }
        finish(db, &job, "resolved", None)?;
    }
    Ok(())
}
fn finish(db: &Store, job: &Value, status: &str, error: Option<&str>) -> Result<()> {
    db.transaction(|db| {
        let mut patch = json!({"status":status,"errorCode":error,"updatedAt":now()});
        if status == "sent" {
            patch["sentAt"] = now().into();
        }
        write(
            db,
            jobs(db)?
                .into_iter()
                .map(|item| {
                    if item["accountId"] == job["accountId"] && item["id"] == job["id"] {
                        merge(item, &patch)
                    } else {
                        item
                    }
                })
                .collect(),
        )?;
        mark_draft(db, job, status)
    })
}
fn mark_draft(db: &Store, job: &Value, status: &str) -> Result<()> {
    if let Some(mut draft) = db.get(string(job, "accountId"), string(job, "draftId"))? {
        draft["scheduledSend"] = json!({"id":job["id"],"sendAt":job["sendAt"],"status":status});
        db.upsert(string(job, "accountId"), &draft)?;
    }
    Ok(())
}
fn confirmed(db: &Store, job: &Value) -> Result<bool> {
    Ok(db
        .get(
            string(job, "accountId"),
            &format!("sent:{}", string(job, "id")),
        )?
        .is_some_and(|sent| {
            mail::fingerprint(&sent).is_ok_and(|hash| hash == string(job, "payloadHash"))
        }))
}
fn reconcile(db: &Store, job: &Value) -> Result<()> {
    if confirmed(db, job)? {
        return finish(db, job, "sent", None);
    }
    let config = db.settings()?;
    let owner = string(job, "accountId");
    let mut attempts = config["deliveryAttempts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !attempts.iter().any(|a| {
        a["account"] == owner && (a["requestId"] == job["id"] || a["draftId"] == job["draftId"])
    }) {
        attempts.push(json!({"account":owner,"requestId":job["id"],"draftId":job["draftId"],"payloadHash":job["payloadHash"],"createdAt":job.get("claimedAt").cloned().unwrap_or(json!(now()))}));
        db.set_settings(&json!({"deliveryAttempts":attempts}))?;
    }
    db.upsert(owner,&mail::outgoing(&config,owner,&job["payload"],&json!({"id":job["draftId"],"folder":"drafts","fromName":job["fromName"],"deliveryStatus":"unconfirmed","deliveryRequestId":job["id"]})))?;
    finish(db, job, "uncertain", Some("uncertain"))
}
pub fn recover(db: &Store) -> Result<()> {
    db.transaction(|db| {
        for job in jobs(db)? {
            if job["status"] == "sending" {
                reconcile(db, &job)?;
            } else if job["status"] == "uncertain" && confirmed(db, &job)? {
                finish(db, &job, "sent", None)?;
            }
        }
        Ok(())
    })
}
pub async fn tick(app: &App) -> Result<()> {
    let Ok(_gate) = app.0.mailbox.try_lock() else {
        return Ok(());
    };
    app.db(|db| db.transaction(recover)).await?;
    loop {
        let next = app
            .db(|db| {
                db.transaction(|db| {
                    let timestamp = Utc::now().timestamp_millis();
                    let job = jobs(db)?
                        .into_iter()
                        .filter(|j| {
                            j["status"] == "scheduled"
                                && DateTime::parse_from_rfc3339(string(j, "sendAt"))
                                    .is_ok_and(|t| t.timestamp_millis() <= timestamp)
                        })
                        .min_by(|a, b| string(a, "sendAt").cmp(string(b, "sendAt")));
                    let Some(job) = job else {
                        return Ok(None);
                    };
                    let at = DateTime::parse_from_rfc3339(string(&job, "sendAt"))
                        .map_err(|_| Error::invalid("Invalid scheduled time."))?;
                    if timestamp - at.timestamp_millis() > GRACE_MS {
                        finish(db, &job, "missed", Some("missed"))?;
                        return Ok(Some(None));
                    }
                    let config = db.settings()?;
                    let owner = string(&job, "accountId");
                    let connections = connections(&config);
                    if connections
                        .get(owner)
                        .is_none_or(|mail| mail["connectionId"] != job["connectionId"])
                    {
                        finish(db, &job, "blocked", Some("connection_changed"))?;
                        return Ok(Some(None));
                    }
                    let valid = db
                        .get(owner, string(&job, "draftId"))?
                        .is_some_and(|draft| {
                            draft["folder"] == "drafts"
                                && draft["providerDraft"] != true
                                && mail::fingerprint(&draft)
                                    .is_ok_and(|hash| hash == string(&job, "payloadHash"))
                        });
                    if !valid {
                        finish(db, &job, "blocked", Some("draft_changed"))?;
                        return Ok(Some(None));
                    }
                    let claimed = merge(
                        job.clone(),
                        &json!({"status":"sending","claimedAt":now(),"updatedAt":now()}),
                    );
                    write(
                        db,
                        jobs(db)?
                            .into_iter()
                            .map(|j| {
                                if j["accountId"] == job["accountId"] && j["id"] == job["id"] {
                                    claimed.clone()
                                } else {
                                    j
                                }
                            })
                            .collect(),
                    )?;
                    mark_draft(db, &job, "sending")?;
                    Ok(Some(Some(claimed)))
                })
            })
            .await?;
        let job = match next {
            None => return Ok(()),
            Some(None) => continue,
            Some(Some(job)) => job,
        };
        let context = Context {
            method: Method::POST,
            path: vec!["send".into()],
            body: merge(
                job["payload"].clone(),
                &json!({"requestId":job["id"],"draftId":job["draftId"]}),
            ),
            query: json!({}),
            headers: HeaderMap::new(),
            owner: string(&job, "accountId").to_owned(),
            paged: true,
        };
        let _ = mail::send_locked(app, &context, Some(job.clone())).await;
        app.db(move |db| db.transaction(|db| reconcile(db, &job)))
            .await?;
    }
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if ctx.path.first().is_none_or(|p| p != "scheduled") {
        return Ok(None);
    }
    let ctx = ctx.clone();
    let _gate = if ctx.method != Method::GET {
        Some(app.0.mailbox.try_lock().map_err(|_| {
            Error::conflict("Another mailbox operation is running. Try again when it finishes.")
        })?)
    } else {
        None
    };
    let result = app
        .db(move |db| {
            let owner = ctx.read_owner(&db.settings()?, false)?;
            match (ctx.method.as_str(), ctx.path.len()) {
                ("GET", 1) => list(db, &owner),
                ("POST", 1) => start(db, &owner, &ctx.body),
                ("POST", 3) if ctx.path[2] == "cancel" => cancel(db, &owner, &ctx.path[1]),
                _ => Err(Error::new(404, "Scheduled send route not found.")),
            }
        })
        .await?;
    Ok(Some(Json(result).into_response()))
}
