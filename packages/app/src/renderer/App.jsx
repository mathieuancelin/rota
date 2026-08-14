import { Suspense, lazy, useEffect, useState } from 'react'

import { fileName } from './format.js'
import { useAppState } from './state.js'
import Dashboard from './views/Dashboard.jsx'
import JobList from './views/JobList.jsx'
import Settings from './views/Settings.jsx'
import Work from './views/Work.jsx'

// Monaco weighs more than the rest of the interface put together. Loading it on
// demand avoids paying for its parsing on every startup, for a view one only
// opens occasionally.
const JobEditor = lazy(() => import('./views/JobEditor.jsx'))

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'work', label: 'Work' },
  { id: 'settings', label: 'Settings' },
]

// Everything about a job lives in its editor view, history included: a job is a
// single place, with tabs. The main process keeps asking for "the history of
// this job" — that is its intention, not an address — and this is where it gets
// translated into a tab.
//
// With no execution designated, we open the editor view as it is: clicking a
// running or upcoming job from the dashboard means "show me this job", and the
// default tab answers that better than a list of past executions — the running
// one is displayed at the top anyway, live. A named execution, on the other
// hand — a failure, a clicked notification — opens the history unfolded on it.
const openJob = (jobId, executionId = null) => ({
  view: 'editor',
  jobId,
  executionId,
  tab: executionId ? 'history' : undefined,
})

export default function App() {
  const state = useAppState()
  // Navigation: the "editor" view attaches to a job.
  const [route, setRoute] = useState({ view: 'dashboard', jobId: null, executionId: null })

  // The main process may ask for a specific view, for instance on a click on a
  // failure notification.
  useEffect(
    () =>
      window.rota.onNavigate((target) => {
        if (target.view === 'history' && target.jobId) {
          setRoute(openJob(target.jobId, target.executionId ?? null))
          return
        }
        setRoute({
          view: target.view ?? 'dashboard',
          jobId: target.jobId ?? null,
          executionId: target.executionId ?? null,
        })
      }),
    [],
  )

  if (!state) return <div className="loading">Loading…</div>

  return (
    <>
      <TitleBar
        state={state}
        active={route.view}
        onSelect={(view) => setRoute({ view, jobId: null, executionId: null })}
      />

      <main>
        {state.issues.length > 0 && <Issues issues={state.issues} />}

        {route.view === 'dashboard' && (
          <Dashboard
            state={state}
            onOpenJob={(jobId, executionId) => setRoute(openJob(jobId, executionId))}
          />
        )}

        {route.view === 'jobs' && (
          <JobList
            state={state}
            onOpenEditor={(jobId) => setRoute({ view: 'editor', jobId, executionId: null })}
          />
        )}

        {route.view === 'editor' && (
          <Suspense fallback={<p className="muted">Loading the editor…</p>}>
            <JobEditor
              jobId={route.jobId}
              job={state.jobs.find((job) => job.id === route.jobId)}
              running={state.runningExecutions.find(
                (execution) => execution.jobId === route.jobId,
              )}
              initialTab={route.tab}
              focusExecutionId={route.executionId}
              onBack={() => setRoute({ view: 'jobs', jobId: null, executionId: null })}
            />
          </Suspense>
        )}

        {route.view === 'work' && (
          <Work state={state} onOpenJob={(jobId) => setRoute(openJob(jobId))} />
        )}

        {route.view === 'settings' && <Settings state={state} />}
      </main>
    </>
  )
}

function TitleBar({ state, active, onSelect }) {
  const { paused, running } = state.scheduler

  return (
    <div className="titlebar">
      <span className="title">Rota</span>

      <nav className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${active === tab.id || (active === 'editor' && tab.id === 'jobs') ? 'active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {/* Only what is waiting: a count of what is done would never go
                back down, and a badge that only ever grows stops being read. */}
            {tab.id === 'work' && state.work?.pending > 0 && (
              <span className="badge">{state.work.pending}</span>
            )}
          </button>
        ))}
      </nav>

      {state.hasUnacknowledgedError && (
        <button
          className="pill error"
          title="Mark errors as seen"
          onClick={() => window.rota.acknowledgeErrors()}
        >
          <span className="dot" />
          {state.recentErrors.length} failure{state.recentErrors.length > 1 ? 's' : ''}
        </button>
      )}

      <span className={`pill ${paused ? 'paused' : running > 0 ? 'running' : ''}`}>
        <span className="dot" />
        {paused ? 'Paused' : running > 0 ? `${running} running` : 'Idle'}
      </span>

      <button onClick={() => window.rota.setSchedulerPaused(!paused)}>
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
}

function Issues({ issues }) {
  return (
    <section>
      <h2>Configuration problems</h2>
      {issues.map((issue) => (
        <div className="issue" key={issue.file}>
          <div className="file">{fileName(issue.file)}</div>
          <ul>
            {issue.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
