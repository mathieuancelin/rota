'use strict'

// Sending a message to Discord, by either of the two paths.
//
// A **webhook** is enough to publish, and asks for nothing but a URL pasted into
// the settings: it is the path for whoever only wants reports. A **bot** is
// indispensable to *receive* commands; having one anyway, it can write too, and
// then serves as a fallback when no webhook is declared.
//
// The two differ on one point: a webhook can choose the displayed name on every
// message, a bot carries its own. The job's name is therefore put at the head of
// the message in the second case — in a channel receiving several jobs, knowing
// which one is speaking beats a common label.

const { resolveReferences } = require('../config/env')

const API = 'https://discord.com/api/v10'

// Discord refuses a message beyond 2000 characters. We cut earlier to leave room
// for the identity markers.
const MAX_CONTENT = 1900
const MAX_MESSAGES = 5

/**
 * Splits a text into messages, on line boundaries as far as possible.
 * @param {string} text
 * @returns {string[]}
 */
function splitContent(text) {
  const messages = []
  let current = ''

  const flush = () => {
    if (current !== '') messages.push(current.trimEnd())
    current = ''
  }

  for (const line of text.split('\n')) {
    // A single line longer than the limit: we cut it raw.
    if (line.length > MAX_CONTENT) {
      flush()
      for (let at = 0; at < line.length; at += MAX_CONTENT) {
        messages.push(line.slice(at, at + MAX_CONTENT))
      }
      continue
    }
    if (current.length + line.length + 1 > MAX_CONTENT) flush()
    current += `${line}\n`
  }
  flush()

  return messages.length === 0 ? [''] : messages
}

/**
 * The sending path chosen, and its resolved address.
 *
 * @param {object} integrations global settings
 * @param {Record<string, string>} env for the ${VARIABLE}s
 * @returns {{kind: 'webhook'|'bot'|'none', url?: string, token?: string,
 *   channelId?: string, error?: string}}
 */
function resolveDestination(integrations, env) {
  const { discordWebhookUrl, discordBotToken, discordChannelId } = integrations

  if (discordWebhookUrl) {
    const resolved = resolveReferences(discordWebhookUrl, env)
    if (!resolved.ok) {
      return { kind: 'none', error: `Discord webhook: missing variable: ${resolved.missing.join(', ')}` }
    }
    return { kind: 'webhook', url: resolved.value }
  }

  if (discordBotToken && discordChannelId) {
    const resolved = resolveReferences(discordBotToken, env)
    if (!resolved.ok) {
      return { kind: 'none', error: `Discord bot: missing variable: ${resolved.missing.join(', ')}` }
    }
    return { kind: 'bot', token: resolved.value, channelId: discordChannelId }
  }

  return { kind: 'none', error: 'no Discord destination in Rota settings' }
}

/** Is a destination configured, without having to resolve the variables? */
function hasDestination(integrations = {}) {
  return Boolean(
    integrations.discordWebhookUrl || (integrations.discordBotToken && integrations.discordChannelId),
  )
}

/**
 * @param {object} options
 * @param {object} options.integrations
 * @param {Record<string, string>} options.env
 * @param {typeof fetch} [options.fetchImpl]
 */
function createDiscordSender({ integrations, env, fetchImpl = fetch }) {
  const destination = resolveDestination(integrations, env)

  return {
    kind: destination.kind,
    available: destination.kind !== 'none',
    error: destination.error ?? null,

    /**
     * @param {object} options
     * @param {string} options.text markdown content
     * @param {string} [options.from] job the message comes from
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ok: true, messages: number, dropped: number} | {ok: false, error: string}>}
     */
    async send({ text, from, signal }) {
      if (destination.kind === 'none') return { ok: false, error: destination.error }

      // A bot cannot change its display name: identity therefore goes into the
      // text.
      const body = destination.kind === 'bot' && from ? `**${from}**\n${text}` : text
      const messages = splitContent(body)
      const kept = messages.slice(0, MAX_MESSAGES)

      for (const [index, content] of kept.entries()) {
        const request =
          destination.kind === 'webhook'
            ? { url: destination.url, headers: {}, payload: { content, username: from } }
            : {
                url: `${API}/channels/${destination.channelId}/messages`,
                headers: { Authorization: `Bot ${destination.token}` },
                payload: { content },
              }

        let response
        try {
          response = await fetchImpl(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...request.headers },
            body: JSON.stringify(request.payload),
            signal,
          })
        } catch (err) {
          if (err.name === 'AbortError') return { ok: false, error: 'send interrupted' }
          return { ok: false, error: `send failed: ${err.cause?.message ?? err.message}` }
        }

        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          const which = kept.length > 1 ? ` (message ${index + 1}/${kept.length})` : ''
          return { ok: false, error: `Discord refused${which}: HTTP ${response.status} ${detail}` }
        }
      }

      return { ok: true, messages: kept.length, dropped: messages.length - kept.length }
    },
  }
}

module.exports = {
  createDiscordSender,
  resolveDestination,
  hasDestination,
  splitContent,
  API,
  MAX_CONTENT,
  MAX_MESSAGES,
}
