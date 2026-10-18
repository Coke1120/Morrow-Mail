const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-receipts-'));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = 'memory';
  const engine = require('../host/mail/engine');
  const db = require('../host/mail/db');
  const secrets = require('../host/mail/secrets');
  const remote = require('../host/mail/remote');
  const saved = { withClient: remote.withClient, moveUid: remote.moveUid, changeFlags: remote.changeFlags };
  try {
    await engine.init();
    assert.equal(engine.answer('mail:getSyncStatus', [{}]).data.message, 'No account connected');
    assert.equal(engine.answer('mail:getSyncStatus', [{}]).data.lastSuccessAt, null);
    db.insertAccount({ id:'receipt', email:'receipt@example.invalid', username:'receipt', profile:'custom', createdAt:Date.now(),
      imapHost:'imap.example.invalid',imapPort:993,imapTls:true,smtpHost:'smtp.example.invalid',smtpPort:587,smtpTls:true });
    secrets.setPassword('receipt', 'fixture-only');
    db.replaceFolders('receipt', [{path:'INBOX',name:'Inbox',wellKnown:'inbox'},{path:'Archive',name:'Archive',wellKnown:'archive'}]);
    for (let i = 1; i <= 3; i++) db.insertMessage({id:`receipt-${i}`,accountId:'receipt',folderPath:'INBOX',uid:i,uidValidity:1,date:new Date().toISOString(),listSortTs:Date.now(),unread:true});
    const hits = [];
    remote.withClient = async (_account, _secret, work) => work({});
    remote.moveUid = async (_client, folder, uid, destination) => {
      hits.push({folder,uid,destination});
      if (uid === 2 || destination === 'INBOX') throw new Error('Fixture uncertain remote move');
      return {uid:uid+100,uidValidity:2};
    };
    const result = await engine.answer('mail:archiveBatch', [{items:[1,2,3].map(i=>({emailId:`receipt-${i}`}))}]);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.outcomes.map(row=>row.status), ['completed','unknown','not_attempted']);
    assert.equal(result.data.opIds.length, 1);
    assert.equal(hits.length, 2);
    assert.equal(db.messageById('receipt-1').folder_path, 'Archive');
    const undo = await engine.answer('mail:undoRemoval', [{opIds:result.data.opIds}]);
    assert.deepEqual(undo.data.outcomes.map(row=>row.status), ['unknown']);
    assert.equal(db.messageById('receipt-1').folder_path, 'Archive', 'failed remote Undo must not manufacture a local restore');
    assert.equal(db.messageById('receipt-1').uid, 101);
    await engine.answer('mail:undoRemoval', [{opIds:result.data.opIds}]);
    assert.equal(hits.length, 3, 'unknown Undo must not replay the remote operation');
    const missing = await engine.answer('mail:moveToFolder', [{emailId:'receipt-2',targetFolderId:'gone'}]);
    assert.equal(missing.data.outcomes[0].status, 'failed');
    remote.changeFlags = async (_c,_f,uid) => { if (uid === 2) throw new Error('Fixture flag failure'); };
    const flags = await engine.answer('mail:markReadBatch', [{isRead:true,items:[1,2,3].map(i=>({emailId:`receipt-${i}`}))}]);
    assert.deepEqual(flags.data.outcomes.map(row=>row.status), ['completed','unknown','not_attempted']);
    assert.equal(db.messageById('receipt-2').unread, 1);
  } finally {
    Object.assign(remote, saved);
    secrets.deletePassword('receipt');
    db.close();
    for (const [key,value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log('operation-receipts-ok');
}
module.exports = {run};
if (require.main === module) run().catch(error=>{console.error(error);process.exitCode=1;});
