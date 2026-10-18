const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-scheduled-'));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir; process.env.MORROW_MAIL_SECRETS = 'memory';
  const engine = require('../host/mail/engine'), db = require('../host/mail/db');
  try {
    await engine.init();
    db.insertAccount({id:'queue',email:'queue@example.invalid',username:'queue',profile:'custom',createdAt:Date.now(),imapHost:'invalid',imapPort:993,imapTls:true,smtpHost:'invalid',smtpPort:587,smtpTls:true});
    db.replaceFolders('queue', [{path:'Drafts',name:'Drafts',wellKnown:'drafts'}]);
    const queued = engine.answer('mail:scheduleSend', [{accountId:'queue',to:'recipient@example.invalid',cc:'copy@example.invalid',subject:'Review me',body:'<p>Keep this quote</p>',inReplyTo:'<source>',threadId:'thread',sendAt:'2099-01-01T08:00:00Z'}]);
    assert.equal(queued.success, true);
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
  } finally {
    db.close(); for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log('scheduled-management-ok');
}
module.exports={run};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
