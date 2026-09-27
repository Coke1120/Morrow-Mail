use crate::{
    error::{Error, Result},
    store::Store,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use icu_collator::{
    Collator,
    options::{CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
};
use rusqlite::{functions::FunctionFlags, params_from_iter, types::Value as Sql};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const FIELDS: &[(&str, usize)] = &[
    ("id", 0),
    ("fromName", 254),
    ("fromEmail", 254),
    ("to", 4096),
    ("subject", 1000),
    ("preview", 240),
    ("date", 40),
    ("folder", 20),
    ("category", 40),
    ("remoteId", 0),
    ("deliveryStatus", 40),
];
const FOLDERS: &[&str] = &[
    "inbox", "starred", "pending", "sent", "drafts", "archive", "spam", "trash",
];
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Options {
    pub folder: String,
    pub category: String,
    pub unread_only: bool,
    pub sort: String,
    pub cursor: String,
    pub page_size: usize,
    pub locale: String,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            folder: String::new(),
            category: "all".into(),
            unread_only: false,
            sort: "newest".into(),
            cursor: String::new(),
            page_size: 50,
            locale: "en".into(),
        }
    }
}
pub fn summary(message: &Value) -> Value {
    let mut result = json!({});
    for &(key, max) in FIELDS {
        if let Some(value) = message.get(key) {
            result[key] = if max == 0 {
                value.clone()
            } else {
                Value::String(value.as_str().unwrap_or("").chars().take(max).collect())
            };
        }
    }
    result["read"] = json!(message["read"] == true || message["read"] == 1);
    result["starred"] = json!(message["starred"] == true || message["starred"] == 1);
    result["pending"] = json!(message["pending"] == true || message["pending"] == 1);
    if let Some(value) = message["scheduledSend"].as_object() {
        result["scheduledSend"] =
            json!({"id":value.get("id"),"sendAt":value.get("sendAt"),"status":value.get("status")});
    }
    result
}
pub fn owned(account: &str, mut message: Value) -> Value {
    message["accountId"] = account.into();
    message["viewId"] = serde_json::to_string(&json!([account, message["id"]]))
        .expect("message identity")
        .into();
    message
}
fn index_ready(store: &Store) -> Result<bool> {
    Ok(store.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM search_meta WHERE version=1)",
        [],
        |row| row.get(0),
    )?)
}
fn documents(store: &Store) -> Result<String> {
    let indexed = index_ready(store)?;
    // The metadata expression index stays complete even when derived FTS data is lost.
    Ok(if indexed {
        "SELECT * FROM search_documents".into()
    } else {
        "SELECT rowid,account,id,COALESCE(json_extract(data,'$.date'),'') AS date,COALESCE(json_extract(data,'$.folder'),'') AS folder,NOT COALESCE(json_extract(data,'$.read'),0) AS unread,COALESCE(json_extract(data,'$.starred'),0) AS starred,COALESCE(json_extract(data,'$.category'),'') AS category FROM messages INDEXED BY mail_metadata".into()
    })
}
pub fn stats(store: &Store, accounts: &[String]) -> Result<Value> {
    let mut result = json!({});
    for account in accounts {
        let mut counts = json!({});
        for folder in FOLDERS {
            counts[folder] = 0.into();
        }
        result[account] = json!({"unread":0,"total":0,"counts":counts});
    }
    let scope = placeholders(accounts.len());
    let sql = format!(
        "WITH d AS NOT MATERIALIZED ({}) SELECT account,folder,count(*),sum(unread),sum(starred) FROM d WHERE account IN ({scope}) GROUP BY account,folder",
        documents(store)?
    );
    let mut statement = store.conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(accounts))?;
    while let Some(row) = rows.next()? {
        let account: String = row.get(0)?;
        let folder: String = row.get(1)?;
        let count: i64 = row.get(2)?;
        let unread: i64 = row.get(3)?;
        let starred: i64 = row.get(4)?;
        let entry = &mut result[&account];
        entry["total"] = (entry["total"].as_i64().unwrap_or(0) + count).into();
        if FOLDERS.contains(&folder.as_str()) && folder != "starred" {
            entry["counts"][&folder] =
                (entry["counts"][&folder].as_i64().unwrap_or(0) + count).into();
        }
        if folder == "inbox" {
            entry["unread"] = (entry["unread"].as_i64().unwrap_or(0) + unread).into();
        }
        if !["trash", "spam"].contains(&folder.as_str()) {
            entry["counts"]["starred"] =
                (entry["counts"]["starred"].as_i64().unwrap_or(0) + starred).into();
        }
    }
    let mut pending = store.conn.prepare(&format!("SELECT account,count(*) FROM messages WHERE json_extract(data,'$.pending')=1 AND account IN ({scope}) AND COALESCE(json_extract(data,'$.folder'),'') NOT IN ('trash','spam') GROUP BY account"))?;
    let counts = pending.query_map(params_from_iter(accounts), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for count in counts {
        let (account, count) = count?;
        result[&account]["counts"]["pending"] = count.into();
    }
    Ok(result)
}
fn placeholders(length: usize) -> String {
    if length == 0 {
        "NULL".into()
    } else {
        vec!["?"; length].join(",")
    }
}
pub fn page(store: &Store, accounts: &[String], input: &Value, secret: &[u8; 32]) -> Result<Value> {
    let mut input = input.clone();
    let offset = match input.as_object_mut().and_then(|v| v.remove("offset")) {
        None => 0,
        Some(value) => value
            .as_u64()
            .filter(|v| *v <= 200_000)
            .ok_or_else(|| Error::invalid("Invalid mail page offset."))?
            as usize,
    };
    page_at(store, accounts, &input, secret, offset)
}
pub(crate) fn page_at(
    store: &Store,
    accounts: &[String],
    input: &Value,
    secret: &[u8; 32],
    offset: usize,
) -> Result<Value> {
    // ponytail: bounded numeric offsets for CLI and desktop page refresh; use cursor sessions beyond 200k rows.
    if offset > 200_000
        || offset > 0
            && input
                .get("cursor")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
    {
        return Err(Error::invalid("Invalid mail page offset."));
    }
    let options: Options =
        serde_json::from_value(input.clone()).map_err(|_| Error::invalid("Invalid mail page."))?;
    if (!options.folder.is_empty() && !FOLDERS.contains(&options.folder.as_str()))
        || !["all", "primary", "updates", "newsletters"].contains(&options.category.as_str())
        || !["newest", "oldest", "sender", "subject", "unread", "starred"]
            .contains(&options.sort.as_str())
        || !(1..=100).contains(&options.page_size)
        || options.cursor.len() > 8192
        || options.locale.len() > 100
        || accounts.len() > 100
    {
        return Err(Error::invalid("Invalid mail folder, sorting or page size."));
    }
    let revision = store.revision()?;
    let scope = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            accounts,
            options.folder,
            options.category,
            options.unread_only,
            options.sort,
            options.page_size,
            options.locale,
            revision
        ]))?)
    );
    let mut conditions = vec![format!("d.account IN ({})", placeholders(accounts.len()))];
    let mut params: Vec<Sql> = accounts.iter().cloned().map(Sql::Text).collect();
    if options.folder == "starred" {
        conditions.push("d.starred=1 AND d.folder NOT IN ('trash','spam')".into());
    } else if options.folder == "pending" {
        conditions.push("d.rowid IN (SELECT rowid FROM messages WHERE json_extract(data,'$.pending')=1) AND d.folder NOT IN ('trash','spam')".into());
    } else if !options.folder.is_empty() {
        conditions.push("d.folder=?".into());
        params.push(options.folder.clone().into());
    }
    if options.category != "all" {
        conditions.push("d.category=?".into());
        params.push(options.category.clone().into());
    }
    if options.unread_only {
        conditions.push("d.unread=1".into());
    }
    let locale: icu_locale::Locale = options
        .locale
        .parse()
        .map_err(|_| Error::invalid("Invalid sorting locale."))?;
    let text_sort = ["sender", "subject"].contains(&options.sort.as_str());
    let mut order = Vec::new();
    if text_sort {
        let mut preferences: icu_collator::CollatorPreferences = locale.into();
        preferences.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut settings = CollatorOptions::default();
        settings.strength = Some(Strength::Primary);
        let collator = Collator::try_new(preferences, settings)
            .map_err(|_| Error::invalid("Unsupported sorting locale."))?;
        store.conn.create_scalar_function(
            "mail_order",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |ctx| {
                let text = ctx.get::<Option<String>>(0)?.unwrap_or_default();
                let mut key = Vec::new();
                let Ok(()) = collator.write_sort_key_to(&text, &mut key);
                Ok(key.iter().map(|b| format!("{b:02x}")).collect::<String>())
            },
        )?;
        order.push((
            if options.sort == "sender" {
                "mail_order(json_extract(m.data,'$.fromName'))"
            } else {
                "mail_order(json_extract(m.data,'$.subject'))"
            },
            "ASC",
        ));
    }
    if options.sort == "unread" {
        order.push(("d.unread", "DESC"));
    }
    if options.sort == "starred" {
        order.push(("d.starred", "DESC"));
    }
    order.extend([
        (
            "d.date",
            if options.sort == "oldest" {
                "ASC"
            } else {
                "DESC"
            },
        ),
        ("d.account", "ASC"),
        ("d.id", "ASC"),
    ]);
    let docs = documents(store)?;
    let total: i64 = store.conn.query_row(
        &format!(
            "WITH d AS NOT MATERIALIZED ({docs}) SELECT count(*) FROM d WHERE {}",
            conditions.join(" AND ")
        ),
        params_from_iter(&params),
        |row| row.get(0),
    )?;
    if !options.cursor.is_empty() {
        let invalid = || Error::conflict("Mail changed or the cursor expired. Refresh the list.");
        let (payload, signature) = options.cursor.split_once('.').ok_or_else(invalid)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
        mac.update(payload.as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        let previous: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if previous["scope"] != scope {
            return Err(invalid());
        }
        let rowid = previous["rowid"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(invalid)?;
        // Resolve ordering keys from the signed identity: long provider subjects never inflate cursors.
        let key_sql = format!(
            "WITH d AS NOT MATERIALIZED ({docs}) SELECT {} FROM d JOIN messages m ON m.account=d.account AND m.id=d.id WHERE d.rowid=?",
            order
                .iter()
                .map(|(column, _)| *column)
                .collect::<Vec<_>>()
                .join(",")
        );
        let keys = store
            .conn
            .query_row(&key_sql, [rowid], |row| {
                (0..order.len())
                    .map(|i| row.get::<_, Sql>(i))
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .map_err(|_| invalid())?;
        let mut branches = Vec::new();
        for (i, (column, direction)) in order.iter().enumerate() {
            let mut branch = Vec::new();
            for (j, (column, _)) in order.iter().take(i).enumerate() {
                branch.push(format!("{column}=?"));
                params.push(keys[j].clone());
            }
            branch.push(format!(
                "{column}{}?",
                if *direction == "ASC" { ">" } else { "<" }
            ));
            params.push(keys[i].clone());
            branches.push(format!("({})", branch.join(" AND ")));
        }
        conditions.push(format!("({})", branches.join(" OR ")));
    }
    let projection = FIELDS
        .iter()
        .map(|(field, max)| {
            let value = format!("json_extract(m.data,'$.{field}')");
            format!(
                "'{field}',{}",
                if *max == 0 {
                    value
                } else {
                    format!("substr({value},1,{max})")
                }
            )
        })
        .chain([
            "'read',json_extract(m.data,'$.read')".into(),
            "'starred',json_extract(m.data,'$.starred')".into(),
            "'pending',json_extract(m.data,'$.pending')".into(),
            "'scheduledSend',json_extract(m.data,'$.scheduledSend')".into(),
        ])
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH d AS NOT MATERIALIZED ({docs}), page AS MATERIALIZED (SELECT d.rowid,d.account AS owner,d.id AS id,{} FROM d {} WHERE {} ORDER BY {} LIMIT ? OFFSET ?) SELECT json_object({projection}),p.owner,p.rowid FROM page p JOIN messages m ON m.account=p.owner AND m.id=p.id ORDER BY {}",
        order
            .iter()
            .enumerate()
            .map(|(i, (column, _))| format!("{column} AS k{i}"))
            .collect::<Vec<_>>()
            .join(","),
        if text_sort {
            "JOIN messages m ON m.account=d.account AND m.id=d.id"
        } else {
            ""
        },
        conditions.join(" AND "),
        order
            .iter()
            .map(|(column, direction)| format!("{column} {direction}"))
            .collect::<Vec<_>>()
            .join(","),
        order
            .iter()
            .enumerate()
            .map(|(i, (_, direction))| format!("p.k{i} {direction}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    params.push(Sql::Integer((options.page_size + 1) as i64));
    params.push(Sql::Integer(offset as i64));
    let mut statement = store.conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(&params))?;
    let mut messages = Vec::new();
    let mut last = 0_i64;
    let mut more = false;
    while let Some(row) = rows.next()? {
        if messages.len() == options.page_size {
            more = true;
            break;
        }
        let message: Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let account: String = row.get(1)?;
        let message = summary(&message);
        messages.push(owned(&account, message));
        last = row.get(2)?;
    }
    let cursor = if more {
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"scope":scope,"rowid":last}))?);
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
        mac.update(payload.as_bytes());
        format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    } else {
        String::new()
    };
    Ok(
        json!({"messages":messages,"total":total,"pageSize":options.page_size,"nextCursor":cursor,"revision":revision}),
    )
}
