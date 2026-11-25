const form = document.getElementById('lookup')
const idInput = document.getElementById('run-id')
const notice = document.getElementById('notice')
const runPanel = document.getElementById('run')
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const states = { queued: 'Queued', running: 'Running', finalized: 'Finalized', unresolved: 'Unresolved', failed: 'Failed' }
let controller
let timer
let lastRendered

function el(tag, value, className) {
  const element = document.createElement(tag)
  if (value !== undefined) element.textContent = String(value)
  if (className) element.className = className
  return element
}

function list(parent, title, values) {
  if (!Array.isArray(values) || !values.length) return
  parent.append(el('h3', title))
  const items = el('ul')
  for (const value of values) items.append(el('li', value))
  parent.append(items)
}

function showEvidence(parent, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return
  parent.append(el('h3', 'Evidence'))
  for (const item of evidence) {
    const block = el('div', undefined, 'evidence')
    const lines = item.startLine === item.endLine ? item.startLine : item.startLine + '–' + item.endLine
    block.append(el('div', item.path + ':' + lines, 'file'), el('div', item.commit, 'revision'), el('pre', item.excerpt))
    parent.append(block)
  }
}

function metadata(label, value) {
  const item = el('div')
  item.append(el('dt', label), el('dd', value))
  return item
}

function render(record, artifacts) {
  const { input } = record
  const badge = document.getElementById('badge')
  badge.textContent = states[record.status] ?? record.status
  badge.dataset.status = record.status
  document.getElementById('stage').textContent = 'Stage · ' + record.stage
  document.getElementById('issue').textContent = input.issue
  const info = document.getElementById('metadata')
  info.replaceChildren(metadata('Repository', input.repo), metadata('Head', input.headRef + ' · ' + input.headSha.slice(0, 12)))
  if (input.baseSha) info.append(metadata('Base', input.baseRef + ' · ' + input.baseSha.slice(0, 12)))
  const result = artifacts['result.json']
  const outcome = document.getElementById('outcome')
  outcome.replaceChildren()
  const card = el('section', undefined, 'card')
  if (record.status === 'finalized' && result?.proposal) {
    const proposal = result.proposal
    card.append(el('h2', 'Agreed root cause'), el('p', proposal.cause, 'cause'), el('p', proposal.explanation))
    showEvidence(card, proposal.evidence)
    list(card, 'Evidence gaps', proposal.gaps)
    card.append(el('p', 'Approved proposal · ' + result.version + ' · ' + result.digest, 'revision'))
  } else if (record.status === 'unresolved' && result) {
    card.append(el('h2', 'Unresolved findings'))
    for (const role of ['A', 'B']) {
      const report = artifacts['reports/' + role + '.json']
      const vote = result.positions?.[role]
      card.append(el('h3', 'Agent ' + role + (vote?.decision ? ' · ' + vote.decision : '')))
      if (report?.hypothesis) card.append(el('p', report.hypothesis))
      if (vote?.reason) card.append(el('p', vote.reason))
      list(card, 'Objections', vote?.objections)
    }
    list(card, 'Remaining objections', result.objections)
  } else if (record.status === 'failed') {
    const error = record.error ?? result?.error
    card.append(el('h2', 'Run failed'), el('p', (error?.role ? 'Agent ' + error.role + ' · ' : '') + (error?.message ?? record.stage)))
  }
  if (card.childElementCount) outcome.append(card)
  const entries = Object.entries(artifacts)
  const artifactList = document.getElementById('artifacts')
  const expanded = new Set(Array.from(artifactList.querySelectorAll('details[open]'), item => item.dataset.artifact))
  artifactList.replaceChildren()
  for (const [name, value] of entries) {
    const detail = el('details')
    detail.dataset.artifact = name
    detail.open = expanded.has(name)
    const summary = el('summary', name, 'artifact-name')
    detail.append(summary, el('pre', JSON.stringify(value, null, 2)))
    artifactList.append(detail)
  }
  document.getElementById('artifact-panel').hidden = entries.length === 0
  runPanel.hidden = false
}

async function read(path, signal) {
  const response = await fetch(path, { signal })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Could not load this run.')
  return value
}

async function refresh(id, signal) {
  try {
    const path = '/runs/' + encodeURIComponent(id)
    const record = await read(path, signal)
    const fingerprint = JSON.stringify([record.status, record.stage, record.artifacts, record.error])
    if (fingerprint !== lastRendered) {
      const artifacts = await read(path + '/artifacts', signal)
      if (signal.aborted) return
      render(record, artifacts)
      lastRendered = fingerprint
      notice.textContent = ''
    }
    if (!signal.aborted && (record.status === 'queued' || record.status === 'running')) {
      timer = setTimeout(() => refresh(id, signal), 1500)
    }
  } catch (error) {
    if (!signal.aborted) notice.textContent = error.message + ' Open the run again to retry.'
  }
}

function load() {
  clearTimeout(timer)
  controller?.abort()
  controller = new AbortController()
  lastRendered = undefined
  runPanel.hidden = true
  notice.textContent = ''
  const id = location.hash.slice(1)
  idInput.value = id
  if (!id) return
  if (!validId.test(id)) {
    notice.textContent = 'Enter a valid run ID.'
    return
  }
  notice.textContent = 'Loading run…'
  refresh(id, controller.signal)
}

form.addEventListener('submit', event => {
  event.preventDefault()
  const id = idInput.value.trim()
  if (!validId.test(id)) {
    idInput.setCustomValidity('Enter a valid run ID.')
    idInput.reportValidity()
    return
  }
  if (location.hash === '#' + id) load()
  else location.hash = id
})
idInput.addEventListener('input', () => idInput.setCustomValidity(''))
window.addEventListener('hashchange', load)
load()
