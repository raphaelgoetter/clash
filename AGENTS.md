# AGENTS.md

## Projet

**TrustRoyale** — Analyseur de fiabilité de guerre de clan Clash Royale — backend Express + frontend Vite, déployé sur Vercel.

## Stack technique

- **Backend** : Node.js ESM, Express 4, `node-fetch`, port 3000 en dev
- **Frontend** : Vite 5, Vanilla JS, Chart.js 4, pas de framework
- **Déploiement** : Vercel (`vercel --prod` depuis la racine), `api/index.js` comme entrée serverless
- **Cache** : in-memory, TTL 15 min (`backend/services/cache.js`)

## Système de fichiers sur Vercel Serverless — règle absolue

Les fonctions Vercel s'exécutent dans un environnement **read-only** sauf pour `/tmp`.

| Chemin                                              | Accès                  | Usage                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tmp/`                                             | **lecture + écriture** | Seul dossier writable. Utiliser `/tmp/<sous-dossier>/` pour tout fichier généré à l'exécution. Durée de vie : le container Lambda (quelques minutes à quelques heures). |
| Tout le reste (`frontend/`, `data/`, `backend/`, …) | **lecture seule**      | Fichiers bundlés au déploiement. Écrire dessus échoue silencieusement ou lève une erreur.                                                                               |

**Conséquences pratiques :**

- `clanCache.js` écrit dans `/tmp/clan-cache/` et lit d'abord `/tmp`, puis `frontend/public/clan-cache/` (bundle statique pré-généré par `npm run cache`).
- `snapshot.js` et tout code qui crée/modifie des fichiers JSON au runtime doivent pointer vers `/tmp/`.
- `data/war-summary-log.json`, `data/discord-links.json` : lisibles depuis le bundle, **non modifiables** sur Vercel — les scripts qui y écrivent ne fonctionnent qu'en local ou via CI.

## Architecture des services backend

`backend/services/` est découpé en modules spécialisés. **Ne jamais réécrire dans `analysisService.js` directement** — c'est désormais un barrel de ré-exports.

| Fichier              | Rôle                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `analysisService.js` | **Barrel** — re-exporte tout pour rétrocompatibilité                                                                                  |
| `dateUtils.js`       | `parisOffsetMs`, `warResetOffsetMs`, `warDayKey`, `parseClashDate`, `MS_PER_DAY`, **`computeCurrentWeekId`**, **`computePrevWeekId`** |
| `battleLogUtils.js`  | `filterWarBattles`, `categorizeBattleLog`, `expandDuelRounds`, `isWarWin/Loss`, `buildDailyActivity`                                  |
| `warScoring.js`      | `computeWarScore`, `computeWarReliabilityFallback`, `scoreTotalDonations`, `estimateWinsFromFame`                                     |
| `warHistory.js`      | `buildWarHistory`, `buildFamilyWarHistory` (avec cache course)                                                                        |
| `playerAnalysis.js`  | `analyzePlayer`, `getPlayerAnalysis`, `buildCurrentWarDays`, `computeIsNewPlayer`, `computeMemberReliability`                         |
| `clashApi.js`        | Wrappers HTTP vers l'API Clash Royale                                                                                                 |
| `cache.js`           | Cache mémoire générique (`getOrSet`, `invalidate`)                                                                                    |
| `clanCache.js`       | Lecture/écriture du cache clan persistant (JSON sur disque)                                                                           |
| `snapshot.js`        | Snapshots de decksUsed quotidiens (fichiers `data/snapshots/`)                                                                        |
| `discordLinks.js`    | Mapping tag joueur → Discord ID (GitHub Gist + fallback local)                                                                        |
| `topplayers.js`      | `computeTopPlayers` — classement de la famille par points                                                                             |
| `uncomplete.js`      | `computeUncomplete` — liste des joueurs avec < 16 decks                                                                               |

## Semaine / Saison Clash Royale — source de vérité

- Une saison dure environ un mois et commence toujours le **premier lundi du mois**, juste après le reset GDC (**09:40 UTC, ou selon le clan**).
- **⚠️ L'heure du reset de chaque clan (**`CLAN_RESET_TIMES`**) change à chaque nouvelle Saison.** Elle n'est pas connue à l'avance et il faut la renseigner à la main dans `dateUtils.js` à chaque saison.
- Elle est composée de **3 à 5 semaines** selon le nombre de lundis dans le mois.
- L'API représente les semaines avec `seasonId` (entier, ex. 130) et `sectionIndex` (0-based : W1=0, …, W5=4).
- `/currentriverrace` **ne fournit pas de `seasonId`** — on le déduit de `raceLog[0].seasonId`.
- **Rollover de saison** : si `currentRace.sectionIndex ≤ raceLog[0].sectionIndex`, le compteur a repassé par 0 → saison suivante (`seasonId + 1`).
- **Fonctions canoniques** (dans `dateUtils.js`, re-exportées par `analysisService.js`) :
  - `computeCurrentWeekId(currentRace, raceLog)` → `"S130W5"` (semaine en cours)
  - `computePrevWeekId(raceLog)` → `"S130W4"` (dernière semaine terminée)
- **Ne jamais recalculer weekId à la main** — toujours utiliser ces deux fonctions.

## Commandes essentielles

```bash
npm run dev      # backend :3000 + frontend :5173 (concurrently)
npm run build    # vite build + vercel --prod
npm run cache    # régénère frontend/public/clan-cache/*.json (via scripts/refreshClanCache.js)
```

## Scripts utiles

| Script                           | Commande / usage                   | Rôle                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/refreshClanCache.js`    | `npm run cache`                    | Précalcule et persiste l'analyse de tous les clans dans `frontend/public/clan-cache/`                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/collectSnapshots.js`    | `node scripts/collectSnapshots.js` | Enregistre les snapshots de decksUsed quotidiens depuis le race log                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/registerCommands.js`    | `node scripts/registerCommands.js` | Enregistre/met à jour les slash-commands Discord                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/notifyMemberChanges.js` | `npm run notify-members`           | Diff membres clan (cache N-1 vs API actuelle) et poste un embed Discord par clan si changement. `--dry-run` affiche sans poster, `--simulate` utilise des données fictives                                                                                                                                                                                                                                                                             |
| `scripts/notifyWarSummary.js`    | `npm run war-summary`              | **Résumé quotidien GDC** — poste un embed dans chaque channel famille après le reset (10h05 UTC). J1→J3 : points + decks du jour vs veille. J4 (dimanche) : idem + bilan de semaine (points totaux, decks / 800, moyenne/jour). Colossée : pts = cumul natif du dernier snapshot ; GDC classique : somme des journées. Déduplication via `data/war-summary-log.json`. `--dry-run` affiche sans poster. Workflow : `.github/workflows/war-summary.yml`. |

## Conventions de génération de scripts temporaires

- scripts de debug/test d’exploration rapide (CJS, Node scripts ad-hoc) doivent être placés dans `/temp`.
- ne pas laisser de fichiers `findconst*` dans la racine du repo.
- ces scripts sont conçus pour usage local, pas pour production.

## Conventions critiques du projet

- **ESM obligatoire** : `"type": "module"` dans le backend — pas de `require()`
- **Verdicts** : 4 paliers stricts — vert ≥ 75 %, jaune 56–74 %, orange 31–55 %, rouge 0–30 %
- **maxScore** : mode principal 53 pts (avec win rate) / 50 pts (sans) ; fallback 40 pts (45 pts avec last seen) — Discord toujours inclus (+2)- **Transferts familiaux** : présence d'un champ `isFamilyTransfer` dans les réponses API (clan + joueur). Le score est calculé à partir du war log (pas du battle log) si le joueur a joué ≥ 13 decks la semaine précédente dans un autre clan de la famille.
- **Projection de Guerre (GDC)** : Calculée uniquement en `periodType: warDay`.
  - **Cible ($T$)** : Moyenne quotidienne de decks de la semaine précédente (via `riverracelog[0]`), arrondie à l'entier. Fallback : 200.
  - **Efficacité ($E$)** : Points accumulés ÷ Total decks joués (hebdomadaire).
  - **Formule** : $Projection = Fame\_Actuelle + (max(0, T - Decks\_Aujourd'hui) \times E)$.
  - **Tri** : En période de GDC, la liste des clans est triée par Projection décroissante.

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
- **Pas de backtick littéral multiligne dans une string** (`'```\n'` est correct, un vrai saut de ligne dans `'...'` est une SyntaxError qui crashe tout le module).
- **`res.status(200).json({ type: 5 })` avant tout `await`** — si un await précède, Discord timeout car la réponse arrive trop tard.

### Enregistrement des commandes

```bash
node scripts/registerCommands.js
```

À relancer après tout ajout ou modification de commande.

### Commandes disponibles

| Commande                            | Description                                                              |
| ----------------------------------- | ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `/trust tag:#TAG`                   | Analyse la fiabilité d'un joueur                                         |
| `/promote clan:N min:X`             | Liste les joueurs ≥ X points de la semaine précédente                    |
| `/trust-clan clan:N`                | Liste les membres High/Extreme risk d'un clan                            |
| `/chelem clan:N [season:X]`         | Liste les joueurs 16/16 decks chaque semaine d'une saison                |
| `/top-players number:X period:[week | season] scope:[previous                                                  | actual]` | Liste les meilleurs joueurs de la famille pour la période demandée |
| `/discord-link tag:#TAG`            | Lie un compte Clash à un Discord                                         |
| `/discord-check clan:N`             | Vérifie la présence Discord des membres d'un clan                        |
| `/late clan:N`                      | Liste les retardataires de la journée de GDC (avant reset)               |
| `/compare clan:N`                   | Affiche les clans du groupe GDC (membres, trophées, score, dernière GDC) |

## Sous-agents

Utiliser des **sous-agents** (Task tool) par défaut pour toute opération dont seul le résumé compte : exploration de code, recherche, revue, investigation. Ne pas encombrer la conversation principale.

## Internationalisation (i18n) / translations

- `frontend/public/lang/en.json` et `frontend/public/lang/fr.json` sont la source unique de vérité.
- Supprimez `frontend/lang` (doublon), gardez seulement `frontend/public/lang`.
- Pour toute nouvelle feature ou texte visible utilisateur,
  - vérifier que la clé de traduction existe dans `frontend/public/lang/en.json` et `frontend/public/lang/fr.json`.
  - si la clé n'existe pas, l'ajouter dans les deux fichiers EN/FR.
  - utiliser `t('key')` côté JS quand possible pour charger la traduction.
- Pour les messages de chart tooltip/label générés dynamiquement, passer un argument `t('...')` à la fonction de rendu.
- Dans la revue de PR, demander explicitement : "Vérifié/en: `english-text`, fr: `texte-fr`?"
- Documenter dans la PR description les traductions, p.ex. :
  - `raceTimeLateBucketWarning`: EN/FR.
  - `riverRaceHistoryWarn`: EN/FR.
