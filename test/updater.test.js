const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const updater = require('../src/updater')
const { extract } = require('../src/unzip')

/** 작은 zip 만들기: [{ name, data?, mode?, link?, deflate? }] */
function makeZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const raw = Buffer.from(e.link ?? e.data ?? '')
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw
    const mode = e.link ? 0o120777 : e.name.endsWith('/') ? 0o40755 : 0o100000 | (e.mode ?? 0o644)
    const crc = zlib.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(0x0314, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8)
    head.writeUInt16LE(e.deflate ? 8 : 0, 10); head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE((mode << 16) >>> 0, 38); head.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(head, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clau-update-test-'))
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const serve = routes => async url => {
  const body = routes[url]
  if (body === undefined) return new Response('nope', { status: 404 })
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 })
}

test('versions compare numerically and the repository comes from package.json', () => {
  assert.equal(updater.newer('0.10.0', '0.9.9'), true)
  assert.equal(updater.newer('v1.0.0', '1.0.0'), false)
  assert.equal(updater.newer('0.5.0', '0.6.0'), false)
  assert.equal(updater.repoSlug({ repository: { url: 'git+https://github.com/OCGK123/clau.git' } }), 'OCGK123/clau')
  assert.equal(updater.repoSlug({ repository: 'github:OCGK123/clau' }), 'OCGK123/clau')
  assert.equal(updater.repoSlug({}), null)
  assert.equal(updater.targetName('darwin', 'arm64'), 'mac-apple-silicon')
  assert.equal(updater.targetName('linux', 'arm64'), null)
  assert.equal(updater.installDir('/Applications/Clau.app/Contents/MacOS/clau', 'darwin'), '/Applications/Clau.app')
  assert.equal(updater.installDir('C:\\Users\\a\\AppData\\Local\\Clau\\clau.exe', 'win32'), 'C:\\Users\\a\\AppData\\Local\\Clau')
})

test('check reads latest.json from the release download link, not the rate-limited API', async () => {
  const zip = Buffer.from('zip')
  const latest = { version: '0.7.0', notes: '새 판', files: { 'Clau-linux-x64.zip': { sha256: sha(zip), size: zip.length } } }
  const info = await updater.check({ repo: 'o/r', current: '0.6.0', target: 'linux-x64', fetch: serve({ 'https://github.com/o/r/releases/latest/download/latest.json': JSON.stringify(latest) }) })
  assert.equal(info.available, true)
  assert.equal(info.file.url, 'https://github.com/o/r/releases/download/v0.7.0/Clau-linux-x64.zip')
  const same = await updater.check({ repo: 'o/r', current: '0.7.0', target: 'linux-x64', fetch: serve({ 'https://github.com/o/r/releases/latest/download/latest.json': JSON.stringify(latest) }) })
  assert.equal(same.available, false)
  const other = await updater.check({ repo: 'o/r', current: '0.6.0', target: 'mac-intel', fetch: serve({ 'https://github.com/o/r/releases/latest/download/latest.json': JSON.stringify(latest) }) })
  assert.equal(other.file, null)
  const none = await updater.check({ repo: 'o/r', current: '0.6.0', target: 'linux-x64', fetch: serve({}) })
  assert.equal(none.available, false)
  await assert.rejects(updater.check({ repo: 'o/r', current: '0.6.0', fetch: async () => { throw new Error('offline') } }), { code: 'UPDATE_OFFLINE' })
})

test('unzip keeps executable bits and safe links, and refuses paths that escape', async () => {
  const dir = temp()
  const file = path.join(dir, 'a.zip')
  fs.writeFileSync(file, makeZip([
    { name: 'app/' },
    { name: 'app/run', data: '#!/bin/sh\necho hi\n', mode: 0o755, deflate: true },
    { name: 'app/empty.txt', data: '' },
    { name: 'app/Current', link: 'run' },
  ]))
  await extract(file, path.join(dir, 'out'))
  assert.equal(fs.readFileSync(path.join(dir, 'out/app/run'), 'utf8'), '#!/bin/sh\necho hi\n')
  // Windows에는 실행 권한 비트가 없다. Windows용 zip에는 링크도 없다(맥 앱에만 있다).
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'out/app/run')).mode & 0o111, 0o111)
  assert.equal(fs.readFileSync(path.join(dir, 'out/app/empty.txt'), 'utf8'), '')
  if (process.platform !== 'win32') assert.equal(fs.readlinkSync(path.join(dir, 'out/app/Current')), 'run')
  for (const evil of [{ name: '../escape', data: 'x' }, { name: '/abs', data: 'x' }, { name: 'app/link', link: '../../outside' }]) {
    fs.writeFileSync(file, makeZip([evil]))
    await assert.rejects(extract(file, path.join(dir, 'evil')), { code: 'BAD_ZIP' })
  }
  assert.ok(!fs.existsSync(path.join(dir, 'escape')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a staged update is verified, swapped in after the app quits, and relaunched', { skip: process.platform === 'win32' }, async () => {
  const dir = temp()
  const dest = path.join(dir, 'clau')
  fs.mkdirSync(dest)
  fs.writeFileSync(path.join(dest, 'clau'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dest, 'old-only.txt'), 'old')
  const marker = path.join(dir, 'relaunched')
  const zip = makeZip([
    { name: 'Clau-linux-x64/Clau/clau', data: `#!/bin/sh\necho new > "${marker}"\n`, mode: 0o755, deflate: true },
    { name: 'Clau-linux-x64/Clau/resources/app/package.json', data: '{"version":"0.7.0"}', deflate: true },
  ])
  const file = { name: 'Clau-linux-x64.zip', sha256: sha(zip), size: zip.length, url: 'https://example.test/Clau-linux-x64.zip' }
  const fetch = serve({ [file.url]: zip })

  await assert.rejects(updater.stage({ file: { ...file, sha256: '0'.repeat(64) } }, { execPath: path.join(dest, 'clau'), platform: 'linux', target: 'linux-x64', fetch }), { code: 'UPDATE_CHECKSUM' })
  assert.ok(!fs.existsSync(path.join(dir, '.clau-update')), 'a bad download leaves nothing behind')

  const progress = []
  const staged = await updater.stage({ file }, { execPath: path.join(dest, 'clau'), platform: 'linux', target: 'linux-x64', fetch, onProgress: (phase, r) => progress.push(phase) })
  assert.ok(progress.includes('download') && progress.includes('unpack'))
  assert.ok(fs.existsSync(path.join(staged.fresh, 'resources/app/package.json')))

  // 이미 끝난 프로세스 번호를 넘기면 스크립트가 기다리지 않고 바로 바꾼다.
  const dead = spawnSync('/bin/true').pid
  let launched
  updater.swap(staged, { pid: dead, platform: 'linux', run: (cmd, args) => { launched = spawnSync(cmd, args); return { unref() {} } } })
  assert.equal(launched.status, 0, String(launched.stderr))
  assert.equal(fs.readFileSync(path.join(dest, 'resources/app/package.json'), 'utf8'), '{"version":"0.7.0"}')
  assert.ok(!fs.existsSync(path.join(dest, 'old-only.txt')), 'old files are gone')
  assert.ok(!fs.existsSync(`${dest}.old`) && !fs.existsSync(staged.root), 'nothing is left over')
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'new', 'the new version was started')
  fs.rmSync(dir, { recursive: true, force: true })
})
