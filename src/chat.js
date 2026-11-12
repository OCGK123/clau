const claude = require('./claude')
const codex = require('./codex')
const { rejected } = require('./cli')

function ask(options, deps) {
  if (options.cfg.chatEnabled === false) {
    const err = new Error('설정에서 눌러서 대화를 켜 주세요.')
    err.code = 'CHAT_DISABLED'
    return rejected(err)
  }
  return (options.cfg.chatProvider === 'codex' ? codex : claude).ask(options, deps)
}

module.exports = { ask, findClaude: claude.findClaude, findCodex: codex.findCodex }
