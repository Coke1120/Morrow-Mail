//! Account-scoped downloaded conversations. No sender/subject heuristics or model calls.
use crate::{
    ai,
    error::Result,
    policy,
    store::{Store, string},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const INDEX_CAP: usize = 10_000;
const FIELDS: &[&str] = &[
    "threadId",
    "conversationId",
    "messageId",
    "inReplyTo",
    "references",
    "replyToId",
    "date",
    "folder",
    "fromEmail",
    "fromName",
    "to",
    "subject",
    "body",
    "providerDraft",
    "providerSent",
    "automated",
    "contentIncomplete",
    "bodyTruncated",
    "deliveryStatus",
    "deliveryResolution",
];

/// Pure SQLite triggers also work when an older app opens the workspace after rollback.
/// Body edits bump a version; read/star/pending changes do not. Metadata never contains bodies.
pub fn create_schema(conn: &rusqlite::Connection) -> Result<()> {
    let metadata = |row: &str| {
        let fields = FIELDS
            .iter()
            .filter(|field| **field != "body")
            .map(|field| format!("'{field}',json_extract({row}.data,'$.{field}')"))
            .collect::<Vec<_>>()
            .join(",");
        format!("json_object({fields})")
    };
    let changed = FIELDS
        .iter()
        .map(|field| {
            format!("json_extract(old.data,'$.{field}') IS NOT json_extract(new.data,'$.{field}')")
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    conn.execute_batch(&format!("CREATE TABLE IF NOT EXISTS mail_review_metadata(account TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(account,id));
        CREATE TABLE IF NOT EXISTS mail_review_deleted(account TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(account,id));
        CREATE INDEX IF NOT EXISTS mail_review_latest ON mail_review_metadata(account,julianday(json_extract(data,'$.date')) DESC,id);
        INSERT OR IGNORE INTO mail_review_metadata(account,id,data) SELECT m.account,m.id,{} FROM messages m WHERE NOT EXISTS(SELECT 1 FROM mail_review_metadata r WHERE r.account=m.account AND r.id=m.id);
        CREATE TRIGGER IF NOT EXISTS mail_review_insert AFTER INSERT ON messages BEGIN INSERT INTO mail_review_metadata(account,id,data,version) VALUES(new.account,new.id,{},COALESCE((SELECT version+1 FROM mail_review_deleted WHERE account=new.account AND id=new.id),1)) ON CONFLICT(account,id) DO UPDATE SET data=excluded.data,version=version+1; DELETE FROM mail_review_deleted WHERE account=new.account AND id=new.id; END;
        CREATE TRIGGER IF NOT EXISTS mail_review_update AFTER UPDATE OF data ON messages WHEN {changed} BEGIN INSERT INTO mail_review_metadata(account,id,data) VALUES(new.account,new.id,{}) ON CONFLICT(account,id) DO UPDATE SET data=excluded.data,version=version+1; END;
        CREATE TRIGGER IF NOT EXISTS mail_review_delete AFTER DELETE ON messages BEGIN INSERT INTO mail_review_deleted(account,id,data,version) SELECT account,id,data,version+1 FROM mail_review_metadata WHERE account=old.account AND id=old.id ON CONFLICT(account,id) DO UPDATE SET data=excluded.data,version=excluded.version; DELETE FROM mail_review_metadata WHERE account=old.account AND id=old.id; END;",metadata("m"),metadata("new"),metadata("new")))?;
    Ok(())
}
pub fn instant(message: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(string(message, "date"))
        .ok()
        .map(|date| date.timestamp_millis())
}
pub fn content_hash(message: &Value) -> String {
    let mut value = message.clone();
    if let Some(fields) = value.as_object_mut() {
        fields.retain(|key, _| !matches!(key.as_str(), "read" | "starred" | "pending"));
    }
    ai::hash(&value)
}
fn token(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 1000 && !value.contains(['\r', '\n', '\0']))
        .then_some(value)
}
fn rfc(value: &str) -> Option<&str> {
    let value = token(value)?;
    let value = value
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(value);
    token(value).filter(|value| !value.contains(['<', '>', ' ']))
}
fn root(parent: &mut [usize], mut id: usize) -> usize {
    while parent[id] != id {
        parent[id] = parent[parent[id]];
        id = parent[id];
    }
    id
}
fn join(
    parent: &mut [usize],
    anchors: &mut [BTreeMap<String, String>],
    ambiguous: &mut [bool],
    a: usize,
    b: usize,
) {
    let a = root(parent, a);
    let b = root(parent, b);
    if a == b {
        return;
    }
    if anchors[a]
        .iter()
        .any(|(field, value)| anchors[b].get(field).is_some_and(|other| other != value))
    {
        ambiguous[a] = true;
        ambiguous[b] = true;
        return;
    }
    let extra = anchors[b].clone();
    anchors[a].extend(extra);
    ambiguous[a] |= ambiguous[b];
    parent[b] = a;
}
fn is_draft(message: &Value) -> bool {
    message["folder"] == "drafts"
        || message["providerDraft"] == true
        || message["providerDraft"] == 1
}
fn uncertain_delivery(message: &Value) -> bool {
    matches!(
        string(message, "deliveryStatus"),
        "uncertain" | "sending" | "unconfirmed"
    )
}

#[derive(Clone)]
pub struct Thread {
    pub key: String,
    pub ids: Vec<String>,
    pub latest: String,
    pub signature: String,
    pub partial: bool,
    pub reliable: bool,
    pub uncertain_delivery: bool,
}
pub struct Index {
    pub messages: BTreeMap<String, Value>,
    groups: BTreeMap<String, Thread>,
    by_id: BTreeMap<String, String>,
    pub limited: bool,
}
impl Index {
    pub fn load(db: &Store, owner: &str) -> Result<Self> {
        let mut query=db.conn.prepare("SELECT id,data,version,deleted FROM (SELECT id,data,version,0 deleted FROM mail_review_metadata WHERE account=? UNION ALL SELECT id,data,version,1 deleted FROM mail_review_deleted WHERE account=?) WHERE ((COALESCE(json_extract(data,'$.folder'),'')!='drafts' AND NOT COALESCE(json_extract(data,'$.providerDraft'),0)) OR json_extract(data,'$.deliveryStatus') IN ('uncertain','sending','unconfirmed')) ORDER BY julianday(json_extract(data,'$.date')) DESC,id LIMIT ?")?;
        let raw = query
            .query_map(
                rusqlite::params![owner, owner, (INDEX_CAP + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let limited = raw.len() > INDEX_CAP;
        let mut nodes = Vec::new();
        for (id, data, version, deleted) in raw.into_iter().take(INDEX_CAP) {
            let mut m: Value = serde_json::from_str(&data)?;
            m["id"] = id.into();
            m["version"] = version.into();
            m["deleted"] = deleted.into();
            if !is_draft(&m) || uncertain_delivery(&m) {
                nodes.push(m);
            }
        }
        let mut parent: Vec<_> = (0..nodes.len()).collect();
        let mut anchors = vec![BTreeMap::new(); nodes.len()];
        let mut ambiguous = vec![false; nodes.len()];
        let mut providers = BTreeMap::<(String, String), usize>::new();
        let mut rfcs = BTreeMap::<String, Vec<usize>>::new();
        let mut local = BTreeMap::new();
        for (i, m) in nodes.iter().enumerate() {
            local.insert(string(m, "id").to_owned(), i);
            for field in ["threadId", "conversationId"] {
                if let Some(value) = token(string(m, field)) {
                    anchors[i].insert(field.into(), value.into());
                }
            }
        }
        for (i, m) in nodes.iter().enumerate() {
            for field in ["threadId", "conversationId"] {
                if let Some(value) = token(string(m, field))
                    && let Some(other) = providers.insert((field.into(), value.into()), i)
                {
                    join(&mut parent, &mut anchors, &mut ambiguous, other, i);
                }
            }
            if let Some(value) = rfc(string(m, "messageId")) {
                rfcs.entry(value.into()).or_default().push(i);
            }
        }
        for matches in rfcs.values() {
            for &other in matches.iter().skip(1) {
                join(&mut parent, &mut anchors, &mut ambiguous, matches[0], other);
            }
        }
        let mut missing = vec![false; nodes.len()];
        let mut linked = vec![false; nodes.len()];
        let mut reference_anchors = BTreeMap::new();
        for (i, m) in nodes.iter().enumerate() {
            if let Some(id) = token(string(m, "replyToId")) {
                if let Some(&other) = local.get(id) {
                    linked[i] = true;
                    join(&mut parent, &mut anchors, &mut ambiguous, i, other);
                } else {
                    missing[i] = true;
                }
            }
            let mut references = m["references"].as_array().cloned().unwrap_or_default();
            if !string(m, "inReplyTo").is_empty() {
                references.push(m["inReplyTo"].clone());
            }
            if references.len() > 64 {
                missing[i] = true;
            }
            for reference in references.iter().take(64) {
                if let Some(id) = reference.as_str().and_then(rfc) {
                    linked[i] = true;
                    if let Some(other) = reference_anchors.insert(id.to_owned(), i) {
                        join(&mut parent, &mut anchors, &mut ambiguous, i, other);
                    }
                    if let Some(matches) = rfcs.get(id) {
                        for &other in matches {
                            join(&mut parent, &mut anchors, &mut ambiguous, i, other);
                        }
                    } else {
                        missing[i] = true;
                    }
                } else {
                    missing[i] = true;
                }
            }
        }
        let mut components = BTreeMap::<usize, Vec<usize>>::new();
        for i in 0..nodes.len() {
            components.entry(root(&mut parent, i)).or_default().push(i);
        }
        let mut groups = BTreeMap::new();
        let mut by_id = BTreeMap::new();
        let mut messages = BTreeMap::new();
        for (r, mut ids) in components {
            ids.sort_by(|&a, &b| {
                instant(&nodes[b])
                    .cmp(&instant(&nodes[a]))
                    .then_with(|| string(&nodes[a], "id").cmp(string(&nodes[b], "id")))
            });
            let latest = string(&nodes[ids[0]], "id").to_owned();
            let key = if !anchors[r].is_empty() {
                format!("providers:{}", ai::hash(&json!(anchors[r])))
            } else {
                format!("message:{}", string(&nodes[*ids.last().unwrap()], "id"))
            };
            let reliable = !anchors[r].is_empty()
                || ids.iter().any(|&i| linked[i])
                || ids
                    .iter()
                    .any(|&i| token(string(&nodes[i], "messageId")).is_some());
            let partial = limited
                || ambiguous[r]
                || ids.iter().any(|&i| {
                    missing[i]
                        || nodes[i]["deleted"] == true
                        || nodes[i]["contentIncomplete"] == true
                        || nodes[i]["contentIncomplete"] == 1
                        || nodes[i]["bodyTruncated"] == true
                        || nodes[i]["bodyTruncated"] == 1
                        || instant(&nodes[i]).is_none()
                });
            let signature = ai::hash(&json!([
                owner,
                key,
                partial,
                ids.iter().map(|&i| &nodes[i]).collect::<Vec<_>>()
            ]));
            let uncertain_delivery = ids.iter().any(|&i| uncertain_delivery(&nodes[i]));
            let members = ids
                .iter()
                .map(|&i| string(&nodes[i], "id").to_owned())
                .collect::<Vec<_>>();
            for &i in &ids {
                let id = string(&nodes[i], "id").to_owned();
                by_id.insert(id.clone(), key.clone());
                messages.insert(id, nodes[i].clone());
            }
            groups.insert(
                key.clone(),
                Thread {
                    key,
                    ids: members,
                    latest,
                    signature,
                    partial,
                    reliable,
                    uncertain_delivery,
                },
            );
        }
        Ok(Self {
            messages,
            groups,
            by_id,
            limited,
        })
    }
    pub fn thread(&self, id: &str) -> Option<&Thread> {
        self.by_id.get(id).and_then(|key| self.groups.get(key))
    }
    pub fn candidates(&self) -> Vec<&Value> {
        let mut result = self
            .groups
            .values()
            .filter_map(|thread| {
                self.messages.get(&thread.latest).filter(|m| {
                    m["folder"] == "inbox" && m["deleted"] != true && !thread.uncertain_delivery
                })
            })
            .collect::<Vec<_>>();
        result.sort_by(|a, b| {
            instant(b)
                .cmp(&instant(a))
                .then_with(|| string(a, "id").cmp(string(b, "id")))
        });
        result.truncate(200);
        result
    }
    pub fn context(
        &self,
        db: &Store,
        owner: &str,
        id: &str,
        p: &Value,
        cap: usize,
    ) -> Result<(Vec<Value>, Value)> {
        let Some(thread) = self.thread(id) else {
            return Ok((vec![], json!({"partial":true,"scope":"unavailable"})));
        };
        let mut messages = Vec::new();
        let mut partial = thread.partial;
        let mut seen = BTreeSet::new();
        let mut aliases = BTreeMap::<String, String>::new();
        let mut ids = vec![id.to_owned()];
        ids.extend(thread.ids.iter().filter(|other| *other != id).cloned());
        for target in ids {
            let meta = &self.messages[&target];
            if p["folders"][string(meta, "folder")] != true
                || ["drafts", "trash", "spam"].contains(&string(meta, "folder"))
            {
                partial = true;
                continue;
            }
            if messages.len() >= cap {
                partial = true;
                continue;
            }
            let Some(raw) = db.get(owner, &target)? else {
                partial = true;
                continue;
            };
            let rfc = rfc(string(&raw, "messageId")).unwrap_or("");
            let identical = ai::hash(&json!([
                raw["body"],
                raw["subject"],
                raw["fromEmail"],
                raw["to"]
            ]));
            if !rfc.is_empty()
                && let Some(previous) = aliases.insert(rfc.into(), identical.clone())
            {
                if previous != identical {
                    partial = true;
                } else {
                    continue;
                }
            }
            if seen.insert(target) {
                messages.push(policy::redact(&raw, p));
            }
        }
        let history = json!({"scope":if thread.reliable{"downloaded_conversation"}else{"unlinked_message"},"partial":partial,"matchedMessages":thread.ids.len(),"usedMessages":messages.len(),"maxMessages":cap,"conversationKey":ai::hash(&json!([owner,thread.key])),"coverage":"downloaded_only"});
        Ok((messages, history))
    }
}
