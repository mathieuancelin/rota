import { useEffect, useRef } from 'react'

import monaco, { sourceModelUri } from '../monaco.js'
import jobSchema from '@rota/core/schemas/job.schema.json'
import {
  RUNNER_SEEDS,
  TRIGGER_SEEDS,
  addStep,
  addTrigger,
  applyKindChange,
  deletePath,
  effective as effectiveIn,
  moveStep,
  removeStep,
  removeTrigger,
  schemaDefault as schemaDefaultIn,
  schemaHint as schemaHintIn,
  schemaNode as schemaNodeIn,
  setStepKind,
  stepKind,
  stepsOf,
  writePath,
} from './job-form-model.mjs'

// The schema is supplied once here: the model receives it as an argument so it
// stays loadable outside the bundle.
const schemaNode = (path) => schemaNodeIn(jobSchema, path)
const schemaDefault = (path) => schemaDefaultIn(jobSchema, path)
const schemaHint = (path) => schemaHintIn(jobSchema, path)
const effective = (job, path) => effectiveIn(jobSchema, job, path)

// Editing a job through a form.
//
// The JSON stays the source of truth: this form reads the parsed definition and
// writes back into it, exactly like the text tabs. Nothing is validated here —
// the main process decides on save, and Monaco flags mistakes live on the same
// document.
//
// The labels are written here, but **the explanations come from the schema**: a
// description is written once, and serves both the JSON tooltip and the hint
// under the field. Two texts for the same field would end up contradicting each
// other.
//
// The fields that do not lend themselves to a form — prompts, free request
// bodies — point at the tab that carries them, rather than pretending. The
// exception is a workflow's inline code: the tabs belong to the job, and a
// workflow has as many pieces of code as it has steps, so none of them could
// have one. That code gets a real editor here instead.

// --- inline code -------------------------------------------------------------------

// Same options as the job editor's, minus what a field a few lines tall cannot
// use: no folding, and a discreet gutter.
const CODE_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  lineNumbersMinChars: 3,
  folding: false,
  tabSize: 2,
  renderLineHighlight: 'none',
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  padding: { top: 8, bottom: 8 },
}

/**
 * A step's inline code, in the editor rather than a textarea.
 *
 * Monaco is already loaded — the job's other tabs use it — and its JavaScript
 * grammar is already registered for the "Code" tab. What this costs is one
 * instance per inline step, not a second editor.
 *
 * The theme is not set here: it is global to Monaco, and the job editor already
 * follows the appearance settings for its own tabs. Setting it again would give
 * two places to keep in step.
 */
function CodeField({ jobId, index, value, onChange, language = 'javascript', extension = 'js' }) {
  const container = useRef(null)
  const model = useRef(null)
  // The callback changes on every render; the editor is created once. Reading
  // it through a ref avoids rebuilding the instance at each keystroke.
  const notify = useRef(onChange)
  notify.current = onChange
  // Writing the value back into the model must not be mistaken for typing.
  const applying = useRef(false)

  useEffect(() => {
    if (!container.current) return

    const uri = sourceModelUri(jobId || 'sans-nom', `step-${index}`, extension)
    const created =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(value ?? '', language, uri)
    model.current = created

    const instance = monaco.editor.create(container.current, { ...CODE_OPTIONS, model: created })
    const subscription = created.onDidChangeContent(() => {
      if (applying.current) return
      notify.current(created.getValue())
    })

    return () => {
      subscription.dispose()
      instance.dispose()
      created.dispose()
      model.current = null
    }
    // The identity of the field, not its content: rebuilding on every keystroke
    // would lose the cursor.
  }, [jobId, index, language, extension])

  // A value that changed elsewhere — a step moved up or down, an edit from the
  // JSON tab. The models are keyed by rank, so moving a step hands its editor
  // the neighbour's code.
  useEffect(() => {
    const created = model.current
    if (!created || value === undefined || created.getValue() === value) return
    applying.current = true
    created.setValue(value)
    applying.current = false
  }, [value])

  return <div className="code-field" ref={container} />
}

// --- tools -------------------------------------------------------------------------

const TOOL_LABELS = [
  ['fetch', 'fetch — HTTP calls'],
  ['exec', 'exec — command + arguments, no shell'],
  ['shell', 'shell — command line handed to sh -c'],
  ['file_read', 'file_read — read a file'],
  ['file_list', 'file_list — list a directory'],
  ['file_write', 'file_write — write a file'],
  ['file_del', 'file_del — delete'],
  ['todo', 'todo — in-memory work list'],
  ['memory', 'memory — memory between executions'],
  ['report', 'report — markdown report window'],
  ['report_discord', 'report_discord — report to a Discord webhook'],
  ['ask_user', 'ask_user — blocking question'],
  ['confirm', 'confirm — blocking confirmation'],
  ['signal_change', 'signal_change — report a real effect'],
  ['run_job', 'run_job — trigger a job, or its own after a delay'],
  ['sub_agent', 'sub_agent — delegate a task to a second agent of this job'],
  ['work_create', 'work_create — queue work for a job, handled later on its own'],
  ['work_fail', 'work_fail — give up for good on the queue item being processed'],
]

const UNITS = [
  ['seconds', 'seconds'],
  ['minutes', 'minutes'],
  ['hours', 'hours'],
  ['days', 'days'],
]

// The two returns a job can wait for. Locking and going to sleep are absent on
// purpose: a job started as the machine leaves is a job that gets killed
// halfway through.
const POWER_EVENTS = [
  ['wake', 'the machine wakes'],
  ['unlock', 'the screen is unlocked'],
]

const AFTER_OUTCOMES = [
  ['success', 'it succeeded'],
  ['failure', 'it failed or timed out'],
  ['any', 'it ended, either way'],
]

// --- fields ------------------------------------------------------------------------

function Field({ label, hint, children, wide = false }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function Text({ job, path, label, hint, placeholder, onChange, area = false, rows = 3 }) {
  const value = effective(job, path) ?? ''
  const apply = (next) => onChange((draft) => writePath(draft, path, next))
  const shared = {
    value,
    placeholder,
    onChange: (event) => apply(event.target.value),
  }
  return (
    <Field label={label} hint={hint ?? schemaHint(path)} wide={area}>
      {area ? <textarea rows={rows} {...shared} /> : <input type="text" {...shared} />}
    </Field>
  )
}

function Numeric({ job, path, label, hint, step, onChange }) {
  const value = effective(job, path)
  const node = schemaNode(path)
  return (
    <Field label={label} hint={hint ?? schemaHint(path)}>
      <input
        type="number"
        value={value ?? ''}
        min={node?.minimum}
        max={node?.maximum}
        step={step ?? 1}
        // Emptying a field removes it from the definition: the schema's default
        // takes over, which is closer to the intention than leaving a zero in it.
        onChange={(event) =>
          onChange((draft) => {
            const raw = event.target.value
            if (raw === '') deletePath(draft, path)
            else writePath(draft, path, Number(raw))
          })
        }
      />
    </Field>
  )
}

function Toggle({ job, path, label, hint, onChange }) {
  return (
    <label className="field toggle">
      <input
        type="checkbox"
        checked={Boolean(effective(job, path))}
        onChange={(event) => onChange((draft) => writePath(draft, path, event.target.checked))}
      />
      <span>
        <span className="field-label">{label}</span>
        {(hint ?? schemaHint(path)) && (
          <span className="field-hint">{hint ?? schemaHint(path)}</span>
        )}
      </span>
    </label>
  )
}

function Select({ job, path, label, hint, options, onChange }) {
  return (
    <Field label={label} hint={hint ?? schemaHint(path)}>
      <select
        value={effective(job, path) ?? ''}
        onChange={(event) =>
          onChange((draft) => {
            if (event.target.value === '') deletePath(draft, path)
            else writePath(draft, path, event.target.value)
          })
        }
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** A list of strings, one per line: quicker to type than a stack of fields. */
function Lines({ job, path, label, hint, placeholder, onChange }) {
  const value = effective(job, path) ?? []
  return (
    <Field label={label} hint={hint ?? schemaHint(path)} wide>
      <textarea
        rows={3}
        value={value.join('\n')}
        placeholder={placeholder}
        onChange={(event) =>
          onChange((draft) =>
            writePath(
              draft,
              path,
              event.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
            ),
          )
        }
      />
    </Field>
  )
}

/** Key/value pairs: environment variables, HTTP headers. */
function Pairs({ job, path, label, hint, onChange }) {
  const value = effective(job, path) ?? {}
  const entries = Object.entries(value)

  const replace = (next) => onChange((draft) => writePath(draft, path, Object.fromEntries(next)))

  return (
    <Field label={label} hint={hint ?? schemaHint(path)} wide>
      <div className="pairs">
        {entries.map(([key, entryValue], index) => (
          // The index is the key: renaming a variable must not move the row up the
          // list nor lose the cursor.
          <div className="pair" key={index}>
            <input
              type="text"
              value={key}
              placeholder="KEY"
              onChange={(event) =>
                replace(entries.map((pair, at) => (at === index ? [event.target.value, pair[1]] : pair)))
              }
            />
            <input
              type="text"
              value={entryValue}
              placeholder="value"
              onChange={(event) =>
                replace(entries.map((pair, at) => (at === index ? [pair[0], event.target.value] : pair)))
              }
            />
            <button type="button" onClick={() => replace(entries.filter((_, at) => at !== index))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={() => replace([...entries, ['', '']])}>
          Add
        </button>
      </div>
    </Field>
  )
}

function Checklist({ job, path, label, options, onChange }) {
  const value = effective(job, path) ?? []
  const toggle = (name, on) =>
    onChange((draft) =>
      writePath(
        draft,
        path,
        // The catalogue's order rather than the clicks': a stable list reads back,
        // and the JSON does not move about as boxes get ticked.
        options.map(([id]) => id).filter((id) => (id === name ? on : value.includes(id))),
      ),
    )

  return (
    <Field label={label} wide>
      <div className="checklist">
        {options.map(([name, text]) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={value.includes(name)}
              onChange={(event) => toggle(name, event.target.checked)}
            />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </Field>
  )
}

const NEW_CONNECTOR = {
  stdio: { name: '', transport: 'stdio', command: '', args: [], environment: {} },
  http: { name: '', transport: 'http', url: '', headers: {} },
}

/**
 * MCP servers: a list of sub-forms. The fields vary with the transport, as the
 * rest of the definition varies with the job type.
 */
function McpConnectors({ job, onChange }) {
  const path = ['runner', 'agent', 'mcp']
  const connectors = effective(job, path) ?? []

  const replace = (next) => onChange((draft) => writePath(draft, path, next))

  return (
    <Section title="Agent — MCP servers">
      <Field label="" hint={schemaHint(path)} wide>
        <div className="pairs">
          {connectors.map((connector, index) => {
            const at = (...keys) => [...path, index, ...keys]
            const props = { job, onChange }
            return (
              <div className="connector" key={index}>
                <div className="fields">
                  <Text {...props} path={at('name')} label="Name" hint="Tool prefix." />
                  <Select
                    {...props}
                    path={at('transport')}
                    label="Transport"
                    options={[
                      ['stdio', 'stdio — processus enfant'],
                      ['http', 'http — serveur distant'],
                    ]}
                  />

                  {connector.transport === 'stdio' ? (
                    <>
                      <Text {...props} path={at('command')} label="Command" placeholder="npx" />
                      <Lines {...props} path={at('args')} label="Arguments" placeholder="one per line" />
                      <Pairs {...props} path={at('environment')} label="Variables" />
                    </>
                  ) : (
                    <>
                      <Text
                        {...props}
                        path={at('url')}
                        label="URL"
                        placeholder="https://example.com/mcp"
                      />
                      <Pairs {...props} path={at('headers')} label="Headers" />
                    </>
                  )}

                  <Numeric {...props} path={at('timeoutSeconds')} label="Timeout (s)" />
                  <Lines
                    {...props}
                    path={at('tools', 'allow')}
                    label="Tools kept"
                    placeholder="empty = all · original name, without the prefix"
                  />
                  <Toggle {...props} path={at('enabled')} label="Connector enabled" />
                </div>
                <button
                  type="button"
                  onClick={() => replace(connectors.filter((_, on) => on !== index))}
                >
                  Retirer ce serveur
                </button>
              </div>
            )
          })}

          <div className="actions">
            {Object.entries(NEW_CONNECTOR).map(([transport, seed]) => (
              <button
                key={transport}
                type="button"
                onClick={() => replace([...connectors, structuredClone(seed)])}
              >
                Ajouter un serveur {transport}
              </button>
            ))}
          </div>
        </div>
      </Field>
    </Section>
  )
}

function Section({ title, children }) {
  return (
    <section className="form-section">
      <h2>{title}</h2>
      <div className="fields">{children}</div>
    </section>
  )
}

const Note = ({ children }) => <p className="form-note">{children}</p>

// --- triggers ----------------------------------------------------------------------

/**
 * One trigger, with only the fields of its type.
 *
 * Changing the type removes the old one's fields rather than leaving them
 * dormant in the file: validation refuses them, and an interval forgotten on a
 * cron trigger is precisely the kind of leftover one does not see.
 */
function Trigger({ job, onChange, index, trigger, onRemove }) {
  const props = { job, onChange }
  const type = trigger.type ?? 'interval'
  const at = (...keys) => ['triggers', index, ...keys]

  return (
    <div className="trigger">
      <div className="trigger-head">
        <Field label={`Trigger ${index + 1}`} hint={schemaHint(at('type'))}>
          <select
            value={type}
            onChange={(event) =>
              onChange((draft) => applyKindChange(draft, at(), event.target.value, TRIGGER_SEEDS))
            }
          >
            <option value="interval">Interval</option>
            <option value="cron">Cron expression</option>
            <option value="webhook">Webhook</option>
            <option value="discord">Discord keyword</option>
            <option value="power">Machine wakes or unlocks</option>
            <option value="after">Another job finished</option>
            <option value="path">A file or directory changed</option>
            <option value="once">Once, at a given moment</option>
            <option value="work">Work is waiting in its queue</option>
          </select>
        </Field>
        <button type="button" className="link" onClick={onRemove} title="Remove this trigger">
          Remove
        </button>
      </div>

      {type === 'interval' && (
        <>
          <Numeric {...props} path={at('every')} label="Every" />
          <Select {...props} path={at('unit')} label="Unit" options={UNITS} />
        </>
      )}
      {type === 'cron' && (
        <Text {...props} path={at('expression')} label="Expression" placeholder="0 9 * * 1-5" />
      )}
      {type === 'webhook' && (
        <>
          <Text {...props} path={at('token')} label="Token" placeholder="the server’s by default" />
          <Note>
            The HTTP server and its webhook endpoint are turned on under Settings → HTTP.
          </Note>
        </>
      )}
      {type === 'discord' && (
        <Text {...props} path={at('keyword')} label="Keyword" placeholder="deploy" />
      )}
      {type === 'power' && (
        <>
          <Select {...props} path={at('event')} label="When" options={POWER_EVENTS} />
          <Note>
            A Mac wakes at the lock screen, before anybody has typed anything. Pick the
            unlock when the job needs the keychain, the network as you left it, or you.
          </Note>
        </>
      )}
      {type === 'work' && (
        <>
          <Numeric {...props} path={at('maxAttempts')} label="Attempts at most" />
          <Numeric {...props} path={at('backoffSeconds')} label="Backoff (seconds)" />
          <Note>
            The job takes its items one at a time until the queue is empty, then stops — no
            model is asked anything to discover there is nothing to do. An item that fails
            leaves the queue for the backoff, doubling each time, and is given up on past the
            ceiling. Queue work with <code>rotactl work add</code> or POST /api/work.
          </Note>
        </>
      )}
      {type === 'after' && (
        <>
          <Text {...props} path={at('job')} label="After the job" placeholder="backup" />
          <Select {...props} path={at('on')} label="When" options={AFTER_OUTCOMES} />
          <Note>
            A job started this way starts no others in turn — chaining steps in order is
            what a workflow job is for. A job cannot wait for itself.
          </Note>
        </>
      )}

      {type === 'once' && (
        <>
          <Text {...props} path={at('at')} label="At" placeholder="2026-09-01T09:00:00Z" />
          <Note>
            An ISO date and time. It runs once and never again. A moment already past
            is not dropped — the job runs when Rota next gets the chance, which is what
            “once at nine” means when the machine was off at nine. Delete the trigger to
            cancel it.
          </Note>
        </>
      )}
      {type === 'path' && (
        <>
          <Text {...props} path={at('path')} label="Path" placeholder="/Users/you/Downloads" />
          <Numeric {...props} path={at('settleSeconds')} label="Quiet for (seconds)" />
          <Note>
            A directory is watched recursively. The job starts once the writing has
            stopped, not on the first change — unpacking an archive is one event, not
            five hundred. Two seconds if you leave it empty.
          </Note>
        </>
      )}

      <Toggle {...props} path={at('enabled')} label="Trigger enabled" />
    </div>
  )
}


// --- workflow steps ---------------------------------------------------------------

const STEP_KIND_LABELS = [
  ['job', 'Run an existing job'],
  ['bun-inline', 'Inline code (Bun)'],
  ['bun', 'Bun script'],
  ['shell', 'Shell script'],
  ['agent', 'Agent'],
]

/**
 * A workflow step.
 *
 * It names a job or carries a runner, and the selector switches from one to the
 * other, taking the abandoned shape with it — the two together cannot be told
 * apart, and validation refuses them.
 *
 * What an agent has that runs deep — tools, MCP connectors, headers — stays in
 * the JSON tab: putting it here would double half the form for settings you
 * touch once.
 */
function Step({ job, onChange, index, step, total }) {
  const props = { job, onChange }
  const kind = stepKind(step)
  const at = (...keys) => ['runner', 'workflow', 'steps', index, ...keys]
  const move = (direction) => onChange((draft) => moveStep(draft, index, direction))

  return (
    <div className="step">
      <div className="step-head">
        <span className="step-rank">{index + 1}</span>
        <Field label="Name" hint={schemaHint(at('name'))}>
          <input
            type="text"
            value={effective(job, at('name')) ?? ''}
            placeholder={kind === 'job' ? step.job || 'the job’s name' : kind}
            onChange={(event) => onChange((draft) => writePath(draft, at('name'), event.target.value))}
          />
        </Field>
        <div className="step-actions">
          <button type="button" onClick={() => move(-1)} disabled={index === 0} title="Move up">
            ↑
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={index === total - 1}
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className="link"
            title="Remove this step"
            onClick={() => onChange((draft) => removeStep(draft, index))}
          >
            ✕
          </button>
        </div>
      </div>

      <Field label="Does what" hint={schemaHint(at('job'))}>
        <select
          value={kind}
          onChange={(event) => onChange((draft) => setStepKind(draft, index, event.target.value))}
        >
          {STEP_KIND_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      {kind === 'job' && (
        <>
          <Text {...props} path={at('job')} label="Job identifier" placeholder="run-tests" />
          <Note>
            It runs with its own definition, but writes no history entry and sends no
            notification: the workflow tells the whole story in one entry.
          </Note>
        </>
      )}

      {(kind === 'bun' || kind === 'shell') && (
        <Text {...props} path={at('runner', 'script')} label="Script" placeholder="/Users/you/…" />
      )}
      {kind === 'shell' && (
        <Select
          {...props}
          path={at('runner', 'interpreter')}
          label="Interpreter"
          options={[
            ['sh', 'sh'],
            ['bash', 'bash'],
          ]}
        />
      )}
      {kind === 'bun-inline' && (
        <Field label="Code" hint={schemaHint(at('runner', 'code'))} wide>
          <CodeField
            jobId={job.id}
            index={index}
            value={effective(job, at('runner', 'code')) ?? ''}
            onChange={(next) =>
              onChange((draft) => writePath(draft, at('runner', 'code'), next))
            }
          />
        </Field>
      )}
      {kind === 'agent' && (
        <>
          <Text {...props} path={at('runner', 'agent', 'model')} label="Model" placeholder="gemma4:latest" />
          <Text {...props} path={at('runner', 'agent', 'api', 'baseUrl')} label="API" />
          <Text {...props} path={at('runner', 'agent', 'prompt')} label="Prompt" area rows={5} />
          <Note>Tools, MCP connectors and the rest of the agent stay in the “JSON” tab.</Note>
        </>
      )}

      {kind !== 'job' && (
        <Text
          {...props}
          path={at('runner', 'workingDirectory')}
          label="Working directory"
          placeholder="the workflow’s, otherwise"
        />
      )}

      <Toggle {...props} path={at('continueOnError')} label="Carry on if this step fails" />
      <Toggle {...props} path={at('receivesPreviousSteps')} label="Receive what the previous steps produced" />
    </div>
  )
}

// --- formulaire -------------------------------------------------------------------------

export default function JobForm({ job, onChange, profiles = [] }) {
  const props = { job, onChange }
  const runnerType = job.runner?.type
  // A job either writes its agent out here or names a reusable one. The two are
  // edited in different places — the fields below belong to the written-out
  // form, and a job that points at a profile has none of them to fill in.
  const referenced = typeof job.runner?.agent === 'string'
  const triggers = Array.isArray(job.triggers) ? job.triggers : []
  const steps = stepsOf(job)
  const agentTools = job.runner?.agent?.tools?.enabled ?? schemaDefault(
    ['runner', 'agent', 'tools', 'enabled'],
  ) ?? []
  const sandboxed = Boolean(effective(job, ['execution', 'sandbox', 'enabled']))

  const switchKind = (path, table) => (kind) =>
    onChange((draft) => applyKindChange(draft, path, kind, table))

  return (
    <div className="form">
      <Section title="Identity">
        <Text {...props} path={['name']} label="Name" hint="Shown in the interface and in notifications." />
        <Text {...props} path={['description']} label="Description" area />
        <Toggle {...props} path={['enabled']} label="Scheduling enabled" />
      </Section>

      <Section title="Triggers">
        {triggers.length === 0 ? (
          <Note>
            No trigger: this job only runs on demand — from the list, from the tray menu, from
            Discord, or from another job.
          </Note>
        ) : (
          triggers.map((trigger, index) => (
            <Trigger
              key={index}
              {...props}
              index={index}
              trigger={trigger}
              onRemove={() => onChange((draft) => removeTrigger(draft, index))}
            />
          ))
        )}
        <div className="form-actions">
          <button type="button" onClick={() => onChange((draft) => addTrigger(draft))}>
            Add a trigger
          </button>
        </div>
      </Section>

      <Section title="Execution">
        <Field label="Type" hint={schemaHint(['runner', 'type'])}>
          <select
            value={runnerType ?? 'bun'}
            onChange={(event) => switchKind(['runner'], RUNNER_SEEDS)(event.target.value)}
          >
            <option value="bun">Bun script</option>
            <option value="bun-inline">Inline code (Bun)</option>
            <option value="shell">Shell script</option>
            <option value="agent">Agent</option>
            <option value="workflow">Workflow</option>
          </select>
        </Field>

        {(runnerType === 'bun' || runnerType === 'shell') && (
          <Text {...props} path={['runner', 'script']} label="Script" placeholder="/Users/you/…" />
        )}
        {runnerType === 'shell' && (
          <Select
            {...props}
            path={['runner', 'interpreter']}
            label="Interpreter"
            options={[
              ['sh', 'sh'],
              ['bash', 'bash'],
            ]}
          />
        )}
        {runnerType === 'bun-inline' && <Note>The code is edited in the “Code” tab.</Note>}
        {runnerType === 'agent' && (
          <Note>The prompts are edited in the “Prompt” and “System” tabs.</Note>
        )}
        {runnerType === 'workflow' && (
          <Note>
            {steps.length} step{steps.length === 1 ? '' : 's'}, edited below.
          </Note>
        )}

        <Text
          {...props}
          path={['runner', 'workingDirectory']}
          label="Working directory"
          placeholder={runnerType === 'agent' ? 'agents/<id> by default' : 'the script’s directory by default'}
        />
        {runnerType !== 'agent' && (
          <Lines {...props} path={['runner', 'args']} label="Arguments" placeholder="one per line" />
        )}
        <Pairs {...props} path={['runner', 'environment']} label="Environment variables" />
      </Section>

      {runnerType === 'workflow' && (
        <Section title="Steps">
          {steps.length === 0 ? (
            <Note>No step yet: a workflow with none has nothing to run.</Note>
          ) : (
            steps.map((step, index) => (
              <Step key={index} {...props} index={index} step={step} total={steps.length} />
            ))
          )}
          <div className="form-actions">
            <button type="button" onClick={() => onChange((draft) => addStep(draft))}>
              Add a step
            </button>
          </div>
        </Section>
      )}

      {runnerType === 'agent' && referenced && (
        <Section title="Agent">
          <Select
            {...props}
            path={['runner', 'agent']}
            label="Reusable agent"
            options={[
              ...profiles.map((profile) => [profile.id, `${profile.name} — ${profile.model}`]),
              // Kept in the list even when it is not there: dropping it would
              // silently rewrite the job to the first profile that happens to
              // exist, which is not what a broken reference calls for.
              ...(profiles.some((profile) => profile.id === job.runner.agent)
                ? []
                : [[job.runner.agent, `${job.runner.agent} — missing`]]),
            ]}
          />
          <Text {...props} path={['runner', 'prompt']} label="Prompt" area rows={5} />
          <Note>
            The model, the instructions, the tools and the memory come from the agent, editable
            under “Agents”. What this job wants different goes in{' '}
            <code className="mono">agentOverrides</code>, in the “Definition” tab.
          </Note>
        </Section>
      )}

      {runnerType === 'agent' && !referenced && (
        <>
          <Section title="Agent — model">
            <Text {...props} path={['runner', 'agent', 'model']} label="Model" />
            <Select
              {...props}
              path={['runner', 'agent', 'reasoningEffort']}
              label="Reasoning effort"
              options={[
                ['', '— none'],
                ['low', 'low'],
                ['medium', 'medium'],
                ['high', 'high'],
              ]}
            />
            <Numeric {...props} path={['runner', 'agent', 'temperature']} label="Temperature" step={0.1} />
            <Numeric {...props} path={['runner', 'agent', 'maxIterations']} label="Maximum turns" />
          </Section>

          <Section title="Agent — connection">
            <Text {...props} path={['runner', 'agent', 'api', 'baseUrl']} label="API URL" />
            <Numeric
              {...props}
              path={['runner', 'agent', 'api', 'timeoutSeconds']}
              label="Timeout per request (s)"
            />
            <Pairs {...props} path={['runner', 'agent', 'api', 'headers']} label="Headers" />
            <Note>
              The extra request body (<code className="mono">extraBody</code>) is edited in the
              “Definition” tab.
            </Note>
          </Section>

          <Section title="Agent — tools">
            <Checklist
              {...props}
              path={['runner', 'agent', 'tools', 'enabled']}
              label="Tools made available"
              options={TOOL_LABELS}
            />
            {agentTools.includes('fetch') && (
              <>
                <Lines
                  {...props}
                  path={['runner', 'agent', 'tools', 'fetch', 'allowHosts']}
                  label="Allowed hosts"
                  placeholder="empty = all · one per line · .example.com covers subdomains"
                />
                <Numeric
                  {...props}
                  path={['runner', 'agent', 'tools', 'fetch', 'maxResponseBytes']}
                  label="Maximum response (bytes)"
                />
              </>
            )}
            {agentTools.includes('report_discord') && (
              <Note>
                The webhook address is declared once and for all under “Settings → Discord”.
                Reports go out under the job’s name.
              </Note>
            )}
            {(agentTools.includes('exec') || agentTools.includes('shell')) && (
              <>
                <Numeric
                  {...props}
                  path={['runner', 'agent', 'tools', 'system', 'timeoutSeconds']}
                  label="Timeout per command (s)"
                />
                <Numeric
                  {...props}
                  path={['runner', 'agent', 'tools', 'system', 'maxOutputBytes']}
                  label="Maximum output (bytes)"
                />
              </>
            )}
            {agentTools.some((name) => name.startsWith('file_')) && (
              <Numeric
                {...props}
                path={['runner', 'agent', 'tools', 'files', 'maxReadBytes']}
                label="Maximum read (bytes)"
              />
            )}
            {agentTools.includes('run_job') && (
              <Lines
                {...props}
                path={['runner', 'agent', 'tools', 'jobs', 'allow']}
                label="Triggerable jobs"
                placeholder="empty = all · one identifier per line"
              />
            )}
            {(agentTools.includes('ask_user') || agentTools.includes('confirm')) && (
              <Numeric
                {...props}
                path={['runner', 'agent', 'tools', 'interaction', 'timeoutSeconds']}
                label="Answer timeout (s)"
              />
            )}
          </Section>

          <McpConnectors {...props} />

          <Section title="Agent — memory">
            <Toggle {...props} path={['runner', 'agent', 'memory', 'enabled']} label="Memory enabled" />
            <Numeric {...props} path={['runner', 'agent', 'memory', 'maxEntries']} label="Maximum entries" />
          </Section>
        </>
      )}

      <Section title="Execution conditions">
        <Numeric {...props} path={['execution', 'timeoutSeconds']} label="Timeout (s)" />
        <Numeric {...props} path={['execution', 'maxOutputBytes']} label="Output kept (bytes)" />
        <Toggle {...props} path={['execution', 'allowConcurrentRuns']} label="Concurrent executions" />
        <Toggle {...props} path={['execution', 'runOnStartup']} label="Run at startup" />
        <Toggle {...props} path={['execution', 'catchUpOnWake']} label="Catch up on wake" />
        <Toggle
          {...props}
          path={['execution', 'requiresUnlockedSession']}
          label="Requires an unlocked session"
        />
      </Section>

      <Section title="Sandbox">
        <Toggle {...props} path={['execution', 'sandbox', 'enabled']} label="Run in a container" />
        {sandboxed && (
          <>
            <Text {...props} path={['execution', 'sandbox', 'image']} label="Docker image" />
            <Toggle {...props} path={['execution', 'sandbox', 'network']} label="Container network" />
            <Toggle
              {...props}
              path={['execution', 'sandbox', 'mountWorkingDirectory']}
              label="Mount the working directory"
            />
          </>
        )}
      </Section>

      <Section title="Notifications">
        <Toggle {...props} path={['notifications', 'onStart']} label="On start" />
        <Toggle {...props} path={['notifications', 'onSuccess']} label="On every success" />
        <Toggle {...props} path={['notifications', 'onChange']} label="Only when something changed" />
        <Toggle {...props} path={['notifications', 'onError']} label="On failure" />
      </Section>

      <Section title="History">
        <Toggle {...props} path={['history', 'enabled']} label="Keep executions" />
        <Numeric {...props} path={['history', 'retainExecutions']} label="Executions kept" />
      </Section>
    </div>
  )
}
