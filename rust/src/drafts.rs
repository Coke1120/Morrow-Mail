use crate::{
    content,
    error::{Error, Result},
    service::{get_message, valid_account},
    store::{Store, string},
    validation,
};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};

fn trim(value: &str) -> &str {
    // Match the compatibility client's ECMAScript trim, including a leading BOM.
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn mailboxes(value: &str) -> Vec<String> {
    if value.contains(['\r', '\n', '\0']) {
        return vec![value.into()];
    }
    let value = trim(value);
    if value.is_empty() {
        return Vec::new();
    }
    // ponytail: support simple mailbox lists; preserve unsupported groups/comments
    // and malformed lists whole for correction until an RFC address editor is needed.
    let original = || vec![value.to_owned()];
    let mut tokens = Vec::new();
    let mut token = String::new();
    let (mut quoted, mut escaped, mut angle) = (false, false, false);
    for c in value.chars() {
        if escaped {
            escaped = false;
        } else if quoted && c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if !quoted {
            match c {
                '<' => {
                    if angle {
                        return original();
                    }
                    angle = true;
                }
                '>' => {
                    if !angle {
                        return original();
                    }
                    angle = false;
                }
                '(' | ')' | ':' if !angle => return original(),
                ',' | ';' if !angle => {
                    tokens.push(std::mem::take(&mut token));
                    continue;
                }
                _ => {}
            }
        }
        token.push(c);
    }
    if quoted || escaped || angle {
        return original();
    }
    tokens.push(token);
    let mut addresses = Vec::new();
    for token in tokens {
        let mut address = trim(&token);
        if let Some((name, tail)) = address.split_once('<') {
            let Some(inner) = tail.strip_suffix('>') else {
                return original();
            };
            if name.contains(['<', '>', '@']) || inner.contains(['<', '>']) {
                return original();
            }
            address = trim(inner);
        }
        if address.contains([',', ';']) {
            return original();
        }
        let Ok(parsed) = content::recipients(&json!({"to":address}), false) else {
            return original();
        };
        addresses.push(string(&parsed, "to").to_owned());
    }
    addresses
}

fn unique(message: &Value, fields: &[&str], seen: &mut HashSet<String>) -> String {
    fields
        .iter()
        .flat_map(|field| mailboxes(string(message, field)))
        .filter(|address| seen.insert(address.to_lowercase()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Build an unsaved draft from the current owned source, without provider/model work.
pub fn prepare(db: &Store, owner: &str, input: &Value) -> Result<Value> {
    if !valid_account(&db.settings()?, owner) {
        return Err(Error::conflict("This account was disconnected."));
    }
    if !input.as_object().is_some_and(|fields| {
        fields
            .keys()
            .all(|key| ["messageId", "mode", "body"].contains(&key.as_str()))
    }) {
        return Err(Error::invalid(
            "Use messageId, mode and optional reply body.",
        ));
    }
    let id = validation::text(&input["messageId"], "Message ID", 8192, false)?;
    let mode = string(input, "mode");
    if !["reply", "replyAll", "forward", "copy"].contains(&mode) {
        return Err(Error::invalid("Choose reply, replyAll, forward or copy."));
    }
    let body = match input.get("body") {
        Some(value) if ["reply", "replyAll"].contains(&mode) => {
            validation::text(value, "Message body", 100000, true)?
        }
        Some(_) => return Err(Error::invalid("A reply body is only allowed for replies.")),
        None => "",
    };
    let message = get_message(db, owner, id)?;
    if mode == "copy" {
        if message["providerDraft"] != true || message["folder"] != "drafts" {
            return Err(Error::conflict("Choose a provider draft to copy."));
        }
    } else if message["folder"] == "drafts" || message["providerDraft"] == true {
        return Err(Error::conflict(
            "Open or copy this draft instead of replying or forwarding.",
        ));
    }
    let subject = string(&message, "subject");
    let mut draft =
        json!({"accountId":owner,"to":"","cc":"","bcc":"","subject":subject,"body":body});
    match mode {
        "copy" => {
            draft["sourceDraft"] = true.into();
            for key in ["to", "cc", "bcc"] {
                draft[key] = mailboxes(string(&message, key)).join(", ").into();
            }
            draft["body"] = string(&message, "body").into();
        }
        "forward" => {
            draft["forwarding"] = true.into();
            if !subject.to_ascii_lowercase().starts_with("fw:")
                && !subject.to_ascii_lowercase().starts_with("fwd:")
            {
                draft["subject"] = format!("Fwd: {subject}").into();
            }
            let name = string(&message, "fromName");
            let email = string(&message, "fromEmail");
            let from = if name.is_empty() || name == email {
                email.into()
            } else if email.is_empty() {
                name.into()
            } else {
                format!("{name} <{email}>")
            };
            static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n]+").unwrap());
            let mut lines: Vec<_> = [
                ("From", from.as_str()),
                ("Date", string(&message, "date")),
                ("Subject", subject),
                ("To", string(&message, "to")),
                ("Cc", string(&message, "cc")),
            ]
            .into_iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(label, value)| format!("{label}: {}", NEWLINES.replace_all(value, " ")))
            .collect();
            lines.push(String::new());
            lines.push(string(&message, "body").to_owned());
            let quoted = lines
                .join("\n")
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .split('\n')
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n");
            draft["body"] = format!("\n\n---------- Forwarded message ----------\n{quoted}").into();
        }
        _ => {
            let sent = message["folder"] == "sent";
            if mode == "replyAll" {
                let address = if owner == "demo" {
                    "alex@genmail.example"
                } else {
                    owner
                };
                let mut seen = HashSet::from([address.to_lowercase()]);
                draft["to"] = unique(
                    &message,
                    if sent { &["to"] } else { &["fromEmail", "to"] },
                    &mut seen,
                )
                .into();
                draft["cc"] = unique(&message, &["cc"], &mut seen).into();
            } else {
                draft["to"] = mailboxes(string(&message, if sent { "to" } else { "fromEmail" }))
                    .join(", ")
                    .into();
            }
            if !subject.to_ascii_lowercase().starts_with("re:") {
                draft["subject"] = format!("Re: {subject}").into();
            }
            draft["replyToId"] = id.into();
        }
    }
    Ok(json!({"draft":draft}))
}
