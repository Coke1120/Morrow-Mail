use super::*;

fn selected_key(owner: &str, path: &str) -> ScopeKey {
    (owner.into(), path.into())
}

fn seed_selected(db: &Store, mail: &Value, paths: &[&str], inbox: bool) -> Result<()> {
    let owner = string(mail, "email");
    let mut config = db.settings()?;
    for group in [
        "mailAccounts",
        "preferences",
        "mailFolderCatalogs",
        "imports",
    ] {
        if !config[group].is_object() {
            config[group] = json!({});
        }
    }
    config["mailAccounts"][owner] = mail.clone();
    config["preferences"]["syncInterval"] = 30.into();
    let folders = std::iter::once("Projects".into())
        .chain((0..20).map(|n| format!("F{n:02}")))
        .map(|path: String| json!({"id":path,"name":path,"kind":"archive","delimiter":"/","selectable":true,"editable":true}))
        .collect::<Vec<_>>();
    config["mailFolderCatalogs"][owner] = json!({"connection":crate::folders::connection_version(mail),"updatedAt":crate::store::now(),"folders":folders});
    if inbox {
        config["imports"].as_object_mut().unwrap().remove(owner);
    } else {
        config["imports"][owner] =
            json!({"connectionId":mail["connectionId"],"options":{"sent":true}});
    }
    db.set_settings(&config)?;
    let status = crate::imap_folder_sync::status(&db.settings()?, owner);
    crate::imap_folder_sync::select(
        db,
        owner,
        &json!({"folderIds":paths,
        "selectionVersion":status["selectionVersion"],"connectionVersion":status["connectionVersion"]}),
    )?;
    let mut config = db.settings()?;
    for entry in config["imapFolderSync"][owner]["folders"]
        .as_array_mut()
        .unwrap()
    {
        entry["checkpoint"] = json!({"path":entry["path"],"validity":"77","uid":0,
            "connection":crate::folders::connection_version(mail),"more":false});
        entry["lastSuccessfulSyncAt"] = crate::store::now().into();
    }
    db.set_settings(&config)?;
    Ok(())
}

async fn selected_setup(app: &App, mail: Value, paths: &[&str], inbox: bool) {
    let paths = paths
        .iter()
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    app.db(move |db| {
        seed_selected(
            db,
            &mail,
            &paths.iter().map(String::as_str).collect::<Vec<_>>(),
            inbox,
        )
    })
    .await
    .unwrap();
}

async fn scope(app: &App, owner: &str, path: &str) -> Scope {
    let key = selected_key(owner, path);
    app.db(move |db| Ok(db.idle_settings.0.borrow().scopes[&key].clone()))
        .await
        .unwrap()
}

fn owner_logins(fixture: &Fixture, owner: &str) -> usize {
    fixture
        .state
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(actual, command, _)| actual == owner && command == "LOGIN")
        .count()
}

fn examined(fixture: &Fixture, owner: &str) -> std::collections::BTreeSet<String> {
    fixture
        .state
        .examinations
        .lock()
        .unwrap()
        .iter()
        .filter(|(actual, _)| actual == owner)
        .map(|(_, path)| path.clone())
        .collect()
}

fn completed(fixture: &Fixture, owner: &str) -> std::collections::BTreeSet<String> {
    fixture
        .state
        .completed_leases
        .lock()
        .unwrap()
        .iter()
        .filter(|(actual, _)| actual == owner)
        .map(|(_, path)| path.clone())
        .collect()
}

#[tokio::test]
async fn selected_identity_survives_progress_and_eligibility_changes_but_not_review_or_validity() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, root) = workspace();
    selected_setup(&app, fixture.mail(OWNER), &["Projects"], true).await;
    let original = scope(&app, OWNER, "Projects").await;
    assert_eq!(original.validity, Some(77));
    assert!(still_current(&app, &original).await);
    app.db(|db| {
        let mut config = db.settings()?;
        let entry = &mut config["imapFolderSync"][OWNER]["folders"][0];
        entry["checkpoint"]["uid"] = 100.into();
        entry["lastAttemptAt"] = crate::store::now().into();
        entry["lastSuccessfulSyncAt"] = crate::store::now().into();
        config["mailFolderCatalogs"][OWNER]["updatedAt"] = crate::store::now().into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        scope(&app, OWNER, "Projects").await.generation,
        original.generation
    );
    app.db(|db| {
        let mut config = db.settings()?;
        config["imapFolderSync"][OWNER]["folders"][0]["nextRetryAt"] =
            "2099-01-01T00:00:00.000Z".into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        scope(&app, OWNER, "Projects").await.generation,
        original.generation
    );
    assert!(!still_current(&app, &original).await);
    app.db(|db| {
        let mut config = db.settings()?;
        config["imapFolderSync"][OWNER]["folders"][0]["nextRetryAt"] = Value::Null;
        config["mailFolderCatalogs"][OWNER]["updatedAt"] = "2000-01-01T00:00:00.000Z".into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        scope(&app, OWNER, "Projects").await.generation,
        original.generation
    );
    assert!(!still_current(&app, &original).await);
    app.db(|db| {
        let mut config = db.settings()?;
        config["mailFolderCatalogs"][OWNER]["updatedAt"] = crate::store::now().into();
        config["imapFolderSync"][OWNER]["folders"][0]["checkpoint"]["validity"] = "78".into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    let changed = scope(&app, OWNER, "Projects").await;
    assert_ne!(changed.generation, original.generation);
    assert_eq!(changed.owner_generation, original.owner_generation);
    assert!(!still_current(&app, &original).await);
    app.db(|db| review(db, OWNER, &["Projects"])).await.unwrap();
    let reviewed = scope(&app, OWNER, "Projects").await;
    assert_ne!(reviewed.generation, changed.generation);
    assert_eq!(reviewed.owner_generation, original.owner_generation);
    assert_eq!(reviewed.validity, Some(78));
    assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn selected_idle_requires_live_selectable_custom_path_and_matching_known_validity() {
    for change in [
        "valid",
        "missing",
        "noselect",
        "protected",
        "validity",
        "unsafe",
    ] {
        let fixture = Fixture::new(Mode::Changed).await;
        match change {
            "missing" => {
                fixture.state.folders.lock().unwrap().remove("Projects");
            }
            "noselect" => {
                fixture
                    .state
                    .folders
                    .lock()
                    .unwrap()
                    .get_mut("Projects")
                    .unwrap()
                    .1 = "\\Noselect".into();
            }
            "protected" => {
                fixture
                    .state
                    .folders
                    .lock()
                    .unwrap()
                    .get_mut("Projects")
                    .unwrap()
                    .1 = "\\Junk".into();
            }
            "validity" => {
                fixture
                    .state
                    .folders
                    .lock()
                    .unwrap()
                    .get_mut("Projects")
                    .unwrap()
                    .0 = 78;
            }
            _ => {}
        }
        let path = if change == "unsafe" {
            "Projects\r\nIDLE"
        } else {
            "Projects"
        };
        let result = crate::imap::idle_selected_folder_with_tls(
            &fixture.mail(OWNER),
            path,
            77,
            &fixture.connector,
            Duration::from_secs(2),
        )
        .await;
        if change == "valid" {
            assert_eq!(result.unwrap(), IdleOutcome::Changed);
            assert_eq!(fixture.count("LIST"), 1);
            assert_eq!(
                examined(&fixture, OWNER),
                ["Projects".into()].into_iter().collect()
            );
            assert_eq!(fixture.count("IDLE"), 1);
        } else {
            assert!(result.is_err());
            assert_eq!(fixture.count("IDLE"), 0);
            assert_eq!(fixture.count("EXAMINE"), usize::from(change == "validity"));
            if change == "unsafe" {
                assert_eq!(fixture.state.connections.load(Ordering::SeqCst), 0);
            }
        }
        fixture.drained().await;
        fixture.close().await;
    }
}

#[tokio::test]
async fn selected_lease_is_revoked_by_deselect_rename_reconnect_validity_or_recovery_gate() {
    for change in [
        "deselect",
        "rename",
        "reconnect",
        "validity",
        "blocked",
        "catalog",
    ] {
        let fixture = Fixture::new(Mode::Quiet).await;
        let (app, root) = workspace();
        selected_setup(&app, fixture.mail(OWNER), &["Projects"], false).await;
        let original = scope(&app, OWNER, "Projects").await;
        let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
        let (_stop, stopped) = watch::channel(false);
        let task = tokio::spawn(lease(
            app.clone(),
            original.clone(),
            settings,
            stopped,
            fixture.connector.clone(),
            Duration::from_secs(10),
        ));
        fixture.until(|| fixture.count("CONTINUE") == 1).await;
        app.db(move |db| {
            let mut config = db.settings()?;
            match change {
                "deselect" | "rename" => {
                    let status = crate::imap_folder_sync::status(&config, OWNER);
                    let paths = if change == "rename" { json!(["F00"]) } else { json!([]) };
                    crate::imap_folder_sync::select(db, OWNER, &json!({"folderIds":paths,
                        "selectionVersion":status["selectionVersion"],"connectionVersion":status["connectionVersion"]}))?;
                    return Ok(());
                },
                "reconnect" => config["mailAccounts"][OWNER]["connectionId"] = "replacement".into(),
                "validity" => config["imapFolderSync"][OWNER]["folders"][0]["checkpoint"]["validity"] = "78".into(),
                "blocked" => config["imapFolderSync"][OWNER]["folders"][0]["blocked"] = true.into(),
                _ => config["mailFolderCatalogs"][OWNER]["folders"][0]["selectable"] = false.into(),
            }
            db.set_settings(&config)?;
            Ok(())
        }).await.unwrap();
        let (_, result) = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_none());
        fixture.drained().await;
        assert_eq!(fixture.count("DONE"), 0);
        assert_eq!(fixture.count("LOGIN"), 1);
        if ["blocked", "catalog"].contains(&change) {
            assert_eq!(
                scope(&app, OWNER, "Projects").await.generation,
                original.generation
            );
        }
        close_workspace(app, root);
        fixture.close().await;
    }
}

fn review(db: &Store, owner: &str, paths: &[&str]) -> Result<()> {
    let status = crate::imap_folder_sync::status(&db.settings()?, owner);
    crate::imap_folder_sync::select(
        db,
        owner,
        &json!({"folderIds":paths,
        "selectionVersion":status["selectionVersion"],"connectionVersion":status["connectionVersion"]}),
    )?;
    Ok(())
}

#[tokio::test]
async fn selected_retry_and_catalog_expiry_are_clock_gates_without_settings_writes() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, root) = workspace();
    selected_setup(&app, fixture.mail(OWNER), &["Projects"], false).await;
    let original = scope(&app, OWNER, "Projects").await;
    app.db(|db| {
        let mut config = db.settings()?;
        let now = chrono::Utc::now();
        config["imapFolderSync"][OWNER]["folders"][0]["nextRetryAt"] = (now
            + chrono::Duration::milliseconds(700))
        .to_rfc3339()
        .into();
        config["mailFolderCatalogs"][OWNER]["updatedAt"] = (now - chrono::Duration::minutes(15)
            + chrono::Duration::seconds(3))
        .to_rfc3339()
        .into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    let saved = app.db(|db| db.settings()).await.unwrap();
    let (stop, _hints, manager) = start_manager(
        &app,
        &fixture,
        Policy {
            lease: Duration::from_secs(10),
            ..fast_policy()
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        fixture.count("LOGIN"),
        0,
        "future retry must not open a socket"
    );
    fixture.until(|| fixture.count("CONTINUE") == 1).await;
    fixture.drained().await;
    assert_eq!(
        fixture.count("DONE"),
        0,
        "catalog expiry cancels the owned lease"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        fixture.count("LOGIN"),
        1,
        "expired catalog must not repeatedly reconnect"
    );
    assert_eq!(
        scope(&app, OWNER, "Projects").await.generation,
        original.generation
    );
    assert_eq!(
        app.db(|db| db.settings()).await.unwrap(),
        saved,
        "notifications do not refresh sync or catalog clocks"
    );
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn owners_and_selected_folders_rotate_fairly_with_one_socket_per_owner() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, root) = workspace();
    let owners = (0..6)
        .map(|n| format!("owner-{n}@example.invalid"))
        .collect::<Vec<_>>();
    for owner in &owners {
        selected_setup(&app, fixture.mail(owner), &["Projects", "F00", "F01"], true).await;
    }
    let (stop, _hints, manager) = start_manager(
        &app,
        &fixture,
        Policy {
            lease: Duration::from_secs(1),
            ..fast_policy()
        },
    )
    .await;
    fixture
        .until(|| {
            owners
                .iter()
                .all(|owner| completed(&fixture, owner).len() == 4)
        })
        .await;
    stop_manager(stop, manager, &fixture).await;
    let first = fixture
        .state
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, command, _)| command == "LOGIN")
        .take(6)
        .map(|(owner, _, _)| owner.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        first.len(),
        6,
        "unserved owners precede a second lease for an owner"
    );
    for owner in &owners {
        assert_eq!(
            completed(&fixture, owner),
            ["INBOX", "Projects", "F00", "F01"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        assert_eq!(fixture.state.owner_peak.lock().unwrap()[owner], 1);
    }
    assert!(fixture.state.peak.load(Ordering::SeqCst) <= SOCKET_LIMIT);
    assert!(app.0.mailbox.try_lock().is_ok());
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn connection_failures_block_all_selected_paths_across_progress_review_and_quiesce() {
    for mode in [Mode::LoginNo, Mode::Missing, Mode::DoneWrongTag] {
        let fixture = Fixture::new(Mode::Quiet).await;
        let (app, root) = workspace();
        let healthy = "healthy@example.invalid";
        fixture
            .state
            .owner_modes
            .lock()
            .unwrap()
            .insert(OWNER.into(), mode);
        selected_setup(
            &app,
            fixture.mail(OWNER),
            &["Projects", "F00", "F01"],
            false,
        )
        .await;
        selected_setup(
            &app,
            fixture.mail(healthy),
            &["Projects", "F00", "F01"],
            false,
        )
        .await;
        let original = scope(&app, OWNER, "Projects").await;
        let (stop, _hints, manager) = start_manager(
            &app,
            &fixture,
            Policy {
                lease: Duration::from_secs(1),
                ..fast_policy()
            },
        )
        .await;
        fixture
            .until(|| completed(&fixture, healthy).len() == 3)
            .await;
        assert_eq!(
            owner_logins(&fixture, OWNER),
            1,
            "mode={mode:?}; commands={:?}",
            fixture
                .state
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|(owner, _, _)| owner == OWNER)
                .collect::<Vec<_>>()
        );
        app.db(|db| {
            let mut config = db.settings()?;
            let entry = &mut config["imapFolderSync"][OWNER]["folders"][0];
            entry["lastAttemptAt"] = crate::store::now().into();
            entry["lastSuccessfulSyncAt"] = crate::store::now().into();
            entry["checkpoint"]["uid"] = 5.into();
            config["mailFolderCatalogs"][OWNER]["updatedAt"] = crate::store::now().into();
            db.set_settings(&config)?;
            review(db, OWNER, &["Projects", "F00", "F01"])
        })
        .await
        .unwrap();
        let reviewed = scope(&app, OWNER, "Projects").await;
        assert_ne!(reviewed.generation, original.generation);
        assert_eq!(reviewed.owner_generation, original.owner_generation);
        app.0.restarting.store(true, Ordering::Release);
        fixture.drained().await;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        app.0.restarting.store(false, Ordering::Release);
        let healthy_before = owner_logins(&fixture, healthy);
        fixture
            .until(|| owner_logins(&fixture, healthy) > healthy_before)
            .await;
        assert_eq!(
            owner_logins(&fixture, OWNER),
            1,
            "a new selected path/version must not bypass connection failure"
        );
        fixture
            .state
            .owner_modes
            .lock()
            .unwrap()
            .insert(OWNER.into(), Mode::Quiet);
        app.db(|db| {
            let mut config = db.settings()?;
            config["mailAccounts"][OWNER]["connectionId"] = "reconnected".into();
            let mail = config["mailAccounts"][OWNER].clone();
            config["imports"][OWNER]["connectionId"] = mail["connectionId"].clone();
            config["mailFolderCatalogs"][OWNER]["connection"] =
                crate::folders::connection_version(&mail);
            db.set_settings(&config)?;
            Ok(())
        })
        .await
        .unwrap();
        fixture.until(|| owner_logins(&fixture, OWNER) == 2).await;
        assert_ne!(
            scope(&app, OWNER, "Projects").await.owner_generation,
            original.owner_generation
        );
        stop_manager(stop, manager, &fixture).await;
        close_workspace(app, root);
        fixture.close().await;
    }
}

#[tokio::test]
async fn changed_or_missing_folder_blocks_only_that_path_until_selection_is_reviewed() {
    for missing in [false, true] {
        let fixture = Fixture::new(Mode::Quiet).await;
        let (app, root) = workspace();
        if missing {
            fixture.state.folders.lock().unwrap().remove("F00");
        } else {
            fixture
                .state
                .folders
                .lock()
                .unwrap()
                .get_mut("F00")
                .unwrap()
                .0 = 78;
        }
        selected_setup(&app, fixture.mail(OWNER), &["F00", "Projects"], false).await;
        let (stop, _hints, manager) = start_manager(
            &app,
            &fixture,
            Policy {
                lease: Duration::from_secs(1),
                ..fast_policy()
            },
        )
        .await;
        fixture.until(|| fixture.count("CONTINUE") >= 3).await;
        let exams = fixture.state.examinations.lock().unwrap().clone();
        assert_eq!(
            exams.iter().filter(|(_, path)| path == "F00").count(),
            usize::from(!missing)
        );
        assert!(exams.iter().filter(|(_, path)| path == "Projects").count() >= 3);
        fixture
            .state
            .folders
            .lock()
            .unwrap()
            .insert("F00".into(), (77, String::new()));
        app.db(|db| review(db, OWNER, &["F00", "Projects"]))
            .await
            .unwrap();
        fixture
            .until(|| {
                fixture
                    .state
                    .examinations
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, path)| path == "F00")
                    .count()
                    > usize::from(!missing)
            })
            .await;
        stop_manager(stop, manager, &fixture).await;
        close_workspace(app, root);
        fixture.close().await;
    }
}

#[tokio::test]
async fn selected_hint_waiting_for_mailbox_gate_cannot_survive_deselect_reselect_aba() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, root) = workspace();
    selected_setup(&app, fixture.mail(OWNER), &["Projects"], false).await;
    let original = scope(&app, OWNER, "Projects").await;
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let pending = Pending::default();
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    sender
        .send(pending.claim(original.clone()).unwrap())
        .await
        .unwrap_or_else(|_| panic!("closed hint channel"));
    let (stop, stopped) = watch::channel(false);
    let gate = app.0.mailbox.lock().await;
    let worker_app = app.clone();
    let connector = fixture.connector.clone();
    let worker = tokio::spawn(async move {
        consume_with_tls(&worker_app, settings, stopped, receiver, Some(&connector)).await;
    });
    tokio::task::yield_now().await;
    app.db(|db| {
        review(db, OWNER, &[])?;
        review(db, OWNER, &["Projects"])
    })
    .await
    .unwrap();
    let renewed = scope(&app, OWNER, "Projects").await;
    assert_ne!(renewed.generation, original.generation);
    assert_ne!(renewed.selection, original.selection);
    assert_eq!(renewed.owner_generation, original.owner_generation);
    assert!(
        renewed.validity.is_none(),
        "new selection needs its own committed baseline"
    );
    drop(gate);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !pending.0.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.count("LOGIN"), 0);
    assert!(app.db(|db| db.list(OWNER)).await.unwrap().is_empty());
    stop.send(true).unwrap();
    worker.await.unwrap();
    drop(sender);
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn selected_speculative_settings_rollback_cannot_authorize_a_socket() {
    let fixture = Fixture::new(Mode::Quiet).await;
    let (app, root) = workspace();
    selected_setup(&app, fixture.mail(OWNER), &[], false).await;
    let (stop, _hints, manager) = start_manager(&app, &fixture, fast_policy()).await;
    let (written, ready) = oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let mail = fixture.mail(OWNER);
    let writing = app.clone();
    let transaction = tokio::spawn(async move {
        writing
            .db(move |db| {
                db.transaction(|db| {
                    seed_selected(db, &mail, &["Projects"], false)?;
                    written.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(5)).unwrap();
                    Err::<(), _>(Error::conflict("fixture rollback"))
                })
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fixture.count("LOGIN"), 0);
    release.send(()).unwrap();
    assert!(transaction.await.unwrap().is_err());
    app.db(|db| {
        assert!(db.idle_settings.0.borrow().scopes.is_empty());
        assert!(desired(&db.settings()?).scopes.is_empty());
        Ok(())
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fixture.count("LOGIN"), 0);
    selected_setup(&app, fixture.mail(OWNER), &["Projects"], false).await;
    fixture.until(|| fixture.count("CONTINUE") == 1).await;
    stop_manager(stop, manager, &fixture).await;
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn selected_notification_uses_existing_owned_sync_and_commits_only_after_fetch() {
    let fixture = Fixture::new(Mode::Sync).await;
    let (app, root) = workspace();
    selected_setup(&app, fixture.mail(OWNER), &["Projects"], true).await;
    let other = fixture.mail("other@example.invalid");
    app.db(move |db| {
        let mut config = db.settings()?;
        config["mailAccounts"]["other@example.invalid"] = other;
        config["activeAccount"] = "other@example.invalid".into();
        config["imapSync"] = json!({OWNER:{"folders":{"INBOX":{
            "connection":crate::folders::connection_version(&config["mailAccounts"][OWNER]),
            "validity":"77","uid":0,"more":false}}}});
        config["imapFolderSync"][OWNER]["folders"][0]["lastSuccessfulSyncAt"] =
            "2000-01-01T00:00:00.000Z".into();
        db.set_settings(&config)?;
        Ok(())
    })
    .await
    .unwrap();
    let settings = app.db(|db| Ok(db.idle_settings.subscribe())).await.unwrap();
    let original = scope(&app, OWNER, "Projects").await;
    let (stop, stopped) = watch::channel(false);
    let (notified, result) = lease(
        app.clone(),
        original.clone(),
        settings.clone(),
        stopped.clone(),
        fixture.connector.clone(),
        Duration::from_secs(2),
    )
    .await;
    assert_eq!(result.unwrap().unwrap(), IdleOutcome::Changed);
    app.db(|db| {
        let config = db.settings()?;
        assert_eq!(
            config["imapFolderSync"][OWNER]["folders"][0]["checkpoint"]["uid"],
            0
        );
        assert_eq!(
            config["imapFolderSync"][OWNER]["folders"][0]["lastSuccessfulSyncAt"],
            "2000-01-01T00:00:00.000Z"
        );
        assert!(db.list(OWNER)?.is_empty());
        Ok(())
    })
    .await
    .unwrap();
    let pending = Pending::default();
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    sender
        .send(pending.claim(notified).unwrap())
        .await
        .unwrap_or_else(|_| panic!("closed hint channel"));
    drop(sender);
    tokio::time::timeout(
        Duration::from_secs(8),
        consume_with_tls(&app, settings, stopped, receiver, Some(&fixture.connector)),
    )
    .await
    .unwrap();
    drop(stop);
    fixture.drained().await;
    app.db(|db| {
        let config = db.settings()?;
        let rows = db.list(OWNER)?;
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .filter(|row| row["providerFolderId"] == "Projects")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["providerFolderId"] == "INBOX")
                .count(),
            1
        );
        assert!(rows.iter().all(|row| {
            row["body"]
                .as_str()
                .is_some_and(|body| body.contains("Synthetic notification body."))
        }));
        assert!(db.list("other@example.invalid")?.is_empty());
        assert_eq!(config["activeAccount"], "other@example.invalid");
        assert_eq!(config["imapSync"][OWNER]["folders"]["INBOX"]["uid"], 1);
        let entry = &config["imapFolderSync"][OWNER]["folders"][0];
        assert_eq!(entry["checkpoint"]["uid"], 1);
        assert_eq!(entry["checkpoint"]["validity"], "77");
        assert_ne!(entry["lastSuccessfulSyncAt"], "2000-01-01T00:00:00.000Z");
        assert!(
            config["backgroundSyncErrors"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        still_current(&app, &original).await,
        "progress must not invalidate the selected identity"
    );
    assert!(
        fixture
            .state
            .commands
            .lock()
            .unwrap()
            .iter()
            .all(|(owner, _, _)| owner == OWNER)
    );
    assert_eq!(fixture.count("IDLE"), 1);
    assert_eq!(fixture.count("DONE"), 1);
    assert!(pending.0.lock().unwrap().is_empty());
    close_workspace(app, root);
    fixture.close().await;
}

#[tokio::test]
async fn notification_round_checks_captured_scope_in_the_initial_store_snapshot() {
    let mut observed = Vec::new();
    for change in ["connection", "selection"] {
        let fixture = Fixture::new(Mode::Sync).await;
        let (app, root) = workspace();
        selected_setup(&app, fixture.mail(OWNER), &["Projects"], true).await;
        let captured = scope(&app, OWNER, "Projects").await;
        assert!(still_current(&app, &captured).await);
        let proof = SyncProof(captured);
        let (entered, held) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let writing = app.clone();
        let writer = tokio::spawn(async move {
            writing
                .db(move |db| {
                    db.transaction(|db| {
                        entered.send(()).unwrap();
                        wait.recv_timeout(Duration::from_secs(5)).unwrap();
                        if change == "connection" {
                            let mut config = db.settings()?;
                            config["mailAccounts"][OWNER]["connectionId"] = "replacement".into();
                            config["mailFolderCatalogs"][OWNER]["connection"] =
                                crate::folders::connection_version(&config["mailAccounts"][OWNER]);
                            db.set_settings(&config)?;
                        } else {
                            review(db, OWNER, &["F00"])?;
                        }
                        Ok(())
                    })
                })
                .await
        });
        held.await.unwrap();
        let result = {
            let round = crate::mail::sync_notification(&app, proof, Some(&fixture.connector));
            tokio::pin!(round);
            assert!(futures_util::poll!(&mut round).is_pending());
            assert_eq!(
                *app.0.syncing.lock().unwrap(),
                [OWNER.to_owned()],
                "round has reached its queued initial Store read"
            );
            assert_eq!(fixture.count("LOGIN"), 0);
            release.send(()).unwrap();
            writer.await.unwrap().unwrap();
            tokio::time::timeout(Duration::from_secs(8), &mut round)
                .await
                .unwrap()
        };
        fixture.drained().await;
        observed.push((
            change,
            result.is_err(),
            fixture.count("LOGIN"),
            app.db(|db| db.list(OWNER)).await.unwrap().len(),
            examined(&fixture, OWNER),
        ));
        assert!(app.0.syncing.lock().unwrap().is_empty());
        close_workspace(app, root);
        fixture.close().await;
    }
    assert!(
        observed
            .iter()
            .all(|(_, rejected, logins, rows, examined)| *rejected
                && *logins == 0
                && *rows == 0
                && examined.is_empty()),
        "stale proof must fail before provider access; (change, rejected, logins, rows, examined): {observed:?}"
    );
}
