const { answer } = require("./engine");

function problem(list, message) {
  list.push(message);
}

async function run() {
  const problems = [];
  const host = process.env.GENMAIL_IMAP_HOST || "127.0.0.1";
  const imapPort = Number(process.env.GENMAIL_IMAP_PORT || 3143);
  const smtpPort = Number(process.env.GENMAIL_SMTP_PORT || 3025);
  const email = process.env.GENMAIL_LIVE_EMAIL || "ada@example.com";
  const username = process.env.GENMAIL_LIVE_USER || email;
  const password = process.env.GENMAIL_LIVE_PASSWORD || "";
  if (!password) {
    console.error("live mail test needs GENMAIL_LIVE_PASSWORD");
    return 1;
  }
  const token = `live-${Date.now().toString(36)}`;
  const connected = await answer("mail:connectImapSmtp", [{
    profile: "custom",
    email,
    username,
    password,
    custom: {
      imap: { host, port: imapPort, tls: false },
      smtp: { host, port: smtpPort, tls: false },
    },
  }]);
  if (!connected || connected.success !== true || !connected.data || !connected.data.id) {
    const message = connected && connected.error && connected.error.message;
    problem(problems, `connect failed: ${message || "no account"}`);
    console.error(problems.join("\n"));
    return 1;
  }
  const accountId = connected.data.id;

  const sentFolder = await answer("mail:createFolder", [{ accountId, folderName: "Sent" }]);
  if (!sentFolder || (sentFolder.success !== true && !(sentFolder.error && sentFolder.error.code === "DUPLICATE_NAME"))) {
    problem(problems, "could not create Sent");
  }
  const draftsFolder = await answer("mail:createFolder", [{ accountId, folderName: "Drafts" }]);
  if (!draftsFolder || (draftsFolder.success !== true && !(draftsFolder.error && draftsFolder.error.code === "DUPLICATE_NAME"))) {
    problem(problems, "could not create Drafts");
  }

  const sent = await answer("mail:send", [{
    accountId,
    fromAddress: email,
    to: [email],
    subject: token,
    body: `<p>${token} body</p>`,
    contentType: "html",
  }]);
  if (!sent || sent.success !== true || !sent.data || !sent.data.messageId) {
    problem(problems, `send failed: ${sent && sent.error && sent.error.message}`);
  }

  const inbox = await answer("mail:listFromNetwork", [{ accountId, folderId: "INBOX", limit: 50 }]);
  const row = inbox && inbox.data && inbox.data.emails.find((item) => item.subject === token);
  if (!row) problem(problems, "sent message did not arrive in the inbox");
  if (row) {
    const opened = await answer("mail:openEmail", [{ emailId: row.id, accountId }]);
    const body = opened && opened.data && opened.data.email && (opened.data.email.textBody || opened.data.email.htmlBody || "");
    if (!String(body).includes(token)) problem(problems, "opened message is missing its body");
    const marked = await answer("mail:markRead", [{ emailId: row.id, accountId, isRead: true }]);
    if (!marked || marked.success !== true) problem(problems, "mark read failed");
  }

  const notes = await answer("mail:createFolder", [{ accountId, folderName: "Notes" }]);
  const notesReady = notes && (notes.success === true || (notes.error && notes.error.code === "DUPLICATE_NAME"));
  if (!notesReady) problem(problems, "could not create Notes");
  if (row && notesReady) {
    const moved = await answer("mail:moveToFolder", [{
      emailId: row.id,
      accountId,
      targetFolderId: "Notes",
      folderId: "INBOX",
    }]);
    if (!moved || moved.success !== true) problem(problems, `move failed: ${moved && moved.error && moved.error.message}`);
    const inNotes = await answer("mail:listFromNetwork", [{ accountId, folderId: "Notes", limit: 50 }]);
    if (!inNotes || !inNotes.data || !inNotes.data.emails.some((item) => item.id === row.id || item.subject === token)) {
      problem(problems, "moved message is not in Notes");
    }
  }

  const uploaded = await answer("mail:uploadAttachment", [{
    filename: "notes.txt",
    mimeType: "text/plain",
    fileBytes: Buffer.from(`${token} attachment`),
  }]);
  if (!uploaded || !uploaded.data || !String(uploaded.data.storageUrl).startsWith("local:")) {
    problem(problems, "attachment upload failed");
  }
  const withFile = await answer("mail:send", [{
    accountId,
    fromAddress: email,
    to: [email],
    subject: `${token} file`,
    body: `<p>${token} with file</p>`,
    attachments: uploaded && uploaded.data ? [{
      storageUrl: uploaded.data.storageUrl,
      filename: "notes.txt",
      mimeType: "text/plain",
    }] : [],
  }]);
  if (!withFile || withFile.success !== true) {
    problem(problems, `attachment send failed: ${withFile && withFile.error && withFile.error.message}`);
  }
  const filed = await answer("mail:listFromNetwork", [{ accountId, folderId: "INBOX", limit: 50 }]);
  const fileRow = filed && filed.data && filed.data.emails.find((item) => item.subject === `${token} file`);
  if (!fileRow || fileRow.hasAttachments !== true) problem(problems, "received message is missing its attachment");
  if (fileRow) {
    const bytes = await answer("mail:fetchAttachmentBytes", [{
      accountId,
      messageId: fileRow.id,
      filename: "notes.txt",
    }]);
    const text = bytes && bytes.data ? Buffer.from(bytes.data).toString("utf8") : "";
    if (!text.includes(`${token} attachment`)) problem(problems, "attachment bytes did not round-trip");
  }

  const drafted = await answer("mail:upsertDraft", [{
    accountId,
    to: [email],
    subject: `${token} draft`,
    body: `<p>${token} draft body</p>`,
  }]);
  if (!drafted || !drafted.data || !drafted.data.emailId) problem(problems, "draft save failed");
  const draftList = await answer("mail:listFromCache", [{ accountId, folderKey: "drafts", limit: 20 }]);
  const draftRow = draftList && draftList.data && draftList.data.emails.find((item) => item.subject === `${token} draft`);
  if (!draftRow) problem(problems, "draft is not in Drafts");

  const found = await answer("mail:search", [{ query: token, limit: 10, filters: {} }]);
  if (!found || found.success !== true || !Array.isArray(found.data) || !found.data.some((item) => String(item.subject || "").includes(token))) {
    problem(problems, "search did not find the live message");
  }

  await answer("mail:removeAccount", [{ accountId }]);

  if (problems.length) {
    console.error(problems.join("\n"));
    return 1;
  }
  console.log("MAIL_LIVE_OK");
  return 0;
}

module.exports = { run };
