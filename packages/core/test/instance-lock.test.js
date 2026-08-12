'use strict'

// One engine per configuration directory.
//
// The case worth the most attention is the ugly one: a process killed with
// SIGKILL leaves its lock file behind, because nothing runs on the way out. A
// naive PID file refuses to start ever again after that; this one notices the
// process is gone and takes the directory.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  acquireInstanceLock,
  InstanceLockError,
  isProcessAlive,
  LOCK_FILENAME,
} = require('../src/instance-lock')

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root }
}

test('the first to ask gets the directory, and says so in the file', (t) => {
  const paths = workspace(t)
  const lock = acquireInstanceLock(paths, { pid: 4242, role: 'rotad' })

  const written = JSON.parse(fs.readFileSync(path.join(paths.root, LOCK_FILENAME), 'utf8'))
  assert.equal(written.pid, 4242)
  assert.equal(written.role, 'rotad')
  assert.ok(Date.parse(written.since) > 0)

  lock.release()
  assert.equal(fs.existsSync(lock.file), false)
})

test('a second engine on the same directory is refused, and told who holds it', (t) => {
  const paths = workspace(t)
  acquireInstanceLock(paths, { pid: 4242, role: 'rotad', isAlive: () => true })

  assert.throws(
    () => acquireInstanceLock(paths, { pid: 99, role: 'app', isAlive: () => true }),
    (err) => {
      assert.ok(err instanceof InstanceLockError)
      assert.equal(err.code, 'ELOCKED')
      assert.equal(err.holder.pid, 4242)
      // The message has to name the holder: "already running" without saying
      // what is running sends people to Activity Monitor.
      assert.match(err.message, /rotad/)
      assert.match(err.message, /4242/)
      assert.match(err.message, /--config-dir/)
      return true
    },
  )
})

test('a lock left by a process that is gone is taken, not respected', (t) => {
  const paths = workspace(t)
  acquireInstanceLock(paths, { pid: 4242, isAlive: () => true })

  // Same file, but this time nobody answers to that identifier.
  const lock = acquireInstanceLock(paths, { pid: 77, isAlive: () => false })
  const written = JSON.parse(fs.readFileSync(lock.file, 'utf8'))
  assert.equal(written.pid, 77)
})

test('a half-written lock file has nothing in it to respect', (t) => {
  const paths = workspace(t)
  fs.writeFileSync(path.join(paths.root, LOCK_FILENAME), '{"pid":')

  const lock = acquireInstanceLock(paths, { pid: 77, isAlive: () => true })
  assert.equal(JSON.parse(fs.readFileSync(lock.file, 'utf8')).pid, 77)
})

test('an empty lock file is stale too', (t) => {
  const paths = workspace(t)
  fs.writeFileSync(path.join(paths.root, LOCK_FILENAME), '')

  const lock = acquireInstanceLock(paths, { pid: 77, isAlive: () => true })
  assert.equal(JSON.parse(fs.readFileSync(lock.file, 'utf8')).pid, 77)
})

test('releasing never deletes a successor’s lock', (t) => {
  const paths = workspace(t)
  const first = acquireInstanceLock(paths, { pid: 4242, isAlive: () => true })

  // The first died, the second took over — and only then does the first get
  // round to tidying up.
  acquireInstanceLock(paths, { pid: 77, isAlive: () => false })
  first.release()

  assert.equal(fs.existsSync(first.file), true)
  assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).pid, 77)
})

test('a process killed with SIGKILL does not lock the directory forever', async (t) => {
  const paths = workspace(t)

  // A real process, really killed: nothing runs on the way out of SIGKILL, so
  // the lock file it leaves behind is the exact artefact we have to survive.
  const holder = spawn(process.execPath, [
    '-e',
    `const { acquireInstanceLock } = require(${JSON.stringify(require.resolve('../src/instance-lock'))});
     acquireInstanceLock({ root: ${JSON.stringify(paths.root)} }, { role: 'victim' });
     console.log('locked');
     setInterval(() => {}, 1000)`,
  ])

  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve)
    holder.once('error', reject)
  })

  const file = path.join(paths.root, LOCK_FILENAME)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, holder.pid)

  holder.kill('SIGKILL')
  await new Promise((resolve) => holder.once('exit', resolve))

  // The evidence of the crash is still there.
  assert.equal(fs.existsSync(file), true)

  const lock = acquireInstanceLock(paths, { role: 'rotad' })
  assert.equal(JSON.parse(fs.readFileSync(lock.file, 'utf8')).pid, process.pid)
  lock.release()
})

test('liveness is read from the operating system, not guessed', () => {
  assert.equal(isProcessAlive(process.pid), true)
  // Identifiers are not reused that fast, and nothing legitimate holds this one.
  assert.equal(isProcessAlive(0x7ffffff), false)
})
