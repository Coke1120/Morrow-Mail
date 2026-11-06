"use strict";

const { digest } = require("./move-recovery");
const bytes = require("./copy-message");
const blocked = message => Object.assign(new Error(message), { code: "move_source", operationIssued: false });
const labelsOf = value => {
  if (!Array.isArray(value?.labelIds) || value.labelIds.length > 5000 || value.labelIds.some(id => typeof id !== "string" || !id || id.length > 256)
    || new Set(value.labelIds).size !== value.labelIds.length) throw blocked("Gmail did not prove the source message's current labels.");
  return [...value.labelIds].sort();
};

// Private Gmail API source adapter. Never imports, sends, deletes a message,
// removes a label or calls an IMAP operation. Recovery is Gmail's own Trash.
function createSource({ api, check, accountId, folder, readRaw } = {}) {
  function validate(prior, snapshot, selected) {
    check();
    const labels = labelsOf(prior), original = labelsOf(snapshot);
    if (prior.id !== snapshot.providerId || labels.includes("TRASH") || labels.includes("DRAFT")) throw blocked("The Gmail source is already in Trash, is a draft or changed identity. No source removal was submitted.");
    if (selected.all ? labels.includes("SPAM") : !labels.includes(selected.id)) throw blocked("The source is no longer in its reviewed Gmail folder. Refresh before moving it.");
    if (Number(prior.internalDate) !== snapshot.date || labels.includes("UNREAD") !== snapshot.unread || labels.includes("STARRED") !== snapshot.starred
      || JSON.stringify(labels) !== JSON.stringify(original)) throw blocked("The Gmail source state changed after Copy. Review and verify it again.");
    return labels;
  }
  async function review(snapshot) {
    check();
    if (!snapshot || typeof snapshot.providerId !== "string" || !snapshot.providerId) throw blocked("A confirmed Gmail API message identity is required.");
    const selected = await folder(); check();
    if (!selected || ["TRASH", "DRAFT"].includes(selected.id)) throw blocked("Choose a saved Gmail source outside Drafts and Trash.");
    const prior = await api.getMessage(snapshot.providerId, { format: "metadata" }); check();
    const labels = validate(prior, snapshot, selected), proof = bytes.inspect(snapshot.raw);
    return { accountId, providerId: snapshot.providerId, folderId: selected.id, folderProof: selected.proof, rawSha: proof.rawSha,
      date: snapshot.date, unread: snapshot.unread, starred: snapshot.starred, labelHash: digest(JSON.stringify(labels)),
      proof: digest(JSON.stringify([accountId, snapshot.providerId, selected.proof, proof.rawSha, snapshot.date,
        snapshot.unread, snapshot.starred, labels])) };
  }
  async function trash(snapshot, reviewed, beforeSubmit) {
    let acknowledged = false;
    try {
      const current = await review(snapshot); check();
      if (current.proof !== reviewed.proof) throw blocked("The reviewed Gmail source or folder changed before removal.");
      const selected = { id: current.folderId, all: current.folderId === "__gmail_all__" };
      const result = await api.trash(current.providerId, {
        validatePrior(prior) { validate(prior, snapshot, selected); },
        beforeSubmit() { check(); beforeSubmit(); check(); },
      });
      acknowledged = true; check();
      if (result?.message?.id !== current.providerId || !labelsOf(result.message).includes("TRASH")) throw new Error("Gmail did not confirm the exact source Trash identity.");
      const saved = await readRaw(current.providerId); check();
      if (saved.providerId !== current.providerId || !labelsOf(saved).includes("TRASH") || bytes.inspect(saved.raw).rawSha !== current.rawSha
        || saved.date !== current.date || saved.unread !== current.unread || saved.starred !== current.starred) throw new Error("The Gmail source Trash readback could not be verified.");
      return { accountId, providerId: current.providerId, labelId: "TRASH", rawSha: current.rawSha };
    } catch (error) {
      // A read/ownership/storage error after an acknowledged Trash cannot turn
      // that write into a definitely unissued action or authorize another one.
      if (acknowledged) error.operationIssued = true;
      throw error;
    }
  }
  return { review, trash };
}

module.exports = { createSource, labelsOf };
