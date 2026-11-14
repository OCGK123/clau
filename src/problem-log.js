// 문제 기록: 앱이 죽지 않고 넘긴 오류를 작은 파일 하나에 남긴다.
// 사용자가 "가끔 이상해요"라고 할 때 볼 곳이 있어야 한다. 파일이 끝없이 크지 않게 넘치면 반으로 줄인다.
const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 256 * 1024
const MAX_LINE = 2000 // 한 줄이 너무 길면(스택 전체 등) 자른다

function createProblemLog(dir, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  const file = path.join(dir, 'problems.log')

  function trim() {
    try {
      if (fs.statSync(file).size <= maxBytes) return
      // 오래된 앞쪽 절반을 버리고, 줄 중간에서 시작하지 않게 다음 줄바꿈부터 남긴다.
      const text = fs.readFileSync(file, 'utf8')
      const half = text.slice(Math.floor(text.length / 2))
      fs.writeFileSync(file, half.slice(half.indexOf('\n') + 1))
    } catch {}
  }

  /** @param {string} line */
  function write(line) {
    const text = String(line).replace(/\s+$/, '').slice(0, MAX_LINE)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(file, `${now().toISOString()} ${text}\n`)
      trim()
    } catch {} // 기록을 못 해도 앱은 계속 돈다
  }

  return { file, write }
}

module.exports = { createProblemLog, MAX_BYTES }
