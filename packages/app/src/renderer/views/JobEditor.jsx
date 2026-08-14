import { useCallback, useEffect, useRef, useState } from 'react'

import monaco, { sourceModelUri, modelUri, themeName } from '../monaco.js'
import Chat from './Chat.jsx'
import JobForm from './JobForm.jsx'
import JobHistory from './JobHistory.jsx'
import LiveOutput from './LiveOutput.jsx'
import Work from './Work.jsx'

// Editing a job: the JSON, and depending on its type, one or two text tabs.
//
// "Definition" shows the JSON, validated live against the job schema. The other
// tabs show a field that lives badly in JSON: the code of a bun-inline job, the
// prompts of an agent job. A page of instructions escaped onto a single line
// neither writes nor reads back.
//
// A single editor, several models swapped in and out: the JSON is what counts.
// Each source is extracted from it when its tab opens, and reinjected into it as
// soon as one leaves the tab or saves — so there are never two versions of the
// same text able to diverge.
//
// Monaco only guides the input: it is the main process that decides on save,
// with the same schema as for the files read from disk. A single validation is
// authoritative, and it is not the renderer's.

const OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  lineNumbersMinChars: 3,
  folding: true,
  tabSize: 2,
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  padding: { top: 10, bottom: 10 },
}

/**
 * Current theme, read again every time rather than frozen.
 *
 * This module is loaded on demand, on the first opening of the editor: a value
 * computed at its evaluation would stay the one from that moment, and changing
 * appearance from the settings left the text dark on a dark background.
 */
const currentTheme = () =>
  themeName(window.matchMedia('(prefers-color-scheme: dark)').matches)

/**
 * Fields that earn their own tab, per job type. `path` designates the place in
 * the definition; it must already exist, the editor never creates a structure
 * the schema would not have validated.
 */
const SOURCE_TABS = {
  'bun-inline': [
    {
      id: 'code',
      label: 'Code',
      language: 'javascript',
      extension: 'js',
      path: ['runner', 'code'],
      hint: (
        <>
          Run by Bun. The content is written back into <code className="mono">runner.code</code> on
          save.
        </>
      ),
    },
  ],
  agent: [
    {
      id: 'prompt',
      label: 'Prompt',
      language: 'markdown',
      extension: 'md',
      path: ['runner', 'agent', 'prompt'],
      hint: (
        <>
          What the agent is asked to do. Written back into{' '}
          <code className="mono">runner.agent.prompt</code> on save.
        </>
      ),
    },
    {
      id: 'system',
      label: 'System',
      language: 'markdown',
      extension: 'md',
      path: ['runner', 'agent', 'systemPrompt'],
      hint: (
        <>
          Standing instructions, added to Rota's own. Written back into{' '}
          <code className="mono">runner.agent.systemPrompt</code>.
        </>
      ),
    },
  ],
}

const sourceTabs = (parsed) => SOURCE_TABS[parsed?.runner?.type] ?? []

/**
 * Tabs that do not depend on the declared type, and edit no text: they are
 * therefore never pulled from under one's feet, and Monaco's container gives
 * way to them.
 */
const PERMANENT_TABS = new Set(['form', 'json', 'chat', 'history', 'work'])
const WITHOUT_EDITOR = new Set(['form', 'chat', 'history', 'work'])

function readPath(target, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), target)
}

/** Only writes if the parent exists: otherwise the source has no place to be. */
function writePath(target, path, value) {
  const parent = readPath(target, path.slice(0, -1))
  if (parent === null || typeof parent !== 'object') return false
  parent[path.at(-1)] = value
  return true
}

function parseOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export default function JobEditor({ jobId, job, running, initialTab, focusExecutionId, onBack }) {
  const container = useRef(null)
  const editor = useRef(null)
  const jsonModel = useRef(null)
  /** @type {import('react').MutableRefObject<Map<string, object>>} */
  const sourceModels = useRef(new Map())
  // Model swaps fire the same events as typing: without this flag, changing tab
  // would mark the job as modified.
  const syncing = useRef(false)

  // The form first: that is what one comes to set nine times out of ten, and the
  // JSON stays one click away. An unreadable definition falls back to it, the
  // only place where it can be repaired.
  const [tab, setTab] = useState(initialTab ?? 'form')
  // The conversation is only mounted once asked for — opening the editor must
  // not open a session — then it stays so, hidden: its thread thereby survives
  // going back and forth between tabs.
  const [chatMounted, setChatMounted] = useState(initialTab === 'chat')
  const [tabs, setTabs] = useState([])
  // The form edits an object, not text: it cannot be a Monaco model. It
  // therefore holds its own state, written back into the JSON on every change —
  // it is always the JSON that counts.
  const [form, setForm] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState([])
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  /**
   * Full content to write: the source models win over the JSON. Only those that
   * hold for the currently declared type are reinjected — a model left behind by
   * an abandoned type has nothing more to say.
   */
  const currentContent = useCallback(() => {
    const content = jsonModel.current.getValue()
    if (sourceModels.current.size === 0) return content

    const parsed = parseOrNull(content)
    // Unreadable JSON: we send it as is, the main process will say why.
    if (!parsed) return content

    let changed = false
    for (const descriptor of sourceTabs(parsed)) {
      const model = sourceModels.current.get(descriptor.id)
      if (model && writePath(parsed, descriptor.path, model.getValue())) changed = true
    }
    // Normalised rewrite: the file's original indentation is not preserved.
    return changed ? `${JSON.stringify(parsed, null, 2)}\n` : content
  }, [])

  const save = useCallback(async () => {
    if (!jsonModel.current) return

    const content = currentContent()
    if (content !== jsonModel.current.getValue()) {
      syncing.current = true
      jsonModel.current.setValue(content)
      syncing.current = false
    }

    const result = await window.rota.saveJob(jobId, content)
    if (result.ok) {
      setDirty(false)
      setErrors([])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      setErrors(result.errors)
    }
  }, [jobId, currentContent])

  const remove = useCallback(async () => {
    const result = await window.rota.deleteJob(jobId)
    // Backing out at the confirmation is not an error: we say nothing.
    if (result.ok) onBack()
    else if (!result.cancelled) setErrors(result.errors)
  }, [jobId, onBack])

  const openTab = useCallback(
    (next) => {
      if (!jsonModel.current || !editor.current || next === tab) return

      // Everything is reinjected into the JSON first: it is what counts, and it
      // is from it that the next source will be extracted.
      const merged = currentContent()
      if (merged !== jsonModel.current.getValue()) {
        syncing.current = true
        jsonModel.current.setValue(merged)
        syncing.current = false
      }

      if (next === 'chat') {
        setChatMounted(true)
        setErrors([])
        setTab('chat')
        return
      }

      // The history is re-read every time its tab opens — it is mounted then
      // unmounted for that. One comes to it after starting something, and it is
      // the execution just triggered that one is looking for.
      if (next === 'history') {
        setErrors([])
        setTab('history')
        return
      }

      if (next === 'json') {
        setErrors([])
        setForm(null)
        editor.current.setModel(jsonModel.current)
        setTab('json')
        editor.current.focus()
        return
      }

      const parsed = parseOrNull(jsonModel.current.getValue())
      if (!parsed) {
        setErrors(['Invalid JSON: fix the definition before editing this text.'])
        return
      }

      if (next === 'form') {
        setErrors([])
        setForm(parsed)
        setTab('form')
        return
      }
      setForm(null)
      const descriptor = sourceTabs(parsed).find((candidate) => candidate.id === next)
      if (!descriptor) return

      const value = readPath(parsed, descriptor.path)
      const text = typeof value === 'string' ? value : ''

      syncing.current = true
      let model = sourceModels.current.get(descriptor.id)
      if (!model) {
        const uri = sourceModelUri(jobId, descriptor.id, descriptor.extension)
        model =
          monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, descriptor.language, uri)
        model.onDidChangeContent(onContentChanged)
        sourceModels.current.set(descriptor.id, model)
      }
      // The definition may have been modified in the JSON tab in the meantime.
      if (model.getValue() !== text) model.setValue(text)
      syncing.current = false

      setErrors([])
      editor.current.setModel(model)
      setTab(descriptor.id)
      editor.current.focus()
    },
    [jobId, tab, currentContent],
  )

  /**
   * A change in the form is immediately written back into the JSON: it stays the
   * source, Monaco keeps validating it live, and saving has no path of its own.
   */
  const changeForm = useCallback((mutate) => {
    setForm((current) => {
      const next = structuredClone(current)
      mutate(next)
      syncing.current = true
      jsonModel.current?.setValue(`${JSON.stringify(next, null, 2)}\n`)
      syncing.current = false
      setDirty(true)
      setSaved(false)
      setTabs(sourceTabs(next))
      return next
    })
  }, [])

  function onContentChanged() {
    if (syncing.current) return
    setDirty(true)
    setSaved(false)
    // Tabs appear and disappear with the type declared in the JSON.
    const parsed = parseOrNull(jsonModel.current?.getValue() ?? '')
    if (parsed) setTabs(sourceTabs(parsed))
  }

  // A text tab the type no longer wants: we go back to the definition rather than
  // editing a text that will be reinjected nowhere. The permanent tabs hold for
  // every type and are never concerned.
  useEffect(() => {
    if (!PERMANENT_TABS.has(tab) && !tabs.some((descriptor) => descriptor.id === tab)) {
      openTab('json')
    }
  }, [tabs, tab, openTab])

  // A view request coming from elsewhere — a click on a failure notification, the
  // tray menu, the dashboard — while the editor is already open. Without this,
  // the route changes and the tab displayed stays the one being looked at.
  useEffect(() => {
    // No tab requested means "show me this job": we open the editing view.
    openTab(initialTab ?? 'form')
    // `openTab` changes with the current tab: putting it in the dependencies
    // would bring back the requested tab every time one leaves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, focusExecutionId])

  // Monaco keeps the content in a model; React does not own it. We mount the
  // editor once per job and drive it imperatively.
  useEffect(() => {
    let active = true
    let instance = null
    const sources = sourceModels.current

    window.rota.readJob(jobId).then((result) => {
      if (!active || !container.current) return
      if (!result.ok) {
        setErrors(result.errors)
        setLoading(false)
        return
      }

      const uri = modelUri(jobId)
      const model =
        monaco.editor.getModel(uri) ?? monaco.editor.createModel(result.content, 'json', uri)
      syncing.current = true
      model.setValue(result.content)
      syncing.current = false

      jsonModel.current = model
      const parsed = parseOrNull(result.content)
      setTabs(sourceTabs(parsed))
      // An unreadable file has no form: we open the JSON, the only place where it
      // can be repaired. The history and the conversation, on the other hand, do
      // not depend on the definition: having asked for them wins.
      if (parsed) setForm(parsed)
      else setTab((current) => (current === 'form' ? 'json' : current))

      instance = monaco.editor.create(container.current, {
        ...OPTIONS,
        model,
        // The background comes from the container: custom themes leave it
        // transparent.
        theme: currentTheme(),
      })
      editor.current = instance
      setLoading(false)

      model.onDidChangeContent(onContentChanged)

      // Cmd-S from the editor: the most expected shortcut in a code field.
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save())
    })

    return () => {
      active = false
      instance?.dispose()
      jsonModel.current?.dispose()
      for (const model of sources.values()) model.dispose()
      sources.clear()
      jsonModel.current = null
      editor.current = null
    }
  }, [jobId, save])

  // Monaco's markers carry the schema errors, with their line.
  useEffect(() => {
    const subscription = monaco.editor.onDidChangeMarkers(() => {
      const model = jsonModel.current
      if (!model) return
      setErrors(
        monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((marker) => marker.severity === monaco.MarkerSeverity.Error)
          .map((marker) => `line ${marker.startLineNumber}: ${marker.message}`),
      )
    })
    return () => subscription.dispose()
  }, [])

  // Follows the application's appearance, system or forced from the settings.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => monaco.editor.setTheme(currentTheme())
    // On mount too, and not only on change: the appearance may have been changed
    // while the editor was closed, and no event waits for one to come back.
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const active = tabs.find((descriptor) => descriptor.id === tab)

  return (
    <section className="editor">
      <div className="crumbs">
        <button className="link" onClick={onBack}>
          ← Jobs
        </button>
        <h1 className="mono">{jobId}.json</h1>
        <button onClick={() => window.rota.openJobFile(jobId)}>
          Open in the system editor
        </button>
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>

      {/* The same actions as in the list: putting a job right means starting it,
          watching it, stopping it and correcting, without going back and forth
          between two views on every round. */}
      <div className="editor-actions">
        <button onClick={() => window.rota.runJob(jobId)} disabled={dirty}>
          Run
        </button>
        <button
          disabled={!running}
          onClick={() => running && window.rota.cancelRun(running.executionId)}
        >
          Stop
        </button>
        {/* The confirmation is a modal sheet from the main process: deletion is
            irreversible and takes the history with it. */}
        <button className="danger" onClick={remove} disabled={Boolean(running)}>
          Delete
        </button>
        {dirty && <span className="muted">Save before running.</span>}
      </div>

      <LiveOutput execution={running} onOpenHistory={() => openTab('history')} />

      <div className="editor-tabs">
        <button className={`tab ${tab === 'form' ? 'active' : ''}`} onClick={() => openTab('form')}>
          Form
        </button>
        <button className={`tab ${tab === 'json' ? 'active' : ''}`} onClick={() => openTab('json')}>
          Definition
        </button>
        {tabs.map((descriptor) => (
          <button
            key={descriptor.id}
            className={`tab ${tab === descriptor.id ? 'active' : ''}`}
            onClick={() => openTab(descriptor.id)}
          >
            {descriptor.label}
          </button>
        ))}
        {job?.runner.type === 'agent' && (
          <button
            className={`tab ${tab === 'chat' ? 'active' : ''}`}
            onClick={() => openTab('chat')}
          >
            Chat
          </button>
        )}
        {/* Last, behind a rule: the other tabs write into the definition, this
            one tells what it did. */}
        <span className="tab-rule" aria-hidden="true" />
        {/* Only for a job that consumes a queue: a Work tab on a job with no
            `work` trigger would show an empty list and explain nothing. */}
        {job?.triggers?.some((trigger) => trigger.type === 'work') && (
          <button
            className={`tab ${tab === 'work' ? 'active' : ''}`}
            onClick={() => openTab('work')}
          >
            Work
            {job.work?.pending > 0 && <span className="badge">{job.work.pending}</span>}
          </button>
        )}
        <button
          className={`tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => openTab('history')}
        >
          History
        </button>
        {active && <span className="muted">{active.hint}</span>}
      </div>

      {/* The editor is not unmounted under the form tab: Monaco keeps its model,
          its undo history and its scroll position. */}
      <div className={`monaco ${WITHOUT_EDITOR.has(tab) ? 'hidden' : ''}`} ref={container}>
        {loading && <p className="muted">Loading…</p>}
      </div>

      {tab === 'form' && form && <JobForm job={form} onChange={changeForm} />}

      {/* Unmounted on leaving the tab, unlike the conversation: there is nothing
          to lose there, and re-reading it is exactly what one comes to do. */}
      {tab === 'history' && <JobHistory jobId={jobId} focusExecutionId={focusExecutionId} />}

      {tab === 'work' && <Work state={{ work: job?.work }} jobId={jobId} />}

      {/* Mounted once, then hidden rather than unmounted: the conversation
          thread survives going back and forth between tabs. */}
      {chatMounted && (
        <div className={`chat-tab ${tab === 'chat' ? '' : 'hidden'}`}>
          <Chat jobId={jobId} />
        </div>
      )}

      {errors.length > 0 && (
        <div className="issue">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Neither the conversation nor the history edits the definition: the save
          state means nothing there. The form, on the other hand, does. */}
      {tab !== 'chat' && tab !== 'history' && tab !== 'work' && (
        <>
          {saved && <p className="tone-ok">Saved. The job has been reloaded.</p>}
          {dirty && errors.length === 0 && !saved && (
            <p className="muted">Unsaved changes — ⌘S to save.</p>
          )}
          {!dirty && !loading && errors.length === 0 && !saved && (
            <p className="muted">Validated live against the job schema.</p>
          )}
        </>
      )}
    </section>
  )
}
