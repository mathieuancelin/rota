'use strict'

// The screenshots in the documentation, taken from the real application.
//
// Not mockups, and not taken by hand: this seeds a throwaway configuration
// directory with sample jobs and a plausible history, starts the application
// against it, and captures the page over the DevTools protocol — which the app
// already exposes, because `npm start -- --remote-debugging-port=9222` is a
// documented thing to do.
//
// It is a script rather than four PNGs somebody dragged in, for one reason:
// pictures of an interface rot silently. When the interface moves, running this
// again is the whole cost of fixing them.
//
//   node scripts/screenshots.js [outputDir]
//
// The data is invented — sample jobs with ordinary names, a history assembled
// here. It is a picture of the interface, not a record of anything that ran.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP = path.resolve(__dirname, '..')
const REPO = path.resolve(APP, '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron')
const PORT = 9333
const OUT = process.argv[2] ?? path.join(REPO, 'docs', 'images')

// --- the sample configuration -----------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-screenshots-'))
for (const dir of ['jobs', 'history', 'scripts', 'logs']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true })
}

// Paths that read well in a screenshot. Nothing here is ever executed: the
// scheduler is given a state where no occurrence is due, so a picture of the
// interface stays a picture rather than becoming a test run.
const script = (name) => `/Users/you/scripts/${name}`
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

const JOBS = [
  {
    id: 'sync-notes',
    name: 'Sync notes',
    description: 'Commit, pull --rebase and push the notes vault.',
    triggers: [{ type: 'interval', every: 15, unit: 'minutes' }],
    runner: { type: 'bun', script: script('sync-notes.js') },
    // The job from the SSH story in the README: it needs the keychain, so it
    // waits rather than failing forty times in a row.
    execution: { requiresUnlockedSession: true, timeoutSeconds: 120 },
  },
  {
    id: 'morning-digest',
    name: 'Morning digest',
    description: 'Read the release feeds I follow and say what actually changed.',
    triggers: [{ type: 'cron', expression: '30 7 * * 1-5' }],
    runner: {
      type: 'agent',
      agent: {
        model: 'qwen2.5:14b',
        api: { baseUrl: 'http://localhost:11434/v1' },
        // Written across several lines because that is how a prompt is actually
        // written, and because one long line in an editor is a bad picture.
        prompt: [
          'Check the changelogs of the projects you have in memory.',
          '',
          'Report only what changed since the last run, in five lines or fewer.',
          'Say "nothing worth reading" when that is the honest answer — a digest',
          'that pads itself is one nobody opens twice.',
          '',
          'Remember the versions you saw, so tomorrow can be shorter.',
        ].join('\n'),
      },
    },
    execution: { timeoutSeconds: 600 },
  },
  {
    id: 'backup-photos',
    name: 'Back up photos',
    description: 'rsync the camera roll to the NAS.',
    triggers: [{ type: 'cron', expression: '0 3 * * *' }],
    runner: { type: 'shell', script: script('backup.sh') },
    execution: { timeoutSeconds: 3600 },
  },
  {
    id: 'weekly-report',
    name: 'Weekly report',
    description: 'Collect the week, then have the agent write it up.',
    triggers: [{ type: 'cron', expression: '0 18 * * 5' }],
    runner: {
      type: 'workflow',
      workflow: {
        steps: [
          { name: 'Sync first', job: 'sync-notes' },
          { name: 'Collect', runner: { type: 'shell', script: script('collect.sh') } },
        ],
      },
    },
  },
  {
    id: 'certificate-watch',
    name: 'Certificate watch',
    description: 'Warn a fortnight before anything expires.',
    enabled: false,
    triggers: [{ type: 'cron', expression: '0 9 * * 1' }],
    runner: { type: 'shell', script: script('certs.sh') },
  },
]

for (const job of JOBS) {
  fs.writeFileSync(
    path.join(root, 'jobs', `${job.id}.json`),
    JSON.stringify(
      {
        $schema: 'https://rota.local/schemas/job.schema.json',
        enabled: true,
        notifications: { onStart: false, onSuccess: false, onChange: true, onError: true },
        history: { enabled: true, retainExecutions: 500 },
        ...job,
      },
      null,
      2,
    ),
  )
}

// Mostly green, one failure with a message that says something. A history where
// nothing ever broke would be a picture of the wrong product.
const RUNS = {
  'sync-notes': [
    { at: minutesAgo(12), status: 'success', ms: 2140, out: '3 files pushed\n', change: '3 files pushed' },
    { at: minutesAgo(27), status: 'success', ms: 1980, out: 'nothing to commit, working tree clean\n' },
    { at: minutesAgo(42), status: 'success', ms: 2260, out: '1 file pushed\n', change: '1 file pushed' },
    { at: minutesAgo(57), status: 'success', ms: 1875, out: 'nothing to commit, working tree clean\n' },
    { at: minutesAgo(72), status: 'success', ms: 2030, out: 'nothing to commit, working tree clean\n' },
  ],
  'morning-digest': [
    {
      at: hoursAgo(6),
      status: 'success',
      ms: 48_210,
      out: 'Bun 1.3.14 — the isolated installer is now the default.\nVite 8.2 — nothing that touches us.\n',
      change: 'Bun 1.3.14, Vite 8.2',
    },
    { at: hoursAgo(30), status: 'success', ms: 51_330, out: 'nothing worth reading\n' },
  ],
  'backup-photos': [
    {
      at: hoursAgo(9),
      status: 'failed',
      ms: 4120,
      out: 'sending incremental file list\n',
      err: 'rsync: [sender] connection unexpectedly closed (0 bytes received so far)\nrsync error: error in rsync protocol data stream (code 12)\n',
      error: 'rsync exited with code 12',
    },
    { at: hoursAgo(33), status: 'success', ms: 184_300, out: 'sent 1.24G bytes  received 4.1K bytes\n' },
  ],
  'weekly-report': [{ at: hoursAgo(70), status: 'success', ms: 62_400, out: 'report written\n' }],
}

const lastRuns = {}
const recentErrors = []
for (const [jobId, runs] of Object.entries(RUNS)) {
  const lines = runs.map((run, index) => ({
    executionId: `${jobId}-${String(index).padStart(2, '0')}`,
    jobId,
    jobName: JOBS.find((j) => j.id === jobId).name,
    trigger: 'schedule',
    startedAt: run.at,
    finishedAt: new Date(Date.parse(run.at) + run.ms).toISOString(),
    durationMs: run.ms,
    status: run.status,
    exitCode: run.status === 'success' ? 0 : 12,
    signal: null,
    command: `sh ${script('…')}`,
    workingDirectory: root,
    stdout: run.out ?? '',
    stderr: run.err ?? '',
    stdoutTruncated: false,
    stderrTruncated: false,
    change: run.change ?? null,
    error: run.error ?? null,
    outputFiles: null,
  }))

  fs.writeFileSync(
    path.join(root, 'history', `${jobId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  )

  const [last] = lines
  // Recorded as having just happened, whatever the history says, so that no
  // occurrence is missed and the catch-up rule has nothing to catch up.
  lastRuns[jobId] = {
    at: new Date(Date.now() - 60_000).toISOString(),
    status: last.status,
    durationMs: last.durationMs,
    executionId: last.executionId,
  }

  for (const line of lines.filter((entry) => entry.status === 'failed')) {
    recentErrors.push({
      jobId,
      name: line.jobName,
      at: line.finishedAt,
      executionId: line.executionId,
      status: line.status,
    })
  }
}

fs.writeFileSync(
  path.join(root, 'state.json'),
  JSON.stringify({ lastRuns, recentErrors, acknowledgedErrorsAt: null }, null, 2),
)
// Dark: it is what a menu bar application is looked at against most of the day.
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ theme: 'dark' }, null, 2))

// --- driving it ---------------------------------------------------------------------

const app = spawn(ELECTRON, [APP, `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  env: { ...process.env, ROTA_CONFIG_DIR: root },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
app.stdout.on('data', (chunk) => (log += chunk))
app.stderr.on('data', (chunk) => (log += chunk))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function debuggablePage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools://'))
      if (page) return page
    } catch {
      // The port is not open yet, which is the usual first few attempts.
    }
    await sleep(500)
  }
  throw new Error(`no debuggable page on ${PORT}\n${log.slice(-1500)}`)
}

/** A thin DevTools protocol client: connect, send, await the matching reply. */
async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })

  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle) {
      pending.delete(message.id)
      settle(message.result)
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageId = ++id
      pending.set(messageId, resolve)
      socket.send(JSON.stringify({ id: messageId, method, params }))
    })

  return { send, close: () => socket.close() }
}

/**
 * Clicks the first element whose visible text is exactly `label`.
 *
 * Driven through the page rather than by dispatching mouse events at
 * coordinates: a click at (412, 208) is a screenshot script that breaks the next
 * time a heading gains a word.
 */
const clickByText = (label) => `
  (() => {
    const wanted = ${JSON.stringify(label)}
    const nodes = [...document.querySelectorAll('button, a, [role="button"], li, tr')]
    const hit = nodes.find((node) => node.textContent.trim() === wanted)
      ?? nodes.find((node) => node.textContent.trim().startsWith(wanted))
    if (!hit) return 'not found: ' + wanted
    hit.click()
    return 'clicked: ' + wanted
  })()
`

const SHOTS = [
  {
    name: 'dashboard',
    caption: 'what it looks like when something broke',
    steps: [],
  },
  {
    name: 'jobs',
    caption: 'every job, when it runs next, how it went last time',
    steps: ['Jobs'],
  },
  {
    name: 'agent-job',
    caption: 'a job described rather than scripted',
    // The Prompt tab, not the form: what makes an agent job worth showing is
    // the paragraph, not the fields it shares with every other kind.
    steps: ['Jobs', 'Morning digest', 'Prompt'],
  },
  {
    name: 'history',
    caption: 'the record a failure is diagnosed from',
    steps: ['Jobs', 'Back up photos', 'History'],
  },
]

async function main() {
  const page = await debuggablePage()
  const { send, close } = await connect(page)

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 760,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await sleep(1500)

  fs.mkdirSync(OUT, { recursive: true })
  console.log(`capturing ${SHOTS.length} views into ${path.relative(REPO, OUT)}/\n`)

  for (const shot of SHOTS) {
    // Back to a known place: the steps are written from the dashboard, so each
    // shot is independent of the one before it.
    await send('Runtime.evaluate', { expression: clickByText('Dashboard') })
    await sleep(400)

    for (const step of shot.steps) {
      const { result } = await send('Runtime.evaluate', { expression: clickByText(step) })
      if (String(result?.value).startsWith('not found')) {
        throw new Error(`${shot.name}: ${result.value} — the interface moved, and so must this script`)
      }
      await sleep(700)
    }
    await sleep(500)

    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, `${shot.name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  ${shot.name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)}KB  — ${shot.caption}`)
  }

  close()
  app.kill('SIGTERM')
  await sleep(500)
  process.exit(0)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`)
  app.kill('SIGKILL')
  process.exit(1)
})
