use crate::{
    content,
    error::{Error, Result},
    store::{merge, random_bytes, string},
    validation,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, SecondsFormat, Utc};
use mail_parser::MessageParser;
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::Duration,
};

pub struct Definition {
    pub authorize: &'static str,
    pub token: &'static str,
    pub api: &'static str,
    // Read/send fallback for older connections without recorded OAuth scopes.
    pub scope: &'static str,
    pub organize: &'static str,
    pub calendar: &'static str,
}
pub fn definition(provider: &str) -> Result<Definition> {
    match provider {
        "google" => Ok(Definition {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth",
            token: "https://oauth2.googleapis.com/token",
            api: "https://gmail.googleapis.com/gmail/v1/users/me",
            scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            organize: "openid email https://www.googleapis.com/auth/gmail.modify",
            calendar: "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events",
        }),
        "microsoft" => Ok(Definition {
            authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            api: "https://graph.microsoft.com/v1.0/me",
            scope: "offline_access User.Read Mail.Read Mail.Send",
            organize: "offline_access User.Read Mail.ReadWrite Mail.Send",
            calendar: "offline_access User.Read Calendars.ReadWrite",
        }),
        _ => Err(Error::invalid("Unsupported provider.")),
    }
}
pub fn remote_error() -> Error {
    Error::new(
        502,
        "The provider request could not be confirmed. Check your connection or reconnect this account.",
    )
}
fn network_error() -> Error {
    let mut error = remote_error();
    error.body["code"] = "provider_network".into();
    error
}
pub async fn request(request: RequestBuilder, limit: usize) -> Result<Value> {
    request_kind(request, limit, false).await
}
async fn request_kind(request: RequestBuilder, limit: usize, oauth: bool) -> Result<Value> {
    let response = request.send().await.map_err(|_| network_error())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut error = Error::new(
            502,
            match status {
                401 => "Authorization expired. Reconnect this account.",
                429 => "The provider is rate limiting requests. Try again shortly.",
                _ => {
                    "The provider rejected the request. Check account authorization and app configuration."
                }
            },
        );
        error.provider_status = Some(status);
        // Token errors are a small, fixed vocabulary; never expose provider descriptions/tokens.
        if oauth && [400, 401].contains(&status) {
            let body = response_json(response, 32768).await.unwrap_or(Value::Null);
            let code = match string(&body, "error") {
                "invalid_grant" | "interaction_required" | "consent_required" => {
                    "oauth_reconnect_required"
                }
                "invalid_client" | "unauthorized_client" | "invalid_scope" => "oauth_configuration",
                _ => "oauth_refresh_failed",
            };
            error.body["code"] = code.into();
        } else if status == 403 {
            let body = response_json(response, 32768).await.unwrap_or(Value::Null);
            if let Some(code) = provider_quota_code(&body) {
                error.body["code"] = code.into();
            } else if body["error"]["errors"].as_array().is_some_and(|errors| {
                errors
                    .iter()
                    .any(|entry| entry["reason"] == "insufficientPermissions")
            }) {
                error.body["code"] = "provider_permission_denied".into();
            }
        }
        return Err(error);
    }
    response_json(response, limit).await
}
fn provider_quota_code(body: &Value) -> Option<&'static str> {
    body["error"]["errors"]
        .as_array()?
        .iter()
        .find_map(|entry| match string(entry, "reason") {
            "rateLimitExceeded" | "userRateLimitExceeded" => Some("provider_quota_exceeded"),
            "dailyLimitExceeded" => Some("provider_daily_quota_exceeded"),
            _ => None,
        })
}
pub fn quota_retry_delay(error: &Error, count: u64) -> Option<i64> {
    // ponytail: hourly cap keeps read-only retries quiet; honor Retry-After if provider pacing needs it.
    let code = string(&error.body, "code");
    if code == "provider_daily_quota_exceeded" {
        return Some(24 * 60 * 60 * 1000);
    }
    (code == "provider_quota_exceeded" || error.provider_status == Some(429))
        .then_some([60_000, 120_000, 300_000, 900_000, 3_600_000][count.min(4) as usize])
}
async fn response_json(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::new(
            502,
            "The provider response exceeds the size limit.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if bytes.len() + chunk.len() > limit {
            return Err(Error::new(
                502,
                "The provider response exceeds the size limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        tokio::task::spawn_blocking(move || {
            serde_json::from_slice(&bytes)
                .map_err(|_| Error::new(502, "The provider returned an unreadable response."))
        })
        .await
        .map_err(|_| remote_error())?
    }
}

pub fn api(
    client: &Client,
    mail: &Value,
    method: reqwest::Method,
    path: &str,
) -> Result<RequestBuilder> {
    Ok(client
        .request(
            method,
            format!("{}{path}", definition(string(mail, "provider"))?.api),
        )
        .bearer_auth(string(mail, "accessToken"))
        .timeout(Duration::from_secs(30)))
}
pub async fn get(client: &Client, mail: &Value, path: &str) -> Result<Value> {
    request(
        api(client, mail, reqwest::Method::GET, path)?,
        8 * 1024 * 1024,
    )
    .await
}
pub fn component(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
pub fn oauth_start(provider: &str, config: &Value, redirect: &str, purpose: &str) -> Result<Value> {
    let def = definition(provider)?;
    if !["mail", "calendar"].contains(&purpose) {
        return Err(Error::invalid("Invalid OAuth purpose."));
    }
    let mut saved = json!({"clientId":validation::text(&config["clientId"],"OAuth client ID",1024,false)?.trim()});
    if purpose == "calendar" {
        saved["purpose"] = purpose.into();
    } else {
        saved["mailScope"] = def.organize.into();
        if config["outOfOffice"] == true {
            saved["mailScope"] = format!(
                "{} {}",
                string(&saved, "mailScope"),
                if provider == "google" {
                    "https://www.googleapis.com/auth/gmail.settings.basic"
                } else {
                    "MailboxSettings.ReadWrite"
                }
            )
            .into();
        }
    }
    if !string(config, "clientSecret").is_empty() {
        saved["clientSecret"] =
            validation::text(&config["clientSecret"], "Google client secret", 4096, false)?.into();
    }
    let state = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes::<48>()?);
    let mut url = url::Url::parse(def.authorize).unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", string(&saved, "clientId")),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        (
            "scope",
            if purpose == "calendar" {
                def.calendar
            } else {
                string(&saved, "mailScope")
            },
        ),
        ("state", &state),
        (
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        ),
        ("code_challenge_method", "S256"),
        (
            "prompt",
            if provider == "google" {
                "consent"
            } else {
                "select_account"
            },
        ),
    ]);
    if provider == "google" {
        url.query_pairs_mut().append_pair("access_type", "offline");
    }
    Ok(
        json!({"url":url.as_str(),"state":state,"verifier":verifier,"config":saved,"purpose":purpose}),
    )
}
async fn exchange(
    client: &Client,
    provider: &str,
    config: &Value,
    mut fields: Vec<(String, String)>,
) -> Result<Value> {
    let def = definition(provider)?;
    fields.push(("client_id".into(), string(config, "clientId").into()));
    if !string(config, "clientSecret").is_empty() {
        fields.push((
            "client_secret".into(),
            string(config, "clientSecret").into(),
        ));
    }
    if provider == "microsoft" {
        fields.push((
            "scope".into(),
            if config["purpose"] == "calendar" {
                def.calendar
            } else if !string(config, "mailScope").is_empty() {
                string(config, "mailScope")
            } else {
                def.scope
            }
            .into(),
        ));
    }
    let result = request_kind(
        client
            .post(def.token)
            .form(&fields)
            .timeout(Duration::from_secs(30)),
        8 * 1024 * 1024,
        true,
    )
    .await?;
    let expiry = result["expires_in"]
        .as_f64()
        .or_else(|| result["expires_in"].as_str().and_then(|s| s.parse().ok()))
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= 31_536_000.0)
        .ok_or_else(remote_error)?;
    if string(&result, "access_token").is_empty() {
        return Err(remote_error());
    }
    let scope = result
        .get("scope")
        .and_then(Value::as_str)
        .or_else(|| config.get("grantedScopes").and_then(Value::as_str))
        .or_else(|| config.get("mailScope").and_then(Value::as_str))
        .unwrap_or(def.scope);
    let mut tokens = json!({"accessToken":result["access_token"],"expiresAt":Utc::now().timestamp_millis()+(expiry*1000.0) as i64,"grantedScopes":scope});
    if !string(&result, "refresh_token").is_empty() {
        tokens["refreshToken"] = result["refresh_token"].clone();
    }
    Ok(tokens)
}
pub async fn oauth_finish(
    client: &Client,
    provider: &str,
    pending: &Value,
    code: &str,
) -> Result<Value> {
    let verifier = string(pending, "verifier");
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Error::invalid("Invalid OAuth callback."));
    }
    let tokens = exchange(
        client,
        provider,
        &pending["config"],
        vec![
            ("grant_type".into(), "authorization_code".into()),
            ("code".into(), code.into()),
            ("code_verifier".into(), verifier.into()),
            ("redirect_uri".into(), string(pending, "redirectUri").into()),
        ],
    )
    .await?;
    let mut mail = merge(
        merge(json!({"provider":provider}), &pending["config"]),
        &tokens,
    );
    let calendar = mail["purpose"] == "calendar";
    let profile = if provider == "google" && calendar {
        request(
            client
                .get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(string(&mail, "accessToken")),
            8 * 1024 * 1024,
        )
        .await?
    } else {
        get(
            client,
            &mail,
            if provider == "google" {
                "/profile"
            } else {
                "?$select=mail,userPrincipalName"
            },
        )
        .await?
    };
    let email = if provider == "google" {
        &profile[if calendar { "email" } else { "emailAddress" }]
    } else if !string(&profile, "mail").is_empty() {
        &profile["mail"]
    } else {
        &profile["userPrincipalName"]
    };
    mail["email"] = validation::email(email)?.to_lowercase().into();
    Ok(mail)
}
pub async fn refresh(client: &Client, mail: &Value) -> Result<Value> {
    let provider = string(mail, "provider");
    definition(provider)?;
    if !string(mail, "accessToken").is_empty()
        && mail["expiresAt"].as_i64().unwrap_or(0) > Utc::now().timestamp_millis() + 60000
    {
        return Ok(mail.clone());
    }
    if string(mail, "refreshToken").is_empty() {
        let mut error = Error::new(401, "Authorization expired. Reconnect this account.");
        error.body["code"] = "oauth_reconnect_required".into();
        return Err(error);
    }
    Ok(merge(
        mail.clone(),
        &exchange(
            client,
            provider,
            mail,
            vec![
                ("grant_type".into(), "refresh_token".into()),
                ("refresh_token".into(), string(mail, "refreshToken").into()),
            ],
        )
        .await?,
    ))
}
pub fn iso(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or_else(|_| DateTime::<Utc>::from_timestamp(0, 0).unwrap())
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn preview(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}
fn category(subject: &str, headers: &Value) -> &'static str {
    if headers.as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            ["list-id", "list-unsubscribe"]
                .contains(&string(row, "name").to_ascii_lowercase().as_str())
        })
    }) {
        "newsletters"
    } else {
        static TERMS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?i)\b(receipt|invoice|order|delivery|notification|verification|security alert|payment|shipping)\b").unwrap()
        });
        if TERMS.is_match(subject) {
            "updates"
        } else {
            "primary"
        }
    }
}
pub fn automated(headers: &Value) -> bool {
    headers.as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            ["auto-submitted", "list-id", "list-unsubscribe"]
                .contains(&string(row, "name").to_ascii_lowercase().as_str())
                && row["value"] != "no"
        })
    })
}
fn address_text(value: Option<&mail_parser::Address<'_>>) -> String {
    value
        .map(|a| {
            a.iter()
                .filter_map(|a| a.address())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}
pub fn mime(raw: &[u8]) -> Result<Value> {
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(remote_error)?;
    let from = parsed.from().and_then(|v| v.first());
    let body = parsed
        .body_text(0)
        .map(|s| s.replace("\r\n", "\n"))
        .unwrap_or_else(|| "(This message has no readable text.)".into());
    let body: String = body.chars().take(100000).collect();
    let body_html = parsed
        .body_html(0)
        .map(|html| crate::message_html::sanitize(&html))
        .unwrap_or_default();
    let headers = parsed
        .headers_raw()
        .map(|(name, value)| json!({"name":name,"value":value.trim()}))
        .collect::<Vec<_>>();
    let subject = parsed.subject().unwrap_or("(No subject)");
    let mut result = json!({"fromName":from.and_then(|a|a.name().or(a.address())).unwrap_or("Unknown sender"),"fromEmail":from.and_then(|a|a.address()).unwrap_or(""),"to":address_text(parsed.to()),"cc":address_text(parsed.cc()),"bcc":address_text(parsed.bcc()),"subject":subject,"body":body,"preview":preview(&body),"date":DateTime::<Utc>::from_timestamp(parsed.date().map(|d|d.to_timestamp()).unwrap_or(0),0).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis,true),"messageId":parsed.message_id().map(|id|format!("<{id}>")).unwrap_or_default(),"automated":automated(&json!(headers)),"category":category(subject,&json!(headers)),"labels":[]});
    result["bodyHtml"] = body_html.into();
    Ok(result)
}
pub fn google_folder(label_ids: &Value) -> &'static str {
    let Some(labels) = label_ids.as_array() else {
        return "archive";
    };
    [
        ("TRASH", "trash"),
        ("SPAM", "spam"),
        ("DRAFT", "drafts"),
        ("INBOX", "inbox"),
        ("SENT", "sent"),
    ]
    .into_iter()
    .find_map(|(label, folder)| labels.iter().any(|v| v == label).then_some(folder))
    .unwrap_or("archive")
}

pub fn normalize_google(message: &Value) -> Result<Value> {
    let headers = message["payload"]["headers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut raw = String::new();
    for header in &headers {
        let name = string(header, "name");
        if !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !name.to_ascii_lowercase().starts_with("content-")
            && !name.eq_ignore_ascii_case("mime-version")
        {
            raw.push_str(&format!(
                "{name}: {}\r\n",
                string(header, "value").replace(['\r', '\n'], " ")
            ));
        }
    }
    raw.push_str("\r\n");
    let mut result = mime(raw.as_bytes())?;
    let mut stack = vec![&message["payload"]];
    let mut plain = Vec::new();
    let mut html = Vec::new();
    let mut formatted = Vec::new();
    let mut count = 0;
    while let Some(part) = stack.pop() {
        count += 1;
        if count > 2000 {
            return Err(remote_error());
        }
        if !string(part, "filename").is_empty()
            || part["headers"].as_array().is_some_and(|h| {
                h.iter().any(|h| {
                    string(h, "name").eq_ignore_ascii_case("content-disposition")
                        && string(h, "value")
                            .to_ascii_lowercase()
                            .starts_with("attachment")
                })
            })
        {
            continue;
        }
        if ["text/plain", "text/html"].contains(&string(part, "mimeType"))
            && !string(&part["body"], "data").is_empty()
        {
            let data = URL_SAFE_NO_PAD
                .decode(string(&part["body"], "data").trim_end_matches('='))
                .map_err(|_| remote_error())?;
            let content_type = part["headers"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|h| string(h, "name").eq_ignore_ascii_case("content-type"))
                })
                .map(|v| string(v, "value").to_owned())
                .unwrap_or_else(|| format!("{}; charset=utf-8", string(part, "mimeType")));
            let raw = format!(
                "Content-Type: {}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
                content_type.replace(['\r', '\n'], " "),
                STANDARD.encode(data)
            );
            let parsed = mime(raw.as_bytes())?;
            if part["mimeType"] == "text/plain" {
                plain.push(string(&parsed, "body").to_owned());
            } else {
                html.push(string(&parsed, "body").to_owned());
                formatted.push(string(&parsed, "bodyHtml").to_owned());
            }
        }
        if let Some(parts) = part["parts"].as_array() {
            stack.extend(parts.iter().rev());
        }
    }
    let body = if plain.is_empty() { html } else { plain }
        .join("\n\n")
        .trim()
        .chars()
        .take(100000)
        .collect::<String>();
    let body = if body.is_empty() {
        "(No inline text was available. Open this message in your original mailbox to read any attachments or large message bodies.)".into()
    } else {
        body
    };
    result["id"] = format!("google:{}", string(message, "id")).into();
    result["body"] = body.clone().into();
    result["bodyHtml"] = crate::message_html::sanitize(&formatted.join("\n")).into();
    result["preview"] = preview(&body).into();
    if let Some(ms) = message["internalDate"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .or(message["internalDate"].as_i64())
        .filter(|n| *n != 0)
    {
        result["date"] = DateTime::<Utc>::from_timestamp_millis(ms)
            .unwrap_or_default()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            .into();
    }
    let labels = message["labelIds"].as_array().cloned().unwrap_or_default();
    if message.get("labelIds").is_some_and(|v| !v.is_array())
        || labels.len() > 1000
        || labels.iter().any(|v| v.as_str().is_none_or(str::is_empty))
    {
        return Err(remote_error());
    }
    let folder = google_folder(&message["labelIds"]);
    result = merge(
        result,
        &json!({"folder":folder,"providerSent":labels.contains(&json!("SENT")),"providerDraft":labels.contains(&json!("DRAFT")),"read":!labels.contains(&json!("UNREAD")),"starred":labels.contains(&json!("STARRED")),"automated":automated(&json!(headers)),"providerLabelIds":labels}),
    );
    Ok(result)
}
pub fn normalize_microsoft(message: &Value) -> Result<Value> {
    let from = message.get("from").unwrap_or(&message["sender"]);
    let from = &from["emailAddress"];
    let body = string(&message["body"], "content");
    let body_html = if string(&message["body"], "contentType").eq_ignore_ascii_case("html") {
        crate::message_html::sanitize(body)
    } else {
        String::new()
    };
    let body = if string(&message["body"], "contentType").eq_ignore_ascii_case("html") {
        content::plain_html(body)?
    } else {
        body.to_owned()
    };
    let body: String = body.chars().take(100000).collect();
    let body = if body.is_empty() {
        "(This message has no readable text.)".into()
    } else {
        body
    };
    let subject = message["subject"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("(No subject)");
    let mut result = json!({"id":format!("microsoft:{}",string(message,"id")),"fromName":from["name"].as_str().filter(|s|!s.is_empty()).or(from["address"].as_str()).unwrap_or("Unknown sender"),"fromEmail":string(from,"address"),"subject":subject,"body":body,"preview":preview(&body),"date":iso(string(message,"receivedDateTime")),"folder":"inbox","read":message["isRead"]==true,"starred":message["flag"]["flagStatus"]=="flagged","category":category(subject,&message["internetMessageHeaders"]),"automated":automated(&message["internetMessageHeaders"]),"labels":[],"messageId":string(message,"internetMessageId")});
    for field in ["to", "cc", "bcc"] {
        result[field] = message[format!("{field}Recipients")]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|r| string(&r["emailAddress"], "address"))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
            .into();
    }
    result["bodyHtml"] = body_html.into();
    Ok(result)
}
pub async fn fetch_page(client: &Client, mail: &Value, options: &Value) -> Result<Value> {
    let folder = options["folder"].as_str().unwrap_or("inbox");
    let provider = string(mail, "provider");
    let supported = if provider == "google" {
        &["all", "inbox", "sent", "drafts", "starred"][..]
    } else {
        &["all", "inbox", "sent"][..]
    };
    if !supported.contains(&folder) {
        return Err(Error::invalid("Unsupported import folder."));
    }
    definition(provider)?;
    if provider == "google" {
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query
                .append_pair("maxResults", "50")
                .append_pair("includeSpamTrash", "false");
            if folder != "all" {
                query.append_pair(
                    "labelIds",
                    match folder {
                        "sent" => "SENT",
                        "drafts" => "DRAFT",
                        "starred" => "STARRED",
                        _ => "INBOX",
                    },
                );
            }
            let mut filter = Vec::new();
            for (key, operator) in [("since", "after"), ("before", "before")] {
                if !string(options, key).is_empty() {
                    let ms = DateTime::parse_from_rfc3339(string(options, key))
                        .map_err(|_| Error::invalid("Invalid import date."))?
                        .timestamp_millis();
                    let seconds = if key == "before" {
                        (ms as f64 / 1000.0).ceil() as i64
                    } else {
                        ms.div_euclid(1000)
                    };
                    filter.push(format!("{operator}:{seconds}"));
                }
            }
            if !filter.is_empty() {
                query.append_pair("q", &filter.join(" "));
            }
            if !string(options, "cursor").is_empty() {
                query.append_pair("pageToken", string(options, "cursor"));
            }
            query.finish()
        };
        let list = get(client, mail, &format!("/messages?{query}")).await?;
        let entries = list["messages"].as_array().cloned().unwrap_or_default();
        if list.get("messages").is_some_and(|v| !v.is_array())
            || entries.len() > 50
            || entries.iter().any(|item| string(item, "id").is_empty())
        {
            return Err(remote_error());
        }
        let label_names: HashMap<String, String> = if entries.is_empty() {
            HashMap::new()
        } else {
            google_labels(client, mail)
                .await?
                .iter()
                .filter(|label| label["type"] == "user")
                .map(|label| {
                    (
                        string(label, "id").to_owned(),
                        string(label, "name").to_owned(),
                    )
                })
                .collect()
        };
        let mut messages = Vec::new();
        for entries in entries.chunks(5) {
            let results = futures_util::future::join_all(entries.iter().map(|item| async {
                let raw = get(
                    client,
                    mail,
                    &format!("/messages/{}?format=full", component(string(item, "id"))),
                )
                .await?;
                let mut value = tokio::task::spawn_blocking(move || normalize_google(&raw))
                    .await
                    .map_err(|_| remote_error())??;
                value["labels"] = value["providerLabelIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|id| label_names.get(id.as_str().unwrap()))
                    .map(|name| json!(name))
                    .collect();
                Ok::<_, Error>(value)
            }))
            .await;
            for result in results {
                messages.push(result?);
            }
        }
        return Ok(
            json!({"messages":messages,"nextCursor":list.get("nextPageToken").unwrap_or(&Value::Null)}),
        );
    }
    let traversal = if folder == "all" {
        Some(microsoft_import_cursor(client, mail, &options["cursor"]).await?)
    } else {
        None
    };
    if traversal
        .as_ref()
        .is_some_and(|v| v["folders"].as_array().unwrap().is_empty())
    {
        return Ok(json!({"messages":[],"nextCursor":null}));
    }
    let current_folder = traversal
        .as_ref()
        .map(|v| &v["folders"][v["index"].as_u64().unwrap() as usize]);
    let folder = current_folder.map_or(folder, |v| string(v, "kind"));
    let date = if folder == "sent" {
        "sentDateTime"
    } else if folder == "drafts" {
        "createdDateTime"
    } else {
        "receivedDateTime"
    };
    let identity = current_folder
        .map(|v| string(v, "id"))
        .unwrap_or(if folder == "sent" {
            "sentitems"
        } else {
            "inbox"
        });
    let path = format!("/v1.0/me/mailFolders/{}/messages", component(identity));
    let mut url = url::Url::parse(&format!("https://graph.microsoft.com{path}")).unwrap();
    url.query_pairs_mut().extend_pairs([("$top","50"),("$orderby",&format!("{date} desc")),("$select","id,from,sender,toRecipients,ccRecipients,bccRecipients,subject,body,receivedDateTime,sentDateTime,createdDateTime,isDraft,isRead,flag,internetMessageId,internetMessageHeaders")]);
    let mut filters = Vec::new();
    for (key, operator) in [("since", "ge"), ("before", "lt")] {
        if !string(options, key).is_empty() {
            let instant = DateTime::parse_from_rfc3339(string(options, key))
                .map_err(|_| Error::invalid("Invalid import date."))?
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            filters.push(format!("{date} {operator} {instant}"));
        }
    }
    if !filters.is_empty() {
        url.query_pairs_mut()
            .append_pair("$filter", &filters.join(" and "));
    }
    let cursor = traversal
        .as_ref()
        .map_or(string(options, "cursor"), |v| string(v, "next"));
    if !cursor.is_empty() {
        url = if traversal.is_some() {
            validated_folder_next(cursor, &url, identity, "messages")?
        } else {
            validated_mail_next(cursor, &url)?
        };
    }
    let result = request(
        client
            .get(url)
            .bearer_auth(string(mail, "accessToken"))
            .header(
                "Prefer",
                "outlook.body-content-type=\"html\", IdType=\"ImmutableId\"",
            ),
        8 * 1024 * 1024,
    )
    .await?;
    let folder = folder.to_owned();
    let current_folder = current_folder.cloned();
    tokio::task::spawn_blocking(move || {
        let entries = result["value"].as_array().ok_or_else(remote_error)?;
        if entries.len() > 50
            || result.get("@odata.nextLink").is_some_and(|v| {
                !v.is_null() && (!v.is_string() || v.as_str().unwrap().len() > 8192)
            })
        {
            return Err(remote_error());
        }
        let mut messages = Vec::new();
        for raw in entries {
            let mut value = normalize_microsoft(raw)?;
            value["folder"] = folder.clone().into();
            value["date"] = iso(string(raw, date)).into();
            if let Some(current) = &current_folder {
                value["providerFolderId"] = current["id"].clone();
                value["providerFolderName"] = current["name"].clone();
                value["providerSent"] = (folder == "sent").into();
                value["providerDraft"] = (folder == "drafts" || raw["isDraft"] == true).into();
                if raw["isDraft"] == true {
                    value["folder"] = "drafts".into();
                }
            }
            messages.push(value);
        }
        let mut next = result
            .get("@odata.nextLink")
            .cloned()
            .filter(|v| v != "")
            .unwrap_or(Value::Null);
        if let Some(mut traversal) = traversal {
            let index = traversal["index"].as_u64().unwrap() as usize + usize::from(next.is_null());
            if index < traversal["folders"].as_array().unwrap().len() {
                traversal["index"] = index.into();
                traversal["next"] = next;
                next = traversal;
            } else {
                next = Value::Null;
            }
        }
        Ok(json!({"messages":messages,"nextCursor":next}))
    })
    .await
    .map_err(|_| remote_error())?
}
fn valid_microsoft_folder_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 2048
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_+=/-".contains(&c))
}
async fn microsoft_import_cursor(client: &Client, mail: &Value, cursor: &Value) -> Result<Value> {
    if cursor.is_null() {
        return Ok(
            json!({"version":1,"folders":microsoft_folders(client,mail,true,false).await?,"index":0,"next":null}),
        );
    }
    let folders = cursor["folders"].as_array().ok_or_else(remote_error)?;
    let mut ids = HashSet::new();
    if cursor["version"] != 1
        || folders.is_empty()
        || folders.len() > 300
        || !cursor["index"]
            .as_u64()
            .is_some_and(|v| v < folders.len() as u64)
        || (!cursor["next"].is_null()
            && (!cursor["next"].is_string() || string(cursor, "next").len() > 8192))
        || folders.iter().any(|v| {
            !valid_microsoft_folder_id(string(v, "id"))
                || !ids.insert(string(v, "id"))
                || !v["name"].is_string()
                || string(v, "name").encode_utf16().count() > 512
                || !["inbox", "sent", "drafts", "archive"].contains(&string(v, "kind"))
        })
    {
        return Err(Error::invalid("Invalid mailbox import cursor."));
    }
    Ok(cursor.clone())
}
// Only the two exact spellings for the already-resolved folder are equivalent.
fn validated_folder_next(
    next: &str,
    original: &url::Url,
    id: &str,
    collection: &str,
) -> Result<url::Url> {
    validated_next(next, original)
        .or_else(|_| {
            let mut alias = original.clone();
            alias.set_path(&format!(
                "/v1.0/me/mailFolders('{}')/{collection}",
                component(id)
            ));
            validated_next(next, &alias)
        })
        .or_else(|_| {
            let mut alias = original.clone();
            alias.set_path(&format!("/v1.0/me/mailFolders('{id}')/{collection}"));
            validated_next(next, &alias)
        })
}
pub fn validated_mail_next(next: &str, original: &url::Url) -> Result<url::Url> {
    let equivalent = match original.path() {
        "/v1.0/me/mailFolders/inbox/messages" => "/v1.0/me/mailFolders('inbox')/messages",
        "/v1.0/me/mailFolders/sentitems/messages" => "/v1.0/me/mailFolders('sentitems')/messages",
        _ => return validated_next(next, original),
    };
    validated_next(next, original).or_else(|_| {
        let mut alias = original.clone();
        alias.set_path(equivalent);
        validated_next(next, &alias)
    })
}
pub fn validated_next(next: &str, original: &url::Url) -> Result<url::Url> {
    if next.len() > 8192 {
        return Err(remote_error());
    }
    let next = url::Url::parse(next).map_err(|_| remote_error())?;
    if next.origin() != original.origin()
        || next.path() != original.path()
        || !next.username().is_empty()
        || next.password().is_some()
        || next.fragment().is_some()
    {
        return Err(Error::new(
            502,
            "The provider returned an unsafe next page.",
        ));
    }
    Ok(next)
}
pub fn compose(mail: &Value, message: &Value, keep_bcc: bool) -> Result<(lettre::Message, String)> {
    let address = validation::email(&mail["email"])?;
    let sender = address
        .parse()
        .map_err(|_| Error::invalid("Invalid sender."))?;
    let mut builder = lettre::Message::builder()
        .from(lettre::message::Mailbox::new(
            Some(string(message, "fromName").into()),
            sender,
        ))
        .subject(validation::text(&message["subject"], "Subject", 500, true)?);
    let addresses = content::recipients(message, false)?;
    for field in ["to", "cc", "bcc"] {
        for address in string(&addresses, field)
            .split(", ")
            .filter(|s| !s.is_empty())
        {
            let mailbox = address
                .parse()
                .map_err(|_| Error::invalid("Invalid recipient."))?;
            builder = match field {
                "to" => builder.to(mailbox),
                "cc" => builder.cc(mailbox),
                _ => builder.bcc(mailbox),
            };
        }
    }
    let id = format!(
        "<{}@{}>",
        uuid::Uuid::new_v4(),
        address.split('@').nth(1).unwrap()
    );
    builder = builder.message_id(Some(id.clone()));
    let reply = string(message, "replyMessageId");
    if !reply.is_empty() {
        if reply.contains(['\r', '\n', '\0']) {
            return Err(Error::invalid("Invalid reply message ID."));
        }
        builder = builder.in_reply_to(reply.into()).references(reply.into());
    }
    if keep_bcc {
        builder = builder.keep_bcc();
    }
    let (text, html) = content::message_content(message)?;
    let message = if let Some(html) = html {
        builder.multipart(lettre::message::MultiPart::alternative_plain_html(
            text, html,
        ))
    } else {
        builder.body(text)
    }
    .map_err(|_| Error::invalid("This email could not be composed."))?;
    Ok((message, id))
}
pub async fn send(client: &Client, mail: &Value, message: &Value) -> Result<String> {
    let provider = string(mail, "provider");
    definition(provider)?;
    let (message, id) = compose(mail, message, true)?;
    let raw = message.formatted();
    let outgoing = if provider == "google" {
        api(client, mail, reqwest::Method::POST, "/messages/send")?
            .json(&json!({"raw":URL_SAFE_NO_PAD.encode(raw)}))
    } else {
        api(client, mail, reqwest::Method::POST, "/sendMail")?
            .header("Content-Type", "text/plain")
            .body(STANDARD.encode(raw))
    };
    request(outgoing, 8 * 1024 * 1024).await?;
    Ok(id)
}
pub fn can_organize(mail: &Value) -> bool {
    let provider = string(mail, "provider");
    if provider.is_empty() || provider == "imap" {
        return !string(mail, "email").is_empty();
    }
    let scopes = mail["grantedScopes"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(mail, "mailScope"));
    scopes.split_whitespace().any(|s| {
        s == if provider == "google" {
            "https://www.googleapis.com/auth/gmail.modify"
        } else {
            "Mail.ReadWrite"
        }
    })
}
async fn google_labels(client: &Client, mail: &Value) -> Result<Vec<Value>> {
    let result = get(client, mail, "/labels").await?;
    let labels = result["labels"]
        .as_array()
        .filter(|labels| labels.len() <= 1000)
        .ok_or_else(remote_error)?;
    if labels
        .iter()
        .any(|label| string(label, "id").is_empty() || string(label, "name").is_empty())
    {
        return Err(remote_error());
    }
    Ok(labels.clone())
}

pub async fn folders(client: &Client, mail: &Value) -> Result<Vec<Value>> {
    if mail["provider"] == "google" {
        let labels = google_labels(client, mail).await?;
        let mut folders = vec![
            json!({"id":"INBOX","name":"Inbox","kind":"inbox"}),
            json!({"id":"__archive","name":"Archive (remove Inbox)","kind":"archive"}),
        ];
        folders.extend(
            labels
                .iter()
                .filter(|v| v["type"] == "system" && ["SPAM", "TRASH"].contains(&string(v, "id")))
                .map(|v| {
                    if v["id"] == "TRASH" {
                        json!({"id":v["id"],"name":"Trash","kind":"trash"})
                    } else {
                        json!({"id":v["id"],"name":"Spam","kind":"spam"})
                    }
                }),
        );
        folders.extend(
            labels
                .iter()
                .filter(|v| v["type"] == "user" && v["id"].is_string())
                .map(|v| json!({"id":v["id"],"name":string(v,"name"),"kind":"label"})),
        );
        return Ok(folders);
    }
    microsoft_folders(client, mail, false, false).await
}
pub async fn management_folders(client: &Client, mail: &Value) -> Result<Vec<Value>> {
    if mail["provider"] == "google" {
        let folders = folders(client, mail).await?;
        return Ok(folders.iter().filter(|f| f["id"] != "__archive").map(|f| {
            let name = string(f, "name");
            let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", name));
            merge(f.clone(), &json!({"editable":f["kind"]=="label","leafName":leaf,"delimiter":"/",
                "parentId":folders.iter().find(|p|p["kind"]=="label"&&p["name"]==parent).map(|p|p["id"].clone()).unwrap_or(json!(""))}))
        }).collect());
    }
    microsoft_folders(client, mail, false, true).await
}
async fn microsoft_folders(
    client: &Client,
    mail: &Value,
    importing: bool,
    management: bool,
) -> Result<Vec<Value>> {
    let mut known = HashMap::new();
    if importing {
        for (alias, kind) in [
            ("inbox", "inbox"),
            ("sentitems", "sent"),
            ("drafts", "drafts"),
            ("junkemail", "spam"),
            ("deleteditems", "trash"),
        ] {
            let folder = get(client, mail, &format!("/mailFolders/{alias}?$select=id")).await?;
            let id = string(&folder, "id");
            if !valid_microsoft_folder_id(id) || known.insert(id.to_owned(), kind).is_some() {
                return Err(remote_error());
            }
        }
    }
    let mut folders = Vec::new();
    let mut pending = VecDeque::from([("/mailFolders".to_owned(), String::new(), String::new())]);
    let mut seen = HashSet::new();
    let mut ids = HashSet::new();
    while let Some((path, prefix, parent)) = pending.pop_front() {
        let original = url::Url::parse(&format!("{}{path}", definition("microsoft")?.api)).unwrap();
        let mut next = format!(
            "{path}?$top=100&$select=id,displayName,childFolderCount{}",
            if management {
                ",totalItemCount,isHidden&includeHiddenFolders=true"
            } else {
                ""
            }
        );
        let mut pages = 0;
        while !next.is_empty() {
            pages += 1;
            if pages > 10 || !seen.insert(next.clone()) {
                return Err(remote_error());
            }
            let result = get(client, mail, &next).await?;
            let entries = result["value"].as_array().ok_or_else(remote_error)?;
            if entries.len() > 100 {
                return Err(remote_error());
            }
            for folder in entries {
                let id = string(folder, "id");
                if !valid_microsoft_folder_id(id) || !ids.insert(id.to_owned()) {
                    return Err(remote_error());
                }
                let kind =
                    known
                        .get(id)
                        .copied()
                        .unwrap_or(if importing { "archive" } else { "folder" });
                if importing && ["spam", "trash"].contains(&kind) {
                    continue;
                }
                let name = format!(
                    "{prefix}{}",
                    folder["displayName"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Untitled folder")
                );
                if management
                    && (name.encode_utf16().count() > 512
                        || name.chars().any(char::is_control)
                        || string(folder, "displayName").is_empty())
                {
                    return Err(remote_error());
                }
                let name = name
                    .chars()
                    .scan(0, |count, c| {
                        *count += c.len_utf16();
                        (*count <= 512).then_some(c)
                    })
                    .collect::<String>();
                let mut entry = json!({"id":id,"name":name,"kind":kind});
                if management {
                    entry = merge(
                        entry,
                        &json!({"leafName":folder["displayName"],"parentId":parent,"hidden":folder["isHidden"]==true,"editable":folder["isHidden"]!=true,
                        "totalItemCount":folder["totalItemCount"],"childFolderCount":folder["childFolderCount"]}),
                    );
                }
                folders.push(entry);
                if folders.len() > 300 {
                    return Err(Error::new(
                        502,
                        "This mailbox exceeds the 300 folder limit.",
                    ));
                }
                if folder["childFolderCount"].as_u64().unwrap_or(0) > 0 {
                    pending.push_back((
                        format!("/mailFolders/{}/childFolders", component(id)),
                        format!("{name} / "),
                        id.to_owned(),
                    ));
                }
            }
            next = String::new();
            if !string(&result, "@odata.nextLink").is_empty() {
                let url = if parent.is_empty() {
                    validated_next(string(&result, "@odata.nextLink"), &original)?
                } else {
                    validated_folder_next(
                        string(&result, "@odata.nextLink"),
                        &original,
                        &parent,
                        "childFolders",
                    )?
                };
                next = format!(
                    "{}?{}",
                    url.path()
                        .strip_prefix("/v1.0/me")
                        .ok_or_else(remote_error)?,
                    url.query().unwrap_or("")
                );
            }
        }
    }
    if importing {
        return Ok(folders);
    }
    let inbox = get(client, mail, "/mailFolders/inbox?$select=id").await?;
    let junk = get(client, mail, "/mailFolders/junkemail?$select=id").await?;
    let trash = get(client, mail, "/mailFolders/deleteditems?$select=id").await?;
    let special = [
        string(&inbox, "id"),
        string(&junk, "id"),
        string(&trash, "id"),
    ];
    if !special.iter().all(|id| valid_microsoft_folder_id(id))
        || special.iter().collect::<HashSet<_>>().len() != special.len()
    {
        return Err(remote_error());
    }
    for folder in &mut folders {
        if folder["id"] == inbox["id"] {
            folder["kind"] = "inbox".into();
        } else if folder["id"] == junk["id"] {
            folder["kind"] = "spam".into();
        } else if folder["id"] == trash["id"] {
            folder["kind"] = "trash".into();
        }
    }
    if management {
        // Resolve well-known IDs, never localized display names, before exposing writes.
        let mut protected = special
            .iter()
            .map(|id| id.to_string())
            .collect::<HashSet<_>>();
        for alias in [
            "archive",
            "clutter",
            "conflicts",
            "conversationhistory",
            "drafts",
            "localfailures",
            "msgfolderroot",
            "outbox",
            "recoverableitemsdeletions",
            "scheduled",
            "searchfolders",
            "sentitems",
            "serverfailures",
            "syncissues",
        ] {
            match get(client, mail, &format!("/mailFolders/{alias}?$select=id")).await {
                Ok(folder) if valid_microsoft_folder_id(string(&folder, "id")) => {
                    protected.insert(string(&folder, "id").to_owned());
                }
                Err(error) if error.provider_status == Some(404) => {}
                _ => return Err(remote_error()),
            }
        }
        for folder in &mut folders {
            if protected.contains(string(folder, "id")) {
                folder["editable"] = false.into();
            }
        }
    }
    Ok(folders)
}
pub async fn manage_folder(
    client: &Client,
    mail: &Value,
    operation: &str,
    id: &str,
    name: &str,
    parent: &str,
) -> Result<Value> {
    if !can_organize(mail) {
        return Err(Error::new(
            403,
            "Reconnect this mailbox and approve mail write permission before managing folders.",
        ));
    }
    let google = mail["provider"] == "google";
    let (method, path, body) = if google {
        match operation {
            "create" => (
                reqwest::Method::POST,
                "/labels".to_owned(),
                Some(json!({"name":name})),
            ),
            "rename" | "move" => (
                reqwest::Method::PATCH,
                format!("/labels/{}", component(id)),
                Some(json!({"name":name})),
            ),
            "delete" => (
                reqwest::Method::DELETE,
                format!("/labels/{}", component(id)),
                None,
            ),
            _ => return Err(Error::invalid("Invalid folder operation.")),
        }
    } else {
        let path = format!("/mailFolders/{}", component(id));
        match operation {
            "create" => (
                reqwest::Method::POST,
                if parent.is_empty() {
                    "/mailFolders".to_owned()
                } else {
                    format!("/mailFolders/{}/childFolders", component(parent))
                },
                Some(json!({"displayName":name})),
            ),
            "rename" => (
                reqwest::Method::PATCH,
                path,
                Some(json!({"displayName":name})),
            ),
            "move" => (
                reqwest::Method::POST,
                format!("{path}/move"),
                Some(json!({"destinationId":if parent.is_empty(){"msgfolderroot"}else{parent}})),
            ),
            "delete" => (reqwest::Method::DELETE, path, None),
            _ => return Err(Error::invalid("Invalid folder operation.")),
        }
    };
    let mut outgoing = api(client, mail, method, &path)?;
    if let Some(body) = body {
        outgoing = outgoing.json(&body);
    }
    let result = request(outgoing, 1024 * 1024).await?;
    if operation != "delete"
        && (string(&result, "id").is_empty()
            || result[if google { "name" } else { "displayName" }] != name)
    {
        return Err(remote_error());
    }
    Ok(result)
}
pub async fn trash_origin(client: &Client, mail: &Value, message: &Value) -> Result<Value> {
    if !can_organize(mail) {
        return Err(Error::new(
            403,
            "Mailbox organization permission is required.",
        ));
    }
    let provider = string(mail, "provider");
    let remote = message["remoteId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(message, "id"));
    let remote = remote
        .strip_prefix(&format!("{provider}:"))
        .ok_or_else(|| Error::invalid("Only imported messages can be organized."))?;
    let current = request(
        api(
            client,
            mail,
            reqwest::Method::GET,
            &format!(
                "/messages/{}?{}",
                component(remote),
                if provider == "google" {
                    "format=minimal"
                } else {
                    "$select=id,parentFolderId"
                }
            ),
        )?
        .header("Prefer", "IdType=\"ImmutableId\""),
        8 * 1024 * 1024,
    )
    .await?;
    if provider == "google" {
        let labels = current["labelIds"].as_array().ok_or_else(remote_error)?;
        if labels.contains(&json!("TRASH")) {
            return Err(Error::conflict(
                "This message is already in provider Trash.",
            ));
        }
        Ok(
            json!({"id":"restore-trash","kind":"restoreTrash","inbox":labels.contains(&json!("INBOX")),"spam":labels.contains(&json!("SPAM"))}),
        )
    } else {
        let id = string(&current, "parentFolderId");
        if !valid_microsoft_folder_id(id) {
            return Err(remote_error());
        }
        Ok(json!({"id":id}))
    }
}
pub async fn organize(
    client: &Client,
    mail: &Value,
    message: &Value,
    destination: &Value,
    mode: &str,
) -> Result<Value> {
    if !can_organize(mail) {
        return Err(Error::new(
            403,
            "Mailbox organization permission is required.",
        ));
    }
    let provider = string(mail, "provider");
    let remote = message["remoteId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(message, "id"));
    let remote = remote
        .strip_prefix(&format!("{provider}:"))
        .ok_or_else(|| Error::invalid("Only imported messages can be organized."))?;
    let path = format!("/messages/{}", component(remote));
    if provider == "google" {
        if mode == "restoreTrash" {
            let current = request(
                api(
                    client,
                    mail,
                    reqwest::Method::GET,
                    &format!("{path}?format=minimal"),
                )?,
                8 * 1024 * 1024,
            )
            .await?;
            if !current["labelIds"]
                .as_array()
                .is_some_and(|labels| labels.contains(&json!("TRASH")))
            {
                return Err(Error::conflict(
                    "This message is no longer in provider Trash.",
                ));
            }
            let mut add = Vec::new();
            let mut remove = vec![json!("TRASH")];
            for (key, label) in [("inbox", "INBOX"), ("spam", "SPAM")] {
                if destination[key] == true {
                    add.push(json!(label));
                } else {
                    remove.push(json!(label));
                }
            }
            let result = request(
                api(
                    client,
                    mail,
                    reqwest::Method::POST,
                    &format!("{path}/modify"),
                )?
                .json(&json!({"addLabelIds":add,"removeLabelIds":remove})),
                8 * 1024 * 1024,
            )
            .await?;
            let labels = result["labelIds"].as_array().ok_or_else(remote_error)?;
            if labels.contains(&json!("TRASH"))
                || labels.contains(&json!("INBOX")) != (destination["inbox"] == true)
                || labels.contains(&json!("SPAM")) != (destination["spam"] == true)
            {
                return Err(remote_error());
            }
            return Ok(
                json!({"providerLabelIds":labels,"folder":google_folder(&result["labelIds"]),"providerFolderName":"Gmail · restored","providerSent":labels.contains(&json!("SENT")),"providerDraft":labels.contains(&json!("DRAFT"))}),
            );
        }
        if mode != "move" && destination["kind"] != "label" {
            return Err(Error::invalid("Choose a custom Gmail label."));
        }
        let add = if mode == "removeLabel" || destination["kind"] == "archive" {
            vec![]
        } else {
            vec![destination["id"].clone()]
        };
        let remove = if mode == "removeLabel" {
            vec![destination["id"].clone()]
        } else if mode == "move" {
            vec![json!(if destination["id"] == "INBOX" {
                "SPAM"
            } else {
                "INBOX"
            })]
        } else {
            vec![]
        };
        let builder = api(
            client,
            mail,
            reqwest::Method::POST,
            &format!(
                "{path}/{}",
                if destination["kind"] == "trash" {
                    "trash"
                } else {
                    "modify"
                }
            ),
        )?;
        let result = request(
            if destination["kind"] == "trash" {
                builder.header(reqwest::header::CONTENT_LENGTH, "0")
            } else {
                builder.json(&json!({"addLabelIds":add,"removeLabelIds":remove}))
            },
            8 * 1024 * 1024,
        )
        .await?;
        let labels = result["labelIds"].as_array().ok_or_else(remote_error)?;
        let inbox = labels.contains(&json!("INBOX"));
        return Ok(
            json!({"providerLabelIds":labels,"folder":google_folder(&result["labelIds"]),"providerSent":labels.contains(&json!("SENT")),"providerDraft":labels.contains(&json!("DRAFT")),"providerFolderName":if destination["kind"]=="trash"{"Trash"}else if destination["kind"]=="spam"{"Spam"}else if inbox{"Inbox"}else{"Gmail · outside Inbox"}}),
        );
    }
    if !["move", "restoreTrash"].contains(&mode) {
        return Err(Error::invalid("Outlook supports folder moves."));
    }
    let current = request(
        api(
            client,
            mail,
            reqwest::Method::GET,
            &format!("{path}?$select=id,parentFolderId"),
        )?
        .header("Prefer", "IdType=\"ImmutableId\""),
        8 * 1024 * 1024,
    )
    .await?;
    if mode == "restoreTrash" && current["parentFolderId"] != destination["undoFrom"] {
        return Err(Error::conflict(
            "This message is no longer in provider Trash.",
        ));
    }
    if destination.get("sourceBeforeTrash").is_some()
        && current["parentFolderId"] != destination["sourceBeforeTrash"]
    {
        return Err(Error::conflict(
            "This message moved again. Refresh before moving it to Trash.",
        ));
    }
    let moved = if current["parentFolderId"] == destination["id"] {
        current
    } else {
        request(
            api(client, mail, reqwest::Method::POST, &format!("{path}/move"))?
                .header("Prefer", "IdType=\"ImmutableId\"")
                .json(&json!({"destinationId":destination["id"]})),
            8 * 1024 * 1024,
        )
        .await?
    };
    if string(&moved, "id").is_empty() || moved["parentFolderId"] != destination["id"] {
        return Err(remote_error());
    }
    Ok(
        json!({"remoteId":format!("microsoft:{}",string(&moved,"id")),"providerFolderId":destination["id"],"providerFolderName":destination["name"],"folder":if destination["kind"]=="inbox"{"inbox"}else if destination["kind"]=="spam"{"spam"}else if destination["kind"]=="trash"{"trash"}else{"archive"}}),
    )
}

#[cfg(test)]
mod quota_tests {
    use super::*;

    #[test]
    fn only_known_quota_reasons_retry() {
        for (reason, expected_code, delay) in [
            ("rateLimitExceeded", "provider_quota_exceeded", 60_000),
            ("userRateLimitExceeded", "provider_quota_exceeded", 60_000),
            (
                "dailyLimitExceeded",
                "provider_daily_quota_exceeded",
                86_400_000,
            ),
        ] {
            let code = provider_quota_code(&json!({"error":{"errors":[{"reason":reason}]}}));
            assert_eq!(code, Some(expected_code));
            let mut error = Error::new(502, "private provider detail");
            error.body["code"] = code.unwrap().into();
            assert_eq!(quota_retry_delay(&error, 0), Some(delay));
        }
        assert_eq!(
            provider_quota_code(
                &json!({"error":{"errors":[{"reason":"insufficientPermissions"}]}})
            ),
            None
        );
        let mut rate = Error::new(502, "private provider detail");
        rate.provider_status = Some(429);
        assert_eq!(quota_retry_delay(&rate, 4), Some(3_600_000));
    }
}
