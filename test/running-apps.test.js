const test = require('node:test')
const assert = require('node:assert/strict')
const { selection, targetSpec, matches, appsFromRows, parseXClass } = require('../src/tracker/identity')
const { parseJSON } = require('../src/running-apps')

test('saved app identity drops transient data and validates OS/kind', () => {
  assert.deepEqual(selection({kind:'windows',id:'Code',label:'Visual Studio Code',pid:23,windowId:42}), {
    kind:'windows',id:'code',label:'Visual Studio Code',
  })
  assert.equal(selection({kind:'other',id:'code'}), null)
  assert.equal(selection({kind:'x11',id:'\ncode'}), null)
  assert.equal(selection({kind:'x11',id:''}), null)
})
test('picker matches exact identity and retains legacy substring only for migrated settings', () => {
  const selected = targetSpec({kind:'x11',id:'claude',label:'Claude'}, 'x11')
  assert.equal(matches(selected, 'CLAUDE'), true)
  assert.equal(matches(selected, 'claude-helper'), false)
  assert.equal(matches(targetSpec('claude','x11'), 'claude-helper'), true)
  assert.equal(matches(targetSpec({kind:'mac',id:'claude'},'x11'), 'claude'), false)
})
test('X11 class parser handles case and escaped class names without matching window titles', () => {
  assert.deepEqual(parseXClass('WM_CLASS(STRING) = "code", "Code"\n_NET_WM_PID(CARDINAL) = 23'), {
    id:'code',label:'Code',legacy:'code code',
  })
  assert.deepEqual(parseXClass('WM_CLASS: not found.'),{id:'',label:'',legacy:''})
  assert.equal(parseXClass('WM_CLASS(STRING) = "test", "A \\"quoted\\" App"').id, 'a "quoted" app')
})
test('normal app windows are deduplicated by stable identity and exclude Clau', () => {
  const rows = [
    {id:'Code',label:'Code',pid:101},{id:'code',label:'Code',pid:102},
    {id:'clau',label:'Clau',pid:103},{id:'electron',label:'Clau',pid:200},
    {id:'panel',label:'Panel',pid:104,normal:false},{id:'',pid:999},null,
  ]
  assert.deepEqual(appsFromRows(rows,'x11',200), [{kind:'x11',id:'code',label:'Code',windows:2}])
})
test('UTF-8 native helper output permits PowerShell BOM and Unicode labels', () => {
  assert.deepEqual(parseJSON('\uFEFF [{"id":"한글","label":"한글 앱"}]\n'),[{id:'한글',label:'한글 앱'}])
})

test('KWin follows the selected app, updates focus, and never follows a similar class', () => {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const signal = () => ({ callbacks: [], connect(fn) { this.callbacks.push(fn) } })
  const win = (resourceClass, pid, x) => ({
    resourceClass, resourceName:resourceClass, pid, normalWindow:true, caption:resourceClass,
    frameGeometry:{x,y:20,width:600,height:400}, frameGeometryChanged:signal(),
    minimizedChanged:signal(), minimized:false, fullScreen:false,
  })
  const wrong = win('claude-helper', 1, 10)
  const selected = win('Claude', 2, 200)
  const newer = win('CLAUDE', 3, 300)
  const workspace = {
    windowList: () => [wrong,selected], activeWindow:wrong,
    windowAdded:signal(),windowRemoved:signal(),windowActivated:signal(),
  }
  const messages = []
  const source = fs.readFileSync(require.resolve('../src/tracker/kwin-script.js'),'utf8')
    .replaceAll('__SERVICE__','local.test').replaceAll('__PID__','999').replaceAll('__TASKBAR__','false').replaceAll('__LOOK__','false')
    .replaceAll('__TARGET_SPEC__',() => JSON.stringify(targetSpec({kind:'kwin',id:'claude'},'kwin')))
  vm.runInNewContext(source,{workspace,callDBus:(_a,_b,_c,_d,text)=>messages.push(JSON.parse(text))})
  assert.equal(messages.at(-1).active,'other')
  assert.equal(messages.at(-1).rect[0],200)
  workspace.activeWindow = newer
  workspace.windowAdded.callbacks[0](newer)
  workspace.windowActivated.callbacks[0](newer)
  assert.equal(messages.at(-1).active,'target')
  assert.equal(messages.at(-1).rect[0],300)
  workspace.windowRemoved.callbacks[0](newer)
  assert.equal(messages.at(-1).rect[0],200)
})

test('overlapping KWin tracker replacements isolate services, plugins, and temporary files', async t => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const vm = require('node:vm')
  const { EventEmitter } = require('node:events')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clau-kwin-restart-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const busses = []
  let nextId = 0
  class Bus extends EventEmitter {
    requestName(service) { this.service=service; return Promise.resolve(1) }
    export(_path,handler) { this.handler=handler }
    disconnect() { this.disconnected=true }
    call(msg) {
      this.messages.push(msg)
      if (msg.member==='loadScript') {
        this.file=msg.body[0]; this.plugin=msg.body[1]
        if (busses.indexOf(this)===0) return new Promise(resolve => { this.finishLoad=()=>resolve({body:[++nextId]}) })
        return Promise.resolve({body:[++nextId]})
      }
      return Promise.resolve({body:[]})
    }
  }
  class Interface { static configureMembers() {} }
  const dbus = {
    sessionBus() { const bus=new Bus(); bus.messages=[]; busses.push(bus); return bus },
    Message:class { constructor(value) {Object.assign(this,value)} },interface:{Interface},
  }
  const module = {exports:{}}
  const filename = require.resolve('../src/tracker/kwin.js')
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    require:name=>name==='dbus-next'?dbus:require(name),module,exports:module.exports,
    __dirname:path.dirname(filename),process,setTimeout,clearTimeout,
  })
  const options={target:targetSpec({kind:'kwin',id:'code'},'kwin'),taskbar:false,pid:999,dir,onState:()=>{},onFail:error=>{throw error}}
  const first=module.exports.start(options)
  const second=module.exports.start(options)
  await new Promise(resolve=>setImmediate(resolve))
  assert.notEqual(busses[0].service,busses[1].service)
  assert.notEqual(busses[0].plugin,busses[1].plugin)
  assert.notEqual(busses[0].file,busses[1].file)
  assert.ok(fs.existsSync(busses[1].file))
  await first.stop()
  busses[0].finishLoad()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(fs.existsSync(busses[0].file),false)
  assert.equal(fs.existsSync(busses[1].file),true)
  assert.equal(busses[0].messages.some(m=>m.member==='run'),false)
  assert.equal(busses[0].messages.find(m=>m.member==='unloadScript').body[0],busses[0].plugin)
  await second.stop()
  assert.equal(fs.existsSync(busses[1].file),false)
  assert.equal(busses.every(bus=>bus.disconnected),true)
})

test('KWin app-list timeout unloads a pending script and cleans up its directory', async t => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const vm = require('node:vm')
  const { EventEmitter } = require('node:events')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clau-list-timeout-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const bus = new EventEmitter()
  bus.messages=[]
  bus.requestName=()=>Promise.resolve(1)
  bus.export=()=>{}
  bus.disconnect=()=>{bus.disconnected=true}
  bus.call=msg=>{
    bus.messages.push(msg)
    return msg.member==='loadScript'?new Promise(()=>{}):Promise.resolve({body:[]})
  }
  class Interface {static configureMembers(){}}
  const dbus={sessionBus:()=>bus,interface:{Interface},Message:class {constructor(value){Object.assign(this,value)}}}
  const filename=require.resolve('../src/running-apps')
  const module={exports:{}}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    module,exports:module.exports,__dirname:path.dirname(filename),process,
    require:name=>name==='dbus-next'?dbus:name==='./tracker'?{pick:()=> 'kwin'}:name==='./tracker/identity'?require('../src/tracker/identity'):require(name),
    setTimeout:(fn,ms)=>setTimeout(fn,ms===6000?30:ms),clearTimeout,
  })
  const result=await module.exports.list({pid:999,dir})
  assert.ok(result.error)
  const load=bus.messages.find(m=>m.member==='loadScript')
  const unload=bus.messages.find(m=>m.member==='unloadScript')
  assert.ok(load)
  assert.equal(unload.body[0],load.body[1])
  assert.equal(bus.disconnected,true)
  assert.deepEqual(fs.readdirSync(dir),[])
})
