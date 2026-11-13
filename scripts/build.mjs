// 운영체제별 배포본 만들기: dist/ 아래에 폴더와 zip이 생긴다.
//   node scripts/build.mjs            전부 (linux, win, mac)
//   node scripts/build.mjs linux      하나만 (linux | win | mac)
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
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
  execFileSync('zip', ['-qry', zip, path.basename(bundle)], { cwd: dist })
  console.log(`→ ${path.relative(root, zip)}  (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`)
}

fs.rmSync(path.join(dist, 'build'), { recursive: true, force: true })

// 앱의 업데이트와 한 줄 설치가 읽는 목록: 버전 번호, 바뀐 점, 파일마다 크기와 sha256.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const notes = (changelog.split(/^# /m)[1] || '').split('\n').slice(1).join('\n').trim()
const files = {}
for (const name of fs.readdirSync(dist).filter(name => /^Clau-.+\.zip$/.test(name)).sort()) {
  const data = fs.readFileSync(path.join(dist, name))
  files[name] = { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}
fs.writeFileSync(path.join(dist, 'latest.json'), `${JSON.stringify({ version: pkg.version, notes, files }, null, 2)}\n`)
console.log(`→ dist/latest.json  (${Object.keys(files).length} files)`)
console.log('\n끝.')
