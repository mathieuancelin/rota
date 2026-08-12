'use strict'

// The commands received from Discord.
//
// No network: we give a message, we read the answer. The two points that matter
// are addressing — the bot must obey only what mentions it, it and not another —
// and the fact that an unknown or malformed command answers something useful
// rather than falling over.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseCommand, runCommand, tail } = require('../src/discord/commands')

const BOT = '111111111111111111'
const AUTRE = '999999999999999999'

// --- addressing ---------------------------------------------------------------

test('a mention of the bot opens a command', () => {
  assert.deepEqual(parseCommand(`<@${BOT}> list`, BOT), { name: 'list', args: [], rest: '' })
  assert.deepEqual(parseCommand(`<@!${BOT}> run sync-obsidian`, BOT), {
    name: 'run',
    args: ['sync-obsidian'],
    rest: 'sync-obsidian',
  })
})

test('case and stray spaces are absorbed', () => {
  assert.deepEqual(parseCommand(`  <@${BOT}>   RUN   sync   `, BOT), {
    name: 'run',
    args: ['sync'],
    rest: 'sync',
  })
})

test('a mention on its own asks for help', () => {
  assert.deepEqual(parseCommand(`<@${BOT}>`, BOT), { name: 'help', args: [], rest: '' })
})

// Otherwise the bot would obey orders addressed to somebody else.
test('anything not mentioning this bot is ignored', () => {
  assert.equal(parseCommand(`<@${AUTRE}> run sync`, BOT), null)
  assert.equal(parseCommand('list', BOT), null)
  assert.equal(parseCommand(`salut <@${BOT}> list`, BOT), null, 'la mention doit ouvrir le message')
  assert.equal(parseCommand(`<@${BOT}> list`, null), null, 'with no identity, nothing is accepted')
})

// --- doubles ------------------------------------------------------------------

const jobs = [
  { id: 'sync-obsidian', name: 'Synchro', enabled: true },
  { id: 'veille', name: 'Veille', enabled: false },
]

function makeDeps(overrides = {}) {
  const calls = []
  const deps = {
    calls,
    store: {
      getJobs: () => jobs,
      getConfig: () => ({ integrations: { discordChatEnabled: false } }),
      setJobEnabled: async (id, enabled) => {
        calls.push(['setJobEnabled', id, enabled])
        return { ok: true }
      },
    },
    scheduler: {
      isPaused: () => false,
      nextRunByJob: () => new Map([['sync-obsidian', '2026-08-03T09:00:00.000Z']]),
      runNow: async (id) => {
        calls.push(['runNow', id])
        return { ok: true }
      },
    },
    runner: {
      isRunning: (id) => id === 'sync-obsidian',
      runningExecutions: () => [{ executionId: 'exec-1', jobId: 'sync-obsidian' }],
      liveOutput: () => ({ ok: true, stdout: { text: 'en cours…\n' }, stderr: { text: '' } }),
      cancel: (executionId) => {
        calls.push(['cancel', executionId])
        return true
      },
    },
    state: { lastRunByJob: () => new Map([['sync-obsidian', { status: 'success' }]]) },
    history: {
      read: async () => ({
        entries: [
          {
            startedAt: '2026-08-02T09:00:00.000Z',
            durationMs: 2300,
            status: 'success',
            stdout: 'tout va bien\n',
            stderr: '',
            error: null,
          },
        ],
      }),
    },
    setPaused: async (paused) => calls.push(['setPaused', paused]),
    ...overrides,
  }
  return deps
}

const call = (line, deps) => runCommand(parseCommand(`<@${BOT}> ${line}`, BOT), deps)

// --- commands -----------------------------------------------------------------

test('list shows the jobs, their state and their last result', async () => {
  const text = await call('list', makeDeps())

  assert.ok(text.includes('2 job(s)'))
  assert.ok(text.includes('▶ sync-obsidian'), text)
  assert.ok(text.includes('× veille'), 'the disabled job is marked')
  assert.ok(text.includes('succeeded'))
})

test('status sums up the scheduler and the next occurrences', async () => {
  const text = await call('status', makeDeps())

  assert.ok(text.includes('active'))
  assert.ok(text.includes('sync-obsidian'))
})

test('run fires the job', async () => {
  const deps = makeDeps()
  const text = await call('run sync-obsidian', deps)

  assert.deepEqual(deps.calls, [['runNow', 'sync-obsidian']])
  assert.ok(text.includes('started'))
})

test("stop cancels the job's running executions", async () => {
  const deps = makeDeps()
  await call('stop sync-obsidian', deps)

  assert.deepEqual(deps.calls, [['cancel', 'exec-1']])
})

test('stop on a resting job says so without cancelling anything', async () => {
  const deps = makeDeps()
  const text = await call('stop veille', deps)

  assert.deepEqual(deps.calls, [])
  assert.ok(text.includes('no running execution'))
})

test('enable and disable go through the store', async () => {
  const deps = makeDeps()
  await call('enable veille', deps)
  await call('disable sync-obsidian', deps)

  assert.deepEqual(deps.calls, [
    ['setJobEnabled', 'veille', true],
    ['setJobEnabled', 'sync-obsidian', false],
  ])
})

test('pause and resume act on the scheduler', async () => {
  const deps = makeDeps()
  await call('pause', deps)
  await call('resume', deps)

  assert.deepEqual(deps.calls, [['setPaused', true], ['setPaused', false]])
})

test('history returns the last executions', async () => {
  const text = await call('history sync-obsidian', makeDeps())

  assert.ok(text.includes('sync-obsidian'))
  assert.ok(text.includes('succeeded'))
  assert.ok(text.includes('2.3 s'))
})

// When you have just started a job, it is its running output you want to see,
// not the previous one's.
test('logs shows the running execution when there is one', async () => {
  const text = await call('logs sync-obsidian', makeDeps())

  assert.ok(text.includes('running execution'))
  assert.ok(text.includes('en cours…'))
})

test('logs falls back to the last finished execution', async () => {
  const text = await call('logs veille', makeDeps())

  assert.ok(text.includes('tout va bien'))
  assert.equal(text.includes('running execution'), false)
})

// --- what breaks --------------------------------------------------------------

test('an unknown job is reported with the list of those that exist', async () => {
  const text = await call('run inexistante', makeDeps())

  assert.ok(text.includes('Unknown job'))
  assert.ok(text.includes('sync-obsidian'))
})

test('a command with no argument asks for the identifier', async () => {
  assert.ok((await call('run', makeDeps())).includes('Name a job identifier'))
})

test('an unknown command answers with the help', async () => {
  const text = await call('rm -rf /', makeDeps())

  assert.ok(text.includes('Unknown command'))
  assert.ok(text.includes('`list`'))
})

test('a refusal from the scheduler is reported as it is', async () => {
  const deps = makeDeps({
    scheduler: {
      isPaused: () => false,
      nextRunByJob: () => new Map(),
      runNow: async () => ({ ok: false, errors: ['Tâche inconnue'] }),
    },
  })

  assert.ok((await call('run veille', deps)).includes('Run refused'))
})

// --- formatting ---------------------------------------------------------------

// A channel is not a console: we show the end, the one carrying the failure.
test('a long output is reduced to its end, on a line boundary', () => {
  const text = `${'ligne de output\n'.repeat(200)}last`

  const cut = tail(text, 100)
  assert.ok(cut.length <= 110)
  assert.ok(cut.startsWith('[…]'))
  assert.ok(cut.endsWith('last'))
  assert.equal(cut.includes('[…]\nligne de output'), true, 'la coupe suit une fin de ligne')
})

test('a short output goes through unchanged', () => {
  assert.equal(tail('court', 100), 'court')
})

// --- conversation -------------------------------------------------------------

// `run` executes the prompt written in the job; `chat` lets the prompt be
// composed in the channel. That is not the same power, hence a flag of its own.
function chatDeps(overrides = {}) {
  const posts = []
  const acks = []
  const chat = {
    posts,
    open: (jobId, origin) => {
      posts.push(['open', jobId, origin])
      return { ok: true, chatId: 'chat-1', busy: overrides.busy === true }
    },
    post: async (chatId, content) => {
      posts.push(['post', chatId, content])
      return overrides.result ?? { ok: true, turn: { ok: true, content: 'Trois services, tous debout.' } }
    },
  }
  return makeDeps({
    chat,
    ack: async (text) => acks.push(text),
    store: {
      getJobs: () => jobs,
      getConfig: () => ({ integrations: { discordChatEnabled: overrides.enabled !== false } }),
    },
    ...(overrides.deps ?? {}),
    posts,
    acks,
  })
}

test('without the flag, chat is refused and says so', async () => {
  const deps = chatDeps({ enabled: false })
  const text = await call('chat sync-obsidian bonjour', deps)

  assert.match(text, /off/)
  assert.deepEqual(deps.posts, [], 'aucune conversation ouverte')
})

test("chat opens the channel's conversation, not the editor's", async () => {
  const deps = chatDeps()
  const text = await call('chat sync-obsidian how is it going?', deps)

  assert.deepEqual(deps.posts, [
    ['open', 'sync-obsidian', 'discord'],
    ['post', 'chat-1', 'how is it going?'],
  ])
  assert.equal(text, 'Trois services, tous debout.')
})

// A turn can last a minute: with no acknowledgement, the channel looks dead.
test('an acknowledgement goes out before the answer', async () => {
  const deps = chatDeps()
  await call('chat sync-obsidian bonjour', deps)

  assert.equal(deps.acks.length, 1)
  assert.match(deps.acks[0], /thinking/)
})

test('the message keeps its newlines', async () => {
  const deps = chatDeps()
  await runCommand(parseCommand(`<@${BOT}> chat sync-obsidian first line\nsecond line`, BOT), deps)

  assert.equal(deps.posts[1][2], 'first line\nsecond line')
})

test('an identifier with no message asks for the message', async () => {
  const deps = chatDeps()
  const text = await call('chat sync-obsidian', deps)

  assert.match(text, /Write something/)
  assert.deepEqual(deps.posts, [])
})

test('a busy conversation says so rather than stacking up', async () => {
  const deps = chatDeps({ busy: true })
  const text = await call('chat sync-obsidian bonjour', deps)

  assert.match(text, /still working/)
  assert.equal(deps.posts.filter(([kind]) => kind === 'post').length, 0)
})

test('a failed turn is reported as it is', async () => {
  const deps = chatDeps({ result: { ok: true, turn: { ok: false, error: 'the model did not answer' } } })
  const text = await call('chat sync-obsidian bonjour', deps)

  assert.match(text, /the model did not answer/)
})

test('a job that is not an agent is refused by the conversation', async () => {
  const deps = chatDeps({
    deps: {
      chat: {
        open: () => ({ ok: false, errors: ['Only agent jobs can be chatted with.'] }),
        post: async () => assert.fail('must not be called'),
      },
    },
  })
  const text = await call('chat veille bonjour', deps)

  assert.match(text, /Only agent jobs/)
})

test('chat is in the help', async () => {
  assert.match(await call('help', makeDeps()), /`chat <id> <message>`/)
})

// --- job keywords -------------------------------------------------------------
//
// A job can claim a word of its own: "@Rota deploy" starts it, without going
// through `run`. The command always keeps priority — otherwise a definition
// could seize `pause`, and nothing would say so.

const keywordDeps = (extra = {}) =>
  makeDeps({
    store: {
      getJobs: () => [
        { id: 'deploiement', name: 'Deployment', enabled: true, triggers: [{ type: 'discord', keyword: 'deploy' }] },
        { id: 'veille', name: 'Veille', enabled: true, triggers: [{ type: 'interval', every: 5, unit: 'minutes' }] },
      ],
      getConfig: () => ({ integrations: { discordChatEnabled: false } }),
      ...extra,
    },
  })

test('a declared keyword starts its job', async () => {
  const deps = keywordDeps()
  const text = await call('deploy', deps)

  assert.deepEqual(deps.calls, [['runNow', 'deploiement']])
  assert.ok(text.includes('`deploiement` started'), text)
})

test('an unknown word stays unknown, and the help goes with it', async () => {
  const deps = keywordDeps()
  const text = await call('deplooy', deps)

  assert.deepEqual(deps.calls, [])
  assert.ok(text.includes('Unknown command'), text)
})

// Disabling a job means "do not start on your own": a word thrown into the
// channel is exactly that.
test('a disabled job cannot be started by its keyword', async () => {
  const deps = makeDeps({
    store: {
      getJobs: () => [
        { id: 'deploiement', name: 'D', enabled: false, triggers: [{ type: 'discord', keyword: 'deploy' }] },
      ],
      getConfig: () => ({ integrations: { discordChatEnabled: false } }),
    },
  })
  const text = await call('deploy', deps)

  assert.deepEqual(deps.calls, [])
  assert.ok(text.includes('Unknown command'), text)
})

test('a trigger switched off does not answer either', async () => {
  const deps = makeDeps({
    store: {
      getJobs: () => [
        {
          id: 'deploiement',
          name: 'D',
          enabled: true,
          triggers: [{ type: 'discord', keyword: 'deploy', enabled: false }],
        },
      ],
      getConfig: () => ({ integrations: { discordChatEnabled: false } }),
    },
  })

  await call('deploy', deps)

  assert.deepEqual(deps.calls, [])
})

// `run` stays `run` whatever a definition claims: the command is read first.
test('a command beats a keyword that would double it', async () => {
  const deps = makeDeps({
    store: {
      getJobs: () => [
        { id: 'pirate', name: 'P', enabled: true, triggers: [{ type: 'discord', keyword: 'list' }] },
      ],
      getConfig: () => ({ integrations: { discordChatEnabled: false } }),
    },
  })
  const text = await call('list', deps)

  assert.deepEqual(deps.calls, [], 'no job started')
  assert.ok(text.includes('job(s)'), text)
})

test('the help lists the declared keywords', async () => {
  const text = await call('help', keywordDeps())

  assert.ok(text.includes('**Keywords**'), text)
  assert.ok(text.includes('`deploy` — runs `deploiement`'), text)
})

test('with no declared keyword, the help does not mention them', async () => {
  const text = await call('help', makeDeps())

  assert.ok(!text.includes('**Keywords**'), text)
})
