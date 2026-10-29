// Cached read of addresses already stored on non-draft messages. No network.
const db = require("./db");
const suggest = require("../../shared/recipient-suggest");

let cache = { key: "", ranked: [] };

function ranked() {
  const key = `${db.file()}\0${db.recipientHeaderStamp()}`;
  if (key !== cache.key) cache = { key, ranked: suggest.rank(db.recipientHeaderRows()) };
  return cache.ranked;
}

function list(query) {
  return suggest.filter(ranked(), query);
}

module.exports = { list };
