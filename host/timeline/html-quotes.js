const { Parser } = require("htmlparser2");
const { htmlToPlain } = require("../mail/text-encoding");

const MAX_DEPTH = 128, MAX_RANGES = 256;
const VOID = new Set("area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr".split(" "));
const INERT = new Set("script style head template title textarea iframe xmp noembed noframes noscript plaintext svg math".split(" "));
const marker = "\0";
const uncertain = Symbol("uncertain HTML quote boundaries");

// Use explicit, balanced parser events with raw offsets. A recovered tree can
// close a quote around text whose position the original HTML never proved.
function markedRanges(html) {
  const stack = [], ranges = [];
  let offset = 0, hasClass = false;
  function consume() {
    const end = parser.endIndex + 1;
    if (parser.startIndex !== offset || end <= offset) throw uncertain;
    offset = end;
  }
  function tag() {
    consume();
    const raw = html.slice(parser.startIndex, offset);
    if (!/^<[^<>]+>$/.test(raw)) throw uncertain;
    return raw;
  }
  const parser = new Parser({
    ontext(value) {
      consume();
      if (value.includes("<")) throw uncertain;
    },
    oncomment() { if (!/^<!--.*-->$/s.test(tag())) throw uncertain; },
    onprocessinginstruction() { if (!/^<!doctype\s/i.test(tag())) throw uncertain; },
    onattribute(name) {
      if (name !== "class") return;
      if (hasClass) throw uncertain;
      hasClass = true;
    },
    onopentag(name, attributes, implied) {
      const raw = tag();
      if (implied || stack.length >= MAX_DEPTH || (!VOID.has(name) && /\/\s*>$/.test(raw))) throw uncertain;
      // The legacy projection treats a word boundary after these names as an
      // opening tag. Only project markup for which those elements really close.
      const skippedTag = /^<(script|style|head|template)\b/i.exec(raw);
      if (skippedTag && skippedTag[1].toLowerCase() !== name) throw uncertain;
      hasClass = false;
      const parent = stack.at(-1);
      const classes = !parent?.inert && name === "div" ? (attributes.class || "").split(/[\t\n\f\r ]+/) : [];
      const attribution = classes.includes("gmail_attr");
      const wrapper = classes.includes("gmail_quote") || classes.includes("gmail_quote_container");
      const quote = !parent?.inert && !attribution && (name === "blockquote" || wrapper);
      const range = quote || attribution ? { start: offset, outerStart: offset, quote } : null;
      if (range) {
        if (ranges.length >= MAX_RANGES) throw uncertain;
        ranges.push(range);
      }
      const leadingAttribution = attribution && parent?.wrapper && parent.range.start === parent.range.outerStart
        && !html.slice(parent.range.start, parser.startIndex).trim();
      stack.push({ name, range, wrapper: quote && wrapper, parentQuote: leadingAttribution ? parent.range : null,
        inert: parent?.inert || attribution || INERT.has(name) });
    },
    onclosetag(name, implied) {
      const frame = stack.pop();
      if (frame?.name !== name) throw uncertain;
      if (implied && VOID.has(name)) return;
      if (implied || tag().slice(0, -1).trimEnd().toLowerCase() !== `</${name}`) throw uncertain;
      if (frame.range) frame.range.end = parser.startIndex;
      if (frame.parentQuote) frame.parentQuote.start = offset;
    },
  }, { decodeEntities: false });
  try { parser.end(html); }
  catch (error) { if (error === uncertain) return []; throw error; }
  return offset === html.length && !stack.length ? ranges : [];
}

function htmlQuoteRanges(html, text) {
  if (html.includes(marker) || text.includes(marker)) return [];
  const ranges = markedRanges(html);
  if (!ranges.some(range => range.quote) || htmlToPlain(html) !== text) return [];

  // Carry raw boundaries through the existing projection once. Removing the
  // markers must recover the whole original text, including duplicate text at
  // other positions. A boundary that affects flattening cannot be used.
  const cuts = [...new Set(ranges.flatMap(({ start, outerStart, end }) => [start, outerStart, end]))].sort((a, b) => a - b);
  let offset = 0;
  const pieces = cuts.map(cut => { const piece = html.slice(offset, cut); offset = cut; return piece; });
  pieces.push(html.slice(offset));
  const projected = htmlToPlain(pieces.join(marker)).split(marker);
  if (projected.length !== pieces.length) return [];
  const full = projected.join(""), trimmedStart = full.trimStart();
  if (trimmedStart.trimEnd() !== text) return [];

  const positions = new Map();
  let position = trimmedStart.length - full.length;
  for (let index = 0; index < cuts.length; index++) {
    position += projected[index].length;
    positions.set(cuts[index], Math.max(0, Math.min(position, text.length)));
  }
  return ranges.map(({ start, outerStart, end, quote }) => ({ start: positions.get(start), outerStart: positions.get(outerStart), end: positions.get(end), quote }));
}

module.exports = { htmlQuoteRanges };
