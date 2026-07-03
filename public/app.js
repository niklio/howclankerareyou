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
        <span class="kl">${m.score}% · ${m.avgKL} nats/token</span>
      </div>
      <div class="bar"><div style="width:${Math.max(1, m.score)}%"></div></div>
    </div>`
      )
      .join('');

  $('res-details').innerHTML = live ? renderDetails() : '';

  const share = $('btn-share');
  share.hidden = !live;
  if (live) {
    const url = `${location.origin}/r/${fin.id}`;
    share.onclick = () => {
      navigator.clipboard.writeText(url).then(() => (share.textContent = 'copied'));
    };
  }
  $('btn-again').textContent = live ? 'run it again' : 'take the test yourself';
  $('btn-again').onclick = () => (location.href = '/');
}

function renderDetails() {
  // Per-question mean divergence across models, from the live score responses.
  const rows = [];
  for (const q of state.questions) {
    const rs = Object.values(state.results[q.id] || {}).filter((r) => r && r.ok);
    if (!rs.length) continue;
    const kl = rs.reduce((s, r) => s + r.avgKL, 0) / rs.length;
    rows.push({ q, kl, completion: rs[0].perStep.map((s) => s.chunk).join(' ') });
  }
  if (rows.length < 2) return '';
  rows.sort((a, b) => a.kl - b.kl);
  const bot = rows[0];
  const top = rows[rows.length - 1];

  // The single most predictable word anywhere in the run.
  let best = null;
  for (const q of state.questions)
    for (const [mid, r] of Object.entries(state.results[q.id] || {}))
      if (r && r.ok)
        for (const s of r.perStep)
          if (s.matched && (!best || s.logprob > best.logprob)) best = { ...s, mid };
  const model = best && state.models.find((m) => m.id === best.mid);
  const predictable = best
    ? `<div class="detail"><p class="q">most predictable word</p><p>“${esc(best.chunk)}” — ` +
      `${esc(model.label)} had it at ${Math.round(Math.exp(best.logprob) * 100)}%.</p></div>`
    : '';

  return (
    `<div class="detail"><p class="q">most robotic answer (${bot.kl.toFixed(1)} nats/token)</p>` +
    `<p>${esc(bot.q.prompt)} <span class="accent">${esc(bot.completion)}</span></p></div>` +
    `<div class="detail"><p class="q">most human answer (${top.kl.toFixed(1)} nats/token)</p>` +
    `<p>${esc(top.q.prompt)} <span class="good">${esc(top.completion)}</span></p></div>` +
    predictable
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
