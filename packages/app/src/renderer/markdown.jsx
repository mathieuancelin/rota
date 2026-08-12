import DOMPurify from 'dompurify'
import { marked } from 'marked'

import './markdown.css'

// Rendering the markdown an agent produced.
//
// The content comes from a language model, hence from nowhere in particular: it
// is sanitised before reaching the document, whatever the CSP says. The CSP
// already forbids inline scripts, but an `onclick` or a `javascript:` `href` is
// not its business.

marked.setOptions({ gfm: true, breaks: false })

// Links go out to the browser: the window itself refuses to navigate.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

const CLEAN = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote',
    'ul', 'ol', 'li',
    'strong', 'em', 'del', 'code', 'pre',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'input', // checkboxes of GitHub task lists
  ],
  ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'align', 'type', 'checked', 'disabled'],
  // Neither javascript: nor data: — except for an image, which an agent may produce.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/|data:image\/)/i,
}

export function renderMarkdown(source) {
  return DOMPurify.sanitize(marked.parse(source ?? ''), CLEAN)
}

export function Markdown({ source }) {
  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
  )
}
