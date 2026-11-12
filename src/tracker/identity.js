// An app identity survives restarts; process and window IDs deliberately do not.
const KINDS = ['kwin', 'x11', 'windows', 'mac']
function selection(value) {
  if (!value || typeof value !== 'object' || !KINDS.includes(value.kind)) return null
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512 || /[\x00-\x1f]/.test(value.id)) return null
  return { kind: value.kind, id: value.id.trim().toLowerCase(), label: String(value.label || value.id).slice(0, 200) }
}
function targetSpec(value, kind) {
  const chosen = selection(value)
  return chosen ? { exact: true, id: chosen.id, kind: chosen.kind, compatible: chosen.kind === kind } :
    { exact: false, id: String(typeof value === 'string' && value.trim() || 'claude').toLowerCase(), kind, compatible: true }
}
function matches(spec, id, legacy = id) {
  if (!spec.compatible) return false
  return spec.exact ? String(id || '').toLowerCase() === spec.id : String(legacy || '').toLowerCase().includes(spec.id)
}
function appsFromRows(rows, kind, ownPid) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || Number(row.pid) === Number(ownPid) || row.normal === false) continue
    const item = selection({ kind, id: row.id, label: row.label })
    if (!item || /^(clau|clau\.exe)$/.test(item.id)) continue
    const previous = groups.get(item.id)
    if (previous) previous.windows++
    else groups.set(item.id, { ...item, windows: 1 })
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'))
}
function parseXClass(text) {
  const match = String(text).match(/WM_CLASS\(STRING\)\s*=\s*(.*)/)
  const values = match ? [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1].replace(/\\(["\\])/g, '$1')) : []
  return { id: (values[1] || values[0] || '').toLowerCase(), label: values[1] || values[0] || '', legacy: values.join(' ').toLowerCase() }
}
module.exports = { selection, targetSpec, matches, appsFromRows, parseXClass }
