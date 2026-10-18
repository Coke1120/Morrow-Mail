use chrono::{Duration, Utc};
use morrow_search::{learning, policy, store::Store};
use serde_json::{Value, json};
use std::path::PathBuf;

const OWNER: &str = "owner@example.test";
const OTHER: &str = "other@example.test";
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-identity-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn open(directory: &Temporary) -> Store {
    let db = Store::open(&directory.0).unwrap();
    db.set_settings(&json!({
        "mailAccounts":{OWNER:{"email":OWNER,"provider":"imap","connectionId":"one"},OTHER:{"email":OTHER,"provider":"imap","connectionId":"two"}},
        "preferences":{"displayName":"Unconfirmed inferred name","signature":"Unconfirmed signature"},
        "workspaces":{OWNER:{"brain":{"notes":"Keep notes","voice":"Keep manual voice"}}},
        "ai":{"baseUrl":"http://127.0.0.1:1/v1","model":"unused-fixture","maxTokens":800},
        "policy":policy::update(&json!({}), &json!({"folders":{"sent":true},"maxMessages":50})).unwrap()
    })).unwrap();
    db
}
fn save(db: &Store, value: Value) {
    learning::update_settings(db, OWNER, &json!({"identity":value})).unwrap();
}

#[test]
fn confirmed_identity_is_bounded_account_owned_and_never_inferred() {
    let directory = Temporary::new();
    let db = open(&directory);
    let original_brain = db.settings().unwrap()["workspaces"].clone();
    assert_eq!(
        learning::identity(&db.settings().unwrap(), OWNER),
        Value::Null
    );
    let input = json!({"displayName":" Leo Ho ","aliases":[" Leo ","leo","LEO HO","何先生"],"confirmed":true});
    save(&db, input);
    assert_eq!(
        learning::identity(&db.settings().unwrap(), OWNER),
        json!({"displayName":"Leo Ho","aliases":["Leo","何先生"]})
    );
    let generation = db.settings().unwrap()["aiGeneration"].as_u64().unwrap();
    save(
        &db,
        json!({"displayName":"Leo Ho","aliases":["Leo","何先生"],"confirmed":true}),
    );
    assert_eq!(db.settings().unwrap()["aiGeneration"], generation);
    for owner in [OTHER, "all", "demo", "missing@example.test"] {
        assert!(learning::identity(&db.settings().unwrap(), owner).is_null());
    }
    let state = learning::state_with_store(&db, &db.settings().unwrap(), OWNER).unwrap();
    assert_eq!(state["settings"]["enabled"], false);
    assert!(state["profile"].is_null());
    assert!(state["preview"].is_null());
    assert_eq!(db.settings().unwrap()["workspaces"], original_brain);
    let before = db.settings().unwrap()["styleLearning"].clone();
    for invalid in [
        Value::Null,
        json!([]),
        json!({"displayName":"Implicit confirmation"}),
        json!({"displayName":"Leo","aliases":[],"confirmed":true,"extra":"secret"}),
        json!({"displayName":"Leo","aliases":[],"confirmed":"yes"}),
        json!({"displayName":"","aliases":[],"confirmed":true}),
        json!({"displayName":"a".repeat(101),"aliases":[],"confirmed":true}),
        json!({"displayName":"😀".repeat(51),"aliases":[],"confirmed":true}),
        json!({"displayName":"Leo\nOther","aliases":[],"confirmed":true}),
        json!({"displayName":"Leo","aliases":["bad\u{85}name"],"confirmed":true}),
        json!({"displayName":"Leo","aliases":[""],"confirmed":true}),
        json!({"displayName":"Leo","aliases":vec!["Alias";11],"confirmed":true}),
    ] {
        assert_eq!(
            learning::update_settings(&db, OWNER, &json!({"identity":invalid}))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(db.settings().unwrap()["styleLearning"], before);
    }
    save(
        &db,
        json!({"displayName":"Leo","aliases":[],"confirmed":false}),
    );
    assert!(learning::identity(&db.settings().unwrap(), OWNER).is_null());
    assert_eq!(db.settings().unwrap()["aiGeneration"], generation + 1);
    save(
        &db,
        json!({"displayName":"Leo Ho","aliases":["Leo","何先生"],"confirmed":true}),
    );
    assert_eq!(db.settings().unwrap()["aiGeneration"], generation + 2);
    let atomic_before = db.settings().unwrap();
    let rollback: morrow_search::error::Result<()> = db.transaction(|db| {
        learning::update_settings(
            db,
            OWNER,
            &json!({"identity":{"displayName":"Leo","aliases":[],"confirmed":false}}),
        )?;
        Err(morrow_search::error::Error::conflict("Rollback fixture"))
    });
    assert!(rollback.is_err());
    assert_eq!(db.settings().unwrap(), atomic_before);
    let mut learning = db.settings().unwrap()["styleLearning"].clone();
    learning[OWNER]["settings"]["identity"] = json!({"displayName":"Leo","aliases":[{"apiKey":"must-not-be-projected"}],"confirmed":true});
    db.set_settings(&json!({"styleLearning":learning})).unwrap();
    assert!(learning::identity(&db.settings().unwrap(), OWNER).is_null());
    assert_eq!(
        learning::state(&db.settings().unwrap(), OWNER)["settings"]["identity"],
        json!({"displayName":"","aliases":[],"confirmed":false})
    );
    save(
        &db,
        json!({"displayName":"Leo","aliases":[],"confirmed":true}),
    );
    db.set_settings(&json!({"mailAccounts":{OTHER:{"email":OTHER}}}))
        .unwrap();
    assert!(learning::identity(&db.settings().unwrap(), OWNER).is_null());
    assert_eq!(
        learning::update_settings(
            &db,
            OWNER,
            &json!({"identity":{"displayName":"Leo","aliases":[],"confirmed":true}})
        )
        .unwrap_err()
        .status,
        409
    );
}

#[test]
fn identity_edits_revoke_preview_preserve_approved_style_schedule_and_survive_restart() {
    let directory = Temporary::new();
    let db = open(&directory);
    db.upsert(OWNER, &json!({"id":"sent","folder":"sent","fromEmail":OWNER,"to":"recipient@example.test","date":(Utc::now()-Duration::hours(1)).to_rfc3339(),"body":"Hello, please review the proposed timetable and share your thoughts. Thank you for your help."})).unwrap();
    learning::update_settings(&db, OWNER, &json!({"enabled":true,"weekly":true})).unwrap();
    let prepared = learning::prepare(&db, OWNER, false).unwrap();
    // Seed a model proposal without making any model or provider request.
    let mut learning = db.settings().unwrap()["styleLearning"].clone();
    learning[OWNER]["preview"]["status"] = "ready".into();
    db.set_settings(&json!({"styleLearning":learning})).unwrap();
    learning::apply(
        &db,
        OWNER,
        &json!({"previewId":prepared["id"],"voice":"Approved writing style"}),
    )
    .unwrap();
    let preview = learning::prepare(&db, OWNER, false).unwrap();
    let previous = db.settings().unwrap()["styleLearning"][OWNER].clone();
    let confirmed = json!({"displayName":"Leo","aliases":["何先生"],"confirmed":true});
    save(&db, confirmed.clone());
    let current = db.settings().unwrap();
    for key in ["profile", "lastWeeklyAt", "weeklySince"] {
        assert_eq!(current["styleLearning"][OWNER][key], previous[key]);
    }
    assert!(learning::state_with_store(&db, &current, OWNER).unwrap()["preview"].is_null());
    assert_eq!(
        learning::apply(
            &db,
            OWNER,
            &json!({"previewId":preview["id"],"voice":"Stale result"})
        )
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(
        learning::voice(&db, &current, OWNER).unwrap(),
        "Approved writing style"
    );
    learning::clear(&db, OWNER).unwrap();
    assert!(learning::state(&db.settings().unwrap(), OWNER)["profile"].is_null());
    drop(db);
    let db = Store::open(&directory.0).unwrap();
    assert_eq!(
        learning::state(&db.settings().unwrap(), OWNER)["settings"]["identity"],
        confirmed
    );
    assert_eq!(
        learning::identity(&db.settings().unwrap(), OWNER),
        json!({"displayName":"Leo","aliases":["何先生"]})
    );
    assert_eq!(
        learning::state(&db.settings().unwrap(), OWNER)["settings"]["enabled"],
        false
    );
}
