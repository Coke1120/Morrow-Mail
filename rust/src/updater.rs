//! Signed, host-owned desktop updates. The helper is a copy of this executable;
//! neither a renderer nor downloaded content supplies commands or destinations.
use crate::{
    cli,
    error::{Error, Result},
    service::{App, Context},
    store::{now, string},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, watch},
    task::JoinHandle,
};

pub const VERSION: &str = env!("MORROW_VERSION");
pub const PUBLIC_KEY: &str = include_str!("../resources/update-public-key.pem");
pub const ARCHIVE_LIMIT: u64 = 750 * 1024 * 1024;
const PLATFORMS: [&str; 2] = ["macos-arm64", "windows-x64"];
const REPOSITORY: &str = "https://github.com/Coke1120/Morrow-Mail";
const DOWNLOAD_ERROR: &str = "Could not download or verify the update. No app files were changed. Try again or use the release downloads.";
fn fail(message: &str) -> Error {
    Error::conflict(message)
}
fn host_platform() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(PLATFORMS[0])
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(PLATFORMS[1])
    } else {
        None
    }
}
fn regex(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern)
        .expect("static update regex")
        .is_match(text)
}

// Decimal comparison preserves Node's BigInt SemVer behavior without a numeric limit.
fn decimal(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then(a.cmp(b))
}
#[derive(Eq, PartialEq)]
struct Version {
    core: Vec<String>,
    pre: Vec<String>,
}
impl Version {
    fn parse(text: &str) -> Option<Self> {
        if text.len() > 100 {
            return None;
        }
        let expression = regex::Regex::new(r"^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$").unwrap();
        let captures = expression.captures(text)?;
        let pre: Vec<String> = captures
            .get(4)
            .map(|p| p.as_str().split('.').map(str::to_owned).collect())
            .unwrap_or_default();
        if pre
            .iter()
            .any(|p| p.bytes().all(|b| b.is_ascii_digit()) && p.len() > 1 && p.starts_with('0'))
        {
            return None;
        }
        Some(Self {
            core: (1..=3).map(|i| captures[i].to_owned()).collect(),
            pre,
        })
    }
    fn compare(&self, other: &Self) -> Ordering {
        for (a, b) in self.core.iter().zip(&other.core) {
            let order = decimal(a, b);
            if order != Ordering::Equal {
                return order;
            }
        }
        if self.pre.is_empty() || other.pre.is_empty() {
            return self.pre.is_empty().cmp(&other.pre.is_empty());
        }
        for (a, b) in self.pre.iter().zip(&other.pre) {
            let numeric = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            let order = match (numeric(a), numeric(b)) {
                (true, true) => decimal(a, b),
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => a.cmp(b),
            };
            if order != Ordering::Equal {
                return order;
            }
        }
        self.pre.len().cmp(&other.pre.len())
    }
}
pub fn select_release(
    releases: &Value,
    installed: &str,
    include_prereleases: bool,
) -> Result<Value> {
    let local = Version::parse(installed)
        .ok_or_else(|| Error::new(502, "The installed version is not recognized."))?;
    let releases = releases.as_array().ok_or_else(|| {
        Error::new(
            502,
            "Could not check GitHub for updates. Check your connection and try again.",
        )
    })?;
    let (item, latest) = releases.iter().rev().filter(|item| item["draft"] != true).filter_map(|item| Version::parse(string(item,"tag_name")).map(|parsed| (item,parsed)))
        .filter(|(item,parsed)| include_prereleases || (item["prerelease"] != true && parsed.pre.is_empty())).max_by(|a,b| a.1.compare(&b.1))
        .ok_or_else(|| Error::new(404,"No published releases were found for this channel. Try including alpha and beta releases."))?;
    let tag = string(item, "tag_name");
    Ok(
        json!({"currentVersion":installed,"latestVersion":tag.strip_prefix('v').unwrap_or(tag),"updateAvailable":latest.compare(&local)==Ordering::Greater,"prerelease":item["prerelease"]==true || !latest.pre.is_empty(),"url":format!("{REPOSITORY}/releases/tag/{}",crate::providers::component(tag)),"checkedAt":now()}),
    )
}
async fn check_updates(client: &reqwest::Client, prereleases: bool) -> Result<Value> {
    let result = async {
        let response = client
            .get("https://api.github.com/repos/Coke1120/Morrow-Mail/releases?per_page=100")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Morrow-Mail-update-check")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| Error::new(502, "Update check failed."))?;
        if matches!(response.status().as_u16(), 403 | 429) {
            return Err(Error::new(
                503,
                "GitHub temporarily limited update checks. Try again later.",
            ));
        }
        if !response.status().is_success() {
            return Err(Error::new(502, "Update check failed."));
        }
        let bytes = limited(response, 4 * 1024 * 1024).await?;
        let releases: Value = serde_json::from_slice(&bytes)?;
        if !releases.is_array() {
            return Err(Error::new(502, "Update check failed."));
        }
        Ok(releases)
    }
    .await
    .map_err(|error: Error| {
        if error.status == 503 {
            error
        } else {
            Error::new(
                502,
                "Could not check GitHub for updates. Check your connection and try again.",
            )
        }
    })?;
    select_release(&result, VERSION, prereleases)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub platforms: std::collections::BTreeMap<String, Asset>,
}
pub fn verify_manifest(
    bytes: &[u8],
    signature: &str,
    version: &str,
    key: &str,
) -> Result<Manifest> {
    let signature = signature.trim();
    if bytes.len() > 16384 || !regex(r"^[A-Za-z0-9+/]{86}==$", signature) {
        return Err(fail("The update signature could not be verified."));
    }
    let key = VerifyingKey::from_public_key_pem(key)
        .map_err(|_| fail("The update signature could not be verified."))?;
    let raw = STANDARD
        .decode(signature)
        .map_err(|_| fail("The update signature could not be verified."))?;
    let signature = Signature::from_slice(&raw)
        .map_err(|_| fail("The update signature could not be verified."))?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| fail("The update signature could not be verified."))?;
    let value: Manifest = serde_json::from_slice(bytes)
        .map_err(|_| fail("The signed update manifest is invalid."))?;
    if value.version != version
        || !regex(
            r"^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta)\.[0-9]+)?$",
            version,
        )
    {
        return Err(fail("The update version does not match."));
    }
    for platform in PLATFORMS {
        let item = value
            .platforms
            .get(platform)
            .ok_or_else(|| fail("The signed update manifest is invalid."))?;
        if item.name != format!("Morrow-Mail-{version}-{platform}.zip")
            || !regex(r"^[a-f0-9]{64}$", &item.sha256)
            || !(1..=ARCHIVE_LIMIT).contains(&item.size)
        {
            return Err(fail("The signed update manifest is invalid."));
        }
    }
    Ok(value)
}
pub fn trusted_asset_url(text: &str) -> Result<url::Url> {
    let url = url::Url::parse(text).map_err(|_| fail("Untrusted update download destination."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|p| p != 443)
        || !matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
    {
        return Err(fail("Untrusted update download destination."));
    }
    Ok(url)
}
async fn release_asset(client: &reqwest::Client, text: &str) -> Result<reqwest::Response> {
    let mut url = trusted_asset_url(text)?;
    for _ in 0..6 {
        let response = client
            .get(url.clone())
            .timeout(Duration::from_secs(15 * 60))
            .send()
            .await
            .map_err(|_| fail(DOWNLOAD_ERROR))?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| fail("Untrusted update download destination."))?;
            url = trusted_asset_url(
                url.join(location)
                    .map_err(|_| fail("Untrusted update download destination."))?
                    .as_str(),
            )?;
        } else if response.status().is_success() {
            return Ok(response);
        } else {
            return Err(fail(
                "The update files are not available. Use the release downloads or try again later.",
            ));
        }
    }
    Err(fail("Too many update download redirects."))
}
async fn limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(fail("The update metadata is too large."));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fail(DOWNLOAD_ERROR))? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(fail("The update metadata is too large."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn u16le(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn archive_read(file: &mut File, size: u64, at: u64, length: usize) -> Result<Vec<u8>> {
    if at.checked_add(length as u64).is_none_or(|end| end > size) {
        return Err(fail("Invalid update archive."));
    }
    let mut bytes = vec![0; length];
    file.seek(SeekFrom::Start(at))?;
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn safe_name(name: &str, root: &str) -> bool {
    !name.contains(['\\', '\0', ':'])
        && !name.starts_with('/')
        && (name == root || name.starts_with(&format!("{root}/")) || name.starts_with("__MACOSX/"))
        && name.trim_end_matches('/').split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty()
                && part != ".."
                && part != "."
                && !part.ends_with(['.', ' '])
                && !part.chars().any(|c| c.is_control())
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}
fn link_destination(name: &str, link: &str, root: &str) -> bool {
    if link.is_empty() || link.starts_with('/') || link.contains(['\\', ':', '\0']) {
        return false;
    }
    let mut path: Vec<&str> = name.split('/').collect();
    path.pop();
    for part in link.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if path.pop().is_none() {
                    return false;
                }
            }
            _ => path.push(part),
        }
    }
    safe_name(&path.join("/"), root) && path.first().copied() == Some(root)
}
/// Bounds and names are checked before the native extractor can write anything.
/// ZIP64 is deliberately unsupported, matching the existing release format.
pub fn inspect_archive(path: &Path, root: &str) -> Result<()> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    if size > ARCHIVE_LIMIT {
        return Err(fail("The update download exceeds its signed size."));
    }
    let tail = archive_read(
        &mut file,
        size,
        size.saturating_sub(65557),
        size.min(65557) as usize,
    )?;
    let end = (0..=tail.len().saturating_sub(22))
        .rev()
        .find(|&i| {
            i + 22 <= tail.len()
                && u32le(&tail, i) == 0x06054b50
                && i + 22 + u16le(&tail, i + 20) as usize == tail.len()
        })
        .ok_or_else(|| fail("Unsupported update archive."))?;
    if u32le(&tail, end + 4) != 0 {
        return Err(fail("Unsupported update archive."));
    }
    let count = u16le(&tail, end + 10);
    let length = u32le(&tail, end + 12) as usize;
    let offset = u32le(&tail, end + 16) as u64;
    if count == 0
        || count == 65535
        || length > 32 * 1024 * 1024
        || u16le(&tail, end + 8) != count
        || offset + length as u64 != size - tail.len() as u64 + end as u64
    {
        return Err(fail("Unsupported update archive."));
    }
    let central = archive_read(&mut file, size, offset, length)?;
    let mut cursor = 0;
    let mut expanded = 0u64;
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    let mut intervals = Vec::new();
    for _ in 0..count {
        if cursor + 46 > central.len() || u32le(&central, cursor) != 0x02014b50 {
            return Err(fail("Invalid update archive entries."));
        }
        let flags = u16le(&central, cursor + 8);
        let method = u16le(&central, cursor + 10);
        let packed = u32le(&central, cursor + 20) as u64;
        let unpacked = u32le(&central, cursor + 24) as u64;
        let n = u16le(&central, cursor + 28) as usize;
        let extra = u16le(&central, cursor + 30) as usize;
        let comment = u16le(&central, cursor + 32) as usize;
        if cursor + 46 + n + extra + comment > central.len() {
            return Err(fail("Invalid update archive entries."));
        }
        let bytes = &central[cursor + 46..cursor + 46 + n];
        let name = std::str::from_utf8(bytes).map_err(|_| fail("Unsafe update archive entry."))?;
        let kind = (u32le(&central, cursor + 38) >> 16) & 0xf000;
        if !safe_name(name, root)
            || !seen.insert(name.trim_end_matches('/').to_lowercase())
            || flags & 1 != 0
            || ![0, 8].contains(&method)
            || ![0, 0x4000, 0x8000, 0xa000].contains(&kind)
            || u16le(&central, cursor + 34) != 0
        {
            return Err(fail("Unsafe update archive entry."));
        }
        expanded += unpacked;
        if expanded > 4 * 1024 * 1024 * 1024 || unpacked > ARCHIVE_LIMIT {
            return Err(fail("The expanded update is too large."));
        }
        let local_offset = u32le(&central, cursor + 42) as u64;
        let local = archive_read(&mut file, size, local_offset, 30)?;
        let data_offset = local_offset + 30 + u16le(&local, 26) as u64 + u16le(&local, 28) as u64;
        if data_offset + packed > offset {
            return Err(fail("Invalid update archive offsets."));
        }
        if u32le(&local, 0) != 0x04034b50
            || u16le(&local, 8) != method
            || u16le(&local, 6) != flags
            || archive_read(
                &mut file,
                size,
                local_offset + 30,
                u16le(&local, 26) as usize,
            )? != bytes
        {
            return Err(fail("Inconsistent update archive entry."));
        }
        intervals.push((local_offset, data_offset + packed));
        if kind == 0xa000 {
            if packed > 8192 || unpacked > 4096 || name.ends_with('/') {
                return Err(fail("Unsafe update symlink."));
            }
            let data = archive_read(&mut file, size, data_offset, packed as usize)?;
            let decoded = if method == 8 {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(&data[..])
                    .take(4097)
                    .read_to_end(&mut out)?;
                out
            } else {
                data
            };
            let link = std::str::from_utf8(&decoded).map_err(|_| fail("Unsafe update symlink."))?;
            if decoded.len() as u64 != unpacked || !link_destination(name, link, root) {
                return Err(fail("Unsafe update symlink."));
            }
            links.push(name.to_lowercase());
        }
        cursor += 46 + n + extra + comment;
    }
    if cursor != central.len() {
        return Err(fail("Invalid update archive directory."));
    }
    intervals.sort_unstable();
    if intervals.windows(2).any(|p| p[0].1 > p[1].0) {
        return Err(fail("Invalid update archive offsets."));
    }
    if links.iter().any(|link| {
        seen.iter()
            .any(|name| name.starts_with(&format!("{link}/")))
    }) {
        return Err(fail("Unsafe update symlink."));
    }
    Ok(())
}

pub fn package_paths(target: &Path, platform: &str) -> Result<(PathBuf, PathBuf)> {
    match platform {
        "macos-arm64" => Ok((
            target.join("Contents/Resources/backend"),
            target.join("Contents/MacOS/MorrowMail"),
        )),
        "windows-x64" => Ok((
            target.join("resources/app/backend"),
            target.join("Morrow Mail.exe"),
        )),
        _ => Err(fail("Unsupported update platform.")),
    }
}
fn clean_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("LD_PRELOAD")
        .env_remove("DYLD_INSERT_LIBRARIES");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.kill_on_drop(true);
    command
}
async fn cancellable<T>(
    cancel: &mut watch::Receiver<bool>,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    if *cancel.borrow() {
        return Err(fail("Cancelled"));
    }
    tokio::select! {biased; _=cancel.changed()=>Err(fail("Cancelled")), result=work=>result}
}
async fn command_output(command: &mut Command, seconds: u64) -> Result<Vec<u8>> {
    command_output_cancellable(command, seconds, None).await
}
async fn command_output_cancellable(
    command: &mut Command,
    seconds: u64,
    mut cancel: Option<&mut watch::Receiver<bool>>,
) -> Result<Vec<u8>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| fail(DOWNLOAD_ERROR))?
        .take(16385);
    let work = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() > 16384 || !child.wait().await?.success() {
            return Err(fail("The downloaded app could not be verified."));
        }
        Ok(bytes)
    };
    let result = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(seconds),work)=>result.unwrap_or_else(|_|Err(fail("The update verification timed out."))),
        _=async {if let Some(cancel)=cancel.as_mut() {if !*cancel.borrow(){let _=cancel.changed().await;}}else{std::future::pending::<()>().await;}}=>Err(fail("Cancelled")),
    };
    // Wait for extraction to die before its staging directory can be removed.
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}
fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}
fn ps_command(script: &str) -> Command {
    let mut command = clean_command(powershell());
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &STANDARD.encode(bytes),
    ]);
    command
}
fn private_directory(path: &Path) -> Result<()> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(path)?;
    Ok(())
}
async fn protect_directory(path: &Path) -> Result<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || crate::store::private(&path, true))
        .await
        .map_err(|_| fail(DOWNLOAD_ERROR))?
}
async fn read_limited_file(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    if file.metadata().await?.len() > limit as u64 {
        return Err(fail("The update metadata is too large."));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > limit {
        return Err(fail("The update metadata is too large."));
    }
    Ok(bytes)
}
fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn save_private(path: &Path, data: &[u8]) -> Result<()> {
    let mut file = private_file(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}
fn check_tree(target: &Path) -> Result<()> {
    fn visit(directory: &Path, root: &Path) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let child = entry.path();
            let actual = fs::canonicalize(&child)?;
            if !actual.starts_with(root) {
                return Err(fail("The update contains an unsafe link."));
            }
            if entry.file_type()?.is_dir() {
                visit(&child, root)?;
            }
        }
        Ok(())
    }
    if fs::symlink_metadata(target)?.file_type().is_symlink() {
        return Err(fail("The update contains an unsafe link."));
    }
    visit(target, &fs::canonicalize(target)?)
}
pub async fn validate_package(target: &Path, platform: &str, version: &str) -> Result<()> {
    let (backend, executable) = package_paths(target, platform)?;
    if !fs::symlink_metadata(executable)?.is_file()
        || serde_json::from_slice::<Value>(&fs::read(backend.join("package.json"))?)?["version"]
            != version
    {
        return Err(fail(
            "The downloaded app is incomplete or has the wrong version.",
        ));
    }
    let target_owned = target.to_owned();
    tokio::task::spawn_blocking(move || check_tree(&target_owned))
        .await
        .map_err(|_| fail(DOWNLOAD_ERROR))??;
    if platform == "macos-arm64" {
        command_output(
            clean_command("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(target),
            60,
        )
        .await?;
        let minimum = command_output(
            clean_command("/usr/bin/plutil")
                .args(["-extract", "LSMinimumSystemVersion", "raw", "-o", "-"])
                .arg(target.join("Contents/Info.plist")),
            15,
        )
        .await?;
        let current =
            command_output(clean_command("/usr/bin/sw_vers").arg("-productVersion"), 15).await?;
        let minimum = String::from_utf8_lossy(&minimum);
        let minimum = minimum.trim();
        let current = String::from_utf8_lossy(&current);
        let numbers = |v: &str| {
            v.trim()
                .split('.')
                .map(|s| s.parse::<u64>().unwrap_or(u64::MAX))
                .chain([0, 0, 0])
                .take(3)
                .collect::<Vec<_>>()
        };
        if !regex(r"^[0-9]+(?:\.[0-9]+){0,2}$", minimum) || numbers(minimum) > numbers(&current) {
            return Err(fail("The update requires a newer macOS version."));
        }
    }
    Ok(())
}
async fn extract(
    directory: &Path,
    platform: &str,
    cancel: Option<&mut watch::Receiver<bool>>,
) -> Result<PathBuf> {
    let root = if platform == "macos-arm64" {
        "Morrow Mail.app"
    } else {
        "Morrow Mail-win32-x64"
    };
    let path = directory.join("update.zip");
    let path_owned = path.clone();
    tokio::task::spawn_blocking(move || inspect_archive(&path_owned, root))
        .await
        .map_err(|_| fail(DOWNLOAD_ERROR))??;
    let extraction = directory.join("extracted");
    private_directory(&extraction)?;
    if platform == "macos-arm64" {
        command_output_cancellable(
            clean_command("/usr/bin/ditto")
                .args(["-x", "-k"])
                .arg(path)
                .arg(&extraction),
            120,
            cancel,
        )
        .await?;
    } else {
        // Keep the verified canonical paths internally. Legacy Windows PowerShell
        // archive APIs do not consistently accept Rust's \\?\ verbatim prefix;
        // these fixed relative names resolve inside the owned staging directory.
        command_output_cancellable(
            ps_command("$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath 'update.zip' -DestinationPath 'extracted'")
                .current_dir(directory),
            120,
            cancel,
        )
        .await?;
    }
    Ok(extraction.join(root))
}

#[derive(Clone)]
pub struct Updater(Arc<UpdaterInner>);
struct UpdaterInner {
    data: PathBuf,
    target: Option<PathBuf>,
    parent: AtomicU32,
    token_valid: bool,
    state: Mutex<UpdateState>,
    checks: [Mutex<Option<(Instant, Value)>>; 2],
}
struct UpdateState {
    value: Value,
    directory: Option<PathBuf>,
    cancel: Option<watch::Sender<bool>>,
    job: Option<JoinHandle<()>>,
}
impl Updater {
    pub fn new(directory: &Path, parent: Option<u32>, token: &str) -> Self {
        let target = std::env::current_exe()
            .ok()
            .and_then(|exe| fs::canonicalize(exe).ok())
            .and_then(|exe| {
                let relative = if host_platform()? == "macos-arm64" {
                    "Contents/Resources/morrow-service"
                } else {
                    "resources/app/runtime/morrow-service.exe"
                };
                let mut target = exe.clone();
                for _ in Path::new(relative).components() {
                    target.pop();
                }
                if target.join(relative) != exe {
                    return None;
                }
                let actual = fs::canonicalize(&target).ok()?;
                let data = fs::canonicalize(directory).ok()?;
                if data.starts_with(&actual)
                    || fs::symlink_metadata(&target).ok()?.file_type().is_symlink()
                {
                    return None;
                }
                Some(target)
            });
        Self(Arc::new(UpdaterInner {
            data: directory.to_owned(),
            target,
            parent: AtomicU32::new(parent.unwrap_or(0)),
            token_valid: regex(r"^[a-f0-9]{64}$", token),
            state: Mutex::new(UpdateState {
                value: json!({"phase":"idle","received":0,"total":0}),
                directory: None,
                cancel: None,
                job: None,
            }),
            checks: [Mutex::new(None), Mutex::new(None)],
        }))
    }
    pub fn configure(&self, parent: u32) {
        self.0.parent.store(
            if (2..=i32::MAX as u32).contains(&parent) {
                parent
            } else {
                0
            },
            AtomicOrdering::Release,
        );
    }
    fn supported(&self) -> bool {
        self.0.target.is_some()
            && self.0.token_valid
            && self.0.parent.load(AtomicOrdering::Acquire) > 1
    }
    async fn status_value(&self, value: &Value) -> Value {
        let mut value = value.clone();
        value["supported"] = self.supported().into();
        if let Ok(bytes) = read_limited_file(&self.0.data.join("update-result.json"), 4096).await
            && bytes.len() <= 4096
            && let Ok(previous) = serde_json::from_slice::<Value>(&bytes)
        {
            if previous["status"] == "installed" && previous["version"].is_string() {
                value["previous"] = format!("Updated to {}.", string(&previous, "version")).into();
            } else if previous["status"] == "error" {
                value["previous"]="The last update did not complete. Your previous app was retained; try again or use the release downloads.".into();
            }
        }
        value
    }
    pub async fn status(&self) -> Value {
        self.status_value(&self.0.state.lock().await.value).await
    }
    pub async fn check(&self, client: &reqwest::Client, prereleases: bool) -> Result<Value> {
        let mut cache = self.0.checks[usize::from(prereleases)].lock().await;
        if let Some((at, value)) = &*cache
            && at.elapsed() < Duration::from_secs(60)
        {
            return Ok(value.clone());
        }
        *cache = None;
        let result = check_updates(client, prereleases).await?;
        *cache = Some((Instant::now(), result.clone()));
        Ok(result)
    }
    pub async fn start(&self, client: reqwest::Client, prereleases: bool) -> Result<Value> {
        self.start_trusted(client, prereleases, PUBLIC_KEY).await
    }
    async fn start_trusted(
        &self,
        client: reqwest::Client,
        prereleases: bool,
        key: &str,
    ) -> Result<Value> {
        if !self.supported() {
            return Err(fail(
                "In-app installation is available only in packaged desktop builds.",
            ));
        }
        let mut state = self.0.state.lock().await;
        if state.cancel.is_some() || state.value["phase"] == "installing" {
            return Err(fail("An update operation is already running."));
        }
        if let Some(directory) = state.directory.take() {
            tokio::fs::remove_dir_all(directory).await?;
        }
        state.value = json!({"phase":"checking","received":0,"total":0});
        let (cancel, mut cancelled) = watch::channel(false);
        state.cancel = Some(cancel.clone());
        let updater = self.clone();
        let key = key.to_owned();
        state.job = Some(tokio::spawn(async move {
            let timer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15 * 60)).await;
                let _ = cancel.send(true);
            });
            let outcome = updater
                .download(&client, prereleases, &key, &mut cancelled)
                .await;
            timer.abort();
            let mut state = updater.0.state.lock().await;
            if let Err(error) = outcome {
                if let Some(directory) = state.directory.take() {
                    let _ = tokio::fs::remove_dir_all(directory).await;
                }
                state.value = if *cancelled.borrow() {
                    json!({"phase":"idle","received":0,"total":0})
                } else {
                    json!({"phase":"error","received":0,"total":0,"error":error.to_string()})
                };
            }
            state.cancel = None;
        }));
        Ok(self.status_value(&state.value).await)
    }
    async fn download(
        &self,
        client: &reqwest::Client,
        prereleases: bool,
        key: &str,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<()> {
        let latest = cancellable(cancel, check_updates(client, prereleases)).await?;
        self.download_release(client, &latest, key, cancel).await
    }
    async fn download_release(
        &self,
        client: &reqwest::Client,
        latest: &Value,
        key: &str,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<()> {
        if latest["updateAvailable"] != true {
            return Err(fail("No newer release is available for this channel."));
        }
        let version = string(latest, "latestVersion");
        let base = format!(
            "{REPOSITORY}/releases/download/v{}/",
            crate::providers::component(version)
        );
        let (bytes, signature) = cancellable(cancel, async {
            let bytes = limited(
                release_asset(client, &format!("{base}update-manifest.json")).await?,
                16384,
            )
            .await?;
            let signature = limited(
                release_asset(client, &format!("{base}update-manifest.sig")).await?,
                256,
            )
            .await?;
            Ok((bytes, signature))
        })
        .await?;
        let signature = std::str::from_utf8(&signature).map_err(|_| fail(DOWNLOAD_ERROR))?;
        let manifest = verify_manifest(&bytes, signature, version, key)?;
        let platform = host_platform().ok_or_else(|| fail(DOWNLOAD_ERROR))?;
        let asset = &manifest.platforms[platform];
        let parent = self
            .0
            .target
            .as_ref()
            .and_then(|target| target.parent())
            .ok_or_else(|| fail(DOWNLOAD_ERROR))?;
        let directory = parent.join(format!(".morrow-update-{}", uuid::Uuid::new_v4()));
        private_directory(&directory).map_err(|_|fail("This installation folder is not writable. Use the manual release download to update this copy."))?;
        {
            let mut state = self.0.state.lock().await;
            state.directory = Some(directory.clone());
            state.value =
                json!({"phase":"downloading","version":version,"received":0,"total":asset.size});
        }
        protect_directory(&directory).await?;
        save_private(&directory.join("update-manifest.json"), &bytes)?;
        save_private(&directory.join("update-manifest.sig"), signature.as_bytes())?;
        let path = directory.join("update.zip");
        let mut output = tokio::fs::File::from_std(private_file(&path)?);
        let mut hash = Sha256::new();
        let mut received = 0u64;
        let mut response = cancellable(
            cancel,
            release_asset(client, &format!("{base}{}", asset.name)),
        )
        .await?;
        if response.content_length().is_some_and(|n| n != asset.size) {
            return Err(fail(
                "The update checksum does not match. No app files were changed.",
            ));
        }
        while let Some(chunk) = cancellable(cancel, async {
            response.chunk().await.map_err(|_| fail(DOWNLOAD_ERROR))
        })
        .await?
        {
            received += chunk.len() as u64;
            if received > asset.size {
                return Err(fail("The update download exceeds its signed size."));
            }
            hash.update(&chunk);
            output.write_all(&chunk).await?;
            self.0.state.lock().await.value["received"] = received.into();
        }
        output.sync_all().await?;
        drop(output);
        if received != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err(fail(
                "The update checksum does not match. No app files were changed.",
            ));
        }
        self.0.state.lock().await.value["phase"] = "verifying".into();
        let staged = extract(&directory, platform, Some(cancel)).await?;
        validate_package(&staged, platform, version).await?;
        if *cancel.borrow() {
            return Err(fail("Cancelled"));
        }
        self.0.state.lock().await.value["phase"] = "ready".into();
        Ok(())
    }
    pub async fn cancel(&self) -> Result<Value> {
        let mut state = self.0.state.lock().await;
        if state.value["phase"] == "installing" {
            return Err(fail("The app is restarting to install the update."));
        }
        if let Some(cancel) = &state.cancel {
            let _ = cancel.send(true);
        } else {
            if let Some(directory) = state.directory.take() {
                tokio::fs::remove_dir_all(directory).await?;
            }
            state.value = json!({"phase":"idle","received":0,"total":0});
        }
        Ok(self.status_value(&state.value).await)
    }
    pub async fn prepare(&self) -> Result<Value> {
        let mut state = self.0.state.lock().await;
        if !self.supported() || state.value["phase"] != "ready" || state.cancel.is_some() {
            return Err(fail("Download and verify an update before installing it."));
        }
        let directory = state
            .directory
            .as_ref()
            .ok_or_else(|| fail(DOWNLOAD_ERROR))?;
        let platform = host_platform().unwrap();
        let root = if platform == "macos-arm64" {
            "Morrow Mail.app"
        } else {
            "Morrow Mail-win32-x64"
        };
        let helper = directory.join(format!(
            "update-helper-{}{}",
            uuid::Uuid::new_v4(),
            if cfg!(windows) { ".exe" } else { "" }
        ));
        let copy = helper.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut source = File::open(std::env::current_exe()?)?;
            let mut output = private_file(&copy)?;
            std::io::copy(&mut source, &mut output)?;
            output.sync_all()?;
            Ok(())
        })
        .await
        .map_err(|_| fail(DOWNLOAD_ERROR))??;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o700))?;
        }
        let config = InstallConfig {
            directory: directory.clone(),
            root: root.into(),
            platform: platform.into(),
            target: self.0.target.clone().unwrap(),
            staged: directory.join("extracted").join(root),
            backup: directory.join("previous"),
            version: string(&state.value, "version").into(),
            installed_version: VERSION.into(),
            pids: [
                self.0.parent.load(AtomicOrdering::Acquire),
                std::process::id(),
            ],
            result_file: self.0.data.join("update-result.json"),
        };
        save_private(
            &directory.join("update-target.json"),
            &serde_json::to_vec(&config.target)?,
        )?;
        let mut command = clean_command(&helper);
        command
            .arg("--update-installer")
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000 | 0x00000008 | 0x00000200);
        let mut child = command.spawn()?;
        let ready = async {
            let mut input = child.stdin.take().ok_or_else(|| fail(DOWNLOAD_ERROR))?;
            input.write_all(&serde_json::to_vec(&config)?).await?;
            input.shutdown().await?;
            drop(input);
            let stdout = child.stdout.take().ok_or_else(|| fail(DOWNLOAD_ERROR))?;
            let mut reader = BufReader::new(stdout).take(1024);
            let mut line = String::new();
            reader.read_line(&mut line).await?;
            if line != "ready\n" {
                return Err(fail("Invalid update installer response."));
            }
            Ok(())
        };
        match tokio::time::timeout(Duration::from_secs(15), ready).await {
            Ok(Ok(())) => {}
            outcome => {
                let _ = child.kill().await;
                let _ = tokio::fs::remove_file(helper).await;
                return Err(match outcome {
                    Ok(Err(error)) => error,
                    _ => fail("The update installer did not become ready."),
                });
            }
        }
        // kill_on_drop(false) leaves the detached helper alive after host/service exit.
        drop(child);
        state.value["phase"] = "installing".into();
        Ok(self.status_value(&state.value).await)
    }
    pub async fn stop(&self) {
        let job = {
            let mut state = self.0.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
            state.job.take()
        };
        if let Some(job) = job {
            let _ = job.await;
        }
        let mut state = self.0.state.lock().await;
        if state.value["phase"] != "installing"
            && let Some(directory) = state.directory.take()
        {
            let _ = tokio::fs::remove_dir_all(directory).await;
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallConfig {
    pub directory: PathBuf,
    pub root: String,
    pub platform: String,
    pub target: PathBuf,
    pub staged: PathBuf,
    pub backup: PathBuf,
    pub version: String,
    pub installed_version: String,
    pub pids: [u32; 2],
    pub result_file: PathBuf,
}
fn validate_install_paths(config: &InstallConfig) -> Result<()> {
    let root = match config.platform.as_str() {
        "macos-arm64" => "Morrow Mail.app",
        "windows-x64" => "Morrow Mail-win32-x64",
        _ => return Err(fail("Unsupported update platform.")),
    };
    if config.root != root
        || !config.directory.is_absolute()
        || !config.target.is_absolute()
        || config.directory.parent() != config.target.parent()
        || config.directory == config.target
        || config.staged != config.directory.join("extracted").join(root)
        || config.backup != config.directory.join("previous")
        || config
            .directory
            .file_name()
            .is_none_or(|name| !name.to_string_lossy().starts_with(".morrow-update-"))
        || config
            .pids
            .iter()
            .any(|&pid| pid <= 1 || pid > i32::MAX as u32 || pid == std::process::id())
        || config.pids[0] == config.pids[1]
    {
        return Err(fail("Invalid update installation paths."));
    }
    for path in [&config.target, &config.directory] {
        if fs::symlink_metadata(path)?.file_type().is_symlink() || fs::canonicalize(path)? != *path
        {
            return Err(fail("Invalid update installation paths."));
        }
    }
    let data = config
        .result_file
        .parent()
        .ok_or_else(|| fail("Invalid update result path."))?;
    let data = fs::canonicalize(data)?;
    if config
        .result_file
        .file_name()
        .is_none_or(|name| name != "update-result.json")
        || data.starts_with(&config.target)
        || data.starts_with(&config.directory)
        || !config.result_file.is_absolute()
        || fs::symlink_metadata(&config.result_file).is_ok_and(|m| !m.is_file())
    {
        return Err(fail("Invalid update result path."));
    }
    Ok(())
}
pub async fn replace_and_launch<F, Fut>(config: &InstallConfig, launch: F) -> Result<()>
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    validate_install_paths(config)?;
    if fs::symlink_metadata(&config.backup).is_ok() {
        return Err(fail("The previous app backup already exists."));
    }
    fs::rename(&config.target, &config.backup)?;
    let outcome = async {
        fs::rename(&config.staged, &config.target)?;
        launch(config.target.clone()).await
    }
    .await;
    if let Err(error) = outcome {
        if config.target.exists() {
            fs::rename(&config.target, &config.staged)?;
        }
        fs::rename(&config.backup, &config.target)?;
        return Err(error);
    }
    Ok(())
}
pub fn process_alive(pid: u32) -> bool {
    if pid <= 1 || pid > i32::MAX as u32 {
        return true;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        unsafe {
            use windows_sys::Win32::{
                Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_TIMEOUT},
                System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
            };
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let result = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            result == WAIT_TIMEOUT || result == u32::MAX
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}
#[cfg(windows)]
fn launched_service_handles(parent_pid: u32) -> Result<Vec<std::os::windows::io::OwnedHandle>> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{
            ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE},
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut handles = Vec::new();
    let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        let name_end = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        if entry.th32ParentProcessID == parent_pid
            && String::from_utf16_lossy(&entry.szExeFile[..name_end])
                .eq_ignore_ascii_case("morrow-service.exe")
        {
            let handle = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                    0,
                    entry.th32ProcessID,
                )
            };
            if handle.is_null() {
                if unsafe { GetLastError() } != ERROR_INVALID_PARAMETER {
                    return Err(std::io::Error::last_os_error().into());
                }
            } else {
                handles.push(unsafe { OwnedHandle::from_raw_handle(handle) });
            }
        }
        found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(handles)
}
#[cfg(windows)]
async fn wait_for_launched_service(parent_pid: u32) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{TerminateProcess, WaitForSingleObject},
    };
    // Retry enumeration rather than roll back while a service may still hold app files or the workspace.
    let handles = loop {
        match launched_service_handles(parent_pid) {
            Ok(handles) => break handles,
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    };
    for handle in handles {
        let deadline = Instant::now() + Duration::from_secs(140);
        loop {
            let state = unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) };
            if state == WAIT_OBJECT_0 {
                break;
            }
            if state != WAIT_TIMEOUT || Instant::now() >= deadline {
                unsafe { TerminateProcess(handle.as_raw_handle(), 1) };
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}
fn launch_app(target: &Path, platform: &str, workspace: &Path) -> Result<Child> {
    let (_, executable) = package_paths(target, platform)?;
    let mut command = clean_command(executable);
    command
        .current_dir(target)
        .env("MORROW_DATA_DIR", workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x00000008 | 0x00000200);
    Ok(command.spawn()?)
}
async fn wait_for_ready<F, Fut>(child: &mut Child, workspace: &Path, probe: F) -> Result<()>
where
    F: Fn(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut healthy_since = None;
    loop {
        if child.try_wait()?.is_some() {
            return Err(fail(
                "The updated app exited before its service became ready.",
            ));
        }
        if probe(workspace.to_owned()).await? {
            if healthy_since.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(2) {
                return Ok(());
            }
        } else {
            healthy_since = None;
        }
        if Instant::now() >= deadline {
            return Err(fail("The updated app did not become ready in time."));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
async fn verify_staging(config: &InstallConfig, key: &str) -> Result<()> {
    validate_install_paths(config)?;
    let bytes = read_limited_file(&config.directory.join("update-manifest.json"), 16384).await?;
    let signature = read_limited_file(&config.directory.join("update-manifest.sig"), 256).await?;
    let signature = std::str::from_utf8(&signature)
        .map_err(|_| fail("The update signature could not be verified."))?;
    let manifest = verify_manifest(&bytes, signature, &config.version, key)?;
    let asset = &manifest.platforms[&config.platform];
    let path = config.directory.join("update.zip");
    let size = asset.size;
    let hash = asset.sha256.clone();
    tokio::task::spawn_blocking(move || {
        if fs::metadata(&path)?.len() != size || hash_file(&path)? != hash {
            return Err(fail("The staged update changed."));
        }
        Ok(())
    })
    .await
    .map_err(|_| fail(DOWNLOAD_ERROR))?
}
fn cleanup_completed_updates(config: &InstallConfig) {
    let _ = fs::remove_file(config.directory.join("update.zip"));
    let _ = fs::remove_dir_all(config.directory.join("extracted"));
    let Some(parent) = config.directory.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix(".morrow-update-"))
        else {
            continue;
        };
        if path == config.directory
            || uuid::Uuid::parse_str(id).is_err()
            || !fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            || !fs::symlink_metadata(path.join("previous"))
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
            continue;
        }
        let marker_path = path.join("update-target.json");
        if !fs::symlink_metadata(&marker_path).is_ok_and(|metadata| {
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 4096
        }) {
            continue;
        }
        let Ok(marker) = fs::read(marker_path) else {
            continue;
        };
        if serde_json::from_slice::<PathBuf>(&marker).ok().as_ref() == Some(&config.target) {
            let _ = fs::remove_dir_all(path);
        }
    }
}
/// Private entry point used only by a host-prepared, copied helper over stdin.
pub async fn installer_main() -> i32 {
    let result = async {
        let mut bytes = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            tokio::io::stdin().take(16385).read_to_end(&mut bytes),
        )
        .await
        .map_err(|_| fail("Invalid update owner."))??;
        if bytes.len() > 16384 {
            return Err(fail("Invalid update owner."));
        }
        let config: InstallConfig = serde_json::from_slice(&bytes)?;
        if Some(config.platform.as_str()) != host_platform()
            || fs::canonicalize(std::env::current_exe()?)?.parent()
                != Some(config.directory.as_path())
        {
            return Err(fail("Invalid update owner."));
        }
        Ok(config)
    }
    .await;
    let config = match result {
        Ok(config) => config,
        Err(_) => return 1,
    };
    let outcome = install_package(&config, PUBLIC_KEY, || {
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(b"ready\n")?;
        stdout.flush()?;
        Ok(())
    })
    .await;
    if outcome.is_ok() { 0 } else { 1 }
}
/// The caller supplies its compiled trust anchor; the native helper always uses PUBLIC_KEY.
/// Keeping verification separate lets fixtures use generated keys without a runtime key override.
pub async fn install_package(
    config: &InstallConfig,
    key: &str,
    ready: impl FnOnce() -> Result<()>,
) -> Result<()> {
    install_package_with_probe(config, key, ready, |workspace| async move {
        cli::healthy(&workspace).await
    })
    .await
}
async fn install_package_with_probe<F, Fut>(
    config: &InstallConfig,
    key: &str,
    ready: impl FnOnce() -> Result<()>,
    probe: F,
) -> Result<()>
where
    F: Fn(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    verify_staging(config, key).await?;
    ready()?;
    let mut parents_exited = false;
    let outcome =
        async {
            let deadline = Instant::now() + Duration::from_secs(100);
            while config.pids.iter().any(|&pid| process_alive(pid)) {
                if Instant::now() >= deadline {
                    return Err(fail("The app did not close; no update was installed."));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            parents_exited = true;
            verify_staging(config, key).await?;
            let (backend, _) = package_paths(&config.target, &config.platform)?;
            if serde_json::from_slice::<Value>(
                &tokio::fs::read(backend.join("package.json")).await?,
            )?["version"]
                != config.installed_version
            {
                return Err(fail(
                    "The installed app changed. Download the update again.",
                ));
            }
            // Re-extract authenticated bytes after the wait; never trust mutable staged files.
            tokio::fs::remove_dir_all(config.directory.join("extracted")).await?;
            let staged = extract(&config.directory, &config.platform, None).await?;
            validate_package(&staged, &config.platform, &config.version).await?;
            replace_and_launch(config, |target| {
                let platform = config.platform.clone();
                let workspace = config.result_file.parent().unwrap().to_owned();
                async move {
                    let mut child = launch_app(&target, &platform, &workspace)?;
                    #[cfg(windows)]
                    let child_pid = child.id().unwrap();
                    let result = wait_for_ready(&mut child, &workspace, probe).await;
                    if result.is_err() {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        #[cfg(windows)]
                        wait_for_launched_service(child_pid).await;
                    }
                    result
                }
            })
            .await
        }
        .await;
    if outcome.is_ok() {
        cleanup_completed_updates(config);
    }
    let value = if outcome.is_ok() {
        json!({"status":"installed","version":config.version})
    } else {
        json!({"status":"error","reason":"The update did not complete. The previous app and workspace have been retained."})
    };
    let temporary = config
        .result_file
        .with_file_name(format!(".update-result-{}.json", uuid::Uuid::new_v4()));
    if save_private(&temporary, &serde_json::to_vec(&value).unwrap()).is_ok() {
        // Windows rename cannot replace an existing result file; this file is status only.
        #[cfg(windows)]
        {
            let _ = fs::remove_file(&config.result_file);
        }
        let _ = fs::rename(&temporary, &config.result_file);
    }
    if outcome.is_err() && parents_exited && config.target.exists() {
        let _ = launch_app(
            &config.target,
            &config.platform,
            config.result_file.parent().unwrap(),
        );
    }
    outcome
}
pub async fn handle(app: &App, context: &Context) -> Result<Option<Response>> {
    let route: Vec<String> = context
        .path
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let route: Vec<&str> = route.iter().map(String::as_str).collect();
    let updater = &app.0.updater;
    let mut status = StatusCode::OK;
    let value = match (context.method.as_str(), route.as_slice()) {
        ("GET", ["updates"]) => {
            let channel = context.query.get("includePrereleases");
            if channel.is_some_and(|v| v != "true" && v != "false") {
                return Err(Error::invalid("Choose a valid release channel."));
            }
            updater
                .check(&app.0.client, channel.is_some_and(|v| v == "true"))
                .await?
        }
        ("GET", ["updates", "status"]) => updater.status().await,
        ("POST", ["updates", "download"]) => {
            let channel = context.body["includePrereleases"]
                .as_bool()
                .ok_or_else(|| fail("Choose a valid update channel."))?;
            status = StatusCode::ACCEPTED;
            updater.start(app.0.client.clone(), channel).await?
        }
        ("POST", ["updates", "cancel"]) => updater.cancel().await?,
        ("POST", ["updates", "install"]) => {
            if app.0.update_token.is_empty()
                || !crate::validation::same_secret(
                    context.header("x-morrow-update"),
                    &app.0.update_token,
                )
            {
                return Err(Error::new(
                    403,
                    "Install updates from the desktop app controls.",
                ));
            }
            let _guard = app
                .0
                .mailbox
                .try_lock()
                .map_err(|_| fail("Wait for the current operation to finish."))?;
            let _google = app
                .0
                .calendars
                .provider("google")?
                .change
                .try_lock()
                .map_err(|_| crate::calendar::busy())?;
            let _microsoft = app
                .0
                .calendars
                .provider("microsoft")?
                .change
                .try_lock()
                .map_err(|_| crate::calendar::busy())?;
            if app.settings().await?["searchIndex"]["status"] == "running" {
                return Err(fail("Wait for the current indexing operation to finish."));
            }
            updater.prepare().await?
        }
        _ => return Ok(None),
    };
    Ok(Some((status, Json(value)).into_response()))
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    use std::sync::atomic::AtomicU8;
    use tokio_rustls::{TlsAcceptor, rustls};

    // Fixture tools contain only generated test data. Preserve bounded diagnostics
    // here without exposing subprocess output through the production update API.
    async fn fixture_command(step: &str, command: &mut Command, seconds: u64) {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| panic!("{step}: could not start fixture command: {error}"));
        let mut stdout = child.stdout.take().unwrap().take(65537);
        let mut stderr = child.stderr.take().unwrap().take(65537);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let result = tokio::time::timeout(Duration::from_secs(seconds), async {
            tokio::try_join!(
                stdout.read_to_end(&mut out),
                stderr.read_to_end(&mut err),
                child.wait()
            )
        })
        .await;
        if !matches!(&result, Ok(Ok((_, _, status))) if status.success())
            || out.len() > 65536
            || err.len() > 65536
        {
            let _ = child.kill().await;
            panic!(
                "{step}: fixture command failed ({result:?}); stdout: {}; stderr: {}",
                String::from_utf8_lossy(&out),
                String::from_utf8_lossy(&err)
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_candidate_waits_for_its_service() {
        let root =
            std::env::temp_dir().join(format!("morrow-update-service-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("candidate.rs");
        fs::write(
            &source,
            r#"fn main() {
    let root = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    if std::env::args().any(|arg| arg == "--service") {
        std::thread::sleep(std::time::Duration::from_secs(4));
        return;
    }
    let child = std::process::Command::new(root.join("morrow-service.exe"))
        .arg("--service").spawn().unwrap();
    std::fs::write(root.join("service.pid"), child.id().to_string()).unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}"#,
        )
        .unwrap();
        let executable = root.join("candidate.exe");
        fixture_command(
            "compile child-service fixture",
            clean_command(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
                .args(["--edition=2024", "--crate-name", "candidate_fixture"])
                .arg(&source)
                .arg("-o")
                .arg(&executable),
            60,
        )
        .await;
        fs::copy(&executable, root.join("morrow-service.exe")).unwrap();
        let mut candidate = clean_command(&executable)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let candidate_pid = candidate.id().unwrap();
        let service_pid = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(pid) = fs::read_to_string(root.join("service.pid")) {
                    break pid.parse::<u32>().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        candidate.kill().await.unwrap();
        candidate.wait().await.unwrap();
        let started = Instant::now();
        wait_for_launched_service(candidate_pid).await;
        assert!(!process_alive(service_pid));
        assert!(started.elapsed() >= Duration::from_secs(1));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn assert_private_acl(path: &Path, protected: bool) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                ACCESS_ALLOWED_ACE,
                Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
                DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
                INHERIT_ONLY_ACE, IsValidAcl, IsValidSid, IsWellKnownSid,
                OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED, WinCreatorOwnerRightsSid,
                WinLocalSystemSid,
            },
            Storage::FileSystem::FILE_ALL_ACCESS,
        };
        struct Descriptor(*mut std::ffi::c_void);
        impl Drop for Descriptor {
            fn drop(&mut self) {
                unsafe { LocalFree(self.0) };
            }
        }
        let name = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut owner = std::ptr::null_mut();
        let mut acl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        // Read the actual Windows descriptor; the fixture must not depend on
        // PowerShell.Security module autoloading or translate canonical paths.
        unsafe {
            assert_eq!(
                GetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    std::ptr::null_mut(),
                    &mut acl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                ),
                0,
                "Read fixture security descriptor: {}",
                path.display()
            );
            let descriptor = Descriptor(descriptor);
            assert!(!descriptor.0.is_null() && !owner.is_null() && !acl.is_null());
            assert_ne!(IsValidSid(owner), 0);
            assert_ne!(IsValidAcl(acl), 0);
            let mut control = 0;
            let mut revision = 0;
            assert_ne!(
                GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision),
                0
            );
            if protected {
                assert_ne!(
                    control & SE_DACL_PROTECTED,
                    0,
                    "Staging DACL is not protected"
                );
            }
            let (mut has_owner, mut has_system) = (false, false);
            for index in 0..u32::from((*acl).AceCount) {
                let mut entry = std::ptr::null_mut();
                assert_ne!(GetAce(acl, index, &mut entry), 0);
                assert!(!entry.is_null());
                let ace = &*entry.cast::<ACCESS_ALLOWED_ACE>();
                assert_eq!(ace.Header.AceType, 0, "Expected ACCESS_ALLOWED_ACE");
                assert_eq!(u32::from(ace.Header.AceFlags) & INHERIT_ONLY_ACE, 0);
                assert_eq!(ace.Mask & FILE_ALL_ACCESS, FILE_ALL_ACCESS);
                let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
                assert_ne!(IsValidSid(sid), 0);
                // SDDL OW is an Owner Rights trustee, not the owner's concrete SID.
                let is_owner =
                    EqualSid(sid, owner) != 0 || IsWellKnownSid(sid, WinCreatorOwnerRightsSid) != 0;
                let is_system = IsWellKnownSid(sid, WinLocalSystemSid) != 0;
                assert!(
                    is_owner || is_system,
                    "Staging grants another principal access"
                );
                has_owner |= is_owner;
                has_system |= is_system;
            }
            assert!(has_owner && has_system, "Missing owner or SYSTEM access");
        }
    }

    struct Fixture {
        root: PathBuf,
        task: JoinHandle<()>,
        client: reqwest::Client,
        updater: Updater,
        key: String,
        mode: Arc<AtomicU8>,
        marker: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    async fn fixture() -> Fixture {
        let platform = host_platform().unwrap();
        let root = std::env::temp_dir().join(format!(
            "morrow-rust-update-download-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let archive_root = if platform == "macos-arm64" {
            "Morrow Mail.app"
        } else {
            "Morrow Mail-win32-x64"
        };
        let incoming = root.join("incoming").join(archive_root);
        let target = root.join(if platform == "macos-arm64" {
            "Installed Morrow.app"
        } else {
            "installed"
        });
        let data = root.join("workspace");
        let (backend, executable) = package_paths(&incoming, platform).unwrap();
        fs::create_dir_all(&backend).unwrap();
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir(&data).unwrap();
        fs::write(backend.join("package.json"), r#"{"version":"99.0.0"}"#).unwrap();
        fs::write(data.join("retained"), "original workspace").unwrap();
        let (old_backend, _) = package_paths(&target, platform).unwrap();
        fs::create_dir_all(old_backend).unwrap();
        fs::write(
            package_paths(&target, platform)
                .unwrap()
                .0
                .join("package.json"),
            serde_json::to_vec(&json!({"version":VERSION})).unwrap(),
        )
        .unwrap();
        let marker = root.join("restarted.txt");
        if platform == "macos-arm64" {
            let source = root.join("fixture.swift");
            fs::write(&source,format!("import Foundation\ntry! (ProcessInfo.processInfo.environment[\"MORROW_DATA_DIR\"] ?? \"missing workspace\").write(toFile: {}, atomically: true, encoding: .utf8)\nThread.sleep(forTimeInterval: 10)\n",serde_json::to_string(&marker.to_string_lossy()).unwrap())).unwrap();
            fixture_command(
                "compile macOS restart fixture",
                clean_command("/usr/bin/swiftc")
                    .args(["-target", "arm64-apple-macosx13.5"])
                    .arg(&source)
                    .arg("-o")
                    .arg(&executable),
                60,
            )
            .await;
            fs::write(incoming.join("Contents/Info.plist"),r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.morrowmail.rust-updater-fixture</string><key>CFBundleExecutable</key><string>MorrowMail</string><key>CFBundleVersion</key><string>99.0.0</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#).unwrap();
            fixture_command(
                "sign macOS restart fixture",
                clean_command("/usr/bin/codesign")
                    .args(["--force", "--sign", "-"])
                    .arg(&incoming),
                30,
            )
            .await;
        } else {
            let source = root.join("restart_fixture.rs");
            fs::write(
                &source,
                format!(
                    "#![windows_subsystem = \"windows\"]\nfn main() {{ std::fs::write({:?}, std::env::var(\"MORROW_DATA_DIR\").expect(\"missing fixture workspace\")).unwrap(); std::thread::sleep(std::time::Duration::from_secs(10)); }}\n",
                    marker.to_string_lossy()
                ),
            )
            .unwrap();
            fixture_command(
                "compile Windows restart fixture",
                clean_command(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
                    .args(["--edition=2024", "--crate-name", "restart_fixture"])
                    .arg(&source)
                    .arg("-o")
                    .arg(&executable),
                60,
            )
            .await;
        }
        let archive = root.join("update.zip");
        if platform == "macos-arm64" {
            fixture_command(
                "archive macOS restart fixture",
                clean_command("/usr/bin/ditto")
                    .args(["-c", "-k", "--keepParent"])
                    .arg(&incoming)
                    .arg(&archive),
                30,
            )
            .await;
        } else {
            fixture_command(
                "archive Windows restart fixture",
                ps_command("$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:MORROW_FIXTURE_APP -DestinationPath 'update.zip'")
                    .current_dir(&root)
                    .env("MORROW_FIXTURE_APP", Path::new("incoming").join(archive_root)),
                30,
            )
            .await;
        }
        let zip = fs::read(&archive).unwrap();
        let digest = hash_file(&archive).unwrap();
        let key = SigningKey::from_bytes(&crate::store::random_bytes::<32>().unwrap());
        let key_pem = key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap();
        let platforms=PLATFORMS.into_iter().map(|p|(p.to_owned(),json!({"name":format!("Morrow-Mail-99.0.0-{p}.zip"),"size":zip.len(),"sha256":digest}))).collect::<serde_json::Map<_,_>>();
        let manifest =
            serde_json::to_vec(&json!({"version":"99.0.0","platforms":platforms})).unwrap();
        let signature = STANDARD.encode(key.sign(&manifest).to_bytes()).into_bytes();
        let certificate = rcgen::generate_simple_self_signed(vec![
            "github.com".into(),
            "api.github.com".into(),
            "objects.githubusercontent.com".into(),
            "release-assets.githubusercontent.com".into(),
        ])
        .unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der())
                .into(),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .add_root_certificate(reqwest::Certificate::from_der(certificate.cert.der()).unwrap())
            .resolve("github.com", address)
            .resolve("api.github.com", address)
            .resolve("objects.githubusercontent.com", address)
            .resolve("release-assets.githubusercontent.com", address)
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mode = Arc::new(AtomicU8::new(0));
        let response_mode = mode.clone();
        let zip = Arc::new(zip);
        let manifest = Arc::new(manifest);
        let signature = Arc::new(signature);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let acceptor = acceptor.clone();
                let mode = response_mode.clone();
                let zip = zip.clone();
                let manifest = manifest.clone();
                let signature = signature.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut bytes = Vec::new();
                    while bytes.len() < 16384 && !bytes.ends_with(b"\r\n\r\n") {
                        match stream.read_u8().await {
                            Ok(byte) => bytes.push(byte),
                            Err(_) => return,
                        }
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let path = text.split_whitespace().nth(1).unwrap_or("");
                    let mode = mode.load(AtomicOrdering::Acquire);
                    let decoded_path =
                        percent_encoding::percent_decode_str(path).decode_utf8_lossy();
                    let valid_path = path == "/repos/Coke1120/Morrow-Mail/releases?per_page=100"
                        || decoded_path
                            .starts_with("/Coke1120/Morrow-Mail/releases/download/v99.0.0/");
                    let (status, headers, body) = if !valid_path {
                        (404, "", b"wrong repository path".to_vec())
                    } else if path.starts_with("/repos/") {
                        if mode == 6 {
                            (429, "", b"limited".to_vec())
                        } else {
                            (
                                200,
                                "",
                                br#"[{"tag_name":"v99.0.0","prerelease":false,"draft":false}]"#
                                    .to_vec(),
                            )
                        }
                    } else if path.ends_with("update-manifest.json") {
                        (
                            200,
                            "",
                            if mode == 4 {
                                vec![b'x'; 16385]
                            } else {
                                manifest.to_vec()
                            },
                        )
                    } else if path.ends_with("update-manifest.sig") {
                        (
                            200,
                            "",
                            if mode == 3 {
                                vec![b'x'; 88]
                            } else {
                                signature.to_vec()
                            },
                        )
                    } else if path.ends_with(".zip") {
                        if mode == 5 {
                            (302, "Location: http://127.0.0.1/private\r\n", vec![])
                        } else {
                            let mut body = zip.to_vec();
                            if mode == 2 {
                                body[0] ^= 1;
                            }
                            (200, "", body)
                        }
                    } else {
                        (404, "", vec![])
                    };
                    let head = format!(
                        "HTTP/1.1 {status} Fixture\r\nConnection: close\r\n{headers}Content-Length: {}\r\n\r\n",
                        body.len()
                    );
                    if stream.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    if mode == 1 && path.ends_with(".zip") {
                        let _ = stream.write_all(&body[..1]).await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        return;
                    }
                    let _ = stream.write_all(&body).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        let updater = Updater(Arc::new(UpdaterInner {
            data,
            target: Some(target),
            parent: AtomicU32::new(std::process::id()),
            token_valid: true,
            state: Mutex::new(UpdateState {
                value: json!({"phase":"idle","received":0,"total":0}),
                directory: None,
                cancel: None,
                job: None,
            }),
            checks: [Mutex::new(None), Mutex::new(None)],
        }));
        Fixture {
            root,
            task,
            client,
            updater,
            key: key_pem,
            mode,
            marker,
        }
    }
    async fn settled(updater: &Updater) -> Value {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let state = updater.0.state.lock().await;
                if state.cancel.is_none() {
                    return state.value.clone();
                }
                drop(state);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn signed_download_install_waits_for_both_processes_and_rolls_back_failed_start() {
        if host_platform().is_none() {
            return;
        }
        let fixture = fixture().await;
        let updater = &fixture.updater;
        assert_eq!(
            updater.check(&fixture.client, true).await.unwrap()["latestVersion"],
            "99.0.0"
        );
        for (mode, phase) in [
            (2, "error"),
            (3, "error"),
            (4, "error"),
            (5, "error"),
            (6, "error"),
        ] {
            fixture.mode.store(mode, AtomicOrdering::Release);
            updater
                .start_trusted(fixture.client.clone(), true, &fixture.key)
                .await
                .unwrap();
            assert_eq!(settled(updater).await["phase"], phase);
            assert!(updater.0.state.lock().await.directory.is_none());
            assert!(fixture.marker.try_exists().is_ok_and(|exists| !exists));
        }
        fixture.mode.store(1, AtomicOrdering::Release);
        updater
            .start_trusted(fixture.client.clone(), true, &fixture.key)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while updater.status().await["received"] != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            updater
                .start_trusted(fixture.client.clone(), true, &fixture.key)
                .await
                .is_err()
        );
        updater.cancel().await.unwrap();
        assert_eq!(settled(updater).await["phase"], "idle");
        fixture.mode.store(0, AtomicOrdering::Release);
        updater
            .start_trusted(fixture.client.clone(), true, &fixture.key)
            .await
            .unwrap();
        assert_eq!(settled(updater).await["phase"], "ready");
        let old_directory = updater.0.state.lock().await.directory.clone().unwrap();
        updater.cancel().await.unwrap();
        assert!(!old_directory.exists());
        updater
            .start_trusted(fixture.client.clone(), true, &fixture.key)
            .await
            .unwrap();
        assert_eq!(settled(updater).await["phase"], "ready");
        let directory = updater.0.state.lock().await.directory.clone().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(directory.join("update.zip"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        #[cfg(windows)]
        {
            // Staging and downloaded content must inherit only owner/SYSTEM access,
            // even when the installation's parent grants other local users access.
            assert_private_acl(&directory, true);
            assert_private_acl(&directory.join("update.zip"), false);
        }
        let sleeper = || {
            let mut command = if cfg!(windows) {
                let mut c = clean_command(powershell());
                c.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ]);
                c
            } else {
                let mut c = clean_command("/bin/sleep");
                c.arg("30");
                c
            };
            command.spawn().unwrap()
        };
        let mut ui = sleeper();
        let mut service = sleeper();
        let platform = host_platform().unwrap();
        let root = if platform == "macos-arm64" {
            "Morrow Mail.app"
        } else {
            "Morrow Mail-win32-x64"
        };
        let config = InstallConfig {
            directory: directory.clone(),
            root: root.into(),
            platform: platform.into(),
            target: updater.0.target.clone().unwrap(),
            staged: directory.join("extracted").join(root),
            backup: directory.join("previous"),
            version: "99.0.0".into(),
            installed_version: VERSION.into(),
            pids: [ui.id().unwrap(), service.id().unwrap()],
            result_file: updater.0.data.join("update-result.json"),
        };
        let obsolete = config
            .target
            .parent()
            .unwrap()
            .join(format!(".morrow-update-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(obsolete.join("previous")).unwrap();
        fs::write(
            obsolete.join("update-target.json"),
            serde_json::to_vec(&config.target).unwrap(),
        )
        .unwrap();
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let install = config.clone();
        let key = fixture.key.clone();
        let task = tokio::spawn(async move {
            install_package_with_probe(
                &install,
                &key,
                || {
                    let _ = ready.send(());
                    Ok(())
                },
                |_| async { Ok(false) },
            )
            .await
        });
        waiting.await.unwrap();
        // A modified staging tree must never become trusted just because the archive still hashes.
        fs::write(
            package_paths(&config.staged, platform)
                .unwrap()
                .0
                .join("package.json"),
            r#"{"version":"tampered"}"#,
        )
        .unwrap();
        ui.kill().await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!config.backup.exists());
        assert!(!task.is_finished());
        service.kill().await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!config.backup.exists());
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(
                    package_paths(&config.target, platform)
                        .unwrap()
                        .0
                        .join("package.json")
                )
                .unwrap()
            )
            .unwrap()["version"],
            VERSION
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&config.result_file).unwrap()).unwrap()["status"],
            "error"
        );
        fs::remove_file(&fixture.marker).unwrap();
        install_package_with_probe(&config, &fixture.key, || Ok(()), |workspace| async move {
            Ok(workspace.parent().unwrap().join("restarted.txt").exists())
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&config.result_file).unwrap()).unwrap()["status"],
            "installed"
        );
        assert!(config.backup.exists());
        assert!(!directory.join("update.zip").exists());
        assert!(!obsolete.exists());
        tokio::time::timeout(Duration::from_secs(10), async {
            while !fixture.marker.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(&fixture.marker).unwrap(),
            updater.0.data.to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(updater.0.data.join("retained")).unwrap(),
            "original workspace"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(
                    package_paths(&config.target, platform)
                        .unwrap()
                        .0
                        .join("package.json")
                )
                .unwrap()
            )
            .unwrap()["version"],
            "99.0.0"
        );
        assert_eq!(updater.status().await["previous"], "Updated to 99.0.0.");
        // Stop must retain the previous application once installation has been handed off.
        updater.0.state.lock().await.value["phase"] = "installing".into();
        updater.stop().await;
        assert!(config.backup.exists());
        assert!(updater.cancel().await.is_err());
    }
    #[tokio::test]
    async fn installation_holds_calendar_change_gates_and_rejects_active_indexing() {
        let root = std::env::temp_dir().join(format!(
            "morrow-update-install-guards-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let app = App::open(&root, 3001, "a".repeat(64), "b".repeat(64)).unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            "x-morrow-update",
            axum::http::HeaderValue::from_str(&"b".repeat(64)).unwrap(),
        );
        let context = Context {
            method: axum::http::Method::POST,
            path: vec!["updates".into(), "install".into()],
            body: json!({}),
            query: json!({}),
            headers,
            owner: "demo".into(),
            paged: false,
        };
        for provider in ["google", "microsoft"] {
            let gate = app
                .0
                .calendars
                .provider(provider)
                .unwrap()
                .change
                .lock()
                .await;
            assert_eq!(
                handle(&app, &context).await.unwrap_err().body,
                crate::calendar::busy().body
            );
            drop(gate);
        }
        app.db(|db| {
            db.set_settings(&json!({"searchIndex":{"status":"running"}}))?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            handle(&app, &context).await.unwrap_err().to_string(),
            "Wait for the current indexing operation to finish."
        );
        drop(app);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancelling_a_native_extractor_waits_for_termination() {
        let (send, mut receive) = watch::channel(false);
        let mut command = if cfg!(windows) {
            let mut c = clean_command(powershell());
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            c
        } else {
            let mut c = clean_command("/bin/sleep");
            c.arg("30");
            c
        };
        let task = tokio::spawn(async move {
            command_output_cancellable(&mut command, 30, Some(&mut receive)).await
        });
        tokio::time::sleep(Duration::from_millis(40)).await;
        send.send(true).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
}
