import { useCallback, useEffect, useRef, useState } from 'react'

import { Markdown } from '../markdown.jsx'
import '../chat.css'

// Conversation with a job's agent.
//
// The window holds no logic: it sends a message and displays the events the main
// process pushes to it as the turn goes. The thread is rebuilt from those events
// rather than from a state returned in one block — that is what makes it
// possible to see the answer compose itself instead of waiting for it.

/** Applies an event to the conversation thread. */
function reduce(messages, event) {
  const last = messages.at(-1)

  switch (event.type) {
    case 'turn-start':
      return [...messages, { role: 'user', content: event.content }]

    // Every round trip with the model gets its own bubble: a turn chaining five
    // tool calls reads back better in five steps than in one.
    case 'turn':
      return [...messages, { role: 'assistant', content: '', reasoning: '', calls: [] }]

    case 'delta':
      if (last?.role !== 'assistant') return messages
      return [
        ...messages.slice(0, -1),
        {
          ...last,
          content: last.content + (event.content ?? ''),
          reasoning: last.reasoning + (event.reasoning ?? ''),
        },
      ]

    case 'tool-call':
      if (last?.role !== 'assistant') return messages
      return [
        ...messages.slice(0, -1),
        { ...last, calls: [...last.calls, { id: event.id, name: event.name, pending: true }] },
      ]

    case 'tool-result':
      if (last?.role !== 'assistant') return messages
      return [
        ...messages.slice(0, -1),
        {
          ...last,
          calls: last.calls.map((call) =>
            call.id === event.id
              ? { ...call, pending: false, ok: event.ok, summary: event.summary ?? event.error }
              : call,
          ),
        },
      ]

    case 'notice':
      return [...messages, { role: 'notice', content: event.text }]

    case 'error':
      return [...messages, { role: 'error', content: event.text }]

    default:
      return messages
  }
}

function ToolCall({ call }) {
  const verdict = call.pending ? '…' : call.ok ? '✓' : '✗'
  return (
    <div className="tool-call">
      <span className={`verdict ${call.pending ? '' : call.ok ? 'ok' : 'ko'}`}>{verdict}</span>
      <span className="name">{call.name}</span>
      <span className="summary">{call.summary ?? ''}</span>
    </div>
  )
}

function Message({ message }) {
  if (message.role === 'user') {
    return (
      <div className="turn user">
        <div className="role">Vous</div>
        {message.content}
      </div>
    )
  }
  if (message.role === 'notice' || message.role === 'error') {
    return (
      <div className={`turn ${message.role === 'error' ? 'failed' : ''}`}>
        <div className="role">{message.role === 'error' ? 'Erreur' : 'Avertissement'}</div>
        {message.content}
      </div>
    )
  }

  // A bubble with no content and no tool call teaches nothing: it appears while
  // the first fragment arrives, then fills up.
  if (!message.content && !message.reasoning && message.calls.length === 0) return null

  return (
    <div className="turn">
      <div className="role">Agent</div>
      {message.reasoning ? <div className="reasoning">{message.reasoning}</div> : null}
      {message.content ? <Markdown source={message.content} /> : null}
      {message.calls.length > 0 ? (
        <div className="tool-calls">
          {message.calls.map((call) => (
            <ToolCall key={call.id} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Sidebar of a job's conversations.
 *
 * A job has as many as one likes: they share its working directory and its
 * memory — it is the same agent — but not their thread. Changing subject must
 * not force erasing the previous one, nor dragging it along in the context.
 */
function Conversations({ list, current, onSelect, onCreate, onRename, onDelete }) {
  // The thread being renamed, and the text typed in. Null the rest of the time:
  // a field left open on every row would turn the list into a list of fields.
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')

  const commit = async () => {
    const chatId = editing
    setEditing(null)
    // An empty name does not cancel: it gives the conversation its derived title back.
    await onRename(chatId, draft.trim())
  }

  return (
    <aside className="chat-list">
      <button type="button" className="chat-new" onClick={onCreate}>
        + New conversation
      </button>
      {list.length === 0 ? (
        <p className="chat-list-empty">No conversation yet.</p>
      ) : (
        list.map((conversation) => (
          <div
            key={conversation.chatId}
            className={`chat-entry ${conversation.chatId === current ? 'active' : ''}`}
          >
            {editing === conversation.chatId ? (
              <input
                className="rename"
                value={draft}
                autoFocus
                placeholder={conversation.title}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                  // Escape gives up: we leave without writing anything.
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="pick"
                  onClick={() => onSelect(conversation.chatId)}
                  onDoubleClick={() => {
                    setEditing(conversation.chatId)
                    setDraft(conversation.named ? conversation.title : '')
                  }}
                  title="Double-click to rename"
                >
                  <span className="title">{conversation.title}</span>
                  <span className="meta">
                    {conversation.origin !== 'ui' ? `${conversation.origin} · ` : ''}
                    {conversation.turns === 0
                      ? 'empty'
                      : `${conversation.turns} message${conversation.turns > 1 ? 's' : ''}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="link forget"
                  title="Delete this conversation"
                  onClick={() => onDelete(conversation.chatId)}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))
      )}
    </aside>
  )
}

export default function Chat({ jobId }) {
  const [chat, setChat] = useState(null)
  const [list, setList] = useState([])
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const log = useRef(null)

  const refreshList = useCallback(async () => {
    const result = await window.rota.listChats(jobId)
    if (result.ok) setList(result.conversations)
    return result.ok ? result.conversations : []
  }, [jobId])

  /** Installs an opened conversation, and its thread. */
  const adopt = useCallback((opened) => {
    if (!opened.ok) {
      setMessages([{ role: 'error', content: opened.errors.join(' | ') }])
      return
    }
    setChat(opened)
    setMessages(opened.events.reduce(reduce, []))
    setBusy(opened.busy)
    // The input field starts from the job's prompt, but only on a fresh
    // conversation: rewriting it over an answer being drafted would lose it.
    setDraft(opened.events.length === 0 ? (opened.prompt ?? '') : '')
  }, [])

  // The conversation lives in the main process, with its trail: leaving the tab
  // does not interrupt it, and coming back finds it as it was — even after a
  // restart, since it is also in a file. The thread is rebuilt by replaying the
  // same events as those received live: there is therefore only one rendering
  // path to keep honest.
  useEffect(() => {
    let active = true
    refreshList().then(async (conversations) => {
      if (!active) return
      // The last one if it exists, a fresh one otherwise: opening the tab must
      // show something, not a screen waiting for a click.
      const opened = conversations.length > 0
        ? await window.rota.openChat(jobId, conversations[0].chatId)
        : await window.rota.createChat(jobId)
      if (active) adopt(opened)
    })
    return () => {
      active = false
    }
  }, [jobId, refreshList, adopt])

  const select = async (chatId) => {
    if (chatId === chat?.chatId) return
    adopt(await window.rota.openChat(jobId, chatId))
  }

  const create = async () => {
    adopt(await window.rota.createChat(jobId))
    await refreshList()
  }

  const forget = async (chatId) => {
    await window.rota.deleteChat(jobId, chatId)
    const remaining = await refreshList()
    if (chatId !== chat?.chatId) return
    // We have just deleted the one being looked at: we move on to the next, or
    // to a fresh one — the tab does not stay on a thread that no longer exists.
    adopt(
      remaining.length > 0
        ? await window.rota.openChat(jobId, remaining[0].chatId)
        : await window.rota.createChat(jobId),
    )
  }

  useEffect(
    () =>
      window.rota.onChatEvent((event) => {
        // Only one conversation is displayed, but the channel is shared.
        if (chat && event.chatId !== chat.chatId) return
        setMessages((current) => reduce(current, event))
        if (event.type === 'turn-end') setBusy(false)
      }),
    [chat],
  )

  // Follow the bottom of the thread while the answer composes itself.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [messages])

  const send = async () => {
    const content = draft.trim()
    if (content === '' || busy || !chat) return
    setBusy(true)
    setDraft('')
    const result = await window.rota.sendChat(chat.chatId, content)
    if (!result.ok) {
      setMessages((current) => reduce(current, { type: 'error', text: result.error }))
      setBusy(false)
    }
    // A conversation's summary — its title, its message count — only changes
    // here. Without this refresh the sidebar keeps what it had when the tab was
    // opened, and a fresh thread stays "empty" for ever.
    await refreshList()
  }

  const rename = async (chatId, title) => {
    await window.rota.renameChat(jobId, chatId, title === '' ? null : title)
    const conversations = await refreshList()
    // The header carries the displayed thread's title: it has to follow.
    const renommee = conversations.find((conversation) => conversation.chatId === chat?.chatId)
    if (renommee) setChat((current) => ({ ...current, title: renommee.title, named: renommee.named }))
  }

  const onKeyDown = (event) => {
    // Enter sends, Shift+Enter breaks the line: the messaging convention.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-tab-inner">
      <Conversations
        list={list}
        current={chat?.chatId}
        onSelect={select}
        onCreate={create}
        onRename={rename}
        onDelete={forget}
      />

      <div className="chat">
        <header className="chat-header">
          <span className="thread-title">{chat?.title ?? 'Opening…'}</span>
          <span className="meta">
            {chat ? `${chat.model} @ ${chat.baseUrl}` : ''}
            {chat?.sandboxed ? ' · sandboxed' : ''}
          </span>
        </header>

        {chat?.running ? (
          <div className="chat-warning">
            A scheduled execution of this job is running: both agents share the same working
            directory and the same memory.
          </div>
        ) : null}

        <div className="chat-log" ref={log}>
          {messages.length === 0 ? (
            <p className="chat-empty">
              The job’s prompt is already in the field below. Edit it, send, and whatever the
              agent memorises here it will find again on its next execution.
            </p>
          ) : (
            messages.map((message, index) => <Message key={index} message={message} />)
          )}
        </div>

        <div className="chat-input">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Your message"
            disabled={busy || !chat}
          />
          <div className="actions">
            <span className="hint">Enter to send, Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" onClick={() => window.rota.stopChat(chat.chatId)}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={send}
                disabled={draft.trim() === '' || !chat}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
