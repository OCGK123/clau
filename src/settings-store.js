// 설정 저장소: 사용자 데이터 폴더의 settings.json 한 파일.
const fs = require('node:fs')
const path = require('node:path')
const { selection } = require('./tracker/identity')

const DEFAULT_PERSONA = [
  '너는 클로야. 사용자의 앱 창 한쪽에 사는 작은 친구야.',
  '엄청 친절하고 해맑은 성격이고, 친한 친구랑 실제로 대화하듯 말해.',
  '답은 한두 문장으로 짧게 해. 긴 설명, 목록, 제목, 마크다운은 쓰지 마.',
  '사용자가 더 자세히 알려달라고 할 때만 조금 더 길게 말해도 돼.',
  '사용자가 쓴 언어로 답하고, 모르는 건 모른다고 솔직하게 말해.',
].join(' ')

const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (기본, 가장 빠름)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2 (가장 똑똑함, 느림)' },
]

// Claude 창 안에서의 자리: 가까운 모서리와 거기서 떨어진 거리(px).
const DEFAULT_ATTACH = { corner: 'br', dx: 28, dy: 150 }

const DEFAULTS = {
  // 대화
  chatEnabled: true,
  chatProvider: 'claude',
  codexModel: '', // 비우면 Codex CLI 기본 모델
  model: 'claude-haiku-5-5',
  persona: DEFAULT_PERSONA,
  noEmoji: true, // 이모지·이모티콘 쓰지 않기
  historyTurns: 8, // 기억하는 지난 대화 수
  bubbleSeconds: 30, // 말풍선 자동 닫힘(초). 0이면 닫지 않음

  // 모습
  size: 220, // 캐릭터 높이(px)
  view: 'full', // 'full' 전신 | 'bust' 상반신
  showBuddy: true, // 작은 친구 표시
  opacity: 100, // 불투명도(%)
  flip: false, // 좌우 반전

  // 자리
  placement: 'claude', // 'claude' Claude 창 안에 붙기 | 'free' 화면 위에 자유롭게
  showWhen: 'focused', // 'focused' Claude 창이 맨 앞일 때만 | 'open' Claude 창이 열려 있는 동안
  attachPos: DEFAULT_ATTACH,
  position: null, // 자유 모드의 마지막 위치 { x, y }
  alwaysOnTop: true, // 자유 모드에서 항상 위에

  // 고정 모드: 자리를 못 옮기고 마우스도 통과한다
  locked: false,
  lockedChat: false, // 고정 모드에서도 눌러서 대화
  lockedPetting: false, // 고정 모드에서도 쓰다듬기

  // 반응
  followClaudeCode: true, // Claude Code 상태(생각 중/말하는 중/사용 제한) 따라 하기
  petting: true, // 머리를 누르면 쓰다듬기
  dragEnabled: true,
  dragPhysics: true,
  soundEnabled: false,
  soundVolume: 35,
  pettingSound: 'chime',
  talkingSound: 'soft',
  dozeMinutes: 3, // 이만큼 조용하면 졸기. 0이면 졸지 않음
  reduceMotion: false, // 움직임 줄이기

  // 연결
  claudePath: '', // 비우면 자동으로 찾음
  codexPath: '',
  targetApp: 'claude', // 따라붙을 앱 이름(창 클래스나 프로세스 이름의 일부)
  targetAppSelection: null, // 실행 중인 앱에서 선택한 고유 식별자. PID는 저장하지 않는다.
  tray: true, // 트레이(macOS는 메뉴 막대) 아이콘
  showInDock: false, // Dock(macOS)이나 작업 표시줄에 아이콘 보이기
  autostart: false, // 로그인할 때 자동 실행
  wakeWithClaude: true, // Claude Code를 열면 같이 깨우기(연결돼 있을 때)
}

let file = null
let cache = null
let saveError = null

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/** 어떤 값이 들어와도 쓸 수 있는 설정으로 다듬는다. */
function normalize(raw) {
  const next = { ...DEFAULTS, ...raw }
  next.chatProvider = pick(next.chatProvider, ['claude', 'codex'], DEFAULTS.chatProvider)
  next.codexModel = typeof next.codexModel === 'string' ? next.codexModel.trim().slice(0, 200) : ''
  if (typeof next.model !== 'string' || !next.model.trim()) next.model = DEFAULTS.model
  if (typeof next.persona !== 'string' || !next.persona.trim()) next.persona = DEFAULT_PERSONA
  next.historyTurns = clampInt(next.historyTurns, 0, 30, DEFAULTS.historyTurns)
  next.bubbleSeconds = clampInt(next.bubbleSeconds, 0, 600, DEFAULTS.bubbleSeconds)
  next.size = clampInt(next.size, 80, 800, DEFAULTS.size)
  next.view = pick(next.view, ['full', 'bust'], 'full')
  next.opacity = clampInt(next.opacity, 20, 100, 100)
  next.placement = pick(next.placement, ['claude', 'free'], 'claude')
  next.showWhen = pick(next.showWhen, ['focused', 'open'], 'focused')
  const a = next.attachPos || {}
  next.attachPos = {
    corner: pick(a.corner, ['br', 'bl', 'tr', 'tl'], DEFAULT_ATTACH.corner),
    dx: clampInt(a.dx, 0, 10000, DEFAULT_ATTACH.dx),
    dy: clampInt(a.dy, 0, 10000, DEFAULT_ATTACH.dy),
  }
  next.dozeMinutes = clampInt(next.dozeMinutes, 0, 120, DEFAULTS.dozeMinutes)
  next.soundVolume = clampInt(next.soundVolume, 0, 100, DEFAULTS.soundVolume)
  next.pettingSound = pick(next.pettingSound, ['none', 'chime', 'pop'], DEFAULTS.pettingSound)
  next.talkingSound = pick(next.talkingSound, ['none', 'soft', 'type'], DEFAULTS.talkingSound)
  next.targetApp = (typeof next.targetApp === 'string' && next.targetApp.trim().toLowerCase()) || DEFAULTS.targetApp
  if (typeof next.claudePath !== 'string') next.claudePath = ''
  if (typeof next.codexPath !== 'string') next.codexPath = ''
  next.targetAppSelection = selection(next.targetAppSelection)
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === 'boolean') next[key] = !!next[key]
  }
  return next
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const draft = `${file}.tmp`
    fs.writeFileSync(draft, JSON.stringify(cache, null, 2))
    fs.renameSync(draft, file)
    saveError = null
  } catch (error) {
    // Keep the current session usable, but tell settings that restart persistence failed.
    saveError = String(error.message || error)
  }
}

function init(userDataDir) {
  saveError = null
  file = path.join(userDataDir, 'settings.json')
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 첫 실행이거나 파일이 깨졌으면 기본값으로 시작한다.
  }
  cache = normalize(saved)
  return cache
}

function get() {
  return cache
}

function set(patch) {
  cache = normalize({ ...cache, ...patch })
  save()
  return cache
}

/** 전부 기본값으로. 자리만은 그대로 둔다. */
function reset() {
  cache = normalize({ position: cache.position })
  save()
  return cache
}

module.exports = { init, get, set, reset, getSaveError: () => saveError, normalize, DEFAULTS, DEFAULT_PERSONA, DEFAULT_ATTACH, MODELS }
