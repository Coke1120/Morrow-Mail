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
        "Please decide.",
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
