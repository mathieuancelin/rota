'use strict'

// A page to read the OpenAPI description in.
//
// Written by hand rather than taken from Swagger UI: that one weighs several
// megabytes which would have to be vendored — the CSP forbids any remote load,
// and this project has exactly one runtime dependency. Same reasoning as for the
// cron parser, the Discord gateway and the MCP client: the need is small and its
// shape is fixed.
//
// The page itself is not behind the token; the description it displays is. A
// browser cannot set a header by following a link, so the page asks for the
// token itself, holds it in memory for the visit — never in local storage, where
// it would outlive the tab — and fetches the description with it.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rota — API</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f4f6; --surface: #fff; --border: #dedee3;
    --text: #1a1a1f; --muted: #6b6b76; --accent: #3b6ef5;
    --get: #1f8f4e; --post: #b06f00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1c1e; --surface: #262629; --border: #3a3a40;
      --text: #f0f0f3; --muted: #9a9aa4; --accent: #6d92ff;
      --get: #4cc47c; --post: #e0a63a;
    }
  }
  * { box-sizing: border-box }
  body {
    margin: 0; background: var(--bg); color: var(--text); line-height: 1.55;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    font-size: 14px;
  }
  main { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px }
  h1 { font-size: 20px; margin: 0 0 4px }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 32px 0 10px
  }
  p { margin: 0 0 10px }
  .lede { color: var(--muted); white-space: pre-wrap }
  code, .mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 12.5px }
  .gate { display: flex; gap: 8px; margin: 18px 0 4px }
  .gate input { flex: 1; min-width: 0 }
  input, button {
    font: inherit; color: inherit; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
  }
  button { cursor: pointer }
  .op {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 8px;
  }
  .op-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap }
  .verb { font-weight: 700; font-size: 11px; letter-spacing: .08em }
  .verb.get { color: var(--get) }
  .verb.post { color: var(--post) }
  .path { font-family: ui-monospace, Menlo, monospace; font-size: 13px }
  .summary { color: var(--muted); margin-left: auto }
  .detail { margin-top: 8px; color: var(--muted) }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px }
  th, td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top }
  th { color: var(--muted); font-weight: 500; white-space: nowrap }
  td.code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; white-space: nowrap }
  .status { color: var(--muted) }
  .status b { color: var(--text); font-variant-numeric: tabular-nums }
  .error { color: #cc2f36 }
  footer { margin-top: 36px; color: var(--muted); font-size: 12.5px }
</style>
</head>
<body>
<main>
  <h1>Rota</h1>
  <p class="lede" id="lede">The description is behind the token, like everything else here.</p>

  <form class="gate" id="gate">
    <input id="token" type="password" placeholder="Token from Settings → HTTP" autocomplete="off">
    <button type="submit">Load</button>
  </form>
  <p id="note" class="lede"></p>

  <div id="spec"></div>

  <footer>
    Raw description: <code>GET /api/openapi.json</code>, with the same token.
  </footer>
</main>
<script>
  const $ = (id) => document.getElementById(id)
  const text = (tag, cls, value) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (value !== undefined) node.textContent = value
    return node
  }

  $('gate').addEventListener('submit', async (event) => {
    event.preventDefault()
    const token = $('token').value.trim()
    $('note').textContent = 'Loading…'
    $('note').className = 'lede'
    try {
      const response = await fetch('/api/openapi.json', {
        headers: { authorization: 'Bearer ' + token },
      })
      if (!response.ok) {
        $('note').textContent =
          response.status === 401
            ? 'Refused: wrong token.'
            : 'Refused: ' + response.status + '. Is the API turned on under Settings → HTTP?'
        $('note').className = 'error'
        return
      }
      $('note').textContent = ''
      render(await response.json())
    } catch (err) {
      $('note').textContent = 'Unreachable: ' + err.message
      $('note').className = 'error'
    }
  })

  function render(spec) {
    $('lede').textContent = spec.info.description
    const root = $('spec')
    root.replaceChildren()

    for (const tag of spec.tags) {
      const operations = []
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          if (op.tags.includes(tag.name)) operations.push({ path, method, op })
        }
      }
      if (operations.length === 0) continue

      root.append(text('h2', null, tag.name + ' — ' + tag.description))
      for (const { path, method, op } of operations) root.append(operation(path, method, op))
    }
  }

  function operation(path, method, op) {
    const box = text('div', 'op')
    const head = text('div', 'op-head')
    head.append(text('span', 'verb ' + method, method.toUpperCase()))
    head.append(text('span', 'path', path))
    head.append(text('span', 'summary', op.summary))
    box.append(head)

    if (op.description) box.append(text('p', 'detail', op.description))

    if (op.parameters?.length) {
      const table = document.createElement('table')
      for (const p of op.parameters) {
        const tr = document.createElement('tr')
        tr.append(text('th', null, p.in))
        const name = text('td', 'code', p.name + (p.required ? '' : '?'))
        tr.append(name)
        tr.append(text('td', null, p.description ?? ''))
        table.append(tr)
      }
      box.append(table)
    }

    if (op.requestBody) {
      const schema = op.requestBody.content['application/json'].schema
      box.append(text('p', 'detail', 'Body: ' + Object.keys(schema.properties ?? {}).join(', ')))
    }

    const statuses = text('p', 'status')
    for (const [code, response] of Object.entries(op.responses)) {
      const bit = text('span')
      bit.append(text('b', null, code))
      bit.append(document.createTextNode(' ' + (response.description ?? '') + '  '))
      statuses.append(bit)
    }
    box.append(statuses)
    return box
  }
</script>
</body>
</html>
`

module.exports = { PAGE }
