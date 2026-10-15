use super::*;
use imap_proto::types::{Response, ResponseCode, Status};

/// One reviewed operation owns this socket. Nothing here reconnects or retries.
/// The caller bounds the complete network/journal operation to 45 seconds.
pub(crate) struct MoveSession {
    session: Mailbox,
    pub(crate) native: bool,
    pub(crate) source: String,
    pub(crate) target: String,
    pub(crate) validity: u32,
    pub(crate) uid: u32,
    pub(crate) target_validity: Option<u32>,
}

#[derive(Clone, Copy)]
pub(crate) struct Presence {
    pub(crate) source: bool,
    pub(crate) source_deleted: bool,
    pub(crate) destination: bool,
}

fn unsupported() -> Error {
    let mut error = Error::new(
        409,
        "This server cannot safely move this message without UIDPLUS. No move was attempted.",
    );
    error.body["code"] = "imap_move_requires_uidplus".into();
    error
}

async fn stable_mailbox(session: &mut Mailbox, path: &str, writable: bool) -> Result<u32> {
    let command = if writable { "SELECT" } else { "EXAMINE" };
    let tag = session
        .run_command(format!("{command} {}", quoted(&encode_folder(path)?)?))
        .await
        .map_err(imap_error)?;
    session.get_mut().set_limit(128 * 1024);
    let mut validity = None;
    loop {
        let response = session
            .read_response()
            .await
            .map_err(imap_error)?
            .ok_or_else(providers::remote_error)?;
        let code = match response.parsed() {
            Response::Data {
                status: Status::Ok,
                code,
                ..
            }
            | Response::Done {
                status: Status::Ok,
                code,
                ..
            } => code.as_ref(),
            _ => None,
        };
        match code {
            Some(ResponseCode::UidValidity(value)) => {
                if *value == 0 || validity.is_some_and(|old| old != *value) {
                    return Err(providers::remote_error());
                }
                validity = Some(*value);
            }
            Some(ResponseCode::UidNotSticky) => return Err(unsupported()),
            Some(ResponseCode::ReadOnly) if writable => {
                return Err(Error::conflict(
                    "This folder is read-only. No further move step was attempted.",
                ));
            }
            _ => {}
        }
        match response.parsed() {
            Response::Done {
                tag: finished,
                status,
                ..
            } => {
                if *finished != tag || *status != Status::Ok {
                    return Err(providers::remote_error());
                }
                session.get_mut().set_limit(COMMAND_LIMIT);
                return validity.ok_or_else(providers::remote_error);
            }
            Response::Data {
                status: Status::Bye,
                ..
            }
            | Response::Continue { .. } => return Err(providers::remote_error()),
            _ => {}
        }
    }
}

async fn present(session: &mut Mailbox, uid: u32) -> Result<Option<bool>> {
    session.get_mut().set_limit(128 * 1024);
    let rows = checked_fetch(session, uid, "(UID FLAGS)").await?;
    session.get_mut().set_limit(COMMAND_LIMIT);
    match rows.as_slice() {
        [] => Ok(None),
        [row] if row.uid == Some(uid) => Ok(Some(row.deleted)),
        _ => Err(providers::remote_error()),
    }
}

impl MoveSession {
    pub(crate) async fn open(
        mail: &Value,
        message: &Value,
        destination: &Value,
        connector: &native_tls::TlsConnector,
    ) -> Result<Self> {
        Self::open_inner(mail, message, destination, connector, true).await
    }

    pub(crate) async fn recovery(
        mail: &Value,
        message: &Value,
        destination: &Value,
        connector: &native_tls::TlsConnector,
    ) -> Result<Self> {
        Self::open_inner(mail, message, destination, connector, false).await
    }

    async fn open_inner(
        mail: &Value,
        message: &Value,
        destination: &Value,
        connector: &native_tls::TlsConnector,
        starting: bool,
    ) -> Result<Self> {
        crate::imap_identity::require(mail, message)?;
        let remote = message["remoteId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or(string(message, "id"));
        let parts = remote.split(':').collect::<Vec<_>>();
        if parts.len() != 3 || parts[0] != "imap" {
            return Err(Error::invalid("Only imported IMAP messages can be moved."));
        }
        let parse_uid = |raw: &str| {
            raw.parse::<u32>()
                .ok()
                .filter(|uid| *uid > 0)
                .ok_or_else(|| Error::invalid("Invalid mailbox message identity."))
        };
        let validity = parse_uid(parts[1])?;
        let uid = parse_uid(parts[2])?;
        let source = message["providerFolderId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or("INBOX")
            .to_owned();
        let target = string(destination, "id").to_owned();
        valid_folder(&source)?;
        valid_folder(&target)?;
        let mut session = connect(mail, connector).await?;
        let caps = session.capabilities().await.map_err(imap_error)?;
        let has = |name: &str| {
            caps.iter().any(|capability| {
            matches!(capability, async_imap::types::Capability::Atom(value) if value.eq_ignore_ascii_case(name))
        })
        };
        if !has("UIDPLUS") {
            return Err(unsupported());
        }
        let native = has("MOVE");
        let target_validity = if !native && source != target {
            Some(stable_mailbox(&mut session, &target, false).await?)
        } else {
            None
        };
        if stable_mailbox(&mut session, &source, starting).await? != validity {
            return Err(Error::conflict(
                "This mailbox changed. Sync and reopen the message before moving it.",
            ));
        }
        if starting && present(&mut session, uid).await?.is_none() {
            return Err(Error::conflict(
                "This message is no longer in its original folder.",
            ));
        }
        Ok(Self {
            session,
            native,
            source,
            target,
            validity,
            uid,
            target_validity,
        })
    }

    async fn mapped_command(&mut self, verb: &str) -> Result<(u32, u32)> {
        let tag = self
            .session
            .run_command(format!(
                "UID {verb} {} {}",
                self.uid,
                quoted(&encode_folder(&self.target)?)?
            ))
            .await
            .map_err(imap_error)?;
        self.session.get_mut().set_limit(128 * 1024);
        let mut mapping = None;
        loop {
            let response = self
                .session
                .read_response()
                .await
                .map_err(imap_error)?
                .ok_or_else(providers::remote_error)?;
            let code = match response.parsed() {
                Response::Data {
                    status: Status::Ok,
                    code,
                    ..
                }
                | Response::Done {
                    status: Status::Ok,
                    code,
                    ..
                } => code.as_ref(),
                _ => None,
            };
            if let Some(ResponseCode::CopyUid(validity, from, to)) = code {
                let target = single_uid(to)
                    .filter(|uid| *uid > 0)
                    .ok_or_else(providers::remote_error)?;
                if *validity == 0
                    || single_uid(from) != Some(self.uid)
                    || self
                        .target_validity
                        .is_some_and(|expected| expected != *validity)
                    || mapping.is_some_and(|previous| previous != (*validity, target))
                {
                    return Err(providers::remote_error());
                }
                mapping = Some((*validity, target));
            }
            match response.parsed() {
                Response::Done {
                    tag: finished,
                    status,
                    ..
                } => {
                    if *finished != tag || *status != Status::Ok {
                        return Err(providers::remote_error());
                    }
                    self.session.get_mut().set_limit(COMMAND_LIMIT);
                    return mapping.ok_or_else(providers::remote_error);
                }
                Response::Data {
                    status: Status::Bye,
                    ..
                }
                | Response::Continue { .. } => return Err(providers::remote_error()),
                _ => {}
            }
        }
    }

    pub(crate) async fn native_move(&mut self) -> Result<(u32, u32)> {
        if !self.native {
            return Err(unsupported());
        }
        if self.source == self.target {
            return Ok((self.validity, self.uid));
        }
        self.mapped_command("MOVE").await
    }

    pub(crate) async fn prepare_copy(&mut self) -> Result<()> {
        if self.native || self.source == self.target || self.target_validity.is_none() {
            return Err(Error::conflict(
                "This operation is not a reviewed fallback move.",
            ));
        }
        // Never copy a message already marked for deletion by another client.
        if present(&mut self.session, self.uid).await? != Some(false) {
            return Err(Error::conflict("The source changed before copying."));
        }
        Ok(())
    }

    pub(crate) async fn copy(&mut self) -> Result<(u32, u32)> {
        self.mapped_command("COPY").await
    }

    pub(crate) async fn verify(&mut self, mapping: (u32, u32), writable: bool) -> Result<Presence> {
        if stable_mailbox(&mut self.session, &self.target, false).await? != mapping.0 {
            return Err(Error::conflict(
                "The destination folder changed. Review the move in your provider.",
            ));
        }
        let destination = present(&mut self.session, mapping.1)
            .await?
            .is_some_and(|deleted| !deleted);
        if stable_mailbox(&mut self.session, &self.source, writable).await? != self.validity {
            return Err(Error::conflict(
                "The source folder changed. Review the move in your provider.",
            ));
        }
        let source = present(&mut self.session, self.uid).await?;
        Ok(Presence {
            source: source.is_some(),
            source_deleted: source == Some(true),
            destination,
        })
    }

    pub(crate) async fn mark_deleted(&mut self) -> Result<()> {
        let tag = self
            .session
            .run_command(format!("UID STORE {} +FLAGS.SILENT (\\Deleted)", self.uid))
            .await
            .map_err(imap_error)?;
        self.checked_completion(tag).await?;
        if present(&mut self.session, self.uid).await? != Some(true) {
            return Err(providers::remote_error());
        }
        Ok(())
    }

    pub(crate) async fn expunge(&mut self) -> Result<()> {
        let tag = self
            .session
            .run_command(format!("UID EXPUNGE {}", self.uid))
            .await
            .map_err(imap_error)?;
        self.checked_completion(tag).await
    }

    async fn checked_completion(&mut self, tag: imap_proto::types::RequestId) -> Result<()> {
        self.session.get_mut().set_limit(128 * 1024);
        loop {
            let response = self
                .session
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
                    self.session.get_mut().set_limit(COMMAND_LIMIT);
                    return Ok(());
                }
                Response::Data {
                    status: Status::Bye,
                    ..
                }
                | Response::Continue { .. } => return Err(providers::remote_error()),
                _ => {}
            }
        }
    }
}
