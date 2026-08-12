import { useCallback, useEffect, useState } from 'react'

import {
  formatDateTime,
  formatDuration,
  statusTone,
  STATUS_LABELS,
  TRIGGER_LABELS,
} from '../format.js'

const PAGE_SIZE = 25

// A job's history, paginated from the end.
//
// Now lives in a tab of the editor view: with no `onBack`, there is therefore
// nothing to leave and the breadcrumb disappears — the editor's is just above,
// and two titles for the same job get in each other's way.

export default function JobHistory({ jobId, job, focusExecutionId, onBack, backLabel = '← Jobs' }) {
  const [entries, setEntries] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(focusExecutionId ?? null)

  const load = useCallback(
    async (offset) => {
      const result = await window.rota.readHistory(jobId, { limit: PAGE_SIZE, offset })
      if (!result.ok) {
        setError(result.errors.join(' '))
        return
      }
      setError(null)
      setEntries((previous) => (offset === 0 ? result.entries : [...previous, ...result.entries]))
      setHasMore(result.hasMore)
    },
    [jobId],
  )

  useEffect(() => {
    setLoading(true)
    setEntries([])
    load(0).finally(() => setLoading(false))
  }, [load])

  useEffect(() => {
    setExpanded(focusExecutionId ?? null)
  }, [focusExecutionId])

  return (
    <section>
      {onBack ? (
        <div className="crumbs">
          <button className="link" onClick={onBack}>
            {backLabel}
          </button>
          <h1>{job?.name ?? jobId}</h1>
          <button onClick={() => load(0)}>Refresh</button>
        </div>
      ) : (
        <div className="history-tools">
          <button onClick={() => load(0)}>Refresh</button>
          {entries.length > 0 && (
            <span className="muted">
              {/* "loaded" assumes the plural, and has it: a full page always
                  precedes the existence of a next one. */}
              {entries.length} execution{entries.length > 1 ? 's' : ''}{' '}
              {hasMore ? 'loaded' : 'in total'}
            </span>
          )}
        </div>
      )}

      {error && <div className="issue">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">No execution recorded for this job.</p>
      ) : (
        <>
          {entries.map((entry) => (
            <Execution
              key={entry.executionId}
              entry={entry}
              expanded={expanded === entry.executionId}
              onToggle={() =>
                setExpanded(expanded === entry.executionId ? null : entry.executionId)
              }
            />
          ))}
          {hasMore && (
            <button className="load-more" onClick={() => load(entries.length)}>
              Load earlier executions
            </button>
          )}
        </>
      )}
    </section>
  )
}

function Execution({ entry, expanded, onToggle }) {
  return (
    <article className={`execution ${expanded ? 'expanded' : ''}`}>
      <button className="execution-head" onClick={onToggle}>
        <span className={`status tone-${statusTone(entry.status)}`}>
          {STATUS_LABELS[entry.status] ?? entry.status}
        </span>
        <span className="when">{formatDateTime(entry.startedAt)}</span>
        <span className="muted">{formatDuration(entry.durationMs)}</span>
        <span className="muted">{TRIGGER_LABELS[entry.trigger] ?? entry.trigger}</span>
        {/* Lets one spot at a glance the executions that did something, in the
            middle of dozens of cycles with no effect. */}
        {entry.change?.changed && (
          <span className="badge changed">{entry.change.message ?? 'changed'}</span>
        )}
        {entry.exitCode !== null && entry.exitCode !== 0 && (
          <span className="muted">code {entry.exitCode}</span>
        )}
        <span className="chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && <ExecutionDetail entry={entry} />}
    </article>
  )
}

function ExecutionDetail({ entry }) {
  return (
    <div className="execution-body">
      {entry.error && <div className="cause">{entry.error}</div>}

      <dl className="facts">
        <Fact label="Started" value={formatDateTime(entry.startedAt)} />
        <Fact label="Finished" value={formatDateTime(entry.finishedAt)} />
        <Fact label="Duration" value={formatDuration(entry.durationMs)} />
        <Fact label="Exit code" value={entry.exitCode ?? '—'} />
        <Fact label="Signal" value={entry.signal ?? '—'} />
        <Fact label="Trigger" value={TRIGGER_LABELS[entry.trigger] ?? entry.trigger} />
      </dl>

      {entry.command && (
        <>
          <h3>Command</h3>
          <pre className="mono">{entry.command}</pre>
          {entry.workingDirectory && (
            <p className="muted mono">from {entry.workingDirectory}</p>
          )}
        </>
      )}

      <Stream
        title="Standard output"
        text={entry.stdout}
        truncated={entry.stdoutTruncated}
        file={entry.outputFiles?.stdout}
      />
      <Stream
        title="Standard error"
        text={entry.stderr}
        truncated={entry.stderrTruncated}
        file={entry.outputFiles?.stderr}
      />
    </div>
  )
}

function Stream({ title, text, truncated, file }) {
  const [full, setFull] = useState(null)
  const [loadError, setLoadError] = useState(null)

  if (!text && !file) return null

  const loadFull = async () => {
    const result = await window.rota.readOutput(file)
    if (result.ok) setFull(result.text)
    else setLoadError(result.error)
  }

  return (
    <>
      <h3>{title}</h3>
      <pre className="mono output">{full ?? text}</pre>
      {loadError && <p className="tone-error">{loadError}</p>}
      {file && !full && (
        <button onClick={loadFull}>Show the full output</button>
      )}
      {truncated && !file && <p className="muted">Output truncated at the configured limit.</p>}
    </>
  )
}

function Fact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  )
}
