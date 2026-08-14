'use strict'

// Resolving the configuration directory and creating the local structure.
// This module does not depend on Electron: it is directly testable under node:test.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { writeJsonAtomic } = require('../lib/json-file')

// What the project was called before it was called Rota. Read, never written.
const LEGACY_DIRNAME = 'ticktray'

const DEFAULT_CONFIG = {
  schedulerPaused: false,
  launchAtLogin: true,
  theme: 'system',
  // Embedded is the default, and the whole desktop install: one thing to start,
  // one thing to quit. Remote is a mode, not the architecture.
  engine: {
    mode: 'embedded',
    url: null,
    token: null,
  },
  runners: {
    // null = automatic resolution (PATH, ~/.bun/bin, /opt/homebrew/bin)
    bunPath: null,
  },
  integrations: {
    discordWebhookUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordControlEnabled: false,
    mirrorReportsToDiscord: true,
  },
  http: {
    enabled: false,
    listen: '127.0.0.1',
    port: 47823,
    // With no token, the server does not start — validation refuses it.
    token: null,
    apiEnabled: false,
    webhookEnabled: false,
  },
  defaults: {
    maxOutputBytes: 1048576,
    inlineOutputBytes: 8192,
    retainExecutions: 500,
  },
}

const DEFAULT_STATE = {
  lastRuns: {},
  acknowledgedErrorsAt: null,
}

/**
 * Configuration directory, the same on every system.
 *
 * macOS reserves "Library/Application Support" for data the user is not meant
 * to open. Here it is the opposite: JSON files and scripts one edits by hand,
 * tracks in a repository, opens from a terminal. They therefore live where the
 * other configurations live.
 *
 * ROTA_CONFIG_DIR overrides it (tests, development instance). TICKTRAY_CONFIG_DIR
 * is still read, one name behind, for the same reason as the directory below.
 *
 * **The project used to be called TickTray**, and an installation that predates
 * the rename keeps its files in `<config>/ticktray`. Nothing is moved: if the
 * new directory does not exist and the old one does, the old one is what we
 * open, and startup says so. A scheduler that silently relocated somebody's
 * jobs, history and secrets to prove a point about its own name would be
 * choosing the wrong thing to care about — and `mv` is one command, taken when
 * the owner feels like it rather than when we do.
 */
function resolveConfigDir({ env = process.env, homedir = os.homedir(), fileSystem = fs } = {}) {
  const named = env.ROTA_CONFIG_DIR || env.TICKTRAY_CONFIG_DIR
  if (named) return path.resolve(named)

  const xdg = env.XDG_CONFIG_HOME
  const base = xdg ? path.resolve(xdg) : path.join(homedir, '.config')

  const current = path.join(base, 'rota')
  const legacy = path.join(base, LEGACY_DIRNAME)
  if (!fileSystem.existsSync(current) && fileSystem.existsSync(legacy)) return legacy
  return current
}

/** Whether this directory is one the rename left behind, for whoever says so. */
function isLegacyConfigDir(configDir) {
  return path.basename(configDir) === LEGACY_DIRNAME
}

/** All the paths derived from the root directory. */
function resolvePaths(configDir = resolveConfigDir()) {
  return {
    root: configDir,
    configFile: path.join(configDir, 'config.json'),
    stateFile: path.join(configDir, 'state.json'),
    // Secrets referenced by ${VARIABLE} in job definitions. Never created
    // automatically: an empty file would invite writing into it without knowing
    // it is protected by the directory's permissions alone.
    envFile: path.join(configDir, '.env'),
    jobsDir: path.join(configDir, 'jobs'),
    // Reusable agents: profiles/<id>.json. Who does the work, as opposed to
    // jobs/, which says what is run. Deliberately not agents/, which already
    // holds one working directory per agent job.
    profilesDir: path.join(configDir, 'profiles'),
    // Conventional home for scripts, outside the project's repository: that is
    // where the job templates point.
    scriptsDir: path.join(configDir, 'scripts'),
    // Files produced from the inline code of jobs. Derived content: nothing
    // irreplaceable lives there, everything is rewritten from jobs/.
    inlineDir: path.join(configDir, 'inline'),
    // Default working directory of an agent job, and perimeter of its file
    // tools. One subdirectory per job, created on first launch.
    agentsDir: path.join(configDir, 'agents'),
    // Persistent memory of the agents: memory/<id>.mem.json, plus
    // memory/global.json for what holds for every job.
    memoryDir: path.join(configDir, 'memory'),
    // Conversations, one file per thread: conversations/<id>/<conversation>.json.
    conversationsDir: path.join(configDir, 'conversations'),
    // The work queues: work/<job>/<item>.json, one file per item. Unlike the
    // history, this is not a record of what happened — it is what has not
    // happened yet, and losing it loses work.
    workDir: path.join(configDir, 'work'),
    historyDir: path.join(configDir, 'history'),
    outputsDir: path.join(configDir, 'history', 'outputs'),
    logsDir: path.join(configDir, 'logs'),
  }
}

/**
 * Creates the missing tree and the default files.
 * Idempotent: never overwrites an existing config.json or state.json.
 */
async function ensureStructure(paths = resolvePaths()) {
  for (const dir of [
    paths.root,
    paths.jobsDir,
    paths.profilesDir,
    paths.scriptsDir,
    paths.inlineDir,
    paths.agentsDir,
    paths.memoryDir,
    paths.conversationsDir,
    paths.workDir,
    paths.historyDir,
    paths.outputsDir,
    paths.logsDir,
  ]) {
    await fsp.mkdir(dir, { recursive: true })
  }

  const created = { config: false, state: false }

  // We never overwrite an existing file, even a corrupted one: it is user content.
  if (!(await exists(paths.configFile))) {
    await writeJsonAtomic(paths.configFile, DEFAULT_CONFIG)
    created.config = true
  }
  if (!(await exists(paths.stateFile))) {
    await writeJsonAtomic(paths.stateFile, DEFAULT_STATE)
    created.state = true
  }

  return created
}

async function exists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  LEGACY_DIRNAME,
  isLegacyConfigDir,
  resolveConfigDir,
  resolvePaths,
  ensureStructure,
  exists,
}
