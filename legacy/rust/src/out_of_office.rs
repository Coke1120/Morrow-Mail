//! Provider-managed replies; no local sending, scheduling or settings storage.
use crate::{
    content,
    error::{Error, Result},
    mail, providers,
    service::{App, Context, connections},
    store::string,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/gmail.settings.basic";
pub const MICROSOFT_SCOPE: &str = "MailboxSettings.ReadWrite";

pub fn capability(mail: &Value, owner: &str) -> Value {
    let provider = match string(mail, "provider") {
        "" => "imap",
        value => value,
    };
    let (scope, url) = match provider {
        "google" => (
            GOOGLE_SCOPE,
            Some("https://mail.google.com/mail/u/0/#settings/general"),
        ),
        "microsoft" => (
            MICROSOFT_SCOPE,
            Some("https://outlook.live.com/mail/0/options/mail/automaticReplies"),
        ),
        _ => ("", None),
    };
    let has = |scope: &str| {
        string(mail, "grantedScopes").split_whitespace().any(|v| {
            let lowered = v.to_ascii_lowercase();
            lowered
                .strip_prefix("https://graph.microsoft.com/")
                .unwrap_or(&lowered)
                .eq_ignore_ascii_case(scope)
        })
    };
    let supported = url.is_some();
    let write = supported && has(scope);
    let read = write || provider == "microsoft" && has("MailboxSettings.Read");
    json!({"accountId":owner,"provider":provider,"supported":supported,"canRead":read,"canWrite":write,
        "requiresReconnect":supported && !write,"requiredScope":scope,"providerUrl":url})
}
fn permission() -> Error {
    Error::new(
        403,
        "Reconnect this mailbox with explicit Out of Office settings permission, then refresh. Your existing mail connection is retained.",
    )
}
fn text(body: &Value, key: &str, limit: usize) -> Result<String> {
    let value = body[key]
        .as_str()
        .ok_or_else(|| Error::invalid("Enter plain-text automatic reply fields."))?;
    if value.chars().count() > limit
        || value
            .chars()
            .any(|c| c.is_control() && !['\r', '\n', '\t'].contains(&c))
    {
        return Err(Error::invalid(
            "Automatic reply text is too long or contains unsupported control characters.",
        ));
    }
    Ok(value.replace("\r\n", "\n").replace('\r', "\n"))
}
fn date(value: &Value) -> Result<String> {
    let value = value
        .as_str()
        .ok_or_else(|| Error::invalid("Enter a valid UTC date and time."))?;
    if value.is_empty() {
        return Ok(String::new());
    }
    if !value.starts_with("20") || !value.ends_with('Z') || value.len() < 20 || value.len() > 24 {
        return Err(Error::invalid("Enter a valid UTC date and time."));
    }
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| Error::invalid("Enter a valid UTC date and time."))?;
    let result = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if result.get(..19) != value.get(..19) {
        return Err(Error::invalid("Enter a valid date and time."));
    }
    Ok(result)
}
pub fn provider_payload(provider: &str, body: &Value, now: i64) -> Result<Value> {
    let action = string(body, "action");
    if body["confirmed"] != true || !["save", "disable"].contains(&action) {
        return Err(Error::invalid(
            "Review and confirm Save, Enable or Disable before changing provider settings.",
        ));
    }
    if action == "disable" {
        return Ok(if provider == "google" {
            json!({"enableAutoReply":false})
        } else {
            json!({"automaticRepliesSetting":{"status":"disabled"}})
        });
    }
    let mode = string(body, "mode");
    if !["disabled", "always", "scheduled"].contains(&mode) {
        return Err(Error::invalid("Choose Disabled, Always or Scheduled."));
    }
    let subject = text(body, "subject", 200)?;
    let message = text(body, "message", 10000)?;
    let external = text(body, "externalMessage", 10000)?;
    let audience = string(body, "audience");
    if subject.contains('\n')
        || !["all", "contacts", "none"].contains(&audience)
        || provider == "google" && audience == "none"
        || !body["restrictToDomain"].is_boolean()
    {
        return Err(Error::invalid(
            "Choose a valid reply audience and a single-line subject.",
        ));
    }
    let (start, end) = if mode == "scheduled" {
        (date(&body["start"])?, date(&body["end"])?)
    } else {
        (String::new(), String::new())
    };
    if mode == "scheduled" {
        if (provider == "microsoft" && (start.is_empty() || end.is_empty()))
            || (start.is_empty() && end.is_empty())
        {
            return Err(Error::invalid(
                "Enter the automatic reply schedule. Outlook requires both start and end.",
            ));
        }
        if !start.is_empty() && !end.is_empty() && start >= end {
            return Err(Error::invalid("The end must be after the start."));
        }
        if !end.is_empty()
            && DateTime::parse_from_rfc3339(&end)
                .unwrap()
                .timestamp_millis()
                <= now
        {
            return Err(Error::invalid("Choose an end time in the future."));
        }
    }
    if mode != "disabled"
        && (message.trim().is_empty()
            || provider == "microsoft" && audience != "none" && external.trim().is_empty())
    {
        return Err(Error::invalid(
            "Enter a reply message for each enabled audience.",
        ));
    }
    if provider == "google" {
        let mut payload = json!({"enableAutoReply":mode != "disabled","responseSubject":subject,"responseBodyPlainText":message,
            "restrictToContacts":audience == "contacts","restrictToDomain":body["restrictToDomain"]});
        for (key, value) in [("startTime", start), ("endTime", end)] {
            if !value.is_empty() {
                payload[key] = DateTime::parse_from_rfc3339(&value)
                    .unwrap()
                    .timestamp_millis()
                    .to_string()
                    .into();
            }
        }
        Ok(payload)
    } else {
        let mut payload = json!({"status":match mode {"always"=>"alwaysEnabled", "scheduled"=>"scheduled", _=>"disabled"},
            "internalReplyMessage":content::escape_html(&message).replace('\n',"<br>"),
            "externalReplyMessage":content::escape_html(&external).replace('\n',"<br>"),
            "externalAudience":match audience {"contacts"=>"contactsOnly", "all"=>"all", _=>"none"}});
        if !start.is_empty() {
            payload["scheduledStartDateTime"] =
                json!({"dateTime":start.trim_end_matches('Z'),"timeZone":"UTC"});
            payload["scheduledEndDateTime"] =
                json!({"dateTime":end.trim_end_matches('Z'),"timeZone":"UTC"});
        }
        Ok(json!({"automaticRepliesSetting":payload}))
    }
}
fn revision(raw: &Value) -> String {
    format!("{:x}", Sha256::digest(raw.to_string().as_bytes()))
}
fn provider_date(raw: &Value, google: bool) -> String {
    if google {
        let n = raw
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .or_else(|| raw.as_i64())
            .unwrap_or(0);
        return if n > 0 && n < 4102444800000 {
            DateTime::from_timestamp_millis(n)
                .map(|v| v.to_rfc3339_opts(SecondsFormat::Millis, true))
                .unwrap_or_default()
        } else {
            String::new()
        };
    }
    if !["UTC", "Etc/UTC", "Etc/GMT"].contains(&string(raw, "timeZone")) {
        return String::new();
    }
    DateTime::parse_from_rfc3339(&format!(
        "{}Z",
        string(raw, "dateTime").trim_end_matches('Z')
    ))
    .ok()
    .map(|v| v.to_rfc3339_opts(SecondsFormat::Millis, true))
    .unwrap_or_default()
}
fn projection(mail: &Value, owner: &str, raw: &Value) -> Result<Value> {
    let google = string(mail, "provider") == "google";
    let fields: &[&str] = if google {
        &[
            "responseSubject",
            "responseBodyPlainText",
            "responseBodyHtml",
        ]
    } else {
        &[
            "status",
            "internalReplyMessage",
            "externalReplyMessage",
            "externalAudience",
        ]
    };
    if fields
        .iter()
        .any(|key| raw.get(key).is_some_and(|value| !value.is_string()))
    {
        return Err(Error::new(
            502,
            "The provider returned incomplete automatic reply settings.",
        ));
    }
    let status = string(raw, "status").to_ascii_lowercase();
    if if google {
        !raw["enableAutoReply"].is_boolean()
    } else {
        !["disabled", "alwaysenabled", "scheduled"].contains(&status.as_str())
    } {
        return Err(Error::new(
            502,
            "The provider returned incomplete automatic reply settings.",
        ));
    }
    let start = provider_date(
        &raw[if google {
            "startTime"
        } else {
            "scheduledStartDateTime"
        }],
        google,
    );
    let end = provider_date(
        &raw[if google {
            "endTime"
        } else {
            "scheduledEndDateTime"
        }],
        google,
    );
    let mode = if google {
        if raw["enableAutoReply"] != true {
            "disabled"
        } else if raw.get("startTime").is_some_and(|v| v != "0" && v != 0)
            || raw.get("endTime").is_some_and(|v| v != "0" && v != 0)
        {
            "scheduled"
        } else {
            "always"
        }
    } else {
        match status.as_str() {
            "scheduled" => "scheduled",
            "alwaysenabled" => "always",
            _ => "disabled",
        }
    };
    let warning = if mode == "scheduled"
        && if google {
            start.is_empty() && end.is_empty()
        } else {
            start.is_empty() || end.is_empty()
        } {
        "The provider has a schedule that cannot be edited safely here. Re-enter its dates before saving, or manage it in provider settings. Disable remains available."
    } else {
        ""
    };
    let plain = |key: &str| content::plain_html(string(raw, key));
    let message = if google {
        if !string(raw, "responseBodyHtml").is_empty() {
            plain("responseBodyHtml")?
        } else {
            string(raw, "responseBodyPlainText").to_owned()
        }
    } else {
        plain("internalReplyMessage")?
    };
    let audience = if google {
        if raw["restrictToContacts"] == true {
            "contacts"
        } else {
            "all"
        }
    } else {
        match string(raw, "externalAudience")
            .to_ascii_lowercase()
            .as_str()
        {
            "all" => "all",
            "contactsonly" => "contacts",
            _ => "none",
        }
    };
    let mut result = capability(mail, owner);
    result["revision"] = revision(raw).into();
    result["scheduleWarning"] = warning.into();
    result["settings"] = json!({"mode":mode,"start":start,"end":end,"subject":if google {string(raw,"responseSubject")} else {""},
        "message":message,"externalMessage":if google {String::new()} else {plain("externalReplyMessage")?},
        "audience":audience,"restrictToDomain":google && raw["restrictToDomain"] == true});
    Ok(result)
}
async fn remote(app: &App, mail: &Value, method: Method, body: Option<&Value>) -> Result<Value> {
    let google = string(mail, "provider") == "google";
    let path = if google {
        "/settings/vacation"
    } else if method == Method::GET {
        "/mailboxSettings/automaticRepliesSetting"
    } else {
        "/mailboxSettings"
    };
    let writing = method != Method::GET;
    let mut request = providers::api(&app.0.client, mail, method, path)?;
    if let Some(body) = body {
        request = request.json(body);
    }
    let mut raw = providers::request(request, 128 * 1024).await?;
    if !google && writing {
        raw = raw["automaticRepliesSetting"].take();
    }
    if !raw.is_object() {
        return Err(Error::new(
            502,
            "The provider returned invalid automatic reply settings.",
        ));
    }
    Ok(raw)
}
fn connected(config: &Value, owner: &str) -> Result<Value> {
    if ["", "all", "demo"].contains(&owner) {
        return Err(Error::conflict(
            "Choose an individual connected mailbox using X-Genmail-Account.",
        ));
    }
    connections(config).get(owner).cloned().ok_or_else(|| {
        Error::conflict("Choose an individual connected mailbox using X-Genmail-Account.")
    })
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    if ctx.path != ["out-of-office"] {
        return Ok(None);
    }
    if ctx.method != Method::GET && ctx.method != Method::PUT {
        return Err(Error::new(405, "Use GET or PUT for automatic replies."));
    }
    let _guard = app.0.mailbox.try_lock().map_err(|_| {
        Error::conflict("Another mailbox operation is running. Try again when it finishes.")
    })?;
    let owner = ctx.header("x-genmail-account");
    let initial = connected(&app.settings().await?, owner)?;
    let info = capability(&initial, owner);
    let writing = ctx.method == Method::PUT;
    if info["supported"] != true || info["canRead"] != true {
        if writing {
            return Err(if info["supported"] != true {
                Error::invalid(
                    "IMAP does not support server-managed automatic replies. Use your provider’s webmail settings.",
                )
            } else {
                permission()
            });
        }
        return Ok(Some(Json(info).into_response()));
    }
    if writing && info["canWrite"] != true {
        return Err(permission());
    }
    let mut payload = if writing {
        provider_payload(
            string(&initial, "provider"),
            &ctx.body,
            Utc::now().timestamp_millis(),
        )?
    } else {
        Value::Null
    };
    if writing
        && (string(&ctx.body, "revision").len() != 64
            || !string(&ctx.body, "revision")
                .bytes()
                .all(|b| b.is_ascii_hexdigit()))
    {
        return Err(Error::conflict("Refresh provider settings before saving."));
    }
    let mail = mail::current_mail(app, owner).await?;
    if capability(&mail, owner)[if writing { "canWrite" } else { "canRead" }] != true {
        return Err(permission());
    }
    let current = remote(app, &mail, Method::GET, None)
        .await
        .map_err(|error| {
            if error.provider_status == Some(403) {
                permission()
            } else {
                error
            }
        })?;
    if connected(&app.settings().await?, owner)? != mail {
        return Err(Error::conflict(
            "This mailbox connection changed. Refresh settings.",
        ));
    }
    if !writing {
        return Ok(Some(
            Json(projection(&mail, owner, &current)?).into_response(),
        ));
    }
    if revision(&current) != string(&ctx.body, "revision") {
        return Err(Error::conflict(
            "Provider settings changed since you opened this page. Refresh and review them before saving.",
        ));
    }
    let google = string(&mail, "provider") == "google";
    if google && string(&ctx.body, "action") == "disable" {
        for key in [
            "responseSubject",
            "responseBodyPlainText",
            "responseBodyHtml",
            "restrictToContacts",
            "restrictToDomain",
            "startTime",
            "endTime",
        ] {
            if let Some(value) = current.get(key) {
                payload[key] = value.clone();
            }
        }
    }
    // These settings endpoints do not expose a documented conditional-write revision.
    // Re-read immediately before the provider write and require another review on a conflict.
    if revision(&remote(app, &mail, Method::GET, None).await?) != revision(&current) {
        return Err(Error::conflict(
            "Provider settings changed while you were saving. Refresh and review them before trying again.",
        ));
    }
    let updated = remote(app,&mail,if google { Method::PUT } else { Method::PATCH },Some(&payload)).await
        .map_err(|_| Error::new(502,"The provider change could not be confirmed. Refresh provider settings before retrying; Morrow will not retry automatically."))?;
    if connected(&app.settings().await?, owner)? != mail {
        return Err(Error::conflict(
            "This mailbox connection changed. Refresh provider settings to check the result.",
        ));
    }
    Ok(Some(
        Json(projection(&mail, owner, &updated)?).into_response(),
    ))
}
