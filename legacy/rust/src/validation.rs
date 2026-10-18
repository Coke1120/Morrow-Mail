use crate::error::{Error, Result};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub fn text<'a>(value: &'a Value, name: &str, maximum: usize, empty: bool) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| s.encode_utf16().count() <= maximum && (empty || !s.trim().is_empty()))
        .ok_or_else(|| {
            Error::invalid(&format!(
                "{name} is required and must be at most {maximum} characters."
            ))
        })
}
pub fn email(value: &Value) -> Result<String> {
    static EMAIL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$").unwrap());
    let email = text(value, "Email address", 254, false)?.trim();
    if !EMAIL.is_match(email) {
        return Err(Error::invalid("Enter one valid email address."));
    }
    Ok(email.to_owned())
}
pub fn api_base(value: &Value) -> Result<String> {
    let base = text(value, "AI API base URL", 2048, false)?;
    let url =
        url::Url::parse(base).map_err(|_| Error::invalid("Enter a valid AI API base URL."))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["https", "http"].contains(&url.scheme())
    {
        return Err(Error::invalid(
            "Use an HTTP(S) base URL without credentials, query or fragment.",
        ));
    }
    if url.scheme() == "http"
        && !url
            .host_str()
            .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]"].contains(&host))
    {
        return Err(Error::invalid(
            "Remote AI providers must use HTTPS. Local models may use HTTP on localhost.",
        ));
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}
pub fn same_secret(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
pub fn hostname(value: &Value, name: &str) -> Result<String> {
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9.-]*$").unwrap());
    let host = text(value, name, 253, false)?.trim();
    if !HOST.is_match(host) {
        return Err(Error::invalid(
            "Mail servers require a hostname without a URL or port.",
        ));
    }
    Ok(host.to_owned())
}
