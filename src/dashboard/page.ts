// ONE page for both the local dashboard and the public demo. Plain HTML + a small script: no framework, no external requests (no CDN, fonts, analytics), works offline.
// dashboard: rows come from /api/* on 127.0.0.1 and the buttons mark applied / skip. demo: everything is inlined (invented sample data) and there are no buttons.
export interface PageOpts { mode: 'dashboard' | 'demo'; title: string; banner?: string; data?: unknown; token?: string }

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--ink:#1b2430;--mut:#6a7686;--line:#e4e7ec;--acc:#2456c9;--ok:#16794a;--okbg:#e1f4ea;--warn:#92580a;--warnbg:#fdf0d5;--gray:#eceef2}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.banner{background:#fff4d6;border-bottom:1px solid #e8cf86;color:#5c4400;padding:8px 24px;font-weight:600}
header{max-width:1280px;margin:0 auto;padding:22px 24px 6px}h1{margin:0;font-size:20px;font-weight:650}header p{margin:2px 0 0;color:var(--mut);font-size:13px}
main{max-width:1280px;margin:0 auto;padding:10px 24px 40px}
.top{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:26px;line-height:1.1;font-weight:650}.card span{color:var(--mut);font-size:12px}
.card.hl b{color:var(--warn)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}.chart h2{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--mut)}
.bar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:end;margin-bottom:10px}
.bar label{display:flex;flex-direction:column;font-size:11px;color:var(--mut);gap:2px}
.bar input,.bar select{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}
.bar input[type=number]{width:64px}.bar input[type=search]{width:210px}.bar .chk{flex-direction:row;align-items:center;gap:6px;color:var(--ink);font-size:13px;padding-bottom:7px}
#count{margin-left:auto;color:var(--mut);font-size:12px;padding-bottom:8px}
.list{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);background:#fafbfc}
td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:middle}tr:last-child td{border-bottom:0}
tr.row{cursor:pointer}tr.row:hover{background:#f6f9ff}tr.sel{background:#eaf1fe}
tr.row.queued td:first-child{box-shadow:inset 3px 0 0 #e0a21b}tr.row.skip{opacity:.55}
td.sc{width:58px}.badge{display:inline-block;min-width:36px;text-align:center;padding:3px 0;border-radius:8px;font-weight:650;font-variant-numeric:tabular-nums;background:var(--gray);color:#47505d}
.badge.hi{background:var(--okbg);color:var(--ok)}.badge.med{background:var(--warnbg);color:var(--warn)}
.t{font-weight:600}.t a{color:var(--ink)}.t a:hover{color:var(--acc)}.sub{color:var(--mut);font-size:12.5px}
td.why{color:#445064;font-size:13px;max-width:380px}
td.st{white-space:nowrap;text-align:right;width:210px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;background:var(--gray);color:#47505d;margin-right:4px}.pill.applied{background:var(--okbg);color:var(--ok)}.pill.queued{background:var(--warnbg);color:var(--warn)}.pill.skip{color:#8a93a0}
button{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);cursor:pointer}button:hover{background:#f3f5f8}
button.ok{background:var(--ok);color:#fff;border-color:var(--ok)}button.ok:hover{background:#12683f}
.empty{padding:36px;text-align:center;color:var(--mut)}
#detail{display:none;position:fixed;top:0;right:0;bottom:0;width:min(520px,100%);background:var(--card);border-left:1px solid var(--line);box-shadow:-12px 0 30px rgba(20,30,50,.12);padding:20px 22px;overflow:auto;z-index:5}
#detail h2{margin:0 28px 2px 0;font-size:17px}#detail h3{margin:16px 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
#detail ul{margin:0;padding-left:18px}#detail li{margin:2px 0}#detail pre{white-space:pre-wrap;background:#f6f7f9;border:1px solid var(--line);padding:10px;border-radius:8px;max-height:230px;overflow:auto;font:12.5px/1.5 ui-monospace,Menlo,monospace}
#detail .x{position:absolute;top:14px;right:16px;border:0;background:none;font-size:20px;line-height:1;color:var(--mut)}
#detail .acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0 4px}
#detail a.open{display:inline-block;padding:6px 12px;border-radius:7px;background:var(--acc);color:#fff;font-weight:600}#detail a.open:hover{text-decoration:none;background:#1c47a6}
.muted{color:var(--mut)}
.pill.run{white-space:normal;text-align:left;max-width:300px;margin:0 4px 4px 0;font-weight:600}.pill.run-active{background:#e3ecfd;color:var(--acc)}.pill.run-complete{background:var(--okbg);color:var(--ok)}.pill.run-needs_you{background:var(--warnbg);color:var(--warn)}.pill.run-blocked,.pill.run-failed{background:#fde4e1;color:#a2281d}
button.go{background:var(--acc);color:#fff;border-color:var(--acc)}button.go:hover{background:#1c47a6}button:disabled{opacity:.5;cursor:default}
td.pick{width:26px;padding-right:0}.err{color:#a2281d;font-size:12px;white-space:normal}
#fillmsg{color:var(--mut);font-size:12px;padding-bottom:8px}#fillmsg.bad{color:#a2281d}
#detail .runbox{margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafbfc}#detail .runbox img{display:block;max-width:100%;margin-top:10px;border:1px solid var(--line);border-radius:6px}
@media(max-width:900px){.top{grid-template-columns:1fr}td.why,th.why{display:none}.cards{grid-template-columns:repeat(2,1fr)}}`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const el = (t, props = {}, ...kids) => { const e = document.createElement(t); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
let rows = [], stats = null, asOf = Date.now(), shown = 100, selected = null;
let runs = {}, runsSig = '[]', picked = new Set(), errs = {}, pollT = null, detailRow = null;
const FILLABLE = ['greenhouse', 'lever', 'ashby'], LOWFIT = 40;
const srcOf = (k) => String(k).split(':')[0];
const canFill = (r) => FILLABLE.includes(srcOf(r.key)) && r.status !== 'applied' && r.status !== 'skip';
const isActive = (u) => u && (u.state === 'queued' || u.state === 'opening' || u.state === 'filling' || u.state === 'verifying');
const isBusy = (u) => isActive(u) || (u && u.windowOpen);
const DEMO = CFG.mode === 'demo';
const TOKEN = (document.querySelector('meta[name="jr-token"]') || {}).content || '';
const post = (url, body) => j(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-job-radar-token': TOKEN }, body: JSON.stringify(body) });
const isHttp = (u) => /^https?:\\/\\//.test(u || '');
async function j(url, init) { const r = await fetch(url, init); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
async function load() {
  if (DEMO) { rows = CFG.data.rows; stats = CFG.data.stats; asOf = new Date(CFG.data.asOf + 'T12:00:00Z').getTime(); }
  else { [rows, stats] = await Promise.all([j('/api/jobs'), j('/api/stats')]); }
  render(); if (!DEMO && !pollT) pollRuns(true);
}
function filtered() {
  const st = $('f-status').value, tr = $('f-track').value, ar = $('f-arr').value, lo = Number($('f-lo').value || 0), hi = Number($('f-hi').value || 100), wk = $('f-week').checked, q = $('f-q').value.trim().toLowerCase();
  return rows.filter((r) => (!st || r.status === st) && (!tr || r.track === tr) && r.score >= lo && r.score <= hi
    && (!ar || (ar === 'remote+hybrid' ? (r.arrangement === 'remote' || r.arrangement === 'hybrid') : r.arrangement === ar))
    && (!wk || (r.posted && asOf - new Date(r.posted + 'T12:00:00Z').getTime() <= 7 * 86400000))
    && (!q || (r.company + ' ' + r.title).toLowerCase().includes(q)));
}
function chipText(u) {
  switch (u.state) {
    case 'verifying': return 'VERIFYING';
    case 'complete': return 'FILL COMPLETE - review and submit';
    case 'needs_you': return 'NEEDS YOU: ' + ((u.fields || []).join(', ') || (u.detail || ''));
    case 'blocked': return 'BLOCKED: ' + (u.reason || '');
    case 'failed': return 'FAILED: ' + (u.reason || '');
    case 'applied': return u.via === 'auto' ? 'APPLIED (auto)' : 'APPLIED (manual)';
    default: return u.state;
  }
}
const chip = (u) => el('span', { className: 'pill run run-' + (isActive(u) ? 'active' : u.state), textContent: chipText(u), title: chipText(u) });
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-job-radar-token': TOKEN }, body: JSON.stringify(body) });
  let out = {}; try { out = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) throw new Error((out.error || ('HTTP ' + r.status)) + (out.keys && out.keys.length ? ' (' + out.keys.join(', ') + ')' : ''));
  return out;
}
async function copySheet(key, btn) {
  const old = btn.textContent;
  try { const r = await fetch('/api/sheet?key=' + encodeURIComponent(key)); if (!r.ok) throw new Error('HTTP ' + r.status); await navigator.clipboard.writeText(await r.text()); btn.textContent = 'Copied'; }
  catch (e) { btn.textContent = 'Copy failed'; errs[key] = 'could not copy the sheet: ' + e.message; }
  setTimeout(() => { btn.textContent = old; }, 2500);
}
async function launch(keys) {
  const low = keys.map((k) => rows.find((r) => r.key === k)).filter((r) => r && r.score < LOWFIT);
  let allow = false;
  if (low.length) {
    if (!confirm('These jobs score below ' + LOWFIT + ' (a weak fit): ' + low.map((r) => r.company + ' - ' + r.title + ' (' + r.score + ')').join('; ') + '. Open them anyway?')) return;
    allow = true;
  }
  const fm = $('fillmsg'); fm.className = ''; fm.textContent = '';
  try {
    await postJson('/api/launch', allow ? { keys, allowLowFit: true } : { keys });
    for (const k of keys) delete errs[k];
    picked.clear(); fm.textContent = 'started ' + keys.length + ' job' + (keys.length > 1 ? 's' : '');
  } catch (e) { for (const k of keys) errs[k] = e.message; fm.className = 'bad'; fm.textContent = e.message; }
  render(); pollRuns(true);
}
function pollDelay() { return Object.values(runs).some(isBusy) ? 1500 : 10000; }
async function pollRuns(now) {
  if (DEMO) return;
  clearTimeout(pollT);
  if (!now) { pollT = setTimeout(() => pollRuns(false), pollDelay()); return pollT; }
  try {
    const list = await j('/api/runs'), sig = JSON.stringify(list);
    const wasApplied = list.some((u) => u.state === 'applied' && (rows.find((r) => r.key === u.key) || {}).status !== 'applied');
    if (sig !== runsSig) { runsSig = sig; runs = {}; for (const u of list) runs[u.key] = u; if (wasApplied) await load(); else render(); updateRunBox(); }
  } catch (e) { /* server busy: next poll */ }
  pollT = setTimeout(() => pollRuns(true), pollDelay());
}
function updateFillBtn() { const b = $('fill-sel'); if (b) { b.textContent = 'Fill selected (' + picked.size + ')'; b.disabled = picked.size === 0; } }
function renderStats() {
  const c = $('cards'); c.textContent = '';
  for (const [n, l, hl] of [[stats.queued, 'queued for review', stats.queued > 0], [stats.appliedToday, 'applied today'], [stats.appliedWeek, 'applied this week'], [stats.applied, 'applied total'], [stats.skipped, 'skipped']]) c.append(el('div', { className: 'card' + (hl ? ' hl' : '') }, el('b', { textContent: String(n) }), el('span', { textContent: l })));
  const days = []; const base = new Date(asOf); for (let i = 13; i >= 0; i--) { const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10); days.push({ day: d, n: (stats.byDay.find((x) => x.day === d) || {}).n || 0 }); }
  const max = Math.max(1, ...days.map((d) => d.n)), W = 300, H = 64, bw = W / days.length;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 16)); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Applications per day, last 14 days');
  days.forEach((d, i) => { const h = d.n ? Math.max(3, Math.round((d.n / max) * (H - 12))) : 0; const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', String(i * bw + 2)); r.setAttribute('y', String(H - h)); r.setAttribute('width', String(bw - 4)); r.setAttribute('height', String(h)); r.setAttribute('rx', '2'); r.setAttribute('fill', '#2456c9'); const t = document.createElementNS(NS, 'title'); t.textContent = d.day + ': ' + d.n; r.append(t); svg.append(r);
    if (i % 4 === 1) { const x = document.createElementNS(NS, 'text'); x.setAttribute('x', String(i * bw + bw / 2)); x.setAttribute('y', String(H + 12)); x.setAttribute('font-size', '9'); x.setAttribute('text-anchor', 'middle'); x.setAttribute('fill', '#6a7686'); x.textContent = d.day.slice(5); svg.append(x); }
    if (d.n) { const v = document.createElementNS(NS, 'text'); v.setAttribute('x', String(i * bw + bw / 2)); v.setAttribute('y', String(H - h - 3)); v.setAttribute('font-size', '9'); v.setAttribute('text-anchor', 'middle'); v.setAttribute('fill', '#1b2430'); v.textContent = String(d.n); svg.append(v); } });
  const ch = $('chart'); ch.textContent = ''; ch.append(el('h2', { textContent: 'Applied per day' + (stats.undatedApplied ? ' (' + stats.undatedApplied + ' earlier, undated)' : '') }), svg);
}
async function mark(key, status, msg) {
  try { const out = await post('/api/mark', { key, status }); if (msg) msg.textContent = out.changed ? 'marked ' + status : 'already ' + status; await load(); }
  catch (e) { if (msg) msg.textContent = 'could not mark: ' + e.message; }
}
function render() {
  renderStats();
  const list = filtered(), body = $('tbody'); body.textContent = '';
  for (const r of list.slice(0, shown)) {
    const tr = el('tr', { className: 'row ' + r.status + (selected === r.key ? ' sel' : '') });
    const band = r.score >= 70 ? 'hi' : r.score >= 40 ? 'med' : '';
    const title = isHttp(r.url) ? el('a', { href: r.url, textContent: r.title, target: '_blank', rel: 'noopener noreferrer', title: 'Open the job posting', onclick: (e) => e.stopPropagation() }) : el('span', { textContent: r.title });
    const sub = [r.company, r.pay, r.arrangement !== 'unknown' ? r.arrangement : '', r.posted ? 'posted ' + r.posted.slice(5) : ''].filter(Boolean).join('  \\u00b7  ');
    const st = el('td', { className: 'st' }), u = runs[r.key];
    if (!DEMO && u && u.state !== 'applied') st.append(chip(u));
    st.append(el('span', { className: 'pill ' + r.status, textContent: r.status === 'skip' ? 'skipped' : r.status === 'queued' ? 'ready to review' : r.status === 'applied' && r.via === 'auto' ? 'applied (auto)' : r.status }));
    if (!DEMO && r.status !== 'applied' && r.status !== 'skip') {
      if (canFill(r)) { if (!isBusy(u)) st.append(el('button', { className: 'go', textContent: 'Open and fill', title: 'Open the form in a browser window and fill it. You review and click Submit yourself.', onclick: (e) => { e.stopPropagation(); launch([r.key]); } }), ' '); }
      else st.append(el('button', { textContent: 'Apply by hand', title: 'This site cannot be filled by the tool: copy a ready sheet to paste', onclick: (e) => { e.stopPropagation(); copySheet(r.key, e.currentTarget); } }), ' ');
      if (u && u.state === 'blocked') st.append(el('button', { textContent: 'Copy sheet', onclick: (e) => { e.stopPropagation(); copySheet(r.key, e.currentTarget); } }), ' ');
      st.append(el('button', { className: 'ok', textContent: 'Applied', title: 'I submitted this application', onclick: (e) => { e.stopPropagation(); mark(r.key, 'applied'); } }), ' ', el('button', { textContent: 'Skip', onclick: (e) => { e.stopPropagation(); mark(r.key, 'skip'); } }));
    }
    if (!DEMO) { const pk = el('td', { className: 'pick', onclick: (e) => e.stopPropagation() }); if (canFill(r) && !isBusy(u)) pk.append(el('input', { type: 'checkbox', checked: picked.has(r.key), title: 'Select for Fill selected', onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) picked.add(r.key); else picked.delete(r.key); updateFillBtn(); } })); tr.append(pk); }
    tr.append(el('td', { className: 'sc' }, el('span', { className: 'badge ' + band, textContent: String(r.score) })),
      el('td', {}, el('div', { className: 't' }, title), el('div', { className: 'sub', textContent: sub }), ...(errs[r.key] ? [el('div', { className: 'err', textContent: errs[r.key] })] : [])),
      el('td', { className: 'why', textContent: r.fit }), st);
    tr.onclick = () => { selected = r.key; render(); showDetail(r); };
    if (!DEMO && picked.has(r.key) && !(canFill(r) && !isBusy(u))) picked.delete(r.key);
    body.append(tr);
  }
  updateFillBtn();
  $('empty').style.display = list.length ? 'none' : '';
  $('count').textContent = list.length + ' of ' + rows.length + ' jobs' + (list.length > shown ? ' (showing the top ' + shown + ')' : '');
  $('more').style.display = list.length > shown ? '' : 'none';
}
function updateRunBox() {
  const box = $('runbox'); if (!box || !detailRow) return;
  const r = detailRow, u = runs[r.key]; box.textContent = '';
  if (u && u.state !== 'applied') box.append(chip(u), ' ');
  const row = el('div', { className: 'acts' });
  if (canFill(r) && !isBusy(u)) row.append(el('button', { className: 'go', textContent: 'Open and fill', onclick: () => launch([r.key]) }));
  if (!canFill(r) && r.status !== 'applied' && r.status !== 'skip') row.append(el('button', { textContent: 'Apply by hand (Copy sheet)', onclick: (e) => copySheet(r.key, e.currentTarget) }));
  if (u && u.state === 'blocked') row.append(el('button', { textContent: 'Copy sheet', onclick: (e) => copySheet(r.key, e.currentTarget) }));
  if (u && u.windowOpen) { const fm = el('span', { className: 'muted' }); row.append(el('button', { textContent: 'Focus window', onclick: async () => { try { await postJson('/api/focus', { key: r.key }); fm.textContent = ''; } catch (e) { fm.textContent = e.message; } } }), fm); }
  if (row.childNodes.length) box.append(row);
  if (errs[r.key]) box.append(el('div', { className: 'err', textContent: errs[r.key] }));
  if (u && u.hasShot) box.append(el('img', { src: '/shot?key=' + encodeURIComponent(r.key) + '&v=' + encodeURIComponent(u.updatedAt), alt: 'The filled form', id: 'shot' }));
  box.style.display = box.childNodes.length ? '' : 'none';
}
function closeDetail() { $('detail').style.display = 'none'; selected = null; detailRow = null; render(); }
async function showDetail(r) {
  const d = $('detail'); d.style.display = 'block'; d.textContent = '';
  d.append(el('button', { className: 'x', textContent: '\\u00d7', title: 'Close', onclick: closeDetail }));
  let x; try { x = DEMO ? CFG.data.details[r.key] : await j('/api/job?key=' + encodeURIComponent(r.key)); } catch (e) { d.append('Could not load details.'); return; }
  if (!x) { d.append('No details.'); return; }
  const ul = (a) => el('ul', {}, ...a.map((s) => el('li', { textContent: s })));
  d.append(el('h2', { textContent: r.title }), el('div', { className: 'muted', textContent: r.company + '  \\u00b7  score ' + r.score + '  \\u00b7  track ' + r.track + '  \\u00b7  ' + (x.priority || '-') + ' priority' }));
  const acts = el('div', { className: 'acts' });
  if (isHttp(x.url)) acts.append(el('a', { className: 'open', href: x.url, textContent: 'Open job posting \\u2197', target: '_blank', rel: 'noopener noreferrer' }));
  if (!DEMO && x.hasLetter) acts.append(el('a', { href: '/letter?key=' + encodeURIComponent(r.key), textContent: 'Cover letter PDF', target: '_blank' }));
  if (!DEMO) { const msg = el('span', { className: 'muted' });
    if (r.status !== 'applied') acts.append(el('button', { className: 'ok', textContent: 'Mark applied', onclick: () => mark(r.key, 'applied', msg) }));
    if (r.status !== 'skip') acts.append(el('button', { textContent: 'Skip', onclick: () => mark(r.key, 'skip', msg) }));
    acts.append(msg); }
  d.append(acts);
  if (!DEMO) { detailRow = r; d.append(el('div', { className: 'runbox', id: 'runbox' })); updateRunBox(); }
  d.append(el('h3', { textContent: 'Strengths' }), ul(x.strengths.length ? x.strengths : ['(none recorded)']), el('h3', { textContent: 'Gaps' }), ul(x.gaps.length ? x.gaps : ['(none recorded)']));
  d.append(el('h3', { textContent: 'Prepared notes' }), x.note ? el('pre', { textContent: x.note }) : el('div', { className: 'muted', textContent: DEMO ? '(sample data: no notes)' : 'No note prepared yet.' }));
  if (!DEMO && !x.hasLetter) d.append(el('p', { className: 'muted', textContent: 'No cover letter PDF yet.' }));
}
for (const id of ['f-status', 'f-track', 'f-arr', 'f-lo', 'f-hi', 'f-week', 'f-q']) $(id).addEventListener('input', () => { shown = 100; render(); });
if (!DEMO) $('fill-sel').onclick = () => launch([...picked]);
if (!DEMO) $('addform').onsubmit = async (e) => {   // POST /api/add: the server fetches that public page (never LinkedIn/Indeed/Handshake or a private host), scores it within the spend cap, stores it
  e.preventDefault(); const u = $('add-url').value.trim(), m = $('addmsg'); if (!u) return;
  $('add-go').disabled = true; m.textContent = 'fetching and scoring...';
  try { const r = await fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json', 'x-job-radar-token': TOKEN }, body: JSON.stringify({ url: u }) }); const x = await r.json();
    m.textContent = x.status === 'new' ? 'added ' + (x.company || '') + ' - ' + (x.title || '') + (x.score != null ? ' (score ' + x.score + ')' : '') + (x.reason ? ': ' + x.reason : '') : x.status === 'dup' || x.status === 'updated' ? 'already in the list' + (x.key ? ' (' + x.key + ')' : '') : (x.reason || x.error || 'could not add');
    if (x.ok) { $('add-url').value = ''; await load(); } }
  catch (err) { m.textContent = 'could not add: ' + err.message; } finally { $('add-go').disabled = false; } };
$('more').onclick = () => { shown += 100; render(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('detail').style.display === 'block') closeDetail(); });
load().catch((e) => { $('count').textContent = 'Could not load: ' + e.message; });`;

export function renderPage(o: PageOpts): string {
  const cfg = JSON.stringify({ mode: o.mode, data: o.data ?? null }).replace(/</g, '\\u003c');   // data is inlined as JSON: "<" is escaped so nothing in it can close the script tag
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const opt = (v: string, l: string) => `<option value="${v}">${l}</option>`;
  const sub = o.mode === 'demo' ? 'Read-only sample data. Click a job for details.' : 'Your scored jobs. Click a title to open the posting, or use the buttons once you have applied.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
${o.token ? `<meta name="jr-token" content="${esc(o.token)}">` : ''}<title>${esc(o.title)}</title><style>${CSS}</style></head><body>
${o.banner ? `<div class="banner">${esc(o.banner)}</div>` : ''}
<header><h1>${esc(o.title)}</h1><p>${esc(sub)}</p></header><main>
<div class="top"><div class="cards" id="cards"></div><div class="chart" id="chart"></div></div>
<div class="bar">
<label>Status<select id="f-status">${opt('', 'all')}${opt('queued', 'ready to review')}${opt('applied', 'applied')}${opt('skip', 'skipped')}${opt('new', 'new')}${opt('seen', 'seen')}</select></label>
<label>Track<select id="f-track">${opt('', 'all')}${opt('A', 'A')}${opt('B', 'B')}</select></label>
<label>Arrangement<select id="f-arr">${opt('', 'any')}${opt('remote', 'remote')}${opt('hybrid', 'hybrid')}${opt('remote+hybrid', 'remote or hybrid')}${opt('onsite', 'onsite')}</select></label>
<label>Score from<input id="f-lo" type="number" min="0" max="100" value="0"></label><label>to<input id="f-hi" type="number" min="0" max="100" value="100"></label>
<label class="chk"><input id="f-week" type="checkbox"> posted in the last 7 days</label>
<label>Search<input id="f-q" type="search" placeholder="company or title"></label>${o.mode === 'dashboard' ? '<button id="fill-sel" class="go" disabled style="margin-bottom:2px">Fill selected (0)</button><span id="fillmsg" role="status"></span>' : ''}<span id="count"></span></div>
${o.mode === 'dashboard' ? '<form id="addform" class="bar" autocomplete="off"><label style="flex:1;min-width:280px">Add a job link (company or ATS page; not LinkedIn/Indeed/Handshake)<input id="add-url" type="url" placeholder="https://jobs.example.com/..." style="width:100%"></label><button id="add-go" type="submit" style="margin-bottom:2px">Add and score</button><span id="addmsg" role="status" class="muted"></span></form>' : ''}
<div class="list"><table><thead><tr>${o.mode === 'dashboard' ? '<th class="pick"></th>' : ''}<th>Fit</th><th>Job</th><th class="why">Why it fits</th><th style="text-align:right">Status</th></tr></thead><tbody id="tbody"></tbody></table><div class="empty" id="empty" style="display:none">No jobs match these filters.</div></div>
<p><button id="more" style="display:none">Show more</button></p></main><aside id="detail"></aside>
<script>const CFG = ${cfg};${SCRIPT}</script></body></html>`;
}
