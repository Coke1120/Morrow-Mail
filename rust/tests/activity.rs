use morrow_search::{activity::Runtime, background, store::Store};
use serde_json::{Value, json};

const A: &str = "one@example.invalid";
const B: &str = "two@example.invalid";
const OFF: &str = "disconnected@example.invalid";
const AT: &str = "2026-09-27T09:00:00.000Z";
fn config() -> Value {
    json!({"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"PRIVATE-CONNECTION"},B:{"email":B}}})
}
fn task(runtime: &Runtime, config: &Value, id: &str) -> Value {
    runtime.snapshot(config)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == id)
        .unwrap()
        .clone()
}

#[test]
fn in_flight_finish_drop_retention_and_connected_owner_filtering() {
    let runtime = Runtime::default();
    let mut config = config();
    let mut work = runtime.start(A, "sync", "Fetching mail", "Checking Inbox");
    assert_eq!(runtime.snapshot(&config)["tasks"][0]["status"], "running");
    assert!(runtime.snapshot(&config)["tasks"][0]["completed"].is_null());
    work.finish(true, Some(12));
    work.finish(false, Some(99));
    drop(work);
    assert_eq!(runtime.snapshot(&config)["tasks"][0]["status"], "complete");
    assert_eq!(runtime.snapshot(&config)["tasks"][0]["completed"], 12);
    drop(runtime.start(B, "ai", "AI assistance", "Waiting for the configured model"));
    assert_eq!(
        runtime.snapshot(&config)["tasks"][0]["status"],
        "interrupted"
    );
    let mut works: Vec<_> = (0..45)
        .map(|_| runtime.start(A, "sync", "Fetching mail", "Checking Sent"))
        .collect();
    let mut keep = runtime.start(B, "sync", "Fetching mail", "Checking Inbox");
    for work in &mut works {
        work.finish(true, Some(1));
    }
    let snapshot = runtime.snapshot(&config);
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 21);
    assert_eq!(
        snapshot["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["status"] == "running")
            .count(),
        1
    );
    keep.finish(false, None);
    assert_eq!(
        runtime.snapshot(&config)["tasks"].as_array().unwrap().len(),
        20
    );
    config["mailAccounts"] = json!({});
    assert_eq!(runtime.snapshot(&config)["tasks"], json!([]));
    // Legacy connection pointer is still supported when the map is absent.
    config.as_object_mut().unwrap().remove("mailAccounts");
    config["mail"] = json!({"email":A});
    assert!(
        !runtime.snapshot(&config)["tasks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn actual_import_schema_is_queued_between_pages_and_unknown_counts_stay_unknown() {
    let root = std::env::temp_dir().join(format!("morrow-activity-{}", uuid::Uuid::new_v4()));
    let db = Store::open(&root).unwrap();
    db.set_settings(&config()).unwrap();
    background::start_import(&db, A, &json!({"allMail":true})).unwrap();
    let runtime = Runtime::default();
    let id = format!("import:{A}");
    let mut config = db.settings().unwrap();
    assert_eq!(task(&runtime, &config, &id)["status"], "queued");
    let mut sync = runtime.start(A, "sync", "Fetching mail", "Checking Inbox");
    assert_eq!(task(&runtime, &config, &id)["status"], "queued");
    sync.finish(true, Some(0));
    let mut page = runtime.start(A, "import", "Fetching history", "Checking All mail");
    assert_eq!(task(&runtime, &config, &id)["status"], "running");
    assert_eq!(
        runtime.snapshot(&config)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["status"] == "running")
            .count(),
        1
    );
    assert_eq!(
        runtime.snapshot(&config)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["kind"] == "import")
            .count(),
        1
    );
    let job = config["imports"][A].clone();
    background::apply_import_page(&db, A, &job, &json!({"messages":[{"id":"PRIVATE-ID","date":job["since"],"folder":"inbox","subject":"PRIVATE-SUBJECT","body":"PRIVATE-BODY"}],"nextCursor":null})).unwrap();
    page.finish(true, Some(1));
    config = db.settings().unwrap();
    let complete = task(&runtime, &config, &id);
    assert_eq!(complete["status"], "complete");
    assert_eq!(complete["completed"], 1);
    assert!(complete["total"].is_null());
    assert!(
        complete["detail"]
            .as_str()
            .unwrap()
            .contains("All mail · 1 pages checked · 1 messages checked · 1 new messages")
    );
    config["imports"][A]
        .as_object_mut()
        .unwrap()
        .remove("pages");
    config["imports"][A]
        .as_object_mut()
        .unwrap()
        .remove("processed");
    config["imports"][A]["status"] = "failed".into();
    config["imports"][A]["error"] = "PRIVATE-PROVIDER-ERROR token".into();
    let legacy = task(&runtime, &config, &id);
    assert!(legacy["completed"].is_null());
    assert!(
        legacy["detail"]
            .as_str()
            .unwrap()
            .contains("Page count unknown · Checked message count unknown")
    );
    assert!(!runtime.snapshot(&config).to_string().contains("PRIVATE-"));
    config["imports"][A]["status"] = "paused".into();
    assert_eq!(task(&runtime, &config, &id)["status"], "paused");
    config["imports"][A]["status"] = "running".into();
    config["imports"][A]["errorCode"] = "network_error".into();
    config["imports"][A]["nextRetryAt"] = AT.into();
    config["imports"][A]["retryCount"] = 7.into();
    let retry = task(&runtime, &config, &id);
    assert!(
        retry["detail"]
            .as_str()
            .unwrap()
            .contains("Retry 7 scheduled")
    );
    assert!(!retry["detail"].as_str().unwrap().contains("/3"));
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn saved_sync_failures_survive_runtime_restart_and_clear_after_recovery() {
    let runtime = Runtime::default();
    let mut config = config();
    let id = format!("sync:{A}");
    let before = config.clone();
    for (code, expected) in [
        ("oauth_reconnect_required", "Reconnect"),
        ("outlook_sync_invalid", "Reconnect"),
        ("oauth_configuration", "OAuth client settings"),
        ("oauth_refresh_failed", "authorization"),
        ("mail_sync_failed", "connection"),
        ("PRIVATE-UNKNOWN-CODE", "connection"),
    ] {
        config["backgroundSyncErrors"] = json!([
            {"accountId":A,"code":code,"error":"PRIVATE-PROVIDER-ERROR","recoveryAction":"PRIVATE-ACTION","updatedAt":"PRIVATE-TIMESTAMP"},
            {"accountId":OFF,"code":"oauth_reconnect_required"}
        ]);
        let saved = config.clone();
        let snapshot = runtime.snapshot(&config);
        assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
        let failure = task(&runtime, &config, &id);
        assert_eq!(failure["status"], "failed");
        assert!(failure["detail"].as_str().unwrap().contains(expected));
        assert!(failure["updatedAt"].is_null());
        assert!(!snapshot.to_string().contains("PRIVATE-"));
        assert_eq!(task(&Runtime::default(), &config, &id), failure);
        assert_eq!(config, saved, "Activity must not change saved work");
    }
    config["backgroundSyncErrors"] = json!([{"accountId":A,"code":"rate_limited","nextRetryAt":AT,"retryCount":7,"error":"PRIVATE-PROVIDER-ERROR"}]);
    let waiting = task(&runtime, &config, &id);
    assert_eq!(waiting["status"], "queued");
    assert!(waiting["detail"].as_str().unwrap().contains(AT));
    assert_eq!(waiting["retryCount"], 7);
    assert!(waiting["completed"].is_null() && waiting["total"].is_null());
    config["backgroundSyncErrors"][0]["nextRetryAt"] = "PRIVATE-TIMESTAMP".into();
    let invalid_retry = task(&runtime, &config, &id);
    assert_eq!(invalid_retry["status"], "failed");
    assert!(!invalid_retry.to_string().contains("PRIVATE-"));

    config["backgroundSyncErrors"][0]["code"] = "provider_quota_exceeded".into();
    for retry_at in [json!(AT), Value::Null, json!("PRIVATE-TIMESTAMP")] {
        config["backgroundSyncErrors"][0]["nextRetryAt"] = retry_at.clone();
        let legacy = task(&runtime, &config, &id);
        assert_eq!(legacy["status"], "queued");
        assert_eq!(
            legacy["nextRetryAt"],
            if retry_at == AT {
                json!(AT)
            } else {
                Value::Null
            }
        );
        assert!(
            legacy["detail"]
                .as_str()
                .unwrap()
                .contains(if retry_at == AT { AT } else { "Retry pending" })
        );
        assert!(!legacy.to_string().contains("PRIVATE-"));
    }

    let mut failed = runtime.start(A, "sync", "Fetching mail", "Inbox");
    failed.finish(false, None);
    let mut retry = runtime.start(A, "sync", "Fetching mail", "Inbox");
    let snapshot = runtime.snapshot(&config);
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["tasks"][0]["status"], "running");
    retry.finish(true, Some(1));
    config = before;
    let recovered = runtime.snapshot(&config);
    assert_eq!(recovered["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(recovered["tasks"][0]["status"], "complete");
    assert_eq!(recovered["tasks"][0]["accountId"], A);
}

#[test]
fn summaries_learning_and_serial_index_progress_never_expose_sources_or_raw_errors() {
    let runtime = Runtime::default();
    let mut config = config();
    let secret = json!({"id":"PRIVATE-ID","text":"PRIVATE-BODY","voice":"PRIVATE-VOICE","error":"PRIVATE-ERROR api-key","sources":[{"body":"PRIVATE-BODY"}],"createdAt":AT});
    let with_status = |status: &str| {
        let mut job = secret.clone();
        job["status"] = status.into();
        job
    };
    config["automation"] = json!({A:{"jobs":[with_status("running"),with_status("queued"),with_status("skipped")]},OFF:{"jobs":[with_status("running")]}});
    let mut running = with_status("running");
    running["sampleCount"] = 4.into();
    let mut ready = with_status("ready");
    ready["sampleCount"] = 2.into();
    config["styleLearning"] =
        json!({A:{"preview":running},B:{"preview":ready},OFF:{"preview":with_status("running")}});
    let sources = [A, B, OFF, A]
        .map(|account| json!({"account":account,"id":"PRIVATE-ID","hash":"PRIVATE-HASH"}));
    config["searchIndex"] = json!({"status":"running","completed":1,"sources":sources,"error":"PRIVATE-ERROR","createdAt":AT});
    let before = config.clone();
    let summary = task(&runtime, &config, &format!("summaries:{A}"));
    assert_eq!(summary["status"], "running");
    assert_eq!(summary["total"], 2);
    assert!(summary["completed"].is_null());
    let last = task(&runtime, &config, &format!("last-summary:{A}"));
    assert_eq!(last["status"], "interrupted");
    assert!(
        last["detail"]
            .as_str()
            .unwrap()
            .contains("result was discarded")
    );
    let learning = task(&runtime, &config, &format!("learning:{A}"));
    assert!(learning["completed"].is_null());
    assert_eq!(learning["total"], 4);
    let ready = task(&runtime, &config, &format!("learning:{B}"));
    assert_eq!(ready["completed"], 2);
    assert!(
        ready["detail"]
            .as_str()
            .unwrap()
            .contains("Review and save")
    );
    let index = task(&runtime, &config, &format!("semantic-index:{A}"));
    assert_eq!(index["status"], "queued");
    assert_eq!(index["completed"], 1);
    assert_eq!(index["total"], 2);
    assert_eq!(
        task(&runtime, &config, &format!("semantic-index:{B}"))["status"],
        "running"
    );
    let snapshot = runtime.snapshot(&config).to_string();
    for secret in ["PRIVATE-", "api-key", OFF] {
        assert!(!snapshot.contains(secret));
    }
    assert_eq!(config, before);
    config["searchIndex"]["completed"] = 4.into();
    assert_eq!(
        task(&runtime, &config, &format!("semantic-index:{A}"))["status"],
        "complete"
    );
    config["searchIndex"]["status"] = "prepared".into();
    assert!(
        task(&runtime, &config, &format!("semantic-index:{A}"))["detail"]
            .as_str()
            .unwrap()
            .contains("Waiting for your confirmation")
    );
    config["styleLearning"][A]["preview"]["status"] = "prepared".into();
    assert!(task(&runtime, &config, &format!("learning:{A}"))["completed"].is_null());
    config["styleLearning"][A]["preview"]["status"] = "failed".into();
    assert!(
        !task(&runtime, &config, &format!("learning:{A}"))["detail"]
            .as_str()
            .unwrap()
            .contains("Analyzing")
    );
    config["mailAccounts"].as_object_mut().unwrap().remove(B);
    assert!(
        runtime.snapshot(&config)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|task| task["accountId"] == A)
    );
}
