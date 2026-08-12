import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Markdown } from './markdown.jsx'
import './agent.css'

// Agent windows: report, question, confirmation.
//
// The chat, on the other hand, is a tab of the editor: it lives in the main
// window, with the rest of the interface.
//
// The panel to display is designated by the URL fragment. Nothing is pushed from
// the main process: the window comes and fetches its content when its rendering
// is ready, which avoids the race with the first display.

const panelId = window.location.hash.slice(1)

function Report({ title, markdown }) {
  return (
    <div className="panel report">
      <h1 className="panel-title">{title}</h1>
      <Markdown source={markdown} />
    </div>
  )
}

function Ask({ question, defaultValue }) {
  const [value, setValue] = useState(defaultValue ?? '')
  const input = useRef(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = (event) => {
    event.preventDefault()
    window.rotaAgent.answerPanel(panelId, { action: 'submit', value })
  }

  return (
    <form className="panel ask" onSubmit={submit}>
      <p className="question">{question}</p>
      <input
        ref={input}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Your answer"
      />
      <div className="actions">
        <button
          type="button"
          className="ghost"
          onClick={() => window.rotaAgent.answerPanel(panelId, { action: 'cancel' })}
        >
          Cancel
        </button>
        <button type="submit" className="primary">
          Answer
        </button>
      </div>
    </form>
  )
}

function Confirm({ question, detail }) {
  const accept = useRef(null)
  useEffect(() => accept.current?.focus(), [])

  const answer = (action) => window.rotaAgent.answerPanel(panelId, { action })

  return (
    <div className="panel confirm">
      <p className="question">{question}</p>
      {detail ? <p className="detail">{detail}</p> : null}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => answer('cancel')}>
          Cancel
        </button>
        <button ref={accept} type="button" className="primary" onClick={() => answer('submit')}>
          Confirm
        </button>
      </div>
    </div>
  )
}

function Panel() {
  const [panel, setPanel] = useState(null)

  useEffect(() => {
    window.rotaAgent.getPanel(panelId).then(setPanel)
  }, [])

  if (!panel) return <div className="loading">Loading…</div>
  if (!panel.ok) return <div className="panel error">{panel.error}</div>

  if (panel.kind === 'report') return <Report {...panel} />
  if (panel.kind === 'ask') return <Ask {...panel} />
  if (panel.kind === 'confirm') return <Confirm {...panel} />
  return <div className="panel error">Unknown panel: {panel.kind}</div>
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
)
