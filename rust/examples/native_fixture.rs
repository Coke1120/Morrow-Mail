//! Disposable native-client acceptance data. Never bundled with the product.
use morrow_search::store::Store;
use serde_json::json;
use std::{error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Use native_fixture seed|verify <marked-temporary-workspace>".into());
    }
    let path = PathBuf::from(&args[1]);
    let temp = std::env::temp_dir().canonicalize()?;
    let path = path.canonicalize()?;
    if path.parent() != Some(temp.as_path())
        || !path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("morrow-native-check-")
        || fs::read_to_string(path.join("disposable-native-fixture"))?
            != "Morrow native acceptance fixture"
    {
        return Err(
            "Requires a marked disposable workspace directly under the temporary directory.".into(),
        );
    }
    let first = "one@fixture.invalid";
    let second = "two@fixture.invalid";
    match args[0].to_str() {
        Some("seed") => {
            if path.join("genmail.sqlite").exists() {
                return Err("Refusing to overwrite an existing fixture.".into());
            }
            let db = Store::open(&path)?;
            db.set_settings(&json!({
                "mailAccounts": {
                    first:{"provider":"imap","email":first,"password":"fictional-only","imapHost":"fixture.invalid","smtpHost":"fixture.invalid","imapPort":993,"smtpPort":465},
                    second:{"provider":"imap","email":second,"password":"fictional-only","imapHost":"fixture.invalid","smtpHost":"fixture.invalid","imapPort":993,"smtpPort":465}
                },
                "activeAccount":first,"preferences":{"syncInterval":0,"markReadOnOpen":false},
                "policy":{"enabled":false},"fixtureVersion":1
            }))?;
            db.transaction(|db| {
                for account in [first, second] {
                    for i in 0..65 {
                        db.upsert(account, &json!({"id":format!("mail-{i:03}"),"fromName":format!("Sender {:02}",i%10),"fromEmail":"sender@fixture.invalid","to":account,"cc":"","subject":format!("Native fixture {i:03}"),"body":format!("Complete native fixture body {i:03} owned by {account}."),"date":format!("2026-09-{:02}T12:00:00.000Z",i%28+1),"folder":"inbox","read":i%2==0,"starred":i%3==0,"pending":false,"labels":[]}))?;
                    }
                }
                db.upsert(first,&json!({"id":"provider-draft","providerDraft":true,"folder":"drafts","fromEmail":first,"to":"to@fixture.invalid","cc":"cc@fixture.invalid","bcc":"bcc@fixture.invalid","subject":"Provider draft","body":"Preserve original provider draft.","date":"2026-09-28T12:00:00.000Z"}))?;
                Ok(())
            })?;
            while db.backfill_batch()? != 0 {}
            fs::write(
                path.join("client-state.json"),
                r#"{"morrow.pendingCalendar":"{\"review\":{\"title\":\"Preserved\"},\"requestId\":\"frozen-fixture\"}","morrow.account.collapsed.one@fixture.invalid":"false"}"#,
            )?;
        }
        Some("verify") => {
            let db = Store::open(&path)?;
            let config = db.settings()?;
            assert_eq!(config["fixtureVersion"], 1);
            assert_eq!(config["mailAccounts"].as_object().unwrap().len(), 2);
            assert_eq!(db.list(second)?.len(), 65);
            assert_eq!(db.get(second, "mail-000")?.unwrap()["pending"], false);
            assert_eq!(db.get(first, "mail-000")?.unwrap()["pending"], true);
            assert_eq!(
                db.get(first, "provider-draft")?.unwrap()["body"],
                "Preserve original provider draft."
            );
            let state: serde_json::Value =
                serde_json::from_slice(&fs::read(path.join("client-state.json"))?)?;
            assert_eq!(
                state["morrow.pendingCalendar"],
                r#"{"review":{"title":"Preserved"},"requestId":"frozen-fixture"}"#
            );
            let saved = db
                .list(first)?
                .into_iter()
                .find(|row| row["subject"] == "Native saved draft")
                .ok_or("Native draft was not saved.")?;
            assert_eq!(saved["bcc"], "bcc@fixture.invalid");
            assert_eq!(saved["body"], "Native saved body.");
            assert!(db.list(first)?.iter().all(|row| row["folder"] != "sent"));
        }
        _ => return Err("Unknown fixture command.".into()),
    }
    println!("Native fixture {} passed.", args[0].to_string_lossy());
    Ok(())
}
