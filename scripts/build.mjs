// 운영체제별 배포본 만들기: dist/ 아래에 폴더와 zip이 생긴다.
//   node scripts/build.mjs            전부 (linux, win, mac)
//   node scripts/build.mjs linux      하나만 (linux | win | mac)
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { section } from './release-notes.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

const TARGETS = {
  linux: [{ platform: 'linux', arch: 'x64', name: 'linux-x64', install: 'linux' }],
  win: [{ platform: 'win32', arch: 'x64', name: 'windows-x64', install: 'windows' }],
  mac: [
    { platform: 'darwin', arch: 'arm64', name: 'mac-apple-silicon', install: 'mac' },
    { platform: 'darwin', arch: 'x64', name: 'mac-intel', install: 'mac' },
  ],
}

const wanted = process.argv.slice(2)
const picks = (wanted.length ? wanted : Object.keys(TARGETS)).flatMap(key => {
  if (!TARGETS[key]) throw new Error(`모르는 대상: ${key} (linux | win | mac)`)
  return TARGETS[key]
})

fs.mkdirSync(dist, { recursive: true })

for (const target of picks) {
  console.log(`\n== ${target.name} ==`)
  const [appDir] = await packager({
    dir: root,
    name: 'Clau',
    executableName: 'clau',
    appBundleId: 'local.clau',
    // macOS: 처음엔 Dock 아이콘 없이 뜬다. 설정에서 켜면 그때 나타난다.
    extendInfo: { LSUIElement: true },
    platform: target.platform,
    arch: target.arch,
    out: path.join(dist, 'build'),
    overwrite: true,
    prune: true,
    asar: false,
    // 앱에 필요한 것만 넣는다: src, assets, claude-mod, package.json, 실행에 쓰는 모듈(prune이 개발용은 뺀다)
    ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/test($|\/)/, /^\/\.git($|\/)/, /^\/\.github($|\/)/, /\.test\.ts$/, /^\/README/, /^\/CHANGELOG/, /^\/install\.(sh|ps1)$/, /^\/\.claude($|\/)/],
  })

  // macOS에서 빌드하면 이 자리에서 바로 서명(ad-hoc)한다. 서명이 없으면 Apple Silicon 맥은 앱을 아예 열지 않는다.
  // 다른 운영체제에서 만든 맥 앱은 Install.command가 설치할 때 서명한다.
  const macApp = target.platform === 'darwin' ? path.join(appDir, 'Clau.app') : null
  if (macApp && process.platform === 'darwin') adhocSign(macApp)

  // 배포 폴더: 앱 + 설치 스크립트 + 읽어보기
  const bundle = path.join(dist, `Clau-${target.name}`)
  fs.rmSync(bundle, { recursive: true, force: true })
  fs.mkdirSync(bundle, { recursive: true })
  // 맥의 .app 안에는 심볼릭 링크가 있어서 그대로 보존해 복사한다.
  fs.cpSync(appDir, path.join(bundle, 'Clau'), { recursive: true, verbatimSymlinks: true })
  fs.cpSync(path.join(root, 'scripts', 'install', target.install), bundle, { recursive: true })
  fs.copyFileSync(path.join(root, 'README.md'), path.join(bundle, '읽어보기.md'))

  const zip = `${bundle}.zip`
  fs.rmSync(zip, { force: true })
  // -y: 심볼릭 링크를 링크 그대로 담는다(맥 앱에 필요). 실행 권한도 보존된다.
  // Windows에는 zip 명령이 없다. 대신 Windows 10부터 들어 있는 tar(bsdtar)로 zip을 만든다.
  if (process.platform === 'win32') execFileSync('tar', ['-a', '-cf', path.basename(zip), path.basename(bundle)], { cwd: dist })
  else execFileSync('zip', ['-qry', zip, path.basename(bundle)], { cwd: dist })
  console.log(`→ ${path.relative(root, zip)}  (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`)

  // 드래그해서 넣는 DMG: 응용 프로그램 폴더로 끌어다 놓기만 하면 된다. hdiutil이 있는 macOS에서만 만든다.
  if (macApp && process.platform === 'darwin') makeDmg(macApp, target)
}

function adhocSign(app) {
  // 받은 파일 표시(격리)를 떼고, 안쪽(프레임워크·도우미 앱)부터 바깥까지 이 자리에서 서명한다.
  execFileSync('xattr', ['-cr', app])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app])
  execFileSync('codesign', ['--verify', '--deep', '--strict', app])
}

function makeDmg(app, target) {
  const stage = path.join(dist, 'build', `dmg-${target.name}`)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  fs.cpSync(app, path.join(stage, 'Clau.app'), { recursive: true, verbatimSymlinks: true })
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'))
  fs.copyFileSync(path.join(root, 'scripts', 'install', 'mac', '열리지 않을 때.txt'), path.join(stage, '열리지 않을 때.txt'))
  const dmg = path.join(dist, `Clau-${target.name}.dmg`)
  const rw = path.join(dist, 'build', `Clau-${target.name}-rw.dmg`)
  fs.rmSync(dmg, { force: true })
  // 쓰기 가능한 이미지로 먼저 만들고, 열자마자 Finder 창이 뜨도록 표시(bless --openfolder)한 뒤 압축한다.
  // 이 표시가 없으면 맥 설정에 따라 더블클릭해도 디스크만 조용히 붙고 아무 창도 안 뜬다.
  execFileSync('hdiutil', ['create', '-volname', 'Clau', '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw])
  const mount = fs.mkdtempSync(path.join(dist, 'build', 'mnt-'))
  execFileSync('hdiutil', ['attach', rw, '-mountpoint', mount, '-nobrowse', '-noautoopen', '-quiet'])
  try {
    execFileSync('bless', ['--folder', mount, '--openfolder', mount])
  } catch (err) {
    console.warn(`(bless 실패: DMG를 열어도 창이 자동으로 뜨지 않을 수 있어요) ${err.message}`)
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-quiet'])
  }
  execFileSync('hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', dmg])
  fs.rmSync(rw, { force: true })
  console.log(`→ ${path.relative(root, dmg)}  (${(fs.statSync(dmg).size / 1e6).toFixed(0)} MB)`)
}

fs.rmSync(path.join(dist, 'build'), { recursive: true, force: true })

// 설치 도우미: 파일 하나로 설치·업데이트·고치기·삭제·열기. 릴리스에 그대로 올린다.
const launcher = path.join(root, 'scripts', 'launcher')
const unix = fs.readFileSync(path.join(launcher, 'clau-installer.sh'))
fs.writeFileSync(path.join(dist, 'Clau-Installer-Linux.sh'), unix, { mode: 0o755 })
fs.writeFileSync(path.join(dist, 'Clau-Installer-macOS.command'), unix, { mode: 0o755 })
// cmd는 CRLF 줄바꿈을 가장 잘 읽는다.
const windows = fs.readFileSync(path.join(launcher, 'Clau-Installer-Windows.cmd'), 'utf8').replace(/\r?\n/g, '\r\n')
fs.writeFileSync(path.join(dist, 'Clau-Installer-Windows.cmd'), windows)
console.log('→ dist/Clau-Installer-*  (Windows, macOS, Linux)')

// 앱의 업데이트와 한 줄 설치가 읽는 목록: 버전 번호, 바뀐 점, 파일마다 크기와 sha256.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const notes = section(changelog, pkg.version) // 이 버전의 바뀐 점만
const files = {}
for (const name of fs.readdirSync(dist).filter(name => /^Clau-.+\.zip$/.test(name)).sort()) {
  const data = fs.readFileSync(path.join(dist, name))
  files[name] = { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}
fs.writeFileSync(path.join(dist, 'latest.json'), `${JSON.stringify({ version: pkg.version, notes, files }, null, 2)}\n`)
console.log(`→ dist/latest.json  (${Object.keys(files).length} files)`)
console.log('\n끝.')
