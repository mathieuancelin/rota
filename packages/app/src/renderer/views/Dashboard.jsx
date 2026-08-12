import RelativeTime from '../RelativeTime.jsx'
import { formatDateTime, formatDuration, formatTime, statusTone, STATUS_LABELS } from '../format.js'

export default function Dashboard({ state, onOpenJob }) {
  const enabled = state.jobs.filter((job) => job.enabled)
  const withErrors = state.jobs.filter(
    (job) => job.lastRun && (job.lastRun.status === 'failed' || job.lastRun.status === 'timed-out'),
  )
  const succeeded = state.jobs
    .filter((job) => job.lastRun?.status === 'success')
    .sort((a, b) => Date.parse(b.lastRun.at) - Date.parse(a.lastRun.at))

  return (
    <>
      <section className="tiles">
        <Tile
          value={enabled.length}
          label={enabled.length > 1 ? 'active jobs' : 'active job'}
        />
        <Tile
          value={state.scheduler.running}
          label="running"
          tone={state.scheduler.running > 0 ? 'running' : undefined}
        />
        <Tile
          value={withErrors.length}
          label="failing"
          tone={withErrors.length > 0 ? 'error' : undefined}
        />
        <Tile
          value={state.scheduler.paused ? 'Paused' : 'Active'}
          label="scheduler"
          tone={state.scheduler.paused ? 'warn' : 'ok'}
        />
      </section>

      {state.runningExecutions.length > 0 && (
        <section>
          <h2>Running executions</h2>
          {state.runningExecutions.map((execution) => (
            <div className="row" key={execution.executionId}>
              <button className="link" onClick={() => onOpenJob(execution.jobId)}>
                {execution.jobName}
              </button>
              <span className="muted">started at {formatTime(execution.startedAt)}</span>
              <button onClick={() => window.rota.cancelRun(execution.executionId)}>Stop</button>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Next runs</h2>
        {state.scheduler.paused ? (
          <p className="muted">The scheduler is paused, nothing is scheduled.</p>
        ) : state.nextRuns.length === 0 ? (
          <p className="muted">No active job.</p>
        ) : (
          state.nextRuns.slice(0, 5).map((run) => (
            <div className="row" key={run.jobId}>
              <span className="mono time">{formatTime(run.at)}</span>
              <button className="link" onClick={() => onOpenJob(run.jobId)}>
                {run.name}
              </button>
              <span className="muted">
                <RelativeTime iso={run.at} />
              </span>
            </div>
          ))
        )}
      </section>

      <div className="columns">
        <section>
          <h2>Recent successes</h2>
          {succeeded.length === 0 ? (
            <p className="muted">No successful execution yet.</p>
          ) : (
            succeeded.slice(0, 5).map((job) => (
              <div className="row" key={job.id}>
                <button className="link" onClick={() => onOpenJob(job.id)}>
                  {job.name}
                </button>
                <span className="muted">{formatDateTime(job.lastRun.at)}</span>
                <span className="muted">{formatDuration(job.lastRun.durationMs)}</span>
              </div>
            ))
          )}
        </section>

        <section>
          <h2>Recent failures</h2>
          {state.recentErrors.length === 0 ? (
            <p className="muted">No failure recorded.</p>
          ) : (
            state.recentErrors.slice(0, 5).map((error) => (
              <div className="row" key={error.executionId ?? error.at}>
                <button className="link" onClick={() => onOpenJob(error.jobId, error.executionId)}>
                  {error.name}
                </button>
                <span className={`tone-${statusTone(error.status)}`}>
                  {STATUS_LABELS[error.status] ?? error.status}
                </span>
                <span className="muted">{formatDateTime(error.at)}</span>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  )
}

function Tile({ value, label, tone }) {
  return (
    <div className={`tile ${tone ? `tone-${tone}` : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  )
}
