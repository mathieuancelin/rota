'use strict'

// File access, bounded to the job's working directory.
//
// The paths returned to the model are always relative: showing it absolute ones
// invites it to make them up, and each will be refused by the resolution.

const fs = require('node:fs/promises')
const path = require('node:path')

const { resolveInWorkspace, displayPath } = require('../workspace')

const MAX_ENTRIES = 500

/** Resolves a path argument, or returns the error as the model will read it. */
function target(ctx, value) {
  return resolveInWorkspace(ctx.workspace, value)
}

const fileRead = {
  name: 'file_read',
  description:
    "Reads a text file from the working directory. The path is relative to that directory.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Chemin relatif du fichier.' },
    },
    required: ['path'],
  },
  async run({ path: requested }, ctx) {
    const resolved = target(ctx, requested)
    if (!resolved.ok) return resolved

    let content
    try {
      const stat = await fs.stat(resolved.path)
      if (stat.isDirectory()) {
        return { ok: false, error: `"${requested}" is a directory — use file_list.` }
      }
      content = await fs.readFile(resolved.path, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, error: `file not found: ${requested}` }
      return { ok: false, error: `read failed: ${err.message}` }
    }

    const limit = ctx.config.files.maxReadBytes
    if (Buffer.byteLength(content) > limit) {
      const kept = Buffer.from(content).subarray(0, limit).toString('utf8')
      return {
        ok: true,
        summary: `${requested} (truncated at ${limit} bytes)`,
        content: `${kept}\n\n[… file truncated at ${limit} bytes]`,
      }
    }
    return { ok: true, summary: requested, content }
  },
}

const fileList = {
  name: 'file_list',
  description:
    "Lists the contents of a directory inside the working directory. With no argument, lists the root.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path of the directory. Default: the root.' },
      recursive: { type: 'boolean', description: 'Descend into subdirectories.' },
    },
  },
  async run({ path: requested = '.', recursive = false }, ctx) {
    const resolved = target(ctx, requested)
    if (!resolved.ok) return resolved

    let entries
    try {
      entries = await fs.readdir(resolved.path, { withFileTypes: true, recursive })
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, error: `directory not found: ${requested}` }
      if (err.code === 'ENOTDIR') return { ok: false, error: `"${requested}" is not a directory` }
      return { ok: false, error: `read failed: ${err.message}` }
    }

    const lines = []
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      const absolute = path.join(entry.parentPath ?? entry.path ?? resolved.path, entry.name)
      const relative = displayPath(ctx.workspace, absolute)
      if (entry.isDirectory()) {
        lines.push(`${relative}/`)
      } else {
        const size = await fs.stat(absolute).then((s) => s.size, () => null)
        lines.push(size === null ? relative : `${relative} (${size} o)`)
      }
    }
    if (entries.length > MAX_ENTRIES) {
      lines.push(`[… ${entries.length - MAX_ENTRIES} further entries not listed]`)
    }

    return {
      ok: true,
      summary: `${requested} — ${entries.length} entry(ies)`,
      content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
    }
  },
}

const fileWrite = {
  name: 'file_write',
  description:
    "Writes a text file into the working directory. Missing directories are created.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Chemin relatif du fichier.' },
      content: { type: 'string', description: 'Content to write.' },
      append: { type: 'boolean', description: 'Append instead of replacing.' },
    },
    required: ['path', 'content'],
  },
  async run({ path: requested, content, append = false }, ctx) {
    const resolved = target(ctx, requested)
    if (!resolved.ok) return resolved
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }

    try {
      await fs.mkdir(path.dirname(resolved.path), { recursive: true })
      if (append) await fs.appendFile(resolved.path, content, 'utf8')
      else await fs.writeFile(resolved.path, content, 'utf8')
    } catch (err) {
      return { ok: false, error: `write failed: ${err.message}` }
    }

    const bytes = Buffer.byteLength(content)
    return {
      ok: true,
      summary: `${requested} (${bytes} B${append ? ', appended' : ''})`,
      content: `${bytes} bytes ${append ? 'appended to' : 'written to'} ${requested}`,
    }
  },
}

const fileDel = {
  name: 'file_del',
  description: "Deletes a file or a directory from the working directory.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to delete.' },
      recursive: { type: 'boolean', description: 'Required for a non-empty directory.' },
    },
    required: ['path'],
  },
  async run({ path: requested, recursive = false }, ctx) {
    const resolved = target(ctx, requested)
    if (!resolved.ok) return resolved

    // The model may ask to delete "." without measuring what it erases: the
    // working directory itself is never a candidate.
    if (resolved.path === ctx.workspace) {
      return { ok: false, error: 'the working directory itself cannot be deleted' }
    }

    try {
      await fs.rm(resolved.path, { recursive, force: false })
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, error: `not found: ${requested}` }
      if (err.code === 'ERR_FS_EISDIR' || err.code === 'EISDIR') {
        return { ok: false, error: `"${requested}" is a directory — pass recursive: true` }
      }
      return { ok: false, error: `delete failed: ${err.message}` }
    }

    return { ok: true, summary: requested, content: `${requested} deleted` }
  },
}

module.exports = { fileRead, fileList, fileWrite, fileDel }
