"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { parseArchive } = require("./local-folders");
const { LIMITS, metadata } = require("./mbox-reader");
const libmime = require("libmime");

(async () => {
  const raw = Buffer.from(workerData.raw);
  const flags = metadata(raw);
  if (flags.expunged) { parentPort.postMessage({ expunged: true }); return; }
  if (flags.partial) { parentPort.postMessage({ failure: "Thunderbird marks this message incomplete (Partial). Download/export the complete message and import again; original retained in the source snapshot." }); return; }
  const head = raw.subarray(0, LIMITS.headers).toString("latin1").split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const contentType = libmime.parseHeaderValue(head.match(/^Content-Type:[ \t]*([^\r\n]*)/im)?.[1] || "text/plain");
  if (/^multipart\//i.test(contentType.value)) {
    const boundary = contentType.params.boundary;
    if (!boundary || boundary.length > 200) throw new Error("Invalid MIME boundary");
    const marker = Buffer.from("--" + boundary + "--");
    let offset = -1, closed = false;
    while ((offset = raw.indexOf(marker, offset + 1)) !== -1) {
      if ((offset === 0 || raw[offset - 1] === 10) && (offset + marker.length === raw.length || [13, 10, 32, 9].includes(raw[offset + marker.length]))) { closed = true; break; }
    }
    if (!closed) throw new Error("Truncated multipart message");
  }
  const archive = await parseArchive(raw, flags);
  if (archive.files.length > LIMITS.attachments || archive.files.reduce((n, file) => n + file.data.length, 0) > LIMITS.message) {
    throw new Error("Decoded attachments exceed the import limit (256 files / 32 MiB). Original retained in the source snapshot.");
  }
  archive.info.originalDate = flags.originalDate;
  archive.info.references = flags.references;
  archive.info.importedFromMbox = true;
  parentPort.postMessage({ archive, flags });
})().catch(error => parentPort.postMessage({ failure: "MIME could not be safely parsed. Original retained in the source snapshot.", code: error.code || "mbox_mime" }));
