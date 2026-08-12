'use strict'

// OpenAPI description of what the server serves.
//
// Written as data, in one place, and held against the router: a test calls every
// operation described here and checks that it exists, then reads back the
// actions the router handles and checks that none was forgotten here. A
// description that ages without anyone noticing is worse than none: it sends
// people calling addresses that have gone.
//
// The webhook appears here on the same footing as the API, although it lives
// behind a flag of its own: it is the address handed to a third party, hence
// precisely the one that needs describing.
//
// The description is served behind the token, like the rest of the API. What it
// contains is no secret — the routes are in the README and in the code — but
// making it public would turn the API into its own directory, which the rest of
// the server takes care to avoid.

const ERROR_SCHEMA = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
}

const jobSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    enabled: { type: 'boolean' },
    stale: { type: 'boolean', description: 'The file is currently invalid; the last valid version is running.' },
    runner: { type: 'string', enum: ['bun', 'bun-inline', 'shell', 'agent', 'workflow'] },
    runnerLabel: { type: 'string' },
    triggers: { type: 'array', items: { type: 'object' } },
    triggerLabel: { type: 'string' },
    running: { type: 'integer' },
    nextRunAt: { type: ['string', 'null'], format: 'date-time' },
    lastRun: { type: ['object', 'null'] },
  },
}

const UNAUTHORIZED = {
  description:
    'Missing or wrong token. Answered the same way as an unknown job, so that the API does not ' +
    'double as a directory for whoever probes it.',
  content: { 'application/json': { schema: ERROR_SCHEMA } },
}
const NOT_FOUND = {
  description: 'No such route, or no such job. A surface that is off answers this too: it is not there.',
  content: { 'application/json': { schema: ERROR_SCHEMA } },
}

const jobIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Job identifier — the name of its file in jobs/, without the extension.',
  schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$' },
}

const json = (schema, description) => ({
  description,
  content: { 'application/json': { schema } },
})

/**
 * The operations, in a shape a test can replay against the router.
 * `path` carries {id} wherever the router expects an identifier.
 */
const OPERATIONS = [
  {
    method: 'get',
    path: '/api/status',
    tag: 'Scheduler',
    summary: 'Scheduler state, running executions, job count',
    responses: {
      200: json({
        type: 'object',
        properties: {
          paused: { type: 'boolean' },
          sessionLocked: { type: 'boolean' },
          running: { type: 'array', items: { type: 'object' } },
          jobs: { type: 'integer' },
        },
      }, 'The current state.'),
    },
  },
  {
    method: 'post',
    path: '/api/scheduler/pause',
    tag: 'Scheduler',
    summary: 'Suspend the scheduler',
    description: 'Jobs stay loaded; no trigger fires. Running by hand still works.',
    responses: { 200: json({ type: 'object', properties: { paused: { type: 'boolean' } } }, 'Suspended.') },
  },
  {
    method: 'post',
    path: '/api/scheduler/resume',
    tag: 'Scheduler',
    summary: 'Resume the scheduler',
    responses: { 200: json({ type: 'object', properties: { paused: { type: 'boolean' } } }, 'Resumed.') },
  },
  {
    method: 'get',
    path: '/api/jobs',
    tag: 'Jobs',
    summary: 'List the jobs',
    description: 'Neither the code of a job nor an agent’s prompt is returned.',
    responses: {
      200: json({ type: 'object', properties: { jobs: { type: 'array', items: jobSchema } } }, 'The jobs.'),
    },
  },
  {
    method: 'get',
    path: '/api/jobs/{id}',
    tag: 'Jobs',
    summary: 'One job',
    parameters: [jobIdParam],
    responses: { 200: json(jobSchema, 'The job.'), 404: NOT_FOUND },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/run',
    tag: 'Jobs',
    summary: 'Run a job now',
    description: 'Overrides the pause and the screen lock: asking for an execution assumes having the machine in hand.',
    parameters: [jobIdParam],
    responses: {
      202: json({ type: 'object', properties: { started: { type: 'string' } } }, 'Started.'),
      404: NOT_FOUND,
      409: json(ERROR_SCHEMA, 'The scheduler refused to start it.'),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/stop',
    tag: 'Jobs',
    summary: 'Stop its running executions',
    parameters: [jobIdParam],
    responses: {
      200: json({ type: 'object', properties: { stopping: { type: 'array', items: { type: 'string' } } } }, 'Stop requested.'),
      404: NOT_FOUND,
      409: json(ERROR_SCHEMA, 'Nothing was running.'),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/enable',
    tag: 'Jobs',
    summary: 'Let its triggers fire',
    parameters: [jobIdParam],
    responses: { 200: json({ type: 'object' }, 'Enabled.'), 404: NOT_FOUND, 422: json(ERROR_SCHEMA, 'Refused.') },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/disable',
    tag: 'Jobs',
    summary: 'Silence every trigger — timer, webhook and keyword alike',
    parameters: [jobIdParam],
    responses: { 200: json({ type: 'object' }, 'Disabled.'), 404: NOT_FOUND, 422: json(ERROR_SCHEMA, 'Refused.') },
  },
  {
    method: 'get',
    path: '/api/jobs/{id}/history',
    tag: 'Jobs',
    summary: 'The last executions',
    parameters: [
      jobIdParam,
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Between 1 and 200. 20 by default.',
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      },
    ],
    responses: {
      200: json({ type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } } } }, 'The entries, most recent first.'),
      404: NOT_FOUND,
    },
  },
  {
    method: 'get',
    path: '/api/jobs/{id}/logs',
    tag: 'Jobs',
    summary: 'Output of the running execution, otherwise of the last one',
    parameters: [jobIdParam],
    responses: {
      200: json({
        type: 'object',
        properties: {
          executionId: { type: 'string' },
          running: { type: 'boolean' },
          status: { type: ['string', 'null'] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          error: { type: ['string', 'null'] },
        },
      }, 'The output.'),
      404: NOT_FOUND,
    },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/chat',
    tag: 'Jobs',
    summary: 'One turn of conversation with an agent job',
    description:
      'A thread of its own, separate from the editor’s: same working directory and memory, but ' +
      'not the same tools — nobody is in front of the screen, so the blocking questions are not ' +
      'offered. One turn at a time; a second message while the first runs is refused.',
    parameters: [jobIdParam],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        },
      },
    },
    responses: {
      200: json({ type: 'object', properties: { chatId: { type: 'string' }, reply: { type: ['string', 'null'] } } }, 'The agent’s answer.'),
      404: NOT_FOUND,
      409: json(ERROR_SCHEMA, 'A turn is already running.'),
      422: json(ERROR_SCHEMA, 'Empty message, or the job is not an agent.'),
      502: json(ERROR_SCHEMA, 'The turn failed — the model, a tool, a timeout.'),
      503: json(ERROR_SCHEMA, 'Chatting is unavailable.'),
    },
  },
  {
    method: 'post',
    path: '/webhook/{id}',
    tag: 'Webhook',
    surface: 'webhook',
    summary: 'Start a job that declares a webhook trigger',
    description:
      'Behind its own flag. Only a job declaring a webhook trigger can be started this way — an ' +
      'address given to a third party starts what you said it could start, and nothing else. A ' +
      'job without that trigger, a disabled one, and one that does not exist all answer 404. The ' +
      'trigger may carry a token of its own, which then replaces the server’s for that job.',
    parameters: [jobIdParam],
    responses: {
      202: json({ type: 'object', properties: { started: { type: 'string' } } }, 'Started.'),
      401: UNAUTHORIZED,
      404: NOT_FOUND,
      405: json(ERROR_SCHEMA, 'POST expected.'),
      409: json(ERROR_SCHEMA, 'The scheduler refused to start it.'),
      500: json(ERROR_SCHEMA, 'The expected token holds a ${VARIABLE} that cannot be resolved.'),
    },
  },
]

/**
 * The description, assembled for the current listening address.
 * @param {{listen: string, port: number}} http server settings
 */
function buildSpec(http = {}) {
  const paths = {}
  for (const op of OPERATIONS) {
    const { method, path, tag, summary, description, parameters, requestBody, responses } = op
    paths[path] = paths[path] ?? {}
    paths[path][method] = {
      tags: [tag],
      summary,
      ...(description ? { description } : {}),
      ...(parameters ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: { ...responses, 401: responses[401] ?? UNAUTHORIZED },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Rota',
      version: require('../../package.json').version,
      description:
        'Local control of a Rota instance. Starting a job means running shell or an agent on ' +
        'the machine: the token is the only thing between a caller and that. Everything here is ' +
        'behind it, and behind the flag of its surface — an API or a webhook that is off answers ' +
        '404, because it is not there.\n\n' +
        'Editing a job stays local, deliberately: a JSON definition pasted into a request reads ' +
        'badly and corrects even worse.',
    },
    servers: [{ url: `http://${http.listen ?? '127.0.0.1'}:${http.port ?? 47823}` }],
    tags: [
      { name: 'Jobs', description: 'List, run, stop, enable, read back.' },
      { name: 'Scheduler', description: 'The state of the engine itself.' },
      { name: 'Webhook', description: 'The one surface a third party is meant to reach.' },
    ],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'The token from Settings → HTTP.' },
        header: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Rota-Token',
          description:
            'The same token. Accepted because some webhook senders do not let you choose the ' +
            'authorization header, and refusing their only option would amount to refusing them.',
        },
      },
    },
    security: [{ bearer: [] }, { header: [] }],
    paths,
  }
}

module.exports = { buildSpec, OPERATIONS }
