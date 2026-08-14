'use strict'

// Persistent memory of an agent: memory/<id>.mem.json.
//
// The `<id>` is the agent's, not the job's — meaning the profile when the job
// points at one, and the job itself otherwise. That is the whole reason a
// profile is worth extracting: two jobs run by the same agent share what it has
// learnt, instead of each rediscovering it on its own.
//
// Which means two executions can now write the same file at the same time, and
// `save` therefore folds into what is on disk rather than replacing it: it
// rewrites only the keys this session actually touched. Two jobs learning
// different things both keep theirs; only two jobs writing the same key have to
// be told apart, and there the last one wins — which is what a memory is for.
//
// A scheduled execution starts from scratch every time. With no memory, an agent
// running hourly redoes the same discovery work sixty times a day, and can
// observe nothing that spans several executions — "this service went down again,
// that is the third time this week".
//
// The system prompt recalls only the **keys**, not the values. What is not in
// the context does not exist — but a value asserted in the instructions reads as
// an instruction, and weighs on a request that has nothing to do with it. A key,
// on the other hand, says "you know something about this" and leaves the agent
// to go and get it. A hundred entries of four thousand characters re-emitted on
// every turn, which the schema allows, would in any case leave room for nothing
// else.

const fsp = require('node:fs/promises')
const path = require('node:path')

const { readJson, writeJsonAtomic } = require('../lib/json-file')

const VERSION = 1
const MAX_VALUE_LENGTH = 4000

// Global memory: what holds for every job — who the user is, on which machine,
// with which conventions. It is merged at read time with the job's own, and the
// local one wins: a job that has learnt something more precise on its own ground
// knows better than the general setting.
//
// The file name does not end in ".mem.json", for two reasons: the orphan sweep
// only touches those, and "global" is a perfectly valid job identifier — the two
// files would have collided.
const GLOBAL_FILE = 'global.json'

function memoryFile(memoryDir, id) {
  return path.join(memoryDir, `${id}.mem.json`)
}

/**
 * Whose memory a job writes into.
 *
 * The profile it names, or itself. A job that later gets pointed at a profile
 * therefore starts reading that agent's memory rather than its own — which is
 * why extracting a profile moves the file across, instead of leaving months of
 * observations behind without saying so.
 */
function keyFor(job) {
  return job?.runner?.agentProfile ?? job?.id
}

const globalMemoryFile = (memoryDir) => path.join(memoryDir, GLOBAL_FILE)

const empty = () => ({ version: VERSION, updatedAt: null, entries: {} })

/**
 * Loads a job's memory. A file that is absent, unreadable or of an unexpected
 * shape yields an empty memory rather than an error: that is no reason to stop
 * the job running.
 */
async function load(memoryDir, id) {
  return readMemory(memoryFile(memoryDir, id))
}

/**
 * Writes back what this session touched, and nothing else.
 *
 * Deliberately not a whole-file replacement. Two jobs of the same profile write
 * the same file, and the one finishing second would otherwise erase what the
 * first had just learnt — silently, and precisely on the runs where both had
 * something to say. So the file is re-read here and only the keys this session
 * wrote or forgot are applied over it.
 *
 * A session that touched nothing writes nothing: rewriting the file to no
 * purpose could only ever undo somebody else's work.
 *
 * @param {string} memoryDir
 * @param {string} id the agent's — a profile, or a job
 * @param {object} memory the session's copy
 * @param {{maxEntries?: number}} [options]
 */
async function save(memoryDir, id, memory, { maxEntries = Infinity } = {}) {
  const touched = memory.touched
  if (!touched || touched.size === 0) return

  const onDisk = await readMemory(memoryFile(memoryDir, id))
  const entries = { ...onDisk.entries }
  for (const key of touched) {
    if (key in memory.entries) entries[key] = memory.entries[key]
    else delete entries[key]
  }
  evict(entries, maxEntries)

  // Written out field by field: `touched` is bookkeeping for this session and
  // has no business on disk.
  await writeJsonAtomic(memoryFile(memoryDir, id), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    entries,
  })
}

/** Global memory, shared by every job. Same reading rules. */
async function loadGlobal(memoryDir) {
  return readMemory(globalMemoryFile(memoryDir))
}

async function saveGlobal(memoryDir, memory) {
  await writeJsonAtomic(globalMemoryFile(memoryDir), memory)
}

async function readMemory(filePath) {
  const result = await readJson(filePath)
  if (!result.ok || result.value === null || typeof result.value !== 'object') return empty()

  const entries = result.value.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return empty()

  const clean = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (entry && typeof entry.value === 'string') {
      clean[key] = { value: entry.value, updatedAt: entry.updatedAt ?? null }
    }
  }
  return { version: VERSION, updatedAt: result.value.updatedAt ?? null, entries: clean }
}

/**
 * Writes an entry, evicting the oldest beyond `maxEntries`.
 *
 * Eviction goes by update date: a value rewritten on every execution is deemed
 * useful, one set once and then forgotten no longer is.
 */
function write(memory, key, value, { maxEntries, now = new Date().toISOString() }) {
  const truncated = value.length > MAX_VALUE_LENGTH
  memory.entries[key] = {
    value: truncated ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value,
    updatedAt: now,
  }
  memory.updatedAt = now
  touch(memory, key)

  evict(memory.entries, maxEntries)

  return truncated
}

function remove(memory, key) {
  if (!(key in memory.entries)) return false
  delete memory.entries[key]
  memory.updatedAt = new Date().toISOString()
  // Recorded like a write: what the save has to carry over is that this key is
  // gone, which is not something the file can be asked to work out.
  touch(memory, key)
  return true
}

/** The keys this session wrote or forgot — see the header, and `save`. */
function touch(memory, key) {
  if (!memory.touched) memory.touched = new Set()
  memory.touched.add(key)
}

/**
 * Drops the oldest beyond `maxEntries`.
 *
 * Eviction goes by update date: a value rewritten on every execution is deemed
 * useful, one set once and then forgotten no longer is.
 */
function evict(entries, maxEntries) {
  const keys = Object.keys(entries)
  if (!Number.isFinite(maxEntries) || keys.length <= maxEntries) return entries
  keys
    .sort((a, b) => String(entries[a].updatedAt).localeCompare(String(entries[b].updatedAt)))
    .slice(0, keys.length - maxEntries)
    .forEach((stale) => delete entries[stale])
  return entries
}

/**
 * Removes the files of agents that disappeared, as the history does.
 *
 * Both lists are needed, and forgetting the second would be expensive: a
 * memory file is named after a profile as readily as after a job, and sweeping
 * on job identifiers alone would delete every profile's memory on the next
 * start.
 *
 * Only touches the `.mem.json`s: the directory is not Rota's alone.
 */
async function prune(memoryDir, jobIds, profileIds = []) {
  const keep = new Set([...jobIds, ...profileIds].map((id) => `${id}.mem.json`))
  let entries
  try {
    entries = await fsp.readdir(memoryDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (keep.has(entry) || !entry.endsWith('.mem.json')) continue
    await fsp.rm(path.join(memoryDir, entry), { force: true })
  }
}

/**
 * Merged view of the two memories, sorted by key.
 *
 * The local one wins over the global at equal keys: a job that has learnt
 * something more precise on its own ground knows better than the general
 * setting. The masked key does not appear twice — two answers to the same
 * question would help nobody, and the question is "what do I know about this".
 *
 * @returns {Array<{key: string, value: string, updatedAt: string|null, scope: 'job'|'global'}>}
 */
function mergedEntries(memory, global = empty()) {
  const merged = new Map()
  for (const [key, entry] of Object.entries(global.entries)) {
    merged.set(key, { key, ...entry, scope: 'global' })
  }
  for (const [key, entry] of Object.entries(memory.entries)) {
    merged.set(key, { key, ...entry, scope: 'job' })
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'))
}

const line = (entry) =>
  entry.scope === 'global' ? `- ${entry.key} (global) : ${entry.value}` : `- ${entry.key} : ${entry.value}`

/** Full rendering, keys and values — for whoever asks for them. */
function render(memory, global = empty()) {
  const entries = mergedEntries(memory, global)
  if (entries.length === 0) return null
  return entries.map(line).join('\n')
}

/** A single entry, in the same shape. */
function renderEntry(memory, key, global = empty()) {
  const found = mergedEntries(memory, global).find((entry) => entry.key === key)
  return found ? line(found) : null
}

/** Every known key, local and global alike. */
const knownKeys = (memory, global = empty()) =>
  mergedEntries(memory, global).map((entry) => entry.key)

/**
 * Inventory of the keys, meant for the system prompt and for `memory_list`.
 *
 * The date tells the agent whether what it knows is fresh without it having to
 * read it, which is often enough to decide whether it is worth being.
 */
function renderKeys(memory, global = empty()) {
  const entries = mergedEntries(memory, global)
  if (entries.length === 0) return null
  return entries
    .map(({ key, updatedAt, scope }) => {
      // The marking is for the agent: a global key reads like the others, but is
      // written elsewhere — and it cannot write it.
      const origin = scope === 'global' ? ' (global' : ' ('
      if (!updatedAt) return scope === 'global' ? `- ${key} (global)` : `- ${key}`
      return `- ${key}${origin}${scope === 'global' ? ', ' : ''}updated ${updatedAt})`
    })
    .join('\n')
}

module.exports = {
  memoryFile,
  globalMemoryFile,
  keyFor,
  evict,
  load,
  save,
  loadGlobal,
  saveGlobal,
  write,
  remove,
  prune,
  render,
  renderEntry,
  renderKeys,
  mergedEntries,
  knownKeys,
  empty,
  GLOBAL_FILE,
  MAX_VALUE_LENGTH,
}
