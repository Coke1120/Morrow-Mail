use morrow_search::providers;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

// Use the real provider URLs with a test-only trusted certificate and local DNS override.
// No production endpoint override or disabled TLS validation is needed.
struct Fixture {
    client: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(handler: impl Fn(&url::Url) -> (u16, Value) + Send + Sync + 'static) -> Self {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["gmail.googleapis.com".into()]).unwrap();
        let tls = tokio_rustls::rustls::ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der())
                .into(),
        )
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()])
            .resolve("gmail.googleapis.com", listener.local_addr().unwrap())
            .build()
            .unwrap();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut stream = acceptor.accept(socket).await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    while !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                        let count = stream.read(&mut buffer).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        assert!(bytes.len() < 65536);
                    }
                    let raw = String::from_utf8(bytes).unwrap();
                    let line = raw.lines().next().unwrap().split(' ').collect::<Vec<_>>();
                    assert_eq!(line[0], "GET");
                    assert!(
                        raw.to_ascii_lowercase()
                            .contains("authorization: bearer fixture-token\r\n")
                    );
                    let target =
                        url::Url::parse(&format!("https://gmail.googleapis.com{}", line[1]))
                            .unwrap();
                    let (status, value) = handler(&target);
                    let body = serde_json::to_vec(&value).unwrap();
                    let location = if status == 302 {
                        "Location: https://attacker.invalid/leak\r\n"
                    } else {
                        ""
                    };
                    let headers = format!(
                        "HTTP/1.1 {status} Fixture\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(headers.as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                    stream.shutdown().await.unwrap();
                });
            }
        });
        Self { client, task }
    }
}

fn mail() -> Value {
    json!({"provider":"google","accessToken":"fixture-token","grantedScopes":"https://www.googleapis.com/auth/gmail.readonly"})
}

#[test]
fn google_folder_uses_label_precedence_without_losing_provider_flags() {
    for (labels, folder) in [
        (
            json!(["TRASH", "DRAFT", "INBOX", "SENT", "STARRED"]),
            "trash",
        ),
        (json!(["DRAFT", "INBOX", "SENT"]), "drafts"),
        (json!(["INBOX", "SENT", "UNREAD"]), "inbox"),
        (json!(["SENT", "STARRED"]), "sent"),
        (json!(["Label_1"]), "archive"),
        (json!([]), "archive"),
    ] {
        let message = providers::normalize_google(
            &json!({"id":"stable","labelIds":labels,"payload":{"headers":[]}}),
        )
        .unwrap();
        assert_eq!(providers::google_folder(&labels), folder);
        assert_eq!(message["folder"], folder);
        assert_eq!(message["id"], "google:stable");
        assert_eq!(message["providerLabelIds"], labels);
        let labels = labels.as_array().unwrap();
        for (field, label) in [
            ("providerSent", "SENT"),
            ("providerDraft", "DRAFT"),
            ("starred", "STARRED"),
        ] {
            assert_eq!(message[field], labels.iter().any(|v| v == label));
        }
        assert_eq!(message["read"], !labels.iter().any(|v| v == "UNREAD"));
    }
    assert_eq!(providers::google_folder(&Value::Null), "archive");
    assert!(providers::normalize_google(&json!({"labelIds":"INBOX"})).is_err());
}

#[tokio::test]
async fn google_pages_cover_five_scopes_with_readonly_label_names_and_stable_ids() {
    let rows = vec![
        json!({"id":"dual","labelIds":["INBOX","SENT","STARRED","UNREAD","Label_1"]}),
        json!({"id":"sent","labelIds":["SENT","Label_2"]}),
        json!({"id":"draft","labelIds":["DRAFT","INBOX","Label_1"]}),
        json!({"id":"archive","labelIds":["Label_2","Label_deleted"]}),
    ];
    let calls = Arc::new(Mutex::new(Vec::<url::Url>::new()));
    let captured = calls.clone();
    let remote_rows = rows.clone();
    let fixture = Fixture::new(move |url| {
        captured.lock().unwrap().push(url.clone());
        if url.path().ends_with("/labels") {
            return (200, json!({"labels":[{"id":"INBOX","name":"INBOX","type":"system"},{"id":"SENT","name":"SENT","type":"system"},{"id":"Label_1","name":"工作 / 專案","type":"user"},{"id":"Label_2","name":"Travel","type":"user"}]}));
        }
        if url.path().ends_with("/messages") {
            let query = url.query_pairs().collect::<HashMap<_, _>>();
            let messages = remote_rows.iter().filter(|row| query.get("labelIds").is_none_or(|label| row["labelIds"].as_array().unwrap().iter().any(|v| v == label.as_ref())))
                .map(|row| json!({"id":row["id"]})).collect::<Vec<_>>();
            return (200, json!({"messages":messages,"nextPageToken":"opaque /?& token"}));
        }
        let row = remote_rows.iter().find(|row| url.path().ends_with(&format!("/{}", row["id"].as_str().unwrap()))).unwrap();
        let mut message = row.clone(); message["payload"] = json!({"headers":[]});
        (200, message)
    }).await;
    for (folder, label) in [
        ("all", None),
        ("inbox", Some("INBOX")),
        ("sent", Some("SENT")),
        ("drafts", Some("DRAFT")),
        ("starred", Some("STARRED")),
    ] {
        let page = providers::fetch_page(&fixture.client, &mail(), &json!({"folder":folder,"since":"2026-06-24T12:00:00.000Z","before":"2026-09-24T12:00:00.000Z","cursor":"opaque /?& token"})).await.unwrap();
        assert_eq!(page["nextCursor"], "opaque /?& token");
        let calls = calls.lock().unwrap();
        let url = calls
            .iter()
            .rev()
            .find(|url| url.path().ends_with("/messages"))
            .unwrap();
        let query = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(query.get("labelIds").map(|v| v.as_ref()), label);
        assert_eq!(query["includeSpamTrash"], "false");
        assert_eq!(query["maxResults"], "50");
        assert_eq!(query["pageToken"], "opaque /?& token");
        assert!(query["q"].starts_with("after:"));
        assert!(query["q"].contains(" before:"));
        for message in page["messages"].as_array().unwrap() {
            let raw = rows
                .iter()
                .find(|row| message["id"] == format!("google:{}", row["id"].as_str().unwrap()))
                .unwrap();
            assert_eq!(message["providerLabelIds"], raw["labelIds"]);
            assert_eq!(
                message["folder"],
                providers::google_folder(&raw["labelIds"])
            );
            let labels = raw["labelIds"].as_array().unwrap();
            assert_eq!(message["providerSent"], labels.iter().any(|v| v == "SENT"));
            assert_eq!(
                message["providerDraft"],
                labels.iter().any(|v| v == "DRAFT")
            );
            assert_eq!(
                message["labels"],
                if labels.iter().any(|v| v == "Label_1") {
                    json!(["工作 / 專案"])
                } else {
                    json!(["Travel"])
                }
            );
        }
    }
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.path().ends_with("/labels"))
            .count(),
        5
    );
    assert_eq!(calls.lock().unwrap().len(), 20); // Five lists, five label lookups, ten details.
    let folders = providers::folders(&fixture.client, &mail()).await.unwrap();
    assert!(
        folders
            .iter()
            .any(|folder| folder["id"] == "Label_1" && folder["name"] == "工作 / 專案")
    );
    assert!(!providers::can_organize(&mail())); // Browsing labels needs only read permission.
    for folder in ["all", "drafts", "starred"] {
        assert!(
            providers::fetch_page(
                &fixture.client,
                &json!({"provider":"microsoft"}),
                &json!({"folder":folder})
            )
            .await
            .is_err()
        );
    }
    assert_eq!(calls.lock().unwrap().len(), 21);
}

#[tokio::test]
async fn google_pages_bound_lists_and_reject_label_redirects_before_reading_messages() {
    for mode in ["page-limit", "label-limit", "invalid-label", "redirect"] {
        let details = Arc::new(Mutex::new(0));
        let captured = details.clone();
        let fixture = Fixture::new(move |url| {
            if url.path().ends_with("/messages") {
                let count = if mode == "page-limit" { 51 } else { 1 };
                return (200, json!({"messages":(0..count).map(|id| json!({"id":id.to_string()})).collect::<Vec<_>>()}));
            }
            if url.path().ends_with("/labels") {
                return match mode {
                    "label-limit" => (200, json!({"labels":(0..1001).map(|id| json!({"id":id.to_string(),"name":"Label","type":"user"})).collect::<Vec<_>>()})),
                    "invalid-label" => (200, json!({"labels":[{"id":"Label_1","name":null,"type":"user"}]})),
                    "redirect" => (302, json!({})),
                    _ => panic!("Oversized page must stop before labels"),
                };
            }
            *captured.lock().unwrap() += 1;
            (200, json!({"id":"0","payload":{"headers":[]}}))
        }).await;
        let error = providers::fetch_page(&fixture.client, &mail(), &json!({"folder":"all"}))
            .await
            .unwrap_err();
        if mode == "redirect" {
            assert_eq!(error.provider_status, Some(302));
        }
        assert_eq!(*details.lock().unwrap(), 0);
    }
}
