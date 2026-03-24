# AGENTS.md

## Projet

**TrustRoyale** — Analyseur de fiabilité de guerre de clan Clash Royale — backend Express + frontend Vite, déployé sur Vercel.

## Stack technique

- **Backend** : Node.js ESM, Express 4, `node-fetch`, port 3000 en dev
- **Frontend** : Vite 5, Vanilla JS, Chart.js 4, pas de framework
- **Déploiement** : Vercel (`vercel --prod` depuis la racine), `api/index.js` comme entrée serverless
- **Cache** : in-memory, TTL 15 min (`backend/services/cache.js`)

## Commandes essentielles

```bash
npm run dev      # backend :3000 + frontend :5173 (concurrently)
npm run build    # vite build + vercel --prod
```

## Conventions critiques du projet

- **ESM obligatoire** : `"type": "module"` dans le backend — pas de `require()`
- **Verdicts** : 4 paliers stricts — vert ≥ 75 %, jaune 56–74 %, orange 31–55 %, rouge 0–30 %
- **maxScore** : mode principal 53 pts (avec win rate) / 50 pts (sans) ; fallback 40 pts (45 pts avec last seen) — Discord toujours inclus (+2)- **Transferts familiaux** : présence d'un champ `isFamilyTransfer` dans les réponses API (clan + joueur). Le score est calculé à partir du war log (pas du battle log) si le joueur a joué ≥ 13 decks la semaine précédente dans un autre clan de la famille.
## Conventions générales critiques

- **CSS** : pas de styles inline (bloqués par CSP). CSS natif uniquement, pas de Tailwind/Bootstrap.
- **Commits** : Conventional Commits — type en anglais, description en français ex : `feat(clan): ajoute filtre par verdict`
- **Commentaires** : en français

## Bot Discord — règles critiques

### Architecture de chaque commande

Toute commande Discord qui fait un appel réseau **doit** suivre ce patron exact, sans exception :

```js
// 1. Répondre IMMÉDIATEMENT avec type:5 (deferred) — avant tout await
res.status(200).json({ type: 5 });

// 2. Construire l'URL du webhook AVANT runBackground
const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

// 3. Lancer le travail lourd dans runBackground (maintient Vercel actif via waitUntil)
runBackground(async () => {
  try {
    // ... appels API, construction de la réponse ...
    await fetch(webhookUrl, { method: 'POST', ... });
  } catch (err) {
    await fetch(webhookUrl, { method: 'POST',
      body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }) });
  }
});
return;
```

### Règles absolues

- **`runBackground` uniquement** — ne jamais appeler `Promise.resolve().then(fn)` directement (Vercel tue la fonction). `runBackground` est défini dans `interactions.js` et appelle `waitUntil(fn())`.
- **Ne jamais importer `buildClanAnalysis` ou des services backend directement** dans un handler Discord — la fonction surchargerait et expirerait. Toujours passer par l'endpoint HTTP :
  - Joueur : `https://trustroyale.vercel.app/api/player/:tag/analysis`
  - Clan : `https://trustroyale.vercel.app/api/clan/:tag/analysis`
- **Pas de backtick littéral multiligne dans une string** (`` '```\n' `` est correct, un vrai saut de ligne dans `'...'` est une SyntaxError qui crashe tout le module).
- **`res.status(200).json({ type: 5 })` avant tout `await`** — si un await précède, Discord timeout car la réponse arrive trop tard.

### Enregistrement des commandes

```bash
node scripts/registerCommands.js
```

À relancer après tout ajout ou modification de commande.

### Commandes disponibles

| Commande | Description |
|---|---|
| `/trust tag:#TAG` | Analyse la fiabilité d'un joueur |
| `/promote clan:N min:X` | Liste les joueurs ≥ X fame de la semaine précédente |
| `/trust-clan clan:N` | Liste les membres High/Extreme risk d'un clan |
| `/chelem clan:N [season:X]` | Liste les joueurs 16/16 decks chaque semaine d'une saison |
| `/top-players number:X period:[week|season] scope:[previous|actual]` | Liste les meilleurs joueurs de la famille pour la période demandée |
| `/discord-link tag:#TAG` | Lie un compte Clash à un Discord |
| `/discord-check clan:N` | Vérifie la présence Discord des membres d'un clan |
| `/late clan:N` | Liste les retardataires de la journée de GDC (avant reset) |

## Sous-agents

Utiliser des **sous-agents** (Task tool) par défaut pour toute opération dont seul le résumé compte : exploration de code, recherche, revue, investigation. Ne pas encombrer la conversation principale.
