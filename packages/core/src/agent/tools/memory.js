'use strict'

// Tools of the persistent memory. Storage is in ../memory.js.
//
// Every write is recorded at once rather than at the end: an execution stopped
// by the timeout, or cancelled halfway, must keep what it had already learnt —
// that is even the moment it matters most.

const memory = require('../memory')

// The instructions announce only the keys: reading a value is therefore a
// deliberate act, and it costs a round trip. Hence a tool for the inventory,
// separate from the one that reads — otherwise rereading everything would stay
// the shortest path.
const memoryList = {
  name: 'memory_list',
  description:
    'Lists what you remember: the keys and when each was last written, without their values. ' +
    'The same list is already in your instructions; this tool is for after you have changed something.',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const rendered = memory.renderKeys(ctx.memory, ctx.globalMemory)
    return {
      ok: true,
      summary: `${memory.knownKeys(ctx.memory, ctx.globalMemory).length} key(s)`,
      content: rendered ?? '(memory empty)',
    }
  },
}

const memoryRead = {
  name: 'memory_read',
  description:
    'Reads what you memorised under a key. Without a key, reads everything — which can be long, ' +
    'so name the key when you know it.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key to read. Omitted, every entry is returned.' },
    },
  },
  async run({ key } = {}, ctx) {
    if (key === undefined || key === null || (typeof key === 'string' && key.trim() === '')) {
      const rendered = memory.render(ctx.memory, ctx.globalMemory)
      return {
        ok: true,
        summary: `${memory.knownKeys(ctx.memory, ctx.globalMemory).length} entry(ies)`,
        content: rendered ?? '(memory empty)',
      }
    }
    if (typeof key !== 'string') return { ok: false, error: 'key must be a string' }

    const rendered = memory.renderEntry(ctx.memory, key.trim(), ctx.globalMemory)
    // Returning the known keys rather than a plain "absent": the agent mostly
    // gets the name wrong, and then has what it needs to correct itself without
    // one more turn.
    if (rendered === null) {
      const known = memory.knownKeys(ctx.memory, ctx.globalMemory).join(', ')
      return {
        ok: false,
        error: `no entry under "${key.trim()}". Known keys: ${known || 'none'}`,
      }
    }
    return { ok: true, summary: key.trim(), content: rendered }
  },
}

const memoryWrite = {
  name: 'memory_write',
  description:
    "Memorises a value under a key, for subsequent executions. " +
    "An existing key is replaced. Reserve it for what is worth keeping from one run to the next. " +
    'Writes to this job’s own memory; a key marked (global) is set by the user and stays as it is, ' +
    'but writing the same key here takes precedence for this job.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "Key, short and stable from one execution to the next." },
      value: { type: 'string', description: 'Value to remember.' },
    },
    required: ['key', 'value'],
  },
  async run({ key, value }, ctx) {
    if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'key is required' }
    if (typeof value !== 'string') return { ok: false, error: 'value must be a string' }

    const truncated = memory.write(ctx.memory, key.trim(), value, {
      maxEntries: ctx.memoryConfig.maxEntries,
    })
    await ctx.saveMemory()

    return {
      ok: true,
      summary: key.trim(),
      content: truncated
        ? `"${key.trim()}" memorised, truncated at ${memory.MAX_VALUE_LENGTH} characters.`
        : `"${key.trim()}" memorised.`,
    }
  },
}

const memoryDel = {
  name: 'memory_del',
  description:
    'Forgets a key from this job’s persistent memory. A key marked (global) belongs to the user ' +
    'and cannot be forgotten from here.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Key to forget.' } },
    required: ['key'],
  },
  async run({ key }, ctx) {
    if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'key is required' }

    if (!memory.remove(ctx.memory, key.trim())) {
      // A global key reads but does not erase from here. Saying so stops the
      // agent believing it absent and rewriting it under another name.
      if (ctx.globalMemory?.entries?.[key.trim()]) {
        return {
          ok: false,
          error: `"${key.trim()}" is global: it is set by the user, and this job cannot forget it`,
        }
      }
      return { ok: false, error: `no entry under "${key.trim()}"` }
    }
    await ctx.saveMemory()
    return { ok: true, summary: key.trim(), content: `"${key.trim()}" forgotten.` }
  },
}

module.exports = { memoryList, memoryRead, memoryWrite, memoryDel }
