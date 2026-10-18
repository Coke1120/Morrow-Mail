use morrow_search::{
    mail_threads::Index,
    policy,
    store::{Store, merge},
};
use serde_json::{Value, json};
const A: &str = "one@threads.invalid";
const B: &str = "two@threads.invalid";
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("morrow-threads-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn mail(id: &str, extra: Value) -> Value {
    merge(
        json!({"id":id,"folder":"inbox","fromEmail":"peer@threads.invalid","to":A,"subject":"Same subject","body":"Please decide.","date":"2026-10-12T08:00:00Z"}),
        &extra,
    )
}
#[test]
fn provider_threads_and_accounts_are_separate_even_with_colliding_ids_and_rfc_headers() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    for owner in [A, B] {
        db.upsert(
            owner,
            &mail(
                "same",
                json!({"threadId":"first","messageId":"<duplicate@threads.invalid>"}),
            ),
        )
        .unwrap();
        db.upsert(
            owner,
            &mail(
                "other",
                json!({"threadId":"second","messageId":"duplicate@threads.invalid"}),
            ),
        )
        .unwrap();
    }
    for owner in [A, B] {
        let index = Index::load(&db, owner).unwrap();
        assert_eq!(index.candidates().len(), 2);
        assert_ne!(
            index.thread("same").unwrap().key,
            index.thread("other").unwrap().key
        );
        assert!(index.thread("same").unwrap().partial);
    }
    let one = Index::load(&db, A).unwrap();
    let two = Index::load(&db, B).unwrap();
    assert_ne!(
        one.thread("same").unwrap().signature,
        two.thread("same").unwrap().signature
    );
}
#[test]
fn rfc_chains_and_owned_sent_replies_link_without_subject_or_sender_guessing() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    db.upsert(
        A,
        &mail("root", json!({"messageId":"root@threads.invalid"})),
    )
    .unwrap();
    db.upsert(A,&mail("sent",json!({"folder":"sent","fromEmail":A,"to":"peer@threads.invalid","messageId":"sent@threads.invalid","replyToId":"root","date":"2026-10-12T09:00:00Z"}))).unwrap();
    db.upsert(A,&mail("followup",json!({"fromEmail":"another@threads.invalid","messageId":"followup@threads.invalid","references":["<root@threads.invalid>","<sent@threads.invalid>"],"inReplyTo":"<sent@threads.invalid>","date":"2026-10-12T10:00:00Z"}))).unwrap();
    db.upsert(A, &mail("unrelated", json!({}))).unwrap();
    let index = Index::load(&db, A).unwrap();
    let thread = index.thread("root").unwrap();
    assert_eq!(thread.ids.len(), 3);
    assert_eq!(thread.latest, "followup");
    assert!(!thread.partial);
    assert_eq!(index.candidates().len(), 2);
    assert_ne!(thread.key, index.thread("unrelated").unwrap().key);
}
#[test]
fn missing_roots_link_downloaded_children_but_remain_partial() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    for id in ["one", "two"] {
        db.upsert(A,&mail(id,json!({"messageId":format!("{id}@threads.invalid"),"references":["<missing@threads.invalid>"]}))).unwrap();
    }
    let index = Index::load(&db, A).unwrap();
    assert_eq!(index.thread("one").unwrap().ids.len(), 2);
    assert!(index.thread("one").unwrap().partial);
    assert_eq!(index.candidates().len(), 1);
    db.update(A, "one", &json!({"contentIncomplete":true}))
        .unwrap();
    assert!(Index::load(&db, A).unwrap().thread("one").unwrap().partial);
}
#[test]
fn read_state_and_prepared_drafts_do_not_invalidate_but_any_conversation_body_change_does() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    for i in 0..13 {
        db.upsert(
            A,
            &mail(
                &format!("m-{i}"),
                json!({"threadId":"one","date":format!("2026-10-12T{:02}:00:00Z",i)}),
            ),
        )
        .unwrap();
    }
    let before = Index::load(&db, A)
        .unwrap()
        .thread("m-12")
        .unwrap()
        .signature
        .clone();
    db.update(
        A,
        "m-12",
        &json!({"read":true,"starred":true,"pending":true}),
    )
    .unwrap();
    db.upsert(A,&mail("draft",json!({"folder":"drafts","threadId":"one","replyToId":"m-12","date":"2026-10-12T23:00:00Z"}))).unwrap();
    assert_eq!(
        Index::load(&db, A)
            .unwrap()
            .thread("m-12")
            .unwrap()
            .signature,
        before
    );
    db.update(
        A,
        "m-0",
        &json!({"body":"An older fact changed outside the model context cap."}),
    )
    .unwrap();
    let index = Index::load(&db, A).unwrap();
    assert_ne!(index.thread("m-12").unwrap().signature, before);
    let p = policy::update(&json!({}), &json!({"folders":{"inbox":true,"sent":true}})).unwrap();
    let (messages, history) = index.context(&db, A, "m-12", &p, 10).unwrap();
    assert_eq!(messages.len(), 10);
    assert_eq!(history["partial"], true);
    let metadata: String = db
        .conn
        .query_row(
            "SELECT data FROM mail_review_metadata WHERE account=? AND id='m-0'",
            [A],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!metadata.contains("older fact"));
    assert!(!metadata.contains("\"body\""));
}
#[test]
fn deleted_latest_does_not_rewind_and_restoring_identical_content_does_not_revive_old_signature() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    db.upsert(A, &mail("first", json!({"threadId":"one"})))
        .unwrap();
    let latest = mail(
        "latest",
        json!({"threadId":"one","date":"2026-10-12T09:00:00Z"}),
    );
    db.upsert(A, &latest).unwrap();
    let before = Index::load(&db, A)
        .unwrap()
        .thread("first")
        .unwrap()
        .signature
        .clone();
    db.conn
        .execute("DELETE FROM messages WHERE account=? AND id='latest'", [A])
        .unwrap();
    let index = Index::load(&db, A).unwrap();
    assert_eq!(index.thread("first").unwrap().latest, "latest");
    assert!(index.thread("first").unwrap().partial);
    assert!(index.candidates().is_empty());
    db.upsert(A, &latest).unwrap();
    assert_ne!(
        Index::load(&db, A)
            .unwrap()
            .thread("first")
            .unwrap()
            .signature,
        before
    );
}
#[test]
fn dates_order_by_instant_and_uncertain_outgoing_delivery_is_never_an_answer() {
    let fixture = Fixture::new();
    let db = Store::open(&fixture.0).unwrap();
    db.upsert(
        A,
        &mail(
            "offset",
            json!({"threadId":"one","date":"2026-10-12T16:00:00+08:00"}),
        ),
    )
    .unwrap();
    db.upsert(
        A,
        &mail(
            "utc",
            json!({"threadId":"one","date":"2026-10-12T09:00:00Z"}),
        ),
    )
    .unwrap();
    assert_eq!(
        Index::load(&db, A)
            .unwrap()
            .thread("offset")
            .unwrap()
            .latest,
        "utc"
    );
    db.upsert(A,&mail("uncertain",json!({"folder":"drafts","replyToId":"utc","deliveryStatus":"uncertain","date":"2026-10-12T10:00:00Z"}))).unwrap();
    let index = Index::load(&db, A).unwrap();
    assert!(index.thread("utc").unwrap().uncertain_delivery);
    assert!(index.candidates().is_empty());
}
