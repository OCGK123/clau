const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const store = require('../src/settings-store')

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clau-settings-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('new defaults preserve existing chat and interaction behavior with opt-in audio', t => {
  const cfg = store.init(isolated(t))
  assert.equal(cfg.chatEnabled, true)
  assert.equal(cfg.chatProvider, 'claude')
  assert.equal(cfg.codexModel, '')
  assert.equal(cfg.dragEnabled, true)
  assert.equal(cfg.dragPhysics, true)
  assert.equal(cfg.petting, true)
  assert.equal(cfg.soundEnabled, false)
  assert.equal(cfg.soundVolume, 35)
  assert.equal(cfg.targetAppSelection, null)
})

test('selected app survives offline restarts and unrelated setting changes without transient IDs', t => {
  const dir = isolated(t)
  store.init(dir)
  store.set({targetAppSelection:{kind:'mac',id:'COM.OPENAI.CODEX',label:'Codex',pid:123,windowId:456}})
  store.set({chatProvider:'codex',soundEnabled:true,soundVolume:60})
  const saved = JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8'))
  const identity = {kind:'mac',id:'com.openai.codex',label:'Codex'}
  assert.deepEqual(saved.targetAppSelection,identity)
  assert.equal(saved.chatProvider,'codex')
  // init does not inspect the current process list: a closed app remains chosen.
  assert.deepEqual(store.init(dir).targetAppSelection,identity)
  store.set({chatEnabled:false,dragEnabled:false,petting:false,soundEnabled:false})
  const restarted = store.init(dir)
  assert.deepEqual(restarted.targetAppSelection,identity)
  for (const key of ['chatEnabled','dragEnabled','petting','soundEnabled']) assert.equal(restarted[key],false)
})

test('legacy app strings migrate safely while the new settings get their defaults', t => {
  const dir = isolated(t)
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({targetApp:'Code',size:300,locked:true}))
  const cfg = store.init(dir)
  assert.equal(cfg.targetApp,'code')
  assert.equal(cfg.targetAppSelection,null)
  assert.equal(cfg.size,300)
  assert.equal(cfg.locked,true)
  assert.equal(cfg.chatEnabled,true)
  assert.equal(cfg.soundEnabled,false)
})

test('new provider, app identity, sound presets, and volume reject malformed saved values', t => {
  store.init(isolated(t))
  let cfg = store.set({chatProvider:'unknown',codexPath:42,codexModel:null,soundVolume:999,pettingSound:'broken',talkingSound:'broken',targetAppSelection:{kind:'x11',id:'code\n'}})
  assert.equal(cfg.chatProvider,'claude')
  assert.equal(cfg.codexPath,'')
  assert.equal(cfg.codexModel,'')
  assert.equal(cfg.soundVolume,100)
  assert.equal(cfg.pettingSound,'chime')
  assert.equal(cfg.talkingSound,'soft')
  assert.equal(cfg.targetAppSelection,null)
  cfg = store.set({soundVolume:-10,targetAppSelection:{kind:'unknown',id:'code'}})
  assert.equal(cfg.soundVolume,0)
  assert.equal(cfg.targetAppSelection,null)
  assert.equal(store.set({soundVolume:'invalid'}).soundVolume,35)
})

test('reset removes saved service/app/audio choices and keeps the free position', t => {
  const dir = isolated(t)
  store.init(dir)
  const position = {x:123,y:456}
  store.set({position,attachPos:{corner:'tl',dx:5,dy:6},chatProvider:'codex',codexPath:'/custom/codex',soundEnabled:true,targetAppSelection:{kind:'windows',id:'Code',label:'Code'}})
  const reset = store.reset()
  assert.deepEqual(reset.position,position)
  assert.deepEqual(reset.attachPos,store.DEFAULT_ATTACH)
  assert.equal(reset.targetAppSelection,null)
  assert.equal(reset.chatProvider,'claude')
  assert.equal(reset.codexPath,'')
  assert.equal(reset.soundEnabled,false)
  assert.deepEqual(store.init(dir),reset)
})

test('a damaged settings file recovers to usable defaults', t => {
  const dir = isolated(t)
  fs.writeFileSync(path.join(dir,'settings.json'),'{broken')
  const cfg = store.init(dir)
  assert.equal(cfg.chatEnabled,true)
  assert.equal(cfg.targetAppSelection,null)
  store.set({chatProvider:'codex'})
  assert.equal(store.init(dir).chatProvider,'codex')
})

test('a failed disk save is surfaced while current-session settings remain usable', t => {
  const dir = isolated(t)
  const blocked = path.join(dir, 'not-a-directory')
  fs.writeFileSync(blocked, 'file')
  store.init(blocked)
  store.set({ chatProvider: 'codex' })
  assert.equal(store.get().chatProvider, 'codex')
  assert.ok(store.getSaveError())
  store.init(dir)
  store.set({ chatProvider: 'codex' })
  assert.equal(store.getSaveError(), null)
})

test('0.5.0 preserves custom sound metadata and fallback preferences but strips raw API keys', t => {
  const dir = isolated(t)
  store.init(dir)
  const meta = {id:'a'.repeat(64)+'.wav',name:'내 효과음.wav',path:'/private/unused'}
  store.set({pettingSound:'custom',pettingSoundFile:meta,claudeFallbackToCodex:true,groqFallbackEnabled:true,groqModel:'openai/gpt-oss-120b',groqApiKey:'never-save-this'})
  const cfg=store.init(dir)
  assert.equal(cfg.pettingSound,'custom')
  assert.deepEqual(cfg.pettingSoundFile,{id:meta.id,name:meta.name})
  assert.equal(cfg.claudeFallbackToCodex,true)
  assert.equal(cfg.groqFallbackEnabled,true)
  assert.ok(!fs.readFileSync(path.join(dir,'settings.json'),'utf8').includes('never-save-this'))
  assert.equal(store.set({pettingSoundFile:{id:'../stolen.wav',name:'bad'}}).pettingSoundFile,null)
})
