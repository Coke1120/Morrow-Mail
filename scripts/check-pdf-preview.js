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
  const opened = ui.run("previewAttachment({id:'synthetic-message'}, {id:'synthetic-pdf',filename:'fixture.pdf',mimeType:'application/pdf'})");
  await until(() => integration.paints.length === 1);
  assert.equal(calls.length, 1); assert.equal(integration.node("attachment-preview-status").hidden, true);
  assert.equal(calls[0].params.emailId, "synthetic-message"); assert.equal(calls[0].params.attachmentId, "synthetic-pdf");
  ui.run("clearAttachmentPreview()"); texts.resolve({ items: [{ str: "late integration text" }] }); await opened;
  assert.ok(integration.tasks[0].destroyed); assert.equal(integration.pages.childNodes.length, 0); assert.equal(integration.pages.hidden, true);
  assert.equal(listeners.size, 0, "attachment progress subscription is released");
  assert.equal(integration.stage.contains(integration.document.activeElement), false);
}

function syntheticPdf(total = 1, width = 595, height = 842) {
  const text = "BT /F1 12 Tf 10 20 Td (Synthetic accessible PDF body) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${total} /Kids [${Array.from({ length: total }, (_, i) => `${i + 5} 0 R`).join(" ")}] >>`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < total; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>`);
  let pdf = "%PDF-1.7\n", offsets = [0];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return Uint8Array.from(Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
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
  for (const claim of [/extracted plain text/, /no OCR/, /load progressively/, /stops remaining preview work/, /shows Retry/, /4096 pixels/, /Text selection, in-preview links/]) assert.match(help, claim);
}

async function run() {
  const crlfSource = previewSource(rawSource.replace(/\r?\n/g, "\r\n"));
  assert.equal(crlfSource, source, "Windows CRLF checkouts strip module imports identically");
  new vm.Script(crlfSource, { filename: "pdf-preview-crlf.js" });
  const hostWithResolvers = Promise.withResolvers;
  await semanticsAndRetry(); await longDocument(); await limitsAndFailures(); await cancellationAndIntegration(); await shippedBundle(); contractAndHelp();
  assert.equal(Promise.withResolvers, hostWithResolvers, "renderer compatibility never patches the host Promise");
  console.log("pdf-preview-ok: source and shipped PDF.js bundle, accessible/inert text, progressive admission/abort, resize failure/Retry, canvas caps, lifecycle/app integration, CSP/assets/rendered Features");
}
module.exports = { run };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error("PDF fixture exceeded 15s"); process.exit(1); }, 15000);
  run().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
}
