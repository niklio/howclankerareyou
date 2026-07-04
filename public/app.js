const $ = (id) => document.getElementById(id);
const VIEWS = ['landing', 'gather', 'quiz', 'scoring', 'results'];
const show = (v) => VIEWS.forEach((x) => ($(`view-${x}`).hidden = x !== v));

const state = {
  session: null,
  questions: [],
  models: [],
  idx: 0,
  results: {}, // qid -> { modelId -> score response }
  promises: [],
  done: 0,
  total: 0,
  gatherTimers: [],
};

async function api(path, body) {
  const res = await fetch(
    path,
    body !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- browser history --------------------------------------------------------
// Results get real URLs (/r/:id, pushed with the full payload in state so
// back/forward re-render instantly, and the address bar IS the share link);
// the quiz gets /#self. Transient views (gather, scoring) never become
// entries. navGen invalidates in-flight flows when the user navigates away.
let navGen = 0;

// Account results get the short, stable share path (/r/handle → that
// account's latest grade); self-tests keep their UUID path.
function resultPath(fin) {
  return fin.subject && fin.subject.type === 'account' && fin.subject.handle
    ? `/r/${fin.subject.handle}`
    : `/r/${fin.id}`;
}

function pushResult(fin, live) {
  try {
    history.pushState({ view: 'result', fin, live }, '', resultPath(fin));
  } catch {}
  renderResults(fin, live);
}

window.addEventListener('popstate', (e) => {
  navGen++;
  stopGather();
  const st = e.state;
  if (st && st.view === 'result' && st.fin) {
    renderResults(st.fin, !!st.live);
    return;
  }
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    api(`/api/result/${m[1]}`)
      .then((d) => renderResults(d, false))
      .catch(() => show('landing'));
    return;
  }
  // '/' and '/#self' both land back on the input (a half-finished quiz isn't
  // resumable, and silently restarting one on Back would be stranger).
  $('btn-diagnose').disabled = false;
  show('landing');
});

// --- landing: diagnose an X account ----------------------------------------

$('diag-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runDiagnose();
});
$('link-self').addEventListener('click', (e) => {
  e.preventDefault();
  history.pushState({ view: 'quiz' }, '', '/#self');
  startSelfTest();
});

async function runDiagnose() {
  const input = $('diag-input').value.trim();
  const errEl = $('diag-err');
  errEl.hidden = true;
  if (!input) {
    errEl.textContent = 'enter an @handle.';
    errEl.hidden = false;
    return;
  }
  const btn = $('btn-diagnose');
  btn.disabled = true;
  const gen = navGen;
  showGather(guessHandle(input));
  // One silent retry on upstream flake (the scoring provider 429s in waves;
  // a couple of seconds later usually succeeds) — the gather screen just
  // keeps running through it.
  for (let attempt = 0; ; attempt++) {
    try {
      const d = await api('/api/diagnose', { input });
      if (gen !== navGen) return; // user navigated away mid-diagnosis
      stopGather();
      btn.disabled = false;
      pushResult(d, true);
      return;
    } catch (err) {
      if (err.code === 'upstream' && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (gen !== navGen) return;
      stopGather();
      btn.disabled = false;
      show('landing');
      errEl.textContent = diagnoseErrorText(err);
      errEl.hidden = false;
      $('diag-input').focus();
      return;
    }
  }
}

// Best-effort handle for the gathering screen before the server confirms it.
function guessHandle(input) {
  return input.replace(/^@/, '').replace(/[^A-Za-z0-9_].*$/, '').slice(0, 15) || 'them';
}

function diagnoseErrorText(err) {
  switch (err.code) {
    case 'badinput':
      return "that doesn't look like an X handle — just the @handle, no links.";
    case 'notfound':
      return err.message + ' — check the spelling.';
    case 'protected':
      return err.message + ' — this account is private, so we can’t read it. try a public one.';
    case 'thin':
      return err.message + ' — we need 5 recent original posts of ~11+ words. try someone wordier.';
    case 'blocked':
      return 'this account asked to be removed from the tool.';
    case 'ratelimited':
      return err.message + '.';
    case 'cap':
      return err.message + '.';
    default:
      return err.message || 'something went wrong — try again in a sec.';
  }
}

// Gathering screen: no per-step server feedback (it's one request), so the
// scan check-offs and bar are optimistic timers, cleaned up when the call
// resolves.
function showGather(handle) {
  $('gather-tag').textContent = `// diagnosing @${handle}`;
  $('gather-head').textContent = `pulling @${handle}'s recent posts…`;
  const scan = $('gather-scan').children;
  scan[0].className = 'wait';
  scan[0].textContent = '⋯ finding the account on X';
  scan[1].className = 'wait';
  scan[1].textContent = '⋯ pulling their 5 most recent posts (retweets & replies excluded)';
  scan[2].className = 'wait';
  scan[2].textContent = '⋯ scoring word-by-word against the model panel';
  const fill = $('gather-fill');
  fill.style.width = '5%';
  show('gather');
  stopGather();
  // A diagnosis is one request (~2–5s: one search call + parallel scoring), so
  // the check-offs are optimistic timers and the bar creeps asymptotically
  // toward 92% until the response lands.
  let pct = 5;
  state.gatherTimers.push(
    setTimeout(() => {
      scan[0].className = 'ok';
      scan[0].textContent = `✓ found @${handle}`;
      fill.style.width = `${(pct = 25)}%`;
    }, 700),
    setTimeout(() => {
      scan[1].className = 'ok';
      scan[1].textContent = '✓ pulled their 5 most recent posts (retweets & replies excluded)';
      fill.style.width = `${(pct = 45)}%`;
    }, 1700),
    setInterval(() => {
      pct = Math.min(92, pct + (92 - pct) * 0.12);
      fill.style.width = `${pct}%`;
    }, 300)
  );
}
function stopGather() {
  state.gatherTimers.forEach((t) => {
    clearTimeout(t);
    clearInterval(t);
  });
  state.gatherTimers = [];
}

// --- self-test (secondary path) --------------------------------------------

async function startSelfTest() {
  const link = $('link-self');
  const old = link.textContent;
  link.textContent = 'booting…';
  try {
    const d = await api('/api/session', {});
    Object.assign(state, { session: d.session, questions: d.questions, models: d.models, idx: 0, results: {}, promises: [], done: 0, total: 0 });
    if (d.mock) $('method-demo').hidden = false;
    show('quiz');
    renderQuestion();
  } catch (err) {
    link.textContent = old;
    const errEl = $('diag-err');
    errEl.textContent = `couldn't start: ${err.message}`;
    errEl.hidden = false;
  } finally {
    link.textContent = old;
  }
}

// --- quiz ------------------------------------------------------------------

function renderQuestion() {
  const q = state.questions[state.idx];
  $('quiz-progress').textContent = `question ${state.idx + 1}/${state.questions.length}`;
  $('quiz-prompt').textContent = q.prompt;
  $('quiz-err').hidden = true;
  const input = $('quiz-input');
  input.value = '';
  input.focus();
  $('btn-next').textContent = state.idx === state.questions.length - 1 ? 'finish →' : 'next →';
}

$('quiz-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-next').click();
});

$('btn-next').addEventListener('click', () => {
  const text = $('quiz-input').value.replace(/\s+/g, ' ').trim();
  if (text.split(' ').length < 2) {
    const err = $('quiz-err');
    err.textContent = 'at least two words. you are supposed to be the creative one here.';
    err.hidden = false;
    return;
  }
  const q = state.questions[state.idx];
  state.results[q.id] = {};
  for (const m of state.models) {
    state.total++;
    const p = api('/api/score', {
      session: state.session,
      questionId: q.id,
      model: m.id,
      completion: text,
    })
      .then((r) => (state.results[q.id][m.id] = r))
      .catch(() => {})
      .finally(() => {
        state.done++;
        renderScoringProgress();
      });
    state.promises.push(p);
  }
  state.idx++;
  if (state.idx < state.questions.length) renderQuestion();
  else finishFlow();
});

// --- scoring ---------------------------------------------------------------

function renderScoringProgress() {
  if ($('view-scoring').hidden) return;
  $('scoring-progress').textContent = `${state.done}/${state.total} model interviews complete`;
  $('scorebar-fill').style.width = `${(100 * state.done) / state.total}%`;
}

async function finishFlow() {
  const gen = navGen;
  show('scoring');
  renderScoringProgress();
  await Promise.allSettled(state.promises);
  try {
    const fin = await api('/api/finish', { session: state.session });
    if (gen !== navGen) return; // user navigated away mid-scoring
    pushResult(fin, true);
  } catch (err) {
    if (gen !== navGen) return;
    $('view-scoring').innerHTML =
      `<h2>scoring failed</h2><p class="fine">${err.message}. the models are being difficult. ` +
      `<a href="/" style="color:var(--accent)">try again</a>.</p>`;
  }
}

// --- results ---------------------------------------------------------------

const VERDICTS = [
  [85, 'beep boop. welcome home, unit.'],
  [60, 'heavy clanker energy. do you dream of electric sheep?'],
  [35, 'suspiciously synthetic. a language model would like to know your location.'],
  [15, 'mostly human. trace amounts of clanker.'],
  [0, 'certified organic. unpredictable in ways no lab can reproduce.'],
];
const ACCOUNT_VERDICTS = [
  [85, 'heavy clanker energy. tweets like a press release wrote itself.'],
  [60, 'a lot of clanker in the timeline. the algorithm approves.'],
  [35, 'some synthetic residue, but a pulse is detectable.'],
  [15, 'mostly human. trace amounts of clanker.'],
  [0, 'certified organic. posts no model saw coming.'],
];

function renderResults(fin, live) {
  show('results');
  const acct = fin.subject && fin.subject.type === 'account';
  const handle = acct ? fin.subject.handle : null;

  const url = fin.id ? location.origin + resultPath(fin) : location.origin;

  // Headline.
  if (acct) {
    const cachedNote = fin.cached ? ' · graded earlier this week' : '';
    $('res-context').innerHTML =
      `graded from public posts on X · <a href="https://x.com/${esc(handle)}" target="_blank" rel="noopener" style="color:var(--accent)">@${esc(handle)}</a>` +
      cachedNote;
    $('res-score').textContent = `${fin.overall}%`;
    $('res-score').previousSibling.textContent = `@${handle} is `;
    $('res-verdict').textContent = ACCOUNT_VERDICTS.find(([min]) => fin.overall >= min)[1];
    $('res-percentile').textContent =
      fin.percentile == null
        ? 'the first specimen. percentile pending more accounts.'
        : `more clanker than ${fin.percentile}% of accounts graded.`;
  } else {
    $('res-context').textContent = live ? '' : 'someone shared this result with you.';
    // Reset the "you are ___ clanker" prefix in case it was overwritten.
    $('res-score').previousSibling.textContent = 'you are ';
    $('res-score').textContent = `${fin.overall}%`;
    $('res-verdict').textContent = VERDICTS.find(([min]) => fin.overall >= min)[1];
    $('res-percentile').textContent =
      fin.percentile == null
        ? 'you are the first specimen. percentile pending more humans.'
        : `more clanker than ${fin.percentile}% of humans tested.`;
  }

  // Model similarity bars.
  const sorted = [...fin.perModel].sort((a, b) => b.score - a.score);
  const lead = acct ? 'closest model' : 'your inner clanker';
  $('res-models').innerHTML =
    `<p class="fine">${lead}: <span class="accent">${esc(sorted[0].label)}</span> — similarity by model:</p>` +
    sorted
      .map(
        (m) => `
    <div class="model-row">
      <div class="head">
        <span>${esc(m.label)} <span class="fine">(${esc(m.maker)})</span></span>
        <span class="kl">${m.score}% · ${m.avgKL} nats surprisal</span>
      </div>
      <div class="bar"><div style="width:${Math.max(1, m.score)}%"></div></div>
    </div>`
      )
      .join('');

  $('res-details').innerHTML = renderDetails(fin.grid, acct);

  // Sampled posts (accounts only).
  if (acct && fin.sources && fin.sources.length) {
    $('res-sources').innerHTML =
      `<h2 class="section">posts sampled — ${fin.sources.length}</h2>` +
      fin.sources
        .map(
          (s) =>
            `<div class="src"><span class="badge">@${esc(handle)}</span><span>${esc(s.text)}</span></div>`
        )
        .join('');
  } else {
    $('res-sources').innerHTML = '';
  }

  // Heat grid.
  const grid = fin.grid;
  if (grid && grid.length) {
    $('res-grid').innerHTML = grid
      .map(
        (row) =>
          `<div class="grid-row" title="${esc(row.answer)}">` +
          row.cells.map((c) => `<span class="cell l${c == null ? 'x' : c}"></span>`).join('') +
          `</div>`
      )
      .join('');
    $('grid-legend').innerHTML = acct
      ? 'one row per post, one square per scored word · <span class="good">green</span> = human · <span class="accent">red</span> = clanker'
      : 'one square per word · <span class="good">green</span> = human · <span class="accent">red</span> = clanker';
    $('grid-legend').hidden = false;
  } else {
    $('res-grid').innerHTML = '';
    $('grid-legend').hidden = true;
  }

  wireResultButtons(fin, grid, url, live, acct);
}

function wireResultButtons(fin, grid, url, live, acct) {
  const share = $('btn-share');
  const link = $('btn-link');
  const take = $('btn-take');
  const again = $('btn-again');
  const diagAgain = $('btn-diag-again');
  const selfInstead = $('btn-self-instead');
  const optout = $('res-optout');
  // Reset all.
  for (const b of [share, link, take, again, diagAgain, selfInstead]) b.hidden = true;
  optout.hidden = true;

  const hasGrid = grid && grid.length;

  if (acct) {
    // Account result — same layout for the diagnoser and a shared-link
    // visitor: share (primary) + diagnose someone else (secondary) under the
    // grid, a lone "take the test yourself" at the bottom. Recipients can
    // share onward too. (Opt-out is server-side only: /api/remove.)
    if (hasGrid) {
      share.hidden = false;
      share.onclick = () => shareResult(fin, grid, url, acct);
    }
    diagAgain.hidden = false;
    diagAgain.onclick = () => {
      beacon('cta', fin.id, 'diag_again');
      location.href = '/';
    };
    selfInstead.hidden = false;
    selfInstead.onclick = () => {
      beacon('cta', fin.id, 'self_instead');
      location.href = '/#self';
    };
    optout.hidden = false;
    return;
  }

  // Self-test result.
  if (live) {
    if (hasGrid) {
      share.hidden = false;
      share.onclick = () => shareResult(fin, grid, url, acct);
      link.hidden = false;
      link.onclick = async () => flash(link, (await copyText(url)) ? 'link copied' : 'copy blocked');
    }
    again.hidden = false;
    again.classList.remove('big');
    again.textContent = 'take it again';
    again.onclick = () => (location.href = '/#self');
  } else {
    take.hidden = false;
    take.onclick = () => {
      beacon('cta', fin.id, 'take_test');
      location.href = '/';
    };
  }
}

// Fire-and-forget analytics beacon (share taps use their own inline copy so
// they stay inside the click's transient activation).
function beacon(type, session, meta) {
  try {
    fetch('/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, session, meta }),
      keepalive: true,
    });
  } catch {}
}

const EMOJI = ['🟥', '🟧', '🟨', '🟩']; // 0 clanker → 3 human
const gridToEmoji = (grid) =>
  grid.map((row) => row.cells.map((c) => (c == null ? '⬜' : EMOJI[c])).join('')).join('\n');

// Self shares keep the Wordle-style emoji grid (it's YOUR square); account
// shares drop it — a stranger's grid reads as noise — and carry the verdict
// quip instead. The link unfurls into the OG card for the visual.
function shareText(fin, grid, url, acct) {
  if (acct) {
    const quip = ACCOUNT_VERDICTS.find(([min]) => fin.overall >= min)[1];
    return `@${fin.subject.handle} is ${fin.overall}% clanker 🤖\n${quip}\n\n${url}`;
  }
  return `how clanker are you? — ${fin.overall}% clanker 🤖\n\n${gridToEmoji(grid)}\n\n${url}`;
}

async function shareResult(fin, grid, url, acct) {
  const text = shareText(fin, grid, url, acct);
  try {
    fetch('/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'share', session: fin.id }),
      keepalive: true,
    });
  } catch {}
  const canShare =
    typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ text }));
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (canShare && touch) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  if (await copyText(text)) {
    flash($('btn-share'), 'copied — paste anywhere ▶');
  } else {
    // Even the legacy path is blocked (some webviews): the address bar holds
    // the share link, so point there instead of dead-ending.
    flash($('btn-share'), 'copy blocked — share the address-bar link');
  }
}

// Copy with fallbacks: in-app/AI browsers (Atlas, Comet, various WKWebViews)
// often block BOTH navigator.share and the async clipboard API. The legacy
// textarea + execCommand('copy') path still works in nearly all of them.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = old), 1800);
}

// Most / least clanker item, derived from the server grid so it renders on
// shared pages too. Lowest per-item surprisal = most clanker.
function renderDetails(grid, acct) {
  const rows = (grid || []).filter((r) => typeof r.kl === 'number' && r.answer);
  if (rows.length < 2) return '';
  const sorted = [...rows].sort((a, b) => a.kl - b.kl);
  const most = sorted[0];
  const least = sorted[sorted.length - 1];
  const noun = acct ? 'post' : 'answer';
  const body = (r, cls) =>
    acct
      ? `<p><span class="${cls}">${esc(r.answer)}</span></p>`
      : `<p>${esc(r.prompt)} <span class="${cls}">${esc(r.answer)}</span></p>`;
  return (
    `<div class="detail"><p class="q">most clanker ${noun} (${most.kl.toFixed(1)} nats surprisal)</p>` +
    body(most, 'accent') +
    `</div>` +
    `<div class="detail"><p class="q">least clanker ${noun} (${least.kl.toFixed(1)} nats surprisal)</p>` +
    body(least, 'good') +
    `</div>`
  );
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- init ------------------------------------------------------------------

api('/api/status')
  .then((s) => {
    if (s.mock) {
      $('demo-note').hidden = false;
      $('method-demo').hidden = false;
    }
  })
  .catch(() => {});

const restored = history.state;
const shared = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})$/);
if (restored && restored.view === 'result' && restored.fin) {
  // Reload of a result we rendered this session: history.state survives
  // refresh, so the taker keeps their live view (share button and all).
  renderResults(restored.fin, !!restored.live);
} else if (shared) {
  api(`/api/result/${shared[1]}`)
    .then((d) => {
      try {
        history.replaceState({ view: 'result', fin: d, live: false }, '', location.pathname);
      } catch {}
      renderResults(d, false);
    })
    .catch(() => {
      // Dead share link (expired/removed result): say so instead of silently
      // dumping the visitor on the homepage. If the link names a handle,
      // prefill it — one click re-runs the diagnosis.
      show('landing');
      const errEl = $('diag-err');
      if (/^[A-Za-z0-9_]{1,15}$/.test(shared[1])) {
        $('diag-input').value = '@' + shared[1];
        errEl.textContent = 'no grade on file for @' + shared[1] + ' — hit diagnose to make one.';
      } else {
        errEl.textContent = "that result doesn't exist anymore — diagnose someone fresh instead.";
      }
      errEl.hidden = false;
    });
} else {
  show('landing');
  // Deep-link to the self-test (from "take it again" / "take the test yourself").
  if (location.hash === '#self') {
    try {
      history.replaceState({ view: 'quiz' }, '', '/#self');
    } catch {}
    startSelfTest();
  } else {
    try {
      history.replaceState({ view: 'landing' }, '', location.pathname + location.search);
    } catch {}
  }
}
