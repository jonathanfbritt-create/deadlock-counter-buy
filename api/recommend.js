const DEADLOCK_API = 'https://api.deadlock-api.com';
const AI_GATEWAY = 'https://ai-gateway.vercel.sh/v1/responses';
const MODEL = 'openai/gpt-5.6-sol';

let assetCache = { expires: 0, heroes: null, items: null, steam: null };

const COUNTER_ITEMS = [
  'Extra Stamina','Extra Regen','Debuff Reducer','Reactive Barrier','Enduring Speed',
  'Slowing Hex','Healbane','Cold Front','Bullet Resilience','Spirit Resilience',
  'Disarming Hex','Dispel Magic','Counterspell','Knockdown','Decay','Unstoppable','Cheat Death'
];

const SPECIAL = new Set(['Stay on core','Only if needed','Return to core scaling','Core']);

function asArray(v) { return Array.isArray(v) ? v : []; }
function safeString(v, max = 8000) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
async function fetchJSON(url, timeoutMs = 8000) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'deadlock-counter-buy/2.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
async function getAssets() {
  if (assetCache.heroes && assetCache.items && Date.now() < assetCache.expires) return assetCache;
  const [heroes, items, steam] = await Promise.all([
    fetchJSON(`${DEADLOCK_API}/v1/assets/heroes`, 10000),
    fetchJSON(`${DEADLOCK_API}/v1/assets/items`, 10000),
    fetchJSON(`${DEADLOCK_API}/v1/assets/steam-info`, 10000).catch(() => null),
  ]);
  assetCache = { heroes: asArray(heroes), items: asArray(items), steam, expires: Date.now() + 10 * 60 * 1000 };
  return assetCache;
}
function heroName(h) { return h?.name || h?.display_name || h?.class_name || ''; }
function itemName(i) { return i?.name || i?.display_name || i?.class_name || ''; }
function byName(arr, name, fn) {
  const target = String(name || '').toLowerCase();
  return arr.find(x => String(fn(x)).toLowerCase() === target) || null;
}
function compactHero(h) {
  if (!h) return null;
  const payload = {
    id: h.id,
    name: heroName(h),
    description: h.description,
    role: h.role,
    hero_type: h.hero_type,
    tags: h.tags,
    abilities: h.abilities,
  };
  return safeString(payload, 7000);
}
function compactItem(i) {
  if (!i) return null;
  const payload = {
    id: i.id,
    name: itemName(i),
    cost: i.cost,
    item_slot_type: i.item_slot_type,
    item_tier: i.item_tier,
    description: i.description,
    passive: i.passive,
    active: i.active,
    properties: i.properties,
  };
  return safeString(payload, 3500);
}
function popularCore(hero, itemById, stage) {
  const group = stage === 'lane' ? 'early_game' : stage === 'mid' ? 'mid_game' : 'late_game';
  const rows = asArray(hero?.popular_items?.[group]).slice().sort((a,b)=>(b.pick_pct||0)-(a.pick_pct||0));
  return rows.slice(0, 10).map(r => ({
    name: itemName(itemById.get(r.item_id)) || r.class_name || String(r.item_id),
    pick_pct: r.pick_pct,
    item_id: r.item_id,
  }));
}
function statMap(rows) { const m = new Map(); for (const r of asArray(rows)) m.set(r.item_id, r); return m; }
function summarizeStats(candidateItems, baseRows, laneRows, teamRows) {
  const B = statMap(baseRows), L = statMap(laneRows), T = statMap(teamRows);
  return candidateItems.map(i => {
    const b=B.get(i.id)||{}, l=L.get(i.id)||{}, t=T.get(i.id)||{};
    return {
      name:itemName(i), id:i.id,
      base_matches:b.matches||0, lane_matches:l.matches||0, roster_matches:t.matches||0,
      lane_avg_buy_min:l.avg_buy_time_s ? +(l.avg_buy_time_s/60).toFixed(1) : null,
      roster_avg_buy_min:t.avg_buy_time_s ? +(t.avg_buy_time_s/60).toFixed(1) : null,
      base_win_rate: typeof b.wins==='number' && b.matches ? +(b.wins/b.matches).toFixed(3) : null,
      lane_win_rate: typeof l.wins==='number' && l.matches ? +(l.wins/l.matches).toFixed(3) : null,
      roster_win_rate: typeof t.wins==='number' && t.matches ? +(t.wins/t.matches).toFixed(3) : null,
    };
  });
}
function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const out of asArray(data?.output)) {
    for (const part of asArray(out?.content)) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
      if (typeof part?.text === 'string') return part.text;
    }
  }
  return '';
}
function validateItem(name, itemNames) {
  if (SPECIAL.has(name)) return name;
  const exact = itemNames.get(String(name||'').toLowerCase());
  return exact || null;
}

const SYSTEM = `You are the Deadlock Counter-Buy Engine for live matches. Your job is to recommend the single most useful purchase now, not to recite a generic build.

Decision rules:
- Treat the LIVE DEADLOCK DATA in the prompt as authoritative over your memory when they conflict.
- In lane phase, weight the two lane opponents heavily, but reject a lane-only item if it becomes dead against the full roster unless the lane urgently requires it.
- In mid/late game, shift weight toward the full six-hero enemy roster and the player's role.
- Protect the player's core power spikes. A technically valid counter is a bad buy if it delays a much more important hero spike without solving an urgent threat.
- Prefer the minimum deviation from core that materially changes the matchup.
- If no counter is worth delaying core, explicitly choose "Stay on core".
- High-rank purchase statistics are evidence and a tie-breaker, not proof that an item is correct.
- Reactive Barrier only makes sense when the enemy has control that actually triggers it; generic slows are not enough.
- Debuff Reducer is for meaningful duration-based debuffs/control, not simply "they have CC".
- Slowing Hex should be prioritized only when it disables or meaningfully punishes important movement tools and the player's hero can capitalize on the catch.
- Healbane requires both meaningful enemy healing and reliable Spirit-damage application by the player's hero.
- Counterspell is for a specific high-impact parryable threat, not generic burst.
- Spirit Resilience and Bullet Resilience should respond to the damage profile that is actually likely to matter, not be default fallbacks.
- Unstoppable rises sharply for heroes whose key channel/engage can be interrupted by the enemy roster.
- Never over-counter. The player's hero still needs to become strong.
- Use exact current item names from the supplied data. Keep every why to one short sentence suitable for reading during a match.

Return only the requested JSON structure.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const hero = String(body.hero || '').trim();
    const lane = asArray(body.lane).map(String).map(s=>s.trim()).filter(Boolean).slice(0,2);
    const enemies = asArray(body.enemies).map(String).map(s=>s.trim()).filter(Boolean).slice(0,6);
    const stage = ['lane','mid','late'].includes(body.stage) ? body.stage : 'lane';
    const laneState = ['behind','even','ahead'].includes(body.laneState) ? body.laneState : 'even';
    if (!hero || lane.length !== 2 || enemies.length !== 6 || new Set(enemies).size !== 6) {
      return json(res, 400, { error: 'Invalid matchup payload' });
    }

    const { heroes, items, steam } = await getAssets();
    const me = byName(heroes, hero, heroName);
    const enemyHeroes = enemies.map(n=>byName(heroes,n,heroName)).filter(Boolean);
    if (!me || enemyHeroes.length !== 6) return json(res, 400, { error: 'One or more heroes were not found in live patch data' });

    const itemById = new Map(items.filter(i=>Number.isFinite(i?.id)).map(i=>[i.id,i]));
    const itemNames = new Map((items.map(i=>[itemName(i).toLowerCase(), itemName(i)]).filter(x=>x[0]));
    const localCandidates = asArray(body.localCandidates).map(x=>String(x?.name || x)).filter(Boolean);
    const core = popularCore(me, itemById, stage);
    const candidateNameSet = new Set([...COUNTER_ITEMS, ...localCandidates, ...core.map(x=>x.name)]);
    let candidateItems = items.filter(i => candidateNameSet.has(itemName(i))).slice(0, 28);

    const laneIds = lane.map(n=>byName(heroes,n,heroName)?.id).filter(Number.isFinite);
    const enemyIds = enemies.map(n=>byName(heroes,n,heroName)?.id).filter(Number.isFinite);
    let baseRows=[], laneRows=[], teamRows=[];
    if (Number.isFinite(me.id) && laneIds.length===2 && enemyIds.length===6) {
      const base = `hero_ids=${encodeURIComponent(me.id)}&min_average_badge=81&min_matches=20&corrupted_items=include`;
      const urls = [
        `${DEADLOCK_API}/v1/analytics/item-stats?${base}`,
        `${DEADLOCK_API}/v1/analytics/item-stats?${base}&enemy_hero_ids=${laneIds.join(',')}&enemy_hero_ids_all_match=true&same_lane_filter=true`,
        `${DEADLOCK_API}/v1/analytics/item-stats?${base}&enemy_hero_ids=${enemyIds.join(',')}`,
      ];
      [baseRows,laneRows,teamRows] = await Promise.all(urls.map(u=>fetchJSON(u,9000).catch(()=>[])));
    }

    const highRank = summarizeStats(candidateItems, baseRows, laneRows, teamRows);
    const matchup = {
      patch: steam ? { version: steam.version, version_date: steam.version_date, build_id: steam.build_id } : null,
      player: { hero, stage, lane_state: laneState, live_hero_data: compactHero(me), popular_core: core },
      lane_opponents: lane,
      full_enemy_roster: enemies,
      enemy_live_data: enemyHeroes.map(h=>compactHero(h)),
      candidate_items_live_data: candidateItems.map(i=>compactItem(i)),
      high_rank_oracle_to_eternus_30d: highRank,
      local_engine_advisory: body.localRecommendation || null,
    };

    const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!token) return json(res, 503, { error: 'AI Gateway authentication is not configured on this Vercel project', code: 'AI_AUTH_MISSING' });

    const schema = {
      type:'object',
      properties:{
        buy_now:{type:'object',properties:{item:{type:'string'},why:{type:'string'}},required:['item','why'],additionalProperties:false},
        if_ahead:{type:'object',properties:{item:{type:'string'},why:{type:'string'}},required:['item','why'],additionalProperties:false},
        next_defense:{type:'object',properties:{item:{type:'string'},why:{type:'string'}},required:['item','why'],additionalProperties:false},
        later:{type:'object',properties:{item:{type:'string'},why:{type:'string'}},required:['item','why'],additionalProperties:false},
        path:{type:'array',items:{type:'string'},minItems:2,maxItems:7},
        confidence:{type:'string',enum:['High','Good','Situational']},
        key_reason:{type:'string'},
      },
      required:['buy_now','if_ahead','next_defense','later','path','confidence','key_reason'],
      additionalProperties:false,
    };

    const aiRes = await fetch(AI_GATEWAY, {
      method:'POST',
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model: MODEL,
        reasoning:{effort:'high'},
        max_output_tokens: 1200,
        store:false,
        instructions:SYSTEM,
        input:`Analyze this exact Deadlock matchup and return the best counter-buy path.\n\n${JSON.stringify(matchup)}`,
        text:{format:{type:'json_schema',name:'deadlock_counter_buy',strict:true,schema}},
      }),
    });

    const aiData = await aiRes.json().catch(()=>null);
    if (!aiRes.ok) {
      return json(res, 502, { error: aiData?.error?.message || `AI Gateway error ${aiRes.status}`, code:'AI_GATEWAY_ERROR' });
    }
    const output = extractOutputText(aiData);
    let rec;
    try { rec = JSON.parse(output); } catch (_) { return json(res, 502, { error:'AI returned invalid structured output', code:'AI_PARSE_ERROR' }); }

    for (const key of ['buy_now','if_ahead','next_defense','later']) {
      const valid = validateItem(rec?.[key]?.item, itemNames);
      if (!valid) return json(res, 502, { error:`AI returned unknown item: ${rec?.[key]?.item}`, code:'AI_UNKNOWN_ITEM' });
      rec[key].item = valid;
    }
    rec.path = asArray(rec.path).map(x => validateItem(x,itemNames) || (String(x).toLowerCase().includes('core') ? 'Core' : null)).filter(Boolean);
    if (rec.path.length < 2) rec.path = [rec.buy_now.item, 'Core', rec.later.item].filter((x,i,a)=>x&&a.indexOf(x)===i);

    const localBuy = body.localRecommendation?.buy?.name || body.localRecommendation?.buy_now?.item || null;
    rec.verdict = localBuy && localBuy.toLowerCase() === rec.buy_now.item.toLowerCase() ? 'verified' : 'updated';
    rec.model = MODEL;
    rec.patch = matchup.patch;
    rec.high_rank_data = Boolean(laneRows?.length || teamRows?.length);

    return json(res, 200, rec);
  } catch (err) {
    return json(res, 500, { error: err?.message || 'Unknown server error', code:'SERVER_ERROR' });
  }
};
