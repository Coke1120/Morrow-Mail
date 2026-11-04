"use strict";

const auth = require("./auth");
const audit = require("./audit");
const catalog = require("./catalog");
const drafts = require("./drafts");
const probe = require("./probe");
const prompt = require("./prompt");
const send = require("./send");
const mailActions = require("./mail-actions");
const proactive = require("./proactive");
const proactiveConfig = require("./proactive-config");
const { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, PORT, SERVE_CAPABILITY } = require("./constants");
const server = require("./server");

function settingsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return false; }
  if (parsed.protocol === "morrow:" && parsed.hostname === "local") {
    return parsed.pathname === "/index.html" || parsed.pathname === "/";
  }
  if (parsed.protocol !== "file:") return false;
  let pathName = parsed.pathname;
  try { pathName = decodeURIComponent(parsed.pathname); } catch { return false; }
  return pathName.endsWith("/renderer/index.html");
}

function senderOk(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== "function") return false;
  let url = "";
  try { url = event.sender.getURL(); } catch { return false; }
  const frame = event.senderFrame;
  if (frame && frame.parent) return false;
  if (!settingsUrl(url)) return false;
  if (frame && frame.url && !settingsUrl(frame.url)) return false;
  return true;
}

function fail(message) {
  return { success: false, error: { message, code: "bot" } };
}

function ok(data) {
  return { success: true, data };
}

function accounts() {
  const db = require("../mail/db");
  if (!db.isReady()) return [];
  return db.listAccountRows().map((row) => ({
    accountId: row.id,
    email: row.email || "",
    displayName: row.display_name || "",
  }));
}

function snapshot() {
  const view = auth.view();
  const local = drafts.listLocal();
  const proactiveStatuses = proactive.statuses(view.grants);
  const mailActionStatus = mailActions.settingsStatus();
  return {
    available: view.available,
    enabled: view.enabled === true,
    installationId: view.installationId,
    serveHost: view.serveHost || "",
    serveCapability: SERVE_CAPABILITY,
    bindHost: "127.0.0.1",
    port: PORT,
    listen: server.status(),
    capabilities: catalog.capabilities(),
    defaultCapabilities: catalog.DEFAULT_CAPABILITIES,
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
    maxExpiryDays: MAX_EXPIRY_DAYS,
    endpoints: catalog.endpoints(view.serveHost),
    serveCommands: catalog.serveCommands(view.serveHost),
    markerJson: catalog.markerJson(),
    accounts: accounts(),
    grants: (view.grants || []).map(grant => ({ ...grant, proactiveStatus: proactiveStatuses[grant.clientId] || null })),
    platforms: auth.PLATFORMS,
    drafts: local.proposals,
    draftsAvailable: local.available,
    sends: send.recentForSettings(),
    mailActions: mailActionStatus.receipts,
    mailActionsAvailable: mailActionStatus.available,
    audit: audit.recent(8),
  };
}

async function setEnabled(enabled) {
  auth.setEnabledFlag(enabled);
  if (enabled) await server.startIfEnabled();
  else await server.stop();
  return snapshot();
}

async function apply(channel, payload) {
  if (channel === "bot:getAccess") return snapshot();
  if (channel === "bot:setEnabled") return setEnabled(payload && payload.enabled === true);
  if (channel === "bot:setServeHost") {
    auth.setServeHost(payload && payload.serveHost);
    return snapshot();
  }
  if (channel === "bot:mintGrant") {
    const minted = auth.mint(payload || {});
    return { secret: minted.secret, grant: minted.grant, access: snapshot() };
  }
  if (channel === "bot:rotateGrant") {
    const rotated = auth.rotate(payload && payload.clientId);
    return { secret: rotated.secret, grant: rotated.grant, access: snapshot() };
  }
  if (channel === "bot:configureProactive") {
    proactiveConfig.configure(payload || {});
    return snapshot();
  }
  if (channel === "bot:revokeGrant" || channel === "bot:deleteGrant") {
    const clientId = payload && payload.clientId;
    const loaded = auth.load();
    const grant = loaded.store && loaded.store.grants.find(row => row.clientId === clientId);
    if (channel === "bot:revokeGrant") auth.revoke(clientId);
    else auth.removeGrant(clientId);
    proactiveConfig.forgetSecret(grant);
    return snapshot();
  }
  if (channel === "bot:probeServe") return probe.probeServeHost(auth.serveHost());
  if (channel === "bot:setupText") {
    const target = payload && payload.target === "serve" ? "serve" : "local";
    const view = auth.view();
    const grant = (view.grants || []).find(row => row.clientId === (payload && payload.clientId));
    if (payload && payload.clientId && !grant) throw auth.publicError("Choose an existing bot for setup.");
    return prompt.renderSetup({ ...catalog.factsFrom(view, target), platform: grant ? grant.platform : "grok_bot", botId: grant ? grant.clientId : null });
  }
  if (channel === "bot:draftComposeSeed") return drafts.composeSeed(payload && payload.proposalId);
  if (channel === "bot:dismissDraftProposal") {
    drafts.dismiss(payload && payload.proposalId);
    return snapshot();
  }
  const error = new Error("That Bot access action is not available.");
  error.publicMessage = error.message;
  throw error;
}

function answer(channel, payload, event) {
  if (!senderOk(event)) return fail("Bot access is managed only from Morrow Settings.");
  return Promise.resolve()
    .then(() => apply(channel, payload))
    .then((data) => ok(data))
    .catch((error) => fail(error && error.publicMessage ? error.publicMessage : "Morrow could not update Bot access."));
}

module.exports = {
  answer,
  snapshot,
  setEnabled,
  senderOk,
};
