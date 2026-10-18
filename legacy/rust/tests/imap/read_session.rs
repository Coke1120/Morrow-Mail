//! Real TLS loopback wire tests for the production reconciliation entry point.
use super::*;
use std::sync::atomic::Ordering;

fn login_count(commands: &[String]) -> usize {
    commands
        .iter()
        .filter(|command| command.starts_with("LOGIN "))
        .count()
}
fn assert_read_only(commands: &[String]) {
    assert!(
        commands.iter().all(|command| {
            ![
                "SELECT ",
                "UID STORE ",
                "UID COPY ",
                "UID MOVE ",
                "EXPUNGE",
                "UID EXPUNGE",
                "IDLE",
            ]
            .iter()
            .any(|write| command.starts_with(write))
        }),
        "Read reconciliation issued a write or entered unowned IDLE"
    );
}
async fn closed(fixture: &ImapFixture) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.active_sessions.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The completed/cancelled round retained its TLS session");
}
async fn prepared() -> (ImapFixture, CacheWorkspace) {
    let fixture = ImapFixture::new(ImapScenario {
        capabilities: "IMAP4rev1 CONDSTORE IDLE",
        count: 4,
        highest_modseq: Some(11),
        ..Default::default()
    })
    .await;
    let cache = CacheWorkspace::new(&fixture.mail).await;
    seed_changed_cache(&fixture, &cache, 4, 10).await;
    closed(&fixture).await;
    fixture.log.lock().unwrap().clear();
    (fixture, cache)
}
async fn unchanged(cache: &CacheWorkspace, checkpoint: &Value) {
    assert_eq!(
        cache.app().settings().await.unwrap()["mailReconcile"][OWNER],
        *checkpoint
    );
    let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert!(
        rows.iter()
            .all(|row| row["read"] == false && row["body"] == "Owned synthetic body")
    );
}

#[tokio::test]
async fn read_round_uses_one_actual_login_for_discovery_and_flags_without_cross_tick_pooling() {
    let (fixture, cache) = prepared().await;
    for round in 0..2 {
        fixture.log.lock().unwrap().clear();
        let (result, profile) =
            morrow_search::sync_profile::capture(changed_sync(&fixture, &cache)).await;
        result.unwrap();
        closed(&fixture).await;
        let commands = fixture.commands();
        assert_eq!(
            login_count(&commands),
            1,
            "One production round must use one authenticated connection"
        );
        assert_eq!(commands.iter().filter(|line| *line == "LOGOUT").count(), 1);
        assert_eq!(
            commands
                .iter()
                .filter(|line| line.starts_with("EXAMINE "))
                .count(),
            2,
            "Reusing the socket must still revalidate selection and UIDVALIDITY"
        );
        if round == 0 {
            assert!(commands.iter().any(|line| line.contains("UID FLAGS")));
        }
        assert_eq!(profile["counters"]["imapConnections"], 1);
        assert_eq!(profile["counters"]["imapSessionReuses"], 1);
        assert_read_only(&commands);
    }
    let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert!(
        rows.iter()
            .all(|row| row["read"] == true && row["pending"] == true)
    );
}

#[tokio::test]
async fn read_rounds_keep_same_provider_ids_separate_across_two_owners_in_one_workspace() {
    const OTHER: &str = "second@example.invalid";
    let first = ImapFixture::new(ImapScenario {
        count: 1,
        remote_read: false,
        ..Default::default()
    })
    .await;
    let mut second = ImapFixture::new(ImapScenario {
        count: 1,
        remote_read: false,
        ..Default::default()
    })
    .await;
    second.mail["email"] = OTHER.into();
    let cache = CacheWorkspace::new(&first.mail).await;
    let other = second.mail.clone();
    cache
        .app()
        .db(move |db| {
            let mut config = db.settings()?;
            config["mailAccounts"][OTHER] = other;
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    for fixture in [&first, &second] {
        let page = fixture.fetch(json!({"folder":"inbox"})).await.unwrap();
        let mail = fixture.mail.clone();
        let rows = page["messages"].as_array().unwrap().clone();
        cache
            .app()
            .db(move |db| morrow_search::mail::import_messages(db, &mail, &rows))
            .await
            .unwrap();
        closed(fixture).await;
        fixture.log.lock().unwrap().clear();
        fixture.update(|s| s.remote_read = true);
    }
    changed_sync(&first, &cache).await.unwrap();
    assert!(
        cache
            .app()
            .db(|db| db.list(OWNER))
            .await
            .unwrap()
            .iter()
            .all(|row| row["read"] == true)
    );
    assert!(
        cache
            .app()
            .db(|db| db.list(OTHER))
            .await
            .unwrap()
            .iter()
            .all(|row| row["read"] == false)
    );
    morrow_search::reconcile::sync_with_tls(
        cache.app(),
        &second.mail,
        &mut Default::default(),
        &second.connector,
    )
    .await
    .unwrap();
    for fixture in [&first, &second] {
        closed(fixture).await;
        assert_eq!(login_count(&fixture.commands()), 1);
        assert_read_only(&fixture.commands());
    }
    assert!(
        cache
            .app()
            .db(|db| db.list(OTHER))
            .await
            .unwrap()
            .iter()
            .all(|row| row["read"] == true)
    );
}

#[tokio::test]
async fn read_round_rejects_replaced_credentials_and_disconnection_before_reusing_the_socket() {
    for mode in ["password", "connection", "disconnect"] {
        let (fixture, cache) = prepared().await;
        let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        fixture.update(|s| s.pause_discovery = Some((entered.clone(), resume.clone())));
        let (app, mail, tls) = (
            cache.app().clone(),
            fixture.mail.clone(),
            fixture.connector.clone(),
        );
        let task = tokio::spawn(async move {
            morrow_search::reconcile::sync_with_tls(&app, &mail, &mut Default::default(), &tls)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        cache
            .app()
            .db(move |db| {
                let mut config = db.settings()?;
                match mode {
                    "password" => {
                        config["mailAccounts"][OWNER]["password"] =
                            "rotated-fictional-password".into()
                    }
                    "connection" => {
                        config["mailAccounts"][OWNER]["connectionId"] = "replacement".into()
                    }
                    _ => {
                        config["mailAccounts"]
                            .as_object_mut()
                            .unwrap()
                            .remove(OWNER);
                    }
                }
                db.set_settings(&config)?;
                Ok(())
            })
            .await
            .unwrap();
        resume.notify_one();
        assert_eq!(task.await.unwrap().unwrap_err().status, 409, "{mode}");
        closed(&fixture).await;
        let commands = fixture.commands();
        assert_eq!(login_count(&commands), 1);
        assert_eq!(
            commands.iter().filter(|line| *line == "CAPABILITY").count(),
            1,
            "Changed credentials must be rejected before the second phase's first command"
        );
        assert!(!commands.iter().any(|line| line.contains("UID FLAGS")));
        assert_read_only(&commands);
        unchanged(&cache, &checkpoint).await;
    }
}

#[tokio::test]
async fn dropping_either_read_phase_discards_the_connection_and_preserves_the_checkpoint() {
    for discovery in [true, false] {
        let (fixture, cache) = prepared().await;
        let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        fixture.update(|s| {
            let pause = Some((entered.clone(), resume.clone()));
            if discovery {
                s.pause_discovery = pause;
            } else {
                s.pause_flags = pause;
            }
        });
        let (app, mail, tls) = (
            cache.app().clone(),
            fixture.mail.clone(),
            fixture.connector.clone(),
        );
        let task = tokio::spawn(async move {
            morrow_search::reconcile::sync_with_tls(&app, &mail, &mut Default::default(), &tls)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        fixture.update(|s| {
            s.pause_discovery = None;
            s.pause_flags = None;
        });
        resume.notify_one();
        closed(&fixture).await;
        unchanged(&cache, &checkpoint).await;
        assert_eq!(login_count(&fixture.commands()), 1);
        assert!(
            !fixture.commands().iter().any(|line| line == "LOGOUT"),
            "Do not write another command into an unfinished response"
        );
        assert_read_only(&fixture.commands());
        fixture.log.lock().unwrap().clear();
        changed_sync(&fixture, &cache).await.unwrap();
        closed(&fixture).await;
        assert_eq!(
            login_count(&fixture.commands()),
            1,
            "A later explicit round must open a fresh session"
        );
    }
}

#[tokio::test]
async fn partial_and_failed_reads_are_not_replayed_or_committed() {
    for mode in ["partial", "invalid-uid", "flags-rejected"] {
        let (fixture, cache) = prepared().await;
        let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
        fixture.update(|s| match mode {
            "partial" => s.truncate_discovery = true,
            "invalid-uid" => s.wrong_uid = true,
            _ => s.fetch_failure = true,
        });
        assert!(changed_sync(&fixture, &cache).await.is_err(), "{mode}");
        closed(&fixture).await;
        assert_eq!(
            login_count(&fixture.commands()),
            1,
            "{mode} must not reconnect/replay inside this round"
        );
        assert!(!fixture.commands().iter().any(|line| line == "LOGOUT"));
        assert_read_only(&fixture.commands());
        unchanged(&cache, &checkpoint).await;
    }
}

#[tokio::test]
async fn reused_session_rechecks_capabilities_and_uidvalidity_before_applying_flags() {
    for generation in [false, true] {
        let (fixture, cache) = prepared().await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        fixture.update(|s| s.pause_discovery = Some((entered.clone(), resume.clone())));
        let (app, mail, tls) = (
            cache.app().clone(),
            fixture.mail.clone(),
            fixture.connector.clone(),
        );
        let task = tokio::spawn(async move {
            morrow_search::reconcile::sync_with_tls(&app, &mail, &mut Default::default(), &tls)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        fixture.update(|s| {
            s.pause_discovery = None;
            if generation {
                s.validity = 99;
            } else {
                s.capabilities = "IMAP4rev1";
                s.highest_modseq = None;
            }
        });
        resume.notify_one();
        task.await.unwrap().unwrap();
        closed(&fixture).await;
        assert_eq!(login_count(&fixture.commands()), 1);
        let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
        assert!(rows.iter().all(|row| row["body"] == "Owned synthetic body"));
        if generation {
            assert!(
                rows.iter()
                    .all(|row| row["providerFolderMissing"] == true && row["read"] == false)
            );
            assert!(
                !fixture
                    .commands()
                    .iter()
                    .any(|line| line.contains("UID FLAGS"))
            );
        } else {
            assert!(rows.iter().all(|row| row["read"] == true));
            assert!(cache.app().settings().await.unwrap()["mailReconcile"][OWNER]["folders"]["INBOX"]["modseq"].is_null());
        }
    }
}

#[tokio::test]
async fn unsupported_move_capabilities_never_attempt_copy_store_expunge_or_replay() {
    let fixture = ImapFixture::new(ImapScenario::default()).await;
    let destination = json!({"id":"Archive","name":"Archive","kind":"folder"});
    for caps in [
        "IMAP4rev1",
        "IMAP4rev1 IDLE",
        "IMAP4rev1 UIDPLUS",
        "IMAP4rev1 MOVE",
        "IMAP4rev1 XMOVE UIDPLUS",
    ] {
        fixture.update(|s| s.capabilities = caps);
        fixture.log.lock().unwrap().clear();
        let error = fixture.organize(destination.clone()).await.unwrap_err();
        closed(&fixture).await;
        assert_eq!(error.status, 409);
        assert_eq!(error.body["code"], "imap_move_unsupported");
        assert!(error.to_string().contains("No move was attempted"));
        let commands = fixture.commands();
        assert_eq!(login_count(&commands), 1);
        assert_eq!(
            commands.iter().filter(|line| *line == "CAPABILITY").count(),
            1
        );
        assert_read_only(&commands);
    }
    fixture.update(|s| s.capabilities = "IMAP4rev1 mOvE uIdPlUs");
    fixture.log.lock().unwrap().clear();
    fixture.organize(destination.clone()).await.unwrap();
    closed(&fixture).await;
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|line| line.starts_with("UID MOVE "))
            .count(),
        1,
        "RFC capability atoms are case-insensitive, while lookalike atoms are not support"
    );
    fixture.update(|s| s.mapping = None);
    fixture.log.lock().unwrap().clear();
    assert!(fixture.organize(destination).await.is_err());
    closed(&fixture).await;
    assert_eq!(login_count(&fixture.commands()), 1);
    assert_eq!(
        fixture
            .commands()
            .iter()
            .filter(|line| line.starts_with("UID MOVE "))
            .count(),
        1
    );
    assert!(!fixture.commands().iter().any(|line| {
        ["UID COPY ", "UID STORE ", "EXPUNGE", "UID EXPUNGE"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    }));
}

#[tokio::test]
async fn stalled_read_uses_the_real_45_second_phase_deadline_without_reconnecting() {
    let (fixture, cache) = prepared().await;
    let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    fixture.update(|s| s.pause_discovery = Some((entered.clone(), resume.clone())));
    let start = std::time::Instant::now();
    let result =
        tokio::time::timeout(Duration::from_secs(55), changed_sync(&fixture, &cache)).await;
    fixture.update(|s| s.pause_discovery = None);
    resume.notify_one();
    closed(&fixture).await;
    let error = result
        .expect("The production phase deadline did not stop the read")
        .unwrap_err();
    assert!(
        start.elapsed() >= Duration::from_secs(44),
        "This fixture must exercise the real production timer"
    );
    assert_eq!(error.body["code"], "provider_network");
    assert_eq!(login_count(&fixture.commands()), 1);
    assert!(!fixture.commands().iter().any(|line| line == "LOGOUT"));
    unchanged(&cache, &checkpoint).await;
}

#[tokio::test]
async fn obsolete_connection_is_rejected_before_the_first_login() {
    let (fixture, cache) = prepared().await;
    let checkpoint = cache.app().settings().await.unwrap()["mailReconcile"][OWNER].clone();
    cache
        .app()
        .db(|db| {
            let mut config = db.settings()?;
            config["mailAccounts"][OWNER]["password"] = "changed-before-read".into();
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        changed_sync(&fixture, &cache).await.unwrap_err().status,
        409
    );
    assert!(fixture.commands().is_empty());
    assert_eq!(fixture.active_sessions.load(Ordering::SeqCst), 0);
    unchanged(&cache, &checkpoint).await;
}

#[tokio::test]
async fn a_rejected_discovery_session_is_discarded_before_separate_missing_folder_verification() {
    let (fixture, cache) = prepared().await;
    cache
        .app()
        .db(|db| {
            for row in db.list(OWNER)? {
                db.update(
                    OWNER,
                    string(&row, "id"),
                    &json!({"providerFolderId":"A-removed"}),
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    fixture.update(|s| {
        s.capabilities = "IMAP4rev1";
        s.examine_failure = Some(("A-removed", "NO [NONEXISTENT] Gone"));
    });
    changed_sync(&fixture, &cache).await.unwrap();
    closed(&fixture).await;
    let commands = fixture.commands();
    assert_eq!(
        login_count(&commands),
        2,
        "The existing authoritative LIST fallback must not reuse the failed discovery socket"
    );
    assert_eq!(
        commands
            .iter()
            .filter(|line| line.starts_with("LIST "))
            .count(),
        1
    );
    assert_eq!(commands.iter().filter(|line| *line == "LOGOUT").count(), 1);
    assert!(!commands.iter().any(|line| line.starts_with("UID FETCH")));
    assert_read_only(&commands);
    let rows = cache.app().db(|db| db.list(OWNER)).await.unwrap();
    assert!(rows.iter().all(|row| row["providerFolderMissing"] == true
        && row["body"] == "Owned synthetic body"
        && row["read"] == false));
}
