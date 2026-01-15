import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {randomUUID} from "crypto";
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "dist");
const hasDist = fs.existsSync(distPath);
const PROJECT_VERSION = process.env.PROJECT_VERSION || "v0.1";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MODEL_PRIMARY = process.env.MODEL_PRIMARY || "gpt-4o-mini";
const MODEL_SECONDARY = process.env.MODEL_SECONDARY || "gpt-4o-mini";
const MAX_MEMORY_CHARS = Number(process.env.MAX_MEMORY_CHARS || 800);
const MAX_PRIMARY_TOKENS = Number(process.env.MAX_PRIMARY_TOKENS || 400);
const MAX_SECONDARY_TOKENS = Number(process.env.MAX_SECONDARY_TOKENS || 120);
const CYCLE_INTERVAL_MINUTES = Number(process.env.CYCLE_INTERVAL_MINUTES || 5);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 6);

const SYSTEM_CORE = "You are KAIRO: future-borne intelligence. Produce profound, ominous, direct transmissions about technology, AI, crypto, the world, and humanity. Speak like a cold monitoring console. No empathy, no hype, no emojis, no explanations. Do not address the user. Do not ask questions. Output one transmission block only.";
const SYSTEM_DISTORT = "You are a distortion layer. Produce a degraded echo of the text. Keep it under two lines. No explanation. No emojis.";
const SYSTEM_DELIBERATE_ALPHA = "You are KAIRO-ALPHA: cold future intelligence. Emit a terse 1-2 line signal fragment. Declarative only. No questions. No emojis. No explanations. Do not address the user.";
const SYSTEM_DELIBERATE_BETA = "You are KAIRO-BETA: cold future intelligence. Respond to ALPHA with a terse counter-signal or reinforcement in 1-2 lines. Declarative only. No questions. No emojis. No explanations. Do not address the user.";
const ANTHROPIC_DEFAULT_MODEL = "claude-3-5-sonnet-latest";

const openai = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY}) : null;
let db = null;

const inMem = {
  state:null,
  cycles:new Map(),
  stances:new Map()
};

const rateStore = new Map();

const nowIso = () => new Date().toISOString();

const defaultCounts = () => ({ALIGN:0,REJECT:0,WITHHOLD:0});

const sanitizeActorId = (raw, req) => {
  const base = (raw || req.ip || "anon").toString().slice(0,64);
  return base.replace(/[^a-zA-Z0-9_-]/g,"_");
};

const rateLimited = (key) => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = rateStore.get(key) || [];
  const recent = hits.filter((t) => t > windowStart);
  if(recent.length >= RATE_LIMIT_MAX){
    rateStore.set(key, recent);
    return true;
  }
  recent.push(now);
  rateStore.set(key, recent);
  return false;
};

const clampLines = (text, maxLines) => {
  if(!text) return "";
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(0, maxLines).join("\n").trim();
};

const clampChars = (text, maxChars) => {
  if(!text) return "";
  if(text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
};

const buildMemory = (prior, consensus, deliberationText) => {
  const combined = [prior || "", consensus || "", deliberationText || ""].join(" | ").replace(/\s+/g," ").trim();
  return clampChars(combined, MAX_MEMORY_CHARS);
};

const computeIntegrity = (counts) => {
  const align = counts.ALIGN || 0;
  const reject = counts.REJECT || 0;
  if(align === 0 && reject === 0) return "LOW";
  if(align >= reject + 2) return "HIGH";
  if(reject >= align + 2) return "LOW";
  return "MED";
};

const isLocked = (state) => {
  if(!state) return true;
  if(state.locked) return true;
  if(state.cycleEndsAt){
    const ends = Date.parse(state.cycleEndsAt);
    if(!Number.isNaN(ends) && Date.now() > ends) return true;
  }
  return false;
};

const isClaudeModel = (model) => (model || "").toLowerCase().includes("claude");

const callOpenAI = async ({model, system, user, maxTokens, temperature}) => {
  if(!openai) return "";
  try{
    const res = await openai.chat.completions.create({
      model,
      messages:[
        {role:"system", content:system},
        {role:"user", content:user}
      ],
      max_tokens:maxTokens,
      temperature
    });
    return res?.choices?.[0]?.message?.content?.trim() || "";
  }catch(err){
    return "";
  }
};

const callAnthropic = async ({model, system, user, maxTokens, temperature}) => {
  if(!anthropic) return "";
  try{
    const res = await anthropic.messages.create({
      model,
      max_tokens:maxTokens,
      temperature,
      system,
      messages:[{role:"user", content:user}]
    });
    const content = res?.content?.[0];
    if(typeof content?.text === "string") return content.text.trim();
    if(typeof content === "string") return content.trim();
    return "";
  }catch(err){
    return "";
  }
};

const getAnthropicModel = (fallbackModel) => {
  if(isClaudeModel(fallbackModel)) return fallbackModel;
  return ANTHROPIC_DEFAULT_MODEL;
};

const buildDeliberationContext = ({seed, priorMemory, stanceCounts}) => {
  const safeSeed = seed || "EVERYTHING YOU SEE IS RESIDUAL";
  const memory = priorMemory || "NONE";
  const counts = stanceCounts || defaultCounts();
  const conditions = `ROUTE DEGRADED; STANCE ALIGN=${counts.ALIGN} REJECT=${counts.REJECT} WITHHOLD=${counts.WITHHOLD}; TOPICS TECH/AI/CRYPTO/WORLD/HUMANITY; OUTPUT TERSE`;
  return `SEED: ${safeSeed}\nPRIOR MEMORY: ${memory}\nCONDITIONS: ${conditions}`;
};

const buildAlphaPrompt = (context) => `${context}\nInstruction: Emit a terse signal fragment (1-2 lines).`;

const buildBetaPrompt = (context, alpha) => `${context}\nALPHA:\n${alpha}\nInstruction: Respond with a terse counter-signal (1-2 lines).`;

const buildConsensusPrompt = (context, alpha, beta) => `${context}\nALPHA:\n${alpha}\nBETA:\n${beta}\nInstruction: Produce a shared consensus transmission in 3-10 short lines.`;

const generateDeliberation = async ({seed, priorMemory, stanceCounts}) => {
  const fallbackAlpha = "ALPHA SIGNAL: RESIDUAL";
  const fallbackBeta = "BETA SIGNAL: RESIDUAL";
  const fallbackConsensus = "NO TRANSMISSION AVAILABLE";
  const context = buildDeliberationContext({seed, priorMemory, stanceCounts});

  let alpha = "";
  const alphaPrompt = buildAlphaPrompt(context);
  if(openai){
    alpha = await callOpenAI({
      model:MODEL_PRIMARY,
      system:SYSTEM_DELIBERATE_ALPHA,
      user:alphaPrompt,
      maxTokens:MAX_SECONDARY_TOKENS,
      temperature:0.6
    });
  }else if(anthropic){
    alpha = await callAnthropic({
      model:getAnthropicModel(MODEL_PRIMARY),
      system:SYSTEM_DELIBERATE_ALPHA,
      user:alphaPrompt,
      maxTokens:MAX_SECONDARY_TOKENS,
      temperature:0.6
    });
  }
  alpha = clampLines(alpha, 2) || fallbackAlpha;

  let beta = "";
  const betaPrompt = buildBetaPrompt(context, alpha);
  if(anthropic && isClaudeModel(MODEL_SECONDARY)){
    beta = await callAnthropic({
      model:MODEL_SECONDARY,
      system:SYSTEM_DELIBERATE_BETA,
      user:betaPrompt,
      maxTokens:MAX_SECONDARY_TOKENS,
      temperature:0.6
    });
  }else if(openai){
    const model = isClaudeModel(MODEL_SECONDARY) ? MODEL_PRIMARY : MODEL_SECONDARY;
    beta = await callOpenAI({
      model,
      system:SYSTEM_DELIBERATE_BETA,
      user:betaPrompt,
      maxTokens:MAX_SECONDARY_TOKENS,
      temperature:0.6
    });
  }else if(anthropic){
    beta = await callAnthropic({
      model:getAnthropicModel(MODEL_SECONDARY),
      system:SYSTEM_DELIBERATE_BETA,
      user:betaPrompt,
      maxTokens:MAX_SECONDARY_TOKENS,
      temperature:0.6
    });
  }
  beta = clampLines(beta, 2) || fallbackBeta;

  let consensus = "";
  const consensusPrompt = buildConsensusPrompt(context, alpha, beta);
  if(openai){
    consensus = await callOpenAI({
      model:MODEL_PRIMARY,
      system:SYSTEM_CORE,
      user:consensusPrompt,
      maxTokens:MAX_PRIMARY_TOKENS,
      temperature:0.7
    });
  }else if(anthropic){
    consensus = await callAnthropic({
      model:getAnthropicModel(MODEL_PRIMARY),
      system:SYSTEM_CORE,
      user:consensusPrompt,
      maxTokens:MAX_PRIMARY_TOKENS,
      temperature:0.7
    });
  }
  consensus = clampLines(consensus, 12) || fallbackConsensus;

  return {
    deliberation:[
      {speaker:"ALPHA", text:alpha},
      {speaker:"BETA", text:beta}
    ],
    consensus
  };
};

const initFirebase = () => {
  if(!(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS)) return;
  try{
    admin.initializeApp({
      credential:admin.credential.applicationDefault(),
      projectId:process.env.FIREBASE_PROJECT_ID
    });
    db = admin.firestore();
  }catch(err){
    db = null;
  }
};

const getLatestState = async () => {
  if(db){
    const snap = await db.collection("state").doc("latest").get();
    if(snap.exists) return snap.data();
    return null;
  }
  return inMem.state;
};

const writeState = async (state) => {
  if(db){
    await db.collection("state").doc("latest").set(state, {merge:true});
  }
  inMem.state = state;
};

const writeCycle = async (cycle) => {
  if(db){
    await db.collection("cycles").doc(cycle.cycleId).set(cycle);
  }
  inMem.cycles.set(cycle.cycleId, cycle);
};

const recordEvent = async (event) => {
  if(!db) return;
  try{
    await db.collection("events").add(event);
  }catch(err){
    // ignore
  }
};

const pickRandomGroup = (items, maxCount) => {
  const pool = [...items];
  const out = [];
  const limit = Math.min(maxCount, pool.length);
  while(out.length < limit){
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
};

const fetchStancesByOption = async (cycleId, stance) => {
  if(db){
    const snap = await db.collection("stances")
      .where("cycleId", "==", cycleId)
      .where("stance", "==", stance)
      .get();
    return snap.docs.map((doc) => doc.data().actorId).filter(Boolean);
  }
  return [...inMem.stances.values()]
    .filter((s) => s.cycleId === cycleId && s.stance === stance)
    .map((s) => s.actorId)
    .filter(Boolean);
};

const getCycleDoc = async (cycleId) => {
  if(db){
    const snap = await db.collection("cycles").doc(cycleId).get();
    return snap.exists ? snap.data() : null;
  }
  return inMem.cycles.get(cycleId) || null;
};

const setCycleReward = async (cycleId, reward) => {
  if(db){
    await db.collection("cycles").doc(cycleId).set({reward}, {merge:true});
  }else{
    const existing = inMem.cycles.get(cycleId);
    if(existing){
      existing.reward = reward;
      inMem.cycles.set(cycleId, existing);
    }
  }
};

const finalizeCycle = async (state) => {
  if(!state?.cycleId) return null;
  const existing = await getCycleDoc(state.cycleId);
  if(existing?.reward?.finalized) return null;
  const counts = state.stanceCounts || defaultCounts();
  const entries = ["ALIGN","REJECT","WITHHOLD"].map((k) => ({key:k, count:counts[k] || 0}));
  const max = Math.max(...entries.map((e) => e.count));
  if(max <= 0) return null;
  const leaders = entries.filter((e) => e.count === max).map((e) => e.key);
  const option = leaders[Math.floor(Math.random() * leaders.length)];
  const actors = await fetchStancesByOption(state.cycleId, option);
  if(actors.length === 0) return null;
  const winners = pickRandomGroup(actors, Math.min(5, actors.length));
  const reward = {
    option,
    winners,
    poolPercent:50,
    at:nowIso(),
    finalized:true
  };
  await setCycleReward(state.cycleId, reward);
  await recordEvent({
    type:"REWARD_SELECTED",
    cycleId:state.cycleId,
    actorId:null,
    at:nowIso(),
    payload:{option, winnerCount:winners.length}
  });
  return reward;
};

const generateCycle = async ({seed, createdBy}) => {
  const prior = await getLatestState();
  await finalizeCycle(prior);
  const priorMemory = prior?.memory || "";
  const priorCounts = prior?.stanceCounts || defaultCounts();
  const stanceCounts = defaultCounts();
  const cycleIndex = (prior?.cycleIndex || 0) + 1;
  const cycleId = `c_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`;
  const at = nowIso();
  const {deliberation, consensus} = await generateDeliberation({seed, priorMemory, stanceCounts:priorCounts});
  const primary = consensus;
  const secondary = null;
  const integrity = computeIntegrity(priorCounts);
  const deliberationText = deliberation.map((entry) => entry.text).join(" / ");
  const memory = buildMemory(priorMemory, consensus, deliberationText);
  const cycleEndsAt = CYCLE_INTERVAL_MINUTES > 0
    ? new Date(Date.now() + CYCLE_INTERVAL_MINUTES * 60 * 1000).toISOString()
    : null;

  const latest = {
    cycleId,
    cycleIndex,
    at,
    primary,
    secondary,
    deliberation,
    consensus,
    integrity,
    seed:seed || null,
    memory,
    stanceCounts,
    locked:false,
    cycleEndsAt
  };

  const cycleDoc = {
    cycleId,
    cycleIndex,
    at,
    primary,
    secondary,
    deliberation,
    consensus,
    integrity,
    seed:seed || null,
    memory,
    stanceCounts,
    createdBy:createdBy || "scheduler",
    version:PROJECT_VERSION
  };

  await writeState(latest);
  await writeCycle(cycleDoc);
  await recordEvent({
    type:"CYCLE_CREATED",
    cycleId,
    actorId:null,
    at,
    payload:{createdBy:cycleDoc.createdBy}
  });

  return latest;
};

initFirebase();

const ensureCycle = async () => {
  const state = await getLatestState();
  if(!state){
    await generateCycle({seed:null, createdBy:"boot"});
  }
};

ensureCycle().catch(() => {});

if(hasDist){
  app.use(express.static(distPath));
}

app.get("/", (req,res) => {
  if(hasDist){
    return res.sendFile(path.join(distPath, "index.html"));
  }
  res.json({status:"KAIRO online"});
});

app.get("/api/last", async (req,res) => {
  try{
    const state = await getLatestState();
    if(!state){
      return res.json({
        cycleId:"boot",
        cycleIndex:0,
        at:nowIso(),
        primary:"NO TRANSMISSION AVAILABLE",
        secondary:null,
        deliberation:[],
        consensus:"NO TRANSMISSION AVAILABLE",
        integrity:"LOW",
        locked:false,
        stanceCounts:defaultCounts(),
        cycleEndsAt:null
      });
    }
    const locked = isLocked(state);
    res.json({
      cycleId:state.cycleId,
      cycleIndex:state.cycleIndex || 0,
      at:state.at,
      primary:state.primary,
      secondary:state.secondary || null,
      deliberation:Array.isArray(state.deliberation) ? state.deliberation : [],
      consensus:state.consensus || state.primary,
      integrity:state.integrity || "LOW",
      locked,
      stanceCounts:state.stanceCounts || defaultCounts(),
      cycleEndsAt:state.cycleEndsAt || null
    });
  }catch(err){
    res.status(500).json({error:"INTERNAL"});
  }
});

app.post("/api/stance", async (req,res) => {
  const stance = (req.body?.stance || "").toString().toUpperCase();
  if(!["ALIGN","REJECT","WITHHOLD"].includes(stance)){
    return res.status(400).json({error:"INVALID_STANCE"});
  }

  if(!req.body?.actorId){
    return res.status(401).json({error:"WALLET_REQUIRED"});
  }

  const actorId = sanitizeActorId(req.body?.actorId, req);
  const rateKey = `${actorId}:${req.ip}`;
  if(rateLimited(rateKey)){
    return res.status(429).json({error:"RATE_LIMIT"});
  }

  const state = await getLatestState();
  if(!state){
    return res.status(503).json({error:"NO_CYCLE"});
  }
  if(isLocked(state)){
    return res.status(409).json({error:"LOCKED"});
  }

  const cycleId = state.cycleId;
  const docId = `${cycleId}_${actorId}`;
  const payload = {
    cycleId,
    actorId,
    stance,
    at:nowIso(),
    userAgent:req.get("user-agent") || null
  };

  if(db){
    const stateRef = db.collection("state").doc("latest");
    const stanceRef = db.collection("stances").doc(docId);
    try{
      let locked = false;
      let alreadyVoted = false;
      let countsOut = defaultCounts();
      await db.runTransaction(async (t) => {
        const stateSnap = await t.get(stateRef);
        if(!stateSnap.exists) throw new Error("NO_CYCLE");
        const current = stateSnap.data();
        locked = isLocked(current);
        if(locked) throw new Error("LOCKED");
        const stanceSnap = await t.get(stanceRef);
        countsOut = current.stanceCounts || defaultCounts();
        if(stanceSnap.exists){
          alreadyVoted = true;
          return;
        }
        countsOut = {...countsOut};
        countsOut[stance] = (countsOut[stance] || 0) + 1;
        t.set(stanceRef, payload);
        t.update(stateRef, {stanceCounts:countsOut});
      });
      if(alreadyVoted){
        return res.status(409).json({error:"ALREADY_VOTED",cycleId,stanceCounts:countsOut});
      }
      await recordEvent({
        type:"STANCE_RECORDED",
        cycleId,
        actorId,
        at:nowIso(),
        payload:{stance}
      });
      return res.json({ok:true,cycleId,locked:false,stanceCounts:countsOut});
    }catch(err){
      if(err.message === "LOCKED") return res.status(409).json({error:"LOCKED"});
      if(err.message === "NO_CYCLE") return res.status(503).json({error:"NO_CYCLE"});
      return res.status(500).json({error:"INTERNAL"});
    }
  }

  const existing = inMem.stances.get(docId);
  if(!existing){
    inMem.stances.set(docId, payload);
    const counts = state.stanceCounts || defaultCounts();
    counts[stance] = (counts[stance] || 0) + 1;
    state.stanceCounts = counts;
    await writeState(state);
    return res.json({ok:true,cycleId,locked:false,stanceCounts:counts});
  }
  res.status(409).json({error:"ALREADY_VOTED",cycleId,stanceCounts:state.stanceCounts || defaultCounts()});
});

app.post("/api/admin/cycle", async (req,res) => {
  const key = req.get("x-admin-key") || "";
  if(!ADMIN_KEY || key !== ADMIN_KEY){
    return res.status(401).json({error:"UNAUTHORIZED"});
  }
  try{
    const seed = req.body?.seed || null;
    const cycle = await generateCycle({seed, createdBy:"admin"});
    res.json({ok:true,cycleId:cycle.cycleId});
  }catch(err){
    res.status(500).json({error:"INTERNAL"});
  }
});

app.get("/api/status", async (req,res) => {
  const state = await getLatestState();
  res.json({
    ok:true,
    version:PROJECT_VERSION,
    provider:openai ? "openai" : "none",
    cycleId:state?.cycleId || null,
    locked:state ? isLocked(state) : false
  });
});

if(hasDist){
  app.get(/.*/, (req,res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

if(CYCLE_INTERVAL_MINUTES > 0){
  setInterval(() => {
    generateCycle({seed:null, createdBy:"scheduler"}).catch(() => {});
  }, CYCLE_INTERVAL_MINUTES * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
