const fs=require('fs'),os=require('os'),path=require('path');
const root=path.join(__dirname,'..');
const db=require(root+'/host/mail/db'),f=require(root+'/scripts/mail-performance-fixture');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'morrow-sort-bench-'));try{
 await db.open(path.join(dir,'mail.sqlite'));
 db.insertAccount(f.account);db.replaceFolders(f.account.id,f.folders);
 for(let i=0;i<10000;i+=100) db.applyFolderSync(f.account.id,'INBOX',f.report(Array.from({length:100},(_,j)=>f.message(i+j+1,{subject:`Topic ${(i+j)*17%10000}`,to:[`recipient${(i+j)*13%10000}@fixture.invalid`],textBody:''}))));
 const results={};for(const sortBy of ['date','sender','recipient','subject']) {const times=[];for(let i=0;i<12;i++){const start=performance.now();db.selectMessages({accountId:f.account.id,folderId:'INBOX',sortBy,sortDirection:i%2?'asc':'desc',limit:200,offset:1000},{headersOnly:true});times.push(performance.now()-start);}times.sort((a,b)=>a-b);results[sortBy]={medianMs:+times[6].toFixed(2),maxMs:+times.at(-1).toFixed(2)};}
 console.log(JSON.stringify(results));
}finally{await db.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
