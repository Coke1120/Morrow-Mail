"use strict";

const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDate(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

function safeZipName(name, used) {
  const raw = String(name || "").replace(/\\/g, "/");
  let base = raw.split("/").filter(Boolean).pop() || "attachment";
  base = base.replace(/[\u0000-\u001f]/g, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!base || base === "." || base === "..") base = "attachment";
  if (base.length > 120) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : "";
    base = `${base.slice(0, Math.max(1, 120 - ext.length))}${ext}`;
  }
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const suffix = `-${n}`;
    const room = Math.max(1, 120 - suffix.length - ext.length);
    candidate = `${stem.slice(0, room)}${suffix}${ext}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function zipDownloadName(subject) {
  let base = String(subject || "").replace(/[\u0000-\u001f]/g, " ").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  if (!base || base === "." || base === "..") base = "attachments";
  base = base.slice(0, 80).replace(/[. ]+$/g, "").trim() || "attachments";
  return `${base}.zip`;
}

function zipFiles(files, now) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > 65535) {
    const error = new Error("These attachments are too large to save as one ZIP.");
    error.code = "too-large";
    throw error;
  }
  const used = new Set();
  const { time, day } = dosDate(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of list) {
    const name = safeZipName(file && file.name, used);
    const raw = Buffer.isBuffer(file && file.data) ? file.data : Buffer.from((file && file.data) || []);
    if (raw.length > 0xffffffff) {
      const error = new Error("An attachment is too large to save in a ZIP.");
      error.code = "too-large";
      throw error;
    }
    const compressed = zlib.deflateRawSync(raw);
    if (compressed.length > 0xffffffff) {
      const error = new Error("An attachment is too large to save in a ZIP.");
      error.code = "too-large";
      throw error;
    }
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const chunk = Buffer.concat([local, nameBuf, compressed]);
    locals.push(chunk);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += chunk.length;
    if (offset > 0xffffffff) {
      const error = new Error("These attachments are too large to save as one ZIP.");
      error.code = "too-large";
      throw error;
    }
  }
  const centralDir = centrals.length ? Buffer.concat(centrals) : Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(locals.length ? [...locals, centralDir, end] : [end]);
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("ZIP directory is missing.");
}

function unzipFiles(buffer) {
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const eocd = findEocd(src);
  const count = src.readUInt16LE(eocd + 10);
  let cursor = src.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (src.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP entry is invalid.");
    const method = src.readUInt16LE(cursor + 10);
    const compSize = src.readUInt32LE(cursor + 20);
    const nameLen = src.readUInt16LE(cursor + 28);
    const extraLen = src.readUInt16LE(cursor + 30);
    const commentLen = src.readUInt16LE(cursor + 32);
    const localOffset = src.readUInt32LE(cursor + 42);
    const name = src.slice(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    const localNameLen = src.readUInt16LE(localOffset + 26);
    const localExtraLen = src.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = src.slice(dataOffset, dataOffset + compSize);
    const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);
    out.push({ name, data });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = {
  zipFiles,
  unzipFiles,
  zipDownloadName,
};
