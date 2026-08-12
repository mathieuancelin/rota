'use strict'

// Sending to Discord: the splitting, the two possible paths, and the agents'
// tool that leans on them.
//
// No real call. What matters: Discord refuses a message beyond 2000 characters
// and a slightly long report soon exceeds that; and the address comes from the
// settings, never from the model.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createDiscordSender, hasDestination, splitContent, MAX_CONTENT } = require('../src/discord/send')
const { reportDiscord } = require('../src/agent/tools/discord')
const { selectTools } = require('../src/agent/tools')
const { validateJob, validateConfig } = require('../src/config/validate')

const WEBHOOK = 'https://discord.com/api/webhooks/123/abcdef'
const TOKEN = 'MTIz.abc.def'
const CHANNEL = '123456789012345678'

const makeJob = (agent = {}, execution = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Veille services',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'Fais.', model: 'm', tools: { enabled: ['report_discord'] }, ...agent },
    },
    execution,
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

/** What Discord answers: 204, hence with no body. */
const ok = () => new Response(null, { status: 204 })

const sender = (integrations, { env = {}, fetchImpl = async () => ok() } = {}) =>
  createDiscordSender({ integrations, env, fetchImpl })

// --- splitting ----------------------------------------------------------------

test('a short report goes out as one message', () => {
  assert.deepEqual(splitContent('bonjour\nmonde'), ['bonjour\nmonde'])
})

test('the split falls on ends of line', () => {
  const ligne = `${'x'.repeat(500)}\n`
  const messages = splitContent(ligne.repeat(8))

  assert.ok(messages.length > 1)
  for (const message of messages) {
    assert.ok(message.length <= MAX_CONTENT, `${message.length} characters`)
    assert.equal(message.includes('x'.repeat(501)), false, 'no line was glued back together')
  }
})

// A single line longer than the limit has no boundary: it has to be cut
// somewhere.
test('an over-long line is cut bluntly', () => {
  const messages = splitContent('y'.repeat(MAX_CONTENT * 2 + 50))

  assert.equal(messages.length, 3)
  assert.equal(messages[0].length, MAX_CONTENT)
})

test('an empty report does not produce an empty array', () => {
  assert.deepEqual(splitContent(''), [''])
})

// --- choosing the path --------------------------------------------------------

test('the webhook wins when both are declared', () => {
  const both = sender({ discordWebhookUrl: WEBHOOK, discordBotToken: TOKEN, discordChannelId: CHANNEL })
  assert.equal(both.kind, 'webhook')
})

test('the bot stands in when no webhook is declared', () => {
  assert.equal(sender({ discordBotToken: TOKEN, discordChannelId: CHANNEL }).kind, 'bot')
  assert.equal(sender({ discordBotToken: TOKEN }).kind, 'none', 'un token sans channel ne suffit pas')
  assert.equal(sender({}).available, false)
})

test('hasDestination answers without resolving the variables', () => {
  assert.equal(hasDestination({ discordWebhookUrl: '${X}' }), true)
  assert.equal(hasDestination({ discordBotToken: TOKEN, discordChannelId: CHANNEL }), true)
  assert.equal(hasDestination({ discordBotToken: TOKEN }), false)
  assert.equal(hasDestination({}), false)
})

// --- sending ------------------------------------------------------------------

test("by webhook: the display name is the job's", async () => {
  const seen = []
  const result = await sender(
    { discordWebhookUrl: WEBHOOK },
    {
      fetchImpl: async (url, options) => {
        seen.push({ url, body: JSON.parse(options.body) })
        return ok()
      },
    },
  ).send({ text: 'Tout va bien.', from: 'Veille services' })

  assert.deepEqual(result, { ok: true, messages: 1, dropped: 0 })
  assert.equal(seen[0].url, WEBHOOK)
  assert.equal(seen[0].body.content, 'Tout va bien.')
  assert.equal(seen[0].body.username, 'Veille services')
})

// A bot carries its own name: identity therefore goes into the text.
test('by bot: the identity goes at the head of the message', async () => {
  const seen = []
  const result = await sender(
    { discordBotToken: TOKEN, discordChannelId: CHANNEL },
    {
      fetchImpl: async (url, options) => {
        seen.push({ url, headers: options.headers, body: JSON.parse(options.body) })
        return ok()
      },
    },
  ).send({ text: 'Tout va bien.', from: 'Veille services' })

  assert.equal(result.ok, true)
  assert.equal(seen[0].url, `https://discord.com/api/v10/channels/${CHANNEL}/messages`)
  assert.equal(seen[0].headers.Authorization, `Bot ${TOKEN}`)
  assert.equal(seen[0].body.content, '**Veille services**\nTout va bien.')
})

test('the addresses accept a variable, resolved when sending', async () => {
  let seen = null
  const result = await sender(
    { discordWebhookUrl: '${DISCORD_WEBHOOK}' },
    {
      env: { DISCORD_WEBHOOK: WEBHOOK },
      fetchImpl: async (url) => {
        seen = url
        return ok()
      },
    },
  ).send({ text: 'x' })

  assert.equal(result.ok, true, result.error)
  assert.equal(seen, WEBHOOK)
})

test('a missing variable is said, with no network call', async () => {
  const destination = sender(
    { discordWebhookUrl: '${DISCORD_WEBHOOK}' },
    { fetchImpl: () => assert.fail('must not be called') },
  )

  assert.equal(destination.available, false)
  assert.ok(destination.error.includes('DISCORD_WEBHOOK'))
  assert.equal((await destination.send({ text: 'x' })).ok, false)
})

test('a refusal from Discord is returned with its status', async () => {
  const result = await sender(
    { discordWebhookUrl: WEBHOOK },
    { fetchImpl: async () => new Response('unknown webhook', { status: 404 }) },
  ).send({ text: 'x' })

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('404'))
  assert.ok(result.error.includes('unknown webhook'))
})

test('an outsized report is cut, and how much is missing is returned', async () => {
  let envois = 0
  const result = await sender(
    { discordWebhookUrl: WEBHOOK },
    {
      fetchImpl: async () => {
        envois += 1
        return ok()
      },
    },
  ).send({ text: `${'z'.repeat(1000)}\n`.repeat(20) })

  assert.equal(result.ok, true)
  assert.equal(envois, 5, 'capped')
  assert.ok(result.dropped > 0)
})

// --- the agents' tool ---------------------------------------------------------

test("report_discord sends the title in bold, in the job's name", async () => {
  const seen = []
  const ctx = {
    job: makeJob(),
    signal: undefined,
    discord: sender(
      { discordWebhookUrl: WEBHOOK },
      {
        fetchImpl: async (url, options) => {
          seen.push(JSON.parse(options.body))
          return ok()
        },
      },
    ),
  }

  const result = await reportDiscord.run({ title: 'Veille', markdown: 'Tout va bien.' }, ctx)

  assert.equal(result.ok, true, result.error)
  assert.equal(seen[0].content, '**Veille**\nTout va bien.')
  assert.equal(seen[0].username, 'Veille services')
})

test('an empty report is refused before anything is sent', async () => {
  const ctx = { job: makeJob(), discord: { send: () => assert.fail('must not be called') } }
  assert.equal((await reportDiscord.run({ markdown: '   ' }, ctx)).ok, false)
})

// --- availability of the tool -------------------------------------------------

// Better not to offer it than to let it fail at the moment the agent finally has
// something to report.
test('with no destination, the tool is not offered to the model', () => {
  const { tools, notices } = selectTools(makeJob(), { integrations: {} })

  assert.deepEqual(tools, [])
  assert.ok(notices[0].includes('no Discord destination'), notices.join(' | '))
})

test('a bot with no webhook is enough to offer it', () => {
  const { tools } = selectTools(makeJob(), {
    integrations: { discordBotToken: TOKEN, discordChannelId: CHANNEL },
  })
  assert.deepEqual(tools.map((tool) => tool.name), ['report_discord'])
})

// The address is the user's choice, not the model's: unlike fetch, the sandbox
// has no reason to withdraw it.
test('a sandbox with no network keeps report_discord and withdraws fetch', () => {
  const job = makeJob({ tools: { enabled: ['fetch', 'report_discord'] } }, { sandbox: { enabled: true } })

  const names = selectTools(job, {
    integrations: { discordWebhookUrl: WEBHOOK },
  }).tools.map((tool) => tool.name)
  assert.deepEqual(names, ['report_discord'])
})

// --- global settings ----------------------------------------------------------

test('the Discord settings are empty by default, and control is off', () => {
  assert.deepEqual(validateConfig({}).config.integrations, {
    discordWebhookUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordControlEnabled: false,
    discordChatEnabled: false,
    mirrorReportsToDiscord: true,
  })
})

const configWith = (integrations) => validateConfig({ integrations })

// A mistyped webhook would send the reports elsewhere, with nothing to flag it:
// Discord is not there to answer that it received nothing.
test('an address that is not a Discord webhook is refused', () => {
  const url = (discordWebhookUrl) => configWith({ discordWebhookUrl })

  assert.equal(url('http://discord.com/api/webhooks/1/x').ok, false, 'https required')
  assert.ok(url('https://exemple.fr/webhook').errors.some((e) => e.includes('discord.com')))
  assert.equal(url('pas une url').ok, false)
  assert.equal(url('https://ptb.discord.com/api/webhooks/1/x').ok, true, 'subdomain accepted')
  assert.equal(url(WEBHOOK).ok, true)
})

test('a URL carried entirely by a variable is not checked here', () => {
  assert.equal(configWith({ discordWebhookUrl: '${DISCORD_WEBHOOK}' }).ok, true)
  assert.equal(configWith({ discordWebhookUrl: '${invalid key}' }).ok, false)
})

// The flag alone opens nothing: saying so at once saves looking for why the bot
// stays mute.
test('turning control on with no bot and no channel is refused', () => {
  const sans = configWith({ discordControlEnabled: true })
  assert.equal(sans.ok, false)
  assert.ok(sans.errors.some((e) => e.includes('bot token')))

  assert.equal(
    configWith({ discordControlEnabled: true, discordBotToken: TOKEN, discordChannelId: CHANNEL }).ok,
    true,
  )
})

test('a channel identifier that is not one is refused', () => {
  assert.equal(configWith({ discordChannelId: '#general' }).ok, false)
  assert.equal(configWith({ discordChannelId: CHANNEL }).ok, true)
})
