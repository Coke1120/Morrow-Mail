const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-scheduled-'));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir; process.env.MORROW_MAIL_SECRETS = 'memory';
  const engine = require('../host/mail/engine'), db = require('../host/mail/db');
  const remote = require('../host/mail/remote'), secrets = require('../host/mail/secrets');
  const sendSmtp = remote.sendSmtp;
  try {
    await engine.init();
    db.insertAccount({id:'queue',email:'queue@example.invalid',username:'queue',profile:'custom',createdAt:Date.now(),imapHost:'invalid',imapPort:993,imapTls:true,smtpHost:'invalid',smtpPort:587,smtpTls:true});
    db.replaceFolders('queue', [{path:'Drafts',name:'Drafts',wellKnown:'drafts'}]);
    const queued = engine.answer('mail:scheduleSend', [{accountId:'queue',to:'recipient@example.invalid',cc:'copy@example.invalid',subject:'Review me',body:'<p>Keep this quote</p>',inReplyTo:'<source>',threadId:'thread',sendAt:'2099-01-01T08:00:00Z'}]);
    assert.equal(queued.success, true);
    const canceled = engine.answer('mail:cancelScheduled', [{id:queued.data.id}]);
    assert.equal(canceled.success, true);
    assert.match(canceled.data.snapshot.payloadJson, /Keep this quote/);
    assert.equal(db.listScheduled().length, 0);
    const restored = engine.answer('mail:restoreScheduled', [{snapshot:canceled.data.snapshot}]);
    assert.equal(restored.success, true);
    assert.equal(restored.data.id, queued.data.id);
    assert.equal(db.listScheduled().length, 1);
    assert.equal(engine.answer('mail:restoreScheduled', [{snapshot:{id:'bad'}}]).success, false);
    const edited = engine.answer('mail:editScheduled', [{id:queued.data.id}]);
    assert.equal(edited.success, true);
    assert.equal(db.listScheduled().length, 0);
    const draft = db.messageById(edited.data.emailId);
    assert.equal(draft.account_id, 'queue'); assert.equal(draft.is_draft, 1);
    assert.equal(draft.html_body, '<p>Keep this quote</p>'); assert.equal(draft.in_reply_to, '<source>');
    assert.equal(draft.thread_id, 'thread'); assert.match(draft.cc_json, /copy@example.invalid/);
    assert.equal(engine.answer('mail:editScheduled', [{id:queued.data.id}]).success, false);
    db.close(); await db.open(path.join(dir,'mail.sqlite'));
    assert.equal(db.listScheduled().length, 0); assert.ok(db.messageById(edited.data.emailId), 'draft survives restart');
    db.insertScheduled({id:'unsupported',accountId:'queue',payloadJson:JSON.stringify({attachments:[{name:'file'}]}),sendAt:Date.now()+60000,createdAt:Date.now()});
    assert.equal(engine.answer('mail:editScheduled',[{id:'unsupported'}]).success,false);
    assert.ok(db.scheduledById('unsupported'), 'failed edit preserves queued payload');
    secrets.setPassword('queue', 'fixture-only');
    let started, release;
    const active = new Promise(resolve => { started=resolve; });
    let sends=0;
    remote.sendSmtp = async () => { sends++; started(); return new Promise(resolve=>{release=()=>resolve({messageId:'<fixture>'});}); };
    db.insertScheduled({id:'failed-row',accountId:'queue',payloadJson:JSON.stringify({to:'recipient@example.invalid',body:'<p>Failed</p>'}),sendAt:Date.now()+60000,createdAt:Date.now(),status:'failed',error:'smtp down'});
    const failedCancel = engine.answer('mail:cancelScheduled',[{id:'failed-row'}]);
    assert.equal(failedCancel.success, true);
    assert.equal(failedCancel.data.snapshot.status, 'failed');
    const failedRestore = engine.answer('mail:restoreScheduled',[{snapshot:failedCancel.data.snapshot}]);
    assert.equal(failedRestore.success, true);
    assert.equal(failedRestore.data.status, 'failed');
    assert.equal(engine.answer('mail:cancelScheduled',[{id:'failed-row'}]).success, true);
    for (const id of ['first','second']) db.insertScheduled({id,accountId:'queue',payloadJson:JSON.stringify({to:'recipient@example.invalid',body:'<p>Queued</p>'}),sendAt:Date.now()-1000,createdAt:Date.now()});
    const pumping = engine.pumpScheduled(); await active;
    assert.equal(engine.answer('mail:cancelScheduled',[{id:'first'}]).error.code,'sending');
    assert.equal(engine.answer('mail:restoreScheduled',[{snapshot:{id:'first',accountId:'queue',payloadJson:JSON.stringify({to:'recipient@example.invalid'}),sendAt:Date.now()+60000,status:'pending'}}]).error.code,'sending');
    assert.equal(engine.answer('mail:editScheduled',[{id:'first'}]).error.code,'sending');
    assert.equal(engine.answer('mail:cancelScheduled',[{id:'second'}]).success,true);
    release(); await pumping;
    assert.equal(sends,1,'a due row canceled while another send awaits I/O must not be delivered');
  } finally {
    remote.sendSmtp = sendSmtp; secrets.deletePassword("queue");
    db.close(); for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log('scheduled-management-ok');
}
module.exports={run};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
