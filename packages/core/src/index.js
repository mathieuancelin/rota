'use strict'

// The public surface of the engine.
//
// What is named here is what an application, a daemon or a command line may
// rely on; everything else under src/ is ours to move without warning. The
// indirection is the point: a path we let a consumer reach into is a path we
// owe them forever, and this file is the one place where that debt is visible.
//
// Nothing here knows about Electron, or about any screen at all. The pieces
// that do live in the application package, and there is exactly one of them —
// the power adapter, which translates `powerMonitor` into two calls the
// scheduler already exposes on its own.

// `agent/index` names its factory `createSession`, which says too little once it
// has left the directory it was named in; it is re-exported as
// `createAgentSession` below.
const agent = require('./agent')
const agentMemory = require('./agent/memory')
const cron = require('./lib/cron')
const historyOutputs = require('./history/outputs')
const logger = require('./lib/logger')

const { acquireInstanceLock, InstanceLockError, isProcessAlive } = require('./instance-lock')
const { ConfigStore } = require('./config/store')
const { createChatSessions } = require('./agent/chat')
const { createEngine } = require('./engine')
const { createUnavailableUi } = require('./agent/ui')
const { watchConfig } = require('./config/watcher')
const { createDiscordControl } = require('./discord')
const { createHttpServer, MAX_BODY_BYTES } = require('./http')
const { createJobLauncher } = require('./agent/jobs')
const { generateToken, presentedToken, tokenMatches } = require('./http/auth')
const { HistoryStore } = require('./history/store')
const { inlineScriptPath, pruneInlineScripts } = require('./runner/inline')
const { isSessionLocked } = require('./lib/session-lock')
const { listTemplates, buildFromTemplate } = require('./config/templates')
const { loadEnv, resolveReferences } = require('./config/env')
const { migrateJob, migrateJobsDir } = require('./config/migrate')
const { extractProfile } = require('./config/extract-profile')
const { readLastLines, countLines } = require('./history/tail')
const { Runner, STATUS, ENV_ALLOWLIST, describeFailure } = require('./runner')
const { Scheduler } = require('./scheduler')
const { StateStore } = require('./state-store')
const { buildSnapshot } = require('./snapshot')
const { jobForKeyword, triggersOfType, webhookTrigger } = require('./config/triggers')
const { nextRunAt, missedOccurrences } = require('./scheduler/next-run')
const {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  ensureStructure,
  resolveConfigDir,
  resolvePaths,
} = require('./config/paths')
const {
  describeRunner,
  describeTrigger,
  describeTriggers,
  validateConfig,
  validateJob,
  validateProfile,
} = require('./config/validate')

module.exports = {
  // The whole engine in one call — what a shell builds, and the reason two
  // shells cannot drift apart.
  createEngine,

  // Where everything is, and what an empty installation looks like.
  resolveConfigDir,
  resolvePaths,
  ensureStructure,
  DEFAULT_CONFIG,
  DEFAULT_STATE,

  // Reading and writing the configuration, and keeping up with it changing
  // under us — a job file is a document a user edits in their own editor.
  ConfigStore,
  watchConfig,
  migrateJob,
  migrateJobsDir,
  extractProfile,
  validateJob,
  validateProfile,
  validateConfig,
  describeTrigger,
  describeTriggers,
  describeRunner,
  listTemplates,
  buildFromTemplate,
  loadEnv,
  resolveReferences,
  triggersOfType,
  webhookTrigger,
  jobForKeyword,

  // Deciding when, and doing it.
  Scheduler,
  nextRunAt,
  missedOccurrences,
  cron,
  Runner,
  STATUS,
  ENV_ALLOWLIST,
  describeFailure,
  inlineScriptPath,
  pruneInlineScripts,

  // What happened, and what is true right now.
  HistoryStore,
  historyOutputs,
  readLastLines,
  countLines,
  StateStore,
  buildSnapshot,

  // Agents: a job that is told what to achieve rather than what to run.
  createAgentSession: agent.createSession,
  runAgent: agent.runAgent,
  createChatSessions,
  createJobLauncher,
  agentMemory,
  // What an agent gets when nobody is attached: refusals, not exceptions.
  createUnavailableUi,

  // The two ways in from outside the machine, both closed by default.
  createHttpServer,
  MAX_BODY_BYTES,
  generateToken,
  tokenMatches,
  presentedToken,
  createDiscordControl,

  // One engine per configuration directory — taken by the daemon and by the
  // application alike, because both embed the same scheduler.
  acquireInstanceLock,
  InstanceLockError,
  isProcessAlive,

  // Platform facts the engine needs and cannot ask a window for.
  isSessionLocked,
  logger,
}
