'use strict'

// What each command actually does.
//
// The split that matters is the one the help already announces: reading
// commands go to the files and work with nothing running, acting commands go
// through the API. Nothing here reaches across that line — a `jobs` that
// quietly fell back to the daemon when the files were unreadable would make
// "works with nothing running" a lie you only discover on a bad day.

const fs = require('node:fs/promises')
const path = require('node:path')

const {
  ConfigStore,
  describeTriggers,
  HistoryStore,
  historyOutputs,
  nextRunAt,
  StateStore,
  validateJob,
} = require('@rota/core')

const { createClient, resolveEndpoint } = require('./api')
const { duration, relativeTime, table } = require('./render')

/** The store, loaded once per invocation. Cheap, and the command needs it. */
async function openStore(paths) {
  const store = new ConfigStore(paths)
  await store.reload()
  return store
}

async function openState(paths) {
  const state = new StateStore(paths.stateFile)
  await state.load()
  return state
}

function client(store, options) {
  return createClient(resolveEndpoint(store, { url: options.url, token: options.token }))
}

// --- Reading the files --------------------------------------------------------

async function jobs(context) {
  const { options, style, out } = context

  if (options.remote) {
    const { jobs: remote } = await client(await openStore(context.paths), options).get('/api/jobs')
    if (options.json) return out(remote)
    return out(
      table(
        ['ID', 'NAME', 'TRIGGERS', 'NEXT', 'RUNNING'],
        remote.map((job) => [
          style.bold(job.id),
          job.name,
          job.triggerLabel ?? '',
          relativeTime(job.nextRunAt),
          job.running ? style.blue(String(job.running)) : '',
        ]),
        { style, empty: 'the engine knows of no job' },
      ),
    )
  }

  const store = await openStore(context.paths)
  const state = await openState(context.paths)
  const all = store.getJobs()

  if (options.json) {
    return out(all.map((job) => ({ ...job, nextRunAt: computeNextRun(job, state) })))
  }

  out(
    table(
      ['ID', 'NAME', 'TRIGGERS', 'NEXT', 'LAST'],
      all.map((job) => {
        const last = state.getLastRun(job.id)
        return [
          job.enabled ? style.bold(job.id) : style.dim(job.id),
          job.name,
          describeTriggers(job.triggers),
          job.enabled ? relativeTime(computeNextRun(job, state)) : style.dim('disabled'),
          last ? `${style.status(last.status)} ${style.dim(relativeTime(last.at))}` : style.dim('never'),
        ]
      }),
      { style, empty: 'no job in this configuration directory' },
    ),
  )

  const issues = store.getIssues()
  if (issues.length > 0) {
    out('')
    out(style.yellow(`${issues.length} file(s) would not load — rotactl validate says why`))
  }
}

/**
 * What the files say will happen. Deliberately not what a scheduler has armed:
 * the two differing is a fact worth surfacing, which is what --remote is for.
 */
function computeNextRun(job, state) {
  if (!job.enabled) return null
  const last = state.getLastRun(job.id)
  const lastRunAt = last ? Date.parse(last.at) : null
  const anchorAt = Date.now()

  const candidates = job.triggers
    .filter((trigger) => trigger.type === 'cron' || trigger.type === 'interval')
    .map((trigger) => nextRunAt(trigger, { lastRunAt, anchorAt }))
    .filter((at) => typeof at === 'number' && Number.isFinite(at))

  return candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : null
}

async function show(context) {
  const { argument, options, out, fail } = context
  if (!argument) return fail('show needs a job identifier')

  // Read raw rather than through the store: a job the engine refuses is exactly
  // the one somebody is trying to look at.
  const file = path.join(context.paths.jobsDir, `${argument}.json`)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return fail(`no job file at ${file}`)
    throw err
  }

  if (options.json) return out(raw.trimEnd(), { raw: true })

  const { style } = context
  out(raw.trimEnd(), { raw: true })

  const parsed = JSON.parse(raw)
  const verdict = validateJob(parsed)
  out('')
  if (verdict.ok) {
    out(style.green('valid'))
  } else {
    out(style.red('would be refused:'))
    for (const error of verdict.errors) out(`  ${error}`)
  }
}

async function next(context) {
  const { options, style, out } = context

  if (options.remote) {
    const { jobs: remote } = await client(await openStore(context.paths), options).get('/api/jobs')
    const upcoming = remote
      .filter((job) => job.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    if (options.json) return out(upcoming)
    return out(
      table(
        ['WHEN', 'ID', 'NAME'],
        upcoming.map((job) => [relativeTime(job.nextRunAt), style.bold(job.id), job.name]),
        { style, empty: 'nothing scheduled' },
      ),
    )
  }

  const store = await openStore(context.paths)
  const state = await openState(context.paths)

  const upcoming = store
    .getJobs()
    .map((job) => ({ job, at: computeNextRun(job, state) }))
    .filter((entry) => entry.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  if (options.json) {
    return out(upcoming.map(({ job, at }) => ({ jobId: job.id, name: job.name, at })))
  }

  out(
    table(
      ['WHEN', 'ID', 'NAME'],
      upcoming.map(({ job, at }) => [relativeTime(at), style.bold(job.id), job.name]),
      { style, empty: 'nothing scheduled — no enabled job has a timed trigger' },
    ),
  )
}

async function history(context) {
  const { argument, options, style, out, fail } = context
  if (!argument) return fail('history needs a job identifier')

  const config = await openStore(context.paths)
  const store = new HistoryStore(context.paths, { getDefaults: () => config.getConfig().defaults })
  const { entries, hasMore } = await store.read(argument, { limit: options.limit ?? 20 })

  if (options.json) return out(entries)

  out(
    table(
      ['WHEN', 'STATUS', 'TOOK', 'TRIGGER', 'DETAIL'],
      entries.map((entry) => [
        relativeTime(entry.finishedAt ?? entry.startedAt),
        style.status(entry.status),
        duration(entry.durationMs),
        style.dim(entry.trigger ?? ''),
        entry.error ? style.red(firstLine(entry.error)) : style.dim(firstLine(entry.change ?? '')),
      ]),
      { style, empty: `no execution recorded for ${argument}` },
    ),
  )

  // Saying so beats letting somebody conclude that twenty is all there ever was.
  if (hasMore) out(style.dim(`more further back — rotactl history ${argument} --limit 100`))
}

function firstLine(text) {
  if (!text) return ''
  const line = String(text).split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

async function logs(context) {
  const { argument, options, style, out, fail } = context
  if (!argument) return fail('logs needs a job identifier')

  const config = await openStore(context.paths)
  const store = new HistoryStore(context.paths, { getDefaults: () => config.getConfig().defaults })
  const { entries } = await store.read(argument, { limit: 1 })
  const [entry] = entries
  if (!entry) return fail(`no execution recorded for ${argument}`)

  // Output too large for the JSONL lives beside it; the caller asked for the
  // output, not for wherever it happens to be kept.
  const read = async (stream) => {
    const relative = entry.outputFiles?.[stream]
    if (!relative) return entry[stream] ?? ''
    const external = await historyOutputs.read(context.paths.historyDir, relative)
    // What is on disk, or — if it has been swept up by retention — the truncated
    // copy the history entry kept. Silence would be the wrong answer to both.
    return external.ok ? external.text : (entry[stream] ?? '')
  }

  const stdout = await read('stdout')
  const stderr = await read('stderr')

  if (options.json) return out({ ...entry, stdout, stderr })

  out(
    `${style.dim('execution')} ${entry.executionId} — ${style.status(entry.status)} ${style.dim(
      relativeTime(entry.finishedAt ?? entry.startedAt),
    )}`,
  )
  out(style.dim(entry.command ?? ''))
  if (stdout) {
    out('')
    out(style.dim('— stdout —'))
    out(stdout.trimEnd(), { raw: true })
  }
  if (stderr) {
    out('')
    out(style.red('— stderr —'))
    out(stderr.trimEnd(), { raw: true })
  }
  if (!stdout && !stderr) {
    out('')
    out(style.dim('no output'))
  }
}

async function validate(context) {
  const { argument, options, style, out } = context
  const store = await openStore(context.paths)

  const files = argument
    ? [path.join(context.paths.jobsDir, `${argument}.json`)]
    : (await fs.readdir(context.paths.jobsDir).catch(() => []))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(context.paths.jobsDir, name))

  const results = []
  for (const file of files) {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (err) {
      results.push({ file, ok: false, errors: [err.message] })
      continue
    }
    const verdict = validateJob(parsed)
    results.push({ file, ok: verdict.ok, errors: verdict.errors ?? [] })

    // The identifier indexes the history: a file whose name does not match it
    // loads, and then writes its history under a name nobody will look for.
    const expected = path.basename(file, '.json')
    if (verdict.ok && parsed.id !== expected) {
      results[results.length - 1] = {
        file,
        ok: false,
        errors: [`the file is named ${expected}.json but the id is "${parsed.id}"`],
      }
    }
  }

  if (options.json) return out(results)

  const broken = results.filter((result) => !result.ok)
  for (const result of broken) {
    out(`${style.red('✗')} ${path.basename(result.file)}`)
    for (const error of result.errors) out(`    ${error}`)
  }

  if (broken.length === 0) {
    out(style.green(`${results.length} file(s), nothing to report`))
  } else {
    out('')
    out(style.red(`${broken.length} of ${results.length} file(s) would be refused`))
  }

  // The exit status is the point: this belongs in whatever runs before you walk
  // away.
  context.exitCode = broken.length > 0 ? 1 : 0

  // Configuration problems the store itself found, which are the same files
  // seen from the other side.
  const issues = store.getIssues()
  if (issues.length > 0 && broken.length === 0) {
    out(style.yellow(`the engine also reports: ${issues.map((i) => i.file).join(', ')}`))
  }
}

// --- Asking the running engine ------------------------------------------------

async function status(context) {
  const { options, style, out } = context
  const api = client(await openStore(context.paths), options)
  const answer = await api.get('/api/status')

  if (options.json) return out(answer)

  out(`${style.dim('engine  ')} ${api.base}`)
  out(`${style.dim('scheduler')} ${answer.paused ? style.yellow('paused') : style.green('running')}`)
  out(`${style.dim('session ')} ${answer.sessionLocked ? 'locked' : 'unlocked'}`)
  out(`${style.dim('jobs    ')} ${answer.jobs}`)

  if (answer.running.length === 0) {
    out(`${style.dim('running ')} nothing`)
    return
  }
  out('')
  out(
    table(
      ['RUNNING', 'STARTED', 'EXECUTION'],
      answer.running.map((run) => [
        style.bold(run.jobId),
        relativeTime(run.startedAt),
        style.dim(run.executionId),
      ]),
      { style },
    ),
  )
}

async function run(context) {
  const { argument, options, style, out, fail } = context
  if (!argument) return fail('run needs a job identifier')

  const answer = await client(await openStore(context.paths), options).post(
    `/api/jobs/${encodeURIComponent(argument)}/run`,
  )
  if (options.json) return out(answer)
  // Accepted, not finished: saying "done" here would be a lie for anything that
  // takes longer than the round trip.
  out(`${style.green('started')} ${argument}${answer?.executionId ? ` — ${style.dim(answer.executionId)}` : ''}`)
}

async function stop(context) {
  const { argument, options, style, out, fail } = context
  if (!argument) return fail('stop needs a job identifier')

  let answer
  try {
    answer = await client(await openStore(context.paths), options).post(
      `/api/jobs/${encodeURIComponent(argument)}/stop`,
    )
  } catch (err) {
    // The engine says 409 when there was nothing to stop. The help promises
    // that this is not an error, and it should not be one here either.
    if (err.status !== 409) throw err
    if (options.json) return out({ stopping: [] })
    return out(`nothing was running for ${argument}`)
  }

  if (options.json) return out(answer)
  const stopping = answer?.stopping ?? []
  out(`${style.yellow('stopping')} ${stopping.length} execution(s) of ${argument}`)
}

const pause = (context) => setPaused(context, true)
const resume = (context) => setPaused(context, false)

async function setPaused(context, paused) {
  const { options, style, out } = context
  const answer = await client(await openStore(context.paths), options).post(
    `/api/scheduler/${paused ? 'pause' : 'resume'}`,
  )
  if (options.json) return out(answer)
  out(paused ? style.yellow('scheduler paused') : style.green('scheduler resumed'))
}

async function events(context) {
  const { options, style, out } = context
  const api = client(await openStore(context.paths), options)

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  if (!options.json) out(style.dim(`following ${api.base} — Ctrl-C to stop`))

  await api.stream((frame) => {
    if (options.json) return out(frame)
    const line = describeEvent(frame, style)
    if (line) out(line)
  }, controller.signal)
}

/**
 * One line per event. `state` is deliberately reduced to a count: it carries the
 * whole world, and printing it would drown everything worth reading.
 */
function describeEvent({ event, data }, style) {
  const stamp = style.dim(new Date().toISOString().slice(11, 19))

  if (event === 'started') return `${stamp} ${style.blue('▶')} ${data.jobId} ${style.dim(data.trigger ?? '')}`
  if (event === 'finished') {
    return `${stamp} ${style.blue('◀')} ${data.jobId} ${style.status(data.status)} ${style.dim(
      duration(data.durationMs),
    )}`
  }
  if (event === 'output') {
    const text = String(data.chunk ?? '').trimEnd()
    if (!text) return null
    const mark = data.stream === 'stderr' ? style.red('│') : style.dim('│')
    return text
      .split('\n')
      .map((line) => `${stamp} ${mark} ${line}`)
      .join('\n')
  }
  if (event === 'state') {
    const running = data?.scheduler?.running ?? 0
    return `${stamp} ${style.dim(`state — ${data?.jobs?.length ?? 0} job(s), ${running} running`)}`
  }
  if (event === 'chat') return `${stamp} ${style.dim(`chat — ${data.type ?? 'event'}`)}`
  return `${stamp} ${style.dim(event)}`
}

// --- Writing a job file -------------------------------------------------------

const enable = (context) => setEnabled(context, true)
const disable = (context) => setEnabled(context, false)

async function setEnabled(context, enabled) {
  const { argument, options, style, out, fail } = context
  if (!argument) return fail(`${enabled ? 'enable' : 'disable'} needs a job identifier`)

  const store = await openStore(context.paths)
  const result = await store.setJobEnabled(argument, enabled)
  if (!result.ok) return fail(result.errors.join(' | '))

  if (options.json) return out({ id: argument, enabled })
  out(
    `${enabled ? style.green('enabled') : style.yellow('disabled')} ${argument} ${style.dim(
      '— a running engine picks this up within the second',
    )}`,
  )
}

// --- Reusable agents --------------------------------------------------------------

/**
 * The profiles, read off the files.
 *
 * A reading command, like `jobs` and `show`: the definitions are on disk, and
 * asking what an agent is made of is exactly the sort of question one has with
 * nothing running.
 */
async function profiles(context) {
  const { argument, options, style, out, fail } = context
  const store = await openStore(context.paths)

  if (!argument) {
    const all = store.getProfiles()
    if (options.json) return out(all)

    return out(
      table(
        ['ID', 'NAME', 'MODEL', 'TOOLS', 'USED BY'],
        all.map((profile) => [
          style.bold(profile.id),
          profile.name,
          profile.model,
          String(profile.tools.enabled.length),
          store.jobsUsingProfile(profile.id).join(', ') || style.dim('nobody'),
        ]),
        { style, empty: 'no profile in profiles/' },
      ),
    )
  }

  const profile = store.getProfile(argument)
  if (!profile) return fail(`unknown profile: ${argument}`)
  if (options.json) return out(profile)

  const users = store.jobsUsingProfile(profile.id)
  out(`${style.dim('profile ')} ${style.bold(profile.id)}`)
  out(`${style.dim('name    ')} ${profile.name}`)
  if (profile.description) out(`${style.dim('about   ')} ${profile.description}`)
  out(`${style.dim('model   ')} ${profile.model} ${style.dim(`@ ${profile.api.baseUrl}`)}`)
  out(`${style.dim('turns   ')} ${profile.maxIterations} at most`)
  out(`${style.dim('memory  ')} ${profile.memory.enabled ? 'on' : 'off'}`)
  out(`${style.dim('tools   ')} ${profile.tools.enabled.join(', ') || style.dim('none')}`)
  if (profile.mcp.length > 0) {
    out(`${style.dim('mcp     ')} ${profile.mcp.map((server) => server.name).join(', ')}`)
  }
  // What one comes to check before changing a system prompt.
  out(`${style.dim('used by ')} ${users.join(', ') || style.dim('nobody')}`)
}

// --- The queues -----------------------------------------------------------------

const WORK_STATUS_COLOUR = {
  pending: (style, text) => style.dim(text),
  claimed: (style, text) => text,
  running: (style, text) => style.green(text),
  done: (style, text) => style.green(text),
  failed: (style, text) => style.red(text),
  cancelled: (style, text) => style.yellow(text),
}

/** A one-line summary of what an item is about, for the table. */
function summariseInput(input) {
  const entries = Object.entries(input ?? {})
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ')
    .slice(0, 48)
}

/**
 * The work queues.
 *
 * The only command with sub-commands, and it earns them: listing, queueing and
 * retrying are not variations on one another, and four top-level names for one
 * concept would read worse than one name with four verbs.
 */
async function work(context) {
  const { options, style, out, fail } = context
  const [verb = 'list', target = null] = context.arguments
  const api = client(await openStore(context.paths), options)

  if (verb === 'list') {
    const query = new URLSearchParams()
    if (target) query.set('jobId', target)
    const suffix = query.toString() ? `?${query}` : ''
    const answer = await api.get(`/api/work${suffix}`)
    if (options.json) return out(answer)

    return out(
      table(
        ['ITEM', 'JOB', 'STATUS', 'AGE', 'TRIES', 'INPUT'],
        answer.items.map((item) => [
          style.bold(item.id),
          item.jobId,
          (WORK_STATUS_COLOUR[item.status] ?? ((_, text) => text))(style, item.status),
          relativeTime(item.createdAt),
          String(item.attempts),
          style.dim(summariseInput(item.input)),
        ]),
        { style, empty: 'no work queued' },
      ),
    )
  }

  if (verb === 'add') {
    if (!target) return fail('work add needs a job identifier')

    let input = {}
    if (options.input) {
      try {
        input = JSON.parse(options.input)
      } catch (err) {
        return fail(`--input is not valid JSON: ${err.message}`)
      }
    }

    const answer = await api.post('/api/work', {
      jobId: target,
      input,
      ...(options.id ? { id: options.id } : {}),
    })
    if (options.json) return out(answer)
    return out(`${style.green('queued')} ${answer.id} ${style.dim(`for ${answer.jobId}`)}`)
  }

  if (!target) return fail(`work ${verb} needs a work item identifier`)
  const id = encodeURIComponent(target)

  if (verb === 'show') {
    const item = await api.get(`/api/work/${id}`)
    if (options.json) return out(item)

    out(`${style.dim('item    ')} ${style.bold(item.id)}`)
    out(`${style.dim('job     ')} ${item.jobId}`)
    out(`${style.dim('status  ')} ${item.status}`)
    out(`${style.dim('tries   ')} ${item.attempts}`)
    out(`${style.dim('created ')} ${relativeTime(item.createdAt)}`)
    if (item.availableAt) out(`${style.dim('held til')} ${relativeTime(item.availableAt)}`)
    if (item.executionId) out(`${style.dim('run     ')} ${item.executionId}`)
    if (item.error) out(`${style.dim('error   ')} ${style.red(item.error)}`)
    out('')
    out(`${style.dim('input')}`)
    out(JSON.stringify(item.input, null, 2), { raw: true })
    if (item.result) {
      out('')
      out(`${style.dim('result')}`)
      out(item.result, { raw: true })
    }
    return
  }

  if (verb === 'retry' || verb === 'cancel') {
    const item = await api.post(`/api/work/${id}/${verb}`)
    if (options.json) return out(item)
    const label = verb === 'retry' ? style.green('queued again') : style.yellow('cancelled')
    return out(`${label} ${item.id}`)
  }

  if (verb === 'rm') {
    const answer = await api.delete(`/api/work/${id}`)
    if (options.json) return out(answer)
    return out(`${style.yellow('removed')} ${answer.removed}`)
  }

  return fail(`unknown: work ${verb} — try list, add, show, retry, cancel or rm`)
}

module.exports = {
  jobs,
  show,
  next,
  profiles,
  work,
  history,
  logs,
  validate,
  status,
  run,
  stop,
  pause,
  resume,
  events,
  enable,
  disable,
  computeNextRun,
  describeEvent,
}
