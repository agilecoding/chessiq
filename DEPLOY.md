# ChessIQ — Deployment Guide

Two parts: deploy the **Worker** (backend), then deploy the **app** (frontend).

---

## Part 1 — Cloudflare Worker (backend)

### Prerequisites
- [Node.js](https://nodejs.org) installed (v18+)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A free [Groq API key](https://console.groq.com) — takes 60 seconds to create

---

### Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login          # opens browser → log in to Cloudflare
```

---

### Step 2 — Create the KV namespace

```bash
cd ChessIQ/worker
npm install
npm run kv:create
```

Copy the `id` from the output (looks like `abc123def456…`) and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CHESSIQ_KV"
id      = "PASTE_YOUR_ID_HERE"   # ← replace this line
```

---

### Step 3 — Add secrets

Your Groq API key stays server-side — never touches the browser:

```bash
wrangler secret put GROQ_API_KEY
# paste your key when prompted: gsk_xxxxxxxxxxxx
```

Optionally lock CORS to your deployed app URL (recommended for production):

```bash
wrangler secret put ALLOWED_ORIGIN
# paste: https://yourusername.github.io
```

---

### Step 4 — Deploy

```bash
wrangler deploy
```

Output will look like:

```
✅ Deployed to: https://chessiq-worker.yourname.workers.dev
```

**Copy that URL** — you'll need it in the app settings.

---

### Step 5 — Test it

```bash
curl https://chessiq-worker.yourname.workers.dev/health
# → {"status":"ok","timestamp":1234567890,"model":"llama-3.1-8b-instant"}
```

---

### What you get

| Feature | Detail |
|---|---|
| Rate limiting | 3 req/sec per IP, 20/sec global — 429 with Retry-After |
| KV caching | Move explanations: 7 days · Position analysis: 7 days · Chat: 1 hr |
| Token savings | ~70% fewer tokens vs sending full game context |
| Smart routing | `/explain-move` for blunders, `/analyze-position` for positions, `/chat-with-coach` for everything else |
| Cost | Free tier: 100k req/day, 1k KV writes/day — plenty for personal use |

---

## Part 2 — Deploy the App (GitHub Pages)

### Step 1 — Create a GitHub repo

Go to [github.com/new](https://github.com/new):
- Name: `chessiq` (or anything)
- Visibility: **Public**
- Click **Create repository**

### Step 2 — Upload

On your empty repo page, click **"uploading an existing file"** → drag in `index.html` → **Commit changes**.

### Step 3 — Enable Pages

Repo → **Settings** → **Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/(root)` → **Save**.

Wait ~60 seconds. Your app is live at:
```
https://yourusername.github.io/chessiq
```

---

## Part 3 — Connect app to Worker

1. Open your live app at `https://yourusername.github.io/chessiq`
2. Click **⚙️ Settings** (top right)
3. Select **☁️ Worker**
4. Paste your Worker URL: `https://chessiq-worker.yourname.workers.dev`
5. Click **Save**

The badge turns green: **☁️ Worker** ✓

---

## Cost summary

| Service | Free tier | Paid starts at |
|---|---|---|
| Cloudflare Workers | 100k req/day | $5/mo for 10M req |
| Cloudflare KV | 100k reads, 1k writes/day | $0.50/M reads |
| Groq | ~14,400 req/day (free) | Pay-as-you-go |
| GitHub Pages | Unlimited | — (always free) |

**For personal use: $0/month.**

---

## Local development

Test the worker locally before deploying:

```bash
cd ChessIQ/worker
wrangler dev
# → Worker available at http://localhost:8787
```

In the app Settings, temporarily set Worker URL to `http://localhost:8787`.

---

## Updating the worker

Edit `worker/src/index.js`, then:

```bash
cd ChessIQ/worker
wrangler deploy
```

Changes are live globally within seconds.

---

## Monitoring

```bash
wrangler tail              # live request logs
wrangler kv:key list --binding CHESSIQ_KV   # inspect cache keys
```

Or use the Cloudflare dashboard → Workers → Analytics.
