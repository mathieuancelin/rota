'use strict'

// Validating the JSON files against the schemas in schemas/.
// ajv also applies the default values: the rest of the code can therefore
// consider a validated job complete (no optional field absent).

const path = require('node:path')
const Ajv = require('ajv')

const { COMMANDS } = require('../discord/commands')
const { parseCron } = require('../lib/cron')

const jobSchema = require('../../schemas/job.schema.json')
const configSchema = require('../../schemas/config.schema.json')

const ajv = new Ajv({
  allErrors: true,
  useDefaults: true,
  // The schemas carry "default"s in sub-objects, which strict mode wrongly flags.
  strict: false,
})

const compiledJob = ajv.compile(jobSchema)
const compiledConfig = ajv.compile(configSchema)

const UNIT_LABELS = {
  seconds: 'seconds',
  minutes: 'minutes',
  hours: 'hours',
  days: 'days',
}

// The words the Discord bridge reads as commands. A job claiming one would never
// start: the command wins, and nothing would say so. The list comes from the
// bridge rather than from a copy — it grows with it.
const RESERVED_KEYWORDS = new Set(Object.keys(COMMANDS))

function fieldLabel(instancePath) {
  if (!instancePath) return 'document root'
  return instancePath.slice(1).replace(/\//g, '.')
}

/** Translates an ajv error into a readable message. */
function formatError(err) {
  const field = fieldLabel(err.instancePath)
  switch (err.keyword) {
    case 'required':
      return `${field}: the "${err.params.missingProperty}" field is required`
    case 'additionalProperties':
      return `${field}: unknown field "${err.params.additionalProperty}"`
    case 'enum':
      return `${field}: expected one of ${err.params.allowedValues.map((v) => `"${v}"`).join(', ')}`
    case 'const':
      return `${field}: only the value "${err.params.allowedValue}" is accepted`
    case 'type':
      return `${field}: expected type ${err.params.type}`
    case 'pattern':
      return `${field}: invalid format (expected: ${err.params.pattern})`
    case 'minimum':
      return `${field}: must be greater than or equal to ${err.params.limit}`
    case 'maximum':
      return `${field}: must be less than or equal to ${err.params.limit}`
    case 'minLength':
      return `${field}: must not be empty`
    case 'maxLength':
      return `${field}: ${err.params.limit} characters at most`
    default:
      return `${field}: ${err.message}`
  }
}

function formatErrors(errors) {
  // The `if` keyword describes no fault by itself: it always doubles a more
  // precise error on the branch taken, the only one worth displaying.
  return (errors ?? []).filter((err) => err.keyword !== 'if').map(formatError)
}

/**
 * Checks that cannot be expressed in JSON Schema.
 * @returns {string[]} error messages
 */
function semanticJobErrors(job) {
  const errors = []
  const { runner } = job

  errors.push(...triggerErrors(job))
  errors.push(...runnerErrors(runner, { field: 'runner', jobId: job.id }))

  const { sandbox } = job.execution
  if (sandbox.enabled) {
    // The image name is an element of docker's argument array: a leading dash
    // would make it an option, and would change the command started.
    if (sandbox.image.startsWith('-')) {
      errors.push('execution.sandbox.image: an image name cannot start with "-"')
    }
    if (/\s/.test(sandbox.image)) {
      errors.push('execution.sandbox.image: an image name contains no space')
    }
    if (usesAgent(runner) && !sandbox.mountWorkingDirectory) {
      // The agent's file tools work on the host side, in the working directory.
      // With no mount, what it writes and what its commands see would be two
      // different disks — a trap rather than an isolation.
      errors.push(
        'execution.sandbox.mountWorkingDirectory: an agent needs its working directory inside the container',
      )
    }
  }

  return errors
}

/** Does an agent run in there — directly, or at a workflow step? */
function usesAgent(runner) {
  if (runner.type === 'agent') return true
  if (runner.type !== 'workflow') return false
  return (runner.workflow?.steps ?? []).some((step) => step.runner?.type === 'agent')
}

/**
 * Checks specific to a runner.
 *
 * Takes the field as an argument rather than assuming it: the inline steps of a
 * workflow are runners like any other, and deserve the same checks under their
 * own name — "runner.workflow.steps.1.runner.script", not "runner.script", which
 * does not exist.
 */
function runnerErrors(runner, { field, jobId }) {
  const errors = []

  if (runner.type === 'bun-inline') {
    // The two fields would contradict each other: which one to run?
    if (runner.script !== undefined) {
      errors.push(`${field}.script: pointless for a bun-inline job, whose code lives in "code"`)
    }
    if (runner.code.trim() === '') {
      errors.push(`${field}.code: a bun-inline job must carry code`)
    }
  } else if (runner.type === 'agent') {
    // An agent job names neither a file nor code: it describes an intention.
    if (runner.script !== undefined) {
      errors.push(`${field}.script: pointless for an agent job, which carries a prompt and not a script`)
    }
    if (runner.code !== undefined) {
      errors.push(`${field}.code: belongs to the bun-inline type`)
    }
    errors.push(...agentErrors(runner.agent, `${field}.agent`))
  } else if (runner.type === 'workflow') {
    if (runner.script !== undefined) errors.push(`${field}.script: belongs to a script type`)
    if (runner.code !== undefined) errors.push(`${field}.code: belongs to the bun-inline type`)
    errors.push(...workflowErrors(runner.workflow, { field: `${field}.workflow`, jobId }))
  } else {
    if (runner.code !== undefined) {
      errors.push(`${field}.code: belongs to the bun-inline type`)
    }
    if (!path.isAbsolute(runner.script)) {
      errors.push(
        `${field}.script: the path must be absolute (got "${runner.script}"). ` +
          "Rota's current directory is not the one holding your scripts.",
      )
    }
  }

  if (runner.type !== 'agent' && runner.agent !== undefined) {
    errors.push(`${field}.agent: belongs to the agent type`)
  }
  if (runner.type !== 'workflow' && runner.workflow !== undefined) {
    errors.push(`${field}.workflow: belongs to the workflow type`)
  }

  if (runner.workingDirectory && !path.isAbsolute(runner.workingDirectory)) {
    errors.push(`${field}.workingDirectory: the path must be absolute`)
  }

  return errors
}

/**
 * Checks specific to a workflow.
 *
 * A step names a job **or** carries a runner. Both at once cannot be told apart,
 * and neither of them describes anything to do — in both cases the workflow
 * would run producing an empty step, which is noticed less than a refusal.
 */
function workflowErrors(workflow, { field, jobId }) {
  const errors = []

  workflow.steps.forEach((step, index) => {
    const at = `${field}.steps.${index}`
    const names = Boolean(step.job)
    const carries = Boolean(step.runner)

    if (names && carries) {
      errors.push(`${at}: a step names a job or carries a runner, not both`)
      return
    }
    if (!names && !carries) {
      errors.push(`${at}: a step names a job in "job", or carries one in "runner"`)
      return
    }

    if (names) {
      // Longer cycles are cut at execution time, where the other definitions are
      // known; this one is visible from here, and it is the most common.
      if (step.job === jobId) {
        errors.push(`${at}.job: a workflow cannot run itself`)
      }
      return
    }

    // A workflow inside a workflow would multiply nesting levels without adding
    // anything: a step that has to chain others names a workflow job, which
    // already carries its list.
    if (step.runner.type === 'workflow') {
      errors.push(`${at}.runner.type: a step cannot be a workflow — reference a workflow job instead`)
      return
    }
    errors.push(...runnerErrors(step.runner, { field: `${at}.runner`, jobId }))
  })

  return errors
}

/**
 * Checks specific to triggers.
 *
 * The fields of one type put on another are refused rather than ignored: an
 * interval left on a trigger switched to cron has no effect, and that is exactly
 * what takes half an hour to work out.
 */
function triggerErrors(job) {
  const errors = []
  const keywords = new Set()

  job.triggers.forEach((trigger, index) => {
    const field = `triggers.${index}`

    if (trigger.type === 'cron') {
      if (trigger.every !== undefined || trigger.unit !== undefined) {
        errors.push(`${field}: "every" and "unit" belong to the interval type`)
      }
      // A faulty expression must be refused here, not discovered when arming a
      // timer: the job would stay loaded without ever firing.
      const parsed = parseCron(trigger.expression)
      if (!parsed.ok) errors.push(`${field}.expression: ${parsed.error}`)
    } else if (trigger.expression !== undefined) {
      errors.push(`${field}.expression: belongs to the cron type`)
    }

    if (trigger.type !== 'interval' && (trigger.every !== undefined || trigger.unit !== undefined)) {
      errors.push(`${field}: "every" and "unit" belong to the interval type`)
    }
    if (trigger.type !== 'webhook' && trigger.token !== undefined) {
      errors.push(`${field}.token: belongs to the webhook type`)
    }
    if (trigger.type !== 'discord' && trigger.keyword !== undefined) {
      errors.push(`${field}.keyword: belongs to the discord type`)
    }

    if (trigger.type === 'webhook' && trigger.token !== undefined) {
      errors.push(...referenceErrors(trigger.token, `${field}.token`))
    }

    if (trigger.type === 'discord') {
      // A keyword doubling a command would never start: the bridge reads the
      // command first, and the silence that follows has no visible reason.
      if (RESERVED_KEYWORDS.has(trigger.keyword)) {
        errors.push(
          `${field}.keyword: "${trigger.keyword}" is a built-in Discord command, pick another word`,
        )
      }
      if (keywords.has(trigger.keyword)) {
        errors.push(`${field}.keyword: "${trigger.keyword}" is declared twice`)
      }
      keywords.add(trigger.keyword)
    }
  })

  return errors
}

/** Checks specific to the agent type. */
function agentErrors(agent, field) {
  const errors = []
  if (!agent) return errors

  if (agent.prompt.trim() === '') {
    errors.push(`${field}.prompt: an agent job must say what it expects`)
  }

  // A faulty URL would only show on the first call, that is, on the first
  // scheduled execution — often at night, often with no witness.
  let url
  try {
    url = new URL(agent.api.baseUrl)
  } catch {
    errors.push(`${field}.api.baseUrl: invalid URL (got "${agent.api.baseUrl}")`)
  }
  if (url && url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${field}.api.baseUrl: only http and https are accepted`)
  }

  for (const [name, value] of Object.entries(agent.api.headers)) {
    errors.push(...referenceErrors(value, `${field}.api.headers.${name}`))
  }

  // Denying a tool the job never enabled is not an error — it is how one writes
  // a definition that stays safe when the tool is switched on later. Denying
  // every tool it has is: the sub-agent would be born unable to do anything, and
  // the delegation would burn its turns finding that out.
  const enabled = new Set(agent.tools.enabled)
  const denied = new Set(agent.tools.subagents.deny)
  if (enabled.has('sub_agent') && [...enabled].every((name) => denied.has(name))) {
    errors.push(
      `${field}.tools.subagents.deny: a sub-agent would be left with no tool at all`,
    )
  }

  return errors
}

/** Malformed ${VARIABLE} references: they would never be resolved. */
function referenceErrors(value, field) {
  const errors = []
  for (const reference of value.matchAll(/\$\{([^}]*)\}/g)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference[1])) {
      errors.push(`${field}: "\${${reference[1]}}" is not a valid variable name`)
    }
  }
  return errors
}

/**
 * Validates a job definition.
 * @param {unknown} raw JSON content already parsed
 * @returns {{ok: true, job: object} | {ok: false, errors: string[]}}
 */
function validateJob(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['document root: a JSON object is expected'] }
  }

  const job = structuredClone(raw)
  if (!compiledJob(job)) {
    return { ok: false, errors: formatErrors(compiledJob.errors) }
  }

  const errors = semanticJobErrors(job)
  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, job }
}

/**
 * Validates the global configuration.
 * @returns {{ok: true, config: object} | {ok: false, errors: string[]}}
 */
function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['document root: a JSON object is expected'] }
  }

  const config = structuredClone(raw)
  if (!compiledConfig(config)) {
    return { ok: false, errors: formatErrors(compiledConfig.errors) }
  }

  const errors = semanticConfigErrors(config)
  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, config }
}

/**
 * A mistyped webhook would send the reports elsewhere with nothing to flag it:
 * nobody, at the other end, is there to answer that they received nothing. So
 * this is where it is decided, not on the first report.
 */
function semanticConfigErrors(config) {
  const errors = []
  const { discordControlEnabled, discordChatEnabled, discordBotToken, discordChannelId } =
    config.integrations

  // The flag alone opens nothing: saying so at once saves looking for why the
  // bot stays mute.
  if (discordControlEnabled && (!discordBotToken || !discordChannelId)) {
    errors.push(
      'integrations.discordControlEnabled: control requires a bot token and a channel identifier',
    )
  }
  // With no control, the bot listens to nothing: the `chat` command would never be read.
  if (discordChatEnabled && !discordControlEnabled) {
    errors.push('integrations.discordChatEnabled: chatting requires control to be enabled')
  }
  if (discordBotToken !== null) {
    errors.push(...referenceErrors(discordBotToken, 'integrations.discordBotToken'))
  }
  if (discordChannelId !== null && !/^\d{5,25}$/.test(discordChannelId)) {
    errors.push('integrations.discordChannelId: a Discord identifier is a run of digits')
  }

  errors.push(...httpErrors(config.http))

  const field = 'integrations.discordWebhookUrl'
  const webhookUrl = config.integrations.discordWebhookUrl
  if (webhookUrl === null) return errors

  errors.push(...referenceErrors(webhookUrl, field))
  // A URL entirely carried by a variable cannot be checked here: its value only
  // exists at run time.
  if (webhookUrl.startsWith('${')) return errors

  let url
  try {
    url = new URL(webhookUrl)
  } catch {
    errors.push(`${field}: invalid URL`)
    return errors
  }

  if (url.protocol !== 'https:') {
    errors.push(`${field}: https is required — a webhook URL is worth a password`)
  }
  if (!/(^|\.)(discord\.com|discordapp\.com)$/.test(url.hostname)) {
    errors.push(`${field}: the expected host is discord.com (got "${url.hostname}")`)
  }

  return errors
}

/**
 * Checks of the HTTP server.
 *
 * The token is not optional, loopback included. A port open with no password is
 * driveable from any local process — and from any web page open in a tab, which
 * can send it a request. That is not recoverable after the fact: we refuse to
 * open.
 */
function httpErrors(http) {
  const errors = []
  if (!http.enabled) return errors

  if (!http.token) {
    errors.push(
      'http.token: a token is required to start the server — an open port with no password is ' +
        'reachable by anything running on this machine',
    )
  } else {
    errors.push(...referenceErrors(http.token, 'http.token'))
  }

  return errors
}

const RUNNER_LABELS = {
  bun: 'Bun',
  'bun-inline': 'Bun, inline code',
}

/**
 * Readable label of a runner, for the interface.
 *
 * `interpreter` is only read for the type that uses it: the schema fills it in
 * with "sh" by default even where it makes no sense, and showing it as it is
 * would make a Bun job look like a shell script.
 */
function describeRunner(runner) {
  if (runner.type === 'agent') return `Agent · ${runner.agent.model}`
  if (runner.type === 'workflow') {
    const count = runner.workflow?.steps?.length ?? 0
    return `Workflow · ${count} step${count > 1 ? 's' : ''}`
  }
  return RUNNER_LABELS[runner.type] ?? runner.interpreter
}

/** Readable label of a trigger, for the interface and the tray menu. */
function describeTrigger(trigger) {
  // Translating a cron expression into English would take a full sentence
  // generator, for a result longer and less precise than the expression itself.
  // We show it as it is, naming it.
  if (trigger.type === 'cron') return `cron "${trigger.expression}"`
  if (trigger.type === 'webhook') return 'on webhook'
  if (trigger.type === 'discord') return `on “${trigger.keyword}”`
  if (trigger.type === 'power') return `on ${trigger.event}`

  const unit = UNIT_LABELS[trigger.unit] ?? trigger.unit
  // The singular drops the "s": "every minute", not "every 1 minutes".
  if (trigger.every === 1) return `every ${unit.replace(/s$/, '')}`
  return `every ${trigger.every} ${unit}`
}

/**
 * A job's triggers, on one line.
 *
 * A disabled trigger is shown struck out rather than hidden: making it vanish
 * outright would suggest a missed entry.
 */
function describeTriggers(triggers) {
  if (!triggers || triggers.length === 0) return 'on demand'
  return triggers
    .map((trigger) =>
      trigger.enabled === false ? `${describeTrigger(trigger)} (off)` : describeTrigger(trigger),
    )
    .join(' · ')
}

module.exports = {
  validateJob,
  validateConfig,
  describeTrigger,
  describeTriggers,
  describeRunner,
  RESERVED_KEYWORDS,
}
