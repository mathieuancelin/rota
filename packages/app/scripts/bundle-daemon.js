'use strict'

// Compiles rotad into the application bundle.
//
// The application embeds the engine and needs no daemon to work — that is the
// whole point of embedded being the default. This is for the other direction:
// somebody who installs the build, later wants the scheduler to keep running
// with no window open, and would otherwise have to find a second download for a
// binary built from the code already sitting in their applications folder.
//
// It is the same engine either way, so shipping it costs a copy and nothing
// else. Cheap here, awkward to retrofit.
//
//   node scripts/bundle-daemon.js [platform] [arch]     defaults to this machine

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const ENTRY = path.join(REPO, 'packages', 'daemon', 'src', 'index.js')

// The application only ships where it is packaged, so this list is exactly the
// set of platforms electron-builder is pointed at — no more.
const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
}

function main() {
  const platform = process.argv[2] ?? process.platform
  const arch = process.argv[3] ?? process.arch
  const target = TARGETS[`${platform}-${arch}`]

  const outDir = path.join(ROOT, 'bin')
  const outFile = path.join(outDir, 'rotad')

  if (!target) {
    console.error(`  • no daemon target for ${platform}-${arch} — packaging without one`)
    fs.rmSync(outDir, { recursive: true, force: true })
    return
  }

  // A stale binary from a previous target would be shipped for the wrong
  // architecture, which is worse than shipping none: it fails at the moment
  // somebody actually tries to use it.
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  try {
    execFileSync(
      'bun',
      ['build', ENTRY, '--compile', `--target=${target}`, '--outfile', outFile],
      { stdio: 'inherit' },
    )
  } catch (err) {
    // Bun is a build-time dependency of the daemon, not of the application. If
    // it is missing, say so and carry on: an application without a daemon
    // beside it is still a complete application.
    console.error(`  • bun could not compile the daemon (${err.message.split('\n')[0]})`)
    console.error('  • packaging without it — the application embeds the engine anyway')
    fs.rmSync(outDir, { recursive: true, force: true })
    return
  }

  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(0)
  console.log(`  • rotad compiled  target=${target} size=${size}MB`)
}

main()
