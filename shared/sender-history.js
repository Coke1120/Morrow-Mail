// Previous-mail-from-sender parsing, query text, and page merge. No I/O and no Electron.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowSenderHistory = api;
})(typeof window === "object" ? window : globalThis, function () {
  const SENDER_PAGE_SIZE = 50;
  const ADDR_SPEC = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

  function isAddrSpec(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text || text.length > 254) return false;
    return ADDR_SPEC.test(text);
  }

  function parseSenderAddresses(header) {
    const text = String(header == null ? "" : header);
    const angled = [];
    const pattern = /<([^<>]+)>/g;
    let match = pattern.exec(text);
    while (match) {
      angled.push(String(match[1] || "").trim());
      match = pattern.exec(text);
    }
    const candidates = angled.length ? angled : [text.trim()];
    const kept = [];
    for (const candidate of candidates) {
      if (!isAddrSpec(candidate) || kept.indexOf(candidate) >= 0) continue;
      kept.push(candidate);
    }
    return kept;
  }

  function senderHeader(header) {
    const addresses = parseSenderAddresses(header);
    const address = addresses[0] || "";
    if (!address) return { address: "", displayName: "", addresses: [] };
    const text = String(header == null ? "" : header).trim();
    const cut = text.indexOf("<");
    let displayName = "";
    if (cut > 0) {
      displayName = text.slice(0, cut).trim().replace(/^"(.*)"$/, "$1").replace(/"/g, "");
    }
    return { address: address, displayName: displayName, addresses: addresses };
  }

  function canonicalAddress(address) {
    return String(address == null ? "" : address).trim().toLowerCase();
  }

  function queryAddress(address) {
    const addr = canonicalAddress(address);
    return isAddrSpec(addr) ? addr : "";
  }

  function gmailFromQuery(address) {
    const addr = queryAddress(address);
    return addr ? `from:"${addr}"` : "";
  }

  function graphFromFilter(address) {
    const addr = queryAddress(address);
    return addr ? `from/emailAddress/address eq '${addr}'` : "";
  }

  function imapFromNeedle(address) {
    const addr = queryAddress(address);
    return addr ? `from:${addr}` : "";
  }

  function headerMatches(header, address) {
    const want = queryAddress(address);
    if (!want) return false;
    return parseSenderAddresses(header).some((item) => item.toLowerCase() === want);
  }

  function normalizeMessageId(value) {
    let text = String(value == null ? "" : value).trim();
    if (text.startsWith("<") && text.endsWith(">") && text.length >= 2) text = text.slice(1, -1).trim();
    return text.toLowerCase();
  }

  function sortStamp(row) {
    if (row && Number.isFinite(row.listSortTs)) return row.listSortTs;
    const parsed = Date.parse(row && row.date);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function compareRows(a, b, prefer) {
    const ta = sortStamp(a);
    const tb = sortStamp(b);
    if (ta == null && tb != null) return 1;
    if (tb == null && ta != null) return -1;
    if (ta != null && tb != null && ta !== tb) return tb - ta;
    const preferRank = (row) => (row.accountId === prefer ? 0 : 1);
    const preferDelta = preferRank(a) - preferRank(b);
    if (preferDelta) return preferDelta;
    const orderDelta = (Number(a.order) || 0) - (Number(b.order) || 0);
    if (orderDelta) return orderDelta;
    return String(a.id).localeCompare(String(b.id));
  }

  function publicRow(row) {
    return {
      id: row.id,
      accountId: row.accountId,
      subject: row.subject || "",
      date: row.date || "",
      listSortTs: Number.isFinite(row.listSortTs) ? row.listSortTs : null,
      unread: !!row.unread,
      messageId: row.messageId || "",
      current: row.current === true,
    };
  }

  function pageSenderHistory(input) {
    const opts = input || {};
    const accounts = (Array.isArray(opts.accounts) ? opts.accounts : []).slice();
    accounts.sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0));
    const prefer = String(opts.preferAccountId || "");
    const currentId = String(opts.currentId || "");
    const currentRfc = normalizeMessageId(opts.currentMessageId);
    const resume = opts.resume && typeof opts.resume === "object" && !Array.isArray(opts.resume) ? opts.resume : {};
    const seenIds = new Set(Array.isArray(resume.seenIds) ? resume.seenIds.map((id) => String(id)) : []);
    const seenRfc = new Set(Array.isArray(resume.seenRfc) ? resume.seenRfc.map((id) => String(id)) : []);
    const buffers = resume.buffers && typeof resume.buffers === "object" ? resume.buffers : {};
    const bufferIds = new Set();
    for (const rows of Object.keys(buffers)) {
      const list = buffers[rows];
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (row && row.id != null) bufferIds.add(String(row.id));
      }
    }

    const pooled = [];
    const pooledIds = new Set();
    for (const account of accounts) {
      const accountId = String(account && account.accountId || "");
      const order = Number.isFinite(account && account.order) ? account.order : 0;
      const buffered = Array.isArray(buffers[accountId]) ? buffers[accountId] : [];
      const hits = Array.isArray(account && account.hits) ? account.hits : [];
      for (const hit of buffered.concat(hits)) {
        if (!hit || hit.id == null || hit.id === "") continue;
        const rowId = String(hit.id);
        if (seenIds.has(rowId) || pooledIds.has(rowId)) continue;
        const rfc = normalizeMessageId(hit.messageId);
        if (rfc && seenRfc.has(rfc) && !bufferIds.has(rowId)) continue;
        pooledIds.add(rowId);
        pooled.push({
          id: rowId,
          accountId: accountId,
          subject: hit.subject || "",
          date: hit.date || "",
          listSortTs: hit.listSortTs,
          unread: !!hit.unread,
          messageId: hit.messageId || "",
          order: order,
        });
      }
    }

    const groups = new Map();
    const survivors = [];
    for (const row of pooled) {
      const rfc = normalizeMessageId(row.messageId);
      if (!rfc) {
        survivors.push(row);
        continue;
      }
      if (!groups.has(rfc)) groups.set(rfc, []);
      groups.get(rfc).push(row);
    }
    for (const [rfc, rows] of groups) {
      let winner = null;
      for (const row of rows) {
        if (row.accountId === prefer) {
          winner = row;
          break;
        }
      }
      if (!winner) {
        winner = rows.slice().sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)))[0];
      }
      survivors.push(winner);
      seenRfc.add(rfc);
      for (const row of rows) {
        if (row.id !== winner.id) seenIds.add(row.id);
      }
    }

    survivors.sort((a, b) => compareRows(a, b, prefer));
    const page = survivors.slice(0, SENDER_PAGE_SIZE);
    const rest = survivors.slice(SENDER_PAGE_SIZE);
    const markCurrent = (row) => {
      const rfc = normalizeMessageId(row.messageId);
      row.current = row.id === currentId || (!!currentRfc && rfc === currentRfc);
    };
    for (const row of page) {
      markCurrent(row);
      seenIds.add(row.id);
    }
    for (const row of rest) markCurrent(row);

    const nextBuffers = {};
    for (const row of rest) {
      if (!nextBuffers[row.accountId]) nextBuffers[row.accountId] = [];
      nextBuffers[row.accountId].push(publicRow(row));
    }

    const cursors = {};
    const exhaustedMap = {};
    const statuses = {};
    let allExhausted = accounts.length > 0;
    for (const account of accounts) {
      const accountId = String(account && account.accountId || "");
      cursors[accountId] = account && account.cursor ? account.cursor : null;
      exhaustedMap[accountId] = !!(account && account.exhausted === true);
      statuses[accountId] = {
        status: (account && account.status) || "ok",
        message: (account && account.message) || "",
      };
      if (!(account && account.exhausted === true)) allExhausted = false;
    }
    if (!accounts.length) allExhausted = true;
    if (rest.length) allExhausted = false;

    return {
      rows: page.map(publicRow),
      resume: {
        buffers: nextBuffers,
        seenIds: Array.from(seenIds),
        seenRfc: Array.from(seenRfc),
        cursors: cursors,
        exhausted: exhaustedMap,
        statuses: statuses,
      },
      exhausted: allExhausted && rest.length === 0,
      accounts: accounts.map((account) => ({
        accountId: String(account && account.accountId || ""),
        email: (account && account.email) || "",
        label: account && account.label != null ? account.label : "",
        name: account && account.name != null ? account.name : "",
        status: (account && account.status) || "ok",
        message: (account && account.message) || "",
      })),
    };
  }

  return {
    SENDER_PAGE_SIZE: SENDER_PAGE_SIZE,
    isAddrSpec: isAddrSpec,
    parseSenderAddresses: parseSenderAddresses,
    senderHeader: senderHeader,
    canonicalAddress: canonicalAddress,
    gmailFromQuery: gmailFromQuery,
    graphFromFilter: graphFromFilter,
    imapFromNeedle: imapFromNeedle,
    headerMatches: headerMatches,
    normalizeMessageId: normalizeMessageId,
    pageSenderHistory: pageSenderHistory,
  };
});
