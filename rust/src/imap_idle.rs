//! Bounded, owned notification leases. IDLE never imports mail or runs AI itself.
use crate::{
    error::Result,
    service::{App, connections},
    store::{Store, string},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
    time::Instant,
};

const SOCKET_LIMIT: usize = 4;
const LEASE: Duration = Duration::from_secs(60);
const HINT_INTERVAL: Duration = Duration::from_secs(30);
const RETRY_MIN: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(300);

#[derive(Clone, PartialEq)]
struct Scope {
    owner: String,
    connection: Value,
    origin: String,
    path: String,
    selection: Option<(String, String)>,
    validity: Option<u32>,
    owner_generation: u64,
    generation: u64,
}

type ScopeKey = (String, String);
impl Scope {
    fn key(&self) -> ScopeKey {
        (self.owner.clone(), self.path.clone())
    }
}

#[derive(Clone, PartialEq)]
struct Owner {
    connection: Value,
    origin: String,
    generation: u64,
}

#[derive(Clone, PartialEq)]
struct Eligibility {
    available: bool,
    not_before: i64,
    expires_at: Option<i64>,
}
impl Eligibility {
    fn allows(&self, now: i64) -> bool {
        self.available && self.not_before <= now && self.expires_at.is_none_or(|until| now < until)
    }
    fn next_check(&self, now: i64) -> Duration {
        let next = [Some(self.not_before), self.expires_at]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min();
        Duration::from_millis(next.map_or(1000, |at| at.saturating_sub(now).min(1000) as u64))
    }
}

#[derive(Clone, Default)]
struct Snapshot {
    generation: u64,
    exhausted: bool,
    owners: BTreeMap<String, Owner>,
    scopes: BTreeMap<ScopeKey, Scope>,
    eligibility: BTreeMap<ScopeKey, Eligibility>,
}

fn desired(config: &Value) -> Snapshot {
    let mut result = Snapshot::default();
    if config["preferences"]["syncInterval"].as_i64().unwrap_or(0) <= 0 {
        return result;
    }
    let accounts = connections(config);
    for (owner, connection) in accounts.as_object().into_iter().flatten() {
        if !["", "imap"].contains(&string(connection, "provider"))
            || !owner.eq_ignore_ascii_case(string(connection, "email"))
        {
            continue;
        }
        let Ok(origin) = crate::imap::server_origin(connection) else {
            continue;
        };
        result.owners.insert(
            owner.clone(),
            Owner {
                connection: connection.clone(),
                origin: origin.clone(),
                generation: 0,
            },
        );
        let shared_wait = crate::mail::read_backoff(config, connection)
            .and_then(|error| error.retry_after)
            .unwrap_or(0);
        let mut insert = |path: String, selection, validity, eligibility| {
            let scope = Scope {
                owner: owner.clone(),
                connection: connection.clone(),
                origin: origin.clone(),
                path,
                selection,
                validity,
                owner_generation: 0,
                generation: 0,
            };
            let key = scope.key();
            result.scopes.insert(key.clone(), scope);
            result.eligibility.insert(key, eligibility);
        };
        let job = crate::background::current_import(config, connection).unwrap_or(&Value::Null);
        let options = &job["options"];
        if !options.is_object() || options["allMail"] == true || options["inbox"] == true {
            let checkpoint = &config["imapSync"][owner]["folders"]["INBOX"];
            let validity = (checkpoint["connection"]
                == crate::folders::connection_version(connection))
            .then(|| {
                checkpoint["validity"].as_u64().or_else(|| {
                    let raw = checkpoint["validity"].as_str()?;
                    (!raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()))
                        .then(|| raw.parse().ok())
                        .flatten()
                })
            })
            .flatten()
            .and_then(|validity| u32::try_from(validity).ok())
            .filter(|validity| *validity > 0);
            insert(
                "INBOX".into(),
                None,
                validity,
                Eligibility {
                    available: true,
                    not_before: shared_wait,
                    expires_at: None,
                },
            );
        }
        for selected in crate::imap_folder_sync::notification_selections(config, owner, connection)
        {
            insert(
                selected.path,
                Some((selected.version, selected.id)),
                selected.validity,
                Eligibility {
                    available: selected.available,
                    not_before: shared_wait.max(selected.not_before),
                    expires_at: Some(selected.expires_at),
                },
            );
        }
    }
    result
}

/// Store-owned private revocation state. It is not a connection authorization.
pub(crate) struct Settings(watch::Sender<Snapshot>);
impl Default for Settings {
    fn default() -> Self {
        Self(watch::channel(Snapshot::default()).0)
    }
}
impl Settings {
    pub(crate) fn update(&self, config: &Value) {
        let mut next = desired(config);
        self.0.send_if_modified(|saved| {
            if saved.exhausted {
                return false;
            }
            let generation = saved.generation.checked_add(1);
            for (owner, value) in &mut next.owners {
                if let Some(previous) = saved.owners.get(owner) {
                    value.generation = previous.generation;
                    if *value == *previous {
                        continue;
                    }
                }
                value.generation = generation.unwrap_or(u64::MAX);
            }
            for (key, scope) in &mut next.scopes {
                scope.owner_generation = next.owners[&scope.owner].generation;
                if let Some(previous) = saved.scopes.get(key) {
                    scope.generation = previous.generation;
                    if *scope == *previous {
                        continue;
                    }
                }
                scope.generation = generation.unwrap_or(u64::MAX);
            }
            let identity_changed = saved.owners != next.owners || saved.scopes != next.scopes;
            if !identity_changed && saved.eligibility == next.eligibility {
                return false;
            }
            if identity_changed && generation.is_none() {
                saved.exhausted = true;
                saved.owners.clear();
                saved.scopes.clear();
                saved.eligibility.clear();
                return true;
            }
            if identity_changed {
                saved.generation = generation.unwrap();
            }
            saved.owners = next.owners.clone();
            saved.scopes = next.scopes.clone();
            saved.eligibility = next.eligibility.clone();
            true
        });
    }
    fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.0.subscribe()
    }
}

fn current_settings(db: &Store, scope: &Scope, config: &Value) -> bool {
    if db.idle_settings.0.borrow().scopes.get(&scope.key()) != Some(scope) {
        return false;
    }
    // This read runs after the preceding Store closure has released its lock.
    // A rolled-back settings write can only revoke, never authorize a socket.
    let mut expected = scope.clone();
    expected.generation = 0;
    expected.owner_generation = 0;
    desired(config).scopes.get(&scope.key()) == Some(&expected)
}

fn current(db: &Store, scope: &Scope) -> Result<bool> {
    Ok(current_settings(db, scope, &db.settings()?))
}

/// Opaque proof carried only by the notification consumer. The sync entry
/// checks it in the same Store closure that captures the round's initial state.
pub(crate) struct SyncProof(Scope);
impl SyncProof {
    pub(crate) fn owner(&self) -> &str {
        &self.0.owner
    }
    pub(crate) fn verify(&self, db: &Store, config: &Value) -> Result<()> {
        if !current_settings(db, &self.0, config)
            || !desired(config)
                .eligibility
                .get(&self.0.key())
                .is_some_and(|gate| gate.allows(chrono::Utc::now().timestamp_millis()))
        {
            return Err(crate::error::Error::conflict(
                "This mail notification scope changed before synchronization.",
            ));
        }
        Ok(())
    }
}

async fn still_current(app: &App, scope: &Scope) -> bool {
    let scope = scope.clone();
    app.db(move |db| {
        Ok(current(db, &scope)?
            && desired(&db.settings()?)
                .eligibility
                .get(&scope.key())
                .is_some_and(|gate| gate.allows(chrono::Utc::now().timestamp_millis())))
    })
    .await
    .unwrap_or(false)
}

async fn ready_to_connect(app: &App, scope: &Scope) -> Result<bool> {
    let scope = scope.clone();
    app.db(move |db| {
        if !current(db, &scope)? {
            return Ok(false);
        }
        if let Some(error) = crate::mail::read_backoff(&db.settings()?, &scope.connection) {
            return Err(error);
        }
        Ok(desired(&db.settings()?)
            .eligibility
            .get(&scope.key())
            .is_some_and(|gate| gate.allows(chrono::Utc::now().timestamp_millis())))
    })
    .await
}

async fn revoked(settings: &mut watch::Receiver<Snapshot>, scope: &Scope) {
    loop {
        let delay = {
            let snapshot = settings.borrow_and_update();
            let now = chrono::Utc::now().timestamp_millis();
            if snapshot.scopes.get(&scope.key()) != Some(scope) {
                return;
            }
            let Some(gate) = snapshot
                .eligibility
                .get(&scope.key())
                .filter(|gate| gate.allows(now))
            else {
                return;
            };
            gate.next_check(now)
        };
        tokio::select! {
            changed = settings.changed() => if changed.is_err() { return; },
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            break;
        }
    }
}

async fn quiescing(app: &App) {
    while !app.0.restarting.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[derive(Clone, Copy)]
struct Policy {
    lease: Duration,
    hint_interval: Duration,
    retry_min: Duration,
    retry_max: Duration,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            lease: LEASE,
            hint_interval: HINT_INTERVAL,
            retry_min: RETRY_MIN,
            retry_max: RETRY_MAX,
        }
    }
}

struct Turn {
    generation: u64,
    served: u64,
    ready: Instant,
    retry: Duration,
    blocked: bool,
}

fn finish_turn(
    owner: &mut Turn,
    folder: Option<&mut Turn>,
    result: Option<Result<crate::imap::IdleOutcome>>,
    policy: Policy,
) -> bool {
    match result {
        Some(Ok(crate::imap::IdleOutcome::Changed)) => {
            owner.retry = policy.retry_min;
            owner.ready = Instant::now() + policy.hint_interval;
            true
        }
        Some(Ok(crate::imap::IdleOutcome::LeaseEnded)) => {
            owner.retry = policy.retry_min;
            owner.ready = Instant::now();
            false
        }
        Some(Err(error)) if string(&error.body, "code") == "provider_network" => {
            owner.ready = Instant::now() + owner.retry;
            owner.retry = owner.retry.saturating_mul(2).min(policy.retry_max);
            false
        }
        Some(Err(error)) if string(&error.body, "code") == "rate_limited" => {
            // Recheck the persisted provider wait before any socket; a timer
            // wake never overrides a longer Retry-After.
            let wait = error
                .retry_after
                .unwrap_or(0)
                .saturating_sub(chrono::Utc::now().timestamp_millis())
                .max(1) as u64;
            owner.ready = Instant::now()
                + Duration::from_millis(wait)
                    .max(policy.retry_min)
                    .min(policy.retry_max);
            false
        }
        Some(Err(error))
            if [
                "imap_idle_mailbox_changed",
                "folder_unavailable",
                "provider_imap_mailbox_rejected",
            ]
            .contains(&string(&error.body, "code")) =>
        {
            if let Some(folder) = folder {
                folder.blocked = true;
            }
            false
        }
        Some(_) => {
            // Authentication/capability/protocol failures belong to the whole
            // connection. Trying its other selected paths is not a retry gate.
            owner.blocked = true;
            false
        }
        // A revoked generation disappears on the next settings snapshot. A
        // quiesced current generation may resume with its existing retry state.
        None => false,
    }
}

type HintIdentity = (u64, u64, String);
#[derive(Clone, Default)]
struct Pending(Arc<Mutex<BTreeMap<String, HintIdentity>>>);
struct Hint {
    scope: Scope,
    pending: Pending,
}
impl Pending {
    fn claim(&self, scope: Scope) -> Option<Hint> {
        let mut pending = self.0.lock().ok()?;
        if pending.len() >= SOCKET_LIMIT || pending.contains_key(&scope.owner) {
            return None;
        }
        pending.insert(
            scope.owner.clone(),
            (scope.owner_generation, scope.generation, scope.path.clone()),
        );
        Some(Hint {
            scope,
            pending: self.clone(),
        })
    }
}
impl Drop for Hint {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.0.lock()
            && pending.get(&self.scope.owner)
                == Some(&(
                    self.scope.owner_generation,
                    self.scope.generation,
                    self.scope.path.clone(),
                ))
        {
            pending.remove(&self.scope.owner);
        }
    }
}

async fn lease(
    app: App,
    scope: Scope,
    mut settings: watch::Receiver<Snapshot>,
    mut stop: watch::Receiver<bool>,
    connector: native_tls::TlsConnector,
    duration: Duration,
) -> (Scope, Option<Result<crate::imap::IdleOutcome>>) {
    let result = tokio::select! {
        biased;
        _ = stopped(&mut stop) => None,
        _ = revoked(&mut settings, &scope) => None,
        _ = quiescing(&app) => None,
        result = async {
            if app.0.restarting.load(Ordering::Acquire) {
                return None;
            }
            match ready_to_connect(&app, &scope).await {
                Ok(true) => {},
                Ok(false) => return None,
                Err(error) => return Some(Err(error)),
            }
            if app.0.restarting.load(Ordering::Acquire) {
                return None;
            }
            Some(if scope.selection.is_some() {
                let validity = scope.validity?;
                crate::imap::idle_selected_folder_with_tls(
                    &scope.connection, &scope.path, validity, &connector, duration,
                ).await
            } else {
                crate::imap::idle_inbox_with_tls(
                    &scope.connection, scope.validity, &connector, duration,
                ).await
            })
        } => result,
    };
    (scope, result)
}

fn new_turn(generation: u64, policy: Policy) -> Turn {
    Turn {
        generation,
        served: 0,
        ready: Instant::now(),
        retry: policy.retry_min,
        blocked: false,
    }
}

fn finish_scope(
    scope: &Scope,
    result: Option<Result<crate::imap::IdleOutcome>>,
    owners: &mut BTreeMap<String, Turn>,
    folders: &mut BTreeMap<ScopeKey, Turn>,
    policy: Policy,
) -> bool {
    let Some(owner) = owners
        .get_mut(&scope.owner)
        .filter(|turn| turn.generation == scope.owner_generation)
    else {
        return false;
    };
    let folder = folders
        .get_mut(&scope.key())
        .filter(|turn| turn.generation == scope.generation);
    finish_turn(owner, folder, result, policy)
}

async fn manage(
    app: &App,
    mut settings: watch::Receiver<Snapshot>,
    mut stop: watch::Receiver<bool>,
    connector: native_tls::TlsConnector,
    hints: mpsc::Sender<Hint>,
    policy: Policy,
) {
    let mut tasks = JoinSet::new();
    let mut active = BTreeMap::<String, u64>::new();
    let mut owners = BTreeMap::<String, Turn>::new();
    let mut folders = BTreeMap::<ScopeKey, Turn>::new();
    let mut serial = 0u64;
    let pending = Pending::default();
    loop {
        if *stop.borrow() {
            break;
        }
        if app.0.restarting.load(Ordering::Acquire) {
            tasks.abort_all();
            while let Some(result) = tasks.join_next().await {
                if let Ok((scope, result)) = result {
                    // A completed connection-wide failure remains blocked even
                    // when the selected path is removed during update preparation.
                    finish_scope(&scope, result, &mut owners, &mut folders, policy);
                }
            }
            active.clear();
            tokio::select! {
                biased;
                _ = stopped(&mut stop) => break,
                changed = settings.changed() => if changed.is_err() { break; },
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
            continue;
        }
        let snapshot = settings.borrow_and_update().clone();
        owners.retain(|owner, turn| {
            snapshot
                .owners
                .get(owner)
                .is_some_and(|scope| scope.generation == turn.generation)
        });
        folders.retain(|key, turn| {
            snapshot
                .scopes
                .get(key)
                .is_some_and(|scope| scope.generation == turn.generation)
        });
        for (owner, scope) in &snapshot.owners {
            owners
                .entry(owner.clone())
                .or_insert_with(|| new_turn(scope.generation, policy));
        }
        for (key, scope) in &snapshot.scopes {
            folders
                .entry(key.clone())
                .or_insert_with(|| new_turn(scope.generation, policy));
        }
        while active.len() < SOCKET_LIMIT {
            let now = Instant::now();
            let clock = chrono::Utc::now().timestamp_millis();
            let next = folders
                .iter()
                .filter(|(key, turn)| {
                    let owner = &owners[&key.0];
                    !active.contains_key(&key.0)
                        && !owner.blocked
                        && owner.ready <= now
                        && !turn.blocked
                        && snapshot
                            .eligibility
                            .get(*key)
                            .is_some_and(|gate| gate.allows(clock))
                })
                .min_by_key(|(key, turn)| (owners[&key.0].served, &key.0, turn.served, &key.1))
                .map(|(key, _)| key.clone());
            let Some(key) = next else { break };
            let scope = snapshot.scopes[&key].clone();
            serial = serial.saturating_add(1);
            folders.get_mut(&key).unwrap().served = serial;
            owners.get_mut(&scope.owner).unwrap().served = serial;
            active.insert(scope.owner.clone(), scope.generation);
            tasks.spawn(lease(
                app.clone(),
                scope,
                settings.clone(),
                stop.clone(),
                connector.clone(),
                policy.lease,
            ));
        }
        // Absolute catalog/retry deadlines are evaluated even without a settings
        // write. Ineligible scopes keep their turns and do not spawn false-ready
        // leases repeatedly; the timer also notices clock shifts and quiescing.
        let clock = chrono::Utc::now().timestamp_millis();
        let mut wake = Instant::now() + Duration::from_secs(1);
        for (owner, turn) in &owners {
            if !active.contains_key(owner) && !turn.blocked && turn.ready > Instant::now() {
                wake = wake.min(turn.ready);
            }
        }
        for gate in snapshot.eligibility.values() {
            wake = wake.min(Instant::now() + gate.next_check(clock));
        }
        tokio::select! {
            biased;
            _ = stopped(&mut stop) => break,
            changed = settings.changed() => if changed.is_err() { break; },
            result = tasks.join_next(), if !tasks.is_empty() => {
                let Some(Ok((scope, result))) = result else {
                    // A panicked child must not leave a permanently occupied
                    // slot or cause a reconnect loop. Polling remains available.
                    break;
                };
                active.remove(&scope.owner);
                if finish_scope(&scope, result, &mut owners, &mut folders, policy)
                    && !app.0.restarting.load(Ordering::Acquire)
                    && still_current(app, &scope).await
                    && let Some(hint) = pending.claim(scope)
                {
                    // Losing a bounded acceleration hint never loses mail or a checkpoint.
                    let _ = hints.try_send(hint);
                }
            }
            _ = tokio::time::sleep_until(wake) => {},
        }
    }
    tasks.shutdown().await;
}

async fn consume(
    app: &App,
    settings: watch::Receiver<Snapshot>,
    stop: watch::Receiver<bool>,
    hints: mpsc::Receiver<Hint>,
) {
    consume_with_tls(app, settings, stop, hints, None).await;
}

async fn consume_with_tls(
    app: &App,
    mut settings: watch::Receiver<Snapshot>,
    mut stop: watch::Receiver<bool>,
    mut hints: mpsc::Receiver<Hint>,
    connector: Option<&native_tls::TlsConnector>,
) {
    loop {
        let hint = tokio::select! {
            biased;
            _ = stopped(&mut stop) => break,
            scope = hints.recv() => match scope { Some(scope) => scope, None => break },
        };
        let scope = &hint.scope;
        if app.0.restarting.load(Ordering::Acquire) {
            continue;
        }
        tokio::select! {
            biased;
            _ = stopped(&mut stop) => break,
            _ = revoked(&mut settings, scope) => {},
            _ = quiescing(app) => {},
            _ = async {
                // Waiting for IDLE never holds this lock. A hint gets the same
                // serialization, backoff and commit proof as ordinary sync.
                let _gate = app.0.mailbox.lock().await;
                if app.0.restarting.load(Ordering::Acquire) || !still_current(app, scope).await {
                    return;
                }
                if app.0.restarting.load(Ordering::Acquire) {
                    return;
                }
                let _ = crate::mail::sync_notification(app, SyncProof(scope.clone()), connector).await;
            } => {},
        }
    }
}

/// Own this future in the service's shutdown task group. Dropping it aborts its
/// read-only children; no global pool or detached reconnect worker survives it.
pub async fn run(app: &App, stop: watch::Receiver<bool>) {
    let Ok(connector) = native_tls::TlsConnector::new() else {
        return;
    };
    run_with_policy(app, stop, connector, Policy::default()).await;
}

async fn run_with_policy(
    app: &App,
    stop: watch::Receiver<bool>,
    connector: native_tls::TlsConnector,
    policy: Policy,
) {
    let Ok(settings) = app.db(|db| Ok(db.idle_settings.subscribe())).await else {
        return;
    };
    let (sender, receiver) = mpsc::channel(SOCKET_LIMIT);
    tokio::join!(
        manage(
            app,
            settings.clone(),
            stop.clone(),
            connector,
            sender,
            policy
        ),
        consume(app, settings, stop, receiver),
    );
}

#[cfg(test)]
mod tests;
