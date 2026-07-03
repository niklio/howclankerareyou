const $ = (id) => document.getElementById(id);
const VIEWS = ['landing', 'quiz', 'scoring', 'results'];
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
};

async function api(path, body) {
  const res = await fetch(
    path,
    body !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --- landing ---------------------------------------------------------------

$('btn-start').addEventListener('click', async () => {
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'booting…';
  try {
    const d = await api('/api/session', {});
    Object.assign(state, { session: d.session, questions: d.questions, models: d.models, idx: 0 });
    if (d.mock) $('method-demo').hidden = false;
    show('quiz');
    renderQuestion();
  } catch (err) {
    btn.textContent = `failed: ${err.message} — retry?`;
    btn.disabled = false;
  }
});

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
  show('scoring');
  renderScoringProgress();
  await Promise.allSettled(state.promises);
  try {
    const fin = await api('/api/finish', { session: state.session });
    renderResults(fin, true);
  } catch (err) {
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

function renderResults(fin, live) {
  show('results');
  $('res-context').textContent = live ? '' : 'someone shared this result with you.';
  $('res-score').textContent = `${fin.overall}%`;
  $('res-verdict').textContent = VERDICTS.find(([min]) => fin.overall >= min)[1];
  $('res-percentile').textContent =
    fin.percentile == null
      ? 'you are the first specimen. percentile pending more humans.'
      : `more clanker than ${fin.percentile}% of humans tested.`;

  const sorted = [...fin.perModel].sort((a, b) => b.score - a.score);
  $('res-models').innerHTML =
    `<p class="fine">your inner clanker: <span class="accent">${esc(sorted[0].label)}</span> — similarity by model:</p>` +
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

  $('res-details').innerHTML = renderDetails(fin.grid);

  // Heat grid + Wordle-style share.
  const grid = fin.grid;
  const url = fin.id ? `${location.origin}/r/${fin.id}` : location.origin;
  if (grid && grid.length) {
    $('res-grid').innerHTML = grid
      .map(
        (row) =>
          `<div class="grid-row" title="${esc(row.prompt + ' ' + row.answer)}">` +
          row.cells
            .map((c) => `<span class="cell l${c == null ? 'x' : c}"></span>`)
            .join('') +
          `</div>`
      )
      .join('');
    $('grid-legend').hidden = false;
  }

  // Two audiences, two CTAs. The person who just took the test gets share (the
  // primary action) + copy-link, with "run it again" as a secondary. Someone
  // who opened a shared link gets neither — just "take the test" as the CTA.
  const share = $('btn-share');
  const link = $('btn-link');
  const take = $('btn-take');
  const again = $('btn-again');
  if (live) {
    // Taker: share is the primary action; "take it again" is their retake,
    // sitting at the very bottom after the deeper stats.
    if (grid && grid.length) {
      share.hidden = false;
      share.onclick = () => shareResult(fin, grid, url);
      link.hidden = false;
      link.onclick = () =>
        navigator.clipboard.writeText(url).then(() => flash(link, 'link copied'));
    }
    again.hidden = false;
    again.classList.remove('big');
    again.textContent = 'take it again';
    again.onclick = () => (location.href = '/');
  } else {
    // Recipient of a shared link already has "take the test" up top — no
    // bottom button (and "again" would be wrong; they haven't taken it).
    take.hidden = false;
    take.onclick = () => (location.href = '/');
  }
}

const EMOJI = ['🟥', '🟧', '🟨', '🟩']; // 0 clanker → 3 human
const gridToEmoji = (grid) =>
  grid.map((row) => row.cells.map((c) => (c == null ? '⬜' : EMOJI[c])).join('')).join('\n');

function shareText(fin, grid, url) {
  return `how clanker are you? — ${fin.overall}% clanker 🤖\n\n${gridToEmoji(grid)}\n\n${url}`;
}

async function shareResult(fin, grid, url) {
  const text = shareText(fin, grid, url);
  // Fire-and-forget analytics beacon for the share tap.
  try {
    fetch('/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'share', session: fin.id }),
      keepalive: true,
    });
  } catch {}
  // Prefer the native share sheet on touch devices (feature-detected, not UA
  // sniffed). The whole payload — headline + emoji grid + link — goes in `text`
  // so it survives every target; iMessage still auto-previews the URL below it.
  // navigator.share() must run in the click's transient activation, so nothing
  // async happens before it.
  const canShare =
    typeof navigator.share === 'function' &&
    (!navigator.canShare || navigator.canShare({ text }));
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (canShare && touch) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user dismissed the sheet
      // any other error: fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    flash($('btn-share'), 'copied — paste anywhere ▶');
  } catch {
    flash($('btn-share'), 'copy failed');
  }
}

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = old), 1800);
}

// Most / least clanker answer, derived from the server grid so it renders on
// shared pages too. Lowest per-question surprisal = most clanker.
function renderDetails(grid) {
  const rows = (grid || []).filter((r) => typeof r.kl === 'number' && r.answer);
  if (rows.length < 2) return '';
  const sorted = [...rows].sort((a, b) => a.kl - b.kl);
  const most = sorted[0];
  const least = sorted[sorted.length - 1];
  return (
    `<div class="detail"><p class="q">most clanker answer (${most.kl.toFixed(1)} nats surprisal)</p>` +
    `<p>${esc(most.prompt)} <span class="accent">${esc(most.answer)}</span></p></div>` +
    `<div class="detail"><p class="q">least clanker answer (${least.kl.toFixed(1)} nats surprisal)</p>` +
    `<p>${esc(least.prompt)} <span class="good">${esc(least.answer)}</span></p></div>`
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

const shared = location.pathname.match(/^\/r\/([0-9a-fA-F-]{8,})$/);
if (shared) {
  api(`/api/result/${shared[1]}`)
    .then((d) => renderResults(d, false))
    .catch(() => show('landing'));
} else {
  show('landing');
}
