//! Account-owned decision projections. Reading this module never calls a model or writes mail.
use crate::{
    error::{Error, Result},
    policy,
    store::{Store, string},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::LazyLock};

pub const GUIDE: &str = "Also include review in each item: {\"title\":\"short event or decision title\",\"action\":\"decision/request explicitly supported by evidence, or empty\",\"state\":\"waiting_on_user|waiting_on_others|completed|uncertain|informational\",\"replyNeeded\":\"yes|no|uncertain\",\"evidence\":[{\"messageId\":\"supplied ID\",\"field\":\"body|subject\",\"quote\":\"exact original excerpt\"}],\"deadline\":null or {\"messageId\":\"supplied ID\",\"field\":\"body\",\"quote\":\"exact explicit deadline excerpt\"},\"questions\":[\"specific missing information for the user\"]}. Evidence must be copied exactly from supplied fields. Do not invent a date, timezone, obligation, approval, availability or commitment. Preserve relative deadline wording rather than guessing an absolute date. Use uncertain when status is unclear. Completed requires an explicit unqualified statement of completion/cancellation, not read state, a draft, an unrelated Sent email, a question, conditional or future promise. Each item describes its own conversation; do not merge unrelated emails merely because they have the same sender or subject.";

fn invalid() -> Error {
    Error::new(
        502,
        "The model returned an ungrounded decision. Review its sources and generate again.",
    )
}
fn text(value: &Value, maximum: usize, allow_empty: bool) -> Result<String> {
    value
        .as_str()
        .filter(|s| (allow_empty || !s.trim().is_empty()) && s.encode_utf16().count() <= maximum)
        .map(|s| s.trim().to_owned())
        .ok_or_else(invalid)
}
pub(crate) fn evidence(value: &Value, messages: &[Value]) -> Result<Value> {
    let id = text(&value["messageId"], 1000, false)?;
    let field = string(value, "field");
    let quote = text(&value["quote"], 600, false)?;
    if !["subject", "body"].contains(&field)
        || !messages
            .iter()
            .any(|m| string(m, "id") == id && string(m, field).contains(&quote))
    {
        return Err(invalid());
    }
    Ok(json!({"messageId":id,"field":field,"quote":quote}))
}
fn explicit_closure(quote: &str) -> bool {
    static CLOSURE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:(?:this|the) (?:request|task|work|order|event|issue|project) (?:is|has been) (?:complete|completed|cancelled|canceled|resolved)|(?:i|we) have (?:completed|cancelled|canceled|resolved)\b|(?:此|這)(?:項|個)?(?:請求|工作|任務|事件|事項|訂單)(?:已經|已)(?:完成|取消|解決))").unwrap()
    });
    static DOUBT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:not|never|if|unless|might|may|could|pending|will|when)\b|[?？]|未完成|尚未|還未|如果|假如|可能|將會").unwrap()
    });
    CLOSURE.is_match(quote) && !DOUBT.is_match(quote)
}
fn closure_supported(evidence: &Value, messages: &[Value]) -> bool {
    let quote = string(evidence, "quote");
    if evidence["field"] != "body" || !explicit_closure(quote) {
        return false;
    }
    let Some(message) = messages.iter().find(|m| m["id"] == evidence["messageId"]) else {
        return false;
    };
    let body = string(message, "body");
    body.match_indices(quote).any(|(offset, _)| {
        let before = &body[..offset];
        let boundary = before
            .rfind(['.', '!', '?', '\n', '。', '！', '？'])
            .map_or(0, |i| i + body[i..].chars().next().unwrap().len_utf8());
        if !before[boundary..].trim().is_empty() {
            return false;
        }
        let after = &body[offset + quote.len()..];
        let end = after
            .find(['.', '!', '?', '\n', '。', '！', '？'])
            .unwrap_or(after.len());
        if quote.ends_with(['.', '!', '?', '。', '！', '？']) {
            explicit_closure(quote)
        } else {
            explicit_closure(&format!("{quote}{}", &after[..end]))
        }
    })
}

/// The model cannot supply arbitrary people, dates, URLs, account IDs or confidence percentages.
pub fn validate(value: &Value, messages: &[Value]) -> Result<Value> {
    let title = text(&value["title"], 160, false)?;
    let action = text(&value["action"], 400, true)?;
    let state = string(value, "state");
    let reply = string(value, "replyNeeded");
    if ![
        "waiting_on_user",
        "waiting_on_others",
        "completed",
        "uncertain",
        "informational",
    ]
    .contains(&state)
        || !["yes", "no", "uncertain"].contains(&reply)
    {
        return Err(invalid());
    }
    let quotes = value["evidence"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 8)
        .ok_or_else(invalid)?
        .iter()
        .map(|v| evidence(v, messages))
        .collect::<Result<Vec<_>>>()?;
    if state == "completed" && !quotes.iter().any(|v| closure_supported(v, messages)) {
        return Err(invalid());
    }
    if state == "completed" && reply != "no" {
        return Err(invalid());
    }
    let deadline = if value["deadline"].is_null() {
        Value::Null
    } else {
        let deadline = evidence(&value["deadline"], messages)?;
        static TIME: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|\d{4}[-/]\d{1,2}[-/]\d{1,2}|今天|明天|今晚|星期|週|月\d{1,2}[日號]").unwrap()
        });
        if deadline["field"] != "body" || !TIME.is_match(string(&deadline, "quote")) {
            return Err(invalid());
        }
        deadline
    };
    let questions = value["questions"]
        .as_array()
        .filter(|v| v.len() <= 8)
        .ok_or_else(invalid)?
        .iter()
        .map(|v| text(v, 240, false).map(Value::String))
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"title":title,"action":action,"state":state,"replyNeeded":reply,"evidence":quotes,"deadline":deadline,"questions":questions}),
    )
}

fn conversation(message: &Value) -> String {
    for field in ["threadId", "conversationId"] {
        if !string(message, field).is_empty() {
            return format!("{field}:{}", string(message, field));
        }
    }
    if let Some(root) = message["references"]
        .as_array()
        .and_then(|v| v.first())
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        return format!("rfc:{root}");
    }
    for field in ["inReplyTo", "messageId"] {
        if !string(message, field).is_empty() {
            return format!("rfc:{}", string(message, field));
        }
    }
    if !string(message, "replyToId").is_empty() {
        format!("message:{}", string(message, "replyToId"))
    } else {
        format!("message:{}", string(message, "id"))
    }
}

/// Historical summaries are preserved without inventing decision/closure evidence.
pub fn events(db: &Store, owner: &str, reports: &Value) -> Result<Vec<Value>> {
    let settings = db.settings()?;
    let saved_policy = policy::resolve(&settings["policy"]);
    let mut by_message = BTreeMap::<String, (String, Value, Value)>::new();
    for report in reports.as_array().into_iter().flatten() {
        let updated = if report["completedAt"].is_string() {
            string(report, "completedAt")
        } else {
            string(report, "createdAt")
        };
        for item in report["items"].as_array().into_iter().flatten() {
            let id = string(item, "messageId");
            let Some(message) = db.get(owner, id)? else {
                continue;
            };
            let mut redacted = policy::redact(&message, &saved_policy);
            // Thread routing metadata is used locally; it is never added to model context.
            redacted["_reviewConversation"] = conversation(&message).into();
            if by_message
                .get(id)
                .is_none_or(|(date, _, _)| updated > date.as_str())
            {
                by_message.insert(id.to_owned(), (updated.to_owned(), item.clone(), redacted));
            }
        }
    }
    let sources: Vec<Value> = by_message.values().map(|(_, _, m)| m.clone()).collect();
    let mut groups = BTreeMap::<String, Vec<(String, Value, Value)>>::new();
    for (_, entry) in by_message {
        groups
            .entry(string(&entry.2, "_reviewConversation").to_owned())
            .or_default()
            .push(entry);
    }
    let mut result = Vec::new();
    for (key, mut entries) in groups {
        // Latest message evidence wins. A later analysis of an older request cannot reopen a newer closure.
        entries.sort_by(|a, b| {
            string(&a.2, "date")
                .cmp(string(&b.2, "date"))
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| string(&a.2, "id").cmp(string(&b.2, "id")))
        });
        let (updated, item, message) = entries.last().unwrap();
        let review = if item["review"].is_object() {
            validate(&item["review"], std::slice::from_ref(message)).ok()
        } else {
            None
        };
        let reviewed = review.is_some();
        let review = review.unwrap_or_else(|| json!({"title":if string(message,"subject").is_empty(){string(item,"summary")}else{string(message,"subject")},"action":"","state":"uncertain","replyNeeded":"uncertain","evidence":[],"deadline":null,"questions":[]}));
        let source_ids: Vec<Value> = entries.iter().map(|(_, _, m)| m["id"].clone()).collect();
        let mut event = review;
        event["id"] = json!([owner, key]).to_string().into();
        event["accountId"] = owner.into();
        event["messageId"] = message["id"].clone();
        event["messageIds"] = source_ids.into();
        event["priority"] = item["priority"].clone();
        event["summary"] = item["summary"].clone();
        event["updatedAt"] = updated.clone().into();
        event["grounded"] = reviewed.into();
        event["waitingOn"] = match string(&event, "state") {
            "waiting_on_user" => json!("you"),
            "waiting_on_others" => message["fromEmail"].clone(),
            _ => Value::Null,
        };
        event["sources"] = entries.iter().map(|(_,_,m)| json!({"id":m["id"],"accountId":owner,"subject":m["subject"],"date":m["date"]})).collect::<Vec<_>>().into();
        for quote in event["evidence"].as_array_mut().into_iter().flatten() {
            quote["accountId"] = owner.into();
        }
        if event["deadline"].is_object() {
            event["deadline"]["accountId"] = owner.into();
            event["deadline"]["sourceDate"] = sources
                .iter()
                .find(|m| m["id"] == event["deadline"]["messageId"])
                .map(|m| m["date"].clone())
                .unwrap_or(Value::Null);
        }
        result.push(event);
    }
    result.sort_by(|a, b| {
        string(a, "priority")
            .cmp(string(b, "priority"))
            .then_with(|| string(b, "updatedAt").cmp(string(a, "updatedAt")))
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Vec<Value> {
        vec![
            json!({"id":"one","body":"Please approve the design by Friday. The request is completed. The request is not completed.","subject":"Design"}),
        ]
    }
    fn review(state: &str, quote: &str) -> Value {
        json!({"title":"Decide on the design","action":"Approve or request changes","state":state,"replyNeeded":if state=="completed"{"no"}else{"yes"},"evidence":[{"messageId":"one","field":"body","quote":quote}],"deadline":null,"questions":[]})
    }
    #[test]
    fn rejects_unknown_source_or_invented_quote_and_closure() {
        assert!(
            validate(
                &review("waiting_on_user", "Please approve the design by Friday."),
                &source()
            )
            .is_ok()
        );
        assert!(
            validate(
                &review("completed", "Please approve the design by Friday."),
                &source()
            )
            .is_err()
        );
        assert!(validate(&review("completed", "The request is completed."), &source()).is_ok());
        assert!(
            validate(
                &review("completed", "The request is not completed."),
                &source()
            )
            .is_err()
        );
        assert!(validate(&review("waiting_on_user", "Approve by tomorrow"), &source()).is_err());
        let mut value = review("waiting_on_user", "Please approve the design by Friday.");
        value["evidence"][0]["messageId"] = "other-account".into();
        assert!(validate(&value, &source()).is_err());
    }
    #[test]
    fn closure_never_accepts_questions_conditions_or_future() {
        for text in [
            "We have completed this if you approve.",
            "We have completed this?",
            "We will complete this.",
            "This request is completed but work is pending.",
        ] {
            assert!(!explicit_closure(text), "{text}");
        }
    }
}
