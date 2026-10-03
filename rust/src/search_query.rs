//! The public search grammar and shared, parameterized mailbox scope.
use crate::{
    error::{Error, Result},
    normalize,
    search::{self, Condition, Operation},
    store::{Store, string},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use regex::Regex;
use rusqlite::{params_from_iter, types::Value as Sql};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::LazyLock};

pub const FOLDERS: &[&str] = &[
    "inbox", "sent", "drafts", "archive", "spam", "trash", "starred", "pending", "later",
];
const FIELDS: &[&str] = &[
    "from", "to", "subject", "after", "before", "is", "label", "in",
];
const SPACE: &str =
    r"\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{9}'..='\u{d}'|' '| '\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(whitespace)
}
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub struct Query {
    pub query: String,
    pub terms: Vec<String>,
    pub conditions: Vec<Condition>,
    pub chips: Vec<Value>,
    pub filters: Value,
    pub scope: String,
    pub folder: String,
    pub sort: String,
    pub page: u32,
    pub smart: bool,
    pub cached_only: bool,
    pub cursor: String,
}
impl Query {
    pub fn entry(&self) -> Value {
        json!({"query":self.query,"scope":self.scope,"filters":self.filters,"folder":self.folder,"sort":self.sort,"smart":self.smart})
    }
    pub fn operation(&self, accounts: &[String], candidates: bool) -> Operation {
        let mut seen = HashSet::new();
        let tokens = self
            .terms
            .iter()
            .flat_map(|term| {
                normalize::tokens(term)
                    .split(' ')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|token| seen.insert(token.clone()))
            .collect();
        Operation::Lexical {
            accounts: accounts.to_vec(),
            terms: self.terms.clone(),
            tokens,
            conditions: self
                .conditions
                .iter()
                .map(|c| Condition {
                    key: c.key.clone(),
                    value: c.value.clone(),
                })
                .collect(),
            folder: (self.scope == "folder").then(|| self.folder.clone()),
            sort: if candidates {
                "relevance".into()
            } else {
                self.sort.clone()
            },
            page: self.page,
            candidates,
        }
    }
}
pub fn parse(input: &Value) -> Result<Query> {
    if !input.is_object() {
        return Err(Error::invalid("Enter valid search options."));
    }
    let defaults = json!({"query":"","scope":"folder","folder":"inbox","sort":"relevance","page":0,"filters":{},"smart":false,"cachedOnly":false,"cursor":""});
    let get = |key: &str| input.get(key).unwrap_or(&defaults[key]);
    let invalid = || Error::invalid("Invalid search query, scope, sorting or page.");
    let query = get("query")
        .as_str()
        .filter(|s| length(s) <= 500)
        .ok_or_else(invalid)?;
    let scope = get("scope")
        .as_str()
        .filter(|s| ["folder", "account", "all"].contains(s))
        .ok_or_else(invalid)?;
    let folder = get("folder")
        .as_str()
        .filter(|s| FOLDERS.contains(s) || crate::pages::provider_folder(s).is_some())
        .ok_or_else(invalid)?;
    let sort = get("sort")
        .as_str()
        .filter(|s| ["relevance", "newest", "oldest"].contains(s))
        .ok_or_else(invalid)?;
    let page = get("page")
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (0.0..=2000.0).contains(n))
        .ok_or_else(invalid)? as u32;
    let smart = get("smart").as_bool().ok_or_else(invalid)?;
    let cached_only = get("cachedOnly")
        .as_bool()
        .ok_or_else(|| Error::invalid("Invalid search cache option."))?;
    let cursor = get("cursor")
        .as_str()
        .filter(|s| s.len() <= 8192)
        .ok_or_else(|| Error::invalid("Invalid search cursor."))?;
    let filters = get("filters")
        .as_object()
        .filter(|v| v.keys().all(|k| FIELDS.contains(&k.as_str())))
        .ok_or_else(|| Error::invalid("Unknown search filter."))?;
    let mut options = Query {
        query: trim(query).into(),
        terms: vec![],
        conditions: vec![],
        chips: vec![],
        filters: json!(filters),
        scope: scope.into(),
        folder: folder.into(),
        sort: sort.into(),
        page,
        smart,
        cached_only,
        cursor: cursor.into(),
    };
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r#"(?:([a-zA-Z]+):)?("[^"]*"|[^{}"]+)"#, SPACE)).unwrap()
    });
    static EMPTY_OPERATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z]+:$").unwrap());
    let mut end = 0;
    for capture in PATTERN.captures_iter(query) {
        let matched = capture.get(0).unwrap();
        if !trim(&query[end..matched.start()]).is_empty() {
            return Err(Error::invalid("Close the quotation marks in your search."));
        }
        end = matched.end();
        let value = &capture[2];
        let value = if value.starts_with('"') {
            &value[1..value.len() - 1]
        } else {
            value
        };
        if let Some(key) = capture.get(1) {
            let key = key.as_str().to_ascii_lowercase();
            if !FIELDS.contains(&key.as_str()) {
                return Err(Error::invalid(&format!("Unknown search operator: {key}.")));
            }
            if trim(value).is_empty() {
                return Err(Error::invalid(&format!("Enter a value after {key}:")));
            }
            add(&mut options.conditions, &key, &json!(value))?;
            options.chips.push(json!({"label":matched.as_str(),"query":trim(&format!("{}{}",&query[..matched.start()],&query[end..]))}));
        } else if EMPTY_OPERATOR.is_match(value) {
            return Err(Error::invalid("Enter a value after the search operator."));
        } else if !trim(value).is_empty() {
            options.terms.push(normalize::normalize(value));
        }
    }
    if !trim(&query[end..]).is_empty() {
        return Err(Error::invalid("Close the quotation marks in your search."));
    }
    for (key, value) in filters {
        add(&mut options.conditions, key, value)?;
    }
    if options.terms.len() + options.conditions.len() > 24 {
        return Err(Error::invalid("Use at most 24 search terms and filters."));
    }
    Ok(options)
}
fn add(conditions: &mut Vec<Condition>, key: &str, value: &Value) -> Result<()> {
    let value = value.as_str().filter(|s| length(s) <= 254).ok_or_else(|| {
        Error::invalid("Search filter values must be text of at most 254 characters.")
    })?;
    if trim(value).is_empty() {
        return Ok(());
    }
    if ["after", "before"].contains(&key)
        && (value.len() != 10
            || !value.bytes().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            })
            || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
    {
        return Err(Error::invalid("Use a valid date: YYYY-MM-DD."));
    }
    if key == "is" && !["read", "unread", "starred", "pending"].contains(&value) {
        return Err(Error::invalid(
            "Use is:read, is:unread, is:starred or is:pending.",
        ));
    }
    if key == "in" && !FOLDERS.contains(&value) {
        return Err(Error::invalid("Choose a valid mailbox folder."));
    }
    conditions.push(Condition {
        key: key.into(),
        value: normalize::normalize(value),
    });
    Ok(())
}
pub fn placeholders(count: usize) -> String {
    if count == 0 {
        "NULL".into()
    } else {
        vec!["?"; count].join(",")
    }
}
pub fn where_clause(
    accounts: &[String],
    conditions: &[Condition],
    folder: Option<&str>,
) -> Result<(String, Vec<Sql>)> {
    let mut clauses = vec![format!("d.account IN ({})", placeholders(accounts.len()))];
    let mut params: Vec<Sql> = accounts.iter().cloned().map(Sql::Text).collect();
    fn folder_clause(value: &str, clauses: &mut Vec<String>, params: &mut Vec<Sql>) -> Result<()> {
        if let Some(id) = crate::pages::provider_folder(value) {
            clauses.push(format!(
                "m.rowid IN ({})",
                crate::pages::PROVIDER_FOLDER_ROWS
            ));
            params.extend([Sql::Text(id.into()), Sql::Text(id.into())]);
            return Ok(());
        }
        if !FOLDERS.contains(&value) {
            return Err(Error::invalid("Choose a valid mailbox folder."));
        }
        if value == "starred" {
            clauses.push("d.starred=1 AND d.folder NOT IN ('trash','spam')".into());
        } else if value == "later" {
            clauses.push(
                "json_extract(m.data,'$.lowPriority')=1 AND d.folder IN ('inbox','archive')".into(),
            );
        } else if value == "pending" {
            clauses.push(
                "json_extract(m.data,'$.pending')=1 AND d.folder NOT IN ('trash','spam')".into(),
            );
        } else {
            clauses.push("d.folder=?".into());
            params.push(value.to_owned().into());
        }
        Ok(())
    }
    if let Some(folder) = folder {
        if crate::pages::provider_folder(folder).is_some() && accounts.len() != 1 {
            return Err(Error::invalid(
                "Choose one mailbox for a server folder or label.",
            ));
        }
        folder_clause(folder, &mut clauses, &mut params)?;
    } else if !conditions
        .iter()
        .any(|c| c.key == "in" && ["trash", "spam"].contains(&c.value.as_str()))
    {
        clauses.push("d.folder NOT IN ('trash','spam')".into());
    }
    for c in conditions {
        match c.key.as_str() {
            "in" => folder_clause(&c.value, &mut clauses, &mut params)?,
            "is" => clauses.push(
                match c.value.as_str() {
                    "read" => "d.unread=0",
                    "unread" => "d.unread=1",
                    "starred" => "d.starred=1",
                    "pending" => "json_extract(m.data,'$.pending')=1",
                    _ => return Err(Error::invalid("Invalid search state.")),
                }
                .into(),
            ),
            "after" | "before" => {
                if c.value.len() != 10
                    || chrono::NaiveDate::parse_from_str(&c.value, "%Y-%m-%d").is_err()
                {
                    return Err(Error::invalid("Use a valid date: YYYY-MM-DD."));
                }
                clauses.push(format!(
                    "d.date{}?",
                    if c.key == "after" { ">=" } else { "<" }
                ));
                params.push(format!("{}T00:00:00.000Z", c.value).into());
            }
            "label" => {
                clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(m.data,'$.labels')) WHERE mail_normalize(value)=?)".into());
                params.push(c.value.clone().into());
            }
            "from" | "to" | "subject" => {
                let column = match c.key.as_str() {
                    "from" => "sender",
                    "to" => "recipients",
                    _ => "subject",
                };
                clauses.push(format!("instr(d.{column},?)>0"));
                params.push(c.value.clone().into());
            }
            _ => return Err(Error::invalid("Unknown search filter.")),
        }
    }
    Ok((clauses.join(" AND "), params))
}
pub fn lexical(db: &Store, query: &Query, accounts: &[String], candidates: bool) -> Result<Value> {
    let mut result =
        search::execute(&db.conn, query.operation(accounts, candidates)).map_err(|_| {
            Error::new(
                500,
                "Keyword search could not complete. Try again after indexing finishes.",
            )
        })?;
    let remaining = db.index_remaining()?;
    if remaining > 0 {
        result["warning"] = format!(
            "Keyword index is rebuilding; {remaining} downloaded messages are not searchable yet."
        )
        .into();
    }
    Ok(result)
}
pub fn coverage(db: &Store, accounts: &[String]) -> Result<Value> {
    let mut statement=db.conn.prepare(&format!("SELECT account,count(*),min(date),max(date) FROM search_documents WHERE account IN ({}) GROUP BY account",placeholders(accounts.len())))?;
    let rows=statement.query_map(params_from_iter(accounts),|row|Ok(json!({"account":row.get::<_,String>(0)?,"count":row.get::<_,i64>(1)?,"oldest":row.get::<_,Option<String>>(2)?,"newest":row.get::<_,Option<String>>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
pub fn cursor_scope(
    query: &Query,
    accounts: &[String],
    revision: &str,
    generation: &str,
) -> String {
    digest(&json!([query.entry(), accounts, revision, generation]))
}
pub fn cursor_page(cursor: &str, scope: &str, secret: &[u8; 32]) -> Result<u32> {
    let invalid = || Error::conflict("Search changed or the cursor expired. Search again.");
    let (payload, signature) = cursor.split_once('.').ok_or_else(invalid)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
    mac.update(payload.as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let value: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if value["scope"] != scope {
        return Err(invalid());
    }
    value["page"]
        .as_u64()
        .filter(|n| *n <= 2000)
        .map(|n| n as u32)
        .ok_or_else(invalid)
}
pub fn next_cursor(scope: &str, page: u32, total: u64, secret: &[u8; 32]) -> String {
    if page >= 2000 || u64::from(page + 1) * 30 >= total {
        return String::new();
    }
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&json!({"scope":scope,"page":page+1})).expect("cursor"));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
    mac.update(payload.as_bytes());
    format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}
/// Text segments only; provider HTML is never returned as markup.
pub fn segments(value: &str, terms: &[String], limit: usize) -> Value {
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{SPACE}]+")).unwrap());
    let text = SPACES.replace_all(value, " ");
    let chars: Vec<char> = text.chars().collect();
    let mut folded = String::new();
    let mut offsets = Vec::new();
    for (index, ch) in chars.iter().enumerate() {
        let part = if whitespace(*ch) {
            " ".into()
        } else {
            normalize::normalize(&ch.to_string())
        };
        offsets.extend(std::iter::repeat_n(index, part.len()));
        folded.push_str(&part);
    }
    let mut hits = HashSet::new();
    for term in terms.iter().filter(|s| !s.is_empty()) {
        for (at, _) in folded.match_indices(term) {
            hits.extend(offsets[at..at + term.len()].iter().copied());
        }
    }
    let start = hits.iter().min().copied().unwrap_or(0).saturating_sub(45);
    let end = chars.len().min(start + limit);
    let mut output: Vec<Value> = vec![];
    if start > 0 {
        output.push(json!({"text":"…","hit":false}));
    }
    for (index, ch) in chars.iter().enumerate().take(end).skip(start) {
        let hit = hits.contains(&index);
        if output.last().is_some_and(|last| last["hit"] == hit) {
            let last = output.last_mut().unwrap();
            let mut text = string(last, "text").to_owned();
            text.push(*ch);
            last["text"] = text.into();
        } else {
            output.push(json!({"text":ch.to_string(),"hit":hit}));
        }
    }
    if end < chars.len() {
        output.push(json!({"text":"…","hit":false}));
    }
    json!(output)
}
