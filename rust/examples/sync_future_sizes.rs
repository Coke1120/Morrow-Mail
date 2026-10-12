//! Construct-only size probe; no future is polled and no provider is contacted.
use morrow_search::{
    cli, mail,
    service::{App, Context},
};
use serde_json::json;
fn main() {
    let root = std::env::temp_dir().join(format!("morrow-future-size-{}", uuid::Uuid::new_v4()));
    let app = App::open(&root, 0, "synthetic".into(), String::new()).unwrap();
    let owners = vec!["demo".to_owned()];
    let ctx = Context {
        method: "GET".parse().unwrap(),
        path: vec!["messages".into(), "missing".into()],
        body: json!({}),
        query: json!({}),
        headers: Default::default(),
        owner: "demo".into(),
        paged: true,
    };
    println!(
        "{}",
        json!({"cliMain":std::mem::size_of_val(&cli::main(Vec::new())),"cliExecute":std::mem::size_of_val(&cli::execute(&app,cli::Command::Read{account:"all".into(),id:"missing".into()})),"mailSync":std::mem::size_of_val(&mail::sync(&app,&owners)),"mailHandle":std::mem::size_of_val(&mail::handle(&app,&ctx))})
    );
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}
