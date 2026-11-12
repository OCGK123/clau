import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
for (const name of fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).sort()) {
  const result = spawnSync(process.execPath, [path.join(root, 'test', name)], { cwd: root, stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
