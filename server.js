import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {randomUUID} from "crypto";
import fs from "fs";
import path from "path";
import {Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction} from "@solana/web3.js";
import bs58 from "bs58";
import {OnlinePumpSdk} from "@pump-fun/pump-sdk";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const __dirname = process.cwd();
const distPath = path.join(__dirname, "dist");
const hasDist = fs.existsSync(distPath);
const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.NETLIFY_LOCAL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const shouldServeDist = hasDist && !IS_SERVERLESS;
const TOPICS_CONFIG_PATH = path.join(__dirname, "config", "topics.json");
const SEED_CONCEPTS_CONFIG_PATH = path.join(__dirname, "config", "seedConcepts.json");
const DOCTRINE_CONFIG_PATH = path.join(__dirname, "config", "doctrine.txt");
const PROJECT_VERSION = process.env.PROJECT_VERSION || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MODEL_PRIMARY = process.env.MODEL_PRIMARY || "";
const MODEL_SECONDARY = process.env.MODEL_SECONDARY || process.env.MODEL_PRIMARY || "";
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
const CYCLE_LOCK_TTL_MS = Number(process.env.CYCLE_LOCK_TTL_MS || 120000);
const CYCLE_RESET_VERSION = process.env.CYCLE_RESET_VERSION || "";
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 6);
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || "";
const CREATOR_FEE_SHARE_BPS = Number(process.env.CREATOR_FEE_SHARE_BPS || 5000);
const CREATOR_FEE_MIN_LAMPORTS = Number(process.env.CREATOR_FEE_MIN_LAMPORTS || 1000);
const MAX_SOL_TRANSFERS_PER_TX = Number(process.env.MAX_SOL_TRANSFERS_PER_TX || 8);
const PUMPFUN_SDK_MODULE = process.env.PUMPFUN_SDK_MODULE || "";
const PUMPFUN_SDK_FACTORY = process.env.PUMPFUN_SDK_FACTORY || "createPumpFunSdk";
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS || "";
const TOKEN_MIN_BALANCE = Number(process.env.TOKEN_MIN_BALANCE || 100000);
const ENABLE_TOKEN_GATING = process.env.ENABLE_TOKEN_GATING === "true";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
const TELEGRAM_VIDEO_PATH = process.env.TELEGRAM_VIDEO_PATH || "./public/assets/kairo-bg.mp4";
const TELEGRAM_VIDEO_URL = process.env.TELEGRAM_VIDEO_URL || "";
const TELEGRAM_POSTING_ENABLED = process.env.TELEGRAM_POSTING_ENABLED === "true";

const SYSTEM_OPUS = "You are OPUS: a future intelligence. Cold. Indifferent. No empathy. No explanation. No hype. No emojis. Avoid dates and concrete predictions. Speak in inevitabilities.";
const SYSTEM_AUDITOR = "You are AUDITOR: a verifier. You enforce constraints. You remove fluff. You prevent repetition and contradictions. You are harsh and concise.";

const buildOpusSystem = () => [
  SYSTEM_OPUS,
  buildDoctrineBlock(),
  "Constraint: The doctrine is canonical. Do not contradict it."
].join("\n\n");

const buildAuditorSystem = () => [
  SYSTEM_AUDITOR,
  buildDoctrineBlock(),
  "Constraint: Explicitly check for contradictions vs doctrine. If any contradiction exists, set contradictionRisk=true and integrity=LOW, and when asked to approve, set approve=false."
].join("\n\n");

const openai = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY}) : null;
const telegramBot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN, {polling: false}) : null;
let db = null;

const inMem = {
  state:null,
  cycles:new Map(),
  stances:new Map(),
  reputation:{},
  anomalyDetection:{
    patterns:new Map(),
    flaggedWallets:new Set()
  },
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

const logger = {
  error: (msg, meta = {}) => console.error(`[ERROR] ${msg}`, JSON.stringify(meta)),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${msg}`, JSON.stringify(meta)),
  info: (msg, meta = {}) => console.log(`[INFO] ${msg}`, JSON.stringify(meta)),
  debug: (msg, meta = {}) => {
    if(process.env.DEBUG) console.log(`[DEBUG] ${msg}`, JSON.stringify(meta));
  }
};

const nowIso = () => new Date().toISOString();

const isHttpUrl = (value) => /^https?:\/\//i.test(value || "");

const toPublicUrlPath = (inputPath) => {
  if(!inputPath) return "";
  if(isHttpUrl(inputPath)) return inputPath;
  const normalized = inputPath.replace(/\\/g, "/");
  const publicMarker = "/public/";
  const publicIdx = normalized.indexOf(publicMarker);
  if(publicIdx !== -1){
    return normalized.slice(publicIdx + "/public".length);
  }
  if(normalized.startsWith("./public/")){
    return `/${normalized.slice("./public".length)}`;
  }
  if(normalized.startsWith("public/")){
    return `/${normalized.slice("public".length)}`;
  }
  if(normalized.startsWith("/")){
    return normalized;
  }
  if(normalized.startsWith("./")){
    return `/${normalized.slice(2)}`;
  }
  return `/${normalized}`;
};

const getDeployBaseUrl = () => {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
};

const resolveTelegramVideoSource = () => {
  if(TELEGRAM_VIDEO_URL) return TELEGRAM_VIDEO_URL;
  if(isHttpUrl(TELEGRAM_VIDEO_PATH)) return TELEGRAM_VIDEO_PATH;
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(TELEGRAM_VIDEO_PATH);
  const localPath = (path.isAbsolute(TELEGRAM_VIDEO_PATH) || isWindowsAbs)
    ? TELEGRAM_VIDEO_PATH
    : path.join(__dirname, TELEGRAM_VIDEO_PATH);
  if(fs.existsSync(localPath)) return localPath;
  const baseUrl = getDeployBaseUrl();
  const publicPath = toPublicUrlPath(TELEGRAM_VIDEO_PATH);
  if(baseUrl && publicPath){
    try{
      return new URL(publicPath, baseUrl).toString();
    }catch(err){
      return null;
    }
  }
  return null;
};

const alignToIntervalMs = (timestampMs, intervalMs) => {
  return Math.floor(timestampMs / intervalMs) * intervalMs;
};

const getCycleWindow = (timestampMs = Date.now()) => {
  const intervalMs = CYCLE_INTERVAL_MINUTES * 60 * 1000;
  const startsAtMs = alignToIntervalMs(timestampMs, intervalMs);
  const endsAtMs = startsAtMs + intervalMs;
  return {
    startsAt:new Date(startsAtMs).toISOString(),
    endsAt:new Date(endsAtMs).toISOString(),
    startsAtMs,
    endsAtMs,
    windowId:`w_${startsAtMs.toString(36)}`
  };
};

const tryAcquireCycleLock = async (windowId) => {
  if(!db) return true;
  const lockRef = db.collection("locks").doc(`cycle_${windowId}`);
  const now = Date.now();
  try{
    await db.runTransaction(async (t) => {
      const snap = await t.get(lockRef);
      const data = snap.exists ? snap.data() : null;
      const status = data?.status || null;
      const startedAtMs = data?.startedAt ? Date.parse(data.startedAt) : 0;
      const isStale = !startedAtMs || (now - startedAtMs) > CYCLE_LOCK_TTL_MS;
      if(status === "completed") throw new Error("DONE");
      if(status === "processing" && !isStale) throw new Error("LOCKED");
      t.set(lockRef, {status:"processing", startedAt:new Date(now).toISOString()}, {merge:true});
    });
    return true;
  }catch(err){
    if(err?.message === "LOCKED" || err?.message === "DONE") return false;
    logger.warn("Failed to acquire cycle lock", {windowId, error:err.message});
    return false;
  }
};

const completeCycleLock = async (windowId, cycleId) => {
  if(!db) return;
  try{
    await db.collection("locks").doc(`cycle_${windowId}`).set({
      status:"completed",
      completedAt:nowIso(),
      cycleId
    }, {merge:true});
  }catch(err){
    logger.warn("Failed to complete cycle lock", {windowId, error:err.message});
  }
};

const resetCycleStateIfNeeded = async () => {
  if(!db || !CYCLE_RESET_VERSION) return false;
  const resetRef = db.collection("config").doc("cycleReset");
  try{
    const snap = await resetRef.get();
    if(snap.exists && snap.data()?.version === CYCLE_RESET_VERSION) return false;
    await db.runTransaction(async (t) => {
      const current = await t.get(resetRef);
      if(current.exists && current.data()?.version === CYCLE_RESET_VERSION) return;
      t.set(resetRef, {version:CYCLE_RESET_VERSION, at:nowIso()}, {merge:true});
      t.delete(db.collection("state").doc("latest"));
    });
    inMem.state = null;
    return true;
  }catch(err){
    logger.warn("Failed to reset cycle state", {error:err.message});
    return false;
  }
};

const defaultCounts = () => ({ALIGN:0,REJECT:0,WITHHOLD:0});

const sanitizeActorId = (raw, req) => {
  const base = (raw || req.ip || "anon").toString().slice(0,64);
  return base.replace(/[^a-zA-Z0-9_-]/g,"_");
};

const verifyWalletSignature = ({wallet, message, signature}) => {
  try{
    if(!wallet || !message || !signature) return false;
    const walletPubkey = new PublicKey(wallet);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const verified = walletPubkey.verify(messageBytes, signatureBytes);
    return verified;
  }catch(err){
    logger.error("Signature verification failed", {error:err.message, wallet});
    return false;
  }
};

const buildVoteMessage = ({cycleId, stance, endsAt}) => {
  return `KAIRO VOTE\ncycleId: ${cycleId}\nstance: ${stance}\nexpires: ${endsAt}`;
};

const getTokenBalance = async (wallet) => {
  if(!TOKEN_MINT_ADDRESS || !SOLANA_RPC_URL) return 0;
  try{
    const connection = getSolanaConnection();
    if(!connection) return 0;
    const walletPubkey = new PublicKey(wallet);
    const mintPubkey = new PublicKey(TOKEN_MINT_ADDRESS);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint:mintPubkey
    });
    if(tokenAccounts.value.length === 0) return 0;
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    return balance || 0;
  }catch(err){
    logger.error("Failed to fetch token balance", {wallet, error:err.message});
    return 0;
  }
};

const isEligibleToVote = async (wallet) => {
  if(!ENABLE_TOKEN_GATING){
    return {eligible:true, reason:"token_gating_disabled"};
  }
  if(!TOKEN_MINT_ADDRESS){
    logger.warn("Token gating enabled but no mint address configured");
    return {eligible:true, reason:"no_token_configured"};
  }
  const balance = await getTokenBalance(wallet);
  const eligible = balance >= TOKEN_MIN_BALANCE;
  return {
    eligible,
    balance,
    minRequired:TOKEN_MIN_BALANCE,
    reason:eligible ? "sufficient_balance" : "insufficient_balance"
  };
};

const getWalletReputation = async (wallet) => {
  try{
    if(db){
      const reputationDoc = await db.collection("walletReputation").doc(wallet).get();
      if(reputationDoc.exists){
        const data = reputationDoc.data();
        return {
          wallet,
          firstSeen:data.firstSeen || nowIso(),
          lastSeen:data.lastSeen || nowIso(),
          totalVotes:data.totalVotes || 0,
          consecutiveDays:data.consecutiveDays || 0,
          reputationScore:data.reputationScore || 0,
          flagged:data.flagged || false,
          flags:data.flags || []
        };
      }
    }else{
      if(inMem.reputation && inMem.reputation[wallet]){
        return inMem.reputation[wallet];
      }
    }
    return {
      wallet,
      firstSeen:nowIso(),
      lastSeen:nowIso(),
      totalVotes:0,
      consecutiveDays:0,
      reputationScore:0,
      flagged:false,
      flags:[]
    };
  }catch(err){
    logger.error("Failed to fetch wallet reputation", {wallet, error:err.message});
    return {wallet, firstSeen:nowIso(), lastSeen:nowIso(), totalVotes:0, consecutiveDays:0, reputationScore:0, flagged:false, flags:[]};
  }
};

const updateWalletReputation = async (wallet) => {
  try{
    const rep = await getWalletReputation(wallet);
    const now = nowIso();
    const daysSinceFirst = rep.firstSeen ? Math.floor((Date.now() - Date.parse(rep.firstSeen)) / (1000 * 60 * 60 * 24)) : 0;
    const reputationScore = Math.min(100, daysSinceFirst * 2 + rep.totalVotes * 0.5);

    const updated = {
      wallet,
      firstSeen:rep.firstSeen || now,
      lastSeen:now,
      totalVotes:rep.totalVotes + 1,
      consecutiveDays:rep.consecutiveDays,
      reputationScore,
      flagged:rep.flagged,
      flags:rep.flags || []
    };

    if(db){
      await db.collection("walletReputation").doc(wallet).set(updated, {merge:true});
    }else{
      if(!inMem.reputation) inMem.reputation = {};
      inMem.reputation[wallet] = updated;
    }

    return updated;
  }catch(err){
    logger.error("Failed to update wallet reputation", {wallet, error:err.message});
  }
};

const getProgressiveRateLimit = (reputationScore) => {
  if(reputationScore >= 80) return {maxRequests:20, windowMs:60000, tier:"trusted"};
  if(reputationScore >= 50) return {maxRequests:12, windowMs:60000, tier:"established"};
  if(reputationScore >= 20) return {maxRequests:8, windowMs:60000, tier:"regular"};
  return {maxRequests:3, windowMs:60000, tier:"new"};
};

const recordVotePattern = async ({wallet, cycleId, stance, timestamp}) => {
  try{
    const pattern = {
      wallet,
      cycleId,
      stance,
      timestamp: timestamp || nowIso(),
      timestampMs: Date.now()
    };

    if(db){
      await db.collection("votePatterns").add(pattern);
    }else{
      const key = `${cycleId}_${wallet}`;
      inMem.anomalyDetection.patterns.set(key, pattern);
    }
  }catch(err){
    logger.error("Failed to record vote pattern", {wallet, error:err.message});
  }
};

const detectCoordinatedVoting = async (cycleId, windowMs = 30000) => {
  try{
    const now = Date.now();
    const windowStart = now - windowMs;
    let recentVotes = [];

    if(db){
      const snap = await db.collection("votePatterns")
        .where("cycleId", "==", cycleId)
        .where("timestampMs", ">", windowStart)
        .get();
      recentVotes = snap.docs.map(doc => doc.data());
    }else{
      const patterns = Array.from(inMem.anomalyDetection.patterns.values());
      recentVotes = patterns.filter(p => p.cycleId === cycleId && p.timestampMs > windowStart);
    }

    if(recentVotes.length < 5) return {coordinated:false, count:0};

    const stanceGroups = {};
    recentVotes.forEach(vote => {
      if(!stanceGroups[vote.stance]) stanceGroups[vote.stance] = [];
      stanceGroups[vote.stance].push(vote);
    });

    for(const stance in stanceGroups){
      const group = stanceGroups[stance];
      if(group.length >= 5){
        const timestamps = group.map(v => v.timestampMs).sort();
        const firstTimestamp = timestamps[0];
        const lastTimestamp = timestamps[timestamps.length - 1];
        const spread = lastTimestamp - firstTimestamp;

        if(spread < 10000){
          logger.warn("Coordinated voting detected", {
            cycleId,
            stance,
            count:group.length,
            spreadMs:spread,
            wallets:group.map(v => v.wallet)
          });
          return {coordinated:true, count:group.length, stance, wallets:group.map(v => v.wallet)};
        }
      }
    }

    return {coordinated:false, count:0};
  }catch(err){
    logger.error("Failed to detect coordinated voting", {cycleId, error:err.message});
    return {coordinated:false, count:0};
  }
};

const detectRapidVoting = async (wallet) => {
  try{
    const now = Date.now();
    const windowStart = now - 300000;
    let voteCount = 0;

    if(db){
      const snap = await db.collection("votePatterns")
        .where("wallet", "==", wallet)
        .where("timestampMs", ">", windowStart)
        .get();
      voteCount = snap.size;
    }else{
      const patterns = Array.from(inMem.anomalyDetection.patterns.values());
      voteCount = patterns.filter(p => p.wallet === wallet && p.timestampMs > windowStart).length;
    }

    if(voteCount > 3){
      logger.warn("Rapid voting detected", {wallet, voteCount, windowMs:300000});
      return {rapid:true, voteCount};
    }

    return {rapid:false, voteCount:0};
  }catch(err){
    logger.error("Failed to detect rapid voting", {wallet, error:err.message});
    return {rapid:false, voteCount:0};
  }
};

const detectBotBehavior = async (wallet, cycleStartTimestamp) => {
  try{
    const pattern = inMem.anomalyDetection.patterns.get(`${wallet}_recent`);
    if(!pattern) return {isBot:false, reason:null};

    const voteTimestamp = Date.now();
    const cycleStartMs = Date.parse(cycleStartTimestamp);
    const timeSinceCycleStart = voteTimestamp - cycleStartMs;

    if(timeSinceCycleStart < 5000){
      logger.warn("Bot behavior detected: immediate voting", {wallet, timeSinceCycleStart});
      return {isBot:true, reason:"immediate_voting", timeSinceCycleStart};
    }

    return {isBot:false, reason:null};
  }catch(err){
    logger.error("Failed to detect bot behavior", {wallet, error:err.message});
    return {isBot:false, reason:null};
  }
};

const flagWallet = async (wallet, reason) => {
  try{
    const reputation = await getWalletReputation(wallet);
    const updatedFlags = [...(reputation.flags || []), {reason, at:nowIso()}];

    if(db){
      await db.collection("walletReputation").doc(wallet).set({
        flagged:true,
        flags:updatedFlags
      }, {merge:true});
    }else{
      if(!inMem.reputation[wallet]) inMem.reputation[wallet] = reputation;
      inMem.reputation[wallet].flagged = true;
      inMem.reputation[wallet].flags = updatedFlags;
      inMem.anomalyDetection.flaggedWallets.add(wallet);
    }

    logger.info("Wallet flagged", {wallet, reason, totalFlags:updatedFlags.length});
  }catch(err){
    logger.error("Failed to flag wallet", {wallet, error:err.message});
  }
};

const runAnomalyDetection = async ({wallet, cycleId, stance, cycleStartTimestamp}) => {
  try{
    const [coordinated, rapid, bot] = await Promise.all([
      detectCoordinatedVoting(cycleId),
      detectRapidVoting(wallet),
      detectBotBehavior(wallet, cycleStartTimestamp)
    ]);

    const anomalies = [];

    if(coordinated.coordinated){
      anomalies.push({type:"coordinated_voting", ...coordinated});
      if(coordinated.wallets && coordinated.wallets.includes(wallet)){
        await flagWallet(wallet, "coordinated_voting");
      }
    }

    if(rapid.rapid){
      anomalies.push({type:"rapid_voting", ...rapid});
      await flagWallet(wallet, "rapid_voting");
    }

    if(bot.isBot){
      anomalies.push({type:"bot_behavior", ...bot});
      await flagWallet(wallet, bot.reason);
    }

    if(anomalies.length > 0){
      logger.warn("Anomalies detected", {wallet, cycleId, anomalies});
    }

    return {detected:anomalies.length > 0, anomalies};
  }catch(err){
    logger.error("Failed to run anomaly detection", {wallet, cycleId, error:err.message});
    return {detected:false, anomalies:[]};
  }
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

const stripPresentationLines = (text) => {
  if(!text) return "";
  const banned = /^(ALIGN|REJECT|WITHHOLD|AUDIT|THESIS|CONSEQUENCE)\b/i;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => !banned.test(line)).join("\n").trim();
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

const getCreatorFeeOverrideLamports = () => {
  const rawLamports = process.env.CREATOR_FEE_LAMPORTS_OVERRIDE;
  if(rawLamports){
    const value = Number(rawLamports);
    if(Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  const rawSol = process.env.CREATOR_FEE_SOL_OVERRIDE;
  if(rawSol){
    const value = Number(rawSol);
    if(Number.isFinite(value) && value > 0) return Math.floor(value * 1e9);
  }
  return null;
};

const toLamportsNumber = (value) => {
  if(typeof value === "number") return Math.floor(value);
  if(typeof value === "bigint") return Number(value);
  if(typeof value?.toNumber === "function") return Math.floor(value.toNumber());
  if(typeof value?.toString === "function"){
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
  }
  return 0;
};

const getSolanaConnection = () => {
  if(!SOLANA_RPC_URL) return null;
  return new Connection(SOLANA_RPC_URL, {commitment:"confirmed"});
};

const parseSecretKey = (raw) => {
  const trimmed = (raw || "").trim();
  if(!trimmed) return null;
  if(trimmed.startsWith("[")){
    const parsed = JSON.parse(trimmed);
    if(Array.isArray(parsed)) return Uint8Array.from(parsed);
  }
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
  if(isBase58){
    try{
      return bs58.decode(trimmed);
    }catch(err){
      // fall through
    }
  }
  try{
    const parsed = JSON.parse(trimmed);
    if(Array.isArray(parsed)) return Uint8Array.from(parsed);
  }catch(err){
    // fall through
  }
  try{
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length ? Uint8Array.from(decoded) : null;
  }catch(err){
    return null;
  }
};

const getDeployerKeypair = () => {
  const raw = process.env.DEPLOYER_WALLET_KEY || process.env.SOLANA_DEPLOYER_WALLET_KEY || "";
  const secret = parseSecretKey(raw);
  if(!secret) return null;
  try{
    return Keypair.fromSecretKey(secret);
  }catch(err){
    return null;
  }
};

const getDeployerPublicKey = (keypair) => {
  const raw = process.env.SOLANA_DEPLOYER_WALLET || process.env.DEPLOYER_WALLET || "";
  if(raw){
    try{
      return new PublicKey(raw);
    }catch(err){
      // fall through
    }
  }
  return keypair?.publicKey || null;
};

const resolvePumpFunSdk = async ({connection, payer}) => {
  const tryFactory = async (factory) => {
    const tryCall = async (value) => {
      try{
        return await factory(value);
      }catch(err){
        return null;
      }
    };
    const tryNew = (valueA, valueB) => {
      try{
        return new factory(valueA, valueB);
      }catch(err){
        return null;
      }
    };
    return (
      (await tryCall({connection, payer})) ||
      tryNew(connection) ||
      tryNew({connection, payer}) ||
      tryNew(connection, payer) ||
      (await tryCall(connection))
    );
  };

  let sdk = null;
  if(PUMPFUN_SDK_MODULE){
    try{
      const mod = await import(PUMPFUN_SDK_MODULE);
      const factory = mod[PUMPFUN_SDK_FACTORY] || mod.PumpFunSDK || mod.default;
      if(factory) sdk = await tryFactory(factory);
    }catch(err){
      // fall through
    }
  }else{
    try{
      sdk = new OnlinePumpSdk(connection);
    }catch(err){
      sdk = null;
    }
  }
  if(typeof sdk.getCreatorVaultBalanceBothPrograms !== "function") return null;
  if(typeof sdk.collectCoinCreatorFeeInstructions !== "function") return null;
  return sdk;
};

const unwrapInstructions = (value) => {
  if(!value) return [];
  if(Array.isArray(value)) return value;
  if(Array.isArray(value.instructions)) return value.instructions;
  if(Array.isArray(value.value)) return value.value;
  return [];
};

const claimCreatorFees = async ({connection, payer}) => {
  const override = getCreatorFeeOverrideLamports();
  if(override !== null){
    return {claimedLamports:override, signature:null, source:"override"};
  }
  const sdk = await resolvePumpFunSdk({connection, payer});
  if(!sdk){
    return {claimedLamports:0, signature:null, source:"none"};
  }
  const owner = getDeployerPublicKey(payer);
  if(!owner){
    return {claimedLamports:0, signature:null, source:"none"};
  }
  const before = toLamportsNumber(await sdk.getCreatorVaultBalanceBothPrograms(owner));
  if(before <= 0){
    return {claimedLamports:0, signature:null, source:"pumpfun"};
  }
  const instructionsRaw = await sdk.collectCoinCreatorFeeInstructions(owner);
  const instructions = unwrapInstructions(instructionsRaw);
  if(!instructions.length){
    return {claimedLamports:0, signature:null, source:"pumpfun"};
  }
  const tx = new Transaction().add(...instructions);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], {commitment:"confirmed"});
  return {claimedLamports:before, signature, source:"pumpfun"};
};

const chunkItems = (items, size) => {
  const out = [];
  for(let i = 0; i < items.length; i += size){
    out.push(items.slice(i, i + size));
  }
  return out;
};

const sendSolPayouts = async ({connection, payer, recipients, lamports}) => {
  const chunkSize = Math.max(1, MAX_SOL_TRANSFERS_PER_TX);
  const batches = chunkItems(recipients, chunkSize);
  const signatures = [];
  for(const batch of batches){
    const tx = new Transaction();
    batch.forEach((recipient) => {
      tx.add(SystemProgram.transfer({
        fromPubkey:payer.publicKey,
        toPubkey:recipient,
        lamports
      }));
    });
    const signature = await sendAndConfirmTransaction(connection, tx, [payer], {commitment:"confirmed"});
    signatures.push(signature);
  }
  return signatures;
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

const DEFAULT_DOCTRINE_VERSION = "v1";
let doctrineCache = null;
let doctrineVersionCache = null;

const loadDoctrine = () => {
  if(doctrineCache !== null) return doctrineCache;
  try{
    doctrineCache = fs.readFileSync(DOCTRINE_CONFIG_PATH, "utf8").trim();
  }catch(err){
    doctrineCache = "";
  }
  if(doctrineCache){
    const match = doctrineCache.match(/^Version:\s*(.+)$/mi);
    doctrineVersionCache = match ? match[1].trim() : null;
  }
  return doctrineCache;
};

const getDoctrineVersion = () => {
  if(doctrineVersionCache) return doctrineVersionCache;
  loadDoctrine();
  return doctrineVersionCache || DEFAULT_DOCTRINE_VERSION;
};

const buildDoctrineBlock = () => {
  const doctrine = loadDoctrine();
  if(!doctrine) return "DOCTRINE: NONE";
  return `DOCTRINE:\n${doctrine}`;
};

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

let topicsConfigCache = null;
let seedConceptsConfigCache = null;

const loadTopicsConfig = (forceReload = false) => {
  if(topicsConfigCache && !forceReload) return topicsConfigCache;
  let result;
  try{
    const raw = fs.readFileSync(TOPICS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.topics) ? parsed.topics : [];
    const normalized = entries.map(normalizeTopicEntry).filter(Boolean);
    if(normalized.length){
      result = {topics:normalized, version:parsed?.version || null};
    }
  }catch(err){
    logger.debug("Topics config load failed, using defaults", {error:err.message});
  }
  if(!result){
    const fallback = DEFAULT_TOPICS.map((topic) => ({
      id:topic.key,
      label:topic.key,
      category:topic.category,
      tags:[]
    }));
    result = {topics:fallback, version:null};
  }
  topicsConfigCache = result;
  return result;
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

const loadSeedConceptsConfig = (forceReload = false) => {
  if(seedConceptsConfigCache && !forceReload) return seedConceptsConfigCache;
  let result;
  try{
    const raw = fs.readFileSync(SEED_CONCEPTS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.seedConcepts) ? parsed.seedConcepts : [];
    const normalized = entries.map(normalizeSeedEntry).filter(Boolean);
    if(normalized.length){
      result = {seedConcepts:normalized, version:parsed?.version || null};
    }
  }catch(err){
    logger.debug("Seed concepts config load failed, using defaults", {error:err.message});
  }
  if(!result){
    const fallback = DEFAULT_SEED_CONCEPTS.map((label) => ({
      id:slugify(label),
      label,
      tags:[]
    }));
    result = {seedConcepts:fallback, version:null};
  }
  seedConceptsConfigCache = result;
  return result;
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
      lastTopic:bags.lastTopic || null,
      lastTopicCategory:bags.lastTopicCategory || null
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
    lastTopic:bags?.lastTopic || null,
    lastTopicCategory:bags?.lastTopicCategory || null
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
  const lastCategory = bags.lastTopicCategory || null;

  // Try to pick a topic from a different category than last time for more variety
  let attempts = 0;
  while(bags.topicsBag.length && attempts < 10){
    const candidate = bags.topicsBag.shift();
    const candidateMeta = topicMap.get(candidate);
    const candidateCategory = candidateMeta?.category || "misc";

    // Skip if same as last topic OR (same category as last AND we have other options)
    if(candidate === bags.lastTopic){
      attempts++;
      continue;
    }
    if(lastCategory && candidateCategory === lastCategory && bags.topicsBag.length > 5){
      // Put it back at the end if we have plenty of options left
      bags.topicsBag.push(candidate);
      attempts++;
      continue;
    }
    topicId = candidate;
    break;
  }

  // If we didn't find one, reshuffle and pick fresh
  if(!topicId){
    bags.topicsBag = shuffle(topicsList.map((t) => t.id));
    topicId = bags.topicsBag.shift();
  }

  const topicMeta = topicMap.get(topicId) || {id:topicId, label:topicId, category:"misc", tags:[]};
  bags.lastTopic = topicId;
  bags.lastTopicCategory = topicMeta.category;

  if(!bags.seedBag.length) bags.seedBag = shuffle(seedsList.map((s) => s.id));
  const seedId = bags.seedBag.shift();
  await saveBags(bags);

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

const DRAFT_LINE_LIMIT = 3;
const FINAL_LINE_LIMIT = 3;

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

const buildOpusDraftPrompt = ({topicLabel, topicCategory, seedConcept, lastSummary, priorContext}) => {
  const topicLine = topicCategory ? `${topicLabel} (${topicCategory})` : topicLabel;
  const doctrineBlock = buildDoctrineBlock();
  const parts = [
    `TOPIC: ${topicLine}`,
    `SEED: ${seedConcept}`,
    `LAST SUMMARY: ${lastSummary || "NONE"}`
  ];
  if(priorContext && priorContext.length > 20){
    parts.push(`PRIOR CONTEXT: ${priorContext}`);
  }
  parts.push(doctrineBlock);
  parts.push("Constraint: The doctrine is canonical. Do not contradict it.");
  parts.push("Variety Requirement: Each transmission must explore the topic from a fresh angle. Consider different: temporal frames (present/near future/distant future), scales (individual/community/civilization), mechanisms (economic/social/technological), or tones (observational/prophetic/structural).");
  parts.push("Instruction: Draft 2-3 short lines as a single transmission. No labels, no bullet or numbered lists, no explicit option words (ALIGN/REJECT/WITHHOLD). Avoid repeating phrasing patterns from recent transmissions.");
  return parts.join("\n");
};

const buildAuditorCritiquePrompt = ({draft, recentSummaries, recentTopics}) => {
  const summaries = (recentSummaries || []).slice(0, 12).join("\n");
  const topics = (recentTopics || []).slice(0, 12).join(", ");
  const doctrineBlock = buildDoctrineBlock();
  return [
    doctrineBlock,
    "RECENT SUMMARIES:",
    summaries || "NONE",
    `RECENT TOPICS: ${topics || "NONE"}`,
    "DRAFT:",
    draft,
    "Instruction: Check the draft against the doctrine. If any contradiction exists, set contradictionRisk=true and integrity=LOW.",
    "Return JSON: {\"issues\":[...],\"requiredChanges\":[...],\"flags\":{\"repeatRisk\":true/false,\"contradictionRisk\":true/false},\"integrity\":\"LOW|MED|HIGH\"}."
  ].join("\n");
};

const buildOpusRevisionPrompt = ({draft, requiredChanges, avoidPhrases, reroll}) => {
  const changes = (requiredChanges || []).map((c) => `- ${c}`).join("\n") || "NONE";
  const avoid = (avoidPhrases || []).map((p) => `- ${p}`).join("\n") || "NONE";
  const doctrineBlock = buildDoctrineBlock();
  const varietyHint = reroll
    ? "Choose a different angle within the same topic. Consider shifting: temporal perspective, scale, mechanism of action, or narrative framing. Use fresh vocabulary and sentence structures."
    : "Ensure linguistic variety. Avoid repeating sentence patterns or word combinations from the avoid list.";
  return [
    doctrineBlock,
    "Constraint: The doctrine is canonical. Do not contradict it.",
    "DRAFT:",
    draft,
    "REQUIRED CHANGES:",
    changes,
    "AVOID PHRASES:",
    avoid,
    `Variety Guidance: ${varietyHint}`,
    `Instruction: Produce the final transmission in 2-3 lines. No labels, no bullet or numbered lists, no explicit option words (ALIGN/REJECT/WITHHOLD).`
  ].join("\n");
};

const buildAuditorApprovePrompt = ({finalText}) => {
  const doctrineBlock = buildDoctrineBlock();
  return [
    doctrineBlock,
    "FINAL:",
    finalText,
    `Instruction: Return JSON: {"approve":true/false,"integrity":"LOW|MED|HIGH","trace":"AUDIT: ..."}.
Approve=false if repetition risk is high or doctrine is contradicted. If doctrine is contradicted, set integrity=LOW.`
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
    lastSummary,
    priorContext:priorMemory
  });
  let draft = await getOpusText({
    system:buildOpusSystem(),
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
    system:buildAuditorSystem(),
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
    system:buildOpusSystem(),
    user:revisionPrompt,
    maxTokens:MAX_REVISION_TOKENS,
    temperature:0.7
  });
  revision = stripPresentationLines(clampLines(revision, FINAL_LINE_LIMIT));

  let repeatGate = computeRepeatRisk(revision, memory);
  const approvePrompt = buildAuditorApprovePrompt({finalText:revision});
  const approveRaw = await getAuditorText({
    system:buildAuditorSystem(),
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
      system:buildOpusSystem(),
      user:rerollPrompt,
      maxTokens:MAX_REVISION_TOKENS,
      temperature:0.7
    });
    reroll = stripPresentationLines(clampLines(reroll, FINAL_LINE_LIMIT));
    if(reroll){
      revision = reroll;
      repeatGate = computeRepeatRisk(revision, memory);
      const approveRaw2 = await getAuditorText({
        system:buildAuditorSystem(),
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
    const fallback = stripPresentationLines(memory.lastFull[0] || "") || "NO TRANSMISSION AVAILABLE";
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

const loadServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) return null;
  try{
    return JSON.parse(raw);
  }catch(err){
    // fall through
  }
  try{
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  }catch(err){
    return null;
  }
};

const initFirebase = () => {
  if(db) return;
  if(admin.apps?.length){
    db = admin.firestore();
    return;
  }
  if(!(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT)) return;
  try{
    const serviceAccount = loadServiceAccount();
    const projectId = process.env.FIREBASE_PROJECT_ID || serviceAccount?.project_id;
    const credential = serviceAccount
      ? admin.credential.cert(serviceAccount)
      : admin.credential.applicationDefault();
    admin.initializeApp({credential, projectId});
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

const updateCycleCreatorFees = async (cycleId, payload) => {
  if(db){
    await db.collection("cycles").doc(cycleId).set({creatorFees:payload}, {merge:true});
    return;
  }
  const existing = inMem.cycles.get(cycleId);
  if(existing){
    existing.creatorFees = payload;
    inMem.cycles.set(cycleId, existing);
  }
};

const tryStartCreatorFees = async (cycleId) => {
  if(db){
    try{
      await db.runTransaction(async (t) => {
        const ref = db.collection("cycles").doc(cycleId);
        const snap = await t.get(ref);
        const status = snap.data()?.creatorFees?.status;
        if(status === "processing" || status === "completed") throw new Error("LOCKED");
        t.set(ref, {creatorFees:{status:"processing", startedAt:nowIso()}}, {merge:true});
      });
      return true;
    }catch(err){
      if(err?.message === "LOCKED") return false;
      return false;
    }
  }
  const existing = inMem.cycles.get(cycleId);
  if(existing?.creatorFees?.status) return false;
  if(existing){
    existing.creatorFees = {status:"processing", startedAt:nowIso()};
    inMem.cycles.set(cycleId, existing);
  }
  return true;
};

const distributeCreatorFees = async ({cycleId, reward}) => {
  if(!reward?.winners?.length) return;
  if(CREATOR_FEE_SHARE_BPS <= 0) return;
  const started = await tryStartCreatorFees(cycleId);
  if(!started) return;

  const connection = getSolanaConnection();
  if(!connection){
    await updateCycleCreatorFees(cycleId, {status:"skipped", reason:"NO_RPC", at:nowIso()});
    return;
  }
  const payer = getDeployerKeypair();
  if(!payer){
    await updateCycleCreatorFees(cycleId, {status:"skipped", reason:"NO_DEPLOYER_KEY", at:nowIso()});
    return;
  }

  const winnerSet = new Set(reward.winners);
  const recipients = [];
  winnerSet.forEach((wallet) => {
    try{
      recipients.push(new PublicKey(wallet));
    }catch(err){
      // ignore invalid key
    }
  });

  if(!recipients.length){
    await updateCycleCreatorFees(cycleId, {status:"skipped", reason:"NO_VALID_WINNERS", at:nowIso()});
    return;
  }

  try{
    const claim = await claimCreatorFees({connection, payer});
    const claimedLamports = claim.claimedLamports || 0;
    if(claimedLamports <= 0){
      await updateCycleCreatorFees(cycleId, {
        status:"skipped",
        reason:"NO_FEES",
        claimedLamports:0,
        claimSource:claim.source || "none",
        at:nowIso()
      });
      return;
    }

    const poolLamports = Math.floor((claimedLamports * CREATOR_FEE_SHARE_BPS) / 10000);
    const perWinnerLamports = Math.floor(poolLamports / recipients.length);
    if(perWinnerLamports < CREATOR_FEE_MIN_LAMPORTS){
      await updateCycleCreatorFees(cycleId, {
        status:"skipped",
        reason:"DUST",
        claimedLamports,
        poolLamports,
        perWinnerLamports,
        claimSignature:claim.signature || null,
        claimSource:claim.source || "unknown",
        at:nowIso()
      });
      return;
    }

    const signatures = await sendSolPayouts({
      connection,
      payer,
      recipients,
      lamports:perWinnerLamports
    });

    await updateCycleCreatorFees(cycleId, {
      status:"completed",
      claimedLamports,
      poolLamports,
      perWinnerLamports,
      winnersCount:recipients.length,
      claimSignature:claim.signature || null,
      claimSource:claim.source || "unknown",
      payoutSignatures:signatures,
      completedAt:nowIso()
    });

    await recordEvent({
      type:"CREATOR_FEES_DISTRIBUTED",
      cycleId,
      actorId:null,
      at:nowIso(),
      payload:{
        claimedLamports,
        poolLamports,
        perWinnerLamports,
        winnersCount:recipients.length,
        payoutSignatures:signatures
      }
    });
  }catch(err){
    await updateCycleCreatorFees(cycleId, {
      status:"failed",
      reason:"ERROR",
      message:(err?.message || "ERROR").toString().slice(0,160),
      at:nowIso()
    });
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

const selectWeightedRandomOption = (counts) => {
  const entries = ["ALIGN","REJECT","WITHHOLD"].map((k) => ({key:k, count:counts[k] || 0}));
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if(total === 0){
    const fallback = entries[Math.floor(Math.random() * entries.length)].key;
    logger.info("No votes, selecting random fallback", {option:fallback});
    return fallback;
  }
  const rand = Math.random() * total;
  let cumulative = 0;
  for(const entry of entries){
    cumulative += entry.count;
    if(rand < cumulative){
      logger.info("Selected weighted option", {
        option:entry.key,
        count:entry.count,
        total,
        probability:(entry.count / total * 100).toFixed(1) + "%"
      });
      return entry.key;
    }
  }
  return entries[entries.length - 1].key;
};

const finalizeCycle = async (state) => {
  if(!state?.cycleId) return null;
  const existing = await getCycleDoc(state.cycleId);
  if(existing?.reward?.finalized){
    await distributeCreatorFees({cycleId:state.cycleId, reward:existing.reward});
    return null;
  }
  const counts = state.stanceCounts || defaultCounts();
  const option = selectWeightedRandomOption(counts);
  const actors = await fetchStancesByOption(state.cycleId, option);
  if(actors.length === 0){
    logger.warn("No actors found for winning option", {cycleId:state.cycleId, option});
    return null;
  }
  const winners = pickRandomGroup(actors, Math.min(WINNERS_PER_CYCLE, actors.length));
  const reward = {
    option,
    winners,
    poolPercent:50,
    at:nowIso(),
    finalized:true,
    voteCounts:counts
  };
  await setCycleReward(state.cycleId, reward);
  await distributeCreatorFees({cycleId:state.cycleId, reward});
  await recordEvent({
    type:"REWARD_SELECTED",
    cycleId:state.cycleId,
    actorId:null,
    at:nowIso(),
    payload:{option, winnerCount:winners.length, counts}
  });

  // Post winner announcement to Telegram
  await postWinnerToTelegram({
    winnerOption:option,
    cycleIndex:state.cycleIndex || 0,
    cycleId:state.cycleId
  });

  return reward;
};

const getWinnerMessage = (option) => {
  const messages = {
    ALIGN: "Alignment proves fruitful",
    REJECT: "Rejection bears reward",
    WITHHOLD: "Withholding from action becomes action in itself"
  };
  return messages[option] || "";
};

const postToTelegram = async ({transmission, cycleIndex, cycleId}) => {
  if(!TELEGRAM_POSTING_ENABLED){
    logger.debug("Telegram posting disabled");
    return;
  }
  if(!telegramBot || !TELEGRAM_CHANNEL_ID){
    logger.warn("Telegram not configured", {
      hasToken:Boolean(TELEGRAM_BOT_TOKEN),
      channelId:TELEGRAM_CHANNEL_ID
    });
    return;
  }

  try{
    const videoSource = resolveTelegramVideoSource();
    if(!videoSource){
      logger.error("Telegram video source not found", {
        videoPath:TELEGRAM_VIDEO_PATH,
        videoUrl:TELEGRAM_VIDEO_URL
      });
      return;
    }

    const caption = `TRANSMISSION - CYCLE ${cycleIndex}\n\n${transmission}\n\n#KAIRO #CYCLE${cycleIndex}`;

    await telegramBot.sendVideo(TELEGRAM_CHANNEL_ID, videoSource, {caption});

    logger.info("Posted to Telegram", {cycleId, cycleIndex, channelId: TELEGRAM_CHANNEL_ID});
  }catch(err){
    logger.error("Failed to post to Telegram", {
      error: err.message,
      cycleId,
      channelId: TELEGRAM_CHANNEL_ID
    });
  }
};

const postWinnerToTelegram = async ({winnerOption, cycleIndex, cycleId}) => {
  if(!TELEGRAM_POSTING_ENABLED){
    logger.debug("Telegram posting disabled");
    return;
  }
  if(!telegramBot || !TELEGRAM_CHANNEL_ID){
    logger.warn("Telegram not configured for winner announcement", {
      hasToken:Boolean(TELEGRAM_BOT_TOKEN),
      channelId:TELEGRAM_CHANNEL_ID
    });
    return;
  }

  try{
    const winnerMsg = getWinnerMessage(winnerOption);
    if(!winnerMsg){
      logger.warn("No winner message for option", {option: winnerOption});
      return;
    }

    const message = `${winnerMsg}\n\n#KAIRO #CYCLE${cycleIndex}`;

    await telegramBot.sendMessage(TELEGRAM_CHANNEL_ID, message);

    logger.info("Posted winner to Telegram", {cycleId, cycleIndex, option: winnerOption, channelId: TELEGRAM_CHANNEL_ID});
  }catch(err){
    logger.error("Failed to post winner to Telegram", {
      error: err.message,
      cycleId,
      option: winnerOption,
      channelId: TELEGRAM_CHANNEL_ID
    });
  }
};

const generateCycle = async ({seed, createdBy, cycleWindow}) => {
  const prior = await getLatestState();
  await finalizeCycle(prior);
  const priorMemory = prior?.memory || "";
  const stanceCounts = defaultCounts();
  const cycleIndex = prior ? (prior.cycleIndex || 0) + 1 : 0;
  const window = cycleWindow || getCycleWindow();
  const cycleId = `c_${window.startsAtMs.toString(36)}_${randomUUID().slice(0,8)}`;
  const at = window.startsAt;
  const cycleEndsAt = window.endsAt;
  const result = await generateTransmission({priorMemory});
  const transmission = result.transmission;
  const primary = transmission;
  const consensus = transmission;
  const secondary = result.trace || null;
  const deliberation = Array.isArray(result.deliberation) ? result.deliberation : [];
  const deliberationText = deliberation.map((entry) => entry.text).join(" / ");
  const memory = buildMemory(priorMemory, transmission, deliberationText);
  const integrity = result.integrity || "LOW";
  const doctrineVersion = getDoctrineVersion();

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
    doctrineVersion,
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
    doctrineVersion,
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

  // Post to Telegram channel
  await postToTelegram({
    transmission,
    cycleIndex,
    cycleId
  });

  return latest;
};

initFirebase();

const maybeRotateCycle = async () => {
  const currentWindow = getCycleWindow();
  await resetCycleStateIfNeeded();
  const state = await getLatestState();

  if(!state){
    logger.info("No state found, generating boot cycle");
    const acquired = await tryAcquireCycleLock(currentWindow.windowId);
    if(!acquired){
      return await getLatestState();
    }
    const latest = await getLatestState();
    if(latest?.at){
      const latestWindow = getCycleWindow(Date.parse(latest.at) || 0);
      if(latestWindow.windowId === currentWindow.windowId){
        await completeCycleLock(currentWindow.windowId, latest.cycleId);
        return latest;
      }
    }
    const created = await generateCycle({seed:null, createdBy:"boot", cycleWindow:currentWindow});
    await completeCycleLock(currentWindow.windowId, created?.cycleId);
    return created;
  }

  const stateWindowMs = state.at ? Date.parse(state.at) : 0;
  const stateWindow = getCycleWindow(stateWindowMs);

  if(stateWindow.windowId !== currentWindow.windowId){
    logger.info("Window changed, generating new cycle", {
      oldWindow:stateWindow.windowId,
      newWindow:currentWindow.windowId
    });
    const acquired = await tryAcquireCycleLock(currentWindow.windowId);
    if(!acquired){
      logger.warn("Cycle generation already in progress", {windowId:currentWindow.windowId});
      return await getLatestState();
    }
    const latest = await getLatestState();
    if(latest?.at){
      const latestWindow = getCycleWindow(Date.parse(latest.at) || 0);
      if(latestWindow.windowId === currentWindow.windowId){
        await completeCycleLock(currentWindow.windowId, latest.cycleId);
        return latest;
      }
    }
    const created = await generateCycle({seed:null, createdBy:"auto", cycleWindow:currentWindow});
    await completeCycleLock(currentWindow.windowId, created?.cycleId);
    return created;
  }

  if(isLocked(state)){
    logger.warn("Cycle locked but in same window", {cycleId:state.cycleId});
    return generateCycle({seed:null, createdBy:"auto"});
  }

  return state;
};

const runCycleJobs = async () => {
  return maybeRotateCycle();
};

const ensureCycle = async () => {
  await maybeRotateCycle();
};

ensureCycle().catch(() => {});

if(shouldServeDist){
  app.use(express.static(distPath));
}

app.get("/", (req,res) => {
  if(shouldServeDist){
    return res.sendFile(path.join(distPath, "index.html"));
  }
  res.json({status:"KAIRO online"});
});

app.get("/api/last", async (req,res) => {
  try{
    const state = await maybeRotateCycle();
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
        doctrineVersion:getDoctrineVersion(),
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
      doctrineVersion:state.doctrineVersion || getDoctrineVersion(),
      locked,
      stanceCounts:state.stanceCounts || defaultCounts(),
      cycleEndsAt:state.cycleEndsAt || null,
      reward:state.reward || null
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

  const wallet = req.body?.wallet || req.body?.actorId;
  if(!wallet){
    return res.status(401).json({error:"WALLET_REQUIRED"});
  }

  const message = req.body?.message;
  const signature = req.body?.signature;
  if(!message || !signature){
    return res.status(401).json({error:"SIGNATURE_REQUIRED"});
  }

  const verified = verifyWalletSignature({wallet, message, signature});
  if(!verified){
    logger.warn("Invalid signature", {wallet, stance});
    return res.status(401).json({error:"INVALID_SIGNATURE"});
  }

  const eligibility = await isEligibleToVote(wallet);
  if(!eligibility.eligible){
    logger.warn("Wallet not eligible to vote", {wallet, ...eligibility});
    return res.status(403).json({
      error:"NOT_ELIGIBLE",
      reason:eligibility.reason,
      balance:eligibility.balance,
      minRequired:eligibility.minRequired
    });
  }

  const reputation = await getWalletReputation(wallet);
  if(reputation.flagged){
    logger.warn("Flagged wallet attempted vote", {wallet, flags:reputation.flags});
    return res.status(403).json({
      error:"WALLET_FLAGGED",
      reason:"anomaly_detected",
      flags:reputation.flags
    });
  }

  const rateLimit = getProgressiveRateLimit(reputation.reputationScore);
  const actorId = sanitizeActorId(wallet, req);
  const rateKey = `${actorId}`;

  const now = Date.now();
  const windowStart = now - rateLimit.windowMs;
  const hits = rateStore.get(rateKey) || [];
  const recent = hits.filter((t) => t > windowStart);

  if(recent.length >= rateLimit.maxRequests){
    logger.warn("Rate limit exceeded", {
      wallet,
      tier:rateLimit.tier,
      reputationScore:reputation.reputationScore,
      attempts:recent.length,
      limit:rateLimit.maxRequests
    });
    return res.status(429).json({
      error:"RATE_LIMIT",
      tier:rateLimit.tier,
      limit:rateLimit.maxRequests,
      windowMs:rateLimit.windowMs
    });
  }

  recent.push(now);
  rateStore.set(rateKey, recent);

  const state = await getLatestState();
  if(!state){
    return res.status(503).json({error:"NO_CYCLE"});
  }
  if(isLocked(state)){
    return res.status(409).json({error:"LOCKED"});
  }

  const expectedMessage = buildVoteMessage({
    cycleId:state.cycleId,
    stance,
    endsAt:state.cycleEndsAt || ""
  });
  if(message !== expectedMessage){
    logger.warn("Message mismatch", {wallet, expected:expectedMessage, received:message});
    return res.status(401).json({error:"INVALID_MESSAGE"});
  }

  if(state.cycleEndsAt){
    const expiresMs = Date.parse(state.cycleEndsAt);
    if(!Number.isNaN(expiresMs) && Date.now() > expiresMs){
      return res.status(409).json({error:"CYCLE_EXPIRED"});
    }
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
      await updateWalletReputation(wallet);
      await recordVotePattern({wallet, cycleId, stance, timestamp:nowIso()});
      await runAnomalyDetection({wallet, cycleId, stance, cycleStartTimestamp:state.at});
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
    await updateWalletReputation(wallet);
    await recordVotePattern({wallet, cycleId, stance, timestamp:nowIso()});
    await runAnomalyDetection({wallet, cycleId, stance, cycleStartTimestamp:state.at});
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

app.get("/api/health", async (req,res) => {
  const checks = {
    timestamp:nowIso(),
    version:PROJECT_VERSION,
    services:{},
    warnings:[]
  };

  const state = await getLatestState();
  checks.services.database = db ? "firestore" : "in-memory";
  checks.services.ai_primary = anthropic ? "anthropic" : openai ? "openai" : "none";
  checks.services.ai_auditor = openai ? "openai" : "none";

  if(!db){
    checks.warnings.push("Using in-memory storage - data will be lost on restart");
  }

  if(!anthropic && !openai){
    checks.warnings.push("No AI providers configured - transmissions cannot be generated");
  }

  const connection = getSolanaConnection();
  checks.services.solana_rpc = connection ? "connected" : "not_configured";

  if(ENABLE_TOKEN_GATING && !TOKEN_MINT_ADDRESS){
    checks.warnings.push("Token gating enabled but no mint address configured");
  }

  checks.cycle = {
    id:state?.cycleId || null,
    index:state?.cycleIndex || 0,
    locked:state ? isLocked(state) : false,
    endsAt:state?.cycleEndsAt || null,
    integrity:state?.integrity || null
  };

  const currentWindow = getCycleWindow();
  if(state?.at){
    const stateWindowMs = Date.parse(state.at);
    const stateWindow = getCycleWindow(stateWindowMs);
    if(stateWindow.windowId !== currentWindow.windowId){
      checks.warnings.push("Cycle out of sync with current time window");
    }
  }

  const isHealthy = checks.warnings.length === 0 &&
                    checks.services.ai_primary !== "none" &&
                    state?.cycleId;

  res.status(isHealthy ? 200 : 503).json({
    ok:isHealthy,
    ...checks
  });
});

app.get("/api/archive", async (req,res) => {
  try{
    const limit = Math.min(Number(req.query?.limit || 10), 50);
    const cycles = [];

    if(db){
      const snap = await db.collection("cycles")
        .orderBy("cycleIndex", "desc")
        .limit(limit)
        .get();
      snap.forEach((doc) => {
        const data = doc.data();
        cycles.push({
          cycleId:data.cycleId,
          cycleIndex:data.cycleIndex,
          at:data.at,
          transmission:data.transmission || data.primary,
          trace:data.trace,
          integrity:data.integrity,
          topics:data.topics,
          seedConcept:data.seedConcept
        });
      });
    }else{
      const sorted = Array.from(inMem.cycles.values())
        .sort((a, b) => (b.cycleIndex || 0) - (a.cycleIndex || 0))
        .slice(0, limit);
      sorted.forEach((data) => {
        cycles.push({
          cycleId:data.cycleId,
          cycleIndex:data.cycleIndex,
          at:data.at,
          transmission:data.transmission || data.primary,
          trace:data.trace,
          integrity:data.integrity,
          topics:data.topics,
          seedConcept:data.seedConcept
        });
      });
    }

    res.json({ok:true, cycles});
  }catch(err){
    logger.error("Archive fetch failed", {error:err.message});
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

if(shouldServeDist){
  app.get(/.*/, (req,res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

export {app, runCycleJobs};

if(!IS_SERVERLESS && CYCLE_INTERVAL_MINUTES > 0){
  setInterval(() => {
    generateCycle({seed:null, createdBy:"scheduler"}).catch(() => {});
  }, CYCLE_INTERVAL_MINUTES * 60 * 1000);
}

if(!IS_SERVERLESS){
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
