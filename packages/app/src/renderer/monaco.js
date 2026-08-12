// Monaco configuration.
//
// Two constraints specific to this application:
//
// 1. Everything must be local. The CSP forbids the slightest external load, so
//    no CDN loader: Monaco and its workers are bundled by Vite.
// 2. We embed the JSON language only. Importing `monaco-editor` whole would
//    pull in the fifty-odd grammars shipped with it, for an editor that will
//    never see anything but job files.
//
// Monaco's JSON service validates live against schemas/job.schema.json and
// provides completion and tooltips. That is only an input convenience: the
// authoritative validation stays the main process's, replayed on save.

// Paths from monaco-editor 0.56's `exports` map: "monaco-editor/x" resolves to
// esm/vs/x.js. The old "monaco-editor/esm/vs/…" paths, still the majority in
// online documentation, no longer resolve.
// Must precede the Monaco import: this module installs _VSCODE_NLS_MESSAGES,
// which the editor's modules read at their initialisation. Localises the
// context menu, the search and the accessibility labels.
//
// The JSON schema diagnostics, however, stay in English: they come from
// vscode-json-languageservice, of which Monaco embeds a version of @vscode/l10n
// reduced to the identity — its t() function returns the English template and
// exposes no configuration point.
import 'monaco-editor/nls/lang/fr'

import * as monaco from 'monaco-editor/editor/editor.api'
// In 0.56, the JSON contribution exports `jsonDefaults` directly and registers
// the language on import; it no longer hangs off `monaco.languages.json`,
// contrary to what most online documentation still shows.
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution'

// JavaScript colouring, for the code of bun-inline jobs. We register the one
// useful language: `basic-languages/monaco.contribution` would import the fifty
// or so shipped with Monaco. The grammar itself is loaded on demand by that
// module, on the first opening of a JS model.
//
// Deliberately without the TypeScript service: it would bring a worker several
// megabytes in size to underline in red `Bun`, `process` and every runtime
// global the renderer does not know.
import 'monaco-editor/languages/definitions/javascript/register.js'

// Markdown, for the prompts of agent jobs. A page-long prompt escaped onto a
// single line of JSON neither writes nor reads back; it is worth its own tab,
// and markdown at least gives it headings and lists.
import 'monaco-editor/languages/definitions/markdown/register.js'

import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'

import jobSchema from '@rota/core/schemas/job.schema.json'

// Arbitrary but stable identifier: it is what links a model to the schema.
const SCHEMA_URI = 'https://rota.local/schemas/job.schema.json'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return label === 'json' ? new jsonWorker() : new editorWorker()
  },
}

jsonDefaults.setDiagnosticsOptions({
  validate: true,
  // A job file is read back by JSON.parse: comments and trailing commas would be
  // accepted here then refused on save.
  allowComments: false,
  comments: 'error',
  trailingCommas: 'error',
  // Monaco's default is "warning": a schema violation would pass for a mere
  // warning when the main process will refuse it.
  schemaValidation: 'error',
  // No network access: the schema is supplied here, the CSP would block the rest.
  enableSchemaRequest: false,
  schemas: [{ uri: SCHEMA_URI, fileMatch: ['*'], schema: jobSchema }],
})

monaco.editor.defineTheme('rota-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#00000000',
    'editorGutter.background': '#00000000',
    'editor.lineHighlightBackground': '#ffffff0d',
  },
})

monaco.editor.defineTheme('rota-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#00000000',
    'editorGutter.background': '#00000000',
    'editor.lineHighlightBackground': '#0000000a',
  },
})

/** Model URI specific to a job, so that fileMatch applies. */
export function modelUri(jobId) {
  return monaco.Uri.parse(`inmemory://rota/${jobId}.json`)
}

/**
 * URI of a source model — inline code, agent prompt. Distinct from the JSON
 * one: these are other languages, and `fileMatch` must not apply the job schema
 * to them.
 */
export function sourceModelUri(jobId, tabId, extension) {
  return monaco.Uri.parse(`inmemory://rota/${jobId}.${tabId}.${extension}`)
}

export function themeName(dark) {
  return dark ? 'rota-dark' : 'rota-light'
}

export default monaco
