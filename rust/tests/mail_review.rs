use morrow_search::{mail_review, policy, store::Store};
use serde_json::{Value, json};
const A: &str = "one@review.invalid";
const B: &str = "two@review.invalid";
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-decisions-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn decision(id: &str, body: &str, state: &str) -> Value {
    json!({"messageId":id,"priority":"P2","summary":"Decide on the project","review":{"title":"Project decision","action":if state=="completed"{""}else{"Review the requested decision"},"state":state,"replyNeeded":if state=="completed"{"no"}else{"yes"},"evidence":[{"messageId":id,"field":"body","quote":body}],"deadline":null,"questions":[]}})
}
fn report(items: Vec<Value>, date: &str) -> Value {
    json!({"id":date,"status":"completed","createdAt":date,"completedAt":date,"items":items})
}
fn setup(db: &Store) {
    db.set_settings(&json!({"mailAccounts":{A:{"provider":"imap","email":A},B:{"provider":"imap","email":B}},"policy":policy::update(&json!({}),&json!({"enabled":true,"content":{"sender":true,"subject":true,"body":true},"folders":{"inbox":true}})).unwrap()})).unwrap();
}
fn mail(db: &Store, owner: &str, id: &str, thread: &str, body: &str, date: &str) {
    db.upsert(owner,&json!({"id":id,"threadId":thread,"subject":"Same subject","body":body,"date":date,"fromEmail":"sender@review.invalid","folder":"inbox","read":true})).unwrap();
}
#[test]
fn empty_review_state_does_not_require_conversation_index_metadata() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    mail(
        &db,
        A,
        "cached",
        "thread-a",
        "Please review.",
        "2026-10-12T08:00:00Z",
    );
    // Isolated fixture trap: normal messages/settings stay available, while an
    // attempted conversation index read fails. No second writer or user store.
    db.conn
        .execute_batch("DROP TABLE mail_review_deleted")
        .unwrap();
    assert!(morrow_search::mail_threads::Index::load(&db, A).is_err());
    for reports in [
        json!([]),
        Value::Null,
        json!([{"items":[]}]),
        json!([{"items":[{"messageId":"no-longer-cached"}]}]),
    ] {
        assert!(mail_review::events(&db, A, &reports).unwrap().is_empty());
    }
    let state = morrow_search::service::state(&db, A, false, &[0; 32]).unwrap();
    assert!(state["today"]["events"].as_array().unwrap().is_empty());
    assert!(
        state["today"]["replySuggestions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.get(A, "cached").unwrap().unwrap()["body"],
        "Please review."
    );
    // A real saved projection must still require the index and its coverage.
    let reports = json!([report(
        vec![decision("cached", "Please review.", "waiting_on_user")],
        "2026-10-12T09:00:00Z"
    )]);
    assert!(mail_review::events(&db, A, &reports).is_err());
}
#[test]
fn latest_thread_evidence_wins_and_older_analysis_cannot_reopen_closure() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    mail(
        &db,
        A,
        "first",
        "thread-a",
        "Please approve the design.",
        "2026-10-12T08:00:00Z",
    );
    mail(
        &db,
        A,
        "second",
        "thread-a",
        "This request is cancelled.",
        "2026-10-12T09:00:00Z",
    );
    let reports = json!([
        report(
            vec![decision(
                "first",
                "Please approve the design.",
                "waiting_on_user"
            )],
            "2026-10-12T11:00:00Z"
        ),
        report(
            vec![decision(
                "second",
                "This request is cancelled.",
                "completed"
            )],
            "2026-10-12T10:00:00Z"
        )
    ]);
    let events = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["state"], "completed");
    assert_eq!(events[0]["messageId"], "second");
    assert_eq!(events[0]["messageIds"].as_array().unwrap().len(), 2);
    db.update(
        A,
        "second",
        &json!({"body":"This request might be cancelled."}),
    )
    .unwrap();
    let changed = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(changed[0]["state"], "uncertain");
    assert_eq!(changed[0]["grounded"], false);
}
#[test]
fn same_sender_subject_and_colliding_ids_never_merge_accounts_or_unrelated_threads() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    for owner in [A, B] {
        mail(
            &db,
            owner,
            "same",
            "one",
            "Please decide.",
            "2026-10-12T08:00:00Z",
        );
        mail(
            &db,
            owner,
            "other",
            "two",
            "Please decide.",
            "2026-10-12T09:00:00Z",
        );
    }
    let reports = json!([report(
        vec![
            decision("same", "Please decide.", "waiting_on_user"),
            decision("other", "Please decide.", "waiting_on_user")
        ],
        "2026-10-12T10:00:00Z"
    )]);
    let one = mail_review::events(&db, A, &reports).unwrap();
    let two = mail_review::events(&db, B, &reports).unwrap();
    assert_eq!(one.len(), 2);
    assert_eq!(two.len(), 2);
    assert_ne!(one[0]["id"], two[0]["id"]);
    assert!(
        one.iter()
            .all(|e| e["accountId"] == A && e["evidence"][0]["accountId"] == A)
    );
}
#[test]
fn historical_read_mail_and_used_drafts_do_not_invent_completion_or_deadlines() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    mail(
        &db,
        A,
        "old",
        "one",
        "Here is an informational update.",
        "2026-10-12T08:00:00Z",
    );
    let reports = json!([report(
        vec![json!({"messageId":"old","priority":"P1","summary":"Review the original request."})],
        "2026-10-12T09:00:00Z"
    )]);
    let events = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(events[0]["state"], "uncertain");
    assert!(events[0]["deadline"].is_null());
    assert_eq!(events[0]["action"], "");
}
#[test]
fn negation_cannot_be_cropped_out_of_a_completion_quote() {
    let messages = vec![json!({"id":"one","body":"If we have completed the work, let me know."})];
    let mut item = decision("one", "we have completed the work", "completed");
    assert!(mail_review::validate(&item["review"], &messages).is_err());
    item["review"]["evidence"][0]["quote"] = "We have completed the work".into();
    let messages =
        vec![json!({"id":"one","body":"We have completed the work only if the review passes."})];
    assert!(mail_review::validate(&item["review"], &messages).is_err());
}

#[test]
fn unsummarized_inbound_and_outbound_update_and_reopen_the_same_event() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    mail(
        &db,
        A,
        "first",
        "one",
        "Please approve the design.",
        "2026-10-12T08:00:00Z",
    );
    let reports = json!([report(
        vec![decision(
            "first",
            "Please approve the design.",
            "waiting_on_user"
        )],
        "2026-10-12T09:00:00Z"
    )]);
    mail(
        &db,
        A,
        "closed",
        "one",
        "This request is cancelled.",
        "2026-10-12T10:00:00Z",
    );
    let closed = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0]["state"], "completed");
    assert_eq!(closed[0]["messageId"], "closed");
    mail(
        &db,
        A,
        "revived",
        "one",
        "Please approve the revised design.",
        "2026-10-12T11:00:00Z",
    );
    let revived = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(revived.len(), 1);
    assert_eq!(revived[0]["state"], "waiting_on_user");
    assert_eq!(revived[0]["messageId"], "revived");
    db.upsert(A,&json!({"id":"outgoing","threadId":"one","folder":"sent","fromEmail":A,"to":"peer@review.invalid","body":"Could you send the final export?","date":"2026-10-12T12:00:00Z"})).unwrap();
    assert_eq!(
        mail_review::events(&db, A, &reports).unwrap()[0]["state"],
        "uncertain"
    );
    let current = db.settings().unwrap();
    db.set_settings(&json!({"policy":policy::update(&current["policy"],&json!({"folders":{"sent":true}})).unwrap()})).unwrap();
    let waiting = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(waiting[0]["state"], "waiting_on_others");
    assert_eq!(waiting[0]["waitingOn"], "peer@review.invalid");
    db.update(A, "outgoing", &json!({"body":"Thank you, received."}))
        .unwrap();
    let acknowledged = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(acknowledged[0]["state"], "uncertain");
    db.upsert(A,&json!({"id":"draft","threadId":"one","folder":"drafts","fromEmail":A,"body":"This request is completed.","date":"2026-10-12T13:00:00Z"})).unwrap();
    assert_eq!(
        mail_review::events(&db, A, &reports).unwrap()[0]["state"],
        "uncertain"
    );
}
#[test]
fn missing_or_truncated_followup_and_deleted_closure_never_reuse_an_old_decision() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    setup(&db);
    mail(
        &db,
        A,
        "first",
        "one",
        "Please decide.",
        "2026-10-12T08:00:00Z",
    );
    let reports = json!([report(
        vec![decision("first", "Please decide.", "waiting_on_user")],
        "2026-10-12T09:00:00Z"
    )]);
    mail(
        &db,
        A,
        "closed",
        "one",
        "This request is completed.",
        "2026-10-12T10:00:00Z",
    );
    db.update(A, "closed", &json!({"bodyTruncated":true}))
        .unwrap();
    let partial = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(partial[0]["state"], "uncertain");
    assert!(partial[0]["deadline"].is_null());
    assert_eq!(partial[0]["coverage"]["partial"], true);
    db.conn
        .execute("DELETE FROM messages WHERE account=? AND id='closed'", [A])
        .unwrap();
    let deleted = mail_review::events(&db, A, &reports).unwrap();
    assert_eq!(deleted[0]["state"], "uncertain");
    assert_eq!(deleted[0]["messageId"], "closed");
}
