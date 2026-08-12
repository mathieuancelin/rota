'use strict'

// Persistent memory of an agent job: memory/<id>.mem.json.
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

function memoryFile(memoryDir, jobId) {
  return path.join(memoryDir, `${jobId}.mem.json`)
}

const globalMemoryFile = (memoryDir) => path.join(memoryDir, GLOBAL_FILE)

const empty = () => ({ version: VERSION, updatedAt: null, entries: {} })

/**
 * Loads a job's memory. A file that is absent, unreadable or of an unexpected
 * shape yields an empty memory rather than an error: that is no reason to stop
 * the job running.
 */
async function load(memoryDir, jobId) {
  return readMemory(memoryFile(memoryDir, jobId))
}

async function save(memoryDir, jobId, memory) {
  await writeJsonAtomic(memoryFile(memoryDir, jobId), memory)
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

  const keys = Object.keys(memory.entries)
  if (keys.length > maxEntries) {
    keys
      .sort((a, b) => String(memory.entries[a].updatedAt).localeCompare(String(memory.entries[b].updatedAt)))
      .slice(0, keys.length - maxEntries)
      .forEach((stale) => delete memory.entries[stale])
  }

  return truncated
}

function remove(memory, key) {
  if (!(key in memory.entries)) return false
  delete memory.entries[key]
  memory.updatedAt = new Date().toISOString()
  return true
}

/**
 * Removes the files of jobs that disappeared, as the history does.
 * Only touches the `.mem.json`s: the directory is not Rota's alone.
 */
async function prune(memoryDir, jobIds) {
  const keep = new Set(jobIds.map((id) => `${id}.mem.json`))
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
