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
    if closure_quote(message).is_none() {
        return false;
    }
    let body = authored_body(body);
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
    if ["waiting_on_user", "waiting_on_others", "completed"].contains(&state) {
        let latest = messages.first().ok_or_else(invalid)?;
        if !quotes.iter().any(|quote| {
            quote["messageId"] == latest["id"]
                && quote["field"] == "body"
                && authored_body(string(latest, "body")).contains(string(quote, "quote"))
        }) {
            return Err(invalid());
        }
    }
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
        static DUE: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)\b(?:by|before|due|deadline|no later than)\b|截止|限期|之前|以前|前完成|前回覆|前回復").unwrap()
        });
        if deadline["field"] != "body"
            || !TIME.is_match(string(&deadline, "quote"))
            || !DUE.is_match(string(&deadline, "quote"))
        {
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

/// Only the author's current text can support closure, never quoted prior mail.
fn authored_body(body: &str) -> &str {
    static QUOTED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?mi)^>.*$|^On .{1,200} wrote:\s*$|^-{2,}.*(?:Original Message|Forwarded message).*$",
        )
        .unwrap()
    });
    &body[..QUOTED.find(body).map_or(body.len(), |found| found.start())]
}
fn closure_quote(message: &Value) -> Option<String> {
    let body = authored_body(string(message, "body"));
    static QUESTION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:not|never|if|unless|pending|might|could|will|reopen|need|require|approve)\b|[?？]|尚未|未完成|如果|可能|請|需要|重新").unwrap()
    });
    if body.len() > 20000 || QUESTION.is_match(body) {
        return None;
    }
    body.split_inclusive(['.', '!', '\n', '。', '！'])
        .map(str::trim)
        .find(|sentence| explicit_closure(sentence))
        .map(str::to_owned)
}
fn request_quote(message: &Value) -> Option<String> {
    static REQUEST: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:please|could you|can you|would you)\b|[?？]|請|能否|可否")
            .unwrap()
    });
    authored_body(string(message, "body"))
        .split_inclusive(['.', '!', '?', '\n', '。', '！', '？'])
        .map(str::trim)
        .find(|sentence| REQUEST.is_match(sentence) && sentence.encode_utf16().count() <= 600)
        .map(str::to_owned)
}
fn recipients(message: &Value, owner: &str) -> Vec<String> {
    let to = string(message, "to");
    if to.len() > 10000 || to.contains(['\r', '\n', '\0']) {
        return vec![];
    }
    let header = format!("To: {to}\r\n\r\n");
    let Some(parsed) = mail_parser::MessageParser::default().parse(header.as_bytes()) else {
        return vec![];
    };
    let mut result = std::collections::BTreeSet::new();
    for address in parsed
        .to()
        .into_iter()
        .flat_map(|list| list.iter())
        .filter_map(|address| address.address())
    {
        if !address.eq_ignore_ascii_case(owner) && crate::validation::email(&json!(address)).is_ok()
        {
            result.insert(address.to_owned());
        }
    }
    result.into_iter().collect()
}
/// Reconcile saved evidence against ALL indexed later arrivals/departures in its account.
/// This is a read projection; it never generates mail, calls a model or marks a draft complete.
pub fn events(db: &Store, owner: &str, reports: &Value) -> Result<Vec<Value>> {
    let mut saved = BTreeMap::<String, (String, Value)>::new();
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for report in reports.as_array().into_iter().flatten() {
        let updated = if !string(report, "completedAt").is_empty() {
            string(report, "completedAt")
        } else if !string(report, "updatedAt").is_empty() {
            string(report, "updatedAt")
        } else {
            string(report, "createdAt")
        };
        for item in report["items"].as_array().into_iter().flatten() {
            let id = string(item, "messageId");
            if db.get(owner, id)?.is_none() {
                continue;
            }
            if saved
                .get(id)
                .is_none_or(|(previous, _)| updated > previous.as_str())
            {
                saved.insert(id.into(), (updated.into(), item.clone()));
            }
        }
    }
    if saved.is_empty() {
        return Ok(Vec::new());
    }
    let saved_policy = policy::resolve(&db.settings()?["policy"]);
    let index = crate::mail_threads::Index::load(db, owner)?;
    for id in saved.keys() {
        let key = index
            .thread(id)
            .map(|thread| thread.key.clone())
            .unwrap_or_else(|| format!("unavailable:{id}"));
        groups.entry(key).or_default().push(id.clone());
    }
    let mut result = Vec::new();
    for (key, ids) in groups {
        let thread = index.thread(&ids[0]);
        let latest = thread
            .map(|thread| thread.latest.as_str())
            .unwrap_or(&ids[0]);
        let raw = db.get(owner, latest)?.unwrap_or(Value::Null);
        let permitted = saved_policy["folders"][string(&raw, "folder")] == true
            && !["drafts", "trash", "spam"].contains(&string(&raw, "folder"));
        let message = if permitted {
            policy::redact(&raw, &saved_policy)
        } else {
            json!({"id":latest,"date":raw["date"],"folder":raw["folder"]})
        };
        let cap = saved_policy["maxMessages"]
            .as_u64()
            .unwrap_or(8)
            .clamp(1, 10) as usize;
        let (sources, coverage) = index.context(db, owner, latest, &saved_policy, cap)?;
        let partial = thread.is_none()
            || !permitted
            || raw.is_null()
            || coverage["partial"] == true
            || thread.is_some_and(|thread| thread.uncertain_delivery);
        let bound = saved.get(latest).and_then(|(_, item)| {
            (item["reviewSourceHash"] == crate::mail_threads::content_hash(&message))
                .then_some(item)
        });
        let reviewed =
            bound.and_then(|item| validate(&item["review"], std::slice::from_ref(&message)).ok());
        let original = &saved[&ids[0]].1;
        let mut event = json!({"title":if !string(&message,"subject").is_empty(){message["subject"].clone()}else{json!("Conversation needs review")},"action":"","state":"uncertain","replyNeeded":"uncertain","evidence":[],"deadline":null,"questions":["Check the latest conversation before deciding."],"grounded":false});
        if !partial {
            if let Some(review) = reviewed {
                event = review;
                event["grounded"] = true.into();
            } else if let Some(quote) = closure_quote(&message) {
                event["state"] = "completed".into();
                event["replyNeeded"] = "no".into();
                event["evidence"] = json!([{"messageId":latest,"field":"body","quote":quote}]);
                event["questions"] = json!([]);
                event["grounded"] = true.into();
            } else if raw["folder"] == "sent"
                && string(&raw, "fromEmail").eq_ignore_ascii_case(owner)
                && let Some(quote) = request_quote(&message)
            {
                event["state"] = "waiting_on_others".into();
                event["replyNeeded"] = "no".into();
                event["action"] = "Wait for a response to the latest outgoing request.".into();
                event["evidence"] = json!([{"messageId":latest,"field":"body","quote":quote}]);
                event["grounded"] = true.into();
            } else if raw["folder"] == "inbox"
                && !string(&raw, "fromEmail").eq_ignore_ascii_case(owner)
                && let Some(quote) = request_quote(&message)
            {
                event["state"] = "waiting_on_user".into();
                event["replyNeeded"] = "yes".into();
                event["action"] =
                    "Review the latest explicit request and decide how to respond.".into();
                event["evidence"] = json!([{"messageId":latest,"field":"body","quote":quote}]);
                event["questions"] = json!(["What answer or decision do you want to give?"]);
                event["grounded"] = true.into();
            }
        }
        if event["state"] == "waiting_on_user"
            && (raw["folder"] != "inbox" || string(&raw, "fromEmail").eq_ignore_ascii_case(owner))
        {
            event["state"] = "uncertain".into();
            event["replyNeeded"] = "uncertain".into();
            event["action"] = "".into();
        }
        event["waitingOn"] = if event["state"] == "waiting_on_user" {
            json!("you")
        } else if event["state"] == "waiting_on_others" && raw["folder"] == "sent" {
            let people = recipients(&message, owner);
            if people.len() == 1 {
                json!(people[0])
            } else {
                Value::Null
            }
        } else {
            Value::Null
        };
        if event["state"] == "waiting_on_others" && event["waitingOn"].is_null() {
            event["questions"] = json!(["Who is expected to respond? Check the original message."]);
        }
        if partial {
            event["questions"] = json!([
                "Some conversation content is missing, withheld or ambiguous. Verify the latest original before deciding."
            ]);
        }
        event["id"] = crate::ai::hash(&json!([owner, key])).into();
        event["accountId"] = owner.into();
        event["messageId"] = latest.into();
        event["messageIds"] = thread
            .map(|thread| json!(thread.ids))
            .unwrap_or_else(|| json!(ids));
        event["priority"] = original["priority"].clone();
        event["summary"] = original["summary"].clone();
        event["updatedAt"] = raw["date"].clone();
        event["coverage"] = coverage;
        event["sources"]=sources.iter().map(|message|json!({"id":message["id"],"accountId":owner,"subject":message["subject"],"date":message["date"]})).collect::<Vec<_>>().into();
        for quote in event["evidence"].as_array_mut().into_iter().flatten() {
            quote["accountId"] = owner.into();
        }
        if event["deadline"].is_object() {
            event["deadline"]["accountId"] = owner.into();
            event["deadline"]["sourceDate"] = message["date"].clone();
        }
        result.push(event);
    }
    result.sort_by(|a, b| {
        string(a, "priority")
            .cmp(string(b, "priority"))
            .then_with(|| crate::mail_threads::instant(b).cmp(&crate::mail_threads::instant(a)))
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
        assert!(
            validate(
                &review("completed", "The request is completed."),
                &[json!({"id":"one","body":"The request is completed."})]
            )
            .is_ok()
        );
        assert!(validate(&review("completed", "The request is completed."), &source()).is_err());
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
