// Codex CLI의 기존 로그인을 사용한다. 클로 대화는 저장하지 않고 읽기 전용으로 실행한다.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { NO_EMOJI_RULE } = require('./clean')
const { buildPrompt } = require('./claude')
const { findExecutable, runJsonLines, rejected } = require('./cli')

const findCodex = (custom, options) => findExecutable('codex', custom, options)

function buildArgs(cfg) {
  const persona = [
    cfg.persona,
    cfg.noEmoji ? NO_EMOJI_RULE : '',
    '이 세션은 데스크톱 친구와 나누는 대화야. 대화에만 답하고 도구, 파일, 명령 실행은 사용하지 마.',
  ].filter(Boolean).join(' ')
  const args = [
    'exec', '--json', '--color', 'never', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'mcp_servers={}',
    '-c', `developer_instructions=${JSON.stringify(persona)}`,
  ]
  // No user hooks, connected apps or subprocess-capable tools in companion chat.
  for (const feature of ['shell_tool', 'hooks', 'plugins', 'apps', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'view_image', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'workspace_dependencies', 'code_mode_host']) {
    args.push('-c', `features.${feature}=false`)
  }
  if (typeof cfg.codexModel === 'string' && cfg.codexModel.trim()) args.push('--model', cfg.codexModel.trim())
  args.push('-')
  return args
}

function ask({ question, history, cfg, onDelta }, deps = {}) {
  const bin = (deps.findCodex || findCodex)(cfg.codexPath)
  if (!bin) {
    const err = new Error('codex 명령을 찾지 못했어요. Codex CLI를 설치하고 codex login으로 로그인하거나, 설정에서 실행 파일 경로를 지정해 주세요.')
    err.code = 'NO_CODEX'
    return rejected(err)
  }
  let cwd
  try {
    cwd = (deps.mkdtempSync || fs.mkdtempSync)(path.join(os.tmpdir(), 'clau-chat-'))
  } catch (err) { return rejected(err) }
  const cleanup = () => {
    try { (deps.rmSync || fs.rmSync)(cwd, { recursive: true, force: true }) } catch { /* OS can remove a busy temp folder later. */ }
  }
  const messages = new Map()
  let text = ''
  let failure = null
  return runJsonLines({
    bin, name: 'codex', args: buildArgs(cfg), cwd,
    prompt: buildPrompt(question, history), cleanup,
    onMessage(msg) {
      if (['item.updated', 'item.completed'].includes(msg.type) && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
        messages.set(msg.item.id || 'answer', msg.item.text)
        const full = [...messages.values()].join('\n')
        if (full !== text) {
          const delta = full.startsWith(text) ? full.slice(text.length) : full
          text = full
          onDelta?.(delta, text)
        }
      } else if (msg.type === 'turn.failed') {
        failure = msg.error?.message || 'Codex가 대답을 마치지 못했어요.'
      } else if (msg.type === 'error') {
        failure = msg.message || msg.error?.message || 'Codex 연결에 문제가 생겼어요.'
      } else if (msg.type === 'turn.completed') {
        // An earlier reconnect error may have recovered successfully.
        failure = null
      }
    },
    finish() {
      if (failure) throw new Error(failure)
      if (!text.trim()) throw new Error('Codex가 답 없이 끝났어요. codex login으로 로그인 상태를 확인해 주세요.')
      return { text: text.trim() }
    },
  }, deps)
}

module.exports = { ask, findCodex, buildArgs }
