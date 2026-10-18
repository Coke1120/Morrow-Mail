const db = require("./db");
const settings = require("../settings");
const policy = require("../../shared/compose-policy");
const sidecar = require("./sidecar");
const provider = require("./provider-api");

function preferences() { return settings.answer("emailBrain:getComposeSettings", []); }

function cacheOf(account) {
  try {
    const cache = JSON.parse(account.send_as_json);
    if (cache.email === account.email && Array.isArray(cache.identities)) return cache;
  } catch { /* no provider cache yet */ }
  return { identities: [], updatedAt: 0 };
}

function accountIdentity(account, prefs = preferences()) {
  const view = { id: account.id, email: account.email, sendAs: cacheOf(account).identities };
  const sendAs = policy.identities(view, prefs);
  return { sendAs, preferredFromAddress: policy.preferredFrom(view, prefs) };
}

async function refresh(account, force) {
  if (sidecar.providerOf(account) !== "google") return "";
  const cache = cacheOf(account);
  if (!force && Date.now() - cache.updatedAt < 10 * 60 * 1000) return "";
  let timer;
  try {
    const identities = await Promise.race([
      (async () => {
        const token = await sidecar.gmailSendAsToken(account);
        return token ? provider.listSendAs(token.accessToken) : null;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Alias lookup timed out")), 8000); }),
    ]);
    if (!identities) return "Gmail aliases could not be checked. Configure verified send-as addresses in Gmail and add them in Brain, or enable mailbox features to discover them.";
    const current = db.accountById(account.id);
    if (!current || current.email !== account.email || current.auth_kind !== account.auth_kind || current.profile !== account.profile) {
      throw new Error("The mailbox connection changed. Reopen compose.");
    }
    db.saveSendAs(account.id, { email: account.email, identities, updatedAt: Date.now() });
    return "";
  } catch {
    return "Could not refresh Gmail send-as addresses. Cached and explicitly configured aliases remain available; Gmail must verify the address before sending.";
  } finally { clearTimeout(timer); }
}

async function context(account, message, kind, explicitFrom, force) {
  const warning = await refresh(account, force);
  const current = db.accountById(account.id);
  if (!current) throw new Error("That mailbox is no longer connected.");
  const prefs = preferences();
  const view = { id: current.id, email: current.email, ...accountIdentity(current, prefs) };
  return { ...policy.resolve(view, message, prefs, kind, explicitFrom), settings: prefs, warning };
}

function outgoingFrom(account, input) {
  const prefs = preferences();
  const view = { id: account.id, email: account.email, ...accountIdentity(account, prefs) };
  const requested = input || view.preferredFromAddress;
  const email = policy.address(requested);
  if (!email) throw new Error("Choose a valid From email address.");
  if (!policy.identities(view, prefs).some((row) => row.email === email)) {
    throw new Error("This From address is no longer configured for this mailbox. Add the alias in Email Brain or choose another From address.");
  }
  // Preserve the selected identity. SMTP is the authority for Outlook/IMAP send-as.
  return email;
}

async function sendingFrom(account, input) {
  input = outgoingFrom(account, input);
  if (sidecar.providerOf(account) === "google" && policy.address(input) !== policy.address(account.email)) {
    const warning = await refresh(account, true);
    const current = db.accountById(account.id);
    if (!current) throw new Error("That mailbox is no longer connected.");
    const cached = cacheOf(current);
    // When Gmail discovery is available, an unverified/removed alias must not silently send as primary.
    if (!warning && !cached.identities.some((row) => row.email === policy.address(input))) {
      throw new Error("Verify this From address in Gmail Settings → Accounts → Send mail as before sending.");
    }
    account = current;
  }
  return outgoingFrom(account, input);
}

module.exports = { preferences, accountIdentity, context, outgoingFrom, sendingFrom };
