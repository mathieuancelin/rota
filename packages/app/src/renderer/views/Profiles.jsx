import { useCallback, useEffect, useRef, useState } from 'react'

import monaco, { profileModelUri, sourceModelUri, themeName } from '../monaco.js'
import { correctedSelection, selectedProfile } from './profiles-model.mjs'

// Reusable agents: who does the work, as opposed to the jobs, which say what is
// run.
//
// One view rather than a list and an editor: a profile is a short file, and the
// question one arrives with — "what is this agent made of, and who leans on it"
// — is answered by looking at it. So the list is on the left, the file on the
// right, and the jobs using it under the file, because that is what has to be
// checked before touching a system prompt several of them share.
//
// The editor is Monaco over the JSON rather than a generated form. The job form
// is derived from the schema and could probably be turned to this, but that is a
// piece of work in itself — and the shape of a profile has yet to live a little.

const EDITOR_OPTIONS = {
  language: 'json',
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  tabSize: 2,
}

export default function Profiles({ state, onOpenJob }) {
  const profiles = state.profiles ?? []
  const [selected, setSelected] = useState(profiles[0]?.id ?? null)
  const [creating, setCreating] = useState(false)

  // Resolved from the list rather than trusted from the identifier — see
  // profiles-model.mjs for why that distinction matters.
  const current = selectedProfile(profiles, selected)

  // And once the state has caught up, the selection is tidied.
  useEffect(() => {
    const corrected = correctedSelection(profiles, selected)
    if (corrected !== undefined) setSelected(corrected)
  }, [profiles, selected])

  return (
    <section className="profiles">
      <div className="list-header">
        <h2>Agents</h2>
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            New agent
          </button>
        )}
      </div>

      {creating && (
        <NewProfile
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            setSelected(id)
          }}
        />
      )}

      {profiles.length === 0 && !creating && (
        <p className="muted">
          No reusable agent yet. One holds what a job’s <code>agent</code> block holds — model,
          instructions, tools, memory — and several jobs can then point at it with{' '}
          <code>"agent": "&lt;id&gt;"</code>, sharing what it has learnt. The quickest way to a first
          one is the <strong>Extract as agent</strong> button on an agent job.
        </p>
      )}

      {profiles.length > 0 && (
        <div className="profiles-split">
          <ul className="profiles-list">
            {profiles.map((profile) => (
              <li key={profile.id}>
                <button
                  className={`profile-row ${selected === profile.id ? 'active' : ''}`}
                  onClick={() => setSelected(profile.id)}
                >
                  <span className="profile-name">{profile.name}</span>
                  <span className="muted">{profile.model}</span>
                  <span className="muted">
                    {profile.usedBy.length === 0
                      ? 'unused'
                      : `${profile.usedBy.length} job${profile.usedBy.length > 1 ? 's' : ''}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {current && (
            <ProfileEditor
              key={current.id}
              profile={current}
              onOpenJob={onOpenJob}
              onDeleted={() => setSelected(null)}
            />
          )}
        </div>
      )}
    </section>
  )
}

function NewProfile({ onCancel, onCreated }) {
  const [id, setId] = useState('')
  const [errors, setErrors] = useState([])

  const create = async () => {
    const result = await window.rota.createProfile(id.trim())
    if (!result.ok) return setErrors(result.errors)
    onCreated(id.trim())
  }

  return (
    <div className="new-job">
      <label>
        Identifier
        <input
          autoFocus
          value={id}
          placeholder="developer"
          onChange={(event) => setId(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
        />
      </label>
      <div className="row">
        <button className="primary" disabled={id.trim() === ''} onClick={create}>
          Create
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      {errors.length > 0 && (
        <div className="issue">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function parseOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function ProfileEditor({ profile, onOpenJob, onDeleted }) {
  const container = useRef(null)
  const editor = useRef(null)
  const jsonModel = useRef(null)
  const systemModel = useRef(null)
  // Swapping models fires the same event as typing: without this, opening a tab
  // would mark the profile as modified.
  const syncing = useRef(false)

  const [tab, setTab] = useState('json')
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState([])

  useEffect(() => {
    let disposed = false

    ;(async () => {
      const read = await window.rota.readProfile(profile.id)
      if (disposed) return
      if (!read.ok) return setErrors(read.errors)

      jsonModel.current = monaco.editor.createModel(
        read.content,
        'json',
        profileModelUri(profile.id),
      )
      editor.current = monaco.editor.create(container.current, {
        ...EDITOR_OPTIONS,
        model: jsonModel.current,
        theme: themeName(matchMedia('(prefers-color-scheme: dark)').matches),
      })
      editor.current.onDidChangeModelContent(() => {
        if (syncing.current) return
        setDirty(true)
        setSaved(false)
      })
    })()

    return () => {
      disposed = true
      editor.current?.dispose()
      jsonModel.current?.dispose()
      systemModel.current?.dispose()
      editor.current = null
      jsonModel.current = null
      systemModel.current = null
    }
  }, [profile.id])

  /**
   * The whole file as it would be written: the prompt model wins over the JSON.
   *
   * There is never a second version of the same text able to diverge — what the
   * markdown tab holds is folded back in here, and the JSON is what counts.
   */
  const contentToWrite = useCallback(() => {
    const content = jsonModel.current?.getValue() ?? ''
    if (!systemModel.current) return content

    const parsed = parseOrNull(content)
    // Unreadable JSON: sent as it is, the main process will say why.
    if (!parsed) return content

    parsed.systemPrompt = systemModel.current.getValue()
    // Normalised rewrite: the file's original indentation is not preserved.
    return `${JSON.stringify(parsed, null, 2)}\n`
  }, [])

  /**
   * Switching tabs.
   *
   * The prompt is pulled out of the JSON when its tab opens and folded back in
   * when it closes, so the JSON stays the single source of truth — the same
   * arrangement the job editor makes for a job's prompts, and for the same
   * reason: a page of instructions escaped onto one line of JSON neither writes
   * nor reads back.
   */
  const openTab = useCallback(
    (next) => {
      if (!editor.current || !jsonModel.current || next === tab) return

      syncing.current = true
      const merged = contentToWrite()
      if (merged !== jsonModel.current.getValue()) jsonModel.current.setValue(merged)

      if (next === 'system') {
        const parsed = parseOrNull(jsonModel.current.getValue())
        if (!parsed) {
          // Nothing to extract from a file that does not parse, and the JSON tab
          // is the only place it can be repaired.
          syncing.current = false
          setErrors(['The definition must be readable JSON before its prompt can be edited.'])
          return
        }
        setErrors([])
        const text = typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : ''
        if (!systemModel.current) {
          // Get-or-create: a model left behind by a previous mounting of this
          // same profile would make createModel throw on a URI already taken.
          const uri = sourceModelUri(`profile-${profile.id}`, 'system', 'md')
          systemModel.current =
            monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, 'markdown', uri)
        }
        if (systemModel.current.getValue() !== text) systemModel.current.setValue(text)
        editor.current.setModel(systemModel.current)
      } else {
        editor.current.setModel(jsonModel.current)
      }

      syncing.current = false
      setTab(next)
    },
    [tab, contentToWrite, profile.id],
  )

  const save = async () => {
    const content = contentToWrite()
    // Written back into the JSON model too, so that what the other tab shows is
    // what was just saved.
    if (jsonModel.current && content !== jsonModel.current.getValue()) {
      syncing.current = true
      jsonModel.current.setValue(content)
      syncing.current = false
    }

    const result = await window.rota.saveProfile(profile.id, content)
    if (!result.ok) return setErrors(result.errors)
    setErrors([])
    setDirty(false)
    setSaved(true)
  }

  const remove = async () => {
    const result = await window.rota.deleteProfile(profile.id)
    if (result.ok) return onDeleted()
    // Backing out at the confirmation is not an error: we say nothing. Anything
    // else is, and swallowing it is how a deletion that never happened comes to
    // look like an interface that does not refresh.
    if (!result.cancelled) setErrors(result.errors ?? ['Deletion failed'])
  }

  return (
    <div className="profile-detail">
      <div className="crumbs">
        <h1>{profile.name}</h1>
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        <button className="danger" onClick={remove}>
          Delete
        </button>
      </div>

      <div className="editor-tabs">
        <button
          className={`tab ${tab === 'json' ? 'active' : ''}`}
          onClick={() => openTab('json')}
        >
          Definition
        </button>
        <button
          className={`tab ${tab === 'system' ? 'active' : ''}`}
          onClick={() => openTab('system')}
        >
          System prompt
        </button>
        {tab === 'system' && (
          <span className="muted">
            Standing instructions, added to Rota’s own. Written back into{' '}
            <code className="mono">systemPrompt</code> on save.{' '}
            <code className="mono">${'{'}defaults.system_prompt{'}'}</code> inserts Rota’s.
          </span>
        )}
      </div>

      <div className="monaco profile-monaco" ref={container} />

      {errors.length > 0 && (
        <div className="issue">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && <p className="tone-ok">Saved. Every job pointing at it has been reloaded.</p>}

      <h4>Used by</h4>
      {profile.usedBy.length === 0 ? (
        <p className="muted">
          No job points at this agent. One does with <code>"agent": "{profile.id}"</code> in its
          runner, plus its own <code>prompt</code>.
        </p>
      ) : (
        <ul className="profile-users">
          {profile.usedBy.map((jobId) => (
            <li key={jobId}>
              <button className="link" onClick={() => onOpenJob?.(jobId)}>
                {jobId}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
