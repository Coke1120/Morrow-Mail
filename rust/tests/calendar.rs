use axum::{
    body::to_bytes,
    http::{HeaderMap, Method},
};
use futures_util::{FutureExt, future::BoxFuture};
use morrow_search::{
    calendar, oauth,
    service::{App, Context},
    store::{Store, string},
};
use serde_json::{Value, json};
use std::{
    fs,
    future::IntoFuture,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};

type Handler =
    Arc<dyn Fn(String, String, HeaderMap, Value) -> BoxFuture<'static, (u16, Value)> + Send + Sync>;
struct Fixture {
    root: PathBuf,
    client: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new(handler: Handler) -> Self {
        let root =
            std::env::temp_dir().join(format!("morrow-calendar-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let names = [
            "www.googleapis.com",
            "graph.microsoft.com",
            "oauth2.googleapis.com",
            "openidconnect.googleapis.com",
            "gmail.googleapis.com",
            "login.microsoftonline.com",
        ];
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(names.map(str::to_owned).to_vec()).unwrap();
        let cert_pem = cert.pem();
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
        let address = listener.local_addr().unwrap();
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .tls_certs_only([reqwest::Certificate::from_pem(cert_pem.as_bytes()).unwrap()]);
        for host in [
            "www.googleapis.com",
            "graph.microsoft.com",
            "oauth2.googleapis.com",
            "openidconnect.googleapis.com",
            "gmail.googleapis.com",
            "login.microsoftonline.com",
        ] {
            builder = builder.resolve(host, address);
        }
        let client = builder.build().unwrap();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut stream = acceptor.accept(socket).await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buf = [0; 4096];
                    let end;
                    loop {
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            end = i + 4;
                            break;
                        }
                        assert!(bytes.len() < 65536);
                    }
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let mut lines = headers.split("\r\n");
                    let first = lines.next().unwrap().split(' ').collect::<Vec<_>>();
                    let method = first[0].to_owned();
                    let target = first[1].to_owned();
                    let mut map = HeaderMap::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            map.insert(
                                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                                v.trim().parse().unwrap(),
                            );
                        }
                    }
                    let length = map
                        .get("content-length")
                        .and_then(|v| v.to_str().unwrap().parse::<usize>().ok())
                        .unwrap_or(0);
                    while bytes.len() < end + length {
                        let n = stream.read(&mut buf).await.unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let body = &bytes[end..end + length];
                    let body = if body.is_empty() {
                        Value::Null
                    } else if map.get("content-type").is_some_and(|v| {
                        v.to_str()
                            .unwrap()
                            .contains("application/x-www-form-urlencoded")
                    }) {
                        let mut v = json!({});
                        for (k, val) in url::form_urlencoded::parse(body) {
                            v[k.as_ref()] = val.into_owned().into();
                        }
                        v
                    } else {
                        serde_json::from_slice(body).unwrap()
                    };
                    let (status, value) = handler(method, target, map, body).await;
                    let body = serde_json::to_vec(&value).unwrap();
                    let header = format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(header.as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { root, client, task }
    }
    fn app(&self) -> App {
        let mut app = App::open(
            &self.root.join("workspace"),
            32145,
            "fixture-native-token".into(),
            String::new(),
        )
        .unwrap();
        let runtime = Arc::get_mut(&mut app.0).unwrap();
        runtime.client = self.client.clone();
        app
    }
}
fn connection(provider: &str) -> Value {
    json!({"provider":provider,"purpose":"calendar","email":format!("{provider}@example.invalid"),"clientId":"fixture-client","clientSecret":"fixture-secret","accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":chrono::Utc::now().timestamp_millis()+3600000})
}
fn input() -> Value {
    json!({"calendarId":"work@example.invalid","title":"Planning","description":"First line\n<script>text</script>","location":"Desk","start":"2026-10-01T09:00:00+08:00","end":"2026-10-01T10:00:00+08:00","requestId":"5c4b819c-b301-4ed5-bd2d-997315b47835","connectionEmail":"google@example.invalid"})
}
fn calendars() -> Value {
    json!({"items":[{"id":"work@example.invalid","summary":"Work","primary":true,"accessRole":"owner","backgroundColor":"#Ab1234"}],"value":[{"id":"work@example.invalid","name":"Work","canEdit":true,"hexColor":"#456DEF"}]})
}
fn context(method: &str, path: &str, body: Value) -> Context {
    let parsed = url::Url::parse(&format!("http://localhost{path}")).unwrap();
    let mut query = json!({});
    for (k, v) in parsed.query_pairs() {
        query[k.as_ref()] = v.into_owned().into();
    }
    Context {
        method: Method::from_bytes(method.as_bytes()).unwrap(),
        path: parsed
            .path()
            .trim_start_matches("/api/")
            .split('/')
            .map(str::to_owned)
            .collect(),
        body,
        query,
        headers: HeaderMap::new(),
        owner: "demo".into(),
        paged: false,
    }
}
async fn call(app: &App, ctx: Context) -> (u16, HeaderMap, Value) {
    let result = if ctx.path[0] == "calendars" {
        calendar::handle(app, &ctx).await
    } else {
        oauth::handle(app, &ctx).await
    };
    match result {
        Ok(Some(response)) => {
            let (parts, body) = response.into_parts();
            let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
            (
                parts.status.as_u16(),
                parts.headers,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }
        Ok(None) => panic!("unhandled fixture route"),
        Err(error) => (error.status, HeaderMap::new(), error.body),
    }
}
async fn set(app: &App, settings: Value) {
    app.db(move |db| {
        db.set_settings(&settings)?;
        Ok(())
    })
    .await
    .unwrap();
}
fn location(headers: &HeaderMap) -> url::Url {
    url::Url::parse(headers["location"].to_str().unwrap()).unwrap()
}

#[tokio::test]
async fn provider_contracts_pagination_normalization_and_idempotency() {
    let saved = Arc::new(Mutex::new(Value::Null));
    let saved_copy = saved.clone();
    let mode = Arc::new(AtomicUsize::new(0));
    let mode_copy = mode.clone();
    let fixture=Fixture::new(Arc::new(move|method,target,headers,body| {
        let saved=saved_copy.clone();let mode=mode_copy.clone();async move {
            assert_eq!(headers["authorization"],"Bearer fixture-access");
            let url=url::Url::parse(&format!("https://{}{}",headers["host"].to_str().unwrap(),target)).unwrap();
            let google=url.host_str()==Some("www.googleapis.com");let stage=mode.load(Ordering::SeqCst);
            if !google {assert!(headers["prefer"].to_str().unwrap().contains("timezone=\"UTC\""));}
            if stage==1 {return(200,json!({"value":[],"@odata.nextLink":"https://attacker.invalid/v1.0/me/calendars"}));}
            if stage==2 {return(200,json!({"items":[],"nextPageToken":"repeated"}));}
            if stage==3 {return(200,json!({"items":(0..501).map(|i|json!({"id":i.to_string()})).collect::<Vec<_>>()}));}
            if method=="POST" {
                assert!(body.get("attendees").is_none());assert!(body.get("recurrence").is_none());
                assert!(body.get("reminders").is_none());assert!(body.get("isReminderOn").is_none());assert!(body.get("reminderMinutesBeforeStart").is_none());
                if google {
                    assert_eq!(url.query(),Some("sendUpdates=none"));assert!(string(&body,"description").contains("&lt;script&gt;"));
                    let mut saved=saved.lock().unwrap();if !saved.is_null(){return(409,json!({"error":"fixture-private"}));}*saved=body.clone();return(200,body);
                }
                assert_eq!(body["transactionId"],input()["requestId"]);assert_eq!(body["start"]["timeZone"],"UTC");
                assert_eq!(body["start"]["dateTime"],"2026-10-01T01:00:00.000");
                let mut result=body;result["id"]="outlook-event".into();return(200,result);
            }
            if url.path().contains("/events/m") {return(200,saved.lock().unwrap().clone());}
            if url.path().ends_with("calendarList") {
                return if url.query_pairs().any(|(k,_)|k=="pageToken") {(200,json!({"items":[{"id":"shared","summary":"Shared","accessRole":"reader","backgroundColor":["#123456"]}]}))}else{let mut list=calendars();list["nextPageToken"]="next/token".into();(200,list)};
            }
            if url.path().ends_with("/calendars") {return(200,calendars());}
            if google {
                assert!(url.query_pairs().any(|(k,v)|k=="singleEvents"&&v=="true"));
                return(200,json!({"items":[{"id":"normal","description":"<b>Agenda</b>","start":{"dateTime":"2026-10-01T09:00:00+08:00"},"end":{"dateTime":"2026-10-01T10:00:00+08:00"}},{"id":"holiday","start":{"date":"2026-10-01"},"end":{"date":"2026-10-02"}},{"id":"cancelled","status":"cancelled"}]}));
            }
            (200,json!({"value":[{"id":"ms-event","body":{"contentType":"html","content":"<p>Prepare</p><script>secret()</script>"},"start":{"dateTime":"2026-10-01T01:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-01T02:00:00.0000000","timeZone":"UTC"},"webLink":"javascript:bad()"},{"id":"ms-all-day","isAllDay":true,"start":{"dateTime":"2026-10-01T00:00:00","timeZone":"UTC"},"end":{"dateTime":"2026-10-03T00:00:00","timeZone":"UTC"}}]}))
        }.boxed()
    })).await;
    let google = connection("google");
    let microsoft = connection("microsoft");
    let listed = calendar::list_calendars(&fixture.client, &google)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[1]["canWrite"], false);
    assert_eq!(listed[0]["color"], "#Ab1234");
    assert!(listed[1].get("color").is_none());
    assert_eq!(
        calendar::list_calendars(&fixture.client, &microsoft)
            .await
            .unwrap()[0]["color"],
        "#456DEF"
    );
    for conn in [&google, &microsoft] {
        let events = calendar::list_events(
            &fixture.client,
            conn,
            "work@example.invalid",
            "2026-10-01T00:00:00Z",
            "2026-10-02T00:00:00Z",
        )
        .await
        .unwrap();
        assert_eq!(events[0]["start"], "2026-10-01T01:00:00.000Z");
        if conn["provider"] == "google" {
            assert_eq!(events.len(), 2);
            assert_eq!(string(&events[0], "description").trim(), "Agenda");
            assert_eq!(events[1]["start"], "2026-10-01");
            assert_eq!(events[1]["allDay"], true);
        } else {
            assert_eq!(events[0]["webUrl"], "");
            assert_eq!(string(&events[0], "description").trim(), "Prepare");
            assert_eq!(events[1]["allDay"], true);
            assert_eq!(events[1]["start"], "2026-10-01");
            assert_eq!(events[1]["end"], "2026-10-03");
        }
    }
    let first = calendar::create_event(&fixture.client, &google, &input())
        .await
        .unwrap();
    assert_eq!(
        calendar::create_event(&fixture.client, &google, &input())
            .await
            .unwrap(),
        first
    );
    let mut changed = input();
    changed["title"] = "Changed".into();
    assert!(
        calendar::create_event(&fixture.client, &google, &changed)
            .await
            .is_err()
    );
    assert_eq!(
        calendar::create_event(&fixture.client, &microsoft, &input())
            .await
            .unwrap()["id"],
        "outlook-event"
    );
    mode.store(1, Ordering::SeqCst);
    assert!(
        calendar::list_calendars(&fixture.client, &microsoft)
            .await
            .unwrap_err()
            .to_string()
            .contains("unsafe")
    );
    mode.store(2, Ordering::SeqCst);
    assert!(
        calendar::list_calendars(&fixture.client, &google)
            .await
            .unwrap_err()
            .to_string()
            .contains("repeated")
    );
    mode.store(3, Ordering::SeqCst);
    assert!(
        calendar::list_calendars(&fixture.client, &google)
            .await
            .unwrap_err()
            .to_string()
            .contains("500")
    );
    for date in [
        "2026-02-30T00:00:00Z",
        "2026-10-01T24:00:00Z",
        "2026-10-01T00:00:00",
    ] {
        assert!(
            calendar::list_events(&fixture.client, &google, "id", date, "2026-11-01T00:00:00Z")
                .await
                .is_err()
        );
    }
}

fn outlook_all_day(id: &str, positive: bool, local: bool) -> Value {
    let zone = if positive {
        "Line Islands Standard Time"
    } else {
        "Pacific Standard Time"
    };
    json!({"id":id,"isAllDay":true,"subject":"All day","originalStartTimeZone":zone,"originalEndTimeZone":zone,
        "start":{"dateTime":if local {"2026-09-24T00:00:00.0000000"} else if positive {"2026-09-23T10:00:00.0000000"} else {"2026-09-24T07:00:00.0000000"},"timeZone":if local {zone} else {"UTC"}},
        "end":{"dateTime":if local {"2026-09-26T00:00:00.0000000"} else if positive {"2026-09-25T10:00:00.0000000"} else {"2026-09-26T07:00:00.0000000"},"timeZone":if local {zone} else {"UTC"}}})
}

#[tokio::test]
async fn outlook_all_day_repairs_are_bounded_and_dates_fail_closed_when_unverifiable() {
    let mut items = (0..6)
        .map(|i| outlook_all_day(&format!("converted/{i}"), i % 2 == 0, false))
        .collect::<Vec<_>>();
    items.extend((0..101).map(|i| {
        let mut item = outlook_all_day(&format!("utc-{i}"), true, true);
        item["start"]["timeZone"] = "UTC".into();
        item["end"]["timeZone"] = "UTC".into();
        item
    }));
    let data = Arc::new(Mutex::new((items, None::<Value>, 200u16)));
    let gets = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (d, g, a, p) = (data.clone(), gets.clone(), active.clone(), peak.clone());
    let fixture = Fixture::new(Arc::new(move |method, path, headers, _| {
        let (data, gets, active, peak) = (d.clone(), g.clone(), a.clone(), p.clone());
        async move {
            assert_eq!(method, "GET");
            assert_eq!(headers["host"], "graph.microsoft.com");
            assert_eq!(headers["authorization"], "Bearer fixture-access");
            let url = url::Url::parse(&format!("https://graph.microsoft.com{path}")).unwrap();
            let (items, override_result, status) = data.lock().unwrap().clone();
            if url.path().ends_with("/calendarView") {
                assert!(
                    headers["prefer"]
                        .to_str()
                        .unwrap()
                        .contains("timezone=\"UTC\"")
                );
                assert!(url.query_pairs().any(|(k, v)| k == "$select"
                    && v.contains("originalStartTimeZone,originalEndTimeZone")));
                return (200, json!({"value":items}));
            }
            assert!(
                url.path()
                    .starts_with("/v1.0/me/calendars/work%2Fpart/events/")
            );
            let item = items
                .iter()
                .find(|item| {
                    url.path().ends_with(&format!(
                        "/{}",
                        morrow_search::providers::component(string(item, "id"))
                    ))
                })
                .unwrap();
            assert_eq!(
                headers["prefer"].to_str().unwrap(),
                format!(
                    "outlook.timezone=\"{}\", outlook.body-content-type=\"text\"",
                    string(item, "originalStartTimeZone")
                )
            );
            gets.fetch_add(1, Ordering::SeqCst);
            peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            if status != 200 {
                return (status, json!({"error":"private-provider-text"}));
            }
            (
                200,
                override_result.unwrap_or_else(|| {
                    outlook_all_day(
                        string(item, "id"),
                        item["originalStartTimeZone"] == "Line Islands Standard Time",
                        true,
                    )
                }),
            )
        }
        .boxed()
    }))
    .await;
    let app = fixture.app();
    set(
        &app,
        json!({"calendars":{"microsoft":connection("microsoft")}}),
    )
    .await;
    let path = "/api/calendars/microsoft/events?calendarId=work%2Fpart&start=2026-09-01T00%3A00%3A00Z&end=2026-10-01T00%3A00%3A00Z";
    let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
    assert_eq!(status, 200, "{body}");
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 107);
    assert!(events.iter().all(|event| event["allDay"] == true
        && event["start"] == "2026-09-24"
        && event["end"] == "2026-09-26"));
    assert_eq!(gets.load(Ordering::SeqCst), 6);
    assert_eq!(peak.load(Ordering::SeqCst), 4);

    // 101 already-UTC-midnight dates above needed no repair; only extra reads consume this cap.
    data.lock().unwrap().0 = (0..101)
        .map(|i| outlook_all_day(&format!("bound-{i}"), true, false))
        .collect();
    gets.store(0, Ordering::SeqCst);
    let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
    assert_eq!(status, 502);
    assert_eq!(body["code"], "calendar_all_day_limit");
    assert!(string(&body, "error").contains("smaller date range"));
    assert_eq!(gets.load(Ordering::SeqCst), 0);
    data.lock().unwrap().0.pop();
    let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["events"].as_array().unwrap().len(), 100);
    assert_eq!(gets.load(Ordering::SeqCst), 100);

    gets.store(0, Ordering::SeqCst);
    for zone in [
        "",
        "tzone://Microsoft/Custom",
        "UTC\"\r\nInjected: true",
        "UTC ",
    ] {
        let mut item = outlook_all_day("source", true, false);
        item["originalStartTimeZone"] = zone.into();
        item["originalEndTimeZone"] = zone.into();
        data.lock().unwrap().0 = vec![item];
        let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
        assert_eq!(status, 502);
        assert_eq!(body["code"], "calendar_all_day_timezone");
    }
    assert_eq!(gets.load(Ordering::SeqCst), 0);
    data.lock().unwrap().0 = vec![outlook_all_day("source", true, false)];
    for patch in [
        json!({"id":"other"}),
        json!({"isAllDay":false}),
        json!({"isCancelled":true}),
        json!({"originalStartTimeZone":"UTC"}),
        json!({"originalEndTimeZone":"UTC"}),
        json!({"start":{"dateTime":"2026-09-24T01:00:00","timeZone":"Line Islands Standard Time"}}),
        json!({"end":{"dateTime":"2026-09-26T00:00:00","timeZone":"UTC"}}),
        json!({"end":{"dateTime":"2026-09-23T00:00:00","timeZone":"Line Islands Standard Time"}}),
    ] {
        let mut repaired = outlook_all_day("source", true, true);
        repaired
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        data.lock().unwrap().1 = Some(repaired);
        let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
        assert_eq!(status, 502);
        assert_eq!(body["code"], "calendar_all_day_timezone");
        assert!(string(&body, "error").contains("original timezone"));
    }
    {
        let mut data = data.lock().unwrap();
        data.0[0]["originalStartTimeZone"] = "Not A Timezone".into();
        data.0[0]["originalEndTimeZone"] = "Not A Timezone".into();
        data.2 = 400;
    }
    let (status, _, body) = call(&app, context("GET", path, Value::Null)).await;
    assert_eq!(status, 502);
    assert_eq!(body["code"], "calendar_all_day_timezone");
    assert!(!body.to_string().contains("private-provider-text"));
}

#[tokio::test]
async fn persistent_requests_restart_legacy_hash_and_uncertain_recovery() {
    let saved = Arc::new(Mutex::new(json!({})));
    let save = saved.clone();
    let posts = Arc::new(AtomicUsize::new(0));
    let count = posts.clone();
    let uncertain = Arc::new(AtomicUsize::new(0));
    let lose = uncertain.clone();
    let fixture = Fixture::new(Arc::new(move |method, target, _, body| {
        let saved = save.clone();
        let posts = count.clone();
        let lose = lose.clone();
        async move {
            if target.contains("calendarList") {
                return (200, calendars());
            }
            if method == "POST" {
                posts.fetch_add(1, Ordering::SeqCst);
                let id = string(&body, "id").to_owned();
                let mut saved = saved.lock().unwrap();
                if saved.get(&id).is_some() {
                    return (409, json!({}));
                }
                saved[&id] = body.clone();
                return if lose.load(Ordering::SeqCst) > 0 {
                    (500, json!({"error":"fixture-access"}))
                } else {
                    (200, body)
                };
            }
            let id = target.rsplit('/').next().unwrap();
            (200, saved.lock().unwrap()[id].clone())
        }
        .boxed()
    }))
    .await;
    let app = fixture.app();
    set(&app,json!({"calendars":{"google":connection("google")},"mailAccounts":{"mail@example.invalid":{"email":"mail@example.invalid"}}})).await;
    let value = input();
    let first = call(
        &app,
        context("POST", "/api/calendars/google/events", value.clone()),
    )
    .await;
    assert_eq!(first.0, 200, "{}", first.2);
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    assert_eq!(
        app.settings().await.unwrap()["calendarRequests"][0]["payloadHash"],
        "26469017e34f5905775ff436ed8e4742d2f36c048bb8e1f7018f833fc810d860"
    );
    // Simulate the Node record format (fingerprint but no saved payload).
    app.db(|db| {
        let mut records = db.settings()?["calendarRequests"].clone();
        records[0].as_object_mut().unwrap().remove("payload");
        db.set_settings(&json!({"calendarRequests":records}))?;
        Ok(())
    })
    .await
    .unwrap();
    drop(app);
    let app = fixture.app();
    let replay = call(
        &app,
        context("POST", "/api/calendars/google/events", value.clone()),
    )
    .await;
    assert_eq!(replay.2, first.2);
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    let mut changed = value.clone();
    changed["reminder"] = json!({"method":"none"});
    assert_eq!(
        call(
            &app,
            context("POST", "/api/calendars/google/events", changed)
        )
        .await
        .0,
        409
    );
    let mut changed = value.clone();
    changed["title"] = "Changed".into();
    assert_eq!(
        call(
            &app,
            context("POST", "/api/calendars/google/events", changed)
        )
        .await
        .0,
        409
    );
    uncertain.store(1, Ordering::SeqCst);
    let mut retry = value;
    retry["requestId"] = uuid::Uuid::new_v4().to_string().into();
    retry["reminder"] = json!({"method":"popup","minutes":0});
    let failed = call(
        &app,
        context("POST", "/api/calendars/google/events", retry.clone()),
    )
    .await;
    assert_eq!(failed.0, 502);
    assert!(!failed.2.to_string().contains("fixture-access"));
    let recorded = app.settings().await.unwrap()["calendarRequests"][1].clone();
    assert_eq!(recorded["payload"]["requestId"], retry["requestId"]);
    assert_eq!(recorded["payload"]["start"], "2026-10-01T01:00:00.000Z");
    assert_eq!(recorded["payload"]["reminder"], retry["reminder"]);
    drop(app);
    let app = fixture.app();
    for reminder in [
        None,
        Some(json!({"method":"none"})),
        Some(json!({"method":"email","minutes":0})),
        Some(json!({"method":"popup","minutes":1})),
    ] {
        let mut changed = retry.clone();
        if let Some(reminder) = reminder {
            changed["reminder"] = reminder;
        } else {
            changed.as_object_mut().unwrap().remove("reminder");
        }
        assert_eq!(
            call(
                &app,
                context("POST", "/api/calendars/google/events", changed)
            )
            .await
            .0,
            409
        );
    }
    assert_eq!(posts.load(Ordering::SeqCst), 2);
    uncertain.store(0, Ordering::SeqCst);
    let recovered = call(&app, context("POST", "/api/calendars/google/events", retry)).await;
    assert_eq!(recovered.0, 200, "{}", recovered.2);
    assert_eq!(posts.load(Ordering::SeqCst), 3);
    assert_eq!(
        app.settings().await.unwrap()["calendarRequests"][1]["payload"],
        recorded["payload"]
    );
    assert!(
        !String::from_utf8_lossy(&fs::read(fixture.root.join("workspace/genmail.sqlite")).unwrap())
            .contains("fixture-access")
    );
    assert_eq!(
        call(
            &app,
            context(
                "POST",
                "/api/calendars/google/disconnect",
                json!({"connectionEmail":"old@example.invalid"})
            )
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            context(
                "POST",
                "/api/calendars/google/disconnect",
                json!({"connectionEmail":"google@example.invalid"})
            )
        )
        .await
        .0,
        200
    );
    assert_eq!(
        app.settings().await.unwrap()["calendarRequests"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(app.settings().await.unwrap()["mailAccounts"]["mail@example.invalid"].is_object());
}

#[tokio::test]
async fn reminders_validate_before_network_and_map_to_native_provider_fields() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let saved = Arc::new(Mutex::new(json!({})));
    let captured = saved.clone();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sent = bodies.clone();
    let fixture = Fixture::new(Arc::new(move |method, target, headers, body| {
        let saved = captured.clone();
        let count = count.clone();
        let sent = sent.clone();
        async move {
            count.fetch_add(1, Ordering::SeqCst);
            if method != "POST" {
                return (
                    200,
                    saved.lock().unwrap()[target.rsplit('/').next().unwrap()].clone(),
                );
            }
            assert!(body.get("attendees").is_none());
            sent.lock().unwrap().push(body.clone());
            if headers["host"] == "www.googleapis.com" {
                assert!(target.ends_with("?sendUpdates=none"));
                let id = string(&body, "id").to_owned();
                let mut saved = saved.lock().unwrap();
                if saved.get(&id).is_some() {
                    return (409, json!({}));
                }
                saved[id] = body.clone();
                (200, body)
            } else {
                let mut body = body;
                body["id"] = "ms-reminder".into();
                (200, body)
            }
        }
        .boxed()
    }))
    .await;
    let app = fixture.app();
    set(
        &app,
        json!({"calendars":{"google":connection("google"),"microsoft":connection("microsoft")}}),
    )
    .await;
    for reminder in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"method":"default"}),
        json!({"method":"popup"}),
        json!({"method":"popup","minutes":"30"}),
        json!({"method":"popup","minutes":true}),
        json!({"method":"popup","minutes":0.5}),
        json!({"method":"popup","minutes":-1}),
        json!({"method":"email","minutes":40321}),
        json!({"method":"none","attendees":[]}),
    ] {
        let mut value = input();
        value["reminder"] = reminder;
        assert_eq!(
            call(
                &app,
                context("POST", "/api/calendars/google/events", value.clone())
            )
            .await
            .0,
            400
        );
        assert!(
            calendar::create_event(&fixture.client, &connection("google"), &value)
                .await
                .is_err()
        );
    }
    let mut unsupported = input();
    unsupported["connectionEmail"] = "microsoft@example.invalid".into();
    unsupported["reminder"] = json!({"method":"email","minutes":30});
    assert_eq!(
        call(
            &app,
            context(
                "POST",
                "/api/calendars/microsoft/events",
                unsupported.clone()
            )
        )
        .await
        .0,
        400
    );
    assert!(
        calendar::create_event(&fixture.client, &connection("microsoft"), &unsupported)
            .await
            .unwrap_err()
            .to_string()
            .contains("popup reminders only")
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(app.settings().await.unwrap()["calendarRequests"].is_null());
    for (provider, reminder) in [
        ("google", json!({"method":"none","minutes":30})),
        ("google", json!({"method":"popup","minutes":0})),
        ("google", json!({"method":"email","minutes":40320})),
        ("microsoft", json!({"method":"none","minutes":30})),
        ("microsoft", json!({"method":"popup","minutes":40320})),
    ] {
        let mut value = input();
        value["requestId"] = uuid::Uuid::new_v4().to_string().into();
        value["reminder"] = reminder.clone();
        let first = calendar::create_event(&fixture.client, &connection(provider), &value)
            .await
            .unwrap();
        let body = bodies.lock().unwrap().last().unwrap().clone();
        if provider == "google" {
            assert_eq!(
                body["reminders"],
                json!({"useDefault":false,"overrides":if reminder["method"]=="none" {vec![]} else {vec![reminder.clone()]}})
            );
            let id = string(&body, "id").to_owned();
            if reminder["method"] == "none" {
                saved.lock().unwrap()[&id]["reminders"]
                    .as_object_mut()
                    .unwrap()
                    .remove("overrides");
            }
            assert_eq!(
                calendar::create_event(&fixture.client, &connection(provider), &value)
                    .await
                    .unwrap(),
                first
            );
            saved.lock().unwrap()[&id]["reminders"] = json!({"useDefault":true});
            assert_eq!(
                calendar::create_event(&fixture.client, &connection(provider), &value)
                    .await
                    .unwrap_err()
                    .status,
                409
            );
        } else {
            assert!(body.get("reminders").is_none());
            assert_eq!(body["isReminderOn"], reminder["method"] != "none");
            if reminder["method"] == "popup" {
                assert_eq!(body["reminderMinutesBeforeStart"], 40320);
            } else {
                assert!(body.get("reminderMinutesBeforeStart").is_none());
            }
        }
    }
}

async fn begin(app: &App, calendar: bool, provider: &str) -> (url::Url, String, url::Url) {
    let path = if calendar {
        format!("/api/calendars/{provider}/connect")
    } else {
        format!("/api/oauth/{provider}/start")
    };
    let body = if provider == "microsoft" {
        json!({"useDefaultClient":true,"importOptions":{"months":1,"sent":true,"inbox":false}})
    } else {
        json!({"clientId":"fixture-client","clientSecret":"fixture-secret","importOptions":{"months":1,"sent":true,"inbox":false}})
    };
    let result = call(app, context("POST", &path, body)).await;
    assert_eq!(result.0, 200, "{}", result.2);
    let local = url::Url::parse(string(&result.2, "url")).unwrap();
    assert_eq!(local.host_str(), Some("localhost"));
    let authorized = call(
        app,
        context(
            "GET",
            &format!("{}?{}", local.path(), local.query().unwrap()),
            json!({}),
        ),
    )
    .await;
    assert_eq!(authorized.0, 302);
    let remote = location(&authorized.1);
    assert!(
        remote
            .query_pairs()
            .any(|(k, v)| k == "code_challenge_method" && v == "S256")
    );
    if provider == "microsoft" {
        assert!(
            remote
                .query_pairs()
                .any(|(k, v)| k == "client_id" && v == oauth::MICROSOFT_CLIENT_ID.trim())
        );
        assert!(!remote.query_pairs().any(|(k, _)| k == "client_secret"));
    }
    let cookie = authorized.1["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    (local, cookie.split(';').next().unwrap().into(), remote)
}
fn callback_context(local: &url::Url, cookie: &str, code: &str) -> Context {
    let path = format!(
        "{}?{}&code={code}",
        local.path().replace("authorize", "callback"),
        local.query().unwrap()
    );
    let mut ctx = context("GET", &path, json!({}));
    ctx.headers.insert("cookie", cookie.parse().unwrap());
    ctx
}
#[tokio::test]
async fn mail_partial_consent_keeps_existing_connections_and_cached_mail() {
    for (provider, scope) in [
        (
            "google",
            "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
        ),
        ("microsoft", "User.Read Mail.Read Mail.Send"),
        ("microsoft", "User.Read Mail.ReadWrite"),
    ] {
        let fixture = Fixture::new(Arc::new(move |method, target, _, _| async move {
            if method == "POST" {
                return (200, json!({"access_token":"fixture-partial","refresh_token":"fixture-new-refresh","expires_in":3600,"scope":scope}));
            }
            assert!(!target.contains("/messages"), "partial consent must not fetch mail");
            (200, json!({"email":"person@example.invalid","emailAddress":"person@example.invalid","mail":"person@example.invalid"}))
        }.boxed())).await;
        let app = fixture.app();
        set(&app, json!({"mailAccounts":{
            "person@example.invalid":{"provider":provider,"email":"person@example.invalid","connectionId":"original","refreshToken":"fixture-original-refresh","grantedScopes":scope},
            "other@example.invalid":{"provider":"imap","email":"other@example.invalid","password":"fixture-other-password"}
        },"activeAccount":"other@example.invalid"})).await;
        app.db(|db| {
            for owner in ["person@example.invalid", "other@example.invalid"] {
                db.upsert(
                    owner,
                    &json!({"id":"same","folder":"inbox","body":"Keep cached mail"}),
                )?;
            }
            db.upsert(
                "person@example.invalid",
                &json!({"id":"draft","folder":"drafts","body":"Keep draft"}),
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let before = app.settings().await.unwrap();
        let (local, cookie, _) = begin(&app, false, provider).await;
        let completed = call(&app, callback_context(&local, &cookie, "partial-mail")).await;
        assert_eq!(completed.0, 302);
        assert!(
            location(&completed.1)
                .query_pairs()
                .any(|(key, value)| key == "connectionError"
                    && value.contains("permissions were not fully granted"))
        );
        assert_eq!(app.settings().await.unwrap(), before);
        app.db(|db| {
            for owner in ["person@example.invalid", "other@example.invalid"] {
                assert_eq!(db.get(owner, "same")?.unwrap()["body"], "Keep cached mail");
            }
            assert_eq!(
                db.get("person@example.invalid", "draft")?.unwrap()["body"],
                "Keep draft"
            );
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn oauth_separate_purposes_browser_binding_canonical_mail_and_import() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let imported = Arc::new(AtomicUsize::new(0));
    let imports = imported.clone();
    let fixture=Fixture::new(Arc::new(move|method,target,headers,body|{let count=count.clone();let imports=imports.clone();async move {
        count.fetch_add(1,Ordering::SeqCst);
        if method=="POST" {assert!(string(&body,"code_verifier").len()>=43);if headers["host"]=="login.microsoftonline.com"{if body["client_id"]==oauth::MICROSOFT_CLIENT_ID.trim(){assert!(body.get("client_secret").is_none());}assert!(string(&body,"scope").contains(if body["code"]=="calendar" {"Calendars.ReadWrite"}else{"Mail.Read"}));}return(200,json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}));}
        if target.contains("calendarList")||target.starts_with("/v1.0/me/calendars") {return(200,calendars());}
        if target.contains("/messages") { imports.fetch_add(1,Ordering::SeqCst);return(200,json!({"value":[{"id":"same","subject":"Fixture","from":{"emailAddress":{"address":"sender@example.invalid"}},"body":{"contentType":"text","content":"Fixture"},"receivedDateTime":"2026-09-01T01:00:00Z"}]}));}
        (200,json!({"email":"PERSON@example.invalid","emailAddress":"PERSON@example.invalid","mail":"PERSON@example.invalid"}))
    }.boxed()})).await;
    let mut app = fixture.app();
    Arc::get_mut(&mut app.0).unwrap().app_origin = "http://127.0.0.1:5173".into();
    set(&app,json!({"mailAccounts":{"Person@example.invalid":{"email":"Person@example.invalid","provider":"imap","password":"preserved"},"other@example.invalid":{"email":"other@example.invalid","password":"other-secret"}},"activeAccount":"other@example.invalid"})).await;
    set(&app, json!({"calendars":{"microsoft":{"clientId":oauth::MICROSOFT_CLIENT_ID.trim(),"clientSecret":"stale-private"}}})).await;
    for provider in ["google", "microsoft"] {
        let (local, cookie, remote) = begin(&app, true, provider).await;
        let scope = remote
            .query_pairs()
            .find(|(k, _)| k == "scope")
            .unwrap()
            .1
            .into_owned();
        assert!(!scope.contains("gmail") && !scope.contains("Mail.Read"));
        let ctx = callback_context(&local, &cookie, "calendar");
        let completed = call(&app, ctx.clone()).await;
        assert_eq!(completed.0, 302);
        assert_eq!(location(&completed.1).host_str(), Some("127.0.0.1"));
        assert!(
            location(&completed.1)
                .query_pairs()
                .any(|(k, v)| k == "calendarConnected" && v == provider)
        );
        let before = calls.load(Ordering::SeqCst);
        let replay = call(&app, ctx).await;
        assert!(
            location(&replay.1)
                .query_pairs()
                .any(|(k, _)| k == "calendarError")
        );
        assert_eq!(before, calls.load(Ordering::SeqCst));
        assert_eq!(
            app.settings().await.unwrap()["activeAccount"],
            "other@example.invalid"
        );
    }
    let (local, cookie, remote) = begin(&app, false, "google").await;
    assert!(
        remote
            .query_pairs()
            .any(|(k, v)| k == "scope" && v.contains("gmail.modify"))
    );
    let completed = call(&app, callback_context(&local, &cookie, "mail")).await;
    assert!(
        location(&completed.1)
            .query_pairs()
            .any(|(k, v)| k == "connected" && v == "google"),
        "{:?}",
        completed.1
    );
    let settings = app.settings().await.unwrap();
    assert_eq!(settings["activeAccount"], "Person@example.invalid");
    assert_eq!(settings["mailAccounts"].as_object().unwrap().len(), 2);
    assert_eq!(
        settings["mailAccounts"]["other@example.invalid"]["password"],
        "other-secret"
    );
    assert_eq!(
        settings["imports"]["Person@example.invalid"]["options"]["inbox"],
        false
    );
    assert_eq!(
        settings["imports"]["Person@example.invalid"]["connectionId"],
        settings["mailAccounts"]["Person@example.invalid"]["connectionId"]
    );
    let (local, cookie, _) = begin(&app, false, "microsoft").await;
    let before = calls.load(Ordering::SeqCst);
    let rejected = call(
        &app,
        callback_context(&local, "genmail_oauth=wrong", "mail"),
    )
    .await;
    assert!(
        location(&rejected.1)
            .query_pairs()
            .any(|(k, v)| k == "connectionError" && v.contains("verified"))
    );
    call(&app, callback_context(&local, &cookie, "mail")).await;
    assert_eq!(before, calls.load(Ordering::SeqCst));
    assert_eq!(
        imported.load(Ordering::SeqCst),
        0,
        "history import must not fetch mail during OAuth"
    );
    app.db(|db| {
        db.upsert(
            "other@example.invalid",
            &json!({"id":"microsoft:same","body":"Keep other account","folder":"inbox"}),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let started = call(
        &app,
        context(
            "POST",
            "/api/oauth/microsoft/start",
            json!({"clientId":"fixture-client"}),
        ),
    )
    .await;
    let local = url::Url::parse(string(&started.2, "url")).unwrap();
    let authorized = call(
        &app,
        context(
            "GET",
            &format!("{}?{}", local.path(), local.query().unwrap()),
            json!({}),
        ),
    )
    .await;
    let cookie = authorized.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let connected = call(&app, callback_context(&local, cookie, "mail")).await;
    assert!(
        location(&connected.1)
            .query_pairs()
            .any(|(k, v)| k == "connected" && v == "microsoft"),
        "{:?}",
        connected.1
    );
    assert_eq!(imported.load(Ordering::SeqCst), 1);
    app.db(|db| {
        assert_eq!(
            db.get("Person@example.invalid", "microsoft:same")?.unwrap()["body"],
            "Fixture"
        );
        assert_eq!(
            db.get("other@example.invalid", "microsoft:same")?.unwrap()["body"],
            "Keep other account"
        );
        Ok(())
    })
    .await
    .unwrap();
    let listed = call(&app, context("GET", "/api/calendars", json!({}))).await;
    assert_eq!(listed.0, 200);
    assert!(!listed.2.to_string().contains("fixture-secret"));
    assert!(!listed.2.to_string().contains("accessToken"));
}

#[tokio::test]
async fn generation_rechecks_coalesced_refresh_and_mutation_exclusion() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let refreshes = Arc::new(AtomicUsize::new(0));
    let (en, rel, count) = (entered.clone(), release.clone(), refreshes.clone());
    let fixture=Fixture::new(Arc::new(move|method,target,_,body|{let(en,rel,count)=(en.clone(),rel.clone(),count.clone());async move {
        if target=="/token" {count.fetch_add(1,Ordering::SeqCst);en.notify_one();tokio::time::timeout(Duration::from_secs(5), rel.notified()).await.expect("fixture must be released");return(200,json!({"access_token":"rotated","refresh_token":"rotated-refresh","expires_in":3600}));}
        if method=="POST" {en.notify_one();tokio::time::timeout(Duration::from_secs(5), rel.notified()).await.expect("fixture must be released");return(200,body);}
        (200,calendars())
    }.boxed()})).await;
    let app = fixture.app();
    let mut expired = connection("google");
    expired["expiresAt"] = 0.into();
    set(
        &app,
        json!({"calendars":{"google":expired,"microsoft":connection("microsoft")}}),
    )
    .await;
    let a = app.clone();
    let first =
        tokio::spawn(async move { call(&a, context("GET", "/api/calendars", json!({}))).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("fixture request must arrive");
    let a = app.clone();
    let second = tokio::spawn(async move {
        call(&a,context("GET","/api/calendars/google/events?calendarId=work&start=2026-10-01T00%3A00%3A00Z&end=2026-10-02T00%3A00%3A00Z",json!({}))).await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(
        call(
            &app,
            context(
                "POST",
                "/api/calendars/google/disconnect",
                json!({"connectionEmail":"google@example.invalid"})
            )
        )
        .await
        .0,
        200
    );
    release.notify_one();
    let result = first.await.unwrap();
    assert_eq!(result.2["connections"][0]["connected"], false);
    assert_eq!(second.await.unwrap().0, 409);
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    assert!(app.settings().await.unwrap()["calendars"]["google"].is_null());
    set(
        &app,
        json!({"calendars":{"google":connection("google"),"microsoft":connection("microsoft")}}),
    )
    .await;
    let a = app.clone();
    let creating = tokio::spawn(async move {
        call(&a, context("POST", "/api/calendars/google/events", input())).await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("fixture request must arrive");
    for (path, body) in [
        (
            "/api/calendars/google/disconnect",
            json!({"connectionEmail":"google@example.invalid"}),
        ),
        ("/api/calendars/google/connect", json!({"clientId":"new"})),
        ("/api/calendars/google/events", input()),
    ] {
        assert_eq!(call(&app, context("POST", path, body)).await.0, 409);
    }
    assert_eq!(
        call(
            &app,
            context(
                "POST",
                "/api/calendars/microsoft/disconnect",
                json!({"connectionEmail":"microsoft@example.invalid"})
            )
        )
        .await
        .0,
        200
    );
    release.notify_one();
    assert_eq!(creating.await.unwrap().0, 200);
    let mut expired = connection("google");
    expired["expiresAt"] = 0.into();
    set(&app, json!({"calendars":{"google":expired}})).await;
    let a = app.clone();
    let cancelled =
        tokio::spawn(async move { call(&a, context("GET", "/api/calendars", json!({}))).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    cancelled.abort();
    let _ = cancelled.await;
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while app.settings().await.unwrap()["calendars"]["google"]["accessToken"] != "rotated" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("cancelled readers must retain rotated tokens");
    assert_eq!(refreshes.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn validation_blocks_network_and_desktop_credentials_are_explicit() {
    let fixture = Fixture::new(Arc::new(|_, _, _, _| {
        async { panic!("invalid input must not reach a provider") }.boxed()
    }))
    .await;
    let app = fixture.app();
    set(&app, json!({"calendars":{"google":connection("google")}})).await;
    for patch in [
        json!({"start":"2026-02-31T09:00:00Z"}),
        json!({"start":"2026-10-01T09:00:00"}),
        json!({"start":"2026-10-01T09:00:00+14:30"}),
        json!({"end":"2027-10-01T09:00:00Z"}),
        json!({"requestId":"bad"}),
        json!({"title":"First\nSecond"}),
        json!({"attendees":["unexpected@example.invalid"]}),
        json!({"calendarId":".."}),
    ] {
        let mut value = input();
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert_eq!(
            call(&app, context("POST", "/api/calendars/google/events", value))
                .await
                .0,
            400
        );
    }
    assert!(app.settings().await.unwrap()["calendarRequests"].is_null());
    let source=json!({"installed":{"client_id":"fixture.apps.googleusercontent.com","client_secret":"fixture-desktop-secret","refresh_token":"must-not-ship"}}).to_string();
    let google = oauth::parse_google_oauth(&source).unwrap();
    assert_eq!(google.as_object().unwrap().len(), 2);
    assert_eq!(
        oauth::credentials(
            "google",
            &json!({"useDefaultClient":true,"organize":true}),
            Some(&google)
        )
        .unwrap()["clientId"],
        google["clientId"]
    );
    for (provider, body, client) in [
        ("google", json!({"useDefaultClient":true}), None),
        (
            "microsoft",
            json!({"useDefaultClient":true,"clientSecret":"custom"}),
            Some(&google),
        ),
        (
            "google",
            json!({"useDefaultClient":true,"clientId":"custom"}),
            Some(&google),
        ),
        ("google", json!({"useDefaultClient":"true"}), Some(&google)),
    ] {
        assert!(oauth::credentials(provider, &body, client).is_err());
    }
    for source in ["{bad-json".into(),"null".into()," ".repeat(32769),json!({"web":{"client_id":"fixture.apps.googleusercontent.com","client_secret":"secret"}}).to_string(),json!({"installed":{"client_id":"fixture.apps.googleusercontent.com","client_secret":"secret\nvalue"}}).to_string()] {assert!(oauth::parse_google_oauth(&source).is_err());}
    let file = fixture.root.join("google-oauth.json");
    assert!(oauth::bundled_google_oauth(&file).unwrap().is_none());
    fs::write(&file, source).unwrap();
    assert_eq!(oauth::bundled_google_oauth(&file).unwrap(), Some(google));
    drop(app);
    let store = Store::open(&fixture.root.join("workspace")).unwrap();
    assert!(store.settings().unwrap()["calendarRequests"].is_null());
}

#[tokio::test]
async fn write_permissions_date_boundaries_and_oauth_loopback_api_security() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let fixture=Fixture::new(Arc::new(move|method,target,_,_|{let count=count.clone();async move {
        count.fetch_add(1,Ordering::SeqCst);assert_eq!(method,"GET");
        if target.contains("calendarList") {(200,json!({"items":[{"id":"work@example.invalid","summary":"Read only","accessRole":"reader"}]}))}else{(200,json!({"items":[]}))}
    }.boxed()})).await;
    let app = fixture.app();
    set(&app, json!({"calendars":{"google":connection("google")}})).await;
    assert_eq!(
        call(
            &app,
            context("POST", "/api/calendars/google/events", input())
        )
        .await
        .0,
        403
    );
    assert!(app.settings().await.unwrap()["calendarRequests"].is_null());
    let mut value = input();
    value["start"] = "2026-09-01T00:00:00-04:00".into();
    value["end"] = "2026-11-30T00:00:00-05:00".into();
    assert_eq!(
        call(&app, context("POST", "/api/calendars/google/events", value))
            .await
            .0,
        400
    );
    for (end, status) in [
        ("2026-11-30T00:00:00-05:00", 200),
        ("2026-11-30T01:00:00-05:00", 200),
        ("2026-11-30T01:00:01-05:00", 400),
    ] {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("calendarId", "work"),
                ("start", "2026-09-01T00:00:00-04:00"),
                ("end", end),
            ])
            .finish();
        assert_eq!(
            call(
                &app,
                context(
                    "GET",
                    &format!("/api/calendars/google/events?{query}"),
                    json!({})
                )
            )
            .await
            .0,
            status
        );
    }
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, app.router()).into_future());
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let start = format!("{origin}/api/oauth/google/start");
    let body = json!({"clientId":"fixture-client","clientSecret":"fixture-secret"});
    assert_eq!(
        client
            .post(&start)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(&start)
            .bearer_auth("fixture-native-token")
            .header("origin", "https://attacker.invalid")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let result: Value = client
        .post(&start)
        .bearer_auth("fixture-native-token")
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let local = url::Url::parse(string(&result, "url")).unwrap();
    let authorized = client
        .get(format!(
            "{origin}{}?{}",
            local.path(),
            local.query().unwrap()
        ))
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(authorized.status(), 302);
    assert!(
        authorized.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    let failed = client
        .get(format!(
            "{origin}{}?{}&code=fixture",
            local.path().replace("authorize", "callback"),
            local.query().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), 302);
    assert!(
        failed.headers()["location"]
            .to_str()
            .unwrap()
            .contains("connectionError")
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    server.abort();
    let _ = server.await;
}
