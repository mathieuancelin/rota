'use strict'

// Resolving the secrets referenced by agent jobs.
//
// The sensitive point is not parsing the file but failing: a missing variable
// must stop the execution before the first network call, rather than sending
// "Bearer ${OPENAI_API_KEY}" and letting the server answer 401.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { parseEnvFile, loadEnv, resolveReferences, resolveHeaders } = require('../src/config/env')

test('parseEnvFile reads the usual shapes', () => {
  const values = parseEnvFile(
    [
      '# a comment',
      '',
      'SIMPLE=value',
      '  SPACES  =  around  ',
      'export EXPORTED=yes',
      'QUOTED="with a space"',
      "APOSTROPHES='literal ${NOT_RESOLVED}'",
      'ESCAPED="line1\\nline2"',
      'COMMENT=value # ignored',
      'HASH_PROTECTED="word#inside"',
      'NO_EQUALS',
      '=NO_KEY',
      '2INVALID=x',
    ].join('\n'),
  )

  assert.deepEqual(values, {
    SIMPLE: 'value',
    SPACES: 'around',
    EXPORTED: 'yes',
    QUOTED: 'with a space',
    APOSTROPHES: 'literal ${NOT_RESOLVED}',
    ESCAPED: 'line1\nline2',
    COMMENT: 'value',
    HASH_PROTECTED: 'word#inside',
  })
})

test('the real environment wins over the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-env-'))
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, 'CLE=du-file\nSEULEMENT_FICHIER=oui\n')

  const env = loadEnv(envFile, { CLE: 'du-processus' })

  assert.equal(env.CLE, 'du-processus')
  assert.equal(env.SEULEMENT_FICHIER, 'oui')
})

test('a missing file is not an error', () => {
  const env = loadEnv('/tmp/rota-inexistant/.env', { A: 'b' })
  assert.deepEqual(env, { A: 'b' })
})

test('resolveReferences replaces what it finds and names what it does not', () => {
  assert.deepEqual(resolveReferences('Bearer ${CLE}', { CLE: 'abc' }), {
    ok: true,
    value: 'Bearer abc',
  })
  assert.deepEqual(resolveReferences('with no reference', {}), { ok: true, value: 'with no reference' })
  assert.deepEqual(resolveReferences('${A} et ${B}', { A: 'a' }), { ok: false, missing: ['B'] })
})

// A variable that is defined but empty is a secret one believed was set: treating
// it as present would send "Bearer " and get the server blamed.
test('an empty variable counts as missing', () => {
  assert.deepEqual(resolveReferences('${CLE}', { CLE: '' }), { ok: false, missing: ['CLE'] })
})

test('resolveHeaders fails as a whole, naming the header and the variable', () => {
  const result = resolveHeaders(
    { Authorization: 'Bearer ${ABSENTE}', 'X-Ok': 'constante' },
    { AUTRE: 'x' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0].includes('headers.Authorization'))
  assert.ok(result.errors[0].includes('ABSENTE'))
})

test('resolveHeaders returns the resolved headers when everything is there', () => {
  const result = resolveHeaders({ Authorization: 'Bearer ${CLE}' }, { CLE: 'secret' })

  assert.deepEqual(result, { ok: true, headers: { Authorization: 'Bearer secret' } })
})
