use crate::{
    error::{Error, Result},
    store::{catalog, merge, string},
    validation,
};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

pub fn recipients(input: &Value, draft: bool) -> Result<Value> {
    static ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$").unwrap()
    });
    let mut result = json!({});
    let mut seen = HashSet::new();
    let mut count = 0;
    for field in ["to", "cc", "bcc"] {
        let empty = json!("");
        let value = validation::text(
            input.get(field).filter(|v| !v.is_null()).unwrap_or(&empty),
            field,
            26000,
            true,
        )?;
        if value.contains(['\r', '\n', '\0']) {
            return Err(Error::invalid(
                "Recipients must be a single line of email addresses.",
            ));
        }
        if draft {
            result[field] = value.trim().into();
            continue;
        }
        let mut values = Vec::new();
        if !value.trim().is_empty() {
            for value in value.split([',', ';']).map(str::trim) {
                count += 1;
                if value.len() > 254
                    || !ADDRESS.is_match(value)
                    || value.starts_with('.')
                    || value.contains("..")
                    || value.contains(".@")
                {
                    return Err(Error::invalid(
                        "Enter valid email addresses, separated by commas or semicolons.",
                    ));
                }
                if seen.insert(value.to_lowercase()) {
                    values.push(value);
                }
            }
        }
        result[field] = values.join(", ").into();
    }
    if !draft && (seen.is_empty() || count > 100) {
        return Err(Error::invalid(
            "Use between 1 and 100 recipients across To, Cc and Bcc.",
        ));
    }
    Ok(result)
}
pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
pub fn clean_style(value: &str) -> String {
    static STYLES: LazyLock<HashMap<&'static str, Regex>> = LazyLock::new(|| {
        [
            (
                "color",
                r"^(#[a-f0-9]{3}(?:[a-f0-9]{3})?|black|white|gray|grey|navy|blue|green|red)$",
            ),
            ("font-weight", r"^(normal|bold|[4-7]00)$"),
            ("font-style", r"^(normal|italic)$"),
            ("font-size", r"^(?:[8-9]|[12][0-9]|3[0-2])px$"),
            ("text-decoration", r"^(none|underline|line-through)$"),
            ("text-align", r"^(left|center|right)$"),
            ("border-collapse", r"^collapse$"),
            ("padding", r"^(?:0|[1-9]|1[0-9]|2[0-4])px$"),
        ]
        .into_iter()
        .map(|(key, regex)| (key, Regex::new(regex).unwrap()))
        .collect()
    });
    value
        .split(';')
        .filter_map(|entry| {
            let mut parts = entry.split(':').map(|s| s.trim().to_lowercase());
            let key = parts.next()?;
            let value = parts.next()?;
            if parts.next().is_some()
                || !STYLES
                    .get(key.as_str())
                    .is_some_and(|re| re.is_match(&value))
            {
                return None;
            }
            Some(format!("{key}:{value}"))
        })
        .collect::<Vec<_>>()
        .join(";")
}
pub fn plain_html(html: &str) -> Result<String> {
    html2text::config::plain_no_decorate()
        .no_table_borders()
        .no_link_wrapping()
        .string_from_read(html.as_bytes(), 100000)
        .map(|s| s.trim().to_owned())
        .map_err(|_| Error::invalid("This HTML text could not be read."))
}
pub fn footer(value: &Value) -> Result<Value> {
    if !value.is_object() {
        return Err(Error::invalid("Footer must be an object."));
    }
    let empty = json!("");
    let text = validation::text(value.get("text").unwrap_or(&empty), "Footer", 12000, true)?;
    let html = validation::text(value.get("html").unwrap_or(&empty), "Footer", 12000, true)?;
    if html.is_empty() {
        return Ok(json!({"text":text,"html":""}));
    }
    let dom = html2text::config::plain()
        .parse_html(html.as_bytes())
        .map_err(|_| Error::invalid("Invalid HTML footer."))?;
    let mut stack = vec![(dom.document.clone(), 0)];
    let mut nodes = 0;
    while let Some((node, depth)) = stack.pop() {
        nodes += 1;
        if nodes > 2003 || depth > 43 {
            return Err(Error::invalid(
                "This HTML footer is too complex. Use a simpler signature.",
            ));
        }
        for child in node.children.borrow().iter() {
            stack.push((child.clone(), depth + 1));
        }
    }
    let allowed = "p div span br hr strong b em i u s a table tbody thead tr td th ul ol li"
        .split(' ')
        .collect();
    let blocked =
        "script style iframe object embed svg math form input button textarea select template head"
            .split(' ')
            .collect();
    let html = ammonia::Builder::new()
        .tags(allowed)
        .clean_content_tags(blocked)
        .generic_attributes(["style"].into_iter().collect())
        .tag_attributes(
            [("a", ["href"].into_iter().collect())]
                .into_iter()
                .collect(),
        )
        .link_rel(None)
        .url_schemes(["https", "mailto", "tel"].into_iter().collect())
        .url_relative(ammonia::UrlRelative::Deny)
        .attribute_filter(|_, key, value| match key {
            "style" => {
                let clean = clean_style(value);
                if clean.is_empty() {
                    None
                } else {
                    Some(clean.into())
                }
            }
            "href" => {
                if value.chars().any(|c| c <= ' ' || c == '\u{7f}')
                    || !url::Url::parse(value)
                        .is_ok_and(|url| url.username().is_empty() && url.password().is_none())
                {
                    None
                } else {
                    Some(value.into())
                }
            }
            _ => None,
        })
        .clean(html)
        .to_string();
    let text = plain_html(&html)?;
    if html.encode_utf16().count() > 12000 || text.encode_utf16().count() > 12000 {
        return Err(Error::invalid(
            "The formatted footer exceeds 12000 characters.",
        ));
    }
    Ok(json!({"text":text,"html":html}))
}
pub fn preferences_footer(input: &Value) -> Result<Value> {
    let format = input
        .get("signatureFormat")
        .and_then(Value::as_str)
        .unwrap_or("plain");
    if !["plain", "html"].contains(&format) {
        return Err(Error::invalid(
            "Choose plain text or HTML for your signature.",
        ));
    }
    footer(
        &json!({if format=="html"{"html"}else{"text"}:input.get("signature").cloned().unwrap_or(json!(""))}),
    )
}
pub fn preferences(current: &Value, patch: &Value) -> Result<Value> {
    let patch = patch
        .as_object()
        .ok_or_else(|| Error::invalid("Preferences must be an object."))?;
    let defaults = &catalog()["preferences"];
    let mut next = merge(defaults.clone(), current);
    let choices = json!({"signatureFormat":["plain","html"],"theme":["system","light","dark"],"density":["comfortable","compact","spacious"],"sort":["newest","oldest","sender","subject","unread","starred"],"replyTone":["friendly","professional","concise","warm"],"syncInterval":[0,1,5,15,30],"sendDelayHours":[0,1,2,3,4,5,6]});
    for (key, value) in patch {
        if defaults.get(key).is_none() {
            return Err(Error::invalid("Unknown preference."));
        }
        if let Some(options) = choices[key].as_array() {
            if !options.contains(value) {
                return Err(Error::invalid("Invalid preference."));
            }
        } else if key == "markReadOnOpen" {
            if !value.is_boolean() {
                return Err(Error::invalid("Mark read on open must be true or false."));
            }
        } else if key == "autoLoadExternalImages" {
            if !value.is_boolean() {
                return Err(Error::invalid(
                    "Automatic external images must be true or false.",
                ));
            }
        } else {
            let max = if key == "signature" {
                12000
            } else if ["language", "translationLanguage"].contains(&key.as_str()) {
                60
            } else {
                100
            };
            let text = validation::text(value, key, max, key != "language")?;
            if key == "displayName" && text.contains(['\r', '\n']) {
                return Err(Error::invalid("Display name must be a single line."));
            }
        }
        next[key] = value.clone();
    }
    let footer = preferences_footer(&next)?;
    next["signature"] = footer[if next["signatureFormat"] == "html" {
        "html"
    } else {
        "text"
    }]
    .clone();
    Ok(next)
}
pub fn content(input: &Value, draft: bool) -> Result<Value> {
    let mut result = recipients(input, draft)?;
    let empty = json!("");
    let subject = validation::text(input.get("subject").unwrap_or(&empty), "Subject", 500, true)?;
    if subject.contains(['\r', '\n']) {
        return Err(Error::invalid("Subject must be a single line."));
    }
    result["subject"] = if !draft && subject.is_empty() {
        "(No subject)"
    } else {
        subject
    }
    .into();
    result["body"] = validation::text(
        input.get("body").unwrap_or(&empty),
        "Message body",
        100000,
        draft,
    )?
    .into();
    if let Some(value) = input.get("footer") {
        result["footer"] = footer(value)?;
    }
    Ok(result)
}
pub fn message_content(message: &Value) -> Result<(String, Option<String>)> {
    let value = footer(message.get("footer").unwrap_or(&json!({})))?;
    let body = string(message, "body");
    let original_text = message["footer"]["text"]
        .as_str()
        .unwrap_or(string(&value, "text"));
    let text = format!(
        "{body}{}",
        if original_text.is_empty() {
            String::new()
        } else {
            format!("\n\n{original_text}")
        }
    );
    let html = if string(&value, "html").is_empty() {
        None
    } else {
        Some(format!(
            "<div>{}</div><br><div>{}</div>",
            escape_html(body)
                .replace("\r\n", "\n")
                .replace('\n', "<br>"),
            string(&value, "html")
        ))
    };
    Ok((text, html))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn address_and_footer_boundaries() {
        assert!(
            recipients(
                &json!({"to":"a@example.test\r\nBcc: b@example.test"}),
                false
            )
            .is_err()
        );
        assert_eq!(
            recipients(
                &json!({"to":"A@example.test","bcc":"a@example.test;hidden@example.test"}),
                false
            )
            .unwrap()["bcc"],
            "hidden@example.test"
        );
        let clean=footer(&json!({"html":"<p style=\"color:red;position:absolute\">Hello<script>secret()</script><img src=x><a href=\"https://user:password@example.test\">unsafe</a><a href=\"https://example.test\">web</a></p>"})).unwrap();
        let html = string(&clean, "html");
        assert!(
            !html.contains("secret")
                && !html.contains("img")
                && !html.contains("password")
                && !html.contains("position")
        );
        assert!(html.contains("color:red") && html.contains("https://example.test"));
        assert_eq!(footer(&clean).unwrap(), clean);
    }
}
