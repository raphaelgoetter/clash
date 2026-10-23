# ⚔️ TrustRoyale : documentation développeurs

Documentation développeurs de **TrustRoyale** (analyse de fiabilité GDC Clash Royale) et organisation du monorepo. Ce fichier est la source de vérité des règles métier GDC (formules, barèmes, seuils). La documentation utilisateur reste dans `README.md`.

➡️ Tout ce qui concerne les jeux Discord (mini-jeux hebdomadaires, jeux spéciaux, duels) est dans [`jeux/CONTRIBUTING.md`](jeux/CONTRIBUTING.md).

---

## Organisation du dépôt (monorepo)

Le dépôt sépare TrustRoyale (GDC) et les jeux Discord, avec deux packages partagés déclarés en workspaces npm (`package.json` racine : `packages/*`, `jeux`) :

| Dossier | Package | Contenu |
| --- | --- | --- |
| `backend/`, `api/`, `frontend/`, `scripts/`, `data/` | (racine) | TrustRoyale : analyse GDC, site, commandes et notifications GDC |
| `jeux/` | `@clash/jeux` | Mini-jeux, jeux spéciaux et duels : `services/`, `discord/handlers/`, `discord/routes/`, `server/imageRoutes.js` (images servies en HTTP), `scripts/`, `data/` |
| `packages/commun/` | `@clash/commun` | Infrastructure générique : cache mémoire, Blob, helpers Discord (`discordUsers`, `discordRoles`, `discordInteractions`, `discordChannels`…), `classement`, `textNormalize` |
| `packages/clash-royale/` | `@clash/clash-royale` | Domaine Clash Royale : `clashApi`, `dateUtils` (saisons/semaines), `cardImage`, `cardArt`, `collectionConstants`, `famille` (`FAMILY_CLAN_TAGS`) |

Règles de dépendance :

- `jeux/` n'importe jamais `backend/`, `api/` ni `scripts/` : uniquement ses propres fichiers et `@clash/commun` / `@clash/clash-royale` ;
- les packages n'importent jamais une application ;
- la racine n'importe `jeux/` qu'à deux points de branchement, en attendant le déploiement séparé du bot des jeux : `api/discord/interactions.js` (routes Discord) et `backend/server.js` (`jeux/server/imageRoutes.js`).

Les imports vers un package utilisent le nom du workspace (`import { getOrSet } from "@clash/commun/cache.js"`), jamais un chemin relatif ; `npm install` à la racine crée les liens dans `node_modules/@clash/`. Les scripts npm des jeux restent déclarés dans le `package.json` racine (`node jeux/scripts/…`), à lancer depuis la racine pour que `./.env` soit trouvé. Les clés Blob (`readBlobAsset("bang/…")`) restent relatives au dossier de données, quel qu'il soit (`data/` ou `jeux/data/`).

---

## Scripts utiles

Scripts TrustRoyale (`package.json` racine ; les scripts des jeux sont listés dans `jeux/CONTRIBUTING.md`). Les variantes `:dry` passent `--dry-run` (rien n'est posté ni écrit).

| Script npm | Fichier | Rôle |
| --- | --- | --- |
| `dev` | | Backend Express :3000 + frontend Vite :5173 |
| `test` | | `node --test` sur `backend/`, `jeux/`, `packages/` (Redis simulé via `@clash/commun/testing/registerFakeRedis.js`) |
| `build` / `deploy` | | Build Vite + `vercel --prod` (`prebuild` lance `cache`) ; le déploiement de `main` est de toute façon automatique |
| `cache` | `scripts/refreshClanCache.js` | Régénère le cache clan (Redis), servi par `GET /api/clan/:tag/cache` |
| `snapshot` | `scripts/collectSnapshots.js` | Snapshots horaires de guerre + cumul matchup GDC |
| `pre-reset-snapshot` | `scripts/preResetSnapshot.js` | Snapshot juste avant le reset (fiabilise les totaux journaliers) |
| `notify-members` (`:dry`, `:sim` = dry-run + données simulées) | `scripts/notifyMemberChanges.js` | Arrivées, départs, changements de rôle |
| `war-summary` (`:dry`) | `scripts/notifyWarSummary.js` | Résumé quotidien/hebdo de guerre après le reset |
| `clan-status` (`:dry`) | `scripts/notifyClanStatus.js` | Statut des clans (salon staff) |
| `war-exploit` (`:dry`, `:test`) | `scripts/notifyWarExploit.js` | « Exploit du jour » (voir ci-dessous) |
| `last-seen` (`:dry`) | `scripts/notifyLastSeen.js` | Joueurs inactifs (`lastSeen` lu en live via l’API, jamais depuis le cache horaire) |
| `gdc-launch` (`:dry`) | `scripts/notifyGdcLaunch.js` | Annonce de lancement GDC (jeudi) |
| `pre-war-summary` (`:dry`) | `scripts/notifyPreWarSummary.js` | Résumé pré-GDC hebdo |
| `rules` (`:dry`, `:dry:noping`) | `scripts/notifyRules.js` | Rappel des règles, ne poste que le 1er mardi du mois (heure de Paris) |
| `discord-links:list` / `:set` / `:remove` | `scripts/discordLinks.js` | Administration des liens tag → Discord |
| `find-discord-clans` | `scripts/findDiscordClans.js` | Scouting ponctuel (voir ci-dessous) |
| `assets:upload-blob` | `scripts/uploadImageAssetsToBlob.js` | Copie ponctuelle des assets binaires de `data/` vers Vercel Blob |

Hors npm : `node scripts/registerCommands.js` (enregistre les slash commands, à relancer après tout ajout/modification de commande) ; `node scripts/deleteGuildCommands.js` (ponctuel, supprime les commandes de guilde en double).

### Exploit du jour (`notifyWarExploit.js`)

- Victoire GDC (1v1 ou manche de duel, hors bateau) au %matchup le plus élevé de la journée écoulée, un seul combat pour toute la famille ; départage par écart de couronnes puis combat le plus tôt.
- Salon `DISCORD_CHANNEL_GENERAL` ; `--test` poste sur le salon de test des jeux et ignore l'anti-doublon Redis `dedup:warexploit` (pour ne pas bloquer le cron).
- Image des deux decks jointe, même rendu que `/matchup-gdc` (`buildWarDecksImage()`, `backend/services/warDecksImage.js`) ; en dry-run, PNG écrit dans le dossier temporaire du système.

### Scouting (`findDiscordClans.js`)

- Liste les clans **français** dont la description mentionne « discord » (hors « famille »/« family ») et qui comptent entre `--min-active=N` (défaut 10) et `--max-active=N` (défaut 30) membres actifs (`lastSeen` < `--active-days=N`, défaut 2). `EXCLUDED_CLAN_TAGS` (dans le script) exclut la famille et des faux positifs revus à la main.
- Sortie : `data/discord-clans-fr.json` = `{ generatedAt, new, contacted }`. Le statut de contact (`status` `pending`/`rejected`, `note`) est tenu à la main dans `data/discord-clans-contacted.json` (clé = tag) ; y ajouter un clan le retire de `new`.
- ⚠️ La recherche `/clans` de l'API est plafonnée à ~640 résultats : le script découpe par tranches de taille (`minMembers`/`maxMembers`, largeur 2, de 2 à 50) et dédoublonne. Compter ~8 min d'exécution.

### Stockage Redis des scripts (Upstash)

Aucun script planifié ne fait de `git commit`/`push` : ⚠️ chaque commit sur `main` redéploie Vercel et sature le Function Storage. Tout l'état persistant est dans Redis :

| Clé | Contenu | Service / script |
| --- | --- | --- |
| `snapshots:<TAG>` | Snapshots de guerre d'un clan | `loadSnapshots()`/`recordSnapshot()`, `backend/services/snapshot.js` |
| `dedup:lastseen`, `dedup:warsummary`, `dedup:clanstatus`, `dedup:gdclaunch`, `dedup:pregdcweekly`, `dedup:warexploit` | Anti-doublon « déjà posté aujourd'hui/cette semaine » | scripts `notify*.js` correspondants |
| `dedup:warclinch` | Preuve de victoire J3 (`computeDay3ClinchProof`, utile en Colisée sans `finishTime`) | `notifyWarSummary.js` |
| `discordlinks` (hash) | Tag Clash → Discord user ID | `backend/services/discordLinks.js` |
| `blacklist` (hash) | Liste Noire | `backend/services/blacklist.js` |
| `matchupPerf:war` (hash) | Cumul matchup GDC 3 semaines | `backend/services/matchupPerformance.js` |

### Liens Discord (`/discord-link`)

- `getDiscordLinks()`/`setDiscordLinks()`/`deleteDiscordLinks()` (`backend/services/discordLinks.js`), écriture `HSET` atomique par tag.
- Tous les consommateurs passent par ce service : routes `/api/player`, `/api/clan`, commandes `/late`, `/late-ping`, `/discord-check`, scripts `notifyMemberChanges.js`, `notifyWarSummary.js`, `notifyPreWarSummary.js`.
- Administration manuelle :

```bash
npm run discord-links:list
npm run discord-links:set -- "#TAG" discordUserId ["#TAG2" discordUserId2 ...]
npm run discord-links:remove -- "#TAG" [...]
```

### Liste Noire (`/blacklist`)

- Hash Redis `blacklist` : un champ par `#TAG`, valeur `{ name, clans, reason, addedBy, addedAt }`. `clans` = historique des clans distincts (plus récent en tête, 5 max), initialisé depuis le journal de combats puis le clan actuel, mis à jour à chaque `consulte`. « Dernier clan connu » = premier clan de l'historique différent du clan actuel (`lastKnownClan()`).
- Accès : rôle Discord commençant par `STAFF` (`memberHasRolePrefix()`, `@clash/commun/discordRoles.js`) ; réponses éphémères. Handler : `api/discord/_handlers/blacklist.js`.
- `notifyMemberChanges.js`, à l'arrivée d'un joueur : `⚠️ Joueur figurant dans la Liste Noire` si son tag y figure ; `⚠️ Clan à risque (NOM)` si son dernier clan connu apparaît dans l'historique d'un *autre* joueur de la liste (`buildRiskyClanMap()`, clans de la famille exclus). Redis indisponible : notification envoyée sans ces avertissements.

### Thread dédié aux notifications d'un clan

- `resolveMembersChannelId(clanTag, { thread = true })` (`@clash/commun/discordChannels.js`) renvoie `DISCORD_THREAD_MEMBERS_<TAG>` si définie, sinon `DISCORD_CHANNEL_MEMBERS_<TAG>` ; `{ thread: false }` force le salon principal.
- Utilisé par `notifyWarSummary.js`, `notifyMemberChanges.js`, `notifyLastSeen.js`. Les autres scripts (`notifyPreWarSummary.js`, `notifyGdcLaunch.js`, `notifyRules.js`, `notifyClanStatus.js`) postent toujours dans le salon principal ou staff.
- Aucun clan n'a de thread configuré aujourd'hui. Pour en activer un : renseigner `DISCORD_THREAD_MEMBERS_<TAG>` dans `.env` et ajouter le secret GitHub Actions du même nom aux workflows `snapshot.yml`, `last-seen.yml`, `war-summary.yml`. Aucun changement de code.

### Planification (GitHub Actions)

Horaires en UTC (`.github/workflows/`) ; Paris = UTC+2 en été, UTC+1 en hiver. Workflows des jeux : voir `jeux/CONTRIBUTING.md`.

| Workflow | Cron (UTC) | Scripts | Salon |
| --- | --- | --- | --- |
| `snapshot.yml` | toutes les heures | `snapshot`, `notify-members`, `cache` | membres (arrivées/départs) |
| `pre-reset-snapshot.yml` | 07:30 ven, sam, dim, lun | `preResetSnapshot.js` | aucun |
| `war-summary.yml` | 10:05 tous les jours (poste ven à lun) | `notifyWarSummary.js`, `notifyClanStatus.js`, `notifyWarExploit.js` | membres, staff (`DISCORD_CHANNEL_STAFF`), général (`DISCORD_CHANNEL_GENERAL`) |
| `last-seen.yml` | 10:08 tous les jours | `notifyLastSeen.js` | membres |
| `gdc-launch.yml` | 10:30 jeudi | `notifyGdcLaunch.js` | membres |
| `pre-war-summary.yml` | 14:00 mercredi | `pre-war-summary` | membres |
| `rules.yml` | 14:00 mardi (poste le 1er mardi du mois) | `notifyRules.js` | membres |

- ⚠️ Les triggers `schedule` de GitHub sont _best-effort_ : retards possibles de 75 à 90 min aux heures chargées (d'où le départ à 07:30 de `pre-reset-snapshot.yml`, qui dort ensuite jusqu'à T−2 min avant chaque reset).
- ⚠️ Un trigger `schedule` peut se désynchroniser silencieusement (aucun run, alors que `workflow_dispatch` fonctionne) : pousser un commit qui touche le workflow sur la branche par défaut force un resync ([community#185355](https://github.com/orgs/community/discussions/185355)). Une occurrence manquée de `pre-reset-snapshot.yml` est irrécupérable.

---

## Référence API backend

| Méthode | Endpoint | Description |
| --- | --- | --- |
| GET | `/health` | Disponibilité du backend |
| GET | `/api/ip` | IP publique du serveur (whitelist API Clash Royale en local) |
| GET | `/api/debug` | Variables d'environnement critiques |
| GET | `/api/player/:tag` | Profil brut d'un joueur |
| GET | `/api/player/:tag/analysis` | Analyse complète d'un joueur (+ `warSnapshotDays`, `warCurrentWeekId`, `warSnapshotTakenAt`, `warResetUtcMinutes` si disponibles) |
| GET | `/api/player/:tag/battlelog` | Journal de combats |
| GET | `/api/clan/:tag` | Profil brut d'un clan |
| GET | `/api/clan/:tag/cache` | Analyse clan pré-calculée (Redis), rendu immédiat de la vue clan |
| GET | `/api/clan/:tag/lite` | Version allégée sans calcul complet de fiabilité |
| GET | `/api/clan/:tag/analysis` | Analyse complète du clan et de ses membres (clans `ALLOWED_CLANS` uniquement) |
| GET | `/api/clan/:tag/current-war`, `/members` | GDC en cours, membres |
| POST / GET | `/api/clan/:tag/snapshot`, `/snapshot-force`, `/snapshot-debug` | Snapshot à la demande et debug |
| GET | `/api/decks/player/:tag`, `/player/:tag/war-decks`, `/meta/top-war-decks` | Decks |
| GET | `/api/matchup/catalog` | Catalogue win conditions (page `/matchup/`) |
| GET | `/api/card-art/:fichier` | Illustrations de cartes à jour (Blob) |
| POST | `/api/cache/flush` | Vide le cache mémoire (dev) |

- Les tags gardent le `#` côté appelant, encodé `%23` dans l'URL.
- Champs de l'API Clash Royale (`currentriverrace`, `periodPoints`, `periodLogs`, `participants`…) : [docs/api-clash-royale.md](docs/api-clash-royale.md).

### Illustrations de cartes à jour (`packages/clash-royale/cardArt.js`)

L'API sert encore l'ancien design de certaines cartes (repérées avec `outils/compare_card_art.mjs`). Les PNG à jour de `data/card-art/` (copie sur Blob) remplacent l'ancien design partout : `fetchCards()` réécrit `iconUrls.medium` vers `/api/card-art/<fichier>` (URL d'origine dans `iconUrls.apiMedium`), `battleCardIconUrl()` fait de même, les rendus SVG lisent le fichier sur Blob.

Nouvelle carte périmée : PNG 285×420 dans `data/card-art/`, entrée dans `CARD_ART_OVERRIDES`, puis `npm run assets:upload-blob -- card-art`.

---

## Formules et scoring

### Projection de fin de journée (groupe GDC)

Source : `backend/routes/clan.js`, bloc `groupWithProjections` (commentaire de référence des champs en tête du bloc).

```text
projectedFame = max(decksToday, targetDecks) × ptsPerDeck
targetDecks   = min(practicalMaxDecksToday, decksToday + maxDecksByTime)
practicalMaxDecksToday = min(200, rosterSize × 4)      J1 (warDayIndex 0)
                         min(200, activeMembers × 4)   J2 à J4
maxDecksByTime = floor(temps avant reset / 3 min) × 2
```

- `rosterSize` = taille du roster (`clan.members`) ; `activeMembers` = membres du roster avec `decksUsed > 0` cette semaine (borné à `rosterSize`). Pour les rivaux, le roster est chargé au calcul du groupe.
- `ptsPerDeck` = `periodPoints / decksToday` (repli : moyenne historique du clan).
- En Colisée, la projection s'ajoute au total live de la semaine.

### `maxReachableFame` et victoire assurée (`isClinchedWin`)

```text
remainingDecks   = min(800 − decksSemaine, (200 − decksToday) + joursRestants × 200)
maxReachableFame = currentFame + remainingDecks × 200
```

- `isClinchedWin` : en Colisée, `currentFame > max(maxReachableFame des rivaux)` ; en GDC normale, progression du bateau ≥ 10 000 (ligne d'arrivée constatée, jamais anticipée).
- ⚠️ Plafond absolu 200 decks/jour, **jamais** `rosterSize × 4` : un clan peut recruter en cours de journée et les decks des partants restent comptés.
- `decksToday` et `clanWarSummary` utilisent `currentRace.clan.participants` **sans filtre** sur le roster actuel : les decks des membres partis pendant la journée ont réellement compté et l'API les renvoie toujours. `activeMembers`, lui, reste basé sur le roster actuel.

### Barème des médailles GDC

| Combat | Victoire | Défaite |
| --- | --- | --- |
| PvP | 200 | 100 |
| Bateau | 125 | 75 |
| Duel | 250 | 100 |

Source : `getWarMatchPoints()` dans `backend/services/battleLogUtils.js`. Tous les clans d'un groupe GDC partagent le même créneau de reset.

### Matchup GDC

Difficulté d'un combat calculée **uniquement** à partir des 8 cartes des deux decks joués (pas des statistiques de compte). Moteur commun à `/matchup-gdc` (combats de guerre regroupés par jour, `summarizeWarDecksForMatchup()`) et `/matchup` (6 derniers combats en modes standards GDC/Ladder/Classé/Amical, événements et 2v2 exclus, `summarizeRecentBattlesForMatchup()`). Le calcul (`computeDeckMatchupDetail()`) ne dépend pas du type de combat.

- Base `scoreA = 50` (avantage du deck A) + 4 layers additifs ; 1 point ≈ 1 % de probabilité de défaite (régression logistique sur ~20 000 combats). `scoreA` borné à `[5, 95]`.
- `matchup` (difficulté affichée, 0-1) = `(100 − scoreA) / 100` ; `analysis.matchup.average` = moyenne sur les combats GDC récents (à défaut, derniers combats compétitifs).
- ⚠️ Toute modification de pondération : relancer la calibration `outils/matchup-calibration/collect.mjs` puis `analyze.mjs` (`audit.mjs` pour valider les règles).

| Layer (clé `breakdown`) | Borne | Fonction | Règle |
| --- | --- | --- | --- |
| `level` | ±40 + ±8 | `computeLevelDifferentialLayer()` | 2 % par point d'écart de la somme des niveaux normalisés (`normLevel()`) des 8 cartes, plafond ±40 ; + 4 % par niveau d'écart du niveau moyen des win conditions, ±8. Facteur le plus prédictif |
| `evolutions` | ±9 | `computeEvolutionLayer()` | 3 % par carte d'écart avec `evolutionLevel > 0` (évolution et héros comptés pareil) |
| `counters` | ±6 | `computeCounterLayer()` / `counterShiftFor()` | Par win condition : `+3` − 3 par hard-counter − 1 par soft-counter adverse, borné ±3 ; layer = moyenne(A) − moyenne(B) |
| `structure` | ±10 (`clamp` du JSON) | `computeUtilityLayer()` | Règles data-driven de `data/clash-royale-matchup-structure-rules.json` : `crossRules` (Bait face à 0 petit sort adverse ; Ronin/P.E.K.K.A/Mini P.E.K.K.A face à un gros DPS), `dispersionRules` (trop de win conditions/sorts/bâtiments), `selfRules` (0 anti-air, 0 sort, 0 carte < 3 élixir). `exclusiveGroup` supporté, inutilisé |

- Sans vraie win condition reconnue, repli sur des « pseudo win conditions » (P.E.K.K.A, Mini P.E.K.K.A, Mega Knight, Boss Bandit…, moyennées). Si un des deux camps n'en a aucune, counters et écart de niveau des win conditions sont neutralisés.
- Le champ `archetype` du catalogue sert uniquement à la règle Bait et à la page `/matchup/` (pas de layer archétype).

#### Performance (victoires réelles vs attendues)

Affichée dans `/matchup`, `/matchup-gdc` (« 🎯 Performance »), `/stats` (« Performance (3 semaines) ») et `/stats-clan` (colonne « 🎯 », écart seul, « — » sous 4 combats).

- Victoires attendues = Σ `(1 − matchup)` ; écart = réelles − attendues. Écart en gras seulement si |écart| ≥ 2 écarts types (`√Σ p(1−p)`) ; emoji `success`/`error` selon le signe ; pas de ligne sous 4 combats.
- Combats retenus (`listMatchupPerformanceSamples()`, `battleLogUtils.js`) : modes calibrés seulement (`Ladder`, `Ranked1v1*`, `CW_Battle_1v1`, `CW_Duel_1v1`, `Friendly`), manches de duel séparées, égalités exclues.
- `/matchup` : battle log seul (25 à 40 combats). `/matchup-gdc` et `/stats` : 3 semaines glissantes via le hash `matchupPerf:war` (champ = tag sans `#`, valeur `[{ key, t, p, w }]`, `key` = `battleTime:manche`, difficulté figée à l'enregistrement), alimenté par `collectSnapshots.js` (`recordWarMatchupSamples()`, sans appel API supplémentaire, purge > 21 jours) et complété à la lecture par le battle log courant (`getWarMatchupPerformanceSamples()`).

#### Sources de vérité matchup

- Moteur pur synchrone : `backend/services/matchupEngine.js` (`computeDeckMatchupScore()`).
- Catalogue win conditions/counters : `data/clash-royale-matchup-catalog.json` ; règles Structure : `data/clash-royale-matchup-structure-rules.json`. Chargés par `backend/services/matchupCatalog.js` depuis l'API GitHub Contents (cache 5 min, donc modifiables sans redéploiement ; fichier local en dev).
- Intégration battle log : `backend/services/battleLogUtils.js` (`computeBattleMatchup()`, `computeMatchupFromBattleLog()`, `summarizeWarDecksForMatchup()`, `summarizeRecentBattlesForMatchup()`).

### Niveau de Tour du Roi

Absent de l'API : reconstruit par `computeTourLevel()` (`packages/clash-royale/collectionConstants.js`) à partir de `player.cards` uniquement (troupes de tour `supportCards` exclues). Utilisé par `/collection` et `backend/services/playerAnalysis.js` ; ne pas dupliquer ce calcul.

### Coûts d'amélioration des cartes (page `/deck-upgrade`)

Plages de niveaux par rareté, cartes et or nécessaires par niveau : `RARITY_CONFIG` (et `GEM_UPGRADES`) dans `frontend/public/deck-upgrade/deck-upgrade.js`. Source : <https://clashroyale.fandom.com/wiki/Cards> (sections « Types of Cards » et « Statistics »).

### Cache clan

La vue clan lit d'abord `GET /api/clan/:tag/cache` (Redis). Après toute modification de scoring, de verdict, de payload clan ou de logique dépendant des snapshots, relancer `npm run cache`.

### Historique famille

`buildFamilyWarHistory()` (`backend/services/warHistory.js`) construit l'historique de guerre d'un joueur sur tous les clans de la famille : les semaines passées dans un autre clan de la famille comptent dans `streakInFamily`, et le score n'est pas limité au clan actuel.

---

## Score de fiabilité

Score GDC propre à TrustRoyale, exprimé en pourcentage du maximum du mode actif (`warScore.total`, `warScore.maxScore`, `warScore.pct`). Source : `backend/services/warScoring.js` ; choix du mode dans `backend/services/playerAnalysis.js` et `backend/routes/clan.js`. Affiché par `/stats`, `/trust`, la fiche joueur et la page clan (mêmes libellés).

- **Mode complet** (`computeWarScore()`) : historique `riverracelog` exploitable (au moins une semaine terminée dans le clan ou la famille ; fenêtre ~10 saisons + semaine courante selon l'API).
- **Mode fallback** (`computeWarReliabilityFallback()`, `isFallback: true`) : `riverracelog` absent ou insuffisant ; s'appuie sur le `battlelog` (30 derniers combats tous modes, filtrés GDC) et, à défaut de combat GDC, sur les decks live de `currentRace`.

### Barème (sur 100)

| Critère | Complet | Fallback | Règle |
| --- | --- | --- | --- |
| Régularité | 25 | 25 | Fenêtre fixe de 5 semaines terminées : 5 pts par semaine complète (`isFullWeek()`), 0 sinon |
| Badge CW2 | 20 | 25 | Badge `ClanWarWins`, linéaire, plafond 250 victoires |
| Stabilité | 20 | | 4 pts par semaine consécutive dans le clan ou la famille (`streakInFamily`), max à 5 |
| Activité de guerre | | 20 | 4 pts par semaine jouée (≥ 1 deck) sur les 5 dernières, max à 5 |
| Points / deck | 10 | 10 | 3 dernières semaines terminées, linéaire de 100 à 180 pts/deck |
| Dernière connexion | 12,5 | 7,5 | Seulement si `lastSeen` connu. Complet : ≤ 1 j 12,5 ; ≤ 3 j 7,5 ; ≤ 7 j 2,5 ; sinon 0. Fallback : 7,5 / 5 / 2,5 / 0 |
| Expérience | 7,5 | 7,5 | Trophées actuels, linéaire de 4 000 à 14 000 |
| Discord | 5 | 5 | Compte Discord lié |
| **Max sans `lastSeen`** | 87,5 | 92,5 | |

### Seuils de verdict

`VERDICT_TIERS` dans `warScoring.js` (mêmes seuils pour les deux modes ; toujours matcher sur `verdictKey`, jamais sur le libellé) :

| % du max | Libellé | `verdictKey` |
| --- | --- | --- |
| ≥ 75 | Très fiable | `highReliability` |
| 56 à 74 | Risque faible | `lowRisk` |
| 31 à 55 | Risque élevé | `highRisk` |
| 0 à 30 | Risque extrême | `extremeRisk` |

### Score d'activité membre (vue clan)

Estimation légère sans calcul complet (`computeMemberReliability()`, `backend/services/playerAnalysis.js`), pour trier/filtrer la vue clan :

```text
score = min(60, trophies / 10000 × 60) + min(40, expLevel / 60 × 40)
```

Seuils propres : ≥ 75 `highReliability`, ≥ 61 `lowRisk`, ≥ 31 `highRisk`, sinon `extremeRisk`.

### Fiabilité d'un clan

Pas de score canonique stocké : la vue clan agrège `members[].reliability` et `members[].verdict` (`GET /api/clan/:tag/analysis`). Seul `notifyPreWarSummary.js` stocke un `scoreClan` dans `dedup:pregdcweekly` pour suivre l'évolution hebdomadaire.

### Statut `isNew` (nouveau joueur)

`computeIsNewPlayer(warHistory, warScore)` (`backend/services/playerAnalysis.js`), unique calcul pour l'API joueur, l'API clan et le bot. Nouveau si :

- aucune semaine terminée avec > 0 deck dans la famille (`totalWeeks === 0`), ou seule la semaine en cours existe ;
- ou transfert récent dans la famille : `streakInFamily < 2` et `totalWeeks > 1`.

⚠️ `totalWeeks` (`warHistory.js`) ne compte que les semaines familiales terminées avec > 0 deck : toute modification doit rester cohérente avec `computeIsNewPlayer` et être testée dans `backend/services/analysisService.test.js`.

---

## Paliers de ligue GDC

Seuils de `clanWarTrophies` définis **une seule fois** dans `backend/services/warLeagues.js` (`WAR_LEAGUE_THRESHOLDS`), importé par le frontend et le bot. ⚠️ Ne jamais les dupliquer.

| Trophées de guerre | Palier |
| --- | --- |
| 0 à 199 / 200 à 399 / 400 à 599 | Bronze 1 / 2 / 3 |
| 600 à 899 / 900 à 1 199 / 1 200 à 1 499 | Argent 1 / 2 / 3 |
| 1 500 à 1 999 / 2 000 à 2 499 / 2 500 à 2 999 | Or 1 / 2 / 3 |
| 3 000 à 3 999 / 4 000 à 4 999 / 5 000 + | Légendaire 1 / 2 / 3 |

`getLeagueName(trophies)` renvoie le libellé français (`getLeagueName(3812)` → `"Légendaire 1"`), `null` si la valeur est absente.

### Trophées gagnés/perdus par position

| Position | GDC normale : Bronze / Argent / Or et Légendaire | Colisée : Bronze / Argent / Or et Légendaire |
| --- | --- | --- |
| 1er | +20 / +20 / +20 | +100 / +100 / +100 |
| 2e | +10 / +10 / +10 | +50 / +50 / +50 |
| 3e | 0 / −2 / −5 | 0 / −10 / −25 |
| 4e | 0 / −4 / −10 | 0 / −20 / −50 |
| 5e | 0 / −8 / −20 | 0 / −40 / −100 |

### Détermination de la position

Source : `backend/services/warStandings.js` (`computeGroupStandings()`, `computeClanStanding()`, utilisés par `backend/routes/clan.js` et `notifyWarSummary.js`) ; détails API dans `docs/api-clash-royale.md` § « Classement final GDC ».

- **GDC normale** : progression du **bateau** (`clan.fame` / `clans[i].fame` dans `/currentriverrace`, 0-10 000, `RACE_FINISH_LINE = 10000` = victoire immédiate), sinon position atteinte au reset du J4. Le cumul de fame de bataille n'intervient pas.
- **Colisée** : cumul brut de fame de bataille de la semaine (`sum(participants[].fame)`, ~80 000-160 000). Pas de bateau.

---

## Bot Discord

### Architecture

```text
Discord → POST /api/discord/interactions
        → réponse immédiate { type: 5 }
        → traitement différé dans runBackground(...)
        → POST de suivi sur le webhook Discord
```

Fonction Vercel séparée de l'application Express pour limiter le cold start et tenir la fenêtre de réponse Discord (`backend/routes/discord.js` ne fait que renvoyer 404 vers cet endpoint).

Deux applications Discord, deux fonctions Vercel :

| Bot | Endpoint (Interactions Endpoint URL) | Routes servies |
| --- | --- | --- |
| TrustRoyale | `api/discord/interactions.js` | TrustRoyale, plus celles des jeux pendant la transition (boutons des messages postés par TrustRoyale) |
| Jeux | `api/discord/jeux.js` (404 tant que `DISCORD_JEUX_*` n'est pas configuré) | Jeux uniquement, voir `jeux/CONTRIBUTING.md` |

Vérification de signature, lecture du corps brut et liste blanche des serveurs : `@clash/commun/discordInteractions.js`, partagés par les deux endpoints.

### Organisation des fichiers

`api/discord/interactions.js` ne contient que le routeur : vérification de signature Ed25519, PING, autocomplétion des tags, liste blanche des serveurs (`AUTHORIZED_GUILD_IDS`), puis délégation aux modules de routes, essayés dans l'ordre jusqu'à ce que l'un réponde (`res.headersSent`) : d'abord ceux de TrustRoyale (`api/discord/_routes/`), puis ceux des jeux (`jeux/discord/routes/`, voir `jeux/CONTRIBUTING.md`).

| Module | Contenu |
| --- | --- |
| `_routes/admin.js` | `/help`, `/discord-link`, `/blacklist`, `/discord-check` |
| `_routes/joueur.js` | `/stats`, `/combats`, `/matchup-gdc`, `/matchup` (+ détail), `/collection` |
| `_routes/clan.js` | `/combats-clan`, `/trust-clan`, `/champion-history`, `/compare`, `/top-clans`, `/clan`, `/family`, `/stats-clan` et leurs boutons |
| `_routes/suiviGdc.js` | `/promote`, `/demote`, `/chelem`, `/fail`, `/late`, `/late-ping`, `/top-players`, `/recap` et leurs boutons |

- Chaque module expose `routeXxx(body, res, ctx)` : une suite de blocs `if (…) { …; return; }` ; un bloc répond s'il reconnaît l'interaction, sinon la fonction rend la main sans rien envoyer.
- ⚠️ Les `custom_id` et noms de commandes doivent rester disjoints entre modules : l'ordre des modules n'est pas un mécanisme de priorité.
- Utilitaires partagés : `api/discord/_lib/commun.js` (`runBackground` et `buildDiscordWebhookUrl` viennent de `@clash/commun/discordInteractions.js`) ; handlers volumineux dans `api/discord/_handlers/` (`blacklist.js`, `championHistory.js`). Les dossiers préfixés `_` ne sont pas exposés comme fonctions par Vercel.
- `/clan` masque les données de fiabilité GDC pour les clans de `NO_WAR_FAMILY_CLAN_TAGS` (`_routes/clan.js`, actuellement `QU9UQJRL`, GDC non obligatoire).

### Règles techniques

- Répondre `{ type: 5 }` **avant tout `await`**.
- Utiliser `runBackground()`, jamais `Promise.resolve().then(...)`.
- Ne pas appeler les services backend lourds depuis un handler : passer par les endpoints HTTP.
- Vérifier la signature Ed25519 avant de répondre au PING.
- Après tout ajout ou modification de commande : `node scripts/registerCommands.js` (enregistre les commandes des jeux, `JEUX_COMMANDS`, sur le bot des jeux s'il est configuré).

### Variables d'environnement

`DISCORD_PUBLIC_KEY`, `DISCORD_APP_ID`, `DISCORD_TOKEN` (requises) ; `AUTHORIZED_GUILD_IDS` (liste blanche des serveurs, vide = tous), `AUTHORIZED_PING_IDS` ; bot des jeux : `DISCORD_JEUX_APP_ID`, `DISCORD_JEUX_PUBLIC_KEY`, `DISCORD_JEUX_TOKEN` (voir `jeux/CONTRIBUTING.md`). Toute nouvelle variable : point d'entrée concerné, `.env.example` et Vercel (voir `AGENTS.md`).

---

## Détection des arrivées en cours de GDC

Objectif : ne pas pénaliser dans les listes d'échec les membres arrivés pendant la semaine de GDC.

- `streakInCurrentClan` (`buildWarHistory()`, `backend/services/warHistory.js`) : nombre de semaines **terminées** consécutives dans le clan actuel (semaine en cours exclue). Exposé côté clan sous `arrivalStreakInCurrentClan` / `arrivalTotalWeeks`.
- `isJoinedThisWar(streakInCurrentClan, day1Decks = null, totalDecks = null, maxDecks = 16)` (`backend/services/arrivalUtils.js`) :

| `streakInCurrentClan` | Autres paramètres | Résultat |
| --- | --- | --- |
| `null` | | installé |
| `0` | `day1Decks > 0` | installé (a pu jouer dès le J1) |
| `0` | sinon | arrivé en cours de GDC |
| `1` | `day1Decks === 0` | arrivé (a raté le J1, 16/16 impossible) |
| `1` | `day1Decks` inconnu | arrivé si `totalDecks < maxDecks` (ou `totalDecks` inconnu) |
| `1` avec `day1Decks ≥ 1`, ou `≥ 2` | | installé |

- `hasLateArrivalDailyPattern(daily)` (même fichier) : arrivé si les 2 premiers jours au moins sont sans donnée de snapshot (cas d'un départ puis retour dans la semaine, que le streak masque).

| Usage | Règle |
| --- | --- |
| `notifyWarSummary.js` (résumé quotidien) | `isJoinedThisWar()` pour ne pas compter les arrivants comme manquants |
| `/demote` | Sépare arrivés et réguliers via `joinedThisWeek`, calculé dans `backend/routes/clan.js` : `lateArrival` ou streak 0 ou (streak 1 et pas de donnée J1) ou `hasLateArrivalDailyPattern()` |
| `/fail` | N'exclut pas les arrivants : ils sont listés et annotés 🆕 si `arrivalTotalWeeks ≤ 1` |

---

## Glossaire

### Temps et périodes

| Terme | Définition | Où trouver la valeur |
| --- | --- | --- |
| Reset times | Heure UTC de reset GDC propre à chaque clan (09:45, 09:51, 09:50) | `CLAN_RESET_TIMES`, `packages/clash-royale/dateUtils.js`. ⚠️ Ne jamais recalculer : passer par `warResetOffsetMs(clanTag)` |
| Saison | Cycle d'environ un mois commençant le premier lundi du mois après le reset ; 3 à 5 semaines de guerre | `seasonId` (API, `raceLog[0]`), `sectionIndex` (API, base 0) ; courants via `computeCurrentSeasonId()` / `computeCurrentWeekId(currentRace, raceLog)` ; numéro public = `toPublicSeasonId()` / `toPublicWeekId()` (`dateUtils.js`) |
| Jours de GDC | Jeudi à dimanche, raisonnés en journée GDC (reset du clan), pas en journée civile UTC | `warDayKey()` (`dateUtils.js`), `buildCurrentWarDays()` (`playerAnalysis.js`), `getEndedWarDay()` (`scripts/notifyWarSummary.js`) |
| `periodType` | Type de période renvoyé par l'API | `"warDay"` = GDC normale, `"colosseum"` = Colisée |
| Jours de Colisée | Semaine où `periodType === "colosseum"` : le vainqueur se décide sur la fame cumulée, pas sur le bateau | Voir « Détermination de la position » |

### Journées jouées après la ligne d'arrivée (GDC normale)

- Une fois la ligne franchie (`clan.finishTime` ≠ `19691231T235959.000Z`, dans `currentriverrace` ou `riverracelog` → `standings[].clan`), l'API compte encore les `decksUsed` mais **ne crédite plus aucun point** (`participants[].fame` figé).
- Le bateau n'avançant qu'au reset, une `finishTime` à moins de 30 min du début d'une journée signifie que la course était gagnée avant elle (`isRaceFinishedBeforeDay()`, `notifyWarSummary.js`) : le résumé affiche « Non comptabilisés (victoire acquise) » sans delta de decks ni combats manquants ; le bilan hebdo exclut ces decks de « Points moyens / deck » et ces jours des duels manquants.
- **Decks attendus d'une semaine** (`backend/services/warStandings.js`) : `countedWarDaysFromRaceLog()` (semaine terminée, `finishTime` vs `createdDate`) et `countedWarDaysFromCurrentRace()` (semaine en cours, `finishTime` vs `periodIndex`) donnent 1 à 4 journées comptées ; `maxDecks` = journées × 4 (16, ou 12 si la ligne est franchie au reset du J4) ; semaine complète si `decksUsed >= maxDecks` (`isFullWeek()`) ; `countedWeekDecks()` plafonne pour les ratios points/deck. Appliqué partout (fiche joueur, page clan, `/stats`, `/demote`, `/fail`, `/late`, `/chelem`). Colisée : pas de `finishTime`, toujours 16.
- Garde-fou : un total journalier < 50 pts par deck joué (`MIN_FAME_PER_DECK`) est impossible hors course gagnée et s'affiche « Données indisponibles (valeur incohérente avec les decks joués) » ; la moyenne hebdo « Points moyens / deck » est masquée sous ce seuil.

### Clans

| Terme | Définition | Où trouver la valeur |
| --- | --- | --- |
| Clans autorisés | Clans recevant l'analyse complète : `Y8JUPC9C` (La Resistance), `LRQP20V9` (Les Resistants), `QU9UQJRL` (Les Revoltes) | `ALLOWED_CLANS`, `backend/routes/clan.js` |
| Famille | Même liste, périmètre de l'historique et de la continuité | `FAMILY_CLAN_TAGS`, `packages/clash-royale/famille.js` (réexporté par `warHistory.js`). La Treve (`QUV220GJ`) apparaît dans `/family` et la vue collective mais pas dans l'analyse complète |
| Full mode / Fallback mode | Modes du score de fiabilité | Voir « Score de fiabilité » |

### Snapshots, decks et points

| Terme | Définition | Où trouver la valeur |
| --- | --- | --- |
| Snapshot | État de guerre persisté pour reconstituer les deltas journaliers | Redis `snapshots:<TAG>` via `backend/services/snapshot.js` ; produits par `collectSnapshots.js` et `preResetSnapshot.js`. Champs : `snapshotTime` (ou `snapshotBackupTime`), `decks`, `decksPreReset`, `_cumul`, `_cumulFame`, `snapshotPreResetTime` |
| Decks cumul (semaine) | Decks joués depuis le début de la semaine | Live `currentRace.clan.participants[].decksUsed` ; persisté `_cumul` ; historique `warHistory.weeks[].decksUsed` |
| Decks du jour (live) | Decks joués aujourd'hui | `participants[].decksUsedToday` (aussi `currentRace.clans[i]` pour tout le groupe, sans appel supplémentaire) |
| Decks journaliers (passés) | Decks d'une journée terminée | `decks` du snapshot du jour (max avec `decksPreReset`), sinon delta entre cumuls ; `warSnapshotDays` pour la vue joueur |
| Fame cumul (semaine) | Points de bataille depuis le J1 | Live `sum(participants[].fame)` (= `currentFame`) ; persisté `_cumulFame` ; historique `warHistory.weeks[].fame` |
| Fame du jour (live) | Points de bataille du jour | `currentRace.clan.periodPoints` / `clans[i].periodPoints`, en GDC normale comme en Colisée |
| Fame journalière (passée) | Points d'une journée terminée | `computeDailyFame(dayEntry, prevDayEntry)` (`notifyWarSummary.js`) : cumul pré-reset du jour − cumul de la veille, valable seulement si la veille a un snapshot pré-reset (`snapshotPreResetTime`), sinon « donnée indisponible » ; J4 : `sum(participants[].fame)` − `_cumulFamePreReset` de la veille (repli : − somme des `periodPointsEarned` J1-J3) |

⚠️ Pièges de l'API :

- `currentRace.clan.fame` / `clans[i].fame` = progression du **bateau** (0-10 000), jamais les points de bataille.
- `periodLogs[].items[].pointsEarned` (stocké `periodPointsEarned` dans les snapshots) n'est **pas** une source fiable des points d'une journée passée (valeur constatée figée d'une semaine à l'autre) : dernier repli seulement ; `progressEarned` = points de classement, non pertinent.

---

## Licence

MIT : projet non affilié à Supercell et non approuvé par Supercell.
