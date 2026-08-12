'use strict'

// Driving Rota from a Discord channel.
//
// The access control fits in one line: **only the designated channel is listened
// to**. Anyone who can write in it can start a job — and a job can start shell
// or an agent. That channel must therefore be treated as access to the machine,
// not as a convenience. That is why control requires an explicit flag on top of
// the token: pasting a token into the settings is not enough to open a remote
// control.
//
// Direct messages are ignored, otherwise they would bypass the only lock there
// is.

const logger = require('../lib/logger')
const { loadEnv, resolveReferences } = require('../config/env')
const { parseCommand, runCommand } = require('./commands')
const { createGateway } = require('./gateway')
const { createDiscordSender, hasDestination } = require('./send')

/**
 * @param {object} deps
 * @param {import('../config/store').ConfigStore} deps.store
 * @param {import('../scheduler').Scheduler} deps.scheduler
 * @param {import('../runner').Runner} deps.runner
 * @param {import('../state-store').StateStore} deps.state
 * @param {import('../history/store').HistoryStore} deps.history
 * @param {object} deps.chat agent conversations, for the `chat` command
 * @param {(paused: boolean) => Promise<void>} deps.setPaused
 * @param {() => void} [deps.onStatusChange]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(options: object) => object} [deps.createGatewayImpl]
 */
function createDiscordControl(deps) {
  const { store, onStatusChange = () => {}, fetchImpl = fetch } = deps
  const createGatewayFn = deps.createGatewayImpl ?? createGateway

  let gateway = null
  let signature = null
  let status = { state: 'disabled', error: null, user: null }

  const integrations = () => store.getConfig().integrations
  const env = () => loadEnv(store.paths.envFile)

  const setStatus = (next) => {
    status = { ...status, ...next }
    onStatusChange(status)
  }

  /** Current sending destination — webhook, or the bot itself. */
  const sender = () =>
    createDiscordSender({ integrations: integrations(), env: env(), fetchImpl })

  async function reply(channelId, token, text) {
    const messages = createDiscordSender({
      integrations: { discordBotToken: token, discordChannelId: channelId },
      env: {},
      fetchImpl,
    })
    const result = await messages.send({ text })
    if (!result.ok) logger.warn(`discord: reply not sent — ${result.error}`)
  }

  /** Is the bot named in this message — it, not its role? */
  const namesBot = (message) =>
    (message.mentions ?? []).some((user) => user.id === gateway?.botUserId())

  async function onMessage(message, token) {
    const { discordChannelId } = integrations()

    // A direct message would bypass the only lock: it is ignored with no answer,
    // so as to teach nothing to whoever probes the bot.
    if (message.channel_id !== discordChannelId) {
      // Anywhere but here is none of our business — unless the message names us.
      // It is then the identifier in the settings that points at the wrong place,
      // and that is exactly what one looks for when "nothing happens".
      if (namesBot(message)) {
        logger.warn(
          `discord: named in channel ${message.channel_id}, but the settings listen to ` +
            `${discordChannelId ?? 'nothing'} — check the channel identifier`,
        )
      }
      return
    }
    if (message.author?.bot) return

    // Discord only delivers the content to whoever is named in the message.
    // Mentioning the bot's *role* is not naming it: the message arrives empty, and
    // the silence that follows has no visible reason. Ordinary messages arrive
    // empty too — hence the condition on the role mention, which alone
    // distinguishes a command that missed its target.
    if (!message.content) {
      if (message.mention_roles?.length > 0) {
        logger.warn(
          'discord: message content withheld — a role was mentioned, not the bot itself. ' +
            'Pick the bot in the member list rather than its role.',
        )
      }
      return
    }

    const command = parseCommand(message.content, gateway?.botUserId())
    if (!command) return

    logger.info(`discord: ${message.author?.username} → ${command.name} ${command.args.join(' ')}`)

    let text
    try {
      // `ack` lets a slow command say it has started, rather than leaving the
      // channel mute while an agent thinks.
      text = await runCommand(command, {
        ...deps,
        ack: (interim) => reply(message.channel_id, token, interim),
      })
    } catch (err) {
      logger.error(`discord: command ${command.name} failed`, err)
      text = `The command failed: ${err.message}`
    }
    await reply(message.channel_id, token, text)
  }

  /** What, when it changes, forces the connection to be reopened. */
  function currentSignature() {
    const { discordControlEnabled, discordBotToken, discordChannelId } = integrations()
    if (!discordControlEnabled || !discordBotToken || !discordChannelId) return null
    // A NUL separates the two values: neither can contain it, so no pair of
    // (token, channel) can produce the signature of another pair.
    return `${discordBotToken}\0${discordChannelId}`
  }

  return {
    /** Opens, closes or reopens the connection according to the settings. Idempotent. */
    sync() {
      const next = currentSignature()
      if (next === signature) return
      signature = next

      gateway?.stop()
      gateway = null

      if (next === null) {
        setStatus({ state: 'disabled', error: null, user: null })
        return
      }

      const resolved = resolveReferences(integrations().discordBotToken, env())
      if (!resolved.ok) {
        const error = `missing variable: ${resolved.missing.join(', ')}`
        logger.error(`discord: unreadable token — ${error}`)
        setStatus({ state: 'failed', error, user: null })
        return
      }

      const token = resolved.value
      gateway = createGatewayFn({
        token,
        onMessage: (message) => {
          onMessage(message, token).catch((err) => logger.error('discord: message', err))
        },
        onStatus: (gatewayStatus) => setStatus(gatewayStatus),
      })
      gateway.start()
    },

    stop() {
      gateway?.stop()
      gateway = null
      signature = null
      setStatus({ state: 'disabled', error: null, user: null })
    },

    status: () => status,

    /**
     * Sending a report, for the agents' tools. Goes through the webhook if one is
     * declared, otherwise through the bot.
     *
     * `available` is what a sender built on the spot exposes, and what the
     * callers test before mirroring a report. It is read each time rather than
     * fixed at construction: a destination configured in the settings must take
     * effect without restarting the application.
     */
    get available() {
      return hasDestination(integrations())
    },
    hasDestination: () => hasDestination(integrations()),
    send: (options) => sender().send(options),
  }
}

module.exports = { createDiscordControl }
