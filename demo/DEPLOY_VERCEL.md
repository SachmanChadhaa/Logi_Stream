# Public demo: UI on Vercel, backend on this laptop behind a Cloudflare tunnel

The browser loads the UI from Vercel and talks **directly** to the gateway on
this laptop through a free Cloudflare quick tunnel. There is no Vercel
server-side proxy: free-tier functions time out long before a tutor turn ends.

```
browser ──► https://<app>.vercel.app      (static Next.js UI)
   │
   └──────► https://<random>.trycloudflare.com ──► cloudflared ──► gateway :8000
                                                                    ├─ orchestrator :8001 ──► Ollama :11434 (LLM + VLM, local)
                                                                    │                    └─► intel :8003 (Rust GRU + booster)
                                                                    └─ domain :8080 ──► local Python subprocess
```

> **Not a security sandbox.** Student code runs as a plain subprocess with this
> laptop's privileges. The only protections on the public path are the demo
> passcode, the CORS allow-list and the run rate limit. Share the passcode only
> with the audience, and stop the tunnel when the demo ends.

## 0. One-time setup

```bash
winget install --id Cloudflare.cloudflared
```

```bash
ollama create logistream-qwen3 -f ollama/Modelfile.logistream-qwen3
```

```bash
ollama pull qwen2.5vl:3b
```

The first `ollama` command builds the 8k-context tutor model from the
`qwen3-14b-64k` already on this machine; the second pulls the vision model
(~3.2 GB).

## 1. Configure `.env` (never commit it)

Add or change these lines in `.env` (see `.env.example`):

```
DEMO_PASSCODE=<a long random string, shared only with the audience>
CORS_ORIGIN=https://<your-app>.vercel.app,http://localhost:3000
RUN_RATE_LIMIT_PER_MIN=12
OBSERVE_RATE_LIMIT_PER_MIN=12
```

## 2. Start the stack and check it

```bash
bash demo/start.sh
```

```bash
bash demo/healthcheck.sh
```

`start.sh` brings up Postgres + LiteLLM (Docker), Java, the Rust `intel`
sidecar (training its synthetic v0 models on first run, ~90 s), Ollama, the
orchestrator, the gateway and the local web UI.

## 3. Open the tunnel

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints `https://<random>.trycloudflare.com`. Keep this terminal open. The URL
**changes every time** cloudflared restarts.

Check it from any machine:

```bash
curl -s https://<random>.trycloudflare.com/health
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<random>.trycloudflare.com/api/auth/check
```

The second must print `401` (passcode required).

## 4. Deploy the UI (the owner does this)

```bash
git push -u origin feature/bring-your-own-problem
```

In Vercel: **Add New → Project → import the repo**, then

| Setting | Value |
|---|---|
| Root Directory | `web` |
| Framework Preset | Next.js (auto-detected; `web/vercel.json` pins it) |
| Branch | `feature/bring-your-own-problem` |
| Environment variable | `NEXT_PUBLIC_API_BASE` = `https://<random>.trycloudflare.com` |

`NEXT_PUBLIC_*` values are baked in at **build** time: whenever the tunnel URL
changes, update the variable and **Redeploy**.

Then put the Vercel URL in `CORS_ORIGIN` (step 1) and restart the gateway:

```bash
bash demo/stop.sh && bash demo/start.sh
```

## 5. Smoke test from the Vercel URL

1. Open `https://<your-app>.vercel.app` → the passcode screen appears.
2. Enter the passcode → the bring-your-own-problem form.
3. **Try a sample problem → Two Sum** loads (logic gate shown).
4. Create a small custom problem with one test, run wrong code → a failing
   test row and a tutor hint.
5. **Assistant** → in Chrome it opens as an always-on-top Picture-in-Picture
   window; elsewhere as a floating panel.
6. **Share screen** in the assistant → pick your IDE window → the header shows
   "screen capture on". Pause / Resume / Stop must match what Chrome shows.

## Known limits (say these out loud)

* **The laptop must stay awake and online**, with Docker, Ollama and the
  tunnel running. Disable sleep for the demo.
* **Cloudflare quick tunnels cut responses at about 100 s** (error 524). A
  local tutor turn is ~5–20 s warm, but ~85 s right after Ollama swaps the
  vision model out (both do not fit in 8 GB of VRAM together). If turns are
  slow, pause screen capture while asking the tutor.
* No streaming: the UI shows a busy timer while a turn runs.
* Screen capture needs HTTPS (Vercel) or localhost, and only ever sends frames
  to the laptop's local Ollama; nothing is stored. Document Picture-in-Picture
  is Chrome-only.
* Identities are anonymous per browser (`X-Demo-User` = random id in local
  storage). Auth is still the MVP's mock (CLAUDE.md §3).
* Diagnostics from `intel` are **synthetic-trained v0, advisory,
  unvalidated**. The booster is in shadow mode because it ranks worse than the
  rules on held-out scenarios (`intel/models/metrics-v0.json`).

## After the demo

Stop the tunnel (Ctrl+C in its terminal), then:

```bash
bash demo/stop.sh
```

Rotate `DEMO_PASSCODE` before the next public run.
