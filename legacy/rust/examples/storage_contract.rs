// Test-only harness. Cargo examples are never copied into application bundles.
use morrow_search::{normalize, store::Store};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::Path,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    if let Some(texts) = request["texts"].as_array() {
        println!(
            "{}",
            json!(
                texts
                    .iter()
                    .map(|text| {
                        let text = text.as_str().unwrap();
                        json!([normalize::normalize(text), normalize::tokens(text)])
                    })
                    .collect::<Vec<_>>()
            )
        );
    } else {
        let store = Store::open(Path::new(request["directory"].as_str().unwrap()))?;
        if request["crash"] == true {
            store.conn.execute_batch("PRAGMA cache_size=1")?;
            store.transaction(|db| {
                db.set_settings(&json!({"deliveryAttempts":[],"crashMarker":"uncommitted"}))?;
                db.update(
                    "fixture@example.invalid",
                    "pending-draft",
                    &json!({"body":"uncommitted replacement","bcc":""}),
                )?;
                db.upsert(
                    "fixture@example.invalid",
                    &json!({"id":"uncommitted-new","body":"never commit"}),
                )?;
                // Abrupt process exit deliberately skips all Rust/SQLite destructors.
                std::process::exit(77);
            })?;
        }
        let before = store.settings()?;
        store.set_settings(&json!({"rustRoundTrip":true}))?;
        store.upsert("fixture@example.invalid", &json!({"id":"rust-owned", "subject":"發票", "body":"Rust writes preserve the existing index triggers.", "folder":"inbox"}))?;
        while store.backfill_batch()? != 0 {}
        println!(
            "{}",
            json!({"settings":before, "message":store.get("fixture@example.invalid", "node-owned")?})
        );
    }
    Ok(())
}
