'use strict'

// Persisted conversations: one file per thread.
//
// Two things are at stake here. The first is that a conversation survives the
// application closing — until now it was volatile memory, and quitting Rota
// erased what had taken an hour to work out.
//
// The second is subtler: what comes back to the model when it resumes. The
// trail serves to rebuild the view, but it abbreviates the tool calls — that is
// deliberate, it is made to be read. The context returned to the model is
// therefore the conversation itself, your messages and its answers, and nothing
// more. A conversation that looked continuous on screen while starting from
// scratch for the model would be the worst of the two situations.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const conversations = require('../src/agent/conversations')
const { createChatSessions } = require('../src/agent/chat')

async function freshDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-conv-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

const conversation = (chatId, jobId, events, at = '2026-08-05T10:00:00.000Z') => ({
  chatId,
  jobId,
  origin: 'ui',
  createdAt: at,
  updatedAt: at,
  events,
})

const exchange = (question, answer) => [
  { type: 'turn-start', content: question },
  { type: 'turn', iteration: 1 },
  { type: 'delta', content: answer },
  { type: 'turn-end', ok: true, error: null },
]

// --- the file -----------------------------------------------------------------

test('a conversation reads back as it was written', async (t) => {
  const dir = await freshDir(t)
  const written = conversation('c-1', 'veille', exchange('bonjour', 'salut'))

  await conversations.save(dir, written)
  const relue = await conversations.load(dir, 'veille', 'c-1')

  assert.deepEqual(relue.events, written.events)
  assert.equal(relue.origin, 'ui')
})

test('a missing conversation returns null, not an error', async (t) => {
  const dir = await freshDir(t)

  assert.equal(await conversations.load(dir, 'veille', 'jamais-vue'), null)
})

// One does not name a conversation before having had it: the title comes from
// the first message, and beats an identifier in a list.
test('the title is the first message, reduced to one line', () => {
  assert.equal(conversations.titleOf(exchange('Anything new?', 'nothing')), 'Anything new?')
  assert.equal(conversations.titleOf([]), 'New conversation')
  assert.equal(
    conversations.titleOf([{ type: 'turn-start', content: 'two\nlines  and   some spaces' }]),
    'two lines and some spaces',
  )
  assert.ok(conversations.titleOf([{ type: 'turn-start', content: 'x'.repeat(200) }]).endsWith('…'))
})

test('the list starts from the most recent', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, conversation('c-1', 'veille', exchange('vieille', 'a'), '2026-08-01T10:00:00.000Z'))
  await conversations.save(dir, conversation('c-2', 'veille', exchange('recent', 'b'), '2026-08-05T10:00:00.000Z'))

  const list = await conversations.list(dir, 'veille')

  assert.deepEqual(
    list.map((entry) => entry.title),
    ['recent', 'vieille'],
  )
  assert.equal(list[0].turns, 1)
})

// Losing one conversation is annoying enough without losing the others too.
test('an unreadable file is ignored, not propagated', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, conversation('c-1', 'veille', exchange('bonjour', 'salut')))
  await fs.writeFile(path.join(dir, 'veille', 'casse.json'), '{ pas du json')

  const list = await conversations.list(dir, 'veille')

  assert.equal(list.length, 1)
})

test('a job with no conversation returns an empty list', async (t) => {
  const dir = await freshDir(t)

  assert.deepEqual(await conversations.list(dir, 'jamais-vue'), [])
})

test('the sweep removes the conversations of the jobs that are gone', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, conversation('c-1', 'garde', exchange('a', 'b')))
  await conversations.save(dir, conversation('c-2', 'disparue', exchange('c', 'd')))

  await conversations.prune(dir, ['garde'])

  assert.equal((await conversations.list(dir, 'garde')).length, 1)
  assert.equal((await conversations.list(dir, 'disparue')).length, 0)
})

// --- the context returned to the model ------------------------------------------

test('the trail becomes a sequence of messages again', () => {
  const messages = conversations.toMessages([
    ...exchange('first question', 'first answer'),
    ...exchange('second question', 'second answer'),
  ])

  assert.deepEqual(messages, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ])
})

test('the fragments of an answer reassemble into one message', () => {
  const messages = conversations.toMessages([
    { type: 'turn-start', content: 'salut' },
    { type: 'turn', iteration: 1 },
    { type: 'delta', content: 'une ' },
    { type: 'delta', content: 'answer ' },
    { type: 'delta', content: 'en morceaux' },
  ])

  assert.deepEqual(messages[1], { role: 'assistant', content: 'une answer en morceaux' })
})

// An empty bubble teaches the model nothing and would cost it context.
test('a turn with no text leaves no empty message', () => {
  const messages = conversations.toMessages([
    { type: 'turn-start', content: 'fais quelque chose' },
    { type: 'turn', iteration: 1 },
    { type: 'tool-call', id: '1', name: 'fetch' },
    { type: 'tool-result', id: '1', ok: true },
    { type: 'turn', iteration: 2 },
    { type: 'delta', content: 'there you go' },
  ])

  assert.deepEqual(messages, [
    { role: 'user', content: 'fais quelque chose' },
    { role: 'assistant', content: 'there you go' },
  ])
})

test('the tool calls do not come back into the context', () => {
  const messages = conversations.toMessages([
    { type: 'turn-start', content: 'va voir' },
    { type: 'turn', iteration: 1 },
    { type: 'tool-call', id: '1', name: 'fetch', args: { url: 'https://example.com' } },
    { type: 'tool-result', id: '1', ok: true, summary: '200 OK' },
    { type: 'delta', content: 'it answers' },
  ])

  assert.equal(messages.length, 2)
  assert.ok(!JSON.stringify(messages).includes('example.com'))
})

// --- the conversation registry ---------------------------------------------------

function sessions(t, dir, { jobs = {} } = {}) {
  const sent = []
  const chat = createChatSessions({
    store: {
      paths: { conversationsDir: dir },
      getJob: (id) => jobs[id] ?? null,
      getConfig: () => ({ runners: {}, integrations: {} }),
    },
    runner: { isRunning: () => false, jobs: null },
    ui: {},
    send: (event) => sent.push(event),
  })
  t.after(() => chat.closeAll())
  return { chat, sent }
}

const agentJob = {
  id: 'veille',
  name: 'Veille',
  runner: { type: 'agent', agent: { model: 'x', prompt: 'Fais quelque chose.', api: { baseUrl: 'http://x' } } },
  execution: { sandbox: { enabled: false } },
}

test('creating two conversations on one job gives two threads', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const first = chat.create('veille')
  const second = chat.create('veille')

  assert.equal(first.ok, true)
  assert.notEqual(first.chatId, second.chatId)
})

test('a job that is not an agent cannot be chatted with', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, {
    jobs: { script: { id: 'script', name: 'S', runner: { type: 'bun' } } },
  })

  assert.equal(chat.create('script').ok, false)
  assert.equal((await chat.list('script')).ok, false)
})

// Opening the tab must not scatter empty files in the directory.
test('a conversation with no message writes no file', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  chat.create('veille')
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.deepEqual(await conversations.list(dir, 'veille'), [])
})

// …but it must nevertheless appear in the list, otherwise the one just created
// vanishes until the first message is written.
test('a fresh conversation appears in the list before its first message', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const created = chat.create('veille')
  const listed = await chat.list('veille')

  assert.deepEqual(
    listed.conversations.map((entry) => entry.chatId),
    [created.chatId],
  )
  assert.equal(listed.conversations[0].title, 'New conversation')
})

test('a saved conversation reopens with its thread', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, conversation('c-1', 'veille', exchange('bonjour', 'salut')))
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const opened = await chat.openConversation('veille', 'c-1')

  assert.equal(opened.ok, true)
  assert.equal(opened.events.length, 4)
  assert.equal(opened.prompt, 'Fais quelque chose.')
})

test('reopening an unknown conversation is refused', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  assert.equal((await chat.openConversation('veille', 'jamais-vue')).ok, false)
})

test('deleting a conversation removes its file', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, conversation('c-1', 'veille', exchange('bonjour', 'salut')))
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  await chat.remove('veille', 'c-1')

  assert.deepEqual(await conversations.list(dir, 'veille'), [])
})

// A Discord channel has no sidebar to pick a thread from: it resumes the one it
// had, rather than opening one on every restart.
test('an origin with no list picks its last conversation up again', async (t) => {
  const dir = await freshDir(t)
  await conversations.save(dir, {
    ...conversation('depuis-discord', 'veille', exchange('salut', 'bonjour')),
    origin: 'discord',
  })
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const opened = await chat.open('veille', 'discord')

  assert.equal(opened.chatId, 'depuis-discord')
})

test('an origin with no previous conversation opens one', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const opened = await chat.open('veille', 'discord')

  assert.equal(opened.ok, true)
  assert.equal(opened.events.length, 0)
})

// The editor's tab and the channel do not share the same thread: two people
// writing in the same context get in each other's way.
test('two origins do not open the same conversation', async (t) => {
  const dir = await freshDir(t)
  const { chat } = sessions(t, dir, { jobs: { veille: agentJob } })

  const depuisDiscord = await chat.open('veille', 'discord')
  const depuisApi = await chat.open('veille', 'api')

  assert.notEqual(depuisDiscord.chatId, depuisApi.chatId)
})

// --- regression: a long reply used to swallow the conversation ------------------
//
// The stream emits one delta per chunk received — roughly one per token. Kept as
// they came, a single long answer filled the 500-event buffer on its own, and the
// eviction took the start of the conversation with it: reopening showed only the
// last turn, and the sidebar counted zero messages because the `turn-start`s were
// gone. They are coalesced now.

const { validateJob } = require('../src/config/validate')

/** A response body that arrives in `count` SSE chunks, as a real stream does. */
const streamedAnswer = (count) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'text/event-stream' },
  body: (async function* () {
    const encoder = new TextEncoder()
    for (let i = 0; i < count; i += 1) {
      const payload = JSON.stringify({ choices: [{ delta: { content: 'mot ' } }] })
      yield encoder.encode(`data: ${payload}\n\n`)
    }
    yield encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    )
    yield encoder.encode('data: [DONE]\n\n')
  })(),
})

async function chattyHarness(t, { chunks }) {
  const racine = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-flux-'))
  t.after(() => fs.rm(racine, { recursive: true, force: true }))

  const paths = {
    conversationsDir: path.join(racine, 'conversations'),
    agentsDir: path.join(racine, 'agents'),
    memoryDir: path.join(racine, 'memory'),
    envFile: path.join(racine, '.env'),
  }
  for (const d of [paths.conversationsDir, paths.agentsDir, paths.memoryDir]) {
    await fs.mkdir(d, { recursive: true })
  }

  const job = validateJob({
    id: 'veille',
    name: 'Veille',
    triggers: [],
    runner: {
      type: 'agent',
      workingDirectory: path.join(racine, 'travail'),
      agent: {
        model: 'faux',
        prompt: 'Fais.',
        api: { baseUrl: 'http://127.0.0.1:1/v1' },
        tools: { enabled: [] },
        memory: { enabled: false },
      },
    },
  }).job
  await fs.mkdir(job.runner.workingDirectory, { recursive: true })

  const vrai = globalThis.fetch
  globalThis.fetch = async () => streamedAnswer(chunks)
  t.after(() => {
    globalThis.fetch = vrai
  })

  const pousses = []
  const chat = createChatSessions({
    store: { paths, getJob: () => job, getConfig: () => ({ runners: {}, integrations: {} }) },
    runner: { isRunning: () => false, jobs: null },
    ui: {},
    send: (event) => pousses.push(event),
  })
  t.after(() => chat.closeAll())
  return { chat, paths, pousses }
}

test('an answer in a thousand pieces does not erase the previous turn', async (t) => {
  const { chat, paths } = await chattyHarness(t, { chunks: 1000 })

  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'first question')
  await chat.post(ouverte.chatId, 'second question')

  const resume = (await chat.list('veille')).conversations[0]
  assert.equal(resume.turns, 2, 'both turns are counted')
  assert.equal(resume.title, 'first question', 'le titre vient toujours du first message')

  chat.close(ouverte.chatId)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const relue = await conversations.load(paths.conversationsDir, 'veille', ouverte.chatId)
  const questions = relue.events.filter((e) => e.type === 'turn-start').map((e) => e.content)
  assert.deepEqual(questions, ['first question', 'second question'])
})

// The point of streaming is watching the answer compose itself: the view must
// still receive every chunk, however few end up stored.
test('the interface receives every piece all the same', async (t) => {
  const { chat, pousses } = await chattyHarness(t, { chunks: 50 })

  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'question')

  const pousssesDelta = pousses.filter((e) => e.type === 'delta')
  const stockes = (await chat.openConversation('veille', ouverte.chatId)).events
  const stockesDelta = stockes.filter((e) => e.type === 'delta')

  assert.equal(pousssesDelta.length, 50, 'the view sees the answer compose itself')
  assert.equal(stockesDelta.length, 1, 'one delta kept for the whole turn')
  assert.equal(stockesDelta[0].content, 'mot '.repeat(50), 'and it carries the whole answer')
})

// --- renaming ------------------------------------------------------------------
//
// The title was derived from the first message and nothing else. That reads well
// until you have four threads on the same job, all opening with "check the
// services": the list stops telling them apart.

test('a title set by hand wins over the first message', async (t) => {
  const { chat } = await chattyHarness(t, { chunks: 3 })
  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'check the services')

  const renommee = await chat.rename('veille', ouverte.chatId, 'Incident du mardi')

  assert.equal(renommee.ok, true)
  assert.equal(renommee.title, 'Incident du mardi')
  const resume = (await chat.list('veille')).conversations[0]
  assert.equal(resume.title, 'Incident du mardi')
  assert.equal(resume.named, true)
})

// An empty name is not an error but a way back, after a rename one regrets.
test('an empty name gives the conversation its derived title back', async (t) => {
  const { chat } = await chattyHarness(t, { chunks: 3 })
  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'check the services')
  await chat.rename('veille', ouverte.chatId, 'Incident du mardi')

  const rendue = await chat.rename('veille', ouverte.chatId, '   ')

  assert.equal(rendue.title, 'check the services')
  assert.equal((await chat.list('veille')).conversations[0].named, false)
})

test('the chosen title survives closing and reloading', async (t) => {
  const { chat, paths } = await chattyHarness(t, { chunks: 3 })
  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'check the services')
  await chat.rename('veille', ouverte.chatId, 'Incident du mardi')

  chat.close(ouverte.chatId)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const relue = await chat.openConversation('veille', ouverte.chatId)
  assert.equal(relue.title, 'Incident du mardi')
  assert.equal(relue.named, true)
  assert.equal((await conversations.list(paths.conversationsDir, 'veille'))[0].title, 'Incident du mardi')
})

// Renaming a thread nobody has written in yet is legitimate — one names it for
// what one is about to do with it.
test('a conversation with no message can be renamed too', async (t) => {
  const { chat } = await chattyHarness(t, { chunks: 3 })
  const ouverte = chat.create('veille')

  const renommee = await chat.rename('veille', ouverte.chatId, 'To do tomorrow')

  assert.equal(renommee.title, 'To do tomorrow')
  assert.equal((await chat.list('veille')).conversations[0].title, 'To do tomorrow')
})

test('renaming an unknown conversation is refused', async (t) => {
  const { chat } = await chattyHarness(t, { chunks: 3 })

  assert.equal((await chat.rename('veille', 'jamais-vue', 'x')).ok, false)
})

// A derived title must keep following the first message: writing it into the
// file is for whoever opens the folder, not a value to freeze.
test('a derived title does not freeze into the file', async (t) => {
  const { chat, paths } = await chattyHarness(t, { chunks: 3 })
  const ouverte = chat.create('veille')
  await chat.post(ouverte.chatId, 'first wording')
  chat.close(ouverte.chatId)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const surDisque = await conversations.load(paths.conversationsDir, 'veille', ouverte.chatId)
  assert.equal(surDisque.title, null, 'nothing was chosen, so nothing is kept')
  assert.equal(conversations.summarize(surDisque).title, 'first wording')
})
