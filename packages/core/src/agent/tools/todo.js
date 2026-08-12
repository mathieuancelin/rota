'use strict'

// An in-memory task list, for the duration of one execution.
//
// It is not for the user, who only sees it in the transcript: it is for the
// model. An agent that breaks its work down before starting sticks to it better
// than one that improvises, and a forgotten step shows up in the list rather
// than in the result.
//
// Deliberately not persisted: what must outlive the execution belongs to memory,
// not to a scratchpad.

function createTodoList() {
  const items = []
  let nextId = 1

  return {
    items,
    add(texts) {
      const added = texts.map((text) => ({ id: nextId++, text }))
      items.push(...added)
      return added
    },
    remove(ids) {
      const wanted = new Set(ids)
      const removed = items.filter((item) => wanted.has(item.id))
      for (const item of removed) items.splice(items.indexOf(item), 1)
      return removed
    },
    clear() {
      const count = items.length
      items.length = 0
      return count
    },
  }
}

const render = (items) =>
  items.length === 0 ? '(empty list)' : items.map((item) => `${item.id}. ${item.text}`).join('\n')

const todoRead = {
  name: 'todo_read',
  description: "Returns the list of things left to do.",
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    return { ok: true, summary: `${ctx.todo.items.length} entry(ies)`, content: render(ctx.todo.items) }
  },
}

const todoAdd = {
  name: 'todo_add',
  description: "Adds one or more entries to the to-do list.",
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Entries to add, one per element.',
      },
    },
    required: ['items'],
  },
  async run({ items }, ctx) {
    const texts = (Array.isArray(items) ? items : [items])
      .filter((text) => typeof text === 'string' && text.trim() !== '')
      .map((text) => text.trim())
    if (texts.length === 0) return { ok: false, error: 'no entry to add' }

    const added = ctx.todo.add(texts)
    return {
      ok: true,
      summary: added.map((item) => item.text).join(' · '),
      content: `${added.length} entry(ies) added.\n${render(ctx.todo.items)}`,
    }
  },
}

const todoDel = {
  name: 'todo_del',
  description: "Removes entries from the list, by number. This is how something is marked done.",
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'integer' },
        description: "Numbers of the entries to remove.",
      },
    },
    required: ['ids'],
  },
  async run({ ids }, ctx) {
    const wanted = (Array.isArray(ids) ? ids : [ids]).filter((id) => Number.isInteger(id))
    if (wanted.length === 0) return { ok: false, error: 'no valid number' }

    const removed = ctx.todo.remove(wanted)
    if (removed.length === 0) {
      return { ok: false, error: `no entry numbered ${wanted.join(', ')}` }
    }
    return {
      ok: true,
      summary: removed.map((item) => item.text).join(' · '),
      content: `${removed.length} entry(ies) removed.\n${render(ctx.todo.items)}`,
    }
  },
}

const todoClear = {
  name: 'todo_clear',
  description: "Empties the to-do list entirely.",
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const count = ctx.todo.clear()
    return { ok: true, summary: `${count} entry(ies)`, content: `List emptied (${count} entry(ies)).` }
  },
}

module.exports = { createTodoList, render, todoRead, todoAdd, todoDel, todoClear }
