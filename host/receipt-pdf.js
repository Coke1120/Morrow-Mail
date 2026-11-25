const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { receiptHtml, ReceiptError } = require("./receipt-pdf-document");

const PRINT_URL = "morrow://receipt-print/index.html";
const PREVIEW_URL = "morrow://receipt-preview/receipt-pdf-preview.html";
const PREVIEW_ORIGIN = "morrow://receipt-preview/";
const ASSET_DIR = path.join(__dirname, "..", "renderer");
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const CHANGED = "The source message or mailbox changed. Reopen the message in a separate Reader and try again.";
const UNOPENED = "Open the full message in this Reader before saving a PDF. If only a summary is available, retry the body download and reopen the message.";
const FILE_ERROR = "The PDF could not be saved. Check the destination and choose Save PDF to try again.";
const PREVIEW_ERROR = "The message PDF could not be previewed. Close the preview and try again.";
const SNAPSHOT_FIELDS = ["subject", "fromAddress", "date", "htmlBody", "textBody", "hasBody", "bodyComplete", "bodyWarning", "encodingWarning"];

function matches(email, source) {
  return email?.id === source.messageId && email.accountId === source.accountId && email.bodyEpoch === source.bodyEpoch;
}

async function withDeadline(operation, signal, ms, message) {
  let timer;
  let onAbort;
  try {
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new ReceiptError(CHANGED));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new ReceiptError(message)), ms);
      if (signal.aborted) onAbort();
    });
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (signal.aborted) throw new ReceiptError(CHANGED);
      return operation();
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function previewAsset(url) {
  if (!url.startsWith(PREVIEW_ORIGIN)) return null;
  const relative = url.slice(PREVIEW_ORIGIN.length);
  switch (relative) {
    case "receipt-pdf-preview.html": return [relative, "text/html; charset=utf-8"];
    case "receipt-pdf-preview.css": return [relative, "text/css; charset=utf-8"];
    case "receipt-pdf-preview.js":
    case "pdf-preview.bundle.js": return [relative, "text/javascript; charset=utf-8"];
    default:
      return /^vendor\/pdfjs\/(?:cmaps\/[\w-]+\.bcmap|standard_fonts\/[\w-]+\.(?:pfb|ttf))$/.test(relative)
        ? [relative, "application/octet-stream"] : null;
  }
}

function response(body, type) {
  return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
}

function isolate(electron, partition, settings) {
  // Separate memory-only sessions for print and preview. Jobs are serialized,
  // and each window is destroyed before its session policy is removed.
  const session = electron.session.fromPartition(partition, { cache: false });
  const denyDownload = event => event.preventDefault();
  const dispose = () => {
    session.webRequest.onBeforeRequest(null);
    session.setPermissionRequestHandler(null);
    session.setPermissionCheckHandler(null);
    session.removeListener("will-download", denyDownload);
    session.protocol.unhandle("morrow");
  };
  session.protocol.handle("morrow", settings.serve);
  try {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", denyDownload);
    session.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: details.method !== "GET" || !settings.allow(details),
    }));
    return { session, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function lockWindow(win) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    contents.on(event, e => e.preventDefault());
  }
}

const localPreferences = {
  sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
  spellcheck: false, devTools: false,
};

async function printPdf(electron, html, signal) {
  const isolated = isolate(electron, "receipt-pdf-print", {
    allow: details => details.url === PRINT_URL && details.resourceType === "mainFrame",
    serve(request) {
      if (request.method !== "GET" || request.url !== PRINT_URL || html === null) return new Response(null, { status: 404 });
      const result = response(html, "text/html; charset=utf-8");
      html = null;
      return result;
    },
  });
  let win;
  try {
    win = new electron.BrowserWindow({
      show: false,
      webPreferences: { ...localPreferences, session: isolated.session, javascript: false },
    });
    lockWindow(win);
    const output = await withDeadline(async () => {
      await win.loadURL(PRINT_URL);
      if (signal.aborted) throw new ReceiptError(CHANGED);
      return win.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: false });
    }, signal, 30000, "The message took too long to print. Try a shorter message.");
    if (!output?.length || output.length > MAX_PDF_BYTES) {
      throw new ReceiptError("The message PDF is empty or too large to preview. Try a shorter message.");
    }
    return output;
  } finally {
    html = null;
    try { if (win && !win.isDestroyed()) win.destroy(); } finally { isolated.dispose(); }
  }
}

function writePdf(destination, bytes) {
  const temporary = path.join(path.dirname(destination), `.morrow-receipt-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* The rename may already have consumed it. */ }
  }
}

async function showPreview(electron, parent, output, signal, verify) {
  let allowDocument = true;
  const isolated = isolate(electron, "receipt-pdf-preview", {
    allow(details) {
      if (details.resourceType === "mainFrame") return allowDocument && details.url === PREVIEW_URL;
      return details.resourceType !== "subFrame" && !!previewAsset(details.url) && details.url !== PREVIEW_URL;
    },
    async serve(request) {
      const asset = request.method === "GET" && previewAsset(request.url);
      if (!asset || (request.url === PREVIEW_URL && !allowDocument)) return new Response(null, { status: 404 });
      if (request.url === PREVIEW_URL) allowDocument = false;
      try { return response(await fs.promises.readFile(path.join(ASSET_DIR, asset[0])), asset[1]); }
      catch { return new Response(null, { status: 404 }); }
    },
  });
  let win;
  const close = () => { if (win && !win.isDestroyed()) win.destroy(); };
  try {
    win = new electron.BrowserWindow({
      parent, show: false, title: "Message PDF preview", width: 860, height: 760, minWidth: 420, minHeight: 320,
      webPreferences: { ...localPreferences, session: isolated.session, backgroundThrottling: false,
        preload: path.join(__dirname, "receipt-pdf-preview-preload.js") },
    });
    if (process.platform !== "darwin") win.removeMenu();
    lockWindow(win);
    const contents = win.webContents;
    const closed = new Promise(resolve => win.once("closed", resolve));
    signal.addEventListener("abort", close, { once: true });
    contents.once("render-process-gone", close);
    let navigated = false;
    let invalidated = false;
    const invalidate = () => {
      invalidated = true;
      setImmediate(close);
    };
    contents.on("did-start-navigation", (details, _url, _inPlace, isMainFrame) => {
      if (!(details?.isMainFrame ?? isMainFrame)) return;
      if (navigated) invalidate();
      navigated = true;
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) invalidate();
    });
    let delivered = false;
    let ready = false;
    let saving = false;
    const active = () => !invalidated && !signal.aborted && !win.isDestroyed();
    const trusted = event => active() && event.sender === contents && event.senderFrame === contents.mainFrame &&
      event.senderFrame?.url === PREVIEW_URL;
    contents.ipc.handle("receipt-pdf:bytes", event => {
      if (!trusted(event) || delivered) return null;
      delivered = true;
      return new Uint8Array(output);
    });
    contents.ipc.handle("receipt-pdf:ready", event => {
      if (!trusted(event) || !delivered) return false;
      ready = true;
      return true;
    });
    contents.ipc.handle("receipt-pdf:cancel", event => {
      if (trusted(event)) close();
    });
    contents.ipc.handle("receipt-pdf:save", async event => {
      if (!trusted(event) || !ready || saving) return {};
      saving = true;
      try {
        await verify();
        if (!trusted(event)) return {};
        const destination = await electron.dialog.showSaveDialog(win, {
          title: "Save message as PDF", defaultPath: "message-receipt.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!trusted(event) || destination.canceled || !destination.filePath) return {};
        await verify();
        if (!trusted(event)) return {};
        writePdf(destination.filePath, output);
        close();
        return {};
      } catch (error) {
        return { error: error instanceof ReceiptError ? error.message : FILE_ERROR };
      } finally {
        saving = false;
      }
    });

    await withDeadline(() => win.loadURL(PREVIEW_URL), signal, 10000, PREVIEW_ERROR);
    if (!active()) return;
    await verify();
    if (!active()) return;
    win.show();
    await closed;
  } finally {
    output = null;
    signal.removeEventListener("abort", close);
    try { close(); } finally { isolated.dispose(); }
  }
}

function createReceiptPdf({ electron, readCached, sourceFor, enabled }) {
  let busy = false;
  return async function saveReceipt(parent) {
    if (!enabled()) return;
    if (busy) {
      await electron.dialog.showMessageBox(parent, {
        type: "info", title: "Message PDF preview", message: "Close the current PDF preview before opening another.",
      }).catch(() => {});
      return;
    }
    busy = true;
    let source;
    try {
      source = sourceFor(parent);
      if (!source) throw new ReceiptError(UNOPENED);
      const { accountId, messageId: emailId, bodyEpoch, signal } = source;
      const check = () => {
        if (!enabled() || !source.isCurrent()) throw new ReceiptError(CHANGED);
      };
      const read = async () => {
        check();
        const shown = await withDeadline(source.renderedIdentity, signal, 4000, "The Reader did not respond. Reopen the message and try again.");
        check();
        if (!matches(shown, source)) throw new ReceiptError(CHANGED);
        const reply = readCached({ accountId, emailId, bodyEpoch });
        if (reply?.success !== true || !matches(reply.data?.email, source)) throw new ReceiptError(CHANGED);
        return reply.data.email;
      };
      const email = await read();
      const verify = async () => {
        const current = await read();
        if (SNAPSHOT_FIELDS.some(key => current[key] !== email[key])) throw new ReceiptError(CHANGED);
      };
      const bytes = await printPdf(electron, receiptHtml(email), signal);
      await verify();
      await showPreview(electron, parent, bytes, signal, verify);
    } catch (error) {
      if (!parent.isDestroyed() && !source?.signal.aborted) {
        await electron.dialog.showMessageBox(parent, {
          type: "warning", title: "Save message as PDF", message: error instanceof ReceiptError ? error.message : PREVIEW_ERROR,
        }).catch(() => {});
      }
    } finally {
      busy = false;
    }
  };
}

module.exports = { createReceiptPdf };
