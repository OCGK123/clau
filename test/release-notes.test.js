const { test } = require('node:test')
const assert = require('node:assert/strict')

test('release notes carry only that version, plus install steps', async () => {
  const { section, notes } = await import('../scripts/release-notes.mjs')
  const log = '# Clau 0.7.0\n\n- 새것\n\n# Clau 0.6.37\n\n- 예전 것\n\n# Clau 0.5.0\n\n- 아주 예전 것\n'
  assert.equal(section(log, '0.7.0'), '- 새것')
  assert.equal(section(log, '0.6.37'), '- 예전 것')
  assert.equal(section(log, '0.5.0'), '- 아주 예전 것')
  assert.equal(section(log, '0.6.3'), '', 'a prefix of another version is not a match')
  const text = notes(log, '0.7.0')
  assert.ok(text.startsWith('- 새것') && text.includes('Clau-Installer-Windows.cmd'))
  assert.ok(!text.includes('예전 것'))
  assert.throws(() => notes(log, '9.9.9'), /9\.9\.9/)
})
