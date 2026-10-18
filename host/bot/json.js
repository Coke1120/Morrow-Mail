"use strict";

const { MAX_DEPTH } = require("./constants");

function parseStrict(text, maxDepth = MAX_DEPTH) {
  if (typeof text !== "string") {
    const error = new Error("INVALID_REQUEST");
    error.code = "INVALID_REQUEST";
    throw error;
  }
  let i = 0;
  function fail() {
    const error = new Error("INVALID_REQUEST");
    error.code = "INVALID_REQUEST";
    throw error;
  }
  function skip() {
    while (i < text.length) {
      const ch = text[i];
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") break;
      i += 1;
    }
  }
  function parseString() {
    if (text[i] !== "\"") fail();
    i += 1;
    let out = "";
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\"") {
        i += 1;
        return out;
      }
      if (ch === "\\") {
        const esc = text[i + 1];
        if (esc === "\"" || esc === "\\" || esc === "/") out += esc;
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        } else fail();
        i += 2;
        continue;
      }
      if (ch < " ") fail();
      out += ch;
      i += 1;
    }
    fail();
  }
  function parseNumber() {
    const start = i;
    if (text[i] === "-") i += 1;
    if (text[i] === "0") i += 1;
    else if (text[i] >= "1" && text[i] <= "9") {
      while (text[i] >= "0" && text[i] <= "9") i += 1;
    } else fail();
    if (text[i] === ".") {
      i += 1;
      if (text[i] < "0" || text[i] > "9") fail();
      while (text[i] >= "0" && text[i] <= "9") i += 1;
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      if (text[i] < "0" || text[i] > "9") fail();
      while (text[i] >= "0" && text[i] <= "9") i += 1;
    }
    const raw = text.slice(start, i);
    const value = Number(raw);
    if (!Number.isFinite(value)) fail();
    return value;
  }
  function parseValue(depth) {
    if (depth > maxDepth) fail();
    skip();
    const ch = text[i];
    if (ch === "{") return parseObject(depth);
    if (ch === "[") return parseArray(depth);
    if (ch === "\"") return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    fail();
  }
  function parseObject(depth) {
    if (text[i] !== "{") fail();
    i += 1;
    const obj = Object.create(null);
    const seen = new Set();
    skip();
    if (text[i] === "}") {
      i += 1;
      return obj;
    }
    while (i < text.length) {
      skip();
      const key = parseString();
      if (seen.has(key)) fail();
      seen.add(key);
      skip();
      if (text[i] !== ":") fail();
      i += 1;
      obj[key] = parseValue(depth + 1);
      skip();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "}") {
        i += 1;
        return obj;
      }
      fail();
    }
    fail();
  }
  function parseArray(depth) {
    if (text[i] !== "[") fail();
    i += 1;
    const out = [];
    skip();
    if (text[i] === "]") {
      i += 1;
      return out;
    }
    while (i < text.length) {
      out.push(parseValue(depth + 1));
      skip();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "]") {
        i += 1;
        return out;
      }
      fail();
    }
    fail();
  }
  skip();
  const value = parseValue(1);
  skip();
  if (i !== text.length) fail();
  return value;
}

module.exports = { parseStrict };
