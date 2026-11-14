// 설치 마법사: 창·IPC·설치 도우미가 서로 맞물려 있는지 본다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('every element the wizard script looks up exists in the page', () => {
  const html = read('src/setup.html')
  const js = read('src/setup.js')
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
  const used = [...js.matchAll(/el\('([^']+)'\)/g)].map(m => m[1])
  assert.ok(used.length > 10)
  for (const id of used) assert.ok(ids.has(id), `setup.html has #${id}`)
  // 단계 표시와 페이지 수가 같아야 '다음'이 끝에서 멈춘다.
  const pages = html.match(/class="page"/g).length
  const steps = html.match(/<li data-step=/g).length
  assert.equal(pages, steps)
  assert.match(js, new RegExp(`const LAST = ${pages - 1}\\b`))
})

test('the wizard only writes settings the store knows', () => {
  const store = require(path.join(root, 'src/settings-store.js'))
  const js = read('src/setup.js')
  const keys = new Set(['placement', 'size', 'soundVolume', 'followClaudeCode'])
  for (const m of js.matchAll(/for \(const key of \[([^\]]+)\]\)/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) keys.add(k[1])
  }
  for (const key of keys) assert.ok(key in store.DEFAULTS, `${key} is a setting`)
})

test('main opens the wizard for --setup, both at start and from a second launch', () => {
  const main = read('src/main.js')
  assert.match(main, /process\.argv\.includes\('--setup'\)\) openSetup\(\)/)
  assert.match(main, /argv\.includes\('--setup'\)\) return openSetup\(\)/)
  assert.match(main, /ipcMain\.on\('setup:done', e => \{\n\s+if \(e\.sender === setupWin\?\.webContents\)/)
  assert.match(read('src/preload.js'), /finishSetup: \(\) => ipcRenderer\.send\('setup:done'\)/)
})

test('installers open the wizard only on a fresh install', () => {
  const mac = read('scripts/install/mac/Install.command')
  assert.match(mac, /if \[ "\$fresh" = 1 \]; then\n\s+open "\$dest\/Clau\.app" --args --setup/)
  const linux = read('scripts/install/linux/install.sh')
  assert.match(linux, /if \[ "\$fresh" = 1 \]; then\n\s+nohup "\$dest\/clau" --setup/)
  const win = read('scripts/install/windows/install.cmd')
  assert.match(win, /if "%FRESH%"=="1" \(\r?\n\s+start "" "%DEST%\\clau\.exe" --setup/)
  const ps = read('scripts/launcher/Clau-Installer-Windows.cmd')
  assert.match(ps, /\$fresh = -not \(Test-Path -LiteralPath \$Exe\)\n\s+Stop-Clau/)
  assert.match(ps, /if \(\$fresh\) \{\n\s+Start-Process -FilePath \$Exe -ArgumentList '--setup'/)
})
