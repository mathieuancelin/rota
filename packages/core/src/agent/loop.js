'use strict'

// The tool loop itself, extracted from the session that owns it.
//
// We send the messages to the model, if it asks for tools we run them and hand
// it back the results, and we start again until it answers asking for nothing.
// That is all this file does — it knows nothing about where the messages come
// from or who is watching.
//
// It lives apart because a sub-agent runs exactly the same loop, with the same
// client and the same tools, on a conversation of its own. Two copies of these
// forty lines would drift on the first fix.

const logger = require('../lib/logger')

/**
 * Arguments arrive as JSON in a string, and some servers already return an
 * object. A model stumbling over its JSON must not take the execution down: the
 * error is handed back to it as a tool result, and it has the next turn to
 * recover.
 */
function parseArguments(raw) {
  if (raw == null || raw === '') return { ok: true, value: {} }
  if (typeof raw === 'object') return { ok: true, value: raw }
  try {
    const parsed = JSON.parse(raw)
    return { ok: true, value: parsed !== null && typeof parsed === 'object' ? parsed : {} }
  } catch (err) {
    return { ok: false, error: `unreadable arguments: ${err.message}` }
  }
}

/**
 * One turn: as many round trips with the model as it asks for tools.
 *
 * @param {object} options
 * @param {object} options.client model client, `complete` and `stream`
 * @param {object[]} options.messages **mutated**: the conversation carries on
 *   across turns, and that is what makes a session a session
 * @param {object[]} options.definitions tool declarations, as the API expects
 * @param {Map<string, object>} options.toolsByName
 * @param {object} options.context handed to every tool
 * @param {number} options.maxIterations
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.stream]
 * @param {(delta: object) => void} [options.onDelta]
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<{ok: boolean, content?: string, iterations: number,
 *   error?: string, aborted?: boolean}>}
 */
async function runToolLoop({
  client,
  messages,
  definitions,
  toolsByName,
  context,
  maxIterations,
  signal,
  stream = false,
  onDelta = () => {},
  onEvent = () => {},
}) {
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (signal?.aborted) {
      return { ok: false, aborted: true, error: 'interrupted', iterations: iteration - 1 }
    }

    onEvent({ type: 'turn', iteration })

    const call = stream ? client.stream : client.complete
    const answer = await call({ messages, tools: definitions, signal, onDelta })

    if (!answer.ok) {
      onEvent({ type: 'error', text: answer.error })
      return { ok: false, aborted: answer.aborted === true, error: answer.error, iterations: iteration }
    }

    const { message } = answer
    const calls = message.tool_calls.map((toolCall, index) => ({
      ...toolCall,
      id: toolCall.id || `call_${index}`,
    }))

    // The assistant's message is rewritten rather than reused: the fields
    // Rota adds (reasoning, stop reason) are not protocol, and some servers
    // refuse what they do not know.
    messages.push({
      role: 'assistant',
      content: message.content,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    })
    onEvent({
      type: 'assistant',
      content: message.content,
      reasoning: message.reasoning,
      toolCalls: calls.map((toolCall) => toolCall.function?.name),
    })

    if (calls.length === 0) {
      onEvent({ type: 'done', reason: 'final' })
      return { ok: true, content: message.content, iterations: iteration }
    }

    // In sequence, not in parallel: two commands started together in the same
    // working directory would get in each other's way, and the transcript would
    // become unreadable.
    for (const [index, toolCall] of calls.entries()) {
      messages.push(await callTool(toolCall, index, { toolsByName, context, onEvent }))
      if (signal?.aborted) {
        return { ok: false, aborted: true, error: 'interrupted', iterations: iteration }
      }
    }
  }

  const error = `the model did not conclude within ${maxIterations} turns`
  onEvent({ type: 'error', text: error })
  return { ok: false, error, iterations: maxIterations }
}

async function callTool(call, index, { toolsByName, context, onEvent }) {
  // Some servers return calls with no identifier: one is needed nonetheless, it
  // is what attaches the result to the request.
  const id = call.id || `call_${index}`
  const name = call.function?.name ?? ''
  const parsed = parseArguments(call.function?.arguments)

  onEvent({ type: 'tool-call', id, name, args: parsed.ok ? parsed.value : call.function?.arguments })

  let result
  if (!parsed.ok) {
    result = { ok: false, error: parsed.error }
  } else if (!toolsByName.has(name)) {
    result = { ok: false, error: `unknown tool: ${name}` }
  } else {
    try {
      result = await toolsByName.get(name).run(parsed.value, context)
    } catch (err) {
      logger.error(`tool ${name} failed`, err)
      result = { ok: false, error: `internal tool failure: ${err.message}` }
    }
  }

  onEvent({ type: 'tool-result', id, name, ...result })
  return {
    role: 'tool',
    tool_call_id: id,
    name,
    content: result.ok ? (result.content ?? '') : `Error: ${result.error}`,
  }
}

module.exports = { runToolLoop, parseArguments }
