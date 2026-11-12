// 클로(Clau) 연동.
// Claude가 지금 무엇을 하는지 ~/.claude/clau/state.json 에 적으면 클로가 그걸 보고 표정을 바꾼다.
// /clau 명령으로 클로를 부르고, 세션을 열 때 같이 깨운다. 이 mod는 아무것도 그리지 않는다.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PetMode, PetState } from '../types'

const pet = atom({ plugin: 'clau', key: 'pet' } as const, { mode: 'idle' } as PetState, {
  shape: 'pet-4',
})

let liveMode: PetMode | undefined
let wakeTimer: Timer | undefined
let stateFile: string | undefined
// The pet's own `claude -p` call must not move the pet a second time.
let isMuted = false

/** ~/.claude/clau, where the app and this mod leave notes for each other. */
async function clauDir($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude/clau` : undefined
}

async function statePath($: EngineInterface): Promise<string | undefined> {
  if (stateFile) return stateFile
  const dir = await clauDir($)
  if (!dir) return undefined
  stateFile = `${dir}/state.json`
  return stateFile
}

/** Where the app lives; it writes this every time it starts. */
type AppInfo = { exec: string; args?: string[]; platform?: string; wake?: boolean }

async function appInfo($: EngineInterface): Promise<AppInfo | undefined> {
  const dir = await clauDir($)
  if (!dir) return undefined
  try {
    const info = JSON.parse(await $.fs.read(`${dir}/app.json`)) as AppInfo
    return typeof info.exec === 'string' && info.exec ? info : undefined
  } catch {
    return undefined
  }
}

/**
 * Starts the app, or hands `flags` to the one already up, and lets go of it:
 * the pet must outlive this session.
 */
async function launch($: EngineInterface, flags: string[]): Promise<boolean> {
  const app = await appInfo($)
  if (!app) return false
  const argv = [app.exec, ...(app.args ?? []), ...flags]
  const detached =
    app.platform === 'win32'
      ? [...argv, '--detach'] // the app starts a copy of itself and exits
      : ['sh', '-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', ...argv]
  try {
    await $.process.run(detached, { timeoutMs: 10_000 })
    return true
  } catch {
    return false
  }
}

const COMMANDS: Record<string, { flag: string; said: string }> = {
  '': { flag: '--hello', said: '클로를 불렀어요.' },
  settings: { flag: '--settings', said: '클로 설정을 열었어요.' },
  unlock: { flag: '--unlock', said: '고정 모드를 껐어요.' },
  quit: { flag: '--quit', said: '클로를 껐어요.' },
}

/** Asleep on the usage limit, and the reset (if known) is still ahead. */
const isLimited = (s: PetState) =>
  s.mode === 'sleeping' && (s.resetsAt === undefined || Date.parse(s.resetsAt) > Date.now())

async function setMode($: EngineInterface, mode: PetMode, resetsAt?: string) {
  liveMode = mode
  await update($, pet, cur => (cur.mode === mode && cur.resetsAt === resetsAt ? cur : { mode, resetsAt }))
  const file = await statePath($)
  if (!file) return
  try {
    await $.fs.write(file, JSON.stringify({ mode, resetsAt: resetsAt ?? null, at: Date.now() }))
  } catch {
    // The pet window simply keeps its last face.
  }
}

/** Mood changes from the turn itself; they never wake a pet the usage limit put to sleep. */
async function moodTo($: EngineInterface, mode: PetMode) {
  if (isMuted || liveMode === mode) return
  if (isLimited(await read($, pet))) return
  await setMode($, mode)
}

function scheduleWake($: EngineInterface, resetsAt?: string) {
  wakeTimer?.cancel()
  wakeTimer = undefined
  if (!resetsAt) return
  const ms = Date.parse(resetsAt) - Date.now()
  if (!(ms > 0)) return
  wakeTimer = $.clock.after(ms + 5000, () => {
    void (async () => {
      if ((await read($, pet)).mode === 'sleeping') await setMode($, 'idle')
    })()
  })
}

async function sleepUntil($: EngineInterface, resetsAt?: string) {
  if (isMuted) return
  await setMode($, 'sleeping', resetsAt)
  scheduleWake($, resetsAt)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isMuted = (await $.env.get('CLAU_CHAT')) === '1'
    if (!isMuted) {
      await $.command.register({
        name: 'clau',
        description: '클로 부르기 (settings: 설정, unlock: 고정 풀기, quit: 끄기)',
        argumentHint: '[settings | unlock | quit]',
      })
      // A person is here (a terminal or an app window): wake the pet if it asked to be.
      if (e.isInteractive || e.surface !== null) {
        void appInfo($).then(app => (app?.wake ? launch($, ['--hello']) : false))
      }
      const cur = await read($, pet)
      liveMode = cur.mode
      if (cur.mode === 'sleeping' && isLimited(cur)) scheduleWake($, cur.resetsAt)
      else if (cur.mode !== 'idle') await setMode($, 'idle')
    }
    return next(e)
  })

  on('command.run', { command: 'clau' }, async ($, e) => {
    const picked = COMMANDS[e.args.trim().toLowerCase()]
    if (!picked) return { text: '쓰는 법: /clau, /clau settings, /clau unlock, /clau quit' }
    if (await launch($, [picked.flag])) return { text: picked.said }
    return { text: '클로가 어디 있는지 몰라요. 클로를 한 번 직접 실행해 주세요.' }
  })

  // A turn opens with Claude thinking.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !isMuted) {
      const cur = await read($, pet)
      // With no known reset time, a new turn is how we find out the limit has lifted.
      if (cur.mode === 'sleeping' && cur.resetsAt === undefined) await setMode($, 'thinking')
      await moodTo($, 'thinking')
    }
    return next(e)
  })

  // Each model response: thinking, then text (talking), or a tool call (working).
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined || isMuted) return yield* stream
    for await (const chunk of stream) {
      if (chunk.kind === 'thinking') void moodTo($, 'thinking')
      else if (chunk.kind === 'text') void moodTo($, 'talking')
      else if (chunk.kind === 'tool' || chunk.kind === 'input') void moodTo($, 'working')
      yield chunk
    }
    const result = await stream.result
    void moodTo($, result.toolUses.length > 0 ? 'working' : 'idle')
    return result
  })

  // The turn's end: happy for an answer, oops for an error or an interruption.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await moodTo($, e.reason === 'answer' ? 'happy' : 'oops')
    return next(e)
  })

  // Usage limit hit: a turn stopped on a rate-limit error.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') {
      const { rateLimits } = await $.session.usage()
      const resetsAt = rateLimits
        .filter(r => r.percentUsed >= 100)
        .map(r => r.resetsAt)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1)
      await sleepUntil($, resetsAt)
    }
    return next(e)
  })

  // Usage windows the API reports: any window at 100% puts the pet to sleep.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const over = e.rateLimits.filter(r => r.percentUsed >= 100)
      if (over.length > 0) {
        await sleepUntil($, over.map(r => r.resetsAt).filter((x): x is string => !!x).sort().at(-1))
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (!isMuted && liveMode !== undefined && liveMode !== 'idle' && liveMode !== 'sleeping') await setMode($, 'idle')
    return next(e)
  })
}
