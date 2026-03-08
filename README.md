# ⚔️ TrustRoyale — Clan War Reliability Analyzer

A full-stack web tool that helps clan leaders evaluate whether a player is likely to participate consistently in clan wars.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Player analysis** | Overview, activity indicators, battle log chart, war reliability score (/45 or /40), colour-coded verdict + breakdown |
| **Clan analysis** | Member table with sorting & filtering, score distribution chart, reliable-vs-risky pie chart |
| **Response cache** | In-memory cache (15 min TTL) to avoid hammering the Clash Royale API |
| **Responsive UI** | Clash Royale-inspired dark theme, works on mobile |

---

## 🗂 Project structure

```
clash/
├── backend/
│   ├── server.js              # Express entry point
│   ├── package.json
│   ├── routes/
│   │   ├── player.js          # GET /api/player/:tag[/analysis]
│   │   └── clan.js            # GET /api/clan/:tag[/analysis]
│   └── services/
│       ├── clashApi.js        # Clash Royale API wrapper
│       ├── analysisService.js # Scoring formulas
│       └── cache.js           # In-memory cache (15 min TTL)
├── frontend/
│   ├── index.html
│   ├── main.js                # UI orchestration
│   ├── style.css              # Clash Royale theme
│   ├── charts.js              # Chart.js wrappers
│   ├── vite.config.js         # Vite + /api proxy
│   └── package.json
├── .env.example
├── .gitignore
├── vercel.json                # Vercel deployment config
└── README.md
```

---

## 🚀 Local development

### Prerequisites

- Node.js ≥ 18
- A [Clash Royale developer API key](https://developer.clashroyale.com/)

### 1 — Install dependencies

```bash
# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2 — Configure environment variables

```bash
# At the project root
cp .env.example .env
```

Open `.env` and fill in your API key:

```
CLASH_API_KEY=eyJ0eXAiOiJKV1Qi...
```

> **Important:** the API key must be whitelisted for your current public IP address on the developer portal.

### 3 — Start the dev servers

```bash
npm run dev
```

Lance backend (**<http://localhost:3000>**) et frontend (**<http://localhost:5173>**) simultanément via `concurrently`. Le frontend proxie `/api` → `:3000`.

---

## 📡 Backend API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/player/:tag` | Raw player profile |
| `GET` | `/api/player/:tag/analysis` | Full player analysis |
| `GET` | `/api/clan/:tag` | Raw clan profile |
| `GET` | `/api/clan/:tag/analysis` | Clan + member analysis |

Tags should include the `#` prefix (URL-encoded as `%23`).

---

## 🧮 Score formulas

### War reliability score — full mode (0–44 pts)

Used when the war race log is available. Seven weighted criteria:

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | Regularity | 10 | avg fame/wk vs 1,600 target over completed weeks |
| 2 | Avg fame | 10 | 3,000 fame/week = full score |
| 3 | CW2 battle wins | 8 | 250 total CW2 wins = full score |
| 4 | Clan stability | 8 | 5+ consecutive weeks in clan = full score |
| 5 | Last seen | +5 | active within 24 h = +5; ≤3 d = +3; ≤7 d = +1 |
| 6 | Win rate (River Race) | 3 | 100% win rate = full score |
| 7 | Experience (best trophies) | 3 | 12,000 trophies = full score |
| 8 | Donations | 2 | 500 cards donated = full score |

Without battle log (criterion 6 absent): max = **46 pts**. With last seen and win rate: **49 pts** maximum.

### War reliability score — fallback mode (0–36 pts)

Used when no race log history is available (battle log only):

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | War activity | 10 | Avg battles/day over 14-day window (4/day = full) |
| 2 | Win rate (war) | 8 | From battle log war battles |
| 3 | CW2 battle wins | 8 | 250 total CW2 wins = full score |
| 4 | Last seen | +5 | active within 24 h = +5; ≤3 d = +3; ≤7 d = +1 |
| 5 | General activity | 5 | 20 competitive battles = full score |
| 6 | Experience | 3 | 12,000 best trophies = full score |
| 7 | Donations | 2 | 500 cards donated = full score |

### Verdict thresholds (both scoring modes)

| % of max score | Verdict | Colour |
|---|---|---|
| ≥ 76 % | High reliability | 🟢 Green |
| 56–75 % | Moderate risk | 🟡 Yellow |
| 31–55 % | High risk | 🟠 Orange |
| 0–30 % | Extreme risk | 🔴 Red |

### Member activity score (clan view, 0–100)

Computed from the `/members` endpoint only (no battle log required):

```
score = min(40, donations / 300 × 40)
      + min(40, trophies  / 10000 × 40)
      + min(20, expLevel  / 60 × 20)
```

Same 4-tier verdict thresholds apply (76 / 61 / 31).

---

## 🤖 Commande Discord `/trust`

Le bot Discord expose une slash command `/trust <tag>` qui affiche l'analyse de fiabilité d'un joueur directement dans un serveur Discord.

### Architecture

```
Discord → POST /api/discord/interactions   (api/discord/interactions.js)
              │
              ├─ type 1 (PING)   → { type: 1 }   (validation endpoint)
              │
              └─ type 2 /trust   → { type: 5 }   (deferred, <3 s)
                                     waitUntil(
                                       fetch /api/player/:tag/analysis
                                       → webhook follow-up Discord
                                     )
```

La fonction Discord est **séparée** de l'app Express (`api/index.js`) pour garantir un cold start minimal (< 1 s au lieu de 3-4 s), impératif pour respecter la fenêtre de 3 s imposée par Discord.

### Points techniques clés

| Problème | Solution |
|---|---|
| Validation endpoint Discord échoue | La vérification de signature Ed25519 doit se faire **avant** de répondre au PING, pas après |
| Cold start > 3 s → "application did not respond" | Fonction Vercel dédiée (`api/discord/interactions.js`) sans Express, uniquement `node:crypto` natif |
| Fonction tuée après `res.end()` | `waitUntil()` de `@vercel/functions` maintient la fonction active après l'envoi du `type: 5` |
| Vérification de signature | Reconstruit la clé publique Ed25519 depuis hex → SPKI DER via `node:crypto` (pas de dépendance npm) |

### Variables d'environnement requises

```
DISCORD_PUBLIC_KEY=   # Clé publique du bot (onglet "General Information")
DISCORD_APP_ID=       # Application ID du bot
DISCORD_TOKEN=        # Token du bot (pour le script d'enregistrement)
```

### Enregistrement de la commande

```bash
node registerCommands.js
```

Lance ce script une seule fois (ou après modification de la commande) pour enregistrer `/trust` auprès de l'API Discord.

### Format de la réponse

```
🟢 NomJoueur ⤑ 93 % (High reliability)
✅ Regularity   10/10    ✅ Avg Score     8.4/10
✅ CW2 Wins      8/8     ✅ Stability       8/8
⚠️ Win Rate      1.9/3   ✅ Experience      3/3
✅ Donations     2/2

Tag : #YRGJGR8R  [lien vers trustroyale.vercel.app]
```

Icônes : ✅ ≥ 75 % du max · ⚠️ entre 40 % et 74 % · ❌ < 40 %

---

## ☁️ Deployment

### Backend → Vercel

```bash
# Install Vercel CLI if needed
pnpm install -g vercel   # or: npm install -g vercel

cd clash          # project root
vercel            # follow the prompts

# Set the environment variable in the Vercel dashboard or via CLI:
vercel env add CLASH_API_KEY
```

The `vercel.json` at the root maps all `/api/*` requests to the Express server.

### Frontend → Vercel (or GitHub Pages)

#### Vercel

```bash
npm run build    # build + vercel --prod (depuis la racine)
```

#### GitHub Pages

```bash
cd frontend && npx vite build
# Then push the dist/ folder to the gh-pages branch
```

---

## 🛡 Security

- API keys are stored in **environment variables** and never exposed to the browser.
- The backend acts as a proxy; the frontend never calls the Clash Royale API directly.
- Add rate-limiting (e.g. `express-rate-limit`) before exposing the backend publicly.

---

## 📜 License

MIT — Not affiliated with or endorsed by Supercell.
