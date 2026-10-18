use rusqlite::{Connection, params_from_iter, types::Value};
use serde::Deserialize;
use serde_json::json;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Lexical {
        accounts: Vec<String>,
        terms: Vec<String>,
        tokens: Vec<String>,
        conditions: Vec<Condition>,
        folder: Option<String>,
        sort: String,
        page: u32,
        candidates: bool,
    },
    Cosine {
        query: Vec<f64>,
        vectors: Vec<Vec<f64>>,
    },
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub key: String,
    pub value: String,
}

pub fn execute(db: &Connection, operation: Operation) -> Result<serde_json::Value> {
    match operation {
        Operation::Cosine { query, vectors } => {
            if query.is_empty()
                || query.len() > 4096
                || vectors.len() > 16
                || query.iter().any(|x| !x.is_finite())
                || vectors
                    .iter()
                    .any(|v| v.len() != query.len() || v.iter().any(|x| !x.is_finite()))
            {
                return Err("invalid vectors".into());
            }
            let scores: Vec<f64> = vectors
                .iter()
                .map(|v| v.iter().zip(&query).map(|(x, y)| x * y).sum())
                .collect();
            if scores.iter().any(|x| !x.is_finite()) {
                return Err("invalid score".into());
            }
            Ok(json!({ "scores": scores }))
        }
        Operation::Lexical {
            accounts,
            terms,
            tokens,
            conditions,
            folder,
            sort,
            page,
            candidates,
        } => {
            if accounts.len() > 100
                || accounts.iter().any(|s| s.is_empty() || s.len() > 1024)
                || terms.len() + conditions.len() > 24
                || terms.iter().any(|s| s.len() > 32768)
                || tokens.len() > 10000
                || tokens.iter().any(|s| s.is_empty() || s.len() > 32768)
                || conditions.iter().any(|c| c.value.len() > 32768)
                || page > 2000
                || !["newest", "oldest", "relevance"].contains(&sort.as_str())
            {
                return Err("invalid search".into());
            }
            let (clause, mut values) =
                crate::search_query::where_clause(&accounts, &conditions, folder.as_deref())?;
            let mut clauses = vec![clause];
            let mut from =
                "search_documents d JOIN messages m ON m.account=d.account AND m.id=d.id"
                    .to_owned();
            let rank = if tokens.is_empty() {
                "0"
            } else {
                from.push_str(" JOIN search_fts ON search_fts.rowid=d.rowid");
                clauses.push("search_fts MATCH ?".into());
                values.push(
                    tokens
                        .iter()
                        .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
                        .collect::<Vec<_>>()
                        .join(" AND ")
                        .into(),
                );
                "bm25(search_fts,6,4,3,1,2)"
            };
            for term in terms {
                clauses.push("(instr(d.subject,?)>0 OR instr(d.sender,?)>0 OR instr(d.recipients,?)>0 OR instr(d.body,?)>0 OR instr(d.labels,?)>0)".into());
                values.extend((0..5).map(|_| Value::Text(term.clone())));
            }
            let clause = clauses.join(" AND ");
            let total: i64 = db.query_row(
                &format!("SELECT count(*) FROM {from} WHERE {clause}"),
                params_from_iter(&values),
                |row| row.get(0),
            )?;
            let order = if sort == "oldest" {
                "d.date ASC".into()
            } else if sort == "newest" || tokens.is_empty() {
                "d.date DESC".into()
            } else {
                format!("{rank},d.date DESC")
            };
            values.push(Value::Integer(if candidates { 200 } else { 30 }));
            values.push(Value::Integer(if candidates {
                0
            } else {
                i64::from(page) * 30
            }));
            let mut statement = db.prepare(&format!("SELECT d.account,d.id FROM {from} WHERE {clause} ORDER BY {order},d.account,d.id LIMIT ? OFFSET ?"))?;
            let rows = statement.query_map(params_from_iter(&values), |row| Ok(json!({ "account": row.get::<_, String>(0)?, "id": row.get::<_, String>(1)? })))?.collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({ "total": total, "rows": rows }))
        }
    }
}
