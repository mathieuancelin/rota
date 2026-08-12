import { useEffect, useState } from 'react'

export default function Settings({ state }) {
  const { config, paths } = state
  const [errors, setErrors] = useState([])

  // The main process validates and may refuse. Without this feedback, a rejected
  // setting would stay displayed in its field without having been saved: nothing
  // would tell "accepted" from "lost".
  const patch = async (values) => {
    const result = await window.rota.patchConfig({ ...config, ...values })
    setErrors(result.ok ? [] : result.errors)
  }

  return (
    <section className="settings">
      {errors.length > 0 && (
        <div className="issue">
          <div className="file">Setting rejected</div>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <h2>General</h2>

      <Field
        label="Appearance"
        hint="“System” follows macOS and switches with it, sunset included."
      >
        <select value={config.theme} onChange={(event) => patch({ theme: event.target.value })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>

      <Toggle
        checked={config.launchAtLogin}
        onChange={(launchAtLogin) => patch({ launchAtLogin })}
        label="Launch at login"
        warning={state.autostart.reason}
      />

      <Toggle
        checked={config.schedulerPaused}
        onChange={(schedulerPaused) => window.rota.setSchedulerPaused(schedulerPaused)}
        label="Pause the scheduler"
        hint="Jobs stay loaded but are no longer triggered."
      />

      <h2>Notifications</h2>
      <NotificationStatus status={state.notifications} />

      <h2>Execution</h2>

      <Field label="Path to Bun" hint="Empty: looked up in PATH and the usual locations.">
        <input
          className="mono"
          type="text"
          placeholder="auto-detected"
          defaultValue={config.runners.bunPath ?? ''}
          onBlur={(event) => {
            const value = event.target.value.trim()
            patch({ runners: { ...config.runners, bunPath: value === '' ? null : value } })
          }}
        />
      </Field>

      <h2>Discord</h2>

      <DiscordStatus status={state.discord} config={config.integrations} />

      <Field
        label="Outgoing webhook"
        hint={
          'Used by the report_discord tool of agent jobs. ' +
          '${VARIABLE} is resolved from the environment or the .env file: ' +
          'a webhook URL is worth a password.'
        }
      >
        <input
          className="mono"
          type="text"
          placeholder="https://discord.com/api/webhooks/…"
          defaultValue={config.integrations.discordWebhookUrl ?? ''}
          onBlur={(event) => {
            const value = event.target.value.trim()
            patch({
              integrations: {
                ...config.integrations,
                discordWebhookUrl: value === '' ? null : value,
              },
            })
          }}
        />
      </Field>

      <Toggle
        checked={config.integrations.mirrorReportsToDiscord}
        onChange={(mirrorReportsToDiscord) =>
          patch({ integrations: { ...config.integrations, mirrorReportsToDiscord } })
        }
        label="Also publish agent reports to Discord"
        hint="The report tool opens its window and publishes. No effect without a destination."
      />

      <Toggle
        checked={config.integrations.discordControlEnabled}
        onChange={(discordControlEnabled) =>
          patch({ integrations: { ...config.integrations, discordControlEnabled } })
        }
        label="Control Rota from Discord"
        hint="Requires a bot and a channel. Anyone who can write in that channel can start a job — and a job can run system commands."
      />

      <Toggle
        checked={config.integrations.discordChatEnabled}
        onChange={(discordChatEnabled) =>
          patch({ integrations: { ...config.integrations, discordChatEnabled } })
        }
        label="Allow chatting with agents from Discord"
        hint="Adds the chat command. run executes the prompt a job carries; chat lets anyone in the channel write one."
      />

      <Field
        label="Bot token"
        hint="Required for control; a webhook can only write. ${VARIABLE} accepted."
      >
        <input
          className="mono"
          type="password"
          placeholder="no bot"
          defaultValue={config.integrations.discordBotToken ?? ''}
          onBlur={(event) => {
            const value = event.target.value.trim()
            patch({
              integrations: {
                ...config.integrations,
                discordBotToken: value === '' ? null : value,
              },
            })
          }}
        />
      </Field>

      <Field
        label="Channel identifier"
        hint="The only channel listened to, and the one the bot answers in. Right-click the channel → Copy ID, with developer mode enabled."
      >
        <input
          className="mono"
          type="text"
          placeholder="123456789012345678"
          defaultValue={config.integrations.discordChannelId ?? ''}
          onBlur={(event) => {
            const value = event.target.value.trim()
            patch({
              integrations: {
                ...config.integrations,
                discordChannelId: value === '' ? null : value,
              },
            })
          }}
        />
      </Field>

      <h2>Global memory</h2>

      <GlobalMemory />

      <h2>HTTP</h2>

      <HttpStatus status={state.http} config={config.http} />

      <Toggle
        checked={config.http.enabled}
        onChange={(enabled) => patch({ http: { ...config.http, enabled } })}
        label="Run the HTTP server"
        hint="Opens the port. Nothing is served until one of the two surfaces below is on as well, and a token is required."
      />

      <Toggle
        checked={config.http.apiEnabled}
        onChange={(apiEnabled) => patch({ http: { ...config.http, apiEnabled } })}
        label="Expose the API"
        hint="Run, stop, enable, history, logs, chat. This is remote control of the machine — a job can run system commands."
      />

      <Toggle
        checked={config.http.webhookEnabled}
        onChange={(webhookEnabled) => patch({ http: { ...config.http, webhookEnabled } })}
        label="Expose the webhook endpoint"
        hint="POST /webhook/<id> starts a job — and only one that declares a webhook trigger."
      />

      <Field
        label="Listening address"
        hint="127.0.0.1 keeps the server on this machine. 0.0.0.0 makes it reachable from the network, which a webhook coming from outside needs."
      >
        <input
          className="mono"
          type="text"
          placeholder="127.0.0.1"
          defaultValue={config.http.listen}
          onBlur={(event) => {
            const value = event.target.value.trim()
            patch({ http: { ...config.http, listen: value === '' ? '127.0.0.1' : value } })
          }}
        />
      </Field>

      <Field label="Port" hint="47823 by default, which is nothing well-known.">
        <input
          type="number"
          min="1"
          max="65535"
          defaultValue={config.http.port}
          onBlur={(event) =>
            patch({ http: { ...config.http, port: Number(event.target.value) } })
          }
        />
      </Field>

      <Field
        label="Token"
        hint="Sent as “Authorization: Bearer …”. Required — an open port with no password is reachable by anything running on this machine. ${VARIABLE} accepted."
      >
        <div className="field-actions">
          <input
            className="mono"
            type="password"
            placeholder="no token"
            defaultValue={config.http.token ?? ''}
            onBlur={(event) => {
              const value = event.target.value.trim()
              patch({ http: { ...config.http, token: value === '' ? null : value } })
            }}
          />
          <button
            type="button"
            onClick={async () => {
              const result = await window.rota.generateHttpToken()
              setErrors(result.ok ? [] : result.errors)
            }}
          >
            Generate
          </button>
        </div>
      </Field>

      <h2>History</h2>

      <Field label="Executions kept per job" hint="Default value, overridable in each job.">
        <input
          type="number"
          min="1"
          max="100000"
          defaultValue={config.defaults.retainExecutions}
          onBlur={(event) =>
            patch({
              defaults: { ...config.defaults, retainExecutions: Number(event.target.value) },
            })
          }
        />
      </Field>

      <Field
        label="Output kept inline (bytes)"
        hint="Beyond that, the full output goes to a separate file."
      >
        <input
          type="number"
          min="0"
          max="1048576"
          step="1024"
          defaultValue={config.defaults.inlineOutputBytes}
          onBlur={(event) =>
            patch({
              defaults: { ...config.defaults, inlineOutputBytes: Number(event.target.value) },
            })
          }
        />
      </Field>

      <h2>Data location</h2>
      <p className="mono muted">{paths.root}</p>
      <button onClick={() => window.rota.openConfigDir()}>Open the directory</button>
    </section>
  )
}

// A notification that does not arrive is indistinguishable from a silent job.
// When the system refuses one, we say so rather than leaving people searching.
function NotificationStatus({ status }) {
  if (!status.supported) {
    return <p className="muted">The system does not provide notifications.</p>
  }
  if (!status.lastFailure) {
    return (
      <p className="muted">
        Each job picks its notifications in its <code>notifications</code> field.
      </p>
    )
  }
  return (
    <div className="issue">
      <div className="file">macOS rejected the last notification</div>
      <p>
        Allow Rota under System Settings → Notifications. Started from{' '}
        <code>npm start</code>, the application presents itself as “Electron” and is usually not
        allowed: the packaged application is.
      </p>
      <p className="mono muted">{status.lastFailure.reason}</p>
    </div>
  )
}

// A bot that has dropped out is indistinguishable from a channel where nobody
// writes: without this state, one types commands into the void with no idea why.
/**
 * Global memory: what every agent job finds again.
 *
 * It is merged with each job's own at read time, and the local one wins at equal
 * keys. This is where one writes who one is, on which machine, and what holds
 * everywhere — rather than copying it into every system prompt, where it would
 * age job by job.
 *
 * The file stays editable by hand: this panel reads and writes in the same
 * place, and says so rather than suggesting a hidden database.
 */
function GlobalMemory() {
  const [entries, setEntries] = useState([])
  const [file, setFile] = useState('')
  const [draft, setDraft] = useState({ key: '', value: '' })
  const [error, setError] = useState(null)

  const reload = async () => {
    const result = await window.rota.readGlobalMemory()
    if (!result.ok) return
    setEntries(result.entries)
    setFile(result.file)
  }

  useEffect(() => {
    reload()
  }, [])

  const save = async (key, value) => {
    const result = await window.rota.writeGlobalMemory(key, value)
    setError(result.ok ? null : result.errors.join(' | '))
    if (result.ok) await reload()
    return result.ok
  }

  return (
    <>
      <p className="muted">
        Merged into every agent job’s memory, listed by key in its instructions like the rest. A
        job that writes the same key overrides it for itself. Also editable in <code>{file}</code>.
      </p>

      {error && (
        <div className="issue">
          <div className="file">Entry rejected</div>
          <p>{error}</p>
        </div>
      )}

      {entries.map((entry) => (
        <Field
          key={entry.key}
          label={entry.key}
          hint={entry.updatedAt ? `Updated ${new Date(entry.updatedAt).toLocaleString('en-GB')}` : ''}
        >
          <div className="field-actions">
            <textarea
              rows={2}
              defaultValue={entry.value}
              onBlur={(event) => {
                if (event.target.value !== entry.value) save(entry.key, event.target.value)
              }}
            />
            <button
              type="button"
              className="danger"
              onClick={async () => {
                await window.rota.deleteGlobalMemory(entry.key)
                await reload()
              }}
            >
              Forget
            </button>
          </div>
        </Field>
      ))}

      <Field label="New entry" hint="A short, stable key — “me/identity”, “machine”, “conventions”.">
        <div className="field-actions">
          <input
            className="mono"
            type="text"
            placeholder="key"
            value={draft.key}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
          <input
            type="text"
            placeholder="value"
            value={draft.value}
            onChange={(event) => setDraft({ ...draft, value: event.target.value })}
          />
          <button
            type="button"
            disabled={draft.key.trim() === '' || draft.value.trim() === ''}
            onClick={async () => {
              if (await save(draft.key.trim(), draft.value)) setDraft({ key: '', value: '' })
            }}
          >
            Remember
          </button>
        </div>
      </Field>
    </>
  )
}

/**
 * State of the HTTP server.
 *
 * Two situations deserve saying rather than guessing: a port that listens
 * without exposing anything — the box was ticked, and nothing answers — and
 * listening somewhere other than loopback, where the token becomes the only
 * barrier between the network and this machine.
 */
function HttpStatus({ status, config }) {
  if (!config.enabled) return <p className="muted">Server off. Nothing is listening.</p>

  if (status.state === 'failed') {
    return (
      <div className="issue">
        <div className="file">Server not started</div>
        <p>{status.error}</p>
      </div>
    )
  }

  if (status.state !== 'listening') {
    return <p className="muted">Starting…</p>
  }

  const exposed = [config.apiEnabled && 'API', config.webhookEnabled && 'webhook'].filter(Boolean)
  const reachable = config.listen !== '127.0.0.1' && config.listen !== 'localhost'

  return (
    <>
      <p className="tone-ok">
        Listening on <code>{status.url}</code>
        {exposed.length > 0 ? ` — ${exposed.join(' and ')}.` : '.'}
      </p>
      {config.apiEnabled && (
        <p className="muted">
          The API describes itself at <code>{status.url}/api/docs</code> — open it in a browser
          and paste the token.
        </p>
      )}
      {exposed.length === 0 && (
        <p className="muted">
          Neither surface is on: the port answers 404 to everything. Turn on the API, the webhook,
          or both.
        </p>
      )}
      {reachable && (
        <div className="issue">
          <div className="file">Reachable from the network</div>
          <p>
            The server does not listen on loopback only. The token is the sole thing between the
            network and this machine — and a job can run system commands.
          </p>
        </div>
      )}
    </>
  )
}

function DiscordStatus({ status, config }) {
  if (!config.discordControlEnabled) {
    return <p className="muted">Control disabled. Reports can still go out.</p>
  }
  if (status.state === 'connected') {
    // Connected and in no server: a token holds for the application, it invites
    // it nowhere. Without this line, the state says "all is well" while nothing
    // can happen.
    if (status.guilds === 0) {
      return (
        <div className="issue">
          <div className="file">Connected, but in no server</div>
          <p>
            The token is valid — the bot has simply never been invited. Open the OAuth2 URL of
            your application, with the <code>bot</code> scope and the “Read Messages” and “Send
            Messages” permissions, and pick your server.
          </p>
        </div>
      )
    }
    return (
      <p className="tone-ok">
        Connected{status.user ? ` as ${status.user}` : ''}. Write “&nbsp;@Rota help&nbsp;” in
        the channel.
      </p>
    )
  }
  if (status.state === 'failed') {
    return (
      <div className="issue">
        <div className="file">Connection refused</div>
        <p>{status.error}</p>
        <p className="muted">The bot will not be restarted until the setting changes.</p>
      </div>
    )
  }
  const labels = {
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    disabled: 'Inactive: missing token or channel.',
    stopped: 'Stopped.',
  }
  return <p className="muted">{labels[status.state] ?? status.state}</p>
}

function Toggle({ checked, onChange, label, hint, warning }) {
  return (
    <label className="setting">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
        {warning && <small className="tone-warn">{warning}</small>}
      </span>
    </label>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="setting field">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  )
}
