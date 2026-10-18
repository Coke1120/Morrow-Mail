//! Check or export the versioned static sources; no Node/npm generation step.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs, path::Path};

const MANIFEST: &[u8] = include_bytes!("../../resources/manifest.json");
const FILES: &[(&str, &[u8])] = &[
    (
        "catalog.json",
        include_bytes!("../../resources/catalog.json"),
    ),
    ("opencc.json", include_bytes!("../../resources/opencc.json")),
    (
        "OPENCC-JS-LICENSE.txt",
        include_bytes!("../../resources/OPENCC-JS-LICENSE.txt"),
    ),
    (
        "OPENCC-DATA-LICENSE.txt",
        include_bytes!("../../resources/OPENCC-DATA-LICENSE.txt"),
    ),
    (
        "OPENCC-NOTICES.md",
        include_bytes!("../../resources/OPENCC-NOTICES.md"),
    ),
];
type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    resource_version: u32,
    files: Vec<Resource>,
}
#[derive(Deserialize)]
struct Resource {
    name: String,
    bytes: usize,
    sha256: String,
}

fn check_file(name: &str, bytes: &[u8], resource: &Resource) -> Result<()> {
    if name != resource.name
        || bytes.len() != resource.bytes
        || format!("{:x}", Sha256::digest(bytes)) != resource.sha256
    {
        return Err(format!("Resource {name} differs from the versioned manifest.").into());
    }
    if name.ends_with(".json") {
        serde_json::from_slice::<serde_json::Value>(bytes)?;
    } else if std::str::from_utf8(bytes)?.trim().is_empty() {
        return Err(format!("Resource {name} is empty.").into());
    }
    Ok(())
}

fn check(directory: Option<&Path>) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(MANIFEST)?;
    if manifest.format_version != 1
        || manifest.resource_version != 1
        || manifest.files.len() != FILES.len()
    {
        return Err("Unsupported static resource manifest version or file list.".into());
    }
    if let Some(directory) = directory
        && fs::read(directory.join("manifest.json"))? != MANIFEST
    {
        return Err("Resource manifest changed; rebuild morrow-resources.".into());
    }
    for ((name, bytes), resource) in FILES.iter().zip(&manifest.files) {
        check_file(name, bytes, resource)?;
        if let Some(directory) = directory {
            check_file(name, &fs::read(directory.join(name))?, resource)?;
        }
    }
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.is_empty() || args.len() == 1 && args[0] == "--check" {
        check(Some(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        ))?;
        println!(
            "Static resources v1: exact catalog, OpenCC 1.4.2 and redistribution notices verified."
        );
    } else if args.len() == 2 && args[0] == "--output" {
        check(None)?;
        let directory = Path::new(&args[1]);
        // An export is a new directory, never an overwrite of checked-in sources.
        fs::create_dir(directory)?;
        for (name, bytes) in FILES
            .iter()
            .copied()
            .chain(std::iter::once(("manifest.json", MANIFEST)))
        {
            use std::io::Write;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join(name))?
                .write_all(bytes)?;
        }
        check(Some(directory))?;
        println!("Static resources v1 exported to {}.", directory.display());
    } else {
        return Err("Usage: morrow-resources [--check | --output NEW_DIRECTORY]".into());
    }
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
    use morrow_search::normalize::{normalize, tokens};
    use serde_json::Value;
    use std::collections::BTreeSet;

    #[test]
    fn exact_resources_and_corruption_rejection() {
        check(Some(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        ))
        .unwrap();
        let manifest: Manifest = serde_json::from_slice(MANIFEST).unwrap();
        for ((name, bytes), resource) in FILES.iter().zip(&manifest.files) {
            let mut changed = bytes.to_vec();
            changed[0] ^= 1;
            assert!(check_file(name, &changed, resource).is_err(), "{name}");
        }
    }

    #[test]
    fn complete_pinned_opencc_and_unicode_golden() {
        let dictionary: Value = serde_json::from_slice(FILES[1].1).unwrap();
        let groups = dictionary["normalization"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&dictionary["segmentation"]))
            .chain(dictionary["conversion"].as_array().unwrap());
        let mut inputs = BTreeSet::new();
        for group in groups {
            for entry in group.as_array().unwrap() {
                inputs.insert(entry[0].as_str().unwrap());
            }
        }
        let manifest: Value = serde_json::from_slice(MANIFEST).unwrap();
        let golden = &manifest["searchGolden"];
        let mut inputs: Vec<_> = inputs.into_iter().collect();
        inputs.extend(
            golden["additionalInputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| input.as_str().unwrap()),
        );
        assert_eq!(inputs.len() as u64, golden["cases"].as_u64().unwrap());
        let actual: Vec<_> = inputs
            .iter()
            .map(|input| (*input, normalize(input), tokens(input)))
            .collect();
        let bytes = serde_json::to_vec(&actual).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            golden["sha256"].as_str().unwrap()
        );
    }
}
