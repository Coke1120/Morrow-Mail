use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub body: Value,
    pub provider_status: Option<u16>,
    // Provider pacing metadata stays private; public status uses nextRetryAt.
    pub retry_after: Option<i64>,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(status: u16, message: &str) -> Self {
        Self {
            status,
            body: json!({"error": message}),
            provider_status: None,
            retry_after: None,
        }
    }
    pub fn invalid(message: &str) -> Self {
        Self::new(400, message)
    }
    pub fn conflict(message: &str) -> Self {
        Self::new(409, message)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            self.body["error"].as_str().unwrap_or("Operation failed.")
        )
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::new(
            500,
            "The workspace could not complete the database operation. Saved data has been retained.",
        )
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            500,
            "The workspace could not read or save its files. Check available space and permissions.",
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid("Invalid JSON data.")
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(self.body),
        )
            .into_response()
    }
}
