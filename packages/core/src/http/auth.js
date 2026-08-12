'use strict'

// Access control for the HTTP server.
//
// There is only one, and it is a token. What that opens deserves to be said
// plainly: starting a job means running shell or an agent on the machine. The
// listening address is a setting — a webhook coming from outside needs more than
// loopback — and past 127.0.0.1, this token is the only thing between the
// network and this machine.
//
// Hence two rules. The server does not start without a token, loopback included:
// anything running locally could otherwise drive it, a web page in an open tab
// included. And the comparison is constant-time, because `===` on a string stops
// at the first differing character and lets the token be guessed byte by byte.

const { randomBytes, timingSafeEqual } = require('node:crypto')

const PREFIX = 'tt_'

/** Token offered in the settings. 32 bytes, in hexadecimal. */
function generateToken() {
  return `${PREFIX}${randomBytes(32).toString('hex')}`
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` requires two buffers of equal length; the length difference
 * is therefore tested separately, and what it reveals — the size of the expected
 * token — helps nobody.
 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  if (presented.length === 0 || presented.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
}

/**
 * Token presented by a request.
 *
 * "Authorization: Bearer <token>" first, then the "X-Rota-Token" header —
 * some webhook senders do not let you choose the authorization header, and
 * refusing their only option would amount to refusing the webhook.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {string|null}
 */
function presentedToken(headers) {
  const authorization = headers.authorization ?? headers.Authorization
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (match) return match[1].trim()
  }
  const custom = headers['x-rota-token']
  return typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : null
}

module.exports = { generateToken, tokenMatches, presentedToken, PREFIX }
