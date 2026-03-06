# ⚔️ Clash Royale — Clan War Reliability Analyzer

A full-stack web tool that helps clan leaders evaluate whether a player is likely to participate consistently in clan wars.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Player analysis** | Overview, activity indicators, battle log chart, war reliability score (/45 or /40), colour-coded verdict + breakdown |
| **Clan analysis** | Member table with sorting & filtering, score distribution chart, reliable-vs-risky pie chart |
| **Response cache** | In-memory cache (5 min TTL) to avoid hammering the Clash Royale API |
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
│       └── cache.js           # In-memory cache (5 min TTL)
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

### War reliability score — full mode (0–45 pts)

Used when the war race log is available. Seven weighted criteria:

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | Regularity | 10 | `playedWeeks / weeksInClan × 10` |
| 2 | Avg fame | 10 | 3,000 fame/week = full score |
| 3 | CW2 battle wins | 10 | 250 total CW2 wins = full score |
| 4 | Win rate (River Race) | 5 | 100% win rate = full score |
| 5 | Clan stability | 5 | 5+ consecutive weeks in clan = full score |
| 6 | Experience (best trophies) | 3 | 12,000 trophies = full score |
| 7 | Donations | 2 | 500 cards donated = full score |

Without battle log (criteria 4 absent): max = **40 pts**.

### War reliability score — fallback mode (0–40 pts)

Used when no race log history is available (battle log only):

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | War activity | 10 | Avg battles/day over 14-day window (4/day = full) |
| 2 | Win rate (war) | 10 | From battle log war battles |
| 3 | CW2 battle wins | 10 | 250 total CW2 wins = full score |
| 4 | General activity | 5 | 20 competitive battles = full score |
| 5 | Experience | 3 | 12,000 best trophies = full score |
| 6 | Donations | 2 | 500 cards donated = full score |

### Verdict thresholds (both scoring modes)

| % of max score | Verdict | Colour |
|---|---|---|
| ≥ 76 % | High reliability | 🟢 Green |
| 61–75 % | Moderate risk | 🟡 Yellow |
| 31–60 % | High risk | 🟠 Orange |
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
