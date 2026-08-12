'use strict'

// Init-system units, printed and never installed.
//
// Writing into LaunchAgents or calling `systemctl enable` is a decision about
// what a machine does at every login, and it is not ours to take on somebody's
// behalf. So we print the file, correct and complete, and say where it goes.
// Redirecting it there is one shell operator away, and it is the user who types
// it.

const path = require('node:path')

const LABEL = 'com.rota.daemon'

/** &, <, > and quotes inside a path would otherwise produce an invalid plist. */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * A launchd user agent: it runs in the graphical session, which is the whole
 * point — a job needing the keychain, or an unlocked screen, gets neither from
 * a system daemon.
 *
 * @param {{binary: string, configDir: string, logsDir?: string, label?: string}} options
 */
function launchdPlist({ binary, configDir, logsDir = path.join(configDir, 'logs'), label = LABEL }) {
  const args = [binary, 'run', '--config-dir', configDir]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>

    <key>ProgramArguments</key>
    <array>
${args}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <!-- Restarted if it dies. It is not restarted when it exits cleanly on
         SIGTERM, which is what stopping it should mean. -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>

    <!-- The daemon keeps its own log; these two catch what escapes it, which is
         mostly a crash worth reading. -->
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(logsDir, 'rotad.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(logsDir, 'rotad.err.log'))}</string>

    <!-- Background: no App Nap, and a scheduling policy that suits something
         which mostly waits. -->
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`
}

/**
 * A systemd *user* unit, for the same reason the launchd one is an agent.
 *
 * @param {{binary: string, configDir: string}} options
 */
function systemdUnit({ binary, configDir }) {
  return `[Unit]
Description=Rota daemon
Documentation=https://github.com/mathieuancelin/rota
After=network-online.target

[Service]
Type=simple
ExecStart=${binary} run --config-dir ${configDir}
# A job may outlive a stop request by the length of its timeout; give it the
# time the runner would have given it before insisting.
KillSignal=SIGTERM
TimeoutStopSec=60
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/**
 * What to do with the file we just printed. Sent to stderr by the command, so
 * that redirecting stdout into the unit file leaves the unit file clean.
 */
function installationNotes(kind, { configDir, label = LABEL }) {
  if (kind === 'launchd') {
    const target = `~/Library/LaunchAgents/${label}.plist`
    return [
      `# Nothing has been installed. To install it yourself:`,
      `#   rotad service launchd --config-dir ${configDir} > ${target}`,
      `#   launchctl bootstrap gui/$(id -u) ${target}`,
      `# and to stop it:`,
      `#   launchctl bootout gui/$(id -u)/${label}`,
    ].join('\n')
  }

  return [
    `# Nothing has been installed. To install it yourself:`,
    `#   rotad service systemd --config-dir ${configDir} > ~/.config/systemd/user/rotad.service`,
    `#   systemctl --user daemon-reload && systemctl --user enable --now rotad`,
    `# and to stop it:`,
    `#   systemctl --user disable --now rotad`,
  ].join('\n')
}

module.exports = { launchdPlist, systemdUnit, installationNotes, escapeXml, LABEL }
