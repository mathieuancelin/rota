'use strict'

// Conversations with a job's agent.
//
// A conversation is not an execution of the job: it produces no history entry,
// notifies nothing, touches neither the scheduler nor the dashboard, and does
// not count towards `allowConcurrentRuns`. It has its own registry and its own
// stop button.
//
// What it shares with the job, on the other hand: the system prompt, the model,
// the tools, the working directory, the sandbox — and the memory. What you teach
// the agent in conversation, it finds again on its next scheduled execution.
// That is the main point of the thing.
//
// The agent session is only opened on the first message: showing the tab must
// not start a container that may never serve.
//
// The trail is kept as events — in memory as long as the conversation is open,
// and in a file so that it survives the application closing. That is what lets
// the view rebuild itself identically: it replays exactly the events received
// live, so there is no second rendering path to keep in step with the first.
//
// A job has as many conversations as one likes, listed in the tab. They share
// the job's working directory and memory — it is indeed the same agent — but not
// their thread: two subjects run in the same context get in each other's way,
// and nothing forces starting over to change subject.

const { randomUUID } = require('node:crypto')

const logger = require('../lib/logger')
const conversations = require('./conversations')
const { createSession } = require('./index')

const MAX_EVENTS = conversations.MAX_EVENTS

// Writing follows the events with a delay: one turn produces dozens a second,
// and rewriting the file on each would bring nothing but a busy disk. What
// matters is that nothing is lost on closing, which `flush` takes care of.
const SAVE_DELAY_MS = 400

/**
 * @param {object} deps
 * @param {import('../config/store').ConfigStore} deps.store
 * @param {import('../runner').Runner} deps.runner
 * @param {object} deps.ui windows handed to the agent's tools
 * @param {(event: object) => void} deps.send pushes an event to the interface
 * @param {object} [deps.discord]
 */
function createChatSessions({ store, runner, ui, send, discord = null }) {
  /** @type {Map<string, object>} open conversations, indexed by identifier */
  const chats = new Map()

  const dir = () => store.paths.conversationsDir

  // Conversations from an origin other than the interface are found by job: a
  // Discord channel has no sidebar to pick a thread from, it resumes the one it
  // had. Two people writing in the same context get in each other's way, and
  // above all a conversation coming from a channel has nobody in front of the
  // screen — it does not have the same tools.
  const findOpen = (jobId, origin) =>
    [...chats.values()].find((chat) => chat.jobId === jobId && chat.origin === origin)

  function track(chat) {
    chats.set(chat.chatId, chat)
    return chat
  }

  /** A fresh conversation, not registered: the caller is the one that keeps it. */
  function newConversation(jobId, origin, overrides = {}) {
    const at = new Date().toISOString()
    return {
      chatId: randomUUID(),
      jobId,
      origin,
      session: null,
      busy: false,
      controller: null,
      events: [],
      createdAt: at,
      updatedAt: at,
      // True for a conversation re-read from a file: its trail rebuilds the view,
      // and the model's context on the first message.
      restored: false,
      saveTimer: null,
      ...overrides,
    }
  }

  /** Writes the conversation, at most once per window. */
  function scheduleSave(chat) {
    if (chat.saveTimer) return
    chat.saveTimer = setTimeout(() => {
      chat.saveTimer = null
      flush(chat)
    }, SAVE_DELAY_MS)
    chat.saveTimer.unref?.()
  }

  function flush(chat) {
    if (chat.saveTimer) {
      clearTimeout(chat.saveTimer)
      chat.saveTimer = null
    }
    // A conversation without a single message has nothing to record: opening the
    // tab must not scatter empty files.
    if (chat.events.length === 0) return Promise.resolve()
    return conversations
      .save(dir(), chat)
      .catch((err) => logger.warn(`saving the conversation with ${chat.jobId}: ${err.message}`))
  }

  function emit(chat, event) {
    // The stream emits one delta per chunk received — roughly one per token.
    // Kept as they come, a single slightly long answer fills the buffer, and
    // eviction carries off the start of the conversation: on reload only the
    // last turn is left. So they are merged back into one, which the view
    // rebuilds identically — it concatenates them anyway.
    //
    // The interface, for its part, keeps receiving every chunk: watching the
    // answer compose itself is the whole point of streaming.
    const last = chat.events.at(-1)
    if (event.type === 'delta' && last?.type === 'delta') {
      if (event.content) last.content = (last.content ?? '') + event.content
      if (event.reasoning) last.reasoning = (last.reasoning ?? '') + event.reasoning
    } else {
      chat.events.push(event)
      if (chat.events.length > MAX_EVENTS) chat.events.splice(0, chat.events.length - MAX_EVENTS)
    }
    chat.updatedAt = new Date().toISOString()
    scheduleSave(chat)
    send({ chatId: chat.chatId, ...event })
  }

  /** Does the job exist, and does it know how to chat? */
  function chattable(jobId) {
    const job = store.getJob(jobId)
    if (!job) return { ok: false, errors: [`Unknown job: ${jobId}`] }
    if (job.runner.type !== 'agent') {
      return { ok: false, errors: ['Only agent jobs can be chatted with.'] }
    }
    return { ok: true, job }
  }

  function describe(job, chat) {
    return {
      ok: true,
      chatId: chat.chatId,
      jobName: job.name,
      model: job.runner.agent.model,
      baseUrl: job.runner.agent.api.baseUrl,
      sandboxed: job.execution.sandbox.enabled,
      title: conversations.titleOf(chat.events, chat.title),
      named: Boolean(chat.title),
      // The input field starts from the job's prompt: that is how one works it
      // out before leaving it to run on its own.
      prompt: job.runner.agent.prompt,
      // Two agents on the same working directory is for the user to decide; the
      // view says so, it does not prevent it.
      running: runner.isRunning(job.id),
      busy: chat.busy,
      events: chat.events,
    }
  }

  /** A job's conversations, the most recent first. */
  async function list(jobId) {
    const found = chattable(jobId)
    if (!found.ok) return found

    const stored = await conversations.list(dir(), jobId)
    const known = new Set(stored.map((conversation) => conversation.chatId))
    // A conversation that is open but still has no message has no file: it must
    // nevertheless appear in the list, otherwise the one just created vanishes
    // until the first message is written.
    const fresh = [...chats.values()]
      .filter((chat) => chat.jobId === jobId && !known.has(chat.chatId))
      .map((chat) => conversations.summarize(chat))

    return { ok: true, conversations: [...fresh, ...stored] }
  }

  /** Opens a fresh conversation. */
  function create(jobId, origin = 'ui') {
    const found = chattable(jobId)
    if (!found.ok) return found

    const chat = track(newConversation(jobId, origin))
    logger.info(`conversation with ${jobId} opened (${origin})`)
    return describe(found.job, chat)
  }

  /**
   * Opens a conversation by its identifier, re-reading it if needed.
   *
   * The accumulated trail comes back with it: leaving the tab does not end the
   * conversation, and coming back to it — even after a restart — finds it as it
   * was left.
   */
  async function openConversation(jobId, chatId) {
    const found = chattable(jobId)
    if (!found.ok) return found

    const live = chats.get(chatId)
    if (live) return describe(found.job, live)

    const stored = await conversations.load(dir(), jobId, chatId)
    if (!stored) return { ok: false, errors: ['Unknown conversation.'] }

    const chat = track(
      newConversation(jobId, stored.origin, {
        chatId: stored.chatId,
        events: stored.events,
        title: stored.title,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        restored: true,
      }),
    )

    return describe(found.job, chat)
  }

  /**
   * A job's conversation for an origin with no sidebar — a Discord channel, an
   * API call. It resumes its own, or opens one.
   */
  async function open(jobId, origin = 'ui') {
    const found = chattable(jobId)
    if (!found.ok) return found

    const live = findOpen(jobId, origin)
    if (live) return describe(found.job, live)

    // The last of that origin: resuming the thread beats starting over on every
    // restart, for whoever has no way of choosing one.
    const stored = await conversations.list(dir(), jobId)
    const last = stored.find((conversation) => conversation.origin === origin)
    if (last) return openConversation(jobId, last.chatId)

    return create(jobId, origin)
  }

  /**
   * Renames a conversation, or gives it back its derived title.
   *
   * An empty name is not an error but a way back: the title returns to the first
   * message, which is what one wants after a rename one regrets.
   */
  async function rename(jobId, chatId, title) {
    const found = chattable(jobId)
    if (!found.ok) return found

    const chosen = typeof title === 'string' && title.trim() !== '' ? title.trim() : null

    const live = chats.get(chatId)
    if (live) {
      live.title = chosen
      live.updatedAt = new Date().toISOString()
      await flush(live)
      // A conversation with no message yet has no file: the title leaves with it
      // on the first send, and there is nothing to write until then.
      return { ok: true, title: conversations.titleOf(live.events, live.title) }
    }

    const stored = await conversations.load(dir(), jobId, chatId)
    if (!stored) return { ok: false, errors: ['Unknown conversation.'] }
    stored.title = chosen
    stored.updatedAt = new Date().toISOString()
    await conversations.save(dir(), stored)
    return { ok: true, title: conversations.titleOf(stored.events, stored.title) }
  }

  /** Deletes a conversation: its thread, and its file. */
  async function remove(jobId, chatId) {
    const chat = chats.get(chatId)
    if (chat) close(chatId)
    await conversations.remove(dir(), jobId, chatId)
    logger.info(`conversation ${chatId} of ${jobId} deleted`)
    return { ok: true }
  }

  async function post(chatId, content) {
    const chat = chats.get(chatId)
    if (!chat) return { ok: false, error: 'unknown conversation, or already closed' }
    if (chat.busy) return { ok: false, error: 'a turn is already running' }

    const job = store.getJob(chat.jobId)
    if (!job) return { ok: false, error: 'the job is gone' }

    if (!chat.session) {
      const opened = await createSession({
        job,
        paths: store.paths,
        executionId: chat.chatId,
        trigger: 'chat',
        ui,
        dockerPath: store.getConfig().runners.dockerPath,
        integrations: store.getConfig().integrations,
        // From a channel, nobody is in front of the screen: tools that wait for an
        // answer are not offered, rather than costing two minutes a question on a
        // turn somebody is actually waiting for.
        unattended: chat.origin !== 'ui',
        discord,
        jobs: runner.jobs,
        // A conversation re-read from a file resumes with what was said in it:
        // your messages and its answers, without the tool traffic. Without that it
        // would look continuous on screen while starting from scratch for the
        // model — the worst of the two situations.
        history: chat.restored ? conversations.toMessages(chat.events) : [],
        onEvent: (event) => emit(chat, event),
      })
      if (!opened.ok) return { ok: false, error: opened.error }
      chat.session = opened.session
      chat.restored = false
    }

    chat.busy = true
    chat.controller = new AbortController()
    emit(chat, { type: 'turn-start', content })

    let result
    try {
      result = await chat.session.runTurn({
        content,
        signal: chat.controller.signal,
        stream: true,
        onDelta: (delta) => emit(chat, { type: 'delta', ...delta }),
      })
    } catch (err) {
      logger.error(`conversation with ${chat.jobId} failed`, err)
      result = { ok: false, error: `internal failure: ${err.message}` }
    } finally {
      chat.busy = false
      chat.controller = null
    }

    emit(chat, { type: 'turn-end', ok: result.ok, error: result.error ?? null })
    // `ok` says the message was accepted, not that the turn succeeded: that is
    // what the interface reads. The turn's fate goes with it, for whoever does
    // not listen to the events — the Discord bridge, which has one answer to write.
    return { ok: true, turn: { ok: result.ok, content: result.content ?? null, error: result.error ?? null } }
  }

  function stop(chatId) {
    const chat = chats.get(chatId)
    if (!chat?.controller) return { ok: false, error: 'no turn running' }
    chat.controller.abort()
    return { ok: true }
  }

  /**
   * Ends a conversation: interrupts the running turn and closes the container.
   * Leaving the tab does not do that — only the application closing, the job
   * disappearing, or an explicit request.
   */
  function close(chatId) {
    const chat = chats.get(chatId)
    if (!chat) return { ok: false, error: 'unknown conversation' }
    chats.delete(chatId)
    chat.controller?.abort()
    // Written before letting go: what has just been said must not be lost
    // because the write delay had not yet expired.
    flush(chat)
    chat.session?.dispose().catch((err) => logger.warn(`cleaning up the conversation: ${err.message}`))
    logger.info(`conversation with ${chat.jobId} closed`)
    return { ok: true }
  }

  /** Closes a job's conversation, if it has one. */
  function closeFor(jobId) {
    // Every origin: the job has changed under both.
    for (const chat of [...chats.values()]) {
      if (chat.jobId === jobId) close(chat.chatId)
    }
  }

  /**
   * Closes the conversations of jobs that no longer exist, and removes their
   * files — as the history and the memory already do on their side.
   */
  async function prune(existingJobIds) {
    const keep = new Set(existingJobIds)
    for (const chat of [...chats.values()]) {
      if (!keep.has(chat.jobId)) close(chat.chatId)
    }
    await conversations.prune(dir(), existingJobIds)
  }

  function closeAll() {
    for (const chatId of [...chats.keys()]) close(chatId)
  }

  return {
    list,
    create,
    open,
    openConversation,
    rename,
    remove,
    post,
    stop,
    close,
    closeFor,
    prune,
    closeAll,
  }
}

module.exports = { createChatSessions, MAX_EVENTS, SAVE_DELAY_MS }
