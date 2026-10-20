const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function run() {
  const textEncoding = require('../host/mail/text-encoding');
  const sentence = '你好，這是一封中文郵件。明天見面。Café';
  const mojibake = (text) => Buffer.from(text, 'utf8').toString('latin1');
  assert.equal(textEncoding.repairMojibake(mojibake(sentence)), sentence);
  assert.equal(textEncoding.repairMojibake(Buffer.from(mojibake('你好'), 'utf8').toString('latin1')), '你好');
  assert.equal(textEncoding.repairMojibake('Café déjà'), 'Café déjà');
  assert.equal(textEncoding.repairMojibake('He said “hello”—done.'), 'He said “hello”—done.');
  assert.equal(textEncoding.presentMessage({
    subject: 'Hello', htmlBody: '<p>你好</p>', textBody: 'Hello team, the meeting is tomorrow.',
  }).textBody, 'Hello team, the meeting is tomorrow.');
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
    const sentence = '你好，這是一封中文郵件。明天見面。Café';
    const mojibake = (text) => Buffer.from(text, 'utf8').toString('latin1');
    const legacy = engine.answer('mail:scheduleSend', [{
      accountId: 'queue', to: 'recipient@example.invalid', subject: mojibake('會議：中文主題'),
      body: mojibake('<p>' + sentence + '</p>'), sendAt: '2099-01-02T08:00:00Z',
    }]);
    assert.equal(legacy.success, true);
    const stored = JSON.parse(db.scheduledById(legacy.data.id).payload_json);
    assert.ok(stored.subject.includes('會議') && stored.body.includes('你好') && stored.body.includes('Café'), 'schedule stores repaired Chinese');
    const resumed = engine.answer('mail:editScheduled', [{ id: legacy.data.id }]);
    assert.equal(resumed.success, true);
    const opened = await engine.answer('mail:openEmail', [{ emailId: resumed.data.emailId }]);
    assert.equal(opened.success, true);
    assert.ok(opened.data.email.subject.includes('會議'));
    assert.ok(opened.data.email.textBody.includes('你好') && opened.data.email.textBody.includes('明天見面') && opened.data.email.textBody.includes('Café'));
    assert.ok(opened.data.email.htmlBody.includes('你好') && !opened.data.email.textBody.includes('ä½'));
    const intact = engine.answer('mail:scheduleSend', [{
      accountId: 'queue', to: 'recipient@example.invalid', subject: '會議：中文主題',
      body: '<p>' + sentence + '</p>', sendAt: '2099-01-03T08:00:00Z',
    }]);
    const intactPayload = JSON.parse(db.scheduledById(intact.data.id).payload_json);
    assert.equal(intactPayload.subject, '會議：中文主題');
    assert.ok(intactPayload.body.includes(sentence), 'already-correct Chinese is not decoded again');
    const iconv = require('iconv-lite');
    const lossy = iconv.decode(Buffer.from(sentence, 'utf8'), 'windows-1252');
    assert.ok(lossy.includes('\uFFFD'));
    function store(id, fields) {
      db.insertMessage({
        id, accountId: 'queue', folderPath: 'Drafts', threadId: id, subject: fields.subject || '',
        from: 'queue@example.invalid', to: ['recipient@example.invalid'], date: new Date().toISOString(),
        listSortTs: Date.now(), isDraft: true, htmlBody: fields.htmlBody, textBody: fields.textBody,
        bodyComplete: true, recipientHeaders: {},
      });
    }
    store('split-mime', { subject: mojibake('會議'), htmlBody: '<p>' + sentence + '</p>', textBody: mojibake(sentence) });
    store('lossy-text', { subject: 'Notes', htmlBody: '<p>' + sentence + '</p>', textBody: lossy });
    store('english-text', { subject: 'Hello', htmlBody: '<p>你好</p>', textBody: 'Hello team, the meeting is tomorrow.' });
    store('entity-html', { subject: 'Hi', htmlBody: '<p>&#20320;&#22909;</p>', textBody: '' });
    store('french-text', { subject: 'Café déjà', htmlBody: '<p>Café déjà</p>', textBody: 'Café déjà' });
    db.insertMessage({
      id: 'header-only', accountId: 'queue', folderPath: 'Drafts', threadId: 'header-only',
      subject: 'Header only', from: 'queue@example.invalid', to: [], date: new Date().toISOString(),
      listSortTs: Date.now(), bodyComplete: false, textBody: '', htmlBody: null,
    });
    const split = await engine.answer('mail:openEmail', [{ emailId: 'split-mime' }]);
    assert.ok(split.data.email.textBody.includes('你好') && split.data.email.htmlBody.includes('你好') && split.data.email.subject.includes('會議'));
    const recovered = await engine.answer('mail:openEmail', [{ emailId: 'lossy-text' }]);
    assert.ok(recovered.data.email.textBody.includes('你好') && !recovered.data.email.textBody.includes('\uFFFD'));
    const english = await engine.answer('mail:openEmail', [{ emailId: 'english-text' }]);
    assert.equal(english.data.email.textBody, 'Hello team, the meeting is tomorrow.');
    const entities = await engine.answer('mail:openEmail', [{ emailId: 'entity-html' }]);
    assert.equal(entities.data.email.textBody, '你好');
    const french = await engine.answer('mail:openEmail', [{ emailId: 'french-text' }]);
    assert.equal(french.data.email.subject, 'Café déjà');
    assert.equal(french.data.email.textBody, 'Café déjà');
    const listed = engine.answer('mail:listFromCache', [{ accountId: 'queue', folderId: 'Drafts' }]);
    const complete = (listed.data.emails || []).find((row) => row.id === 'split-mime');
    const headerOnly = (listed.data.emails || []).find((row) => row.id === 'header-only');
    assert.equal(complete && complete.bodyComplete, true);
    assert.equal(headerOnly && headerOnly.bodyComplete, false);
  } finally {
    remote.sendSmtp = sendSmtp; secrets.deletePassword("queue");
    db.close(); for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log('scheduled-management-ok');
}
module.exports={run};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
