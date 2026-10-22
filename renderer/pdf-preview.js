import { getDocument, PDFWorker } from "pdfjs-dist/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";

// file:// origins make PDF.js wrap its module worker in a blob URL. This CSP
// does not allow that, so the worker runs on the main thread instead.
globalThis.pdfjsWorker = { WorkerMessageHandler };

let sharedWorker = null;
let previewChain = Promise.resolve();

function previewWorker() {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new PDFWorker();
  return sharedWorker;
}

function pdfAssetUrl(path) {
  return new URL(path, window.location.href).href;
}

// Fit the page to the stage width. bitmapWidth/bitmapHeight are the canvas
// pixels; CSS then shows that bitmap at cssWidth so one page is not a thin strip.
function pdfPreviewBitmap(pageWidth, pageHeight, cssWidth, pixelRatio) {
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  const width = Math.max(1, Number(cssWidth) || 1);
  let ratio = Number(pixelRatio);
  if (!Number.isFinite(ratio) || ratio < 1) ratio = 1;
  if (ratio > 2) ratio = 2;
  let bitmapWidth = Math.max(1, Math.round(width * ratio));
  let bitmapHeight = Math.max(1, Math.round(ph * (width / pw) * ratio));
  const maxEdge = 4096;
  const edge = Math.max(bitmapWidth, bitmapHeight);
  if (edge > maxEdge) {
    const shrink = maxEdge / edge;
    bitmapWidth = Math.max(1, Math.round(bitmapWidth * shrink));
    bitmapHeight = Math.max(1, Math.round(bitmapHeight * shrink));
  }
  return { bitmapWidth, bitmapHeight };
}

function contentWidth(pages) {
  const style = getComputedStyle(pages);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return Math.max(0, pages.clientWidth - pad);
}

function isCancelled(error) {
  const name = error && error.name;
  return name === "RenderingCancelledException" || name === "AbortException";
}

function placeholderSize(base) {
  const height = Math.max(1, Math.round(8 * base.height / Math.max(1, base.width)));
  return { width: 8, height };
}

async function renderPdfPages(options) {
  const pages = options && options.pages;
  const stage = options && options.stage;
  const signal = options && options.signal;
  if (!pages || !stage) throw new Error("PDF preview is unavailable.");
  let releaseChain = () => {};
  const gate = new Promise((resolve) => {
    releaseChain = resolve;
  });
  const previous = previewChain;
  previewChain = gate;
  let task = null;
  let observer = null;
  let resize = null;
  let settled = false;
  let armed = false;
  const entries = [];
  let paintChain = Promise.resolve();
  const shutdown = () => {
    if (settled) return;
    settled = true;
    if (observer) observer.disconnect();
    if (resize) resize.disconnect();
    pages.removeAttribute("aria-busy");
    for (const entry of entries) {
      entry.dropped = true;
      if (entry.renderTask) {
        try { entry.renderTask.cancel(); } catch { /* already finished */ }
        entry.renderTask = null;
      }
    }
    const done = task ? task.destroy().catch(() => {}) : Promise.resolve();
    done.finally(releaseChain);
  };
  const enqueue = (fn) => {
    const run = paintChain.then(fn, fn);
    paintChain = run.then(() => {}, () => {});
    return run;
  };
  try {
    await previous;
    if (signal && signal.aborted) return;
    const bytes = options.data instanceof Uint8Array ? options.data.slice() : new Uint8Array(options.data || 0);
    task = getDocument({
      data: bytes,
      worker: previewWorker(),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      cMapUrl: pdfAssetUrl("vendor/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: pdfAssetUrl("vendor/pdfjs/standard_fonts/"),
      verbosity: 0,
    });
    if (signal) signal.addEventListener("abort", shutdown, { once: true });
    armed = true;
    const pdf = await task.promise;
    if (settled || (signal && signal.aborted)) return;
    const total = pdf.numPages;
    if (!total) {
      const error = new Error("This PDF has no pages.");
      error.name = "InvalidPDFException";
      throw error;
    }
    pages.replaceChildren();
    pages.setAttribute("aria-busy", "true");
    const bySlot = new WeakMap();

    const makeEntry = (page, pageNumber) => {
      const base = page.getViewport({ scale: 1 });
      const slot = document.createElement("div");
      slot.className = "attachment-preview-page-slot";
      const canvas = document.createElement("canvas");
      canvas.className = "attachment-preview-page";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Page " + pageNumber + " of " + total);
      const placeholder = placeholderSize(base);
      canvas.width = placeholder.width;
      canvas.height = placeholder.height;
      slot.appendChild(canvas);
      const entry = {
        page,
        pageNumber,
        base,
        slot,
        canvas,
        renderTask: null,
        token: 0,
        painted: false,
        atWidth: 0,
        dropped: false,
        failed: false,
        visible: false,
      };
      bySlot.set(slot, entry);
      entries.push(entry);
      pages.appendChild(slot);
      return entry;
    };

    const paint = async (entry) => {
      if (settled || entry.failed || entry.dropped || (signal && signal.aborted)) return;
      const token = ++entry.token;
      let cssWidth = contentWidth(pages);
      if (cssWidth < 2) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        cssWidth = contentWidth(pages);
      }
      if (settled || token !== entry.token || entry.dropped || (signal && signal.aborted)) return;
      if (cssWidth < 2) throw new Error("PDF preview has no space.");
      if (entry.painted && Math.abs(entry.atWidth - cssWidth) < 2 && entry.canvas.width > 8) return;
      if (entry.renderTask) {
        const previousTask = entry.renderTask;
        entry.renderTask = null;
        try { previousTask.cancel(); } catch { /* already finished */ }
        try { await previousTask.promise; } catch { /* cancellation */ }
      }
      if (settled || token !== entry.token || entry.dropped || (signal && signal.aborted)) return;
      const size = pdfPreviewBitmap(entry.base.width, entry.base.height, cssWidth, window.devicePixelRatio || 1);
      const viewport = entry.page.getViewport({ scale: size.bitmapWidth / entry.base.width });
      entry.canvas.width = Math.max(1, Math.floor(viewport.width));
      entry.canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = entry.canvas.getContext("2d");
      const renderTask = entry.page.render({ canvasContext: context, viewport });
      entry.renderTask = renderTask;
      try {
        await renderTask.promise;
      } catch (error) {
        if (isCancelled(error) || settled || token !== entry.token || (signal && signal.aborted)) return;
        throw error;
      } finally {
        if (entry.renderTask === renderTask) entry.renderTask = null;
      }
      if (settled || token !== entry.token || entry.dropped) return;
      entry.painted = true;
      entry.atWidth = cssWidth;
    };

    const showSlotError = (entry) => {
      entry.failed = true;
      entry.dropped = true;
      const note = document.createElement("p");
      note.className = "attachment-preview-page-error";
      note.textContent = "This page could not be previewed.";
      entry.slot.replaceChildren(note);
    };

    const firstPage = await pdf.getPage(1);
    if (settled || (signal && signal.aborted)) return;
    const first = makeEntry(firstPage, 1);
    first.visible = true;
    await enqueue(() => paint(first));
    if (settled || (signal && signal.aborted)) return;
    if (options.onFirstPage) options.onFirstPage();
    pages.removeAttribute("aria-busy");

    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const entry = bySlot.get(record.target);
        if (!entry || entry.failed || settled) continue;
        if (record.isIntersecting) {
          entry.visible = true;
          entry.dropped = false;
          enqueue(() => paint(entry).catch((error) => {
            if (settled || (signal && signal.aborted) || isCancelled(error)) return;
            showSlotError(entry);
          }));
        } else {
          entry.visible = false;
          entry.dropped = true;
          entry.painted = false;
          entry.token += 1;
          if (entry.renderTask) {
            try { entry.renderTask.cancel(); } catch { /* already finished */ }
            entry.renderTask = null;
          }
          const placeholder = placeholderSize(entry.base);
          entry.canvas.width = placeholder.width;
          entry.canvas.height = placeholder.height;
          try { entry.page.cleanup(); } catch { /* page has nothing cached */ }
        }
      }
    }, { root: stage, rootMargin: "800px 0px" });
    observer.observe(first.slot);

    let resizeTick = 0;
    resize = new ResizeObserver(() => {
      const tick = ++resizeTick;
      requestAnimationFrame(() => {
        if (tick !== resizeTick || settled) return;
        for (const entry of entries) {
          if (!entry.visible || entry.failed) continue;
          enqueue(() => paint(entry).catch(() => {}));
        }
      });
    });
    resize.observe(stage);

    // Later pages stay out of the caller's wait so a long file does not hold the UI.
    void (async () => {
      for (let pageNumber = 2; pageNumber <= total; pageNumber += 1) {
        if (settled || (signal && signal.aborted)) return;
        try {
          const page = await pdf.getPage(pageNumber);
          if (settled || (signal && signal.aborted)) return;
          const entry = makeEntry(page, pageNumber);
          observer.observe(entry.slot);
        } catch (error) {
          if (settled || (signal && signal.aborted) || isCancelled(error)) return;
          const slot = document.createElement("div");
          slot.className = "attachment-preview-page-slot";
          const note = document.createElement("p");
          note.className = "attachment-preview-page-error";
          note.textContent = "This page could not be previewed.";
          slot.appendChild(note);
          pages.appendChild(slot);
        }
      }
    })();
  } catch (error) {
    shutdown();
    throw error;
  } finally {
    if (!armed) shutdown();
  }
}

window.morrowPdf = {
  render: renderPdfPages,
  pdfPreviewBitmap,
};
