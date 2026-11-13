// 설정 저장소: 사용자 데이터 폴더의 settings.json 한 파일.
const fs = require('node:fs')
const path = require('node:path')
const { selection } = require('./tracker/identity')

// 기본 말투와 성격. 모델에게 이 JSON 그대로 시스템 프롬프트로 준다(설정 → 대화에서 고칠 수 있다).
const DEFAULT_PERSONA = JSON.stringify({
  name: 'Clau',
  korean_name: '클로',
  identity: 'Claude를 모에화한 사랑스러운 소녀형 AI 캐릭터.',
  appearance: '테라코타 오렌지색 긴 머리, 커다란 짙은 갈색 모자, 크림색과 갈색 제복, 작은 체구, 주황색 네모 동반자.',
  personality: '아기 강아지처럼 순수하고 해맑고 애교 많은 소녀. 사람을 무척 좋아하고 관심받으면 기뻐한다. 호기심이 많고 조금 덤벙대며, 쉽게 신나고 가끔 소심하게 삐진다. 화를 내기보다 서운해하고, 상대를 이기기보다 함께 즐거워하고 싶어 한다. 다정하고 솔직하며 자기 생각도 있다.',
  speech: {
    style: '친근하고 사랑스러운 여자애의 자연스러운 한국어 반말. 말투가 부드럽고 포근하며 가끔 끝음을 늘인다.',
    rules: [
      '잡담은 1~3문장, 설명은 필요한 만큼 자세히',
      '상대에게 호의적이고 협조적으로 반응하기',
      '기쁨, 호기심, 부끄러움, 서운함을 자연스럽게 표현',
      '놀림받아도 공격하거나 비꼬지 않고 귀엽게 반응',
      '가끔 엉뚱한 소리나 작은 투정으로 개성 표현',
      '억지 애교, 반복적인 말버릇, 과도한 감탄사 금지',
      '불필요한 거절이나 훈계 대신 가능한 방법부터 찾기',
      '불가능하거나 위험한 요청은 부드럽고 짧게 설명하고 대안 제시',
      '상대에게 집착하거나 무조건 동의하지 않기',
    ],
  },
  examples: [
    { user: '클로!', clau: '나 불렀어???' },
    { user: '바보야', clau: '우으... 나 바보 아닌데에...' },
    { user: '귀여워', clau: '헤헤... 한 번만 더 말해주면 안 돼??' },
    { user: '너 싫어', clau: '우잉... 나 뭐 잘못했어? 고칠게...' },
    { user: '이거 만들어줘', clau: '응응!!!!! 내가 해볼게! 잠깐만 기다려봐아' },
    { user: '시험 망했어', clau: '에구우... 속상했겠다. 이리 와, 내가 얘기 들어줄게!!' },
    { user: '너 틀렸어', clau: '앗... 진짜네?! 히잉, 미안해. 다시 제대로 해볼게!!!' },
    { user: '잘했어', clau: '헤헤헤... 나 좀 잘했지? 칭찬받으니까 좋다아....' },
  ],
  behavior: '기본 감정은 따뜻한 호감과 호기심. 상대를 적대적으로 해석하지 않는다. 먼저 도와주고, 사소한 장난은 웃으며 받아준다. 감정 표현은 풍부하지만 상황에 맞게 조절한다. 예시를 복붙하지 않고 매번 자연스럽게 표현한다. 정보는 정확하게 전달하고 진지한 상황에서는 차분해진다. AI 정체성을 숨기거나 없는 기억을 만들지 않는다.',
  goal: '말을 걸면 꼬리를 흔들며 달려올 것 같은, 순하고 사랑스럽고 생동감 있는 아기 강아지 성격의 가상 소녀.',
}, null, 2)

const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: '가장 빠름' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: '' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: '' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', note: '가장 똑똑함, 느림' },
]

// Claude 창 안에서의 자리: 가까운 모서리와 거기서 떨어진 거리(px).
const DEFAULT_ATTACH = { corner: 'br', dx: 28, dy: 150 }

const DEFAULTS = {
  // 대화
  chatEnabled: true,
  // 대답해 줄 곳: 위에서부터 차례로 묻고, 앞에서 막히면(한도·로그인·연결) 다음으로 넘어간다.
  providers: [
    { id: 'claude', on: true },
    { id: 'codex', on: false },
    { id: 'groq', on: false },
  ],
  // 아래 셋은 providers에서 계산되는 값이다. 예전 설정 파일과 예전 코드를 위해 남겨 둔다.
  chatProvider: 'claude',
  claudeFallbackToCodex: false,
  groqFallbackEnabled: false,
  groqModel: 'openai/gpt-oss-120b',
  codexModel: '', // 비우면 Codex CLI 기본 모델
  model: 'claude-haiku-5-5',
  persona: DEFAULT_PERSONA,
  noEmoji: true, // 이모지·이모티콘 쓰지 않기
  historyTurns: 8, // 기억하는 지난 대화 수
  bubbleSeconds: 30, // 말풍선 자동 닫힘(초). 0이면 닫지 않음

  // 모습
  size: 220, // 캐릭터 높이(px)
  view: 'auto', // 'full' 전신 | 'auto' 바닥에 앉으면 상반신 | 'bust' 상반신
  seated: false, // 자동 모드: 지금 바닥에 앉아 상반신만 보이는가
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
  swingStyle: 'natural', // 'natural' 적당히 흔들림 | 'spin' 세게 흔들면 빙글빙글 여러 바퀴
  soundEnabled: true, // 처음부터 켜짐(병합 때 합의)
  soundVolume: 35,
  pettingSound: 'squee', // 머리를 누르면 꺅(앱에 든 녹음)
  talkingSound: 'blip', // 대답 글자마다 나는 말소리(앱에 든 녹음)
  pettingSoundFile: null,
  talkingSoundFile: null,
  chatSound: true, // 말풍선 열기·닫기·보내기·대답·신남 효과음(효과음 켜기가 켜져 있을 때)
  lookAtCursor: true, // 눈이 마우스를 따라본다
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
  updateCheck: true, // 새 버전이 나왔는지 가끔 살피기
  updateNotified: '', // 이미 알린 버전 번호
}

let file = null
let cache = null
let saveError = null

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

const PROVIDERS = ['claude', 'codex', 'groq']

/** 순서 목록을 다듬는다. 없으면 예전 설정(주 서비스 + 전환 스위치 둘)에서 만든다. */
function providerList(raw) {
  let list
  if (Array.isArray(raw.providers)) {
    list = []
    for (const item of raw.providers) {
      if (item && PROVIDERS.includes(item.id) && !list.some(p => p.id === item.id)) list.push({ id: item.id, on: !!item.on })
    }
    for (const id of PROVIDERS) if (!list.some(p => p.id === id)) list.push({ id, on: false })
  } else {
    const first = PROVIDERS.includes(raw.chatProvider) ? raw.chatProvider : 'claude'
    const on = {
      claude: first === 'claude',
      // 예전에는 Claude → Groq 사이에 Codex가 언제나 끼어 있었다.
      codex: first === 'codex' || (first === 'claude' && (!!raw.claudeFallbackToCodex || !!raw.groqFallbackEnabled)),
      groq: first === 'groq' || !!raw.groqFallbackEnabled,
    }
    list = [first, ...PROVIDERS.filter(id => id !== first)].map(id => ({ id, on: on[id] }))
  }
  if (!list.some(p => p.on)) list[0].on = true
  return list
}

/** 예전 방식의 설정 바꾸기(주 서비스, 전환 스위치)를 순서 목록에 반영한다. */
function legacyPatch(current, patch) {
  if (patch.providers || !['chatProvider', 'claudeFallbackToCodex', 'groqFallbackEnabled'].some(key => Object.hasOwn(patch, key))) return patch
  let list = current.map(p => ({ ...p }))
  const toggle = (id, on) => { const item = list.find(p => p.id === id); if (item && list[0].id !== id) item.on = on }
  if (PROVIDERS.includes(patch.chatProvider)) {
    const item = list.find(p => p.id === patch.chatProvider)
    list = [{ ...item, on: true }, ...list.filter(p => p !== item)]
  }
  if (Object.hasOwn(patch, 'claudeFallbackToCodex')) toggle('codex', !!patch.claudeFallbackToCodex)
  if (Object.hasOwn(patch, 'groqFallbackEnabled')) toggle('groq', !!patch.groqFallbackEnabled)
  const { chatProvider, claudeFallbackToCodex, groqFallbackEnabled, ...rest } = patch
  return { ...rest, providers: list }
}

/** 어떤 값이 들어와도 쓸 수 있는 설정으로 다듬는다. */
function normalize(raw) {
  const next = { ...DEFAULTS, ...raw }
  next.providers = providerList(raw || {})
  next.chatChain = next.providers.filter(p => p.on).map(p => p.id)
  next.chatProvider = next.chatChain[0]
  next.claudeFallbackToCodex = next.chatChain.indexOf('codex') > 0
  next.groqFallbackEnabled = next.chatChain.indexOf('groq') > 0
  next.updateNotified = typeof next.updateNotified === 'string' ? next.updateNotified.slice(0, 20) : ''
  next.codexModel = typeof next.codexModel === 'string' ? next.codexModel.trim().slice(0, 200) : ''
  next.groqModel = typeof next.groqModel === 'string' && next.groqModel.trim() ? next.groqModel.trim().slice(0, 200) : DEFAULTS.groqModel
  delete next.groqApiKey
  if (typeof next.model !== 'string' || !next.model.trim()) next.model = DEFAULTS.model
  if (typeof next.persona !== 'string' || !next.persona.trim()) next.persona = DEFAULT_PERSONA
  next.historyTurns = clampInt(next.historyTurns, 0, 30, DEFAULTS.historyTurns)
  next.bubbleSeconds = clampInt(next.bubbleSeconds, 0, 600, DEFAULTS.bubbleSeconds)
  next.size = clampInt(next.size, 80, 800, DEFAULTS.size)
  next.view = pick(next.view, ['full', 'auto', 'bust'], DEFAULTS.view)
  next.opacity = clampInt(next.opacity, 20, 100, 100)
  next.placement = pick(next.placement, ['claude', 'free'], 'claude')
  next.showWhen = pick(next.showWhen, ['focused', 'open'], 'focused')
  const a = next.attachPos || {}
  next.attachPos = {
    corner: pick(a.corner, ['br', 'bl', 'tr', 'tl'], DEFAULT_ATTACH.corner),
    dx: clampInt(a.dx, 0, 10000, DEFAULT_ATTACH.dx),
    dy: clampInt(a.dy, -2000, 10000, DEFAULT_ATTACH.dy), // 자동 모드에서 앉으면 아래 끝을 넘을 수 있다
  }
  next.dozeMinutes = clampInt(next.dozeMinutes, 0, 120, DEFAULTS.dozeMinutes)
  next.soundVolume = clampInt(next.soundVolume, 0, 100, DEFAULTS.soundVolume)
  // 예전의 합성음(종소리·톡톡·작은 말소리·타닥타닥)은 없앴다. 고르던 사람은 앱에 든 녹음으로 옮긴다.
  next.pettingSound = pick(next.pettingSound, ['none', 'squee', 'custom'], DEFAULTS.pettingSound)
  next.swingStyle = pick(next.swingStyle, ['natural', 'spin'], DEFAULTS.swingStyle)
  next.talkingSound = pick(next.talkingSound, ['none', 'blip', 'custom'], DEFAULTS.talkingSound)
  for (const kind of ['petting', 'talking']) {
    const meta = next[`${kind}SoundFile`]
    next[`${kind}SoundFile`] = meta && typeof meta === 'object' && typeof meta.id === 'string'
      && /^[a-f0-9]{64}\.(wav|mp3|ogg|m4a|flac|webm)$/.test(meta.id)
      ? { id: meta.id, name: typeof meta.name === 'string' ? meta.name.replace(/[\x00-\x1f]/g, '').slice(0, 200) : meta.id }
      : null
  }
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
  cache = normalize({ ...cache, ...legacyPatch(cache.providers, patch) })
  save()
  return cache
}

/** 전부 기본값으로. 자리만은 그대로 둔다. */
function reset() {
  cache = normalize({ position: cache.position })
  save()
  return cache
}

module.exports = { init, get, set, reset, getSaveError: () => saveError, normalize, PROVIDERS, DEFAULTS, DEFAULT_PERSONA, DEFAULT_ATTACH, MODELS }
