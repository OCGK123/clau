// 설치 마법사: 설치가 끝난 직후 한 번 뜬다. 고르는 즉시 설정에 저장하므로, 중간에 닫아도 고른 데까지는 남는다.
;(function () {
  const el = id => document.getElementById(id)
  const LAST = 4 // 마지막(완료) 단계
  const pages = [...document.querySelectorAll('.page')]
  const stepItems = [...document.querySelectorAll('#steps li')]
  const next = el('next')
  const back = el('back')
  const skip = el('skip')
  let step = 0
  let info = null

  /** 지금 설정을 화면에 옮긴다. */
  function render() {
    const cfg = info.cfg
    for (const input of document.querySelectorAll('input[name="placement"]')) input.checked = input.value === cfg.placement
    el('size').value = cfg.size
    el('sizeOut').textContent = `${cfg.size}px`
    el('soundEnabled').checked = cfg.soundEnabled
    el('soundVolume').value = cfg.soundVolume
    el('soundVolume').disabled = !cfg.soundEnabled
    el('volumeOut').textContent = `${cfg.soundVolume}%`
    el('lookAtCursor').checked = cfg.lookAtCursor
    el('reduceMotion').checked = cfg.reduceMotion
    el('followClaudeCode').checked = cfg.followClaudeCode && info.modConnected
    el('followClaudeCode').disabled = !info.hasClaudeCode
    if (!info.hasClaudeCode) el('ccNote').textContent = '이 컴퓨터에서 Claude Code를 찾지 못했어요. 설치한 뒤 설정에서 켤 수 있어요.'
    el('autostart').checked = cfg.autostart
    el('version').textContent = info.version ? `클로 ${info.version}` : ''
  }

  function showStep(n) {
    step = Math.max(0, Math.min(LAST, n))
    pages.forEach((page, i) => { page.hidden = i !== step })
    stepItems.forEach((item, i) => {
      item.classList.toggle('done', i < step)
      item.classList.toggle('current', i === step)
    })
    back.hidden = step === 0 || step === LAST
    skip.hidden = step === LAST
    next.textContent = step === 0 ? '시작하기' : step === LAST ? '클로와 함께하기' : '다음'
    if (step === LAST) summarize()
    // 키보드로 넘길 때만 다음 단추로 초점을 옮긴다(마우스로 누를 때 테두리가 번쩍이지 않게).
    if (document.activeElement && document.activeElement !== document.body) next.focus()
  }

  function summarize() {
    const cfg = info.cfg
    const lines = [
      cfg.placement === 'claude' ? 'Claude 창 옆에 붙어 있어요.' : '화면 위에 자유롭게 떠 있어요.',
      `크기 ${cfg.size}px`,
      cfg.soundEnabled ? `효과음 켜짐 (${cfg.soundVolume}%)` : '효과음 꺼짐',
      cfg.followClaudeCode && info.modConnected ? 'Claude Code와 연결됨' : 'Claude Code 연결 안 함',
      cfg.autostart ? '컴퓨터를 켤 때 같이 시작' : '직접 열 때만 시작',
    ]
    el('summary').replaceChildren(...lines.map(text => Object.assign(document.createElement('li'), { textContent: text })))
  }

  async function save(patch) {
    info = await window.pet.setSettings(patch)
    const error = el('error')
    error.hidden = !info.modError
    error.textContent = info.modError ? `Claude Code에 연결하지 못했어요: ${info.modError}` : ''
    render()
  }

  for (const input of document.querySelectorAll('input[name="placement"]')) {
    input.addEventListener('change', () => save({ placement: input.value }))
  }
  el('size').addEventListener('input', () => { el('sizeOut').textContent = `${el('size').value}px` })
  el('size').addEventListener('change', () => save({ size: Number(el('size').value) }))
  el('soundVolume').addEventListener('input', () => { el('volumeOut').textContent = `${el('soundVolume').value}%` })
  el('soundVolume').addEventListener('change', () => save({ soundVolume: Number(el('soundVolume').value) }))
  for (const key of ['soundEnabled', 'lookAtCursor', 'reduceMotion', 'autostart']) {
    el(key).addEventListener('change', () => save({ [key]: el(key).checked }))
  }
  el('followClaudeCode').addEventListener('change', async () => {
    const on = el('followClaudeCode').checked
    // 켜면 settings:set이 연결까지 한다. 끄면 연결도 같이 거둔다.
    if (!on && info.modConnected) info = await window.pet.connectMod(false)
    await save({ followClaudeCode: on })
  })

  next.addEventListener('click', () => (step === LAST ? window.pet.finishSetup() : showStep(step + 1)))
  back.addEventListener('click', () => showStep(step - 1))
  skip.addEventListener('click', () => window.pet.finishSetup())
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') window.pet.finishSetup()
  })

  // 마법사가 떠 있는 동안 다른 데(트레이 메뉴, 크기 조절)서 바뀐 설정도 따라 그린다.
  window.pet.onCfg(cfg => {
    if (!info) return
    info = { ...info, cfg }
    render()
    if (step === LAST) summarize()
  })

  window.pet.getSettings().then(result => {
    info = result
    render()
    showStep(0)
  })
})()
