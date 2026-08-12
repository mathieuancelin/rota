'use strict'

// Starts the Vite development server then Electron once the port is open.
// Avoids a dependency on concurrently: this is exactly the kind of child-process
// orchestration Rota does elsewhere.

const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')

const PORT = 5273
// Vite may listen on only one address family: we try both.
const HOSTS = ['127.0.0.1', '::1']
const DEV_SERVER_URL = `http://localhost:${PORT}`
const ROOT = path.resolve(__dirname, '..')

const children = []
let shuttingDown = false

function bin(name) {
  return path.join(ROOT, 'node_modules', '.bin', name)
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

function tryConnect(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function waitForPort({ retries = 100, delayMs = 150 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const results = await Promise.all(HOSTS.map(tryConnect))
    if (results.some(Boolean)) return
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Le serveur Vite n'a pas répondu sur ${DEV_SERVER_URL}`)
}

async function main() {
  const vite = spawn(bin('vite'), [], { cwd: ROOT, stdio: 'inherit' })
  children.push(vite)
  vite.on('exit', (code) => shutdown(code ?? 0))

  await waitForPort()

  // Arguments after "--" are passed on to Electron (--remote-debugging-port, etc.).
  const electron = spawn(bin('electron'), ['.', ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
  })
  children.push(electron)
  electron.on('exit', (code) => shutdown(code ?? 0))
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

main().catch((err) => {
  console.error(err.message)
  shutdown(1)
})
