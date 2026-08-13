'use strict'

// Everything, in the order it has to happen.
//
// The individual commands already exist — `npm test`, `npm run build`,
// `npm run compile`, `npm run package`. What this adds is the order, the
// prerequisites checked before an hour of work rather than after it, and one
// summary at the end saying what exists and how big it is.
//
//   node scripts/build.js                    install, test, renderer, binaries, app
//   node scripts/build.js --clean            the same, from an empty tree
//   node scripts/build.js --skip-tests       when you have just run them
//   node scripts/build.js --all-targets      the four binary targets, not just this one
//   node scripts/build.js --help
//
// Not included, on purpose: `npm run icons` and `npm run screenshots`. Both
// write files that are committed, both are answers to "the design changed"
// rather than to "build it", and a build that quietly rewrote either would make
// every rebuild look like a diff.

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const OPTIONS = new Set(process.argv.slice(2))

const FLAGS = [
  ['--clean', 'remove node_modules and every build output first'],
  ['--skip-tests', 'do not run the suites'],
  ['--skip-binaries', 'do not compile rotad and rotactl'],
  ['--skip-app', 'do not package the Electron application'],
  ['--all-targets', 'compile the four binary targets rather than this machine’s'],
  ['-h, --help', 'this'],
]

const bold = (text) => (process.stdout.isTTY ? `[1m${text}[0m` : text)
const dim = (text) => (process.stdout.isTTY ? `[2m${text}[0m` : text)
const red = (text) => (process.stdout.isTTY ? `[31m${text}[0m` : text)

let step = 0
const started = Date.now()

function heading(title) {
  step += 1
  console.log(`\n${bold(`[${step}] ${title}`)}`)
}

function run(command, args, { cwd = REPO } = {}) {
  console.log(dim(`    ${command} ${args.join(' ')}`))
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function has(command) {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0
}

function size(file) {
  const bytes = fs.statSync(file).size
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(0)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`
}

/**
 * Node 22, and not by preference.
 *
 * The shell's default is often older, and an old one does not fail where you
 * would notice: Electron's postinstall requires `@electron/get`, which is ESM,
 * so the install dies with ERR_REQUIRE_ESM — and `npm test` invents about
 * twenty failures that have nothing to do with the code. Both are confusing
 * enough to be worth one check up front.
 */
function checkNode() {
  const wanted = fs.readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim()
  const [major] = process.versions.node.split('.').map(Number)
  const [wantedMajor] = wanted.split('.').map(Number)

  console.log(`    node ${process.versions.node}   ${dim(`(.nvmrc says ${wanted})`)}`)
  if (major < wantedMajor) {
    throw new Error(
      `Node ${process.versions.node} is too old — this needs ${wanted}.\n` +
        '    Run `nvm use` and try again: an older Node fails the install with\n' +
        '    ERR_REQUIRE_ESM and invents test failures that are not in the code.',
    )
  }
}

function clean() {
  const targets = [
    'node_modules',
    'dist',
    'packages/app/dist',
    'packages/app/release',
    'packages/app/bin',
    // Left behind by an install that used a different linker. They shadow the
    // hoisted tree with symlinks into a node_modules/.bun that no longer
    // exists, and then nothing resolves — not even ajv.
    ...['core', 'daemon', 'cli', 'app'].map((p) => `packages/${p}/node_modules`),
  ]
  for (const target of targets) {
    const full = path.join(REPO, target)
    if (!fs.existsSync(full)) continue
    fs.rmSync(full, { recursive: true, force: true })
    console.log(dim(`    removed ${target}`))
  }
}

function hostTarget() {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${platform}-${arch}`
}

function artefacts() {
  const found = []
  const dist = path.join(REPO, 'dist')
  if (fs.existsSync(dist)) {
    for (const name of fs.readdirSync(dist).sort()) {
      found.push([path.join('dist', name), size(path.join(dist, name))])
    }
  }

  const release = path.join(REPO, 'packages/app/release')
  if (fs.existsSync(release)) {
    for (const name of fs.readdirSync(release).sort()) {
      if (!/\.(dmg|AppImage|deb|zip)$/.test(name)) continue
      found.push([path.join('packages/app/release', name), size(path.join(release, name))])
    }
  }
  return found
}

function main() {
  if (OPTIONS.has('--help') || OPTIONS.has('-h')) {
    console.log('Builds everything: dependencies, suites, renderer, binaries, application.\n')
    console.log('Usage: node scripts/build.js [options]\n')
    for (const [flag, text] of FLAGS) console.log(`  ${flag.padEnd(16)} ${text}`)
    console.log('\nIcons and screenshots are not rebuilt here — see `npm run icons` and')
    console.log('`npm run screenshots`, which rewrite committed files.')
    return 0
  }

  heading('Prerequisites')
  checkNode()

  const bun = has('bun')
  console.log(`    bun ${bun ? execFileSync('bun', ['--version']).toString().trim() : red('not installed')}`)
  if (!bun) {
    // Bun installs the workspace and compiles the binaries. Without it there is
    // no point starting.
    throw new Error('bun is required to install this workspace — see https://bun.sh')
  }

  if (OPTIONS.has('--clean')) {
    heading('Clean')
    clean()
  }

  heading('Dependencies')
  run('bun', ['install'])

  if (!OPTIONS.has('--skip-tests')) {
    heading('Suites')
    run('npm', ['test'])

    // The daemon ships as a Bun binary and the application runs the same code
    // under Electron's Node. A divergence between the two is a bug you would
    // otherwise meet in production.
    heading('Suites, under Bun')
    run('node', ['scripts/test-bun.js'])
  }

  heading('Renderer')
  run('npm', ['run', 'build', '--workspace', 'rota'])

  if (!OPTIONS.has('--skip-binaries')) {
    const targets = OPTIONS.has('--all-targets') ? [] : [hostTarget()]
    heading(`Binaries${targets.length ? ` (${targets[0]})` : ' (all four targets)'}`)
    run('node', ['scripts/compile.js', ...targets])
  }

  if (!OPTIONS.has('--skip-app')) {
    heading(`Application (${process.platform})`)
    if (process.platform === 'win32') {
      console.log('    skipped: Windows is not a supported platform')
    } else {
      // electron-builder packages for the machine it runs on. Cross-packaging a
      // macOS bundle from Linux is possible in principle and not something this
      // repository does: the .app is ad-hoc signed by build/after-pack.js, and
      // codesign only exists on macOS.
      run('node', ['packages/app/scripts/bundle-daemon.js'])
      run('npx', ['electron-builder', '--publish', 'never'], {
        cwd: path.join(REPO, 'packages/app'),
      })
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`\n${bold('Built')} in ${Math.floor(seconds / 60)} min ${seconds % 60} s\n`)

  const found = artefacts()
  if (found.length === 0) {
    console.log('  nothing to show — every producing step was skipped')
  } else {
    const width = Math.max(...found.map(([name]) => name.length))
    for (const [name, bytes] of found) console.log(`  ${name.padEnd(width)}  ${bytes}`)
  }

  if (process.platform === 'darwin' && !OPTIONS.has('--skip-app')) {
    console.log(
      `\n${dim('  The .dmg is ad-hoc signed, not notarized: on another machine, first launch')}` +
        `\n${dim('  is right-click → Open.')}`,
    )
  }
  return 0
}

try {
  process.exit(main())
} catch (err) {
  console.error(`\n${red('Failed')} at step ${step}: ${err.message}\n`)
  process.exit(1)
}
