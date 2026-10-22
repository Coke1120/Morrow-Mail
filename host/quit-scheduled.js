"use strict";

// Scheduled sends leave only while this process is alive. Quit, and a window
// close that means quit, share this decision so a missed warning cannot drop a
// pending message. On macOS the red close button hides the window and is not a
// quit; Cmd+Q still is. Windows and Linux window close still quits.

const QUIT_LIST_LIMIT = 5;

function pendingScheduled(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.status !== "failed");
}

function formatWhen(sendAt, format) {
  const when = sendAt ? new Date(sendAt) : null;
  if (!when || Number.isNaN(when.getTime())) return "Unknown time";
  if (typeof format === "function") return format(when);
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return when.toLocaleString() + (zone ? " (" + zone + ")" : "");
  } catch {
    return when.toISOString();
  }
}

function quitPrompt(rows, format) {
  const pending = pendingScheduled(rows);
  if (!pending.length) return null;
  const items = pending.slice(0, QUIT_LIST_LIMIT).map((row) => ({
    subject: String(row.subject || "").trim() || "(no subject)",
    sendAt: row.sendAt || "",
    time: formatWhen(row.sendAt, format),
    status: row.status === "sending" ? "sending" : "pending",
  }));
  return {
    count: pending.length,
    items,
    hidden: Math.max(0, pending.length - items.length),
  };
}

function uncertainPrompt() {
  return {
    count: 0,
    items: [],
    hidden: 0,
    uncertain: true,
    title: "Scheduled mail could not be checked",
    body: "Morrow Mail could not check pending scheduled messages. They will not send while the app is closed. Stay open to keep this app running.",
  };
}

function quitCopy(prompt) {
  const source = prompt || {};
  if (source.uncertain) {
    return {
      title: source.title || uncertainPrompt().title,
      body: source.body || uncertainPrompt().body,
    };
  }
  const count = Math.max(0, Number(source.count) || 0);
  const noun = count === 1 ? "message" : "messages";
  return {
    title: count === 1 ? "1 scheduled message is still pending" : `${count} scheduled messages are still pending`,
    body: `Scheduled ${noun} will not send while Morrow Mail is closed. A time that passes while the app is closed is sent the next time you open it.`,
  };
}

function promptPayload(prompt) {
  const copy = quitCopy(prompt);
  const source = prompt || {};
  return {
    title: copy.title,
    body: copy.body,
    count: Math.max(0, Number(source.count) || 0),
    items: Array.isArray(source.items) ? source.items : [],
    hidden: Math.max(0, Number(source.hidden) || 0),
    uncertain: source.uncertain === true,
  };
}

function nativeDetail(prompt) {
  const payload = promptPayload(prompt);
  const lines = payload.items.map((item) => {
    const subject = item.subject || "(no subject)";
    const time = item.time || "Unknown time";
    const sending = item.status === "sending" ? " (sending now)" : "";
    return `${subject} — ${time}${sending}`;
  });
  if (payload.hidden === 1) lines.push("1 more scheduled message.");
  else if (payload.hidden > 1) lines.push(`${payload.hidden} more scheduled messages.`);
  return lines.length ? `${payload.body}\n\n${lines.join("\n")}` : payload.body;
}

function nativeDialogOptions(prompt) {
  const payload = promptPayload(prompt);
  return {
    type: "warning",
    title: "Morrow Mail",
    message: payload.title,
    detail: nativeDetail(prompt),
    buttons: ["Stay open", "Quit anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function choiceAllowsQuit(choice) {
  return choice === "quit";
}

function nativeResponseChoice(response) {
  return response === 1 ? "quit" : "stay";
}

function readPrompt(listRows, format) {
  try {
    return quitPrompt(listRows(), format);
  } catch {
    return uncertainPrompt();
  }
}

// macOS keeps the process when the main window closes. Other platforms quit.
function hidesWindowOnClose(platform) {
  return platform === "darwin";
}

function createQuitController({ listRows, requestChoice, quitApp, cleanup, platform, format }) {
  let confirmed = false;
  let cleaning = false;
  let prompting = null;

  function startCleanup() {
    if (cleaning) return;
    cleaning = true;
    Promise.resolve()
      .then(() => cleanup())
      .catch(() => {})
      .finally(() => quitApp());
  }

  function startPrompt(prompt) {
    if (prompting || confirmed || cleaning) return;
    prompting = Promise.resolve()
      .then(() => requestChoice(prompt))
      .then((choice) => {
        if (!choiceAllowsQuit(choice) || confirmed || cleaning) return false;
        confirmed = true;
        quitApp();
        return true;
      })
      .catch(() => false)
      .finally(() => { prompting = null; });
  }

  function onClose(event) {
    // A real quit sets cleaning before Electron closes the window, because the
    // first before-quit is held until cleanup calls quit again. That close must
    // destroy the window. Every other macOS close hides and skips the confirm.
    if (confirmed || cleaning) return "allow";
    if (hidesWindowOnClose(platform) && !prompting) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      return "hide";
    }
    const prompt = readPrompt(listRows, format);
    if (!prompt) return "allow";
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    startPrompt(prompt);
    return "blocked";
  }

  function onBeforeQuit(event) {
    if (cleaning) return "allow";
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (confirmed) {
      startCleanup();
      return "cleanup";
    }
    const prompt = readPrompt(listRows, format);
    if (!prompt) {
      startCleanup();
      return "cleanup";
    }
    startPrompt(prompt);
    return "blocked";
  }

  return {
    onClose,
    onBeforeQuit,
    get confirmed() { return confirmed; },
    get cleaning() { return cleaning; },
  };
}

module.exports = {
  QUIT_LIST_LIMIT,
  pendingScheduled,
  quitPrompt,
  uncertainPrompt,
  quitCopy,
  promptPayload,
  nativeDetail,
  nativeDialogOptions,
  choiceAllowsQuit,
  nativeResponseChoice,
  hidesWindowOnClose,
  createQuitController,
};
