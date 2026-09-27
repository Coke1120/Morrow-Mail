use morrow_search::{
    error::{Error, Result},
    service::App,
};
use serde::Deserialize;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    token: String,
    data_directory: PathBuf,
    #[serde(default)]
    port: u16,
    #[serde(default, rename = "parentPID")]
    parent_pid: Option<u32>,
    #[serde(default)]
    update_token: String,
    #[serde(default)]
    asset_directory: Option<PathBuf>,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("cli") {
        std::process::exit(morrow_search::cli::main(std::env::args().skip(2).collect()).await);
    }
    if std::env::args().skip(1).eq(["--update-installer"]) {
        std::process::exit(morrow_search::updater::installer_main().await);
    }
    if std::env::args().skip(1).eq(["--version"]) {
        println!("Morrow Mail {}", env!("MORROW_VERSION"));
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--backup") {
        let args = std::env::args_os()
            .skip(2)
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let result = if args.len() == 2
            && args.iter().all(|path| path.is_absolute())
            && args[0].join("genmail.sqlite").is_file()
        {
            morrow_search::store::Store::open(&args[0]).and_then(|db| db.backup(&args[1]))
        } else {
            Err(Error::invalid(
                "Close Morrow Mail, then use --backup <absolute-workspace> <new-absolute-destination>.",
            ))
        };
        match result {
            Ok(()) => println!("Verified Morrow Mail backup saved."),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if std::env::args().len() != 1 {
        eprintln!("Configuration must arrive over the private parent pipe.");
        std::process::exit(1);
    }
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let (configuration_tx, configuration_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, mut closed_rx) = tokio::sync::watch::channel(false);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut bytes = Vec::new();
        let result = std::io::Read::take(&mut input, 8194).read_until(b'\n', &mut bytes);
        if result.is_err() || bytes.len() > 8193 || bytes.last() != Some(&b'\n') {
            let _ = configuration_tx.send(Err(Error::invalid(
                "Invalid private service configuration.",
            )));
            let _ = closed_tx.send(true);
            return;
        }
        let _ = configuration_tx
            .send(serde_json::from_slice::<Configuration>(&bytes).map_err(Error::from));
        // A dedicated pipe reader terminates on EOF even when the app crashes. No credentials in argv or env.
        let mut buffer = [0; 256];
        while std::io::Read::read(&mut input, &mut buffer).is_ok_and(|count| count > 0) {}
        let _ = closed_tx.send(true);
    });
    let config = tokio::time::timeout(Duration::from_secs(10), configuration_rx)
        .await
        .map_err(|_| Error::invalid("Private service startup timed out."))?
        .map_err(|_| Error::invalid("Private parent pipe closed."))??;
    let valid_token = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !valid_token(&config.token)
        || !config.data_directory.is_absolute()
        || (!config.update_token.is_empty() && !valid_token(&config.update_token))
        || config.parent_pid == Some(0)
    {
        return Err(Error::invalid("Invalid private service configuration."));
    }
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await?;
    let port = listener.local_addr()?.port();
    let parent_pid = config.parent_pid;
    let directory = config.data_directory.clone();
    let app = tokio::task::spawn_blocking(move || {
        let mut app = App::open(
            &config.data_directory,
            port,
            config.token,
            config.update_token,
        )?;
        if let Some(directory) = config.asset_directory {
            app.set_asset_directory(&directory)?;
        }
        Ok::<_, Error>(app)
    })
    .await
    .map_err(|_| Error::new(500, "Could not open the workspace."))??;
    if let Some(parent) = parent_pid {
        app.0.updater.configure(parent);
    }
    if *closed_rx.borrow() {
        return Ok(());
    }
    let _cli_endpoint = morrow_search::cli::publish(&directory, &app)?;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let indexing = app.clone();
    let mut index_stop = shutdown_rx.clone();
    let index_task = tokio::spawn(async move {
        loop {
            tokio::select! { _=index_stop.changed()=>break,_=tokio::time::sleep(Duration::from_millis(50))=>{} }
            match indexing.db(|db| db.backfill_batch()).await {
                Ok(0) | Err(_) => break,
                _ => {}
            }
        }
    });
    let mut jobs = Vec::new();
    for kind in 0..4 {
        let worker = app.clone();
        let mut stop = shutdown_rx.clone();
        jobs.push(tokio::spawn(async move {
            loop {
                let seconds = match kind { 0 => 30, 1 => 1, _ => 5 };
                tokio::select! { _ = stop.changed() => break, _ = tokio::time::sleep(Duration::from_secs(seconds)) => {} }
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = async {
                        match kind {
                            0 => { let _ = morrow_search::background::tick(&worker).await; }
                            1 => { let _ = morrow_search::smart_search::tick(&worker).await; }
                            2 => { let _ = morrow_search::scheduled::tick(&worker).await; }
                            _ => { let _ = morrow_search::reply_suggestions::tick(&worker).await; }
                        }
                    } => {}
                }
            }
        }));
    }
    let router = app.router();
    let mut server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
    });
    println!("{{\"port\":{port}}}");
    std::io::stdout().flush()?;
    let completed = tokio::select! { result = &mut server => Some(result), _=closed_rx.changed()=>None,_ = shutdown_signal()=>None };
    morrow_search::background::stop(&app);
    morrow_search::reply_suggestions::stop(&app);
    let _ = shutdown_tx.send(true);
    app.0.updater.stop().await;
    for job in jobs {
        let _ = job.await;
    }
    let _ = index_task.await;
    let result = match completed {
        Some(result) => result,
        None => match tokio::time::timeout(Duration::from_secs(65), server).await {
            Ok(result) => result,
            Err(_) => std::process::exit(1),
        },
    };
    result.map_err(|_| Error::new(500, "The private service stopped unexpectedly."))??;
    // Acquire the same executor after draining HTTP: all accepted DB writes have completed before close.
    app.db(|_| Ok(())).await?;
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=terminate.recv()=>{},_=tokio::signal::ctrl_c()=>{}};
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
