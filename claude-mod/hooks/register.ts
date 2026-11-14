// 클로(Clau) 연동.
// Claude가 지금 무엇을 하는지 ~/.claude/clau/state.json 에 적으면 클로가 그걸 보고 표정을 바꾼다.
// /clau 명령으로 클로를 부르고, 세션을 열 때 같이 깨운다. 이 mod는 아무것도 그리지 않는다.
// 일이 끝나거나 한도에 닿으면 클로에게 알리고(말풍선), 권한·질문·계획 승인을 클로 말풍선에서 고르게 한다.
// 클로가 안 떠 있거나 안 보이면 Claude Code가 늘 하던 대로 직접 묻는다.
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

/** Where the app lives; it writes this every time it starts. port/token: its local notice door. */
type AppInfo = { exec: string; args?: string[]; platform?: string; wake?: boolean; port?: number; token?: string; notices?: boolean; ask?: boolean }
type AskReply = { state: 'answered' | 'pending' | 'pass'; answer?: { choice: string; answers?: Record<string, string> } }

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

/** The app's notice door: a POST to 127.0.0.1 with the key it left in app.json. undefined when it is not up. */
async function door<T>($: EngineInterface, app: AppInfo | undefined, path: string, body: unknown): Promise<T | undefined> {
  if (!app?.port || !app.token) return undefined
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clau-token': app.token },
      body: JSON.stringify(body),
    })
    if (!res.ok) return undefined
    return res.text ? (JSON.parse(res.text) as T) : ({} as T)
  } catch {
    return undefined
  }
}

let project: string | undefined
const folderName = (cwd?: string) => (cwd ? cwd.split(/[\\/]+/).filter(Boolean).pop() : undefined)

/** Tells the pet something happened (work done, usage limit). Never waits on it. */
async function notify($: EngineInterface, kind: 'done' | 'limit', extra: Record<string, unknown> = {}) {
  if (isMuted) return
  const app = await appInfo($)
  if (!app || app.notices === false) return
  await door($, app, '/notify', { kind, project, ...extra })
}

let asked = 0
/** What Claude Code should do with the pet's answer; undefined lets Claude Code ask as usual. */
function decide(kind: string, input: unknown, suggestions: unknown, answer: AskReply['answer']) {
  if (!answer) return undefined
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (kind === 'question') {
    if (answer.choice !== 'answers' || !answer.answers) return undefined
    return { behavior: 'allow' as const, updatedInput: { ...given, answers: answer.answers } }
  }
  if (kind === 'plan') return answer.choice === 'allow' ? { behavior: 'allow' as const, updatedInput: given } : undefined
  if (answer.choice === 'allow') return { behavior: 'allow' as const }
  if (answer.choice === 'always') {
    return Array.isArray(suggestions) && suggestions.length
      ? { behavior: 'allow' as const, updatedPermissions: suggestions as never }
      : { behavior: 'allow' as const }
  }
  if (answer.choice === 'deny') return { behavior: 'deny' as const, message: '클로 말풍선에서 거절했어요.', interrupt: true as const }
  return undefined
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
  const already = liveMode === 'sleeping'
  await setMode($, 'sleeping', resetsAt)
  scheduleWake($, resetsAt)
  if (!already) await notify($, 'limit', resetsAt ? { resetsAt } : {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isMuted = (await $.env.get('CLAU_CHAT')) === '1'
    project = folderName(e.cwd)
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
  // An answer also pops "작업을 다 끝냈어요!" over the pet.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await moodTo($, e.reason === 'answer' ? 'happy' : 'oops')
      if (e.reason === 'answer') void notify($, 'done')
    }
    return next(e)
  })

  // Something only the person can decide (a tool permission, a question, a plan): show it in the pet's bubble
  // and hand back what they pick. While this waits Claude Code shows no dialog of its own, so the app says
  // "pass" at once when the pet is not on screen, and after a few minutes with no answer.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (isMuted) return next(e)
    if (next.signal.aborted) return next(e)
    const app = await appInfo($)
    if (!app?.port || !app.token || app.notices === false || app.ask === false) return next(e)
    const kind = e.tool_name === 'AskUserQuestion' ? 'question' : e.tool_name === 'ExitPlanMode' ? 'plan' : 'permission'
    const id = `${e.session_id}-${Date.now().toString(36)}-${++asked}`
    const body = {
      id,
      kind,
      session: e.session_id,
      project: folderName(e.cwd) ?? project,
      cwd: e.cwd,
      tool: e.tool_name,
      input: e.tool_input,
      suggestions: e.permission_suggestions ?? [],
    }
    // Answered in Claude Code itself, or interrupted: take the bubble down.
    let over = false
    const cancel = () => {
      if (over) return
      over = true
      void door($, app, '/cancel', { id })
    }
    let answered = false
    next.signal.addEventListener('abort', cancel)
    // Aborting while appInfo was being read must not create a new request.
    if (next.signal.aborted) cancel()
    try {
      // The app holds each request up to 20 s and gives up after 3 minutes; ask again while it says pending.
      for (let round = 0; round < 15 && !over; round++) {
        const reply = await door<AskReply>($, app, '/ask', body)
        // A response that raced with cancellation must never authorize a tool.
        if (over || next.signal.aborted || !reply || reply.state === 'pass') break
        if (reply.state === 'pending') continue
        if (reply.state !== 'answered') break
        const decision = decide(kind, e.tool_input, e.permission_suggestions, reply.answer)
        if (decision) {
          answered = true
          over = true
          return { decision }
        }
        break
      }
    } finally {
      next.signal.removeEventListener('abort', cancel)
      // A failed poll, malformed response or exhausted polling budget also hands the UI back.
      // Otherwise its stale bubble could later authorize an operation Claude Code no longer awaits.
      if (!answered) {
        over = true
        await door($, app, '/cancel', { id })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a failure here must never block: Claude Code asks as usual

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
