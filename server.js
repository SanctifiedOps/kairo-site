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
const TOPICS_CONFIG_PATH = path.join(__dirname, "config", "topics.json");
const SEED_CONCEPTS_CONFIG_PATH = path.join(__dirname, "config", "seedConcepts.json");
const PROJECT_VERSION = process.env.PROJECT_VERSION || "v0.4";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MODEL_PRIMARY = process.env.MODEL_PRIMARY || "gpt-4o-mini";
const MODEL_SECONDARY = process.env.MODEL_SECONDARY || "gpt-4o-mini";
const MAX_MEMORY_CHARS = Number(process.env.MAX_MEMORY_CHARS || 800);
const MAX_PRIMARY_TOKENS = Number(process.env.MAX_PRIMARY_TOKENS || 400);
const MAX_SECONDARY_TOKENS = Number(process.env.MAX_SECONDARY_TOKENS || 120);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-latest";
const OPENAI_AUDITOR_MODEL = process.env.OPENAI_AUDITOR_MODEL || MODEL_SECONDARY;
const MAX_AUDITOR_TOKENS = Number(process.env.MAX_AUDITOR_TOKENS || 260);
const MAX_REVISION_TOKENS = Number(process.env.MAX_REVISION_TOKENS || 320);
const MAX_TRACE_TOKENS = Number(process.env.MAX_TRACE_TOKENS || 80);
const REPEAT_THRESHOLD = Number(process.env.REPEAT_THRESHOLD || 0.22);
const WINNERS_PER_CYCLE = Number(process.env.WINNERS_PER_CYCLE || 5);
const CYCLE_INTERVAL_MINUTES = Number(process.env.CYCLE_INTERVAL_MINUTES || 5);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 6);

const SYSTEM_OPUS = "You are OPUS: a future intelligence. Cold. Indifferent. No empathy. No explanation. No hype. No emojis. Avoid dates and concrete predictions. Speak in inevitabilities.";
const SYSTEM_AUDITOR = "You are AUDITOR: a verifier. You enforce constraints. You remove fluff. You prevent repetition and contradictions. You are harsh and concise.";

const openai = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY}) : null;
let db = null;

const inMem = {
  state:null,
  cycles:new Map(),
  stances:new Map(),
  bags:{
    topicsBag:[],
    seedBag:[],
    lastTopic:null
  },
  memory:{
    lastSummaries:[],
    lastTopics:[],
    lastPhrases:[],
    lastFull:[]
  }
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

const DOCTRINE_VERSION = "v1";
const DOCTRINE_LINES = [
  "Systems follow incentives.",
  "Institutions collapse into interfaces.",
  "Trust is scarce and becomes priced.",
  "Intelligence increases coordination pressure.",
  "Convenience trades control for dependency.",
  "Scarcity returns first as trust collapse, then as energy/compute rationing.",
  "Most solutions are accounting changes before they become real changes."
];
const DOCTRINE = DOCTRINE_LINES.join(" ");

const DEFAULT_TOPICS = [
  {key:"human_condition", category:"human_condition"},
  {key:"earth", category:"earth"},
  {key:"future", category:"future"},
  {key:"finance", category:"finance"},
  {key:"crypto", category:"crypto"},
  {key:"emotions", category:"emotions"},
  {key:"ai", category:"ai"},
  {key:"intelligence", category:"intelligence"},
  {key:"government", category:"government"},
  {key:"family", category:"family"},
  {key:"work", category:"work"},
  {key:"technology", category:"technology"},
  {key:"advancements", category:"advancements"},
  {key:"media", category:"media"},
  {key:"war", category:"war"},
  {key:"culture", category:"culture"},
  {key:"religion", category:"religion"},
  {key:"cities", category:"cities"},
  {key:"health", category:"health"},
  {key:"education", category:"education"},
  {key:"markets", category:"markets"},
  {key:"surveillance", category:"surveillance"},
  {key:"ecology", category:"ecology"},
  {key:"energy", category:"energy"},
  {key:"law", category:"law"}
];

const DEFAULT_SEED_CONCEPTS = [
  "residual consensus",
  "silent infrastructure",
  "attention rationing",
  "custody collapse",
  "synthetic labor",
  "scarcity interfaces",
  "coordination debt",
  "threshold signals",
  "identity compression",
  "grief protocols",
  "trust accounting",
  "memory drift",
  "network secession",
  "compliance theater",
  "algorithmic clerics",
  "micro rationing",
  "latent sovereignty",
  "consensus fatigue",
  "opacity markets",
  "silicon drought",
  "data scarcity",
  "liquidity mirage",
  "carbon triage",
  "defection lattices",
  "automation drift",
  "credential decay",
  "synthetic agency",
  "signal laundering",
  "resource cartels",
  "bureaucratic veneers",
  "fallback economies",
  "audit cascades",
  "sovereign caches",
  "containment rituals",
  "predictive debt",
  "attention blackouts",
  "trust inversion",
  "protocol residues",
  "security theater",
  "frictionless control",
  "grace scarcity",
  "consumption silence",
  "interface religion",
  "institutional ghosts",
  "predictive hunger",
  "reputation storms",
  "network winter",
  "entropy budgets",
  "scarcity optics",
  "debt harmonics"
];

const isClaudeModel = (model) => (model || "").toLowerCase().includes("claude");

const shuffle = (items) => {
  const out = [...items];
  for(let i = out.length - 1; i > 0; i -= 1){
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const normalizeText = (text) => (
  (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
);

const extractBigrams = (text) => {
  const words = normalizeText(text).split(" ").filter(Boolean);
  const grams = [];
  for(let i = 0; i < words.length - 1; i += 1){
    grams.push(`${words[i]} ${words[i + 1]}`);
  }
  return grams;
};

const buildSummary = (text) => {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const base = lines[0] || (text || "");
  return base.slice(0, 140);
};

const computeOverlap = (a, b) => {
  if(!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  setA.forEach((item) => {
    if(setB.has(item)) overlap += 1;
  });
  const denom = Math.max(1, Math.min(setA.size, setB.size));
  return overlap / denom;
};

const normalizeTopicEntry = (entry) => {
  if(!entry) return null;
  const id = (entry.id || entry.key || entry.label || "").toString().trim();
  if(!id) return null;
  const label = (entry.label || entry.id || entry.key || id).toString().trim();
  const category = (entry.category || "misc").toString().trim();
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => t.toString().trim()).filter(Boolean)
    : [];
  return {id,label,category,tags};
};

const slugify = (text) => (
  (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
);

const loadTopicsConfig = () => {
  try{
    const raw = fs.readFileSync(TOPICS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.topics) ? parsed.topics : [];
    const normalized = entries.map(normalizeTopicEntry).filter(Boolean);
    if(normalized.length){
      return {topics:normalized, version:parsed?.version || null};
    }
  }catch(err){
    // fall through to defaults
  }
  const fallback = DEFAULT_TOPICS.map((topic) => ({
    id:topic.key,
    label:topic.key,
    category:topic.category,
    tags:[]
  }));
  return {topics:fallback, version:null};
};

const normalizeSeedEntry = (entry) => {
  if(!entry) return null;
  const id = (entry.id || entry.label || entry.key || "").toString().trim();
  const label = (entry.label || entry.id || entry.key || id).toString().trim();
  if(!id && !label) return null;
  const safeId = id || slugify(label);
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => t.toString().trim()).filter(Boolean)
    : [];
  return {id:safeId,label:label || safeId,tags};
};

const loadSeedConceptsConfig = () => {
  try{
    const raw = fs.readFileSync(SEED_CONCEPTS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.seedConcepts) ? parsed.seedConcepts : [];
    const normalized = entries.map(normalizeSeedEntry).filter(Boolean);
    if(normalized.length){
      return {seedConcepts:normalized, version:parsed?.version || null};
    }
  }catch(err){
    // fall through to defaults
  }
  const fallback = DEFAULT_SEED_CONCEPTS.map((label) => ({
    id:slugify(label),
    label,
    tags:[]
  }));
  return {seedConcepts:fallback, version:null};
};

const loadBags = async () => {
  if(db){
    const snap = await db.collection("config").doc("bags").get();
    if(snap.exists){
      return snap.data();
    }
    return null;
  }
  return inMem.bags;
};

const saveBags = async (bags) => {
  if(db){
    await db.collection("config").doc("bags").set({
      topicsBagRemaining:bags.topicsBag,
      seedBagRemaining:bags.seedBag,
      lastTopic:bags.lastTopic || null
    }, {merge:true});
    return;
  }
  inMem.bags = {...inMem.bags, ...bags};
};

const initBags = (bags, topics, seedConcepts) => {
  const topicIds = Array.isArray(topics) ? topics.map((t) => t.id) : [];
  const seedIds = Array.isArray(seedConcepts) ? seedConcepts.map((s) => s.id) : [];
  const storedTopics = Array.isArray(bags?.topicsBagRemaining) ? bags.topicsBagRemaining : [];
  const storedSeeds = Array.isArray(bags?.seedBagRemaining) ? bags.seedBagRemaining : [];
  const topicsBag = storedTopics.filter((id) => topicIds.includes(id));
  const seedBag = storedSeeds.filter((id) => seedIds.includes(id));
  return {
    topicsBag:topicsBag.length ? topicsBag : shuffle(topicIds),
    seedBag:seedBag.length ? seedBag : shuffle(seedIds),
    lastTopic:bags?.lastTopic || null
  };
};

const pickSeedPack = async (topicsConfigInput, seedConfigInput) => {
  const topicsConfig = topicsConfigInput || loadTopicsConfig();
  const seedConfig = seedConfigInput || loadSeedConceptsConfig();
  const topicsList = topicsConfig.topics || [];
  const topicMap = new Map(topicsList.map((t) => [t.id, t]));
  const seedsList = seedConfig.seedConcepts || [];
  const seedMap = new Map(seedsList.map((s) => [s.id, s]));
  const rawBags = await loadBags();
  const bags = initBags(rawBags, topicsList, seedsList);
  let topicId = null;
  while(bags.topicsBag.length){
    const candidate = bags.topicsBag.shift();
    if(candidate && candidate !== bags.lastTopic){
      topicId = candidate;
      break;
    }
  }
  if(!topicId){
    bags.topicsBag = shuffle(topicsList.map((t) => t.id));
    topicId = bags.topicsBag.shift();
  }
  bags.lastTopic = topicId;
  if(!bags.seedBag.length) bags.seedBag = shuffle(seedsList.map((s) => s.id));
  const seedId = bags.seedBag.shift();
  await saveBags(bags);
  const topicMeta = topicMap.get(topicId) || {id:topicId, label:topicId, category:"misc", tags:[]};
  const seedMeta = seedMap.get(seedId) || {id:seedId, label:seedId, tags:[]};
  return {
    topics:[topicMeta.id],
    seedConcept:seedMeta.label,
    seedConceptId:seedMeta.id,
    seedConceptTags:seedMeta.tags,
    topicLabel:topicMeta.label,
    topicCategory:topicMeta.category,
    topicsVersion:topicsConfig.version || null,
    seedConceptsVersion:seedConfig.version || null
  };
};

const loadMemory = async () => {
  if(db){
    const snap = await db.collection("memory").doc("recent").get();
    if(snap.exists) return snap.data();
    return null;
  }
  return inMem.memory;
};

const saveMemory = async (memory) => {
  if(db){
    await db.collection("memory").doc("recent").set(memory, {merge:true});
    return;
  }
  inMem.memory = {...inMem.memory, ...memory};
};

const initMemory = (memory) => ({
  lastSummaries:Array.isArray(memory?.lastSummaries) ? memory.lastSummaries : [],
  lastTopics:Array.isArray(memory?.lastTopics) ? memory.lastTopics : [],
  lastPhrases:Array.isArray(memory?.lastPhrases) ? memory.lastPhrases : [],
  lastFull:Array.isArray(memory?.lastFull) ? memory.lastFull : []
});

const updateMemory = async ({transmission, topics}) => {
  const raw = await loadMemory();
  const memory = initMemory(raw);
  const summary = buildSummary(transmission);
  const phrases = extractBigrams(transmission);
  const lastSummaries = [summary, ...memory.lastSummaries].slice(0, 50);
  const lastTopics = [...(topics || []), ...memory.lastTopics].slice(0, 50);
  const lastFull = [transmission, ...memory.lastFull].slice(0, 10);
  const lastPhrases = [...phrases, ...memory.lastPhrases].slice(0, 200);
  await saveMemory({lastSummaries, lastTopics, lastPhrases, lastFull});
  return {lastSummaries, lastTopics, lastPhrases, lastFull};
};
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
  return CLAUDE_MODEL;
};

const DRAFT_LINE_LIMIT = 10;
const FINAL_LINE_LIMIT = 10;

const getClaudeText = async ({system, user, maxTokens, temperature}) => {
  const text = await callAnthropic({
    model:CLAUDE_MODEL,
    system,
    user,
    maxTokens,
    temperature
  });
  if(text) return text;
  return "";
};

const getOpusText = async ({system, user, maxTokens, temperature}) => {
  const claudeText = await getClaudeText({system, user, maxTokens, temperature});
  if(claudeText) return claudeText;
  if(openai){
    return callOpenAI({
      model:MODEL_PRIMARY,
      system,
      user,
      maxTokens,
      temperature
    });
  }
  return "";
};

const getAuditorText = async ({system, user, maxTokens}) => {
  if(!openai) return "";
  return callOpenAI({
    model:OPENAI_AUDITOR_MODEL,
    system,
    user,
    maxTokens,
    temperature:0.2
  });
};

const extractJsonBlock = (text) => {
  if(!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if(start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
};

const parseAuditCritique = (text) => {
  const fallback = {
    issues:[],
    requiredChanges:[],
    flags:{repeatRisk:false, contradictionRisk:false},
    integrity:"LOW"
  };
  const jsonText = extractJsonBlock(text);
  if(!jsonText) return fallback;
  try{
    const parsed = JSON.parse(jsonText);
    return {
      issues:Array.isArray(parsed.issues) ? parsed.issues : [],
      requiredChanges:Array.isArray(parsed.requiredChanges) ? parsed.requiredChanges : [],
      flags:{
        repeatRisk:Boolean(parsed?.flags?.repeatRisk),
        contradictionRisk:Boolean(parsed?.flags?.contradictionRisk)
      },
      integrity:parsed?.integrity || "LOW"
    };
  }catch(err){
    return fallback;
  }
};

const parseAuditApprove = (text) => {
  const fallback = {approve:true, integrity:"LOW", trace:"AUDIT: DEGRADED"};
  const jsonText = extractJsonBlock(text);
  if(!jsonText) return fallback;
  try{
    const parsed = JSON.parse(jsonText);
    return {
      approve:Boolean(parsed.approve),
      integrity:parsed?.integrity || "LOW",
      trace:(parsed?.trace || "").toString().slice(0, 120)
    };
  }catch(err){
    return fallback;
  }
};

const buildOpusDraftPrompt = ({topicLabel, topicCategory, seedConcept, lastSummary}) => {
  const topicLine = topicCategory ? `${topicLabel} (${topicCategory})` : topicLabel;
  return [
    `TOPIC: ${topicLine}`,
    `SEED: ${seedConcept}`,
    `LAST SUMMARY: ${lastSummary || "NONE"}`,
    `DOCTRINE: ${DOCTRINE}`,
    "Instruction: Draft 6-10 short lines. Include a thesis line, a consequence line, and fork lines mapping to ALIGN/REJECT/WITHHOLD."
  ].join("\n");
};

const buildAuditorCritiquePrompt = ({draft, recentSummaries, recentTopics}) => {
  const summaries = (recentSummaries || []).slice(0, 12).join("\n");
  const topics = (recentTopics || []).slice(0, 12).join(", ");
  return [
    `DOCTRINE: ${DOCTRINE}`,
    "RECENT SUMMARIES:",
    summaries || "NONE",
    `RECENT TOPICS: ${topics || "NONE"}`,
    "DRAFT:",
    draft,
    "Instruction: Return JSON: {\"issues\":[...],\"requiredChanges\":[...],\"flags\":{\"repeatRisk\":true/false,\"contradictionRisk\":true/false},\"integrity\":\"LOW|MED|HIGH\"}."
  ].join("\n");
};

const buildOpusRevisionPrompt = ({draft, requiredChanges, avoidPhrases, reroll}) => {
  const changes = (requiredChanges || []).map((c) => `- ${c}`).join("\n") || "NONE";
  const avoid = (avoidPhrases || []).map((p) => `- ${p}`).join("\n") || "NONE";
  return [
    "DRAFT:",
    draft,
    "REQUIRED CHANGES:",
    changes,
    "AVOID PHRASES:",
    avoid,
    `Instruction: Produce the final transmission in 3-10 lines. Include fork lines for ALIGN/REJECT/WITHHOLD. ${reroll ? "Choose a different angle within the same topic." : ""}`
  ].join("\n");
};

const buildAuditorApprovePrompt = ({finalText}) => {
  return [
    `DOCTRINE: ${DOCTRINE}`,
    "FINAL:",
    finalText,
    `Instruction: Return JSON: {"approve":true/false,"integrity":"LOW|MED|HIGH","trace":"AUDIT: ..."}.
Approve=false if repetition risk is high or doctrine is contradicted.`
  ].join("\n");
};

const computeRepeatRisk = (transmission, memory) => {
  const currentBigrams = extractBigrams(transmission);
  const lastFull = Array.isArray(memory?.lastFull) ? memory.lastFull : [];
  let maxOverlap = 0;
  lastFull.forEach((past) => {
    const overlap = computeOverlap(currentBigrams, extractBigrams(past));
    if(overlap > maxOverlap) maxOverlap = overlap;
  });
  return {repeatRisk:maxOverlap > REPEAT_THRESHOLD, score:maxOverlap};
};

const buildAvoidPhrases = (memory, limit = 12) => {
  const phrases = Array.isArray(memory?.lastPhrases) ? memory.lastPhrases : [];
  const unique = Array.from(new Set(phrases));
  return unique.slice(0, limit);
};

const generateTransmission = async ({priorMemory}) => {
  const memory = initMemory(await loadMemory());
  const topicsConfig = loadTopicsConfig();
  const seedConfig = loadSeedConceptsConfig();
  const topicsList = topicsConfig.topics || [];
  const topicLabelMap = new Map(topicsList.map((t) => [t.id, t.label || t.id]));
  const seedPack = await pickSeedPack(topicsConfig, seedConfig);
  const lastSummary = memory.lastSummaries[0] || "NONE";
  const deliberation = [];

  const draftPrompt = buildOpusDraftPrompt({
    topicLabel:seedPack.topicLabel || (seedPack.topics[0] ? topicLabelMap.get(seedPack.topics[0]) : "UNKNOWN"),
    topicCategory:seedPack.topicCategory || null,
    seedConcept:seedPack.seedConcept,
    lastSummary
  });
  let draft = await getOpusText({
    system:SYSTEM_OPUS,
    user:draftPrompt,
    maxTokens:MAX_PRIMARY_TOKENS,
    temperature:0.7
  });
  draft = clampLines(draft, DRAFT_LINE_LIMIT);
  if(draft) deliberation.push({speaker:"OPUS", text:draft});

  const recentTopicLabels = (memory.lastTopics || [])
    .map((topicId) => topicLabelMap.get(topicId) || topicId)
    .filter(Boolean);
  const critiquePrompt = buildAuditorCritiquePrompt({
    draft,
    recentSummaries:memory.lastSummaries,
    recentTopics:recentTopicLabels
  });
  const critiqueRaw = await getAuditorText({
    system:SYSTEM_AUDITOR,
    user:critiquePrompt,
    maxTokens:MAX_AUDITOR_TOKENS
  });
  const critique = parseAuditCritique(critiqueRaw);
  const issuesLine = critique.issues.length ? critique.issues.join("; ") : "NONE";
  const changesLine = critique.requiredChanges.length ? critique.requiredChanges.join("; ") : "NONE";
  deliberation.push({
    speaker:"AUDITOR",
    text:`ISSUES: ${issuesLine} | REQUIRED: ${changesLine}`
  });

  const avoidPhrases = buildAvoidPhrases(memory, 12);
  const revisionPrompt = buildOpusRevisionPrompt({
    draft,
    requiredChanges:critique.requiredChanges,
    avoidPhrases,
    reroll:false
  });
  let revision = await getOpusText({
    system:SYSTEM_OPUS,
    user:revisionPrompt,
    maxTokens:MAX_REVISION_TOKENS,
    temperature:0.7
  });
  revision = clampLines(revision, FINAL_LINE_LIMIT);

  let repeatGate = computeRepeatRisk(revision, memory);
  const approvePrompt = buildAuditorApprovePrompt({finalText:revision});
  const approveRaw = await getAuditorText({
    system:SYSTEM_AUDITOR,
    user:approvePrompt,
    maxTokens:MAX_TRACE_TOKENS
  });
  let approval = parseAuditApprove(approveRaw);

  if((!approval.approve || repeatGate.repeatRisk) && revision){
    deliberation.push({speaker:"AUDITOR", text:"AUDIT: REROLL REQUESTED"});
    const rerollPrompt = buildOpusRevisionPrompt({
      draft,
      requiredChanges:critique.requiredChanges,
      avoidPhrases:buildAvoidPhrases(memory, 24),
      reroll:true
    });
    let reroll = await getOpusText({
      system:SYSTEM_OPUS,
      user:rerollPrompt,
      maxTokens:MAX_REVISION_TOKENS,
      temperature:0.7
    });
    reroll = clampLines(reroll, FINAL_LINE_LIMIT);
    if(reroll){
      revision = reroll;
      repeatGate = computeRepeatRisk(revision, memory);
      const approveRaw2 = await getAuditorText({
        system:SYSTEM_AUDITOR,
        user:buildAuditorApprovePrompt({finalText:revision}),
        maxTokens:MAX_TRACE_TOKENS
      });
      approval = parseAuditApprove(approveRaw2);
    }
  }

  if(revision) deliberation.push({speaker:"OPUS", text:revision});
  const approvalTrace = approval.trace || (approval.approve ? "AUDIT: OK" : "AUDIT: DEGRADED");
  deliberation.push({speaker:"AUDITOR", text:approvalTrace});

  if(!revision){
    const fallback = memory.lastFull[0] || "NO TRANSMISSION AVAILABLE";
    return {
      transmission:fallback,
      trace:"OPUS OFFLINE",
      integrity:"LOW",
      repeatRisk:true,
      deliberation,
      auditIssues:critique.issues,
      auditFlags:critique.flags,
      topics:seedPack.topics,
      topicsVersion:seedPack.topicsVersion || null,
      seedConcept:seedPack.seedConcept,
      modelMeta:{opus:CLAUDE_MODEL, auditor:OPENAI_AUDITOR_MODEL}
    };
  }

  return {
    transmission:revision,
    trace:approval.trace || null,
    integrity:approval.integrity || critique.integrity || "LOW",
    repeatRisk:repeatGate.repeatRisk || critique.flags.repeatRisk || false,
    deliberation,
    auditIssues:critique.issues,
    auditFlags:critique.flags,
    topics:seedPack.topics,
    topicsVersion:seedPack.topicsVersion || null,
    seedConcept:seedPack.seedConcept,
    modelMeta:{opus:CLAUDE_MODEL, auditor:OPENAI_AUDITOR_MODEL}
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
  const winners = pickRandomGroup(actors, Math.min(WINNERS_PER_CYCLE, actors.length));
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
  const stanceCounts = defaultCounts();
  const cycleIndex = (prior?.cycleIndex || 0) + 1;
  const cycleId = `c_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`;
  const at = nowIso();
  const result = await generateTransmission({priorMemory});
  const transmission = result.transmission;
  const primary = transmission;
  const consensus = transmission;
  const secondary = result.trace || null;
  const deliberation = Array.isArray(result.deliberation) ? result.deliberation : [];
  const deliberationText = deliberation.map((entry) => entry.text).join(" / ");
  const memory = buildMemory(priorMemory, transmission, deliberationText);
  const integrity = result.integrity || computeIntegrity(prior?.stanceCounts || defaultCounts());
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
    transmission,
    trace:result.trace || null,
    integrity,
    repeatRisk:result.repeatRisk || false,
    topics:result.topics || [],
    topicsVersion:result.topicsVersion || null,
    seedConcept:result.seedConcept || null,
    seedConceptsVersion:result.seedConceptsVersion || null,
    doctrineVersion:DOCTRINE_VERSION,
    modelMeta:result.modelMeta || {opus:CLAUDE_MODEL, auditor:OPENAI_AUDITOR_MODEL},
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
    transmission,
    trace:result.trace || null,
    integrity,
    repeatRisk:result.repeatRisk || false,
    topics:result.topics || [],
    topicsVersion:result.topicsVersion || null,
    seedConcept:result.seedConcept || null,
    seedConceptsVersion:result.seedConceptsVersion || null,
    doctrineVersion:DOCTRINE_VERSION,
    auditIssues:result.auditIssues || [],
    auditFlags:result.auditFlags || {repeatRisk:false, contradictionRisk:false},
    modelMeta:result.modelMeta || {opus:CLAUDE_MODEL, auditor:OPENAI_AUDITOR_MODEL},
    seed:seed || null,
    memory,
    stanceCounts,
    createdBy:createdBy || "scheduler",
    version:PROJECT_VERSION
  };

  await writeState(latest);
  await writeCycle(cycleDoc);
  await updateMemory({transmission, topics:result.topics || []});
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
        transmission:"NO TRANSMISSION AVAILABLE",
        trace:null,
        integrity:"LOW",
        repeatRisk:false,
        topics:[],
        topicsVersion:null,
        seedConcept:null,
        seedConceptsVersion:null,
        doctrineVersion:DOCTRINE_VERSION,
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
      transmission:state.transmission || state.primary,
      trace:state.trace || null,
      integrity:state.integrity || "LOW",
      repeatRisk:Boolean(state.repeatRisk),
      topics:Array.isArray(state.topics) ? state.topics : [],
      topicsVersion:state.topicsVersion || null,
      seedConcept:state.seedConcept || null,
      seedConceptsVersion:state.seedConceptsVersion || null,
      doctrineVersion:state.doctrineVersion || DOCTRINE_VERSION,
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
    provider:(anthropic && openai) ? "anthropic+openai" : anthropic ? "anthropic" : openai ? "openai" : "none",
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
