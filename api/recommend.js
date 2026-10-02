const AI_GATEWAY = 'https://ai-gateway.vercel.sh/v1/responses';
const MODEL = 'openai/gpt-5.6-sol';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function textFromResponse(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  for (const out of arr(data?.output)) {
    for (const part of arr(out?.content)) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text;
    }
  }
  return '';
}

function normalizeName(name) {
  return String(name || '').trim();
}

function isSpecial(name) {
  return ['Stay on core','Only if needed','Return to core scaling','Core'].includes(name);
}

const SYSTEM = [
  'You are the Deadlock Counter-Buy Engine for a player making a live purchase decision.',
  'Recommend the single most useful purchase now, not a generic build.',
  'Use the supplied current patch/item data and high-rank evidence when present. Treat high-rank purchase data as evidence, not proof.',
  'In lane phase, weight the two lane opponents heavily while still checking whether the buy remains useful into the full six-hero roster.',
  'Protect the player hero core power spike. A technically valid counter is a bad buy if it delays a much stronger spike without solving a pressing problem.',
  'Reactive Barrier is only appropriate when enemy control actually triggers it; generic slows alone are not enough.',
  'Debuff Reducer is for meaningful duration-based debuffs/control, not simply because the roster has CC.',
  'Slowing Hex should be prioritized only when it meaningfully punishes important movement tools and this hero can capitalize on the catch.',
  'Healbane requires meaningful enemy healing and reliable Spirit-damage application by the player hero.',
  'Counterspell should answer a specific high-impact parryable threat, not generic burst.',
  'Spirit Resilience and Bullet Resilience should answer the damage profile that is actually likely to matter; do not use them as automatic fallbacks.',
  'Unstoppable rises sharply when the player hero depends on a channel or commit that the enemy roster can interrupt.',
  'If no situational counter is worth delaying core, explicitly choose Stay on core.',
  'Keep each why to one short sentence suitable for reading during a match.',
  'Return only the requested JSON.'
].join('\n');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      route: '/api/recommend',
      model: MODEL,
      gateway_auth_present: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
      runtime: process.version
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

  let phase = 'input';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const hero = normalizeName(body.hero);
    const lane = arr(body.lane).map(normalizeName).filter(Boolean).slice(0, 2);
    const enemies = arr(body.enemies).map(normalizeName).filter(Boolean).slice(0, 6);
    const stage = ['lane','mid','late'].includes(body.stage) ? body.stage : 'lane';
    const laneState = ['behind','even','ahead'].includes(body.laneState) ? body.laneState : 'even';

    if (!hero || lane.length !== 2 || enemies.length !== 6 || new Set(enemies).size !== 6) {
      return send(res, 400, { error: 'Invalid matchup payload', phase });
    }

    phase = 'AI authentication';
    const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!token) {
      return send(res, 503, {
        error: 'AI Gateway authentication is not configured on this Vercel project.',
        code: 'AI_AUTH_MISSING',
        phase
      });
    }

    const allowedNames = new Set();
    for (const x of arr(body.localCandidates)) if (x?.name) allowedNames.add(normalizeName(x.name));
    for (const x of arr(body.itemData)) if (x?.name) allowedNames.add(normalizeName(x.name));
    const coreName = normalizeName(body.localRecommendation?.core);
    if (coreName && coreName !== 'Core') allowedNames.add(coreName);

    const schema = {
      type: 'object',
      properties: {
        buy_now: {
          type: 'object',
          properties: { item: { type: 'string' }, why: { type: 'string' } },
          required: ['item','why'],
          additionalProperties: false
        },
        if_ahead: {
          type: 'object',
          properties: { item: { type: 'string' }, why: { type: 'string' } },
          required: ['item','why'],
          additionalProperties: false
        },
        next_defense: {
          type: 'object',
          properties: { item: { type: 'string' }, why: { type: 'string' } },
          required: ['item','why'],
          additionalProperties: false
        },
        later: {
          type: 'object',
          properties: { item: { type: 'string' }, why: { type: 'string' } },
          required: ['item','why'],
          additionalProperties: false
        },
        path: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 7 },
        confidence: { type: 'string', enum: ['High','Good','Situational'] },
        key_reason: { type: 'string' }
      },
      required: ['buy_now','if_ahead','next_defense','later','path','confidence','key_reason'],
      additionalProperties: false
    };

    const matchup = {
      player: hero,
      lane_opponents: lane,
      full_enemy_roster: enemies,
      lane_state: laneState,
      game_stage: stage,
      patch: body.patch || null,
      hero_data: body.heroData || null,
      item_data: arr(body.itemData).slice(0, 18),
      high_rank_oracle_to_eternus: arr(body.highRankEvidence).slice(0, 18),
      local_candidates: arr(body.localCandidates).slice(0, 14),
      local_engine_recommendation: body.localRecommendation || null
    };

    phase = 'GPT-5.6 Sol request';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);

    let aiRes;
    try {
      aiRes = await fetch(AI_GATEWAY, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          reasoning: { effort: 'high' },
          max_output_tokens: 1400,
          store: false,
          instructions: SYSTEM,
          input: 'Analyze this exact Deadlock matchup and return the best counter-buy path.\n\n' + JSON.stringify(matchup),
          text: {
            format: {
              type: 'json_schema',
              name: 'deadlock_counter_buy',
              strict: true,
              schema
            }
          }
        })
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await aiRes.text();
    let aiData = null;
    try { aiData = JSON.parse(raw); } catch (_) {}

    if (!aiRes.ok) {
      const msg = aiData?.error?.message || aiData?.message || raw.slice(0, 700) || ('AI Gateway error ' + aiRes.status);
      return send(res, 502, {
        error: 'GPT-5.6 Sol request: ' + msg,
        code: 'AI_GATEWAY_ERROR',
        gateway_status: aiRes.status,
        phase
      });
    }

    phase = 'AI response parsing';
    const output = textFromResponse(aiData);
    if (!output) {
      return send(res, 502, {
        error: 'AI response parsing: no output text was returned.',
        code: 'AI_EMPTY_OUTPUT',
        phase
      });
    }

    let rec;
    try {
      rec = JSON.parse(output);
    } catch (_) {
      return send(res, 502, {
        error: 'AI response parsing: model returned invalid JSON.',
        code: 'AI_PARSE_ERROR',
        phase
      });
    }

    function validateChoice(value) {
      const name = normalizeName(value);
      if (isSpecial(name)) return name;
      const exact = [...allowedNames].find(x => x.toLowerCase() === name.toLowerCase());
      return exact || null;
    }

    for (const key of ['buy_now','if_ahead','next_defense','later']) {
      const valid = validateChoice(rec?.[key]?.item);
      if (!valid) {
        return send(res, 502, {
          error: 'AI response parsing: unknown item "' + normalizeName(rec?.[key]?.item) + '".',
          code: 'AI_UNKNOWN_ITEM',
          phase
        });
      }
      rec[key].item = valid;
    }

    rec.path = arr(rec.path)
      .map(x => validateChoice(x) || (String(x).toLowerCase().includes('core') ? 'Core' : null))
      .filter(Boolean);

    if (rec.path.length < 2) {
      rec.path = [rec.buy_now.item, 'Core', rec.later.item]
        .filter((x, i, a) => x && a.indexOf(x) === i);
    }

    const localBuy = normalizeName(body.localRecommendation?.buy?.name || body.localRecommendation?.buy_now?.item);
    rec.verdict = localBuy && localBuy.toLowerCase() === rec.buy_now.item.toLowerCase() ? 'verified' : 'updated';
    rec.model = MODEL;
    rec.high_rank_data = arr(body.highRankEvidence).some(x => (x?.lane_matches || 0) > 0 || (x?.roster_matches || 0) > 0);

    return send(res, 200, rec);
  } catch (err) {
    const timeout = err?.name === 'AbortError';
    return send(res, timeout ? 504 : 500, {
      error: phase + ': ' + (timeout ? 'request timed out before AI completed.' : (err?.message || 'Unknown server error')),
      code: timeout ? 'AI_TIMEOUT' : 'SERVER_ERROR',
      phase
    });
  }
};
