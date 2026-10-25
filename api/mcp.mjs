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
const WIDGET_URI = "ui://deadlock-counter-buy/picker-v1.html";
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
function counterCoverage(candidateItems,role,enemyHeroes,buildSignals,mechanics,laneNames){
  const laneSet=new Set(laneNames);
  return candidateItems.map(i=>{
    const name=itemName(i);
    const covered=[];
    for(let idx=0;idx<enemyHeroes.length;idx++){
      const h=enemyHeroes[idx], b=buildSignals[idx], m=mechanics[idx];
      const gun=(m.gun_score>=2)||(b?.slot_share?.weapon>=0.4);
      const spirit=(m.spirit_score>=2)||(b?.slot_share?.spirit>=0.4);
      let hit=false;
      if(["Metal Skin","Rusted Barrel","Disarming Hex","Bullet Resilience","Plated Armor"].includes(name)) hit=gun;
      else if(name==="Suppressor") hit=gun;
      else if(["Healbane","Toxic Bullets","Decay"].includes(name)) hit=m.healing.length>0;
      else if(name==="Reactive Barrier") hit=m.trigger_control.length>0;
      else if(name==="Debuff Reducer") hit=m.meaningful_debuffs.length>0;
      else if(name==="Enduring Speed") hit=m.slows.length>0;
      else if(name==="Slowing Hex") hit=m.movement.length>0;
      else if(name==="Spirit Resilience") hit=spirit;
      else if(name==="Knockdown") hit=m.airborne.length>0||m.long_channels.length>0;
      else if(name==="Rebuttal") hit=m.melee.length>0;
      else if(name==="Dispel Magic") hit=m.meaningful_debuffs.length>0;
      else if(name==="Unstoppable") hit=m.trigger_control.length>0||m.silences.length>0||m.disarms.length>0;
      else if(name==="Cold Front") hit=m.movement.length>0;
      if(hit) covered.push(heroName(h));
    }
    const laneCovered=covered.filter(x=>laneSet.has(x));
    const fit=roleFit(name,role);
    const fitWeight=fit==="high"?1.5:(fit==="medium"?.75:0);
    return {
      item:name,
      coverage_count:covered.length,
      lane_coverage_count:laneCovered.length,
      covers:covered,
      role_fit:fit,
      overlap_score:+(covered.length*2+laneCovered.length*.75+fitWeight).toFixed(2)
    };
  }).filter(x=>x.coverage_count>0||x.role_fit!=="neutral").sort((a,b)=>b.overlap_score-a.overlap_score);
}

const METHOD = [
  "Decide the active problem first, then the item.",
  "Use three tests: does the item counter these specific enemies; can the player's hero use it well; is it worth delaying the hero's next core power spike now?",
  "Do not over-counter. If no situational item clears that bar, say Stay on core.",
  "Counter-buying is role-dependent. Prefer the answer that lets the player's hero keep doing its job rather than the theoretically strongest 1v1 counter.",
  "For M1 vs M1, Metal Skin can outrank Disarming Hex because it preserves the buyer's own firing window; utility heroes can prefer Disarming Hex because disabling the enemy carry protects the whole team.",
  "Full-team coverage matters: count how many enemies are meaningfully answered by each candidate and prefer one item that solves several real threats over several narrow 1:1 purchases.",
  "Use current common-build signals to decide whether an enemy is actually presenting gun, Spirit, healing, control, channel, or mobility pressure.",
  "Buy now is driven by lane urgency plus role fit. Team counter is driven by full-roster overlap. Pivot is conditional on which threat becomes the real problem. Later is expensive insurance.",
  "For newly released heroes, use the live ability mechanics, current build signals, and the derived expert-framework priors returned in this tool call.",
  "Debuff Reducer is for meaningful duration-based debuffs/control; consider absolute time saved, not just whether CC exists.",
  "Reactive Barrier only matters when a specific enemy ability applies Stun, Chain, Immobilize, Sleep, or Silence.",
  "Slowing Hex is high value only when it meaningfully shuts an important movement ability and the player's hero can capitalize.",
  "Choose antiheal by buyer role: Healbane for reliable Spirit application, Toxic Bullets for M1 application, Decay for targeted utility.",
  "Suppressor is especially efficient for Spirit heroes into M1 threats because normal Spirit damage applies the fire-rate reduction.",
  "Knockdown gains teamwide value when multiple enemies rely on aerial states or long interruptible channels.",
  "Counterspell should answer a specific high-impact parryable threat, not generic burst.",
  "Spirit/Bullet Resilience are conditional on the damage profile actually hurting the player.",
  "Unstoppable becomes high value for channels/commits that the enemy roster can reliably interrupt.",
  "High-rank purchase data is supporting evidence, never a substitute for mechanical validity, buyer role, or team coverage."
].join("\n");

function createServer(){
  const server = new McpServer({
    name:"Deadlock Counter-Buy",
    version:"1.0.0",
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

Output for the user should be extremely glanceable:
[Player] vs [Lane 1] + [Lane 2]
Buy now: ITEM — one-line why.
Team counter: ITEM — one-line why it covers multiple meaningful enemies and fits the buyer's role.
Pivot: ITEM — one-line condition for changing the purchase.
Later: ITEM — one-line why.
Simple path: ITEM → Core → ITEM → ITEM.
If no counter is worth delaying core, explicitly say Stay on core.
Do not force four different purchases; repeating Stay on core or holding a slot is better than over-countering.`
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
