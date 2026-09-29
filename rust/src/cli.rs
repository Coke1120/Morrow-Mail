//! Agent CLI: the same owned mailbox operations, with no scheduler or implicit send.
use crate::{
    content,
    error::{Error, Result},
    pages,
    service::{self, App, Context},
    store::{self, Store, string},
    validation,
};
use axum::{
    body::to_bytes,
    http::{HeaderMap, Method},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

const INPUT_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const ENDPOINT: &str = "cli.json";

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    Accounts {},
    List {
        account: String,
        folder: String,
        sort: String,
        page: u32,
        limit: usize,
    },
    Read {
        account: String,
        id: String,
    },
    Search {
        account: String,
        query: String,
        page: u32,
    },
    Draft {
        account: String,
        message: Value,
    },
    Review {
        account: String,
        id: String,
    },
    Send {
        review: Review,
        confirm: bool,
        retry_unconfirmed: bool,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    account: String,
    draft_id: String,
    request_id: String,
    message: Value,
    from_name: String,
    review_hash: String,
    unconfirmed: bool,
    simulated: bool,
}
fn owner(config: &Value, account: &str, combined: bool) -> Result<String> {
    validation::text(&json!(account), "Account", 254, false)?;
    let owner = service::canonical_address(config, account);
    if (combined && owner == "all") || service::valid_account(config, &owner) {
        Ok(owner)
    } else {
        Err(Error::conflict(
            "Choose an explicit connected account (or demo).",
        ))
    }
}
fn payload(draft: &Value) -> Result<Value> {
    let mut value = content::content(draft, false)?;
    value["replyToId"] = draft.get("replyToId").cloned().unwrap_or(json!(""));
    if draft["deliveryStatus"] == "unconfirmed" && draft.get("footer").is_some() {
        value["footer"] = draft["footer"].clone();
    }
    Ok(value)
}
fn review_hash(config: &Value, owner: &str, id: &str, message: &Value) -> Result<String> {
    let connection = &service::connections(config)[owner];
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            owner,
            id,
            message,
            connection["connectionId"],
            connection["provider"],
            config["preferences"]["displayName"]
        ]))?)
    ))
}
// Called inside send's DB transactions, including after token refresh. Replay is handled first.
pub(crate) fn guard_review(db: &Store, owner: &str, input: &Value) -> Result<()> {
    let Some(hash) = input.get("cliReviewHash") else {
        return Ok(());
    };
    let config = db.settings()?;
    let id = string(input, "draftId");
    let draft = service::get_message(db, owner, id)?;
    let expected = payload(&draft)?;
    let mut supplied = content::content(input, false)?;
    supplied["replyToId"] = input.get("replyToId").cloned().unwrap_or(json!(""));
    if draft["deliveryStatus"] == "unconfirmed" && input["footer"] == draft["footer"] {
        supplied["footer"] = draft["footer"].clone();
    }
    if draft["folder"] != "drafts"
        || expected != supplied
        || input["cliReviewFromName"] != string(&config["preferences"], "displayName")
        || hash.as_str() != Some(&review_hash(&config, owner, id, &expected)?)
    {
        return Err(Error::conflict(
            "Draft, sender or connection changed. Create and inspect a new review before sending.",
        ));
    }
    Ok(())
}
async fn route(
    app: &App,
    owner: String,
    method: Method,
    path: Vec<String>,
    body: Value,
) -> Result<Value> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-genmail-account",
        owner
            .parse()
            .map_err(|_| Error::invalid("Invalid account."))?,
    );
    let response = service::dispatch(
        app,
        Context {
            method,
            path,
            body,
            query: json!({}),
            headers,
            owner,
            paged: true,
        },
    )
    .await?;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), OUTPUT_LIMIT)
        .await
        .map_err(|_| Error::new(413, "Result exceeds 16 MiB."))?;
    let value = serde_json::from_slice(&bytes)?;
    if status >= 400 {
        let mut error = Error::new(status, "Command failed.");
        error.body = value;
        Err(error)
    } else {
        Ok(value)
    }
}
pub async fn execute(app: &App, command: Command) -> Result<Value> {
    match command {
        Command::Accounts {} => {
            app.db(|db| {
                let config = db.settings()?;
                let mut accounts = vec![json!({"id":"demo","simulated":true})];
                for (id, mail) in service::connections(&config).as_object().unwrap() {
                    accounts.push(
                        json!({"id":id,"email":id,"provider":mail["provider"],"simulated":false}),
                    );
                }
                Ok(json!({"accounts":accounts}))
            })
            .await
        }
        Command::List {
            account,
            folder,
            sort,
            page,
            limit,
        } => {
            if !(1..=2000).contains(&page) || !(1..=100).contains(&limit) {
                return Err(Error::invalid("Use page 1–2000 and limit 1–100."));
            }
            let secret = app.0.page_secret;
            app.db(move |db| {
                let config = db.settings()?;
                let owner = owner(&config, &account, true)?;
                let accounts = if owner == "all" {
                    service::connections(&config)
                        .as_object()
                        .unwrap()
                        .keys()
                        .cloned()
                        .collect()
                } else {
                    vec![owner]
                };
                let mut result = pages::page_at(
                    db,
                    &accounts,
                    &json!({"folder":folder,"sort":sort,"pageSize":limit}),
                    &secret,
                    (page as usize - 1) * limit,
                )?;
                result["nextPage"] = if string(&result, "nextCursor").is_empty() {
                    Value::Null
                } else {
                    json!(page + 1)
                };
                result.as_object_mut().unwrap().remove("nextCursor");
                result["page"] = page.into();
                Ok(result)
            })
            .await
        }
        Command::Read { account, id } => {
            validation::text(&json!(id), "Message ID", 8192, false)?;
            let owner = owner(&app.settings().await?, &account, false)?;
            route(
                app,
                owner,
                Method::GET,
                vec!["messages".into(), id],
                json!({}),
            )
            .await
        }
        Command::Search {
            account,
            query,
            page,
        } => {
            if !(1..=2000).contains(&page) {
                return Err(Error::invalid("Use page 1–2000."));
            }
            let owner = owner(&app.settings().await?, &account, true)?;
            let mut result = route(
                app,
                owner,
                Method::POST,
                vec!["search".into()],
                json!({"query":query,"scope":"account","page":page-1,"smart":false}),
            )
            .await?;
            result.as_object_mut().unwrap().remove("nextCursor");
            result["nextPage"] = if u64::from(page) * 30 < result["total"].as_u64().unwrap_or(0) {
                json!(page + 1)
            } else {
                Value::Null
            };
            result["page"] = page.into();
            Ok(result)
        }
        Command::Draft {
            account,
            mut message,
        } => {
            let fields = message
                .as_object()
                .ok_or_else(|| Error::invalid("Draft must be an object."))?;
            if fields.keys().any(|k| {
                ![
                    "id",
                    "to",
                    "cc",
                    "bcc",
                    "subject",
                    "body",
                    "replyToId",
                    "footer",
                ]
                .contains(&k.as_str())
            }) {
                return Err(Error::invalid("Unknown draft field."));
            }
            let config = app.settings().await?;
            let owner = owner(&config, &account, false)?;
            if message.get("footer").is_none() {
                let id = string(&message, "id").to_owned();
                let account = owner.clone();
                let saved = if id.is_empty() {
                    None
                } else {
                    app.db(move |db| db.get(&account, &id)).await?
                };
                message["footer"] = saved
                    .and_then(|m| m.get("footer").cloned())
                    .unwrap_or(content::preferences_footer(&config["preferences"])?);
            }
            route(app, owner, Method::POST, vec!["drafts".into()], message).await
        }
        Command::Review { account, id } => {
            validation::text(&json!(id), "Draft ID", 8192, false)?;
            let account = owner(&app.settings().await?, &account, false)?;
            crate::mail::ensure_draft_idle(app, &account, &id)?;
            app.db(move |db| {
                let config = db.settings()?;
                let account = owner(&config, &account, false)?;
                let draft = service::get_message(db, &account, &id)?;
                if draft["folder"] != "drafts" {
                    return Err(Error::invalid("Only saved drafts can be reviewed."));
                }
                let message = payload(&draft)?;
                let unconfirmed = draft["deliveryStatus"] == "unconfirmed";
                let review = Review {
                    review_hash: review_hash(&config, &account, &id, &message)?,
                    simulated: account == "demo",
                    account,
                    draft_id: id,
                    request_id: if unconfirmed {
                        string(&draft, "deliveryRequestId").into()
                    } else {
                        uuid::Uuid::new_v4().to_string()
                    },
                    message,
                    from_name: string(&config["preferences"], "displayName").into(),
                    unconfirmed,
                };
                Ok(serde_json::to_value(review)?)
            })
            .await
        }
        Command::Send {
            review,
            confirm,
            retry_unconfirmed,
        } => {
            if !confirm {
                return Err(Error::invalid(
                    "Inspect the complete review, then pass --confirm to send.",
                ));
            }
            let account = owner(&app.settings().await?, &review.account, false)?;
            if review.simulated != (account == "demo") || review.review_hash.len() != 64 {
                return Err(Error::invalid("Invalid send review."));
            }
            let mut body = review.message;
            if !body.is_object() {
                return Err(Error::invalid("Invalid reviewed message."));
            }
            body["draftId"] = review.draft_id.into();
            body["requestId"] = review.request_id.into();
            body["cliReviewHash"] = review.review_hash.into();
            body["cliReviewFromName"] = review.from_name.into();
            body["retryUnconfirmed"] = retry_unconfirmed.into();
            route(app, account, Method::POST, vec!["send".into()], body).await
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    version: u8,
    port: u16,
    pid: u32,
    token: String,
    workspace: String,
}
pub(crate) fn workspace_id(directory: &Path) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(directory.canonicalize()?.as_os_str().as_encoded_bytes())
    ))
}
fn proof(token: &str, workspace: &str, pid: u32, nonce: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC key");
    mac.update(&serde_json::to_vec(&json!([
        "morrow-cli-health-v1",
        workspace,
        pid,
        nonce
    ]))?);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}
pub(crate) fn health(app: &App, nonce: &str) -> Result<Value> {
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::invalid("A fresh 32-byte CLI challenge is required."));
    }
    Ok(
        json!({"service":"morrow-cli","version":1,"pid":std::process::id(),
        "workspace":app.0.cli_workspace,"proof":proof(&app.0.cli_token,&app.0.cli_workspace,std::process::id(),nonce)?}),
    )
}
pub struct PublishedEndpoint(PathBuf);
impl Drop for PublishedEndpoint {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub fn publish(directory: &Path, app: &App) -> Result<PublishedEndpoint> {
    let path = directory.join(ENDPOINT);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    store::private_file(
        &path,
        &serde_json::to_vec(&Endpoint {
            version: 1,
            port: app.0.port,
            pid: std::process::id(),
            token: app.0.cli_token.clone(),
            workspace: app.0.cli_workspace.clone(),
        })?,
    )?;
    store::private(&path, false)?;
    Ok(PublishedEndpoint(path))
}
fn read_endpoint(directory: &Path) -> Result<Option<Endpoint>> {
    let path = directory.join(ENDPOINT);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err(Error::invalid("Invalid private CLI endpoint."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(Error::invalid(
                "CLI endpoint must be owned by you with mode 0600.",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(Error::invalid("CLI endpoint cannot be a reparse point."));
        }
    }
    let endpoint: Endpoint =
        serde_json::from_slice(&read_limited(std::fs::File::open(path)?, 4096)?)?;
    if endpoint.version != 1
        || endpoint.port == 0
        || endpoint.pid == 0
        || endpoint.token.len() != 64
        || !endpoint.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(Error::invalid("Invalid private CLI endpoint."));
    }
    if endpoint.workspace != workspace_id(directory)? {
        // A copied workspace must never attach to the source workspace's service.
        return Ok(None);
    }
    Ok(Some(endpoint))
}
/// Confirm that the newly launched service owns this workspace and answers a fresh challenge.
pub async fn healthy(directory: &Path) -> Result<bool> {
    // The service can be writing cli.json while the installer polls readiness.
    let Some(endpoint) = read_endpoint(directory).ok().flatten() else {
        return Ok(false);
    };
    if !crate::updater::process_alive(endpoint.pid) {
        return Ok(false);
    }
    let nonce = service::hex_token()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| Error::new(500, "Could not check updated service readiness."))?;
    let response = match client
        .get(format!(
            "http://127.0.0.1:{}/api/cli/health?nonce={nonce}",
            endpoint.port
        ))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(false),
    };
    let health = match response_json(response).await {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let expected = proof(&endpoint.token, &endpoint.workspace, endpoint.pid, &nonce)?;
    Ok(health["service"] == "morrow-cli"
        && health["version"] == 1
        && health["pid"] == endpoint.pid
        && health["workspace"] == endpoint.workspace
        && validation::same_secret(string(&health, "proof"), &expected))
}
fn read_limited(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(Error::new(413, "Input exceeds its size limit."));
    }
    Ok(bytes)
}
async fn response_json(mut response: reqwest::Response) -> Result<Value> {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::new(502, "CLI response interrupted. Do not retry a send automatically; inspect its saved draft or Sent record."))? {
        if bytes.len() + chunk.len() > OUTPUT_LIMIT { return Err(Error::new(413,"Result exceeds 16 MiB.")); } bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes)?;
    if status >= 400 {
        let mut error = Error::new(status, "Command failed.");
        error.body = value;
        Err(error)
    } else {
        Ok(value)
    }
}
async fn run(directory: PathBuf, command: Command) -> Result<Value> {
    if !directory.is_absolute()
        || !directory.join("genmail.sqlite").is_file()
        || !directory.join("encryption.key").is_file()
    {
        return Err(Error::invalid(
            "Choose an existing absolute Morrow workspace with its database and encryption key.",
        ));
    }
    if let Some(endpoint) = read_endpoint(&directory)? {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(150))
            .build()
            .map_err(|_| Error::new(500, "Could not initialize CLI networking."))?;
        let url = format!("http://127.0.0.1:{}/api/cli", endpoint.port);
        let nonce = service::hex_token()?;
        match client
            .get(format!("{url}/health?nonce={nonce}"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(response) => {
                let health = response_json(response).await?;
                let expected = proof(&endpoint.token, &endpoint.workspace, endpoint.pid, &nonce)?;
                if health["service"] != "morrow-cli"
                    || health["version"] != 1
                    || health["pid"] != endpoint.pid
                    || health["workspace"] != endpoint.workspace
                    || !validation::same_secret(string(&health, "proof"), &expected)
                {
                    return Err(Error::conflict(
                        "CLI service identity changed. No command was sent. Reopen Morrow Mail.",
                    ));
                }
                let response = client.post(url).bearer_auth(endpoint.token).json(&command).send().await.map_err(|_| Error::new(502,"CLI request interrupted. Do not retry a send automatically; inspect its saved draft or Sent record."))?;
                return response_json(response).await;
            }
            Err(error) if error.is_connect() => {} // Stale endpoint: the Store lock still decides ownership.
            Err(_) => {
                return Err(Error::new(
                    503,
                    "The running app is not responding. No command was sent.",
                ));
            }
        }
    }
    let app = tokio::task::spawn_blocking(move || {
        App::open(
            &directory,
            0,
            uuid::Uuid::new_v4().to_string(),
            String::new(),
        )
    })
    .await
    .map_err(|_| Error::new(500, "Could not open workspace."))??;
    let result = execute(&app, command).await;
    app.db(|_| Ok(())).await?;
    result
}
const HELP: &str = "Morrow Mail agent CLI\n\nUsage: morrow-service cli <command> [--workspace ABSOLUTE_PATH] [options]\n\n  accounts\n  list   --account ID [--folder inbox] [--sort newest] [--page 1] [--limit 50]\n  read   --account ID --id MESSAGE_ID\n  search --account ID --query QUERY [--page 1]\n  draft  --account ID --input FILE_OR_-\n  review --account ID --id DRAFT_ID\n  send   --input REVIEW_FILE_OR_- --confirm [--retry-unconfirmed]\n\nJSON stdout: {ok:true,data:...} or {ok:false,status:...,error:...}.\nAccount is explicit; all is read-only for list/search. Read never marks mail read.\nDraft JSON: to, cc, bcc, subject, body, optional id/replyToId/footer.\nReview before sending. Keep the review/request ID for replay; never auto-retry uncertain delivery.\nApp open: private local connection. App closed: exclusive workspace access, no background jobs.\nDefaults: MORROW_DATA_DIR, otherwise the desktop workspace on macOS/Windows.\nExit: 0 success, 2 invalid input, 3 conflict, 1 other failure.\n";
fn parse(args: Vec<String>) -> Result<(PathBuf, Command)> {
    let name = args
        .first()
        .ok_or_else(|| Error::invalid("Use cli --help."))?;
    let mut flags = HashMap::new();
    let mut it = args.iter().skip(1);
    while let Some(key) = it.next() {
        if !key.starts_with("--") || flags.contains_key(key) {
            return Err(Error::invalid(
                "Invalid or repeated option. Use cli --help.",
            ));
        }
        let value = if ["--confirm", "--retry-unconfirmed"].contains(&key.as_str()) {
            "true".into()
        } else {
            it.next()
                .filter(|s| !s.starts_with("--"))
                .ok_or_else(|| Error::invalid("Missing option value."))?
                .clone()
        };
        flags.insert(key.clone(), value);
    }
    let directory = flags
        .remove("--workspace")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MORROW_DATA_DIR").map(PathBuf::from))
        .or_else(default_directory)
        .ok_or_else(|| Error::invalid("Provide --workspace with an absolute path."))?;
    let required = |flags: &mut HashMap<String, String>, key: &str| {
        flags
            .remove(key)
            .ok_or_else(|| Error::invalid(&format!("Missing {key}.")))
    };
    let input = |flags: &mut HashMap<String, String>| -> Result<Value> {
        let file = required(flags, "--input")?;
        let bytes = if file == "-" {
            read_limited(std::io::stdin().lock(), INPUT_LIMIT)?
        } else {
            read_limited(std::fs::File::open(file)?, INPUT_LIMIT)?
        };
        Ok(serde_json::from_slice(&bytes)?)
    };
    let number = |flags: &mut HashMap<String, String>, key: &str, default: u32| -> Result<u32> {
        flags.remove(key).map_or(Ok(default), |v| {
            v.parse()
                .map_err(|_| Error::invalid("Invalid numeric option."))
        })
    };
    let command = match name.as_str() {
        "accounts" => Command::Accounts {},
        "list" => Command::List {
            account: required(&mut flags, "--account")?,
            folder: flags.remove("--folder").unwrap_or("inbox".into()),
            sort: flags.remove("--sort").unwrap_or("newest".into()),
            page: number(&mut flags, "--page", 1)?,
            limit: number(&mut flags, "--limit", 50)? as usize,
        },
        "read" => Command::Read {
            account: required(&mut flags, "--account")?,
            id: required(&mut flags, "--id")?,
        },
        "search" => Command::Search {
            account: required(&mut flags, "--account")?,
            query: required(&mut flags, "--query")?,
            page: number(&mut flags, "--page", 1)?,
        },
        "draft" => Command::Draft {
            account: required(&mut flags, "--account")?,
            message: input(&mut flags)?,
        },
        "review" => Command::Review {
            account: required(&mut flags, "--account")?,
            id: required(&mut flags, "--id")?,
        },
        "send" => {
            let mut review = input(&mut flags)?;
            if review["ok"] == true {
                review = review["data"].take();
            }
            Command::Send {
                review: serde_json::from_value(review)
                    .map_err(|_| Error::invalid("Use a complete review JSON result."))?,
                confirm: flags.remove("--confirm").is_some(),
                retry_unconfirmed: flags.remove("--retry-unconfirmed").is_some(),
            }
        }
        _ => return Err(Error::invalid("Unknown command. Use cli --help.")),
    };
    if !flags.is_empty() {
        return Err(Error::invalid(
            "Unknown option for this command. Use cli --help.",
        ));
    }
    Ok((directory, command))
}
fn default_directory() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support/Morrow Mail"))
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|home| PathBuf::from(home).join("Morrow Mail"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}
pub async fn main(args: Vec<String>) -> i32 {
    if args.is_empty() || args == ["--help"] {
        println!("{HELP}");
        return 0;
    }
    let result = match parse(args) {
        Ok((directory, command)) => run(directory, command).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(data) => {
            println!("{}", json!({"ok":true,"data":data}));
            0
        }
        Err(error) => {
            println!(
                "{}",
                json!({"ok":false,"status":error.status,"error":error.body})
            );
            match error.status {
                400 | 413 => 2,
                409 => 3,
                _ => 1,
            }
        }
    }
}
