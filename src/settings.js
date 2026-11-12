// 설정 창: 값을 바꾸면 바로 반영하고 저장한다. 저장 버튼은 없다.
const el = id => document.getElementById(id)
const CUSTOM = '__custom__'
const fields = [...document.querySelectorAll('[data-key]')]

let info = null
let appsInfo = null
let loadingApps = false
let saveQueue = Promise.resolve()
const previewSound = PetSound.create()
const previewFiles = ChatSound.create()

// ── 탭 ─────────────────────────────────────────────────────────────────
function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('on', tab.dataset.tab === name)
    tab.setAttribute('aria-current', tab.dataset.tab === name ? 'page' : 'false')
  }
  for (const page of document.querySelectorAll('section')) page.classList.toggle('on', page.dataset.page === name)
  document.querySelector('main').scrollTop = 0
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab))

// ── 값 읽고 쓰기 ───────────────────────────────────────────────────────
function read(node) {
  if (node.classList.contains('seg')) return node.querySelector('button.on')?.dataset.value
  if (node.type === 'checkbox') return node.checked
  if (node.type === 'range' || node.type === 'number') return Number(node.value)
  return node.value
}

function write(node, value) {
  if (node.classList.contains('seg')) {
    for (const b of node.querySelectorAll('button')) b.classList.toggle('on', b.dataset.value === value)
  } else if (node.type === 'checkbox') node.checked = !!value
  else if (document.activeElement !== node) node.value = value // 적고 있는 칸은 건드리지 않는다
}

function setStatus(node, text, cls = '') {
  node.textContent = text
  node.className = `${node.classList.contains('note') ? 'note' : 'status'} ${cls}`.trim()
}

function render() {
  const { cfg, models, claudeFound, modSeen, modConnected, hasClaudeCode, tracking, platform } = info
  const mac = platform === 'darwin'
  for (const node of fields) write(node, cfg[node.dataset.key])

  // 모델: 목록에 없는 ID는 직접 입력 칸으로.
  const select = el('model')
  if (!select.options.length) {
    for (const m of models) select.add(new Option(m.label, m.id))
    select.add(new Option('직접 입력…', CUSTOM))
  }
  const known = models.some(m => m.id === cfg.model)
  if (document.activeElement !== el('customModel')) {
    select.value = known ? cfg.model : CUSTOM
    el('customModel').value = known ? '' : cfg.model
    el('customRow').hidden = known
  }

  el('sizeOut').textContent = `${cfg.size}px`
  el('opacityOut').textContent = `${cfg.opacity}%`
  el('soundVolumeOut').textContent = `${cfg.soundVolume}%`
  previewSound.configure(cfg)
  previewFiles.configure(cfg)

  // 조건이 맞을 때만 보이는 줄
  for (const row of document.querySelectorAll('[data-when]')) {
    const [key, want] = row.dataset.when.split('=')
    row.hidden = String(cfg[key]) !== want
  }

  // 자리
  document.querySelector('.seg[data-key="placement"] [data-value="claude"]').disabled = !tracking.supported
  if (!tracking.supported) setStatus(el('trackStatus'), '이 데스크톱에서는 다른 앱의 창 위치를 알 수 없어서 화면 위에만 둘 수 있어요.', 'bad')
  else if (cfg.placement === 'claude' && !tracking.found) setStatus(el('trackStatus'), `${cfg.targetAppSelection?.label || 'Claude'} 창이 열리면 나타나요.`)
  else setStatus(el('trackStatus'), '')
  renderApps()

  // 고정 모드의 하위 옵션은 고정 모드가 켜져 있을 때만 의미가 있다
  el('lockedChat').disabled = !cfg.locked || !cfg.chatEnabled
  el('lockedPetting').disabled = !cfg.locked || !cfg.petting
  el('trayHow').hidden = !cfg.tray
  el('trayHow').textContent = mac ? '메뉴 막대의 클로 아이콘 메뉴에서' : '트레이의 클로 아이콘 메뉴에서'
  el('dragPhysics').disabled = !cfg.dragEnabled || cfg.reduceMotion
  for (const id of ['soundVolume', 'pettingSound', 'talkingSound', 'chatSound']) el(id).disabled = !cfg.soundEnabled
  el('previewChat').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.chatSound === false
  el('previewPetting').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.pettingSound === 'none'
  el('previewTalking').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.talkingSound === 'none'

  // 반응
  if (!cfg.followClaudeCode) setStatus(el('modStatus'), '')
  else if (modSeen) setStatus(el('modStatus'), '생각할 땐 눈을 감고, 말할 땐 입을 움직여요.')
  else setStatus(el('modStatus'), '실행 탭에서 Claude Code와 연결하면 표정이 따라 바뀌어요.')

  // 실행
  el('trayLabel').textContent = mac ? '메뉴 막대 아이콘' : '트레이 아이콘'
  el('dockLabel').textContent = mac ? 'Dock에 보이기' : '작업 표시줄에 보이기'
  el('wakeWithClaude').disabled = !modConnected
  setStatus(el('wakeHelp'), modConnected ? '세션 안에서 /clau 로 부를 수도 있어요.' : '아래에서 Claude Code와 연결하면 쓸 수 있어요.')
  el('linkMod').textContent = modConnected ? '연결 끊기' : '연결하기'
  el('linkMod').disabled = !hasClaudeCode && !modConnected
  if (info.modError) setStatus(el('linkStatus'), `연결하지 못했어요: ${info.modError}`, 'bad')
  else if (modConnected) setStatus(el('linkStatus'), '연결됨. 새로 여는 세션부터 적용돼요.', 'ok')
  else if (!hasClaudeCode) setStatus(el('linkStatus'), '이 컴퓨터에서 Claude Code를 찾지 못했어요.')
  else setStatus(el('linkStatus'), '표정이 Claude Code를 따라 하고, /clau 명령이 생겨요.')
  if (claudeFound) setStatus(el('claudeStatus'), claudeFound, 'ok')
  else setStatus(el('claudeStatus'), 'claude 명령을 찾지 못했어요. 경로를 직접 적어 주세요.', 'bad')
  if (info.codexFound) setStatus(el('codexStatus'), info.codexFound, 'ok')
  else setStatus(el('codexStatus'), 'codex 명령을 찾지 못했어요. 설치 후 로그인하거나 경로를 지정해 주세요.', 'bad')
  const provider = cfg.chatProvider === 'codex' ? 'Codex' : 'Claude Code'
  const found = cfg.chatProvider === 'codex' ? info.codexFound : claudeFound
  setStatus(el('providerStatus'), !cfg.chatEnabled ? '대화가 꺼져 있어요. 쓰다듬기와 자리 옮기기는 따로 설정할 수 있어요.' : found ? `${provider}로 대화해요. 해당 CLI에 로그인되어 있어야 해요.` : `${provider} 실행 파일을 찾지 못했어요. 실행 탭에서 연결을 확인해 주세요.`, cfg.chatEnabled && !found ? 'bad' : '')
}

function apply(patch) {
  setStatus(el('saveStatus'), '저장 중…')
  saveQueue = saveQueue.then(async () => {
    info = await window.pet.setSettings(patch)
    render()
    setStatus(el('saveStatus'), info.saveError ? `이번 실행에만 적용됐어요. 저장 실패: ${info.saveError}` : '저장했어요.', info.saveError ? 'bad' : 'ok')
  }).catch(error => setStatus(el('saveStatus'), `저장하지 못했어요: ${error.message || error}`, 'bad'))
  return saveQueue
}

const appKey = app => `${app.kind}:${app.id}`
function renderApps() {
  const select = el('targetAppSelect')
  const chosen = info.cfg.targetAppSelection
  const apps = appsInfo?.apps || []
  select.replaceChildren()
  select.add(new Option(chosen ? '앱을 선택해 주세요' : '실행 중인 앱을 선택해 주세요', ''))
  if (chosen && !apps.some(app => appKey(app) === appKey(chosen))) select.add(new Option(`${chosen.label} · 저장됨, 현재 창 없음`, appKey(chosen)))
  for (const app of apps) select.add(new Option(`${app.label}${app.windows > 1 ? ` · 창 ${app.windows}개` : ''}`, appKey(app)))
  select.value = chosen ? appKey(chosen) : ''
  select.disabled = loadingApps || (!!appsInfo && !appsInfo.supported)
  el('refreshApps').disabled = loadingApps
  if (loadingApps) setStatus(el('appsStatus'), '지금 창이 열려 있는 앱을 찾고 있어요…')
  else if (appsInfo?.error) setStatus(el('appsStatus'), `${appsInfo.error} 저장한 앱 선택은 유지돼요.`, 'bad')
  else if (appsInfo && !appsInfo.supported) setStatus(el('appsStatus'), '이 데스크톱에서는 앱 목록을 읽을 수 없어요. 화면 위 모드를 이용해 주세요.', 'bad')
  else if (appsInfo && !apps.length) setStatus(el('appsStatus'), '선택할 앱 창이 없어요. 앱을 연 뒤 새로고침해 주세요.')
  else setStatus(el('appsStatus'), chosen ? `${chosen.label} 선택을 기억했어요. 앱을 다시 열어도 따라가요.` : '열려 있는 앱을 고르면 다음 실행에도 기억해요.')
}

async function refreshApps() {
  if (loadingApps || !info) return
  loadingApps = true
  renderApps()
  try { appsInfo = await window.pet.listApps() }
  catch (error) { appsInfo = { supported: true, apps: appsInfo?.apps || [], error: String(error.message || error) } }
  finally { loadingApps = false; renderApps() }
}
el('refreshApps').addEventListener('click', refreshApps)
el('targetAppSelect').addEventListener('change', () => {
  const app = appsInfo?.apps.find(app => appKey(app) === el('targetAppSelect').value)
  if (app) apply({ targetAppSelection: { kind: app.kind, id: app.id, label: app.label } })
})
el('previewPetting').addEventListener('click', () => {
  // '꺅'은 녹음 파일, 나머지는 합성음
  if (el('pettingSound').value === 'squee') previewFiles.preview('squee')
  else { previewSound.unlock(); previewSound.pat() }
})
el('previewChat').addEventListener('click', () => previewFiles.preview('chatOpen'))
el('previewTalking').addEventListener('click', () => { previewSound.unlock(); previewSound.talk() })
window.addEventListener('beforeunload', () => previewSound.dispose())

// ── 이벤트 ─────────────────────────────────────────────────────────────
for (const node of fields) {
  const key = node.dataset.key
  if (node.classList.contains('seg')) {
    node.addEventListener('click', e => {
      const button = e.target.closest('button')
      if (button && !button.disabled) apply({ [key]: button.dataset.value })
    })
  } else if (node.type === 'range') {
    // 끄는 동안에도 바로 미리 보기
    node.addEventListener('input', () => apply({ [key]: read(node) }))
  } else if (node.tagName === 'TEXTAREA' || node.type === 'text') {
    let timer = null
    const commit = () => {
      clearTimeout(timer)
      if (read(node) !== info.cfg[key]) apply({ [key]: read(node) })
    }
    node.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(commit, 700)
    })
    node.addEventListener('blur', commit)
  } else {
    node.addEventListener('change', () => apply({ [key]: read(node) }))
  }
}

el('model').addEventListener('change', () => {
  const picked = el('model').value
  el('customRow').hidden = picked !== CUSTOM
  if (picked === CUSTOM) el('customModel').focus()
  else apply({ model: picked })
})
el('customModel').addEventListener('change', () => {
  const id = el('customModel').value.trim()
  if (id) apply({ model: id })
})
el('resetPersona').addEventListener('click', () => {
  el('persona').value = info.defaultPersona
  apply({ persona: info.defaultPersona })
})
el('clearChat').addEventListener('click', () => {
  window.pet.clearChat()
  // 눌렸다는 걸 잠깐 보여 준다.
  el('clearChat').textContent = '지웠어요'
  setTimeout(() => (el('clearChat').textContent = '지우기'), 1200)
})
el('linkMod').addEventListener('click', async () => {
  info = await window.pet.connectMod(!info.modConnected)
  render()
})
el('resetPlace').addEventListener('click', () => apply({ attachPos: null, position: null }))
el('resetAll').addEventListener('click', async () => {
  if (!confirm('모든 설정을 처음 상태로 돌릴까요? 말투와 성격에 적은 내용도 지워져요.')) return
  saveQueue = saveQueue.then(async () => {
    info = await window.pet.resetSettings()
    render()
    setStatus(el('saveStatus'), info.saveError ? `초기화 저장 실패: ${info.saveError}` : '처음 설정으로 되돌렸어요.', info.saveError ? 'bad' : 'ok')
  }).catch(error => setStatus(el('saveStatus'), String(error.message || error), 'bad'))
})

// 오른쪽 클릭 메뉴에서 바꾼 것도 여기에 바로 비친다.
window.pet.onCfg(() => {
  saveQueue = saveQueue.then(async () => { info = await window.pet.getSettings(); render() })
    .catch(error => setStatus(el('saveStatus'), String(error.message || error), 'bad'))
})

window.pet.getSettings().then(first => {
  info = first
  render()
  showTab('chat')
  refreshApps()
}).catch(error => setStatus(el('saveStatus'), `설정을 불러오지 못했어요: ${error.message || error}`, 'bad'))
