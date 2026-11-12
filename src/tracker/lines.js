// 도우미 프로세스를 띄워 한 줄에 JSON 하나씩 받는다. 죽으면 다시 띄운다.
const { spawn } = require('node:child_process')

function follow({ command, args, onMessage, onFail }) {
  let child = null
  let stopped = false
  let quickExits = 0

  const launch = () => {
    const startedAt = Date.now()
    let buffer = ''
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch (err) {
      return onFail(err)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let cut
      while ((cut = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        if (!line) continue
        try {
          onMessage(JSON.parse(line))
        } catch {
          // JSON이 아닌 줄은 무시한다.
        }
      }
    })
    child.on('error', err => {
      child = null
      if (!stopped) onFail(err)
    })
    child.on('exit', () => {
      child = null
      if (stopped) return
      // 켜자마자 죽기를 반복하면 이 방식은 못 쓰는 환경이다.
      quickExits = Date.now() - startedAt < 1500 ? quickExits + 1 : 0
      if (quickExits >= 3) return onFail(new Error(`${command} 도우미가 바로 끝나 버려요.`))
      setTimeout(() => !stopped && launch(), 1000)
    })
  }
  launch()

  return {
    stop() {
      stopped = true
      child?.kill()
    },
  }
}

module.exports = { follow }
