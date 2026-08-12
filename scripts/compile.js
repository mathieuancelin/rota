'use strict'

// The two binaries, for the four targets a release ships.
//
// `bun build --compile` inlines everything: ajv, both JSON schemas, the whole
// engine. What comes out opens a configuration directory on a machine with
// neither Node nor Bun on it, which is the point — a scheduler you have to
// install a runtime for is a scheduler you install once and never move.
//
// The Electron application is not compiled here. It keeps Vite for the renderer
// and electron-builder for the .dmg, and it ships a copy of rotad beside
// itself (see packages/app/scripts/bundle-daemon.js).

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const OUT = path.join(REPO, 'dist')

const BINARIES = [
  { name: 'rotad', entry: 'packages/daemon/src/index.js' },
  { name: 'rotactl', entry: 'packages/cli/src/index.js' },
]

const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64']

function main() {
  // A single target, for the impatient: `npm run compile -- darwin-arm64`.
  const only = process.argv.slice(2)
  const targets = only.length > 0 ? TARGETS.filter((t) => only.some((o) => t.includes(o))) : TARGETS

  if (targets.length === 0) {
    console.error(`no target matches ${only.join(', ')} — known targets: ${TARGETS.join(', ')}`)
    process.exit(2)
  }

  fs.mkdirSync(OUT, { recursive: true })

  for (const target of targets) {
    const suffix = target.replace(/^bun-/, '')
    for (const { name, entry } of BINARIES) {
      const outFile = path.join(OUT, `${name}-${suffix}`)
      execFileSync(
        'bun',
        ['build', path.join(REPO, entry), '--compile', `--target=${target}`, '--outfile', outFile],
        { stdio: 'inherit', cwd: REPO },
      )
      const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(0)
      console.log(`  • ${path.relative(REPO, outFile)}  ${size}MB`)
    }
  }
}

main()
