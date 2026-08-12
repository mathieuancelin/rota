'use strict'

// The core suite under Bun, which is the runtime the daemon ships as.
//
// The application runs this code under Electron's Node and the daemon runs it
// under Bun, so a divergence between the two is a bug we would otherwise find
// in production. Running the suite twice is how that stays a theory.
//
// Two things Bun's `node:test` does not do the way Node does, and they are
// handled differently because they deserve different answers:
//
//   - **`t.mock.timers`** (oven-sh/bun#5090) is missing outright. Rewriting the
//     files that use it to `bun:test` would mean maintaining two dialects of the
//     same suite for the sake of a runner, so they are skipped here — and named
//     on the way past, because a check that quietly covers less than it claims
//     is worse than no check at all.
//   - **`t.skip()` from inside a test body** is ignored: Bun runs the body
//     anyway. That one is refused rather than skipped, because it does not fail
//     honestly — a test guarded that way passes on a machine that has Docker and
//     fails on one that does not, under one runner only, which is close to
//     unreadable from a CI log. The declarative `test.skip(...)` is honoured by
//     both, so there is a correct form to point at.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TEST_DIR = path.join(REPO, 'packages', 'core', 'test')

// What Bun's node:test does not implement. Detected in the files rather than
// listed by name, so a new test that reaches for mock timers is skipped by this
// rule instead of breaking the build for a reason nobody remembers.
const NEEDS_MOCK_TIMERS = /\bt\.mock\b|\bmock\.timers\b/

// `t.skip(...)` but not `test.skip(...)`: the first is the imperative form Bun
// ignores, the second is the declarative one both runners honour.
const IMPERATIVE_SKIP = /(?<![A-Za-z.])t\.skip\(/

/**
 * The rules below look for calls, and a comment explaining a call is not one —
 * as this file found out about the very comment that documents the rule.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function main() {
  const files = fs
    .readdirSync(TEST_DIR)
    // `._foo.test.js` is an AppleDouble sidecar: macOS writes one beside a file
    // whenever the tree is copied to a filesystem that cannot hold extended
    // attributes. It ends in .test.js, it is binary, and bun will try to run it.
    .filter((name) => name.endsWith('.test.js') && !name.startsWith('.'))
    .sort()

  const skipped = []
  const runnable = []
  const refused = []

  for (const name of files) {
    const source = withoutComments(fs.readFileSync(path.join(TEST_DIR, name), 'utf8'))
    if (IMPERATIVE_SKIP.test(source)) refused.push(name)
    ;(NEEDS_MOCK_TIMERS.test(source) ? skipped : runnable).push(name)
  }

  if (refused.length > 0) {
    console.error(
      `${refused.join(', ')} calls t.skip() from inside a test body, which Bun ignores —\n` +
        'it runs the body anyway, so the test fails on whichever machine lacks the\n' +
        'tool it was guarding against. Declare it skipped instead:\n\n' +
        '  const withDocker = DOCKER.ok ? test : test.skip\n' +
        "  withDocker('...', async (t) => { ... })\n",
    )
    process.exit(1)
  }

  if (skipped.length > 0) {
    console.log(
      `skipping ${skipped.length} file(s) that use node:test mock timers, ` +
        `unimplemented in Bun: ${skipped.join(', ')}`,
    )
  }
  console.log(`running ${runnable.length} of ${files.length} core test files under Bun\n`)

  execFileSync(
    'bun',
    [
      'test',
      ...runnable.map((name) => path.join(TEST_DIR, name)),
      // Bun imposes a five-second per-test timeout that node --test does not,
      // and one runner test deliberately sleeps longer while it proves a
      // subprocess was killed along with its group.
      '--timeout',
      '30000',
    ],
    { stdio: 'inherit', cwd: REPO },
  )
}

main()
