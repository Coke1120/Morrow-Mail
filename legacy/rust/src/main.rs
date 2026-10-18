use morrow_search::search::{Operation, execute};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::time::Duration;

const MAX_INPUT: u64 = 2 * 1024 * 1024;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u32,
    operation: Operation,
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("{}", env!("MORROW_VERSION"));
        return Ok(());
    }
    if args.len() != 1 || !Path::new(&args[0]).is_absolute() {
        return Err("trusted absolute database path required".into());
    }
    let db = Connection::open_with_flags(
        &args[0],
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(100))?;
    morrow_search::store::register_functions(&db)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    let version: i64 =
        db.query_row("SELECT max(version) FROM search_meta", [], |row| row.get(0))?;
    if version != 1 {
        return Err("unsupported search schema".into());
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let length = (&mut input)
            .take(MAX_INPUT + 1)
            .read_until(b'\n', &mut line)?;
        if length == 0 {
            break;
        }
        if length as u64 > MAX_INPUT {
            return Err("request too large".into());
        }
        let request: Request = serde_json::from_slice(&line)?;
        // One consistent read snapshot for counts, ranking and IDs. This never acquires a write transaction.
        let transaction = db.unchecked_transaction()?;
        let result = execute(&transaction, request.operation);
        transaction.rollback()?;
        let response = match result {
            Ok(value) => json!({ "id": request.id, "result": value }),
            Err(_) => json!({ "id": request.id, "error": "Search worker rejected the operation." }),
        };
        let encoded = serde_json::to_vec(&response)?;
        if encoded.len() > 1024 * 1024 {
            return Err("response too large".into());
        }
        output.write_all(&encoded)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("Morrow search worker stopped.");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_cosine_and_protocol_reject_invalid_operations() {
        let db = Connection::open_in_memory().unwrap();
        let result = execute(
            &db,
            Operation::Cosine {
                query: vec![1.0, 0.0],
                vectors: vec![vec![0.6, 0.8], vec![-1.0, 0.0]],
            },
        )
        .unwrap();
        assert_eq!(result, json!({"scores": [0.6, -1.0]}));
        assert!(
            execute(
                &db,
                Operation::Cosine {
                    query: vec![1.0],
                    vectors: vec![vec![1.0, 0.0]]
                }
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Request>(
                r#"{"id":1,"operation":{"kind":"sql","sql":"DELETE FROM messages"}}"#
            )
            .is_err()
        );
        assert!(serde_json::from_str::<Request>(r#"{"id":1,"operation":{"kind":"cosine","query":[],"vectors":[],"path":"elsewhere"}}"#).is_err());
    }
}
