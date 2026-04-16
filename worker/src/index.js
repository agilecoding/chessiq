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
 *   • Multi-provider — Groq (Llama 3.1) and OpenAI (GPT-4o-mini), auto-failover
 *   • Rate limiting  — KV-based sliding window (3 req/sec per IP, 20/sec global)
 *   • KV caching     — deterministic responses cached 7 days, chat 1 hr
 *   • Token budget   — compressed prompts reduce cost ~70%
 *   • Retry headers  — 429 includes Retry-After so client backs off cleanly
 *   • CORS           — set * for dev, lock to origin in production
 *
 * Env vars (set via `wrangler secret put` or Workers dashboard)
 *   GROQ_API_KEY   — Groq key (required unless LLM_PROVIDER=openai)
 *   OPENAI_API_KEY — OpenAI key (optional; used as failover or primary)
 *   LLM_PROVIDER   — 'groq' (default) | 'openai' | 'auto' (Groq with OpenAI failover)
 *   ALLOWED_ORIGIN — your deployed app URL (e.g. https://yourname.github.io)
 *
 * KV namespace
 *   CHESSIQ_KV     — bound in wrangler.toml
 *
 * Concurrency note
 *   Cloudflare Workers handle concurrency natively — each request runs in its
 *   own isolate. No queue is needed; the platform scales horizontally for free.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const GROQ_API    = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL  = 'llama-3.1-8b-instant';   // fast, free tier, excellent quality

const OPENAI_API   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';            // cheap, capable, HTTPS-friendly

const RATE_WINDOW_SEC  = 1;   // sliding window size
const RATE_LIMIT_PER_IP = 3;  // max requests per IP per window
const RATE_LIMIT_GLOBAL = 20; // max requests across all IPs per window

const TTL_MOVE     = 60 * 60 * 24 * 7; // 7 days  — blunder explanations are deterministic
const TTL_POSITION = 60 * 60 * 24 * 7; // 7 days  — position analysis is deterministic
const TTL_CHAT     = 60 * 60;           // 1 hour  — chat is conversational, less cacheable

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Use * so any origin (GitHub Pages, local file, custom domain) can call this.
// Security comes from the GROQ_API_KEY being server-side, not from CORS restrictions.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function corsPreflightResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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

// ─── LLM callers ─────────────────────────────────────────────────────────────

/**
 * Call a single provider. Returns { text, inputTokens, outputTokens, provider }.
 * Throws on error with err.status set for rate-limit detection.
 */
async function callProvider(apiUrl, apiKey, model, messages, maxTokens) {
  const res = await fetch(apiUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  maxTokens,
      temperature: 0.65,   // slightly creative but factual
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status} from ${apiUrl}`;
    // Preserve status so callers can detect 429 vs 5xx
    if (res.status === 429) throw Object.assign(new Error(msg), { status: 429 });
    if (res.status >= 500)  throw Object.assign(new Error(msg), { status: res.status });
    throw new Error(msg);
  }

  const data = await res.json();
  return {
    text:         data.choices[0].message.content.trim(),
    inputTokens:  data.usage?.prompt_tokens    ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

/**
 * Route to the right provider based on env.LLM_PROVIDER:
 *   'groq'   — Groq only (default)
 *   'openai' — OpenAI only
 *   'auto'   — try Groq first; if it returns 429 or 5xx, failover to OpenAI
 *
 * The active provider name is returned in the result so /health can report it.
 */
async function callLLM(env, messages, maxTokens = 500) {
  const mode = (env.LLM_PROVIDER ?? 'groq').toLowerCase();

  if (mode === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('Worker misconfigured: OPENAI_API_KEY not set');
    const result = await callProvider(OPENAI_API, env.OPENAI_API_KEY, OPENAI_MODEL, messages, maxTokens);
    return { ...result, provider: 'openai', model: OPENAI_MODEL };
  }

  if (mode === 'auto') {
    // Try Groq first
    if (env.GROQ_API_KEY) {
      try {
        const result = await callProvider(GROQ_API, env.GROQ_API_KEY, GROQ_MODEL, messages, maxTokens);
        return { ...result, provider: 'groq', model: GROQ_MODEL };
      } catch (err) {
        // Failover to OpenAI on rate-limit or server error — not on bad requests
        if ((err.status === 429 || err.status >= 500) && env.OPENAI_API_KEY) {
          console.warn(`[ChessIQ] Groq ${err.status} — failing over to OpenAI`);
          const result = await callProvider(OPENAI_API, env.OPENAI_API_KEY, OPENAI_MODEL, messages, maxTokens);
          return { ...result, provider: 'openai-failover', model: OPENAI_MODEL };
        }
        throw err; // rethrow if no fallback available
      }
    }
    // No Groq key — fall through to OpenAI directly
    if (!env.OPENAI_API_KEY) throw new Error('Worker misconfigured: no API key set (GROQ_API_KEY or OPENAI_API_KEY required)');
    const result = await callProvider(OPENAI_API, env.OPENAI_API_KEY, OPENAI_MODEL, messages, maxTokens);
    return { ...result, provider: 'openai', model: OPENAI_MODEL };
  }

  // Default: 'groq'
  if (!env.GROQ_API_KEY) throw new Error('Worker misconfigured: GROQ_API_KEY not set');
  const result = await callProvider(GROQ_API, env.GROQ_API_KEY, GROQ_MODEL, messages, maxTokens);
  return { ...result, provider: 'groq', model: GROQ_MODEL };
}

// ─── Token-optimised prompt builders ─────────────────────────────────────────

/**
 * /explain-move
 * Includes player name, move number, eval swing.
 * Input tokens: ~100  Output tokens: max 400
 */
function buildExplainMoveMessages({ fen, san, side, playerName, moveNumber, classification, evalBefore, evalAfter, bestMove }) {
  const swing   = Math.abs(((evalAfter ?? 0) - (evalBefore ?? 0)) / 100).toFixed(2);
  const evalNow = evalAfter != null
    ? (evalAfter > 0 ? `+${(evalAfter / 100).toFixed(2)}` : `${(evalAfter / 100).toFixed(2)}`)
    : '?';

  // Always be explicit: "White (Magnus)" not just "White"
  const actor = playerName && playerName !== side
    ? `${side} (${playerName})`
    : (side ?? 'the player');

  const system =
    `You are a chess coach. Explain this move clearly in 3–5 sentences: ` +
    `why it is a ${classification}, what the correct idea was, and what chess concept was missed. ` +
    `Be specific — name the pieces and squares involved. ` +
    `IMPORTANT: ${side} is the player who just moved. Do not confuse the two sides.`;

  const user =
    `FEN: ${fen}\n` +
    `Move ${moveNumber ?? '?'}: ${actor} played ${san} — classified as ${classification}.\n` +
    `Evaluation swing: ${swing} pawns | Position now: ${evalNow}.` +
    (bestMove ? `\nEngine's best move was: ${bestMove}.` : '') +
    `\n\nWhy is ${san} a ${classification}, and what should have been played instead?`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user   },
  ];
}

/**
 * /analyze-position
 * Input tokens: ~80  Output tokens: max 350
 */
function buildAnalyzePositionMessages({ fen, eval: ev, turn, moveNumber, whiteName, blackName }) {
  // turn is from FEN: 'w' = White to move next, 'b' = Black to move next
  const toMove = turn === 'b'
    ? `Black${blackName && blackName !== 'Black' ? ` (${blackName})` : ''}`
    : `White${whiteName && whiteName !== 'White' ? ` (${whiteName})` : ''}`;

  const evalStr = ev != null
    ? (ev > 0
        ? `White${whiteName && whiteName !== 'White' ? ` (${whiteName})` : ''} is better by +${(ev / 100).toFixed(2)}`
        : ev < 0
          ? `Black${blackName && blackName !== 'Black' ? ` (${blackName})` : ''} is better by +${(Math.abs(ev) / 100).toFixed(2)}`
          : 'Equal (0.00)')
    : 'unknown';

  const system =
    `You are a chess coach. ` +
    `White is ${whiteName ?? 'White'}, Black is ${blackName ?? 'Black'}. ` +
    `Analyze this position in 4–6 sentences: key imbalances, immediate threats, plans for both sides. ` +
    `Be concrete — name the pieces and squares.`;

  const user =
    `FEN: ${fen}\n` +
    `${toMove} to move | Move ${moveNumber ?? '?'} | Eval: ${evalStr}\n\n` +
    `What are the key ideas and plans for both sides?`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user   },
  ];
}

/**
 * /chat-with-coach
 * System prompt with explicit color assignments + proper PGN.
 * History: last 6 turns max (3 exchanges)
 * Output tokens: max 600
 */
function buildChatMessages({ fen, pgn, whiteName, blackName, headers, currentMove, evalScore, accuracy, blunders, mistakes, history, message }) {
  const evalStr = evalScore != null
    ? (evalScore > 0
        ? `+${(evalScore / 100).toFixed(2)} (White better)`
        : evalScore < 0
          ? `${(evalScore / 100).toFixed(2)} (Black better)`
          : '0.00 (equal)')
    : 'unknown';

  // Derive names from whichever field is present
  const wName = whiteName ?? headers?.White ?? 'White';
  const bName = blackName ?? headers?.Black ?? 'Black';

  const eventTag = headers?.Event ? ` | ${headers.Event}` : '';
  const resultTag = headers?.Result ? ` | Result: ${headers.Result}` : '';

  // Current move with full attribution — this is the most important context line
  const moveTag = currentMove
    ? `Move ${currentMove.moveNumber ?? '?'}: ${currentMove.side ?? ''} ` +
      `(${currentMove.playerName ?? (currentMove.side === 'White' ? wName : bName)}) ` +
      `played ${currentMove.san}` +
      (currentMove.classification && !['good','best','excellent','book'].includes(currentMove.classification)
        ? ` [${currentMove.classification}]` : '') +
      (currentMove.bestMove ? ` | Engine best: ${currentMove.bestMove}` : '')
    : '';

  const statsTag = accuracy
    ? `${wName}: ${accuracy.white?.toFixed(0) ?? '?'}% accuracy | ` +
      `${bName}: ${accuracy.black?.toFixed(0) ?? '?'}% accuracy | ` +
      `${blunders ?? 0} blunders, ${mistakes ?? 0} mistakes total`
    : '';

  const systemParts = [
    'You are ChessIQ, an expert chess coach. Be conversational, specific, and insightful.',
    // Color assignment is on its own line so it cannot be missed
    `White: ${wName} | Black: ${bName}${eventTag}${resultTag}`,
    `Current position FEN: ${fen ?? 'starting position'} | Eval: ${evalStr}`,
    moveTag  || null,
    statsTag || null,
    // Full PGN with move numbers so White/Black attribution is unambiguous
    pgn ? `Game moves: ${pgn}` : null,
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
    return jsonResponse({ error: 'Missing required fields: fen, san' }, 400);
  }

  // Cache key covers FEN + move + best move so variations get their own entry
  const cacheKey = await sha256(`explain|${body.fen}|${body.san}|${body.bestMove ?? ''}`);
  const cached   = await cacheGet(env, cacheKey);
  if (cached) return jsonResponse({ ...cached, cached: true }, 200);

  const messages    = buildExplainMoveMessages(body);
  const { text, inputTokens, outputTokens, provider } = await callLLM(env, messages, 400);

  const result = {
    explanation:    text,
    move:           body.san,
    classification: body.classification,
    provider,
    tokens:         { in: inputTokens, out: outputTokens },
  };

  await cacheSet(env, cacheKey, result, TTL_MOVE);
  return jsonResponse(result, 200);
}

async function handleAnalyzePosition(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.fen) {
    return jsonResponse({ error: 'Missing required field: fen' }, 400);
  }

  const cacheKey = await sha256(`position|${body.fen}|${Math.round((body.eval ?? 0) / 10)}`);
  const cached   = await cacheGet(env, cacheKey);
  if (cached) return jsonResponse({ ...cached, cached: true }, 200);

  const messages = buildAnalyzePositionMessages(body);
  const { text, inputTokens, outputTokens, provider } = await callLLM(env, messages, 350);

  const result = {
    analysis: text,
    fen:      body.fen,
    provider,
    tokens:   { in: inputTokens, out: outputTokens },
  };

  await cacheSet(env, cacheKey, result, TTL_POSITION);
  return jsonResponse(result, 200);
}

async function handleChatWithCoach(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.message) {
    return jsonResponse({ error: 'Missing required field: message' }, 400);
  }

  // Only cache first question about a position (no prior history = deterministic)
  const hasHistory   = body.history && body.history.length > 0;
  const cacheKey     = hasHistory ? null : await sha256(`chat|${body.fen ?? ''}|${body.message}`);
  const cached       = cacheKey ? await cacheGet(env, cacheKey) : null;
  if (cached) return jsonResponse({ ...cached, cached: true }, 200);

  const messages = buildChatMessages(body);
  const { text, inputTokens, outputTokens, provider } = await callLLM(env, messages, 600);

  const result = {
    reply:  text,
    provider,
    tokens: { in: inputTokens, out: outputTokens },
  };

  if (cacheKey) await cacheSet(env, cacheKey, result, TTL_CHAT);
  return jsonResponse(result, 200);
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') return corsPreflightResponse();

    const { pathname } = new URL(request.url);

    // Health check (no auth, no rate limit)
    if (pathname === '/health') {
      const mode     = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
      const hasGroq  = !!env.GROQ_API_KEY;
      const hasOAI   = !!env.OPENAI_API_KEY;
      const model    = mode === 'openai' ? OPENAI_MODEL
                     : mode === 'auto'   ? (hasGroq ? `${GROQ_MODEL} (auto, OAI fallback: ${hasOAI})` : OPENAI_MODEL)
                     : GROQ_MODEL;
      return jsonResponse({
        status:    'ok',
        timestamp: Date.now(),
        provider:  mode,
        model,
        groqKey:   hasGroq,
        openaiKey: hasOAI,
      }, 200);
    }

    // All other routes need POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Guard: at least one API key must be configured
    if (!env.GROQ_API_KEY && !env.OPENAI_API_KEY) {
      return jsonResponse({ error: 'Worker misconfigured: set GROQ_API_KEY or OPENAI_API_KEY' }, 500);
    }

    // Rate limit
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For')  || 'unknown';

    if (await isRateLimited(env, ip)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded — please wait a moment.' }),
        {
          status:  429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1', ...CORS_HEADERS },
        }
      );
    }

    // Route
    try {
      switch (pathname) {
        case '/explain-move':      return await handleExplainMove(request, env);
        case '/analyze-position':  return await handleAnalyzePosition(request, env);
        case '/chat-with-coach':   return await handleChatWithCoach(request, env);
        default:                   return jsonResponse({ error: `Unknown endpoint: ${pathname}` }, 404);
      }
    } catch (err) {
      const status = err.status === 429 ? 503 : 500; // surface Groq 429 as 503 (backend busy)
      console.error(`[ChessIQ Worker] ${pathname}: ${err.message}`);
      return jsonResponse({ error: err.message || 'Internal server error' }, status);
    }
  },
};
