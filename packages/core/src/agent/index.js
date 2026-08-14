'use strict'

// Tool loop of an agent job.
//
// The principle is simple and fits in ten lines: we send the messages to the
// model, if it asks for tools we run them and hand it back the results, and we
// start again until it answers asking for nothing. All the rest is setting the
// stage — perimeter, memory, execution environment — and care taken over what
// breaks.
//
// A session outlives a turn: that is what lets the chat console resume the
// conversation where it was, with the same container, the same memory and the
// same task list.

const { randomUUID } = require('node:crypto')

const { loadEnv } = require('../config/env')
const { createClient } = require('./client')
const { expandDefaults } = require('./defaults')
const { createDiscordSender } = require('../discord/send')
const { createEnvironment } = require('./environment')
const { MAX_TRIGGERS_PER_RUN } = require('./jobs')
const { runToolLoop, parseArguments } = require('./loop')
const { connectAll } = require('./mcp')
const memory = require('./memory')
const { buildSystemPrompt, expandWork } = require('./prompt')
const { settingsOf: subagentSettings, inheritedTools, taskMessage } = require('./subagent')
const { createTranscript } = require('./transcript')
const { selectTools, selectJobTools, toolDefinitions, byName } = require('./tools')
const { createTodoList } = require('./tools/todo')
const { resolveWorkspace, ensureWorkspace } = require('./workspace')

/**
 * Opens a session: perimeter, memory, tools, connection and execution
 * environment. Nothing is sent to the model before the first `runTurn`.
 *
 * @param {object} options
 * @param {object} options.job validated definition
 * @param {object} options.paths paths of the configuration directory
 * @param {string} options.executionId also identifies the container
 * @param {string} options.trigger
 * @param {object} options.ui { report, ask, confirm }
 * @param {string|null} [options.dockerPath]
 * @param {object} [options.integrations] shared destinations, global config
 * @param {boolean} [options.unattended] withdraws the tools that wait for an answer
 * @param {object} [options.jobs] job launcher, for the run_job tool
 * @param {{id: string, input: object}|null} [options.work] the queue item this
 *   execution was handed, reachable from the prompts as ${work.input}
 * @param {Array<{role: string, content: string}>} [options.history] previous
 *   turns of a resumed conversation, inserted after the instructions
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(event: object) => void} [options.onEvent]
 * @param {(line: string) => void} [options.onLine] transcript lines, as they
 *   come — used by `runAgent`, ignored here
 * @returns {Promise<{ok: true, session: object} | {ok: false, error: string}>}
 */
async function createSession({
  job,
  paths,
  executionId = randomUUID(),
  trigger = 'manual',
  ui,
  dockerPath = null,
  integrations = {},
  unattended = false,
  discord = null,
  jobs = null,
  work = null,
  workStore = null,
  getProfile = null,
  history = [],
  fetchImpl = fetch,
  onEvent = () => {},
}) {
  const agent = job.runner.agent

  let workspace
  try {
    workspace = ensureWorkspace(resolveWorkspace(job, paths))
  } catch (err) {
    return { ok: false, error: `unusable working directory: ${err.message}` }
  }

  const { tools, notices } = selectJobTools(job, { integrations, unattended })
  const toolsByName = byName(tools)
  const definitions = toolDefinitions(tools)

  // The agent's memory, which is the profile's when the job names one: two jobs
  // run by the same agent share what it has learnt rather than each finding it
  // out again.
  const memoryKey = memory.keyFor(job)
  const state = agent.memory.enabled ? await memory.load(paths.memoryDir, memoryKey) : memory.empty()
  // Global memory is read, not written from here: it comes from the settings or
  // the file, and holds for every job. A job that disabled its memory receives
  // no more of it — the setting says "no memory".
  const globalState = agent.memory.enabled ? await memory.loadGlobal(paths.memoryDir) : memory.empty()

  // A single read of the .env for the whole session: the client uses it for its
  // headers, the tools for what they have to resolve.
  const env = loadEnv(paths.envFile)

  const client = createClient({
    agent,
    env,
    fetchImpl,
    onNotice: (text) => {
      notices.push(text)
      onEvent({ type: 'notice', text })
    },
  })

  let currentSignal
  const created = await createEnvironment({
    job,
    executionId,
    workspace,
    dockerPath,
    getSignal: () => currentSignal,
  })
  if (!created.ok) return created
  const environment = created.environment

  // MCP connectors open once per session: their tools join Rota's, with no
  // distinction for the rest of the loop. With no signal: opening precedes the
  // first turn, and it is the connector's `timeoutSeconds` that bounds a
  // handshake that drags on.
  const mcp = await connectAll(agent.mcp, { env, workspace, fetchImpl })
  for (const notice of mcp.notices) {
    notices.push(notice)
    onEvent({ type: 'notice', text: notice })
  }
  for (const tool of mcp.tools) toolsByName.set(tool.name, tool)
  definitions.push(...toolDefinitions(mcp.tools))

  // What the instructions will name, resolved once. A profile that is listed but
  // missing from profiles/ is left out rather than announced: telling the model
  // about an agent it would be refused costs it a turn to find out.
  const delegableAgents = subagentSettings(agent.tools.subagents)
    .allow.map((id) => {
      const profile = getProfile?.(id) ?? null
      return profile ? `${profile.id} — ${profile.name}${profile.description ? `: ${profile.description}` : ''}` : null
    })
    .filter(Boolean)

  const changes = []
  const todo = createTodoList()
  // Rota's tools and the connectors', with no distinction — which is what a
  // sub-agent inherits.
  const available = [...toolsByName.values()]

  // Shared by the whole execution, sub-agents included: the ceilings are on the
  // totals, not on one turn and not on one agent.
  const triggers = { count: 0, max: MAX_TRIGGERS_PER_RUN }
  const subAgents = { count: 0 }

  const sharedContext = {
    job,
    executionId,
    workspace,
    config: agent.tools,
    memoryConfig: agent.memory,
    memory: state,
    globalMemory: globalState,
    ui,
    env,
    integrations,
    // Discord sending, shared with the control bridge. Mirroring reports is a
    // global setting, not a decision of the agent's.
    discord: discord ?? createDiscordSender({ integrations, env, fetchImpl }),
    mirrorReports: integrations.mirrorReportsToDiscord !== false,
    jobs,
    // The item being processed, for the tools that speak about it. A sub-agent
    // sees the same one: it is working on the caller's item, not its own.
    work,
    workStore,
    triggers,
    fetchImpl,
    runCommand: environment.runCommand,
    saveMemory: () =>
      memory.save(paths.memoryDir, memoryKey, state, { maxEntries: agent.memory.maxEntries }),
    signalChange: (message) => changes.push(message),
  }

  /**
   * The delegation budget as one agent sees it: the count is the execution's,
   * the depth is its own.
   */
  const budgetAt = (depth) => ({
    depth,
    get count() {
      return subAgents.count
    },
    set count(value) {
      subAgents.count = value
    },
  })

  /**
   * One agent's context: what the execution shares, plus what belongs to it —
   * its task list, how deep it is, and its right to delegate.
   *
   * The stop button is a getter and is installed *here*, after the spread: a
   * conversation chains several turns, each with its own, and spreading an
   * object that carried one would freeze it to whatever it was at that instant —
   * `undefined`, for the agent built before the first turn.
   */
  const contextAt = (depth, tools, borrowed = null) => ({
    ...sharedContext,
    get signal() {
      return currentSignal
    },
    // Its own: a sub-agent that saw the caller's task list would be doing its
    // work rather than the one it was given.
    todo: depth === 0 ? todo : createTodoList(),
    subAgents: budgetAt(depth),
    spawnSubAgent: (request) => spawn(request, { depth, tools }),
    // Last, because a sub-agent embodying a reusable agent works from that
    // agent's settings and memory rather than from this job's.
    ...(borrowed ?? {}),
  })

  const toolContext = contextAt(0, available)

  /**
   * Equips a sub-agent from a reusable agent instead of from its caller.
   *
   * What it takes from the profile is who it is — model, instructions, tools,
   * connectors, memory. What it keeps from here is where the work happens: the
   * working directory, the container, the stop button. It is still this job
   * doing this job's work; the profile only says who is doing it.
   *
   * The allowlist is the reason this cannot be a free choice. A sub-agent runs
   * inside the caller's execution, in its directory, and its results come back
   * into its conversation — so delegating to an agent that has `shell` would
   * hand `shell` to a job that never enabled it. Unlike `jobs.allow`, an empty
   * list therefore allows nothing rather than everything.
   *
   * @returns {Promise<{ok: true, …} | {ok: false, error: string}>}
   */
  async function embody(profileId, childDepth, settings) {
    if (settings.allow.length === 0) {
      return {
        ok: false,
        error:
          'this job may not delegate to a reusable agent — none is listed in tools.subagents.allow',
      }
    }
    if (!settings.allow.includes(profileId)) {
      return {
        ok: false,
        error:
          `"${profileId}" is not one of the agents this job may delegate to ` +
          `(${settings.allow.join(', ')})`,
      }
    }

    const profile = getProfile?.(profileId) ?? null
    if (!profile) return { ok: false, error: `no reusable agent named "${profileId}" in profiles/` }

    const say = (text) => {
      notices.push(`${profileId}: ${text}`)
      onEvent({ type: 'notice', text: `${profileId}: ${text}`, depth: childDepth })
    }

    const selected = selectTools(profile, {
      sandbox: job.execution.sandbox,
      integrations,
      unattended,
    })
    for (const notice of selected.notices) say(notice)

    // `deny` still applies to what the profile brings: it is the only say the
    // caller keeps over what it is inviting into its own execution.
    const denied = new Set(settings.deny)
    if (childDepth >= settings.maxDepth) denied.add('sub_agent')
    const tools = selected.tools.filter((tool) => !denied.has(tool.name))

    const profileState = profile.memory.enabled
      ? await memory.load(paths.memoryDir, profile.id)
      : memory.empty()

    // Opened for this delegation and closed after it — see the `finally` in
    // spawn(). A profile that declares connectors is not honoured by half.
    const profileMcp = await connectAll(profile.mcp, { env, workspace, fetchImpl })
    for (const notice of profileMcp.notices) say(notice)

    return {
      ok: true,
      profile,
      tools: [...tools, ...profileMcp.tools],
      state: profileState,
      close: profileMcp.close,
      client: createClient({ agent: profile, env, fetchImpl, onNotice: say }),
      // What replaces the caller's in the sub-agent's tool context. The tool
      // settings become the profile's — its fetch allowlist, its jobs.allow —
      // save for the delegation budget, which stays the caller's: the ceilings
      // protect the machine, not the agent.
      context: {
        config: { ...profile.tools, subagents: agent.tools.subagents },
        memoryConfig: profile.memory,
        memory: profileState,
        saveMemory: () =>
          memory.save(paths.memoryDir, profile.id, profileState, {
            maxEntries: profile.memory.maxEntries,
          }),
      },
    }
  }

  /**
   * Runs a sub-agent to its conclusion and returns what it concluded.
   *
   * By default: same client, same tools less what `deny` withdraws, same
   * everything the caller shares — see ./subagent.js. Named a profile, it is
   * that agent that answers instead, equipped by `embody` above.
   *
   * Its events go out on the caller's stream, one level deeper, which is what
   * puts its turns into the transcript indented under the call.
   */
  async function spawn({ task, context, profileId = null }, { depth, tools: inherited }) {
    const settings = subagentSettings(agent.tools.subagents)
    const childDepth = depth + 1

    const borrowed = profileId ? await embody(profileId, childDepth, settings) : null
    if (borrowed && !borrowed.ok) return { ok: false, error: borrowed.error, iterations: 0 }

    const childAgent = borrowed ? borrowed.profile : agent
    const childTools = borrowed ? borrowed.tools : inheritedTools(inherited, childDepth, settings)
    const childByName = byName(childTools)

    try {
      return await runToolLoop({
        client: borrowed ? borrowed.client : client,
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              job,
              agent: childAgent,
              memory: borrowed ? borrowed.state : state,
              globalMemory: globalState,
              trigger,
              sandboxed: environment.sandboxed,
              toolNames: [...childByName.keys()],
              subAgent: true,
              work,
              delegableAgents,
            }),
          },
          { role: 'user', content: taskMessage({ task, context }) },
        ],
        definitions: toolDefinitions(childTools),
        toolsByName: childByName,
        context: contextAt(childDepth, childTools, borrowed?.context),
        // The profile's own turn budget when it is one answering: an agent that
        // says fifteen turns knows better than the caller what its work costs.
        maxIterations: settings.maxIterations ?? childAgent.maxIterations,
        signal: currentSignal,
        // One level deeper on the caller's stream: that is what puts its turns
        // into the transcript, indented under the call that started it.
        onEvent: (event) => onEvent({ ...event, depth: (event.depth ?? 0) + 1 }),
      })
    } finally {
      // Whatever the outcome, cancellation and timeout included: a connector
      // left open would outlive the execution that asked for it.
      await borrowed?.close?.()
    }
  }

  // The instructions first, then what had been said if the conversation resumes.
  // They are recomputed rather than re-read from the file: the memory, the
  // trigger and the tools offered may have changed since, and it is they that
  // describe the current execution — not the one three weeks ago.
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        job,
        memory: state,
        globalMemory: globalState,
        trigger,
        sandboxed: environment.sandboxed,
        toolNames: [...toolsByName.keys()],
        work,
        delegableAgents,
      }),
    },
    ...history.filter(
      (message) => typeof message?.content === 'string' && message.content.trim() !== '',
    ),
  ]

  /**
   * One turn of conversation: the user's message, then as many round trips with
   * the model as it asks for tools.
   *
   * @returns {Promise<{ok: boolean, content?: string, iterations: number,
   *   error?: string, aborted?: boolean}>}
   */
  async function runTurn({ content, signal, stream = false, onDelta = () => {} }) {
    currentSignal = signal
    // The reference to the default instructions holds in a job prompt or a
    // console message too: wherever one writes it, one wants it.
    if (content != null) messages.push({ role: 'user', content: expandDefaults(content) })

    return runToolLoop({
      client,
      messages,
      definitions,
      toolsByName,
      context: toolContext,
      maxIterations: agent.maxIterations,
      signal,
      stream,
      onDelta,
      onEvent,
    })
  }

  return {
    ok: true,
    session: {
      job,
      executionId,
      workspace,
      messages,
      notices,
      changes,
      todo,
      memory: state,
      toolNames: [...toolsByName.keys()],
      sandboxed: environment.sandboxed,
      environment: environment.describe(),
      model: agent.model,
      baseUrl: agent.api.baseUrl,
      runTurn,
      dispose: async () => {
        await mcp.close()
        await environment.dispose()
      },
    },
  }
}

/**
 * A full execution: opens a session, plays the job's prompt, and returns what
 * is needed to build a history entry.
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string,
 *   change: string|null, iterations: number, error: string|null, aborted: boolean}>}
 */
async function runAgent(options) {
  const transcript = createTranscript({ onLine: options.onLine })
  const { job } = options

  const opened = await createSession({
    ...options,
    onEvent: (event) => {
      // A sub-agent's events arrive on this same stream, carrying how many
      // agents down they were produced.
      const depth = event.depth ?? 0
      if (event.type === 'turn') transcript.turn(event.iteration, depth)
      else if (event.type === 'notice') transcript.notice(event.text, depth)
      else if (event.type === 'assistant') {
        transcript.reasoning(event.reasoning, depth)
        if (event.toolCalls.length === 0) transcript.assistant(event.content, depth)
      } else if (event.type === 'tool-call') transcript.toolCall(event.name, event.args, depth)
      else if (event.type === 'tool-result') transcript.toolResult(event, depth)
      options.onEvent?.(event)
    },
  })

  if (!opened.ok) {
    return {
      ok: false,
      stdout: transcript.text(),
      stderr: `${opened.error}\n`,
      change: null,
      iterations: 0,
      error: opened.error,
      aborted: false,
    }
  }

  const { session } = opened
  transcript.header({
    job,
    model: session.model,
    baseUrl: session.baseUrl,
    environment: session.environment,
    toolNames: session.toolNames,
    notices: session.notices,
  })

  try {
    const result = await session.runTurn({
      // The item is put into the request itself, where the job asked for it.
      // The prompt is what the model is being told to do, and a run that came
      // off a queue is being told to do it to one particular thing.
      content: expandWork(job.runner.agent.prompt, options.work ?? null),
      signal: options.signal,
    })

    transcript.final(result.ok ? result.content : (result.error ?? ''))

    return {
      ok: result.ok,
      stdout: transcript.text(),
      stderr: result.ok ? '' : `${result.error}\n`,
      // The last report wins, as with the scripts' marker.
      change: session.changes.at(-1) ?? null,
      iterations: result.iterations,
      error: result.ok ? null : result.error,
      aborted: result.aborted === true,
    }
  } finally {
    await session.dispose()
  }
}

module.exports = { createSession, runAgent, parseArguments }
