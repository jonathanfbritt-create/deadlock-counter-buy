import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const DEADLOCK_API = "https://api.deadlock-api.com";
const WIDGET_URI = "ui://deadlock-counter-buy/team-plan-v3.html";
const widgetHtml = readFileSync(join(process.cwd(), "public", "deadlock-widget.html"), "utf8");

const COUNTER_ITEM_NAMES = [
  "Extra Stamina","Extra Regen","Rebuttal","Rusted Barrel",
  "Debuff Reducer","Reactive Barrier","Enduring Speed","Slowing Hex","Healbane","Cold Front","Suppressor",
  "Bullet Resilience","Spirit Resilience","Metal Skin","Disarming Hex","Dispel Magic","Counterspell","Knockdown","Decay","Silence Wave","Toxic Bullets",
  "Unstoppable","Cheat Death","Plated Armor"
];

let cache = { expires: 0, heroes: [], items: [], steam: null };

function arr(v){ return Array.isArray(v) ? v : []; }
function clean(v){ return String(v ?? "").trim(); }
function clip(v, max=2200){
  if (v == null) return null;
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); }
  catch { s = String(v); }
  return s.length > max ? s.slice(0,max) + "…" : s;
}
async function fetchJSON(url, timeout=9000){
  const c = new AbortController();
  const id = setTimeout(()=>c.abort(), timeout);
  try {
    const r = await fetch(url, { signal:c.signal, headers:{ "User-Agent":"deadlock-counter-buy-plugin/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}
async function getAssets(){
  if (cache.heroes.length && cache.items.length && Date.now() < cache.expires) return cache;
  const [heroes, items, steam] = await Promise.all([
    fetchJSON(`${DEADLOCK_API}/v1/assets/heroes`),
    fetchJSON(`${DEADLOCK_API}/v1/assets/items`),
    fetchJSON(`${DEADLOCK_API}/v1/assets/steam-info`).catch(()=>null),
  ]);
  cache = {
    heroes: arr(heroes).filter(h => h?.player_selectable !== false && !h?.disabled && (!h?.development_state || h.development_state === "release")),
    items: arr(items),
    steam,
    expires: Date.now() + 10*60*1000,
  };
  return cache;
}
function heroName(h){ return h?.name || h?.display_name || h?.class_name || ""; }
function itemName(i){ return i?.name || i?.display_name || i?.class_name || ""; }
function findByName(list, name, fn){
  const target = clean(name).toLowerCase();
  return list.find(x => clean(fn(x)).toLowerCase() === target) || null;
}
function heroCard(h){
  const images = h?.images || {};
  return {
    id: h?.id ?? null,
    name: heroName(h),
    image: images.icon_hero_card_webp || images.icon_hero_card || images.icon_image_small_webp || images.icon_image_small || null,
  };
}
function heroSnapshot(h){
  return {
    id: h?.id ?? null,
    name: heroName(h),
    hero_type: h?.hero_type ?? null,
    tags: h?.tags ?? null,
    role: h?.description?.role ?? h?.role ?? null,
    description: clip(h?.description, 2600),
    abilities: clip(h?.abilities, 4200),
  };
}
function itemSnapshot(i){
  return {
    id: i?.id ?? null,
    name: itemName(i),
    cost: i?.cost ?? null,
    tier: i?.item_tier ?? i?.tier ?? null,
    slot_type: i?.item_slot_type ?? null,
    description: clip(i?.description, 1500),
    passive: clip(i?.passive, 1200),
    active: clip(i?.active, 1200),
    properties: clip(i?.properties, 2000),
  };
}
function statMap(rows){
  const m = new Map();
  for (const r of arr(rows)) if (Number.isFinite(r?.item_id)) m.set(r.item_id, r);
  return m;
}
function popularCore(hero, itemById, stage){
  const group = stage === "lane" ? "early_game" : stage === "mid" ? "mid_game" : "late_game";
  return arr(hero?.popular_items?.[group])
    .slice()
    .sort((a,b)=>(b?.pick_pct||0)-(a?.pick_pct||0))
    .slice(0,10)
    .map(r => ({
      item_id:r?.item_id ?? null,
      name:itemName(itemById.get(r?.item_id)) || r?.class_name || String(r?.item_id ?? ""),
      pick_pct:r?.pick_pct ?? null,
    }))
    .filter(x=>x.name);
}
function evidenceFor(items, baseRows, laneRows, rosterRows){
  const B=statMap(baseRows), L=statMap(laneRows), R=statMap(rosterRows);
  return items.map(i=>{
    const b=B.get(i.id)||{}, l=L.get(i.id)||{}, r=R.get(i.id)||{};
    return {
      item_id:i.id,
      name:itemName(i),
      base_matches:b.matches||0,
      lane_matches:l.matches||0,
      roster_matches:r.matches||0,
      base_win_rate:b.matches && typeof b.wins==="number" ? +(b.wins/b.matches).toFixed(3) : null,
      lane_win_rate:l.matches && typeof l.wins==="number" ? +(l.wins/l.matches).toFixed(3) : null,
      roster_win_rate:r.matches && typeof r.wins==="number" ? +(r.wins/r.matches).toFixed(3) : null,
      lane_avg_buy_min:l.avg_buy_time_s ? +(l.avg_buy_time_s/60).toFixed(1) : null,
      roster_avg_buy_min:r.avg_buy_time_s ? +(r.avg_buy_time_s/60).toFixed(1) : null,
    };
  });
}


const ROLE_GUIDANCE = {
  m1:"Preserve your own firing window. Prefer self-protection or counters delivered through bullets; against another gun carry, Metal Skin can be better than spending your window on Disarming Hex.",
  spirit:"Prefer counters your normal Spirit damage can apply or support, such as Suppressor and Healbane, while protecting your casting uptime when control is the real problem.",
  utility:"You can spend active slots to remove the enemy's win condition for the whole team. Disarming Hex, Knockdown, Decay, Dispel Magic and Silence Wave gain value here.",
  frontline:"Prefer items that let you keep functioning through the engage: Reactive Barrier, Debuff Reducer, resistances, Metal Skin, and later Unstoppable.",
  hybrid:"Choose the counter that solves the largest real team problem without forcing you away from your current damage plan."
};

const EXPERT_FRAMEWORK_PRIORS = {
  "Rat King":{
    problem:"Gun-forward brawler with repeated slows, Bullet Resist shred from Rat Swarm, and a max-health barrier that can punish sustained bullet trading.",
    by_role:{
      m1:["Metal Skin","Bullet Resilience"],
      spirit:["Suppressor","Spirit Resilience"],
      utility:["Rusted Barrel","Disarming Hex"],
      frontline:["Bullet Resilience","Debuff Reducer"]
    },
    overlap:"Anti-gun counters rise sharply if the roster also contains other M1 threats."
  },
  "Baba":{
    problem:"Spirit/control hero with long-duration Spirit theft, a 3s Silence option, heavy slows, and a long Feed The Birds channel ending in a hex.",
    by_role:{
      m1:["Debuff Reducer","Spirit Resilience"],
      spirit:["Spirit Resilience","Knockdown"],
      utility:["Knockdown","Debuff Reducer"],
      frontline:["Debuff Reducer","Reactive Barrier"]
    },
    overlap:"Knockdown gains extra team value when other enemies also rely on long channels or aerial windows."
  },
  "Solomon":{
    problem:"Spirit-heavy hybrid with repeatable slows, barriers, invulnerable repositioning, immobilize from Rook Battery, and stun pressure from the Queen.",
    by_role:{
      m1:["Spirit Resilience","Reactive Barrier"],
      spirit:["Spirit Resilience","Reactive Barrier"],
      utility:["Reactive Barrier","Silence Wave"],
      frontline:["Reactive Barrier","Debuff Reducer"]
    },
    overlap:"Reactive Barrier becomes more attractive when the rest of the roster also supplies real trigger statuses."
  },
  "Deadman Danny":{
    problem:"Gun/Spirit hybrid with prolonged aerial play, Bullet Resist shred, strong burst windows, and a grab ultimate.",
    by_role:{
      m1:["Metal Skin","Knockdown"],
      spirit:["Knockdown","Suppressor"],
      utility:["Knockdown","Disarming Hex"],
      frontline:["Metal Skin","Bullet Resilience"]
    },
    overlap:"Knockdown is especially efficient when Danny is joined by other airborne or channel-dependent enemies."
  },
  "Violet":{
    problem:"Spirit caster/controller with major slows, fire-rate pressure, a channeled Still Life stun, and an area Silence.",
    by_role:{
      m1:["Spirit Resilience","Debuff Reducer"],
      spirit:["Spirit Resilience","Knockdown"],
      utility:["Knockdown","Debuff Reducer"],
      frontline:["Reactive Barrier","Debuff Reducer"]
    },
    overlap:"Spirit defense or channel interruption can cover several caster-heavy enemies at once."
  },
  "Nurse Harrow":{
    problem:"Gun/healer support with repeatable ally healing, buff-duration destruction, deferred damage, and a long Lurking Terrors channel.",
    by_role:{
      m1:["Toxic Bullets","Metal Skin"],
      spirit:["Healbane","Knockdown"],
      utility:["Decay","Knockdown"],
      frontline:["Debuff Reducer","Bullet Resilience"]
    },
    overlap:"Antiheal should be chosen by buyer role; Knockdown gains value if other enemies also expose long channels or aerial windows."
  }
};

function slotKind(i){
  const s=clean(i?.item_slot_type || i?.slot_type).toLowerCase();
  if(s.includes("weapon")) return "weapon";
  if(s.includes("spirit")) return "spirit";
  if(s.includes("vital")) return "vitality";
  return s || "other";
}
function topPopular(hero,itemById,group,limit=8){
  return arr(hero?.popular_items?.[group]).slice().sort((a,b)=>(b?.pick_pct||0)-(a?.pick_pct||0)).slice(0,limit).map(r=>{
    const i=itemById.get(r?.item_id);
    return {name:itemName(i)||r?.class_name||String(r?.item_id??""),pick_pct:r?.pick_pct??0,slot:slotKind(i)};
  }).filter(x=>x.name);
}
function buildSignal(hero,itemById){
  const early=topPopular(hero,itemById,"early_game",8);
  const mid=topPopular(hero,itemById,"mid_game",8);
  const late=topPopular(hero,itemById,"late_game",6);
  const totals={weapon:0,spirit:0,vitality:0,other:0};
  for(const x of [...early,...mid]){
    const w=Math.max(1,Number(x.pick_pct)||0);
    totals[x.slot in totals?x.slot:"other"]+=w;
  }
  const total=Object.values(totals).reduce((a,b)=>a+b,0)||1;
  const share=Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,+((v/total)).toFixed(2)]));
  const type=clean(hero?.hero_type).toLowerCase();
  const tags=arr(hero?.tags).join(" ").toLowerCase();
  const roleText=clean(hero?.description?.role || hero?.role).toLowerCase();
  let inferred="hybrid";
  if(share.weapon>=0.46 && share.weapon>share.spirit+0.08) inferred="m1";
  else if(share.spirit>=0.46 && share.spirit>share.weapon+0.08) inferred="spirit";
  else if(/support|healer/.test(roleText+" "+tags)) inferred="utility";
  else if(/brawler|tank/.test(type+" "+roleText)) inferred="frontline";
  else if(/marksman/.test(type)) inferred="m1";
  else if(/mystic/.test(type)) inferred="spirit";
  return {inferred_role:inferred,slot_share:share,top_items:{early_game:early,mid_game:mid,late_game:late}};
}
function propNum(a,key){
  const raw=a?.properties?.[key]?.value ?? a?.properties?.[key];
  if(raw==null) return null;
  const n=parseFloat(String(raw).replace(/[^0-9.+-]/g,""));
  return Number.isFinite(n)?n:null;
}
function mechanicSummary(hero,build){
  const abilities=arr(hero?.abilities);
  const rows=abilities.map(a=>{
    const desc=clean(a?.description?.desc || a?.description).toLowerCase();
    const name=clean(a?.name);
    const statusDuration=Math.max(0,
      propNum(a,"DebuffDuration")||0,propNum(a,"SilenceDuration")||0,propNum(a,"StunDuration")||0,
      propNum(a,"ImmobilizeDuration")||0,propNum(a,"SlowDuration")||0,propNum(a,"HexDuration")||0,
      propNum(a,"TetherDuration")||0,propNum(a,"RootDuration")||0
    );
    const channel=propNum(a,"AbilityChannelTime")||0;
    return {name,desc,statusDuration,channel};
  });
  const names=pred=>rows.filter(pred).map(x=>x.name);
  const gunAbilities=names(x=>/weapon damage|bullet damage|bullets|weapon\b|fire rate|shots?\b/.test(x.desc));
  const spiritAbilities=names(x=>/spirit damage/.test(x.desc));
  const gunScore=Math.min(3,Math.round((build?.slot_share?.weapon||0)*3 + Math.min(1.5,gunAbilities.length*.45)));
  const spiritScore=Math.min(3,Math.round((build?.slot_share?.spirit||0)*3 + Math.min(1.5,spiritAbilities.length*.45)));
  return {
    gun_score:gunScore,
    spirit_score:spiritScore,
    trigger_control:names(x=>/stun|immobiliz|sleep|silence|chained/.test(x.desc)),
    meaningful_debuffs:rows.filter(x=>x.statusDuration>=1.5 && /slow|silence|hex|curse|bleed|burn|mark|immobiliz|stun|sleep|disarm|fear/.test(x.desc)).map(x=>({ability:x.name,duration_s:+x.statusDuration.toFixed(2)})),
    slows:names(x=>/slow/.test(x.desc)),
    silences:names(x=>/silence/.test(x.desc)),
    disarms:names(x=>/disarm/.test(x.desc)),
    healing:names(x=>/heal|lifesteal|regeneration|restore[^.]{0,20}health/.test(x.desc)),
    movement:names(x=>/dash|teleport|swap positions|burrow|fly|glide|leap|jump to|launches you high|move[^.]{0,35}invulnerable/.test(x.desc)),
    airborne:names(x=>/airborne|fly|glide|high in the air|launches you high/.test(x.desc)),
    long_channels:rows.filter(x=>x.channel>=1.5 && x.channel<=20).map(x=>({ability:x.name,channel_s:+x.channel.toFixed(2)})),
    melee:names(x=>/\bmelee\b/.test(x.desc)),
    bullet_shred:names(x=>/bullet resist/.test(x.desc)&&/reduc|shred|lower|eat/.test(x.desc)),
    spirit_shred:names(x=>/spirit resist/.test(x.desc)&&/reduc|shred|lower/.test(x.desc))
  };
}
function roleFit(item,role){
  const high={
    m1:new Set(["Metal Skin","Toxic Bullets","Bullet Resilience","Plated Armor","Debuff Reducer"]),
    spirit:new Set(["Suppressor","Healbane","Spirit Resilience","Slowing Hex","Knockdown"]),
    utility:new Set(["Rusted Barrel","Disarming Hex","Knockdown","Decay","Dispel Magic","Silence Wave","Reactive Barrier"]),
    frontline:new Set(["Reactive Barrier","Debuff Reducer","Metal Skin","Bullet Resilience","Spirit Resilience","Unstoppable"]),
    hybrid:new Set(["Debuff Reducer","Reactive Barrier","Knockdown","Metal Skin","Spirit Resilience","Bullet Resilience"])
  };
  const medium={
    m1:new Set(["Rusted Barrel","Disarming Hex","Spirit Resilience","Knockdown","Rebuttal"]),
    spirit:new Set(["Metal Skin","Debuff Reducer","Reactive Barrier","Decay"]),
    utility:new Set(["Metal Skin","Spirit Resilience","Bullet Resilience","Healbane","Suppressor"]),
    frontline:new Set(["Rusted Barrel","Disarming Hex","Knockdown","Enduring Speed"]),
    hybrid:new Set(["Healbane","Suppressor","Disarming Hex","Enduring Speed","Slowing Hex"])
  };
  if(high[role]?.has(item)) return "high";
  if(medium[role]?.has(item)) return "medium";
  return "neutral";
}

const PLATED_INTERACTIONS = {
  "Baba":"Threadsap","Billy":"Blasted","Celeste":"Light Eater",
  "Graves":"Essence Theft","Haze":"Fixation","Holliday":"Crackshot",
  "Infernus":"Afterburn","Mina":"Love Bites","Seven":"Power Surge",
  "Venator":"Ira Domini","Victor":"Shocking Reanimation",
  "Vindicta":"Flight","Vyper":"Lethal Venom","Wraith":"Card Trick / Full Auto"
};
const PLATED_EXCEPTIONS=new Set(["Mirage","Paradox","Silver","Sinclair","Grey Talon"]);
const ITEM_FAMILIES={
  "Metal Skin":"bullet-defense","Bullet Resilience":"bullet-defense",
  "Plated Armor":"on-hit-defense",
  "Disarming Hex":"gun-denial","Rusted Barrel":"gun-denial","Suppressor":"gun-denial",
  "Healbane":"antiheal","Toxic Bullets":"antiheal","Decay":"antiheal",
  "Debuff Reducer":"status-defense","Dispel Magic":"status-defense",
  "Reactive Barrier":"status-defense","Unstoppable":"status-defense",
  "Knockdown":"interrupt","Silence Wave":"interrupt"
};
const HEX_MOVEMENT={
 "Infernus":["Flame Dash"],"Mo & Krill":["Burrow"],"Mina":["Sanguine Retreat"],
 "Sinclair":["Spectral Assistant"],"Drifter":["Stalker's Mark"],
 "Pocket":["Flying Cloak"],"Haze":["Smoke Bomb"]
};
function interaction(item,h,b,m,role){
 const hero=heroName(h),hasBuild=!!b.top_items?.early_game?.length;
 const gun=(b.slot_share?.weapon||0)>=.34||(m.gun_score>=1&&!hasBuild)||m.gun_score>=2;
 const spirit=(b.slot_share?.spirit||0)>=.34||(m.spirit_score>=1&&!hasBuild)||m.spirit_score>=2;
 const cc=m.trigger_control||[],heal=m.healing||[],status=m.meaningful_debuffs||[];
 const make=(strength,ability,why,evidence="mechanics")=>({hero,strength,ability,why,evidence});
 switch(item){
 case "Plated Armor":
  if(PLATED_INTERACTIONS[hero])return make(3.6,PLATED_INTERACTIONS[hero],"chance to prevent on-hit buildup/effect","verified");
  return gun&&!PLATED_EXCEPTIONS.has(hero)?make(.9,"Weapon fire","chance-based bullet deflection","profile"):null;
 case "Metal Skin":return gun?make(role==="m1"?2.6:2.1,"Weapon damage","temporary bullet immunity","profile"):null;
 case "Bullet Resilience":return gun?make(1.8,"Weapon damage","persistent bullet resistance","profile"):null;
 case "Disarming Hex":case "Rusted Barrel":
  return gun?make(role==="utility"?2.5:1.85,"Weapon damage","targeted gun denial","profile"):null;
 case "Suppressor":return gun?make(role==="spirit"?2.5:1.6,"Weapon damage","spirit hits lower fire rate","profile"):null;
 case "Spirit Resilience":return spirit?make(1.9,"Spirit damage","broad spirit protection","profile"):null;
 case "Healbane":return heal.length&&role!=="m1"?make(role==="spirit"?2.6:1.7,heal[0],"spirit-applied antiheal"):null;
 case "Toxic Bullets":return heal.length?make(role==="m1"?2.6:1.3,heal[0],"bullet-applied antiheal"):null;
 case "Decay":return heal.length?make(role==="utility"?2.6:1.8,heal[0],"targeted antiheal"):null;
 case "Reactive Barrier":return cc.length?make(2.1,cc[0],"real control trigger for barrier"):null;
 case "Debuff Reducer":{
  const effects=status.filter(x=>x.duration_s>=1.8).sort((x,y)=>y.duration_s-x.duration_s);
  return effects.length?make(Math.min(2.55,1.15+effects[0].duration_s*.26),effects[0].ability,"reduces a meaningful-duration debuff"):null;
 }
 case "Dispel Magic":{
  const effect=status.find(x=>x.duration_s>=2.5);
  return effect?make(1.6,effect.ability,"only if this specific lingering debuff can be dispelled","conditional"):null;
 }
 case "Knockdown":
  return m.airborne.length?make(3,m.airborne[0],"stun punishes airborne state"):
   m.long_channels.length?make(2.75,m.long_channels[0].ability,"interrupt long vulnerable channel"):null;
 case "Silence Wave":return m.long_channels.length?make(1,m.long_channels[0].ability,"prevents cast but does not interrupt ongoing channel","conditional"):null;
 case "Slowing Hex":{
  const ab=(HEX_MOVEMENT[hero]||[]).find(x=>m.movement.includes(x));
  return ab?make(2.2,ab,"movement shutdown must be confirmed on patch","conditional"):null;
 }
 case "Enduring Speed":return m.slows.length?make(1.65,m.slows[0],"broad slow protection"):null;
 case "Unstoppable":return cc.length?make(role==="frontline"?2.25:1.6,cc[0],"proactive CC immunity"):null;
 case "Cold Front":return m.movement.length?make(1.2,m.movement[0],"close-range peel"):null;
 default:return null;
 }
}
function counterCoverage(candidateItems,role,enemyHeroes,buildSignals,mechanics,laneNames){
 return candidateItems.map(i=>{
  const item=itemName(i),interactions=enemyHeroes.map((h,j)=>interaction(item,h,buildSignals[j],mechanics[j],role)).filter(Boolean);
  const strong=interactions.filter(x=>x.strength>=1.6),count=new Set(strong.map(x=>x.hero)).size;
  const fit=roleFit(item,role),cost=Number(i.cost)||0,verified=interactions.filter(x=>x.evidence==="verified").length;
  const breadth=count>=4?5.2:count>=3?3.5:count>=2?1:0;
  const score=strong.reduce((a,x)=>a+x.strength,0)+breadth+verified*1.5+
   (fit==="high"?1.5:fit==="medium"?.7:0)-Math.max(0,cost-1600)/1600*.28;
  return {
   item,cost,role_fit:fit,family:ITEM_FAMILIES[item]||item,
   interactions:interactions.sort((x,y)=>y.strength-x.strength),
   covers:[...new Set(interactions.map(x=>x.hero))],
   coverage_count:new Set(interactions.map(x=>x.hero)).size,
   strong_coverage_count:count,
   lane_coverage_count:strong.filter(x=>laneNames.includes(x.hero)).length,
   overlap_score:+score.toFixed(2),team_score:+score.toFixed(2),
   primary_reason:strong.slice(0,4).map(x=>x.hero+" ("+x.ability+")").join(", "),
   verified_interaction_count:verified
  };
 }).filter(x=>x.strong_coverage_count>0).sort((x,y)=>y.team_score-x.team_score);
}
function fullGamePlan(ranked,core){
 const remaining=ranked.slice(),chosen=[],maxByHero=new Map();
 for(let k=0;k<3;k++){
  let best=null,bestScore=-Infinity;
  for(const row of remaining){
   const incremental=row.interactions.filter(x=>x.strength>=1.6).reduce(
    (acc,x)=>acc+Math.max(0,x.strength-(maxByHero.get(x.hero)||0)),0);
   const sameFamily=chosen.some(x=>x.family===row.family)?2.5:0;
   const score=incremental+(row.strong_coverage_count>=3?2.2:0)+
     (row.role_fit==="high"?1:0)-sameFamily-Math.max(0,row.cost-3200)/3200*.35;
   if(score>bestScore){best=row;bestScore=score;}
  }
  if(!best||bestScore<2.8)break;
  chosen.push({...best,marginal_score:+bestScore.toFixed(2)});
  for(const x of best.interactions)if(x.strength>=1.6)
   maxByHero.set(x.hero,Math.max(maxByHero.get(x.hero)||0,x.strength));
  remaining.splice(remaining.indexOf(best),1);
 }
 return {
  strategy:"Full team plan: six enemies weighted equally, no per-stage item gate",
  primary:chosen[0]||null,supporting:chosen[1]||null,third:chosen[2]||null,
  optional_substitution:remaining.find(x=>x.strong_coverage_count>=2)||null,
  full_game_path:[core[0]?.name||"Core spike",...(chosen[0]?[chosen[0].item]:[]),"Next core spike",...(chosen[1]?[chosen[1].item]:[])],
  guidance:"This is an entire-game plan, not a mandate to buy every item. Preserve core items and skip redundant counters."
 };
}

const METHOD = [
 "Return ONE full-game counter plan for all six opponents, not different item plans by game phase.",
 "Prefer counters with three or more specific meaningful enemy interactions when possible.",
 "Use confirmed ability and item mechanics, role fit, probable enemy builds, and current high-rank purchases.",
 "Stage and lane state are legacy context and must NOT gate, eliminate or determine counter priority.",
 "Plated Armor can prevent Haze Fixation, Infernus Afterburn and Mina Love Bites on eligible bullet hits; chance-based not guaranteed.",
 "Do not claim Plated blocks Mirage Djinn's Mark, Paradox Kinetic Carbine, Silver Slam Fire bonus damage or other unverified interactions.",
 "Role fit: a gun carry might prefer Metal Skin over Disarming Hex; a utility hero can prefer team-facing gun denial.",
 "Prefer one counter solving several enemies over several narrow purchases; penalize overlapping counters with low additional utility.",
 "Do not force an expensive item into an early purchase, but allow it to be the highest priority objective for the whole match.",
 "Require actual triggers for Reactive Barrier, meaningful status time saved by Debuff Reducer, reliable proc application for antiheal, and vulnerable channels for Knockdown.",
 "Do not over-counter: preserve the player's damage and utility core. Two counters that together cover most of the enemy roster often beat four narrow counters.",
 "Expert role/team framework is derived from AShires video; exact per-item video citations have not been transcribed. Analytics are observational only.",
 "Report best team counter, second priority, conditional alternative, and a practical full-game path."
].join("\n");

function createServer(){
  const server = new McpServer({
    name:"Deadlock Counter-Buy",
    version:"3.0.0",
  });

  registerAppResource(
    server,
    "deadlock-counter-buy-picker",
    WIDGET_URI,
    {},
    async()=>({
      contents:[{
        uri:WIDGET_URI,
        mimeType:RESOURCE_MIME_TYPE,
        text:widgetHtml,
        _meta:{
          ui:{
            prefersBorder:true,
            csp:{
              connectDomains:[],
              resourceDomains:["https://assets.deadlock-api.com","https://api.deadlock-api.com"],
            },
          },
        },
      }],
    })
  );

  registerAppTool(
    server,
    "open_counter_buy",
    {
      title:"Open Deadlock Counter-Buy",
      description:"Open the interactive Deadlock hero picker. Use this when the user wants to choose their hero, two lane opponents, and the other four enemy heroes before asking ChatGPT for a counter-buy.",
      inputSchema:{},
      outputSchema:{
        heroes:z.array(z.object({
          id:z.number().nullable(),
          name:z.string(),
          image:z.string().nullable(),
        })),
        patch:z.object({
          version:z.any().nullable(),
          version_date:z.any().nullable(),
          build_id:z.any().nullable(),
        }).nullable(),
      },
      _meta:{ ui:{ resourceUri:WIDGET_URI } },
    },
    async()=>{
      const {heroes,steam}=await getAssets();
      return {
        content:[{type:"text",text:"Interactive Deadlock Counter-Buy picker opened. After the user presses GO, use get_counter_buy_context for the submitted matchup before giving any item recommendation."}],
        structuredContent:{
          heroes:heroes.map(heroCard).sort((a,b)=>a.name.localeCompare(b.name)),
          patch:steam ? {version:steam.version??null,version_date:steam.version_date??null,build_id:steam.build_id??null} : null,
        },
      };
    }
  );

  registerAppTool(
    server,
    "get_counter_buy_context",
    {
      title:"Get live Deadlock counter-buy context",
      description:"Fetch current Deadlock patch data, hero/item mechanics, the player's popular core items, and recent high-rank item purchase evidence for one exact matchup. Call this before making any counter-buy recommendation. The model should reason over this evidence; this tool does not choose the final answer.",
      inputSchema:{
        player_hero:z.string().min(1).optional(),
        hero:z.string().min(1).optional(),
        lane_opponents:z.array(z.string().min(1)).length(2),
        other_enemies:z.array(z.string().min(1)).length(4),
        lane_state:z.enum(["behind","even","ahead"]).optional(),
        game_stage:z.enum(["lane","mid","late"]).optional(),
        stage:z.enum(["lane","mid","late"]).optional(),
        player_role:z.enum(["auto","m1","spirit","utility","frontline","hybrid"]).optional(),
      },
    },
    async(args)=>{
      const hero=clean(args.player_hero ?? args.hero);
      const lane=arr(args.lane_opponents).map(clean);
      const other=arr(args.other_enemies).map(clean);
      const enemies=[...lane,...other];
      const stage=args.game_stage ?? args.stage ?? "lane";
      const laneState=args.lane_state ?? "even";
      if(!hero) return {isError:true,content:[{type:"text",text:"A player hero is required."}]};
      if(new Set(enemies.map(x=>x.toLowerCase())).size!==6 || enemies.some(x=>x.toLowerCase()===hero.toLowerCase())){
        return {isError:true,content:[{type:"text",text:"The enemy roster must contain six unique heroes and cannot include the player's hero."}]};
      }

      const {heroes,items,steam}=await getAssets();
      const me=findByName(heroes,hero,heroName);
      const enemyHeroes=enemies.map(n=>findByName(heroes,n,heroName));
      if(!me || enemyHeroes.some(x=>!x)){
        const missing=[!me?hero:null,...enemyHeroes.map((h,i)=>h?null:enemies[i])].filter(Boolean);
        return {isError:true,content:[{type:"text",text:`Could not find current live hero data for: ${missing.join(", ")}`}]};
      }

      const itemById=new Map(items.filter(i=>Number.isFinite(i?.id)).map(i=>[i.id,i]));
      const core=popularCore(me,itemById,stage);
      const playerBuild=buildSignal(me,itemById);
      const resolvedRole=(args.player_role && args.player_role!=="auto") ? args.player_role : playerBuild.inferred_role;
      const enemyBuildSignals=enemyHeroes.map(h=>buildSignal(h,itemById));
      const enemyMechanics=enemyHeroes.map((h,i)=>mechanicSummary(h,enemyBuildSignals[i]));
      const laneIds=lane.map(n=>findByName(heroes,n,heroName)?.id).filter(Number.isFinite);
      const enemyIds=enemyHeroes.map(h=>h?.id).filter(Number.isFinite);

      let baseRows=[], laneRows=[], rosterRows=[];
      if(Number.isFinite(me.id) && laneIds.length===2 && enemyIds.length===6){
        const base=`hero_ids=${encodeURIComponent(me.id)}&min_average_badge=81&min_matches=20&corrupted_items=include`;
        const urls=[
          `${DEADLOCK_API}/v1/analytics/item-stats?${base}`,
          `${DEADLOCK_API}/v1/analytics/item-stats?${base}&enemy_hero_ids=${laneIds.join(",")}&enemy_hero_ids_all_match=true&same_lane_filter=true`,
          `${DEADLOCK_API}/v1/analytics/item-stats?${base}&enemy_hero_ids=${enemyIds.join(",")}`,
        ];
        [baseRows,laneRows,rosterRows]=await Promise.all(urls.map(u=>fetchJSON(u,10000).catch(()=>[])));
      }

      const baseSorted=arr(baseRows).slice().sort((a,b)=>(b?.matches||0)-(a?.matches||0));
      const candidateNames=new Set([...COUNTER_ITEM_NAMES,...core.map(x=>x.name)]);
      for(const row of baseSorted.slice(0,16)){
        const i=itemById.get(row?.item_id);
        if(i) candidateNames.add(itemName(i));
      }
      const candidateItems=items.filter(i=>candidateNames.has(itemName(i))).slice(0,40);
      const coverage=counterCoverage(candidateItems,resolvedRole,enemyHeroes,enemyBuildSignals,enemyMechanics,lane);
      const fullPlan=fullGamePlan(coverage,core);

      const result={
        source:"Deadlock API current assets + analytics",
        patch:steam ? {version:steam.version??null,version_date:steam.version_date??null,build_id:steam.build_id??null} : null,
        matchup:{
          player:hero,
          lane_opponents:lane,
          other_enemies:other,
          full_enemy_roster:enemies,
          lane_state:laneState,
          stage,
          requested_role:args.player_role??"auto",
          resolved_role:resolvedRole,
        },
        player_hero:heroSnapshot(me),
        player_build_signal:playerBuild,
        player_role:{resolved:resolvedRole,guidance:ROLE_GUIDANCE[resolvedRole]||ROLE_GUIDANCE.hybrid},
        enemy_heroes:enemyHeroes.map(heroSnapshot),
        enemy_build_signals:enemyHeroes.map((h,i)=>({hero:heroName(h),...enemyBuildSignals[i]})),
        enemy_mechanic_summaries:enemyHeroes.map((h,i)=>({hero:heroName(h),...enemyMechanics[i]})),
        expert_framework_priors:enemyHeroes.map(h=>EXPERT_FRAMEWORK_PRIORS[heroName(h)]?({
          hero:heroName(h),
          source_note:"Derived from AShires' role-fit + full-team counter-buy framework applied to current live mechanics; not a direct quote from his older per-hero video.",
          ...EXPERT_FRAMEWORK_PRIORS[heroName(h)]
        }):null).filter(Boolean),
        popular_core:core,
        candidate_items:candidateItems.map(itemSnapshot),
        counter_coverage:coverage,
        full_game_plan:fullPlan,
        engine_version:"3.0.0-team-first",
        high_rank_item_evidence:evidenceFor(candidateItems,baseRows,laneRows,rosterRows),
        evidence_window:"Deadlock API analytics default window (currently 30 days unless the API changes its default).",
        high_rank_filter:"min_average_badge=81, maximum supported badge=116",
        methodology:METHOD,
      };

      return {
        content:[{
          type:"text",
          text:
`LIVE COUNTER-BUY CONTEXT READY.

Use the structured evidence returned with this tool call. Do not simply pick the highest purchase-rate item.

Decision standard:
${METHOD}

Output for the user, extremely glanceable:
[Player] versus [six enemy heroes]
Best team counter: ITEM — concrete interactions and number of enemies covered.
Second priority: ITEM or Stay on core — distinct additional coverage.
Optional pivot: ITEM — conditional fallback if threat changes.
Full-game path: Core → Counter → Core → Counter.
No per-stage advice; one plan from one prompt. No mandatory extra items.`
        }],
        structuredContent:result,
      };
    }
  );

  return server;
}

export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","content-type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers","Mcp-Session-Id");

  if(req.method==="OPTIONS"){
    res.statusCode=204;
    res.end();
    return;
  }

  const server=createServer();
  const transport=new StreamableHTTPServerTransport({
    sessionIdGenerator:undefined,
    enableJsonResponse:true,
  });

  try{
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch(err){
    console.error("MCP request failed",err);
    if(!res.headersSent){
      res.statusCode=500;
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({error:"MCP server error",message:err?.message||String(err)}));
    }
  }
}
