import { QUESTIONS } from './questions.js';
import { MODELS, scoreModel, clankerScore, isMock } from './scoring.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function api(request, env, url) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/status') {
    return json({ mock: isMock(env) });
  }

  if (request.method === 'POST' && pathname === '/api/session') {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)')
      .bind(id, Date.now())
      .run();
    return json({
      session: id,
      questions: QUESTIONS,
      models: MODELS.map(({ id, label, maker }) => ({ id, label, maker })),
      mock: isMock(env),
    });
  }

  if (request.method === 'POST' && pathname === '/api/score') {
    if (env.SCORE_RL) {
      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await env.SCORE_RL.limit({ key: ip });
      if (!success) return json({ error: 'rate limited, slow down' }, 429);
    }
    const body = await request.json();
    const question = QUESTIONS.find((q) => q.id === body.questionId);
    const model = MODELS.find((m) => m.id === body.model);
    if (!question || !model) return json({ error: 'unknown question or model' }, 400);
    const session = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?')
      .bind(String(body.session ?? ''))
      .first();
    if (!session) return json({ error: 'unknown session' }, 400);

    const completion = String(body.completion ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (completion.length < 2) return json({ error: 'completion too short' }, 400);

    const result = await scoreModel(env, model, question.prompt, completion);
    if (!result) return json({ model: model.id, ok: false });

    await env.DB.prepare(
      'INSERT OR REPLACE INTO answers (session_id, question_id, model, avg_kl, steps, completion) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(session.id, question.id, model.id, result.avgKL, result.steps, completion)
      .run();
    return json({ model: model.id, ok: true, ...result });
  }

  if (request.method === 'POST' && pathname === '/api/finish') {
    const body = await request.json();
    const sessionId = String(body.session ?? '');
    const rows = (
      await env.DB.prepare(
        'SELECT question_id, model, avg_kl FROM answers WHERE session_id = ?'
      )
        .bind(sessionId)
        .all()
    ).results;
    const questionCount = new Set(rows.map((r) => r.question_id)).size;
    if (questionCount < 4) return json({ error: 'not enough scored questions' }, 400);

    const perModel = MODELS.map((m) => {
      const mine = rows.filter((r) => r.model === m.id);
      if (!mine.length) return null;
      const avgKL = mine.reduce((s, r) => s + r.avg_kl, 0) / mine.length;
      return {
        model: m.id,
        label: m.label,
        maker: m.maker,
        avgKL: Math.round(avgKL * 1000) / 1000,
        score: clankerScore(avgKL, m.d0),
        questions: mine.length,
      };
    }).filter(Boolean);
    // Divergence to the model ensemble is the min over members, so the overall
    // score is the nearest model's — your inner clanker sets your number.
    const overall = Math.max(...perModel.map((m) => m.score));

    await env.DB.prepare(
      'INSERT OR REPLACE INTO results (id, created_at, overall, per_model) VALUES (?, ?, ?, ?)'
    )
      .bind(sessionId, Date.now(), overall, JSON.stringify(perModel))
      .run();
    return json({ id: sessionId, overall, perModel, percentile: await percentile(env, overall) });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/result/')) {
    const id = pathname.slice('/api/result/'.length);
    const row = await env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json({
      id,
      overall: row.overall,
      perModel: JSON.parse(row.per_model),
      percentile: await percentile(env, row.overall),
    });
  }

  return json({ error: 'not found' }, 404);
}

// Share of other finished runs strictly less clanker than this score.
async function percentile(env, overall) {
  const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM results').first();
  if (total <= 1) return null;
  const { below } = await env.DB.prepare(
    'SELECT COUNT(*) AS below FROM results WHERE overall < ?'
  )
    .bind(overall)
    .first();
  return Math.round((100 * below) / (total - 1));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
