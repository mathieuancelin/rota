'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { HistoryStore } = require('../src/history/store')
const { readLastLines, countLines } = require('../src/history/tail')

const DEFAULTS = { inlineOutputBytes: 8192, retainExecutions: 500, maxOutputBytes: 1048576 }

async function freshHistory(t, defaults = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-history-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = {
    historyDir: path.join(dir, 'history'),
    outputsDir: path.join(dir, 'history', 'outputs'),
  }
  await fs.mkdir(paths.outputsDir, { recursive: true })
  const store = new HistoryStore(paths, { getDefaults: () => ({ ...DEFAULTS, ...defaults }) })
  return { store, paths }
}

let counter = 0
function entry(overrides = {}) {
  counter += 1
  return {
    executionId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    jobId: 'sync',
    jobName: 'Synchro',
    trigger: 'schedule',
    startedAt: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    finishedAt: new Date(1_700_000_000_000 + counter * 1000 + 50).toISOString(),
    durationMs: 50,
    status: 'success',
    exitCode: 0,
    signal: null,
    command: 'sh /tmp/sync.sh',
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    ...overrides,
  }
}

test('the executions are read back from the most recent to the oldest', async (t) => {
  const { store } = await freshHistory(t)
  const first = await store.append(entry({ status: 'failed' }))
  const second = await store.append(entry())

  const page = await store.read('sync')

  assert.equal(page.entries.length, 2)
  assert.equal(page.entries[0].executionId, second.executionId)
  assert.equal(page.entries[1].executionId, first.executionId)
  assert.equal(page.hasMore, false)
})

test('the history of a job that never ran is empty, not an error', async (t) => {
  const { store } = await freshHistory(t)
  assert.deepEqual(await store.read('jamais-lancee'), { entries: [], hasMore: false })
})

test('pagination advances in slices with no duplicate', async (t) => {
  const { store } = await freshHistory(t)
  const written = []
  for (let i = 0; i < 12; i++) written.push(await store.append(entry()))

  const first = await store.read('sync', { limit: 5, offset: 0 })
  const second = await store.read('sync', { limit: 5, offset: 5 })
  const third = await store.read('sync', { limit: 5, offset: 10 })

  assert.equal(first.entries.length, 5)
  assert.equal(first.hasMore, true)
  assert.equal(second.entries.length, 5)
  assert.equal(third.entries.length, 2)
  assert.equal(third.hasMore, false)

  const ids = [...first.entries, ...second.entries, ...third.entries].map((e) => e.executionId)
  assert.equal(new Set(ids).size, 12, 'no entry may appear twice')
  assert.deepEqual(ids, written.map((e) => e.executionId).reverse())
})

test('retention compacts past 20% over', async (t) => {
  const { store, paths } = await freshHistory(t, { retainExecutions: 10 })
  const job = { history: { retainExecutions: 10 } }

  // 12 entries = compaction threshold (10 × 1.2) just exceeded.
  for (let i = 0; i < 13; i++) await store.append(entry(), job)

  const lines = await countLines(path.join(paths.historyDir, 'sync.jsonl'))
  assert.equal(lines, 10, 'the file is brought back to the retained count')

  const page = await store.read('sync', { limit: 50 })
  assert.equal(page.entries.length, 10)
})

test('compaction keeps the most recent entries', async (t) => {
  const retain = 5
  const { store } = await freshHistory(t, { retainExecutions: retain })
  const job = { history: { retainExecutions: retain } }

  const written = []
  for (let i = 0; i < 8; i++) written.push(await store.append(entry(), job))

  const page = await store.read('sync', { limit: 50 })
  const kept = page.entries.map((e) => e.executionId)

  assert.equal(kept[0], written.at(-1).executionId, 'the most recent comes first')
  // Compaction is deferred: the file may exceed the retention by 20% before
  // being rewritten, but never more.
  assert.ok(kept.length >= retain && kept.length <= Math.floor(retain * 1.2) + 1, `${kept.length} entries kept`)
  assert.deepEqual(kept, written.slice(-kept.length).map((e) => e.executionId).reverse())
})

test('a large output goes into a file and leaves an excerpt', async (t) => {
  const { store, paths } = await freshHistory(t, { inlineOutputBytes: 100 })
  const long = 'x'.repeat(5000)

  const stored = await store.append(entry({ stdout: long }))

  assert.equal(stored.stdoutTruncated, true)
  assert.equal(stored.stdout.length, 100, "the excerpt is cut at the limit")
  assert.ok(stored.outputFiles.stdout.startsWith('outputs/'))

  const full = await store.readOutput(stored.outputFiles.stdout)
  assert.equal(full.ok, true)
  assert.equal(full.text, long, 'the whole output is preserved')

  const onDisk = await fs.readFile(path.join(paths.historyDir, 'sync.jsonl'), 'utf8')
  assert.ok(onDisk.length < 1000, 'the JSONL stays light')
})

test('an output under the limit stays inline, with no side file', async (t) => {
  const { store } = await freshHistory(t, { inlineOutputBytes: 100 })

  const stored = await store.append(entry({ stdout: 'court' }))

  assert.equal(stored.stdout, 'court')
  assert.equal(stored.stdoutTruncated, false)
  assert.equal(stored.outputFiles, null)
})

test('compaction deletes the output files left orphaned', async (t) => {
  const { store, paths } = await freshHistory(t, {
    inlineOutputBytes: 10,
    retainExecutions: 2,
  })
  const job = { history: { retainExecutions: 2 } }

  const written = []
  for (let i = 0; i < 4; i++) {
    written.push(await store.append(entry({ stdout: 'y'.repeat(500) }), job))
  }

  const remaining = await fs.readdir(paths.outputsDir)
  assert.equal(remaining.length, 2, 'only the outputs still referenced remain')
  assert.ok(remaining.some((name) => name.startsWith(written.at(-1).executionId)))
  assert.ok(!remaining.some((name) => name.startsWith(written[0].executionId)))
})

test('a corrupt line does not stop the others being read', async (t) => {
  const { store, paths } = await freshHistory(t)
  await store.append(entry())
  await fs.appendFile(path.join(paths.historyDir, 'sync.jsonl'), '{ truncated by an abrupt stop\n')
  await store.append(entry())

  const page = await store.read('sync', { limit: 10 })

  assert.equal(page.entries.length, 2, 'both valid entries stay readable')
})

test('readOutput refuses a path leaving the outputs directory', async (t) => {
  const { store } = await freshHistory(t)
  const result = await store.readOutput('../../../../etc/passwd')
  assert.equal(result.ok, false)
  assert.match(result.error, /outside the allowed directory/)
})

test('prune deletes the history of the jobs that are gone', async (t) => {
  const { store, paths } = await freshHistory(t)
  await store.append(entry({ jobId: 'sync' }))
  await store.append(entry({ jobId: 'backup' }))

  await store.prune(['sync'])

  const files = await fs.readdir(paths.historyDir)
  assert.ok(files.includes('sync.jsonl'))
  assert.ok(!files.includes('backup.jsonl'))
})

test('a hostile job identifier is refused before any disk access', async (t) => {
  const { store } = await freshHistory(t)
  await assert.rejects(() => store.read('../../etc/passwd'), /Invalid job identifier/)
})

test('concurrent writes do not interleave', async (t) => {
  const { store, paths } = await freshHistory(t)

  await Promise.all(Array.from({ length: 30 }, () => store.append(entry())))

  const raw = await fs.readFile(path.join(paths.historyDir, 'sync.jsonl'), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 30)
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `ligne corrompue : ${line.slice(0, 60)}`)
  }
})

test('readLastLines reads back correctly past one read chunk', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-tail-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'gros.jsonl')

  // Each line is about 1 KiB: the file goes well past the 64 KiB of a read
  // chunk, which forces the rejoining of lines straddling two chunks.
  const total = 200
  const lines = Array.from({ length: total }, (_, i) => JSON.stringify({ i, filler: 'z'.repeat(1000) }))
  await fs.writeFile(filePath, `${lines.join('\n')}\n`)

  const { lines: tail } = await readLastLines(filePath, 5)

  assert.equal(tail.length, 5)
  assert.deepEqual(
    tail.map((line) => JSON.parse(line).i),
    [199, 198, 197, 196, 195],
  )
})

test('readLastLines handles multi-byte characters straddling two chunks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-tail-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'accents.jsonl')

  const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ i, text: 'é🎉'.repeat(100) }))
  await fs.writeFile(filePath, `${lines.join('\n')}\n`)

  const { lines: tail } = await readLastLines(filePath, 250)

  assert.equal(tail.length, 250)
  for (const line of tail) {
    assert.ok(!line.includes('�'), 'no character may be broken')
    assert.doesNotThrow(() => JSON.parse(line))
  }
})

test('countLines counts a last line with no trailing newline too', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-tail-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const withNewline = path.join(dir, 'a.txt')
  await fs.writeFile(withNewline, 'un\ndeux\n')
  assert.equal(await countLines(withNewline), 2)

  const without = path.join(dir, 'b.txt')
  await fs.writeFile(without, 'un\ndeux')
  assert.equal(await countLines(without), 2)

  assert.equal(await countLines(path.join(dir, 'absent.txt')), 0)
})
