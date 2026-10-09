//! Paired release publisher. Check/dry-run never writes files or invokes gh.
//! Publish requires the existing serialized `release` job in check.yml and a
//! gate file identifying every successful macOS/Windows job in this run attempt:
//! {"repository":"Coke1120/Morrow-Mail","tag":"v0.7.0",
//!  "sha":"<GITHUB_SHA>","runId":123,"runAttempt":1,
//!  "platforms":{"macos-arm64":[111,112],"windows-x64":[113,114]}}
//! IDs come from GitHub's jobs API, not runner IDs. No trust-key override exists.
//! Publication also downloads the two immutable same-run Actions artifact IDs,
//! verifies GitHub's archive digests, and compares all four files before signing.
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey, pkcs8::DecodePrivateKey};
use morrow_search::updater::{ARCHIVE_LIMIT, Asset, Manifest, PUBLIC_KEY, verify_manifest};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    ffi::OsString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const REPOSITORY: &str = "Coke1120/Morrow-Mail";
const PLATFORMS: [&str; 2] = ["macos-arm64", "windows-x64"];
const JSON_LIMIT: u64 = 8 * 1024 * 1024;
// One bounded release ZIP plus its checksum and the outer Actions ZIP overhead.
const ARTIFACT_LIMIT: u64 = ARCHIVE_LIMIT + 8 * 1024 * 1024;
const HELP: &str = "morrow-publish [--check | --dry-run | --publish] --notes-file FILE
  [--artifacts DIR] [--tag TAG] [--gate-file FILE]

Run from the repository root. Defaults: --check, release-artifacts, and the
GITHUB_REF_NAME tag (or v<package.json version> outside CI). --check/--dry-run
validate the exact paired archives/checksums, notes and legacy manifest locally;
they never write files or call GitHub. If MORROW_UPDATE_SIGNING_KEY is set, its
signature must verify against the compiled production key, even in check mode.

--publish additionally requires MORROW_UPDATE_SIGNING_KEY (Ed25519 PKCS#8 PEM),
GH_TOKEN, a tag-push GitHub Actions release job in the canonical check.yml, and
--gate-file with repository, tag, sha, runId, runAttempt, platforms:
  {\"macos-arm64\":[<successful job IDs>],\"windows-x64\":[<successful job IDs>]}
The jobs API must confirm all preceding jobs succeeded, both platform job lists
are complete, and tag/run/attempt/SHA match. No workflow is wired by this tool.
The same run must contain morrow-macos-arm64 and morrow-windows-x64 artifacts
created in this attempt. Their GitHub IDs, commit SHA and SHA-256 digests are
verified; downloaded contents must match all four local files before signing.
Only those verified staged files are uploaded. No caller-supplied artifact hash
or artifact override is accepted. Actions ZIPs are bounded and never extracted
using archive-controlled paths (ZIP64/encrypted/multipart archives unsupported).
The serialized release job needs contents: write and actions: read permissions.
Notes must be an explicit existing UTF-8 file (1..65536 bytes).
Existing public releases, extra/mismatched assets and missing digests are rejected.
Matching draft uploads may be resumed; assets are never clobbered or deleted.
Failures before the final publish request leave the release as a draft.";

struct Options {
    publish: bool,
    artifacts: PathBuf,
    notes: PathBuf,
    tag: Option<String>,
    gate: Option<PathBuf>,
}

fn options(args: impl IntoIterator<Item = OsString>) -> Result<Options> {
    let mut args = args.into_iter();
    let mut seen = BTreeSet::new();
    let (mut publish, mut mode) = (false, false);
    let (mut artifacts, mut notes, mut tag, mut gate) = (None, None, None, None);
    while let Some(arg) = args.next() {
        let flag = arg
            .to_str()
            .ok_or("Arguments must use UTF-8 option names.")?;
        if !seen.insert(flag.to_owned()) {
            return Err("Duplicate option.".into());
        }
        match flag {
            "--check" | "--dry-run" | "--publish" => {
                if mode {
                    return Err("Choose exactly one execution mode.".into());
                }
                mode = true;
                publish = flag == "--publish";
            }
            "--artifacts" | "--notes-file" | "--tag" | "--gate-file" => {
                let value = args.next().ok_or("Missing option value.")?;
                if value.is_empty() || value.to_string_lossy().starts_with("--") {
                    return Err("Missing option value.".into());
                }
                match flag {
                    "--artifacts" => artifacts = Some(PathBuf::from(value)),
                    "--notes-file" => notes = Some(PathBuf::from(value)),
                    "--gate-file" => gate = Some(PathBuf::from(value)),
                    _ => tag = Some(value.into_string().map_err(|_| "Invalid tag.")?),
                }
            }
            _ => return Err("Unknown option. See --help.".into()),
        }
    }
    Ok(Options {
        publish,
        artifacts: artifacts.unwrap_or_else(|| "release-artifacts".into()),
        notes: notes.ok_or("An explicit --notes-file is required.")?,
        tag,
        gate,
    })
}

fn regular(path: &Path, limit: u64) -> Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || !(1..=limit).contains(&metadata.len())
    {
        return Err("Input must be a nonempty regular file within its size limit.".into());
    }
    Ok(File::open(path)?)
}

fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    regular(path, limit)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err("Input changed or exceeded its size limit.".into());
    }
    Ok(bytes)
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    bounded_hash(path, ARCHIVE_LIMIT)
}

fn bounded_hash(path: &Path, limit: u64) -> Result<(u64, String)> {
    let mut file = regular(path, limit)?.take(limit + 1);
    let (mut hash, mut size) = (Sha256::new(), 0_u64);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > limit {
            return Err("File exceeds its size limit.".into());
        }
        hash.update(&buffer[..n]);
    }
    if size == 0 {
        return Err("Empty archive.".into());
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn version(package: &Value, tag: &str) -> Result<String> {
    let version = package["version"]
        .as_str()
        .ok_or("Missing package version.")?;
    if version.len() > 100
        || !Regex::new(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")?.is_match(version)
        || tag != format!("v{version}")
    {
        return Err(
            "Only vMAJOR.MINOR.PATCH tags exactly matching package.json may be published.".into(),
        );
    }
    if package["repository"]["url"] != "git+https://github.com/Coke1120/Morrow-Mail.git" {
        return Err("package.json must name the canonical repository.".into());
    }
    Ok(version.to_owned())
}

fn asset_bytes(name: &str, bytes: &[u8]) -> Asset {
    Asset {
        name: name.into(),
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}

fn archives(directory: &Path, version: &str) -> Result<(Manifest, Vec<(Asset, PathBuf)>)> {
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Artifacts must be a real directory.".into());
    }
    let expected: BTreeSet<String> = PLATFORMS
        .iter()
        .flat_map(|platform| {
            [
                format!("Morrow-Mail-{version}-{platform}.zip"),
                format!("SHA256SUMS-{platform}.txt"),
            ]
        })
        .collect();
    let actual: BTreeSet<_> = fs::read_dir(directory)?
        .take(5)
        .map(|item| {
            item?
                .file_name()
                .into_string()
                .map_err(|_| "Invalid artifact filename.".into())
        })
        .collect::<Result<_>>()?;
    if actual != expected {
        return Err("Exactly both platform archives and checksums are required.".into());
    }
    let mut platforms = BTreeMap::new();
    let mut files = Vec::new();
    for platform in PLATFORMS {
        let name = format!("Morrow-Mail-{version}-{platform}.zip");
        let path = directory.join(&name).canonicalize()?;
        // Check the original path too: canonicalization must not permit symlink inputs.
        regular(&directory.join(&name), ARCHIVE_LIMIT)?;
        let (size, sha256) = hash_file(&path)?;
        let checksum_name = format!("SHA256SUMS-{platform}.txt");
        let checksum = read(&directory.join(&checksum_name), 1024)?;
        if checksum != format!("{sha256}  {name}\n").as_bytes() {
            return Err(
                "Platform checksum does not match its exact archive filename and bytes.".into(),
            );
        }
        let asset = Asset { name, size, sha256 };
        platforms.insert(platform.to_owned(), asset.clone());
        files.push((asset, path));
        files.push((
            asset_bytes(&checksum_name, &checksum),
            directory.join(checksum_name).canonicalize()?,
        ));
    }
    // Struct field order and BTreeMap platform order match legacy JSON.stringify.
    Ok((
        Manifest {
            version: version.into(),
            platforms,
        },
        files,
    ))
}

fn signature(bytes: &[u8], key: &SigningKey) -> String {
    STANDARD.encode(key.sign(bytes).to_bytes())
}

fn trusted_signature(bytes: &[u8], version: &str) -> Result<Option<String>> {
    let pem = match env::var("MORROW_UPDATE_SIGNING_KEY") {
        Ok(value) => Zeroizing::new(value),
        Err(env::VarError::NotPresent) => return Ok(None),
        Err(_) => return Err("Invalid signing key environment value.".into()),
    };
    if pem.is_empty() || pem.len() > 8192 {
        return Err("Invalid signing key length.".into());
    }
    let key =
        SigningKey::from_pkcs8_pem(&pem).map_err(|_| "Invalid Ed25519 PKCS#8 signing key.")?;
    let signature = signature(bytes, &key);
    verify_manifest(bytes, &signature, version, PUBLIC_KEY)
        .map_err(|_| "Signing key does not verify against the pinned production trust anchor.")?;
    Ok(Some(signature))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gate {
    repository: String,
    tag: String,
    sha: String,
    run_id: u64,
    run_attempt: u64,
    platforms: BTreeMap<String, Vec<u64>>,
}

fn ci_gate(gate: &Gate, tag: &str, get: impl Fn(&str) -> Option<String>) -> Result<()> {
    for (name, expected) in [
        ("GITHUB_ACTIONS", "true".into()),
        ("CI", "true".into()),
        ("GITHUB_REPOSITORY", REPOSITORY.into()),
        ("GITHUB_EVENT_NAME", "push".into()),
        ("GITHUB_REF_TYPE", "tag".into()),
        ("GITHUB_REF_NAME", tag.into()),
        ("GITHUB_REF", format!("refs/tags/{tag}")),
        ("GITHUB_JOB", "release".into()),
        ("GITHUB_SHA", gate.sha.clone()),
        ("GITHUB_RUN_ID", gate.run_id.to_string()),
        ("GITHUB_RUN_ATTEMPT", gate.run_attempt.to_string()),
        (
            "GITHUB_WORKFLOW_REF",
            format!("{REPOSITORY}/.github/workflows/check.yml@refs/tags/{tag}"),
        ),
        ("GITHUB_API_URL", "https://api.github.com".into()),
    ] {
        if get(name).as_deref() != Some(expected.as_str()) {
            return Err("Publish requires matching canonical tag-push CI release context.".into());
        }
    }
    if gate.repository != REPOSITORY
        || gate.tag != tag
        || gate.run_id == 0
        || gate.run_attempt == 0
        || !Regex::new(r"^[a-f0-9]{40}$")?.is_match(&gate.sha)
        || gate
            .platforms
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != PLATFORMS
    {
        return Err("Paired gate identity is invalid.".into());
    }
    let mut ids = BTreeSet::new();
    for jobs in gate.platforms.values() {
        if jobs.is_empty() || jobs.len() > 50 || jobs.iter().any(|id| *id == 0 || !ids.insert(*id))
        {
            return Err(
                "Paired gate requires distinct successful job IDs for both platforms.".into(),
            );
        }
    }
    Ok(())
}

fn paired_jobs(gate: &Gate, value: &Value) -> Result<()> {
    let jobs = value["jobs"].as_array().ok_or("Missing CI jobs.")?;
    if jobs.len() > 100 || value["total_count"].as_u64() != Some(jobs.len() as u64) {
        return Err("CI jobs listing is incomplete or too large.".into());
    }
    let mut found: BTreeMap<String, BTreeSet<u64>> = PLATFORMS
        .iter()
        .map(|p| ((*p).into(), BTreeSet::new()))
        .collect();
    let mut publisher = 0;
    let mut ids = BTreeSet::new();
    for job in jobs {
        let id = job["id"].as_u64().ok_or("Missing CI job ID.")?;
        if id == 0
            || !ids.insert(id)
            || job["run_id"].as_u64() != Some(gate.run_id)
            || job["head_sha"] != gate.sha
        {
            return Err("CI job identity mismatch.".into());
        }
        if job["name"] == "release" && job["status"] == "in_progress" {
            publisher += 1;
            continue;
        }
        if job["status"] != "completed" || job["conclusion"] != "success" {
            return Err(
                "Every preceding CI job must complete successfully before publication.".into(),
            );
        }
        let labels = job["labels"].as_array().ok_or("Missing runner labels.")?;
        for (platform, prefix, label) in [
            (PLATFORMS[0], "macos-", "macOS"),
            (PLATFORMS[1], "windows-", "Windows"),
        ] {
            if labels
                .iter()
                .filter_map(Value::as_str)
                .any(|v| v.starts_with(prefix) || v == label)
            {
                found.get_mut(platform).unwrap().insert(id);
            }
        }
    }
    if publisher != 1
        || PLATFORMS.iter().any(|p| {
            found[*p].is_empty() || found[*p] != gate.platforms[*p].iter().copied().collect()
        })
    {
        return Err("Gate must include every successful macOS/Windows job in this attempt.".into());
    }
    Ok(())
}

// Bound stdout and wall time; never print gh output or pass it the signing key.
fn gh(args: &[OsString], seconds: u64) -> Result<Vec<u8>> {
    gh_output(args, seconds, Vec::new(), JSON_LIMIT).map(|(bytes, _)| bytes)
}

fn gh_output<W: Write + Send + 'static>(
    args: &[OsString],
    seconds: u64,
    mut output: W,
    limit: u64,
) -> Result<(W, u64)> {
    let mut child = Command::new("gh")
        .args(args)
        .env_remove("MORROW_UPDATE_SIGNING_KEY")
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start gh.")?;
    let stdout = child.stdout.take().ok_or("Missing gh output.")?;
    let (send, receive) = mpsc::channel();
    let reader = thread::spawn(move || {
        let result = std::io::copy(&mut stdout.take(limit + 1), &mut output);
        let _ = send.send((result, output));
    });
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let result = (|| {
        let (read, output) = receive
            .recv_timeout(Duration::from_secs(seconds))
            .map_err(|_| "gh timed out.")?;
        let size = read.map_err(|_| "Could not read gh output.")?;
        if size > limit {
            return Err("gh output exceeded its limit.".into());
        }
        loop {
            match child.try_wait()? {
                Some(status) if status.success() => return Ok((output, size)),
                Some(_) => return Err("gh failed; no subprocess diagnostics are exposed.".into()),
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                None => return Err("gh timed out.".into()),
            }
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Reap the writer before exclusive staging can be removed on failure.
    let _ = reader.join();
    result
}

fn api_args(path: &str, method: &str) -> Vec<OsString> {
    vec![
        "api".into(),
        "--hostname".into(),
        "github.com".into(),
        "--method".into(),
        method.into(),
        "-H".into(),
        "Accept: application/vnd.github+json".into(),
        "-H".into(),
        "X-GitHub-Api-Version: 2022-11-28".into(),
        // Revalidate release/asset state instead of reusing pre-write responses.
        "-H".into(),
        "Cache-Control: no-cache".into(),
        format!("repos/{REPOSITORY}/{path}").into(),
    ]
}

fn api(path: &str) -> Result<Value> {
    let bytes = gh(&api_args(path, "GET"), 120)?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid GitHub API response.".into())
}

fn verify_gate(gate: &Gate) -> Result<i64> {
    let run = api(&format!("actions/runs/{}", gate.run_id))?;
    if run["head_sha"] != gate.sha
        || run["event"] != "push"
        || run["path"] != ".github/workflows/check.yml"
        || run["run_attempt"].as_u64() != Some(gate.run_attempt)
        || run["repository"]["full_name"] != REPOSITORY
    {
        return Err("GitHub run does not match the paired gate.".into());
    }
    let started = timestamp(&run["run_started_at"])?;
    let mut object = api(&format!("git/ref/tags/{}", gate.tag))?["object"].clone();
    let sha_pattern = Regex::new(r"^[a-f0-9]{40}$")?;
    for _ in 0..8 {
        if object["type"] == "commit" && object["sha"] == gate.sha {
            paired_jobs(
                gate,
                &api(&format!(
                    "actions/runs/{}/attempts/{}/jobs?per_page=100",
                    gate.run_id, gate.run_attempt
                ))?,
            )?;
            return Ok(started);
        }
        let sha = object["sha"].as_str().ok_or("Missing tag target.")?;
        if object["type"] != "tag" || !sha_pattern.is_match(sha) {
            break;
        }
        object = api(&format!("git/tags/{sha}"))?["object"].clone();
    }
    Err("GitHub tag does not resolve to the reviewed CI commit.".into())
}

fn timestamp(value: &Value) -> Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(
        value.as_str().ok_or("Missing artifact/run timestamp.")?,
    )?
    .timestamp_millis())
}

#[derive(Debug, PartialEq, Eq)]
struct RunArtifact {
    id: u64,
    name: String,
    size: u64,
    digest: String,
    created: i64,
}

fn run_artifact(gate: &Gate, started: i64, value: &Value) -> Result<RunArtifact> {
    let artifact = RunArtifact {
        id: value["id"].as_u64().ok_or("Missing Actions artifact ID.")?,
        name: value["name"]
            .as_str()
            .ok_or("Missing Actions artifact name.")?
            .into(),
        size: value["size_in_bytes"]
            .as_u64()
            .ok_or("Missing Actions artifact size.")?,
        digest: value["digest"]
            .as_str()
            .ok_or("Missing trusted Actions artifact digest.")?
            .into(),
        created: timestamp(&value["created_at"])?,
    };
    let run = &value["workflow_run"];
    if artifact.id == 0
        || !PLATFORMS
            .iter()
            .any(|p| artifact.name == format!("morrow-{p}"))
        || !(1..=ARTIFACT_LIMIT).contains(&artifact.size)
        || !Regex::new(r"^sha256:[a-f0-9]{64}$")?.is_match(&artifact.digest)
        || value["expired"] != false
        || run["id"].as_u64() != Some(gate.run_id)
        || run["head_sha"] != gate.sha
        || artifact.created < started
    {
        return Err("Actions artifact does not belong to the approved run/attempt/commit.".into());
    }
    Ok(artifact)
}

fn run_artifacts(gate: &Gate, started: i64, value: &Value) -> Result<Vec<RunArtifact>> {
    let entries = value["artifacts"]
        .as_array()
        .ok_or("Missing Actions artifacts.")?;
    if entries.len() > 100 || value["total_count"].as_u64() != Some(entries.len() as u64) {
        return Err("Actions artifact listing is incomplete or too large.".into());
    }
    let mut result = Vec::new();
    for platform in PLATFORMS {
        let name = format!("morrow-{platform}");
        let matches: Vec<_> = entries.iter().filter(|v| v["name"] == name).collect();
        if matches.len() != 1 {
            return Err("Exactly one same-run artifact per release platform is required.".into());
        }
        let artifact = run_artifact(gate, started, matches[0])?;
        if result.iter().any(|a: &RunArtifact| a.id == artifact.id) {
            return Err("Actions artifact IDs must be distinct.".into());
        }
        result.push(artifact);
    }
    Ok(result)
}

fn verify_download(path: &Path, artifact: &RunArtifact) -> Result<()> {
    let (size, hash) = bounded_hash(path, artifact.size)?;
    if size != artifact.size || format!("sha256:{hash}") != artifact.digest {
        return Err("Downloaded Actions archive does not match GitHub's size/digest.".into());
    }
    Ok(())
}

fn u16le(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn zip_read(file: &mut File, size: u64, offset: u64, length: usize) -> Result<Vec<u8>> {
    if offset > size || length as u64 > size - offset {
        return Err("Actions ZIP offset exceeds the archive.".into());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

// Deliberately narrow Actions transport ZIP reader: two flat regular files only.
// Never extract an entry's path, symlink, directory or application ZIP contents.
// GitHub's outer digest authenticates the transport; each expanded SHA-256 must
// also equal the local candidate, including the exact checksum-file bytes.
fn match_artifact_files(
    path: &Path,
    expected: &[(Asset, PathBuf)],
    destination: &Path,
) -> Result<Vec<(Asset, PathBuf)>> {
    if expected.len() != 2 {
        return Err("Each platform artifact must contain exactly two files.".into());
    }
    let mut file = regular(path, ARTIFACT_LIMIT)?;
    let size = file.metadata()?.len();
    let tail = zip_read(
        &mut file,
        size,
        size.saturating_sub(65557),
        size.min(65557) as usize,
    )?;
    let end = (0..=tail.len().saturating_sub(22))
        .rev()
        .find(|&at| {
            at + 22 <= tail.len()
                && u32le(&tail, at) == 0x06054b50
                && at + 22 + u16le(&tail, at + 20) as usize == tail.len()
        })
        .ok_or("Unsupported Actions ZIP end record.")?;
    let length = u32le(&tail, end + 12) as usize;
    let offset = u32le(&tail, end + 16) as u64;
    if u32le(&tail, end + 4) != 0
        || u16le(&tail, end + 8) != 2
        || u16le(&tail, end + 10) != 2
        || length > 16384
        || offset + length as u64 != size - tail.len() as u64 + end as u64
    {
        return Err("Actions ZIP must contain exactly two bounded ZIP32 entries.".into());
    }
    let central = zip_read(&mut file, size, offset, length)?;
    let mut cursor = 0;
    let mut seen = BTreeSet::new();
    let mut ranges = Vec::new();
    let mut result = Vec::new();
    for _ in 0..2 {
        if cursor + 46 > central.len() || u32le(&central, cursor) != 0x02014b50 {
            return Err("Invalid Actions ZIP directory.".into());
        }
        let flags = u16le(&central, cursor + 8);
        let method = u16le(&central, cursor + 10);
        let packed = u32le(&central, cursor + 20) as u64;
        let expanded = u32le(&central, cursor + 24) as u64;
        let n = u16le(&central, cursor + 28) as usize;
        let next = cursor
            + 46
            + n
            + u16le(&central, cursor + 30) as usize
            + u16le(&central, cursor + 32) as usize;
        if next > central.len() {
            return Err("Invalid Actions ZIP name/extra bounds.".into());
        }
        let name = std::str::from_utf8(&central[cursor + 46..cursor + 46 + n])?;
        let asset = &expected
            .iter()
            .find(|(a, _)| a.name == name)
            .ok_or("Unexpected Actions artifact file/path.")?
            .0;
        let kind = (u32le(&central, cursor + 38) >> 16) & 0xf000;
        if !seen.insert(name.to_owned())
            || flags & !0x0808 != 0
            || ![0, 8].contains(&method)
            || ![0, 0x8000].contains(&kind)
            || u32le(&central, cursor + 38) & 0x10 != 0
            || u16le(&central, cursor + 34) != 0
            || expanded != asset.size
            || packed > ARTIFACT_LIMIT
            || (method == 0 && packed != expanded)
        {
            return Err("Unsafe, duplicated or mismatched Actions ZIP entry.".into());
        }
        let local_offset = u32le(&central, cursor + 42) as u64;
        let local = zip_read(&mut file, size, local_offset, 30)?;
        let data = local_offset + 30 + u16le(&local, 26) as u64 + u16le(&local, 28) as u64;
        if u32le(&local, 0) != 0x04034b50
            || u16le(&local, 6) != flags
            || u16le(&local, 8) != method
            || data + packed > offset
            || zip_read(
                &mut file,
                size,
                local_offset + 30,
                u16le(&local, 26) as usize,
            )? != name.as_bytes()
            || (flags & 8 == 0
                && (u32le(&local, 18) as u64 != packed
                    || u32le(&local, 22) as u64 != expanded
                    || u32le(&local, 14) != u32le(&central, cursor + 16)))
        {
            return Err("Inconsistent Actions ZIP local header.".into());
        }
        ranges.push((local_offset, data + packed));
        file.seek(SeekFrom::Start(data))?;
        let input = (&mut file).take(packed);
        let source: Box<dyn Read + '_> = if method == 8 {
            Box::new(flate2::read::DeflateDecoder::new(input))
        } else {
            Box::new(input)
        };
        // Use the prevalidated candidate filename, never the transport path.
        let target = destination.join(&asset.name);
        let mut output = File::create_new(&target)?;
        if std::io::copy(&mut source.take(expanded + 1), &mut output)? != expanded {
            return Err("Expanded Actions artifact exceeds or differs from candidate size.".into());
        }
        drop(output);
        let (size, hash) = hash_file(&target)?;
        if size != asset.size || hash != asset.sha256 {
            return Err(
                "Candidate bytes differ from the trusted same-run Actions artifact.".into(),
            );
        }
        result.push((asset.clone(), target));
        cursor = next;
    }
    ranges.sort_unstable();
    if cursor != central.len() || ranges[0].1 > ranges[1].0 {
        return Err("Overlapping or unexpected Actions ZIP data.".into());
    }
    Ok(result)
}

fn verified_run_files(
    gate: &Gate,
    started: i64,
    files: &[(Asset, PathBuf)],
    staging: &Staging,
) -> Result<Vec<(Asset, PathBuf)>> {
    if files.len() != 4 {
        return Err("Exactly four candidate files are required.".into());
    }
    let artifacts = run_artifacts(
        gate,
        started,
        &api(&format!(
            "actions/runs/{}/artifacts?per_page=100",
            gate.run_id
        ))?,
    )?;
    let destination = staging.0.join("verified");
    fs::create_dir(&destination)?;
    let mut verified = Vec::new();
    for (artifact, expected) in artifacts.iter().zip(files.as_chunks::<2>().0) {
        let path = staging.0.join(format!("{}.zip", artifact.id));
        let (output, _) = gh_output(
            &api_args(&format!("actions/artifacts/{}/zip", artifact.id), "GET"),
            900,
            File::create_new(&path)?,
            artifact.size,
        )?;
        drop(output);
        verify_download(&path, artifact)?;
        if run_artifact(
            gate,
            started,
            &api(&format!("actions/artifacts/{}", artifact.id))?,
        )? != *artifact
        {
            return Err("Trusted Actions artifact identity changed during download.".into());
        }
        verified.extend(match_artifact_files(&path, expected, &destination)?);
        fs::remove_file(path)?;
    }
    Ok(verified)
}

fn draft(value: &Value, tag: &str) -> Result<u64> {
    if value["tag_name"] != tag || value["draft"] != true {
        return Err(
            "This release is already public or changed; never modify public artifacts.".into(),
        );
    }
    value["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| "Missing draft release ID.".into())
}

fn existing(tag: &str) -> Result<Option<u64>> {
    for page in 1..=10 {
        let response = api(&format!("releases?per_page=100&page={page}"))?;
        let releases = response.as_array().ok_or("Invalid release listing.")?;
        if releases.len() > 100 {
            return Err("Release listing exceeded its limit.".into());
        }
        if let Some(release) = releases.iter().find(|r| r["tag_name"] == tag) {
            return Ok(Some(draft(release, tag)?));
        }
        if releases.len() < 100 {
            return Ok(None);
        }
    }
    Err("Release history exceeded the bounded listing; publication refused.".into())
}

fn uploaded(
    value: &Value,
    expected: &[(Asset, PathBuf)],
    complete: bool,
) -> Result<BTreeSet<String>> {
    let assets = value.as_array().ok_or("Missing release assets.")?;
    if assets.len() > expected.len() || (complete && assets.len() != expected.len()) {
        return Err("Release asset count mismatch; retained as draft.".into());
    }
    let mut names = BTreeSet::new();
    for asset in assets {
        let name = asset["name"].as_str().ok_or("Missing asset name.")?;
        let wanted = expected
            .iter()
            .find(|(item, _)| item.name == name)
            .ok_or("Unexpected draft asset; refusing replacement.")?;
        if !names.insert(name.into())
            || asset["state"] != "uploaded"
            || asset["size"].as_u64() != Some(wanted.0.size)
            || asset["digest"] != format!("sha256:{}", wanted.0.sha256)
        {
            return Err(
                "Remote asset digest/size mismatch or absent; refusing replacement.".into(),
            );
        }
    }
    Ok(names)
}

struct Staging(PathBuf);
impl Staging {
    fn new() -> Result<Self> {
        let path = env::temp_dir().join(format!("morrow-publish-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn publish(
    tag: &str,
    version: &str,
    notes: &[u8],
    bytes: &[u8],
    signature: &str,
    gate: &Gate,
    mut files: Vec<(Asset, PathBuf)>,
) -> Result<()> {
    verify_gate(gate)?;
    let existing = existing(tag)?;
    let staging = Staging::new()?;
    let notes_file = staging.0.join("release-notes.md");
    fs::write(&notes_file, notes)?;
    for (name, bytes) in [
        ("update-manifest.json", bytes),
        ("update-manifest.sig", signature.as_bytes()),
    ] {
        let path = staging.0.join(name);
        fs::write(&path, bytes)?;
        files.push((asset_bytes(name, bytes), path));
    }
    // gh interprets # in upload paths as an asset-label delimiter.
    if files.iter().any(|(_, p)| p.to_string_lossy().contains('#')) {
        return Err("Upload paths must not contain #.".into());
    }
    let repo = [OsString::from("--repo"), OsString::from(REPOSITORY)];
    let id = if let Some(id) = existing {
        id
    } else {
        // verify_gate already requires this tag to resolve to the reviewed SHA.
        // Use the creation response, not an immediately repeated release listing.
        let request_file = staging.0.join("create-release.json");
        fs::write(
            &request_file,
            serde_json::to_vec(&serde_json::json!({
                "tag_name": tag,
                "target_commitish": gate.sha,
                "name": format!("Morrow Mail {version}"),
                "body": std::str::from_utf8(notes)?,
                "draft": true,
                "prerelease": false,
            }))?,
        )?;
        let mut args = api_args("releases", "POST");
        args.extend([OsString::from("--input"), request_file.into_os_string()]);
        let created: Value = serde_json::from_slice(&gh(&args, 120)?)
            .map_err(|_| "Invalid draft creation response.")?;
        draft(&created, tag)?
    };
    for (asset, path) in &files {
        let release = api(&format!("releases/{id}"))?;
        draft(&release, tag)?;
        let present = uploaded(
            &api(&format!("releases/{id}/assets?per_page=100"))?,
            &files,
            false,
        )?;
        if present.contains(&asset.name) {
            continue;
        }
        let (size, hash) = hash_file(path)?;
        if size != asset.size || hash != asset.sha256 {
            return Err("Local asset changed; retained as draft.".into());
        }
        let mut args = vec![
            "release".into(),
            "upload".into(),
            tag.into(),
            path.clone().into_os_string(),
        ];
        args.extend(repo.clone());
        gh(&args, 900)?;
    }
    verify_gate(gate)?;
    let release = api(&format!("releases/{id}"))?;
    draft(&release, tag)?;
    uploaded(
        &api(&format!("releases/{id}/assets?per_page=100"))?,
        &files,
        true,
    )?;
    let mut args = vec![
        "release".into(),
        "edit".into(),
        tag.into(),
        "--draft=false".into(),
        "--prerelease=false".into(),
        "--notes-file".into(),
        notes_file.into_os_string(),
    ];
    args.extend(repo);
    gh(&args, 120).map_err(|_| "Final publish request failed or its result is unknown; inspect GitHub before retrying.")?;
    let published = api(&format!("releases/{id}"))
        .map_err(|_| "Final publication could not be confirmed; inspect GitHub before retrying.")?;
    if published["tag_name"] != tag
        || published["draft"] != false
        || published["prerelease"] != false
    {
        return Err(
            "Final publication could not be confirmed; inspect GitHub before retrying.".into(),
        );
    }
    println!("Published {tag} with both platforms.");
    Ok(())
}

fn run(options: Options) -> Result<()> {
    let package: Value = serde_json::from_slice(&read(Path::new("package.json"), 1024 * 1024)?)?;
    let tag = options
        .tag
        .or_else(|| env::var("GITHUB_REF_NAME").ok())
        .unwrap_or_else(|| format!("v{}", package["version"].as_str().unwrap_or("")));
    let version = version(&package, &tag)?;
    let notes = read(&options.notes, 65536)?;
    if std::str::from_utf8(&notes)
        .map_err(|_| "Release notes must be UTF-8.")?
        .trim()
        .is_empty()
        || notes.contains(&0)
    {
        return Err("Release notes must contain nonempty UTF-8 text without NUL.".into());
    }
    let (manifest, files) = archives(&options.artifacts, &version)?;
    let bytes = serde_json::to_vec(&manifest)?;
    if bytes.len() > 16384 {
        return Err("Manifest exceeds the updater limit.".into());
    }
    if !options.publish {
        let signature = trusted_signature(&bytes, &version)?;
        println!(
            "Checked {tag}: both platform archives/checksums, explicit notes and legacy manifest. {} No files written or GitHub calls made.",
            if signature.is_some() {
                "Pinned signature verified."
            } else {
                "No signing key supplied; signature not checked."
            }
        );
        return Ok(());
    }
    let gate: Gate = serde_json::from_slice(&read(
        options
            .gate
            .as_deref()
            .ok_or("Publishing requires --gate-file.")?,
        65536,
    )?)?;
    ci_gate(&gate, &tag, |name| env::var(name).ok())?;
    if env::var_os("GH_TOKEN").is_none_or(|value| value.is_empty()) {
        return Err("Publishing requires GH_TOKEN.".into());
    }
    if env::var_os("MORROW_UPDATE_SIGNING_KEY").is_none_or(|value| value.is_empty()) {
        return Err("Publishing requires MORROW_UPDATE_SIGNING_KEY.".into());
    }
    let started = verify_gate(&gate)?;
    let staging = Staging::new()?;
    let files = verified_run_files(&gate, started, &files, &staging)?;
    // The private key is only used after GitHub-authenticated same-run bytes match.
    // Upload the verified staging copies, not mutable caller-supplied paths.
    verify_gate(&gate)?;
    let signature = trusted_signature(&bytes, &version)?
        .ok_or("Publishing requires MORROW_UPDATE_SIGNING_KEY.")?;
    publish(&tag, &version, &notes, &bytes, &signature, &gate, files)
}

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--help" {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    match options(args).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Release stopped: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signature;
    use serde_json::json;

    const VERSION: &str = "0.7.0";
    fn package() -> Value {
        json!({"version":VERSION,"repository":{"url":"git+https://github.com/Coke1120/Morrow-Mail.git"}})
    }
    fn gate() -> Gate {
        serde_json::from_value(json!({"repository":REPOSITORY,"tag":format!("v{VERSION}"),"sha":"a".repeat(40),"runId":99,"runAttempt":2,"platforms":{"macos-arm64":[1],"windows-x64":[2]}})).unwrap()
    }
    fn jobs() -> Value {
        let gate = gate();
        json!({"total_count":3,"jobs":[
            {"id":1,"run_id":99,"head_sha":gate.sha,"name":"check (macos-15)","labels":["macos-15"],"status":"completed","conclusion":"success"},
            {"id":2,"run_id":99,"head_sha":gate.sha,"name":"check (windows-2022)","labels":["windows-2022"],"status":"completed","conclusion":"success"},
            {"id":3,"run_id":99,"head_sha":gate.sha,"name":"release","status":"in_progress"}
        ]})
    }

    #[test]
    fn default_is_read_only_and_versions_are_exact_numbered_releases() {
        for mode in [None, Some("--check"), Some("--dry-run")] {
            let mut args = vec![OsString::from("--notes-file"), "notes.md".into()];
            if let Some(mode) = mode {
                args.push(mode.into());
            }
            assert!(!options(args).unwrap().publish);
        }
        assert!(
            options(["--publish", "--check", "--notes-file", "notes.md"].map(Into::into)).is_err()
        );
        assert!(options(["--publish"].map(Into::into)).is_err());
        assert!(version(&package(), &format!("v{VERSION}")).is_ok());
        assert!(version(&package(), "v0.7.1").is_err());
        let mut candidate = package();
        for value in ["0.7.0", "0.7.1", "0.8.0", "1.0.0"] {
            candidate["version"] = value.into();
            assert_eq!(version(&candidate, &format!("v{value}")).unwrap(), value);
        }
        for value in [
            "0.7",
            "0.7.0-beta.1",
            "0.7.0-alpha.1",
            "0.7.0-rc.1",
            "0.7.0+local",
            "01.7.0",
            "0.07.0",
            "0.7.00",
            "0.7.0\n",
        ] {
            candidate["version"] = value.into();
            assert!(
                version(&candidate, &format!("v{value}")).is_err(),
                "{value}"
            );
        }
        candidate["version"] = VERSION.into();
        candidate["repository"]["url"] = "git+https://github.com/Coke1120/genmail.git".into();
        assert!(version(&candidate, &format!("v{VERSION}")).is_err());
    }

    #[test]
    fn exact_paired_files_legacy_bytes_and_generated_key_signature() {
        let directory = Staging::new().unwrap();
        for platform in PLATFORMS {
            let name = format!("Morrow-Mail-{VERSION}-{platform}.zip");
            fs::write(directory.0.join(&name), b"fictional archive").unwrap();
            let hash = format!("{:x}", Sha256::digest(b"fictional archive"));
            fs::write(
                directory.0.join(format!("SHA256SUMS-{platform}.txt")),
                format!("{hash}  {name}\n"),
            )
            .unwrap();
        }
        let (manifest, files) = archives(&directory.0, VERSION).unwrap();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let hash = &files[0].0.sha256;
        let legacy = format!(
            "{{\"version\":\"{VERSION}\",\"platforms\":{{\"macos-arm64\":{{\"name\":\"Morrow-Mail-{VERSION}-macos-arm64.zip\",\"size\":17,\"sha256\":\"{hash}\"}},\"windows-x64\":{{\"name\":\"Morrow-Mail-{VERSION}-windows-x64.zip\",\"size\":17,\"sha256\":\"{hash}\"}}}}}}"
        );
        assert_eq!(bytes, legacy.as_bytes());
        let mut seed = Zeroizing::new([0_u8; 32]);
        getrandom::fill(seed.as_mut()).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let signature = signature(&bytes, &key);
        let raw = STANDARD.decode(&signature).unwrap();
        assert_eq!(signature.len(), 88);
        key.verifying_key()
            .verify_strict(&bytes, &Signature::from_slice(&raw).unwrap())
            .unwrap();
        assert!(
            key.verifying_key()
                .verify_strict(b"altered manifest", &Signature::from_slice(&raw).unwrap())
                .is_err()
        );
        assert!(
            verify_manifest(&bytes, &signature, VERSION, PUBLIC_KEY).is_err(),
            "Fixture key cannot replace production trust"
        );
        fs::write(directory.0.join("extra.txt"), "extra").unwrap();
        assert!(archives(&directory.0, VERSION).is_err());
        fs::remove_file(directory.0.join("extra.txt")).unwrap();
        fs::write(directory.0.join("SHA256SUMS-windows-x64.txt"), "wrong\n").unwrap();
        assert!(archives(&directory.0, VERSION).is_err());
        let oversized = directory
            .0
            .join(format!("Morrow-Mail-{VERSION}-macos-arm64.zip"));
        File::options()
            .write(true)
            .open(&oversized)
            .unwrap()
            .set_len(ARCHIVE_LIMIT + 1)
            .unwrap();
        assert!(hash_file(&oversized).is_err());
    }

    #[test]
    fn failed_incomplete_wrong_attempt_or_unpaired_gates_are_rejected() {
        let gate = gate();
        assert!(ci_gate(&gate, &gate.tag, |_| None).is_err());
        let mut context: BTreeMap<&str, String> = [
            ("GITHUB_ACTIONS", "true".into()),
            ("CI", "true".into()),
            ("GITHUB_REPOSITORY", REPOSITORY.into()),
            ("GITHUB_EVENT_NAME", "push".into()),
            ("GITHUB_REF_TYPE", "tag".into()),
            ("GITHUB_REF_NAME", gate.tag.clone()),
            ("GITHUB_REF", format!("refs/tags/{}", gate.tag)),
            ("GITHUB_JOB", "release".into()),
            ("GITHUB_SHA", gate.sha.clone()),
            ("GITHUB_RUN_ID", "99".into()),
            ("GITHUB_RUN_ATTEMPT", "2".into()),
            (
                "GITHUB_WORKFLOW_REF",
                format!(
                    "{REPOSITORY}/.github/workflows/check.yml@refs/tags/{}",
                    gate.tag
                ),
            ),
            ("GITHUB_API_URL", "https://api.github.com".into()),
        ]
        .into();
        ci_gate(&gate, &gate.tag, |name| context.get(name).cloned()).unwrap();
        context.insert("GITHUB_RUN_ATTEMPT", "1".into());
        assert!(ci_gate(&gate, &gate.tag, |name| context.get(name).cloned()).is_err());
        paired_jobs(&gate, &jobs()).unwrap();
        for (key, value) in [
            ("conclusion", json!("failure")),
            ("status", json!("in_progress")),
            ("head_sha", json!("b".repeat(40))),
            ("labels", json!(["ubuntu-latest"])),
        ] {
            let mut bad = jobs();
            bad["jobs"][0][key] = value;
            assert!(paired_jobs(&gate, &bad).is_err());
        }
        let mut incomplete = jobs();
        incomplete["total_count"] = 4.into();
        assert!(paired_jobs(&gate, &incomplete).is_err());
        let mut wrong_ids = self::gate();
        wrong_ids.platforms.get_mut("windows-x64").unwrap()[0] = 1;
        assert!(paired_jobs(&wrong_ids, &jobs()).is_err());
    }

    #[test]
    fn public_release_and_asset_overwrite_are_rejected() {
        assert!(
            draft(
                &json!({"id":1,"tag_name":"v1.0.0-beta.1","draft":false}),
                "v1.0.0-beta.1"
            )
            .is_err()
        );
        let asset = asset_bytes("fixture.zip", b"fixture");
        let uploaded_asset = json!({"name":asset.name,"size":asset.size,"digest":format!("sha256:{}",asset.sha256),"state":"uploaded"});
        let expected = vec![(asset, PathBuf::from("unused-fixture.zip"))];
        assert!(uploaded(&json!([]), &expected, false).unwrap().is_empty());
        uploaded(&json!([uploaded_asset.clone()]), &expected, true).unwrap();
        assert!(uploaded(&json!([]), &expected, true).is_err());
        let mut bad = uploaded_asset.clone();
        bad["digest"] = Value::Null;
        assert!(uploaded(&json!([bad]), &expected, false).is_err());
        assert!(
            uploaded(
                &json!([uploaded_asset.clone(), uploaded_asset]),
                &expected,
                false
            )
            .is_err()
        );
    }

    fn artifact_metadata(platform: &str, id: u64, bytes: &[u8]) -> Value {
        json!({"id":id,"name":format!("morrow-{platform}"),"size_in_bytes":bytes.len(),
            "digest":format!("sha256:{:x}",Sha256::digest(bytes)),"expired":false,
            "created_at":"2026-09-28T01:02:00Z","workflow_run":{"id":99,"head_sha":gate().sha}})
    }

    #[test]
    fn same_run_artifact_identity_rejects_wrong_run_commit_attempt_or_digest() {
        let gate = gate();
        let started = timestamp(&json!("2026-09-28T01:00:00Z")).unwrap();
        let mac = artifact_metadata(PLATFORMS[0], 10, b"transport");
        let windows = artifact_metadata(PLATFORMS[1], 20, b"transport");
        let listing = json!({"total_count":2,"artifacts":[mac.clone(),windows.clone()]});
        let selected = run_artifacts(&gate, started, &listing).unwrap();
        assert_eq!(selected.iter().map(|a| a.id).collect::<Vec<_>>(), [10, 20]);
        for (key, value) in [
            ("id", json!(0)),
            ("name", json!("morrow-other-platform")),
            ("expired", json!(true)),
            ("digest", Value::Null),
            ("size_in_bytes", json!(ARTIFACT_LIMIT + 1)),
            ("created_at", json!("2026-09-28T00:59:59Z")),
            ("workflow_run", json!({"id":98,"head_sha":gate.sha})),
            ("workflow_run", json!({"id":99,"head_sha":"b".repeat(40)})),
        ] {
            let mut bad = mac.clone();
            bad[key] = value;
            assert!(run_artifact(&gate, started, &bad).is_err(), "{key}");
        }
        for bad in [
            json!({"total_count":3,"artifacts":[mac.clone(),windows]}),
            json!({"total_count":2,"artifacts":[mac.clone(),mac.clone()]}),
            json!({"total_count":1,"artifacts":[mac]}),
        ] {
            assert!(run_artifacts(&gate, started, &bad).is_err());
        }
    }

    fn fixture_pair(platform: &str, bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let name = format!("Morrow-Mail-{VERSION}-{platform}.zip");
        let checksum = format!("{:x}  {name}\n", Sha256::digest(bytes));
        vec![
            (name, bytes.to_vec()),
            (format!("SHA256SUMS-{platform}.txt"), checksum.into_bytes()),
        ]
    }

    // Generated, nonproduction ZIP32 fixtures, including deflate/data descriptors
    // as used by Actions. No network, subprocess, signing key or git writes.
    fn fixture_zip(entries: &[(String, Vec<u8>)], deflate: bool) -> Vec<u8> {
        fn put16(bytes: &mut [u8], at: usize, n: u16) {
            bytes[at..at + 2].copy_from_slice(&n.to_le_bytes());
        }
        fn put32(bytes: &mut [u8], at: usize, n: u32) {
            bytes[at..at + 4].copy_from_slice(&n.to_le_bytes());
        }
        let mut zip = Vec::new();
        let mut directory = Vec::new();
        for (name, data) in entries {
            let crc = !data.iter().fold(!0_u32, |crc, byte| {
                (0..8).fold(crc ^ u32::from(*byte), |n, _| {
                    (n >> 1) ^ (0xedb88320 & 0_u32.wrapping_sub(n & 1))
                })
            });
            let packed = if deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(data).unwrap();
                encoder.finish().unwrap()
            } else {
                data.clone()
            };
            let offset = zip.len() as u32;
            let method = if deflate { 8 } else { 0 };
            let mut local = vec![0; 30];
            put32(&mut local, 0, 0x04034b50);
            put16(&mut local, 4, 20);
            put16(&mut local, 6, 0x0808);
            put16(&mut local, 8, method);
            put16(&mut local, 26, name.len() as u16);
            zip.extend(local);
            zip.extend(name.as_bytes());
            zip.extend(&packed);
            for n in [0x08074b50, crc, packed.len() as u32, data.len() as u32] {
                zip.extend(n.to_le_bytes());
            }
            let mut central = vec![0; 46];
            put32(&mut central, 0, 0x02014b50);
            put16(&mut central, 4, 0x0314);
            put16(&mut central, 6, 20);
            put16(&mut central, 8, 0x0808);
            put16(&mut central, 10, method);
            put32(&mut central, 16, crc);
            put32(&mut central, 20, packed.len() as u32);
            put32(&mut central, 24, data.len() as u32);
            put16(&mut central, 28, name.len() as u16);
            put32(&mut central, 38, 0o100644 << 16);
            put32(&mut central, 42, offset);
            directory.extend(central);
            directory.extend(name.as_bytes());
        }
        let mut end = vec![0; 22];
        put32(&mut end, 0, 0x06054b50);
        put16(&mut end, 8, entries.len() as u16);
        put16(&mut end, 10, entries.len() as u16);
        put32(&mut end, 12, directory.len() as u32);
        put32(&mut end, 16, zip.len() as u32);
        zip.extend(directory);
        zip.extend(end);
        zip
    }

    #[test]
    fn same_version_wrong_artifact_bytes_rejected_before_signing() {
        let candidate = Staging::new().unwrap();
        for platform in PLATFORMS {
            for (name, bytes) in fixture_pair(platform, b"run A payload") {
                fs::write(candidate.0.join(name), bytes).unwrap();
            }
        }
        let (_, files) = archives(&candidate.0, VERSION).unwrap();
        let download = Staging::new().unwrap();
        let path = download.0.join("transport.zip");
        let started = timestamp(&json!("2026-09-28T01:00:00Z")).unwrap();
        // Same version, exact names, sizes, self-consistent checksums, and trusted
        // transport digest still cannot authorize a different candidate payload.
        let wrong = fixture_zip(&fixture_pair(PLATFORMS[0], b"run B payload"), true);
        fs::write(&path, &wrong).unwrap();
        let artifact = run_artifact(
            &gate(),
            started,
            &artifact_metadata(PLATFORMS[0], 10, &wrong),
        )
        .unwrap();
        verify_download(&path, &artifact).unwrap();
        let output = Staging::new().unwrap();
        let error = match_artifact_files(&path, &files[..2], &output.0)
            .err()
            .unwrap();
        assert!(error.to_string().contains("Candidate bytes differ"));

        for deflate in [false, true] {
            let paired = Staging::new().unwrap();
            for (platform, expected) in PLATFORMS.iter().zip(files.as_chunks::<2>().0) {
                let zip = fixture_zip(&fixture_pair(platform, b"run A payload"), deflate);
                fs::write(&path, &zip).unwrap();
                let metadata =
                    run_artifact(&gate(), started, &artifact_metadata(platform, 10, &zip)).unwrap();
                verify_download(&path, &metadata).unwrap();
                match_artifact_files(&path, expected, &paired.0).unwrap();
            }
            let (verified, copies) = archives(&paired.0, VERSION).unwrap();
            assert_eq!(verified.platforms.len(), 2);
            assert_eq!(copies.len(), 4);
        }
        // Digest failure is separate from inner-file SHA matching.
        fs::write(&path, b"tampered transport").unwrap();
        assert!(verify_download(&path, &artifact).is_err());
    }

    #[test]
    fn actions_zip_rejects_paths_links_duplicates_and_expansion_overflow() {
        let pair = fixture_pair(PLATFORMS[0], b"run A payload");
        let expected: Vec<_> = pair
            .iter()
            .map(|(name, bytes)| (asset_bytes(name, bytes), PathBuf::new()))
            .collect();
        let good = fixture_zip(&pair, true);
        let mut traversal = pair.clone();
        traversal[0].0 = "../outside.zip".into();
        let mut link = good.clone();
        let central = u32le(&link, link.len() - 6) as usize;
        link[central + 38..central + 42].copy_from_slice(&(0o120777_u32 << 16).to_le_bytes());
        let mut expanded = pair.clone();
        expanded[0].1 = vec![b'x'; 1024 * 1024];
        let mut bomb = fixture_zip(&expanded, true);
        let central = u32le(&bomb, bomb.len() - 6) as usize;
        bomb[central + 24..central + 28].copy_from_slice(&(pair[0].1.len() as u32).to_le_bytes());
        for zip in [
            fixture_zip(&traversal, false),
            link,
            fixture_zip(&[pair[0].clone(), pair[0].clone()], false),
            bomb,
            good[..good.len() - 1].to_vec(),
        ] {
            let download = Staging::new().unwrap();
            let output = Staging::new().unwrap();
            let path = download.0.join("transport.zip");
            fs::write(&path, zip).unwrap();
            assert!(match_artifact_files(&path, &expected, &output.0).is_err());
            for entry in fs::read_dir(&output.0).unwrap() {
                let entry = entry.unwrap();
                let allowed = expected
                    .iter()
                    .find(|(a, _)| entry.file_name() == a.name.as_str())
                    .unwrap();
                assert!(entry.metadata().unwrap().len() <= allowed.0.size + 1);
            }
        }
    }
}
