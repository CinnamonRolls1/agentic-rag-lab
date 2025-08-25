async function ask(question) {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function renderMarkdown(md) {
  try {
    const html = (window.marked ? window.marked.parse(md) : md);
    if (window.DOMPurify) return window.DOMPurify.sanitize(html);
    return html;
  } catch (e) {
    return escapeHtml(String(md));
  }
}

function renderTrace(trace) {
  const out = document.getElementById('out');
  out.innerHTML = '';
  const answer = document.createElement('div');
  answer.className = 'block';
  answer.innerHTML = `<div><strong>Answer</strong></div><div class="markdown">${renderMarkdown(trace.answer || '')}</div>`;
  out.appendChild(answer);

  const metrics = document.createElement('div');
  metrics.className = 'block';
  const rows = [
    ['plan', trace.plan],
    ['ttft_ms', Math.round(trace.ttft_ms)],
    ['toks_per_s', Math.round(trace.toks_per_s * 10) / 10],
    ['retrieval_ms', Math.round(trace.retrieval.took_ms)],
    ['agent_overhead_ms', Math.round(trace.total_ms - trace.retrieval.took_ms)],
    ['claims', `${trace.verify.claims} (atomic factual statements in the answer)`],
    ['supported', `${trace.verify.supported} (claims judged supported by top-3 chunks)`],
    ['attrP', `${Number.isFinite(trace.verify.p) ? trace.verify.p.toFixed(2) : 'n/a'} (supported/claims)`],
  ];
  metrics.innerHTML = `<div><strong>Metrics</strong></div>` +
    `<div class="kvs">` + rows.map(([k,v]) => `<div class="kv">${k}</div><div class="mono">${v}</div>`).join('') + `</div>`;
  out.appendChild(metrics);

  const cites = document.createElement('div');
  cites.className = 'block citations';
  cites.textContent = 'Citations: ' + trace.retrieval.ids.join(', ');
  out.appendChild(cites);

  const ctx = document.createElement('div');
  ctx.className = 'block';
  ctx.innerHTML = '<div><strong>Context (top chunks)</strong></div>' +
    trace.retrieval.items.map(it => `
      <div class="mono" style="margin-top:8px">
        [${escapeHtml(it.id)}] <em>${escapeHtml(it.docId)}</em>
        <div>${escapeHtml(it.text)}</div>
      </div>
    `).join('');
  out.appendChild(ctx);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.getElementById('ask').addEventListener('click', async () => {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const out = document.getElementById('out');
  out.innerHTML = '<div class="block">Running...</div>';
  try {
    const { trace } = await ask(q);
    renderTrace(trace);
  } catch (e) {
    out.innerHTML = `<div class="block">Error: ${escapeHtml(e.message || String(e))}</div>`;
  }
});


