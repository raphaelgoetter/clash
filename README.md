# ⚔️ Clash Royale — Clan War Reliability Analyzer

A full-stack web tool that helps clan leaders evaluate whether a player is likely to participate consistently in clan wars.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Player analysis** | Overview, activity indicators, battle log chart, stability score, war reliability score, colour-coded verdict + reasons |
| **Clan analysis** | Member table with sorting & filtering, score distribution chart, reliable-vs-risky pie chart |
| **CSV export** | One-click recruitment report download |
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
│       └── analysisService.js # Scoring formulas
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

### 3 — Run the backend

```bash
cd backend
npm run dev          # uses nodemon for auto-reload
# or
npm start            # plain node
```

The Express server starts at **http://localhost:3000**.

### 4 — Run the frontend

```bash
cd frontend
npm run dev
```

Vite starts at **http://localhost:5173** and proxies `/api` → `http://localhost:3000`.

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

### Stability score (0–100)

```
stabilityScore = (donations / 1000) × (battleCount / 2000) × (expLevel × 1.5)
```

- **< 15** → Low stability
- **15–39** → Medium stability
- **≥ 40** → High stability

### War reliability score (0–100)

```
raw = (recentBattles7d × 2)
    + (donations / 200)
    + (battleCount / 500)
    + (expLevel × 3)

normalised = min(100, raw / 200 × 100)
```

- **70–100** 🟢 Highly reliable
- **40–69**  🟡 Moderate reliability
- **0–39**   🔴 High risk

### Member activity score (clan view, 0–100)

Computed from the `/members` endpoint only (no battle log required):

```
score = min(40, donations / 300 × 40)
      + min(40, trophies  / 10000 × 40)
      + min(20, expLevel  / 60 × 20)
```

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
cd frontend
vercel
```

Update the API base URL in `vite.config.js` → replace the proxy target with your deployed backend URL, or use `VITE_API_BASE` environment variable.

#### GitHub Pages

```bash
cd frontend
npm run build
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
