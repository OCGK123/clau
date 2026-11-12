const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { importFile, readFile, MAX_BYTES, ID_PATTERN } = require('../src/sound-files')

function wav() {
  const bytes = Buffer.alloc(44 + 160)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(160, 40)
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(Math.round(Math.sin(i / 6) * 3000), i)
  return bytes
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clau-sound-files-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const userData = path.join(dir, 'profile')
  const source = path.join(dir, '내 효과음.WAV')
  const bytes = wav()
  await fs.writeFile(source, bytes)
  return { dir, userData, source, bytes }
}

test('imports a real WAV into content-addressed storage and survives moving the original', async t => {
  const s = await setup(t)
  const meta = await importFile(s.source, s.userData)
  assert.deepEqual(Object.keys(meta).sort(), ['id', 'name'])
  assert.match(meta.id, ID_PATTERN)
  assert.equal(meta.name, '내 효과음.WAV')
  await fs.unlink(s.source)
  assert.deepEqual(await readFile(meta, s.userData), s.bytes)
  assert.deepEqual(await fs.readdir(path.join(s.userData, 'sounds')), [meta.id])
})

test('the same audio reuses one stored file and importing repairs a damaged copy', async t => {
  const s = await setup(t)
  const first = await importFile(s.source, s.userData)
  const renamed = path.join(s.dir, '다른 이름.wav')
  await fs.copyFile(s.source, renamed)
  const second = await importFile(renamed, s.userData)
  assert.equal(second.id, first.id)
  assert.equal(second.name, '다른 이름.wav')
  assert.equal((await fs.readdir(path.join(s.userData, 'sounds'))).length, 1)
  await fs.writeFile(path.join(s.userData, 'sounds', first.id), 'broken')
  await assert.rejects(readFile(first, s.userData), { code: 'SOUND_FILE_CORRUPT' })
  await importFile(s.source, s.userData)
  assert.deepEqual(await readFile(first, s.userData), s.bytes)
})

test('rejects empty, nonregular, unsupported and truncated source files with useful errors', async t => {
  const s = await setup(t)
  const empty = path.join(s.dir, 'empty.wav')
  await fs.writeFile(empty, '')
  await assert.rejects(importFile(empty, s.userData), { code: 'SOUND_FILE_EMPTY' })
  const directory = path.join(s.dir, 'folder.wav')
  await fs.mkdir(directory)
  await assert.rejects(importFile(directory, s.userData), { code: 'SOUND_FILE_TYPE' })
  const unsupported = path.join(s.dir, 'sound.txt')
  await fs.writeFile(unsupported, s.bytes)
  await assert.rejects(importFile(unsupported, s.userData), { code: 'SOUND_FILE_EXTENSION' })
  const truncated = path.join(s.dir, 'truncated.wav')
  await fs.writeFile(truncated, s.bytes.subarray(0, 60))
  await assert.rejects(importFile(truncated, s.userData), { code: 'SOUND_FILE_INVALID' })
  const disguised = path.join(s.dir, 'not-audio.mp3')
  await fs.writeFile(disguised, 'this is not an audio file')
  await assert.rejects(importFile(disguised, s.userData), { code: 'SOUND_FILE_INVALID' })
  await assert.rejects(importFile('relative.wav', s.userData), { code: 'SOUND_FILE_PATH' })
})

test('enforces the 10MiB limit before reading large sparse files', async t => {
  const s = await setup(t)
  const oversized = path.join(s.dir, 'too-big.wav')
  const handle = await fs.open(oversized, 'w')
  await handle.truncate(MAX_BYTES + 1)
  await handle.close()
  await assert.rejects(importFile(oversized, s.userData), { code: 'SOUND_FILE_SIZE' })
})

test('invalid IDs cannot traverse directories and deleted or modified copies are reported', async t => {
  const s = await setup(t)
  for (const id of ['../outside.wav', '/tmp/audio.wav', `${'f'.repeat(64)}.exe`, `${'f'.repeat(64)}.wav/../x`]) {
    await assert.rejects(readFile({ id }, s.userData), { code: 'SOUND_FILE_ID' })
  }
  const meta = await importFile(s.source, s.userData)
  const target = path.join(s.userData, 'sounds', meta.id)
  const corrupted = Buffer.from(s.bytes)
  corrupted[corrupted.length - 1] ^= 1
  await fs.writeFile(target, corrupted)
  await assert.rejects(readFile(meta, s.userData), { code: 'SOUND_FILE_CORRUPT' })
  await fs.unlink(target)
  await assert.rejects(readFile(meta, s.userData), { code: 'SOUND_FILE_MISSING' })
})

test('managed file IDs cannot be replaced by symlinks to another location', { skip: process.platform === 'win32' }, async t => {
  const s = await setup(t)
  const meta = await importFile(s.source, s.userData)
  const target = path.join(s.userData, 'sounds', meta.id)
  await fs.unlink(target)
  await fs.symlink(s.source, target)
  await assert.rejects(readFile(meta, s.userData), { code: 'SOUND_FILE_READ' })
})
