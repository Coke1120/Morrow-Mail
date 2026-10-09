use axum::http::{HeaderMap, HeaderValue, Method};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
use morrow_search::{
    error::Error,
    service::{App, Context},
    updater::*,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("morrow-rust-updater-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture_key() -> (SigningKey, String) {
    let key = SigningKey::from_bytes(&morrow_search::store::random_bytes::<32>().unwrap());
    let pem = key
        .verifying_key()
        .to_public_key_pem(Default::default())
        .unwrap();
    (key, pem)
}
fn manifest(version: &str, size: u64, digest: &str) -> Value {
    json!({"version":version,"platforms": (["macos-arm64","windows-x64"].into_iter().map(|p|(p.to_string(),json!({"name":format!("Morrow-Mail-{version}-{p}.zip"),"size":size,"sha256":digest}))).collect::<serde_json::Map<_,_>>())})
}
#[test]
fn signatures_require_both_platforms_exact_version_and_bounded_assets() {
    let (key, pem) = fixture_key();
    let version = "0.5.0-beta.2";
    let value = manifest(version, 10, &"a".repeat(64));
    let verify = |value: Value, version: &str| {
        let bytes = serde_json::to_vec(&value).unwrap();
        verify_manifest(
            &bytes,
            &STANDARD.encode(key.sign(&bytes).to_bytes()),
            version,
            &pem,
        )
    };
    assert_eq!(verify(value.clone(), version).unwrap().version, version);
    assert!(verify(value.clone(), "0.5.0-beta.1").is_err());
    for (property, bad) in [
        ("size", json!(0)),
        ("size", json!(ARCHIVE_LIMIT + 1)),
        ("size", json!(1.5)),
        ("name", json!("../update.zip")),
        ("sha256", json!("A".repeat(64))),
    ] {
        let mut value = value.clone();
        value["platforms"]["windows-x64"][property] = bad;
        assert!(verify(value, version).is_err());
    }
    let mut missing = value.clone();
    missing["platforms"]
        .as_object_mut()
        .unwrap()
        .remove("windows-x64");
    assert!(verify(missing, version).is_err());
    let bytes = serde_json::to_vec(&value).unwrap();
    let signed = STANDARD.encode(key.sign(&bytes).to_bytes());
    assert!(verify_manifest(&bytes, &signed, version, &fixture_key().1).is_err());
    assert!(verify_manifest(&bytes, &signed, version, PUBLIC_KEY).is_err());
    let mut changed = bytes.clone();
    changed[0] = b' ';
    assert!(verify_manifest(&changed, &signed, version, &pem).is_err());
    assert!(verify_manifest(&vec![b'x'; 16385], &signed, version, &pem).is_err());
    for url in [
        "http://github.com/update",
        "https://github.com@localhost/update",
        "https://github.com:8443/update",
        "https://github.com/update#fragment",
        "https://untrusted.invalid/update",
        "https://github.com.evil.invalid/update",
    ] {
        assert!(trusted_asset_url(url).is_err(), "{url}");
    }
    for host in [
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    ] {
        assert!(trusted_asset_url(&format!("https://{host}:443/update")).is_ok());
    }
}
#[test]
fn numbered_release_reaches_existing_users_in_both_channels() {
    let releases = json!([
        {"tag_name":"v0.6.0-beta.48","prerelease":true},
        {"tag_name":"v0.7.0","prerelease":false},
        {"tag_name":"v9.0.0","draft":true}
    ]);
    for installed in ["0.6.0-beta.48", "0.6.0", "0.7.0"] {
        for include_prereleases in [false, true] {
            let result = select_release(&releases, installed, include_prereleases).unwrap();
            assert_eq!(result["latestVersion"], "0.7.0");
            assert_eq!(result["prerelease"], false);
            assert_eq!(result["updateAvailable"], installed != "0.7.0");
        }
    }
}

#[test]
fn channel_selection_matches_node_semver_and_never_reports_failures_up_to_date() {
    for (installed, tag, expected) in [
        ("1.0.0-alpha.9", "v1.0.0-alpha.10", true),
        ("1.0.0-alpha", "1.0.0-alpha.1", true),
        ("1.0.0-beta", "1.0.0", true),
        ("1.0.0", "1.0.0-beta", false),
        ("0.5.0-alpha.1", "v0.5.0-beta.1", true),
        ("1.0.0-2", "1.0.0-alpha", true),
        ("1.9.0", "1.10.0", true),
        ("2.0.0", "1.99.0", false),
        ("1.0.0+local", "v1.0.0+release", false),
        (
            "999999999999999999999999.0.0",
            "1000000000000000000000000.0.0",
            true,
        ),
    ] {
        assert_eq!(
            select_release(&json!([{"tag_name":tag}]), installed, true).unwrap()["updateAvailable"],
            expected,
            "{installed} => {tag}"
        );
    }
    assert_eq!(
        select_release(
            &json!([{"tag_name":"v1.0.0+first"},{"tag_name":"v1.0.0+second"}]),
            "0.0.1",
            true
        )
        .unwrap()["latestVersion"],
        "1.0.0+first"
    );
    assert_eq!(
        select_release(&json!([{"tag_name":"v1٩.0.0"}]), "0.0.1", true)
            .unwrap_err()
            .status,
        404
    );
    let releases = json!([{"tag_name":"v0.3.0"},{"tag_name":"v0.4.0-alpha.10"},{"tag_name":"v9.0.0","draft":true},{"tag_name":"v0.4.0-alpha.2"},{"tag_name":"v99.0.0-01"}]);
    assert_eq!(
        select_release(&releases, "0.4.0-alpha.2", true).unwrap()["latestVersion"],
        "0.4.0-alpha.10"
    );
    assert_eq!(
        select_release(&releases, "0.4.0-alpha.2", false).unwrap()["latestVersion"],
        "0.3.0"
    );
    for releases in [
        json!([]),
        json!([{"tag_name":"v1.0.0-01"}]),
        json!([{"tag_name":"v01.0.0"}]),
        json!([{"tag_name":"v2.0.0","draft":true}]),
    ] {
        assert_eq!(
            select_release(&releases, "1.0.0", true).unwrap_err().status,
            404
        );
    }
    assert_eq!(
        select_release(&json!({}), "1.0.0", true)
            .unwrap_err()
            .status,
        502
    );
}
fn tiny_zip(entries: &[(&str, Option<&str>)]) -> Vec<u8> {
    fn w16(b: &mut [u8], at: usize, n: u16) {
        b[at..at + 2].copy_from_slice(&n.to_le_bytes());
    }
    fn w32(b: &mut [u8], at: usize, n: u32) {
        b[at..at + 4].copy_from_slice(&n.to_le_bytes());
    }
    let mut local = Vec::new();
    let mut central = Vec::new();
    for (name, link) in entries {
        let content = link.unwrap_or("ok").as_bytes();
        let mut head = vec![0; 30];
        w32(&mut head, 0, 0x04034b50);
        w32(&mut head, 18, content.len() as u32);
        w32(&mut head, 22, content.len() as u32);
        w16(&mut head, 26, name.len() as u16);
        let mut dir = vec![0; 46];
        w32(&mut dir, 0, 0x02014b50);
        w32(&mut dir, 20, content.len() as u32);
        w32(&mut dir, 24, content.len() as u32);
        w16(&mut dir, 28, name.len() as u16);
        w32(&mut dir, 42, local.len() as u32);
        if link.is_some() {
            w32(&mut dir, 38, 0xa1ff << 16);
        }
        local.extend(head);
        local.extend(name.as_bytes());
        local.extend(content);
        central.extend(dir);
        central.extend(name.as_bytes());
    }
    let mut end = vec![0; 22];
    w32(&mut end, 0, 0x06054b50);
    w16(&mut end, 8, entries.len() as u16);
    w16(&mut end, 10, entries.len() as u16);
    w32(&mut end, 12, central.len() as u32);
    w32(&mut end, 16, local.len() as u32);
    local.extend(central);
    local.extend(end);
    local
}
#[test]
fn archives_reject_traversal_aliases_links_duplicates_and_malformed_headers() {
    let dir = Temporary::new();
    let path = dir.0.join("update.zip");
    let root = "Morrow Mail.app";
    fs::write(
        &path,
        tiny_zip(&[("Morrow Mail.app/Contents/example", None)]),
    )
    .unwrap();
    inspect_archive(&path, root).unwrap();
    for (name, link) in [
        ("../outside", None),
        ("/absolute", None),
        ("Morrow Mail.app/../../outside", None),
        ("Morrow Mail.app/C:stream", None),
        ("Morrow Mail.app/AUX.txt", None),
        ("Morrow Mail.app/foo.", None),
        ("Morrow Mail.app/Contents/link", Some("../../../outside")),
        ("Morrow Mail.app/link", Some("/private")),
        ("Morrow Mail.app/link", Some("../__MACOSX/escape")),
    ] {
        fs::write(&path, tiny_zip(&[(name, link)])).unwrap();
        assert!(inspect_archive(&path, root).is_err(), "{name}");
    }
    for entries in [
        vec![
            ("Morrow Mail.app/Contents/Example", None),
            ("Morrow Mail.app/Contents/example", None),
        ],
        vec![
            ("Morrow Mail.app/link", Some("Contents")),
            ("Morrow Mail.app/link/write", None),
        ],
    ] {
        fs::write(&path, tiny_zip(&entries)).unwrap();
        assert!(inspect_archive(&path, root).is_err());
    }
    let valid = tiny_zip(&[("Morrow Mail.app/Contents/example", None)]);
    for i in [0, 8, 30] {
        let mut broken = valid.clone();
        broken[i] = 88;
        fs::write(&path, broken).unwrap();
        assert!(inspect_archive(&path, root).is_err());
    }
    for n in 0..valid.len() {
        fs::write(&path, &valid[..n]).unwrap();
        assert!(inspect_archive(&path, root).is_err());
    }
}
fn config(root: &Path) -> InstallConfig {
    let directory = root.join(".morrow-update-test");
    let target = root.join("current");
    let staged = directory.join("extracted/Morrow Mail-win32-x64");
    let workspace = root.join("workspace");
    fs::create_dir(&target).unwrap();
    fs::create_dir_all(&staged).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::write(target.join("version"), "old").unwrap();
    fs::write(staged.join("version"), "new").unwrap();
    fs::write(workspace.join("user-data"), "retained").unwrap();
    InstallConfig {
        directory: directory.clone(),
        root: "Morrow Mail-win32-x64".into(),
        platform: "windows-x64".into(),
        target,
        staged,
        backup: directory.join("previous"),
        version: "0.0.2".into(),
        installed_version: "0.0.1".into(),
        pids: [2147483000, 2147483001],
        result_file: workspace.join("update-result.json"),
    }
}
#[tokio::test]
async fn replace_rolls_back_failed_launch_and_retains_previous_binary_without_restoring_old_data() {
    let root = Temporary::new();
    let cfg = config(&root.0);
    assert!(
        replace_and_launch(&cfg, |_| async { Err(Error::conflict("launch failed")) })
            .await
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(cfg.target.join("version")).unwrap(),
        "old"
    );
    assert!(!cfg.backup.exists());
    replace_and_launch(&cfg, |target| async move {
        assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "new");
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(cfg.backup.join("version")).unwrap(),
        "old"
    );
    assert_eq!(
        fs::read_to_string(root.0.join("workspace/user-data")).unwrap(),
        "retained"
    );
    assert!(
        replace_and_launch(&cfg, |_| async { Ok(()) })
            .await
            .is_err()
    );
}
#[tokio::test]
async fn unsupported_packages_and_renderer_install_are_rejected_without_provider_access() {
    let root = Temporary::new();
    let app = App::open(&root.0, 3001, "a".repeat(64), "b".repeat(64)).unwrap();
    assert_eq!(app.0.updater.status().await["supported"], false);
    assert_eq!(
        app.0
            .updater
            .start(app.0.client.clone(), true)
            .await
            .unwrap_err()
            .status,
        409
    );
    let mut context = Context {
        method: Method::POST,
        path: vec!["updates".into(), "install".into()],
        body: json!({"url":"https://evil.invalid","target":"/untrusted"}),
        query: json!({}),
        headers: HeaderMap::new(),
        owner: "demo".into(),
        paged: false,
    };
    assert_eq!(handle(&app, &context).await.unwrap_err().status, 403);
    context.headers.insert(
        "x-morrow-update",
        HeaderValue::from_str(&"c".repeat(64)).unwrap(),
    );
    assert_eq!(handle(&app, &context).await.unwrap_err().status, 403);
    context.headers.insert(
        "x-morrow-update",
        HeaderValue::from_str(&"b".repeat(64)).unwrap(),
    );
    assert_eq!(handle(&app, &context).await.unwrap_err().status, 409);
    app.0.updater.cancel().await.unwrap();
    app.0.updater.stop().await;
}
#[tokio::test]
async fn real_process_liveness_waits_for_exits() {
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        c
    } else {
        let mut c = tokio::process::Command::new("/bin/sleep");
        c.arg("30");
        c
    };
    let mut child = command.kill_on_drop(true).spawn().unwrap();
    let pid = child.id().unwrap();
    assert!(process_alive(pid));
    child.kill().await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!process_alive(pid));
}
