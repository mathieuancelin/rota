'use strict'

// The tag and the manifests have to agree before anything is published.
//
// A release named v0.2.0 carrying binaries that answer `--version` with 0.1.0 is
// the kind of thing nobody notices until somebody is trying to work out which
// build they are running, months later, from a bug report. It costs one job to
// refuse.
//
//   node scripts/check-version.js v0.2.0

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/daemon/package.json',
  'packages/cli/package.json',
  'packages/app/package.json',
]

function main() {
  const tag = process.argv[2]
  if (!tag) {
    console.error('usage: node scripts/check-version.js <tag>')
    process.exit(2)
  }

  const wanted = tag.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(wanted)) {
    console.error(`"${tag}" is not a version tag — expected something like v1.2.3`)
    process.exit(2)
  }

  const wrong = []
  for (const manifest of MANIFESTS) {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(REPO, manifest), 'utf8'))
    if (version !== wanted) wrong.push({ manifest, name, version })
    console.log(`  ${version === wanted ? '✓' : '✗'} ${String(name).padEnd(20)} ${version}`)
  }

  if (wrong.length > 0) {
    console.error(
      `\n${wrong.length} manifest(s) do not say ${wanted}. ` +
        `Set them, commit, and move the tag — or tag the version they already carry.`,
    )
    process.exit(1)
  }

  console.log(`\nall ${MANIFESTS.length} manifests say ${wanted}`)
}

main()
