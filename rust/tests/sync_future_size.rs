//! Catch nested CLI/router frame growth without contacting a provider.
use morrow_search::{mail, service::App};

#[test]
fn provider_sync_state_stays_off_the_nested_cli_stack() {
    let root = std::env::temp_dir().join(format!("morrow-sync-frame-{}", uuid::Uuid::new_v4()));
    let app = App::open(&root, 0, "synthetic-frame".into(), String::new()).unwrap();
    let owners = vec!["demo".to_owned()];
    let bytes = std::mem::size_of_val(&mail::sync(&app, &owners));
    assert!(
        bytes <= 4096,
        "Sync frame grew to {bytes} bytes; Windows CLI has nested poll frames and an unchanged 1 MiB main stack."
    );
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}
