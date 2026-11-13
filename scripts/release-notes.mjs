// 릴리스 설명: CHANGELOG.md에서 그 버전 부분만 뽑고, 설치 안내를 붙인다.
//   node scripts/release-notes.mjs 0.7.0   → 표준 출력
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** '# Clau 0.7.0' 아래부터 다음 '# ' 앞까지. 없으면 빈 문자열. */
export function section(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === `# Clau ${version}`)
  if (start < 0) return ''
  let end = lines.findIndex((line, i) => i > start && /^# /.test(line))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

export function notes(changelog, version) {
  const body = section(changelog, version)
  if (!body) throw new Error(`CHANGELOG.md에 '# Clau ${version}' 부분이 없어요.`)
  return `${body}

## 설치

내 컴퓨터용 설치 도우미 하나를 받아 여세요. 설치, 업데이트, 고치기, 삭제를 한 창에서 합니다.

- Windows: \`Clau-Installer-Windows.cmd\` 더블클릭
- macOS: \`Clau-Installer-macOS.command\` 우클릭 → 열기
- Linux: \`Clau-Installer-Linux.sh\` 실행

이미 클로를 쓰고 있다면 설정 → 실행 → 업데이트에서 바로 바꿀 수 있습니다.
`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  process.stdout.write(notes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version))
}
