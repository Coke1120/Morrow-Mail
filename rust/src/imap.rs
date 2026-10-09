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
use futures_util::TryStreamExt;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
    },
};
use serde_json::{Value, json};
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
fn imap_error(error: impl Into<async_imap::error::Error>) -> Error {
    if let async_imap::error::Error::Io(error) = error.into()
        && let Some(limit) = error
            .get_ref()
            .and_then(|error| error.downcast_ref::<ResponseLimit>())
    {
        return Error::new(502, &limit.to_string());
    }
    providers::remote_error()
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
        if matches!(result, Poll::Ready(Ok(size)) if size > 0) {
            this.remaining = this.limit;
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
async fn connect(mail: &Value, connector: &native_tls::TlsConnector) -> Result<Mailbox> {
    let host = validation::hostname(&mail["imapHost"], "IMAP host")?;
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect((host.as_str(), port(mail, "imapPort", 993)?)),
    )
    .await
    .map_err(|_| providers::remote_error())?
    .map_err(|_| providers::remote_error())?;
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_native_tls::TlsConnector::from(connector.clone()).connect(&host, stream),
    )
    .await
    .map_err(|_| providers::remote_error())?
    .map_err(|_| providers::remote_error())?;
    let mut client = async_imap::Client::new(BoundedImap::new(stream));
    tokio::time::timeout(Duration::from_secs(30), async {
        client
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(providers::remote_error)?;
        client
            .login(validation::email(&mail["email"])?, string(mail, "password"))
            .await
            .map_err(|(error, _)| imap_error(error))
    })
    .await
    .map_err(|_| providers::remote_error())?
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
async fn list_names(session: &mut Mailbox) -> Result<Vec<ImportFolder>> {
    let mut stream = session.list(None, Some("*")).await.map_err(imap_error)?;
    let mut names = Vec::new();
    let mut count = 0;
    while let Some(name) = stream.try_next().await.map_err(imap_error)? {
        count += 1;
        if count > 300 {
            return Err(Error::new(
                502,
                "This mailbox exceeds the 300 folder limit.",
            ));
        }
        let path = decode_folder(name.name())?;
        let has = |expected: NameAttribute<'_>, text: &str| {
            name.attributes().iter().any(|attribute| *attribute == expected || matches!(attribute, NameAttribute::Extension(value) if value.eq_ignore_ascii_case(text)))
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
            delimiter: name.delimiter().map(str::to_owned),
            selectable: !name.attributes().contains(&NameAttribute::NoSelect),
            editable: kind == "archive" && !has(NameAttribute::Archive,"\\Archive") && !name.attributes().iter().any(|a| matches!(a, NameAttribute::Extension(v) if v.eq_ignore_ascii_case("\\Important"))),
        });
    }
    Ok(names)
}
async fn move_capabilities(session: &mut Mailbox) -> Result<()> {
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    if !capabilities.has_str("MOVE") || !capabilities.has_str("UIDPLUS") {
        return Err(Error::new(
            409,
            "Safe folder moves require MOVE and UIDPLUS support.",
        ));
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
}
// async-imap 0.11's FETCH stream discards tagged NO/BAD; validate completion before using rows.
async fn checked_fetch(
    session: &mut Mailbox,
    sequence: impl std::fmt::Display,
    query: impl std::fmt::Display,
) -> Result<Vec<Fetched>> {
    use imap_proto::types::{AttributeValue, MessageSection, Response, SectionPath, Status};
    let tag = session
        .run_command(format!("UID FETCH {sequence} {query}"))
        .await
        .map_err(imap_error)?;
    let mut rows = Vec::new();
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(providers::remote_error)?;
        match response.parsed() {
            Response::Done {
                tag: finished,
                status,
                ..
            } => {
                if *finished != tag || *status != Status::Ok {
                    return Err(providers::remote_error());
                }
                return Ok(rows);
            }
            Response::Fetch(_, attrs) => {
                if rows.len() >= 50 {
                    return Err(providers::remote_error());
                }
                let mut row = Fetched::default();
                let mut has_flags = false;
                for attr in attrs {
                    match attr {
                        AttributeValue::Uid(id) => row.uid = Some(*id),
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
            Response::Data {
                status: Status::Bye,
                ..
            } => return Err(providers::remote_error()),
            _ => {}
        }
    }
}
pub async fn fetch_page(mail: &Value, options: &Value) -> Result<Value> {
    fetch_page_with_tls(mail, options, &connector()?).await
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
pub async fn reconcile_with_tls(
    mail: &Value,
    messages: &[Value],
    connector: &native_tls::TlsConnector,
) -> Result<Vec<Value>> {
    if messages.len() > 50 {
        return Err(Error::invalid("Reconciliation batch exceeds 50 messages."));
    }
    tokio::time::timeout(Duration::from_secs(45),async {
        let mut session=connect(mail,connector).await?;
        let mut result=Vec::new();
        let mut folders=std::collections::BTreeMap::<String,Vec<&Value>>::new();
        for message in messages { folders.entry(message["providerFolderId"].as_str().filter(|s|!s.is_empty()).unwrap_or("INBOX").to_owned()).or_default().push(message); }
        for (folder, messages) in folders {
            let mailbox=session.examine(encode_folder(&folder)?).await.map_err(imap_error)?;
            let validity=mailbox.uid_validity.filter(|v|*v>0).ok_or_else(providers::remote_error)?;
            let mut selected=std::collections::HashMap::new();
            for message in messages {
                let remote=message["remoteId"].as_str().filter(|s|!s.is_empty()).unwrap_or(string(message,"id"));
                let parts:Vec<_>=remote.split(':').collect();
                if parts.len()!=3 || parts[0]!="imap" { return Err(providers::remote_error()); }
                let original=parts[1].parse::<u32>().map_err(|_|providers::remote_error())?;
                let uid=parts[2].parse::<u32>().ok().filter(|id|*id>0).ok_or_else(providers::remote_error)?;
                if validity!=original { result.push(merge(message.clone(),&json!({"providerFolderMissing":true}))); }
                else if selected.insert(uid,message).is_some() {return Err(providers::remote_error());}
            }
            if selected.is_empty() {continue;}
            let sequence=selected.keys().map(u32::to_string).collect::<Vec<_>>().join(",");
            for row in checked_fetch(&mut session,sequence,"(UID FLAGS)").await? {
                let uid=row.uid.ok_or_else(providers::remote_error)?;
                let message=selected.remove(&uid).ok_or_else(providers::remote_error)?;
                result.push(merge(message.clone(),&json!({"read":row.read,"starred":row.starred,"providerFolderMissing":false,"providerDeleted":false})));
            }
            for message in selected.values() {result.push(merge((*message).clone(),&json!({"providerDeleted":true,"providerFolderMissing":true})));}
        }
        let _=session.logout().await; Ok(result)
    }).await.map_err(|_|providers::remote_error())?
}
pub async fn raw_message(mail: &Value, message: &Value) -> Result<Vec<u8>> {
    raw_message_with_tls(mail, message, &connector()?).await
}
pub async fn raw_message_with_tls(
    mail: &Value,
    message: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Vec<u8>> {
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
        fetch_inner(mail, options, connector),
    )
    .await
    .map_err(|_| providers::remote_error())?
}
async fn fetch_inner(
    mail: &Value,
    options: &Value,
    connector: &native_tls::TlsConnector,
) -> Result<Value> {
    if options["folder"] != "all" {
        return fetch_folder(mail, options, connector, None).await;
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
    let mailbox = session
        .examine(encode_folder(&path)?)
        .await
        .map_err(imap_error)?;
    let validity = mailbox
        .uid_validity
        .filter(|value| *value > 0)
        .ok_or_else(providers::remote_error)?
        .to_string();
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
        let _ = session.logout().await;
        return Ok(json!({"messages":[],"nextCursor":null}));
    }
    let mut query = Vec::new();
    for (key, operator) in [("since", "SINCE"), ("before", "BEFORE")] {
        if !string(options, key).is_empty() {
            let date = DateTime::parse_from_rfc3339(string(options, key))
                .map_err(|_| Error::invalid("Invalid import date."))?;
            let date = if key == "before" {
                date + chrono::Duration::days(1)
            } else {
                date
            };
            query.push(format!(
                "{}{} {}",
                if folder == "sent" { "SENT" } else { "" },
                operator,
                date.format("%d-%b-%Y")
            ));
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
    let mut ids = Vec::new();
    // ponytail: fixed UID windows bound SEARCH to 8192 IDs / 128 KiB per command.
    // Scan at most 32 windows per page; persist an advancing cursor across sparse gaps.
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
    let next_uid = if ids.len() > 50 {
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
    let mut messages = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in metadata {
        let uid = row.uid.ok_or_else(providers::remote_error)?;
        if !selected.contains(&uid) || !seen.insert(uid) {
            return Err(providers::remote_error());
        }
        if row
            .header
            .as_deref()
            .is_some_and(|header| header.len() > 65536)
        {
            return Err(providers::remote_error());
        }
        let large = row.size.unwrap_or(u32::MAX) > 5 * 1024 * 1024;
        let mut value = if large {
            let mut bytes = row.header.as_deref().unwrap_or_default().to_vec();
            bytes.extend_from_slice(b"\r\n\r\nThis message exceeds the 5 MB import limit. Open it in your original mailbox to read it.");
            let mut value = parse_mime(bytes).await?;
            value["body"]="This message exceeds the 5 MB import limit. Open it in your original mailbox to read it.".into();
            value["automated"] = true.into();
            value["hasAttachments"] = true.into();
            value
        } else {
            let rows = checked_fetch(&mut session, uid, "(UID BODY.PEEK[]<0.5242881>)").await?;
            if rows.is_empty() {
                continue;
            }
            if rows.len() != 1 || rows[0].uid != Some(uid) {
                return Err(providers::remote_error());
            }
            let Some(bytes) = rows[0].body.as_deref() else {
                continue;
            };
            if bytes.len() > 5 * 1024 * 1024 {
                return Err(providers::remote_error());
            }
            parse_mime(bytes.to_vec()).await?
        };
        let remote = format!("imap:{validity}:{uid}");
        let id = if path.eq_ignore_ascii_case("INBOX") {
            remote.clone()
        } else {
            format!(
                "imap-folder:{}:{validity}:{uid}",
                URL_SAFE_NO_PAD.encode(path.as_bytes())
            )
        };
        if string(&value, "date").starts_with("1970-") {
            value["date"] = row
                .date
                .map(|date| date.with_timezone(&Utc))
                .unwrap_or_else(Utc::now)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
                .into();
        }
        value = merge(
            value,
            &json!({"id":id,"remoteId":remote,"providerFolderId":path,"providerFolderName":path,"folder":folder,"read":row.read,"starred":row.starred}),
        );
        if selected_path.is_some() {
            value["providerSent"] = (folder == "sent").into();
            value["providerDraft"] = (folder == "drafts" || row.draft).into();
            if value["providerDraft"] == true {
                value["folder"] = "drafts".into();
            }
        }
        value["preview"] = providers::preview(string(&value, "body")).into();
        if (string(options, "since").is_empty()
            || string(&value, "date") >= string(options, "since"))
            && (string(options, "before").is_empty()
                || string(&value, "date") < string(options, "before"))
        {
            messages.push(value);
        }
    }
    let _ = session.logout().await;
    Ok(
        json!({"messages":messages,"nextCursor":if let Some(uid)=next_uid{json!({"path":path,"validity":validity,"uid":uid})}else{Value::Null}}),
    )
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
