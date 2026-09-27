use crate::{
    background, calendar,
    error::{Error, Result},
    mail, providers,
    service::{App, Context, canonical_address, connections, save_connection},
    store::{merge, random_bytes, string},
    validation,
};
use axum::{
    Json,
    http::{HeaderValue, header},
    response::{IntoResponse, Redirect, Response},
};
use chrono::Utc;
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashMap, io::Read, path::Path, sync::LazyLock};
use tokio::sync::Mutex;

// Public desktop application ID; shared with the Node compatibility service.
pub const MICROSOFT_CLIENT_ID: &str = include_str!("../../shared/microsoft-client-id.txt");

#[derive(Default)]
pub struct OAuthState {
    pending: Mutex<HashMap<String, Attempt>>,
}
struct Attempt {
    provider: String,
    calendar: bool,
    value: Value,
    browser_token: String,
    expires_at: i64,
    started: bool,
    import_options: Option<Value>,
    upgrade: Option<Value>,
}
pub fn parse_google_oauth(source: &str) -> Result<Value> {
    let invalid = || Error::invalid("Use a valid Google Desktop app OAuth JSON file.");
    if source.len() > 32768 {
        return Err(invalid());
    }
    let value: Value = serde_json::from_str(source).map_err(|_| invalid())?;
    static ID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9._-]{1,1000}\.apps\.googleusercontent\.com$").unwrap()
    });
    let id = string(&value["installed"], "client_id");
    let secret = string(&value["installed"], "client_secret");
    if !value["web"].is_null()
        || !ID.is_match(id)
        || secret.is_empty()
        || secret.encode_utf16().count() > 4096
        || secret
            .chars()
            .any(|c| c.is_whitespace() || c.is_ascii_control())
    {
        return Err(invalid());
    }
    Ok(json!({"clientId":id,"clientSecret":secret}))
}
pub fn bundled_google_oauth(file: &Path) -> Result<Option<Value>> {
    let source = match std::fs::File::open(file) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    source.take(32769).read_to_end(&mut bytes)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Error::invalid("Use a valid Google Desktop app OAuth JSON file."))?;
    parse_google_oauth(text).map(Some)
}
pub fn credentials(provider: &str, body: &Value, google: Option<&Value>) -> Result<Value> {
    if body
        .get("useDefaultClient")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(Error::invalid("Choose a valid OAuth client option."));
    }
    if body["useDefaultClient"] != true {
        return Ok(body.clone());
    }
    let microsoft = json!({"clientId": MICROSOFT_CLIENT_ID.trim()});
    let client = match provider {
        "microsoft" => Some(&microsoft),
        "google" => google,
        _ => None,
    }
    .ok_or_else(|| {
        Error::invalid(
            "Built-in sign-in is not configured for this provider. Use your own OAuth client.",
        )
    })?;
    if body
        .get("clientId")
        .is_some_and(|v| !v.is_null() && v != "" && v != false)
        || body
            .get("clientSecret")
            .is_some_and(|v| !v.is_null() && v != "" && v != false)
    {
        return Err(Error::invalid(
            "Choose either the built-in OAuth client or your own credentials.",
        ));
    }
    Ok(merge(body.clone(), client))
}
fn cookie_name(provider: &str, calendar: bool) -> String {
    if calendar {
        format!("morrow_calendar_{provider}")
    } else {
        "genmail_oauth".into()
    }
}
fn cookie_path(provider: &str, calendar: bool) -> String {
    if calendar {
        format!("/api/calendar-oauth/{provider}")
    } else {
        "/api/oauth".into()
    }
}
fn redirect(location: &str, cookie: Option<String>) -> Result<Response> {
    let mut response = Redirect::temporary(location).into_response();
    // Express uses 302 for browser handoff; preserve that API contract.
    *response.status_mut() = axum::http::StatusCode::FOUND;
    if let Some(cookie) = cookie {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&cookie)
                .map_err(|_| Error::new(500, "Could not initialize the browser connection."))?,
        );
    }
    Ok(response)
}
fn expired(calendar: bool) -> Error {
    Error::invalid(if calendar {
        "Calendar connection expired or could not be verified. Start again from Settings."
    } else {
        "Connection expired or could not be verified. Start again from Settings."
    })
}
pub(crate) async fn invalidate_calendar(app: &App, provider: &str) {
    app.0
        .oauth
        .pending
        .lock()
        .await
        .retain(|_, attempt| !attempt.calendar || attempt.provider != provider);
}
async fn start(app: &App, ctx: &Context, provider: &str, calendar: bool) -> Result<Response> {
    providers::definition(provider)?;
    if ctx.body.get("outOfOffice").is_some_and(|v| !v.is_boolean()) {
        return Err(Error::invalid("Choose a valid automatic-reply permission."));
    }
    let upgrade = if ctx.body.get("forAccount").is_some() {
        let owner = validation::email(&ctx.body["forAccount"])?;
        if calendar
            || ctx.body["outOfOffice"] != true
            || ctx.header("x-genmail-account") != owner
            || ctx
                .body
                .as_object()
                .unwrap()
                .keys()
                .any(|key| !["forAccount", "outOfOffice"].contains(&key.as_str()))
        {
            return Err(Error::invalid(
                "Authorize automatic replies for this mailbox only.",
            ));
        }
        let saved = connections(&app.settings().await?)
            .get(&owner)
            .cloned()
            .filter(|mail| mail["provider"] == provider)
            .ok_or_else(|| Error::conflict("Choose a connected mailbox for this provider."))?;
        Some(saved)
    } else {
        None
    };
    let credentials = if let Some(saved) = &upgrade {
        saved.clone()
    } else {
        credentials(provider, &ctx.body, app.0.google_oauth.as_ref())?
    };
    let id = calendar::text(&credentials["clientId"], "OAuth client ID", 1024, false)?.trim();
    if id.contains(['\r', '\n', '\t']) {
        return Err(Error::invalid("OAuth client ID must be a single line."));
    }
    let mut config = json!({"clientId":id,"organize":upgrade.as_ref().map(providers::can_organize).unwrap_or(ctx.body["organize"]==true),"outOfOffice":!calendar && ctx.body["outOfOffice"]==true});
    if calendar {
        let settings = app.settings().await?;
        let existing = &settings["calendars"][provider];
        let secret = if credentials
            .get("clientSecret")
            .is_some_and(|v| !v.is_null() && v != "")
        {
            &credentials["clientSecret"]
        } else if credentials["useDefaultClient"] != true && existing["clientId"] == id {
            &existing["clientSecret"]
        } else {
            &Value::Null
        };
        if !secret.is_null() && secret != "" {
            config["clientSecret"] = calendar::text(secret, "Client secret", 4096, false)?
                .trim()
                .into();
        }
    } else if provider == "google" {
        config["clientSecret"] = calendar::text(
            &credentials["clientSecret"],
            "Google client secret",
            4096,
            false,
        )?
        .trim()
        .into();
    }
    if upgrade.is_some()
        && provider == "microsoft"
        && !string(&credentials, "clientSecret").is_empty()
    {
        config["clientSecret"] = credentials["clientSecret"].clone();
    }
    if string(&config, "clientSecret").contains(['\r', '\n', '\t']) {
        return Err(Error::invalid("Client secret must be a single line."));
    }
    let options = if !calendar {
        ctx.body
            .get("importOptions")
            .map(background::import_options)
            .transpose()?
    } else {
        None
    };
    let prefix = if calendar { "calendar-oauth" } else { "oauth" };
    let redirect_uri = format!(
        "http://localhost:{}/api/{prefix}/{provider}/callback",
        app.0.port
    );
    let mut value = providers::oauth_start(
        provider,
        &config,
        &redirect_uri,
        if calendar { "calendar" } else { "mail" },
    )?;
    value["redirectUri"] = redirect_uri.into();
    let state = string(&value, "state").to_owned();
    let mut pending = app.0.oauth.pending.lock().await;
    let now = Utc::now().timestamp_millis();
    pending.retain(|_, attempt| {
        attempt.expires_at >= now && !(calendar && attempt.calendar && attempt.provider == provider)
    });
    if pending
        .values()
        .filter(|attempt| attempt.calendar == calendar)
        .count()
        >= 20
    {
        return Err(Error::new(
            429,
            if calendar {
                "Too many pending connections. Try again in ten minutes."
            } else {
                "Too many pending connections. Wait a few minutes and try again."
            },
        ));
    }
    let browser_token = random_bytes::<32>()?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    pending.insert(
        state.clone(),
        Attempt {
            provider: provider.into(),
            calendar,
            value,
            browser_token,
            expires_at: now + 600_000,
            started: false,
            import_options: options,
            upgrade,
        },
    );
    Ok(Json(json!({"url":format!("http://localhost:{}/api/{prefix}/{provider}/authorize?state={}",app.0.port,providers::component(&state))})).into_response())
}
pub(crate) async fn start_calendar(app: &App, ctx: &Context, provider: &str) -> Result<Response> {
    let state = app.0.calendars.provider(provider)?;
    let _change = state.change.try_lock().map_err(|_| calendar::busy())?;
    start(app, ctx, provider, true).await
}
async fn authorize(app: &App, ctx: &Context, provider: &str, calendar: bool) -> Result<Response> {
    let mut pending = app.0.oauth.pending.lock().await;
    let attempt = pending
        .get_mut(string(&ctx.query, "state"))
        .ok_or_else(|| expired(calendar))?;
    if attempt.provider != provider
        || attempt.calendar != calendar
        || attempt.expires_at < Utc::now().timestamp_millis()
        || attempt.started
    {
        return Err(expired(calendar));
    }
    attempt.started = true;
    redirect(
        string(&attempt.value, "url"),
        Some(format!(
            "{}={}; Path={}; HttpOnly; SameSite=Lax; Max-Age=600",
            cookie_name(provider, calendar),
            attempt.browser_token,
            cookie_path(provider, calendar)
        )),
    )
}
async fn finish_mail(app: &App, attempt: &Attempt, code: &str) -> Result<()> {
    let _mailbox = app.0.mailbox.try_lock().map_err(|_| {
        Error::conflict("Another mailbox operation is running. Try again when it finishes.")
    })?;
    let failed = || {
        Error::invalid(
            "The provider connection failed. Check your app registration and permissions, then try again.",
        )
    };
    let mut connection =
        providers::oauth_finish(&app.0.client, &attempt.provider, &attempt.value, code)
            .await
            .map_err(|_| failed())?;
    let messages = if attempt.import_options.is_none() && attempt.upgrade.is_none() {
        let result = providers::fetch_page(&app.0.client, &connection, &json!({}))
            .await
            .map_err(|_| failed())?;
        result["messages"]
            .as_array()
            .filter(|rows| rows.len() <= 50)
            .ok_or_else(failed)?
            .clone()
    } else {
        Vec::new()
    };
    let options = attempt.import_options.clone();
    let upgrade = attempt.upgrade.clone();
    app.db(move |db| {
        db.transaction(|db| {
            let email =
                canonical_address(&db.settings()?, &validation::email(&connection["email"])?);
            connection["email"] = email.clone().into();
            if let Some(previous) = upgrade {
                let current = connections(&db.settings()?);
                let owner = string(&previous,"email");
                if !email.eq_ignore_ascii_case(owner) || current.get(owner).is_none_or(|v| v["connectionId"] != previous["connectionId"] || v["authorizationId"] != previous["authorizationId"] || v["provider"] != previous["provider"] || v["clientId"] != previous["clientId"]) {
                    return Err(Error::conflict("The mailbox changed. Authorize automatic replies again for the original account."));
                }
                if crate::out_of_office::capability(&connection, owner)["canWrite"] != true
                    || (providers::can_organize(&current[owner]) && !providers::can_organize(&connection)) {
                    return Err(Error::new(403, "Automatic reply permissions were not fully granted. The existing mail connection was retained."));
                }
                connection = merge(current[owner].clone(), &connection);
                // Keep history checkpoints but reject older authorization windows.
                connection["authorizationId"] = uuid::Uuid::new_v4().to_string().into();
                save_connection(db, &connection, false)?;
                crate::ai::invalidate(db)?;
                return Ok(());
            }
            mail::import_messages(db, &connection, &messages)?;
            save_connection(db, &connection, true)?;
            if let Some(options) = options {
                background::start_import(db, &email, &options)?;
            }
            Ok(())
        })
    })
    .await
}
async fn finish_calendar(app: &App, attempt: &Attempt, code: &str) -> Result<()> {
    let state = app.0.calendars.provider(&attempt.provider)?;
    let _change = state.change.try_lock().map_err(|_| calendar::busy())?;
    let connection = providers::oauth_finish(
        &app.0.client,
        &attempt.provider,
        &attempt.value,
        code,
    )
    .await
    .map_err(|_| {
        Error::new(
            502,
            "Calendar connection failed. Check your app registration and calendar permissions.",
        )
    })?;
    calendar::list_calendars(&app.0.client,&connection).await.map_err(|_|Error::new(502,"Calendar access could not be verified. Check the calendar permissions and try again."))?;
    let mut generation = state.generation.lock().await;
    let provider = attempt.provider.clone();
    app.db(move |db| calendar::save_connection(db, &provider, connection))
        .await?;
    *generation += 1;
    invalidate_calendar(app, &attempt.provider).await;
    Ok(())
}
async fn callback(app: &App, ctx: &Context, provider: &str, calendar: bool) -> Result<Response> {
    // Remove before validation or awaiting the provider: all callbacks are one use.
    let attempt = app
        .0
        .oauth
        .pending
        .lock()
        .await
        .remove(string(&ctx.query, "state"));
    let result = async {
        let attempt = attempt.ok_or_else(|| expired(calendar))?;
        let cookie_name = format!("{}=", cookie_name(provider, calendar));
        let cookie = ctx
            .header("cookie")
            .split(';')
            .map(str::trim)
            .find_map(|v| v.strip_prefix(&cookie_name))
            .unwrap_or("");
        if !attempt.started
            || attempt.provider != provider
            || attempt.calendar != calendar
            || attempt.expires_at < Utc::now().timestamp_millis()
            || !validation::same_secret(cookie, &attempt.browser_token)
        {
            return Err(expired(calendar));
        }
        if ctx
            .query
            .get("error")
            .is_some_and(|v| v != "" && !v.is_null())
        {
            return Err(Error::invalid(if calendar {
                "Calendar access was not granted. Try again from Settings."
            } else {
                "Mailbox access was not granted. Try again from Settings."
            }));
        }
        let code = calendar::text(&ctx.query["code"], "Authorization code", 8192, false)?;
        if calendar {
            finish_calendar(app, &attempt, code).await
        } else {
            finish_mail(app, &attempt, code).await
        }
    }
    .await;
    let mut destination = url::Url::parse(&app.0.app_origin)
        .map_err(|_| Error::new(500, "Invalid application origin."))?;
    match result {
        Ok(()) => {
            destination.query_pairs_mut().append_pair(
                if calendar {
                    "calendarConnected"
                } else {
                    "connected"
                },
                provider,
            );
        }
        Err(error) => {
            destination.query_pairs_mut().append_pair(
                if calendar {
                    "calendarError"
                } else {
                    "connectionError"
                },
                if error.status == 500 {
                    if calendar {
                        "Calendar connection failed. Try again from Settings."
                    } else {
                        "Connection failed. Try again from Settings."
                    }
                } else {
                    string(&error.body, "error")
                },
            );
        }
    }
    redirect(
        destination.as_str(),
        Some(format!(
            "{}=; Path={}; HttpOnly; SameSite=Lax; Max-Age=0",
            cookie_name(provider, calendar),
            cookie_path(provider, calendar)
        )),
    )
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path: Vec<_> = ctx.path.iter().map(String::as_str).collect();
    let response = match (ctx.method.as_str(), path.as_slice()) {
        ("POST", ["oauth", provider, "start"]) => start(app, ctx, provider, false).await?,
        ("GET", [prefix @ ("oauth" | "calendar-oauth"), provider, "authorize"]) => {
            providers::definition(provider)?;
            authorize(app, ctx, provider, *prefix == "calendar-oauth").await?
        }
        ("GET", [prefix @ ("oauth" | "calendar-oauth"), provider, "callback"]) => {
            providers::definition(provider)?;
            callback(app, ctx, provider, *prefix == "calendar-oauth").await?
        }
        _ => return Ok(None),
    };
    Ok(Some(response))
}
