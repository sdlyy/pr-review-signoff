// ==UserScript==
// @name         PR review sign-off
// @namespace    pr-review-signoff
// @version      0.3.0
// @description  Shows in a GitHub PR's Reviewers section which review agents (Codex, CodeRabbit, Greptile, ...) signed off on its current head commit
// @author       sdlyy
// @homepageURL  https://github.com/sdlyy/pr-review-signoff
// @supportURL   https://github.com/sdlyy/pr-review-signoff/issues
// @updateURL    https://raw.githubusercontent.com/sdlyy/pr-review-signoff/main/pr-review-signoff.user.js
// @downloadURL  https://raw.githubusercontent.com/sdlyy/pr-review-signoff/main/pr-review-signoff.user.js
// @match        https://github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      api.github.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

const QUERY = `
query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      early: comments(first: 100) { nodes { ...C } }
      recent: comments(last: 50) { nodes { ...C } }
      reviews(last: 100) { nodes { author { login __typename } commit { oid } url } }
      reviewThreads(first: 100) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login __typename } url } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        nodes { __typename ... on CheckRun { name status } }
      } } } } }
    }
  }
}
fragment C on IssueComment { id author { login __typename } body url updatedAt }`;

const AGENTS = [
  { name: 'Codex', login: 'chatgpt-codex-connector', parse: parseCodex },
  { name: 'CodeRabbit', login: 'coderabbitai', check: 'CodeRabbit', parse: parseCodeRabbit },
  { name: 'Greptile', login: 'greptile-apps', check: 'Greptile Review', parse: parseGreptile },
];

const short = (sha) => (sha ? sha.slice(0, 7) : '?');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lastMatch = (body, re) => [...body.matchAll(re)].at(-1);

function parseCodex(comments) {
  for (const c of [...comments].reverse()) {
    const m = c.body.match(/codex-review-state:v1 (\{.*?\})\s*-->/s);
    let s;
    try { s = m && JSON.parse(m[1]).code_review; } catch { s = null; }
    if (!s || !s.status) continue;
    const base = { url: c.url, sha: s.commit_sha };
    if (s.status !== 'completed') {
      return /progress|pending|queued|running|started/i.test(s.status)
        ? { ...base, running: s.status }
        : { ...base, sha: null, detail: `status: ${s.status}` };
    }
    return {
      ...base,
      findings: !!s.has_unresolved_findings,
      detail: s.has_unresolved_findings ? 'unresolved findings' : s.has_any_findings ? 'findings resolved' : 'no findings',
    };
  }
  return { url: comments.at(-1)?.url };
}

function parseCodeRabbit(comments) {
  const all = comments.map((c) => c.body).join('\n');
  const skipped = /Review limit reached/i.test(all) ? 'review limit reached' : /Review skipped/i.test(all) ? 'review skipped' : null;
  const c = [...comments].reverse().find((c) => c.body.includes('final_review_risk_coverage'));
  if (!c) return { url: comments.at(-1)?.url, skipped };
  let cov;
  try { cov = JSON.parse(lastMatch(c.body, /final_review_risk_coverage:(\{.*?\})\s*-->/gs)[1]); } catch { cov = {}; }
  const risk = lastMatch(c.body, /Merge Risk:\*\*\s*\*\*([^*]+?)\*\*/g)?.[1].replace(/^[^\p{L}]+/u, '').trim();
  const kind = cov.kind && cov.kind !== 'reviewed' ? ` (${cov.kind})` : '';
  return { url: c.url, sha: cov.coveredCommitId, skipped, detail: (risk ? `${risk} risk` : 'no risk label') + kind };
}

function parseGreptile(comments) {
  const c = [...comments].reverse().find((c) => c.body.includes('greptile_summary'));
  if (!c) return { url: comments.at(-1)?.url };
  const score = c.body.match(/greptile_confidence_score:(\d+)/)?.[1];
  const sha = c.body.match(/Last reviewed commit[\s\S]*?\/commit\/([0-9a-f]{40})/)?.[1];
  return { url: c.url, sha, detail: score ? `confidence ${score}/5` : 'no score' };
}

// Pure: GraphQL pullRequest -> table rows. Order of verdicts matters:
// an open thread beats a HEAD sign-off, and a HEAD sign-off beats an old "limit reached".
function summarize(pr) {
  const head = pr.headRefOid;
  const byId = new Map([...pr.early.nodes, ...pr.recent.nodes].map((c) => [c.id, c]));
  const comments = [...byId.values()].filter((c) => c.author).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const reviews = pr.reviews.nodes.filter((r) => r.author);
  const threads = pr.reviewThreads.nodes.map((t) => ({ ...t, first: t.comments.nodes[0] }));
  const checks = (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((n) => n.__typename === 'CheckRun');

  const openThreads = (login) => threads.filter((t) => t.first?.author?.login === login && !t.isResolved);
  const shaNote = (sha) => (!sha ? null : sha === head ? `reviewed HEAD ${short(sha)}` : `reviewed ${short(sha)}, HEAD is ${short(head)}`);
  const threadNote = (open) => {
    const outdated = open.filter((t) => t.isOutdated).length;
    return open.length ? plural(open.length, 'open thread') + (outdated ? ` (${outdated} outdated)` : '') : null;
  };
  const join = (parts) => [...new Set(parts.filter(Boolean))].join(' · ');

  const rows = [];
  const absent = [];
  for (const a of AGENTS) {
    const mine = comments.filter((c) => c.author.login === a.login);
    const present = mine.length || reviews.some((r) => r.author.login === a.login) || threads.some((t) => t.first?.author?.login === a.login);
    if (!present) { absent.push(a.name); continue; }
    const p = a.parse(mine);
    const open = openThreads(a.login);
    const reviewing = a.check && checks.some((c) => c.name === a.check && c.status !== 'COMPLETED');
    const running = p.running || (reviewing ? 'reviewing' : null);
    const verdict = running ? 'running'
      : p.findings || open.length ? 'findings'
      : p.sha && p.sha === head ? 'ok'
      : p.skipped ? 'skipped'
      : p.sha ? 'stale'
      : 'unknown';
    const note = running ? 'reviewing'
      : verdict === 'findings' && open.length ? plural(open.length, 'open thread')
      : verdict === 'skipped' ? p.skipped
      : p.detail || 'no review state found';
    const title = join([running, verdict === 'skipped' && p.skipped, p.detail, threadNote(open), shaNote(p.sha)]);
    rows.push({ name: a.name, known: true, verdict, note, sha: p.sha ?? null, url: p.url, title });
  }

  // Other code-reviewing bots only matter when they leave something to resolve.
  const known = new Set(AGENTS.map((a) => a.login));
  const otherBots = new Set(threads.filter((t) => t.first?.author?.__typename === 'Bot').map((t) => t.first.author.login));
  for (const login of otherBots) {
    const open = openThreads(login);
    if (known.has(login) || !open.length) continue;
    const sha = reviews.filter((r) => r.author.login === login).at(-1)?.commit?.oid ?? null;
    rows.push({ name: login, known: false, verdict: 'findings', note: plural(open.length, 'open thread'), sha, url: open[0].first.url, title: join([threadNote(open), shaNote(sha)]) });
  }

  const total = rows.filter((r) => r.known).length;
  const okCount = rows.filter((r) => r.known && r.verdict === 'ok').length;
  return { head, rows, absent, total, okCount };
}

// ---------------------------------------------------------------- browser

const BOX_ID = 'pr-review-signoff';
const LOG = '[pr-review-signoff]';
const STALE_AFTER_MS = 60_000;
const SIDEBAR_WAIT_MS = 2_000;
// Octicons (16px), same set GitHub uses next to reviewers.
const ICONS = {
  check: ['M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z'],
  dot: ['M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z'],
  diff: ['M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z'],
  skip: ['M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z'],
  sync: ['M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z'],
  question: ['M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'],
};
const VERDICT = {
  ok: { tone: 'ok', icon: 'check' },
  stale: { tone: 'warn', icon: 'dot' },
  running: { tone: 'warn', icon: 'sync' },
  skipped: { tone: 'warn', icon: 'skip' },
  unknown: { tone: 'warn', icon: 'question' },
  findings: { tone: 'bad', icon: 'diff' },
};
// Tampermonkey/Violentmonkey expose GM_*; Safari Userscripts and Greasemonkey 4 only the async GM.*.
const gmGet = (k, d) => (typeof GM_getValue === 'function' ? Promise.resolve(GM_getValue(k, d)) : GM.getValue(k, d));
const gmSet = (k, v) => (typeof GM_setValue === 'function' ? Promise.resolve(GM_setValue(k, v)) : GM.setValue(k, v));

let current = null;
let box = null;

function gql(variables, token) {
  const xhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : GM.xmlHttpRequest;
  return new Promise((resolve, reject) => {
    xhr({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ query: QUERY, variables }),
      onload: (r) => {
        if (r.status === 401) return reject(new Error('GitHub rejected the token'));
        let json;
        try { json = JSON.parse(r.responseText); } catch { return reject(new Error(`HTTP ${r.status}`)); }
        if (json.errors?.length) return reject(new Error(json.errors[0].message));
        const pr = json.data?.repository?.pullRequest;
        return pr ? resolve(pr) : reject(new Error('PR not found'));
      },
      onerror: () => reject(new Error('network error')),
    });
  });
}

async function load(st) {
  const token = await gmGet('token', '');
  if (!token) { st.status = 'no-token'; return render(st); }
  st.status = st.summary ? 'refreshing' : 'loading';
  render(st);
  try {
    const pr = await gql({ owner: st.owner, name: st.name, number: st.number }, token);
    st.summary = summarize(pr);
    st.status = 'ok';
    st.error = null;
  } catch (e) {
    st.status = 'error';
    st.error = e.message;
    console.warn(LOG, e);
  }
  st.fetchedAt = Date.now();
  if (current === st) render(st);
}

function setToken() {
  const t = prompt('GitHub token for PR review sign-off (fine-grained, read-only is enough):', '');
  if (t === null) return;
  gmSet('token', t.trim()).then(() => current && load(current));
}

function el(tag, { dataset, ...props } = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  Object.assign(n.dataset, dataset);
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

function icon(name, className) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', class: className })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function row(r, head) {
  const { tone, icon: name } = VERDICT[r.verdict];
  const stale = r.sha && r.sha !== head;
  return el(r.url ? 'a' : 'div', { className: 'ps-row', ...(r.url && { href: r.url }), title: r.title, dataset: { tone } },
    icon(name, `ps-ic ps-ic-${tone}`),
    el('span', { className: 'ps-name', textContent: r.name }),
    el('span', { className: 'ps-note', textContent: r.note }),
    r.sha && el('code', { className: 'ps-sha', textContent: stale ? short(r.sha) : 'HEAD', dataset: stale ? { stale: '' } : {} }));
}

function content(st) {
  const s = st.summary;
  const refresh = el('button', { type: 'button', className: 'ps-iconbtn', title: 'Refresh', disabled: st.status === 'loading' || st.status === 'refreshing', onclick: () => load(st) }, icon('sync'));
  const tokenBtn = el('button', { type: 'button', className: 'ps-btn', textContent: 'Set token', onclick: setToken });
  const allOk = s && s.total > 0 && s.okCount === s.total;
  const head = el('div', { className: 'ps-head' },
    el('span', { className: 'ps-title', textContent: 'Review agents' }),
    s && s.total > 0 && el('span', { className: 'ps-count', title: `HEAD ${s.head}`, dataset: { tone: allOk ? 'ok' : 'warn' }, textContent: `${s.okCount}/${s.total} at HEAD` }),
    st.status !== 'no-token' && refresh);

  if (st.status === 'no-token') return [head, el('div', { className: 'ps-msg' }, el('span', { textContent: 'Needs a GitHub token. ' }), tokenBtn)];
  if (!s && st.status === 'error') return [head, el('div', { className: 'ps-msg ps-err' }, el('span', { textContent: `${st.error}. ` }), tokenBtn)];
  if (!s) return [head, el('div', { className: 'ps-msg ps-muted', textContent: 'Loading…' })];
  return [
    head,
    ...s.rows.map((r) => row(r, s.head)),
    !s.rows.length && el('div', { className: 'ps-msg ps-muted', textContent: 'No review agents on this PR' }),
    st.status === 'error' && el('div', { className: 'ps-msg ps-err', textContent: st.error }),
    s.absent.length > 0 && el('div', { className: 'ps-foot', textContent: `Not run: ${s.absent.join(', ')}` }),
  ].filter(Boolean);
}

function findReviewers() {
  return document.querySelector('#partial-discussion-sidebar [data-channel-event-name="reviewers_updated"]')
    || [...document.querySelectorAll('.discussion-sidebar-item')]
      .find((s) => /^\s*Reviewers\b/.test(s.querySelector('.discussion-sidebar-heading')?.textContent ?? ''));
}

// Top of the Reviewers block on the Conversation tab. Tabs without that sidebar (Files, Commits)
// get the box at the top of the page, but only after the sidebar had a chance to render.
function place() {
  const section = findReviewers();
  if (!section && Date.now() - current.since < SIDEBAR_WAIT_MS) return;
  const target = section || document.querySelector('#repo-content-pjax-container') || document.querySelector('main') || document.body;
  if (target.firstElementChild !== box) target.prepend(box);
  box.classList.toggle('ps-standalone', !section);
}

function render(st) {
  if (current !== st) return;
  box.replaceChildren(...content(st));
  place();
}

// GitHub navigates client-side and live-replaces the sidebar, so poll and re-place.
function tick() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) { box.remove(); current = null; return; }
  const key = `${m[1]}/${m[2]}#${m[3]}`;
  if (current?.key !== key) {
    current = { key, owner: m[1], name: m[2], number: Number(m[3]), since: Date.now() };
    box.replaceChildren();
    box.remove();
    load(current);
  } else if (box.childElementCount) {
    place();
  }
}

const CSS = `
#${BOX_ID}{margin:0 0 16px;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;overflow:hidden;
  background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);font-size:12px;line-height:18px}
#${BOX_ID}.ps-standalone{max-width:360px;margin:16px}
#${BOX_ID} svg{flex:none;fill:currentColor}
#${BOX_ID} .ps-head{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bgColor-muted,#f6f8fa)}
#${BOX_ID} .ps-title{flex:1;font-weight:600}
#${BOX_ID} .ps-count{padding:0 6px;border-radius:999px;font-size:11px;font-weight:600}
#${BOX_ID} .ps-count[data-tone=ok]{color:var(--fgColor-success,#1a7f37);background:var(--bgColor-success-muted,#dafbe1)}
#${BOX_ID} .ps-count[data-tone=warn]{color:var(--fgColor-attention,#9a6700);background:var(--bgColor-attention-muted,#fff8c5)}
#${BOX_ID} .ps-iconbtn{display:flex;padding:2px;border:0;border-radius:4px;background:none;color:var(--fgColor-muted,#59636e);cursor:pointer}
#${BOX_ID} .ps-iconbtn:hover{color:var(--fgColor-accent,#0969da);background:var(--bgColor-neutral-muted,#818b981f)}
#${BOX_ID} .ps-iconbtn:disabled{opacity:.5;cursor:default}
#${BOX_ID} .ps-row{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 6px;border-top:1px solid var(--borderColor-muted,#d8dee4);
  border-left:2px solid transparent;color:inherit;text-decoration:none}
#${BOX_ID} a.ps-row:hover .ps-name{color:var(--fgColor-accent,#0969da)}
#${BOX_ID} .ps-row[data-tone=ok]{background:var(--bgColor-success-muted,#dafbe1);border-left-color:var(--borderColor-success-emphasis,#1f883d)}
#${BOX_ID} .ps-row[data-tone=warn]{background:var(--bgColor-attention-muted,#fff8c5);border-left-color:var(--borderColor-attention-emphasis,#9a6700)}
#${BOX_ID} .ps-row[data-tone=bad]{background:var(--bgColor-danger-muted,#ffebe9);border-left-color:var(--borderColor-danger-emphasis,#cf222e)}
#${BOX_ID} .ps-ic-ok{color:var(--fgColor-success,#1a7f37)}
#${BOX_ID} .ps-ic-warn{color:var(--fgColor-attention,#9a6700)}
#${BOX_ID} .ps-ic-bad{color:var(--fgColor-danger,#d1242f)}
#${BOX_ID} .ps-name{font-weight:600;white-space:nowrap}
#${BOX_ID} .ps-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fgColor-muted,#59636e)}
#${BOX_ID} .ps-sha{padding:0;background:none;font-family:var(--fontStack-monospace,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:11px;color:var(--fgColor-muted,#59636e)}
#${BOX_ID} .ps-sha[data-stale]{color:var(--fgColor-attention,#9a6700)}
#${BOX_ID} .ps-msg,#${BOX_ID} .ps-foot{padding:6px 8px;border-top:1px solid var(--borderColor-muted,#d8dee4)}
#${BOX_ID} .ps-foot,#${BOX_ID} .ps-muted{color:var(--fgColor-muted,#59636e)}
#${BOX_ID} .ps-err{color:var(--fgColor-danger,#d1242f)}
#${BOX_ID} .ps-btn{padding:0 8px;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;
  background:var(--bgColor-default,#fff);color:inherit;cursor:pointer;font:inherit}
`;

function start() {
  console.info(LOG, 'running');
  const addStyle = typeof GM_addStyle === 'function' ? GM_addStyle : (css) => document.head.append(el('style', { textContent: css }));
  addStyle(CSS);
  box = el('div', { id: BOX_ID });
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Set GitHub token', setToken);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current?.fetchedAt && Date.now() - current.fetchedAt > STALE_AFTER_MS) load(current);
  });
  const safeTick = () => { try { tick(); } catch (e) { console.error(LOG, e); } };
  setInterval(safeTick, 500);
  safeTick();
}

if (typeof process === 'object' && process.versions?.node) module.exports = { QUERY, summarize };
else start();
