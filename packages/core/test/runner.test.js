'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { Runner, STATUS } = require('../src/runner')

const DEFAULT_EXECUTION = {
  timeoutSeconds: 10,
  allowConcurrentRuns: false,
  runOnStartup: false,
  catchUpOnWake: true,
  maxOutputBytes: 1048576,
  sandbox: { enabled: false, image: 'oven/bun:1', network: false, mountWorkingDirectory: true },
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-runner-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function shellScript(dir, name, body) {
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, body, { mode: 0o755 })
  return filePath
}

function makeJob(script, overrides = {}) {
  return {
    id: 'test-job',
    name: 'Tâche de test',
    enabled: true,
    triggers: [{ type: 'interval', every: 1, unit: 'minutes' }],
    runner: { type: 'shell', script, interpreter: 'sh', args: [], environment: {}, ...overrides.runner },
    execution: { ...DEFAULT_EXECUTION, ...overrides.execution },
    notifications: { onStart: false, onSuccess: false, onError: true },
    history: { enabled: true, retainExecutions: 500 },
  }
}

function makeRunner(job, { inlineDir = null } = {}) {
  const entries = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null } }),
      getJob: () => job,
      paths: { inlineDir },
    },
    history: {
      append: async (entry) => {
        entries.push(entry)
        return entry
      },
    },
  })
  return { runner, entries }
}

// --- live output -------------------------------------------------------------
//
// What matters is not that the output eventually arrives — the history entry
// takes care of that — but that it arrives *while it happens*. A script that
// writes then waits must already have delivered everything before it ends.

test('the output is emitted during the execution, not at the end', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'echo "first"\nsleep 0.4\necho "second"\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const seen = []
  runner.on('output', (event) => seen.push(event))

  const execution = runner.run(job, { trigger: 'manual' })

  // In the middle of the script's sleep: the first line must already be there.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(seen.length, 1, 'the first line did not wait for the end')
  assert.equal(seen[0].stream, 'stdout')
  assert.equal(seen[0].chunk, 'first\n')
  assert.equal(seen[0].jobId, 'test-job')

  await execution
  assert.equal(seen.map((event) => event.chunk).join(''), 'first\nsecond\n')
})

test('stderr is told apart from stdout', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'deux.sh', 'echo "output"\necho "error" >&2\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const seen = []
  runner.on('output', (event) => seen.push(event))
  await runner.run(job, { trigger: 'manual' })

  const byStream = Object.fromEntries(
    ['stdout', 'stderr'].map((stream) => [
      stream,
      seen.filter((event) => event.stream === stream).map((event) => event.chunk).join(''),
    ]),
  )
  assert.deepEqual(byStream, { stdout: 'output\n', stderr: 'error\n' })
})

// A view opening midway would otherwise only see what arrives afterwards, and a
// job silent for ten minutes would look dead.
test('liveOutput returns what has already scrolled past, and nothing after the end', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'echo "already there"\nsleep 0.4\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const execution = runner.run(job, { trigger: 'manual' })
  await new Promise((resolve) => setTimeout(resolve, 200))

  const [{ executionId }] = runner.runningExecutions()
  const pendant = runner.liveOutput(executionId)
  assert.equal(pendant.ok, true)
  assert.equal(pendant.jobId, 'test-job')
  assert.equal(pendant.stdout.text, 'already there\n')
  assert.equal(pendant.stdout.dropped, false)

  await execution
  assert.equal(runner.liveOutput(executionId).ok, false, 'nothing left to follow once it is done')
})

test('an unknown identifier is refused without throwing', () => {
  const job = makeJob('/tmp/x.sh')
  const { runner } = makeRunner(job)
  assert.equal(runner.liveOutput('inexistant').ok, false)
})

test('a script that succeeds produces a success entry with its output', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'ok.sh', 'echo "tout va bien"\n')
  const job = makeJob(script)
  const { runner, entries } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entry.exitCode, 0)
  assert.equal(entry.stdout.trim(), 'tout va bien')
  assert.equal(entry.error, null)
  assert.equal(entry.trigger, 'manual')
  assert.ok(entry.durationMs >= 0)
  assert.equal(entries.length, 1, "the execution really is recorded")
})

test('a non-zero exit code gives a failure with the cause', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'ko.sh', 'echo "trouble" >&2\nexit 3\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.equal(entry.exitCode, 3)
  assert.equal(entry.stderr.trim(), 'trouble')
  assert.match(entry.error, /code 3/)
})

test('a script that runs too long is stopped and marked timed-out', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'sleep 30\n')
  const job = makeJob(script, { execution: { timeoutSeconds: 1 } })
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.TIMED_OUT)
  assert.match(entry.error, /1 seconds/)
  assert.ok(entry.durationMs < 10_000, 'the process must not have run for 30 seconds')
})

test('the child processes are killed with the script on timeout', async (t) => {
  const dir = await workspace(t)
  const marker = path.join(dir, 'toujours-vivant')
  // The script delegates to a subprocess that would write after the timeout.
  const script = await shellScript(dir, 'enfants.sh', `(sleep 4; touch ${marker}) &\nwait\n`)
  const job = makeJob(script, { execution: { timeoutSeconds: 1 } })
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'schedule' })
  assert.equal(entry.status, STATUS.TIMED_OUT)

  await new Promise((resolve) => setTimeout(resolve, 4500))
  await assert.rejects(
    () => fs.access(marker),
    'the sub-process should have been killed with its group',
  )
})

test('a second execution is skipped when concurrency is forbidden', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'sleep 2\n')
  const job = makeJob(script, { execution: { allowConcurrentRuns: false } })
  const { runner } = makeRunner(job)

  const first = runner.run(job, { trigger: 'schedule' })
  // We let the first process settle in before starting again.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const second = await runner.run(job, { trigger: 'schedule' })

  assert.equal(second.status, STATUS.SKIPPED_ALREADY_RUNNING)
  assert.match(second.error, /still running/)
  assert.equal((await first).status, STATUS.SUCCESS)
})

test('allowed concurrency lets both executions through', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'sleep 1\n')
  const job = makeJob(script, { execution: { allowConcurrentRuns: true } })
  const { runner } = makeRunner(job)

  const [first, second] = await Promise.all([
    runner.run(job, { trigger: 'schedule' }),
    runner.run(job, { trigger: 'manual' }),
  ])

  assert.equal(first.status, STATUS.SUCCESS)
  assert.equal(second.status, STATUS.SUCCESS)
})

test('a missing script fails with an explicit message, with no spawn', async (t) => {
  const dir = await workspace(t)
  const job = makeJob(path.join(dir, 'inexistant.sh'))
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.error, /Script not found/)
})

test('the environment is an allowlist, completed by the job', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'env.sh', 'echo "$MA_VARIABLE|${FUITE:-absente}"\n')
  const job = makeJob(script, { runner: { environment: { MA_VARIABLE: 'valeur' } } })
  const { runner } = makeRunner(job)

  process.env.FUITE = 'ne devrait pas passer'
  t.after(() => delete process.env.FUITE)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.stdout.trim(), 'valeur|absente')
})

test('the correlation variables are exposed to the script', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'ids.sh', 'echo "$ROTA_JOB_ID"\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.stdout.trim(), 'test-job')
})

test("the default working directory is the script's", async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'pwd.sh', 'pwd\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(await fs.realpath(entry.stdout.trim()), await fs.realpath(dir))
})

test('a running execution can be cancelled', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'lent.sh', 'sleep 30\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const pending = runner.run(job, { trigger: 'manual' })
  await new Promise((resolve) => setTimeout(resolve, 200))

  const executions = runner.runningExecutions()
  assert.equal(executions.length, 1)
  assert.equal(runner.cancel(executions[0].executionId), true)

  const entry = await pending
  assert.equal(entry.status, STATUS.CANCELLED)
  assert.match(entry.error, /Stop requested/)
})

test('cancelling an unknown execution does not throw', async (t) => {
  const dir = await workspace(t)
  const { runner } = makeRunner(makeJob(await shellScript(dir, 'x.sh', 'true\n')))
  assert.equal(runner.cancel('identifiant-inexistant'), false)
})

test('the running-execution tracking empties at the end', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'ok.sh', 'true\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  await runner.run(job, { trigger: 'manual' })

  assert.equal(runner.runningExecutions().length, 0)
  assert.equal(runner.isRunning('test-job'), false)
  assert.equal(runner.runningByJob().size, 0)
})

test('a large output is truncated at maxOutputBytes', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'bavard.sh', 'for i in $(seq 1 500); do echo "ligne $i de remplissage"; done\n')
  const job = makeJob(script, { execution: { maxOutputBytes: 1024 } })
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entry.stdoutTruncated, true)
  assert.ok(entry.stdout.includes('truncated'))
})

test('the history is not written when the job turns it off', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'ok.sh', 'true\n')
  const job = makeJob(script)
  job.history.enabled = false
  const { runner, entries } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entries.length, 0)
})

test('a script reporting an effect brings it back into the history entry', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'change.sh', 'echo "travail"\necho "::rota:changed:: 2 files pushed"\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.deepEqual(entry.change, { changed: true, message: '2 files pushed' })
  assert.ok(entry.stdout.includes('::rota:changed::'), 'le marqueur reste visible dans l’historique')
})

test('a silent script reports no effect', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'rien.sh', 'echo "aucune modification"\n')
  const job = makeJob(script)
  const { runner } = makeRunner(job)

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entry.change, null)
})

// --- inline code ---------------------------------------------------------------
//
// These tests really start Bun: it is the only way to check that the code the
// job carries does end up running. They are skipped where Bun is not installed
// rather than failing the suite over a missing dependency.

const { resolveBun } = require('../src/runner/resolve-bun')
const BUN = resolveBun()

function makeInlineJob(code, overrides = {}) {
  return {
    ...makeJob('/inutilise', overrides),
    runner: { type: 'bun-inline', code, args: [], environment: {}, ...overrides.runner },
  }
}

// Declared as skipped when the tool is missing, rather than skipped from inside
// the body. `t.skip()` is honoured by `node --test` and ignored by `bun test`,
// which runs the body anyway — so the imperative form passes on a machine with
// Docker and fails on one without, under one runner only. That is a hard bug to
// read from a CI log, and this form has neither problem.
const withBun = BUN.ok ? test : test.skip

withBun('a bun-inline job runs the code its definition carries', async (t) => {
  const dir = await workspace(t)
  const job = makeInlineJob('console.log(`somme ${2 + 3}`)')
  const { runner } = makeRunner(job, { inlineDir: path.join(dir, 'inline') })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS, entry.stderr)
  assert.equal(entry.stdout.trim(), 'somme 5')
})

withBun('the inline code is written beside, never passed as an argument', async (t) => {
  const dir = await workspace(t)
  const inlineDir = path.join(dir, 'inline')
  const job = makeInlineJob('console.log("written to disk")')
  const { runner } = makeRunner(job, { inlineDir })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.ok(entry.command.includes(path.join(inlineDir, 'test-job.js')))
  assert.ok(!entry.command.includes('console.log'), 'le code reste hors de la commande')
  assert.match(await fs.readFile(path.join(inlineDir, 'test-job.js'), 'utf8'), /written to disk/)
})

withBun('an error in the inline code gives a failure with the trace', async (t) => {
  const dir = await workspace(t)
  const job = makeInlineJob('throw new Error("broken")')
  const { runner } = makeRunner(job, { inlineDir: path.join(dir, 'inline') })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.stderr, /broken/)
})

withBun('with no declared directory, an inline job runs in the generated directory', async (t) => {
  const dir = await workspace(t)
  const inlineDir = path.join(dir, 'inline')
  const job = makeInlineJob('console.log(process.cwd())')
  const { runner } = makeRunner(job, { inlineDir })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(await fs.realpath(entry.stdout.trim()), await fs.realpath(inlineDir))
})

withBun('the change marker works from inline code too', async (t) => {
  const dir = await workspace(t)
  const job = makeInlineJob('console.log("::rota:changed:: 1 chose faite")')
  const { runner } = makeRunner(job, { inlineDir: path.join(dir, 'inline') })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.deepEqual(entry.change, { changed: true, message: '1 chose faite' })
})

// --- regression: two triggers in the same tick -----------------------------------
//
// Writing the code of an inline job is asynchronous. The concurrency guard and
// the registration into `running` ended up separated by that wait: a wake-up
// catch-up crossing an occurrence passed twice, and the two writes fought over
// the same intermediate file.

withBun('two simultaneous firings give one execution', async (t) => {
  const dir = await workspace(t)
  const job = makeInlineJob('console.log("une seule fois")')
  const { runner } = makeRunner(job, { inlineDir: path.join(dir, 'inline') })

  const [first, second] = await Promise.all([
    runner.run(job, { trigger: 'schedule' }),
    runner.run(job, { trigger: 'wake' }),
  ])

  const statuses = [first.status, second.status].sort()
  assert.deepEqual(statuses, [STATUS.SKIPPED_ALREADY_RUNNING, STATUS.SUCCESS].sort())
})

withBun('the reservation is handed back: a later execution goes through', async (t) => {
  const dir = await workspace(t)
  const job = makeInlineJob('console.log("ok")')
  const { runner } = makeRunner(job, { inlineDir: path.join(dir, 'inline') })

  await runner.run(job, { trigger: 'manual' })
  const second = await runner.run(job, { trigger: 'manual' })

  assert.equal(second.status, STATUS.SUCCESS)
  assert.equal(runner.starting.size, 0, 'no reservation leaks')
})

// Root ignores permission bits, so the unwritable directory below is writable
// after all and the test has nothing to observe. That is not a failure worth
// reporting — it is a question this machine cannot be asked. Containers run as
// root by default, which is increasingly where a suite finds itself.
const asMortal = process.getuid?.() === 0 ? test.skip : test

asMortal('a failed write leaves no reservation behind it', async (t) => {
  const dir = await workspace(t)
  // A directory with no write access: writing the code must fail.
  const inlineDir = path.join(dir, 'interdit')
  await fs.mkdir(inlineDir)
  await fs.chmod(inlineDir, 0o500)
  const job = makeInlineJob('console.log("jamais")')
  const { runner } = makeRunner(job, { inlineDir })

  const entry = await runner.run(job, { trigger: 'manual' })

  // Restored before the assertions: cleaning up the workspace must be able to pass.
  await fs.chmod(inlineDir, 0o700)
  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.error, /inline code/)
  assert.equal(runner.starting.size, 0)
})

withBun('allowed concurrent executions each write without getting in the way', async (t) => {
  const dir = await workspace(t)
  const inlineDir = path.join(dir, 'inline')
  const job = makeInlineJob('console.log("parallel")', {
    execution: { allowConcurrentRuns: true },
  })
  const { runner } = makeRunner(job, { inlineDir })

  const results = await Promise.all([
    runner.run(job, { trigger: 'manual' }),
    runner.run(job, { trigger: 'manual' }),
    runner.run(job, { trigger: 'manual' }),
  ])

  assert.deepEqual(
    results.map((entry) => entry.status),
    [STATUS.SUCCESS, STATUS.SUCCESS, STATUS.SUCCESS],
    results.map((entry) => entry.error).join(' | '),
  )
  assert.deepEqual(await fs.readdir(inlineDir), ['test-job.js'], 'no intermediate is left behind')
})

// --- sandbox -------------------------------------------------------------------

const { resolveDocker } = require('../src/runner/resolve-bun')
const DOCKER = resolveDocker()
const withDocker = DOCKER.ok ? test : test.skip

function makeSandboxRunner(job, { dockerPath = null, inlineDir = null } = {}) {
  const entries = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null, dockerPath } }),
      getJob: () => job,
      paths: { inlineDir },
    },
    history: { append: async (entry) => (entries.push(entry), entry) },
  })
  return { runner, entries }
}

const sandboxed = (script, sandbox = {}) =>
  makeJob(script, {
    execution: { sandbox: { ...DEFAULT_EXECUTION.sandbox, enabled: true, ...sandbox } },
  })

test('a docker configured but not found fails with a clear message', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'x.sh', 'echo ok\n')
  const job = sandboxed(script)
  const { runner } = makeSandboxRunner(job, { dockerPath: '/nulle/part/docker' })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.error, /is not executable/)
  assert.match(entry.error, /nulle\/part\/docker/)
})

withDocker('the recorded command really is a docker run', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'x.sh', 'echo ok\n')
  const job = sandboxed(script)
  const { runner } = makeSandboxRunner(job)

  const entry = await runner.run(job, { trigger: 'manual' })

  // The daemon may be absent: what matters here is what was started.
  assert.match(entry.command, /docker run --rm --name rota-/)
  assert.match(entry.command, /--network none/)
  assert.match(entry.command, /oven\/bun:1 sh \/rota\/x\.sh$/)
  assert.ok(entry.status === STATUS.SUCCESS || entry.status === STATUS.FAILED)
})

test('a job that is not isolated does not go through docker', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'x.sh', 'echo ok\n')
  const job = makeJob(script)
  const { runner } = makeSandboxRunner(job, { dockerPath: '/nulle/part/docker' })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS, 'docker absent n’a aucune incidence')
  assert.ok(!entry.command.includes('docker'))
})

// --- reports asked for by a script -------------------------------------------
//
// A script has no tools. The markers give it what `report` and `report_discord`
// give an agent, and the destination stays Rota's business: the script says
// what it has to say, the settings say where that goes.

const { REPORT, REPORT_DISCORD, END } = require('../src/runner/markers')

function withReports(job, { integrations = {} } = {}) {
  const windows = []
  const sent = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null }, integrations }),
      getJob: () => job,
      paths: { inlineDir: null },
    },
    history: { append: async (entry) => entry },
    ui: {
      async report(payload) {
        windows.push(payload)
      },
      async ask() {
        return { answered: false }
      },
      async confirm() {
        return { confirmed: false }
      },
    },
    discord: {
      available: true,
      async send(options) {
        sent.push(options)
        return { ok: true, messages: 1, dropped: 0 }
      },
    },
  })
  return { runner, windows, sent }
}

// The sends are not awaited — a slow server must not hold back the history
// entry — so we let the loop turn once before looking.
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a script opens a report window through its markers', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(
    dir,
    'report.sh',
    `echo "travail"\necho "${REPORT} Sync nocturne"\necho "## 3 fichiers"\necho "${END}"\n`,
  )
  const job = makeJob(script)
  const { runner, windows } = withReports(job)

  const entry = await runner.run(job)
  await settle()

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.deepEqual(windows, [{ title: 'Sync nocturne', markdown: '## 3 fichiers' }])
  // The marker stays in the output: the history shows what the script wrote.
  assert.match(entry.stdout, /::rota:report::/)
})

test("with no title, the window takes the job's name", async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'sans-titre.sh', `echo "${REPORT}"\necho "corps"\n`)
  const { runner, windows } = withReports(makeJob(script))

  await runner.run(makeJob(script))
  await settle()

  assert.equal(windows[0].title, 'Tâche de test')
})

test('report_discord goes to the channel without opening a window', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(
    dir,
    'discord.sh',
    `echo "${REPORT_DISCORD} Veille"\necho "trois articles"\necho "${END}"\n`,
  )
  const job = makeJob(script)
  const { runner, windows, sent } = withReports(job)

  await runner.run(job)
  await settle()

  assert.equal(windows.length, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '**Veille**\ntrois articles')
  assert.equal(sent[0].from, 'Tâche de test')
})

// Same mirror as an agent's `report`: a window assumes someone in front of the
// screen, which a scheduled job almost never has.
test('the report is mirrored to Discord according to the global setting', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'miroir.sh', `echo "${REPORT} T"\necho "corps"\n`)
  const job = makeJob(script)

  const avec = withReports(job, { integrations: { mirrorReportsToDiscord: true } })
  await avec.runner.run(job)
  await settle()
  assert.equal(avec.sent.length, 1, 'miroir expected')

  const sans = withReports(job, { integrations: { mirrorReportsToDiscord: false } })
  await sans.runner.run(job)
  await settle()
  assert.equal(sans.sent.length, 0, 'mirror refused')
  assert.equal(sans.windows.length, 1, 'the window opens all the same')
})

// A failed send is logged, not raised: the run went well, only its telling did
// not get through.
test('a failed Discord send compromises neither the entry nor the status', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'rate.sh', `echo "${REPORT_DISCORD} T"\necho "corps"\n`)
  const job = makeJob(script)
  const { runner } = withReports(job)
  runner.discord.send = async () => ({ ok: false, error: 'channel introuvable' })

  const entry = await runner.run(job)
  await settle()

  assert.equal(entry.status, STATUS.SUCCESS)
})

test('an output with no marker opens nothing', async (t) => {
  const dir = await workspace(t)
  const script = await shellScript(dir, 'muet.sh', 'echo "nothing to report"\n')
  const job = makeJob(script)
  const { runner, windows, sent } = withReports(job)

  await runner.run(job)
  await settle()

  assert.equal(windows.length + sent.length, 0)
})
