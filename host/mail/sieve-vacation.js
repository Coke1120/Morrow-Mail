const net = require("node:net");
const tls = require("node:tls");

const SCRIPT_NAME = 'morrow-vacation';
const safe = (message, status = 400) => Object.assign(new Error(message), { status, safe: true });

function quoteSieve(value) {
  if (typeof value !== 'string' || /[^\t\x20-\x7e]/.test(value)) throw safe('Automatic reply text contains characters the IMAP vacation script cannot quote.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sieveString(value) {
  if (/^[\t\x20-\x7e]*$/.test(value)) return quoteSieve(value);
  const lines = value.split('\n').map(line => (line.startsWith('.') ? `.${line}` : line));
  return `text:\n${lines.join('\n')}\n.\n`;
}

function exclusiveDay(value) {
  const day = value.slice(0, 10);
  if (value.startsWith(`${day}T00:00:00.000Z`)) return day;
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
}

function buildVacation({ subject, message, start = '', end = '', useDate = false }) {
  const command = `vacation :days 1${subject ? ` :subject ${quoteSieve(subject)}` : ''} ${sieveString(message)};`;
  if (!useDate) return `require ["vacation"];\n${command}\n`;
  const tests = [];
  if (start) tests.push(`currentdate :value "ge" "date" ${quoteSieve(start.slice(0, 10))}`);
  if (end) tests.push(`currentdate :value "lt" "date" ${quoteSieve(exclusiveDay(end))}`);
  const test = tests.length === 1 ? tests[0] : `allof (\n  ${tests.join(',\n  ')}\n)`;
  return `require ["vacation", "date", "relational"];\nif ${test} {\n  ${command}\n}\n`;
}

function unquote(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return null;
  let out = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      if (index >= value.length - 1) return null;
    }
    out += value[index];
  }
  return out;
}

function unescapeText(value) {
  return value.split('\n').map(line => (line.startsWith('..') ? line.slice(1) : line)).join('\n').replace(/\n$/, '');
}

function vacationCommand(source) {
  const match = source.match(/^vacation :days 1(?: :subject ("(?:\\.|[^"\\])*"))? /);
  if (!match) return null;
  const rest = source.slice(match[0].length);
  let message;
  let consumed;
  if (rest.startsWith('text:\n')) {
    const end = rest.indexOf('\n.\n;');
    if (end < 0) return null;
    message = unescapeText(rest.slice('text:\n'.length, end));
    consumed = end + '\n.\n;'.length;
  } else if (rest.startsWith('"')) {
    const quoted = rest.match(/^("(?:\\.|[^"\\])*");/);
    if (!quoted) return null;
    message = unquote(quoted[1]);
    consumed = quoted[0].length;
  } else return null;
  if (message == null || rest.slice(consumed) !== '\n') return null;
  const subject = match[1] ? unquote(match[1]) : '';
  return subject == null ? null : { subject, message };
}

function parseVacation(script) {
  if (typeof script !== 'string' || script.length > 32768) return null;
  const normalized = script.replace(/\r\n/g, '\n');
  const dated = normalized.startsWith('require ["vacation", "date", "relational"];\n');
  const plain = normalized.startsWith('require ["vacation"];\n');
  if (dated === plain) return null;
  const body = normalized.slice(plain ? 'require ["vacation"];\n'.length : 'require ["vacation", "date", "relational"];\n'.length);
  const dates = [...body.matchAll(/currentdate :value "(ge|lt)" "date" "([0-9]{4}-[0-9]{2}-[0-9]{2})"/g)];
  if (plain && dates.length) return null;
  let command = body;
  if (dated) {
    if (!dates.length || dates.length > 2) return null;
    const block = body.match(/^if (?:allof \(\n  currentdate :value "(?:ge|lt)" "date" "[0-9-]+",\n  currentdate :value "(?:ge|lt)" "date" "[0-9-]+"\n\)|currentdate :value "(?:ge|lt)" "date" "[0-9-]+") \{\n([\s\S]*)\}\n$/);
    if (!block) return null;
    command = block[1].replace(/^ {2}/, '');
  }
  const parsed = vacationCommand(command);
  if (!parsed) return null;
  const start = dates.find(item => item[1] === 'ge')?.[2] || '';
  const end = dates.find(item => item[1] === 'lt')?.[2] || '';
  return {
    mode: dated ? 'scheduled' : 'always',
    ...parsed,
    start: start ? `${start}T00:00:00.000Z` : '',
    end: end ? `${end}T00:00:00.000Z` : '',
  };
}

function createProtocol(socket) {
  let buffer = Buffer.alloc(0);
  const readers = [];
  let failed = null;
  const fail = error => {
    failed = failed || error;
    socket.destroy();
    while (readers.length) readers.shift().reject(failed);
  };
  const onData = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 65536) fail(safe('The mail server returned an oversized vacation response.', 502));
    else flush();
  };
  const onError = () => fail(safe('The mail server closed the vacation connection.', 502));
  const onEnd = () => { if (readers.length) fail(safe('The mail server closed the vacation connection.', 502)); };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);
  function flush() {
    while (readers.length && !failed) {
      const reader = readers[0];
      if (reader.type === 'line') {
        const index = buffer.indexOf('\r\n');
        if (index < 0) {
          if (buffer.length > 8192) fail(safe('The mail server returned an invalid vacation response.', 502));
          return;
        }
        const line = buffer.subarray(0, index).toString('utf8');
        buffer = buffer.subarray(index + 2);
        readers.shift();
        reader.resolve(line);
      } else if (buffer.length < reader.length) return;
      else {
        const data = buffer.subarray(0, reader.length);
        buffer = buffer.subarray(reader.length);
        readers.shift();
        reader.resolve(data);
      }
    }
  }
  const enqueue = reader => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    readers.push({ ...reader, resolve, reject });
    flush();
  });
  return {
    readLine: () => enqueue({ type: 'line' }),
    readBytes: length => enqueue({ type: 'bytes', length }),
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (buffer.length) socket.unshift(buffer);
      buffer = Buffer.alloc(0);
    },
    write(value) { socket.write(value); },
  };
}

async function readResponse(protocol) {
  const lines = [];
  while (lines.length < 80) {
    const line = await protocol.readLine();
    const literal = line.match(/\{(\d+)\+?\}$/);
    if (literal) {
      const length = Number(literal[1]);
      if (length > 32768) throw safe('The mail server returned an oversized vacation script.', 502);
      lines.push(line, (await protocol.readBytes(length)).toString('utf8'));
      continue;
    }
    lines.push(line);
    if (/^(OK|NO|BYE)(?: |$)/i.test(line)) return lines;
  }
  throw safe('The mail server returned an invalid vacation response.', 502);
}

async function command(protocol, text) {
  protocol.write(`${text}\r\n`);
  const lines = await readResponse(protocol);
  if (!/^OK(?: |$)/i.test(lines.at(-1))) throw safe('The mail server rejected the vacation change. Refresh before trying again; Morrow will not retry automatically.', 502);
  return lines;
}

function capabilities(lines) {
  const values = new Map();
  for (const line of lines) {
    const match = line.match(/^"([A-Z0-9-]+)"(?: "(.*)")?$/i);
    if (match) values.set(match[1].toUpperCase(), match[2] || '');
  }
  return values;
}

function extensions(caps) {
  return (caps.get('SIEVE') || '').split(/\s+/).filter(Boolean);
}

function quotedName(value) {
  const match = value.match(/^"((?:\\.|[^"\\])*)"( ACTIVE)?$/);
  if (!match) return null;
  const name = unquote(`"${match[1]}"`);
  return name == null ? null : { name, active: Boolean(match[2]) };
}

function scriptsFrom(lines) {
  const scripts = [];
  for (const line of lines) {
    if (/^(OK|NO|BYE)(?: |$)/i.test(line)) continue;
    const script = quotedName(line);
    if (!script) throw safe('The mail server returned an unreadable vacation script list.', 502);
    scripts.push(script);
  }
  return scripts;
}

async function authenticate(protocol, mail, caps) {
  const mechanisms = (caps.get('SASL') || '').split(/\s+/);
  if (!mechanisms.includes('PLAIN')) throw safe('This IMAP server does not offer a vacation login Morrow can use. Use your provider’s webmail settings.');
  if (typeof mail.email !== 'string' || typeof mail.password !== 'string' || mail.email.length > 254 || mail.password.length > 4096) throw safe('This mailbox is missing the credentials needed for vacation settings.');
  const token = Buffer.from(`\0${mail.email}\0${mail.password}`).toString('base64');
  if (caps.has('SASL-IR')) {
    await command(protocol, `AUTHENTICATE "PLAIN" "${token}"`);
    return;
  }
  protocol.write('AUTHENTICATE "PLAIN"\r\n');
  const challenge = await protocol.readLine();
  if (!/^(""|\{0\+?\}|OK|NO|BYE)/i.test(challenge)) throw safe('This IMAP server does not offer a vacation login Morrow can use. Use your provider’s webmail settings.');
  if (/^(NO|BYE)(?: |$)/i.test(challenge)) throw safe('The mail server rejected vacation access. The existing mailbox connection was retained.', 403);
  if (/^OK(?: |$)/i.test(challenge)) return;
  protocol.write(`"${token}"\r\n`);
  const result = await readResponse(protocol);
  if (!/^OK(?: |$)/i.test(result.at(-1))) throw safe('The mail server rejected vacation access. The existing mailbox connection was retained.', 403);
}

async function runVacation(socket, mail, operation, upgrade) {
  const opening = createProtocol(socket);
  const greeting = capabilities(await readResponse(opening));
  if (!greeting.has('STARTTLS')) throw safe('This IMAP server does not offer a verified vacation connection. Use your provider’s webmail settings.');
  await command(opening, 'STARTTLS');
  opening.detach();
  const secureSocket = await upgrade(socket, mail.imapHost);
  secureSocket.setTimeout?.(10000);
  const protocol = createProtocol(secureSocket);
  const caps = capabilities(await command(protocol, 'CAPABILITY'));
  const available = extensions(caps);
  if (!available.includes('vacation')) throw safe('This IMAP server does not offer server-managed vacation replies. Morrow will not send local automatic replies.');
  await authenticate(protocol, mail, caps);
  const readScripts = async () => scriptsFrom(await command(protocol, 'LISTSCRIPTS'));
  const readScript = async () => {
    const lines = await command(protocol, `GETSCRIPT "${SCRIPT_NAME}"`);
    const header = lines.findIndex(line => /^\{(\d+)\+?\}$/.test(line));
    if (header < 0 || typeof lines[header + 1] !== 'string') throw safe('The mail server returned an unreadable vacation script.', 502);
    return lines[header + 1];
  };
  if (operation.action === 'read') {
    const scripts = await readScripts();
    const active = scripts.find(script => script.active)?.name || '';
    const script = scripts.some(item => item.name === SCRIPT_NAME) ? await readScript() : '';
    protocol.write('LOGOUT\r\n');
    return { extensions: available, active, script };
  }
  const scripts = await readScripts();
  const active = scripts.find(script => script.active)?.name || '';
  const exists = scripts.some(item => item.name === SCRIPT_NAME);
  if (operation.action === 'disable') {
    if (active === SCRIPT_NAME) await command(protocol, 'SETACTIVE ""');
    if (exists) await command(protocol, `DELETESCRIPT "${SCRIPT_NAME}"`);
    protocol.write('LOGOUT\r\n');
    return { extensions: available, active: active === SCRIPT_NAME ? '' : active, script: '' };
  }
  if (active && active !== SCRIPT_NAME) throw safe('This IMAP server already has an active Sieve script. Morrow will not replace it. Manage vacation replies in your provider’s settings.', 409);
  const bytes = Buffer.from(operation.script);
  if (bytes.length > 20000) throw safe('Automatic reply text is too long for this IMAP server.');
  protocol.write(`PUTSCRIPT "${SCRIPT_NAME}" {${bytes.length}+}\r\n`);
  protocol.write(bytes);
  const uploaded = await readResponse(protocol);
  if (!/^OK(?: |$)/i.test(uploaded.at(-1))) throw safe('The mail server rejected the vacation change. Refresh before trying again; Morrow will not retry automatically.', 502);
  try {
    await command(protocol, `SETACTIVE "${SCRIPT_NAME}"`);
  } catch (error) {
    if (!exists) { try { await command(protocol, `DELETESCRIPT "${SCRIPT_NAME}"`); } catch { /* The activation failure is reported below. */ } }
    throw error;
  }
  const script = await readScript();
  protocol.write('LOGOUT\r\n');
  return { extensions: available, active: SCRIPT_NAME, script };
}

function validHost(host) {
  return typeof host === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(host) && !host.includes('..');
}

function connectManageSieve(mail) {
  if (!validHost(mail.imapHost)) throw safe('This mailbox has no IMAP host Morrow can use for vacation settings.');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: mail.imapHost, port: 4190 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(safe('This IMAP server did not answer vacation settings in time.', 502));
    }, 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); reject(safe('This IMAP server could not be reached for vacation settings. Morrow will not send local automatic replies.', 502)); });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => resolve(secure));
    secure.once('error', () => reject(safe('The vacation connection could not be verified. Morrow will not send local automatic replies.', 502)));
  });
}

async function manageSieve(mail, operation, connect = connectManageSieve, upgrade = upgradeTls) {
  const socket = await connect(mail);
  socket.setTimeout?.(10000);
  try {
    return await runVacation(socket, mail, operation, upgrade);
  } catch (error) {
    if (error?.safe) throw error;
    throw safe('This IMAP server could not be reached for vacation settings. Morrow will not send local automatic replies.', 502);
  } finally {
    socket.end();
  }
}


module.exports = {
  SCRIPT_NAME,
  quoteSieve,
  buildVacation,
  parseVacation,
  runVacation,
  connectManageSieve,
  manageSieve,
};
