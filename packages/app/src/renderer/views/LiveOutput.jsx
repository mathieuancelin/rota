import { useCallback, useEffect, useRef, useState } from 'react'

import { STATUS_LABELS, statusTone } from '../format.js'

// Output of an execution while it happens.
//
// The main process keeps the tail of what has scrolled past and pushes the rest
// as it comes. The view therefore claims the existing output on opening, then
// merely appends: without that first call, a job silent for ten minutes would
// look dead.
//
// The text stays displayed after the end. That is the moment it is most needed
// — one has just started a job to see what it does — and making it disappear the
// second it finishes would amount to hiding the answer to the question being
// asked. It clears on the next launch, or on leaving the view; what must last
// is in the history.

export default function LiveOutput({ execution, onOpenHistory }) {
  const [shown, setShown] = useState(execution ?? null)
  const [output, setOutput] = useState({ stdout: '', stderr: '', dropped: false })
  const [finished, setFinished] = useState(null)
  const log = useRef(null)
  const stuck = useRef(true)

  // A new execution replaces the previous one; its end does not clear it.
  useEffect(() => {
    if (execution) {
      setShown(execution)
      setFinished(null)
    }
  }, [execution])

  const executionId = shown?.executionId

  useEffect(() => {
    if (!executionId) return undefined
    let active = true

    setOutput({ stdout: '', stderr: '', dropped: false })
    stuck.current = true

    window.rota.readLiveOutput(executionId).then((result) => {
      if (!active || !result.ok) return
      setOutput({
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        dropped: result.stdout.dropped || result.stderr.dropped,
      })
    })

    const unsubscribe = window.rota.onLiveOutput((event) => {
      if (!active || event.executionId !== executionId) return
      if (event.done) {
        setFinished(event.status)
        return
      }
      setOutput((current) => ({
        stdout: current.stdout + (event.stdout ?? ''),
        stderr: current.stderr + (event.stderr ?? ''),
        dropped: current.dropped,
      }))
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [executionId])

  // Follow the bottom as long as one is there. Scrolling up to read something
  // freezes the scroll — otherwise the line one is trying to read escapes upwards.
  useEffect(() => {
    const element = log.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [output])

  const onScroll = useCallback(() => {
    const element = log.current
    if (!element) return
    stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }, [])

  if (!executionId) return null

  const running = Boolean(execution) && !finished
  const empty = output.stdout === '' && output.stderr === ''

  return (
    <section className={`live ${running ? '' : 'done'}`}>
      <header>
        <span className={`dot ${running ? 'running' : `tone-${statusTone(finished)}`}`} />
        {running ? (
          <>
            <span>Execution running</span>
            <span className="muted">
              for <Elapsed from={shown.startedAt} />
            </span>
          </>
        ) : (
          <span>Execution finished — {STATUS_LABELS[finished] ?? finished ?? 'unknown'}</span>
        )}
        {output.dropped && <span className="muted">· beginning truncated</span>}
        {!running && onOpenHistory && (
          <button className="link" onClick={onOpenHistory}>
            View in history
          </button>
        )}
      </header>

      <pre className="mono output" ref={log} onScroll={onScroll}>
        {empty ? <span className="muted">No output.</span> : output.stdout}
        {output.stderr && <span className="tone-error">{output.stderr}</span>}
      </pre>
    </section>
  )
}

/** Counter in seconds: an execution watched live rarely lasts hours. */
function Elapsed({ from }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}
