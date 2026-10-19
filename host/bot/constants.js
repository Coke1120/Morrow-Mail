"use strict";

// P0 bridge limits from the host-owned contract. The adapter cannot raise them.
const HOST = "127.0.0.1";
const PORT = 47831;
const API_VERSION = "1.0";
const CALL_PATH = "/api/bot/v1/call";
const SERVE_CAPABILITY = "com.coke1120.morrow-mail/bot-access";
const STALE_AFTER_SECONDS = 300;
const SYNC_WINDOW_DAYS = 180;
const MAX_ACCOUNTS = 5;
const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_BODY_BYTES = 8 * 1024;
const HTML_INPUT_CAP = 128 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_TRANSPORT_BYTES = 48 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_AUTH_HEADER = 512;
const MAX_CAP_HEADER = 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const SUBJECT_BYTES = 512;
const SENDER_BYTES = 320;
const SNIPPET_BYTES = 512;
const MAX_RECIPIENTS = 50;
const CORPUS_CAP = 50000;
const CALLS_PER_MINUTE = 60;
const BURST = 10;
const GLOBAL_PER_MINUTE = 120;
const SEARCHES_PER_MINUTE = 10;
const BODIES_PER_MINUTE = 20;
const CLIENT_CONCURRENCY = 2;
const GLOBAL_CONCURRENCY = 4;
const BYTES_PER_MINUTE = 1024 * 1024;
const BYTES_PER_DAY = 10 * 1024 * 1024;
const DRAFTS_PER_DAY = 10;
const DRAFTS_PENDING = 20;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const SEND_PER_GRANT_PER_MINUTE = 1;
const SEND_PER_GRANT_PER_DAY = 10;
const SEND_PER_INSTALLATION_PER_DAY = 20;
const MAX_DEPTH = 8;

const FOLDERS = ["inbox", "sent", "drafts", "archive", "trash", "spam"];

const ERRORS = {
  INVALID_REQUEST: {
    status: 400,
    message: "The request is not valid.",
    retryable: false,
  },
  UNSUPPORTED_VERSION: {
    status: 400,
    message: "That API version is not supported.",
    retryable: false,
  },
  UNAUTHENTICATED: {
    status: 401,
    message: "The client is not authenticated.",
    retryable: false,
    action: "REPAIR_IN_MORROW",
  },
  FORBIDDEN: {
    status: 403,
    message: "This client cannot access that account or operation.",
    retryable: false,
    action: "REVIEW_ACCESS_IN_MORROW",
  },
  SEND_OUTCOME_UNKNOWN: {
    status: 409,
    message: "The send outcome is unknown. Morrow will not send it again.",
    retryable: false,
  },
  SEND_REJECTED: {
    status: 400,
    message: "The mail server refused the message.",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    message: "That cached item is not available.",
    retryable: false,
  },
  ATTACHMENT_NOT_IN_CACHE: {
    status: 404,
    message: "No cached attachment metadata is stored for that index.",
    retryable: false,
  },
  UNKNOWN_OPERATION: {
    status: 404,
    message: "That operation is not available.",
    retryable: false,
  },
  INSTALLATION_MISMATCH: {
    status: 409,
    message: "This credential belongs to another Morrow installation.",
    retryable: false,
    action: "REPAIR_IN_MORROW",
  },
  REQUEST_TOO_LARGE: {
    status: 413,
    message: "The request is too large.",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: "The client is over its request budget.",
    retryable: true,
  },
  HOST_NOT_READY: {
    status: 503,
    message: "Morrow is not ready for bridge requests.",
    retryable: true,
  },
  STORE_UNAVAILABLE: {
    status: 503,
    message: "Proposal storage cannot be read.",
    retryable: true,
  },
  SEARCH_BUDGET_EXCEEDED: {
    status: 503,
    message: "That search is outside the local work budget.",
    retryable: false,
  },
  INTERNAL: {
    status: 500,
    message: "Morrow could not complete that request.",
    retryable: true,
  },
};

module.exports = {
  HOST,
  PORT,
  API_VERSION,
  CALL_PATH,
  SERVE_CAPABILITY,
  STALE_AFTER_SECONDS,
  SYNC_WINDOW_DAYS,
  MAX_ACCOUNTS,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BODY_BYTES,
  DEFAULT_BODY_BYTES,
  HTML_INPUT_CAP,
  MAX_REQUEST_BYTES,
  MAX_TRANSPORT_BYTES,
  MAX_HEADER_BYTES,
  MAX_AUTH_HEADER,
  MAX_CAP_HEADER,
  MAX_RESPONSE_BYTES,
  SUBJECT_BYTES,
  SENDER_BYTES,
  SNIPPET_BYTES,
  MAX_RECIPIENTS,
  CORPUS_CAP,
  CALLS_PER_MINUTE,
  BURST,
  GLOBAL_PER_MINUTE,
  SEARCHES_PER_MINUTE,
  BODIES_PER_MINUTE,
  CLIENT_CONCURRENCY,
  GLOBAL_CONCURRENCY,
  BYTES_PER_MINUTE,
  BYTES_PER_DAY,
  DRAFTS_PER_DAY,
  DRAFTS_PENDING,
  DRAFT_TTL_MS,
  SEND_PER_GRANT_PER_MINUTE,
  SEND_PER_GRANT_PER_DAY,
  SEND_PER_INSTALLATION_PER_DAY,
  MAX_DEPTH,
  FOLDERS,
  ERRORS,
};
