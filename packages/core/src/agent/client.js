'use strict'

// Calling an OpenAI-compatible API ("/chat/completions").
//
// Two modes, for two uses:
//
//   * blocking, for scheduled executions — nobody watches them arrive, and the
//     transcript is written in one go at the end;
//   * streaming, for the chat console — where seeing the answer compose itself
//     makes all the difference between "it works" and "it looks stuck".
//
// This module knows neither the tools nor the loop: it sends messages and
// returns what the model answered.

const { resolveHeaders } = require('../config/env')

/** Servers that refuse an unknown field rather than ignoring it. */
const UNKNOWN_FIELD = /unknown|unrecognized|unsupported|invalid|extra|not permitted|unexpected/i

/**
 * `baseUrl` designates the root of the API, "/v1" included. We append the path
 * rather than expecting it from the user: every piece of documentation gives
 * that root, and half the configurations would get the slash wrong.
 */
function chatCompletionsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/**
 * Body of the request.
 *
 * @param {object} options
 * @param {object} options.agent validated configuration
 * @param {object[]} options.messages
 * @param {object[]} [options.tools] declarations in the OpenAI format
 * @param {boolean} [options.stream]
 * @param {boolean} [options.reasoningEffort] include "reasoning_effort"
 */
function buildRequestBody({ agent, messages, tools = [], stream = false, reasoningEffort = true }) {
  const body = { model: agent.model, messages }

  // An empty array is not the same as an absence: some servers refuse it, and it
  // would tell the model it has tools, but none of them.
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  if (agent.temperature !== undefined) body.temperature = agent.temperature
  if (reasoningEffort && agent.reasoningEffort) body.reasoning_effort = agent.reasoningEffort
  if (stream) body.stream = true

  // Last: what the user writes explicitly wins over what Rota infers.
  return { ...body, ...agent.api.extraBody }
}

/**
 * SSE event parser.
 *
 * An HTTP stream is not cut on logical boundaries: one event can arrive in
 * three chunks, and three events in a single one. The state kept here is that
 * leftover incomplete line.
 */
function createSseParser() {
  let buffer = ''

  return {
    /**
     * @param {string} text chunk received
     * @returns {object[]} JSON data of the complete events
     */
    push(text) {
      buffer += text
      const events = []

      // An event ends with an empty line. We keep the last fragment: it is
      // incomplete by construction.
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')

        if (data === '' || data === '[DONE]') continue
        try {
          events.push(JSON.parse(data))
        } catch {
          // An unreadable fragment must not take down the whole answer.
        }
      }

      return events
    },
  }
}

/**
 * Recomposes a message from a stream's deltas.
 *
 * Tool calls arrive in crumbs: the name in one delta, the arguments character
 * by character in the following ones, identified by their `index` alone.
 */
function createDeltaAccumulator() {
  let content = ''
  let reasoning = ''
  let finishReason = null
  const toolCalls = []

  return {
    push(chunk) {
      const choice = chunk.choices?.[0]
      if (!choice) return null
      const delta = choice.delta ?? {}
      const emitted = {}

      if (choice.finish_reason) finishReason = choice.finish_reason

      if (typeof delta.content === 'string' && delta.content !== '') {
        content += delta.content
        emitted.content = delta.content
      }
      // "reasoning_content" for some, "reasoning" for others.
      const thought = delta.reasoning_content ?? delta.reasoning
      if (typeof thought === 'string' && thought !== '') {
        reasoning += thought
        emitted.reasoning = thought
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0
        toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        const target = toolCalls[index]
        if (call.id) target.id = call.id
        if (call.function?.name) target.function.name += call.function.name
        if (call.function?.arguments) target.function.arguments += call.function.arguments
        emitted.toolCall = { index, name: target.function.name }
      }

      return emitted
    },

    result() {
      return {
        role: 'assistant',
        content,
        reasoning,
        tool_calls: toolCalls.filter(Boolean),
        finishReason,
      }
    },
  }
}

/**
 * A network failure comes back from `fetch` under the message "fetch failed",
 * which tells nobody anything. The cause, on the other hand, carries a code —
 * and by far the most frequent failure is the local server one forgot to start.
 */
function describeNetworkError(err, url) {
  switch (err.cause?.code) {
    case 'ECONNREFUSED':
      return `server unreachable at ${url} — is the service running?`
    case 'ENOTFOUND':
      return `host not found for ${url}`
    case 'ECONNRESET':
      return `connection closed by ${url}`
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `certificate rejected by ${url}: ${err.cause.code}`
    default:
      return `call to the model failed: ${err.cause?.message ?? err.message}`
  }
}

/** Normalised message of a blocking response. */
function normalizeMessage(payload) {
  const choice = payload.choices?.[0]
  const message = choice?.message ?? {}
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: message.reasoning_content ?? message.reasoning ?? '',
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: choice?.finish_reason ?? null,
  }
}

/**
 * Client bound to a job.
 *
 * @param {object} options
 * @param {object} options.agent validated configuration (runner.agent)
 * @param {Record<string, string>} options.env environment resolving the ${VAR}s
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.onNotice] non-fatal warnings
 */
function createClient({ agent, env, fetchImpl = fetch, onNotice = () => {} }) {
  const url = chatCompletionsUrl(agent.api.baseUrl)
  const resolved = resolveHeaders(agent.api.headers, env)

  // A server that does not know "reasoning_effort" says so once; no need to ask
  // it again on every turn of the loop.
  let sendReasoningEffort = true

  async function request({ messages, tools, stream, signal }) {
    if (!resolved.ok) return { ok: false, error: resolved.errors.join(' | ') }

    const attempt = async (withReasoningEffort) => {
      const body = buildRequestBody({
        agent,
        messages,
        tools,
        stream,
        reasoningEffort: withReasoningEffort,
      })

      const timeout = AbortSignal.timeout(agent.api.timeoutSeconds * 1000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...resolved.headers },
        body: JSON.stringify(body),
        signal: combined,
      })

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 2000)
        return { ok: false, status: response.status, error: detail, response }
      }
      return { ok: true, response }
    }

    try {
      let result = await attempt(sendReasoningEffort)

      // The field is not normalised everywhere. Rather than guessing the server
      // from its URL, we ask it once and remember its answer.
      if (
        !result.ok &&
        sendReasoningEffort &&
        agent.reasoningEffort &&
        result.status === 400 &&
        (result.error.includes('reasoning_effort') || UNKNOWN_FIELD.test(result.error))
      ) {
        sendReasoningEffort = false
        onNotice(`the server rejects "reasoning_effort", request replayed without it`)
        result = await attempt(false)
      }

      if (!result.ok) {
        return { ok: false, error: `HTTP ${result.status}${result.error ? ` — ${result.error}` : ''}` }
      }
      return { ok: true, response: result.response }
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { ok: false, error: `the model did not answer within ${agent.api.timeoutSeconds} seconds` }
      }
      if (err.name === 'AbortError') return { ok: false, aborted: true, error: 'call interrupted' }
      return { ok: false, error: describeNetworkError(err, url) }
    }
  }

  return {
    url,

    /** Complete answer, in one go. */
    async complete({ messages, tools = [], signal }) {
      const result = await request({ messages, tools, stream: false, signal })
      if (!result.ok) return result

      let payload
      try {
        payload = await result.response.json()
      } catch (err) {
        return { ok: false, error: `unreadable answer from the model: ${err.message}` }
      }
      if (payload.error) {
        return { ok: false, error: payload.error.message ?? String(payload.error) }
      }
      return { ok: true, message: normalizeMessage(payload), usage: payload.usage ?? null }
    },

    /**
     * Streamed answer. `onDelta` receives the chunks as they come; the
     * recomposed message is returned at the end, in the same shape as `complete`.
     */
    async stream({ messages, tools = [], signal, onDelta = () => {} }) {
      const result = await request({ messages, tools, stream: true, signal })
      if (!result.ok) return result

      const parser = createSseParser()
      const accumulator = createDeltaAccumulator()
      const decoder = new TextDecoder()

      try {
        for await (const chunk of result.response.body) {
          for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
            if (event.error) {
              return { ok: false, error: event.error.message ?? String(event.error) }
            }
            const emitted = accumulator.push(event)
            if (emitted && Object.keys(emitted).length > 0) onDelta(emitted)
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return { ok: false, aborted: true, error: 'call interrupted' }
        return { ok: false, error: `stream interrupted: ${err.message}` }
      }

      return { ok: true, message: accumulator.result(), usage: null }
    },
  }
}

module.exports = {
  chatCompletionsUrl,
  buildRequestBody,
  createSseParser,
  createDeltaAccumulator,
  normalizeMessage,
  createClient,
}
