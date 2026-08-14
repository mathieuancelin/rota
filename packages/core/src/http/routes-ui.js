'use strict'

// The routes that existed only as IPC channels.
//
// Everything here answers a question the window used to ask its own process
// directly. They are grouped in one file rather than folded into router.js
// because that is what they have in common: none of them was designed as an
// HTTP route, and each is the API's answer to "what did the renderer need that
// a stranger could not have".
//
// Two rules hold throughout. Identifiers are revalidated here even though the
// router already matched them, because they end up composing file paths. And
// nothing destructive happens without saying so: deletion over HTTP has no
// modal sheet to hide behind, so the caller has to mean it.

const fs = require('node:fs/promises')
const path = require('node:path')

const agentMemory = require('../agent/memory')

const { buildFromTemplate, listTemplates } = require('../config/templates')
const { generateToken } = require('./auth')

const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

// The same ceiling the settings apply to a job's memory: it is the same context
// it occupies.
const GLOBAL_MEMORY_MAX_ENTRIES = 100

const ok = (body) => ({ status: 200, body })
const json = (status, body) => ({ status, body })
const NOT_FOUND = json(404, { error: 'not found' })

function validId(id) {
  return typeof id === 'string' && JOB_ID.test(id)
}

/**
 * @returns {Promise<{status: number, body: object}|null>} null when no route
 *   here matches, so the caller carries on to the rest of the API.
 */
async function handleUiRoutes(request, segments, deps) {
  const { method, body, query } = request
  const { store, scheduler, runner, state, history, chat, snapshot, ui } = deps
  const [head, ...rest] = segments

  // --- the whole state, as the interface consumes it ---------------------------

  if (head === 'state' && rest.length === 0 && method === 'GET') {
    if (!snapshot) return json(503, { error: 'this engine publishes no snapshot' })
    return ok(snapshot())
  }

  if (head === 'templates' && rest.length === 0 && method === 'GET') {
    return ok({ templates: listTemplates() })
  }

  // --- settings ----------------------------------------------------------------

  if (head === 'config' && rest.length === 0) {
    if (method === 'GET') return ok(store.getConfig())
    if (method === 'PATCH' || method === 'PUT') {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return json(422, { error: 'an object is expected' })
      }
      const result = await store.patchConfig(body)
      return result.ok ? ok({ config: store.getConfig() }) : json(422, { error: result.errors.join(' | ') })
    }
    return NOT_FOUND
  }

  // Generated here rather than by the caller: it is cryptographic randomness,
  // and a token somebody typed is a token somebody chose.
  if (head === 'config' && rest[0] === 'http-token' && rest.length === 1 && method === 'POST') {
    return ok({ token: generateToken() })
  }

  // --- errors, power, and the questions an agent asks ---------------------------

  if (head === 'errors' && rest[0] === 'acknowledge' && method === 'POST') {
    state.acknowledgeErrors()
    return ok({ acknowledged: true })
  }

  if (head === 'errors' && rest.length === 0 && method === 'DELETE') {
    state.clearErrors()
    return ok({ cleared: true })
  }

  if (head === 'ui' && rest[0] === 'answer' && method === 'POST') {
    if (!ui?.answer) return json(503, { error: 'this engine takes no answers' })
    if (typeof body?.requestId !== 'string') return json(422, { error: 'requestId is expected' })
    const result = ui.answer(body.requestId, { action: body.action, value: body.value })
    return result.ok ? ok(result) : json(409, { error: result.error })
  }

  // A window that knows the machine slept, telling an engine that has no way of
  // knowing. The daemon infers it from its own clock; an application attached to
  // one can simply say so.
  if (head === 'system' && rest[0] === 'power' && rest.length === 2 && method === 'POST') {
    const events = {
      suspend: () => (scheduler.handleSuspend(), []),
      wake: () => scheduler.handleWake(),
      lock: () => (scheduler.handleLock(), []),
      unlock: () => scheduler.handleUnlock(),
    }
    const handler = events[rest[1]]
    if (!handler) return json(422, { error: `unknown power event: ${rest[1]}` })
    return ok({ event: rest[1], caughtUp: handler() ?? [] })
  }

  // --- executions ---------------------------------------------------------------

  if (head === 'executions' && rest.length === 2) {
    const [executionId, action] = rest
    if (typeof executionId !== 'string') return json(422, { error: 'invalid identifier' })

    // What has already scrolled past. The rest arrives on the event stream.
    if (action === 'output' && method === 'GET') return ok(runner.liveOutput(executionId))

    if (action === 'cancel' && method === 'POST') {
      return runner.cancel(executionId)
        ? ok({ cancelled: true })
        : json(409, { error: 'that execution is no longer running' })
    }
    return NOT_FOUND
  }

  // --- externalised output -------------------------------------------------------

  if (head === 'outputs' && method === 'GET' && rest.length > 0) {
    // The reference comes from a history entry we wrote; readOutput refuses
    // anything that would leave the history directory.
    const content = await history.readOutput(rest.join('/'))
    return content === null ? NOT_FOUND : ok({ content })
  }

  // --- what every agent remembers -------------------------------------------------

  if (head === 'memory' && rest[0] === 'global') {
    const memoryDir = store.paths.memoryDir

    if (rest.length === 1 && method === 'GET') {
      const loaded = await agentMemory.loadGlobal(memoryDir)
      return ok({ entries: loaded.entries ?? loaded, file: agentMemory.globalMemoryFile(memoryDir) })
    }

    if (rest.length === 1 && (method === 'PUT' || method === 'POST')) {
      if (typeof body?.key !== 'string' || body.key.trim() === '') {
        return json(422, { error: 'a key is expected' })
      }
      const loaded = await agentMemory.loadGlobal(memoryDir)
      agentMemory.write(loaded, body.key.trim(), body.value, {
        maxEntries: GLOBAL_MEMORY_MAX_ENTRIES,
      })
      await agentMemory.saveGlobal(memoryDir, loaded)
      return ok({ key: body.key.trim() })
    }

    if (rest.length === 2 && method === 'DELETE') {
      const loaded = await agentMemory.loadGlobal(memoryDir)
      if (!agentMemory.remove(loaded, decodeURIComponent(rest[1]))) {
        return json(404, { error: `unknown key: ${rest[1]}` })
      }
      await agentMemory.saveGlobal(memoryDir, loaded)
      return ok({ removed: rest[1] })
    }
    return NOT_FOUND
  }

  // --- conversations ---------------------------------------------------------------

  if (head === 'chats' && rest.length >= 1) {
    if (!chat) return json(503, { error: 'this engine holds no conversations' })
    const [chatId, action] = rest
    if (typeof chatId !== 'string') return json(422, { error: 'invalid conversation' })

    if (!action && method === 'DELETE') return answerOf(await chat.remove(null, chatId))
    if (!action && method === 'PATCH') {
      if (body?.title !== null && typeof body?.title !== 'string') {
        return json(422, { error: 'a title is expected, or null to clear it' })
      }
      return answerOf(await chat.rename(null, chatId, body.title))
    }
    if (action === 'messages' && method === 'POST') {
      if (typeof body?.content !== 'string' || body.content.trim() === '') {
        return json(422, { error: 'an empty message is not a message' })
      }
      return answerOf(await chat.post(chatId, body.content))
    }
    if (action === 'stop' && method === 'POST') return answerOf(await chat.stop(chatId))
    if (action === 'close' && method === 'POST') return answerOf(await chat.close(chatId))
    return NOT_FOUND
  }

  // --- job definitions, and the jobs themselves ---------------------------------------

  if (head === 'jobs') {
    // Creation: the identifier comes from a text field somewhere, so its shape
    // is an error to report rather than an exception to raise.
    if (rest.length === 0 && method === 'POST') {
      if (!validId(body?.id)) {
        return json(422, {
          error:
            'invalid identifier: lowercase letters, digits, hyphen and underscore, ' +
            'starting with a letter or a digit',
        })
      }
      if (typeof body.templateId !== 'string') return json(422, { error: 'a template is expected' })
      const result = await store.createJob(body.id, body.templateId)
      return result.ok ? json(201, { id: body.id }) : json(422, { error: result.errors.join(' | ') })
    }

    const [id, action] = rest
    if (rest.length >= 1 && !validId(id)) return json(422, { error: 'invalid job identifier' })

    if (rest.length === 1 && method === 'DELETE') {
      // No modal sheet out here. The caller says the identifier twice, which is
      // the closest thing HTTP has to meaning it — and the history goes too.
      if (query?.get('confirm') !== id) {
        return json(428, {
          error: `deleting ${id} takes its history with it and cannot be undone — repeat the identifier as ?confirm=${id}`,
        })
      }
      if (!store.getJob(id)) return NOT_FOUND
      const result = await store.deleteJob(id)
      if (result.ok) await store.reload()
      return result.ok ? ok({ deleted: id }) : json(422, { error: result.errors.join(' | ') })
    }

    // The definition as it is on disk — unvalidated, because a job the engine
    // refuses is exactly the one somebody is trying to fix.
    if (action === 'definition' && rest.length === 2) {
      const file = path.join(store.paths.jobsDir, `${id}.json`)

      if (method === 'GET') {
        try {
          return ok({ id, content: await fs.readFile(file, 'utf8') })
        } catch (err) {
          return err.code === 'ENOENT' ? NOT_FOUND : json(500, { error: err.message })
        }
      }

      if (method === 'PUT') {
        if (typeof body?.content !== 'string') return json(422, { error: 'content is expected' })
        let parsed
        try {
          parsed = JSON.parse(body.content)
        } catch (err) {
          return json(422, { error: `invalid JSON: ${err.message}` })
        }
        const result = await store.saveJob(id, parsed)
        return result.ok ? ok({ id }) : json(422, { error: result.errors.join(' | ') })
      }
      return NOT_FOUND
    }

    if (action === 'chats' && rest.length === 2) {
      if (!chat) return json(503, { error: 'this engine holds no conversations' })
      if (method === 'GET') return ok({ chats: await chat.list(id) })
      if (method === 'POST') return answerOf(await chat.create(id))
      return NOT_FOUND
    }

    // Opening one, or the job's most recent.
    if (action === 'chats' && rest.length === 3 && method === 'POST') {
      if (!chat) return json(503, { error: 'this engine holds no conversations' })
      return answerOf(rest[2] === 'latest' ? await chat.open(id) : await chat.openConversation(id, rest[2]))
    }

    if (action === 'templates' && method === 'GET') {
      return ok(buildFromTemplate(id))
    }
  }

  return null
}

/** The conversation methods answer {ok, ...} already; HTTP just needs a status. */
function answerOf(result) {
  if (result?.ok === false) {
    return json(422, { error: result.errors?.join(' | ') ?? result.error ?? 'refused' })
  }
  return ok(result ?? { ok: true })
}

module.exports = { handleUiRoutes, GLOBAL_MEMORY_MAX_ENTRIES }
