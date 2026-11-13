const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { targetSpec } = require('../src/tracker/identity')

function x11Harness(showWhen = 'focused') {
  let now = 0
  let next = 0
  let minimized = false
  const timers = new Map()
  const calls = []
  const spawned = []
  const states = []
  const errors = []
  const setTimer = (fn,ms) => {const id=++next;timers.set(id,{at:now+ms,fn});return id}
  const clearTimer = id => timers.delete(id)
  const settle = async () => {for(let i=0;i<20;i++)await Promise.resolve()}
  const advance = async ms => {
    const end=now+ms
    for(;;) {
      const pair=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]
      if(!pair)break
      now=pair[1].at;timers.delete(pair[0]);pair[1].fn();await settle()
    }
    now=end;await settle()
  }
  const rootText = '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2\n'
  const childProcess = {
    spawn(command,args) {
      const child=new EventEmitter();child.command=command;child.args=args
      child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{}
      child.kill=()=>{child.killed=true;child.emit('exit',0)}
      spawned.push(child);return child
    },
    execFile(command,args,_opts,callback) {
      const child={kill(){this.killed=true}}
      calls.push({command,args})
      let output
      if(command==='xwininfo') output=`Absolute upper-left X: 100\nAbsolute upper-left Y: 200\nWidth: 600\nHeight: 400\nMap State: ${minimized?'IsUnMapped':'IsViewable'}\n`
      else if(args.includes('-root'))output=rootText
      else output=args.includes('0x1')?'WM_CLASS(STRING) = "code", "Code"\n_NET_WM_PID(CARDINAL) = 11':'WM_CLASS(STRING) = "firefox", "Firefox"\n_NET_WM_PID(CARDINAL) = 12'
      queueMicrotask(()=>callback(null,output))
      return child
    },
  }
  const filename=require.resolve('../src/tracker/x11')
  const module={exports:{}}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    module,exports:module.exports,__dirname:path.dirname(filename),
    require:name=>name==='node:child_process'?childProcess:require('../src/tracker/identity'),
    setTimeout:setTimer,clearTimeout:clearTimer,Date:{now:()=>now},
  })
  const backend=module.exports.start({target:targetSpec({kind:'x11',id:'code'},'x11'),pid:99,showWhen,onState:state=>states.push(state),onFail:error=>errors.push(error)})
  return {backend,spawned,states,errors,calls,advance,timers,rootText,setMinimized:value=>{minimized=value}}
}

test('X11 uses persistent root subscription and preserves active geometry cadence', async () => {
  const h=x11Harness()
  h.spawned[0].stdout.emit('data',h.rootText)
  await h.advance(1020)
  assert.equal(h.calls.filter(c=>c.command==='xprop'&&c.args.includes('-root')).length,0)
  assert.ok(h.calls.filter(c=>c.command==='xwininfo').length>=5)
  assert.equal(h.spawned.length,2)
  assert.equal(h.states.at(-1).active,'target')
  h.backend.stop()
  assert.ok(h.spawned.every(child=>child.killed))
  assert.equal(h.timers.size,0)
})

test('hidden X11 geometry sleeps and resumes immediately on foreground events', async () => {
  const h=x11Harness()
  h.spawned[0].stdout.emit('data',h.rootText)
  await h.advance(50)
  h.spawned[0].stdout.emit('data','_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2\n')
  await h.advance(20)
  const before=h.calls.filter(c=>c.command==='xwininfo').length
  await h.advance(3000)
  assert.equal(h.calls.filter(c=>c.command==='xwininfo').length,before)
  assert.equal(h.states.at(-1).active,'other')
  h.spawned[0].stdout.emit('data','_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n')
  await h.advance(20)
  assert.equal(h.calls.filter(c=>c.command==='xwininfo').length,before+1)
  assert.equal(h.states.at(-1).active,'target')
  h.backend.stop()
})

test('minimized X11 target stops geometry polling until its native state changes', async () => {
  const h=x11Harness('open')
  h.spawned[0].stdout.emit('data',h.rootText)
  await h.advance(50)
  h.setMinimized(true)
  h.spawned[1].stdout.emit('data','_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n')
  await h.advance(20)
  const before=h.calls.filter(c=>c.command==='xwininfo').length
  await h.advance(3000)
  assert.equal(h.calls.filter(c=>c.command==='xwininfo').length,before)
  assert.equal(h.states.at(-1).minimized,true)
  h.setMinimized(false)
  h.spawned[1].stdout.emit('data','_NET_WM_STATE(ATOM) =\n')
  await h.advance(20)
  assert.equal(h.calls.filter(c=>c.command==='xwininfo').length,before+1)
  assert.equal(h.states.at(-1).minimized,false)
  h.backend.stop()
})

test('X11 recovers through a slower fallback read when the property watcher exits', async () => {
  const h=x11Harness()
  h.spawned[0].emit('exit',1)
  await h.advance(1050)
  assert.equal(h.calls.filter(c=>c.command==='xprop'&&c.args.includes('-root')).length,1)
  assert.equal(h.states.at(-1).active,'target')
  assert.equal(h.errors.length,0)
  h.backend.stop()
})

test('macOS hidden polling avoids full window scans while active motion keeps 150ms sampling', () => {
  let tick=0
  let now=0
  const scans=[]
  const output=[]
  let identityLookups=0
  const targetWindow={kCGWindowLayer:0,kCGWindowOwnerPID:11,kCGWindowOwnerName:'Code',kCGWindowBounds:{X:100,Y:200,Width:600,Height:400}}
  const otherWindow={...targetWindow,kCGWindowOwnerPID:12,kCGWindowOwnerName:'Other'}
  const hidden=()=>tick>=3&&tick<17
  const appFor=pid=>({processIdentifier:pid,localizedName:pid===11?'Code':'Other',bundleIdentifier:pid===11?'com.test.code':'com.test.other'})
  const bridge=text=>({dataUsingEncoding:()=>text})
  Object.assign(bridge,{
    NSUTF8StringEncoding:1,kCGWindowListOptionAll:1,kCGWindowListOptionOnScreenOnly:2,kCGWindowListExcludeDesktopElements:4,
    NSFileHandle:{fileHandleWithStandardOutput:{writeData:text=>output.push(JSON.parse(text))}},
    NSWorkspace:{sharedWorkspace:{get frontmostApplication(){return appFor(hidden()?12:11)}}},
    NSRunningApplication:{runningApplicationWithProcessIdentifier:pid=>{identityLookups++;return appFor(pid)}},
    CGWindowListCopyWindowInfo:()=>{scans.push({tick,at:now});return hidden()?[otherWindow,targetWindow]:[targetWindow,otherWindow]},
    CFMakeCollectable:value=>value,NSDate:{dateWithTimeIntervalSinceNow:value=>value},
    NSRunLoop:{currentRunLoop:{runUntilDate:()=>{now+=150;if(++tick===20)throw new Error('test complete')}}},
  })
  const context={ObjC:{import(){},bindFunction(){},unwrap:value=>value,deepUnwrap:value=>value},$:bridge,Date:{now:()=>now}}
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(require.resolve('../src/tracker/mac-helper'),'utf8'),context)
  assert.throws(()=>context.run(['99',JSON.stringify(targetSpec({kind:'mac',id:'com.test.code'},'mac')),'focused']),/test complete/)
  assert.deepEqual(scans.filter(scan=>scan.tick<3||scan.tick>=17).map(scan=>scan.tick),[0,1,2,17,18,19])
  assert.ok(scans.filter(scan=>scan.tick>=3&&scan.tick<17).length<=1)
  assert.ok(output.some(msg=>msg.active==='other'))
  assert.equal(output.at(-1).active,'target')
  assert.ok(identityLookups<=2)
})

test('KWin repeated activation never accumulates duplicate pet geometry listeners', () => {
  const signal=()=>({callbacks:[],connect(fn){this.callbacks.push(fn)}})
  const pet={pid:999,normalWindow:true,resourceClass:'clau',resourceName:'clau',caption:'Clau',frameGeometry:{x:100,y:100,width:200,height:220},frameGeometryChanged:signal()}
  const workspace={windowList:()=>[pet],activeWindow:pet,windowAdded:signal(),windowRemoved:signal(),windowActivated:signal()}
  const source=fs.readFileSync(require.resolve('../src/tracker/kwin-script'),'utf8')
    .replaceAll('__SERVICE__','local.test').replaceAll('__PID__','999').replaceAll('__TASKBAR__','false').replaceAll('__LOOK__','false')
    .replaceAll('__TARGET_SPEC__',()=>JSON.stringify(targetSpec({kind:'kwin',id:'code'},'kwin')))
  vm.runInNewContext(source,{workspace,callDBus(){}})
  for(let i=0;i<50;i++)workspace.windowActivated.callbacks[0](pet)
  assert.equal(pet.frameGeometryChanged.callbacks.length,1)
})
