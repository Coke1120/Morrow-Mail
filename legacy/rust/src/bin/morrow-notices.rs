//! Production notices in deterministic UTF-8 byte order; honors CARGO_NET_OFFLINE.
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env,
    error::Error,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::LazyLock,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const NOTICE_LIMIT: u64 = 2 * 1024 * 1024;
const METADATA_LIMIT: u64 = 16 * 1024 * 1024;
const LICENSES: &[&str] = &[
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Unicode-3.0",
    "0BSD",
    "Zlib",
    "MPL-2.0",
    "MIT-0",
    "CC0-1.0",
    "BSL-1.0",
    "Unlicense",
];
const OMITTED: &[&str] = &["hashify@0.2.9", "imap-proto@0.16.7", "stop-token@0.7.0"];

// Match ECMAScript whitespace so both the old parser and notice trimming agree.
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

struct Expression<'a> {
    tokens: Vec<&'a str>,
    cursor: usize,
}
impl<'a> Expression<'a> {
    fn take(&mut self, token: &str) -> bool {
        if self.tokens.get(self.cursor) == Some(&token) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn atom(&mut self, depth: usize) -> Result<Option<Vec<&'a str>>> {
        if depth > 64 {
            return Err("License expression is too deeply nested.".into());
        }
        if self.take("(") {
            let value = self.or(depth + 1)?;
            if !self.take(")") {
                return Err("Unclosed license expression.".into());
            }
            return Ok(value);
        }
        let id = *self
            .tokens
            .get(self.cursor)
            .ok_or("Incomplete license expression.")?;
        self.cursor += 1;
        if matches!(id, "AND" | "OR" | "WITH" | ")") {
            return Err("Invalid license expression.".into());
        }
        if self.take("WITH") {
            let exception = self
                .tokens
                .get(self.cursor)
                .ok_or("Missing license exception.")?;
            if matches!(*exception, "AND" | "OR" | "WITH" | "(" | ")") {
                return Err("Invalid license exception.".into());
            }
            self.cursor += 1;
            return Ok(None);
        }
        Ok(LICENSES.contains(&id).then(|| vec![id]))
    }
    fn and(&mut self, depth: usize) -> Result<Option<Vec<&'a str>>> {
        let mut value = self.atom(depth)?;
        while self.take("AND") {
            value = match (value, self.atom(depth)?) {
                (Some(mut left), Some(right)) => {
                    for item in right {
                        if !left.contains(&item) {
                            left.push(item);
                        }
                    }
                    Some(left)
                }
                _ => None,
            };
        }
        Ok(value)
    }
    fn or(&mut self, depth: usize) -> Result<Option<Vec<&'a str>>> {
        let mut value = self.and(depth)?;
        while self.take("OR") {
            let next = self.and(depth)?;
            value = if next.as_deref() == Some(&["Apache-2.0"][..]) {
                next
            } else {
                value.or(next)
            };
        }
        Ok(value)
    }
}

fn license_choice(expression: &str) -> Result<Vec<String>> {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(|\)|[A-Za-z0-9.+-]+").unwrap());
    if expression.len() > 4096 {
        return Err("Oversized license expression.".into());
    }
    let expression = expression.replace('/', " OR ");
    let tokens: Vec<_> = TOKEN
        .find_iter(&expression)
        .map(|item| item.as_str())
        .collect();
    if tokens.concat()
        != expression
            .chars()
            .filter(|c| !whitespace(*c))
            .collect::<String>()
    {
        return Err("Invalid license expression.".into());
    }
    let mut parser = Expression { tokens, cursor: 0 };
    let selected = parser.or(0)?.ok_or("Unreviewed required license.")?;
    if parser.cursor != parser.tokens.len() {
        return Err("Invalid license expression.".into());
    }
    Ok(selected.into_iter().map(str::to_owned).collect())
}

#[derive(Deserialize)]
struct Metadata {
    packages: Vec<Package>,
    resolve: Resolve,
}
#[derive(Deserialize)]
struct Resolve {
    root: Option<String>,
    nodes: Vec<Node>,
}
#[derive(Deserialize)]
struct Node {
    id: String,
    deps: Vec<Dependency>,
}
#[derive(Deserialize)]
struct Dependency {
    pkg: String,
    dep_kinds: Vec<Kind>,
}
#[derive(Deserialize)]
struct Kind {
    kind: Option<String>,
}
#[derive(Deserialize)]
struct Package {
    id: String,
    name: String,
    version: String,
    source: Option<String>,
    license: Option<String>,
    license_file: Option<PathBuf>,
    manifest_path: PathBuf,
    authors: Vec<String>,
    repository: Option<String>,
    homepage: Option<String>,
}

fn dependencies(metadata: &Metadata) -> Result<Vec<&Package>> {
    let root = metadata
        .resolve
        .root
        .as_ref()
        .ok_or("Cargo metadata has no root package.")?;
    let nodes: HashMap<_, _> = metadata
        .resolve
        .nodes
        .iter()
        .map(|node| (&node.id, node))
        .collect();
    let packages: HashMap<_, _> = metadata
        .packages
        .iter()
        .map(|item| (&item.id, item))
        .collect();
    if nodes.len() != metadata.resolve.nodes.len() || packages.len() != metadata.packages.len() {
        return Err("Cargo metadata contains duplicate IDs.".into());
    }
    let mut seen = HashSet::new();
    let mut pending = vec![root];
    let mut result = Vec::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let node = nodes
            .get(id)
            .ok_or("Cargo returned an incomplete dependency graph.")?;
        let package = packages
            .get(id)
            .ok_or("Cargo returned an unknown package.")?;
        if id != root {
            result.push(*package);
        }
        for dep in &node.deps {
            if dep
                .dep_kinds
                .iter()
                .any(|kind| kind.kind.is_none() || kind.kind.as_deref() == Some("build"))
            {
                pending.push(&dep.pkg);
            }
        }
    }
    result.sort_by_key(|item| format!("{}@{}", item.name, item.version));
    if result.is_empty() {
        return Err("The Rust dependency license list is empty.".into());
    }
    Ok(result)
}

fn cargo_metadata(target: &str) -> Result<Metadata> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing repository root.")?;
    let mut child = Command::new("cargo")
        .args([
            "metadata",
            "--manifest-path",
            "rust/Cargo.toml",
            "--locked",
            "--format-version",
            "1",
            "--filter-platform",
            target,
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or("Missing Cargo stdout.")?
        .take(METADATA_LIMIT + 1)
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() as u64 > METADATA_LIMIT {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Could not read Cargo metadata within 16 MiB.".into());
    }
    if !child.wait()?.success() {
        return Err("cargo metadata failed; verify the lockfile, target and dependency source availability (CARGO_NET_OFFLINE is honored).".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn safe_path(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut path = root.to_owned();
    for component in relative.components() {
        match component {
            Component::CurDir => (),
            Component::Normal(part) => {
                path.push(part);
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err("A license path contains a symbolic link.".into());
                }
            }
            _ => return Err("License escapes its source package.".into()),
        }
    }
    let path = fs::canonicalize(path)?;
    if !path.starts_with(root) || path == root {
        return Err("License escapes its source package.".into());
    }
    Ok(path)
}

fn read_text(root: &Path, relative: &Path) -> Result<String> {
    let path = safe_path(root, relative)?;
    if !fs::metadata(&path)?.is_file() {
        return Err("A license notice is not a regular file.".into());
    }
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > NOTICE_LIMIT {
        return Err("Invalid or oversized license notice.".into());
    }
    let mut bytes = Vec::new();
    file.take(NOTICE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > NOTICE_LIMIT {
        return Err("Oversized license notice.".into());
    }
    let text = String::from_utf8(bytes)?;
    if text.trim_matches(whitespace).is_empty() || text.contains(['\0', '\u{fffd}']) {
        return Err("Unreadable license notice.".into());
    }
    Ok(text)
}

struct Notice {
    name: String,
    content: String,
}
fn notice_files(root: &Path) -> Result<Vec<Notice>> {
    static NAME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:(?:licen[sc]e|copying|notice|copyright)(?:[._-]|$)|THIRD[_-]PARTY[_-](?:LICENSES|NOTICES))").unwrap()
    });
    let mut files = Vec::new();
    let mut pending = vec![(root.to_owned(), false)];
    while let Some((directory, license_directory)) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(root)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or("Non-UTF-8 source path.")?;
            if kind.is_dir() {
                let path = safe_path(root, relative)?;
                pending.push((
                    path,
                    license_directory
                        || name.eq_ignore_ascii_case("license")
                        || name.eq_ignore_ascii_case("licenses"),
                ));
            } else if kind.is_file() && (license_directory || NAME.is_match(name)) {
                files.push(Notice {
                    name: relative
                        .to_str()
                        .ok_or("Non-UTF-8 notice path.")?
                        .replace(std::path::MAIN_SEPARATOR, "/"),
                    content: read_text(root, relative)?,
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn package_root(item: &Package) -> Result<PathBuf> {
    Ok(fs::canonicalize(
        item.manifest_path
            .parent()
            .ok_or("Missing package source directory.")?,
    )?)
}
fn package_notices(
    item: &Package,
    selected: &[String],
    apache: Option<&str>,
) -> Result<Vec<Notice>> {
    let root = package_root(item)?;
    read_text(
        &root,
        Path::new(
            item.manifest_path
                .file_name()
                .ok_or("Missing package manifest.")?,
        ),
    )?;
    let mut notices = notice_files(&root)?;
    if let Some(path) = &item.license_file {
        let content = read_text(&root, path)?;
        let name = path
            .to_str()
            .ok_or("Non-UTF-8 license path.")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if !notices.iter().any(|notice| notice.name == name) {
            notices.push(Notice { name, content });
        }
    }
    if notices.is_empty() {
        if !OMITTED.contains(&format!("{}@{}", item.name, item.version).as_str())
            || selected != ["Apache-2.0"]
        {
            return Err(format!(
                "Missing redistribution license text for {}@{}.",
                item.name, item.version
            )
            .into());
        }
        notices.push(Notice {
            name: "Apache-2.0 (standard text; upstream archive omitted its linked license files)"
                .into(),
            content: apache.ok_or("Missing standard Apache-2.0 text.")?.into(),
        });
        notices.push(Notice {
            name: "Upstream README attribution".into(),
            content: read_text(&root, Path::new("README.md"))?,
        });
    }
    Ok(notices)
}

fn encoded(value: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, SET).to_string()
}
fn render_notices(notices: &[Notice]) -> String {
    notices
        .iter()
        .map(|file| {
            format!(
                "--- {} ---\n{}\n",
                file.name,
                file.content.trim_matches(whitespace)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn opencc_section(root: &Path) -> Result<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(&read_text(root, Path::new("manifest.json"))?)?;
    if manifest["formatVersion"] != 1 || manifest["resourceVersion"] != 1 {
        return Err("Unsupported OpenCC resource manifest.".into());
    }
    let files = manifest["files"]
        .as_array()
        .ok_or("Missing OpenCC file manifest.")?;
    let packages = manifest["provenance"]["opencc"]["packages"]
        .as_array()
        .ok_or("Missing OpenCC provenance.")?;
    let package = packages
        .iter()
        .find(|item| item["name"] == "opencc-js")
        .ok_or("Missing opencc-js provenance.")?;
    let data = packages
        .iter()
        .find(|item| item["name"] == "opencc-data")
        .ok_or("Missing opencc-data provenance.")?;
    for item in [package, data] {
        license_choice(item["license"].as_str().ok_or("Missing OpenCC license.")?)?;
        let name = item["name"]
            .as_str()
            .ok_or("Missing OpenCC package name.")?;
        let version = item["version"].as_str().ok_or("Missing OpenCC version.")?;
        if item["sourceArchive"]
            != format!("https://registry.npmjs.org/{name}/-/{name}-{version}.tgz")
        {
            return Err("Invalid OpenCC source archive.".into());
        }
    }
    let mut notices = Vec::new();
    for (name, original) in [
        ("opencc.json", None),
        ("OPENCC-JS-LICENSE.txt", Some("LICENSE")),
        ("OPENCC-DATA-LICENSE.txt", Some("LICENSES/Apache-2.0.txt")),
        ("OPENCC-NOTICES.md", Some("THIRD_PARTY_LICENSES.md")),
    ] {
        let content = read_text(root, Path::new(name))?;
        let entry = files
            .iter()
            .find(|item| item["name"] == name)
            .ok_or("Missing OpenCC notice checksum.")?;
        if entry["bytes"].as_u64() != Some(content.len() as u64)
            || entry["sha256"] != format!("{:x}", Sha256::digest(content.as_bytes()))
        {
            return Err(format!("OpenCC resource {name} differs from its manifest.").into());
        }
        if let Some(name) = original {
            notices.push(Notice {
                name: name.into(),
                content,
            });
        }
    }
    Ok(format!(
        "OpenCC generated dictionary resource: opencc-js {}\nSource archive: {}\nDictionary source archive: {}\nThe canonical rust/resources/opencc.json was generated from the pinned opencc-js presets and opencc-data dictionaries; see rust/resources/manifest.json and the upstream data notices below.\n\n{}",
        package["version"]
            .as_str()
            .ok_or("Missing OpenCC version.")?,
        package["sourceArchive"]
            .as_str()
            .ok_or("Missing OpenCC archive.")?,
        data["sourceArchive"]
            .as_str()
            .ok_or("Missing OpenCC data archive.")?,
        render_notices(&notices)
    ))
}

fn collect(target: &str, metadata: &Metadata) -> Result<String> {
    let dependencies = dependencies(metadata)?;
    // The published source links below refer to crates.io, never an alternate registry.
    for item in &dependencies {
        if item.source.as_deref() != Some("registry+https://github.com/rust-lang/crates.io-index") {
            return Err(format!(
                "Review the source distribution for {}@{}.",
                item.name, item.version
            )
            .into());
        }
    }
    let mut apache = None;
    for item in &dependencies {
        let root = package_root(item)?;
        if root.join("LICENSE-APACHE").try_exists()? {
            let text = read_text(&root, Path::new("LICENSE-APACHE"))?;
            if text
                .find("Apache License")
                .is_some_and(|start| text[start..].contains("Version 2.0"))
            {
                apache = Some(text);
                break;
            }
        }
    }
    let mut sections = vec![format!(
        "Morrow Mail third-party notices ({target})\nProduction normal/build dependency graph; dev-only dependencies excluded.\nUpstream dependency sources are unmodified. For MPL-2.0 covered packages, the exact corresponding source is available without charge at each package's source-archive URL below. The complete license texts and supplied attribution notices follow.\nPackage and notice sections use deterministic UTF-8 byte ordering."
    )];
    for item in dependencies {
        let license = item
            .license
            .as_deref()
            .ok_or("Package has no license expression.")?;
        let selected = license_choice(license).map_err(|error| {
            format!(
                "License review required for {}@{}: {error}",
                item.name, item.version
            )
        })?;
        let notices = package_notices(item, &selected, apache.as_deref())?;
        let authors = if item.authors.is_empty() {
            "See upstream attribution below.".into()
        } else {
            item.authors.join(", ")
        };
        let repository = item
            .repository
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(item.homepage.as_deref().filter(|s| !s.is_empty()))
            .unwrap_or("See source archive.");
        sections.push(format!("Package: {} {}\nDeclared license: {license}\nDistribution choice: {}\nAuthors: {authors}\nSource archive: https://crates.io/api/v1/crates/{}/{}/download\nRepository: {repository}\n\n{}", item.name, item.version, selected.join(" AND "), encoded(&item.name), encoded(&item.version), render_notices(&notices)));
    }
    sections.push(opencc_section(&fs::canonicalize(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
    )?)?);
    Ok(sections.join(&format!("\n{}\n\n", "=".repeat(80))) + "\n")
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 2
        || args[0] != "--target"
        || args[1].len() > 128
        || !args[1].starts_with(|c: char| c.is_ascii_alphanumeric())
        || !args[1]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
    {
        return Err(
            "Usage: morrow-notices --target TARGET_TRIPLE (CARGO_NET_OFFLINE is honored)".into(),
        );
    }
    let text = collect(&args[1], &cargo_metadata(&args[1])?)?;
    std::io::stdout().lock().write_all(text.as_bytes())?;
    Ok(())
}
fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("morrow-notices-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        fn package(&self, name: &str, version: &str) -> Package {
            serde_json::from_value(json!({"id":name,"name":name,"version":version,"source":"registry+fixture", "license":"Apache-2.0", "manifest_path":self.0.join("Cargo.toml"),"authors":[]})).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn licensed_alternatives_precedence_and_fail_closed() {
        for (expression, expected) in [
            (
                "(MIT OR Apache-2.0) AND Unicode-3.0",
                vec!["Apache-2.0", "Unicode-3.0"],
            ),
            ("Apache-2.0 OR GPL-2.0-only", vec!["Apache-2.0"]),
            (
                "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
                vec!["Apache-2.0"],
            ),
            ("MIT AND BSD-3-Clause OR Apache-2.0", vec!["Apache-2.0"]),
            ("MIT/Apache-2.0", vec!["Apache-2.0"]),
            ("MIT AND MIT", vec!["MIT"]),
            ("GPL-2.0-only OR MIT AND ISC", vec!["MIT", "ISC"]),
        ] {
            assert_eq!(
                license_choice(expression).unwrap(),
                expected,
                "{expression}"
            );
        }
        for expression in [
            "",
            "MIT AND Unknown-License",
            "GPL-2.0-only",
            "(MIT OR Apache-2.0",
            "MIT + nonsense",
            "MIT OR",
            "MIT WITH",
            "MIT WITH OR Apache-2.0",
            "MIT)",
            "MIT @ Apache-2.0",
        ] {
            assert!(license_choice(expression).is_err(), "{expression}");
        }
    }

    #[test]
    fn production_graph_excludes_dev_only_and_requires_complete_resolution() {
        let fixture = Fixture::new();
        let mut metadata = Metadata { packages: ["root", "normal", "build", "shared", "dev"].map(|name| fixture.package(name, "1")).into(), resolve: serde_json::from_value(json!({"root":"root","nodes":[
            {"id":"root","deps":[{"pkg":"normal","dep_kinds":[{"kind":null}]},{"pkg":"build","dep_kinds":[{"kind":"build"}]},{"pkg":"dev","dep_kinds":[{"kind":"dev"}]}]},
            {"id":"normal","deps":[{"pkg":"shared","dep_kinds":[{"kind":"dev"},{"kind":null}]}]},
            {"id":"build","deps":[{"pkg":"shared","dep_kinds":[{"kind":"build"}]}]},
            {"id":"shared","deps":[]}
        ]})).unwrap() };
        assert_eq!(
            dependencies(&metadata)
                .unwrap()
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["build", "normal", "shared"]
        );
        assert!(
            collect("fixture", &metadata)
                .unwrap_err()
                .to_string()
                .contains("Review the source distribution")
        );
        metadata.resolve.nodes.pop();
        assert!(dependencies(&metadata).is_err());
    }

    #[test]
    fn recursive_notices_limits_paths_and_exact_missing_file_exceptions() {
        let fixture = Fixture::new();
        fixture.write("Cargo.toml", "[package]");
        fixture.write("README.md", "Fixture attribution");
        let mut package = fixture.package("hashify", "0.2.9");
        let selected = vec!["Apache-2.0".into()];
        assert_eq!(
            package_notices(&package, &selected, Some("Apache License Version 2.0"))
                .unwrap()
                .len(),
            2
        );
        package.version = "0.3.0".into();
        assert!(package_notices(&package, &selected, Some("Apache License Version 2.0")).is_err());
        fixture.write("LICENSE", "MIT License");
        fixture.write("nested/CoPyInG.txt", "Nested attribution");
        fixture.write("nested/LICENSES/vendor.txt", "AWS-style vendor terms");
        fixture.write("LICENSED.txt", "Not a matching filename");
        assert_eq!(
            notice_files(&fixture.0)
                .unwrap()
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            [
                "LICENSE",
                "nested/CoPyInG.txt",
                "nested/LICENSES/vendor.txt"
            ]
        );
        for content in [
            b"".as_slice(),
            b"\xff",
            b"a\0b",
            "replacement \u{fffd}".as_bytes(),
        ] {
            fixture.write("LICENSE", content);
            assert!(notice_files(&fixture.0).is_err());
        }
        fixture.write("LICENSE", vec![b'x'; NOTICE_LIMIT as usize + 1]);
        assert!(notice_files(&fixture.0).is_err());
        assert!(read_text(&fixture.0, Path::new("../LICENSE")).is_err());
        assert!(read_text(&fixture.0, &fixture.0.join("README.md")).is_err());
        assert!(read_text(&fixture.0, Path::new("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_even_inside_a_package() {
        let fixture = Fixture::new();
        fixture.write("real.txt", "real terms");
        std::os::unix::fs::symlink(fixture.0.join("real.txt"), fixture.0.join("LICENSE")).unwrap();
        assert!(notice_files(&fixture.0).unwrap().is_empty());
        assert!(read_text(&fixture.0, Path::new("LICENSE")).is_err());
        std::os::unix::fs::symlink(fixture.0.parent().unwrap(), fixture.0.join("licenses"))
            .unwrap();
        assert!(notice_files(&fixture.0).unwrap().is_empty());
    }

    #[test]
    fn vendored_opencc_notices_retain_all_texts_and_archives() {
        let root =
            fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources")).unwrap();
        let section = opencc_section(&root).unwrap();
        for path in [
            "OPENCC-JS-LICENSE.txt",
            "OPENCC-DATA-LICENSE.txt",
            "OPENCC-NOTICES.md",
        ] {
            assert!(
                section.contains(
                    read_text(&root, Path::new(path))
                        .unwrap()
                        .trim_matches(whitespace)
                )
            );
        }
        assert!(section.contains("opencc-js-1.4.2.tgz"));
        assert!(section.contains("opencc-data-1.4.2.tgz"));
    }
}
