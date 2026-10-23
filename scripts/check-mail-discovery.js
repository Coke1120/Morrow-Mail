const assert = require("node:assert/strict");
const discovery = require("../host/mail/discovery");
const presets = require("../host/mail/presets");
const remote = require("../host/mail/remote");

const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.test">
    <incomingServer type="imap">
      <hostname>imap.example.test</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.test</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const OAUTH_THEN_PASSWORD = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="split.test">
    <incomingServer type="imap">
      <hostname>127.0.0.1</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.split.test</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.split.test</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function offline() {
  return {
    fetch() { throw new Error("offline"); },
    resolveMx() { throw new Error("offline"); },
    resolveSrv() { throw new Error("offline"); },
  };
}

async function run() {
  const yahoo = presets.endpointsFor("yahoo");
  assert.deepEqual(yahoo, {
    imap: { host: "imap.mail.yahoo.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, tls: true },
  });
  for (const email of ["Ada@Yahoo.com", "ada@ymail.com", "ada@yahoo.com.hk"]) {
    const found = await discovery.discover(email, offline());
    assert.equal(found.profile, "yahoo", email);
    assert.equal(found.source, "known");
    assert.deepEqual(found.imap, yahoo.imap);
    assert.deepEqual(found.smtp, yahoo.smtp);
  }
  const japan = await discovery.discover("ada@yahoo.co.jp", offline());
  assert.equal(japan.profile, "yahoo_jp");
  assert.equal(japan.imap.host, "imap.mail.yahoo.co.jp");
  assert.equal(japan.imap.port, 993);
  assert.equal(japan.imap.tls, true);
  assert.equal(discovery.chosenProfile("gmail", "ada@yahoo.com.hk"), "yahoo");
  assert.equal(discovery.chosenProfile("custom", "ada@yahoo.com"), "custom");
  assert.equal(discovery.chosenProfile("fastmail", "ada@fastmail.com"), "fastmail");
  assert.equal(discovery.loginName("yahoo", "ada@yahoo.com", "ada"), "ada@yahoo.com");
  assert.equal(discovery.loginName("yahoo", "ada@yahoo.com", "ada@yahoo.com"), "ada@yahoo.com");
  assert.equal(discovery.loginName("gmail", "ada@gmail.com", "ada"), "ada");

  const mx = await discovery.discover("ada@custom-yahoo.test", {
    ...offline(),
    resolveMx: async () => [{ exchange: "mx-apac.mail.gm0.yahoodns.net.", priority: 10 }],
  });
  assert.equal(mx.profile, "yahoo");
  assert.equal(mx.source, "mx");
  assert.equal(mx.imap.host, "imap.mail.yahoo.com");

  const seen = [];
  const ispdb = await discovery.discover("Ada@Example.test", {
    resolveMx: async () => [],
    resolveSrv: async () => { throw new Error("no srv"); },
    fetch: async (url) => {
      seen.push(url);
      if (!url.startsWith("https://autoconfig.thunderbird.net/")) return { ok: false, url, text: async () => "" };
      return { ok: true, url, text: async () => XML };
    },
  });
  assert.deepEqual(seen, [
    "https://autoconfig.example.test/mail/config-v1.1.xml?emailaddress=Ada%40Example.test",
    "https://example.test/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=Ada%40Example.test",
    "https://autoconfig.thunderbird.net/v1.1/example.test",
  ]);
  assert.equal(ispdb.source, "autoconfig");
  assert.deepEqual(ispdb.imap, { host: "imap.example.test", port: 993, tls: true });
  assert.deepEqual(ispdb.smtp, { host: "smtp.example.test", port: 587, tls: true });

  let fetches = 0;
  const first = await discovery.discover("ada@early.test", {
    resolveMx: async () => [],
    resolveSrv: async () => { throw new Error("unused"); },
    fetch: async (url) => {
      fetches += 1;
      assert.match(url, /^https:\/\/autoconfig\.early\.test\//);
      return { ok: true, url, text: async () => XML.replaceAll("example.test", "early.test") };
    },
  });
  assert.equal(fetches, 1);
  assert.equal(first.imap.host, "imap.early.test");

  const parsed = discovery.fromXml(OAUTH_THEN_PASSWORD);
  assert.equal(parsed.imap.host, "imap.split.test");
  assert.equal(parsed.smtp.host, "smtp.split.test");
  assert.equal(parsed.smtp.port, 465);
  assert.equal(parsed.smtp.tls, true);

  const srv = await discovery.discover("ada@srv.test", {
    resolveMx: async () => [],
    fetch: async () => { throw new Error("no xml"); },
    resolveSrv: async (name) => {
      if (name === "_imaps._tcp.srv.test") return [{ name: "imap.srv.test.", port: 993, priority: 0, weight: 1 }];
      if (name === "_submissions._tcp.srv.test") return [{ name: "smtp.srv.test.", port: 465, priority: 1, weight: 5 }];
      const error = new Error("none");
      error.code = "ENODATA";
      throw error;
    },
  });
  assert.equal(srv.source, "srv");
  assert.deepEqual(srv.imap, { host: "imap.srv.test", port: 993, tls: true });
  assert.deepEqual(srv.smtp, { host: "smtp.srv.test", port: 465, tls: true });

  const none = await discovery.discover("ada@missing.test", {
    resolveMx: async () => [],
    fetch: async () => ({ ok: false, text: async () => "" }),
    resolveSrv: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); },
  });
  assert.equal(none, null);
  assert.equal(await discovery.discover("not-an-email", offline()), null);

  const yahooAccount = { profile: "yahoo", username: "ada@yahoo.com", imap_host: "imap.mail.yahoo.com" };
  assert.equal(remote.imapAuth(yahooAccount, "app password").loginMethod, "LOGIN");
  assert.equal(remote.usesImapLogin({ profile: "aol", imap_host: "imap.aol.com" }), true);
  assert.equal(remote.imapAuth({ profile: "gmail", username: "ada@gmail.com", imap_host: "imap.gmail.com" }, "x").loginMethod, undefined);
  assert.deepEqual(remote.imapAuth({ auth_kind: "oauth2", username: "ada@gmail.com" }, "token"), {
    user: "ada@gmail.com",
    accessToken: "token",
  });
  const message = remote.explain(Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
    responseText: "LOGIN Invalid credentials",
    response: "3 NO [AUTHENTICATIONFAILED] LOGIN Invalid credentials",
  }), "s3cret-value", yahooAccount);
  assert.match(message, /Generate app password/);
  assert.match(message, /app password/i);
  assert.match(message, /regular account password/);
  assert.doesNotMatch(message, /s3cret-value/);
  assert.match(remote.explain(new Error("Command failed")), /^Command failed/);
  console.log("mail-discovery-ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
