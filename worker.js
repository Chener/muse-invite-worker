/**
 * muse-invite-v2 — Cloudflare Worker 后端
 * 服务 https://muse.chenerpath.com 邀请码聚合站 V2：
 *   访客投票「还能用 / 已失效」、码主认领 + 自助更新剩余次数。
 *
 * 部署：见同目录 deploy.sh（KV namespace 绑定名为 KV）。
 * 目录（code / invite_url / publisher …）唯一来源是
 * https://muse.chenerpath.com/data/codes.json，Worker 按 5 分钟缓存
 * 拉取后与 KV 中的众包动态字段合并返回；KV 只存动态字段，避免双写。
 */

"use strict";

const ALLOWED_ORIGIN = "https://muse.chenerpath.com";
const CATALOG_URL = "https://muse.chenerpath.com/data/codes.json";
const CATALOG_CACHE_MS = 5 * 60 * 1000; // 目录缓存 5 分钟
const VOTE_TTL_S = 24 * 3600;           // 投票限流窗口 24h
const CLAIM_LIMIT = 5;                  // 同一 IP 24h 内最多认领 5 个码
const MAX_REMAINING = 100000;

let catalogCache = { at: 0, codes: null };

/* ---------- helpers ---------- */

function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin === ALLOWED_ORIGIN) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function jres(req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) },
  });
}

function clientIP(req) {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function normCode(v) {
  const c = String(v || "").trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(c) ? c : null;
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 常量时间比较，防止时序侧信道
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJSON(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function getCatalog() {
  const now = Date.now();
  if (catalogCache.codes && now - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.codes;
  const res = await fetch(CATALOG_URL, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error("catalog unavailable: http " + res.status);
  const data = await res.json();
  const codes = {};
  for (const c of data.codes || []) {
    const code = normCode(c.code);
    if (code) codes[code] = c;
  }
  catalogCache = { at: now, codes };
  return codes;
}

function blankState() {
  return {
    remaining: null,
    votes_works: 0,
    votes_dead: 0,
    owner_key_hash: null,
    claimed_at: null,
    updated_at: null,
  };
}

async function readState(env, code) {
  const raw = await env.KV.get("code:" + code);
  if (!raw) return blankState();
  try {
    return { ...blankState(), ...JSON.parse(raw) };
  } catch {
    return blankState();
  }
}

/* ---------- routes ---------- */

// GET /api/codes — 全部码：目录字段 + KV 众包字段合并
async function handleCodes(req, env) {
  let catalog;
  try {
    catalog = await getCatalog();
  } catch (e) {
    return jres(req, { error: "catalog_unavailable", detail: String((e && e.message) || e) }, 502);
  }
  const entries = Object.values(catalog);
  const states = await Promise.all(entries.map((c) => readState(env, normCode(c.code))));
  const codes = entries.map((c, i) => {
    const s = states[i];
    const code = normCode(c.code);
    return {
      code,
      invite_url: c.invite_url || "https://agent.meta.ai/invite/" + code,
      publisher: c.publisher || null,
      source_label: c.source_label || null,
      added_at: c.added_at || null,
      status: c.status || "unverified",
      status_label: c.status_label || "待验证",
      total_slots: c.total_slots ?? null,
      last_verified: c.last_verified || null,
      remaining: s.remaining,
      votes_works: s.votes_works,
      votes_dead: s.votes_dead,
      claimed: !!s.owner_key_hash,
      updated_at: s.updated_at,
    };
  });
  return jres(req, { codes, count: codes.length });
}

// POST /api/vote {code, verdict:"works"|"dead"} — 同一 IP 24h 内对同一码限投一次
async function handleVote(req, env) {
  const body = await readJSON(req);
  const code = body && normCode(body.code);
  const verdict = body && body.verdict;
  if (!code) return jres(req, { error: "invalid_code" }, 400);
  if (verdict !== "works" && verdict !== "dead") return jres(req, { error: "invalid_verdict" }, 400);

  let catalog;
  try {
    catalog = await getCatalog();
  } catch (e) {
    return jres(req, { error: "catalog_unavailable" }, 502);
  }
  if (!catalog[code]) return jres(req, { error: "unknown_code" }, 404);

  const ip = clientIP(req);
  const limitKey = "iplimit:vote:" + ip + ":" + code;
  if (await env.KV.get(limitKey)) {
    return jres(req, { error: "already_voted", retry_after_hours: 24 }, 429);
  }

  const st = await readState(env, code);
  if (verdict === "works") st.votes_works += 1;
  else st.votes_dead += 1;
  st.updated_at = new Date().toISOString();
  await env.KV.put("code:" + code, JSON.stringify(st));
  await env.KV.put(limitKey, "1", { expirationTtl: VOTE_TTL_S });

  return jres(req, { ok: true, code, votes_works: st.votes_works, votes_dead: st.votes_dead });
}

// POST /api/claim {code} — 首次认领返回 owner_key（只显示一次）
async function handleClaim(req, env) {
  const body = await readJSON(req);
  const code = body && normCode(body.code);
  if (!code) return jres(req, { error: "invalid_code" }, 400);

  let catalog;
  try {
    catalog = await getCatalog();
  } catch (e) {
    return jres(req, { error: "catalog_unavailable" }, 502);
  }
  if (!catalog[code]) return jres(req, { error: "unknown_code" }, 404);

  const st = await readState(env, code);
  if (st.owner_key_hash) return jres(req, { error: "already_claimed" }, 409);

  const ip = clientIP(req);
  const claimKey = "iplimit:claim:" + ip;
  const n = parseInt((await env.KV.get(claimKey)) || "0", 10);
  if (n >= CLAIM_LIMIT) {
    return jres(req, { error: "claim_rate_limited", retry_after_hours: 24 }, 429);
  }

  const raw = crypto.getRandomValues(new Uint8Array(32));
  const ownerKey = Array.from(raw)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const now = new Date().toISOString();
  st.owner_key_hash = await sha256hex(ownerKey); // 只存哈希，原文永不落盘
  st.claimed_at = now;
  st.updated_at = now;
  await env.KV.put("code:" + code, JSON.stringify(st));
  await env.KV.put(claimKey, String(n + 1), { expirationTtl: VOTE_TTL_S });

  return jres(req, {
    ok: true,
    code,
    owner_key: ownerKey,
    warning: "owner_key 只显示一次，请立即复制保存；丢失后无法找回。",
  });
}

// POST /api/owner-update {code, owner_key, remaining} — 凭 key 更新剩余次数
async function handleOwnerUpdate(req, env) {
  const body = await readJSON(req);
  const code = body && normCode(body.code);
  const ownerKey = body ? String(body.owner_key || "").trim() : "";
  const remaining = body ? body.remaining : undefined;
  if (!code) return jres(req, { error: "invalid_code" }, 400);
  if (!/^[0-9a-f]{64}$/i.test(ownerKey)) return jres(req, { error: "invalid_owner_key" }, 403);
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > MAX_REMAINING) {
    return jres(req, { error: "invalid_remaining" }, 400);
  }

  const st = await readState(env, code);
  if (!st.owner_key_hash) return jres(req, { error: "not_claimed" }, 403);
  if (!safeEqual(await sha256hex(ownerKey), st.owner_key_hash)) {
    return jres(req, { error: "invalid_owner_key" }, 403);
  }

  st.remaining = remaining;
  st.updated_at = new Date().toISOString();
  await env.KV.put("code:" + code, JSON.stringify(st));
  return jres(req, { ok: true, code, remaining });
}

/* ---------- entry ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (!env.KV) return jres(req, { error: "kv_not_bound" }, 500);
    try {
      if (url.pathname === "/api/codes" && req.method === "GET") return await handleCodes(req, env);
      if (url.pathname === "/api/vote" && req.method === "POST") return await handleVote(req, env);
      if (url.pathname === "/api/claim" && req.method === "POST") return await handleClaim(req, env);
      if (url.pathname === "/api/owner-update" && req.method === "POST")
        return await handleOwnerUpdate(req, env);
      if (url.pathname === "/" || url.pathname === "/api") {
        return jres(req, {
          name: "muse-invite-v2",
          endpoints: ["GET /api/codes", "POST /api/vote", "POST /api/claim", "POST /api/owner-update"],
        });
      }
      return jres(req, { error: "not_found" }, 404);
    } catch (e) {
      return jres(req, { error: "internal", detail: String((e && e.message) || e) }, 500);
    }
  },
};
