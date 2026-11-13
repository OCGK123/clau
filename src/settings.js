// 설정 창: 값을 바꾸면 바로 반영하고 저장한다. 저장 버튼은 없다.
const el = id => document.getElementById(id)
const CUSTOM = '__custom__'
const fields = [...document.querySelectorAll('[data-key]')]

let info = null
let appsInfo = null
let loadingApps = false
let saveQueue = Promise.resolve()
let choosingSound = false
const lists = { codex: null, groq: null } // 받아 온 모델 목록
const previewSound = ClauSound.create({ onError: ({ kind, message }) => setStatus(el(`${kind}FileStatus`), message, 'bad') })

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

// ── 모델 고르기 ────────────────────────────────────────────────────────
// 누르면 이름과 설명이 함께 펼쳐지는 목록. 방향키, Enter, Esc로도 쓸 수 있다.
function createPicker(root, onPick) {
  const button = document.createElement('button')
  const name = document.createElement('span')
  const menu = document.createElement('div')
  button.type = 'button'
  button.className = 'picker-button'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  name.className = 'picker-name'
  menu.className = 'picker-menu'
  menu.setAttribute('role', 'listbox')
  menu.hidden = true
  button.append(name)
  root.append(button, menu)
  let value = null
  let drawn = ''

  const close = refocus => {
    if (menu.hidden) return
    menu.hidden = true
    root.classList.remove('open', 'up')
    button.setAttribute('aria-expanded', 'false')
    if (refocus) button.focus()
  }
  const open = () => {
    if (button.disabled) return
    menu.hidden = false
    root.classList.add('open')
    button.setAttribute('aria-expanded', 'true')
    // 아래 자리가 모자라면 위로 펼친다.
    const box = button.getBoundingClientRect()
    const below = innerHeight - box.bottom
    root.classList.toggle('up', below < Math.min(menu.scrollHeight, 280) + 14 && box.top > below)
    const current = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild
    current?.focus({ preventScroll: true })
    current?.scrollIntoView({ block: 'nearest' })
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()))
  button.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    open()
  })
  menu.addEventListener('click', e => {
    const item = e.target.closest('.picker-item')
    if (!item) return
    close(true)
    if (item.dataset.id !== value) onPick(item.dataset.id)
  })
  menu.addEventListener('keydown', e => {
    const items = [...menu.children]
    const at = items.indexOf(document.activeElement)
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key]
    if (go !== undefined) {
      e.preventDefault()
      items[Math.max(0, Math.min(go, items.length - 1))]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') close()
  })
  document.addEventListener('pointerdown', e => { if (!root.contains(e.target)) close() })
  window.addEventListener('blur', () => close())

  return {
    set(items, next, { disabled = false, placeholder = '' } = {}) {
      const signature = JSON.stringify([items, next, disabled, placeholder])
      if (signature === drawn) return
      drawn = signature
      value = next
      name.textContent = items.find(item => item.id === next)?.label ?? placeholder
      button.disabled = disabled || !items.length
      if (button.disabled) close()
      menu.replaceChildren(...items.map(item => {
        const row = document.createElement('button')
        const label = document.createElement('span')
        row.type = 'button'
        row.className = 'picker-item'
        row.dataset.id = item.id
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(item.id === next))
        label.className = 'name'
        label.textContent = item.label
        row.append(label)
        if (item.note) {
          const note = document.createElement('span')
          note.className = 'note'
          note.textContent = item.note
          row.append(note)
        }
        return row
      }))
    },
  }
}

const pickers = {
  claude: createPicker(el('modelPick'), id => {
    el('customRow').hidden = id !== CUSTOM
    if (id === CUSTOM) {
      customOpen = true
      render()
      el('customModel').focus()
    } else {
      customOpen = false
      apply({ model: id })
    }
  }),
  codex: createPicker(el('codexModelPick'), id => apply({ codexModel: id })),
  groq: createPicker(el('groqModelPick'), id => apply({ groqModel: id })),
}
let customOpen = false

/** 저장해 둔 모델이 목록에서 빠졌어도 고른 그대로 보여 준다. */
const withSaved = (items, id) => (!id || items.some(item => item.id === id) ? items : [...items, { id, label: id, note: '지금 목록에는 없어요' }])

function renderModels() {
  const { cfg, models } = info
  const known = models.some(m => m.id === cfg.model)
  const custom = customOpen || !known
  pickers.claude.set([...models.map(m => ({ id: m.id, label: m.label, note: m.note })), { id: CUSTOM, label: '직접 적기' }], custom ? CUSTOM : cfg.model)
  el('customRow').hidden = !custom
  if (document.activeElement !== el('customModel')) el('customModel').value = known ? '' : cfg.model

  const codex = lists.codex
  pickers.codex.set(withSaved([{ id: '', label: 'Codex 기본', note: 'Codex가 알아서 골라요' }, ...(codex?.models || [])], cfg.codexModel), cfg.codexModel, { disabled: !codex, placeholder: '불러오는 중…' })
  setStatus(el('codexModelNote'), codex?.error || '', codex?.error ? 'bad' : '')

  const groq = lists.groq
  pickers.groq.set(withSaved(groq?.models || [], cfg.groqModel), cfg.groqModel, { disabled: !groq, placeholder: '불러오는 중…' })
  setStatus(el('groqModelNote'), groq?.error || (groq?.source === 'builtin' ? '키를 저장하면 계정에서 쓸 수 있는 모델이 전부 나와요.' : ''), groq?.error ? 'bad' : '')
}

async function loadModels(provider, force = false) {
  try { lists[provider] = await window.pet.listModels(provider, force) }
  catch { lists[provider] = { models: [], source: 'none', error: '모델 목록을 받지 못했어요.' } }
  if (info) { renderModels(); renderProviders() }
}
el('refreshModels').addEventListener('click', async () => {
  el('refreshModels').disabled = true
  await Promise.all([loadModels('codex', true), loadModels('groq', true)])
  el('refreshModels').disabled = false
})

// ── 대답해 줄 곳: 순서 목록 ────────────────────────────────────────────
// 칸을 끌거나 화살표로 순서를 바꾸고, 스위치로 쓸지 말지, 이름을 누르면 그 서비스 설정이 펼쳐진다.
const list = el('providerList')
const items = () => [...list.children]
const NAMES = { claude: 'Claude Code', codex: 'Codex', groq: 'Groq' }
const order = () => items().map(item => ({ id: item.dataset.id, on: item.querySelector('.pswitch').checked }))
let dragState = null

/** 순서를 바꾸면 움직인 칸들이 제자리로 미끄러져 들어간다(FLIP). */
function slide(moved, before) {
  if (info?.cfg.reduceMotion) return
  for (const item of moved) {
    const shift = before.get(item) - item.offsetTop
    if (!shift) continue
    item.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.15)' })
  }
}
const tops = () => new Map(items().map(item => [item, item.offsetTop]))

function saveOrder() {
  apply({ providers: order() })
}

function moveBy(item, step) {
  const all = items()
  const to = all.indexOf(item) + step
  if (to < 0 || to >= all.length) return
  const before = tops()
  if (step < 0) list.insertBefore(item, all[to])
  else list.insertBefore(item, all[to].nextElementSibling)
  slide(items(), before)
  renderRanks()
  saveOrder()
}

function toggleBody(item, open = item.querySelector('.pitem-body').hidden) {
  const body = item.querySelector('.pitem-body')
  body.hidden = !open
  item.classList.toggle('expanded', open)
  item.querySelector('.pitem-open').setAttribute('aria-expanded', String(open))
}

/** 숫자, 화살표, 스위치 상태를 지금 순서에 맞춘다(설정을 다시 받지 않아도 되는 부분). */
function renderRanks() {
  const all = items()
  const on = all.filter(item => item.querySelector('.pswitch').checked)
  for (const [i, item] of all.entries()) {
    const sw = item.querySelector('.pswitch')
    const rank = on.indexOf(item)
    item.classList.toggle('off', !sw.checked)
    item.querySelector('.rank').textContent = rank >= 0 ? String(rank + 1) : ''
    item.querySelector('.up').disabled = i === 0
    item.querySelector('.down').disabled = i === all.length - 1
    // 하나는 언제나 켜져 있어야 대답할 수 있다.
    sw.disabled = sw.checked && on.length === 1
  }
}

function renderProviders() {
  const { cfg, claudeFound, codexFound } = info
  const keyInfo = info.groqCredential || {}
  if (!dragState) {
    // 저장된 순서대로 칸을 놓는다. 이미 그 순서면 건드리지 않는다.
    const want = cfg.providers.map(p => p.id)
    if (items().map(item => item.dataset.id).join() !== want.join()) {
      const before = tops()
      for (const id of want) list.append(list.querySelector(`[data-id="${id}"]`))
      slide(items(), before)
    }
    for (const p of cfg.providers) list.querySelector(`[data-id="${p.id}"] .pswitch`).checked = p.on
  }
  renderRanks()
  list.classList.toggle('disabled', !cfg.chatEnabled)

  // 칸마다 한 줄 요약: 고른 모델, 쓸 수 없으면 그 까닭.
  const label = (all, id, fallback) => all?.find(m => m.id === id)?.label || id || fallback
  const problem = {
    claude: claudeFound ? '' : 'claude 명령을 찾지 못했어요',
    codex: codexFound ? '' : 'codex 명령을 찾지 못했어요',
    groq: keyInfo.configured ? '' : 'API 키가 없어요',
  }
  const model = {
    claude: label(info.models, cfg.model),
    codex: cfg.codexModel ? label(lists.codex?.models, cfg.codexModel) : 'Codex 기본 모델',
    groq: label(lists.groq?.models, cfg.groqModel),
  }
  for (const id of Object.keys(NAMES)) {
    const sub = el(`${id}Summary`)
    sub.textContent = problem[id] || model[id]
    sub.classList.toggle('bad', !!problem[id])
  }

  const first = cfg.chatChain.find(id => !problem[id])
  if (!cfg.chatEnabled) setStatus(el('providerStatus'), '')
  else if (!first) setStatus(el('providerStatus'), '켜 둔 곳 중에 지금 대답할 수 있는 곳이 없어요. 칸을 눌러 설정을 확인해 주세요.', 'bad')
  else if (first !== cfg.chatChain[0]) setStatus(el('providerStatus'), `${NAMES[cfg.chatChain[0]]}를 쓸 수 없어서 ${NAMES[first]}로 대답해요.`)
  else setStatus(el('providerStatus'), '')
}

for (const item of items()) {
  item.querySelector('.pitem-open').addEventListener('click', () => {
    if (item.dataset.dragged) return delete item.dataset.dragged
    toggleBody(item)
  })
  item.querySelector('.up').addEventListener('click', e => { moveBy(item, -1); e.currentTarget.disabled || e.currentTarget.focus() })
  item.querySelector('.down').addEventListener('click', e => { moveBy(item, 1); e.currentTarget.disabled || e.currentTarget.focus() })
  item.querySelector('.pswitch').addEventListener('change', () => { renderRanks(); saveOrder() })
  // 키보드: 이름 칸에서 Alt+↑/↓ 로 옮긴다.
  item.querySelector('.pitem-open').addEventListener('keydown', e => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    moveBy(item, e.key === 'ArrowUp' ? -1 : 1)
    item.querySelector('.pitem-open').focus()
  })
  item.querySelector('.pitem-head').addEventListener('pointerdown', e => {
    // 스위치와 화살표는 그대로 누르게 둔다. 손잡이나 이름 칸을 잡으면 끌 수 있다.
    if (e.button !== 0 || dragState || e.target.closest('.move, .pswitch')) return
    // 아직 붙잡지 않는다. 붙잡으면 그냥 누른 것(클릭)이 이름 버튼에 닿지 않아 설정이 펼쳐지지 않는다.
    // 실제로 끌기 시작할 때 붙잡는다.
    dragState = { item, pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, started: false, from: items().indexOf(item) }
  })
  const head = item.querySelector('.pitem-head')
  window.addEventListener('pointermove', e => {
    const d = dragState
    if (!d || d.item !== item || d.pointerId !== e.pointerId) return
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < 5) return
      d.started = true
      head.setPointerCapture(d.pointerId)
      item.classList.add('dragging')
      list.classList.add('sorting')
    }
    d.lastY = e.clientY
    item.style.transform = `translateY(${e.clientY - d.startY}px)`
    // 끌고 있는 칸의 가운데가 이웃 칸의 가운데를 넘으면 자리를 바꾼다.
    const box = item.getBoundingClientRect()
    const middle = box.top + box.height / 2
    const prev = item.previousElementSibling
    const next = item.nextElementSibling
    let swapWith = null
    if (next) { const r = next.getBoundingClientRect(); if (middle > r.top + r.height / 2) swapWith = next }
    if (!swapWith && prev) { const r = prev.getBoundingClientRect(); if (middle < r.top + r.height / 2) swapWith = prev }
    if (!swapWith) return
    const before = tops()
    const top = item.offsetTop
    if (swapWith === next) list.insertBefore(next, item)
    else list.insertBefore(item, prev)
    // 칸이 새 자리로 옮겨진 만큼 기준점을 옮겨, 손 아래에서 튀지 않게 한다.
    d.startY += item.offsetTop - top
    item.style.transform = `translateY(${e.clientY - d.startY}px)`
    slide([swapWith], before)
    renderRanks()
  })
  const drop = e => {
    const d = dragState
    if (!d || d.item !== item || (e.pointerId !== undefined && d.pointerId !== e.pointerId)) return
    dragState = null
    if (head.hasPointerCapture(d.pointerId)) head.releasePointerCapture(d.pointerId)
    if (!d.started) return
    item.dataset.dragged = '1' // 끌기를 마치며 생기는 클릭이 설정을 펼치지 않게
    setTimeout(() => delete item.dataset.dragged, 0)
    const offset = d.lastY - d.startY
    item.style.transform = ''
    item.classList.remove('dragging')
    list.classList.remove('sorting')
    if (offset && !info?.cfg.reduceMotion) item.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.9,.3,1.1)' })
    if (items().indexOf(item) !== d.from) saveOrder()
  }
  window.addEventListener('pointerup', drop)
  window.addEventListener('pointercancel', drop)
  head.addEventListener('lostpointercapture', drop)
}

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
  const { cfg, claudeFound, modSeen, modConnected, hasClaudeCode, tracking, platform } = info
  const mac = platform === 'darwin'
  for (const node of fields) write(node, cfg[node.dataset.key])

  renderModels()

  el('sizeOut').textContent = `${cfg.size}px`
  el('viewHelp').textContent = cfg.view === 'auto' ? '바닥에 내려놓으면 앉아서 상반신만, 들어 올리면 전신이 보여요.' : ''
  el('opacityOut').textContent = `${cfg.opacity}%`
  el('soundVolumeOut').textContent = `${cfg.soundVolume}%`
  previewSound.configure(cfg)

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
  el('swingStyle').disabled = !cfg.dragEnabled || !cfg.dragPhysics || cfg.reduceMotion
  for (const id of ['soundVolume', 'pettingSound', 'talkingSound', 'chatSound']) el(id).disabled = !cfg.soundEnabled
  el('previewChat').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.chatSound === false
  el('previewPetting').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.pettingSound === 'none'
  el('previewTalking').disabled = !cfg.soundEnabled || !cfg.soundVolume || cfg.talkingSound === 'none'
  for (const kind of ['petting', 'talking']) {
    el(`${kind}FileName`).textContent = cfg[`${kind}SoundFile`]?.name || '아직 고른 파일이 없어요.'
    el(`choose${kind === 'petting' ? 'Petting' : 'Talking'}Sound`).disabled = choosingSound
  }
  const keyInfo = info.groqCredential || {}
  el('clearGroqKey').disabled = !keyInfo.configured
  const needsKey = cfg.chatChain.includes('groq') && !keyInfo.configured
  setStatus(el('groqKeyStatus'), keyInfo.error || (keyInfo.configured ? (keyInfo.persistent ? '저장해 뒀어요. 이 컴퓨터의 보안 저장소에 암호화해서 둬요.' : '이번에 켜 둔 동안만 기억해요. 이 컴퓨터에 보안 저장소가 없어서 파일로 남기지 않아요.') : needsKey ? 'Groq로 대답하려면 키가 있어야 해요.' : ''), keyInfo.error || needsKey ? 'bad' : keyInfo.configured ? 'ok' : '')

  // 반응: 스위치는 실제로 따라 하고 있을 때만 켜져 보인다(연결까지 되어 있어야 한다).
  const following = cfg.followClaudeCode && (modConnected || !hasClaudeCode)
  el('followClaudeCode').checked = following
  el('followClaudeCode').disabled = !hasClaudeCode
  if (info.modError) setStatus(el('modStatus'), `연결하지 못했어요: ${info.modError}`, 'bad')
  else if (!hasClaudeCode) setStatus(el('modStatus'), '이 컴퓨터에서 Claude Code를 찾지 못했어요.')
  else if (!following) setStatus(el('modStatus'), '켜면 Claude Code가 생각할 땐 눈을 감고, 말할 땐 입을 움직이고, 일할 땐 바빠져요.')
  else setStatus(el('modStatus'), modSeen ? '생각, 말하기, 작업, 끝났을 때를 따라 해요. 새로 여는 세션부터 적용돼요.' : '새로 여는 Claude Code 세션부터 따라 해요.')

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
  renderProviders()
  renderUpdate()
}

function saveGroqKey(clear = false) {
  const value = clear ? null : el('groqKey').value
  el('groqKey').value = ''
  saveQueue = saveQueue.then(async () => {
    try {
      info = await window.pet.setGroqKey(value)
      render()
      loadModels('groq', true) // 키가 바뀌면 고를 수 있는 모델도 달라진다
    } catch { setStatus(el('groqKeyStatus'), '키를 저장하지 못했어요. 맞는 키인지 보고 다시 넣어 주세요.', 'bad') }
  })
  return saveQueue
}
el('groqKey').addEventListener('keydown', e => { if (e.key === 'Enter' && el('groqKey').value.trim()) saveGroqKey() })

// ── 업데이트 ───────────────────────────────────────────────────────────
function renderUpdate() {
  const u = info.update
  const busy = ['checking', 'downloading', 'installing'].includes(u.state)
  el('versionLabel').textContent = `클로 ${info.version}`
  el('updateButton').disabled = busy
  el('updateButton').textContent = {
    checking: '확인하는 중',
    available: u.canInstall ? '지금 업데이트' : '받으러 가기',
    downloading: `받는 중 ${u.progress}%`,
    installing: '바꾸는 중',
  }[u.state] || '새 버전 확인'
  el('updateButton').classList.toggle('primary', u.state === 'available')
  el('updateProgress').hidden = u.state !== 'downloading' && u.state !== 'installing'
  el('updateProgress').value = u.progress
  if (u.state === 'error') setStatus(el('updateStatus'), u.error, 'bad')
  else if (u.state === 'latest') setStatus(el('updateStatus'), '최신 버전이에요.', 'ok')
  else if (u.state === 'available') setStatus(el('updateStatus'), `${u.version} 버전이 나왔어요.${u.canInstall ? ' 받아서 바꾼 뒤 다시 켜져요.' : ''}`)
  else if (u.state === 'installing') setStatus(el('updateStatus'), '곧 새 버전으로 다시 켜져요.')
  else setStatus(el('updateStatus'), '')
}
el('updateButton').addEventListener('click', async () => {
  const u = info.update
  if (u.state === 'available' && !u.canInstall) return window.pet.openUpdatePage()
  info = await (u.state === 'available' ? window.pet.installUpdate() : window.pet.checkUpdate())
  renderUpdate()
})
window.pet.onUpdate(next => {
  if (!info) return
  info.update = next
  renderUpdate()
})
el('saveGroqKey').addEventListener('click', () => saveGroqKey())
el('clearGroqKey').addEventListener('click', () => saveGroqKey(true))

function apply(patch) {
  saveQueue = saveQueue.then(async () => {
    info = await window.pet.setSettings(patch)
    render()
    // 잘 됐을 땐 조용히. 파일에 못 적었을 때만 알린다.
    setStatus(el('saveStatus'), info.saveError ? `지금은 바뀌었지만 파일에 적지 못했어요: ${info.saveError}` : '', 'bad')
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
async function playPreview(kind) {
  await saveQueue
  try {
    previewSound.configure(info.cfg)
    await previewSound.prepare(kind)
    await previewSound.preview(kind)
    setStatus(el(`${kind}FileStatus`), '')
  } catch (error) { setStatus(el(`${kind}FileStatus`), `이 소리를 재생하지 못했어요: ${error.message || error}`, 'bad') }
}
function chooseSound(kind) {
  if (choosingSound) return saveQueue
  choosingSound = true
  render()
  saveQueue = saveQueue.then(async () => {
    const previous = { [`${kind}Sound`]: info.cfg[`${kind}Sound`], [`${kind}SoundFile`]: info.cfg[`${kind}SoundFile`] }
    try {
      const result = await window.pet.chooseSound(kind)
      info = result.info
      render()
      if (result.cancelled) return
      if (result.error) throw new Error(result.error)
      previewSound.configure(info.cfg)
      try { await previewSound.prepare(kind) }
      catch (error) {
        info = await window.pet.setSettings(previous)
        render()
        throw new Error(`이 파일을 해석하지 못했어요. 다른 파일을 골라 주세요. ${error.message || error}`)
      }
      setStatus(el(`${kind}FileStatus`), '파일을 클로에 복사해 두었어요. 원래 파일을 옮겨도 사용할 수 있어요.', 'ok')
      setStatus(el('saveStatus'), info.saveError ? `파일에 적지 못했어요: ${info.saveError}` : '', 'bad')
    } catch (error) { setStatus(el(`${kind}FileStatus`), String(error.message || error), 'bad') }
    finally { choosingSound = false; render() }
  })
  return saveQueue
}
el('previewPetting').addEventListener('click', () => playPreview('petting'))
el('previewTalking').addEventListener('click', () => playPreview('talking'))
el('choosePettingSound').addEventListener('click', () => chooseSound('petting'))
el('chooseTalkingSound').addEventListener('click', () => chooseSound('talking'))
el('previewChat').addEventListener('click', () => { previewSound.configure(info.cfg); previewSound.preview('chatResult') })
window.addEventListener('beforeunload', () => previewSound.dispose())
window.pet.onSoundError?.(({kind, message}) => setStatus(el(`${kind}FileStatus`), message, 'bad'))

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
    node.addEventListener('change', () => {
      if (['pettingSound', 'talkingSound'].includes(key) && read(node) === 'custom' && !info.cfg[`${key}File`]) return chooseSound(key === 'pettingSound' ? 'petting' : 'talking')
      apply({ [key]: read(node) })
    })
  }
}

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
el('resetPlace').addEventListener('click', () => apply({ attachPos: null, position: null, seated: false }))
el('resetAll').addEventListener('click', async () => {
  if (!confirm('모든 설정을 처음 상태로 돌릴까요? 말투와 성격에 적은 내용도 지워져요.')) return
  saveQueue = saveQueue.then(async () => {
    info = await window.pet.resetSettings()
    render()
    customOpen = false
    setStatus(el('saveStatus'), info.saveError ? `파일에 적지 못했어요: ${info.saveError}` : '', 'bad')
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
  loadModels('codex')
  loadModels('groq')
}).catch(error => setStatus(el('saveStatus'), `설정을 불러오지 못했어요: ${error.message || error}`, 'bad'))
