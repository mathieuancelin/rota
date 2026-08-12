'use strict'

// Ad-hoc signature of the bundle.
//
// With `identity: null`, electron-builder signs nothing: the bundle keeps only
// the Electron binary's "linker-signed" signature, whose identifier is still
// "Electron" and which does not cover the resources we added. macOS on Apple
// Silicon refuses to run a bundle whose signature no longer matches its
// contents. So we re-sign everything, without a certificate, which is enough
// for local use (but not for distribution: there is no notarisation).

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', 'com.rota.app', appPath],
    { stdio: 'inherit' },
  )
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' })

  console.log(`  • ad-hoc signature applied  file=${path.relative(process.cwd(), appPath)}`)
}
