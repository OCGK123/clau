// 창의 그림 프로세스(렌더러)를 지킨다.
// 렌더러가 죽거나 멈추면 캐릭터는 사라지는데 투명한 창만 남아 클릭을 막을 수 있다.
// 죽으면 다시 불러 살리고, 너무 자주 죽으면 포기해서 끝없는 재시작 고리를 막는다.

const CRASH_WINDOW_MS = 60_000 // 이 시간 안에
const CRASH_LIMIT = 3 // 이만큼 넘게 죽으면 포기한다
const RELOAD_DELAY_MS = 500 // 죽자마자 다시 부르면 같은 이유로 또 죽기 쉽다
const HANG_GRACE_MS = 8_000 // 멈춤 알림 뒤 이만큼 기다려도 안 풀리면 다시 부른다

/**
 * @param {import('electron').BrowserWindow} me 지킬 창
 * @param {object} opts
 * @param {string} opts.name 기록에 남길 이름
 * @param {(line: string) => void} opts.log 문제를 남길 곳
 * @param {() => void} [opts.onGone] 죽은 순간(클릭 막힘 풀기 같은 응급 처치)
 * @param {() => void} [opts.onRevived] 다시 불러온 뒤(처음 불러올 때 하던 일을 다시 한다)
 * @param {() => void} opts.onGiveUp 너무 자주 죽을 때
 * @param {{ now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [opts.clock] 테스트용
 */
function guardRenderer(me, { name, log, onGone, onRevived, onGiveUp, clock = {} }) {
  const now = clock.now || Date.now
  const later = clock.setTimeout || setTimeout
  const cancel = clock.clearTimeout || clearTimeout
  const crashes = []
  let reviving = false
  let hangTimer = null
  let reloadTimer = null
  const alive = () => !me.isDestroyed() && !me.webContents.isDestroyed()

  function reload() {
    cancel(reloadTimer)
    reloadTimer = later(() => {
      reloadTimer = null
      if (!alive()) return
      reviving = true
      me.webContents.reload()
    }, RELOAD_DELAY_MS)
  }

  me.webContents.on('render-process-gone', (_e, details = {}) => {
    cancel(hangTimer)
    hangTimer = null
    // 창을 닫아서 끝난 것은 정상이다.
    if (details.reason === 'clean-exit' || !alive()) return
    log(`${name}: renderer gone (${details.reason}, exit ${details.exitCode})`)
    try { onGone?.() } catch (err) { log(`${name}: onGone failed: ${err?.message || err}`) }
    const t = now()
    while (crashes.length && t - crashes[0] > CRASH_WINDOW_MS) crashes.shift()
    crashes.push(t)
    if (crashes.length > CRASH_LIMIT) {
      log(`${name}: crashed ${crashes.length} times in a minute, giving up`)
      cancel(reloadTimer)
      onGiveUp()
      return
    }
    reload()
  })

  me.on('unresponsive', () => {
    if (hangTimer) return
    hangTimer = later(() => {
      hangTimer = null
      if (!alive()) return
      log(`${name}: unresponsive for ${HANG_GRACE_MS}ms, reloading`)
      try { onGone?.() } catch {}
      reviving = true
      me.webContents.reload()
    }, HANG_GRACE_MS)
  })
  me.on('responsive', () => {
    cancel(hangTimer)
    hangTimer = null
  })

  me.webContents.on('did-finish-load', () => {
    if (!reviving) return // 처음 불러온 것은 창을 만든 쪽이 따로 챙긴다
    reviving = false
    try { onRevived?.() } catch (err) { log(`${name}: onRevived failed: ${err?.message || err}`) }
  })

  me.on('closed', () => {
    cancel(hangTimer)
    cancel(reloadTimer)
  })
}

module.exports = { guardRenderer, CRASH_WINDOW_MS, CRASH_LIMIT, RELOAD_DELAY_MS, HANG_GRACE_MS }
