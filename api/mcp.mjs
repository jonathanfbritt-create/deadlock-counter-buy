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
  "Extra Stamina","Extra Regen","Debuff Reducer","Reactive Barrier","Enduring Speed",
  "Slowing Hex","Healbane","Cold Front","Bullet Resilience","Spirit Resilience",
  "Disarming Hex","Dispel Magic","Counterspell","Knockdown","Decay",
  "Unstoppable","Cheat Death"
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

const METHOD = [
  "Decide the active problem first, then the item.",
  "Use three tests: does the item counter these specific enemies; can the player's hero use it well; is it worth delaying the hero's next core power spike now?",
  "Do not over-counter. If no situational item clears that bar, say Stay on core.",
  "Separate lane urgency from full-roster planning: Buy now is driven by the lane and current stage, while Next defense and Later must account for all six enemies.",
  "Before choosing a situational item, identify repeated threat patterns across the full enemy roster and prefer multi-hero coverage when it fits the player hero.",
  "Do not default to a familiar counter template. Compare the actual roster's healing, movement, hard control, damage profile, channels, and dispellable effects.",
  "For newly released heroes, reason from the live ability mechanics returned in this tool call rather than stale assumptions.",
  "Debuff Reducer is for meaningful duration-based debuffs/control, not generic CC.",
  "Reactive Barrier only matters when the enemy has control that actually triggers it.",
  "Slowing Hex is high value only when it meaningfully shuts down important movement and the player's hero can capitalize.",
  "Healbane requires meaningful enemy healing plus reliable application by the player's hero.",
  "Counterspell should answer a specific high-impact parryable threat, not generic burst.",
  "Spirit/Bullet Resilience are conditional on the damage profile actually hurting the player.",
  "Unstoppable becomes high value for channels/commits that the enemy roster can reliably interrupt."
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
        hero:z.string().min(1),
        lane_opponents:z.array(z.string().min(1)).length(2),
        other_enemies:z.array(z.string().min(1)).length(4),
        lane_state:z.enum(["behind","even","ahead"]).default("even"),
        stage:z.enum(["lane","mid","late"]).default("lane"),
      },
    },
    async(args)=>{
      const hero=clean(args.hero);
      const lane=arr(args.lane_opponents).map(clean);
      const other=arr(args.other_enemies).map(clean);
      const enemies=[...lane,...other];
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
      const core=popularCore(me,itemById,args.stage);
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
      const candidateItems=items.filter(i=>candidateNames.has(itemName(i))).slice(0,32);

      const result={
        source:"Deadlock API current assets + analytics",
        patch:steam ? {version:steam.version??null,version_date:steam.version_date??null,build_id:steam.build_id??null} : null,
        matchup:{
          player:hero,
          lane_opponents:lane,
          other_enemies:other,
          full_enemy_roster:enemies,
          lane_state:args.lane_state,
          stage:args.stage,
        },
        player_hero:heroSnapshot(me),
        enemy_heroes:enemyHeroes.map(heroSnapshot),
        popular_core:core,
        candidate_items:candidateItems.map(itemSnapshot),
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
If ahead: ITEM — one-line why.
Next defense: ITEM — one-line why.
Later: ITEM — one-line why.
Simple path: ITEM → ITEM → Core → ITEM.
If no counter is worth delaying core, explicitly say Stay on core.`
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
