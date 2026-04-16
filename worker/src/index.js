/**
 * ChessIQ — Cloudflare Worker
 *
 * Endpoints
 *   POST /explain-move      → focused blunder/mistake explanation
 *   POST /analyze-position  → strategic position overview
 *   POST /chat-with-coach   → free-form multi-turn chess coaching
 *   GET  /health            → uptime check
 *
 * Features
 *   • Rate limiting  — KV-based sliding window (3 req/sec per IP)
 *   • KV caching     — deterministic responses cached 7 days, chat 1 hr
 *   • Token budget   — compressed prompts reduce cost ~70%
 *   • Retry headers  — 429 includes Retry-After so client backs off cleanly
 *   • CORS           — locked to ALLOWED_ORIGINS, set * for dev
 *
 * Env vars (set via `wrangler secret put` or Workers dashboard)
 *   GROQ_API_KEY   — your Groq API key
 *   ALLOWED_ORIGIN — your deployed app URL (e.g. https://yourname.github.io)
 *
 * KV namespace
 *   CHESSIQ_KV     — bound in wrangler.toml
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';  // fast, cheap, excellent quality

const RATE_WINDOW_SEC  = 1;   // sliding window size
const RATE_LIMIT_PER_IP = 3;  // max requests per IP per window
const RATE_LIMIT_GLOBAL = 20; // max requests across all IPs per window

const TTL_MOVE     = 60 * 60 * 24 * 7; // 7 days  — blunder explanations are deterministic
const TTL_POSITION = 60 * 60 * 24 * 7; // 7 days  — position analysis is deterministic
const TTL_CHAT     = 60 * 60;           // 1 hour  — chat is conversational, less cacheable

// ─── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  const origin = env?.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status = 200, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function corsPreflightResponse(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

// ─── Crypto hash (for cache keys) ────────────────────────────────────────────

async function sha256(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 40); // 40 hex chars is plenty
}

// ─── Rate limiter (KV sliding window) ────────────────────────────────────────

/**
 * Returns true if the request should be blocked.
 * Uses two counters: per-IP and global.
 */
async function isRateLimited(env, ip) {
  if (!env.CHESSIQ_KV) return false; // no KV bound → skip (e.g. during local dev)

  const now = Math.floor(Date.now() / 1000);

  // Check + increment both counters in parallel
  const [ipBlocked, globalBlocked] = await Promise.all([
    checkAndIncrement(env, `rl:ip:${ip}:${now}`,     RATE_LIMIT_PER_IP),
    checkAndIncrement(env, `rl:global:${now}`,        RATE_LIMIT_GLOBAL),
  ]);

  return ipBlocked || globalBlocked;
}

async function checkAndIncrement(env, key, limit) {
  try {
    const current = parseInt(await env.CHESSIQ_KV.get(key) || '0', 10);
    if (current >= limit) return true; // over limit — don't increment
    // Store with TTL = window + 2s buffer so KV doesn't bloat
    await env.CHESSIQ_KV.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_SEC + 2 });
    return false;
  } catch {
    return false; // on KV error, allow request (fail open)
  }
}

// ─── KV Cache ─────────────────────────────────────────────────────────────────

async function cacheGet(env, key) {
  if (!env.CHESSIQ_KV) return null;
  try {
    const raw = await env.CHESSIQ_KV.get(`cache:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function cacheSet(env, key, value, ttl) {
  if (!env.CHESSIQ_KV) return;
  try {
    await env.CHESSIQ_KV.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttl });
  } catch { /* non-fatal */ }
}

// ─── Groq caller ─────────────────────────────────────────────────────────────

async function callGroq(env, messages, maxTokens = 500) {
  const res = await fetch(GROQ_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:      GROQ_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.65,  // slightly creative but factual
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `Groq HTTP ${res.status}`;
    // Surface Groq's rate limit upstream so the client can see it
    if (res.status === 429) throw Object.assign(new Error(msg), { status: 429 });
    throw new Error(msg);
  }

  const data = await res.json();
  return {
    text:       data.choices[0].message.content.trim(),
    inputTokens:  data.usage?.prompt_tokens     ?? 0,
    outputTokens: data.usage?.completion_tokens  ?? 0,
  };
}

// ─── Token-optimised prompt builders ─────────────────────────────────────────

/**
 * /explain-move
 * Input tokens: ~80   (vs ~400 for full context)
 * Output tokens: max 400
 */
function buildExplainMoveMessages({ fen, san, side, classification, evalBefore, evalAfter, bestMove }) {
  const swing   = Math.abs(((evalAfter ?? 0) - (evalBefore ?? 0)) / 100).toFixed(2);
  const evalNow = evalAfter != null
    ? (evalAfter > 0 ? `+${(evalAfter / 100).toFixed(2)}` : `${(evalAfter / 100).toFixed(2)}`)
    : '?';

  const system = `You are a chess coach. Explain this move in 3–5 sentences: \
why it's a ${classification}, what the idea should have been, and what concept was missed. \
Be specific and educational. Mention the piece/square when relevant.`;

  const user =
    `FEN: ${fen}\n` +
    `${side ?? 'Player'} played ${san} — rated as ${classification}.\n` +
    `Eval swing: ${swing} pawns → now ${evalNow}.` +
    (bestMove ? `\nEngine best: ${bestMove}.` : '') +
    `\n\nExplain why this is a ${classification} and what was better.`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user   },
  ];
}

/**
 * /analyze-position
 * Input tokens: ~60
 * Output tokens: max 350
 */
function buildAnalyzePositionMessages({ fen, eval: ev, turn, moveNumber, phase }) {
  const who    = turn === 'b' ? 'Black' : 'White';
  const evalStr = ev != null
    ? (ev > 0 ? `White +${(ev / 100).toFixed(2)}` : ev < 0 ? `Black +${(Math.abs(ev) / 100).toFixed(2)}` : 'Equal (0.00)')
    : 'unknown';

  const system = `You are a chess coach. Analyze this position in 4–6 sentences: \
key imbalances, immediate threats, plans for both sides. Be concrete — name pieces and squares.`;

  const user =
    `FEN: ${fen}\n` +
    `${who} to move | Move ${moveNumber ?? '?'}${phase ? ` | ${phase}` : ''} | Eval: ${evalStr}\n\n` +
    `What are the key ideas and plans for both sides?`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user   },
  ];
}

/**
 * /chat-with-coach
 * System prompt: compressed to ~150 tokens (vs 400+ from full buildGameContext)
 * History:       last 6 turns max (3 exchanges)
 * Output tokens: max 600
 */
function buildChatMessages({ fen, pgnSummary, headers, currentMove, evalScore, accuracy, blunders, mistakes, history, message }) {
  const evalStr = evalScore != null
    ? (evalScore > 0 ? `+${(evalScore / 100).toFixed(2)}` : `${(evalScore / 100).toFixed(2)}`)
    : 'unknown';

  const gameTag = headers
    ? `${headers.White ?? '?'} vs ${headers.Black ?? '?'}` +
      (headers.Event  ? ` — ${headers.Event}`  : '') +
      (headers.Result ? ` (${headers.Result})` : '')
    : 'Chess game';

  const moveTag = currentMove
    ? `Current: ${currentMove.san}${currentMove.classification ? ` [${currentMove.classification}]` : ''}`
    : '';

  const statsTag = accuracy
    ? `Acc W${accuracy.white?.toFixed(0) ?? '?'}% B${accuracy.black?.toFixed(0) ?? '?'}%` +
      ` | ❌ ${blunders ?? 0} blunders ${mistakes ?? 0} mistakes`
    : '';

  // Compressed system context
  const systemParts = [
    'You are ChessIQ, an expert chess coach. Be conversational, specific, and insightful.',
    `Game: ${gameTag}`,
    `FEN: ${fen ?? 'starting position'} | Eval: ${evalStr}`,
    moveTag  || null,
    statsTag || null,
    pgnSummary ? `Key moves: ${pgnSummary}` : null,
  ].filter(Boolean);

  const system = systemParts.join('\n');

  // Trim history to last 6 messages (3 exchanges) to cap token usage
  const trimmedHistory = (history ?? []).slice(-6);

  return [
    { role: 'system', content: system },
    ...trimmedHistory,
    { role: 'user',   content: message },
  ];
}

// ─── Endpoint handlers ────────────────────────────────────────────────────────

async function handleExplainMove(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.fen || !body?.san) {
    return jsonResponse({ error: 'Missing required fields: fen, san' }, 400, env);
  }

  // Cache key covers FEN + move + best move so variations get their own entry
  const cacheKey = await sha256(`explain|${body.fen}|${body.san}|${body.bestMove ?? ''}`);
  const cached   = await cacheGet(env, cacheKey);
  if (cached) return jsonResponse({ ...cached, cached: true }, 200, env);

  const messages    = buildExplainMoveMessages(body);
  const { text, inputTokens, outputTokens } = await callGroq(env, messages, 400);

  const result = {
    explanation:    text,
    move:           body.san,
    classification: body.classification,
    tokens:         { in: inputTokens, out: outputTokens },
  };

  await cacheSet(env, cacheKey, result, TTL_MOVE);
  return jsonResponse(result, 200, env);
}

async function handleAnalyzePosition(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.fen) {
    return jsonResponse({ error: 'Missing required field: fen' }, 400, env);
  }

  const cacheKey = await sha256(`position|${body.fen}|${Math.round((body.eval ?? 0) / 10)}`);
  const cached   = await cacheGet(env, cacheKey);
  if (cached) return jsonResponse({ ...cached, cached: true }, 200, env);

  const messages = buildAnalyzePositionMessages(body);
  const { text, inputTokens, outputTokens } = await callGroq(env, messages, 350);

  const result = {
    analysis: text,
    fen:      body.fen,
    tokens:   { in: inputTokens, out: outputTokens },
  };

  await cacheSet(env, cacheKey, result, TTL_POSITION);
  return jsonResponse(result, 200, env);
}

async function handleChatWithCoach(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.message) {
    return jsonResponse({ error: 'Missing required field: message' }, 400, env);
  }

  // Only cache first question about a position (no prior history = deterministic)
  const hasHistory   = body.history && body.history.length > 0;
  const cacheKey     = hasHistory ? null : await sha256(`chat|${body.fen ?? ''}|${body.message}`);
  const cached       = cacheKey ? await cacheGet(env, cacheKey) : null;
  if (cached) return jsonResponse({ ...cached, cached: true }, 200, env);

  const messages = buildChatMessages(body);
  const { text, inputTokens, outputTokens } = await callGroq(env, messages, 600);

  const result = {
    reply:  text,
    tokens: { in: inputTokens, out: outputTokens },
  };

  if (cacheKey) await cacheSet(env, cacheKey, result, TTL_CHAT);
  return jsonResponse(result, 200, env);
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') return corsPreflightResponse(env);

    const { pathname } = new URL(request.url);

    // Health check (no auth, no rate limit)
    if (pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: Date.now(), model: GROQ_MODEL }, 200, env);
    }

    // All other routes need POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, env);
    }

    // Guard: API key must be configured
    if (!env.GROQ_API_KEY) {
      return jsonResponse({ error: 'Worker misconfigured: GROQ_API_KEY not set' }, 500, env);
    }

    // Rate limit
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For')  || 'unknown';

    if (await isRateLimited(env, ip)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded — please wait a moment.' }),
        {
          status:  429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1', ...corsHeaders(env) },
        }
      );
    }

    // Route
    try {
      switch (pathname) {
        case '/explain-move':      return await handleExplainMove(request, env);
        case '/analyze-position':  return await handleAnalyzePosition(request, env);
        case '/chat-with-coach':   return await handleChatWithCoach(request, env);
        default:                   return jsonResponse({ error: `Unknown endpoint: ${pathname}` }, 404, env);
      }
    } catch (err) {
      const status = err.status === 429 ? 503 : 500; // surface Groq 429 as 503 (backend busy)
      console.error(`[ChessIQ Worker] ${pathname}: ${err.message}`);
      return jsonResponse({ error: err.message || 'Internal server error' }, status, env);
    }
  },
};
