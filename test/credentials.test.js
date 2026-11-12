const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {create}=require('../src/credentials')
const key='gsk_test_1234567890_no_real_credential'
function fixture(t,backend='kwallet6') {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clau-key-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const safe={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>backend,encryptString:x=>Buffer.from('encrypted:'+Buffer.from(x).toString('base64')),decryptString:x=>Buffer.from(x.toString().slice(10),'base64').toString()};return {dir,safe}}
test('key is encrypted, survives restart and never appears in status',t=>{const {dir,safe}=fixture(t);const a=create(dir,safe);a.set(key);assert.equal(a.info().persistent,true);assert.ok(!fs.readFileSync(path.join(dir,'credentials/groq.enc')).includes(key));assert.equal(create(dir,safe).get(),key);assert.ok(!JSON.stringify(a.info()).includes(key));a.clear();assert.equal(create(dir,safe).get(),'')})
test('Linux basic_text keeps the key only in memory',t=>{const {dir,safe}=fixture(t,'basic_text');const a=create(dir,safe);a.set(key);assert.equal(a.get(),key);assert.equal(a.info().persistent,false);assert.equal(fs.existsSync(path.join(dir,'credentials/groq.enc')),false);assert.equal(create(dir,safe).get(),'')})
test('unavailable or broken vault has a redacted error and no plaintext fallback',t=>{const {dir,safe}=fixture(t);create(dir,safe).set(key);safe.decryptString=()=>{throw Error(key)};const a=create(dir,safe);assert.equal(a.get(),'');assert.ok(a.info().error);assert.ok(!a.info().error.includes(key));assert.throws(()=>a.set('bad'));assert.equal(a.get(),'')})
