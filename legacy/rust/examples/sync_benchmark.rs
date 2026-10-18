//! Synthetic, backend-only sync benchmark. Never accepts a workspace path.
use morrow_search::{mail, normalize, store::Store};
use rusqlite::functions::FunctionFlags;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

#[derive(Default)]
struct Counters {
    inserted: AtomicU64,
    updated: AtomicU64,
    token_calls: AtomicU64,
    token_ns: AtomicU64,
    normalize_ns: AtomicU64,
}
impl Counters {
    fn reset(&self) {
        for counter in [
            &self.inserted,
            &self.updated,
            &self.token_calls,
            &self.token_ns,
            &self.normalize_ns,
        ] {
            counter.store(0, Ordering::Relaxed);
        }
    }
}
fn probe(db: &Store, counts: &Arc<Counters>) {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS;
    let captured = counts.clone();
    db.conn
        .create_scalar_function("sync_bench_event", 1, flags, move |ctx| {
            if ctx.get::<String>(0)? == "insert" {
                captured.inserted.fetch_add(1, Ordering::Relaxed);
            } else {
                captured.updated.fetch_add(1, Ordering::Relaxed);
            }
            Ok(0)
        })
        .unwrap();
    db.conn.execute_batch("CREATE TEMP TRIGGER bench_insert AFTER INSERT ON main.messages BEGIN SELECT sync_bench_event('insert'); END;
        CREATE TEMP TRIGGER bench_update AFTER UPDATE ON main.messages BEGIN SELECT sync_bench_event('update'); END;").unwrap();
    for (name, tokens) in [("mail_normalize", false), ("mail_tokens", true)] {
        let captured = counts.clone();
        db.conn
            .create_scalar_function(
                name,
                1,
                flags | FunctionFlags::SQLITE_DETERMINISTIC,
                move |ctx| {
                    let input = ctx.get::<Option<String>>(0)?.unwrap_or_default();
                    let start = Instant::now();
                    let output = if tokens {
                        normalize::tokens(&input)
                    } else {
                        normalize::normalize(&input)
                    };
                    let elapsed = start.elapsed().as_nanos() as u64;
                    if tokens {
                        captured.token_calls.fetch_add(1, Ordering::Relaxed);
                        captured.token_ns.fetch_add(elapsed, Ordering::Relaxed);
                    } else {
                        captured.normalize_ns.fetch_add(elapsed, Ordering::Relaxed);
                    }
                    Ok(output)
                },
            )
            .unwrap();
    }
}
fn message(i: usize, body: &str) -> Value {
    json!({"id":format!("google:{i:08}"),"folder":"inbox","fromName":"Synthetic fixture","fromEmail":"sender@example.invalid","to":"owner@example.invalid","cc":"","bcc":"","replyTo":"sender@example.invalid","messageId":format!("<fixture-{i}@example.invalid>"),"subject":format!("Synthetic invoice 發票 {i}"),"body":body,"bodyHtml":"","bodyTruncated":false,"preview":"Synthetic fixture","hasAttachments":false,"date":"2026-10-12T00:00:00.000Z","read":false,"starred":false,"labels":[],"providerLabelIds":["INBOX","UNREAD"],"providerDraft":false,"providerSent":false})
}
fn main() {
    let mut results = Vec::new();
    for size in [1_000, 10_000, 50_000] {
        let root = std::env::temp_dir().join(format!("morrow-sync-bench-{}", uuid::Uuid::new_v4()));
        let db = Store::open(&root).unwrap();
        let body = "Synthetic correspondence 發票 fixture only. ".repeat(48);
        let owners = ["one@example.invalid", "two@example.invalid"];
        let seed = Instant::now();
        for owner in owners {
            let connection = json!({"email":owner,"provider":"google"});
            for begin in (0..size / 2).step_by(50) {
                let messages = (begin..(begin + 50).min(size / 2))
                    .map(|i| message(i, &body))
                    .collect::<Vec<_>>();
                mail::import_messages(&db, &connection, &messages).unwrap();
            }
        }
        let seed_ms = seed.elapsed().as_secs_f64() * 1000.0;
        let counts = Arc::new(Counters::default());
        probe(&db, &counts);
        for scenario in [
            "unchanged",
            "flags_only",
            "new_mail",
            "indexed_subject",
            "two_accounts",
        ] {
            let mut samples = Vec::new();
            for round in 0..5 {
                counts.reset();
                let before = db.conn.total_changes();
                let mut inputs = Vec::new();
                for owner in &owners[..if scenario == "two_accounts" { 2 } else { 1 }] {
                    let rows = (0..50)
                        .map(|i| {
                            if scenario == "new_mail" {
                                return message(size + round * 50 + i, &body);
                            }
                            let mut row =
                                db.get(owner, &format!("google:{i:08}")).unwrap().unwrap();
                            if scenario == "flags_only" {
                                let read = row["read"] != true;
                                row["read"] = read.into();
                                row["providerLabelIds"] = if read {
                                    json!(["INBOX"])
                                } else {
                                    json!(["INBOX", "UNREAD"])
                                };
                            } else if scenario == "indexed_subject" {
                                row["subject"] =
                                    format!("Changed synthetic subject {round}").into();
                            }
                            row
                        })
                        .collect::<Vec<_>>();
                    inputs.push((json!({"email":owner,"provider":"google"}), rows));
                }
                let start = Instant::now();
                for (connection, rows) in &inputs {
                    mail::import_messages(&db, connection, rows).unwrap();
                }
                samples.push(json!({"importMs":start.elapsed().as_secs_f64()*1000.0,"rows":inputs.iter().map(|(_,r)|r.len()).sum::<usize>(),"inserted":counts.inserted.load(Ordering::Relaxed),"updated":counts.updated.load(Ordering::Relaxed),"ftsRows":counts.token_calls.load(Ordering::Relaxed)/5,"ftsTokenizeMs":counts.token_ns.load(Ordering::Relaxed) as f64/1_000_000.0,"normalizeMs":counts.normalize_ns.load(Ordering::Relaxed) as f64/1_000_000.0,"sqliteChanges":db.conn.total_changes()-before}));
            }
            results.push(json!({"mailboxRows":size,"accounts":2,"bodyBytes":body.len(),"seedMs":seed_ms,"scenario":scenario,"samples":samples}));
        }
        assert_eq!(
            db.conn
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&json!({"schema":1,"scope":"Synthetic SQLite import only; excludes network, UI, cold cache and real-account acceptance. Timed SQLite scalar wrappers add equal observation overhead before/after; FTS time is tokenization, not total FTS maintenance.","results":results})).unwrap());
}
