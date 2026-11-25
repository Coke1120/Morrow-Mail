"use strict";

// Real preview source/bundle and renderer integration; synthetic PDF/DOM/canvas only.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { renderer } = require("./check-ux-workflows");
const root = path.resolve(__dirname, "..");
const rawSource = fs.readFileSync(path.join(root, "renderer/pdf-preview.js"), "utf8");
const previewSource = text => text.replace(/\r\n/g, "\n").replace(/^import .*;\n/gm, "");
const source = previewSource(rawSource);
const bundle = fs.readFileSync(path.join(root, "renderer/pdf-preview.bundle.js"), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
function gate() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(check) {
  for (let i = 0; i < 1000 && !check(); i++) await tick();
  assert.ok(check(), "synthetic phase reached");
}
function descendants(node, className) {
  return node.childNodes.flatMap(child => [...(child.className === className ? [child] : []), ...descendants(child, className)]);
}

function fixture(actualBundle = false) {
  const nodes = new Map(), tasks = [], requested = [], paints = [], dimensions = [];
  const observers = [], resizes = [], frames = [];
  const controls = { total: 1, width: 595, height: 842, failPaint: false, text: null, getPage: null, render: null, destroy: null };
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.childNodes = []; this.attrs = {}; this.listeners = {}; this.dataset = {};
      this.className = ""; this.hidden = false; this.clientWidth = 880;
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.context = new Proxy({ canvas: this, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: () => ({ width: 10 }), save: () => { if (controls.failPaint) throw Error("synthetic paint failure"); },
      }, { get: (target, key) => key in target ? target[key] : () => {} });
    }
    set width(value) { this._width = value; dimensions.push(value); }
    get width() { return this._width || 0; }
    set height(value) { this._height = value; dimensions.push(value); }
    get height() { return this._height || 0; }
    get textContent() { return (this._text || "") + this.childNodes.map(child => child.textContent).join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.childNodes.push(child); } }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { for (const child of this.childNodes) child.parent = null; this.childNodes = []; this._text = ""; this.append(...children); }
    remove() { if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    click() { this.listeners.click?.(); }
    focus() { document.activeElement = this; }
    contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
    querySelector() { return null; }
    getContext() { return this.context; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document = { createElement: tag => new Element(tag), getElementById: node, querySelectorAll: () => [], activeElement: null };
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
    emit(target, isIntersecting) { this.callback([{ target, isIntersecting }]); }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; resizes.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const getDocument = options => {
    assert.equal(options.isEvalSupported, false); assert.equal(options.disableFontFace, true);
    assert.equal(options.useSystemFonts, false); assert.equal(options.useWorkerFetch, false);
    assert.match(options.cMapUrl, /^file:.*vendor\/pdfjs\/cmaps\/$/);
    const task = { options, destroyed: false, destroy() { this.destroyed = true; return controls.destroy?.() || Promise.resolve(); } };
    tasks.push(task);
    task.promise = Promise.resolve({ numPages: controls.total, async getPage(number) {
      requested.push(number);
      const controlled = controls.getPage?.(number);
      if (controlled !== undefined) return controlled;
      return { getViewport: ({ scale }) => ({ width: controls.width * scale, height: controls.height * scale }),
        getTextContent: () => controls.text ? controls.text(number) : Promise.resolve({ items: [{ str: "Synthetic page " + number, hasEOL: true }, { str: "<script>inert</script>" }] }),
        render(options) {
          paints.push({ number, ...options });
          if (controls.render) return controls.render(number);
          return { promise: controls.failPaint ? Promise.reject(Error("synthetic paint failure")) : Promise.resolve(), cancel() {} };
        }, cleanup() {},
      };
    } });
    return task;
  };
  const window = { location: { href: "file:///synthetic/renderer/index.html" }, devicePixelRatio: 2,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
  const globals = { window, document, console, URL, Uint8Array, ArrayBuffer, AbortController, AbortSignal,
    TextDecoder, TextEncoder, ReadableStream, structuredClone, setTimeout, clearTimeout, performance,
    getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0" }), IntersectionObserver, ResizeObserver,
    requestAnimationFrame: callback => { frames.push(callback); },
    getDocument, PDFWorker: class {}, WorkerMessageHandler: {},
    fetch: async () => { throw Error("network forbidden in synthetic fixture"); },
    Path2D: class { addPath() {} },
  };
  const context = vm.createContext(globals);
  // Electron's Chromium provides this API; Node 20 CI does not. Supply it only
  // in the synthetic renderer realm, without changing the host or PDF bundle.
  vm.runInContext(`
    if (typeof Promise.withResolvers !== "function") {
      Object.defineProperty(Promise, "withResolvers", { configurable: true, writable: true, value: function () {
        let resolve, reject;
        const promise = new this((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      } });
    }
  `, context);
  vm.runInContext(actualBundle ? bundle : source, context, { filename: actualBundle ? "pdf-preview.bundle.js" : "pdf-preview.js" });
  const pages = node("attachment-preview-pages"), stage = node("attachment-preview-stage");
  const controller = new AbortController();
  const render = (options = {}) => window.morrowPdf.render({ data: Uint8Array.of(1), pages, stage, signal: controller.signal, ...options });
  return { globals, window, document, node, pages, stage, controls, tasks, requested, paints, dimensions, observers, resizes, controller, render,
    resize(width) { pages.clientWidth = width; resizes.at(-1).callback(); for (const callback of frames.splice(0)) callback(); },
  };
}

async function semanticsAndRetry() {
  const f = fixture(); f.controls.total = 2;
  await f.render(); await until(() => f.pages.childNodes.length === 2);
  const [first, second] = f.pages.childNodes;
  assert.equal(first.getAttribute("role"), "group"); assert.equal(first.getAttribute("aria-label"), "Page 1 of 2");
  const text = descendants(first, "sr")[0], canvas = descendants(first, "attachment-preview-page")[0];
  assert.equal(canvas.getAttribute("aria-hidden"), "true");
  assert.equal(text.textContent, "Synthetic page 1\n<script>inert</script>"); assert.equal(text.childNodes.length, 0, "PDF text never becomes HTML");
  assert.match(second.textContent, /Synthetic page 2/, "offscreen pages expose text before painting");
  const observer = f.observers[0]; observer.emit(first, false); assert.match(text.textContent, /Synthetic page 1/, "bitmap eviction retains semantics");
  observer.emit(first, true); await until(() => f.paints.length === 2);
  f.controls.failPaint = true; f.resize(700);
  await until(() => descendants(first, "attachment-preview-page-error").length === 1);
  const note = descendants(first, "attachment-preview-page-error")[0];
  assert.equal(note.getAttribute("role"), "status"); assert.equal(canvas.hidden, true);
  assert.match(text.textContent, /Synthetic page 1/, "render failure retains extracted text");
  f.controls.failPaint = false; f.resize(880);
  await until(() => descendants(first, "attachment-preview-page-error").length === 0);
  assert.equal(f.paints.length, 4, "return to the old successful width actually repaints after failure");
  assert.equal(canvas.hidden, false);
  f.controls.failPaint = true; f.resize(600);
  await until(() => descendants(first, "attachment-preview-page-error").length === 1);
  const retry = descendants(first, "attachment-preview-page-error")[0].childNodes[0];
  assert.equal(retry.textContent, "Retry"); assert.equal(retry.getAttribute("aria-label"), "Retry page 1");
  f.controls.failPaint = false; retry.focus(); retry.click();
  await until(() => descendants(first, "attachment-preview-page-error").length === 0);
  assert.equal(f.document.activeElement, f.stage, "successful Retry keeps focus inside the preview");
  assert.equal(f.paints.length, 6);
  f.controller.abort(); assert.ok(f.tasks[0].destroyed && observer.disconnected && f.resizes[0].disconnected);
  const count = f.paints.length; retry.click(); f.resize(500); await tick(); assert.equal(f.paints.length, count, "stale Retry/resize cannot revive a closed preview");
}

async function longDocument() {
  const f = fixture(); f.controls.total = 3000;
  let admitted;
  const heartbeat = new Promise(resolve => {
    void f.render({ onFirstPage() { setTimeout(() => { admitted = f.pages.childNodes.length; f.controller.abort(); resolve(); }, 0); } });
  });
  await heartbeat; await tick();
  assert.ok(admitted > 0 && admitted <= 9, "input runs before a long document is admitted");
  assert.equal(f.pages.childNodes.length, admitted); assert.equal(f.requested.length, admitted, "abort stops further getPage calls");
  assert.ok(f.tasks[0].destroyed); assert.equal(f.pages.getAttribute("aria-busy"), null);
  const middle = fixture(), heartbeatLater = gate(); middle.controls.total = 3000;
  const append = middle.pages.appendChild.bind(middle.pages);
  middle.pages.appendChild = slot => {
    append(slot);
    if (middle.pages.childNodes.length === 9) setTimeout(() => { admitted = middle.pages.childNodes.length; middle.controller.abort(); heartbeatLater.resolve(); }, 0);
  };
  await middle.render(); await heartbeatLater.promise; await tick();
  assert.ok(admitted >= 9 && admitted <= 17, "later batches also yield to input and cancellation");
  assert.equal(middle.requested.length, admitted);
  const progressive = fixture(); progressive.controls.total = 18; await progressive.render();
  await until(() => progressive.pages.childNodes.length === 18);
  assert.equal(descendants(progressive.pages, "sr").length, 18);
  assert.match(progressive.pages.childNodes[17].textContent, /Synthetic page 18/); progressive.controller.abort();
}

async function limitsAndFailures() {
  for (const [width, height] of [[595, 842], [1, 50000], [50000, 1]]) {
    const f = fixture(); Object.assign(f.controls, { width, height }); await f.render();
    const canvas = descendants(f.pages, "attachment-preview-page")[0];
    for (const displayedWidth of [700, 880]) { f.resize(displayedWidth); await tick(); }
    f.observers[0].emit(f.pages.childNodes[0], false);
    f.observers[0].emit(f.pages.childNodes[0], true); await tick();
    assert.ok(f.dimensions.every(value => value >= 1 && value <= 4096), "initial, resize and placeholder canvas dimensions stay bounded");
    assert.ok(f.paints.every(paint => paint.viewport.width <= 4096 && paint.viewport.height <= 4096), "both viewport axes are capped");
    assert.ok(canvas.width <= 4096 && canvas.height <= 4096); f.controller.abort();
  }
  const empty = fixture(); empty.controls.text = async () => ({ items: [] }); await empty.render();
  assert.match(empty.pages.textContent, /No extractable text/); empty.controller.abort();
  const failedText = fixture(); failedText.controls.text = async () => { throw Error("synthetic extraction failure"); }; await failedText.render();
  assert.match(failedText.pages.textContent, /Text could not be extracted/); assert.equal(failedText.paints.length, 1); failedText.controller.abort();
  const first = fixture(); first.controls.failPaint = true;
  await assert.rejects(first.render(), /synthetic paint failure/); assert.ok(first.tasks[0].destroyed, "first-page failure still reaches the caller and destroys the document");
  const password = fixture();
  password.controls.getPage = () => { throw Object.assign(Error("password"), { name: "PasswordException" }); };
  await assert.rejects(password.render(), { name: "PasswordException" }); assert.ok(password.tasks[0].destroyed);
  const later = fixture(); later.controls.total = 3;
  later.controls.getPage = number => { if (number === 2) throw Error("page failure"); };
  await later.render(); await until(() => later.pages.childNodes.length === 3);
  assert.match(later.pages.childNodes[1].textContent, /This page could not be previewed/);
  assert.match(later.pages.childNodes[2].textContent, /Synthetic page 3/, "page retrieval failure does not stop later pages"); later.controller.abort();
  const laterRender = fixture(); laterRender.controls.total = 2; await laterRender.render();
  await until(() => laterRender.pages.childNodes.length === 2);
  laterRender.controls.failPaint = true; laterRender.observers[0].emit(laterRender.pages.childNodes[1], true);
  await until(() => descendants(laterRender.pages, "attachment-preview-page-error").length === 1);
  assert.match(laterRender.pages.childNodes[1].textContent, /Synthetic page 2/);
  laterRender.controls.failPaint = false;
  laterRender.observers[0].emit(laterRender.pages.childNodes[1], false); laterRender.observers[0].emit(laterRender.pages.childNodes[1], true);
  await until(() => descendants(laterRender.pages, "attachment-preview-page-error").length === 0); laterRender.controller.abort();
  const noPages = fixture(); noPages.controls.total = 0;
  await assert.rejects(noPages.render(), { name: "InvalidPDFException" }); assert.ok(noPages.tasks[0].destroyed);
}

async function cancellationAndIntegration() {
  const preAborted = fixture(); preAborted.controller.abort(); await preAborted.render(); assert.equal(preAborted.tasks.length, 0);
  const firstPaintAbort = fixture(); let extractionsAfterClose = 0;
  firstPaintAbort.controls.text = async () => { extractionsAfterClose++; return { items: [] }; };
  await firstPaintAbort.render({ onFirstPage: () => firstPaintAbort.controller.abort() });
  assert.ok(firstPaintAbort.tasks[0].destroyed); assert.equal(extractionsAfterClose, 0, "no extraction starts after Close");
  const latePage = fixture(), pageResult = gate(); latePage.controls.total = 2;
  latePage.controls.getPage = number => number === 2 ? pageResult.promise : undefined;
  await latePage.render(); await until(() => latePage.requested.length === 2);
  latePage.controller.abort(); latePage.pages.replaceChildren();
  let lateViewports = 0;
  pageResult.resolve({ getViewport() { lateViewports++; return { width: 595, height: 842 }; } }); await tick();
  assert.equal(lateViewports, 0, "cancelled page must never be admitted"); assert.equal(latePage.pages.childNodes.length, 0);
  const painting = fixture(), painted = gate(), events = [];
  painting.controls.render = () => ({ promise: painted.promise, cancel() {
    events.push("cancel"); painted.reject(Object.assign(Error("cancelled"), { name: "RenderingCancelledException" }));
  } });
  painting.controls.destroy = () => { events.push("destroy"); return Promise.resolve(); };
  const active = painting.render(); await until(() => painting.paints.length === 1);
  painting.controller.abort(); await active; assert.deepEqual(events, ["cancel", "destroy"], "active drawing stops before document destruction");
  assert.equal(descendants(painting.pages, "attachment-preview-page-error").length, 0, "cancellation stays silent");
  const f = fixture(), heldText = gate(), destroyed = gate();
  f.controls.text = () => heldText.promise; f.controls.destroy = () => destroyed.promise;
  const pending = f.render(); await until(() => f.paints.length === 1);
  f.controller.abort(); f.pages.replaceChildren();
  const replacementController = new AbortController();
  const replacement = f.render({ signal: replacementController.signal });
  await tick(); assert.equal(f.tasks.length, 1, "new PDF waits for prior destruction");
  heldText.resolve({ items: [{ str: "stale secret-free fixture" }] }); await pending;
  assert.equal(f.pages.childNodes.length, 0, "late text cannot repopulate a closed preview");
  destroyed.resolve(); await replacement; assert.equal(f.tasks.length, 2);
  replacementController.abort();
  const integration = fixture(), texts = gate(), calls = [], listeners = new Set();
  integration.controls.text = () => texts.promise;
  vm.runInNewContext(fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8"), {
    require(name) { assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld(name, bridge) { assert.equal(name, "morrow"); integration.window.morrow = bridge; } },
      ipcRenderer: { on: (_channel, fn) => listeners.add(fn), removeListener: (_channel, fn) => listeners.delete(fn),
        async invoke(channel, params) {
          calls.push({ channel, params }); assert.equal(channel, "mail:fetchAttachmentBytes");
          return { success: true, data: Uint8Array.of(1) };
        } },
    }; },
  });
  await assert.rejects(integration.window.morrow.invoke("pdf:executeScript"), /Unsupported channel/);
  assert.equal(calls.length, 0, "unknown channels never reach IPC");
  const ui = renderer({ ...integration.globals, crypto: require("node:crypto").webcrypto });
  ui.run("openDialog=()=>{$('attachment-preview').open=true;};");
  const opened = ui.run("previewAttachment({id:'synthetic-message',from:'Alder Paper <alder@example.invalid>'}, {id:'synthetic-pdf',filename:'fixture.pdf',mimeType:'application/pdf'})");
  await until(() => integration.paints.length === 1);
  assert.equal(calls.length, 1); assert.equal(integration.node("attachment-preview-status").hidden, true);
  assert.equal(calls[0].params.emailId, "synthetic-message"); assert.equal(calls[0].params.attachmentId, "synthetic-pdf");
  const sender = integration.node("attachment-preview-from");
  assert.equal(sender.hidden, false);
  assert.match(sender.textContent, /Alder Paper <alder@example[.]invalid>/);
  assert.equal(integration.node("attachment-preview-arrange").hidden, true, "arrangement belongs to separate readers");
  ui.run("clearAttachmentPreview()"); texts.resolve({ items: [{ str: "late integration text" }] }); await opened;
  assert.ok(integration.tasks[0].destroyed); assert.equal(integration.pages.childNodes.length, 0); assert.equal(integration.pages.hidden, true);
  assert.equal(sender.textContent, "", "closing the preview clears its source");
  assert.equal(sender.hidden, true);
  assert.equal(listeners.size, 0, "attachment progress subscription is released");
  assert.equal(integration.stage.contains(integration.document.activeElement), false);
}

function syntheticPdf(total = 1, width = 595, height = 842, body = "Synthetic accessible PDF body") {
  const text = `BT /F1 12 Tf 10 20 Td (${body}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${total} /Kids [${Array.from({ length: total }, (_, i) => `${i + 5} 0 R`).join(" ")}] >>`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < total; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>`);
  let pdf = "%PDF-1.7\n", offsets = [0];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return Uint8Array.from(Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
}

async function composeReplacementPreview() {
  const f = fixture(true), ui = renderer(f.globals);
  const oldPdf = syntheticPdf(1, 595, 842, "HKD 1,240");
  const replacement = syntheticPdf(1, 595, 842, "HKD 1,340");
  assert.equal(oldPdf.byteLength, replacement.byteLength);
  const compose = f.node("compose"), dialog = f.node("attachment-preview"), list = f.node("compose-attachments");
  compose.id = "compose"; compose.open = true; compose.close = () => { compose.open = false; };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.listeners.close(); };
  f.document.querySelectorAll = selector => selector === "dialog[open]" && compose.open ? [compose] : [];
  const previews = () => descendants(list, "ghost").filter(button => button.dataset.composePdf);
  list.querySelectorAll = previews;
  f.node("compose-body").value = "Unsaved edits";

  const calls = [];
  ui.context.callUpload = async (channel, payload) => {
    calls.push(channel);
    assert.equal(channel, "mail:uploadAttachment");
    assert.deepEqual(payload.fileBytes, replacement);
    return { filename: payload.filename, mimeType: payload.mimeType, size: replacement.byteLength, storageUrl: "local:replacement" };
  };
  ui.context.file = { name: "quote.pdf", size: replacement.byteLength, type: "", arrayBuffer: async () => replacement.buffer.slice(0) };
  ui.run(`syncComposeActions = () => {}; paintComposeNote = () => {}; call = callUpload;
    $('attachment-preview').addEventListener('close', finishAttachmentPreview);
    state.composeAttachments = [{ filename: 'quote.pdf', size: file.size, storageUrl: 'local:saved' }];
    paintComposeAttachments();`);
  assert.equal(previews().length, 0, "saved attachment has no current-session bytes");
  await ui.run("removeComposeAttachment('local:saved'); addComposeFiles([file])");
  assert.equal(previews().length, 1);
  const button = previews()[0];
  assert.equal(button.type, "button");
  assert.equal(button.getAttribute("aria-label"), "Preview quote.pdf");
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(attachmentPayload(state.composeAttachments))")), [
    { storageUrl: "local:replacement", filename: "quote.pdf", mimeType: "application/octet-stream", size: replacement.byteLength, id: "local:replacement" },
  ]);

  const snapshot = ui.run("composeSnapshot()");
  for (let count = 0; count < 2; count++) {
    previews()[0].click();
    await until(() => /HKD 1,340/.test(f.pages.textContent));
    assert.doesNotMatch(f.pages.textContent, /HKD 1,240/);
    ui.run("syncAttachmentPreview({id:'background-refresh'}); paintComposeAttachments()");
    assert.equal(dialog.open, true, "reader refresh preserves the Compose preview");
    ui.run("closeAttachmentPreview()");
    assert.equal(f.pages.textContent, "");
    assert.equal(f.document.activeElement, previews()[0], "Close focuses the rebuilt attachment button");
    assert.equal(compose.open, true);
    assert.equal(ui.run("composeSnapshot()"), snapshot, "preview preserves the current draft and edits");
  }
  assert.deepEqual(calls, ["mail:uploadAttachment"], "opening either preview uses the retained bytes");
  ui.run("removeComposeAttachment('local:replacement')");
  assert.equal(previews().length, 0);
  assert.equal(ui.run("state.composePdfBytes.size"), 0, "removal releases the retained bytes");

  await ui.run("addComposeFiles([file])");
  const upload = gate(), waiting = gate();
  ui.context.lateUpload = () => { waiting.resolve(); return upload.promise; };
  const pending = ui.run("call = lateUpload; addComposeFiles([file])");
  await waiting.promise;
  ui.run("state.composeBaseline = composeSnapshot()");
  assert.equal(await ui.run("requestComposeClose()"), true);
  assert.equal(ui.run("state.composePdfBytes.size"), 0, "closing Compose clears accepted bytes");
  upload.resolve({ filename: "quote.pdf", size: replacement.byteLength, storageUrl: "local:late" });
  await pending;
  assert.equal(ui.run("state.composePdfBytes.size"), 0, "an upload finishing after close cannot retain its bytes");
}

async function resumedDraftPdfPreview() {
  const f = fixture(true);
  const revised = syntheticPdf(2, 595, 842, "HKD 1,340");
  const original = syntheticPdf(2, 595, 842, "HKD 1,240");
  assert.equal(revised.byteLength, original.byteLength);
  const files = ["revised", "original"].map(key => ({
    id: "legacy-" + key, storageUrl: "local:" + key, filename: "quote.pdf",
    mimeType: "application/pdf", size: original.byteLength,
  }));
  const provider = { ...files[0], id: "revised", storageUrl: undefined };
  let saved = { id: "draft", accountId: "box", bodyEpoch: 7, draftRevision: "before-save", isDraft: true,
    bodyComplete: true, fromAddress: "owner@example.invalid", textBody: "Saved text", attachments: [...files, provider] };
  const calls = [];
  let pendingRead, composeSeed;
  f.window.morrow = { openComposeWindow(seed) { composeSeed = seed; }, async invoke(channel, params) {
    calls.push({ channel, params });
    const ok = data => ({ success: true, data });
    if (channel === "mail:openEmail") return ok({ email: saved });
    if (channel === "mail:prepareDraft") {
      return ok({ email: { ...saved, attachments: [...files, { ...provider, id: "hydrated", storageUrl: "local:hydrated" }] } });
    }
    if (channel === "mail:readCachedBody") {
      assert.deepEqual({ ...params }, { emailId: "draft", accountId: "box", bodyEpoch: 7 });
      return ok({ email: saved });
    }
    if (channel === "mail:fetchAttachmentBytes") {
      assert.equal(params.messageId, "draft");
      assert.equal(params.accountId, "box");
      const file = saved.attachments.find(file => file.id === params.attachmentId);
      assert.ok(file?.storageUrl, "fetch uses the saved attachment ID, even if a provider ID equals its blob ID");
      if (pendingRead) await pendingRead.promise;
      return ok(file.storageUrl === "local:revised" ? revised : original);
    }
    if (channel === "mail:upsertDraft") {
      assert.equal(params.draftRevision, saved.draftRevision);
      saved = { ...saved, draftRevision: "after-save",
        attachments: params.attachments.map(file => ({ ...file, id: file.storageUrl.slice(6) })) };
      return ok({ emailId: saved.id, draftRevision: saved.draftRevision });
    }
    assert.equal(channel, "mail:cancelAttachmentRequest");
    return ok(true);
  } };
  const ui = renderer({ ...f.globals, crypto: require("node:crypto").webcrypto });
  const compose = f.node("compose"), dialog = f.node("attachment-preview"), list = f.node("compose-attachments");
  compose.id = "compose"; dialog.id = "attachment-preview";
  dialog.close = () => { dialog.open = false; dialog.listeners.close(); };
  f.document.querySelectorAll = selector => selector === "dialog[open]" ? [compose, dialog].filter(node => node.open) : [];
  const buttons = prefix => descendants(list, "ghost").filter(button => button.getAttribute("aria-label").startsWith(prefix));
  const previews = () => buttons("Preview ");
  list.querySelectorAll = previews;
  ui.run(`
    state.accounts = [{id:'box', email:'owner@example.invalid', platform:'imap'}];
    openDialog = id => { $(id).open = true; };
    initializeComposeIdentity = async () => {}; fillSignatures = async () => {}; showComposeSuggestions = async () => {};
    syncCompose = paintComposeAttachments; paintComposeNote = () => {}; paintComposeEditor = () => {};
    paintComposeChrome = () => {}; paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    syncScheduleFields = () => {}; setAiMode = () => {}; showStatus = () => {};
    $('attachment-preview').addEventListener('close', finishAttachmentPreview);
  `);
  await ui.run("resumeDraft({id:'draft',accountId:'box'})");
  assert.deepEqual(JSON.parse(JSON.stringify(composeSeed.draftPdf)), {
    id: "draft", accountId: "box", bodyEpoch: 7, draftRevision: "before-save",
    files: files.map(({ id, storageUrl }) => ({ id, storageUrl })),
  });
  ui.context.resumedSeed = composeSeed;
  await ui.run("openCompose(resumedSeed)");
  assert.deepEqual(calls.map(call => call.channel), ["mail:openEmail", "mail:prepareDraft"]);
  assert.deepEqual(previews().map(button => button.getAttribute("aria-label")), [
    "Preview quote.pdf, attachment 1 of 3", "Preview quote.pdf, attachment 2 of 3",
  ], "a prepared provider-only PDF is excluded");
  assert.equal(new Set(buttons("Remove ").map(button => button.getAttribute("aria-label"))).size, 3);
  f.node("compose-body").value = "Unsaved recommendation";
  const dirty = ui.run("composeSnapshot()");
  const fetchIds = () => calls.filter(call => call.channel === "mail:fetchAttachmentBytes").map(call => call.params.attachmentId);
  async function inspect(index, amount) {
    previews()[index].click();
    await until(() => f.pages.childNodes[1]?.textContent.includes(amount));
    assert.equal(f.node("attachment-preview-arrange").hidden, true);
    ui.run("paintComposeAttachments(); closeAttachmentPreview()");
    assert.equal(f.document.activeElement, previews()[index]);
    assert.equal(ui.run("composeSnapshot()"), dirty);
  }
  await inspect(0, "HKD 1,340");
  await inspect(1, "HKD 1,240");
  assert.deepEqual(fetchIds(), ["legacy-revised", "legacy-original"]);
  assert.equal(calls.some(call => call.channel === "mail:upsertDraft"), false, "preview never saves the dirty editor");
  assert.equal(await ui.run("saveDraft()"), true);
  await inspect(0, "HKD 1,340");
  assert.equal(fetchIds().at(-1), "revised", "after Save the confirmed revision supplies the normalized ID");

  pendingRead = gate();
  previews()[1].click();
  await until(() => fetchIds().length === 4);
  const request = calls.at(-1).params;
  ui.run("closeAttachmentPreview()");
  assert.equal(calls.at(-1).params.requestId, request.requestId);
  assert.equal(calls.at(-1).channel, "mail:cancelAttachmentRequest");
  pendingRead.resolve();
  await tick();
  assert.equal(f.pages.childNodes.length, 0, "late bytes cannot reopen a closed preview");
  assert.equal(f.document.activeElement, previews()[1]);

  pendingRead = gate();
  previews()[1].click();
  await until(() => fetchIds().length === 5);
  saved = { ...saved, draftRevision: "changed-elsewhere" };
  pendingRead.resolve();
  await until(() => /saved draft or attachment changed/.test(f.node("attachment-preview-status").textContent));
  assert.equal(f.pages.childNodes.length, 0, "a newer saved revision blocks stale bytes");
  ui.run("closeAttachmentPreview()");
  buttons("Remove ")[1].click();
  assert.deepEqual(previews().map(button => button.dataset.composePdf), ["local:revised"]);
  assert.equal(f.node("compose-body").value, "Unsaved recommendation");
}

async function receivingDraftInboxPicker() {
  const f = fixture();
  f.window.location.search = "?role=compose";
  const draft = { id: "draft", accountId: "box", bodyEpoch: 0, draftRevision: "saved", isDraft: true, bodyComplete: true,
    fromAddress: "owner@example.invalid", to: ["To <to@example.invalid>"], cc: ["cc@example.invalid"],
    bcc: ["bcc@example.invalid"], textBody: "Saved text", attachments: [] };
  const file = { id: "2", filename: "Inbox quote.pdf", size: 7, proof: "opaque-proof" };
  const local = { id: "blob", storageUrl: "local:blob", filename: file.filename, size: file.size, mimeType: "application/pdf" };
  const sources = [{ id: "source", from: "Source <source@example.invalid>", subject: "Source quote",
    date: "2026-11-24T08:00:00Z", files: [file] }];
  const olderCursor = "opaque-older-page";
  const calls = [];
  let seed, pending, pendingList, pendingPin;
  f.window.morrow = { openComposeWindow(fields) { seed = fields; }, async invoke(channel, params) {
    calls.push({ channel, params });
    let data;
    if (channel === "mail:openEmail") data = { email: draft };
    else if (channel === "mail:listFromCache") {
      assert.equal(params.strictLocal, true);
      assert.equal(params.inboxAttachmentReview.bodyEpoch, 0);
      if (params.checkDraft) data = { current: true };
      else if (pendingList) data = await pendingList.promise;
      else if (params.cursor === olderCursor) data = { sources: [], nextCursor: null };
      else {
        assert.equal(params.cursor, null);
        data = { sources, nextCursor: olderCursor };
      }
    } else if (channel === "mail:prepareDraft") {
      assert.equal(params.strictLocal, true);
      const choice = { emailId: "source", partId: "2", proof: file.proof };
      if (params.pinSelection) {
        assert.deepEqual(JSON.parse(JSON.stringify(params.parts)), [choice]);
        if (pendingPin) await pendingPin.promise;
        data = { attachments: [{ contentProof: "checked-bytes" }] };
      } else {
        assert.deepEqual(JSON.parse(JSON.stringify(params.parts)), [{ ...choice, contentProof: "checked-bytes" }]);
        if (pending) await pending.promise;
        data = { attachments: [{ filename: file.filename, mimeType: local.mimeType, bytes: Buffer.from("fixture"), size: 7 }] };
      }
    } else if (channel === "mail:uploadAttachment") {
      assert.equal(Buffer.from(params.fileBytes).toString(), "fixture");
      data = local;
    } else {
      assert.equal(channel, "mail:cancelAttachmentRequest");
      data = true;
    }
    return { success: true, data };
  } };
  const ui = renderer({ ...f.globals, URLSearchParams, crypto: require("node:crypto").webcrypto });
  const pickerScript = path.join(root, "renderer/compose-attachments.js");
  vm.runInContext(fs.readFileSync(pickerScript, "utf8"), ui.context, { filename: pickerScript });
  const dialog = f.node("compose-inbox-picker");
  for (const id of ["compose", "compose-inbox-picker", "compose-close-review"]) {
    const node = f.node(id);
    node.showModal = () => { node.open = true; };
    node.close = () => { node.open = false; node.listeners.close?.(); };
  }
  ui.run(`
    state.accounts = [{id:"box", email:"owner@example.invalid", platform:"imap", bodyEpoch:0}];
    initializeComposeIdentity = async () => {}; fillSignatures = async () => {}; showComposeSuggestions = async () => {};
    syncCompose = () => { syncComposeActions(); paintComposeAttachments(); }; paintComposeNote = () => {}; paintComposeEditor = () => {};
    paintComposeChrome = () => {}; paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    syncScheduleFields = () => {}; setAiMode = () => {}; showStatus = () => {};
    wireComposeInboxPicker();
  `);
  await ui.run("resumeDraft({id:'draft',accountId:'box'})");
  assert.equal(seed.draftBodyEpoch, 0);
  assert.equal(seed.draftPdf, undefined, "receiving scope is independent of existing PDFs or attachments");
  ui.context.inboxSeed = seed;
  await ui.run("openCompose(inboxSeed)");
  const confirm = f.node("compose-inbox-confirm");
  const list = f.node("compose-inbox-sources");
  const status = f.node("compose-inbox-status");
  const openPicker = async () => {
    f.node("compose-attach-inbox").click();
    await until(() => list.childNodes.length > 0);
  };
  const checkbox = () => descendants(list, "check")[0].childNodes[0];
  const checkFile = async () => {
    assert.equal(confirm.disabled, true);
    assert.match(list.textContent, /Source quote.*Source <source@example\.invalid>.*Inbox quote\.pdf · 7 B/);
    const input = checkbox();
    assert.equal(input.type, "checkbox");
    assert.equal(input.getAttribute("aria-describedby"), list.childNodes[0].childNodes[1].id);
    assert.equal(Boolean(input.checked), false);
    input.checked = true;
    await input.listeners.change();
    assert.equal(confirm.disabled, false);
  };
  const choose = async () => {
    await openPicker();
    await checkFile();
  };
  assert.equal(f.node("compose-attach-inbox").disabled, false);
  await choose();
  assert.deepEqual(["to", "cc", "bcc"].map(field => f.node("compose-inbox-" + field).textContent), [
    draft.to[0], draft.cc[0], draft.bcc[0],
  ]);
  assert.equal(f.node("compose-save").disabled, true);
  const older = f.node("compose-inbox-older"), newer = f.node("compose-inbox-newer");
  assert.equal(older.disabled, false);
  older.click();
  await until(() => !newer.disabled);
  assert.equal(calls.at(-1).params.cursor, olderCursor);
  assert.equal(confirm.disabled, true);
  assert.equal(list.childNodes.length, 0);
  newer.click();
  await until(() => list.childNodes.length > 0);
  assert.equal(calls.at(-1).params.cursor, null);
  await checkFile();

  const before = ui.run("composeSnapshot()");
  pending = gate();
  const cancelled = ui.run("confirmComposeInboxFiles()");
  const requestId = calls.at(-1).params.requestId;
  assert.equal(Boolean(f.node("compose-inbox-cancel").disabled), false);
  let escaped = false;
  dialog.listeners.cancel({ preventDefault() { escaped = true; } });
  assert.equal(escaped, true);
  assert.equal(dialog.open, false);
  assert.equal(calls.at(-1).params.requestId, requestId);
  pending.resolve();
  await cancelled;
  assert.equal(ui.run("composeSnapshot()"), before, "a late result after Escape cannot attach");

  await choose();
  pending = gate();
  const stale = ui.run("confirmComposeInboxFiles()");
  f.node("compose-bcc").value = "updated@example.invalid";
  pending.resolve();
  await stale;
  assert.equal(dialog.open, false);
  assert.equal(ui.run("state.composeAttachments.length"), 0, "a late result for old recipients cannot attach");

  const staleList = gate();
  pendingList = staleList;
  f.node("compose-attach-inbox").click();
  assert.equal(calls.at(-1).channel, "mail:listFromCache");
  assert.equal(status.textContent, "Checking stored Inbox files…");
  dialog.listeners.cancel({ preventDefault() {} });
  pendingList = null;
  await choose();
  const currentInput = checkbox();
  staleList.resolve({ sources: [], nextCursor: null });
  await tick();
  assert.ok(list.contains(currentInput), "a late page cannot replace the reopened picker");
  assert.equal(status.textContent, "1 selected.");
  assert.equal(confirm.disabled, false);
  dialog.listeners.cancel({ preventDefault() {} });

  await choose();
  pending = null;
  await ui.run("confirmComposeInboxFiles()");
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(state.composeAttachments)")), [local]);
  assert.equal(dialog.open, false);
  assert.equal(f.node("compose-body").value, draft.textBody);
  ui.run('removeComposeAttachment("local:blob")');

  const unsavedTo = "new-to@example.invalid";
  const unsavedBody = "Unsaved draft recommendation";
  const unsavedQuote = "New quotation for this draft";
  f.node("compose-to").value = unsavedTo;
  f.node("compose-body").value = unsavedBody;
  ui.context.unsavedQuote = unsavedQuote;
  ui.run("state.composeQuote = quoteStateFromSeed({quote: unsavedQuote})");

  await openPicker();
  const stalePin = gate();
  pendingPin = stalePin;
  const oldInput = checkbox();
  oldInput.checked = true;
  const pin = oldInput.listeners.change();
  const pinRequestId = calls.at(-1).params.requestId;
  dialog.listeners.cancel({ preventDefault() {} });
  assert.equal(calls.at(-1).channel, "mail:cancelAttachmentRequest");
  assert.equal(calls.at(-1).params.requestId, pinRequestId);
  pendingPin = null;
  await openPicker();
  stalePin.resolve();
  await pin;
  assert.equal(Boolean(checkbox().checked), false, "a late pin cannot select a file after reopening");
  assert.equal(confirm.disabled, true);
  assert.equal(status.textContent, "Choose files to add to the draft.");

  assert.equal(f.node("compose-inbox-to").textContent, unsavedTo);
  await checkFile();
  await ui.run("confirmComposeInboxFiles()");
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(state.composeAttachments)")), [local]);
  assert.equal(dialog.open, false);
  assert.equal(f.node("compose-to").value, unsavedTo);
  assert.equal(f.node("compose-body").value, unsavedBody);
  assert.equal(ui.run("state.composeQuote.text"), unsavedQuote);
  const closing = ui.run("requestComposeClose()");
  await until(() => f.node("compose-close-review").open);
  f.node("draft-close-keep").onclick();
  assert.equal(await closing, false);
  assert.equal(ui.run("state.composeAttachments.length"), 1, "Keep editing preserves the attachment");
  assert.ok(calls.every(({ channel }) => ["mail:openEmail", "mail:listFromCache", "mail:prepareDraft", "mail:cancelAttachmentRequest", "mail:uploadAttachment"].includes(channel)));
}

async function shippedBundle() {
  const f = fixture(true); await f.render({ data: syntheticPdf() });
  assert.match(f.pages.textContent, /Synthetic accessible PDF body/, "shipped PDF.js bundle parses and exposes actual PDF text");
  assert.equal(f.pages.childNodes[0].getAttribute("role"), "group");
  assert.equal(descendants(f.pages, "attachment-preview-page")[0].getAttribute("aria-hidden"), "true");
  assert.match(descendants(f.pages, "sr")[0].textContent, /Synthetic accessible PDF body/);
  f.controls.failPaint = true; f.resize(700);
  await until(() => descendants(f.pages, "attachment-preview-page-error").length === 1);
  f.controls.failPaint = false; f.resize(880);
  await until(() => descendants(f.pages, "attachment-preview-page-error").length === 0); f.controller.abort();
  for (const [width, height] of [[1, 50000], [50000, 1]]) {
    const extreme = fixture(true); await extreme.render({ data: syntheticPdf(1, width, height) });
    assert.ok(extreme.dimensions.every(value => value >= 1 && value <= 4096), "shipped bundle bounds real PDF page canvases"); extreme.controller.abort();
  }
  const long = fixture(true); let count;
  const heartbeat = gate();
  await long.render({ data: syntheticPdf(3000), onFirstPage() {
    setTimeout(() => { count = long.pages.childNodes.length; long.controller.abort(); heartbeat.resolve(); }, 0);
  } });
  await heartbeat.promise; await tick();
  assert.ok(count >= 1 && count <= 9, "actual fake-worker PDF yields before all 3000 pages");
  assert.equal(long.pages.childNodes.length, count, "actual bundle stops after cancellation");
}

function contractAndHelp() {
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"), css = fs.readFileSync(path.join(root, "renderer/app.css"), "utf8");
  assert.match(html, /id="attachment-preview-stage"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(html, /id="attachment-preview-pages"[^>]*role="document"/);
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'"]) assert.ok(html.includes(directive));
  assert.doesNotMatch(html, /unsafe-eval|unsafe-inline|unsafe-hashes/);
  assert.match(css, /\.attachment-preview-page \{[^}]*max-height: 4096px;[^}]*object-fit: contain;/);
  const clipped = css.match(/\.sr \{([^}]+)\}/)[1];
  assert.match(clipped, /clip: rect\(0, 0, 0, 0\)/); assert.doesNotMatch(clipped, /display:\s*none|visibility:\s*hidden/);
  for (const asset of ["cmaps/Adobe-CNS1-UCS2.bcmap", "standard_fonts/LiberationSans-Regular.ttf"]) assert.ok(fs.existsSync(path.join(root, "renderer/vendor/pdfjs", asset)));
  const f = fixture(), ui = renderer(f.globals);
  const bitmap = f.window.morrowPdf.pdfPreviewBitmap;
  assert.equal(bitmap(595, 842, 880, 1).bitmapWidth, 880);
  assert.equal(bitmap(595, 842, 880, 3).bitmapWidth, 1760);
  assert.equal(bitmap(0, 0, 0, NaN).bitmapWidth, 1);
  assert.equal(bitmap(100, 100, 10000, 2).bitmapHeight, 4096);
  f.window.morrowFeaturesCatalog = require("../renderer/features-catalog"); ui.run("paintFeatureCatalog()");
  const help = f.node("features-catalog").textContent;
  for (const claim of [/extracted plain text/, /no OCR/, /load progressively/, /stops remaining preview work/, /shows Retry/, /4096 pixels/, /Text selection, in-preview links/, /verified local PDF in a resumed draft/, /Attach from Inbox in a draft/, /exact To, Cc and Bcc/]) assert.match(help, claim);
}

async function run() {
  const crlfSource = previewSource(rawSource.replace(/\r?\n/g, "\r\n"));
  assert.equal(crlfSource, source, "Windows CRLF checkouts strip module imports identically");
  new vm.Script(crlfSource, { filename: "pdf-preview-crlf.js" });
  const hostWithResolvers = Promise.withResolvers;
  await semanticsAndRetry(); await longDocument(); await limitsAndFailures(); await cancellationAndIntegration(); await composeReplacementPreview(); await resumedDraftPdfPreview(); await receivingDraftInboxPicker(); await shippedBundle(); contractAndHelp();
  assert.equal(Promise.withResolvers, hostWithResolvers, "renderer compatibility never patches the host Promise");
  console.log("pdf-preview-ok: source and shipped PDF.js bundle, accessible/inert text, progressive admission/abort, resize failure/Retry, canvas caps, lifecycle/app integration, CSP/assets/rendered Features");
}
module.exports = { run };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error("PDF fixture exceeded 15s"); process.exit(1); }, 15000);
  run().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
}
