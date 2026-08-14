'use strict'

// What the HTTP server answers, knowing nothing of the network.
//
// A request comes in as an object, a response comes out: that is what makes it
// possible to exercise the authorisation and every route without opening a
// socket, as the Discord commands are exercised without a bot.
//
// Two surfaces, two flags, and they do not give the same power. The API drives
// everything — start, stop, enable, chat with an agent. The webhook only starts
// a job, and only those declaring they expect it: an address given to a
// third-party service must not open more than what it was given for.

const { loadEnv, resolveReferences } = require('../config/env')
const { describeTriggers, describeRunner } = require('../config/validate')
const { webhookTrigger } = require('../config/triggers')
const logger = require('../lib/logger')
const { presentedToken, tokenMatches } = require('./auth')
const { PAGE } = require('./docs')
const { buildSpec } = require('./openapi')
const { handleUiRoutes } = require('./routes-ui')

const json = (status, body) => ({ status, body })
const ok = (body) => json(200, body)

// An error response says only what the caller is entitled to know. "That token
// is wrong" and "that job does not exist" get the same answer for anyone not
// authenticated: otherwise the API serves as a directory to whoever probes it.
const UNAUTHORIZED = json(401, { error: 'unauthorized' })
const NOT_FOUND = json(404, { error: 'not found' })

/** What a job shows to the outside. Neither its code nor its prompt. */
function describeJob(job, { running, nextRunAt, lastRun }) {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    stale: Boolean(job.stale),
    runner: job.runner.type,
    runnerLabel: describeRunner(job.runner),
    triggers: job.triggers.map((trigger) => ({ ...trigger })),
    triggerLabel: describeTriggers(job.triggers),
    running,
    nextRunAt,
    lastRun,
  }
}

/**
 * Splits "/api/jobs/sync-notes/run" into decoded segments.
 * An empty segment — two slashes in a row — is dropped: it designates nothing.
 */
const segmentsOf = (pathname) =>
  pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment))

/**
 * @param {object} request
 * @param {string} request.method
 * @param {string} request.pathname
 * @param {URLSearchParams} request.query
 * @param {Record<string, string>} request.headers
 * @param {object|null} request.body JSON body already parsed, null if there is none
 * @param {object} deps store, scheduler, runner, state, history, chat, setPaused
 * @returns {Promise<{status: number, body: object}>}
 */
async function handle(request, deps) {
  const { store } = deps
  const config = store.getConfig().http
  const segments = segmentsOf(request.pathname)

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'docs' && request.method === 'GET') {
    if (!config.apiEnabled) return NOT_FOUND
    // A page, not data: it carries nothing the open port does not already say,
    // and it is the page that will ask for the token to fetch the description.
    return { status: 200, body: PAGE, contentType: 'text/html; charset=utf-8' }
  }

  if (segments[0] === 'api') return handleApi(request, segments.slice(1), deps, config)
  if (segments[0] === 'webhook') return handleWebhook(request, segments.slice(1), deps, config)
  return NOT_FOUND
}

// --- API ----------------------------------------------------------------------

async function handleApi(request, segments, deps, config) {
  // Versioned before anything is public. `/api/...` stays an alias for `/api/v1/...`
  // so the README's examples, the scripts people already wrote and the webhook
  // keep working; `/api/v1/...` is what the description now advertises.
  if (segments[0] === 'v1') segments = segments.slice(1)

  // The flag is read before the token: an API that is off answers like an address
  // that does not exist, which is what it is.
  if (!config.apiEnabled) return NOT_FOUND

  const expected = resolveServerToken(deps.store, config)
  if (expected === null) return json(500, { error: 'the server token cannot be resolved' })
  if (!tokenMatches(presentedToken(request.headers), expected)) return UNAUTHORIZED

  const { store, scheduler, runner, state, history, chat, setPaused } = deps
  const { method } = request

  if (segments.length === 1 && segments[0] === 'openapi.json' && method === 'GET') {
    return ok(buildSpec(config))
  }

  // Everything a window used to ask its own process over IPC.
  const ui = await handleUiRoutes(request, segments, deps)
  if (ui) return ui

  if (segments.length === 1 && segments[0] === 'status' && method === 'GET') {
    return ok({
      paused: scheduler.isPaused(),
      sessionLocked: scheduler.isSessionLocked(),
      running: runner.runningExecutions(),
      jobs: store.getJobs().length,
    })
  }

  if (segments.length === 2 && segments[0] === 'scheduler' && method === 'POST') {
    if (segments[1] !== 'pause' && segments[1] !== 'resume') return NOT_FOUND
    await setPaused(segments[1] === 'pause')
    return ok({ paused: segments[1] === 'pause' })
  }

  if (segments[0] === 'work') return handleWork(request, segments.slice(1), deps)

  if (segments[0] !== 'jobs') return NOT_FOUND

  const nextRuns = scheduler.nextRunByJob()
  const lastRuns = state.lastRunByJob()
  const decorate = (job) =>
    describeJob(job, {
      running: runner.runningByJob().get(job.id) ?? 0,
      nextRunAt: nextRuns.get(job.id) ?? null,
      lastRun: lastRuns.get(job.id) ?? null,
    })

  if (segments.length === 1 && method === 'GET') {
    return ok({ jobs: store.getJobs().map(decorate) })
  }

  const job = segments.length >= 2 ? store.getJob(segments[1]) : null
  if (!job) return NOT_FOUND

  if (segments.length === 2 && method === 'GET') return ok(decorate(job))

  const action = segments[2]

  if (segments.length === 3 && action === 'run' && method === 'POST') {
    const result = await scheduler.runNow(job.id, { trigger: 'api' })
    if (!result.ok) return json(409, { error: result.errors.join(' | ') })
    return json(202, { started: job.id })
  }

  if (segments.length === 3 && action === 'stop' && method === 'POST') {
    const executions = runner
      .runningExecutions()
      .filter((execution) => execution.jobId === job.id)
    if (executions.length === 0) return json(409, { error: 'no running execution' })
    for (const execution of executions) runner.cancel(execution.executionId)
    return ok({ stopping: executions.map((execution) => execution.executionId) })
  }

  if (segments.length === 3 && (action === 'enable' || action === 'disable') && method === 'POST') {
    const result = await store.setJobEnabled(job.id, action === 'enable')
    if (!result.ok) return json(422, { error: result.errors.join(' | ') })
    return ok({ id: job.id, enabled: action === 'enable' })
  }

  if (segments.length === 3 && action === 'history' && method === 'GET') {
    const asked = Number.parseInt(request.query.get('limit') ?? '', 10)
    const limit = Math.min(Math.max(Number.isNaN(asked) ? 20 : asked, 1), 200)
    const { entries } = await history.read(job.id, { limit })
    return ok({
      entries: entries.map((entry) => ({
        executionId: entry.executionId,
        trigger: entry.trigger,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        durationMs: entry.durationMs,
        status: entry.status,
        exitCode: entry.exitCode,
        error: entry.error,
      })),
    })
  }

  if (segments.length === 3 && action === 'logs' && method === 'GET') {
    // A running execution wins: that is the one you want to see when you have
    // just started it.
    const live = runner.runningExecutions().find((execution) => execution.jobId === job.id)
    if (live) {
      const output = runner.liveOutput(live.executionId)
      return ok({
        executionId: live.executionId,
        running: true,
        stdout: output.ok ? output.stdout.text : '',
        stderr: output.ok ? output.stderr.text : '',
      })
    }

    const { entries } = await history.read(job.id, { limit: 1 })
    if (entries.length === 0) return ok({ running: false, stdout: '', stderr: '', status: null })
    const entry = entries[0]
    return ok({
      executionId: entry.executionId,
      running: false,
      status: entry.status,
      startedAt: entry.startedAt,
      stdout: entry.stdout ?? '',
      stderr: entry.stderr ?? '',
      error: entry.error,
    })
  }

  if (segments.length === 3 && action === 'chat' && method === 'POST') {
    return handleChat(request, job, { chat })
  }

  return NOT_FOUND
}

/**
 * One turn of conversation with a job's agent.
 *
 * As from a Discord channel: nobody is in front of the screen, so the tools that
 * ask a blocking question are not offered. The answer goes out when the turn is
 * done — an HTTP call knows how to wait, unlike a command that would have a
 * deadline.
 */
async function handleChat(request, job, { chat }) {
  if (!chat) return json(503, { error: 'chatting is unavailable' })

  const message = typeof request.body?.message === 'string' ? request.body.message.trim() : ''
  if (message === '') return json(422, { error: 'a "message" field is required' })

  const opened = chat.open(job.id, 'api')
  if (!opened.ok) return json(422, { error: opened.errors.join(' | ') })
  // One turn occupies the conversation: two messages crossing would stack up on
  // the same context.
  if (opened.busy) return json(409, { error: 'a turn is already running' })

  const posted = await chat.post(opened.chatId, message)
  if (!posted.ok) return json(422, { error: posted.error })
  if (!posted.turn.ok) return json(502, { error: posted.turn.error })
  return ok({ chatId: opened.chatId, reply: posted.turn.content })
}

// --- work queues ----------------------------------------------------------------

/**
 * The queues, over HTTP.
 *
 * This is the door the whole feature exists for: something outside Rota — a
 * GitHub integration, a script, another machine — puts work on the queue, and a
 * worker picks it up without anybody being at the screen. The rest of the
 * surface is convenience; this route is the point.
 */
async function handleWork(request, segments, deps) {
  const { work, store } = deps
  if (!work) return NOT_FOUND
  const { method } = request

  if (segments.length === 0 && method === 'GET') {
    const jobId = request.query.get('jobId')
    const status = request.query.get('status')
    return ok({ items: work.list({ jobId: jobId || null, status: status || null }) })
  }

  if (segments.length === 0 && method === 'POST') {
    const body = request.body ?? {}
    // A queue for a job that is not there would sit unread forever, and the
    // caller would have no way of finding that out.
    if (!store.getJob(body.jobId)) return json(422, { error: `unknown job: ${body.jobId}` })

    const created = await work.create({
      jobId: body.jobId,
      input: body.input ?? {},
      id: typeof body.id === 'string' ? body.id : null,
    })
    // 409 rather than 422 for a name already taken: the caller replaying the
    // same event has done nothing wrong, and that status is what tells it so.
    if (!created.ok) {
      return json(created.error.includes('already exists') ? 409 : 422, { error: created.error })
    }
    return json(201, created.item)
  }

  const item = segments.length >= 1 ? work.get(segments[0]) : null
  if (!item) return NOT_FOUND

  if (segments.length === 1 && method === 'GET') return ok(item)

  if (segments.length === 1 && method === 'DELETE') {
    await work.remove(item.id)
    return ok({ removed: item.id })
  }

  if (segments.length === 2 && segments[1] === 'retry' && method === 'POST') {
    return ok(await work.retry(item.id))
  }

  if (segments.length === 2 && segments[1] === 'cancel' && method === 'POST') {
    return ok(await work.cancel(item.id))
  }

  return NOT_FOUND
}

// --- webhook -------------------------------------------------------------------

/**
 * Starting a job through an HTTP call.
 *
 * Three conditions, and none is one too many: the flag, the job declaring a
 * webhook trigger, and the token. The second is what distinguishes the webhook
 * from the API — an address given to a third-party service only starts what one
 * declared wanting to start by that route.
 */
async function handleWebhook(request, segments, deps, config) {
  if (!config.webhookEnabled) return NOT_FOUND
  // The shape of the address first: "/webhook" on its own designates nothing, and
  // answering "wrong method" would suggest it exists.
  if (segments.length !== 1) return NOT_FOUND
  if (request.method !== 'POST') return json(405, { error: 'POST expected' })

  const { store, scheduler } = deps
  const job = store.getJob(segments[0])
  // A job with no webhook trigger answers like a job that does not exist: the
  // caller has no business learning which ones exist.
  const trigger = job ? webhookTrigger(job) : null
  if (!trigger) {
    const server = resolveServerToken(store, config)
    if (server === null || !tokenMatches(presentedToken(request.headers), server)) {
      return UNAUTHORIZED
    }
    return NOT_FOUND
  }

  const expected =
    trigger.token === undefined
      ? resolveServerToken(store, config)
      : resolveToken(trigger.token, store, 'webhook trigger')
  if (expected === null) return json(500, { error: 'the expected token cannot be resolved' })
  if (!tokenMatches(presentedToken(request.headers), expected)) return UNAUTHORIZED

  const result = await scheduler.runNow(job.id, { trigger: 'webhook' })
  if (!result.ok) return json(409, { error: result.errors.join(' | ') })
  return json(202, { started: job.id })
}

/**
 * Resolves a token that may be only a reference.
 *
 * ${VARIABLE} is accepted here as in API headers: a job definition or a
 * config.json get shared, a secret does not get shared with them. A missing
 * variable yields `null` — and the refusal that follows beats a comparison
 * against the string "${TOKEN}", which a caller could guess.
 *
 * @returns {string|null}
 */
function resolveToken(value, store, what) {
  const resolved = resolveReferences(value, loadEnv(store.paths.envFile))
  if (!resolved.ok) {
    logger.error(`http: unreadable ${what} token — missing variable: ${resolved.missing.join(', ')}`)
    return null
  }
  return resolved.value
}

/**
 * The server's token, or the empty string if there is none.
 *
 * The empty string rather than `null`: a comparison against it always fails —
 * `tokenMatches` refuses the empty — and the caller gets an ordinary refusal,
 * not an internal error that would teach them the configuration is at fault.
 * The case should not arise anyway: validation refuses to open a server with
 * no token.
 */
const resolveServerToken = (store, config) =>
  config.token ? resolveToken(config.token, store, 'server') : ''

module.exports = { handle, describeJob, segmentsOf, resolveServerToken }
