Built and deployed on github pages a full-stack AI chess coach app using Cloudflare Worker proxy with KV caching and rate limiting, 
smart multi-endpoint prompt routing, and a single-file HTML frontend — using Claude as a collaborative AI pair programmer. 

TechStack: JavaScript, Cloudflare Workers, OpenAI, StockFish (alpha/beta depth-3) Groq- (Meta’s Llama 3.1- LLM) API,KV Store, Chess.js & Chart.js

Built a full-stack AI chess coach as a single-file web app — no build pipeline, no framework, deployed instantly to GitHub Pages.
Implemented a client-side alpha-beta minimax engine (depth 3, piece-square tables, <100ms/position) without WebAssembly or external binaries
Designed 3 specialized LLM endpoints (/explain-move, /analyze-position, /chat-with-coach) with compressed, context-aware prompts — reducing token usage ~70% vs a naive single-endpoint approach
Built a Cloudflare Worker API proxy to keep the Groq API key server-side; added KV-based sliding-window rate limiting (3 req/s per IP, 20 req/s global)
and response caching (7-day TTL for deterministic move analysis, 1-hour TTL for chat)
Implemented client-side intent routing in pure JS — regex classifies user questions and dispatches to the most specific endpoint automatically, 
with no worker redeployment needed to change routing logic
Integrated Chart.js eval visualization, PGN parsing via Chess.js, and cburnett SVG piece rendering from Lichess CDN
Supports Groq (via Worker) and direct OpenAI/Groq as provider options; graceful fallback with exponential backoff on 429s

Key learning: discovered that CORS restrictions from local files forced a serverless proxy architecture — 
turned a constraint into a feature by adding rate limiting and caching the browser fundamentally cannot do.
