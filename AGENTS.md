# AGENTS.md

## Comportement global

- Réponds en français.
- Sois concis : pas de préambule ni de conclusion, 1-4 lignes sauf si détail demandé.
- Ne commit pas — l'utilisateur s'en charge.
- Utilise `rg` (ripgrep) plutôt que `grep` pour les recherches textuelles.
- Commentaires en français.

## Projet

**TrustRoyale** — Analyseur de fiabilité GDC Clash Royale — backend Express + frontend Vite, déployé sur Vercel.

## CodeGraph — index sémantique obligatoire

Avant toute exploration de code dans un nouveau projet :
```bash
codegraph init      # une fois à la création du projet
codegraph index     # pour indexer les contenus initialement
codegraph sync      # pour rafraîchir l'index (début ou fin de session)
```

Utiliser les outils `codegraph_*` (context, explore, search, trace, impact) pour les questions structurelles — plus rapides et précis que grep/lecture.

## Sources de vérité — règle absolue

**Avant de modifier ou d'implémenter une formule de scoring, un calcul de niveau, ou toute logique métier, consulter d'abord `CONTRIBUTING.md`** à la racine. Ce document est la source de vérité unique pour :
- les formules de score, matchup, projection GDC
- le calcul du niveau de Tour du Roi
- les paliers de ligue, barèmes de points, seuils de verdict
- toute règle métier documentée

## Vercel Serverless — règle absolue

`/tmp/` est le seul dossier writable. `frontend/`, `data/`, `backend/` sont read-only au déploiement.

Conséquences :
- `clanCache.js` écrit dans `/tmp/clan-cache/` (lit `/tmp` puis `frontend/public/clan-cache/` en fallback)
- `snapshot.js` écrit dans `/tmp/clash-snapshots/` (copie persistante dans `data/snapshots/` si accessible)
- `data/*.json` : lisible depuis le bundle, **non modifiable** sur Vercel

## Stack, architecture, saison, scripts

Voir `CONTRIBUTING.md` pour :
- **Stack technique** — ESM, Express, Vite, Chart.js
- **Architecture backend** — services, barrels, fonctions clés (`dateUtils`, `warScoring`, …)
- **Semaine/saison Clash Royale** — `computeCurrentWeekId`, rollover, reset times
- **Scripts utiles** — `notifyWarSummary`, `collectSnapshots`, `registerCommands`…
- **Formules et scoring** — fiabilité, projection, matchup, paliers ligue
- **Bot Discord** — architecture, `runBackground`, enregistrement des commandes

## Variables d'environnement — déploiement

Toute nouvelle variable d'environnement doit être :

1. **Ajoutée à `api/discord/interactions.js`** (via `process.env.MA_VAR`) — exécution du bot
2. **Déclarée dans `.env.example`** (valeur vide ou placeholder) — template pour les devs
3. **Configurée sur Vercel → Settings → Environment Variables** — production (le `.env` local n'est pas lu sur Vercel)

Le `.env` local suffit pour le développement, mais **Vercel est obligatoire** pour la prod.

## Commandes essentielles

```bash
npm run dev      # backend :3000 + frontend :5173
npm run build    # vite build + vercel --prod
npm run cache    # régénère le cache statique
npm run rules:dry -- --force  # tester le post règles sans poster
```

## Conventions code

- **ESM obligatoire** : `"type": "module"` — pas de `require()`
- **CSS** : natif uniquement, pas de styles inline (bloqué par CSP)

## Conventions scripts temporaires

- Les scripts de debug/test ad-hoc (CJS, Node) vont dans `/temp`
- Ne pas laisser de fichiers `findconst*` à la racine du repo
- Usage local uniquement, pas pour la production

## Discord Embed — limites caractères

| Champ | Limite |
|---|---|
| `description` | 4096 |
| `field.value` | 1024 |
| Fields par embed | 25 |
| Embeds par message | 10 |

Ne pas confondre `description` (4096) et `field.value` (1024) — pour une longue liste, utiliser la `description`.

## Bot Discord — règles critiques

- `res.status(200).json({ type: 5 })` **avant tout `await`**
- `runBackground()` obligatoire (jamais `Promise.resolve().then()`)
- Ne pas importer les services backend directement depuis un handler Discord → passer par les endpoints HTTP
- Pas de backtick littéral multiligne dans une string (`'```\n'` correct, pas de vrai saut de ligne)

### Commandes disponibles

| Commande | Description |
|---|---|
| `/trust tag:#TAG` | Analyse fiabilité joueur |
| `/stats tag:#TAG` | Statistiques GDC détaillées |
| `/matchup tag:#TAG` | Calcule le matchup GDC d'un joueur |
| `/discord-link tag:#TAG` | Lie un tag Clash au compte Discord |
| `/discord-check clan:N` | Vérifie présence Discord des membres |
| `/promote clan:N` | Joueurs éligibles à la promotion (2600 pts) |
| `/demote clan:N` | Joueurs n'ayant pas fait 16/16 decks |
| `/fail clan:N` | Joueurs ayant manqué une journée GDC |
| `/trust-clan clan:N` | Membres High/Extreme risk |
| `/late clan:N` | Retardataires GDC du jour |
| `/late-ping clan:N` | `/late` avec ping, réservé staff |
| `/compare clan:N` | Clans du groupe GDC |
| `/top-players number:X period:W` | Meilleurs joueurs famille |
| `/top-clans` | Classement France GDC |
| `/collection tag:#TAG` | Statistiques de collection |
| `/help` | Aide détaillée du bot |
| `/clan clan:N\|tag:#TAG` | Fiche récapitulative clan |
| `/family` | Résumé des clans de la famille |
| `/chelem clan:N [season:X]` | Joueurs 16/16 decks par semaine |
| `/recap [saison:-1\|-2]` | Bottom 10 La Resistance / top 10 Les Resistants (saison passée) |
| `/frame` | Scores personnels au jeu Frame (devine le film) — manche en cours, historique, total saison |

## Sous-agents

Utiliser des **sous-agents** (Task tool) pour exploration de code, recherche, revue, investigation — tout ce dont seul le résumé compte. Ne pas encombrer la conversation principale.

## Langue

TrustRoyale est exclusivement en français (web app et bot Discord) — pas de
système multilingue, pas de dictionnaire de traduction. Tout texte visible
utilisateur (UI, embeds Discord, messages d'erreur) doit être écrit en
français directement dans le code, en littéral. Les URLs sont sans préfixe
de langue (`/player/:tag`, `/clan/:tag`).

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
