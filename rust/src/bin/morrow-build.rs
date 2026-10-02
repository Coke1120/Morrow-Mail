//! Node-free macOS candidate packaging. Never replaces an installed application.
use morrow_search::oauth::{bundled_google_oauth, parse_google_oauth};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const MINIMUM: &str = "13.5";
const TARGET: &str = "aarch64-apple-darwin";

fn command(root: &Path, program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(root)
        .env("MACOSX_DEPLOYMENT_TARGET", MINIMUM);
    command
}

fn run(command: &mut Command) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!(
            "{} failed ({status}).",
            command.get_program().to_string_lossy()
        )
        .into());
    }
    Ok(())
}

fn capture(command: &mut Command, limit: u64) -> Result<String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or("Missing build output pipe.")?
        .take(limit + 1)
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() as u64 > limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Could not read bounded build output.".into());
    }
    let status = child.wait()?;
    if !status.success() {
        return Err(format!(
            "{} failed ({status}).",
            command.get_program().to_string_lossy()
        )
        .into());
    }
    String::from_utf8(bytes).map_err(|_| "Build output was not UTF-8.".into())
}

fn version(metadata: &Value) -> Result<&str> {
    let value = metadata["version"]
        .as_str()
        .ok_or("Missing package version.")?;
    if !Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$")?.is_match(value) {
        return Err("Invalid common package version.".into());
    }
    Ok(value)
}

fn system_libraries(output: &str) -> bool {
    let lines: Vec<_> = output
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    !lines.is_empty()
        && lines
            .iter()
            .all(|line| line.starts_with("/System/Library/") || line.starts_with("/usr/lib/"))
}

fn directory(parent: &Path, name: &str) -> Result<PathBuf> {
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Candidate output must be a real directory, not a symlink or file.".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&path)?,
        Err(error) => return Err(error.into()),
    }
    Ok(path)
}

fn reset_candidate_child(output: &Path, name: &str) -> Result<PathBuf> {
    if !matches!(name, "Morrow Mail.app" | "Morrow.iconset") {
        return Err("Refusing to replace anything outside the fixed candidate outputs.".into());
    }
    let path = directory(output, name)?;
    fs::remove_dir_all(&path)?;
    fs::create_dir(&path)?;
    Ok(path)
}

fn google_oauth() -> Result<Option<Value>> {
    let file = env::var_os("MORROW_GOOGLE_OAUTH_FILE").filter(|value| !value.is_empty());
    let raw = env::var_os("MORROW_GOOGLE_OAUTH_JSON").filter(|value| !value.is_empty());
    if file.is_some() && raw.is_some() {
        return Err("Choose one Google OAuth build input.".into());
    }
    let value = if let Some(file) = file {
        Some(
            bundled_google_oauth(Path::new(&file))
                .map_err(|_| "Could not read a valid Google Desktop OAuth build input.")?
                .ok_or("Could not read the Google Desktop OAuth build input.")?,
        )
    } else if let Some(raw) = raw {
        Some(
            parse_google_oauth(
                raw.to_str()
                    .ok_or("Google Desktop OAuth input must be UTF-8.")?,
            )
            .map_err(|_| "Use a valid Google Desktop app OAuth JSON build input.")?,
        )
    } else {
        None
    };
    if value.is_none()
        && env::var_os("MORROW_REQUIRE_GOOGLE_OAUTH").is_some_and(|value| value == "1")
    {
        return Err("This candidate requires a Google Desktop OAuth build input.".into());
    }
    Ok(value.map(|value| json!({"installed":{"client_id":value["clientId"],"client_secret":value["clientSecret"]}})))
}

fn plist(version: &str) -> String {
    let short = version.split('-').next().unwrap();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Morrow Mail</string>
<key>CFBundleDisplayName</key><string>Morrow Mail</string>
<key>CFBundleIdentifier</key><string>org.morrowmail.desktop</string>
<key>CFBundleExecutable</key><string>MorrowMail</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>{short}</string>
<key>CFBundleVersion</key><string>{short}</string>
<key>MorrowReleaseVersion</key><string>{version}</string>
<key>MorrowServiceRuntime</key><string>rust</string>
<key>CFBundleIconFile</key><string>Morrow</string>
<key>LSMinimumSystemVersion</key><string>{MINIMUM}</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMultipleInstancesProhibited</key><true/>
<key>UTExportedTypeDeclarations</key><array><dict>
<key>UTTypeIdentifier</key><string>com.morrowmail.mail-row</string>
<key>UTTypeDescription</key><string>Morrow Mail message drag token</string>
<key>UTTypeConformsTo</key><array><string>public.data</string></array>
</dict></array>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>© 2026 Morrow Mail contributors. MIT License.</string>
</dict></plist>
"#
    )
}

fn zip_names(version: &str) -> (String, &'static str) {
    (
        format!("Morrow-Mail-{version}-macos-arm64.zip"),
        "SHA256SUMS-macos-arm64.txt",
    )
}

fn ensure_absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err("Candidate release output already exists; choose a new run after preserving or removing that generated directory. Nothing was overwritten.".into()),
    }
}

fn write_checksum(archive: &Path, checksum: &Path) -> Result<()> {
    let mut file = fs::File::open(archive)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid archive filename.")?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(checksum)?;
    writeln!(output, "{:x}  {name}", hash.finalize())?;
    output.sync_all()?;
    Ok(())
}

fn archive_candidate(root: &Path, application: &Path, release: &Path, version: &str) -> Result<()> {
    // The dedicated directory must be newly created: ditto never receives an
    // existing archive, and no historical build/release output is overwritten.
    fs::create_dir(release)?;
    let (archive_name, checksum_name) = zip_names(version);
    let archive = release.join(archive_name);
    run(command(root, "/usr/bin/ditto")
        .args(["-c", "-k", "--sequesterRsrc", "--keepParent"])
        .arg(application)
        .arg(&archive))?;
    write_checksum(&archive, &release.join(checksum_name))?;
    println!(
        "Packaged {} with its SHA-256 checksum. Local candidate only; nothing was published.",
        archive.display()
    );
    Ok(())
}

fn zip_option(arguments: &[std::ffi::OsString]) -> Result<bool> {
    match arguments {
        [platform] if platform == "macos" => Ok(false),
        [platform, flag] if platform == "macos" && flag == "--zip" => Ok(true),
        _ => Err("Usage: morrow-build macos [--zip]".into()),
    }
}

fn macos(root: &Path, zip: bool) -> Result<()> {
    if !cfg!(target_os = "macos") || env::consts::ARCH != "aarch64" {
        return Err(
            "Build the native macOS candidate on macOS arm64 with Apple's Swift tools.".into(),
        );
    }
    let metadata: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
    let version = version(&metadata)?;
    let google = google_oauth()?;
    let identity = env::var_os("MORROW_SIGNING_IDENTITY")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "-".into());
    let ad_hoc = identity == "-";
    let output = directory(&directory(root, "build")?, "macos-native")?;
    let release = output.join("release");
    if zip {
        ensure_absent(&release)?;
    }

    // Cargo reports actual executable locations, including a caller's target dir.
    let artifacts = capture(
        command(root, "cargo").args([
            "build",
            "--manifest-path",
            "rust/Cargo.toml",
            "--release",
            "--locked",
            "--target",
            TARGET,
            "--message-format=json-render-diagnostics",
            "--bin",
            "morrow-resources",
            "--bin",
            "morrow-notices",
            "--bin",
            "morrow-service",
        ]),
        16 * 1024 * 1024,
    )?;
    let mut binaries = std::collections::HashMap::new();
    for line in artifacts.lines() {
        let item: Value = serde_json::from_str(line)?;
        if item["reason"] == "compiler-artifact"
            && let (Some(name), Some(path)) =
                (item["target"]["name"].as_str(), item["executable"].as_str())
        {
            binaries.insert(name.to_owned(), PathBuf::from(path));
        }
    }
    let binary = |name: &str| {
        binaries
            .get(name)
            .ok_or("Cargo did not report a required build executable.")
    };
    run(command(root, binary("morrow-resources")?).arg("--check"))?;
    let service = binary("morrow-service")?;
    if capture(command(root, service).arg("--version"), 4096)?.trim()
        != format!("Morrow Mail {version}")
    {
        return Err("The Rust service and package versions differ.".into());
    }
    let libraries = capture(
        command(root, "/usr/bin/otool").arg("-L").arg(service),
        64 * 1024,
    )?;
    if !system_libraries(&libraries) {
        return Err(
            "The Rust service links libraries outside macOS and cannot be bundled portably.".into(),
        );
    }
    run(command(root, "cargo").args([
        "fetch",
        "--manifest-path",
        "rust/Cargo.toml",
        "--locked",
        "--target",
        TARGET,
    ]))?;
    let notices = capture(
        command(root, binary("morrow-notices")?).args(["--target", TARGET]),
        32 * 1024 * 1024,
    )?;
    if !notices.contains(TARGET) || !notices.contains("MPL-2.0") || !notices.contains("OpenCC") {
        return Err("Production Rust/OpenCC redistribution notices are incomplete.".into());
    }
    let swift_args = [
        "build",
        "--package-path",
        "macos",
        "-c",
        "release",
        "--triple",
        "arm64-apple-macosx13.5",
    ];
    run(command(root, "swift").args(swift_args))?;
    let bin = capture(
        command(root, "swift")
            .args(swift_args)
            .arg("--show-bin-path"),
        16 * 1024,
    )?;
    let ui = Path::new(bin.trim()).join("MorrowMail");
    for executable in [service.as_path(), ui.as_path()] {
        if capture(
            command(root, "/usr/bin/lipo").arg("-archs").arg(executable),
            4096,
        )?
        .trim()
            != "arm64"
        {
            return Err("Expected an arm64 candidate executable.".into());
        }
    }

    // All replacements are immediate, fixed children of the checked output root.
    let application = reset_candidate_child(&output, "Morrow Mail.app")?;
    let contents = directory(&application, "Contents")?;
    let resources = directory(&contents, "Resources")?;
    let backend = directory(&resources, "backend")?;
    let ui_target = directory(&contents, "MacOS")?.join("MorrowMail");
    let service_target = resources.join("morrow-service");
    fs::copy(ui, ui_target)?;
    fs::copy(service, &service_target)?;
    fs::write(resources.join("THIRD_PARTY_LICENSES.txt"), notices)?;
    for name in [
        "package.json",
        "LICENSE",
        "README.md",
        "FEATURE_COVERAGE.md",
        "VERIFICATION.md",
    ] {
        fs::copy(root.join(name), backend.join(name))?;
    }
    if let Some(google) = google {
        fs::write(
            backend.join("google-oauth.json"),
            serde_json::to_vec(&google)?,
        )?;
    }
    let iconset = reset_candidate_child(&output, "Morrow.iconset")?;
    run(command(root, "swift")
        .args([
            "scripts/render-macos-icon.swift",
            "assets/brand/morrow-icon.svg",
        ])
        .arg(&iconset))?;
    let icon = resources.join("Morrow.icns");
    run(command(root, "/usr/bin/iconutil")
        .args(["-c", "icns"])
        .arg(iconset)
        .arg("-o")
        .arg(&icon))?;
    if !icon.is_file() {
        return Err("App icon was not generated.".into());
    }
    let info = contents.join("Info.plist");
    fs::write(&info, plist(version))?;
    run(command(root, "/usr/bin/plutil").arg("-lint").arg(info))?;
    // Rust requires no JIT or unsigned-executable-memory entitlements.
    for target in [&service_target, &application] {
        let mut signing = command(root, "/usr/bin/codesign");
        signing.args(["--force", "--sign"]).arg(&identity);
        if !ad_hoc {
            signing.args(["--options", "runtime", "--timestamp"]);
        }
        run(signing.arg(target))?;
    }
    run(command(root, "/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&application))?;
    println!(
        "Built {}\nMinimum macOS: {MINIMUM}. Architecture: arm64. {}",
        application.display(),
        if ad_hoc {
            "Ad-hoc signed candidate; public distribution requires Developer ID signing and notarization."
        } else {
            "Signed candidate; notarize before public distribution."
        }
    );
    if zip {
        archive_candidate(root, &application, &release, version)?;
    }
    Ok(())
}

fn main() -> ExitCode {
    let result = (|| {
        let zip = zip_option(&env::args_os().skip(1).collect::<Vec<_>>())?;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Missing repository root.")?
            .canonicalize()?;
        macos(&root, zip)
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zip_option_names_checksums_and_existing_outputs_are_exact() {
        assert!(!zip_option(&["macos".into()]).unwrap());
        assert!(zip_option(&["macos".into(), "--zip".into()]).unwrap());
        assert!(zip_option(&["macos".into(), "--zip".into(), "other".into()]).is_err());
        assert!(zip_option(&["windows".into()]).is_err());
        let root = env::temp_dir().join(format!("morrow-archive-check-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let (name, checksum) = zip_names("0.6.0-beta.16");
        assert_eq!(name, "Morrow-Mail-0.6.0-beta.16-macos-arm64.zip");
        assert_eq!(checksum, "SHA256SUMS-macos-arm64.txt");
        let archive = root.join(&name);
        let checksum = root.join(checksum);
        // Hash framing/no-overwrite check only; this is deliberately not a ZIP
        // acceptance test or a substitute for a real ditto candidate run.
        fs::write(&archive, b"abc").unwrap();
        write_checksum(&archive, &checksum).unwrap();
        let expected =
            format!("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  {name}\n");
        assert_eq!(fs::read_to_string(&checksum).unwrap(), expected);
        assert!(write_checksum(&archive, &checksum).is_err());
        assert_eq!(fs::read_to_string(&checksum).unwrap(), expected);
        assert!(ensure_absent(&root).is_err());
        assert!(ensure_absent(&archive).is_err());
        assert!(ensure_absent(&root.join("missing")).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn package_values_and_system_library_boundary() {
        assert_eq!(
            version(&json!({"version":"0.6.0-beta.16"})).unwrap(),
            "0.6.0-beta.16"
        );
        assert!(version(&json!({"version":"1.0.0</string>"})).is_err());
        assert!(system_libraries(
            "service:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/Security.framework/Security (compatibility version 1.0.0)\n"
        ));
        assert!(!system_libraries(
            "service:\n\t/opt/homebrew/lib/libssl.dylib (compatibility version 1.0.0)\n"
        ));
        assert!(!system_libraries(
            "service:\n\t@rpath/libssl.dylib (compatibility version 1.0.0)\n"
        ));
        assert!(!system_libraries("service:\n"));
        let info = plist("0.6.0-beta.16");
        assert!(info.contains("<key>MorrowServiceRuntime</key><string>rust</string>"));
        assert!(info.contains("<key>LSMinimumSystemVersion</key><string>13.5</string>"));
        assert!(info.contains("<key>UTExportedTypeDeclarations</key><array><dict>"));
        assert!(
            info.contains("<key>UTTypeIdentifier</key><string>com.morrowmail.mail-row</string>")
        );
        assert!(
            info.contains("<key>UTTypeConformsTo</key><array><string>public.data</string></array>")
        );
        assert!(!info.contains("allow-jit"));
    }
}
