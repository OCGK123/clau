// Isolated Electron smoke checks; mock CLIs never use a subscription or API.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clau-smoke-'))
const output = process.env.CLAU_TEST_OUTPUT || path.join(temp, 'screenshots')
const fakeCli = path.join(temp, 'companion-cli')
fs.writeFileSync(fakeCli, `#!${process.execPath}\nlet q='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>q+=x);process.stdin.on('end',()=>{const codex=process.argv.includes('exec');const provider=codex?'codex':'claude';setTimeout(()=>{if((q.includes('force fallback')&&!codex)||q.includes('force groq')){console.log(JSON.stringify(codex?{type:'turn.failed',error:{message:'service unavailable'}}:{type:'result',is_error:true,result:'Rate limit exceeded'}));return;}if(codex){console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Hello from '+provider}}));console.log(JSON.stringify({type:'turn.completed'}));}else{console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hello from '+provider}}}));console.log(JSON.stringify({type:'result',result:'Hello from '+provider}));}},q.includes('cancel me')?5000:180);});\n`, { mode: 0o755 })
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
let command = electron
let args = ['.', `--user-data-dir=${path.join(temp, 'profile')}`, '--disable-gpu']
if (process.platform === 'linux') {
  command = 'xvfb-run'
  args = ['-a', electron, ...args, '--no-sandbox', '--ozone-platform=x11']
}
if (process.platform === 'win32') throw new Error('The UI smoke runner requires Linux with xvfb-run or macOS; unit tests run on all platforms.')
const result = spawnSync(command, args, { cwd: root, env: { ...process.env, CLAU_NATIVE: '1', CLAU_SHOT: output, CLAU_TEST_CLI: fakeCli }, stdio: 'inherit', detached: process.platform !== 'win32', timeout: 120000 })
if (result.error) {
  console.error(result.error.message)
  // xvfb-run만 끝내면 Electron이 가상 화면에 남을 수 있으므로 테스트 그룹도 함께 정리한다.
  if (process.platform !== 'win32' && result.pid) { try { process.kill(-result.pid, 'SIGKILL') } catch {} }
}
console.log(`Screenshots and check results: ${output}`)
process.exit(result.status ?? 1)
