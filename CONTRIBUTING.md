# ⚔️ TrustRoyale — Clan War Reliability Analyzer (developer docs)

Ce fichier rassemble toute la documentation destinée aux développeurs
et aux contributeurs. Il correspond à l'ancien README du projet.
Toute la partie "usage" destinée aux utilisateurs finaux a été déplacée
vers `README.md` (en français).

---

## ✨ Features

| Feature | Details |
|---|---|
| **Player analysis** | Overview, activity indicators, battle log chart, war reliability score (/45 or /40), colour-coded verdict + breakdown |
| **Clan analysis** | Member table with sorting & filtering, score distribution chart, reliable-vs-risky pie chart |
| **Family transfers** | Detects when a player moves between the 3 allowed clans and merges last week history to compute a proper score |
| **Response cache** | In-memory cache (30 s TTL) to avoid hammering the Clash Royale API on repeated navigations |
| **Responsive UI** | Clash Royale-inspired dark theme, works on mobile |
| **Favorites** | Save player or clan tags (with names) locally and recall them with one click |

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
│       ├── analysisCache.js   # Lecture/écriture du cache JSON (utilisé par scripts/cacheAll.js)
│       └── cache.js           # In-memory cache (30 s TTL)
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

This launches both backend (**<http://localhost:3000>**) and frontend (**<http://localhost:5173>**) simultaneously via `concurrently`. The frontend proxies `/api` → `:3000`.

### Scripts utiles

- `npm run cache` — pré-génère `frontend/public/clan-cache/*.json` (utilisé pour le rendu instantané en vue clan)
- `npm run transfers -- --out=transfers.json` — liste les joueurs détectés comme **transferts familiaux** (voir la section "Transferts familiaux" ci-dessous)

---

## 📡 Backend API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/player/:tag` | Raw player profile |
| `GET` | `/api/player/:tag/analysis` | Full player analysis |
| `GET` | `/api/clan/:tag` | Raw clan profile |
| `GET` | `/api/clan/:tag/analysis` | Clan + member analysis |
| `POST` | `/api/cache/flush` | Vide le cache mémoire (dev uniquement) |

Tags should include the `#` prefix (URL‑encoded as `%23`).

---

## 🧮 Score formulas
## Transferts familiaux

Les clans autorisés sont :

- `Y8JUPC9C` (La Resistance)
- `LRQP20V9` (Les Resistants)
- `QU9UQJRL` (Les Revoltes)

Lorsqu'un joueur passe d'un clan à un autre dans cette famille, l'historique de la
semaine précédente est **fusionné** (si le joueur a joué au moins 13 decks) afin
d'éviter de le pénaliser (et de basculer sur le mode `battle log` moins fiable).

Le marquage `transfer` est exposé dans l'API (champ `isFamilyTransfer`) et est
utilisé dans les UI/commandes Discord pour remplacer le badge `new`.

Le script `npm run transfers -- --out=transfers.json` permet de générer une
liste (locale) des transferts détectés.

### Script de test (transferts)

Ce script est utile en local pour vérifier rapidement :

```bash
npm run transfers -- --out=transfers.json
```

Il utilise `buildClanAnalysis()` et regarde les champs exposés sur chaque membre :
`isFamilyTransfer`, `transferFromClan` et `transferWeek`.

### 🚨 Note sur le cache statique

La vue clan charge un cache JSON statique (`frontend/public/clan-cache/*.json`) en
priorité pour un rendu instantané. Si vous modifiez le code de scoring ou de
détection de transfert, relancez :

```bash
npm run cache
```

### War reliability score — full mode (0–46 pts)

Used when the war race log is available. Eight weighted criteria:

> **Note on history sanitisation.** When a player has at least two prior weeks
> in the clan and the **oldest** of those weeks shows fewer than 16 decks, that
> week is treated as a potential mid‑race arrival and **ignored** for scoring
> purposes. It remains in the returned history (a grey bar in the chart) but
> does not count toward fame averages or participation. This prevents a recent
> recruit’s first partial week from artificially dragging down their score.
>
> These same rules are applied across both the player and clan analysis
> endpoints, ensuring the percentages shown in the clan member list match the
> individual player view.

Seven weighted criteria:

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | Regularity | 12 | war decks used / (16 × completed weeks); –0.5 pt per incomplete week |
| 2 | Avg fame | 10 | 3,000 fame/week = full score |
| 3 | CW2 battle wins | 8 | 250 total CW2 wins = full score |
| 4 | Clan stability | 8 | 5+ consecutive weeks in clan = full score |
| 5 | Last seen | +5 | active within 24 h = +5; ≤3 d = +3; ≤7 d = +1 |
| 6 | Win rate (River Race) | 3 | 100% win rate = full score · **min. 10 GDC battles** (absent otherwise) |
| 7 | Experience (best trophies) | 3 | 12,000 trophies = full score |
| 8 | Donations | 2 | 100 000 total cards donated = full score (≤ 2 000 = minimum score) |
| 9 | Discord | 2 | compte lié via `/discord-link` = full score |

Without battle log (criterion 6 absent): max = **45 pts**. With last seen and win rate: **53 pts** maximum.

### War reliability score — fallback mode (0–36 pts)

Used when no race log history is available (battle log only):

| # | Criterion | Max | Cap / rule |
|---|---|---|---|
| 1 | War activity | 12 | Decks/day over sliding window; bonus +0.2 pt per 4‑deck day, penalty ‑0.1 pt per short day |
| 2 | Win rate (war) | 5 | From battle log war battles · **min. 10 GDC battles** (scores 0 otherwise) |
| 3 | CW2 battle wins | 8 | 250 total CW2 wins = full score |
| 4 | Last seen | +5 | same as above but only awarded after ≥16 war decks in log |
| 5 | General activity | 8 | 20 competitive battles = full score |
| 6 | Experience | 3 | 12,000 best trophies = full score |
| 7 | Donations | 2 | 100 000 total cards donated = full score (≤ 2 000 = minimum score) |
| 8 | Discord | 2 | compte lié via `/discord-link` = full score |

### Verdict thresholds (both scoring modes)

| % of max score | Verdict | Colour |
|---|---|---|
| ≥ 75 % | High reliability | 🟢 Green |
| 56–74 % | Moderate risk | 🟡 Yellow |
| 31–55 % | High risk | 🟠 Orange |
| 0–30 % | Extreme risk | 🔴 Red |

### Member activity score (clan view, 0–100)

Computed from the `/members` endpoint only (no battle log required):

```
score = min(40, totalDonations / 100000 × 40)
      + min(40, trophies  / 10000 × 40)
      + min(20, expLevel  / 60 × 20)
```

Same 4-tier verdict thresholds apply (76 / 61 / 31).

---

## 🤖 Bot Discord

Le bot Discord expose des slash commands qui affichent les analyses directement dans un serveur Discord.

### Commandes disponibles

| Commande | Description |
|---|---|
| `/trust tag:#TAG` | Analyse la fiabilité d'un joueur |
| `/trust-clan clan:N` | Liste les membres High/Extreme risk d'un clan (N = 1/2/3) |
| `/promote clan:N min:X` | Liste les joueurs ≥ X fame la semaine précédente |
| `/discord-link tag:#TAG` | Lie un compte Clash à un Discord |
| `/discord-check clan:N` | Vérifie la présence Discord des membres d'un clan |

### Architecture

```
Discord → POST /api/discord/interactions   (api/discord/interactions.js)
              │
              ├─ type 1 (PING)      → { type: 1 }   (validation endpoint)
              │
              └─ type 2 (commande)  → { type: 5 }   (deferred, <3 s)
                                       runBackground(
                                         fetch /api/.../analysis
                                         → webhook follow-up Discord
                                       )
```

La fonction Discord est **séparée** de l'app Express (`api/index.js`) pour garantir un cold start minimal (< 1 s au lieu de 3‑4 s), impératif pour respecter la fenêtre de 3 s imposée par Discord.

### Points techniques clés

| Problème | Solution |
|---|---|
| Validation endpoint Discord échoue | La vérification de signature Ed25519 doit se faire **avant** de répondre au PING, pas après |
| Cold start > 3 s → "application did not respond" | Fonction Vercel dédiée (`api/discord/interactions.js`) sans Express, uniquement `node:crypto` natif |
| Fonction tuée après `res.end()` | `runBackground(fn)` appelle `waitUntil(fn())` de `@vercel/functions` — maintient la fonction active |
| `Promise.resolve().then(fn)` sans waitUntil | Vercel coupe la VM dès que `res.json()` est envoyé — utiliser `runBackground` **uniquement** |
| Syntaxe cassée → module entier planté | Ne jamais écrire de saut de ligne littéral dans `'...'`. Utiliser `'\`\`\`\n'` |
| Import direct de services backend | Ne jamais `import('../../backend/routes/clan.js')` dans un handler — appeler l'endpoint HTTP |
| Vérification de signature | Reconstruit la clé publique Ed25519 depuis hex → SPKI DER via `node:crypto` |

### Patron obligatoire pour toute nouvelle commande

```js
if (body.type === 2 && body.data?.name === 'ma-commande') {
  // 1. Parser les options SYNCHRONEMENT (pas d'await)
  const opt = body.data.options?.find((o) => o.name === 'mon-option');

  // 2. Répondre IMMÉDIATEMENT — avant tout await
  res.status(200).json({ type: 5 });
  const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

  // 3. Travail lourd dans runBackground (maintient Vercel actif via waitUntil)
  runBackground(async () => {
    try {
      // Toujours appeler les endpoints HTTP, jamais les services directement
      const resp = await fetch('https://trustroyale.vercel.app/api/...');
      await fetch(webhookUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }) });
    } catch (err) {
      await fetch(webhookUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }) });
    }
  });
  return;
}
```

### Variables d'environnement requises

```
DISCORD_PUBLIC_KEY=   # Clé publique du bot (onglet "General Information")
DISCORD_APP_ID=       # Application ID du bot
DISCORD_TOKEN=        # Token du bot (pour le script d'enregistrement)
```

### Enregistrement des commandes

```bash
node scripts/registerCommands.js
```

À relancer après tout ajout ou modification de commande.

### Invitation du bot sur un serveur Discord

1. Aller sur le [Discord Developer Portal](https://discord.com/developers/applications) → sélectionner l'application
2. Onglet **OAuth2 → URL Generator**
3. Cocher les scopes : `bot` + `applications.commands`
4. Dans les permissions bot, cocher au minimum : `Send Messages`
5. Copier l'URL générée et l'ouvrir dans un navigateur → choisir le serveur cible → Autoriser

### Format des réponses

**`/trust`**

```
🟢 NomJoueur ⤑ 93 % (Fiabilité élevée)
✅ Activité de guerre  10/12    ✅ Victoires CW2  8/8
⚠️ Winrate (guerre)    1.9/3   ✅ Expérience     3/3
✅ Dons                2/2
Tag : #YRGJGR8R
```

**`/trust-clan`**

```
⚠️  Les Resistants (4 joueurs à risque)
- NomJoueur   (new) #TAG [Co-Leader] 🔴 Extreme risk (28%)
- AutreJoueur       #TAG [Member]    🟠 High risk    (45%)
```

**`/promote`**

```
🏅 Semaine de GDC précédente — La Resistance (≥ 2800 fame)
 1. NomJoueur   3200 fame  [Co-Leader]
 2. AutreJoueur 3000 fame  [Member]
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
