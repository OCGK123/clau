// Credentials stay outside settings and renderer snapshots. Plaintext storage is
// never used when the OS keyring is unavailable (Linux basic_text included).
const fs = require('node:fs')
const path = require('node:path')
function create(dir, safeStorage) {
  const file = path.join(dir, 'credentials', 'groq.enc')
  let key = ''
  let error = ''
  const secure = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text' } catch { return false }
  }
  if (fs.existsSync(file)) {
    try {
      if (!secure()) throw new Error()
      key = safeStorage.decryptString(fs.readFileSync(file))
    } catch { error = '저장된 Groq 키를 열지 못했어요. 키를 다시 입력해 주세요.' }
  }
  return {
    get: () => key,
    info: () => ({ configured: !!key, persistent: !!key && secure() && fs.existsSync(file), error }),
    set(value) {
      if (typeof value !== 'string' || value.trim().length < 16 || value.trim().length > 512 || /[\x00-\x20\x7f]/.test(value.trim())) throw new Error('유효한 Groq API 키를 입력해 주세요.')
      const next = value.trim()
      if (secure()) {
        const bytes = safeStorage.encryptString(next)
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        fs.writeFileSync(file + '.tmp', bytes, { mode: 0o600 })
        fs.renameSync(file + '.tmp', file)
      } else {
        fs.rmSync(file, { force: true })
      }
      key = next
      error = ''
      return this.info()
    },
    clear() { fs.rmSync(file, { force: true }); key = ''; error = ''; return this.info() },
  }
}
module.exports = { create }
