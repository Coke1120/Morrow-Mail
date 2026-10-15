//! Content-free summary diagnostics remain useful after their result is stale.
use morrow_search::{activity::Runtime, background, policy, store::Store};
use serde_json::{Value, json};

const A: &str = "one@summary.example.invalid";
const B: &str = "two@summary.example.invalid";
const OFF: &str = "disconnected@summary.example.invalid";
const CREATED: &str = "2026-09-27T09:00:00.000Z";
const STARTED: &str = "2026-09-27T09:00:01.000Z";
const FINISHED: &str = "2026-09-27T09:00:12.000Z";

fn config() -> Value {
    json!({"mailAccounts":{A:{"email":A,"provider":"google","connectionId":"PRIVATE-CONNECTION"},B:{"email":B,"provider":"google","connectionId":"PRIVATE-OTHER-CONNECTION"}},"ai":{"model":"PRIVATE-MODEL","apiKey":"PRIVATE-KEY","baseUrl":"http://127.0.0.1:1/v1"},"preferences":{"syncInterval":0}})
}
fn saved_job(status: &str, error: &str) -> Value {
    json!({"id":"PRIVATE-JOB-ID","kind":"manual","status":status,"error":error,"createdAt":CREATED,"runningAt":STARTED,"finishedAt":FINISHED,"updatedAt":FINISHED,"messageIds":["PRIVATE-MESSAGE-ONE","PRIVATE-MESSAGE-TWO"],"signature":"PRIVATE-SIGNATURE","sourceDigest":"PRIVATE-DIGEST","text":"PRIVATE-MAIL-BODY","items":[{"messageId":"PRIVATE-ID","summary":"PRIVATE-SUMMARY"}],"diagnosticCode":"PRIVATE-CODE","diagnostic":"PRIVATE-DIAGNOSTIC"})
}
fn last(config: &Value, owner: &str) -> Value {
    Runtime::default().snapshot(config)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == format!("last-summary:{owner}"))
        .unwrap()
        .clone()
}

#[test]
fn terminal_summary_diagnostics_keep_distinct_statuses_and_rebuild_only_safe_errors() {
    let cases = [
        (
            "failed",
            "The summary timed out. Nothing was sent. Review Today before generating again.",
            "failed",
            "summary_timeout",
            "timed out",
        ),
        (
            "failed",
            "The AI model did not respond within 45 seconds. Check model availability or use a faster model; no automatic retry was started.",
            "failed",
            "model_timeout",
            "45 seconds",
        ),
        (
            "failed",
            "Could not reach the AI model or read its response. Check your endpoint and model, then try again.",
            "failed",
            "model_unreachable",
            "reach the AI model",
        ),
        (
            "failed",
            "The AI provider returned HTTP 429. Check the model, endpoint, and API key.",
            "failed",
            "model_http_error",
            "HTTP 429",
        ),
        (
            "failed",
            "The model response exceeded the 1 MB limit. Reduce the token limit.",
            "failed",
            "response_too_large",
            "1 MB",
        ),
        (
            "failed",
            "The AI model returned invalid JSON. Check that the endpoint supports chat completions.",
            "failed",
            "model_invalid_json",
            "invalid JSON",
        ),
        (
            "failed",
            "The model returned an empty response. Try a different model.",
            "failed",
            "model_empty_response",
            "empty response",
        ),
        (
            "failed",
            "The model returned an incomplete P0–P4 summary. Try fewer context messages or a higher response token limit.",
            "failed",
            "summary_incomplete",
            "incomplete P0–P4",
        ),
        (
            "failed",
            "The model returned an ungrounded decision. Review its sources and generate again.",
            "failed",
            "summary_ungrounded",
            "ungrounded",
        ),
        (
            "failed",
            "Remote AI providers must use HTTPS. Local models may use HTTP on localhost.",
            "failed",
            "model_configuration",
            "Settings",
        ),
        (
            "failed",
            "Invalid summary context.",
            "failed",
            "summary_context_invalid",
            "context",
        ),
        (
            "failed",
            "The workspace could not complete the database operation. Saved data has been retained.",
            "failed",
            "storage_error",
            "database",
        ),
        (
            "failed",
            "The workspace could not read or save its files. Check available space and permissions.",
            "failed",
            "file_error",
            "files",
        ),
        (
            "failed",
            "PRIVATE-PROVIDER-ERROR api-key",
            "failed",
            "unknown_failure",
            "could not complete",
        ),
        (
            "failed",
            "The AI provider returned HTTP 429. Check the model, endpoint, and API key. PRIVATE-KEY",
            "failed",
            "unknown_failure",
            "could not complete",
        ),
        (
            "failed",
            "The AI provider returned HTTP 999. Check the model, endpoint, and API key.",
            "failed",
            "unknown_failure",
            "could not complete",
        ),
        (
            "failed",
            "The AI provider returned HTTP ４２９. Check the model, endpoint, and API key.",
            "failed",
            "unknown_failure",
            "could not complete",
        ),
        (
            "failed",
            "The AI provider returned HTTP 429\nPRIVATE-KEY. Check the model, endpoint, and API key.",
            "failed",
            "unknown_failure",
            "could not complete",
        ),
        (
            "cancelled",
            "PRIVATE-ERROR",
            "cancelled",
            "cancelled",
            "cancelled",
        ),
        (
            "interrupted",
            "PRIVATE-ERROR",
            "interrupted",
            "interrupted",
            "interrupted",
        ),
        (
            "skipped",
            "PRIVATE-ERROR",
            "skipped",
            "context_changed",
            "context changed",
        ),
        (
            "completed",
            "PRIVATE-ERROR",
            "completed",
            "completed",
            "completed",
        ),
        (
            "complete",
            "PRIVATE-ERROR",
            "completed",
            "completed",
            "completed",
        ),
        (
            "PRIVATE-STATUS",
            "PRIVATE-ERROR",
            "unknown",
            "unknown_status",
            "not recorded",
        ),
    ];
    for (stored, error, expected, code, fragment) in cases {
        let mut config = config();
        config["automation"] = json!({A:{"jobs":[saved_job(stored,error)]}});
        let before = config.clone();
        let task = last(&config, A);
        assert_eq!(task["status"], expected, "{stored} / {code}");
        let detail = &task["summaryJob"];
        assert_eq!(detail["status"], expected);
        assert_eq!(detail["diagnosticCode"], code);
        let message = detail["diagnostic"].as_str().unwrap();
        assert!(message.contains(fragment), "{code}: {message}");
        assert!(message.encode_utf16().count() <= 512);
        assert_eq!(detail["accountId"], A);
        assert_eq!(detail["kind"], "manual");
        assert_eq!(detail["messageCount"], 2);
        assert_eq!(detail["automaticRetry"], false);
        assert_eq!(detail["createdAt"], CREATED);
        assert_eq!(detail["startedAt"], STARTED);
        assert_eq!(detail["finishedAt"], FINISHED);
        assert_eq!(detail["updatedAt"], FINISHED);
        let id = detail["id"].as_str().unwrap();
        assert_eq!(id.len(), 64);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(detail.as_object().unwrap().len(), 12);
        if expected != "completed" {
            assert_eq!(task["error"], detail["diagnostic"]);
        } else {
            assert!(task["error"].is_null());
        }
        assert!(!task.to_string().contains("PRIVATE-"));
        assert!(!task.to_string().contains("AI Studio"));
        assert!(!task.to_string().contains("Review Summaries"));
        assert_eq!(
            config, before,
            "reading Activity must never mutate or retry a job"
        );
    }
}

#[test]
fn summary_identity_and_times_do_not_invent_missing_or_malformed_history() {
    let mut config = config();
    let mut job = saved_job("failed", "PRIVATE-ERROR");
    for field in ["finishedAt", "updatedAt", "messageIds"] {
        job.as_object_mut().unwrap().remove(field);
    }
    config["automation"] = json!({A:{"jobs":[job.clone()]},B:{"jobs":[job.clone()]}});
    let a = last(&config, A);
    let b = last(&config, B);
    assert_ne!(a["summaryJob"]["id"], b["summaryJob"]["id"]);
    assert!(a["summaryJob"]["finishedAt"].is_null());
    assert!(a["summaryJob"]["updatedAt"].is_null());
    assert!(a["summaryJob"]["messageCount"].is_null());
    assert_eq!(a["summaryJob"]["startedAt"], STARTED);

    job["status"] = "completed".into();
    job["completedAt"] = "2026-09-27T17:00:12+08:00".into();
    job["updatedAt"] = STARTED.into();
    config["automation"][A]["jobs"] = json!([job.clone()]);
    let completed = last(&config, A);
    assert_eq!(completed["summaryJob"]["id"], a["summaryJob"]["id"]);
    assert_eq!(completed["summaryJob"]["finishedAt"], FINISHED);
    assert_eq!(completed["summaryJob"]["updatedAt"], FINISHED);
    assert_eq!(completed["updatedAt"], FINISHED);

    for id in [
        Value::Null,
        json!(""),
        json!(" \t "),
        json!({"PRIVATE-ID":"PRIVATE-KEY"}),
    ] {
        job["id"] = id;
        job["kind"] = "PRIVATE-KIND".into();
        job["createdAt"] = "PRIVATE-DATE".into();
        job["runningAt"] = "PRIVATE-DATE".into();
        job["completedAt"] = "PRIVATE-DATE".into();
        job["finishedAt"] = json!({"PRIVATE-DATE":"PRIVATE-KEY"});
        job["updatedAt"] = (-1).into();
        config["automation"][A]["jobs"] = json!([job.clone()]);
        let malformed = last(&config, A);
        assert!(malformed["summaryJob"]["id"].is_null());
        assert_eq!(malformed["summaryJob"]["kind"], "unknown");
        for field in ["createdAt", "startedAt", "finishedAt", "updatedAt"] {
            assert!(malformed["summaryJob"][field].is_null(), "{field}");
        }
        assert!(!malformed.to_string().contains("PRIVATE-"));
    }
}

#[test]
fn activity_uses_the_saved_job_even_when_day_context_and_today_filters_exclude_it() {
    let directory = std::env::temp_dir().join(format!(
        "morrow-summary-diagnostics-{}",
        uuid::Uuid::new_v4()
    ));
    let db = Store::open(&directory).unwrap();
    let mut config = config();
    config["policy"] = policy::update(
        &json!({}),
        &json!({"triggers":{"onArrival":true,"scheduledSummary":false}}),
    )
    .unwrap();
    db.set_settings(&config).unwrap();
    db.upsert(A,&json!({"id":"same","folder":"inbox","fromEmail":"sender@example.invalid","body":"PRIVATE-MAIL-BODY","subject":"PRIVATE-SUBJECT","date":CREATED})).unwrap();
    background::arrivals(&db, A, &["same".into()]).unwrap();
    let mut saved = db.settings().unwrap();
    let mut original = saved["automation"][A]["jobs"][0].clone();
    original["status"] = "failed".into();
    original["error"] = "The model returned an empty response. Try a different model.".into();
    original["createdAt"] = CREATED.into();
    original["finishedAt"] = FINISHED.into();
    saved["automation"][A]["jobs"] = json!([original.clone()]);
    db.set_settings(&saved).unwrap();
    assert_eq!(
        background::reports(&db, A)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let earlier = last(&db.settings().unwrap(), A)["summaryJob"].clone();

    // A later saved terminal row remains the existing reverse-insertion choice,
    // even if its historical clock is older. Active work is projected separately.
    let mut stale = original.clone();
    stale["id"] = "PRIVATE-OLD-JOB".into();
    stale["signature"] = "PRIVATE-OBSOLETE-CONTEXT".into();
    stale["createdAt"] = "2020-01-01T00:00:00Z".into();
    stale["finishedAt"] = "2020-01-01T00:00:02Z".into();
    let mut queued = original.clone();
    queued["id"] = "PRIVATE-QUEUED".into();
    queued["status"] = "queued".into();
    saved["automation"] = json!({A:{"jobs":[original,stale.clone(),queued]},B:{"jobs":[stale.clone()]},OFF:{"jobs":[stale]}});
    saved["policy"]["enabled"] = false.into();
    db.set_settings(&saved).unwrap();
    assert_eq!(background::reports(&db, A).unwrap(), json!([]));
    let before = db.settings().unwrap();
    let current = last(&before, A);
    assert_eq!(current["status"], "failed");
    assert_eq!(
        current["summaryJob"]["createdAt"],
        "2020-01-01T00:00:00.000Z"
    );
    assert_eq!(
        current["summaryJob"]["diagnosticCode"],
        "model_empty_response"
    );
    assert_ne!(current["summaryJob"]["id"], earlier["id"]);
    assert_eq!(earlier["createdAt"], CREATED);
    assert_ne!(
        current["summaryJob"]["id"],
        last(&before, B)["summaryJob"]["id"]
    );
    let snapshot = Runtime::default().snapshot(&before);
    assert!(
        snapshot["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == format!("summaries:{A}") && task["status"] == "queued")
    );
    assert!(!snapshot.to_string().contains(OFF));
    assert!(!snapshot.to_string().contains("PRIVATE-"));
    assert_eq!(db.settings().unwrap(), before);
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn terminal_mutations_record_finish_but_recovery_only_records_observation() {
    let directory = std::env::temp_dir().join(format!(
        "morrow-summary-terminal-times-{}",
        uuid::Uuid::new_v4()
    ));
    let db = Store::open(&directory).unwrap();
    for status in ["cancelled", "failed", "interrupted"] {
        let mut config = config();
        let mut job = saved_job("running", "PRIVATE-ERROR");
        job.as_object_mut().unwrap().remove("finishedAt");
        job["updatedAt"] = STARTED.into();
        config["automation"] = json!({A:{"jobs":[job]}});
        db.set_settings(&config).unwrap();
        match status {
            "cancelled" => assert!(background::cancel_running_summaries(&db, A).unwrap()),
            "failed" => background::expire_stale(&db).unwrap(),
            "interrupted" => background::recover(&db).unwrap(),
            _ => unreachable!(),
        }
        let saved = db.settings().unwrap();
        let job = &saved["automation"][A]["jobs"][0];
        assert_eq!(job["status"], status);
        let updated = job["updatedAt"].as_str().unwrap();
        assert!(updated > STARTED);
        assert!(chrono::DateTime::parse_from_rfc3339(updated).is_ok());
        let detail = last(&saved, A)["summaryJob"].clone();
        assert_eq!(detail["updatedAt"], updated);
        assert_eq!(detail["startedAt"], STARTED);
        if status == "interrupted" {
            assert!(job["finishedAt"].is_null());
            assert!(detail["finishedAt"].is_null());
        } else {
            assert_eq!(job["finishedAt"], updated);
            assert_eq!(detail["finishedAt"], updated);
        }
        let before = db.settings().unwrap();
        background::recover(&db).unwrap();
        assert_eq!(
            db.settings().unwrap(),
            before,
            "terminal work is not replayed on recovery"
        );
    }
    let before = last(&db.settings().unwrap(), A);
    drop(db);
    let reopened = Store::open(&directory).unwrap();
    assert_eq!(last(&reopened.settings().unwrap(), A), before);
    drop(reopened);
    std::fs::remove_dir_all(directory).unwrap();
}
