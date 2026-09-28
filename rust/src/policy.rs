use crate::{
    error::{Error, Result},
    store::{catalog, merge, string},
};
use serde_json::{Value, json};

pub fn resolve(saved: &Value) -> Value {
    let defaults = &catalog()["policy"];
    let mut value = merge(defaults.clone(), saved);
    for key in [
        "summarySchedule",
        "triggers",
        "behaviors",
        "folders",
        "content",
    ] {
        value[key] = merge(defaults[key].clone(), &saved[key]);
    }
    if saved["summarySchedule"].get("timeZone").is_none() {
        value["summarySchedule"]["timeZone"] = iana_time_zone::get_timezone()
            .unwrap_or_else(|_| "UTC".into())
            .into();
    }
    value
}
pub fn update(current: &Value, patch: &Value) -> Result<Value> {
    let patch = patch
        .as_object()
        .ok_or_else(|| Error::invalid("AI permissions must be an object."))?;
    let defaults = &catalog()["policy"];
    let mut next = resolve(current);
    for (key, value) in patch {
        if defaults.get(key).is_none() {
            return Err(Error::invalid("Unknown AI permission."));
        }
        match key.as_str() {
            "enabled" => {
                if !value.is_boolean() {
                    return Err(Error::invalid("AI enabled must be true or false."));
                }
                next[key] = value.clone();
            }
            "maxMessages" => {
                if !value.as_u64().is_some_and(|n| (1..=50).contains(&n)) {
                    return Err(Error::invalid(
                        "Context limit must be between 1 and 50 messages.",
                    ));
                }
                next[key] = value.clone();
            }
            "summarySchedule" => {
                let fields = value
                    .as_object()
                    .ok_or_else(|| Error::invalid("Summary schedule must be an object."))?;
                for (field, value) in fields {
                    let valid = match field.as_str() {
                        "cadence" => value
                            .as_str()
                            .is_some_and(|s| ["daily", "interval"].contains(&s)),
                        "time" => value.as_str().is_some_and(|s| {
                            s.len() == 5 && chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
                        }),
                        "everyHours" => value.as_u64().is_some_and(|n| (1..=168).contains(&n)),
                        "timeZone" => value
                            .as_str()
                            .is_some_and(|s| s.len() <= 100 && s.parse::<chrono_tz::Tz>().is_ok()),
                        _ => false,
                    };
                    if !valid {
                        return Err(Error::invalid(
                            "Choose a valid summary cadence, time, interval and IANA time zone.",
                        ));
                    }
                    next[key][field] = value.clone();
                }
            }
            _ => {
                let fields = value
                    .as_object()
                    .ok_or_else(|| Error::invalid("AI permissions must contain checkboxes."))?;
                for (field, value) in fields {
                    if defaults[key].get(field).is_none() || !value.is_boolean() {
                        return Err(Error::invalid("Invalid AI permission checkbox."));
                    }
                    next[key][field] = value.clone();
                }
            }
        }
    }
    Ok(next)
}
pub fn require(policy: &Value, action: &str) -> Result<Value> {
    let feature = catalog()["features"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == action)
        .ok_or_else(|| Error::invalid("Unknown AI behavior."))?;
    if policy["enabled"] != true || policy["behaviors"][action] != true {
        return Err(Error::new(
            403,
            "This behavior is disabled in AI permissions.",
        ));
    }
    let content = match action {
        "memory" | "research" => "contacts",
        "meeting" | "schedule" => "calendar",
        "attachments" => "attachments",
        _ => "",
    };
    if !content.is_empty() && policy["content"][content] != true {
        return Err(Error::new(
            403,
            "Enable the required content access in AI permissions.",
        ));
    }
    if action == "batchReplies"
        && (policy["content"]["sender"] != true || policy["content"]["body"] != true)
    {
        return Err(Error::new(
            403,
            "Batch replies require sender and body access.",
        ));
    }
    Ok(feature.clone())
}
pub fn redact(message: &Value, policy: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id", "date", "folder", "read", "starred", "pending", "category",
    ] {
        if let Some(value) = message.get(key) {
            result[key] = value.clone();
        }
    }
    for (key, permission) in [
        ("fromName", "sender"),
        ("fromEmail", "sender"),
        ("to", "sender"),
        ("subject", "subject"),
        ("body", "body"),
        ("preview", "body"),
        ("labels", "subject"),
    ] {
        if policy["content"][permission] == true {
            if let Some(value) = message.get(key) {
                result[key] = value.clone();
            }
        } else {
            result[key] = if key == "labels" {
                json!([])
            } else {
                json!("")
            };
        }
    }
    result
}
pub fn matches_trigger(policy: &Value, trigger: &str, message: &Value) -> bool {
    let action = match trigger {
        "onOpen" | "onArrival" => "summary",
        "onReply" => "reply",
        _ => return false,
    };
    policy["enabled"] == true
        && policy["triggers"][trigger] == true
        && policy["behaviors"][action] == true
        && !message.is_null()
        && !["drafts", "trash"].contains(&string(message, "folder"))
        && policy["folders"][string(message, "folder")] == true
        && (policy["triggers"]["inboxOnly"] != true || message["folder"] == "inbox")
        && (policy["triggers"]["starredOnly"] != true || message["starred"] == true)
        && ["subject", "body", "sender"]
            .iter()
            .any(|field| policy["content"][field] == true)
}
