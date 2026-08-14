'use strict'

// An engine the application does not own.
//
// This presents the surface `createEngine()` presents — the same objects under
// the same names, the same events — but every call goes out over HTTP and every
// event arrives on the stream. The renderer is not told which it got, and there
// is nothing for it to notice: the Rust experiment proved a renderer cannot tell
// the difference, and this is that proof written down in the language the
// application is in.
//
// What is deliberately *not* here is a fallback. If the daemon is gone, calls
// fail and say where they were looking. An engine that quietly ran the job
// locally instead would be two schedulers on one configuration directory, which
// is the exact thing the instance lock exists to prevent.

const { EventEmitter } = require('node:events')

const { loadEnv, logger, resolveReferences } = require('@rota/core')

// Long enough to survive a daemon restarting, short enough that "it came back"
// is something you notice rather than something you wait for.
const RECONNECT_MS = 2000

/**
 * @param {object} options
 * @param {object} options.paths the local configuration directory — still ours,
 *   because that is where the settings naming the daemon live.
 * @param {{url: string, token: string|null}} options.remote
 * @returns {EventEmitter & object}
 */
function createRemoteEngine({ paths, remote }) {
  const engine = new EventEmitter()

  const base = String(remote.url).replace(/\/$/, '')
  const token = resolveRemoteToken(remote.token, paths)
  const headers = token ? { authorization: `Bearer ${token}` } : {}

  // The last state the daemon sent. A remote engine has no state of its own to
  // build a snapshot from: the snapshot *is* what arrived on the stream.
  let latest = null
  let attached = false
  let stopping = false
  let controller = null
  let reconnectTimer = null

  async function call(method, path, body = null) {
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new RemoteError(`no answer from ${base}`, { cause: err })
    }

    const payload = await response.json().catch(() => null)
    if (response.status === 401) throw new RemoteError(`${base} refused the token`)
    if (!response.ok) throw new RemoteError(payload?.error ?? `${base} answered ${response.status}`)
    return payload
  }

  /** The shape the IPC layer expects back: {ok} or {ok:false, errors}. */
  const attempt = async (work) => {
    try {
      return { ok: true, ...((await work()) ?? {}) }
    } catch (err) {
      return { ok: false, errors: [err.message] }
    }
  }

  async function follow() {
    if (stopping) return
    controller = new AbortController()

    try {
      const response = await fetch(`${base}/api/v1/events`, { headers, signal: controller.signal })
      if (!response.ok) throw new RemoteError(`${base} answered ${response.status} on its event stream`)

      if (!attached) {
        attached = true
        logger.info(`attached to the engine at ${base}`)
        engine.emit('connection', { attached: true, url: base, error: null })
      }

      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          dispatch(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
      throw new RemoteError(`${base} closed the event stream`)
    } catch (err) {
      if (stopping || err.name === 'AbortError') return
      if (attached) {
        attached = false
        logger.warn(`lost the engine at ${base}: ${err.message}`)
      }
      engine.emit('connection', { attached: false, url: base, error: err.message })
      reconnectTimer = setTimeout(follow, RECONNECT_MS)
      reconnectTimer.unref?.()
    }
  }

  /** One SSE frame, turned back into the event the shell already knows. */
  function dispatch(frame) {
    let event = 'message'
    const data = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length === 0) return

    let payload
    try {
      payload = JSON.parse(data.join('\n'))
    } catch {
      return
    }

    if (event === 'state') {
      latest = payload
      engine.emit('changed')
      return
    }
    // started, finished, output, chat, ui-request, ui-report — the names the
    // local engine emits, which is the point.
    engine.emit(event, payload)
    if (event === 'started' || event === 'finished') engine.emit('changed')
  }

  Object.assign(engine, {
    paths,
    mode: 'remote',
    url: base,
    isAttached: () => attached,

    // The parts of a local engine the IPC layer reaches into, each backed by a
    // route rather than by an object in this process.
    store: {
      paths,
      getConfig: () => latest?.config ?? {},
      getJob: (id) => latest?.jobs?.find((job) => job.id === id) ?? null,
      getJobs: () => latest?.jobs ?? [],
      getIssues: () => latest?.issues ?? [],
      patchConfig: (patch) => attempt(() => call('PATCH', '/api/v1/config', patch)),
      createJob: (id, templateId) => attempt(() => call('POST', '/api/v1/jobs', { id, templateId })),
      saveJob: (id, raw) =>
        attempt(() =>
          call('PUT', `/api/v1/jobs/${encodeURIComponent(id)}/definition`, {
            content: JSON.stringify(raw, null, 2),
          }),
        ),
      deleteJob: (id) =>
        attempt(() =>
          call('DELETE', `/api/v1/jobs/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`),
        ),
      setJobEnabled: (id, enabled) =>
        attempt(() =>
          call('POST', `/api/v1/jobs/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`),
        ),
      // The daemon watches its own directory; there is nothing here to reload.
      reload: async () => {},
      readDefinition: (id) => call('GET', `/api/v1/jobs/${encodeURIComponent(id)}/definition`),
    },

    state: {
      acknowledgeErrors: () => call('POST', '/api/v1/errors/acknowledge').catch(() => {}),
      clearErrors: () => call('DELETE', '/api/v1/errors').catch(() => {}),
    },

    scheduler: {
      runNow: (id) => attempt(() => call('POST', `/api/v1/jobs/${encodeURIComponent(id)}/run`)),
      isPaused: () => Boolean(latest?.scheduler?.paused),
      isSessionLocked: () => Boolean(latest?.scheduler?.sessionLocked),
      // A window knows things the daemon cannot: this machine slept, this screen
      // locked. Told, rather than inferred, when there is somebody to tell.
      handleSuspend: () => call('POST', '/api/v1/system/power/suspend').catch(() => {}),
      handleWake: () => (call('POST', '/api/v1/system/power/wake').catch(() => {}), []),
      handleLock: () => call('POST', '/api/v1/system/power/lock').catch(() => {}),
      handleUnlock: () => (call('POST', '/api/v1/system/power/unlock').catch(() => {}), []),
    },

    runner: {
      cancel: (executionId) =>
        call('POST', `/api/v1/executions/${encodeURIComponent(executionId)}/cancel`).then(
          () => true,
          () => false,
        ),
      liveOutput: (executionId) =>
        call('GET', `/api/v1/executions/${encodeURIComponent(executionId)}/output`).catch(() => ({
          ok: false,
          error: 'that execution is no longer running',
        })),
    },

    history: {
      read: (id, options = {}) => {
        const query = new URLSearchParams({
          limit: String(options.limit ?? 50),
          offset: String(options.offset ?? 0),
        })
        return call('GET', `/api/v1/jobs/${encodeURIComponent(id)}/history?${query}`)
      },
      readOutput: (relative) =>
        call('GET', `/api/v1/outputs/${relative.split('/').map(encodeURIComponent).join('/')}`)
          .then((answer) => answer.content)
          .catch(() => null),
    },

    chat: {
      list: (jobId) => call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}/chats`).then((a) => a.chats),
      create: (jobId) => attempt(() => call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/chats`)),
      open: (jobId) => attempt(() => call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/chats/latest`)),
      openConversation: (jobId, chatId) =>
        attempt(() =>
          call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/chats/${encodeURIComponent(chatId)}`),
        ),
      rename: (jobId, chatId, title) =>
        attempt(() => call('PATCH', `/api/v1/chats/${encodeURIComponent(chatId)}`, { title })),
      remove: (jobId, chatId) => attempt(() => call('DELETE', `/api/v1/chats/${encodeURIComponent(chatId)}`)),
      post: (chatId, content) =>
        attempt(() => call('POST', `/api/v1/chats/${encodeURIComponent(chatId)}/messages`, { content })),
      stop: (chatId) => attempt(() => call('POST', `/api/v1/chats/${encodeURIComponent(chatId)}/stop`)),
      close: (chatId) => attempt(() => call('POST', `/api/v1/chats/${encodeURIComponent(chatId)}/close`)),
      closeAll: () => {},
      prune: async () => {},
    },

    /** An answer to a question the daemon's agent asked over the stream. */
    answerUiRequest: (requestId, answer) =>
      attempt(() => call('POST', '/api/v1/ui/answer', { requestId, ...answer })),

    /** The daemon's own view of the world, with what only this shell can add. */
    snapshot({ autostart = null, notifier = null } = {}) {
      if (!latest) {
        // Attached but not yet told anything, or not attached at all. An empty
        // shape beats undefined: the interface renders "nothing yet" rather
        // than failing to render.
        return {
          scheduler: { paused: false, sessionLocked: false, running: 0 },
          jobs: [],
          runningExecutions: [],
          nextRuns: [],
          recentErrors: [],
          hasUnacknowledgedError: false,
          issues: [],
          jobTemplates: [],
          autostart: autostart ?? { supported: false, active: false, reason: null },
          notifications: notifier?.getStatus() ?? { supported: false, lastFailure: null },
          discord: { state: 'unknown', error: null, user: null },
          http: { state: 'unknown', error: null, url: base },
          config: {},
          paths: { root: paths.root, jobsDir: paths.jobsDir, configFile: paths.configFile },
          connection: { mode: 'remote', url: base, attached },
        }
      }
      return {
        ...latest,
        autostart: autostart ?? latest.autostart,
        notifications: notifier?.getStatus() ?? latest.notifications,
        // Which engine this is, and where it was looked for. The interface has
        // to be able to say so: "nothing is running" and "the daemon you named
        // is not answering" are different problems.
        connection: { mode: 'remote', url: base, attached },
      }
    },

    async start() {
      logger.info(`driving the engine at ${base}`)
      follow()
    },

    async stop() {
      stopping = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      controller?.abort()
    },

    setPaused: (paused) =>
      call('POST', `/api/v1/scheduler/${paused ? 'pause' : 'resume'}`).catch((err) =>
        logger.error('pausing the remote engine failed', err),
      ),
  })

  return engine
}

class RemoteError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/** ${VARIABLE} in the settings is resolved from the local .env, as everywhere else. */
function resolveRemoteToken(token, paths) {
  if (!token) return null
  const resolved = resolveReferences(token, loadEnv(paths.envFile))
  if (resolved.ok) return resolved.value
  logger.error(`the remote token references ${resolved.missing.join(', ')}, which .env does not define`)
  return null
}

module.exports = { createRemoteEngine }
