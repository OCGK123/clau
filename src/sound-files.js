// User-selected audio is copied into managed storage so moving the original
// file never breaks a saved selection. Renderer metadata never contains paths.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MAX_BYTES = 10 * 1024 * 1024
const EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'webm']
const ID_PATTERN = /^[a-f0-9]{64}\.(wav|mp3|ogg|m4a|flac|webm)$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message) => Object.assign(new Error(message), { code })

function validateContainer(bytes, ext) {
  let valid = false
  if (ext === 'wav') valid = bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) + 8 <= bytes.length
  else if (ext === 'mp3') {
    valid = bytes.length >= 4 && ((bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || bytes.toString('ascii', 0, 3) === 'ID3')
    if (valid && bytes.toString('ascii', 0, 3) === 'ID3') {
      valid = bytes.length >= 10 && [bytes[6], bytes[7], bytes[8], bytes[9]].every(value => value < 128)
      if (valid) valid = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) <= bytes.length
    }
  } else if (ext === 'ogg') {
    valid = bytes.length >= 27 && bytes.toString('ascii', 0, 4) === 'OggS'
    if (valid) {
      const segments = bytes[26]
      const header = 27 + segments
      valid = header <= bytes.length
      if (valid) valid = header + bytes.subarray(27, header).reduce((sum, value) => sum + value, 0) <= bytes.length
    }
  } else if (ext === 'm4a') valid = bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length
  else if (ext === 'flac') valid = bytes.length >= 42 && bytes.toString('ascii', 0, 4) === 'fLaC' && (bytes[4] & 0x7f) === 0 && bytes.readUIntBE(5, 3) === 34
  else if (ext === 'webm') valid = bytes.length >= 8 && bytes.readUInt32BE(0) === 0x1a45dfa3
  if (!valid) throw fail('SOUND_FILE_INVALID', '오디오 파일이 손상됐거나 확장자와 형식이 달라요. 재생되는 파일을 다시 선택해 주세요.')
}

async function boundedRead(file, managed = false) {
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (managed ? constants.O_NOFOLLOW || 0 : 0))
    const stat = await handle.stat()
    if (!stat.isFile()) throw fail('SOUND_FILE_TYPE', '일반 오디오 파일을 선택해 주세요. 폴더는 사용할 수 없어요.')
    if (stat.size > MAX_BYTES) throw fail('SOUND_FILE_SIZE', '효과음은 10MB 이하의 파일을 선택해 주세요.')
    if (stat.size === 0) throw fail('SOUND_FILE_EMPTY', '비어 있는 파일이에요. 재생되는 오디오 파일을 선택해 주세요.')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw fail('SOUND_FILE_CHANGED', '파일을 읽는 동안 내용이 바뀌었어요. 파일 저장을 마친 뒤 다시 선택해 주세요.')
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead) throw fail('SOUND_FILE_CHANGED', '파일을 읽는 동안 내용이 바뀌었어요. 파일 저장을 마친 뒤 다시 선택해 주세요.')
    return bytes
  } catch (error) {
    if (error.code?.startsWith('SOUND_FILE_')) throw error
    if (error.code === 'ENOENT') throw fail('SOUND_FILE_MISSING', managed ? '저장한 효과음 파일을 찾지 못했어요. 설정에서 파일을 다시 선택해 주세요.' : '선택한 파일을 찾지 못했어요. 파일 위치를 확인하고 다시 선택해 주세요.')
    if (error.code === 'EACCES' || error.code === 'EPERM') throw fail('SOUND_FILE_ACCESS', '파일을 읽을 수 없어요. 읽을 수 있는 위치의 오디오 파일을 다시 선택해 주세요.')
    if (error.code === 'EISDIR') throw fail('SOUND_FILE_TYPE', '일반 오디오 파일을 선택해 주세요. 폴더는 사용할 수 없어요.')
    throw fail('SOUND_FILE_READ', '효과음 파일을 읽지 못했어요. 설정에서 파일을 다시 선택해 주세요.')
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function importFile(sourcePath, userDataDir) {
  if (typeof sourcePath !== 'string' || !sourcePath || !path.isAbsolute(sourcePath)) throw fail('SOUND_FILE_PATH', '이 컴퓨터의 오디오 파일을 선택해 주세요.')
  const ext = path.extname(sourcePath).slice(1).toLowerCase()
  if (!EXTENSIONS.includes(ext)) throw fail('SOUND_FILE_EXTENSION', 'WAV, MP3, OGG, M4A, FLAC, WebM 파일을 선택해 주세요.')
  const bytes = await boundedRead(sourcePath)
  validateContainer(bytes, ext)
  const id = `${digest(bytes)}.${ext}`
  const name = path.basename(sourcePath).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
  const dir = path.join(userDataDir, 'sounds')
  const target = path.join(dir, id)
  let temporary
  try {
    await fs.mkdir(dir, { recursive: true })
    try {
      await readFile({ id, name }, userDataDir)
      return { id, name }
    } catch { /* Repair an absent or corrupted managed copy atomically. */ }
    temporary = path.join(dir, `.${randomUUID()}.tmp`)
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, target)
    temporary = null
    return { id, name }
  } catch {
    throw fail('SOUND_FILE_SAVE', '효과음 파일을 앱에 저장하지 못했어요. 저장 공간과 폴더 권한을 확인하고 다시 선택해 주세요.')
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {})
  }
}

async function readFile(meta, userDataDir) {
  if (!meta || typeof meta.id !== 'string' || !ID_PATTERN.test(meta.id)) throw fail('SOUND_FILE_ID', '저장된 효과음 정보가 올바르지 않아요. 설정에서 파일을 다시 선택해 주세요.')
  const file = path.join(userDataDir, 'sounds', meta.id)
  const bytes = await boundedRead(file, true)
  if (digest(bytes) !== meta.id.slice(0, 64)) throw fail('SOUND_FILE_CORRUPT', '저장된 효과음 파일이 변경되거나 손상됐어요. 설정에서 파일을 다시 선택해 주세요.')
  validateContainer(bytes, path.extname(meta.id).slice(1))
  return bytes
}

module.exports = { importFile, readFile, MAX_BYTES, EXTENSIONS, ID_PATTERN }
