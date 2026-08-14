import { useCallback, useEffect, useState } from 'react'

import RelativeTime from '../RelativeTime.jsx'

// The work queues: what is waiting to be done on this machine.
//
// An execution inbox, deliberately not a board. There are no columns to drag
// between, no assignee and no priority — an item is a piece of work with a job
// to do it, and everything else it might carry belongs in whatever put it here.
//
// The list is fetched rather than read off the state snapshot. The snapshot
// carries the counts, which is all the badges need, and it is rebuilt on every
// engine event: a queue of a thousand items has no business riding along with
// each one.

const STATUSES = ['pending', 'claimed', 'running', 'done', 'failed', 'cancelled']

const TONE = {
  pending: '',
  claimed: 'running',
  running: 'running',
  done: 'success',
  failed: 'error',
  cancelled: 'muted',
}

/** One line of what the item is about, without unfolding it. */
function summarise(input) {
  const entries = Object.entries(input ?? {})
  if (entries.length === 0) return '—'
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ')
}

export default function Work({ state, jobId = null, onOpenJob = null }) {
  const [items, setItems] = useState([])
  const [status, setStatus] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    const found = await window.rota.listWork({ jobId, status })
    setItems(Array.isArray(found) ? found : [])
  }, [jobId, status])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // The engine's counts move whenever the queue does; that is the cue to go and
  // read the list again, without a timer of our own.
  const counts = JSON.stringify(state?.work ?? {})
  useEffect(() => {
    load()
  }, [counts, load])

  const act = async (id, action) => {
    setBusy(id)
    try {
      await action(id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  // The whole-machine figures come pre-folded; a single job's arrive straight
  // from the store, where claimed and running are still two statuses. They are
  // one thing to look at: an item somebody has started.
  const source = state?.work ?? {}
  const totals = {
    pending: source.pending ?? 0,
    running: (source.running ?? 0) + (source.claimed ?? 0),
    failed: source.failed ?? 0,
    done: source.done ?? 0,
  }

  return (
    <section className="work">
      {!jobId && (
        <div className="crumbs">
          <h1>Work</h1>
          <button onClick={() => load()}>Refresh</button>
        </div>
      )}

      <div className="work-totals">
        <span className="pill">{totals.pending} pending</span>
        <span className={`pill ${totals.running > 0 ? 'running' : ''}`}>
          {totals.running} running
        </span>
        {totals.failed > 0 && <span className="pill error">{totals.failed} failed</span>}
        <span className="pill muted">{totals.done} done</span>
      </div>

      <div className="work-filters">
        <button className={`link ${status === null ? 'active' : ''}`} onClick={() => setStatus(null)}>
          All
        </button>
        {STATUSES.map((name) => (
          <button
            key={name}
            className={`link ${status === name ? 'active' : ''}`}
            onClick={() => setStatus(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {loading && <p className="muted">Reading the queue…</p>}

      {!loading && items.length === 0 && (
        <p className="muted">
          Nothing queued. Add work with <code>rotactl work add &lt;job&gt;</code> or by posting to
          /api/work; a job with a <code>work</code> trigger picks it up on its own.
        </p>
      )}

      {items.map((item) => (
        <div className={`work-item ${TONE[item.status] ?? ''}`} key={item.id}>
          <div className="work-row" onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <span className={`pill ${TONE[item.status] ?? ''}`}>{item.status}</span>
            <span className="work-id">{item.id}</span>
            {!jobId && (
              <button
                className="link"
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenJob?.(item.jobId)
                }}
              >
                {item.jobId}
              </button>
            )}
            <span className="work-input">{summarise(item.input)}</span>
            {item.attempts > 0 && (
              <span className="muted">
                {item.attempts} {item.attempts > 1 ? 'tries' : 'try'}
              </span>
            )}
            <span className="muted">
              <RelativeTime iso={item.createdAt} />
            </span>
          </div>

          {expanded === item.id && (
            <div className="work-detail">
              {item.availableAt && (
                <p className="muted">
                  Held back until <RelativeTime iso={item.availableAt} /> — it failed, and is not
                  served again before then.
                </p>
              )}
              {item.error && <p className="tone-error">{item.error}</p>}

              <h4>Input</h4>
              <pre>{JSON.stringify(item.input, null, 2)}</pre>

              {item.result && (
                <>
                  <h4>Result</h4>
                  <pre>{item.result}</pre>
                </>
              )}

              {item.executionId && <p className="muted">Execution {item.executionId}</p>}

              <div className="work-actions">
                <button
                  disabled={busy === item.id}
                  onClick={() => act(item.id, window.rota.retryWork)}
                >
                  Queue again
                </button>
                <button
                  disabled={busy === item.id || item.status === 'cancelled'}
                  onClick={() => act(item.id, window.rota.cancelWork)}
                >
                  Give up
                </button>
                <button
                  className="danger"
                  disabled={busy === item.id}
                  onClick={() => act(item.id, window.rota.deleteWork)}
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
