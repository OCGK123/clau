// 업데이트로 받은 zip을 푼다. 운영체제마다 다른 압축 도구에 기대지 않으려고 직접 읽는다.
// 배포본에 필요한 만큼만 안다: 저장/deflate, 실행 권한, 심볼릭 링크(맥 앱 안에 있다).
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { pipeline } = require('node:stream/promises')

const fsp = fs.promises
const END = 0x06054b50
const ENTRY = 0x02014b50
const LOCAL = 0x04034b50
const MAX_ENTRIES = 50_000
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

const bad = message => Object.assign(new Error(message), { code: 'BAD_ZIP' })

async function read(handle, length, position) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw bad('압축 파일이 중간에 끊겼어요.')
  return buffer
}

/** 목록(중앙 디렉터리)을 읽는다. 크기와 권한은 여기 적힌 값이 정확하다. */
async function entries(handle) {
  const { size } = await handle.stat()
  const tail = await read(handle, Math.min(size, 65_557), Math.max(0, size - 65_557))
  let at = tail.length - 22
  while (at >= 0 && tail.readUInt32LE(at) !== END) at--
  if (at < 0) throw bad('압축 파일이 아니에요.')
  const count = tail.readUInt16LE(at + 10)
  const length = tail.readUInt32LE(at + 12)
  const offset = tail.readUInt32LE(at + 16)
  if (count === 0xffff || offset === 0xffffffff || count > MAX_ENTRIES) throw bad('너무 큰 압축 파일이에요.')
  const table = await read(handle, length, offset)
  const list = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > table.length || table.readUInt32LE(p) !== ENTRY) throw bad('압축 파일 목록이 깨졌어요.')
    const nameLength = table.readUInt16LE(p + 28)
    const skip = table.readUInt16LE(p + 30) + table.readUInt16LE(p + 32)
    const unix = table[p + 5] === 3
    list.push({
      name: table.toString('utf8', p + 46, p + 46 + nameLength),
      encrypted: (table.readUInt16LE(p + 8) & 1) === 1,
      method: table.readUInt16LE(p + 10),
      packed: table.readUInt32LE(p + 20),
      size: table.readUInt32LE(p + 24),
      mode: unix ? table.readUInt32LE(p + 38) >>> 16 : 0,
      offset: table.readUInt32LE(p + 42),
    })
    p += 46 + nameLength + skip
  }
  return list
}

/** 푸는 폴더 밖으로 나가는 이름은 받지 않는다. */
function inside(root, name) {
  if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw bad(`이상한 파일 이름이에요: ${name}`)
  const parts = name.split('/').filter(Boolean)
  if (parts.includes('..')) throw bad(`이상한 파일 이름이에요: ${name}`)
  return path.join(root, ...parts)
}

async function data(handle, entry) {
  const local = await read(handle, 30, entry.offset)
  if (local.readUInt32LE(0) !== LOCAL) throw bad('압축 파일이 깨졌어요.')
  return entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
}

async function extract(file, dest, { onProgress, platform = process.platform } = {}) {
  const handle = await fsp.open(file, 'r')
  try {
    const list = await entries(handle)
    const root = path.resolve(dest)
    await fsp.mkdir(root, { recursive: true })
    const total = list.reduce((sum, entry) => sum + entry.size, 0) || 1
    let written = 0
    for (const entry of list) {
      if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) throw bad('풀 수 없는 압축 방식이에요.')
      const target = inside(root, entry.name)
      if (entry.name.endsWith('/')) {
        await fsp.mkdir(target, { recursive: true })
        continue
      }
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const start = await data(handle, entry)
      const source = () => fs.createReadStream(file, { start, end: start + entry.packed - 1 })
      const unpack = () => (entry.method === 8 ? [zlib.createInflateRaw()] : [])
      if ((entry.mode & S_IFMT) === S_IFLNK) {
        // 링크가 가리키는 곳도 푸는 폴더 안이어야 한다.
        const chunks = []
        if (entry.packed) await pipeline(source(), ...unpack(), async function (stream) { for await (const chunk of stream) chunks.push(chunk) })
        const link = Buffer.concat(chunks).toString('utf8')
        const to = path.resolve(path.dirname(target), link)
        if (!link || path.isAbsolute(link) || (to !== root && !to.startsWith(root + path.sep))) throw bad(`이상한 링크예요: ${entry.name}`)
        if (platform !== 'win32') {
          await fsp.rm(target, { force: true })
          await fsp.symlink(link, target)
        }
        continue
      }
      const out = fs.createWriteStream(target, { mode: (entry.mode & 0o777) || 0o644 })
      if (entry.packed) await pipeline(source(), ...unpack(), out)
      else await new Promise((resolve, reject) => out.on('error', reject).end(resolve))
      if (out.bytesWritten !== entry.size) throw bad(`크기가 맞지 않아요: ${entry.name}`)
      written += entry.size
      onProgress?.(written / total)
    }
    return list.length
  } finally {
    await handle.close()
  }
}

module.exports = { extract, entries }
