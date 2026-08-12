'use strict'

// Job templates, offered at creation time from the interface.
//
// A template produces a complete, valid definition, written as it is into jobs/;
// the editor then opens on it. The goal is not to guess what the user wants, but
// to spare them the structure of the file and to put plausible absolute paths in
// place — the schema refuses relative ones.
//
// Jobs are created **disabled**. A template does not yet do what the user wants,
// and for the types that point at a file, that file does not even exist: enabled,
// the job would fail — and notify — on every interval. Enabling is the gesture
// that says "it is ready".

const path = require('node:path')

const SCHEMA = 'https://rota.local/schemas/job.schema.json'

/** "my-backup" → "My backup". The user corrects it afterwards. */
function humanize(id) {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function base(id, triggers) {
  return {
    $schema: SCHEMA,
    id,
    name: humanize(id),
    description: '',
    enabled: false,
    triggers,
  }
}

// One trigger per template: it is one the user is going to correct, and two to
// correct are worth less than one plus the button to add another.
const every = (value, unit) => [{ type: 'interval', every: value, unit }]
const cron = (expression) => [{ type: 'cron', expression }]

// Starting code of an inline job: shows the change marker and the output
// convention, without doing anything destructive.
const INLINE_STARTER = `// Run by Bun. The working directory, the environment variables and the timeout
// all come from the job definition.

const now = new Date().toLocaleString('en-GB')
console.log(\`Nothing to do for now (\${now})\`)

// Report a real effect — with "onChange": true, this is the only situation that
// sends a notification:
// console.log('::rota:changed:: 3 items processed')

// Show a report, as an agent's \`report\` tool would. \`report_discord\` sends it
// to the channel instead, and everything up to \`::rota:end::\` is the body:
// console.log('::rota:report:: What I found')
// console.log('- nothing worth waking you for')
// console.log('::rota:end::')

// A non-zero exit code marks the execution as failed:
// process.exit(1)
`

// Starting prompts of an agent job.
//
// The system prompt starts with the reference to Rota's instructions rather
// than copying them: they evolve with the application, and a copy taken today
// would age inside every job ever created. What follows is what one adds on top,
// specific to the job.
const AGENT_SYSTEM_STARTER = `\${defaults.system_prompt}

# Instructions specific to this job

Replace this paragraph with what sets this job apart from the others: a domain,
a tone, constraints, what to watch out for.

Remove the first line to start from instructions entirely your own.`

const AGENT_PROMPT_STARTER = `Describe here what you expect from the agent.

For example: check that https://example.com responds, compare with what you
remembered last time, and only write a report if the state has changed.`

// JSON accepts no comment — neither JSON.parse nor the schema. This field is the
// only free text in a definition: it therefore carries what a comment would,
// starting with the tools one does not enable by default but whose name must be
// known to add them.
const AGENT_DESCRIPTION = `To be completed. Tools you can enable in runner.agent.tools.enabled: \
fetch, exec, shell, file_read, file_list, file_write, file_del, todo, memory, report, \
report_discord, ask_user, confirm, signal_change, run_job, sub_agent. Hover any field in the \
editor to read its description.`

const TEMPLATES = [
  {
    id: 'bun-inline',
    label: 'Inline code (Bun)',
    description:
      'The JavaScript code lives in the job itself, edited in the Code tab. ' +
      'No file to manage on the side.',
    build: (id) => ({
      ...base(id, every(15, 'minutes')),
      runner: {
        type: 'bun-inline',
        code: INLINE_STARTER,
        args: [],
        environment: {},
      },
      execution: { timeoutSeconds: 300 },
      notifications: { onError: true },
    }),
  },
  {
    id: 'bun-inline-cron',
    label: 'Inline code, at a fixed time',
    description:
      'Like the previous one, but scheduled by a cron expression — here Monday to ' +
      'Friday at 9am. An interval cannot express that.',
    build: (id) => ({
      ...base(id, cron('0 9 * * 1-5')),
      runner: {
        type: 'bun-inline',
        code: INLINE_STARTER,
        args: [],
        environment: {},
      },
      execution: { timeoutSeconds: 300 },
      notifications: { onError: true },
    }),
  },
  {
    id: 'bun',
    label: 'Bun script',
    description: 'A JavaScript or TypeScript script run by Bun.',
    build: (id, { scriptsDir }) => ({
      ...base(id, every(15, 'minutes')),
      runner: {
        type: 'bun',
        script: path.join(scriptsDir, `${id}.js`),
        args: [],
        environment: {},
      },
      execution: { timeoutSeconds: 300 },
      notifications: { onError: true },
    }),
  },
  {
    id: 'shell',
    label: 'Shell script',
    description: 'An sh or bash script.',
    build: (id, { scriptsDir }) => ({
      ...base(id, every(15, 'minutes')),
      runner: {
        type: 'shell',
        interpreter: 'sh',
        script: path.join(scriptsDir, `${id}.sh`),
        args: [],
        environment: {},
      },
      execution: { timeoutSeconds: 300 },
      notifications: { onError: true },
    }),
  },
  {
    id: 'workflow',
    label: 'Workflow',
    description:
      'Chains steps, one after another: code written on the spot, or a reference to a job you ' +
      'already have. The whole chain is one execution, with one history entry.',
    build: (id) => ({
      ...base(id, cron('0 9 * * 1-5')),
      description:
        'To be completed. A step names a job in "job", or carries its own runner in "runner" — ' +
        'the same fields as a job\'s, minus the workflow type. Add "continueOnError": true to a ' +
        'step that may fail without stopping the rest.',
      runner: {
        type: 'workflow',
        workflow: {
          steps: [
            {
              name: 'First step',
              runner: { type: 'bun-inline', code: INLINE_STARTER, args: [], environment: {} },
            },
            // A second step left as an example commented nowhere: JSON does not
            // allow it. It therefore points at a job to correct, and validation
            // will say which if it does not exist.
            { name: 'Then an existing job', job: 'to-be-replaced' },
          ],
        },
      },
      // A chain lasts the sum of its steps: the timeout of the other types would
      // be reached before the second one finished.
      execution: { timeoutSeconds: 1800 },
      notifications: { onError: true },
    }),
  },
  {
    id: 'agent',
    label: 'Agent',
    description:
      'A language model equipped with tools carries the job out on its own. Say what you want, not how. ' +
      'The generated file carries every setting at its default value, ready to be changed.',
    // The only exhaustive template: the other types fit in five fields one reads
    // at a glance, an agent has some thirty spread over four levels. Discovering
    // them one by one in the schema costs more than writing them all out, even
    // if half are left at their default value.
    build: (id, { agentsDir }) => ({
      ...base(id, cron('0 9 * * 1-5')),
      description: AGENT_DESCRIPTION,
      runner: {
        type: 'agent',
        // Perimeter of the file tools and current directory of the commands.
        // It is also what Rota would choose by itself; it is written so that
        // one knows where the agent works without having to guess.
        workingDirectory: path.join(agentsDir, id),
        args: [],
        environment: {},
        agent: {
          systemPrompt: AGENT_SYSTEM_STARTER,
          prompt: AGENT_PROMPT_STARTER,
          // To check before the first launch: the model must be present locally,
          // and know how to call tools.
          model: 'gemma4:latest',
          reasoningEffort: 'medium',
          temperature: 0.2,
          maxIterations: 25,
          api: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            // Values accept ${VARIABLE}, resolved from the environment or from
            // the .env file in the configuration directory.
            headers: {},
            timeoutSeconds: 120,
            extraBody: {},
          },
          tools: {
            // Read-only, plus memory and reporting. Writing, commands and
            // blocking questions are added explicitly — the full list is in the
            // job's description, and in completion.
            enabled: ['fetch', 'file_read', 'file_list', 'todo', 'memory', 'report'],
            fetch: { allowHosts: [], maxResponseBytes: 262144 },
            system: { timeoutSeconds: 120, maxOutputBytes: 65536 },
            files: { maxReadBytes: 131072 },
            jobs: { allow: [] },
            interaction: { timeoutSeconds: 120 },
          },
          // MCP servers: none by default. An example of each shape is in the
          // README.
          mcp: [],
          memory: { enabled: true, maxEntries: 100 },
        },
      },
      execution: {
        // An agent chains calls to the model: a few minutes, not a few seconds.
        // The timeout of the other types would be reached before the
        // conclusion.
        timeoutSeconds: 900,
        allowConcurrentRuns: false,
        runOnStartup: false,
        catchUpOnWake: true,
        requiresUnlockedSession: false,
        maxOutputBytes: 1048576,
        sandbox: {
          enabled: false,
          image: 'oven/bun:1',
          network: false,
          mountWorkingDirectory: true,
        },
      },
      notifications: { onStart: false, onSuccess: false, onChange: true, onError: true },
      history: { enabled: true, retainExecutions: 500 },
    }),
  },
]

/** Description of the templates for the interface, without the functions. */
function listTemplates() {
  return TEMPLATES.map(({ id, label, description }) => ({ id, label, description }))
}

/**
 * @param {string} templateId
 * @param {string} jobId
 * @param {{scriptsDir: string, agentsDir: string}} paths
 * @returns {object|null} definition to validate, or null if the template is unknown
 */
function buildFromTemplate(templateId, jobId, { scriptsDir, agentsDir }) {
  const template = TEMPLATES.find((candidate) => candidate.id === templateId)
  if (!template) return null
  return template.build(jobId, { scriptsDir, agentsDir })
}

module.exports = { listTemplates, buildFromTemplate, humanize }
