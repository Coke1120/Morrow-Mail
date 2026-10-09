use crate::{
    error::{Error, Result},
    pages, policy,
    store::{Store, catalog, merge, string},
    validation,
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct App(pub Arc<Runtime>);
pub struct Runtime {
    pub activity: crate::activity::Runtime,
    dist: std::path::PathBuf,
    pub background: crate::background::Runtime,
    pub ai: crate::ai::Runtime,
    pub reply_suggestions: crate::reply_suggestions::Runtime,
    pub workflows: Mutex<std::collections::HashMap<String, Value>>,
    pub calendars: crate::calendar::CalendarState,
    pub oauth: crate::oauth::OAuthState,
    pub app_origin: String,
    pub google_oauth: Option<Value>,
    pub updater: crate::updater::Updater,
    pub smart: crate::smart_search::SmartState,
    store: Arc<Mutex<Store>>,
    db_slots: Arc<Semaphore>,
    requests: Semaphore,
    pub mailbox: tokio::sync::Mutex<()>,
    pub trash_undo: Mutex<std::collections::HashMap<String, crate::mail::TrashUndo>>,
    pub folder_reviews: Mutex<std::collections::HashMap<String, crate::folders::Review>>,
    pub sending: Mutex<std::collections::HashSet<(String, String)>>,
    pub client: reqwest::Client,
    pub port: u16,
    token: String,
    pub(crate) cli_token: String,
    pub(crate) cli_workspace: String,
    pub update_token: String,
    pub page_secret: [u8; 32],
}
#[derive(Clone)]
pub struct Context {
    pub method: Method,
    pub path: Vec<String>,
    pub body: Value,
    pub query: Value,
    pub headers: HeaderMap,
    pub owner: String,
    pub paged: bool,
}
impl Context {
    pub fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
    pub fn read_owner(&self, config: &Value, combined: bool) -> Result<String> {
        let owner = self.header("x-genmail-account");
        if owner == "all" && combined || valid_account(config, owner) {
            Ok(owner.into())
        } else {
            Err(Error::conflict("Choose the message’s owning mailbox."))
        }
    }
}
impl App {
    pub fn set_asset_directory(&mut self, directory: &Path) -> Result<()> {
        if !directory.is_absolute()
            || !directory.is_dir()
            || !directory.join("index.html").is_file()
        {
            return Err(Error::invalid("The desktop asset directory is invalid."));
        }
        Arc::get_mut(&mut self.0)
            .ok_or_else(|| Error::conflict("Desktop assets must be configured before startup."))?
            .dist = directory.canonicalize()?;
        Ok(())
    }
    pub fn open(directory: &Path, port: u16, token: String, update_token: String) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("MorrowMail/", env!("MORROW_VERSION")))
            .build()
            .map_err(|_| Error::new(500, "Could not initialize secure networking."))?;
        let executable = std::env::current_exe()?;
        let root = executable
            .parent()
            .ok_or_else(|| Error::new(500, "Could not locate the service."))?;
        let bundled = if root.file_name().is_some_and(|name| name == "runtime") {
            root.parent()
                .unwrap_or(root)
                .join("backend/google-oauth.json")
        } else {
            root.join("backend/google-oauth.json")
        };
        let google_oauth = crate::oauth::bundled_google_oauth(&bundled)?;
        let dist = bundled.parent().unwrap().join("dist");
        let store = Store::open(directory)?;
        let updater = crate::updater::Updater::new(directory, None, &update_token);
        crate::background::recover(&store)?;
        crate::learning::initialize(&store)?;
        crate::brain::initialize(&store)?;
        crate::scheduled::recover(&store)?;
        crate::reply_suggestions::initialize(&store)?;
        crate::smart_search::reconcile(&store)?;
        Ok(Self(Arc::new(Runtime {
            activity: Default::default(),
            dist,
            background: Default::default(),
            ai: Default::default(),
            reply_suggestions: Default::default(),
            workflows: Default::default(),
            calendars: Default::default(),
            oauth: Default::default(),
            app_origin: format!("http://localhost:{port}"),
            google_oauth,
            updater,
            smart: Default::default(),
            store: Arc::new(Mutex::new(store)),
            db_slots: Arc::new(Semaphore::new(1)),
            requests: Semaphore::new(32),
            mailbox: tokio::sync::Mutex::new(()),
            trash_undo: Default::default(),
            folder_reviews: Default::default(),
            sending: Mutex::new(std::collections::HashSet::new()),
            client,
            port,
            token,
            cli_token: hex_token()?,
            cli_workspace: crate::cli::workspace_id(directory)?,
            update_token,
            page_secret: crate::store::random_bytes()?,
        })))
    }
    pub async fn db<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .0
            .db_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::new(503, "The workspace is closing."))?;
        let store = self.0.store.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let db = store
                .lock()
                .map_err(|_| Error::new(503, "Restart Morrow Mail to reopen the workspace."))?;
            work(&db)
        })
        .await
        .map_err(|_| Error::new(500, "The database operation could not be completed."))?
    }
    pub fn router(&self) -> Router {
        Router::new().fallback(handle).with_state(self.clone())
    }
    pub async fn settings(&self) -> Result<Value> {
        self.db(|db| db.settings()).await
    }
    pub async fn state(&self, owner: &str, paged: bool) -> Result<Value> {
        let owner = owner.to_owned();
        let secret = self.0.page_secret;
        let mut result = self.db(move |db| state(db, &owner, paged, &secret)).await?;
        result["settings"]["oauthClients"]["google"]["configured"] =
            self.0.google_oauth.is_some().into();
        Ok(result)
    }
}
pub fn connections(config: &Value) -> Value {
    if config["mailAccounts"].is_object() {
        config["mailAccounts"].clone()
    } else if !string(&config["mail"], "email").is_empty() {
        json!({string(&config["mail"],"email"): config["mail"]})
    } else {
        json!({})
    }
}
pub fn valid_account(config: &Value, owner: &str) -> bool {
    owner == "demo" || connections(config).get(owner).is_some()
}
pub fn active_account(config: &Value) -> String {
    let account = string(config, "activeAccount");
    if account == "all" || valid_account(config, account) {
        account.into()
    } else {
        "demo".into()
    }
}
pub fn canonical_address(config: &Value, address: &str) -> String {
    connections(config)
        .as_object()
        .unwrap()
        .keys()
        .find(|key| key.to_lowercase() == address.to_lowercase())
        .cloned()
        .unwrap_or_else(|| address.to_owned())
}
pub fn reconnect_address(db: &Store, address: &str) -> Result<String> {
    let mut accounts = connections(&db.settings()?)
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut query = db.conn.prepare("SELECT DISTINCT account FROM messages")?;
    for account in query.query_map([], |row| row.get::<_, String>(0))? {
        accounts.insert(account?);
    }
    let mut matches = accounts
        .into_iter()
        .filter(|key| key.to_lowercase() == address.to_lowercase());
    let canonical = matches.next().unwrap_or_else(|| address.to_owned());
    if matches.next().is_some() {
        return Err(Error::conflict(
            "Multiple cached mailboxes differ only by address casing. Resolve their identities before reconnecting; cached data was retained.",
        ));
    }
    Ok(canonical)
}
pub fn workspace(config: &Value, owner: &str) -> Value {
    merge(
        json!({"activity":[],"reminders":[],"events":[],"unsubscribed":[],"brain":null,"skills":catalog()["skills"]}),
        &config["workspaces"][owner],
    )
}
pub fn save_workspace(db: &Store, owner: &str, patch: &Value) -> Result<()> {
    let config = db.settings()?;
    let mut workspaces = merge(json!({}), &config["workspaces"]);
    workspaces[owner] = merge(workspace(&config, owner), patch);
    db.set_settings(&json!({"workspaces":workspaces}))?;
    Ok(())
}
pub fn save_connection(db: &Store, connection: &Value, select: bool) -> Result<()> {
    db.transaction(|db| {
        let config = db.settings()?;
        let mut connection = connection.clone();
        let address = string(&connection, "email").to_owned();
        if select {
            connection["connectionId"] = uuid::Uuid::new_v4().to_string().into();
        }
        let mut accounts = connections(&config);
        accounts[&address] = connection.clone();
        let mut patch = json!({"mailAccounts":accounts});
        if select || config["mail"]["email"] == address {
            patch["mail"] = connection;
        }
        if select {
            patch["activeAccount"] = address.clone().into();
            let mut backoffs = merge(json!({}), &config["mailReadBackoffs"]);
            backoffs.as_object_mut().unwrap().remove(&address);
            patch["mailReadBackoffs"] = backoffs;
            patch["backgroundSyncErrors"] = config["backgroundSyncErrors"]
                .as_array()
                .map(|errors| {
                    errors
                        .iter()
                        .filter(|error| string(error, "accountId") != address)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
                .into();
        }
        db.set_settings(&patch)?;
        if select {
            crate::ai::invalidate(db)?;
        }
        crate::smart_search::reconcile(db)?;
        Ok(())
    })
}
pub fn get_message(db: &Store, owner: &str, id: &str) -> Result<Value> {
    db.get(owner, id)?
        .ok_or_else(|| Error::new(404, "Message not found."))
}
pub(crate) fn message_patch(original: &Value, body: &Value) -> Result<Value> {
    let mut patch = json!({});
    for key in ["read", "starred", "pending", "lowPriority"] {
        if let Some(value) = body.get(key) {
            if !value.is_boolean() {
                return Err(Error::invalid(
                    "Read, starred and pending must be true or false.",
                ));
            }
            patch[key] = value.clone();
        }
    }
    if let Some(folder) = body.get("folder") {
        if !["inbox", "archive", "trash"].contains(&folder.as_str().unwrap_or(""))
            || original["folder"] == "drafts" && folder != "trash"
        {
            return Err(Error::invalid("Save or send this draft before moving it."));
        }
        patch["folder"] = folder.clone();
    }
    if patch.as_object().unwrap().is_empty() {
        return Err(Error::invalid("No supported changes were provided."));
    }
    if original["providerLabelIds"].is_array()
        || string(original, "id").starts_with("microsoft:")
        || string(original, "remoteId").starts_with("microsoft:")
    {
        let mut overrides = original["localOverrides"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for key in patch.as_object().unwrap().keys() {
            if !["pending", "lowPriority"].contains(&key.as_str()) {
                overrides.insert(key.clone(), Value::Bool(true));
            }
        }
        patch["localOverrides"] = Value::Object(overrides);
    }
    Ok(patch)
}
pub fn safe_mail(mail: &Value) -> Value {
    let mut safe = json!({"configured":!string(mail,"email").is_empty(),"provider":"imap","email":"","imapHost":"","imapPort":993,"smtpHost":"","smtpPort":465,"clientId":"","canOrganize":crate::providers::can_organize(mail)});
    for key in [
        "provider", "email", "imapHost", "imapPort", "smtpHost", "smtpPort", "clientId",
    ] {
        if let Some(value) = mail.get(key).filter(|value| !value.is_null()) {
            safe[key] = value.clone();
        }
    }
    safe
}
pub fn state(db: &Store, selected: &str, paged: bool, secret: &[u8; 32]) -> Result<Value> {
    crate::smart_search::reconcile(db)?;
    let config = db.settings()?;
    let accounts = connections(&config);
    let view = if selected == "all" || valid_account(&config, selected) {
        selected.to_owned()
    } else {
        active_account(&config)
    };
    let style = crate::learning::state_with_store(db, &config, &view)?;
    let reports = crate::background::reports(db, &view)?;
    let overflow = crate::background::overflow(db, &view)?;
    let live = view != "all" && view != "demo";
    let mail = accounts.get(&view).unwrap_or(&config["mail"]);
    let ai = &config["ai"];
    let preferences = merge(catalog()["preferences"].clone(), &config["preferences"]);
    let ids: Vec<String> = accounts.as_object().unwrap().keys().cloned().collect();
    // Aggregate only validated reports; each model request still belongs to one mailbox.
    let mut today_reports = Vec::new();
    let mut today_overflow = 0;
    let mut today_replies = Vec::new();
    for owner in &ids {
        let reports = crate::background::reports(db, owner)?;
        for report in reports.as_array().into_iter().flatten() {
            let mut report = report.clone();
            report["reportId"] = report["id"].clone();
            report["id"] = json!([owner, report["id"]]).to_string().into();
            report["accountId"] = owner.clone().into();
            today_reports.push(report);
        }
        today_overflow += crate::background::overflow(db, owner)?;
        for proposal in crate::reply_suggestions::reviewed(db, owner)?
            .0
            .iter()
            .filter(|p| p["status"] == "ready")
            .take(5)
        {
            let mut proposal = proposal.clone();
            proposal["accountId"] = owner.clone().into();
            proposal["proposalId"] = proposal["id"].clone();
            proposal["id"] = json!([owner, proposal["id"]]).to_string().into();
            today_replies.push(proposal);
        }
    }
    let mut counted = ids.clone();
    counted.push("demo".into());
    let stats = pages::stats(db, &counted)?;
    let metadata=ids.iter().map(|id| merge(json!({"id":id,"email":id,"mode":"live","provider":accounts[id].get("provider").unwrap_or(&json!("imap")),"name":id.split('@').next().unwrap_or(""),"settings":safe_mail(&accounts[id]),"import":crate::background::import_status_from(&config,id)}),&stats[id])).collect::<Vec<_>>();
    let owners = if view == "all" {
        ids
    } else {
        vec![view.clone()]
    };
    let mut page = pages::page(db, &owners, &json!({}), secret)?;
    let messages = if paged {
        page.as_object_mut().unwrap().remove("messages").unwrap()
    } else {
        let mut values = Vec::new();
        for owner in owners {
            let summaries = if owner == view {
                reports.clone()
            } else {
                crate::background::reports(db, &owner)?
            };
            let mut by_message = std::collections::HashMap::new();
            for report in summaries.as_array().into_iter().flatten() {
                if report["kind"] == "arrival" && report["status"] == "completed" {
                    for id in report["messageIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        by_message.entry(id).or_insert(report);
                    }
                }
            }
            values.extend(db.list(&owner)?.into_iter().map(|mut message| {
                message["aiSummary"] = by_message
                    .get(string(&message, "id"))
                    .map_or(Value::Null, |report| (*report).clone());
                pages::owned(&owner, message)
            }));
        }
        values.sort_by(|a, b| {
            string(b, "date")
                .cmp(string(a, "date"))
                .then_with(|| string(a, "viewId").cmp(string(b, "viewId")))
        });
        json!(values)
    };
    let mut result = json!({"features":catalog()["features"],"account":{"id":view,"email":if live {view.as_str()} else if view=="all" {""} else {"alex@genmail.example"},"name":if view=="all" {"All accounts"} else if !string(&preferences,"displayName").is_empty() {string(&preferences,"displayName")} else if live {view.split('@').next().unwrap_or("")} else {"Alex Morgan"},"mode":if view=="all" {"combined"} else if live {"live"} else {"demo"},"provider":if live {mail.get("provider").cloned().unwrap_or(json!("imap"))} else {json!(view)}},"accounts":metadata,"syncErrors":config.get("backgroundSyncErrors").cloned().unwrap_or(json!([])),"revision":db.revision()?,"demoStats":stats["demo"],"messages":messages,
        "settings":{"oauthClients":{"google":{"configured":false},"microsoft":{"configured":true}},"mail":safe_mail(mail),"ai":{"configured":!string(ai,"baseUrl").is_empty()&&!string(ai,"model").is_empty(),"baseUrl":ai.get("baseUrl").cloned().unwrap_or(json!("http://127.0.0.1:11434/v1")),"model":string(ai,"model"),"hasApiKey":!string(ai,"apiKey").is_empty(),"temperature":ai.get("temperature").cloned().unwrap_or(json!(0.3)),"maxTokens":ai.get("maxTokens").cloned().unwrap_or(json!(1200))},"policy":policy::resolve(&config["policy"]),"preferences":preferences,"footer":crate::content::preferences_footer(&preferences)?,"calendars":crate::calendar::state(&config)},"workspace":workspace(&config,&view)});
    result["serverFolders"] = crate::folders::cached_catalogs(&config);
    result["workspace"]["styleLearning"] = style;
    result["workspace"]["brainLearning"] = crate::brain::learning_state(db, &view)?;
    result["workspace"]["summaries"] = reports;
    result["workspace"]["summaryOverflow"] = overflow.into();
    result["today"] = json!({"summaries":today_reports,"summaryOverflow":today_overflow,"replySuggestions":today_replies});
    if paged {
        result["mailPage"] = page;
    }
    Ok(result)
}
fn loopback_host(host: &str) -> bool {
    url::Url::parse(&format!("http://{host}")).is_ok_and(|url| {
        url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .host_str()
                .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]"].contains(&host))
    })
}
async fn handle(State(app): State<App>, request: axum::http::Request<Body>) -> Response {
    let response = handle_inner(app, request)
        .await
        .unwrap_or_else(IntoResponse::into_response);
    let (mut parts, body) = response.into_parts();
    for (key, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("cross-origin-resource-policy", "same-origin"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        ),
        ("cache-control", "no-store"),
    ] {
        parts.headers.insert(
            axum::http::HeaderName::from_static(key),
            axum::http::HeaderValue::from_static(value),
        );
    }
    Response::from_parts(parts, body)
}
async fn handle_inner(app: App, request: axum::http::Request<Body>) -> Result<Response> {
    let _slot = app
        .0
        .requests
        .try_acquire()
        .map_err(|_| Error::new(429, "Too many requests. Try again shortly."))?;
    let (parts, body) = request.into_parts();
    let header = |name: &str| {
        parts
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    };
    if !loopback_host(header("host")) {
        return Err(Error::new(
            403,
            "Morrow Mail accepts localhost requests only.",
        ));
    }
    let path: Vec<String> = parts
        .uri
        .path()
        .trim_end_matches('/')
        .split('/')
        .skip(1)
        .map(|s| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8()
                .map(|s| s.into_owned())
                .map_err(|_| Error::invalid("Invalid URL."))
        })
        .collect::<Result<_>>()?;
    if path.first().is_none_or(|v| !v.eq_ignore_ascii_case("api")) {
        return static_response(&app, &parts, &path).await;
    }
    let path = path[1..].to_vec();
    let route: Vec<String> = path.iter().map(|s| s.to_ascii_lowercase()).collect();
    let route: Vec<&str> = route.iter().map(String::as_str).collect();
    let callback = parts.method == Method::GET
        && route.len() == 3
        && ["oauth", "calendar-oauth"].contains(&route[0])
        && ["google", "microsoft"].contains(&route[1])
        && ["callback", "authorize"].contains(&route[2]);
    let cli_route = route == ["cli"] || route == ["cli", "health"];
    let cli_health = parts.method == Method::GET && route == ["cli", "health"];
    let cli_auth = cli_route
        && validation::same_secret(
            header("authorization"),
            &format!("Bearer {}", app.0.cli_token),
        );
    if !callback
        && !cli_auth
        && !cli_health
        && !app.0.token.is_empty()
        && !validation::same_secret(header("authorization"), &format!("Bearer {}", app.0.token))
    {
        return Err(Error::new(
            401,
            "Open Morrow Mail to access this workspace.",
        ));
    }
    let origin = header("origin");
    let origins = [
        format!("http://localhost:{}", app.0.port),
        format!("http://127.0.0.1:{}", app.0.port),
        "http://localhost:5173".into(),
        "http://127.0.0.1:5173".into(),
    ];
    if !callback
        && ((!origin.is_empty() && !origins.iter().any(|v| v == origin))
            || header("sec-fetch-site") == "cross-site")
    {
        return Err(Error::new(
            403,
            "This request did not come from Morrow Mail.",
        ));
    }
    let mutation =
        [Method::POST, Method::PATCH, Method::PUT, Method::DELETE].contains(&parts.method);
    if mutation
        && !header("content-type")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    {
        return Err(Error::new(415, "Use application/json."));
    }
    let bound = mutation
        && matches!(
            route.as_slice(),
            ["send" | "drafts" | "ai" | "sync" | "skills"]
                | ["drafts", "prepare" | "resolve"]
                | ["messages", _]
                | ["messages", _, "organize" | "trash" | "undo-trash"]
                | [
                    "workflows"
                        | "imports"
                        | "style"
                        | "skills"
                        | "workspace"
                        | "scheduled"
                        | "out-of-office"
                        | "reply-suggestions",
                    ..
                ]
                | ["account", "disconnect"]
                | ["mail", "folders", ..]
        );
    let bytes = tokio::time::timeout(Duration::from_secs(15), to_bytes(body, 256 * 1024))
        .await
        .map_err(|_| Error::new(408, "Request body timed out."))?
        .map_err(|_| Error::new(413, "Request body exceeds 256 KiB."))?;
    let body = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes)?
    };
    if !body.is_object() {
        return Err(Error::invalid("Request must contain a JSON object."));
    }
    let mut query = json!({});
    for (key, value) in url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes()) {
        if query.get(key.as_ref()).is_some() {
            return Err(Error::invalid("Repeated query parameter."));
        }
        query[key.as_ref()] = value.into_owned().into();
    }
    if cli_route {
        return match (parts.method.as_str(), route.as_slice()) {
            ("GET", ["cli", "health"]) => {
                Ok(Json(crate::cli::health(&app, string(&query, "nonce"))?).into_response())
            }
            ("POST", ["cli"]) => {
                let command = serde_json::from_value(body)
                    .map_err(|_| Error::invalid("Invalid CLI command."))?;
                Ok(Json(crate::cli::execute(&app, command).await?).into_response())
            }
            _ => Err(Error::new(404, "Not found.")),
        };
    }
    let config = app.settings().await?;
    let supplied = header("x-genmail-account");
    if bound && !valid_account(&config, supplied) && !(route == ["sync"] && supplied == "all") {
        return Err(Error::conflict(
            "Choose a connected mailbox before continuing. This account may have been disconnected.",
        ));
    }
    let owner = if supplied == "all" || valid_account(&config, supplied) {
        supplied.to_owned()
    } else {
        active_account(&config)
    };
    let paged = header("x-morrow-view") == "paged";
    let context = Context {
        method: parts.method,
        path,
        body,
        query,
        headers: parts.headers,
        owner,
        paged,
    };
    let mut activity =
        (context.method == Method::POST && route == ["workspace", "brain", "preview"]).then(|| {
            app.0.activity.start(
                &context.owner,
                "ai",
                "AI assistance",
                "Waiting for the configured model",
            )
        });
    let result = dispatch(&app, context).await;
    if let Some(work) = &mut activity {
        work.finish(result.as_ref().is_ok_and(|r| r.status().is_success()), None);
    }
    result
}
pub(crate) async fn dispatch(app: &App, context: Context) -> Result<Response> {
    if let Some(response) = crate::folders::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::calendar::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::oauth::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::updater::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::smart_search::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::background::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::ai::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::local_rules::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::workflows::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::learning::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::reply_suggestions::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::out_of_office::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::scheduled::handle(app, &context).await? {
        return Ok(response);
    }
    if let Some(response) = crate::mail::handle(app, &context).await? {
        return Ok(response);
    }
    let route: Vec<String> = context
        .path
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let route: Vec<&str> = route.iter().map(String::as_str).collect();
    let owner = context.owner.clone();
    let body = context.body.clone();
    let secret = app.0.page_secret;
    let mut result = match (context.method.as_str(), route.as_slice()) {
        ("POST", ["backup"]) => {
            if app.0.update_token.is_empty()
                || !validation::same_secret(context.header("x-morrow-update"), &app.0.update_token)
            {
                return Err(Error::new(403, "Back up from the desktop app controls."));
            }
            let destination = std::path::PathBuf::from(validation::text(
                &body["destination"],
                "Backup destination",
                4096,
                false,
            )?);
            if !destination.is_absolute() {
                return Err(Error::invalid("Choose an absolute backup destination."));
            }
            let _mail = app.0.mailbox.try_lock().map_err(|_| {
                Error::conflict("Wait for the current mailbox operation before backing up.")
            })?;
            let _google = app
                .0
                .calendars
                .provider("google")?
                .change
                .try_lock()
                .map_err(|_| crate::calendar::busy())?;
            let _microsoft = app
                .0
                .calendars
                .provider("microsoft")?
                .change
                .try_lock()
                .map_err(|_| crate::calendar::busy())?;
            app.db(move |db| db.backup(&destination)).await?;
            json!({"saved":true})
        }
        ("GET", ["health"]) => {
            app.settings().await?;
            json!({"status":"ok","service":"morrow-mail"})
        }
        ("GET", ["state"]) => app.state(&owner, context.paged).await?,
        ("GET", ["activity"]) => app.0.activity.snapshot(&app.settings().await?),
        ("GET", ["state", "revision"]) => {
            app.db(move |db| Ok(json!({"revision":db.revision()?,"accountId":owner})))
                .await?
        }
        ("POST", ["mail", "page"]) => {
            let context = context.clone();
            app.db(move |db| {
                let config = db.settings()?;
                let owner = context.read_owner(&config, true)?;
                let owners = if owner == "all" {
                    connections(&config)
                        .as_object()
                        .unwrap()
                        .keys()
                        .cloned()
                        .collect()
                } else {
                    vec![owner]
                };
                pages::page(db, &owners, &body, &secret)
            })
            .await?
        }
        ("GET", ["messages", _, "history"]) => {
            let context = context.clone();
            app.db(move |db| {
                let owner = context.read_owner(&db.settings()?, false)?;
                crate::drafts::history(db, &owner, &context.path[1])
            })
            .await?
        }
        ("GET", ["messages", _]) => {
            let context = context.clone();
            app.db(move |db| {
                let owner = context.read_owner(&db.settings()?, false)?;
                let mut message = get_message(db, &owner, &context.path[1])?;
                message["aiSummary"] = crate::background::reports(db, &owner)?
                    .as_array()
                    .and_then(|rows| {
                        rows.iter().find(|report| {
                            report["kind"] == "arrival"
                                && report["status"] == "completed"
                                && report["messageIds"]
                                    .as_array()
                                    .is_some_and(|ids| ids.contains(&message["id"]))
                        })
                    })
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({"message":pages::owned(&owner,message)}))
            })
            .await?
        }
        ("POST", ["account", "select" | "demo" | "live"]) => {
            let action = route[1].to_owned();
            let paged = context.paged;
            app.db(move |db| {
                let config = db.settings()?;
                let accounts = connections(&config);
                let selected = if action == "demo" {
                    "demo".to_owned()
                } else if action == "live" && string(&body, "accountId").is_empty() {
                    accounts
                        .get(string(&config["mail"], "email"))
                        .and_then(|mail| mail["email"].as_str())
                        .or_else(|| {
                            accounts
                                .as_object()
                                .unwrap()
                                .keys()
                                .next()
                                .map(String::as_str)
                        })
                        .unwrap_or("")
                        .into()
                } else {
                    string(&body, "accountId").into()
                };
                if selected != "all" && !valid_account(&config, &selected) {
                    return Err(Error::conflict("Choose a connected mailbox."));
                }
                let mut patch = json!({"activeAccount":selected});
                if let Some(mail) = accounts.get(&selected) {
                    patch["mail"] = mail.clone();
                }
                db.set_settings(&patch)?;
                state(db, &selected, paged, &secret)
            })
            .await?
        }
        ("POST", ["settings", "policy"]) => {
            app.db(move |db| {
                db.transaction(|db| {
                    let config = db.settings()?;
                    let previous = policy::resolve(&config["policy"]);
                    let policy = policy::update(&config["policy"], &body)?;
                    db.set_settings(&json!({"policy":policy}))?;
                    crate::ai::invalidate(db)?;
                    crate::smart_search::reconcile(db)?;
                    if previous["summarySchedule"] != policy["summarySchedule"]
                        || previous["enabled"] != true && policy["enabled"] == true
                        || previous["triggers"]["scheduledSummary"] != true
                            && policy["triggers"]["scheduledSummary"] == true
                        || previous["behaviors"]["briefing"] != true
                            && policy["behaviors"]["briefing"] == true
                    {
                        crate::background::reset_schedules(db)?;
                    }
                    Ok(())
                })
            })
            .await?;
            app.0.smart.invalidate().await;
            app.state(&owner, context.paged).await?
        }
        ("PATCH", ["messages", _]) => {
            let id = context.path[1].clone();
            crate::mail::ensure_draft_idle(app, &owner, &id)?;
            app.db(move |db| {
                if !valid_account(&db.settings()?, &owner) {
                    return Err(Error::conflict("This account was disconnected."));
                }
                let original = get_message(db, &owner, &id)?;
                crate::scheduled::guard_draft(db, &owner, &id, None)?;
                let patch = message_patch(&original, &body)?;
                Ok(json!({"message":pages::owned(&owner,db.update(&owner,&id,&patch)?.unwrap())}))
            })
            .await?
        }
        _ => return Err(Error::new(404, "Not found.")),
    };
    if result.get("settings").is_some() {
        result["settings"]["oauthClients"]["google"]["configured"] =
            app.0.google_oauth.is_some().into();
    }
    Ok((StatusCode::OK, Json(result)).into_response())
}

async fn static_response(
    app: &App,
    parts: &axum::http::request::Parts,
    path: &[String],
) -> Result<Response> {
    if ![Method::GET, Method::HEAD].contains(&parts.method) {
        return Err(Error::new(404, "Not found."));
    }
    let authenticated = app.0.token.is_empty()
        || parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| {
                validation::same_secret(value, &format!("Bearer {}", app.0.token))
            });
    let root = path.is_empty() || path.iter().all(String::is_empty);
    if root && !authenticated {
        let failed = url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
            .any(|(key, _)| ["connectionError", "calendarError"].contains(&key.as_ref()));
        let html = format!(
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Morrow Mail</title><style>body{{font:18px system-ui;max-width:36rem;margin:15vh auto;padding:2rem;color:#193c34;background:#f5f4ec}}h1{{font-size:32px}}</style><h1>{}</h1><p>{}</p></html>",
            if failed {
                "Connection was not completed."
            } else {
                "Return to Morrow Mail."
            },
            if failed {
                "Check your provider app registration and permissions, then try connecting again in Settings."
            } else {
                "You can close this browser tab. Your connection status will refresh when you return to the app."
            }
        );
        return Ok(([("content-type","text/html; charset=utf-8"),("content-security-policy","default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")],if parts.method==Method::HEAD{String::new()}else{html}).into_response());
    }
    if !authenticated {
        return Err(Error::new(
            401,
            "Open Morrow Mail to access this workspace.",
        ));
    }
    if path
        .iter()
        .any(|part| part == ".." || part == "." || part.contains(['\\', '/', '\0']))
    {
        return Err(Error::new(404, "Not found."));
    }
    let canonical = match tokio::fs::canonicalize(&app.0.dist).await {
        Ok(path) => path,
        Err(_) => {
            if root {
                return Ok("Morrow Mail API is ready.".into_response());
            }
            return Err(Error::new(404, "Not found."));
        }
    };
    let mut target = canonical.clone();
    for part in path {
        target.push(part);
    }
    if root
        || !tokio::fs::metadata(&target)
            .await
            .is_ok_and(|meta| meta.is_file())
    {
        target = canonical.join("index.html");
    }
    let target = tokio::fs::canonicalize(target)
        .await
        .map_err(|_| Error::new(404, "Not found."))?;
    if !target.starts_with(&canonical) {
        return Err(Error::new(404, "Not found."));
    }
    let metadata = tokio::fs::metadata(&target).await?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err(Error::new(404, "Not found."));
    }
    let mime = match target.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "json" => "application/json",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    let bytes = if parts.method == Method::HEAD {
        Vec::new()
    } else {
        tokio::fs::read(&target).await?
    };
    Ok(([("content-type",mime),("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")],bytes).into_response())
}
#[allow(dead_code)]
fn assert_handler_send(app: App, request: axum::http::Request<Body>) {
    fn check<T: Send>(_: T) {}
    check(handle_inner(app, request));
}

pub(crate) fn hex_token() -> Result<String> {
    Ok(crate::store::random_bytes::<32>()?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
