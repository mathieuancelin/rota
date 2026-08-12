import { useState } from 'react'

import RelativeTime from '../RelativeTime.jsx'
import { formatDateTime, formatDuration, statusTone, STATUS_LABELS } from '../format.js'
import { SORTS, arrange } from './job-list-model.mjs'

export default function JobList({ state, onOpenEditor }) {
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  // Deliberately not persisted: sorting by name is the one you want most of the
  // time, and coming back to it by changing tab is rather a good thing. The
  // other two answer a one-off question.
  const [sort, setSort] = useState('name')

  const jobs = arrange(state.jobs, { search, sort })
  const filtering = search.trim() !== ''

  return (
    <section>
      <div className="list-header">
        <h2>Jobs</h2>
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            New job
          </button>
        )}
      </div>

      {state.jobs.length > 0 && (
        <div className="list-tools">
          <input
            type="search"
            value={search}
            placeholder="Filter by name, description or identifier"
            onChange={(event) => setSearch(event.target.value)}
          />
          <label>
            Sort by
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              {Object.entries(SORTS).map(([id, { label }]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {filtering && (
            <span className="muted">
              {jobs.length} of {state.jobs.length}
            </span>
          )}
        </div>
      )}

      {creating && (
        <NewJob
          templates={state.jobTemplates ?? []}
          onCancel={() => setCreating(false)}
          // The file is written: the editor can read it without waiting for the
          // watcher to have reloaded the configuration.
          onCreated={(id) => {
            setCreating(false)
            onOpenEditor(id)
          }}
        />
      )}

      {state.jobs.length === 0 && !creating && <EmptyJobs onCreate={() => setCreating(true)} />}

      {state.jobs.length > 0 && jobs.length === 0 && (
        <p className="muted">No job matches “{search.trim()}”.</p>
      )}

      {jobs.map((job) => (
        <Job
          key={job.id}
          job={job}
          paused={state.scheduler.paused}
          running={state.runningExecutions.find((execution) => execution.jobId === job.id)}
          onOpenEditor={() => onOpenEditor(job.id)}
        />
      ))}
    </section>
  )
}

function NewJob({ templates, onCancel, onCreated }) {
  const [id, setId] = useState('')
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [errors, setErrors] = useState([])
  const [busy, setBusy] = useState(false)

  const trimmed = id.trim()
  const selected = templates.find((template) => template.id === templateId)

  const submit = async (event) => {
    event.preventDefault()
    if (!trimmed || busy) return

    setBusy(true)
    const result = await window.rota.createJob(trimmed, templateId)
    setBusy(false)

    if (result.ok) onCreated(trimmed)
    else setErrors(result.errors)
  }

  return (
    <form className="new-job" onSubmit={submit}>
      <div className="fields">
        <label>
          Identifier
          <input
            type="text"
            value={id}
            autoFocus
            placeholder="my-job"
            spellCheck={false}
            onChange={(event) => {
              setId(event.target.value)
              setErrors([])
            }}
          />
        </label>
        <label>
          Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && <p className="muted">{selected.description}</p>}
      <p className="muted">
        The file will be <code className="mono">{trimmed || 'my-job'}.json</code>, created{' '}
        <strong>disabled</strong>: enable it once the job does what you want.
      </p>

      {errors.length > 0 && (
        <div className="issue">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={!trimmed || busy}>
          Create and edit
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function Job({ job, paused, running, onOpenEditor }) {
  const lastRun = job.lastRun

  // The whole card opens the editor: that is what one comes to do nine times out
  // of ten, and the rest — history, conversation — now has its tab there. An
  // "Edit" button remains all the same: nothing says a card is clickable until
  // you hover it.
  return (
    <article
      className={`job ${job.enabled ? '' : 'disabled'}`}
      role="button"
      tabIndex={0}
      onClick={onOpenEditor}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpenEditor()
      }}
    >
      <div className="name">
        {job.name}
        {job.running > 0 && <span className="badge running">running</span>}
        {!job.enabled && <span className="badge off">disabled</span>}
        {job.stale && (
          <span className="badge stale" title="The file is currently invalid">
            previous definition
          </span>
        )}
      </div>

      {/* The actions do not trigger the opening of the card carrying them. */}
      <div className="actions" onClick={(event) => event.stopPropagation()}>
        {/* One button for both states: what one wants of a running job is to stop
            it, and "Run" would have nothing more to do. A manual launch stays
            possible even with the scheduler paused: pausing stops the automatic
            firing, not the explicit action. */}
        {running ? (
          <button
            className="primary"
            title="Stop the running execution"
            onClick={() => window.rota.cancelRun(running.executionId)}
          >
            Stop
          </button>
        ) : (
          <button
            className="primary"
            title="Run now"
            onClick={() => window.rota.runJob(job.id)}
          >
            Run
          </button>
        )}
        <button onClick={() => window.rota.setJobEnabled(job.id, !job.enabled)}>
          {job.enabled ? 'Disable' : 'Enable'}
        </button>
        <button onClick={onOpenEditor}>Edit</button>
      </div>

      {job.description && <div className="description">{job.description}</div>}

      <div className="meta">
        <span>{job.triggerLabel}</span>
        <span>·</span>
        <span>{job.runnerLabel}</span>
        <span>·</span>
        <span>times out after {job.execution.timeoutSeconds} s</span>
        {!job.execution.allowConcurrentRuns && (
          <>
            <span>·</span>
            <span>single run</span>
          </>
        )}
        {job.execution.sandbox.enabled && (
          <>
            <span>·</span>
            <span
              title={`Container ${job.execution.sandbox.image}, network ${
                job.execution.sandbox.network ? 'on' : 'off'
              }`}
            >
              sandboxed
            </span>
          </>
        )}
        {job.execution.requiresUnlockedSession && (
          <>
            <span>·</span>
            <span title="Nothing starts while the screen is locked; unlocking catches up like a wake">
              unlocked session required
            </span>
          </>
        )}
      </div>

      <dl className="runs">
        <div>
          <dt>Last run</dt>
          <dd>
            {lastRun ? (
              <>
                <span className={`tone-${statusTone(lastRun.status)}`}>
                  {STATUS_LABELS[lastRun.status] ?? lastRun.status}
                </span>{' '}
                <span className="muted">
                  {formatDateTime(lastRun.at)} · {formatDuration(lastRun.durationMs)}
                </span>
              </>
            ) : (
              <span className="muted">never</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>
            {!job.enabled ? (
              <span className="muted">job disabled</span>
            ) : job.deferredUntilUnlock ? (
              <span className="muted">when the session unlocks</span>
            ) : job.nextRunAt ? (
              <>
                {formatDateTime(job.nextRunAt)}{' '}
                <span className="muted">
                  (<RelativeTime iso={job.nextRunAt} />)
                </span>
              </>
            ) : (
              <span className="muted">{paused ? 'scheduler paused' : '—'}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="command mono" title="Command that runs">
        {job.commandPreview}
      </div>
    </article>
  )
}

function EmptyJobs({ onCreate }) {
  return (
    <div className="empty">
      <p>
        No jobs yet. Start from a template, or drop a JSON file into the{' '}
        <code>jobs/</code> directory: Rota loads it immediately.
      </p>
      <button className="primary" onClick={onCreate}>
        New job
      </button>
      <button onClick={() => window.rota.openConfigDir()}>
        Open the configuration directory
      </button>
    </div>
  )
}
