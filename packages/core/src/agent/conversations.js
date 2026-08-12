'use strict'

// Conversation storage: one file per conversation, under
// conversations/<job>/<conversation>.json.
//
// What is kept is the event trail, exactly the one the interface replays to
// rebuild itself. There is therefore only one rendering path to keep honest,
// whether one comes back to the tab a minute later or three weeks after a
// restart.
//
// What is **not** kept: the model's context. It is rebuilt from the trail —
// your messages and its answers — without the tool traffic, which the events
// deliberately abbreviate. A resumed conversation therefore remembers what was
// said, not every call it made to say it. Replaying tool calls faithfully would
// mean keeping their identifiers and their full arguments, that is, keeping a
// second record in step with the first.

const fsp = require('node:fs/promises')
const path = require('node:path')

const { readJson, writeJsonAtomic } = require('../lib/json-file')
const logger = require('../lib/logger')

const VERSION = 1

// A long conversation would end up taking an unreasonable amount of room; what
// gets lost is the beginning, as in a console.
const MAX_EVENTS = 500

// Enough to recognise a conversation in a list, not enough for a pasted
// three-paragraph message to take up the whole width.
const TITLE_LENGTH = 72

const dirFor = (conversationsDir, jobId) => path.join(conversationsDir, jobId)
const fileFor = (conversationsDir, jobId, chatId) =>
  path.join(dirFor(conversationsDir, jobId), `${chatId}.json`)

/**
 * Title of a conversation: its first message, reduced to one line.
 *
 * Derived rather than typed — one does not name a conversation before having
 * had it, and naming it afterwards would be one more gesture for a benefit the
 * first sentence already gives.
 */
function titleOf(events, given = null) {
  // A title set by hand wins, and never moves again: that is the whole point of
  // setting one. The derived one keeps serving until somebody does.
  const chosen = typeof given === 'string' ? given.replace(/\s+/g, ' ').trim() : ''
  if (chosen !== '') return chosen.length > TITLE_LENGTH ? `${chosen.slice(0, TITLE_LENGTH)}…` : chosen

  const first = events.find((event) => event.type === 'turn-start')
  if (!first?.content) return 'New conversation'
  const flat = String(first.content).replace(/\s+/g, ' ').trim()
  if (flat === '') return 'New conversation'
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat
}

/** What the sidebar displays, without the trail. */
const summarize = (conversation) => ({
  chatId: conversation.chatId,
  jobId: conversation.jobId,
  origin: conversation.origin,
  title: titleOf(conversation.events, conversation.title),
  // The view needs to know whether the title was chosen: it offers to put it
  // back to its derived value, which only makes sense if it was not.
  named: Boolean(conversation.title),
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  turns: conversation.events.filter((event) => event.type === 'turn-start').length,
})

/**
 * Conversations of a job, the most recent first.
 *
 * An unreadable file is ignored rather than failing the list: losing one
 * conversation is annoying enough without losing the others too.
 */
async function list(conversationsDir, jobId) {
  let names
  try {
    names = await fsp.readdir(dirFor(conversationsDir, jobId))
  } catch {
    return []
  }

  const conversations = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const loaded = await load(conversationsDir, jobId, path.basename(name, '.json'))
    if (loaded) conversations.push(summarize(loaded))
  }

  return conversations.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** @returns {object|null} null if the file is missing or does not read */
async function load(conversationsDir, jobId, chatId) {
  const result = await readJson(fileFor(conversationsDir, jobId, chatId))
  if (!result.ok || result.value === null || typeof result.value !== 'object') return null

  const events = Array.isArray(result.value.events) ? result.value.events : []
  return {
    version: VERSION,
    chatId,
    jobId,
    origin: typeof result.value.origin === 'string' ? result.value.origin : 'ui',
    title: typeof result.value.named === 'string' ? result.value.named : null,
    createdAt: result.value.createdAt ?? null,
    updatedAt: result.value.updatedAt ?? null,
    events: events.slice(-MAX_EVENTS),
  }
}

async function save(conversationsDir, conversation) {
  const file = fileFor(conversationsDir, conversation.jobId, conversation.chatId)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await writeJsonAtomic(file, {
    version: VERSION,
    chatId: conversation.chatId,
    jobId: conversation.jobId,
    origin: conversation.origin,
    // Written into the file even when derived: opening the folder by hand must
    // say what each file is about, without having to read it whole.
    title: titleOf(conversation.events, conversation.title),
    // Distinct from the line above: this one is what the user chose, and null
    // when they chose nothing. Without it, a derived title written once would
    // freeze on reload and stop following the first message.
    named: conversation.title ?? null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    events: conversation.events,
  })
}

async function remove(conversationsDir, jobId, chatId) {
  await fsp.rm(fileFor(conversationsDir, jobId, chatId), { force: true })
}

/** Removes the conversations of jobs that disappeared, as the history does. */
async function prune(conversationsDir, jobIds) {
  const keep = new Set(jobIds)
  let entries
  try {
    entries = await fsp.readdir(conversationsDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue
    await fsp
      .rm(path.join(conversationsDir, entry.name), { recursive: true, force: true })
      .catch((err) => logger.warn(`cleaning up conversations: ${err.message}`))
  }
}

/**
 * Context to give back to the model when a conversation resumes.
 *
 * What was said, in order: the user's messages, and the agent's answer at each
 * turn. Tool calls are not in it — see the header of this file. A turn that
 * produced no text leaves nothing: an empty bubble teaches the model nothing
 * and would cost it a round trip of context.
 */
function toMessages(events) {
  const messages = []
  let pending = null

  const flush = () => {
    if (pending?.trim()) messages.push({ role: 'assistant', content: pending.trim() })
    pending = null
  }

  for (const event of events) {
    if (event.type === 'turn-start') {
      flush()
      if (event.content) messages.push({ role: 'user', content: event.content })
    } else if (event.type === 'turn') {
      flush()
      pending = ''
    } else if (event.type === 'delta' && pending !== null) {
      pending += event.content ?? ''
    }
  }
  flush()

  return messages
}

module.exports = {
  list,
  load,
  save,
  remove,
  prune,
  toMessages,
  titleOf,
  summarize,
  MAX_EVENTS,
  VERSION,
}
