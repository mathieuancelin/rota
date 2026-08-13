'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  validateJob,
  validateConfig,
  describeTrigger,
  describeTriggers,
  describeRunner,
} = require('../src/config/validate')

const MINIMAL_JOB = {
  id: 'obsidian-sync',
  name: 'Synchronisation Obsidian',
  triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
  runner: { type: 'bun', script: '/Users/moi/scripts/sync.js' },
}

const job = (overrides) => ({ ...MINIMAL_JOB, ...overrides })

test('a minimal job is valid and receives all its default values', () => {
  const result = validateJob(MINIMAL_JOB)
  assert.equal(result.ok, true)

  assert.deepEqual(result.job.execution, {
    timeoutSeconds: 300,
    allowConcurrentRuns: false,
    runOnStartup: false,
    catchUpOnWake: true,
    requiresUnlockedSession: false,
    maxOutputBytes: 1048576,
    sandbox: { enabled: false, image: 'oven/bun:1', network: false, mountWorkingDirectory: true },
  })
  assert.deepEqual(result.job.notifications, {
    onStart: false,
    onSuccess: false,
    onChange: false,
    onError: true,
  })
  assert.deepEqual(result.job.history, { enabled: true, retainExecutions: 500 })
  assert.equal(result.job.enabled, true)
  assert.equal(result.job.runner.interpreter, 'sh')
  assert.deepEqual(result.job.runner.args, [])
})

test('validation does not modify its argument', () => {
  const input = job({})
  validateJob(input)
  assert.equal(input.execution, undefined, 'the defaults must not leak into the source object')
})

test('the explicit values are not overwritten by the defaults', () => {
  const result = validateJob(
    job({ execution: { timeoutSeconds: 30, catchUpOnWake: false }, notifications: { onError: false } }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.job.execution.timeoutSeconds, 30)
  assert.equal(result.job.execution.catchUpOnWake, false)
  assert.equal(result.job.execution.allowConcurrentRuns, false, 'the other defaults stay applied')
  assert.equal(result.job.notifications.onError, false)
})

test('the missing required fields are reported', () => {
  const result = validateJob({ id: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
  assert.ok(result.errors.every((e) => e.includes('is required')))
})

// A trigger is a convenience, not an obligation: a job carrying none only starts
// on demand — from the list, the tray, Discord, or another job. That is the case
// of a workflow step.
test('a job with no trigger is valid and schedules nothing', () => {
  const result = validateJob(job({ triggers: [] }))

  assert.equal(result.ok, true, result.errors?.join(' | '))
  assert.deepEqual(result.job.triggers, [])
})

test('an identifier outside the allowed character set is rejected', () => {
  // The id is used as the history file name: it must never contain a separator.
  for (const id of ['Majuscule', 'avec espace', '../evasion', 'accentué', '-starts-with-a-dash']) {
    assert.equal(validateJob(job({ id })).ok, false, `${id} should have been rejected`)
  }
  for (const id of ['obsidian-sync', 'backup_photos', 'job42']) {
    assert.equal(validateJob(job({ id })).ok, true, `${id} should have been accepted`)
  }
})

// --- cron scheduling ------------------------------------------------------------

test('a valid cron expression is accepted', () => {
  const result = validateJob(job({ triggers: [{ type: 'cron', expression: '0 9 * * 1-5' }] }))

  assert.equal(result.ok, true, result.errors?.join(' | '))
  assert.equal(result.job.triggers[0].expression, '0 9 * * 1-5')
})

// The expression is parsed at validation, not when arming a timer: otherwise the
// job would stay loaded, with no visible error and never running.
test('a faulty cron expression is refused, naming the field', () => {
  const result = validateJob(job({ triggers: [{ type: 'cron', expression: '0 25 * * *' }] }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('hour')), result.errors.join(' | '))
})

test('a cron schedule with no expression is refused', () => {
  const result = validateJob(job({ triggers: [{ type: 'cron' }] }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('"expression"')))
})

test('mixing an interval and a cron expression is refused', () => {
  const withBoth = validateJob(
    job({ triggers: [{ type: 'cron', expression: '@daily', every: 5, unit: 'minutes' }] }),
  )
  assert.equal(withBoth.ok, false)
  assert.ok(withBoth.errors.some((e) => e.includes('belong to the interval type')))

  const onInterval = validateJob(
    job({ triggers: [{ type: 'interval', every: 5, unit: 'minutes', expression: '@daily' }] }),
  )
  assert.equal(onInterval.ok, false)
  assert.ok(onInterval.errors.some((e) => e.includes('belongs to the cron type')))
})

test('an interval with neither every nor unit stays refused', () => {
  const result = validateJob(job({ triggers: [{ type: 'interval' }] }))
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
})

test('an unknown scheduling type is refused', () => {
  const result = validateJob(job({ triggers: [{ type: 'quantique', expression: '@daily' }] }))
  assert.equal(result.ok, false)
})

test('an unknown field is refused rather than silently ignored', () => {
  const result = validateJob(job({ scheudle: {} }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('scheudle')))
})

test('a relative script path is refused', () => {
  const result = validateJob(job({ runner: { type: 'bun', script: './sync.js' } }))
  assert.equal(result.ok, false)
  assert.ok(result.errors[0].includes('absolu'))
})

test('an interpreter off the allowlist is refused', () => {
  const result = validateJob(
    job({ runner: { type: 'shell', script: '/tmp/x.sh', interpreter: 'zsh' } }),
  )
  assert.equal(result.ok, false)
})

// --- inline code ----------------------------------------------------------------

const inlineJob = (runner) => job({ runner: { type: 'bun-inline', code: 'console.log(1)', ...runner } })

test('a bun-inline job is valid with no script', () => {
  const result = validateJob(inlineJob())

  assert.equal(result.ok, true, result.errors?.join(' | '))
  assert.equal(result.job.runner.code, 'console.log(1)')
  assert.equal(result.job.runner.script, undefined)
})

test('a bun-inline job with no code is refused', () => {
  const result = validateJob(job({ runner: { type: 'bun-inline' } }))

  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some((error) => error.includes('"code"')),
    result.errors.join(' | '),
  )
  assert.ok(
    !result.errors.some((error) => error.includes('"then"')),
    "the conditional schema's internals do not reach the user",
  )
})

test('a bun-inline job with empty code is refused', () => {
  const result = validateJob(inlineJob({ code: '   \n  ' }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('must carry code')))
})

test('script and code together are refused: which one to run?', () => {
  const result = validateJob(inlineJob({ script: '/Users/moi/scripts/x.js' }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('pointless for a bun-inline job')))
})

test('code on a job that is not inline is refused', () => {
  const result = validateJob(job({ runner: { type: 'bun', script: '/tmp/x.js', code: 'x' } }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('belongs to the bun-inline type')))
})

test('an ordinary bun job is still required to carry a script', () => {
  const result = validateJob(job({ runner: { type: 'bun' } }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('"script"')))
})

test('an entry that is not an object is refused without throwing', () => {
  for (const input of [null, 42, 'text', [], undefined]) {
    const result = validateJob(input)
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 1)
  }
})

test('a zero or negative interval is refused', () => {
  for (const every of [0, -1, 1.5]) {
    assert.equal(validateJob(job({ triggers: [{ type: 'interval', every, unit: 'minutes' }] })).ok, false)
  }
})

test('an empty configuration receives all its defaults', () => {
  const result = validateConfig({})
  assert.equal(result.ok, true)
  assert.deepEqual(result.config, {
    schedulerPaused: false,
    launchAtLogin: true,
    theme: 'system',
    // Embedded is the default, and the whole desktop install: a configuration
    // that says nothing about it gets the scheduler in the application.
    engine: { mode: 'embedded', url: null, token: null },
    runners: { bunPath: null, dockerPath: null },
    integrations: {
      discordWebhookUrl: null,
      discordBotToken: null,
      discordChannelId: null,
      discordControlEnabled: false,
      discordChatEnabled: false,
      mirrorReportsToDiscord: true,
    },
    http: {
      enabled: false,
      listen: '127.0.0.1',
      port: 47823,
      token: null,
      apiEnabled: false,
      webhookEnabled: false,
    },
    defaults: { maxOutputBytes: 1048576, inlineOutputBytes: 8192, retainExecutions: 500 },
  })
})

// A port open with no password is driveable from any local process — and from any
// web page open in a tab, which can send it a request. That is not recoverable
// after the fact: we refuse to open.
test('the HTTP server does not come up without a token', () => {
  const sans = validateConfig({ http: { enabled: true } })
  assert.equal(sans.ok, false)
  assert.ok(sans.errors.some((error) => error.startsWith('http.token:')), sans.errors.join(' | '))

  const avec = validateConfig({
    http: { enabled: true, token: 'tt_0123456789abcdef0123456789abcdef' },
  })
  assert.equal(avec.ok, true, avec.errors?.join(' | '))
})

test('a token too short is refused by the schema', () => {
  assert.equal(validateConfig({ http: { enabled: true, token: 'court' } }).ok, false)
})

// The token accepts ${VARIABLE} like the API headers: a config.json gets shared,
// a secret does not get shared with it.
test("the server's token accepts a variable reference", () => {
  const result = validateConfig({ http: { enabled: true, token: '${ROTA_API_TOKEN}' } })

  assert.equal(result.ok, true, result.errors?.join(' | '))
})

test('a malformed reference is refused', () => {
  const result = validateConfig({ http: { enabled: true, token: '${pas-un-nom-valide}' } })

  assert.equal(result.ok, false)
})

// Appearance is a single setting that drives everything: the stylesheets, the
// Monaco editor and the window backgrounds all listen to the same media query,
// which the main process forces from this value.
test('the appearance follows the system by default, and accepts three values only', () => {
  assert.equal(validateConfig({}).config.theme, 'system')

  for (const theme of ['system', 'light', 'dark']) {
    assert.equal(validateConfig({ theme }).ok, true, theme)
  }
  assert.equal(validateConfig({ theme: 'sombre' }).ok, false, 'les values sont en anglais')
  assert.equal(validateConfig({ theme: true }).ok, false)
})

test('describeTrigger gets the article and the plural right', () => {
  assert.equal(describeTrigger({ every: 5, unit: 'minutes' }), 'every 5 minutes')
  assert.equal(describeTrigger({ every: 1, unit: 'minutes' }), 'every minute')
  assert.equal(describeTrigger({ every: 1, unit: 'hours' }), 'every hour')
  assert.equal(describeTrigger({ every: 1, unit: 'days' }), 'every day')
  assert.equal(describeTrigger({ every: 2, unit: 'days' }), 'every 2 days')
  assert.equal(describeTrigger({ every: 30, unit: 'seconds' }), 'every 30 seconds')
})

test('describeTrigger names the triggers that have no occurrence', () => {
  assert.equal(describeTrigger({ type: 'cron', expression: '0 9 * * 1-5' }), 'cron "0 9 * * 1-5"')
  assert.equal(describeTrigger({ type: 'webhook' }), 'on webhook')
  assert.equal(describeTrigger({ type: 'discord', keyword: 'deploy' }), 'on \u201cdeploy\u201d')
})

// A job with no trigger does not say "nothing": it says how it starts.
test('describeTriggers enumerates, and says what having none means', () => {
  assert.equal(describeTriggers([]), 'on demand')
  assert.equal(describeTriggers(undefined), 'on demand')
  assert.equal(
    describeTriggers([
      { type: 'interval', every: 5, unit: 'minutes' },
      { type: 'webhook' },
    ]),
    'every 5 minutes \u00b7 on webhook',
  )
})

// A disabled trigger stays visible: hiding it would suggest an oversight.
test('describeTriggers shows the switched-off triggers rather than keeping quiet', () => {
  assert.equal(
    describeTriggers([{ type: 'webhook', enabled: false }]),
    'on webhook (off)',
  )
})

// --- runner label ----------------------------------------------------------------
//
// The schema fills `interpreter` with "sh" by default, including for a Bun job:
// reading it without looking at the type displayed "sh" under a "bun run"
// command.

test('describeRunner names every type without reading an irrelevant interpreter', () => {
  const label = (runner) => describeRunner(validateJob(job({ runner })).job.runner)

  assert.equal(label({ type: 'bun', script: '/tmp/x.js' }), 'Bun')
  assert.equal(label({ type: 'bun-inline', code: 'console.log(1)' }), 'Bun, inline code')
  assert.equal(label({ type: 'shell', script: '/tmp/x.sh' }), 'sh')
  assert.equal(label({ type: 'shell', script: '/tmp/x.sh', interpreter: 'bash' }), 'bash')
})

// --- sandbox ---------------------------------------------------------------------

test('a sandboxed job receives its default values', () => {
  const result = validateJob(job({ execution: { sandbox: { enabled: true } } }))

  assert.equal(result.ok, true, result.errors?.join(' | '))
  assert.deepEqual(result.job.execution.sandbox, {
    enabled: true,
    image: 'oven/bun:1',
    network: false,
    mountWorkingDirectory: true,
  })
})

// The image name is an element of docker's argument array: accepting a leading
// dash would let the job choose an option of docker run.
test('an image name starting with a dash is refused', () => {
  const result = validateJob(
    job({ execution: { sandbox: { enabled: true, image: '--privileged' } } }),
  )

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('cannot start with')))
})

test('an image name with a space is refused', () => {
  const result = validateJob(
    job({ execution: { sandbox: { enabled: true, image: 'oven/bun:1 --privileged' } } }),
  )

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('no space')))
})

test('the image is not checked when the sandbox is off', () => {
  const result = validateJob(job({ execution: { sandbox: { image: '--bizarre' } } }))
  assert.equal(result.ok, true, 'unused, it bothers nobody')
})

test('an unknown field in sandbox is refused', () => {
  const result = validateJob(job({ execution: { sandbox: { privileged: true } } }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('privileged')))
})

// --- agent type ------------------------------------------------------------------

const agentJob = (agent, rest) =>
  job({
    runner: { type: 'agent', agent: { prompt: 'Range mes notes.', model: 'gemma4:latest', ...agent } },
    ...rest,
  })

test('an agent job is valid with neither script nor code, and receives its defaults', () => {
  const result = validateJob(agentJob())

  assert.equal(result.ok, true, result.errors?.join(' | '))
  const { agent } = result.job.runner
  // A job that says nothing receives Rota's default instructions, by
  // reference: the text itself lives in agent/defaults.js.
  assert.equal(agent.systemPrompt, '${defaults.system_prompt}')
  assert.equal(agent.maxIterations, 25)
  assert.equal(agent.reasoningEffort, undefined, 'absent, nothing is sent to the server')
  assert.deepEqual(agent.api, {
    baseUrl: 'http://127.0.0.1:11434/v1',
    headers: {},
    timeoutSeconds: 120,
    extraBody: {},
  })
  assert.deepEqual(agent.tools.enabled, ['fetch', 'file_read', 'file_list', 'todo', 'memory', 'report'])
  assert.deepEqual(agent.tools.fetch, { allowHosts: [], maxResponseBytes: 262144 })
  assert.deepEqual(agent.tools.system, { timeoutSeconds: 120, maxOutputBytes: 65536 })
  assert.deepEqual(agent.tools.files, { maxReadBytes: 131072 })
  assert.deepEqual(agent.tools.interaction, { timeoutSeconds: 120 })
  assert.deepEqual(agent.memory, { enabled: true, maxEntries: 100 })
})

test('an agent job with no agent configuration is refused', () => {
  const result = validateJob(job({ runner: { type: 'agent' } }))

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('"agent"')), result.errors.join(' | '))
})

test('prompt and model are required', () => {
  for (const missing of ['prompt', 'model']) {
    const agent = { prompt: 'Fais.', model: 'gemma4:latest' }
    delete agent[missing]
    const result = validateJob(job({ runner: { type: 'agent', agent } }))
    assert.equal(result.ok, false, `${missing} missing should have been refused`)
    assert.ok(result.errors.some((e) => e.includes(`"${missing}"`)))
  }
})

test('a prompt empty of meaning is refused', () => {
  const result = validateJob(agentJob({ prompt: '  \n ' }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('must say what it expects')))
})

test('script or code on an agent job are refused', () => {
  const withScript = validateJob(
    job({ runner: { type: 'agent', script: '/tmp/x.js', agent: { prompt: 'x', model: 'm' } } }),
  )
  assert.equal(withScript.ok, false)
  assert.ok(withScript.errors.some((e) => e.includes('pointless for an agent job')))

  const withCode = validateJob(
    job({ runner: { type: 'agent', code: 'x', agent: { prompt: 'x', model: 'm' } } }),
  )
  assert.equal(withCode.ok, false)
  assert.ok(withCode.errors.some((e) => e.includes('belongs to the bun-inline type')))
})

test('an agent configuration on another type is refused', () => {
  const result = validateJob(
    job({ runner: { type: 'bun', script: '/tmp/x.js', agent: { prompt: 'x', model: 'm' } } }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('belongs to the agent type')))
})

// A faulty URL would otherwise only show on the first call, that is, on the first
// scheduled execution.
test('an invalid API URL is refused, naming the field', () => {
  for (const baseUrl of ['pas-une-url', 'ftp://exemple.fr', '/v1']) {
    const result = validateJob(agentJob({ api: { baseUrl } }))
    assert.equal(result.ok, false, `${baseUrl} should have been refused`)
    assert.ok(result.errors.some((e) => e.includes('api.baseUrl')), result.errors.join(' | '))
  }
})

test('a malformed variable reference in a header is refused', () => {
  const result = validateJob(
    agentJob({ api: { headers: { Authorization: 'Bearer ${api key}' } } }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('valid variable name')))
})

test('a well-formed variable reference goes through, without being resolved here', () => {
  const result = validateJob(
    agentJob({ api: { headers: { Authorization: 'Bearer ${OPENAI_API_KEY}' } } }),
  )
  assert.equal(result.ok, true, result.errors?.join(' | '))
  assert.equal(result.job.runner.agent.api.headers.Authorization, 'Bearer ${OPENAI_API_KEY}')
})

test('an unknown tool is refused rather than ignored', () => {
  const result = validateJob(agentJob({ tools: { enabled: ['fetch', 'rm_rf'] } }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('expected one of')))
})

// The agent's file tools work on the host side: with no mount, what it writes and
// what its commands see would be two different disks.
test('a sandboxed agent with no working directory mounted is refused', () => {
  const result = validateJob(
    agentJob({}, { execution: { sandbox: { enabled: true, mountWorkingDirectory: false } } }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('working directory inside the container')))
})

test("describeRunner names an agent's model", () => {
  const result = validateJob(agentJob())
  assert.equal(describeRunner(result.job.runner), 'Agent · gemma4:latest')
})

// With no control, the bot listens to nothing: the command would never be read.
test('chatting from Discord requires control', () => {
  const refuse = validateConfig({ integrations: { discordChatEnabled: true } })
  assert.equal(refuse.ok, false)
  assert.ok(refuse.errors.some((e) => e.includes('chatting requires control')))

  const accepte = validateConfig({
    integrations: {
      discordChatEnabled: true,
      discordControlEnabled: true,
      discordBotToken: 'token',
      discordChannelId: '123456789012345678',
    },
  })
  assert.equal(accepte.ok, true, accepte.errors?.join(' | '))
})

test('a schema default never leaks a field into a trigger of another type', () => {
  // `on` once carried "default": "success" in the schema. ajv fills defaults in
  // for every declared property of the object it is validating, so every
  // interval and cron trigger came back carrying an `on` — which the checks
  // below then rejected as belonging to the after type. 130 tests said so at
  // once; this one says why.
  const result = validateJob({
    id: 'x',
    name: 'X',
    triggers: [
      { type: 'interval', every: 5, unit: 'minutes' },
      { type: 'cron', expression: '0 9 * * *' },
      { type: 'webhook' },
      { type: 'power', event: 'wake' },
    ],
    runner: { type: 'shell', script: '/x.sh' },
  })

  assert.equal(result.ok, true, JSON.stringify(result.errors))
  const foreign = ['job', 'on', 'event', 'keyword', 'token', 'expression', 'every', 'unit']
  for (const [index, trigger] of result.job.triggers.entries()) {
    const kept = foreign.filter((field) => trigger[field] !== undefined)
    const allowed = {
      interval: ['every', 'unit'],
      cron: ['expression'],
      webhook: [],
      power: ['event'],
    }[trigger.type]
    assert.deepEqual(kept.sort(), allowed.sort(), `trigger ${index} (${trigger.type})`)
  }
})
