fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    let package: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("../package.json").expect("package.json"))
            .expect("valid package.json");
    println!(
        "cargo:rustc-env=MORROW_VERSION={}",
        package["version"].as_str().expect("version")
    );
}
