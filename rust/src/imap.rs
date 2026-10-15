use crate::{
    error::{Error, Result},
    providers,
    store::{merge, string},
    validation,
};
use async_imap::{
    Session,
    types::{Flag, NameAttribute},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, SecondsFormat, Utc};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
type Mailbox = Session<BoundedImap<tokio_native_tls::TlsStream<tokio::net::TcpStream>>>;
const COMMAND_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug)]
struct ResponseLimit(usize);
impl std::fmt::Display for ResponseLimit {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bound = if self.0 >= 1024 * 1024 {
            format!("{} MiB", self.0 / (1024 * 1024))
        } else {
            format!("{} KiB", self.0 / 1024)
        };
        write!(
            output,
            "The IMAP response exceeds the {bound} safety limit. Narrow the import date range and try again."
        )
    }
}
impl std::error::Error for ResponseLimit {}
fn network_error() -> Error {
    let mut error = providers::remote_error();
    error.body["code"] = "provider_network".into();
    error
}
fn transient_io(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::TimedOut
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::HostUnreachable
            | io::ErrorKind::NetworkUnreachable
            | io::ErrorKind::NetworkDown
    )
}
fn io_error(error: io::Error) -> Error {
    if transient_io(&error) {
        network_error()
    } else {
        providers::remote_error()
    }
}
fn connect_error(error: io::Error) -> Error {
    // Host/port validation has already succeeded. getaddrinfo failures often
    // have an unclassified/Other kind, so classify them only at this boundary.
    if matches!(
        error.kind(),
        io::ErrorKind::InvalidInput
            | io::ErrorKind::InvalidData
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::OutOfMemory
            | io::ErrorKind::Unsupported
    ) {
        providers::remote_error()
    } else {
        network_error()
    }
}
fn tls_error(error: native_tls::Error) -> Error {
    // Certificate, protocol and trust failures must not become automatic retries.
    // Only a typed transport cause in the platform TLS error chain is retryable.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(cause) = source {
        if cause.downcast_ref::<io::Error>().is_some_and(transient_io) {
            return network_error();
        }
        source = cause.source();
    }
    providers::remote_error()
}
fn imap_error(error: impl Into<async_imap::error::Error>) -> Error {
    match error.into() {
        async_imap::error::Error::Io(error) => {
            if let Some(limit) = error
                .get_ref()
                .and_then(|error| error.downcast_ref::<ResponseLimit>())
            {
                Error::new(502, &limit.to_string())
            } else {
                io_error(error)
            }
        }
        async_imap::error::Error::ConnectionLost => network_error(),
        _ => providers::remote_error(),
    }
}

#[derive(Clone, Copy, Debug, Default)]
enum LiteralProbe {
    #[default]
    Text,
    Number(u64, bool),
    Brace(u64),
    Cr(u64),
}
/// Inspect literal declarations before async-imap can allocate their announced size.
/// Commands are serial; a successful command write starts a fresh bounded response.
#[derive(Debug)]
struct BoundedImap<S> {
    inner: S,
    remaining: usize,
    limit: usize,
    literal_remaining: u64,
    probe: LiteralProbe,
    failed: bool,
    prefix: [u8; 16],
    prefix_len: usize,
    last_cr: bool,
    write_cr: bool,
}
impl<S> BoundedImap<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            remaining: COMMAND_LIMIT,
            limit: COMMAND_LIMIT,
            literal_remaining: 0,
            probe: LiteralProbe::Text,
            failed: false,
            prefix: [0; 16],
            prefix_len: 0,
            last_cr: false,
            write_cr: false,
        }
    }
    fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
        self.remaining = limit;
    }
    fn inspect(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            self.remaining -= 1;
            if self.literal_remaining > 0 {
                self.literal_remaining -= 1;
                continue;
            }
            if self.prefix_len < self.prefix.len() {
                self.prefix[self.prefix_len] = *byte;
                self.prefix_len += 1;
            }
            let mut literal = false;
            let restart = if *byte == b'{' {
                LiteralProbe::Number(0, false)
            } else {
                LiteralProbe::Text
            };
            self.probe = match (self.probe, *byte) {
                (LiteralProbe::Number(value, _), b'0'..=b'9') => LiteralProbe::Number(
                    value
                        .saturating_mul(10)
                        .saturating_add(u64::from(byte - b'0')),
                    true,
                ),
                (LiteralProbe::Number(value, true), b'}') => LiteralProbe::Brace(value),
                (LiteralProbe::Brace(value), b'\r') => LiteralProbe::Cr(value),
                (LiteralProbe::Cr(value), b'\n') => {
                    // Status/greeting text is not a literal, even when it ends in {N}.
                    let prefix = &self.prefix[..self.prefix_len];
                    let kind = prefix
                        .get(2..)
                        .unwrap_or_default()
                        .split(|byte| byte.is_ascii_whitespace())
                        .find(|part| !part.is_empty())
                        .unwrap_or_default();
                    if prefix.starts_with(b"* ")
                        && ![b"OK".as_slice(), b"NO", b"BAD", b"BYE", b"PREAUTH"]
                            .iter()
                            .any(|status| kind.eq_ignore_ascii_case(status))
                    {
                        if value > self.remaining as u64 {
                            return Err(io::Error::other(ResponseLimit(self.limit)));
                        }
                        self.literal_remaining = value;
                        literal = true;
                    }
                    LiteralProbe::Text
                }
                _ => restart,
            };
            if *byte == b'\n' && self.last_cr && !literal {
                self.prefix_len = 0;
            }
            self.last_cr = *byte == b'\r';
        }
        Ok(())
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for BoundedImap<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.failed || this.remaining == 0 {
            this.failed = true;
            return Poll::Ready(Err(io::Error::other(ResponseLimit(this.limit))));
        }
        let mut bytes = [0; 8192];
        let size = output.remaining().min(bytes.len()).min(this.remaining);
        let mut input = ReadBuf::new(&mut bytes[..size]);
        match Pin::new(&mut this.inner).poll_read(cx, &mut input) {
            Poll::Ready(Ok(())) => {
                if let Err(error) = this.inspect(input.filled()) {
                    this.failed = true;
                    return Poll::Ready(Err(error));
                }
                output.put_slice(input.filled());
                crate::sync_profile::count("imapResponseBytes", input.filled().len() as u64);
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for BoundedImap<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.failed {
            return Poll::Ready(Err(io::Error::other(ResponseLimit(this.limit))));
        }
        let result = Pin::new(&mut this.inner).poll_write(cx, bytes);
        if let Poll::Ready(Ok(size)) = &result
            && *size > 0
        {
            this.remaining = this.limit;
            crate::sync_profile::count("imapRequestBytes", *size as u64);
            for byte in &bytes[..*size] {
                if this.write_cr && *byte == b'\n' {
                    crate::sync_profile::count("imapCommands", 1);
                }
                this.write_cr = *byte == b'\r';
            }
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

async fn parse_mime(bytes: Vec<u8>) -> Result<Value> {
    // Keep the permit in the blocking job even if its awaiting request is cancelled.
    static WORKER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let permit = WORKER
        .acquire()
        .await
        .map_err(|_| providers::remote_error())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        providers::mime(&bytes)
    })
    .await
    .map_err(|_| providers::remote_error())?
}
fn port(mail: &Value, key: &str, default: u16) -> Result<u16> {
    mail.get(key)
        .map(|v| {
            v.as_u64()
                .and_then(|v| u16::try_from(v).ok())
                .filter(|v| *v != 0)
                .ok_or_else(|| Error::invalid("Invalid mail server port."))
        })
        .unwrap_or(Ok(default))
}
fn smtp(mail: &Value, tls: TlsParameters) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let host = validation::hostname(&mail["smtpHost"], "SMTP host")?;
    let port = port(mail, "smtpPort", 465)?;
    Ok(
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(port)
            .tls(if port == 465 {
                Tls::Wrapper(tls)
            } else {
                Tls::Required(tls)
            })
            .credentials(Credentials::new(
                validation::email(&mail["email"])?,
                string(mail, "password").into(),
            ))
            .timeout(Some(Duration::from_secs(30)))
            .build(),
    )
}
fn smtp_tls(mail: &Value) -> Result<TlsParameters> {
    TlsParameters::new(validation::hostname(&mail["smtpHost"], "SMTP host")?)
        .map_err(|_| providers::remote_error())
}
pub async fn verify_smtp(mail: &Value) -> Result<()> {
    verify_smtp_with_tls(mail, smtp_tls(mail)?).await
}
/// Library-only transport injection; API callers always use the platform trust store.
pub async fn verify_smtp_with_tls(mail: &Value, tls: TlsParameters) -> Result<()> {
    let transport = smtp(mail, tls)?;
    if !transport
        .test_connection()
        .await
        .map_err(|_| providers::remote_error())?
    {
        return Err(providers::remote_error());
    }
    Ok(())
}
pub async fn send(mail: &Value, message: &Value) -> Result<String> {
    send_with_tls(mail, message, smtp_tls(mail)?).await
}
pub async fn send_with_tls(mail: &Value, message: &Value, tls: TlsParameters) -> Result<String> {
    let transport = smtp(mail, tls)?;
    let (message, id) = providers::compose(mail, message, false)?;
    transport
        .send(message)
        .await
        .map_err(|_| providers::remote_error())?;
    Ok(id)
}
fn connector() -> Result<native_tls::TlsConnector> {
    native_tls::TlsConnector::new().map_err(|_| providers::remote_error())
}
/// Stable UID namespace: exactly the endpoint, transport and LOGIN principal
/// used by connect(). Password, SMTP settings and reconnect generation are not identity.
pub fn server_origin(mail: &Value) -> Result<String> {
    let host = validation::hostname(&mail["imapHost"], "IMAP host")?.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let principal = validation::email(&mail["email"])?;
    let endpoint = json!([
        "imap-origin-v1",
        "implicit-tls",
        host,
        port(mail, "imapPort", 993)?,
        principal
    ]);
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&endpoint)?)))
}

/// A notification is only a request for ordinary bounded synchronization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdleOutcome {
    Changed,
    LeaseEnded,
    Unsupported,
}

fn idle_protocol_error() -> Error {
    let mut error = Error::new(
        502,
        "IMAP notifications stopped; ordinary mail polling remains available.",
    );
    error.body["code"] = "imap_idle_protocol".into();
    error
}

fn idle_notification(response: &imap_proto::Response<'_>) -> Result<bool> {
    use imap_proto::{MailboxDatum, Response, Status};
    match response {
        Response::MailboxData(MailboxDatum::Exists(_) | MailboxDatum::Recent(_))
        | Response::Fetch(..)
        | Response::Expunge(_)
        | Response::Vanished { .. } => Ok(true),
        Response::MailboxData(MailboxDatum::Flags(_))
        | Response::Data {
            status: Status::Ok, ..
        } => Ok(false),
        _ => Err(idle_protocol_error()),
    }
}

/// Library-only TLS/lease injection. The service uses platform trust and a fixed
/// 60-second lease; API callers cannot override either. No session is returned
/// or reused after this future completes, fails, times out or is dropped.
pub async fn idle_inbox_with_tls(
    mail: &Value,
    validity: Option<u32>,
    connector: &native_tls::TlsConnector,
    budget: Duration,
) -> Result<IdleOutcome> {
    idle_folder_with_tls(mail, "INBOX", validity, false, connector, budget).await
}

pub(crate) async fn idle_selected_folder_with_tls(
    mail: &Value,
    path: &str,
    validity: u32,
    connector: &native_tls::TlsConnector,
    budget: Duration,
) -> Result<IdleOutcome> {
    if validity == 0 {
        return Err(idle_protocol_error());
    }
    idle_folder_with_tls(mail, path, Some(validity), true, connector, budget).await
}

async fn idle_folder_with_tls(
    mail: &Value,
    path: &str,
    validity: Option<u32>,
    selected_custom: bool,
    connector: &native_tls::TlsConnector,
    budget: Duration,
) -> Result<IdleOutcome> {
    use async_imap::types::Capability;
    use imap_proto::{Response, Status};
    if budget < Duration::from_millis(40) || budget > Duration::from_secs(60) {
        return Err(Error::invalid("Invalid IMAP notification lease."));
    }
    // The identity unit supplies this canonical endpoint/login validator. A
    // malformed origin never reaches the network, even through library callers.
    server_origin(mail)?;
    valid_folder(path)?;
    let deadline = tokio::time::Instant::now() + budget;
    let leave_idle = deadline - Duration::from_secs(2).min(budget / 4);
    let setup_deadline = leave_idle.min(tokio::time::Instant::now() + Duration::from_secs(45));
    let Some((mut session, tag, mut changed)) = tokio::time::timeout_at(setup_deadline, async {
        let mut session = connect(mail, connector).await?;
        let capabilities = session.capabilities().await.map_err(imap_error)?;
        if !capabilities.iter().any(|capability| {
            matches!(capability, Capability::Atom(atom) if atom.eq_ignore_ascii_case("IDLE"))
        }) {
            return Ok(None);
        }
        if selected_custom {
            require_selectable_custom(&mut session, path).await?;
        }
        let mailbox = examine_read(&mut session, path).await?;
        if mailbox.uid_validity.is_none_or(|value| value == 0)
            || validity.is_some_and(|expected| mailbox.uid_validity != Some(expected))
        {
            let mut error = idle_protocol_error();
            error.body["code"] = "imap_idle_mailbox_changed".into();
            return Err(error);
        }
        session.as_mut().set_limit(128 * 1024);
        let tag = session.run_command("IDLE").await.map_err(imap_error)?;
        let mut changed = false;
        loop {
            if tokio::time::Instant::now() >= setup_deadline {
                return Err(network_error());
            }
            let response = session
                .read_response()
                .await
                .map_err(io_error)?
                .ok_or_else(network_error)?;
            match response.parsed() {
                Response::Continue { .. } => return Ok(Some((session, tag, changed))),
                Response::Done {
                    tag: received,
                    status: Status::No | Status::Bad,
                    ..
                } if received == &tag => return Ok(None),
                other => changed |= idle_notification(other)?,
            }
        }
    })
    .await
    .map_err(|_| network_error())??
    else {
        // Missing/rejected IDLE is polling-only for this connection generation.
        return Ok(IdleOutcome::Unsupported);
    };
    while !changed {
        if tokio::time::Instant::now() >= leave_idle {
            break;
        }
        let response = match tokio::time::timeout_at(leave_idle, session.read_response()).await {
            Ok(response) => response.map_err(io_error)?.ok_or_else(network_error)?,
            Err(_) => break,
        };
        changed |= idle_notification(response.parsed())?;
    }
    tokio::time::timeout_at(deadline, async {
        session
            .run_command_untagged("DONE")
            .await
            .map_err(imap_error)?;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(network_error());
            }
            let response = session
                .read_response()
                .await
                .map_err(io_error)?
                .ok_or_else(network_error)?;
            match response.parsed() {
                Response::Done {
                    tag: received,
                    status: Status::Ok,
                    ..
                } if received == &tag => {
                    return Ok(if changed {
                        IdleOutcome::Changed
                    } else {
                        IdleOutcome::LeaseEnded
                    });
                }
                other => changed |= idle_notification(other)?,
            }
        }
    })
    .await
    .map_err(|_| network_error())?
}

async fn connect(mail: &Value, connector: &native_tls::TlsConnector) -> Result<Mailbox> {
    let _phase = crate::sync_profile::phase("imapConnect");
    crate::sync_profile::count("imapConnections", 1);
    let host = validation::hostname(&mail["imapHost"], "IMAP host")?;
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect((host.as_str(), port(mail, "imapPort", 993)?)),
    )
    .await
    .map_err(|_| network_error())?
    .map_err(connect_error)?;
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_native_tls::TlsConnector::from(connector.clone()).connect(&host, stream),
    )
    .await
    .map_err(|_| network_error())?
    .map_err(tls_error)?;
    let mut client = async_imap::Client::new(BoundedImap::new(stream));
    tokio::time::timeout(Duration::from_secs(30), async {
        client
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(network_error)?;
        client
            .login(validation::email(&mail["email"])?, string(mail, "password"))
            .await
            .map_err(|(error, _)| imap_error(error))
    })
    .await
    .map_err(|_| network_error())?
}

/// Own one connection for discovery followed by one bounded flags read. It is
/// never pooled across owners or sync ticks. Taking the session before awaiting
/// makes a cancelled/failed operation discard it instead of leaving a partially
/// consumed IMAP response available to the next operation.
pub(crate) struct ReadRound {
    mail: Value,
    connector: native_tls::TlsConnector,
    session: Option<Mailbox>,
    uses: u8,
    deadline: tokio::time::Instant,
}
impl ReadRound {
    pub(crate) fn new(mail: &Value, tls: Option<&native_tls::TlsConnector>) -> Result<Self> {
        Ok(Self {
            mail: mail.clone(),
            connector: match tls {
                Some(tls) => tls.clone(),
                None => connector()?,
            },
            session: None,
            uses: 0,
            // The existing two reads each had a 45-second limit. Time spent
            // between them cannot extend their combined lifetime indefinitely.
            deadline: tokio::time::Instant::now() + Duration::from_secs(90),
        })
    }
    fn take(&mut self) -> Result<(Option<Mailbox>, tokio::time::Instant)> {
        let session = self.session.take();
        let now = tokio::time::Instant::now();
        if self.uses >= 2 || self.uses > 0 && session.is_none() || now >= self.deadline {
            return Err(network_error());
        }
        self.uses += 1;
        Ok((session, self.deadline.min(now + Duration::from_secs(45))))
    }
    pub(crate) async fn discover(
        &mut self,
        app: &crate::service::App,
        folder: &str,
        checkpoint: &Value,
    ) -> Result<Value> {
        let (session, deadline) = self.take()?;
        let (session, state) = tokio::time::timeout_at(deadline, async {
            valid_folder(folder)?;
            let mut session =
                current_read_session(app, &self.mail, &self.connector, session).await?;
            let state =
                discover_changes_session(&mut session, &self.mail, folder, checkpoint).await?;
            Ok::<_, Error>((session, state))
        })
        .await
        .map_err(|_| network_error())??;
        self.session = Some(session);
        Ok(state)
    }
    pub(crate) async fn reconcile(
        &mut self,
        app: &crate::service::App,
        messages: &[Value],
    ) -> Result<Vec<Value>> {
        let (session, deadline) = self.take()?;
        let (session, rows) = tokio::time::timeout_at(deadline, async {
            if messages.len() > 50 {
                return Err(Error::invalid("Reconciliation batch exceeds 50 messages."));
            }
            let mut session =
                current_read_session(app, &self.mail, &self.connector, session).await?;
            let rows = reconcile_session(&mut session, &self.mail, messages).await?;
            Ok::<_, Error>((session, rows))
        })
        .await
        .map_err(|_| network_error())??;
        self.session = Some(session);
        Ok(rows)
    }
    pub(crate) async fn close(mut self) {
        if let Some(mut session) = self.session.take() {
            let deadline = self
                .deadline
                .min(tokio::time::Instant::now() + Duration::from_secs(2));
            let _ = tokio::time::timeout_at(deadline, session.logout()).await;
        }
    }
}
async fn current_read_session(
    app: &crate::service::App,
    mail: &Value,
    tls: &native_tls::TlsConnector,
    session: Option<Mailbox>,
) -> Result<Mailbox> {
    if crate::service::connections(&app.settings().await?).get(string(mail, "email")) != Some(mail)
    {
        return Err(Error::conflict(
            "This mailbox changed before the provider read.",
        ));
    }
    match session {
        Some(session) => {
            crate::sync_profile::count("imapSessionReuses", 1);
            Ok(session)
        }
        None => connect(mail, tls).await,
    }
}
async fn names(session: &mut Mailbox) -> Result<Vec<(String, bool)>> {
    Ok(list_names(session)
        .await?
        .into_iter()
        .filter(|v| v.selectable)
        .map(|v| (v.path, v.kind == "sent"))
        .collect())
}
struct ImportFolder {
    path: String,
    kind: &'static str,
    delimiter: Option<String>,
    selectable: bool,
    editable: bool,
}

async fn require_selectable_custom(session: &mut Mailbox, path: &str) -> Result<()> {
    let catalog = list_names(session).await?;
    if !catalog.iter().any(|folder| {
        folder.path == path
            && folder.selectable
            && folder.editable
            && ["archive", "folder"].contains(&folder.kind)
    }) || catalog.iter().any(|folder| {
        ["spam", "trash", "virtual"].contains(&folder.kind)
            && (folder.path == path
                || folder.delimiter.as_ref().is_some_and(|delimiter| {
                    !delimiter.is_empty()
                        && path.starts_with(&format!("{}{delimiter}", folder.path))
                }))
    }) {
        let mut error = Error::conflict("The selected custom IMAP folder is unavailable.");
        error.body["code"] = "folder_unavailable".into();
        return Err(error);
    }
    Ok(())
}

async fn list_names(session: &mut Mailbox) -> Result<Vec<ImportFolder>> {
    use imap_proto::types::{MailboxDatum, Response, Status};
    // The library's LIST stream discards tagged failures, so check completion before trusting absence.
    let tag = session
        .run_command("LIST \"\" \"*\"")
        .await
        .map_err(imap_error)?;
    let mut names = Vec::new();
    let mut count = 0;
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(network_error)?;
        let (attributes, delimiter, name) = match response.parsed() {
            Response::Done {
                tag: finished,
                status,
                ..
            } => {
                if *finished != tag || *status != Status::Ok {
                    return Err(providers::remote_error());
                }
                return Ok(names);
            }
            Response::MailboxData(MailboxDatum::List {
                name_attributes,
                delimiter,
                name,
            }) => (name_attributes, delimiter, name),
            _ => continue,
        };
        count += 1;
        if count > 300 {
            return Err(Error::new(
                502,
                "This mailbox exceeds the 300 folder limit.",
            ));
        }
        let path = decode_folder(name)?;
        let has = |expected: NameAttribute<'_>, text: &str| {
            attributes.iter().any(|attribute| *attribute == expected || matches!(attribute, NameAttribute::Extension(value) if value.eq_ignore_ascii_case(text)))
        };
        let kind = if has(NameAttribute::Junk, "\\Junk") {
            "spam"
        } else if has(NameAttribute::Trash, "\\Trash") {
            "trash"
        } else if has(NameAttribute::All, "\\All") || has(NameAttribute::Flagged, "\\Flagged") {
            "virtual"
        } else if path.eq_ignore_ascii_case("INBOX") {
            "inbox"
        } else if has(NameAttribute::Sent, "\\Sent") {
            "sent"
        } else if has(NameAttribute::Drafts, "\\Drafts") {
            "drafts"
        } else {
            "archive"
        };
        names.push(ImportFolder {
            path,
            kind,
            delimiter: delimiter.as_ref().map(|value| value.to_string()),
            selectable: !attributes.contains(&NameAttribute::NoSelect),
            editable: kind == "archive" && !has(NameAttribute::Archive,"\\Archive") && !attributes.iter().any(|a| matches!(a, NameAttribute::Extension(v) if v.eq_ignore_ascii_case("\\Important"))),
        });
    }
}
async fn move_capabilities(session: &mut Mailbox) -> Result<()> {
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    // Capability atoms are case-insensitive; async-imap's generic has_str
    // checks Atom strings case-sensitively.
    let has = |name: &str| {
        capabilities.iter().any(|capability| {
            matches!(capability, async_imap::types::Capability::Atom(value) if value.eq_ignore_ascii_case(name))
        })
    };
    if !has("MOVE") || !has("UIDPLUS") {
        let mut error = Error::new(
            409,
            "Safe folder moves require MOVE and UIDPLUS support. No move was attempted.",
        );
        error.body["code"] = "imap_move_unsupported".into();
        return Err(error);
    }
    Ok(())
}
pub async fn folders(mail: &Value) -> Result<Vec<Value>> {
    folders_with_tls(mail, &connector()?).await
}
pub async fn folders_with_tls(
    mail: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    tokio::time::timeout(Duration::from_secs(45),async{let mut session=connect(mail,connector).await?;let folders=list_names(&mut session).await?.into_iter().filter(|folder|folder.selectable).map(|folder|json!({"id":folder.path,"name":folder.path,"kind":if folder.kind=="trash"{"trash"}else if folder.kind=="inbox"{"inbox"}else{"folder"}})).collect();let _=session.logout().await;Ok(folders)}).await.map_err(|_|providers::remote_error())?
}
pub async fn management_folders(mail: &Value) -> Result<Vec<Value>> {
    management_folders_with_tls(mail, &connector()?).await
}
pub async fn management_folders_with_tls(
    mail: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail, connector).await?;
        let names = list_names(&mut session).await?;
        let result = names.iter().map(|folder| {
            let delimiter = folder.delimiter.as_deref().unwrap_or("");
            let (parent, leaf) = if delimiter.is_empty() { ("",folder.path.as_str()) } else { folder.path.rsplit_once(delimiter).unwrap_or(("",&folder.path)) };
            json!({"id":folder.path,"name":folder.path,"kind":folder.kind,"leafName":leaf,"parentId":parent,"delimiter":delimiter,
                "editable":folder.editable,"selectable":folder.selectable})
        }).collect();
        let _ = session.logout().await;
        Ok(result)
    }).await.map_err(|_|providers::remote_error())?
}
pub async fn folder_status(mail: &Value, id: &str) -> Result<Value> {
    folder_status_with_tls(mail, id, &connector()?).await
}
pub async fn folder_status_with_tls(
    mail: &Value,
    id: &str,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail, connector).await?;
        let status = session
            .status(encode_folder(id)?, "(MESSAGES UIDVALIDITY)")
            .await
            .map_err(imap_error)?;
        let _ = session.logout().await;
        Ok(json!({"totalItemCount":status.exists,"uidValidity":status.uid_validity}))
    })
    .await
    .map_err(|_| providers::remote_error())?
}
pub async fn manage_folder(
    mail: &Value,
    operation: &str,
    id: &str,
    target: &str,
    changes: &[Value],
) -> Result<Vec<Value>> {
    manage_folder_with_tls(mail, operation, id, target, changes, &connector()?).await
}
pub async fn manage_folder_with_tls(
    mail: &Value,
    operation: &str,
    id: &str,
    target: &str,
    changes: &[Value],
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail,connector).await?;
        let names = list_names(&mut session).await?;
        if operation != "create" && !names.iter().any(|f|f.path==id && f.editable) {
            return Err(Error::conflict("Choose a custom IMAP folder. System folders are protected."));
        }
        let mut result = changes.to_vec();
        if ["rename","move"].contains(&operation) {
            for change in &mut result {
                if names.iter().any(|f|f.path==string(change,"oldId") && f.selectable) {
                    let status = session.status(encode_folder(string(change,"oldId"))?, "(UIDVALIDITY)").await.map_err(imap_error)?;
                    change["uidValidity"] = status.uid_validity.filter(|v|*v>0).ok_or_else(providers::remote_error)?.into();
                }
            }
        }
        match operation {
            "create" => session.create(encode_folder(target)?).await.map_err(imap_error)?,
            "rename" | "move" => session.rename(encode_folder(id)?,encode_folder(target)?).await.map_err(imap_error)?,
            "delete" => session.delete(encode_folder(id)?).await.map_err(imap_error)?,
            _ => return Err(Error::invalid("Invalid folder operation.")),
        }
        for change in &result {
            if let Some(validity) = change["uidValidity"].as_u64() {
                let status = session.status(encode_folder(string(change,"newName"))?, "(UIDVALIDITY)").await.map_err(imap_error)?;
                if status.uid_validity.map(u64::from) != Some(validity) {
                    return Err(Error::conflict("The renamed folder changed UIDVALIDITY. Check your provider and sync before another reviewed change."));
                }
            }
        }
        let _ = session.logout().await;
        Ok(result)
    }).await.map_err(|_|providers::remote_error())?
}
#[derive(Default)]
struct Fetched {
    uid: Option<u32>,
    size: Option<u32>,
    header: Option<Vec<u8>>,
    body: Option<Vec<u8>>,
    date: Option<DateTime<Utc>>,
    read: bool,
    starred: bool,
    draft: bool,
    modseq: Option<u64>,
}
// async-imap 0.11's FETCH stream discards tagged NO/BAD; validate completion before using rows.
async fn checked_fetch(
    session: &mut Mailbox,
    sequence: impl std::fmt::Display,
    query: impl std::fmt::Display,
) -> Result<Vec<Fetched>> {
    Ok(checked_delta(session, sequence, query).await?.0)
}
async fn checked_delta(
    session: &mut Mailbox,
    sequence: impl std::fmt::Display,
    query: impl std::fmt::Display,
) -> Result<(Vec<Fetched>, Vec<std::ops::RangeInclusive<u32>>)> {
    let (rows, vanished, _) = checked_delta_bounded(session, sequence, query, 50).await?;
    Ok((rows, vanished))
}
async fn checked_delta_bounded(
    session: &mut Mailbox,
    sequence: impl std::fmt::Display,
    query: impl std::fmt::Display,
    limit: usize,
) -> Result<(Vec<Fetched>, Vec<std::ops::RangeInclusive<u32>>, bool)> {
    let _phase = crate::sync_profile::phase("imapFetch");
    use imap_proto::types::{AttributeValue, MessageSection, Response, SectionPath, Status};
    let tag = session
        .run_command(format!("UID FETCH {sequence} {query}"))
        .await
        .map_err(imap_error)?;
    let mut rows = Vec::new();
    let mut vanished = Vec::new();
    let mut earlier_vanished = false;
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(network_error)?;
        match response.parsed() {
            Response::Done {
                tag: finished,
                status,
                ..
            } => {
                if *finished != tag {
                    return Err(providers::remote_error());
                }
                if *status != Status::Ok {
                    let mut error = providers::remote_error();
                    if matches!(status, Status::No | Status::Bad) {
                        error.body["code"] = "provider_imap_command_rejected".into();
                    }
                    return Err(error);
                }
                return Ok((rows, vanished, earlier_vanished));
            }
            Response::Fetch(_, attrs) => {
                if rows.len() >= limit {
                    return Err(providers::remote_error());
                }
                let mut row = Fetched::default();
                let mut has_flags = false;
                for attr in attrs {
                    match attr {
                        AttributeValue::Uid(id) => row.uid = Some(*id),
                        AttributeValue::ModSeq(value) => row.modseq = Some(*value),
                        AttributeValue::Rfc822Size(size) => row.size = Some(*size),
                        AttributeValue::Flags(flags) => {
                            has_flags = true;
                            row.read = flags.iter().any(|f| Flag::from(f.as_ref()) == Flag::Seen);
                            row.starred = flags
                                .iter()
                                .any(|f| Flag::from(f.as_ref()) == Flag::Flagged);
                            row.draft = flags.iter().any(|f| Flag::from(f.as_ref()) == Flag::Draft);
                        }
                        AttributeValue::InternalDate(date) => {
                            row.date = DateTime::parse_from_str(date, "%d-%b-%Y %H:%M:%S %z")
                                .ok()
                                .map(|d| d.with_timezone(&Utc))
                        }
                        AttributeValue::BodySection {
                            section: Some(SectionPath::Full(MessageSection::Header)),
                            data: Some(data),
                            ..
                        }
                        | AttributeValue::Rfc822Header(Some(data)) => {
                            row.header = Some(data.to_vec())
                        }
                        AttributeValue::BodySection {
                            section: None,
                            data: Some(data),
                            ..
                        }
                        | AttributeValue::Rfc822(Some(data)) => row.body = Some(data.to_vec()),
                        _ => {}
                    }
                }
                if query.to_string().contains("FLAGS") && !has_flags {
                    return Err(providers::remote_error());
                }
                rows.push(row);
            }
            Response::Vanished { earlier, uids } => {
                if vanished.len() + uids.len() > limit {
                    return Err(providers::remote_error());
                }
                earlier_vanished |= *earlier;
                vanished.extend(uids.iter().cloned());
            }
            Response::Data {
                status: Status::Bye,
                ..
            } => return Err(providers::remote_error()),
            _ => {}
        }
    }
}
fn incomplete_read() -> Error {
    let mut error = Error::new(
        502,
        "The IMAP server returned incomplete message data. Saved progress is retained; try again.",
    );
    error.body["code"] = "provider_incomplete_read".into();
    error
}
async fn confirm_expunged(session: &mut Mailbox, missing: &[u32]) -> Result<()> {
    if missing.is_empty() {
        return Ok(());
    }
    let sequence = missing
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut seen = std::collections::HashSet::new();
    for row in checked_fetch(session, sequence, "UID").await? {
        let uid = row.uid.ok_or_else(providers::remote_error)?;
        if !missing.contains(&uid) || !seen.insert(uid) {
            return Err(providers::remote_error());
        }
    }
    if seen.is_empty() {
        Ok(())
    } else {
        Err(incomplete_read())
    }
}
pub async fn fetch_page(mail: &Value, options: &Value) -> Result<Value> {
    fetch_page_with_tls(mail, options, &connector()?).await
}
pub(crate) async fn fetch_page_cached(
    app: &crate::service::App,
    mail: &Value,
    options: &Value,
) -> Result<Value> {
    fetch_page_cached_with_tls(app, mail, options, &connector()?).await
}
pub(crate) async fn fetch_selected_page_cached(
    app: &crate::service::App,
    mail: &Value,
    path: &str,
    checkpoint: &Value,
) -> Result<Value> {
    fetch_selected_page_cached_with_tls(app, mail, path, checkpoint, &connector()?).await
}
pub async fn fetch_selected_page_cached_with_tls(
    app: &crate::service::App,
    mail: &Value,
    path: &str,
    checkpoint: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    valid_folder(path)?;
    let options = json!({"folder":"archive","incremental":true,"syncCheckpoints":{path:checkpoint},"expectedValidity":checkpoint["validity"],"selectedCustomFolder":true});
    tokio::time::timeout(
        Duration::from_secs(45),
        fetch_folder(mail, &options, connector, Some(path), Some(app)),
    )
    .await
    .map_err(|_| network_error())?
}
pub async fn write_flags(mail: &Value, message: &Value, patch: &Value) -> Result<Value> {
    write_flags_with_tls(mail, message, patch, &connector()?).await
}
pub async fn write_flags_with_tls(
    mail: &Value,
    message: &Value,
    patch: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    crate::imap_identity::require(mail, message)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let remote = message["remoteId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(string(message, "id"));
        let parts: Vec<_> = remote.split(':').collect();
        if parts.len() != 3 || parts[0] != "imap" {
            return Err(providers::remote_error());
        }
        let validity = parts[1]
            .parse::<u32>()
            .map_err(|_| providers::remote_error())?;
        let uid = parts[2]
            .parse::<u32>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or_else(providers::remote_error)?;
        let mut session = connect(mail, connector).await?;
        let folder = message["providerFolderId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("INBOX");
        let mailbox = session
            .select(encode_folder(folder)?)
            .await
            .map_err(imap_error)?;
        if mailbox.uid_validity != Some(validity) {
            return Err(Error::conflict(
                "IMAP UIDVALIDITY changed. Sync before another change.",
            ));
        }
        {
            let rows = checked_fetch(&mut session, uid, "UID").await?;
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
        }
        for enabled in [true, false] {
            let flags = [("read", "\\Seen"), ("starred", "\\Flagged")]
                .into_iter()
                .filter(|(key, _)| patch[*key].as_bool() == Some(enabled))
                .map(|(_, flag)| flag)
                .collect::<Vec<_>>();
            if flags.is_empty() {
                continue;
            }
            let command = format!(
                "{}FLAGS.SILENT ({})",
                if enabled { "+" } else { "-" },
                flags.join(" ")
            );
            session
                .run_command_and_check_ok(format!("UID STORE {uid} {command}"))
                .await
                .map_err(imap_error)?;
        }
        let confirmed = {
            let rows = checked_fetch(&mut session, uid, "(UID FLAGS)").await?;
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
            json!({"read":rows[0].read,"starred":rows[0].starred})
        };
        let _ = session.logout().await;
        Ok(confirmed)
    })
    .await
    .map_err(|_| providers::remote_error())?
}
pub async fn reconcile(mail: &Value, messages: &[Value]) -> Result<Vec<Value>> {
    reconcile_with_tls(mail, messages, &connector()?).await
}
pub(crate) async fn reconcile_priority(mail: &Value, messages: &[Value]) -> Result<Vec<Value>> {
    reconcile_priority_with_tls(mail, messages, &connector()?).await
}
pub async fn reconcile_priority_with_tls(
    mail: &Value,
    messages: &[Value],
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    if messages.len() > crate::sync_priority::LIMIT {
        return Err(Error::invalid("The mail view exceeds its message limit."));
    }
    for message in messages {
        crate::imap_identity::require(mail, message)?;
    }
    // A retained reader can add one row to a 50-row page. Keep the existing
    // per-request limit and overall read deadline; return no partial batch.
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut result = Vec::new();
        if messages.is_empty() {
            return Ok(result);
        }
        let mut session = connect(mail, connector).await?;
        for chunk in messages.chunks(50) {
            result.extend(reconcile_session(&mut session, mail, chunk).await?);
        }
        let _ = session.logout().await;
        Ok(result)
    })
    .await
    .map_err(|_| providers::remote_error())?
}
pub async fn reconcile_with_tls(
    mail: &Value,
    messages: &[Value],
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    if messages.len() > 50 {
        return Err(Error::invalid("Reconciliation batch exceeds 50 messages."));
    }
    for message in messages {
        crate::imap_identity::require(mail, message)?;
    }
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail, connector).await?;
        let result = reconcile_session(&mut session, mail, messages).await?;
        let _ = session.logout().await;
        Ok(result)
    })
    .await
    .map_err(|_| providers::remote_error())?
}
async fn sync_examine(
    session: &mut Mailbox,
    folder: &str,
) -> Result<(async_imap::types::Mailbox, bool, bool)> {
    use imap_proto::types::{MailboxDatum, Response, ResponseCode, Status};
    let capabilities = match session.capabilities().await {
        Ok(caps) => caps,
        Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => {
            return examine_basic(session, folder).await;
        }
        Err(error) => return Err(imap_error(error)),
    };
    let mut qresync = false;
    if capabilities.has_str("QRESYNC") {
        qresync = enable_qresync(session).await?;
    }
    if qresync {
        return examine_read(session, folder).await.map(|m| (m, true, true));
    }
    if !capabilities.has_str("CONDSTORE") {
        return examine_basic(session, folder).await;
    }
    // async-imap exposes SELECT CONDSTORE, but reading must remain EXAMINE.
    let tag = session
        .run_command(format!(
            "EXAMINE {} (CONDSTORE)",
            quoted(&encode_folder(folder)?)?
        ))
        .await
        .map_err(imap_error)?;
    let mut mailbox = async_imap::types::Mailbox::default();
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(network_error)?;
        match response.parsed() {
            Response::MailboxData(MailboxDatum::Exists(count)) => mailbox.exists = *count,
            Response::Data {
                status: Status::Ok,
                code: Some(code),
                ..
            } => match code {
                ResponseCode::UidValidity(v) => mailbox.uid_validity = Some(*v),
                ResponseCode::UidNext(v) => mailbox.uid_next = Some(*v),
                ResponseCode::HighestModSeq(v) => mailbox.highest_modseq = Some(*v),
                _ => {}
            },
            Response::Done {
                tag: done, status, ..
            } => {
                if *done != tag {
                    return Err(providers::remote_error());
                }
                if *status == Status::Ok {
                    return Ok((mailbox, false, true));
                }
                if matches!(status, Status::No | Status::Bad) {
                    return examine_basic(session, folder).await;
                }
                return Err(providers::remote_error());
            }
            Response::Data {
                status: Status::Bye,
                ..
            } => return Err(network_error()),
            _ => {}
        }
    }
}
async fn examine_basic(
    session: &mut Mailbox,
    folder: &str,
) -> Result<(async_imap::types::Mailbox, bool, bool)> {
    let mut mailbox = examine_read(session, folder).await?;
    // An unsolicited HIGHESTMODSEQ is not proof that CONDSTORE was enabled.
    mailbox.highest_modseq = None;
    Ok((mailbox, false, false))
}
async fn examine_read(session: &mut Mailbox, folder: &str) -> Result<async_imap::types::Mailbox> {
    session
        .examine(encode_folder(folder)?)
        .await
        .map_err(|error| {
            let rejected = matches!(&error, async_imap::error::Error::No(_));
            let mut error = imap_error(error);
            if rejected {
                error.body["code"] = "provider_imap_mailbox_rejected".into();
            }
            error
        })
}
async fn enable_qresync(session: &mut Mailbox) -> Result<bool> {
    use imap_proto::types::{Response, Status};
    let tag = session
        .run_command("ENABLE QRESYNC")
        .await
        .map_err(imap_error)?;
    let mut enabled = false;
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(network_error)?;
        match response.parsed() {
            Response::Capabilities(caps) => {
                if response.borrow_owner().starts_with(b"* ENABLED ") {
                    enabled=caps.iter().any(|cap|matches!(cap,imap_proto::types::Capability::Atom(v) if v.eq_ignore_ascii_case("QRESYNC")));
                }
            }
            Response::Done {
                tag: done, status, ..
            } => {
                if *done != tag {
                    return Err(providers::remote_error());
                }
                if matches!(status, Status::No | Status::Bad) {
                    return Ok(false);
                }
                if *status != Status::Ok {
                    return Err(providers::remote_error());
                }
                return Ok(enabled);
            }
            Response::Data {
                status: Status::Bye,
                ..
            } => return Err(network_error()),
            _ => {}
        }
    }
}

pub(crate) const CHANGE_QUEUE_LIMIT: usize = 1000;
/// Discover metadata changes without downloading bodies or an unbounded UID set.
/// The caller persists this state together with the applied message updates.
pub async fn discover_changes_with_tls(
    mail: &Value,
    folder: &str,
    checkpoint: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    valid_folder(folder)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail, connector).await?;
        let state = discover_changes_session(&mut session, mail, folder, checkpoint).await?;
        let _ = session.logout().await;
        Ok(state)
    })
    .await
    .map_err(|_| network_error())?
}
async fn discover_changes_session(
    session: &mut Mailbox,
    mail: &Value,
    folder: &str,
    checkpoint: &Value,
) -> Result<Value> {
    let (mailbox, _, enabled) = sync_examine(session, folder).await?;
    let validity = mailbox
        .uid_validity
        .filter(|v| *v > 0)
        .ok_or_else(providers::remote_error)?;
    let highest = mailbox.highest_modseq.filter(|v| *v > 0);
    let connection = crate::folders::connection_version(mail);
    let mut state =
        json!({"connection":connection,"validity":validity,"modseq":0,"pending":[],"scan":null});
    let same = checkpoint["connection"] == connection
        && checkpoint["validity"] == validity
        && checkpoint["modseq"].as_u64().is_some()
        && checkpoint["pending"].as_array().is_some_and(|uids| {
            let mut seen = std::collections::HashSet::new();
            uids.len() <= CHANGE_QUEUE_LIMIT
                && uids.iter().all(|uid| {
                    uid.as_u64()
                        .is_some_and(|uid| uid > 0 && uid <= u32::MAX as u64 && seen.insert(uid))
                })
        });
    if same && let Some(highest) = highest {
        let scan = &checkpoint["scan"];
        let scan_valid = (scan.is_null() && checkpoint["pending"].as_array().unwrap().is_empty())
            || (scan["since"] == checkpoint["modseq"]
                && scan["target"]
                    .as_u64()
                    .is_some_and(|v| v <= highest && v > checkpoint["modseq"].as_u64().unwrap())
                && scan["upper"].as_u64().is_some_and(|v| v <= u32::MAX as u64)
                && scan["after"]
                    .as_u64()
                    .is_some_and(|v| v <= scan["upper"].as_u64().unwrap_or(0)));
        if checkpoint["modseq"].as_u64().unwrap() <= highest && scan_valid {
            state = checkpoint.clone();
        }
    }
    let invalidated = checkpoint.is_object()
        && (checkpoint["connection"] != connection
            || checkpoint["validity"] != validity
            || highest.is_some_and(|highest| {
                checkpoint["modseq"]
                    .as_u64()
                    .is_some_and(|old| old > highest)
            }));
    state["enabled"] = enabled.into();
    state["flagEpoch"] = if invalidated
        || highest.is_none() && (!checkpoint.is_object() || !checkpoint["modseq"].is_null())
    {
        uuid::Uuid::new_v4().to_string().into()
    } else {
        checkpoint["flagEpoch"].clone()
    };
    if highest.is_none() {
        state["modseq"] = Value::Null;
    } else if state["scan"].is_null() && highest != state["modseq"].as_u64() {
        let upper = if mailbox.exists == 0 {
            0
        } else if let Some(next) = mailbox.uid_next.filter(|v| *v > 0) {
            if next == 1 {
                return Err(incomplete_read());
            }
            next - 1
        } else {
            let rows = checked_fetch(session, "*", "UID").await?;
            if rows.len() != 1 {
                return Err(incomplete_read());
            }
            rows[0].uid.filter(|v| *v > 0).ok_or_else(incomplete_read)?
        };
        state["scan"] = json!({"since":state["modseq"],"target":highest,"upper":upper,"after":0});
    }
    // Numeric windows cap even a server that ignores CHANGEDSINCE at 1000
    // rows. At most 32 windows and 128 KiB per response, then yield durably.
    if state["scan"].is_object() && state["pending"].as_array().unwrap().is_empty() {
        let since = state["scan"]["since"].as_u64().unwrap();
        let upper = state["scan"]["upper"].as_u64().unwrap() as u32;
        let mut after = state["scan"]["after"].as_u64().unwrap() as u32;
        let mut pending = Vec::new();
        for _ in 0..32 {
            if after >= upper || !pending.is_empty() {
                break;
            }
            let lower = after + 1;
            let end = lower
                .saturating_add(CHANGE_QUEUE_LIMIT as u32 - 1)
                .min(upper);
            session.get_mut().set_limit(128 * 1024);
            let delta = checked_delta_bounded(
                session,
                format!("{lower}:{end}"),
                format!("(UID MODSEQ) (CHANGEDSINCE {since})"),
                CHANGE_QUEUE_LIMIT,
            )
            .await;
            session.get_mut().set_limit(COMMAND_LIMIT);
            let (rows, _vanished, earlier_vanished) = match delta {
                Ok(delta) => delta,
                Err(error) if error.body["code"] == "provider_imap_command_rejected" => {
                    state["modseq"] = Value::Null;
                    state["scan"] = Value::Null;
                    state["pending"] = json!([]);
                    if !checkpoint.is_object() || !checkpoint["modseq"].is_null() {
                        state["flagEpoch"] = uuid::Uuid::new_v4().to_string().into();
                    }
                    return Ok(state);
                }
                Err(error) => return Err(error),
            };
            // This fetch does not request VANISHED. EARLIER is not a legal
            // unsolicited form. A concurrent expunge without EARLIER still
            // belongs to a round that ends tagged OK.
            if earlier_vanished {
                return Err(incomplete_read());
            }
            let mut seen = std::collections::BTreeSet::new();
            for row in rows {
                let uid = row
                    .uid
                    .filter(|v| *v >= lower && *v <= end)
                    .ok_or_else(incomplete_read)?;
                if !seen.insert(uid) {
                    return Err(incomplete_read());
                }
                if !row.modseq.is_some_and(|v| v > since) {
                    // A server ignoring MODSEQ/CHANGEDSINCE has not supplied
                    // incremental proof. Discard it and let flags rotate normally.
                    state["modseq"] = Value::Null;
                    state["scan"] = Value::Null;
                    state["pending"] = json!([]);
                    if !checkpoint.is_object() || !checkpoint["modseq"].is_null() {
                        state["flagEpoch"] = uuid::Uuid::new_v4().to_string().into();
                    }
                    return Ok(state);
                }
            }
            pending.extend(seen);
            after = end;
        }
        state["scan"]["after"] = after.into();
        state["pending"] = json!(pending);
    }
    Ok(state)
}
async fn reconcile_session(
    session: &mut Mailbox,
    mail: &Value,
    messages: &[Value],
) -> Result<Vec<Value>> {
    for message in messages {
        crate::imap_identity::require(mail, message)?;
    }
    let _phase = crate::sync_profile::phase("imapReconcile");
    let mut result = Vec::new();
    let mut folders = std::collections::BTreeMap::<String, Vec<&Value>>::new();
    for message in messages {
        folders
            .entry(
                message["providerFolderId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("INBOX")
                    .to_owned(),
            )
            .or_default()
            .push(message);
    }
    for (folder, messages) in folders {
        let (mailbox, qresync, _) =
            match sync_examine(session, &folder).await {
                Ok(mailbox) => mailbox,
                Err(error) if error.body["code"] == "provider_imap_mailbox_rejected" => {
                    let names = list_names(session).await?;
                    if names.iter().any(|name| {
                        name.path == folder
                            || name.path.eq_ignore_ascii_case("INBOX")
                                && folder.eq_ignore_ascii_case("INBOX")
                    }) {
                        return Err(error);
                    }
                    result.extend(messages.into_iter().map(|message| {
                        merge(message.clone(), &json!({"providerFolderMissing":true}))
                    }));
                    continue;
                }
                Err(error) => return Err(error),
            };
        let validity = mailbox
            .uid_validity
            .filter(|v| *v > 0)
            .ok_or_else(providers::remote_error)?;
        let mut selected = std::collections::HashMap::new();
        for message in messages {
            let remote = message["remoteId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(string(message, "id"));
            let parts: Vec<_> = remote.split(':').collect();
            if parts.len() != 3 || parts[0] != "imap" {
                return Err(providers::remote_error());
            }
            let original = parts[1]
                .parse::<u32>()
                .map_err(|_| providers::remote_error())?;
            let uid = parts[2]
                .parse::<u32>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or_else(providers::remote_error)?;
            if validity != original {
                result.push(merge(
                    message.clone(),
                    &json!({"providerFolderMissing":true}),
                ));
            } else if selected.insert(uid, message).is_some() {
                return Err(providers::remote_error());
            }
        }
        if selected.is_empty() {
            continue;
        }
        let sequence = selected
            .keys()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let highest = mailbox.highest_modseq.filter(|v| *v > 0);
        let minimum = selected
            .values()
            .map(|m| {
                if m["imapSyncConnection"] == crate::folders::connection_version(mail)
                    && m["providerSnapshot"]["read"].is_boolean()
                    && m["providerSnapshot"]["starred"].is_boolean()
                {
                    m["imapModseq"].as_u64().unwrap_or(0)
                } else {
                    0
                }
            })
            .min()
            .unwrap_or(0);
        let mut incremental = false;
        let mut present = std::collections::HashSet::new();
        let mut vanished = Vec::new();
        let rows =
            if let Some(highest) = highest.filter(|highest| minimum > 0 && minimum <= *highest) {
                let delta = if qresync {
                    checked_delta(
                        session,
                        &sequence,
                        format!("(UID FLAGS MODSEQ) (CHANGEDSINCE {minimum} VANISHED)"),
                    )
                    .await
                } else {
                    for row in checked_fetch(session, &sequence, "UID").await? {
                        let uid = row.uid.ok_or_else(providers::remote_error)?;
                        if !selected.contains_key(&uid) || !present.insert(uid) {
                            return Err(providers::remote_error());
                        }
                    }
                    if highest == minimum {
                        Ok((vec![], vec![]))
                    } else {
                        checked_delta(
                            session,
                            &sequence,
                            format!("(UID FLAGS MODSEQ) (CHANGEDSINCE {minimum})"),
                        )
                        .await
                    }
                };
                match delta {
                    Ok((rows, removed)) => {
                        incremental = true;
                        vanished = removed;
                        rows
                    }
                    Err(error) if error.body["code"] == "provider_imap_command_rejected" => {
                        checked_fetch(session, &sequence, "(UID FLAGS)").await?
                    }
                    Err(error) => return Err(error),
                }
            } else {
                match checked_fetch(
                    session,
                    &sequence,
                    if highest.is_some() {
                        "(UID FLAGS MODSEQ)"
                    } else {
                        "(UID FLAGS)"
                    },
                )
                .await
                {
                    Err(error)
                        if highest.is_some()
                            && error.body["code"] == "provider_imap_command_rejected" =>
                    {
                        checked_fetch(session, &sequence, "(UID FLAGS)").await?
                    }
                    result => result?,
                }
            };
        let mut removed = std::collections::HashSet::new();
        for range in vanished {
            // Intersect compact VANISHED sets without expanding arbitrary ranges.
            for uid in selected.keys().filter(|uid| range.contains(uid)) {
                removed.insert(*uid);
            }
        }
        for row in rows {
            let uid = row.uid.ok_or_else(providers::remote_error)?;
            if incremental && row.modseq.is_none() {
                return Err(incomplete_read());
            }
            let message = selected.remove(&uid).ok_or_else(providers::remote_error)?;
            if removed.contains(&uid) {
                return Err(providers::remote_error());
            }
            let mut value = merge(
                message.clone(),
                &json!({"read":row.read,"starred":row.starred,"providerFolderMissing":false,"providerDeleted":false}),
            );
            if let Some(highest) = highest.filter(|_| row.modseq.is_some_and(|v| v > 0)) {
                value["imapModseq"] = highest.into();
                value["imapSyncConnection"] = crate::folders::connection_version(mail);
            } else {
                value["imapModseq"] = Value::Null;
                value["imapSyncConnection"] = Value::Null;
            }
            result.push(value);
        }
        for (uid, message) in &selected {
            if incremental && !removed.contains(uid) && (qresync || present.contains(uid)) {
                let mut value = merge(
                    (*message).clone(),
                    &json!({"providerDeleted":false,"providerFolderMissing":false,"imapModseq":highest,"imapSyncConnection":crate::folders::connection_version(mail)}),
                );
                // CHANGEDSINCE omissions are unchanged, never deleted.
                // Only the saved provider snapshot is remote state. Local stars
                // can intentionally differ; old rows without snapshots reread flags.
                value["read"] = message["providerSnapshot"]["read"].clone();
                value["starred"] = message["providerSnapshot"]["starred"].clone();
                value["id"] = message["id"].clone();
                result.push(value);
            } else {
                result.push(merge(
                    (*message).clone(),
                    &json!({"providerDeleted":true,"providerFolderMissing":true}),
                ));
            }
        }
    }
    Ok(result)
}
pub async fn raw_message(mail: &Value, message: &Value) -> Result<Vec<u8>> {
    raw_message_with_tls(mail, message, &connector()?).await
}
pub async fn raw_message_with_tls(
    mail: &Value,
    message: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Vec<u8>> {
    crate::imap_identity::require(mail, message)?;
    tokio::time::timeout(Duration::from_secs(120), async {
        let remote = message["remoteId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(string(message, "id"));
        let parts: Vec<_> = remote.split(':').collect();
        if parts.len() != 3 || parts[0] != "imap" {
            return Err(Error::invalid("Invalid IMAP message identity."));
        }
        let validity = parts[1]
            .parse::<u32>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::invalid("Invalid IMAP UIDVALIDITY."))?;
        let uid = parts[2]
            .parse::<u32>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::invalid("Invalid IMAP UID."))?;
        let path = message["providerFolderId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("INBOX");
        let mut session = connect(mail, connector).await?;
        let mailbox = session
            .examine(encode_folder(path)?)
            .await
            .map_err(imap_error)?;
        if mailbox.uid_validity != Some(validity) {
            return Err(Error::conflict(
                "The IMAP folder changed. Sync before downloading attachments.",
            ));
        }
        let size = {
            let rows = checked_fetch(&mut session, uid, "(UID RFC822.SIZE)").await?;
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
            rows[0].size.ok_or_else(providers::remote_error)? as usize
        };
        if size > crate::attachments::MAX_RAW_BYTES {
            return Err(Error::new(
                413,
                "This message exceeds the 80 MiB download limit.",
            ));
        }
        let mut bytes = Vec::with_capacity(size);
        while bytes.len() < size {
            let count = (size - bytes.len()).min(1024 * 1024);
            let query = format!("(UID BODY.PEEK[]<{}.{}>)", bytes.len(), count);
            let rows = checked_fetch(&mut session, uid, query).await?;
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
            let body = rows[0]
                .body
                .as_deref()
                .ok_or_else(providers::remote_error)?;
            if body.len() != count {
                return Err(providers::remote_error());
            }
            bytes.extend_from_slice(body);
        }
        let _ = session.logout().await;
        Ok(bytes)
    })
    .await
    .map_err(|_| providers::remote_error())?
}
pub async fn fetch_page_with_tls(
    mail: &Value,
    options: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    tokio::time::timeout(
        Duration::from_secs(120),
        fetch_inner(mail, options, connector, None),
    )
    .await
    .map_err(|_| network_error())?
}
pub async fn fetch_page_cached_with_tls(
    app: &crate::service::App,
    mail: &Value,
    options: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    tokio::time::timeout(
        Duration::from_secs(120),
        fetch_inner(mail, options, connector, Some(app)),
    )
    .await
    .map_err(|_| network_error())?
}
async fn fetch_inner(
    mail: &Value,
    options: &Value,
    connector: &native_tls::TlsConnector,
    cache: Option<&crate::service::App>,
) -> Result<Value> {
    if options["folder"] != "all" {
        return fetch_folder(mail, options, connector, None, cache).await;
    }
    let mut traversal = options["cursor"].clone();
    if traversal.is_null() {
        let mut session = connect(mail, connector).await?;
        let names = list_names(&mut session).await?;
        let _ = session.logout().await;
        let mut seen = std::collections::HashSet::new();
        let folders = names
            .iter()
            .filter(|v| {
                v.selectable
                    && !["spam", "trash", "virtual"].contains(&v.kind)
                    && !names.iter().any(|excluded| {
                        ["spam", "trash", "virtual"].contains(&excluded.kind)
                            && (v.path == excluded.path
                                || excluded.delimiter.as_ref().is_some_and(|delimiter| {
                                    !delimiter.is_empty()
                                        && v.path
                                            .starts_with(&format!("{}{delimiter}", excluded.path))
                                }))
                    })
                    && seen.insert(if v.path.eq_ignore_ascii_case("INBOX") {
                        "INBOX".to_owned()
                    } else {
                        v.path.clone()
                    })
            })
            .map(|v| json!({"path":if v.kind=="inbox"{"INBOX"}else{&v.path},"kind":v.kind}))
            .collect::<Vec<_>>();
        if folders.is_empty() {
            return Ok(json!({"messages":[],"nextCursor":null}));
        }
        traversal = json!({"version":1,"folders":folders,"index":0,"next":null});
    }
    let folders = traversal["folders"]
        .as_array()
        .ok_or_else(|| Error::invalid("Invalid IMAP cursor."))?;
    let mut seen = std::collections::HashSet::new();
    if traversal["version"] != 1
        || folders.is_empty()
        || folders.len() > 300
        || !traversal["index"]
            .as_u64()
            .is_some_and(|index| index < folders.len() as u64)
        || folders.iter().any(|v| {
            string(v, "path").is_empty()
                || string(v, "path").len() > 4096
                || string(v, "path").chars().any(char::is_control)
                || !seen.insert(string(v, "path"))
                || !["inbox", "sent", "drafts", "archive"].contains(&string(v, "kind"))
        })
    {
        return Err(Error::invalid("Invalid IMAP cursor."));
    }
    let index = traversal["index"].as_u64().unwrap() as usize;
    let current = &folders[index];
    let page_options = merge(
        options.clone(),
        &json!({"folder":current["kind"],"cursor":traversal["next"]}),
    );
    let mut page = fetch_folder(
        mail,
        &page_options,
        connector,
        Some(string(current, "path")),
        cache,
    )
    .await?;
    let index = index + usize::from(page["nextCursor"].is_null());
    if index < folders.len() {
        traversal["index"] = index.into();
        traversal["next"] = page["nextCursor"].clone();
        page["nextCursor"] = traversal;
    }
    Ok(page)
}
async fn fetch_folder(
    mail: &Value,
    options: &Value,
    connector: &native_tls::TlsConnector,
    selected_path: Option<&str>,
    cache: Option<&crate::service::App>,
) -> Result<Value> {
    let folder = options["folder"].as_str().unwrap_or("inbox");
    if selected_path.is_none() && !["inbox", "sent"].contains(&folder) {
        return Err(Error::invalid("Unsupported import folder."));
    }
    let mut session = connect(mail, connector).await?;
    let path = if let Some(path) = selected_path {
        path.to_owned()
    } else if folder == "inbox" {
        "INBOX".to_owned()
    } else {
        names(&mut session).await?.into_iter().find(|(_,sent)|*sent).map(|(path,_)|path).ok_or_else(||Error::new(409,"This IMAP server does not identify a Sent folder. Import Inbox only or configure Sent on your provider."))?
    };
    if options["selectedCustomFolder"] == true {
        require_selectable_custom(&mut session, &path).await?;
    }
    let mailbox = examine_read(&mut session, &path).await?;
    let validity = mailbox
        .uid_validity
        .filter(|value| *value > 0)
        .ok_or_else(providers::remote_error)?
        .to_string();
    if options["expectedValidity"].is_string() && options["expectedValidity"] != validity {
        let mut error = Error::conflict("The selected IMAP folder changed UIDVALIDITY.");
        error.body["code"] = "folder_changed".into();
        return Err(error);
    }
    let cursor = &options["cursor"];
    let cursor_uid = if !cursor.is_null() {
        if cursor["path"] != path || cursor["validity"] != validity {
            return Err(Error::conflict(
                "The IMAP folder changed. Start the import again.",
            ));
        }
        Some(
            cursor["uid"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
                .ok_or_else(|| Error::invalid("Invalid IMAP cursor."))?,
        )
    } else {
        None
    };
    if mailbox.exists == 0 || cursor_uid == Some(1) {
        let previous = options["syncCheckpoints"][&path]["uid"]
            .as_u64()
            .and_then(|uid| u32::try_from(uid).ok())
            .unwrap_or(0);
        let mut upper = mailbox.uid_next.unwrap_or(1).saturating_sub(1);
        if options["selectedCustomFolder"] == true {
            if mailbox.uid_next.is_some() && upper < previous {
                return Err(incomplete_read());
            }
            upper = upper.max(previous);
        }
        let _ = session.logout().await;
        let mut page = json!({"messages":[],"nextCursor":null});
        if options["incremental"] == true {
            page["syncCheckpoint"] = json!({"path":path,"validity":validity,"uid":upper,"connection":crate::folders::connection_version(mail),"more":false});
            page["expectedSyncCheckpoint"] = options["syncCheckpoints"][&path].clone();
        }
        return Ok(page);
    }
    let parse_bound = |key| {
        let value = string(options, key);
        if value.is_empty() {
            Ok(None)
        } else {
            DateTime::parse_from_rfc3339(value)
                .map(|date| Some(date.with_timezone(&Utc)))
                .map_err(|_| Error::invalid("Invalid import date."))
        }
    };
    let (since, before) = (parse_bound("since")?, parse_bound("before")?);
    let mut query = Vec::new();
    for (bound, operator, days) in [(since, "SINCE", -1), (before, "BEFORE", 1)] {
        if let Some(date) = bound {
            // IMAP searches calendar days without considering time or timezone.
            // Widen both bounds, then filter the returned INTERNALDATE instants.
            let date = date
                .checked_add_signed(chrono::Duration::days(days))
                .ok_or_else(|| Error::invalid("Invalid import date."))?;
            query.push(format!("{operator} {}", date.format("%d-%b-%Y")));
        }
    }
    let mut upper = if let Some(uid) = cursor_uid {
        uid - 1
    } else if let Some(next) = mailbox.uid_next.filter(|uid| *uid > 1) {
        next - 1
    } else {
        // UIDNEXT may be absent; UID * fetches the highest existing UID, not EXISTS.
        let rows = checked_fetch(&mut session, "*", "UID").await?;
        if rows.len() != 1 {
            return Err(providers::remote_error());
        }
        rows[0]
            .uid
            .filter(|uid| *uid > 0)
            .ok_or_else(providers::remote_error)?
    };
    let observed_upper = upper;
    let checkpoint = &options["syncCheckpoints"][&path];
    let incremental = options["incremental"] == true;
    let previous_uid = if incremental
        && checkpoint["connection"] == crate::folders::connection_version(mail)
        && checkpoint["validity"] == validity
    {
        checkpoint["uid"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
    } else {
        None
    };
    if options["selectedCustomFolder"] == true
        && mailbox.uid_next.is_some()
        && previous_uid.is_some_and(|previous| previous > observed_upper)
    {
        return Err(incomplete_read());
    }
    let mut ids = Vec::new();
    // ponytail: fixed UID windows bound SEARCH to 8192 IDs / 128 KiB per command.
    // Scan at most 32 windows per page; persist an advancing cursor across sparse gaps.
    let mut progressed = previous_uid.unwrap_or(observed_upper);
    if let Some(previous) = previous_uid {
        // Ascending windows preserve every newly assigned UID, even when more
        // than one 50-message page arrives between polls. Do not use UID n:*:
        // IMAP ranges reverse when n exceeds the highest UID.
        let mut lower = previous.saturating_add(1);
        for _ in 0..32 {
            if previous == u32::MAX || lower > observed_upper || ids.len() > 50 {
                break;
            }
            let end = lower.saturating_add(8191).min(observed_upper);
            let mut terms = query.clone();
            terms.push(format!("UID {lower}:{end}"));
            session.get_mut().set_limit(128 * 1024);
            let found = session
                .uid_search(terms.join(" "))
                .await
                .map_err(imap_error)?;
            session.get_mut().set_limit(COMMAND_LIMIT);
            if found.len() > 8192 || found.iter().any(|uid| *uid < lower || *uid > end) {
                return Err(providers::remote_error());
            }
            ids.extend(found);
            ids.sort_unstable();
            ids.truncate(51);
            progressed = end;
            if end == u32::MAX {
                break;
            }
            lower = end + 1;
        }
        if ids.len() > 50 {
            progressed = ids[49];
        }
        upper = if progressed < observed_upper {
            observed_upper
        } else {
            0
        };
    } else {
        for _ in 0..32 {
            if upper == 0 || ids.len() > 50 {
                break;
            }
            let lower = upper.saturating_sub(8191).max(1);
            let mut terms = query.clone();
            terms.push(format!("UID {lower}:{upper}"));
            session.get_mut().set_limit(128 * 1024);
            let found = session
                .uid_search(terms.join(" "))
                .await
                .map_err(imap_error)?;
            session.get_mut().set_limit(COMMAND_LIMIT);
            if found.len() > 8192 || found.iter().any(|uid| *uid < lower || *uid > upper) {
                return Err(providers::remote_error());
            }
            ids.extend(found);
            ids.sort_unstable_by(|a, b| b.cmp(a));
            ids.truncate(51);
            upper = lower - 1;
        }
    }
    let next_uid = if previous_uid.is_some() {
        None
    } else if ids.len() > 50 {
        ids.get(49).copied()
    } else if upper > 0 {
        Some(upper + 1)
    } else {
        None
    };
    let selected = &ids[..ids.len().min(50)];
    let mut metadata = Vec::new();
    if !selected.is_empty() {
        let sequence = selected
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        metadata = checked_fetch(
            &mut session,
            sequence,
            "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER]<0.65536>)",
        )
        .await?;
    }
    let mut seen = std::collections::HashSet::new();
    for row in &metadata {
        let uid = row.uid.ok_or_else(providers::remote_error)?;
        if !selected.contains(&uid) || !seen.insert(uid) {
            return Err(providers::remote_error());
        }
    }
    let missing = selected
        .iter()
        .copied()
        .filter(|uid| !seen.contains(uid))
        .collect::<Vec<_>>();
    confirm_expunged(&mut session, &missing).await?;
    let cached = if let Some(app) = cache {
        crate::mail::cached_page_bodies(
            app,
            mail,
            metadata
                .iter()
                .map(|row| format!("imap:{validity}:{}", row.uid.unwrap()))
                .collect(),
            Some(path.clone()),
        )
        .await?
    } else {
        std::collections::HashMap::new()
    };
    let mut messages = Vec::new();
    for row in metadata {
        let uid = row.uid.unwrap();
        let date = row.date.ok_or_else(incomplete_read)?;
        let size = row.size.ok_or_else(incomplete_read)?;
        if row
            .header
            .as_deref()
            .is_some_and(|header| header.len() > 65536)
        {
            return Err(providers::remote_error());
        }
        let large = size > 5 * 1024 * 1024;
        let remote = format!("imap:{validity}:{uid}");
        let previous = cached
            .get(&remote)
            .filter(|old| !large && !row.draft && folder != "drafts" && old["bodySize"] == size);
        let header = if previous.is_some() {
            if let Some(bytes) = row.header.as_deref().filter(|bytes| {
                bytes.len() < 65536 && (bytes.ends_with(b"\r\n\r\n") || bytes.ends_with(b"\n\n"))
            }) {
                parse_mime(bytes.to_vec()).await.ok()
            } else {
                None
            }
        } else {
            None
        };
        let reuse = previous.zip(header).filter(|(old, header)| {
            !string(old, "messageId").is_empty() && old["messageId"] == header["messageId"]
        });
        let mut value = if let Some((previous, mut value)) = reuse {
            crate::sync_profile::count("bodyCacheHits", 1);
            crate::mail::copy_cached_body(previous, &mut value);
            value
        } else if large {
            let mut bytes = row.header.as_deref().ok_or_else(incomplete_read)?.to_vec();
            bytes.extend_from_slice(b"\r\n\r\nThis message exceeds the 5 MB import limit. Open it in your original mailbox to read it.");
            let mut value = parse_mime(bytes).await?;
            value["body"]="This message exceeds the 5 MB import limit. Open it in your original mailbox to read it.".into();
            value["automated"] = true.into();
            value["hasAttachments"] = true.into();
            value
        } else {
            crate::sync_profile::count("bodyFetches", 1);
            let rows = checked_fetch(&mut session, uid, "(UID BODY.PEEK[]<0.5242881>)").await?;
            if rows.is_empty() {
                confirm_expunged(&mut session, &[uid]).await?;
                continue;
            }
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
            let Some(bytes) = rows[0].body.as_deref() else {
                confirm_expunged(&mut session, &[uid]).await?;
                continue;
            };
            if bytes.len() > 5 * 1024 * 1024 {
                return Err(providers::remote_error());
            }
            if bytes.len() != size as usize {
                return Err(incomplete_read());
            }
            parse_mime(bytes.to_vec()).await?
        };
        if !large {
            value["bodyConnection"] = crate::folders::connection_version(mail);
            value["bodySize"] = size.into();
        }
        let id = if path.eq_ignore_ascii_case("INBOX") {
            remote.clone()
        } else {
            format!(
                "imap-folder:{}:{validity}:{uid}",
                URL_SAFE_NO_PAD.encode(path.as_bytes())
            )
        };
        // Keep sender time as metadata; received/internal time must drive both
        // SEARCH and the history commit filter, including in Sent folders.
        if string(&value, "date") != "1970-01-01T00:00:00.000Z" {
            value["senderDate"] = value["date"].clone();
        }
        value["date"] = date.to_rfc3339_opts(SecondsFormat::Millis, true).into();
        value["contentIncomplete"] = large.into();
        value["contentErrorCode"] = if large {
            json!("imap_size_limit")
        } else {
            Value::Null
        };
        value = merge(
            value,
            &json!({"id":id,"remoteId":remote,"imapOrigin":server_origin(mail)?,"providerFolderId":path,"providerFolderName":path,"folder":folder,"read":row.read,"starred":row.starred}),
        );
        if selected_path.is_some() || row.draft {
            value["providerSent"] = (folder == "sent").into();
            value["providerDraft"] = (folder == "drafts" || row.draft).into();
            if value["providerDraft"] == true {
                value["folder"] = "drafts".into();
            }
        }
        value["preview"] = providers::preview(string(&value, "body")).into();
        if since.is_none_or(|since| date >= since) && before.is_none_or(|before| date < before) {
            messages.push(value);
        }
    }
    let _ = session.logout().await;
    let mut page = json!({"messages":messages,"nextCursor":if let Some(uid)=next_uid{json!({"path":path,"validity":validity,"uid":uid})}else{Value::Null}});
    if incremental {
        let incomplete = if previous_uid.is_some() {
            checkpoint["bootstrapIncomplete"] == true && options["historyComplete"] != true
        } else {
            page["nextCursor"].is_object()
                && page["messages"]
                    .as_array()
                    .is_some_and(|rows| rows.len() < 50)
        };
        page["syncCheckpoint"] = json!({"path":path,"validity":validity,"uid":progressed,"connection":crate::folders::connection_version(mail),"more":previous_uid.is_some() && upper>0,"bootstrapIncomplete":incomplete});
        page["expectedSyncCheckpoint"] = checkpoint.clone();
    }
    Ok(page)
}
fn single_uid(values: &[imap_proto::types::UidSetMember]) -> Option<u32> {
    match values {
        [imap_proto::types::UidSetMember::Uid(uid)] => Some(*uid),
        [imap_proto::types::UidSetMember::UidRange(range)] if range.start() == range.end() => {
            Some(*range.start())
        }
        _ => None,
    }
}
fn quoted(value: &str) -> Result<String> {
    if value.len() > 8192 || value.contains(['\r', '\n', '\0']) {
        return Err(Error::invalid("Invalid IMAP folder."));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
fn valid_folder(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(Error::invalid("Invalid IMAP folder."));
    }
    Ok(())
}
/// IMAP4rev1 wire names use modified UTF-7; persisted/UI identities use Unicode.
pub fn encode_folder(value: &str) -> Result<String> {
    valid_folder(value)?;
    let mut result = String::new();
    let mut shifted = Vec::new();
    let flush = |bytes: &mut Vec<u8>, result: &mut String| {
        if !bytes.is_empty() {
            result.push('&');
            result.push_str(&STANDARD_NO_PAD.encode(&*bytes).replace('/', ","));
            result.push('-');
            bytes.clear();
        }
    };
    for ch in value.chars() {
        if (' '..='~').contains(&ch) {
            flush(&mut shifted, &mut result);
            if ch == '&' {
                result.push_str("&-");
            } else {
                result.push(ch);
            }
        } else {
            let mut units = [0; 2];
            for unit in ch.encode_utf16(&mut units) {
                shifted.extend_from_slice(&unit.to_be_bytes());
            }
        }
    }
    flush(&mut shifted, &mut result);
    valid_folder(&result)?;
    Ok(result)
}
pub fn decode_folder(value: &str) -> Result<String> {
    valid_folder(value)?;
    if !value.is_ascii() {
        return Err(providers::remote_error());
    }
    let mut result = String::new();
    let mut remaining = value;
    while let Some((plain, shifted)) = remaining.split_once('&') {
        result.push_str(plain);
        let (encoded, rest) = shifted
            .split_once('-')
            .ok_or_else(providers::remote_error)?;
        if encoded.is_empty() {
            result.push('&');
        } else {
            if !encoded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b',')
            {
                return Err(providers::remote_error());
            }
            let bytes = STANDARD_NO_PAD
                .decode(encoded.replace(',', "/"))
                .map_err(|_| providers::remote_error())?;
            if bytes.len() % 2 != 0 {
                return Err(providers::remote_error());
            }
            let units: Vec<_> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
                .collect();
            let decoded = String::from_utf16(&units).map_err(|_| providers::remote_error())?;
            if decoded.chars().any(|ch| (' '..='~').contains(&ch)) {
                return Err(providers::remote_error());
            }
            result.push_str(&decoded);
        }
        remaining = rest;
    }
    result.push_str(remaining);
    valid_folder(&result)?;
    Ok(result)
}
pub async fn organize(
    mail: &Value,
    message: &Value,
    destination: &Value,
    mode: &str,
) -> Result<Value> {
    organize_with_tls(mail, message, destination, mode, &connector()?).await
}
pub async fn organize_with_tls(
    mail: &Value,
    message: &Value,
    destination: &Value,
    mode: &str,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    crate::imap_identity::require(mail, message)?;
    let target = encode_folder(string(destination, "id"))?;
    if !["move", "restoreTrash"].contains(&mode) {
        return Err(Error::invalid("IMAP supports folder moves."));
    }
    let remote = message["remoteId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(message, "id"));
    let parts: Vec<_> = remote.split(':').collect();
    if parts.len() != 3 || parts[0] != "imap" {
        return Err(Error::invalid("Only imported IMAP messages can be moved."));
    }
    let validity = parts[1]
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::invalid("Invalid mailbox UIDVALIDITY."))?;
    let uid = parts[2]
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::invalid("Invalid message UID."))?;
    let source = message["providerFolderId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or("INBOX");
    let source_wire = encode_folder(source)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut session = connect(mail, connector).await?;
        move_capabilities(&mut session).await?;
        let mailbox = session.select(source_wire).await.map_err(imap_error)?;
        if mailbox.uid_validity != Some(validity) {
            return Err(Error::conflict("This mailbox changed. Sync and reopen the message before moving it."));
        }
        {
            let rows = checked_fetch(&mut session,uid,"UID").await?;
            if rows.len()!=1 || rows[0].uid!=Some(uid) {
                return Err(Error::conflict("This message is no longer in its original folder."));
            }
        }
        let mut remote = remote.to_owned();
        if source != string(destination, "id") {
            let tag = session.run_command(format!("UID MOVE {uid} {}", quoted(&target)?)).await.map_err(imap_error)?;
            let mut mapping = None;
            loop {
                let response = session.read_response().await.map_err(imap_error)?.ok_or_else(providers::remote_error)?;
                use imap_proto::types::{Response, ResponseCode, Status};
                let code = match response.parsed() {
                    Response::Done { code, .. } | Response::Data { code, .. } => code.as_ref(),
                    _ => None,
                };
                if let Some(ResponseCode::CopyUid(validity, from, to)) = code {
                    if *validity == 0 || single_uid(from) != Some(uid) {
                        return Err(providers::remote_error());
                    }
                    let target_uid = single_uid(to).filter(|uid| *uid > 0).ok_or_else(providers::remote_error)?;
                    let candidate = (*validity, target_uid);
                    if mapping.is_some_and(|existing| existing != candidate) {
                        return Err(providers::remote_error());
                    }
                    mapping = Some(candidate);
                }
                if let Response::Done { tag: finished, status, .. } = response.parsed() {
                    if *finished != tag || *status != Status::Ok {
                        return Err(providers::remote_error());
                    }
                    break;
                }
            }
            let (validity, uid) = mapping.ok_or_else(|| Error::new(502, "The destination UID was not confirmed. Check your provider before retrying."))?;
            remote = format!("imap:{validity}:{uid}");
        }
        let _ = session.logout().await;
        Ok(json!({"remoteId":remote,"providerFolderId":destination["id"],"providerFolderName":destination["name"],"folder":if destination["kind"]=="inbox"{"inbox"}else if destination["kind"]=="trash"{"trash"}else{"archive"}}))
    }).await.map_err(|_| providers::remote_error())?
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    #[test]
    fn read_round_deadlines_and_consumed_leases_cannot_be_extended_or_reopened() {
        let mut round = ReadRound::new(&json!({}), None).unwrap();
        let now = tokio::time::Instant::now();
        let (_, phase_deadline) = round.take().unwrap();
        assert!(phase_deadline <= tokio::time::Instant::now() + Duration::from_secs(45));
        assert!(phase_deadline >= now + Duration::from_secs(44));
        assert!(round.deadline <= now + Duration::from_secs(90));
        assert!(
            round.take().is_err(),
            "A dropped/failed lease must not reconnect"
        );

        let mut round = ReadRound::new(&json!({}), None).unwrap();
        round.deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let deadline = round.deadline;
        assert_eq!(round.take().unwrap().1, deadline);
        let mut expired = ReadRound::new(&json!({}), None).unwrap();
        expired.deadline = tokio::time::Instant::now() - Duration::from_secs(1);
        assert!(expired.take().is_err());
        assert_eq!(
            expired.uses, 0,
            "Expired rounds fail before attempting a connection"
        );
    }

    #[test]
    fn transport_retry_classification_excludes_auth_protocol_and_response_limits() {
        assert_eq!(
            connect_error(io::Error::other("DNS unavailable")).body["code"],
            "provider_network"
        );
        assert_ne!(
            io_error(io::Error::other("Unknown read error")).body["code"],
            "provider_network"
        );
        assert_ne!(
            connect_error(io::Error::from(io::ErrorKind::InvalidInput)).body["code"],
            "provider_network"
        );
        for kind in [
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::TimedOut,
            io::ErrorKind::UnexpectedEof,
        ] {
            assert_eq!(
                imap_error(io::Error::from(kind)).body["code"],
                "provider_network"
            );
        }
        assert_eq!(
            imap_error(async_imap::error::Error::ConnectionLost).body["code"],
            "provider_network"
        );
        for error in [
            async_imap::error::Error::No("Authentication failed".into()),
            async_imap::error::Error::Bad("Malformed command".into()),
            async_imap::error::Error::Io(io::Error::from(io::ErrorKind::InvalidData)),
            async_imap::error::Error::Io(io::Error::other(ResponseLimit(COMMAND_LIMIT))),
        ] {
            assert_ne!(imap_error(error).body["code"], "provider_network");
        }
    }
}
