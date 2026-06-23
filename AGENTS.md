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
| `/quota clan:N quota:V` | Moyenne GDC et sous-quota |
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

## Sous-agents

Utiliser des **sous-agents** (Task tool) pour exploration de code, recherche, revue, investigation — tout ce dont seul le résumé compte. Ne pas encombrer la conversation principale.

## Internationalisation (i18n)

- Sources : `frontend/public/lang/en.json` et `fr.json`
- Utiliser `t('key')` côté JS
- Ajouter les clés dans les deux fichiers pour toute nouvelle feature ou texte visible utilisateur
