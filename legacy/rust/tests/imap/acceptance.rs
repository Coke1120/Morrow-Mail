//! Current-source acceptance, not the historical warm-cache comparison.
//!
//! Generated TLS drives production IMAP fetch/reconciliation and the real
//! history-page transaction. The fixture supplies transport trust only. It does
//! not run the service scheduler, a native UI, a live server or any mail write.
use super::*;
use morrow_search::background;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::OpenOptions, io::Write, time::Instant};

const OTHER: &str = "isolation@example.invalid";
const BURST: u32 = 120;

fn expected_body(uid: u32) -> String {
    format!("Acceptance UID {uid:010}: {}", "x".repeat(1024))
}

async fn count(cache: &CacheWorkspace, owner: &'static str) -> u64 {
    cache
        .app()
        .db(move |db| {
            let count: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE account=?",
                [owner],
                |row| row.get(0),
            )?;
            Ok(u64::try_from(count).unwrap())
        })
        .await
        .unwrap()
}

async fn verify_downloads(cache: &CacheWorkspace, total: u32) -> Value {
    cache.app().db(move |db| {
        let connection = db.settings()?["mailAccounts"][OWNER].clone();
        let origin = imap::server_origin(&connection)?;
        let mut rows = db.conn.prepare("SELECT id,data FROM messages WHERE account=? ORDER BY id")?;
        let mut query = rows.query([OWNER])?;
        let mut actual = Sha256::new();
        let mut observed = BTreeSet::new();
        let mut body_bytes = 0_u64;
        while let Some(row) = query.next()? {
            let id: String = row.get(0)?;
            let data: String = row.get(1)?;
            let message: Value = serde_json::from_str(&data)?;
            let uid: u32 = id.strip_prefix("imap:55:").unwrap().parse().unwrap();
            assert!((1..=total).contains(&uid) && observed.insert(uid));
            assert_eq!(message["remoteId"], id);
            assert_eq!(message["imapOrigin"], origin);
            assert_eq!(message["providerFolderId"], "INBOX");
            assert_eq!(message["contentIncomplete"], false);
            assert_ne!(message["bodySize"], 0);
            let body = string(&message, "body").trim();
            assert_eq!(body, expected_body(uid));
            body_bytes += body.len() as u64;
            actual.update(id.as_bytes()); actual.update([0]); actual.update(body.as_bytes()); actual.update([0]);
        }
        assert_eq!(observed, (1..=total).collect());
        let mut expected = Sha256::new();
        let mut ids = (1..=total).map(|uid| (format!("imap:55:{uid}"), uid)).collect::<Vec<_>>();
        ids.sort_unstable();
        for (id, uid) in ids {
            expected.update(id.as_bytes()); expected.update([0]); expected.update(expected_body(uid).as_bytes()); expected.update([0]);
        }
        let actual = format!("{:x}", actual.finalize());
        let expected = format!("{:x}", expected.finalize());
        assert_eq!(actual, expected);
        Ok(json!({"expectedMessages":total,"downloadedMessages":observed.len(),"verifiedBodies":observed.len(),
            "bodyBytes":body_bytes,"expectedSha256":expected,"actualSha256":actual,"duplicates":0}))
    }).await.unwrap()
}

fn history_options(job: &Value) -> Value {
    // The public importer creates a recent pass followed by the older pass.
    // Supply its persisted window/cursor to the injectable production fetcher;
    // all cursor, date, duplicate and ownership checks stay in apply_import_page.
    let recent = string(job, "recentSince");
    let (since, before) =
        if !recent.is_empty() && recent > string(job, "since") && recent < string(job, "before") {
            if job["recentComplete"] == true {
                (string(job, "since"), recent)
            } else {
                (recent, string(job, "before"))
            }
        } else {
            (string(job, "since"), string(job, "before"))
        };
    json!({"folder":"inbox","cursor":job["cursor"],"since":since,"before":before})
}

async fn history_page(fixture: &ImapFixture, cache: &CacheWorkspace) -> Value {
    let settings = cache.app().settings().await.unwrap();
    let job = settings["imports"][OWNER].clone();
    let connection = settings["mailAccounts"][OWNER].clone();
    let page = imap::fetch_page_cached_with_tls(
        cache.app(),
        &connection,
        &history_options(&job),
        &fixture.connector,
    )
    .await
    .unwrap();
    let saved = page.clone();
    cache
        .app()
        .db(move |db| background::apply_import_page(db, OWNER, &job, &saved))
        .await
        .unwrap();
    page
}

async fn restart(cache: &mut CacheWorkspace) {
    drop(cache.app.take());
    cache.app = Some(
        morrow_search::service::App::open(&cache.root, 0, "fictional-cache".into(), String::new())
            .unwrap(),
    );
    cache.app().db(background::recover).await.unwrap();
}

fn flag_round_limit(total: u32) -> u32 {
    // imap::CHANGE_QUEUE_LIMIT is 1,000; reconcile's 50-row batch can reserve
    // one row for rotation. Discovery yields until each pending window drains.
    // Keep the existing 16-round startup/scope allowance, separate from work.
    (0..total)
        .step_by(1000)
        .map(|start| (total - start).min(1000).div_ceil(49))
        .sum::<u32>()
        + 16
}

async fn flag_failure_snapshot(
    cache: &CacheWorkspace,
    total: u32,
    changed: &[u32],
    enabled: bool,
    rounds: u32,
    limit: u32,
) -> Value {
    let ids = changed.to_vec();
    cache.app().db(move |db| {
        let mut remaining = Vec::new();
        for uid in ids {
            let Some(row) = db.get(OWNER, &format!("imap:55:{uid}"))? else {
                remaining.push(json!({"uid":uid,"missing":true}));
                continue;
            };
            if row["read"] != enabled || row["starred"] != enabled {
                remaining.push(json!({"uid":uid,"read":row["read"].as_bool(),
                    "starred":row["starred"].as_bool(),"pending":row["pending"].as_bool()}));
            }
        }
        let settings = db.settings()?;
        let checkpoint = &settings["mailReconcile"][OWNER];
        let folder = &checkpoint["folders"]["INBOX"];
        Ok(json!({"totalMessages":total,"enabled":enabled,"completedRounds":rounds,"roundLimit":limit,
            "remaining":remaining,"rotationAfter":checkpoint["after"].as_u64(),
            "pendingCount":folder["pending"].as_array().map(Vec::len),
            "scanAfter":folder["scan"]["after"].as_u64(),"scanUpper":folder["scan"]["upper"].as_u64(),
            "scanSince":folder["scan"]["since"].as_u64(),"scanTarget":folder["scan"]["target"].as_u64(),
            "committedModseq":folder["modseq"].as_u64()}))
    }).await.unwrap()
}

fn record_flag_failure(detail: Value) {
    // Fixed fields from the fictional fixture only; never serialize messages,
    // settings, connections, provider responses or credentials into evidence.
    let report = json!({"schema":1,"kind":"morrow-imap-acceptance-failure",
        "status":"failed","phase":"flag-convergence","detail":detail});
    eprintln!("mailbox_acceptance_failure {report}");
    if let Some(output) = std::env::var_os("MORROW_ACCEPTANCE_OUTPUT") {
        let path = std::path::PathBuf::from(output).with_extension("failure.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&report).unwrap())
            .unwrap();
        file.write_all(b"\n").unwrap();
        file.sync_all().unwrap();
    }
}

async fn converge_flags(
    fixture: &ImapFixture,
    cache: &CacheWorkspace,
    total: u32,
    changed: &[u32],
    enabled: bool,
) -> Value {
    fixture.update(|state| {
        state.remote_read = enabled;
        state.remote_starred = enabled;
        state.changed_uids = Some(changed.to_vec());
        state.highest_modseq = Some(if enabled { 11 } else { 12 });
    });
    let started = Instant::now();
    let before = fixture.commands().len();
    let before_bodies = body_requests(fixture);
    // Round each discovery window separately: unused slots cannot carry into
    // the next window. This is a correctness bound, not a performance target.
    let limit = flag_round_limit(total);
    for round in 1..=limit {
        changed_sync(fixture, cache).await.unwrap();
        let ids = changed.to_vec();
        let ready = cache
            .app()
            .db(move |db| {
                for uid in ids {
                    let row = db.get(OWNER, &format!("imap:55:{uid}"))?.unwrap();
                    if row["read"] != enabled || row["starred"] != enabled {
                        return Ok(false);
                    }
                    assert_eq!(
                        row["providerSnapshot"],
                        json!({"read":enabled,"starred":enabled})
                    );
                    assert_eq!(string(&row, "body").trim(), expected_body(uid));
                    assert_eq!(row["pending"], true);
                }
                Ok(true)
            })
            .await
            .unwrap();
        if ready {
            assert_eq!(body_requests(fixture), before_bodies);
            return json!({"enabled":enabled,"changedMessages":changed.len(),"convergedMessages":changed.len(),
                "rounds":round,"roundLimit":limit,"wallMs":started.elapsed().as_secs_f64()*1000.0,
                "commands":fixture.commands().len()-before,"bodyFetches":0});
        }
    }
    record_flag_failure(flag_failure_snapshot(cache, total, changed, enabled, limit, limit).await);
    panic!("Flags did not converge within the bounded whole-cache rotation");
}

#[test]
fn flag_round_bound_includes_each_discovery_window_and_arrival_tail() {
    for (total, expected) in [
        (49, 17),
        (50, 18),
        (999, 37),
        (1000, 37),
        (1001, 38),
        (1049, 38),
        (1050, 39),
        (1999, 58),
        (2000, 58),
        (2001, 59),
        (240, 21),
        (1120, 40),
        (10_120, 229),
        (50_000, 1066),
        (50_120, 1069),
    ] {
        assert_eq!(flag_round_limit(total), expected, "total={total}");
    }
    // The original global rounding stops before the conservative per-window
    // queue work, even without the unchanged startup/scope allowance.
    assert!(50_120_u32.div_ceil(49) + 16 < flag_round_limit(50_120) - 16);
}

#[tokio::test]
async fn flag_failure_snapshot_reports_owned_differences_without_mail_or_secrets() {
    let cache = CacheWorkspace::new(&json!({"provider":"imap","email":OWNER,
        "password":"fictional-password-not-for-evidence","imapHost":"127.0.0.1"}))
    .await;
    cache.app().db(|db| {
        db.upsert(OWNER, &json!({"id":"imap:55:1","read":true,"starred":true,"pending":true,
            "body":"fictional-body-not-for-evidence"}))?;
        db.upsert(OWNER, &json!({"id":"imap:55:2","read":false,"starred":true,"pending":false}))?;
        db.upsert(OTHER, &json!({"id":"imap:55:3","read":true,"starred":true}))?;
        let mut settings = db.settings()?;
        settings["mailReconcile"] = json!({OWNER:{"after":9,"connection":{"password":"private-connection-marker"},
            "folders":{"INBOX":{"modseq":10,"pending":[1000,1001],
                "scan":{"after":1000,"upper":50_120,"since":10,"target":11}}}}});
        db.set_settings(&settings)
    }).await.unwrap();
    let result = flag_failure_snapshot(&cache, 50_120, &[1, 2, 3], true, 1039, 1069).await;
    assert_eq!(
        result["remaining"],
        json!([
            {"uid":2,"read":false,"starred":true,"pending":false},
            {"uid":3,"missing":true}
        ])
    );
    assert_eq!(result["completedRounds"], 1039);
    assert_eq!(result["roundLimit"], 1069);
    assert_eq!(result["pendingCount"], 2);
    assert_eq!(result["scanAfter"], 1000);
    assert_eq!(result["scanUpper"], 50_120);
    assert_eq!(result["rotationAfter"], 9);
    let text = result.to_string();
    for excluded in [
        "fictional-password-not-for-evidence",
        "fictional-body-not-for-evidence",
        "private-connection-marker",
    ] {
        assert!(!text.contains(excluded));
    }
}

async fn run_dataset(size: u32) -> Value {
    assert!(size >= 120);
    let mut fixture = ImapFixture::new(ImapScenario {
        count: size,
        sent: false,
        acceptance_body: true,
        internal_date: "01-Jan-2020 12:00:00 +0000",
        capabilities: "IMAP4rev1 CONDSTORE",
        highest_modseq: Some(10),
        remote_read: false,
        remote_starred: false,
        ..Default::default()
    })
    .await;
    // A new reviewed history import requires a known authorization generation;
    // the shared low-level transport fixture intentionally does not supply one.
    fixture.mail["connectionId"] = json!("acceptance-initial-generation");
    let mut cache = CacheWorkspace::new(&fixture.mail).await;
    cache.app().db(|db| {
        // This single foreign sentinel is not part of the downloaded dataset.
        // It deliberately collides with a real provider UID to detect routing.
        db.upsert(OTHER, &json!({"id":"imap:55:1","folder":"inbox","body":"foreign sentinel","read":false,"starred":false}))?;
        background::start_import(db, OWNER, &json!({"months":0,"inbox":true,"sent":false}))
    }).await.unwrap();
    assert_eq!(
        count(&cache, OWNER).await,
        0,
        "Never seed the measured mailbox"
    );
    let started = Instant::now();
    let mut interrupted = false;
    let mut pages = 0_u32;
    while cache.app().settings().await.unwrap()["imports"][OWNER]["status"] == "running" {
        assert!(pages < size.div_ceil(50) + 4);
        let page = history_page(&fixture, &cache).await;
        assert!(page["messages"].as_array().unwrap().len() <= 50);
        pages += 1;
        if !interrupted && count(&cache, OWNER).await >= 50 {
            let saved = cache.app().settings().await.unwrap()["imports"][OWNER].clone();
            let before_count = count(&cache, OWNER).await;
            fixture.update(|state| state.disconnect_on_body = true);
            let error = imap::fetch_page_cached_with_tls(
                cache.app(),
                &fixture.mail,
                &history_options(&saved),
                &fixture.connector,
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, 502);
            assert_eq!(
                cache.app().settings().await.unwrap()["imports"][OWNER],
                saved
            );
            assert_eq!(count(&cache, OWNER).await, before_count);
            fixture.update(|state| state.disconnect_on_body = false);
            restart(&mut cache).await;
            assert_eq!(
                cache.app().settings().await.unwrap()["imports"][OWNER],
                saved
            );
            interrupted = true;
        }
        if pages.is_multiple_of(100) {
            eprintln!("mailbox_acceptance_progress size={size} history_pages={pages}");
        }
    }
    assert!(interrupted);
    let history_job = cache.app().settings().await.unwrap()["imports"][OWNER].clone();
    assert_eq!(history_job["status"], "complete");
    assert_eq!(history_job["imported"], size);
    assert_eq!(history_job["processed"], size);
    let full = verify_downloads(&cache, size).await;
    let history_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Bootstrap the incremental read from the now fully downloaded cache.
    // These calls exercise production fetch and merge, not the private service
    // scheduler/commit_sync_page; history durability above uses its real API.
    let initial = imap::fetch_page_cached_with_tls(
        cache.app(),
        &fixture.mail,
        &json!({"folder":"inbox","incremental":true}),
        &fixture.connector,
    )
    .await
    .unwrap();
    let mut checkpoint = initial["syncCheckpoint"].clone();
    let before_burst = body_requests(&fixture);
    let started = Instant::now();
    fixture.update(|state| state.count = size + BURST);
    let mut seen = BTreeSet::new();
    let mut burst_pages = 0;
    loop {
        let page = imap::fetch_page_cached_with_tls(
            cache.app(),
            &fixture.mail,
            &json!({"folder":"inbox","incremental":true,"syncCheckpoints":{"INBOX":checkpoint}}),
            &fixture.connector,
        )
        .await
        .unwrap();
        let messages = page["messages"].as_array().unwrap().clone();
        assert!(messages.len() <= 50);
        for message in &messages {
            assert!(seen.insert(string(message, "id").to_owned()));
        }
        let connection = fixture.mail.clone();
        cache
            .app()
            .db(move |db| morrow_search::mail::import_messages(db, &connection, &messages))
            .await
            .unwrap();
        checkpoint = page["syncCheckpoint"].clone();
        burst_pages += 1;
        if checkpoint["more"] != true {
            break;
        }
        assert!(burst_pages < 4);
    }
    assert_eq!(
        seen,
        ((size + 1)..=(size + BURST))
            .map(|uid| format!("imap:55:{uid}"))
            .collect()
    );
    assert_eq!(checkpoint["uid"], size + BURST);
    assert_eq!(body_requests(&fixture) - before_burst, BURST as usize);
    let after_burst = verify_downloads(&cache, size + BURST).await;
    let burst_ms = started.elapsed().as_secs_f64() * 1000.0;
    let changed = vec![1, size / 2, size, size + BURST];
    let saved_changed = changed.clone();
    cache
        .app()
        .db(move |db| {
            for uid in saved_changed {
                db.update(OWNER, &format!("imap:55:{uid}"), &json!({"pending":true}))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let flags_on = converge_flags(&fixture, &cache, size + BURST, &changed, true).await;
    let flags_off = converge_flags(&fixture, &cache, size + BURST, &changed, false).await;

    // A new authorization invalidates an in-flight history page. The same
    // server/owner keeps cached rows; a reviewed new import obtains fresh proof.
    cache
        .app()
        .db(|db| {
            background::start_import(db, OWNER, &json!({"months":0,"inbox":true,"sent":false}))
        })
        .await
        .unwrap();
    history_page(&fixture, &cache).await; // Empty recent pass, into older history.
    let job = cache.app().settings().await.unwrap()["imports"][OWNER].clone();
    let page = imap::fetch_page_cached_with_tls(
        cache.app(),
        &fixture.mail,
        &history_options(&job),
        &fixture.connector,
    )
    .await
    .unwrap();
    cache.app().db(|db| {
        let mut settings = db.settings()?;
        settings["mailAccounts"][OWNER]["connectionId"] = json!("acceptance-reconnected");
        db.set_settings(&settings)?;
        db.conn.execute_batch("CREATE TEMP TABLE acceptance_writes(n INTEGER); INSERT INTO acceptance_writes VALUES(0); CREATE TEMP TRIGGER acceptance_update AFTER UPDATE ON messages BEGIN UPDATE acceptance_writes SET n=n+1; END;")?;
        Ok(())
    }).await.unwrap();
    let stale = job.clone();
    cache
        .app()
        .db(move |db| {
            background::apply_import_page(db, OWNER, &stale, &page)?;
            let writes: i64 = db
                .conn
                .query_row("SELECT n FROM acceptance_writes", [], |row| row.get(0))?;
            assert_eq!(writes, 0);
            assert_eq!(db.settings()?["imports"][OWNER], stale);
            assert!(background::control_import(db, OWNER, "resume").is_err());
            background::start_import(db, OWNER, &json!({"months":0,"inbox":true,"sent":false}))
        })
        .await
        .unwrap();
    history_page(&fixture, &cache).await;
    history_page(&fixture, &cache).await;
    assert_eq!(count(&cache, OWNER).await, u64::from(size + BURST));
    assert_eq!(
        cache.app().settings().await.unwrap()["imports"][OWNER]["imported"],
        0
    );
    restart(&mut cache).await;
    assert_eq!(
        cache.app().settings().await.unwrap()["mailAccounts"][OWNER]["connectionId"],
        "acceptance-reconnected"
    );
    verify_downloads(&cache, size + BURST).await;
    cache
        .app()
        .db(|db| {
            let sentinel = db.get(OTHER, "imap:55:1")?.unwrap();
            assert_eq!(sentinel["body"], "foreign sentinel");
            assert_eq!(sentinel["read"], false);
            assert_eq!(sentinel["starred"], false);
            let settings = db.settings()?;
            assert!(
                settings["deliveryAttempts"].is_null()
                    || settings["deliveryAttempts"]
                        .as_object()
                        .is_some_and(|v| v.is_empty())
            );
            Ok(())
        })
        .await
        .unwrap();
    let commands = fixture.commands();
    assert!(commands.iter().all(|command| {
        ![
            "UID STORE ",
            "UID MOVE ",
            "UID COPY ",
            "EXPUNGE",
            "APPEND ",
            "CREATE ",
            "DELETE ",
            "RENAME ",
        ]
        .iter()
        .any(|prefix| command.to_ascii_uppercase().starts_with(prefix))
    }));
    assert!(fixture.failures.lock().unwrap().is_empty());
    json!({"size":size,"initialOwnerRows":0,"seededOwnerRows":0,"transport":"generated-trusted-loopback-tls",
        "transportOptions":{"fixtureServerTcpNoDelay":true,"productionTransportUnchanged":true},
        "download":full,"history":{"status":"complete","pages":pages,"wallMs":history_ms,"disconnectPreservedCheckpoint":true,"restartPreservedCheckpoint":true},
        "newMail":{"expected":BURST,"observed":seen.len(),"pages":burst_pages,"bodyFetches":BURST,"wallMs":burst_ms,"after":after_burst},
        "flags":[flags_on,flags_off],"reconnect":{"stalePageWrites":0,"manualNewImportRequired":true,"sameOriginCachedRowsRetained":true,"restartRetainedConnection":true},
        "ownerIsolation":true,"providerWrites":0,"commands":commands.len(),"bodyFetchAttempts":body_requests(&fixture)})
}

#[tokio::test]
async fn controlled_acceptance_contract() {
    let result = run_dataset(120).await;
    assert_eq!(result["size"], 120);
    assert_eq!(result["download"]["downloadedMessages"], 120);
}

#[tokio::test]
#[ignore = "Explicit full-download 1k/10k/50k acceptance; isolated TLS and fresh stores"]
async fn controlled_large_mailbox_acceptance() {
    let size = std::env::var("MORROW_ACCEPTANCE_SIZE")
        .expect("Set MORROW_ACCEPTANCE_SIZE to 1000, 10000, or 50000")
        .parse::<u32>()
        .unwrap();
    assert!([1000, 10_000, 50_000].contains(&size));
    let output = std::env::var_os("MORROW_ACCEPTANCE_OUTPUT")
        .expect("Set a new MORROW_ACCEPTANCE_OUTPUT report path");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap();
    let result = run_dataset(size).await;
    let report = json!({"schema":1,"kind":"morrow-imap-acceptance","status":"complete","platform":std::env::consts::OS,
        "measuredAt":chrono::Utc::now().to_rfc3339(),"dataset":"imap-acceptance-v1","result":result,
        "scope":"Production TLS fetch, import-page transaction, incremental merge and bounded reconciliation. One owner, INBOX, 1024 ASCII filler plus unique UID bodies; no seeded target rows. Excludes scheduler cadence/backoff, WAN/provider acceptance, attachment download, native UI and process resource measurements."});
    file.write_all(&serde_json::to_vec_pretty(&report).unwrap())
        .unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
}
