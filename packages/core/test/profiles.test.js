'use strict'

// Reusable agents.
//
// The whole feature rests on one property: a job that names a profile and a job
// that writes its agent out in full must be indistinguishable by the time
// anything downstream reads them. Eleven files read `runner.agent`, and none of
// them was taught that there are now two spellings — these tests are what says
// that trust is warranted.
//
// The second thing worth guarding is the defaults. Accepting a string as well as
// an object means a `oneOf`, and ajv silently drops `default` inside one; an
// inline agent losing its tool list would be a wide, quiet regression, so it is
// checked here on both forms.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { ConfigStore } = require('../src/config/store')
const { resolvePaths, ensureStructure } = require('../src/config/paths')
const { validateJob, validateProfile } = require('../src/config/validate')
const { merge } = require('../src/config/resolve-agent')

const profile = (overrides = {}) => ({
  id: 'developer',
  name: 'Developer',
  model: 'gemma4:latest',
  ...overrides,
})

const inlineJob = (agent = {}) => ({
  id: 'essai',
  name: 'Essai',
  runner: { type: 'agent', agent: { prompt: 'fais le travail', model: 'gemma4:latest', ...agent } },
})

const referencingJob = (runner = {}) => ({
  id: 'essai',
  name: 'Essai',
  runner: { type: 'agent', agent: 'developer', prompt: 'fais le travail', ...runner },
})

const profiles = (...list) => new Map(list.map((p) => [p.id, validateProfile(p).profile]))

async function freshStore(t, { jobs = {}, profileFiles = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-profiles-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = resolvePaths(dir)
  await ensureStructure(paths)

  for (const [id, content] of Object.entries(jobs)) {
    await fs.writeFile(path.join(paths.jobsDir, `${id}.json`), JSON.stringify(content), 'utf8')
  }
  for (const [id, content] of Object.entries(profileFiles)) {
    await fs.writeFile(path.join(paths.profilesDir, `${id}.json`), JSON.stringify(content), 'utf8')
  }

  const store = new ConfigStore(paths)
  await store.reload()
  return { store, paths, dir }
}

// --- the profile on its own -------------------------------------------------------

test('a profile fills in what it did not say', async () => {
  const result = validateProfile(profile())

  assert.equal(result.ok, true)
  assert.equal(result.profile.maxIterations, 25)
  assert.equal(result.profile.api.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.ok(result.profile.tools.enabled.includes('file_read'))
})

test('a profile carries no prompt: that is the job’s to say', () => {
  const result = validateProfile({ ...profile(), prompt: 'fais quelque chose' })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /unknown field "prompt"/)
})

test('a profile gets the same checks an inline agent gets', () => {
  const result = validateProfile(profile({ api: { baseUrl: 'pas-une-url' } }))

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /baseUrl/)
})

// --- resolution ---------------------------------------------------------------------

// The property the other ten files depend on.
test('a referenced agent and an inline one come out identical', () => {
  const identity = {
    model: 'gemma4:latest',
    systemPrompt: 'tu es un développeur',
    maxIterations: 40,
    tools: { enabled: ['file_read', 'exec'] },
  }

  const referenced = validateJob(referencingJob(), {
    profiles: profiles(profile(identity)),
  })
  const inline = validateJob(inlineJob(identity))

  assert.equal(referenced.ok, true)
  assert.equal(inline.ok, true)
  // Bar the marker of where the values came from, which is the point of it.
  const { agentProfile, ...referencedRunner } = referenced.job.runner
  assert.equal(agentProfile, 'developer')
  assert.deepEqual(referencedRunner.agent, inline.job.runner.agent)
})

test('the defaults survive the reference, and the inline form too', () => {
  const referenced = validateJob(referencingJob(), { profiles: profiles(profile()) })
  const inline = validateJob(inlineJob())

  for (const [label, result] of [['référencé', referenced], ['inline', inline]]) {
    assert.equal(result.job.runner.agent.maxIterations, 25, label)
    assert.equal(result.job.runner.agent.api.timeoutSeconds, 120, label)
    assert.ok(result.job.runner.agent.tools.enabled.length > 0, label)
  }
})

test('the job’s prompt is what the agent is asked, never the profile’s business', () => {
  const result = validateJob(referencingJob({ prompt: 'corrige l’issue 412' }), {
    profiles: profiles(profile()),
  })

  assert.equal(result.job.runner.agent.prompt, 'corrige l’issue 412')
  // And it does not stay at the runner level, where nothing reads it.
  assert.equal(result.job.runner.prompt, undefined)
})

test('an override redeclares a field for this job alone', () => {
  const known = profiles(profile({ maxIterations: 25 }))
  const result = validateJob(
    referencingJob({ agentOverrides: { maxIterations: 60 } }),
    { profiles: known },
  )

  assert.equal(result.job.runner.agent.maxIterations, 60)
  // The profile itself is untouched: another job still gets 25.
  assert.equal(known.get('developer').maxIterations, 25)
})

test('an override reaches into an object without emptying it', () => {
  const result = validateJob(
    referencingJob({ agentOverrides: { api: { timeoutSeconds: 300 } } }),
    { profiles: profiles(profile({ api: { baseUrl: 'https://api.exemple.fr/v1' } })) },
  )

  assert.equal(result.job.runner.agent.api.timeoutSeconds, 300)
  assert.equal(result.job.runner.agent.api.baseUrl, 'https://api.exemple.fr/v1')
})

test('an override replaces a list outright', () => {
  const result = validateJob(
    referencingJob({ agentOverrides: { tools: { enabled: ['exec'] } } }),
    { profiles: profiles(profile({ tools: { enabled: ['file_read', 'file_write'] } })) },
  )

  assert.deepEqual(result.job.runner.agent.tools.enabled, ['exec'])
})

test('merge blends objects and replaces the rest', () => {
  assert.deepEqual(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } })
  assert.deepEqual(merge({ a: [1, 2] }, { a: [3] }), { a: [3] })
  assert.deepEqual(merge({ a: 1 }, { a: 2 }), { a: 2 })
})

// --- what gets refused ----------------------------------------------------------------

test('a profile that does not exist is named in the error', () => {
  const result = validateJob(referencingJob(), { profiles: profiles(profile({ id: 'autre' })) })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /no profile named "developer"/)
  assert.match(result.errors.join(' '), /autre/)
})

test('a referenced agent with no prompt is refused', () => {
  const raw = referencingJob()
  delete raw.runner.prompt

  const result = validateJob(raw, { profiles: profiles(profile()) })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /"prompt" field is required/)
})

// Left behind after switching a job back to an inline agent, they would have no
// effect whatever — which is exactly the kind of thing that takes half an hour.
test('the keys that only mean something beside a profile are refused without one', () => {
  const withPrompt = inlineJob()
  withPrompt.runner.prompt = 'ailleurs'
  const withOverrides = inlineJob()
  withOverrides.runner.agentOverrides = { maxIterations: 60 }

  assert.match(validateJob(withPrompt).errors.join(' '), /runner\.prompt/)
  assert.match(validateJob(withOverrides).errors.join(' '), /runner\.agentOverrides/)
})

// --- through the store ------------------------------------------------------------------

test('the store resolves a job against the profiles on disk', async (t) => {
  const { store } = await freshStore(t, {
    profileFiles: { developer: profile({ maxIterations: 40 }) },
    jobs: { essai: referencingJob() },
  })

  const job = store.getJob('essai')
  assert.equal(job.runner.agent.maxIterations, 40)
  assert.equal(job.runner.agent.prompt, 'fais le travail')
  assert.equal(job.runner.agentProfile, 'developer')
  assert.equal(store.getIssues().length, 0)
})

test('the store says which jobs lean on a profile', async (t) => {
  const { store } = await freshStore(t, {
    profileFiles: { developer: profile() },
    jobs: {
      essai: referencingJob(),
      autre: { ...referencingJob(), id: 'autre' },
      seul: inlineJob(),
    },
  })

  assert.deepEqual(store.jobsUsingProfile('developer').sort(), ['autre', 'essai'])
})

test('a job naming a profile that is not there is an issue, not a crash', async (t) => {
  const { store } = await freshStore(t, { jobs: { essai: referencingJob() } })

  assert.equal(store.getJob('essai'), null)
  assert.match(store.getIssues().map((i) => i.errors.join(' ')).join(' '), /no profile named/)
})

test('a broken profile is dropped, and the jobs using it say so', async (t) => {
  const { store } = await freshStore(t, {
    profileFiles: { developer: { id: 'developer', name: 'Developer' } }, // pas de model
    jobs: { essai: referencingJob() },
  })

  assert.equal(store.getProfile('developer'), null)
  const errors = store.getIssues().map((i) => i.errors.join(' ')).join(' ')
  assert.match(errors, /"model" field is required/)
  assert.match(errors, /no profile named "developer"/)
})

test('an installation with no profiles directory is not a problem to report', async (t) => {
  const { store, paths } = await freshStore(t, { jobs: { essai: inlineJob() } })
  await fs.rm(paths.profilesDir, { recursive: true, force: true })

  await store.reload()

  assert.equal(store.getIssues().length, 0)
  assert.equal(store.getJob('essai').runner.agent.prompt, 'fais le travail')
})

test('a profile edited re-resolves the jobs pointing at it', async (t) => {
  const { store, paths } = await freshStore(t, {
    profileFiles: { developer: profile({ maxIterations: 10 }) },
    jobs: { essai: referencingJob() },
  })
  assert.equal(store.getJob('essai').runner.agent.maxIterations, 10)

  await fs.writeFile(
    path.join(paths.profilesDir, 'developer.json'),
    JSON.stringify(profile({ maxIterations: 99 })),
    'utf8',
  )
  await store.reload()

  assert.equal(store.getJob('essai').runner.agent.maxIterations, 99)
})

// --- workflow steps ------------------------------------------------------------------------

test('a workflow step can name a profile too', () => {
  const job = {
    id: 'chaine',
    name: 'Chaîne',
    runner: {
      type: 'workflow',
      workflow: {
        steps: [
          { name: 'relecture', runner: { type: 'agent', agent: 'developer', prompt: 'relis' } },
        ],
      },
    },
  }

  const result = validateJob(job, { profiles: profiles(profile({ maxIterations: 7 })) })

  assert.equal(result.ok, true)
  const step = result.job.runner.workflow.steps[0].runner
  assert.equal(step.agent.maxIterations, 7)
  assert.equal(step.agent.prompt, 'relis')
  assert.equal(step.agentProfile, 'developer')
})

// --- the memory --------------------------------------------------------------------------

const memory = require('../src/agent/memory')

async function freshMemoryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-mem-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

/** What a session does: load, write through the tool's path, save. */
async function session(dir, id, writes) {
  const state = await memory.load(dir, id)
  for (const [key, value] of Object.entries(writes)) {
    memory.write(state, key, value, { maxEntries: 100 })
  }
  await memory.save(dir, id, state, { maxEntries: 100 })
  return state
}

test('the memory key is the profile’s when the job names one', () => {
  const referenced = validateJob(referencingJob(), { profiles: profiles(profile()) })
  const inline = validateJob(inlineJob())

  assert.equal(memory.keyFor(referenced.job), 'developer')
  assert.equal(memory.keyFor(inline.job), 'essai')
})

test('two jobs of one profile read the same memory', async (t) => {
  const dir = await freshMemoryDir(t)
  await session(dir, 'developer', { convention: 'tabs' })

  const other = await memory.load(dir, 'developer')

  assert.equal(other.entries.convention.value, 'tabs')
})

// The reason `save` folds instead of replacing. Both sessions load the same
// file, both learn something, and the one finishing second used to erase the
// first.
test('two sessions writing at once keep both their keys', async (t) => {
  const dir = await freshMemoryDir(t)

  const first = await memory.load(dir, 'developer')
  const second = await memory.load(dir, 'developer')

  memory.write(first, 'du-premier', 'a', { maxEntries: 100 })
  memory.write(second, 'du-second', 'b', { maxEntries: 100 })

  await memory.save(dir, 'developer', first, { maxEntries: 100 })
  await memory.save(dir, 'developer', second, { maxEntries: 100 })

  const onDisk = await memory.load(dir, 'developer')
  assert.equal(onDisk.entries['du-premier'].value, 'a')
  assert.equal(onDisk.entries['du-second'].value, 'b')
})

test('the same key written by both goes to the one that finished last', async (t) => {
  const dir = await freshMemoryDir(t)
  const first = await memory.load(dir, 'developer')
  const second = await memory.load(dir, 'developer')

  memory.write(first, 'etat', 'ancien', { maxEntries: 100 })
  memory.write(second, 'etat', 'récent', { maxEntries: 100 })
  await memory.save(dir, 'developer', first, { maxEntries: 100 })
  await memory.save(dir, 'developer', second, { maxEntries: 100 })

  assert.equal((await memory.load(dir, 'developer')).entries.etat.value, 'récent')
})

test('a session that touched nothing writes nothing', async (t) => {
  const dir = await freshMemoryDir(t)
  await session(dir, 'developer', { garde: 'moi' })

  // Loaded before the other one writes, saved after: the stale copy must not
  // travel back to disk.
  const idle = await memory.load(dir, 'developer')
  await session(dir, 'developer', { ajout: 'nouveau' })
  await memory.save(dir, 'developer', idle, { maxEntries: 100 })

  const onDisk = await memory.load(dir, 'developer')
  assert.equal(onDisk.entries.garde.value, 'moi')
  assert.equal(onDisk.entries.ajout.value, 'nouveau')
})

test('forgetting a key removes it from the file, not just from the session', async (t) => {
  const dir = await freshMemoryDir(t)
  await session(dir, 'developer', { a: '1', b: '2' })

  const state = await memory.load(dir, 'developer')
  memory.remove(state, 'a')
  await memory.save(dir, 'developer', state, { maxEntries: 100 })

  const onDisk = await memory.load(dir, 'developer')
  assert.equal(onDisk.entries.a, undefined)
  assert.equal(onDisk.entries.b.value, '2')
})

// Sweeping on job identifiers alone would delete every profile's memory on the
// next start — which is months of observations, quietly.
test('the sweep keeps the memory of a profile that still exists', async (t) => {
  const dir = await freshMemoryDir(t)
  await session(dir, 'developer', { su: 'des choses' })
  await session(dir, 'un-job', { aussi: 'des choses' })
  await session(dir, 'disparu', { plus: 'personne' })

  await memory.prune(dir, ['un-job'], ['developer'])

  assert.ok((await memory.load(dir, 'developer')).entries.su)
  assert.ok((await memory.load(dir, 'un-job')).entries.aussi)
  assert.equal((await memory.load(dir, 'disparu')).entries.plus, undefined)
})

// --- extraction ---------------------------------------------------------------------------

const { extractProfile } = require('../src/config/extract-profile')

test('an inline agent becomes a profile the job points at', async (t) => {
  const { store, paths } = await freshStore(t, {
    jobs: { essai: { ...inlineJob({ maxIterations: 40 }), name: 'Essai' } },
  })

  const result = await extractProfile({ paths, jobId: 'essai', profileId: 'developer' })
  assert.equal(result.ok, true)

  const written = JSON.parse(await fs.readFile(path.join(paths.jobsDir, 'essai.json'), 'utf8'))
  assert.equal(written.runner.agent, 'developer')
  assert.equal(written.runner.prompt, 'fais le travail')

  const profile = JSON.parse(await fs.readFile(path.join(paths.profilesDir, 'developer.json'), 'utf8'))
  assert.equal(profile.id, 'developer')
  assert.equal(profile.maxIterations, 40)
  assert.equal(profile.prompt, undefined, 'the task stays with the job')

  // And the whole thing still resolves to what it was.
  await store.reload()
  assert.equal(store.getJob('essai').runner.agent.maxIterations, 40)
  assert.equal(store.getJob('essai').runner.agent.prompt, 'fais le travail')
})

// The part that takes care: an extraction that quietly cost an agent months of
// observations would be worse than one that refused.
test('the memory follows the agent, with a copy left behind', async (t) => {
  const { paths } = await freshStore(t, { jobs: { essai: inlineJob() } })
  await session(paths.memoryDir, 'essai', { convention: 'tabs' })

  const result = await extractProfile({ paths, jobId: 'essai', profileId: 'developer' })

  assert.equal(result.memoryMoved, true)
  assert.equal((await memory.load(paths.memoryDir, 'developer')).entries.convention.value, 'tabs')
  assert.equal((await memory.load(paths.memoryDir, 'essai')).entries.convention, undefined)
  await fs.access(path.join(paths.memoryDir, 'essai.mem.json.bak'))
})

test('the job file is backed up before being rewritten', async (t) => {
  const { paths } = await freshStore(t, { jobs: { essai: inlineJob() } })

  await extractProfile({ paths, jobId: 'essai', profileId: 'developer' })

  const backup = JSON.parse(await fs.readFile(path.join(paths.jobsDir, 'essai.json.bak'), 'utf8'))
  assert.equal(typeof backup.runner.agent, 'object', 'the backup still holds the inline agent')
})

test('extracting onto a name already taken is refused, and writes nothing', async (t) => {
  const { paths } = await freshStore(t, {
    jobs: { essai: inlineJob() },
    profileFiles: { developer: profile() },
  })

  const result = await extractProfile({ paths, jobId: 'essai', profileId: 'developer' })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /already exists/)
  const untouched = JSON.parse(await fs.readFile(path.join(paths.jobsDir, 'essai.json'), 'utf8'))
  assert.equal(typeof untouched.runner.agent, 'object')
})

test('a job already pointing at a profile has nothing to extract', async (t) => {
  const { paths } = await freshStore(t, {
    jobs: { essai: referencingJob() },
    profileFiles: { developer: profile() },
  })

  const result = await extractProfile({ paths, jobId: 'essai', profileId: 'autre' })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /already points at/)
})

test('a job that is not an agent is refused', async (t) => {
  const { paths } = await freshStore(t, {
    jobs: { script: { id: 'script', name: 'Script', runner: { type: 'shell', script: '/tmp/x.sh' } } },
  })

  const result = await extractProfile({ paths, jobId: 'script', profileId: 'developer' })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /not an agent job/)
})
