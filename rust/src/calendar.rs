use crate::{
    content,
    error::{Error, Result},
    oauth, providers,
    service::{App, Context},
    store::{Store, merge, now, string},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock},
};
use tokio::sync::Mutex;

pub const PROVIDERS: [&str; 2] = ["google", "microsoft"];
type Refresh = Shared<BoxFuture<'static, std::result::Result<Value, Arc<Error>>>>;
#[derive(Default)]
pub struct CalendarState {
    providers: [ProviderState; 2],
}
#[derive(Default)]
pub(crate) struct ProviderState {
    pub change: Mutex<()>,
    pub generation: Mutex<u64>,
    refreshing: Mutex<Option<(uuid::Uuid, Refresh)>>,
}
impl CalendarState {
    pub(crate) fn provider(&self, provider: &str) -> Result<&ProviderState> {
        Ok(&self.providers[provider_index(provider)?])
    }
}
fn provider_index(provider: &str) -> Result<usize> {
    PROVIDERS
        .iter()
        .position(|p| *p == provider)
        .ok_or_else(|| Error::invalid("Choose Google Calendar or Outlook Calendar."))
}
pub fn state(config: &Value) -> Value {
    json!(PROVIDERS.iter().map(|provider| {
        let connection = &config["calendars"][provider];
        json!({"provider":provider,"email":string(connection,"email"),"clientId":string(connection,"clientId"),
            "connected":!string(connection,"email").is_empty() && (!string(connection,"accessToken").is_empty() || !string(connection,"refreshToken").is_empty()),
            "hasClientSecret":!string(connection,"clientSecret").is_empty()})
    }).collect::<Vec<_>>())
}
pub(crate) fn busy() -> Error {
    Error::conflict("Another calendar change is in progress. Wait for it to finish.")
}
fn changed() -> Error {
    Error::conflict("This calendar connection changed. Reload the calendars.")
}
pub(crate) fn save_connection(db: &Store, provider: &str, connection: Value) -> Result<()> {
    let mut calendars = merge(json!({}), &db.settings()?["calendars"]);
    calendars[provider] = connection;
    db.set_settings(&json!({"calendars":calendars}))?;
    Ok(())
}
fn connected(config: &Value, provider: &str, expected_email: Option<&str>) -> Result<Value> {
    let connection = &config["calendars"][provider];
    if string(connection, "email").is_empty()
        || (string(connection, "accessToken").is_empty()
            && string(connection, "refreshToken").is_empty())
    {
        return Err(Error::conflict("Connect this calendar in Settings first."));
    }
    if expected_email.is_some_and(|email| email != string(connection, "email")) {
        return Err(changed());
    }
    Ok(connection.clone())
}
async fn check_generation(app: &App, provider: &str, generation: u64) -> Result<()> {
    if *app.0.calendars.provider(provider)?.generation.lock().await != generation {
        return Err(changed());
    }
    Ok(())
}
async fn refresh_connection(app: &App, provider: &str, generation: u64) -> Result<Value> {
    check_generation(app, provider, generation).await?;
    let connection = connected(&app.settings().await?, provider, None)?;
    let refreshed = providers::refresh(&app.0.client, &connection)
        .await
        .map_err(|_| {
            Error::new(
                401,
                "Calendar authorization expired or could not be refreshed. Reconnect in Settings.",
            )
        })?;
    let current = app.0.calendars.provider(provider)?.generation.lock().await;
    if *current != generation {
        return Err(changed());
    }
    let provider = provider.to_owned();
    let saved = refreshed.clone();
    app.db(move |db| {
        if connected(&db.settings()?, &provider, None)? != connection {
            return Err(changed());
        }
        save_connection(db, &provider, saved)
    })
    .await?;
    Ok(refreshed)
}
async fn current_connection(app: &App, provider: &str) -> Result<Value> {
    let state = app.0.calendars.provider(provider)?;
    let (id, future) = {
        let mut slot = state.refreshing.lock().await;
        if let Some(pending) = slot.as_ref() {
            pending.clone()
        } else {
            let generation = *state.generation.lock().await;
            let app = app.clone();
            let provider = provider.to_owned();
            let id = uuid::Uuid::new_v4();
            // Finish refresh/rotation even if the initiating HTTP request is cancelled.
            let task = tokio::spawn(async move {
                let result = refresh_connection(&app, &provider, generation)
                    .await
                    .map_err(Arc::new);
                let mut slot = app
                    .0
                    .calendars
                    .provider(&provider)
                    .expect("validated provider")
                    .refreshing
                    .lock()
                    .await;
                if slot.as_ref().is_some_and(|pending| pending.0 == id) {
                    *slot = None;
                }
                result
            });
            let future = async move {
                task.await.unwrap_or_else(|_| {
                    Err(Arc::new(Error::new(
                        503,
                        "Calendar refresh was interrupted. Try again.",
                    )))
                })
            }
            .boxed()
            .shared();
            let pending = (id, future);
            *slot = Some(pending.clone());
            pending
        }
    };
    let result = future.await;
    let mut slot = state.refreshing.lock().await;
    if slot.as_ref().is_some_and(|pending| pending.0 == id) {
        *slot = None;
    }
    result.map_err(|e| Error {
        status: e.status,
        body: e.body.clone(),
        provider_status: e.provider_status,
    })
}
pub(crate) fn text<'a>(
    value: &'a Value,
    name: &str,
    max: usize,
    optional: bool,
) -> Result<&'a str> {
    value.as_str().filter(|s| s.encode_utf16().count() <= max && (optional || !s.trim().is_empty()) && !s.chars().any(|c| matches!(c, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}')))
        .ok_or_else(|| Error::invalid(&format!("{name} must be {} and at most {max} characters.", if optional {"text"} else {"provided"})))
}
fn date_time(value: &Value) -> Result<String> {
    static FORMAT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$")
            .unwrap()
    });
    let value = value
        .as_str()
        .filter(|v| FORMAT.is_match(v))
        .ok_or_else(|| Error::invalid("Use a date and time with an explicit time zone."))?;
    let normalized = if value.as_bytes().get(16) != Some(&b':') {
        format!("{}:00{}", &value[..16], &value[16..])
    } else {
        value.to_owned()
    };
    let invalid = || Error::invalid("Choose a valid calendar date, time, and time zone.");
    let date = DateTime::parse_from_rfc3339(&normalized).map_err(|_| invalid())?;
    if date.year() < 1900
        || date.offset().local_minus_utc().abs() > 14 * 3600
        || normalized[17..19].parse::<u32>().unwrap_or(60) > 59
    {
        return Err(invalid());
    }
    Ok(date
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn range(start: &Value, end: &Value, listing: bool) -> Result<(String, String)> {
    let start = date_time(start)?;
    let end = date_time(end)?;
    let duration = DateTime::parse_from_rfc3339(&end)
        .unwrap()
        .timestamp_millis()
        - DateTime::parse_from_rfc3339(&start)
            .unwrap()
            .timestamp_millis();
    if duration <= 0 || duration > 90 * 86_400_000 + if listing { 2 * 3_600_000 } else { 0 } {
        return Err(Error::invalid(
            "The end must be after the start, within 90 days.",
        ));
    }
    Ok((start, end))
}
fn reminder(value: Option<&Value>, provider: &str) -> Result<Option<Value>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.as_object().is_none_or(|fields| {
        fields
            .keys()
            .any(|key| !["method", "minutes"].contains(&key.as_str()))
    }) || !["none", "popup", "email"].contains(&string(value, "method"))
    {
        return Err(Error::invalid(
            "Choose no reminder, a popup reminder or a supported email reminder.",
        ));
    }
    let method = string(value, "method");
    if method == "none" {
        return Ok(Some(json!({"method":"none"})));
    }
    if provider == "microsoft" && method == "email" {
        return Err(Error::invalid(
            "Outlook Calendar supports popup reminders only. Choose popup, none or the provider default.",
        ));
    }
    let minutes = value["minutes"]
        .as_f64()
        .filter(|n| (0.0..=40320.0).contains(n) && n.fract() == 0.0)
        .ok_or_else(|| Error::invalid("Reminder minutes must be an integer between 0 and 40320."))?
        as u32;
    Ok(Some(json!({"method":method,"minutes":minutes})))
}
fn event_input(input: &Value, provider: &str) -> Result<(String, Value)> {
    let allowed = [
        "calendarId",
        "title",
        "description",
        "location",
        "start",
        "end",
        "requestId",
        "connectionEmail",
        "reminder",
    ];
    if input
        .as_object()
        .is_none_or(|v| v.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err(Error::invalid(
            "Only the displayed event details are supported. Attendees and invitations are not supported.",
        ));
    }
    let email = text(
        &input["connectionEmail"],
        "Connected calendar email",
        254,
        false,
    )?
    .to_owned();
    let request_id = text(&input["requestId"], "Event request ID", 36, false)?.to_ascii_lowercase();
    static UUID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .unwrap()
    });
    if !UUID.is_match(&request_id) {
        return Err(Error::invalid("Use a valid unique event request ID."));
    }
    let calendar = text(&input["calendarId"], "Calendar", 2048, false)?;
    calendar_path("google", calendar)?;
    let title = text(&input["title"], "Event title", 300, false)?.trim();
    let empty = json!("");
    let description = text(
        input
            .get("description")
            .filter(|v| !v.is_null())
            .unwrap_or(&empty),
        "Description",
        10000,
        true,
    )?;
    let location = text(
        input
            .get("location")
            .filter(|v| !v.is_null())
            .unwrap_or(&empty),
        "Location",
        1000,
        true,
    )?;
    if title.contains(['\r', '\n', '\t']) || location.contains(['\r', '\n']) {
        return Err(Error::invalid(
            "Event title and location must be single lines.",
        ));
    }
    let (start, end) = range(&input["start"], &input["end"], false)?;
    // Preserve Node's insertion order: existing calendarRequests use this JSON fingerprint.
    let mut value = json!({"calendarId":calendar,"title":title,"description":description,"location":location,"start":start,"end":end,"requestId":request_id});
    if let Some(reminder) = reminder(input.get("reminder"), provider)? {
        value["reminder"] = reminder;
    }
    Ok((email, value))
}
fn fingerprint(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
fn matches(record: &Value, provider: &str, email: &str, request_id: &str) -> bool {
    record["provider"] == provider && record["email"] == email && record["requestId"] == request_id
}
fn prior_request(db: &Store, provider: &str, email: &str, value: &Value) -> Result<Option<Value>> {
    let config = db.settings()?;
    connected(&config, provider, Some(email))?;
    let prior = config["calendarRequests"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| matches(row, provider, email, string(value, "requestId")))
        })
        .cloned();
    if let Some(record) = &prior
        && (record["payloadHash"] != fingerprint(value)
            || record
                .get("payload")
                .is_some_and(|payload| payload != value))
    {
        return Err(Error::conflict(
            "This event request ID was already used for different details. Reload before creating a different event.",
        ));
    }
    Ok(prior)
}
fn persist_request(
    db: &Store,
    provider: &str,
    email: &str,
    value: &Value,
    event: Option<Value>,
) -> Result<()> {
    let prior = prior_request(db, provider, email, value)?;
    let config = db.settings()?;
    let mut records = config["calendarRequests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if prior.is_none() {
        if records.len() >= 100 {
            let completed = records.iter().position(|record| !record["event"].is_null()).ok_or_else(||Error::conflict("There are too many unconfirmed calendar requests. Resolve them before adding events."))?;
            records.remove(completed);
        }
        records.push(json!({"provider":provider,"email":email,"requestId":value["requestId"],"payloadHash":fingerprint(value),"payload":value,"createdAt":now()}));
    }
    for record in &mut records {
        if matches(record, provider, email, string(value, "requestId")) {
            record["payload"] = value.clone();
            if let Some(event) = &event {
                record["event"] = event.clone();
            }
        }
    }
    db.set_settings(&json!({"calendarRequests":records}))?;
    Ok(())
}
async fn create(app: &App, provider: &str, input: &Value) -> Result<Value> {
    let (email, value) = event_input(input, provider)?;
    let state = app.0.calendars.provider(provider)?;
    let _change = state.change.try_lock().map_err(|_| busy())?;
    let (p, e, v) = (provider.to_owned(), email.clone(), value.clone());
    let prior = app.db(move |db| prior_request(db, &p, &e, &v)).await?;
    if let Some(event) = prior
        .as_ref()
        .and_then(|r| r.get("event"))
        .filter(|event| !event.is_null())
    {
        return Ok(json!({"event":event}));
    }
    let generation = *state.generation.lock().await;
    let connection = current_connection(app, provider).await?;
    connected(&app.settings().await?, provider, Some(&email))?;
    let calendars = list_calendars(&app.0.client, &connection)
        .await
        .map_err(|_| Error::new(502, "Could not verify calendar permissions. Try again."))?;
    check_generation(app, provider, generation).await?;
    if !calendars
        .iter()
        .any(|c| c["id"] == value["calendarId"] && c["canWrite"] == true)
    {
        return Err(Error::new(
            403,
            "Choose a calendar that permits you to create events.",
        ));
    }
    let (p, e, v) = (provider.to_owned(), email.clone(), value.clone());
    app.db(move |db| persist_request(db, &p, &e, &v, None))
        .await?;
    let event = create_event(&app.0.client,&connection,&value).await.map_err(|_|Error::new(502,"Creating this event could not be confirmed. Check your calendar before retrying; retrying these same details reuses the event request ID."))?;
    check_generation(app, provider, generation).await?;
    if string(&event, "id").is_empty() {
        return Err(Error::new(
            502,
            "The provider did not confirm an event ID. Check your calendar before retrying.",
        ));
    }
    let (p, e, v, saved) = (provider.to_owned(), email, value, event.clone());
    app.db(move |db| persist_request(db, &p, &e, &v, Some(saved)))
        .await?;
    Ok(json!({"event":event}))
}
pub async fn handle(app: &App, ctx: &Context) -> Result<Option<Response>> {
    let path: Vec<_> = ctx.path.iter().map(String::as_str).collect();
    let result = match (ctx.method.as_str(), path.as_slice()) {
        ("GET", ["calendars"]) => {
            let mut calendars = Vec::new();
            let mut errors = Vec::new();
            let results = futures_util::future::join_all(PROVIDERS.iter().map(|provider| async move {
                let generation = *app.0.calendars.provider(provider)?.generation.lock().await;
                if string(&app.settings().await?["calendars"][provider],"email").is_empty() { return Ok(Vec::new()); }
                let connection = current_connection(app,provider).await?;
                let result = list_calendars(&app.0.client,&connection).await.map_err(|_|Error::new(502,"Could not load calendars. Check your connection and calendar permissions."))?;
                check_generation(app,provider,generation).await?;
                Ok::<_,Error>(result.into_iter().map(|c|merge(c,&json!({"provider":provider}))).collect())
            })).await;
            for (provider, result) in PROVIDERS.iter().zip(results) {
                match result { Ok(values)=>calendars.extend(values), Err(error)=>errors.push(json!({"provider":provider,"message":if error.status==500 {"Could not load calendars."} else {string(&error.body,"error")}})) }
            }
            let mut connections = state(&app.settings().await?);
            for connection in connections.as_array_mut().unwrap() {
                connection["hasDefaultClient"] = (connection["provider"] == "microsoft"
                    || (connection["provider"] == "google" && app.0.google_oauth.is_some()))
                .into();
                connection["redirectUri"] = format!(
                    "http://localhost:{}/api/calendar-oauth/{}/callback",
                    app.0.port,
                    string(connection, "provider")
                )
                .into();
            }
            json!({"connections":connections,"calendars":calendars,"errors":errors})
        }
        ("POST", ["calendars", provider, "connect"]) => {
            return oauth::start_calendar(app, ctx, provider).await.map(Some);
        }
        ("POST", ["calendars", provider, "disconnect"]) => {
            let state = app.0.calendars.provider(provider)?;
            let email = text(
                &ctx.body["connectionEmail"],
                "Connected calendar email",
                254,
                false,
            )?
            .to_owned();
            let _change = state.change.try_lock().map_err(|_| busy())?;
            let mut generation = state.generation.lock().await;
            let p = provider.to_string();
            app.db(move |db| {
                connected(&db.settings()?, &p, Some(&email))?;
                save_connection(db, &p, Value::Null)
            })
            .await?;
            *generation += 1;
            oauth::invalidate_calendar(app, provider).await;
            json!({"ok":true})
        }
        ("GET", ["calendars", provider, "events"]) => {
            let state = app.0.calendars.provider(provider)?;
            let calendar = text(&ctx.query["calendarId"], "Calendar", 2048, false)?;
            calendar_path(provider, calendar)?;
            let (start, end) = range(&ctx.query["start"], &ctx.query["end"], true)?;
            let generation = *state.generation.lock().await;
            let connection = current_connection(app, provider).await?;
            let events = list_events(&app.0.client, &connection, calendar, &start, &end)
                .await
                .map_err(|error| {
                    if ["calendar_all_day_limit", "calendar_all_day_timezone"]
                        .contains(&string(&error.body, "code"))
                    {
                        return error;
                    }
                    Error::new(
                        502,
                        "Could not load events. Check your calendar access and try again.",
                    )
                })?;
            check_generation(app, provider, generation).await?;
            json!({"events":events})
        }
        ("POST", ["calendars", provider, "events"]) => create(app, provider, &ctx.body).await?,
        _ => return Ok(None),
    };
    Ok(Some(Json(result).into_response()))
}
fn connection_provider(connection: &Value) -> Result<&str> {
    let provider = string(connection, "provider");
    provider_index(provider)?;
    if string(connection, "accessToken").is_empty() {
        return Err(Error::invalid(
            "A connected Google or Microsoft calendar is required.",
        ));
    }
    Ok(provider)
}
fn origin(provider: &str) -> &'static str {
    if provider == "google" {
        "https://www.googleapis.com"
    } else {
        "https://graph.microsoft.com"
    }
}
fn calendar_path(provider: &str, id: &str) -> Result<String> {
    if id.is_empty()
        || id.encode_utf16().count() > 2048
        || id.chars().any(|c| c.is_ascii_control())
        || [".", ".."].contains(&id)
    {
        return Err(Error::invalid("A valid calendar ID is required."));
    }
    Ok(format!(
        "{}/calendars/{}",
        if provider == "google" {
            "/calendar/v3"
        } else {
            "/v1.0/me"
        },
        providers::component(id)
    ))
}
fn request(
    client: &reqwest::Client,
    connection: &Value,
    method: reqwest::Method,
    url: url::Url,
    timezone: Option<&str>,
) -> Result<reqwest::RequestBuilder> {
    let provider = connection_provider(connection)?;
    if url.origin().ascii_serialization() != origin(provider)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new(
            502,
            "The calendar provider returned an unsafe next page.",
        ));
    }
    let mut request = client
        .request(method, url)
        .bearer_auth(string(connection, "accessToken"))
        .timeout(std::time::Duration::from_secs(30));
    if provider == "microsoft" {
        request = request.header(
            "Prefer",
            format!(
                "outlook.timezone=\"{}\", outlook.body-content-type=\"text\"",
                timezone.unwrap_or("UTC")
            ),
        );
    }
    Ok(request)
}
async fn pages(
    client: &reqwest::Client,
    connection: &Value,
    path: &str,
    limit: usize,
) -> Result<Vec<Value>> {
    let provider = connection_provider(connection)?;
    let original = url::Url::parse(&format!("{}{path}", origin(provider)))
        .map_err(|_| providers::remote_error())?;
    let mut next = original.clone();
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    // ponytail: at most ten complete pages; add incremental sync for larger calendars.
    for _ in 0..10 {
        if !seen.insert(next.to_string()) {
            return Err(Error::new(
                502,
                "The calendar provider returned a repeated page.",
            ));
        }
        let result = providers::request(
            request(client, connection, reqwest::Method::GET, next, None)?,
            8 * 1024 * 1024,
        )
        .await?;
        if !result.is_object() {
            return Err(providers::remote_error());
        }
        if let Some(entries) = result.get(if provider == "google" {
            "items"
        } else {
            "value"
        }) {
            items.extend(
                entries
                    .as_array()
                    .ok_or_else(providers::remote_error)?
                    .iter()
                    .cloned(),
            );
        }
        if items.len() > limit {
            return Err(Error::new(
                502,
                &format!(
                    "This calendar request exceeds {limit} items. Select a smaller date range."
                ),
            ));
        }
        let cursor = &result[if provider == "google" {
            "nextPageToken"
        } else {
            "@odata.nextLink"
        }];
        if cursor.is_null() || cursor == "" {
            return Ok(items);
        }
        let cursor = cursor
            .as_str()
            .filter(|s| s.len() <= 8192)
            .ok_or_else(providers::remote_error)?;
        next = if provider == "google" {
            let mut next = original.clone();
            next.query_pairs_mut().append_pair("pageToken", cursor);
            next
        } else {
            providers::validated_next(cursor, &original)?
        };
    }
    Err(Error::new(
        502,
        "This calendar request has too many pages. Select a smaller date range.",
    ))
}
pub async fn list_calendars(client: &reqwest::Client, connection: &Value) -> Result<Vec<Value>> {
    let google = connection_provider(connection)? == "google";
    let items = pages(
        client,
        connection,
        if google {
            "/calendar/v3/users/me/calendarList?maxResults=100"
        } else {
            "/v1.0/me/calendars?$top=100&$select=id,name,isDefaultCalendar,canEdit,hexColor"
        },
        500,
    )
    .await?;
    Ok(items.iter().filter(|item|item["id"].is_string() && item["deleted"]!=true).map(|item| {
        let name=if google {item["summaryOverride"].as_str().filter(|v|!v.is_empty()).or(item["summary"].as_str())} else {item["name"].as_str()}.filter(|v|!v.is_empty()).unwrap_or("Untitled calendar");
        let mut calendar = json!({"id":item["id"],"name":name.chars().take(500).collect::<String>(),"primary":item[if google {"primary"} else {"isDefaultCalendar"}]==true,
            "canWrite":if google {["owner","writer"].contains(&string(item,"accessRole"))} else {item["canEdit"]==true},"timeZone":if google {item["timeZone"].as_str().unwrap_or("UTC")} else {"UTC"}})
        ;
        let color = string(item, if google {"backgroundColor"} else {"hexColor"});
        if color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit()) { calendar["color"] = color.into(); }
        calendar
    }).collect())
}
fn instant(value: &str) -> Result<String> {
    static FORMAT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$").unwrap()
    });
    let invalid =
        || Error::invalid("Calendar dates must be valid ISO timestamps with a time zone.");
    if !FORMAT.is_match(value) {
        return Err(invalid());
    }
    Ok(DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid())?
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn event_date(value: &Value, provider: &str, all_day: bool) -> Result<String> {
    if all_day {
        // Preserve the provider's civil dates, including its exclusive all-day end.
        let date = if provider == "google" {
            string(value, "date")
        } else {
            string(value, "dateTime").get(..10).unwrap_or("")
        };
        instant(&format!("{date}T00:00:00Z"))?;
        return Ok(date.into());
    }
    let mut date = string(value, "dateTime").to_owned();
    let has_zone =
        date.ends_with(['Z', 'z']) || date.get(19..).is_some_and(|s| s.contains(['+', '-']));
    if provider == "microsoft" && !has_zone {
        if !["", "UTC", "Etc/UTC"].contains(&string(value, "timeZone")) {
            return Err(Error::new(
                502,
                "Outlook Calendar did not return the requested UTC event times.",
            ));
        }
        date.push('Z');
    }
    instant(&date)
}
fn normalize_event(item: &Value, provider: &str, calendar: &str) -> Result<Value> {
    if string(item, "id").is_empty() {
        return Err(Error::new(
            502,
            "The calendar provider returned an invalid event.",
        ));
    }
    let google = provider == "google";
    let all_day = if google {
        !string(&item["start"], "date").is_empty()
    } else {
        item["isAllDay"] == true
    };
    let description = if google {
        string(item, "description")
    } else {
        string(&item["body"], "content")
    }
    .chars()
    .take(100000)
    .collect::<String>();
    let description = if google || string(&item["body"], "contentType").eq_ignore_ascii_case("html")
    {
        content::plain_html(&description)?
    } else {
        description
    };
    let web_url = string(item, if google { "htmlLink" } else { "webLink" });
    let web_url = if url::Url::parse(web_url)
        .is_ok_and(|u| u.scheme() == "https" && u.username().is_empty() && u.password().is_none())
    {
        web_url
    } else {
        ""
    };
    Ok(
        json!({"id":item["id"],"title":item[if google {"summary"} else {"subject"}].as_str().filter(|s|!s.is_empty()).unwrap_or("(No title)").chars().take(1000).collect::<String>(),
        "description":description,"location":if google {string(item,"location")} else {string(&item["location"],"displayName")}.chars().take(2000).collect::<String>(),
        "start":event_date(&item["start"],provider,all_day)?,"end":event_date(&item["end"],provider,all_day)?,"allDay":all_day,"webUrl":web_url,"calendarId":calendar,
        "status":if item["status"]=="cancelled" || item["isCancelled"]==true {"cancelled"} else {"confirmed"}}),
    )
}
fn provider_range(start: &str, end: &str) -> Result<(String, String)> {
    let start = instant(start)?;
    let end = instant(end)?;
    let duration = DateTime::parse_from_rfc3339(&end)
        .unwrap()
        .timestamp_millis()
        - DateTime::parse_from_rfc3339(&start)
            .unwrap()
            .timestamp_millis();
    if duration <= 0 || duration > 366 * 86_400_000 {
        return Err(Error::invalid(
            "Choose a calendar date range of no more than 366 days.",
        ));
    }
    Ok((start, end))
}
fn all_day_error(limit: bool) -> Error {
    let mut error = Error::new(
        502,
        if limit {
            "More than 100 Outlook all-day events need timezone verification. Select a smaller date range."
        } else {
            "Outlook could not verify all-day dates in their original timezone. Open the affected calendar in Outlook; custom or unrecognized timezones are not supported."
        },
    );
    error.body["code"] = if limit {
        "calendar_all_day_limit"
    } else {
        "calendar_all_day_timezone"
    }
    .into();
    error
}
fn original_zone(item: &Value) -> Result<&str> {
    let zone = string(item, "originalStartTimeZone");
    if zone.is_empty()
        || zone.len() > 128
        || zone != string(item, "originalEndTimeZone")
        || zone.trim() != zone
        || zone.to_ascii_lowercase().contains("custom")
        || !zone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_ .+/-".contains(c))
    {
        return Err(all_day_error(false));
    }
    Ok(zone)
}
fn midnight_bounds(item: &Value, zone: &str) -> bool {
    static MIDNIGHT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,7})?$").unwrap());
    if item["isAllDay"] != true
        || item["isCancelled"] == true
        || ["start", "end"].iter().any(|key| {
            string(&item[key], "timeZone") != zone
                || !MIDNIGHT.is_match(string(&item[key], "dateTime"))
        })
    {
        return false;
    }
    match (
        event_date(&item["start"], "microsoft", true),
        event_date(&item["end"], "microsoft", true),
    ) {
        (Ok(start), Ok(end)) => start < end,
        _ => false,
    }
}
fn verified_all_day(item: &Value, zone: &str) -> bool {
    string(item, "originalStartTimeZone") == zone
        && string(item, "originalEndTimeZone") == zone
        && midnight_bounds(item, zone)
}
async fn repair_all_day(
    client: &reqwest::Client,
    connection: &Value,
    base: &str,
    items: &mut [Value],
) -> Result<()> {
    let mut repairs = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if item["isAllDay"] != true
            || midnight_bounds(item, "UTC")
            || midnight_bounds(item, "Etc/UTC")
        {
            continue;
        }
        let zone = original_zone(item)?;
        if !verified_all_day(item, zone) {
            repairs.push((index, zone.to_owned(), string(item, "id").to_owned()));
        }
    }
    if repairs.len() > 100 {
        return Err(all_day_error(true));
    }
    // Graph knows its own timezone rules. Repair at most four independent reads at once.
    for batch in repairs.chunks(4) {
        let requests = batch.iter().map(|(index, zone, id)| async move {
            if id.is_empty()
                || id.encode_utf16().count() > 2048
                || id.chars().any(|c| c.is_ascii_control())
                || [".", ".."].contains(&id.as_str())
            {
                return Err(all_day_error(false));
            }
            let url = url::Url::parse(&format!(
                "{}{base}/events/{}?$select=id,isAllDay,isCancelled,start,end,originalStartTimeZone,originalEndTimeZone",
                origin("microsoft"), providers::component(id)
            )).map_err(|_| all_day_error(false))?;
            let result = providers::request(
                request(client, connection, reqwest::Method::GET, url, Some(zone))?,
                8 * 1024 * 1024,
            ).await.map_err(|_| all_day_error(false))?;
            if string(&result, "id") != id || !verified_all_day(&result, zone) {
                return Err(all_day_error(false));
            }
            Ok((*index, result["start"].clone(), result["end"].clone()))
        });
        let repaired = futures_util::future::try_join_all(requests).await?;
        for (index, start, end) in repaired {
            items[index]["start"] = start;
            items[index]["end"] = end;
        }
    }
    Ok(())
}
pub async fn list_events(
    client: &reqwest::Client,
    connection: &Value,
    calendar: &str,
    start: &str,
    end: &str,
) -> Result<Vec<Value>> {
    let provider = connection_provider(connection)?;
    let base = calendar_path(provider, calendar)?;
    let (start, end) = provider_range(start, end)?;
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        if provider == "google" {
            query.extend_pairs([
                ("timeMin", start.as_str()),
                ("timeMax", &end),
                ("singleEvents", "true"),
                ("orderBy", "startTime"),
                ("showDeleted", "false"),
                ("maxResults", "250"),
            ]);
        } else {
            query.extend_pairs([
                ("startDateTime", start.as_str()),
                ("endDateTime", &end),
                ("$top", "250"),
                ("$orderby", "start/dateTime"),
                (
                    "$select",
                    "id,subject,body,location,start,end,isAllDay,isCancelled,webLink,type,originalStartTimeZone,originalEndTimeZone",
                ),
            ]);
        }
        query.finish()
    };
    let path = format!(
        "{base}/{}?{}",
        if provider == "google" {
            "events"
        } else {
            "calendarView"
        },
        query
    );
    let mut items = pages(client, connection, &path, 1000).await?;
    items.retain(|i| !i.is_null() && i["status"] != "cancelled" && i["isCancelled"] != true);
    if provider == "microsoft" {
        repair_all_day(client, connection, &base, &mut items).await?;
    }
    items
        .iter()
        .map(|i| normalize_event(i, provider, calendar))
        .collect()
}
pub async fn create_event(
    client: &reqwest::Client,
    connection: &Value,
    value: &Value,
) -> Result<Value> {
    let provider = connection_provider(connection)?;
    let reminder = reminder(value.get("reminder"), provider)?;
    let calendar = string(value, "calendarId");
    let base = calendar_path(provider, calendar)?;
    let title = text(&value["title"], "Event title", 300, false)?.trim();
    if title.chars().any(|c| c.is_ascii_control()) {
        return Err(Error::invalid(
            "A calendar event title of up to 300 characters is required.",
        ));
    }
    let empty = json!("");
    let description = text(
        value.get("description").unwrap_or(&empty),
        "Description",
        10000,
        true,
    )?;
    let location = text(
        value.get("location").unwrap_or(&empty),
        "Location",
        1000,
        true,
    )?;
    let request_id = string(value, "requestId").to_lowercase();
    if request_id.len() != 36 || uuid::Uuid::parse_str(&request_id).is_err() {
        return Err(Error::invalid(
            "A UUID request ID is required to create a calendar event.",
        ));
    }
    let (start, end) = provider_range(string(value, "start"), string(value, "end"))?;
    let id = format!("m{:x}", Sha256::digest(request_id.as_bytes()));
    let mut body = if provider == "google" {
        json!({"id":id,"summary":title,"description":description.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('\n',"<br>"),"location":location,"start":{"dateTime":start},"end":{"dateTime":end}})
    } else {
        json!({"transactionId":request_id,"subject":title,"body":{"contentType":"text","content":description},"location":{"displayName":location},"start":{"dateTime":start.trim_end_matches('Z'),"timeZone":"UTC"},"end":{"dateTime":end.trim_end_matches('Z'),"timeZone":"UTC"}})
    };
    if let Some(reminder) = reminder {
        let method = string(&reminder, "method");
        if provider == "google" {
            body["reminders"] = json!({"useDefault":false,"overrides":if method == "none" {vec![]} else {vec![reminder]}});
        } else {
            body["isReminderOn"] = (method != "none").into();
            if method == "popup" {
                body["reminderMinutesBeforeStart"] = reminder["minutes"].clone();
            }
        }
    }
    let url = url::Url::parse(&format!(
        "{}{base}/events{}",
        origin(provider),
        if provider == "google" {
            "?sendUpdates=none"
        } else {
            ""
        }
    ))
    .map_err(|_| providers::remote_error())?;
    let result = providers::request(
        request(client, connection, reqwest::Method::POST, url, None)?.json(&body),
        8 * 1024 * 1024,
    )
    .await;
    let result = match result {
        Err(error) if provider == "google" && error.provider_status == Some(409) => {
            let url = url::Url::parse(&format!("{}{base}/events/{id}", origin(provider)))
                .map_err(|_| providers::remote_error())?;
            let saved = providers::request(
                request(client, connection, reqwest::Method::GET, url, None)?,
                8 * 1024 * 1024,
            )
            .await?;
            if saved["status"] == "cancelled"
                || saved["summary"] != body["summary"]
                || string(&saved, "description") != string(&body, "description")
                || string(&saved, "location") != location
                || event_date(&saved["start"], provider, false)? != start
                || event_date(&saved["end"], provider, false)? != end
                || !same_google_reminder(&saved["reminders"], body.get("reminders"))
            {
                return Err(Error::conflict(
                    "This calendar request ID was already used for different event details. Refresh before creating a new event.",
                ));
            }
            saved
        }
        result => result?,
    };
    normalize_event(&result, provider, calendar)
}
fn same_google_reminder(saved: &Value, expected: Option<&Value>) -> bool {
    let Some(expected) = expected else {
        return true;
    }; // Preserve legacy recovery behavior.
    if saved["useDefault"] != false {
        return false;
    }
    let empty = vec![];
    let overrides = if saved.get("overrides").is_none() {
        Some(&empty)
    } else {
        saved["overrides"].as_array()
    };
    overrides.is_some_and(|overrides| {
        let expected = expected["overrides"]
            .as_array()
            .expect("validated reminder overrides");
        overrides.len() == expected.len()
            && overrides.iter().zip(expected).all(|(saved, expected)| {
                saved["method"] == expected["method"]
                    && saved["minutes"].as_f64() == expected["minutes"].as_f64()
            })
    })
}
