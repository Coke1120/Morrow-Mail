import { createHash, createHmac, randomBytes } from 'node:crypto';

const folders = ['inbox', 'starred', 'pending', 'sent', 'drafts', 'archive', 'spam', 'trash'];
const sorts = ['newest', 'oldest', 'sender', 'subject', 'unread', 'starred'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const fields = { id: null, fromName: 254, fromEmail: 254, to: 4096, subject: 1000, preview: 240, date: 40, folder: 20, category: 40, remoteId: null, deliveryStatus: 40 };
export function messageSummary(message) {
  return { ...Object.fromEntries(Object.entries(fields).filter(([key]) => message[key] !== undefined).map(([key, limit]) => [key, limit ? String(message[key] ?? '').slice(0, limit) : message[key]])), read: !!message.read, starred: !!message.starred, pending: !!message.pending, ...(message.scheduledSend ? { scheduledSend: { id: message.scheduledSend.id, sendAt: message.scheduledSend.sendAt, status: message.scheduledSend.status } } : {}) };
}

export function createMailPages(db, revision) {
  // ponytail: uncommon text sorts scan scoped metadata; persist ICU sort keys only if measured necessary.
  let textRanks = new Map();
  db.function('mail_order', value => textRanks.get(String(value ?? '')) ?? 0);
  db.exec(`CREATE INDEX IF NOT EXISTS mail_pending ON messages(account) WHERE json_extract(data,'$.pending')=1;
    CREATE INDEX IF NOT EXISTS mail_date ON search_documents(account,date DESC,id);
    CREATE INDEX IF NOT EXISTS mail_folder_date ON search_documents(account,folder,date DESC,id);
    CREATE INDEX IF NOT EXISTS mail_counts ON search_documents(account,folder,unread,starred);`);
  const secret = randomBytes(32), sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const projection = `json_object(${Object.entries(fields).flatMap(([key, limit]) => [`'${key}'`, limit ? `substr(json_extract(m.data,'$.${key}'),1,${limit})` : `json_extract(m.data,'$.${key}')`]).join(',')},'read',NOT d.unread,'starred',d.starred,'pending',json_extract(m.data,'$.pending'),'scheduledSend',json_extract(m.data,'$.scheduledSend'))`;
  return {
    stats(accounts) {
      const result = Object.fromEntries(accounts.map(account => [account, { unread: 0, total: 0, counts: Object.fromEntries(folders.map(folder => [folder, 0])) }]));
      for (const row of db.prepare(`SELECT account,folder,count(*) AS count,sum(unread) AS unread,sum(starred) AS starred FROM search_documents
        WHERE account IN (${accounts.map(() => '?').join(',') || 'NULL'}) GROUP BY account,folder`).all(...accounts)) {
        const entry = result[row.account]; entry.total += row.count;
        if (Object.hasOwn(entry.counts, row.folder) && row.folder !== 'starred') entry.counts[row.folder] = row.count;
        if (row.folder === 'inbox') entry.unread += row.unread;
        if (!['trash', 'spam'].includes(row.folder)) entry.counts.starred += row.starred;
      }
      for (const row of db.prepare(`SELECT account,count(*) AS count FROM messages WHERE json_extract(data,'$.pending')=1 AND account IN (${accounts.map(() => '?').join(',') || 'NULL'}) AND COALESCE(json_extract(data,'$.folder'),'') NOT IN ('trash','spam') GROUP BY account`).all(...accounts)) result[row.account].counts.pending = row.count;
      return result;
    },
    page(accounts, input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['folder', 'category', 'unreadOnly', 'sort', 'cursor', 'pageSize', 'locale', 'offset'].includes(key))) fail('Invalid mail page.');
      const { folder = '', category = 'all', unreadOnly = false, sort = 'newest', cursor = '', pageSize = 50, locale = 'en', offset = 0 } = input;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 200000 || (offset && cursor)) fail('Invalid mail page offset.');
      if ((folder !== '' && !folders.includes(folder)) || !['all', 'primary', 'updates', 'newsletters'].includes(category) || typeof unreadOnly !== 'boolean' || !sorts.includes(sort) || typeof cursor !== 'string' || cursor.length > 8192 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('Invalid mail folder, sorting or page size.');
      if (typeof locale !== 'string' || !locale || locale.length > 100) fail('Invalid sorting locale.');
      let collator; try { collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true }); } catch { fail('Invalid sorting locale.'); }
      const scope = createHash('sha256').update(JSON.stringify([accounts, folder, category, unreadOnly, sort, pageSize, locale, revision()])).digest('hex');
      const clauses = [`d.account IN (${accounts.map(() => '?').join(',') || 'NULL'})`], params = [...accounts];
      if (folder === 'starred') clauses.push("d.starred=1 AND d.folder NOT IN ('trash','spam')");
      else if (folder === 'pending') clauses.push("d.rowid IN (SELECT rowid FROM messages WHERE json_extract(data,'$.pending')=1) AND d.folder NOT IN ('trash','spam')");
      else if (folder) { clauses.push('d.folder=?'); params.push(folder); }
      if (category !== 'all') { clauses.push('d.category=?'); params.push(category); }
      if (unreadOnly) clauses.push('d.unread=1');
      if (['sender', 'subject'].includes(sort)) {
        const field = sort === 'sender' ? 'fromName' : 'subject';
        const values = db.prepare(`SELECT DISTINCT COALESCE(json_extract(m.data,'$.${field}'),'') AS value FROM search_documents d JOIN messages m ON m.account=d.account AND m.id=d.id WHERE ${clauses.join(' AND ')}`).all(...params).map(row => String(row.value)).sort(collator.compare);
        textRanks = new Map(); let rank = 0;
        for (let i = 0; i < values.length; i++) { if (i && collator.compare(values[i - 1], values[i])) rank++; textRanks.set(values[i], rank); }
      }
      const order = [];
      if (sort === 'sender') order.push(["mail_order(json_extract(m.data,'$.fromName'))", 'ASC']);
      if (sort === 'subject') order.push(["mail_order(json_extract(m.data,'$.subject'))", 'ASC']);
      if (sort === 'unread') order.push(['d.unread', 'DESC']);
      if (sort === 'starred') order.push(['d.starred', 'DESC']);
      order.push(['d.date', sort === 'oldest' ? 'ASC' : 'DESC'], ['d.account', 'ASC'], ['d.id', 'ASC']);
      const total = db.prepare(`SELECT count(*) n FROM search_documents d WHERE ${clauses.join(' AND ')}`).get(...params).n;
      if (cursor) {
        const [payload, signature, extra] = cursor.split('.');
        if (extra || !payload || signature !== sign(payload)) fail('Mail cursor expired or is invalid. Refresh the list.', 409);
        let previous; try { previous = JSON.parse(Buffer.from(payload, 'base64url')); } catch { fail('Invalid mail cursor.'); }
        if (previous.scope !== scope) fail('Mail changed. Refresh the list before loading another page.', 409);
        if (!Array.isArray(previous.keys) || previous.keys.length !== order.length) fail('Invalid mail cursor.');
        clauses.push('(' + order.map(([column, direction], i) => {
          const terms = order.slice(0, i).map(([key], j) => { params.push(previous.keys[j]); return `${key}=?`; });
          params.push(previous.keys[i]); terms.push(`${column}${direction === 'ASC' ? '>' : '<'}?`); return '(' + terms.join(' AND ') + ')';
        }).join(' OR ') + ')');
      }
      // Materialize bounded identities before touching message JSON (including in combined views).
      const rows = db.prepare(`WITH page AS MATERIALIZED (
        SELECT d.rowid,${order.map(([key], i) => `${key} AS k${i}`).join(',')} FROM search_documents d
        ${['sender', 'subject'].includes(sort) ? 'JOIN messages m ON m.account=d.account AND m.id=d.id' : ''}
        WHERE ${clauses.join(' AND ')} ORDER BY ${order.map(([key, direction]) => `${key} ${direction}`).join(',')} LIMIT ? OFFSET ?)
        SELECT ${projection} AS data,d.account,${order.map((_, i) => `p.k${i}`).join(',')} FROM page p
        JOIN search_documents d ON d.rowid=p.rowid JOIN messages m ON m.account=d.account AND m.id=d.id
        ORDER BY ${order.map(([, direction], i) => `p.k${i} ${direction}`).join(',')}`).all(...params, pageSize + 1, offset);
      const more = rows.length > pageSize; if (more) rows.pop();
      const last = rows.at(-1), payload = more ? Buffer.from(JSON.stringify({ scope, keys: order.map((_, i) => last[`k${i}`]) })).toString('base64url') : '';
      return { messages: rows.map(row => { const message = messageSummary(JSON.parse(row.data)); return { ...message, accountId: row.account, viewId: JSON.stringify([row.account, message.id]) }; }),
        total, pageSize, nextCursor: payload ? `${payload}.${sign(payload)}` : '', revision: revision() };
    },
  };
}
