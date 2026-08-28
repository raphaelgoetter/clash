# ⚔️ TrustRoyale Developer docs

Ce document rassemble la documentation destinée aux développeurs et aux contributeurs.
La documentation orientée utilisateur final reste dans README.md.

---

## Scripts utiles

- `npm run dev` — lance le backend Express sur le port 3000 et le frontend Vite sur le port 5173.
- `npm run test` — exécute les tests Node présents dans backend/services.
- `npm run cache` — régénère le cache statique des clans dans frontend/public/clan-cache via scripts/refreshClanCache.js.
- `npm run snapshot` — collecte les snapshots quotidiens de guerre via scripts/collectSnapshots.js.
- `npm run pre-reset-snapshot` — prend un snapshot juste avant le reset pour fiabiliser les calculs journaliers.
- `npm run notify-members` — détecte les arrivées, départs et changements de rôle puis poste un résumé Discord.
- `npm run notify-members:dry` — même script en mode dry-run.
- `npm run notify-members:sim` — dry-run avec données simulées.
- `npm run war-summary` — publie le résumé quotidien de guerre après le reset.
- `npm run war-summary:dry` — version dry-run du résumé quotidien.
- `node scripts/registerCommands.js` — enregistre ou met à jour les slash commands Discord.
- `npm run ping-test` — vérifie rapidement la disponibilité réseau ou les secrets utilisés par les scripts de ping.
- `npm run rules` — poste le rappel des règles du clan le premier mardi du mois.
- `npm run rules:dry` — même script en mode dry-run.
- `npm run frame:test` — poste manuellement une nouvelle partie de Frame sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`).
- `npm run frame:test:dry` — même script en mode dry-run (aperçu console, rien n'est posté ni écrit).
- `npm run frame:public` — poste sur le salon public "Général" (`DISCORD_CHANNEL_FRAME_PUBLIC`) ; utilisé par le cron `frames.yml`.
- `npm run frame:public:dry` — équivalent dry-run.
- `npm run frame:scores` — affiche le classement de la partie Frame en cours (joueur / score de la partie / score total de la saison).
- `npm run frame:reset` — remet le jeu Frame à zéro : plus de partie active (la prochaine repart à la première image de `frames.json`), historique et scores effacés.
- `npm run find-discord-clans` — script ponctuel (hors cron) qui liste les clans **français** dont la description mentionne « discord » (hors clans mentionnant « famille »/« family », qui désignent en général une organisation multi-clans plutôt qu'une cible de scouting isolée) et qui comptent entre `MIN_ACTIVE` et `MAX_ACTIVE` joueurs actifs (candidats potentiels de recrutement/scouting). Options : `--max-active=N` (défaut 30), `--min-active=N` (défaut 10) et `--active-days=N` (défaut 2, un membre est considéré actif si `lastSeen` date de moins de N jours). Une poignée de clans passés en revue manuellement sont exclus d'office via `EXCLUDED_CLAN_TAGS` dans le script (faux positifs non pertinents malgré la correspondance sur les critères automatiques). Écrit le résultat dans `data/discord-clans-fr.json` : `{ generatedAt, new: [...], contacted: [...] }`.
  - `new` — clans à contacter (tag, nom, membres, membres actifs, description).
  - `contacted` — clans déjà contactés, stats rafraîchies à chaque run indépendamment des critères ci-dessus. Le statut de contact (`status`: `pending`/`rejected`, `note` libre) est tenu à la main dans `data/discord-clans-contacted.json` (clé = tag du clan) ; ajouter une entrée dans ce fichier retire automatiquement le clan de `new` au run suivant.
  - ⚠️ L'API Clash Royale plafonne chaque requête `/clans` (recherche) à ~640 résultats, quel que soit le nombre réel de clans correspondants — y compris les gros clans identifiés dans le repo (48/38/43 membres), absents d'une recherche `locationId=France` sans autre filtre. Le script contourne cette limite en découpant la recherche par tranches de taille de clan (`minMembers`/`maxMembers`, largeur 2, de 2 à 50 membres) et en fusionnant les résultats dédupliqués — ce qui porte la couverture réelle à ~11 000 clans FR uniques au lieu de 640. Compter ~8 minutes d'exécution (25 requêtes de recherche + un `fetchClan` par clan trouvé + un `fetchClanMembers` par clan retenu sur la description).

### Notes sur les scripts de snapshots

- Les snapshots sont écrits en priorité dans /tmp/clash-snapshots à l’exécution.
- Quand le dossier data/snapshots est accessible, une copie persistante y est aussi écrite.
- À la lecture, loadSnapshots() privilégie /tmp puis fusionne avec data/snapshots si les deux existent.
- La fusion se fait jour par jour avec mergeSnapshotsByDay(), en gardant le snapshot valide le plus récent pour chaque journée.

### Thread Discord dédié aux notifications automatiques (test clan 2)

Pour éviter que les posts automatiques parasitent les discussions manuelles du salon d'un clan, certains scripts peuvent poster dans un thread dédié plutôt que dans le salon principal.

Chaque script concerné résout son channel cible via `resolveMembersChannelId(clanTag)` (`backend/services/discordChannels.js`) plutôt que de lire directement `DISCORD_CHANNEL_MEMBERS_<TAG>`. Par défaut, cette fonction retourne `DISCORD_THREAD_MEMBERS_<TAG>` si elle est définie pour ce clan, sinon retombe sur `DISCORD_CHANNEL_MEMBERS_<TAG>` (comportement historique inchangé). Un appelant peut forcer le salon principal en passant `{ thread: false }`, ce qui ignore `DISCORD_THREAD_MEMBERS_<TAG>` même si elle est définie.

Scripts concernés : `notifyWarSummary.js` (résumé quotidien/hebdo), `notifyMemberChanges.js` (arrivées/départs/promotions/rétrogradations), `notifyLastSeen.js` (joueurs inactifs).

Postent toujours dans le salon principal (appellent `resolveMembersChannelId(clanTag, { thread: false })`), quel que soit le clan — choix volontaire pour ne pas noyer les votes dans le thread de test :

- `autoStartPredictions.js` / `autoEndPredictions.js` (cron `predictions.yml`)

Scripts **non concernés** (restent dans le salon principal ou le salon staff) : `notifyPreWarSummary.js`, `notifyGdcLaunch.js`, `notifyRules.js`, `notifyClanStatus.js`.

Le test mené sur le clan 2 (`LRQP20V9`, thread `1523295989044088964`) n'a finalement pas été retenu : ses scripts postent de nouveau dans le salon membres principal. Aucun clan n'a donc actuellement de `DISCORD_THREAD_MEMBERS_<TAG>` renseignée. Pour activer ce mécanisme sur un clan :

1. Renseigner `DISCORD_THREAD_MEMBERS_<TAG>` dans `.env` (local).
2. Ajouter le secret GitHub Actions du même nom dans les workflows concernés (`snapshot.yml`, `last-seen.yml`, `war-summary.yml`).

Aucun changement de code n'est nécessaire pour étendre le test à un autre clan (sauf pour les pronostics, qui ignorent volontairement le thread — voir plus haut).

### Planification des scripts automatiques (GitHub Actions)

Tous les horaires ci-dessous sont définis en UTC dans les workflows (`.github/workflows/`). L'heure de Paris correspond à UTC+2 en été (CEST) et UTC+1 en hiver (CET).

| Script                                                  | Workflow                 | Jour(s)                                       | Horaire UTC                  | Horaire Paris (été/hiver) | Salon Discord                         |
| ------------------------------------------------------- | ------------------------ | --------------------------------------------- | ---------------------------- | ------------------------- | ------------------------------------- |
| `collectSnapshots.js` (`npm run snapshot`)              | `snapshot.yml`           | Tous les jours                                | Toutes les heures            | —                         | Aucun post (données uniquement)       |
| `notifyMemberChanges.js` (`npm run notify-members`)     | `snapshot.yml`           | Tous les jours                                | Toutes les heures            | —                         | Salon membres principal               |
| `refreshClanCache.js` (`npm run cache`)                 | `snapshot.yml`           | Tous les jours                                | Toutes les heures            | —                         | Aucun post (cache statique)           |
| `preResetSnapshot.js`                                   | `pre-reset-snapshot.yml` | Ven, Sam, Dim, Lun                            | 07:30                        | 09:30 / 08:30             | Aucun post (données uniquement)       |
| `notifyWarSummary.js`                                   | `war-summary.yml`        | Tous les jours (poste ven/sam/dim/lun)        | 10:05                        | 12:05 / 11:05             | Salon membres principal               |
| `notifyClanStatus.js`                                   | `war-summary.yml`        | Tous les jours (idem)                         | 10:05                        | 12:05 / 11:05             | Salon staff (`DISCORD_CHANNEL_STAFF`) |
| `notifyLastSeen.js`                                     | `last-seen.yml`          | Tous les jours                                | 10:08                        | 12:08 / 11:08             | Salon membres principal               |
| `notifyGdcLaunch.js`                                    | `gdc-launch.yml`         | Jeudi                                         | 10:30                        | 12:30 / 11:30             | Salon membres principal               |
| `notifyPreWarSummary.js` (`npm run pre-war-summary`)    | `pre-war-summary.yml`    | Mercredi                                      | 14:00                        | 16:00 / 15:00             | Salon membres principal               |
| `notifyRules.js`                                        | `rules.yml`              | Mardi (le script ne poste que le 1er du mois) | 14:00                        | 16:00 / 15:00             | Salon membres principal               |
| `autoStartPredictions.js` (`npm run predictions:start`) | `predictions.yml`        | Mardi                                         | 08:00                        | 10:00 / 09:00             | Salon membres principal               |
| `autoEndPredictions.js` (`npm run predictions:end`)     | `predictions.yml`        | Lundi                                         | 12:00                        | 14:00 / 13:00             | Salon membres principal               |
| `postFrame.js` (`npm run frame:public`)                 | `frames.yml`             | Mercredi                                      | 08:00                        | 10:00 / 09:00             | Salon "Général"                       |
| `postAnagram.js` (`npm run anagram:public`)             | `anagrams.yml`           | Samedi                                        | 10:00 ou 18:00 (aléatoire)\* | 12:00-20:00 / 11:00-19:00 | Salon "Général"                       |

\* `anagrams.yml` se déclenche à 10h et 18h UTC (2 créneaux). À chaque déclenchement, un tirage au sort décide de poster ou non : 1 chance sur 2 au premier créneau, garanti au second (18h UTC) si aucun post n'a encore eu lieu cette semaine — voir [Post hebdomadaire à horaire aléatoire](#post-hebdomadaire-à-horaire-aléatoire-samedi-10h-ou-18h-utc) dans la section Jeu Anagram.

---

## Référence API backend

| Méthode | Endpoint                  | Description                                                                         |
| ------- | ------------------------- | ----------------------------------------------------------------------------------- |
| GET     | /health                   | Vérification simple de disponibilité du backend                                     |
| GET     | /api/ip                   | Retourne l’IP publique du serveur, utile pour whitelist l’API Clash Royale en local |
| GET     | /api/debug                | Endpoint de debug des variables d’environnement critiques                           |
| GET     | /api/player/:tag          | Retourne le profil brut d’un joueur                                                 |
| GET     | /api/player/:tag/analysis | Retourne l’analyse complète d’un joueur                                             |
| GET     | /api/clan/:tag            | Retourne le profil brut d’un clan                                                   |
| GET     | /api/clan/:tag/lite       | Retourne une version allégée d’un clan sans calcul complet de fiabilité             |
| GET     | /api/clan/:tag/analysis   | Retourne l’analyse complète d’un clan et de ses membres                             |
| POST    | /api/cache/flush          | Vide le cache mémoire, usage développement                                          |

Notes :

- Les tags doivent conserver le préfixe # côté appelant, encodé en %23 dans l’URL.
- L’endpoint /api/clan/:tag/analysis refuse les clans hors liste autorisée.
- /api/player/:tag/analysis ajoute aussi warSnapshotDays, warCurrentWeekId, warSnapshotTakenAt et warResetUtcMinutes quand les données existent.
- /api/clan/:tag/analysis peut exposer debugSnapshotInfo avec des scores journaliers explicites : scoreJeudi, scoreVendredi, scoreSamedi, scoreDimanche et dailyScores.

### API Clash Royale — champs et sources de vérité

La documentation détaillée des champs retournés par l’API Clash Royale (champs `currentriverrace`, `periodPoints`, `periodLogs`, `participants`, etc.) est dans [docs/api-clash-royale.md](docs/api-clash-royale.md).

---

## Formules et scoring

### Projection de fin de journée (groupe GDC)

La projection estime les points qu'un clan atteindra à la fin de la journée de guerre.

La variable de plafonnement utilisée ici s'appelle **Engagement**. Elle est calculée au niveau du clan à partir de l'intersection entre le roster du clan et les participants de la guerre en cours qui ont déjà joué au moins un deck cette semaine :

- `activeMembers` = nombre de membres du roster ayant `decksUsed > 0` dans cette semaine de GDC
- `rosterSize` = taille du clan (`clan.members`)
- `ratio` = `activeMembers / rosterSize`

Cette approche donne un indicateur plus utile pour la projection, en évitant de compter comme actifs les membres qui sont simplement listés dans la course mais n'ont encore rien joué.

Pour le clan propre, le roster vient du payload de l'analyse. Pour les rivaux, le roster est chargé une fois au moment du calcul du groupe GDC afin de garder une mesure stricte sans dépasser 100 %.

**Formule générale :**

```text
Projection = max(decksToday, targetDecks) × ptsPerDeck
```

**Calcul de `targetDecks` :**

`targetDecks` représente la capacité maximale réaliste du clan pour la journée courante, basée sur le roster et l'engagement constaté :

- **J1** (`warDayIndex === 0`) : `min(200, rosterSize × 4)` — on utilise la taille totale du roster car l'engagement n'est pas encore fiable en J1.
- **J2–J4** (`warDayIndex > 0`) : `min(200, activeMembers × 4)` — on utilise l'engagement constaté : seuls les membres ayant déjà joué au moins un deck dans la semaine sont comptés.

Cette approche simplifiée remplace l'ancienne formule qui combinait historique (moyenne de la semaine passée), pace (extrapolation cadence) et engagement. La donnée d'engagement est plus réactive et évite les décalages avec la semaine réelle. Le pace n'est plus utilisé dans la cible (il reste consultable via les métriques brutes).

### `maxReachableFame` et détection de victoire assurée (`isClinchedWin`)

Le calcul de `maxReachableFame` (borne haute théorique) utilise un plafond **absolu** (`absoluteMaxDecksToday`), différent de `targetDecks` :

- `absoluteMaxDecksToday = min(200, rosterSize × 4)` — capacité maximale du roster complet, indépendamment de l'engagement constaté.
- `maxReachableFame = currentFame + remainingDecks × 200`

Un clan est marqué `isClinchedWin` quand `currentFame > max(maxReachableFame de tous les rivaux)`, c'est-à-dire quand même le scénario le plus optimiste pour les adversaires ne permet pas de dépasser le clan.

L'utilisation du **roster complet** (pas seulement `activeMembers`) garantit qu'on ne sous-estime pas la capacité de remontée des rivaux quand certains membres n'ont pas encore joué de la semaine.

### `decksToday` et `clanWarSummary` — pas de filtre ex-membres

`decksToday` et `clanWarSummary` utilisent les participants bruts de `currentRace.clan.participants`, sans filtre par le roster actuel (`currentMemberTags`). Cela signifie que les decks joués par des membres ayant quitté le clan **pendant le jour de guerre** sont bien comptabilisés.

Conséquence : si 2 membres (8 decks) quittent le clan en cours de J4 mais ont joué leurs 4 decks chacun avant de partir, `decksToday` affichera 198 et non 190 (qui serait le total des seuls membres encore présents).

**Ne pas filtrer** est le comportement correct car :

- ces decks ont réellement contribué au score du clan dans la course
- l'API Clash Royale continue de les retourner dans `currentRace.clan.participants` même après leur départ
- `activeMembers` reste basé sur le roster actuel (logique : les partis ne joueront plus), ce qui borne correctement `targetDecks` et `maxReachableFame`

### Barème des médailles GDC

Les points gagnés/perdus dans les combats de guerre sont utilisés pour estimer les victoires et les défaites à partir des fame du clan.

- **PvP Battle** : victoire = 200 points, défaite = 100 points
- **Boat Battle** : victoire = 125 points, défaite = 75 points
- **Duels** : victoire = 250 points, défaite = 100 points

Ces valeurs sont issues du barème de Clan Wars de Clash Royale.

**Remarques :**

- Tous les clans d'un même groupe GDC partagent le même créneau de reset.
- Code source : `backend/routes/clan.js`, bloc `groupWithProjections`.

### Matchup GDC

Le matchup GDC mesure la difficulté moyenne des combats d'un joueur sur ses récents combats de guerre.
Le calcul est purement tactique : il compare les 8 cartes des deux decks réellement joués (win conditions,
counters, structure, niveaux) — pas les statistiques de compte des joueurs (trophées, winrate, collection…,
ancien algorithme abandonné).

Ce moteur est partagé par deux commandes Discord : `/matchup-gdc` (combats de guerre uniquement, decks
regroupés par jour de GDC — `summarizeWarDecksForMatchup()`) et `/matchup` (6 derniers combats bruts du
joueur, tous types confondus — GDC, Ladder, Amical, Challenge —, une ligne par combat sans regroupement,
via `summarizeRecentBattlesForMatchup()`). Le calcul de difficulté lui-même (`computeDeckMatchupDetail()`)
est identique dans les deux cas : il ne dépend pas du type de combat.

Généralités :

- Le matchup d'un combat est calculé à partir d'une base `scoreA = 50` (avantage du deck A) et de 4 layers
  pondérés, calibrés pour que leur somme de maxima vaille `50` — 0 %/100 % ne sont atteints que si les 4
  s'alignent simultanément à l'extrême (sauf "écart exceptionnel" du Layer 4, cf. ci-dessous, qui peut à lui
  seul dominer le score).
- `matchup` (difficulté affichée, 0-1) = `(100 - scoreA) / 100`.
- `analysis.matchup.average` est la moyenne des matchups de combat sur les batailles GDC récentes.
- Si le `battleLog` ne contient aucune bataille de guerre, la moyenne est calculée sur les derniers combats
  compétitifs disponibles.

#### Layers et pondération

1. **Archétype** (±5) — `computeArchetypeLayer()` : avantage macro entre les archétypes des win conditions
   des deux decks (Beatdown bat Siege/Control, Cycle bat Beatdown… cf. `ARCHETYPE_ADVANTAGE`).
2. **Counters directs** (±25) — `computeCounterLayer()`/`counterShiftFor()` : pénalité en échelle
   triangulaire selon les hard-counters (poids 14) et soft-counters (poids 5) trouvés chez l'adversaire
   pour chaque win condition, depuis une baseline `+15` (aucun counter présent).
3. **Structure du deck** (±10) — `computeUtilityLayer()` : interpréteur générique de règles entièrement
   data-driven (`data/clash-royale-matchup-structure-rules.json`, hot-reload sans redéploiement) :
   `crossRules` (Bait, Split-Push, Heavy Beatdown, Ronin/gros DPS hard+soft), `dispersionRules` (deck trop
   dispersé : trop de win conditions/sorts/bâtiments), `selfRules` (carence du deck lui-même : anti-air,
   bâtiment, sort, cartes < 3 élixir, ou 0 win condition reconnue).
4. **Écart de niveau** (±10, + "écart exceptionnel") — `computeLevelDifferentialLayer()` : 2 % par point
   d'écart de niveau normalisé (`normLevel()`), plafond normal atteint dès 5 points cumulés. Au-delà de
   15 points cumulés, un bonus fixe s'ajoute PAR-DESSUS ce plafond, par palier de 5 points (15→±25,
   20→±30, 25→±35, 30→±40 au total) — un écart de niveau vraiment extrême doit pouvoir dominer le score à
   lui seul, au-delà de la répartition ±50 normale ; seul le clamp final `[0, 100]` reste garde-fou.

Si aucune vraie win condition (au sens du catalogue) n'est reconnue dans un deck, le calcul se rabat sur des
"pseudo win conditions" (cartes à forts dégâts type P.E.K.K.A/Mini P.E.K.K.A/Mega Knight/Boss Bandit,
moyennées si plusieurs trouvées) pour éviter de neutraliser les Layers 1/2. Si vraiment aucune win condition
n'est identifiable des deux côtés, ces deux layers sont neutralisés pour ce combat (seuls Structure et
Écart de niveau s'appliquent encore).

#### Source de vérité

- Moteur pur (synchrone, sans appel LLM) : `backend/services/matchupEngine.js` — `computeDeckMatchupScore()`
- Catalogue win conditions/counters (+ variantes type LavaLoon) : `data/clash-royale-matchup-catalog.json`,
  chargé via `backend/services/matchupCatalog.js` (GitHub Contents API + cache 5 min, fallback fichier
  local en dev)
- Règles du Layer 3 : `data/clash-royale-matchup-structure-rules.json`
- Intégration battle log : `backend/services/battleLogUtils.js` — `computeBattleMatchup()`,
  `computeMatchupFromBattleLog()`, `summarizeWarDecksForMatchup()` (GDC), `summarizeRecentBattlesForMatchup()`
  (tous types)

### Niveau de Tour du Roi

Le niveau de Tour du Roi n'est pas un champ livré directement par l'API Clash Royale. Il est reconstruit dans la commande `/collection` à partir du profil du joueur.

- Source de vérité : `backend/services/collectionConstants.js`
- Fonction : `computeTourLevel(baseCardsCol)`
- Entrée : `player.cards` uniquement (les troupes de tour `supportCards` sont exclues)
- Usage : `/collection` affiche `Niveau ${tourLevel}` et le backend réutilise ce même calcul pour les analyses de joueurs.

Cette fonction doit rester la source de vérité pour connaître rapidement le niveau de tour d'un joueur.

## Données upgrade cartes (page /deck-upgrade)

Source de vérité utilisée pour la page publique `/deck-upgrade` :

- <https://clashroyale.fandom.com/wiki/Cards>
- sections `Types of Cards` (plages de niveaux par rareté) et `Statistics`
- date de collecte : 25/05/2026

### Niveaux disponibles par rareté

| Rareté     | Niveau min | Niveau max |
| ---------- | ---------- | ---------- |
| Commune    | 1          | 16         |
| Rare       | 3          | 16         |
| Épique     | 6          | 16         |
| Légendaire | 9          | 16         |
| Champion   | 11         | 16         |

### Cartes nécessaires pour passer au niveau suivant

Les clés ci-dessous représentent le niveau actuel, la valeur représente les cartes nécessaires pour passer au niveau +1.

```js
const DECK_UPGRADE_COSTS = {
  common: {
    1: 2,
    2: 4,
    3: 10,
    4: 20,
    5: 50,
    6: 100,
    7: 200,
    8: 400,
    9: 800,
    10: 1000,
    11: 1500,
    12: 2500,
    13: 3500,
    14: 5500,
    15: 7500,
  },
  rare: {
    3: 2,
    4: 4,
    5: 10,
    6: 20,
    7: 50,
    8: 100,
    9: 200,
    10: 300,
    11: 400,
    12: 550,
    13: 750,
    14: 1000,
    15: 1400,
  },
  epic: {
    6: 2,
    7: 4,
    8: 10,
    9: 20,
    10: 30,
    11: 50,
    12: 70,
    13: 100,
    14: 130,
    15: 180,
  },
  legendary: {
    9: 2,
    10: 4,
    11: 6,
    12: 9,
    13: 12,
    14: 14,
    15: 20,
  },
  champion: {
    11: 2,
    12: 5,
    13: 8,
    14: 11,
    15: 15,
  },
};
```

### Note sur le cache statique

La vue clan charge en priorité les fichiers JSON présents dans frontend/public/clan-cache pour afficher un rendu immédiat.
Si vous modifiez un calcul de scoring, une logique de verdict, une structure de payload clan, ou une logique dépendante des snapshots, relancez :

```bash
npm run cache
```

### Historique famille et transferts

Le code continue d’utiliser l’historique des clans de la famille pour construire l’historique de guerre d’un joueur.
La source de vérité est buildFamilyWarHistory() dans backend/services/warHistory.js.

En pratique :

- les semaines passées dans un autre clan autorisé de la famille peuvent être prises en compte dans streakInFamily ;
- le score n’est pas limité au seul clan actuel quand l’historique famille est disponible ;
- la notion opérationnelle importante est la continuité dans la famille, pas un ancien flag documentaire de “transfer”.

### Score de fiabilité

Le score de fiabilité de GDC est un pourcentage calculé à partir d’un ensemble de critères pondérés, avec des maxima définis pour chaque critère.

Clash Royale ne fournissant pas directement un score de fiabilité, nous avons défini notre propre algorithme pour évaluer la fiabilité d’un joueur en GDC, basé sur des données objectives et transparentes.

L’API Clash Royale fournit deux sources de données principales pour ce calcul :

- le `riverracelog` du clan. Très complet, il permet de reconstituer l’historique de guerre et d’obtenir des critères précis sur les semaines terminées. C’est la source de vérité principale pour le score complet.
- le `battlelog` du joueur, qui sert de source de secours quand le `riverracelog` est insuffisant ou indisponible. Cette source est plus limitée (30 derniers combats d'un joueur) et moins spécifique à la GDC, d’où un score de fiabilité en mode fallback.

### Score de fiabilité guerre, mode complet

<!-- markdownlint-disable MD060 -->

Le mode complet est utilisé quand l’historique d'un joueur permet d'exploiter le `riverracelog`. Il faut au minimum une vraie semaine terminée dans le clan ou la famille pour que ce mode s’active. Si l’historique famille est inexistant ou trop faible, on reste en `fallback`.

Quand ces données existent, le score complet privilégie les signaux GDC du profil plutôt qu'une moyenne brute d'activité. La régularité sur les semaines terminées reste la base, et l'efficacité par deck prend le relais dès qu'un historique River Race exploitable est disponible.

En pratique, la fenêtre exploitable est de `~10` saisons terminées + `1` semaine courante, sous réserve de ce que l’API renvoie réellement.

Critères :

- Régularité : 10. Sur une fenêtre fixe de 5 semaines, une semaine complète vaut 1 point, sinon 0.
- Badge CW2 : 8. Cap à 250 victoires CW2.
- Stabilité : 8. 5 semaines consécutives dans le clan ou la famille donnent le maximum.
- Dernière connexion : 5. Ajoutée seulement si lastSeen est disponible.
- Points / deck : 4. Efficacité GDC sur les 3 dernières semaines terminées, avec une plage utile d’environ 100 à 180 points / deck.
- Expérience : 3. Basée sur les trophées actuels, plage 4000 à 14000.
- Discord : 2. Compte Discord lié.

Disclosures front :

- `/stats` et `/trust` affichent ce score complet avec un breakdown détaillé.
- La page profil joueur réutilise la même logique pour garantir la cohérence avec Discord.
- La page profil clan expose les mêmes libellés lorsqu’un score individuel est disponible.

### Score de fiabilité guerre, mode fallback

Le mode fallback est utilisé quand le `riverracelog` est insuffisant ou indisponible. Le `battlelog` du joueur reste la source de vérité restante ;

L'API `battlelog` ne fournit que les `30` derniers combats d’un joueur tous types confondus (ladder, challenges, GDC, etc.). Le code tente de filtrer les combats de GDC.
Quand le `battlelog` est trop court ou trop écrasé par des combats non-GDC, le calcul devient moins fiable et peut retomber sur des approximations.

Critères :

- Régularité : 10. Calculée sur 5 semaines fixes, avec une semaine complète valant 1 et les semaines incomplètes ou manquantes valant 0.
- Badge CW2 : 10. Cap à 250 victoires CW2.
- Activité GDC : 8. Basée uniquement sur le nombre de semaines réellement jouées (au moins un deck), avec maximum atteint à partir de 5 semaines jouées.
- Points / deck : 4. Efficacité GDC sur les 3 dernières semaines terminées quand l’historique est disponible.
- Dernière connexion : 3. Ajoutée si lastSeen est disponible.
- Expérience : 3. Basée sur les trophées actuels.
- Discord : 2. Compte Discord lié.

<!-- markdownlint-enable MD060 -->

### Seuils de verdict

Les deux modes utilisent les mêmes seuils :

| Pourcentage du score maximal | Verdict          |
| ---------------------------- | ---------------- |
| ≥ 75 %                       | High reliability |
| 56 à 74 %                    | Low risk         |
| 31 à 55 %                    | High risk        |
| 0 à 30 %                     | Extreme risk     |

### Score d’activité membre, vue clan

Ce score léger est utilisé quand on ne dispose pas du calcul complet par joueur.
La fonction source est `computeMemberReliability()` dans `backend/services/playerAnalysis.js`.

Formule actuelle :

```text
score = min(60, trophies / 10000 × 60)
      + min(40, expLevel / 60 × 40)
```

Notes :

- `trophies` et `expLevel` sont des `sources de vérité` venant du profil joueur ;
- le score final est une `estimation` légère ramenée sur `100` et sert surtout à trier/filtrer la vue clan ;
- les seuils associés dans la vue clan sont : `75+`, `61-74`, `31-60`, `0-30`.

---

## Paliers de ligue GDC

### Source de vérité ligue

Les seuils de trophées de guerre (`clanWarTrophies`) déterminant le palier de ligue GDC sont définis **une seule fois** dans :

```text
backend/services/warLeagues.js
```

Ce module est importé par le frontend (`frontend/main.js`) et le bot Discord (`api/discord/interactions.js`).
**Ne jamais dupliquer ces seuils** — toute modification doit se faire uniquement dans `warLeagues.js`.

### Tableau des paliers

| Trophées de guerre | Palier (EN) | Palier (FR)  |
| ------------------ | ----------- | ------------ |
| 0 – 199            | Bronze 1    | Bronze 1     |
| 200 – 399          | Bronze 2    | Bronze 2     |
| 400 – 599          | Bronze 3    | Bronze 3     |
| 600 – 899          | Silver 1    | Argent 1     |
| 900 – 1 199        | Silver 2    | Argent 2     |
| 1 200 – 1 499      | Silver 3    | Argent 3     |
| 1 500 – 1 999      | Gold 1      | Or 1         |
| 2 000 – 2 499      | Gold 2      | Or 2         |
| 2 500 – 2 999      | Gold 3      | Or 3         |
| 3 000 – 3 999      | Legendary 1 | Légendaire 1 |
| 4 000 – 4 999      | Legendary 2 | Légendaire 2 |
| 5 000 +            | Legendary 3 | Légendaire 3 |

### API exposée

```js
import { getLeagueName } from "../../backend/services/warLeagues.js";

getLeagueName(3812, "en"); // → "Legendary 1"
getLeagueName(3812, "fr"); // → "Légendaire 1"
```

### Trophées gagnés/perdus par position — GDC normale (River Race)

| Position | Bronze | Argent | Or & Légendaire |
| -------- | ------ | ------ | --------------- |
| 1er      | +20    | +20    | +20             |
| 2e       | +10    | +10    | +10             |
| 3e       | 0      | -2     | -5              |
| 4e       | 0      | -4     | -10             |
| 5e       | 0      | -8     | -20             |

### Trophées gagnés/perdus par position — GDC Colisée (Colosseum)

| Position | Bronze | Argent | Or & Légendaire |
| -------- | ------ | ------ | --------------- |
| 1er      | +100   | +100   | +100            |
| 2e       | +50    | +50    | +50             |
| 3e       | 0      | -10    | -25             |
| 4e       | 0      | -20    | -50             |
| 5e       | 0      | -40    | -100            |

**Comment la position (1er-5e) est déterminée — voir aussi `docs/api-clash-royale.md`
§ "Classement final GDC" et `backend/services/warStandings.js` :**

- **GDC normale** : par la progression du **bateau** (`clan.fame` / `clans[i].fame`
  dans `/currentriverrace`, 0-10 000 — ligne d'arrivée à 10 000 = victoire immédiate,
  sinon classement par position atteinte au reset du J4). Le cumul brut de fame de
  bataille (`sum(participants[].fame)`) n'entre pas en jeu ici.
- **Colisée** : par le cumul brut de fame de bataille sur la semaine
  (`sum(participants[].fame)`, ~80 000-160 000). Pas de course de bateau.

---

## Bot Discord

Le bot Discord déclenche les analyses via l’endpoint dédié api/discord/interactions.js.

### Architecture

```text
Discord → POST /api/discord/interactions
        → réponse immédiate { type: 5 }
        → traitement différé dans runBackground(...)
        → POST de suivi sur le webhook Discord
```

La fonction Discord est séparée de l’application Express principale pour limiter le cold start et respecter la fenêtre de réponse imposée par Discord.

### Règles techniques importantes

- répondre immédiatement avec type: 5 avant tout await ;
- utiliser runBackground() et jamais Promise.resolve().then(...) directement ;
- ne jamais appeler directement les services backend lourds depuis un handler Discord, passer par les endpoints HTTP ;
- vérifier la signature Ed25519 avant de répondre au PING ;
- après toute modification ou ajout de commande, relancer node scripts/registerCommands.js.

### Variables d’environnement requises

```text
DISCORD_PUBLIC_KEY=
DISCORD_APP_ID=
DISCORD_TOKEN=
```

---

## Crons GitHub Actions (jeux quotidiens)

Les 5 jeux à avancée quotidienne (Robinson, Tamagoshi, Boss Raid, Quiz, Goblin Hunters) tournent chacun sur leur propre workflow (`.github/workflows/{robinson,tamagotchi,bossraid,quiz,goblinhunters}.yml`), avec un `schedule` étalé sur la même tranche horaire mais **jamais à la même minute** :

| Jeu | Cron |
| --- | --- |
| Boss Raid | `2 8 * * *` |
| Goblin Hunters | `4 8 * * *` |
| Quiz | `6 8 * * *` |
| Robinson | `8 8 * * *` |
| Tamagoshi | `10 8 * * *` |

⚠️ **Incident du 27/08** : les 5 crons étaient initialement tous réglés sur `0 8 * * *` (pile 8h00 UTC). GitHub documente explicitement que les triggers `schedule` sont *best-effort* et que le délai augmente aux heures rondes, justement à cause de la charge — caler 5 workflows du même dépôt sur exactement la même minute aggrave mécaniquement ce risque. Résultat concret : le 27/08, aucun des 5 crons ne s'était déclenché plus d'une heure après l'horaire prévu (confirmé via l'API GitHub, `GET /repos/.../actions/workflows/{id}/runs`, aucun run pour la date du jour alors que les runs de la veille existaient bien vers 08h07-08h20 UTC). Étaler les horaires par tranches de 2 minutes ne garantit pas un déclenchement pile à l'heure (toujours best-effort côté GitHub), mais réduit la contention auto-infligée.

⚠️ **Incident du 27-28/08 (suite)** : le décalage des horaires n'a pas suffi — aucun des 5 crons ne s'est déclenché ni le 27/08 ni le 28/08, alors que d'autres workflows planifiés du même dépôt (`snapshot.yml`, `gdc-launch.yml`, `last-seen.yml`) ont bien tourné sur cette période (avec retard, mais tournés). Ce contre-exemple élimine l'hypothèse d'une panne globale au dépôt ou d'une simple contention de charge. La vraie cause identifiée : un **bug GitHub confirmé par leur équipe** où le trigger `schedule` d'un workflow se désynchronise silencieusement côté serveur (aucune erreur, aucun run, `workflow_dispatch` continue de fonctionner normalement sur le même fichier) — voir [community#185355](https://github.com/orgs/community/discussions/185355), où un employé GitHub (SrRyan) confirme ce mécanisme et donne le correctif officiel : *"Any commit pushed to the default branch will resync the impacted scheduled workflows."* Un premier commit de resynchronisation a été poussé le 28/08 sur les 5 fichiers concernés — si le prochain cycle (29/08) ne se déclenche toujours pas, retenter un nouveau commit et/ou commenter sur cette discussion GitHub plutôt que de repasser par un ticket support classique (fermé automatiquement sans investigation sur ce palier de compte).

⚠️ **6ᵉ victime confirmée, criticité supérieure : `pre-reset-snapshot.yml`** (`30 7 * * 5,6,0,1`, checké le 28/08 — aucun run depuis le 24/08, alors que le cron ne devait de toute façon pas tourner mar-jeu, donc le 28/08 était sa toute première occasion manquée depuis l'incident). Contrairement aux jeux quotidiens, une occurrence manquée ici est **définitivement irrécupérable** : le script dort jusqu'à T−2 min de chaque reset de clan puis capture l'état via l'API — une fois le reset passé, `msUntilReset < 0` fait sauter silencieusement ce clan (`scripts/preResetSnapshot.js`), sans aucun rattrapage possible après coup, contrairement à `postRobinson()` qui peut toujours être relancé à la main sans perte. Perte actée pour le 28/08 (2 clans GDC concernés). **Vérification manuelle recommandée chaque matin ven-lun avant 09h38 UTC** (T−2 min du premier reset GDC) tant que la résolution du bug GitHub n'est pas confirmée sur ce workflow spécifiquement.

Si un cron manqué doit être rattrapé dans l'immédiat sans attendre la résync GitHub, chaque jeu reste déclenchable manuellement via `workflow_dispatch` (bouton "Run workflow" sur GitHub, ou `gh workflow run <fichier>.yml`) — protégé côté Robinson par le garde-fou anti-double-avancée (`isTooSoonSinceLastClosure()`) qui rend ce rattrapage manuel sans risque même si le cron en retard finit par se déclencher après coup.

---

## Noms français des cartes (`data/cardNames.json`)

Source de vérité anglais↔français des noms de cartes Clash Royale, partagée par tous les mini-jeux qui en ont besoin (Anagram, Zoom carte) — évite que chaque jeu retraduise/duplique les mêmes noms avec le risque de divergence que ça implique (constaté : plusieurs noms erronés trouvés dans `anagrams.json` avant la création de ce fichier, dont un vrai bug de `cardKey` qui cassait l'image de révélation).

- Un objet par carte du catalogue officiel (`{ cardKey, rarity, fr }`), `cardKey` étant le nom anglais exact renvoyé par l'API Clash Royale (`fetchCards()`).
- **Fichier édité à la main** une fois généré — `scripts/generateCardNames.js` (usage ponctuel) ne fait que compléter les cartes absentes du fichier existant ; il ne touche jamais une entrée déjà présente, corrections manuelles y compris. Résolution pour une carte manquante, par ordre de priorité : liens interlangues du wiki Fandom FR (`clashroyale.fandom.com/fr`, vérifiés dans les deux sens contre le nom anglais authentique de l'API) puis repli sur `data/anagrams/anagrams.json` si la carte est trop récente pour avoir une page sur le wiki. Toute valeur ajoutée automatiquement reste une proposition à relire, pas une certitude — le wiki peut se tromper (cf. l'exemple `Goblin Cage` ci-dessus).
- Certaines cartes très récentes n'ont pas de nom trouvé automatiquement (`fr: null` à la génération) — à compléter à la main, voir la liste affichée en fin d'exécution du script.
- `scripts/generateZoomCatalog.js` source ses noms français exclusivement d'ici (jamais d'`anagrams.json` directement) et resynchronise `answer`/`accept` à chaque exécution, même sans retélécharger l'image (coût nul). `anagrams.json`, en revanche, n'est pas resynchronisé automatiquement (voir la mise en garde ci-dessous) : une correction dans `cardNames.json` doit être reportée à la main sur `anagrams.json` si elle concerne une carte qui y est présente, en vérifiant que l'anagramme existante reste valide pour les nouvelles lettres (sinon la modifier casse le puzzle — voir `checkAnswer`/le champ `anagram` de chaque entrée).

---

## Jeu Frame (devine le film)

Mini-jeu hebdomadaire indépendant du Clash Royale : chaque mercredi 08:00 UTC, une image tirée d'un film connu est postée sur le salon public, les membres devinent le titre. Pas de commande slash associée — la publication passe uniquement par `scripts/postFrame.js` (manuel ou cron), les boutons/modal restent gérés par `api/discord/interactions.js`.

### Barème

- Réponse exacte du 1er coup sans indice : **10 pts**
- Chaque tentative incorrecte : **-2 pts**
- Chaque indice utilisé : **-3 pts**
- Score plancher à **0** (jamais négatif). La tentative gagnante elle-même n'est jamais comptée comme incorrecte.

### Réponse via Modal Discord

Le bot ne fonctionne qu'en webhook HTTP (pas de connexion Gateway, pas d'intent `MESSAGE_CONTENT`), donc il ne peut pas lire les messages tapés librement dans un salon. Le bouton "Répondre" ouvre une **Modal** Discord (réponse `type: 9`, `custom_id: frame_answer_modal:<gameId>`) contenant le champ texte ; la soumission arrive en tant qu'interaction entrante `body.type === 5` (`MODAL_SUBMIT`) — à ne pas confondre avec le `type: 5` de _réponse_ (`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`) utilisé ailleurs dans `interactions.js`, deux enums Discord distinctes qui partagent des valeurs numériques.

### Correspondance de la réponse

`checkAnswer()` (`backend/services/frames.js`) normalise la réponse (minuscule, accents retirés, ponctuation supprimée) puis vérifie qu'elle **contient** un terme de `accepte` et **ne contient aucun** terme de `refuse`. Exemple (`The Dark Knight`, `accepte: ["knight"]`, `refuse: ["rises", "joker"]`) : "dark knight" → accepté ; "the dark knight rises" → refusé (contient aussi "rises").

### Données

- `data/frames/frames.json` — liste ordonnée des films (`image`, `indice1`, `indice2`, `titre`, `accepte`, `refuse?`), éditée à la main. La partie suivante boucle au début une fois toutes les images épuisées.
- `data/frames/images/*.webp` — images des frames, nommées comme le champ `image` de `frames.json`.
- Ni `frames.json` ni les images ne sont exposés statiquement (rien sous `frontend/public/`) : `frames.json` est lu côté serveur uniquement, et l'image est accessible uniquement via `GET /api/frames/image` (`backend/server.js`) — impossible de deviner l'image d'une semaine future en devinant une URL, quel que soit le nom de fichier essayé.
- **URL de l'embed** : `${TRUST_ROYALE_URL}/api/frames/image?gameId=<gameId>&v=<horodatage>`. Le paramètre `gameId` épingle l'image de **cette manche précise** (`getFrameImageByGameId()`, gardé par le SET durable `frame:posted_games` — jamais servi pour un `gameId` qui n'a encore jamais été posté, anti-spoiler). ⚠️ Sans ce paramètre (ancien comportement), la route servait toujours l'image de la partie **active** (`getCurrentFrameImage()`) — un bug réel constaté en production : d'anciens messages Discord se remettaient à afficher l'image de la manche EN COURS dès que le proxy d'images de Discord revalidait son cache, plusieurs jours après leur publication. `v=` reste un simple cache-buster pour forcer un fetch frais au moment de la publication, sans rôle anti-spoiler à lui seul.
- État de la partie, progression par joueur et classements — stockés sur **Upstash Redis** (`@upstash/redis`, REST, voir "Stockage — Upstash Redis" ci-dessous).

### Stockage — Upstash Redis

Le jeu stockait initialement son état sur Vercel Blob (même pattern que `champion-predictions.json`), mais Blob facture chaque `put()`/`list()` comme "Advanced Operation" avec un quota gratuit de seulement 2 000/mois — largement dépassé par l'usage normal du jeu (indices, tentatives, résolutions). Migré vers **Upstash Redis** (intégration Vercel Marketplace, tier gratuit 500 000 commandes/mois) qui offre en plus des primitives **atomiques natives** (`INCR`, `SADD`, `HSETNX`, `ZINCRBY`) réglant nativement les problèmes de concurrence (deux joueurs qui répondent au même instant) sans verrou ni retry applicatif à gérer soi-même.

Schéma des clés (`backend/services/frames.js`) :

| Clé Redis                                | Type              | Contenu                                                                                                                                                         |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame:state`                            | STRING            | Métadonnées de la partie active (JSON) — inclut `seasonManche`/`seasonMancheTotal` (voir ci-dessous)                                                            |
| `frame:participants:<gameId>`            | HASH              | `discordId → participant` (doc final, écrit seulement à la résolution)                                                                                          |
| `frame:usernames:<gameId>`               | HASH              | `discordId → pseudo` (mis à jour à chaque indice/tentative)                                                                                                     |
| `frame:hints:<gameId>:<discordId>`       | SET               | Indices déjà pris (`indice1`, `indice2`)                                                                                                                        |
| `frame:attempts:<gameId>:<discordId>`    | STRING (compteur) | Nombre de tentatives incorrectes (`INCR` atomique)                                                                                                              |
| `frame:season:<seasonId>`                | ZSET              | `discordId → score total` de la saison (`ZINCRBY` atomique)                                                                                                     |
| `frame:season:<seasonId>:pseudos`        | HASH              | `discordId → pseudo` pour l'affichage du classement de saison                                                                                                   |
| `frame:season:<seasonId>:manche_seq`     | STRING (compteur) | Dernier numéro de manche attribué cette saison (`INCR` atomique)                                                                                                |
| `frame:season:<seasonId>:manche_numbers` | HASH              | `gameId → numéro de manche` (1, 2, 3... relatif à la saison, attribué par `assignSeasonMancheNumber()` à chaque `startNewGame()`, idempotent via `HSETNX`)      |
| `frame:posted_games`                     | SET (durable)     | Tous les `gameId` déjà postés, toutes saisons confondues, jamais nettoyé — garde-fou anti-spoiler de `getFrameImageByGameId()`                                  |
| `frame:archived:<seasonId>`              | HASH              | `<gameId>:<discordId> → résultat` — marqueur d'idempotence (`HSETNX`) évitant un double comptage si `archiveSolve` est appelé deux fois pour la même résolution |

⚠️ **`automaticDeserialization: false` obligatoire** à la construction du client — par défaut le SDK convertit toute valeur "numérique" en `Number` JS, y compris les IDs Discord (17-19 chiffres, au-delà de `Number.MAX_SAFE_INTEGER`), ce qui les corrompt silencieusement. La sérialisation/désérialisation JSON est donc gérée à la main partout (`toJson`/`fromJson`/`hgetallJson`). Autre piège vérifié empiriquement (non documenté) : avec cette option désactivée, `HGETALL` renvoie un tableau plat `[champ1, valeur1, ...]` et non un objet — voir `pairsToObject()`.

⚠️ **Client Redis construit paresseusement** (`getRedis()`, pas au chargement du module) : avec les imports ES hoistés, `import ... from frames.js` s'exécute avant le `dotenv.config()` du script appelant, donc construire le client en haut de fichier figerait des variables d'environnement pas encore chargées dans les scripts (`postFrame.js`, etc.).

Nettoyage : `startNewGame()` supprime la progression (indices/tentatives/participants) de la partie **précédente** à chaque nouvelle partie — données jetables une fois la partie terminée. Les résultats archivés (`frame:season:*`, nécessaires au total de la saison) ne sont eux jamais supprimés automatiquement.

### Scores et classements par saison

Le score total et le classement général affichés en DM ne portent que sur la **saison Clash Royale en cours** (voir [Saison](#saison)), pas un cumul indéfini. `getCurrentSeasonId()` (`backend/services/frames.js`) réutilise `computeCurrentSeasonId(currentRace, raceLog)` de `dateUtils.js`, avec 3 tentatives (délai croissant) pour absorber un aléa réseau transitoire côté API Clash Royale. Chaque résultat archivé dans `frame:archived:<seasonId>` garde le `seasonId` de la saison où il a été joué ; le classement de saison vit dans un ZSET dédié par `seasonId` (`frame:season:<seasonId>`), donc aucun recalcul ni remise à zéro manuelle n'est nécessaire au changement de saison — chaque nouvelle saison utilise simplement une nouvelle clé.

### Récapitulatif de fin de saison

Quand `postFrame()` détecte que le `seasonId` a changé depuis la dernière partie (comparaison `previousState.seasonId` vs `getCurrentSeasonId()`, avant tout appel à `startNewGame()`), un embed récapitulatif de la saison écoulée est posté dans le salon **avant** le post normal de la nouvelle manche 1 — jamais de DM, uniquement ce post public (`postSeasonRecap()`/`buildSeasonRecapEmbed()`, `api/discord/_handlers/frames.js`).

Contenu : classement final de `computeSeasonRanking(endedSeasonId)`, félicitations au(x) vainqueur(s) (gestion des ex-aequo — plusieurs co-champions possibles), classement complet avec médailles 🥇🥈🥉 uniquement pour un rang non partagé (`findTiedRank`, sinon numéro simple). Deux règles de troncage explicites : les scores à **0 pt sont exclus**, et la liste est plafonnée à **20 joueurs** (au-delà, note "... et X autres joueurs"). Si personne n'a marqué le moindre point sur la saison écoulée, aucun récap n'est posté.

Prévisualisable sans rien poster via `npm run frame:public:dry` (ou `frame:test:dry`) : si un changement de saison serait détecté, le récap apparaît dans la sortie console avant l'embed de la nouvelle manche.

### Commande `/frame` — scores personnels

Seule commande slash du jeu (tout le reste passe par les boutons/modal du post hebdomadaire ou par des scripts). N'a aucune option : elle affiche à l'appelant (réponse éphémère) sa propre progression, déterminée à partir de son `discordId` — pas de paramètre à saisir.

Contenu affiché (`handleFrameStatsCommand()`, `api/discord/_handlers/frames.js`) :

- **Manche en cours** : trouvée ou non, score obtenu (ou "pas encore trouvé"/"pas de points").
- **Manches précédentes de la saison** (`getPlayerSeasonResults()`) : uniquement celles où le joueur a trouvé la réponse — triées de la plus récente à la plus ancienne. Le numéro de manche vient de `getSeasonMancheNumber(seasonId, gameId)` (`frame:season:<seasonId>:manche_numbers`, voir "Stockage — Upstash Redis" ci-dessus).
- **Score total de la saison** : somme de tous les résultats archivés (`frame:archived:<seasonId>`) du joueur, saison en cours uniquement (voir "Scores et classements par saison" ci-dessus).

L'affichage "Manche N" est partout devenu **"Saison S · Manche N/X"** (post hebdomadaire, DM de fin de manche, `/frame`) : N est relatif à la saison (repart à 1 à chaque nouvelle saison, attribué par `assignSeasonMancheNumber()`), X est le nombre total de manches prévues sur la saison, calculé calendairement (voir [Saison](#saison)). La progression des images dans `frames.json` (`currentIndex`) reste, elle, indépendante et ne redémarre jamais — seule la numérotation affichée aux joueurs est scopée par saison.

À relancer `node scripts/registerCommands.js` après toute modification (nouvelle option, changement de description) — comme pour toute commande.

### Scripts npm

| Commande                   | Effet                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run frame:test`       | Poste manuellement une nouvelle partie sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`), **sans ping** (le salon de test ne pingue jamais `@MINI-JEUX`, même sans `--no-ping` explicite).           |
| `npm run frame:test:dry`   | Aperçu console de la prochaine partie, sans écrire d'état ni poster sur Discord.                                                                                                                       |
| `npm run frame:public`     | Poste sur le salon public "Général" (`DISCORD_CHANNEL_FRAME_PUBLIC`) — utilisé par le cron `frames.yml`.                                                                                               |
| `npm run frame:public:dry` | Équivalent dry-run de `frame:public`.                                                                                                                                                                  |
| `npm run frame:scores`     | Affiche le classement de la partie en cours : joueur, score de la partie, score total de la saison.                                                                                                    |
| `npm run frame:reset`      | Remet le jeu à zéro : plus de partie active (la suivante repart à `frames.json[0]`), historique et scores effacés. **Destructif** — à éviter une fois de vraies parties jouées, sauf besoin explicite. |

### Variables d'environnement requises

```text
DISCORD_CHANNEL_FRAME_TEST=      # salon de test personnel
DISCORD_CHANNEL_FRAME_PUBLIC=    # salon "Général"
KV_REST_API_URL=                 # Upstash Redis (voir "Stockage — Upstash Redis" ci-dessus)
KV_REST_API_TOKEN=
```

⚠️ Le workflow `.github/workflows/frames.yml` (cron `npm run frame:public`) a besoin de `KV_REST_API_URL`/`KV_REST_API_TOKEN` en plus des secrets Discord habituels — ce ne sont **pas** les mêmes que `BLOB_READ_WRITE_TOKEN` (utilisé par `predictions.yml`, pas par Frame). À ajouter dans Settings → Secrets and variables → Actions du dépôt GitHub, avec les mêmes valeurs que dans `.env` local, sinon le post hebdomadaire échoue avec `[Upstash Redis] The 'url'/'token' property is missing`.

---

## Jeu Anagram (devine la carte)

Second mini-jeu hebdomadaire indépendant, sur le modèle exact de Frame (Modal Discord, DM de fin de manche, scores par manche/saison, `/anagram` en miroir de `/frame`) — voir [Jeu Frame](#jeu-frame-devine-le-film) pour tous les mécanismes partagés (Modal `type:9`/`MODAL_SUBMIT type:5`, stockage Upstash Redis et ses pièges, gestion de saison CR). Cette section ne documente que ce qui est **spécifique** à Anagram.

### Barème — score par position d'arrivée

Contrairement à Frame (pénalités par tentative/indice), le score d'Anagram dépend **uniquement du rang d'arrivée**, sans aucun indice ni pénalité de tentative :

- 1er joueur à trouver : **10 pts**, 2e : **9 pts**, 3e : **8 pts**, ... 10e et suivants : **1 pt** (plancher à 1, pas 0 — tout joueur qui trouve la réponse marque au moins 1 point)
- Un joueur qui ne trouve jamais la réponse : **0 pt** (aucune position ne lui est attribuée, il n'apparaît simplement pas dans le classement de la manche)

La position est attribuée de façon atomique et immuable au moment de la résolution (`assignArrivalPosition()`, `backend/services/anagrams.js` — même pattern `INCR` + `HSETNX` idempotent que `assignSeasonMancheNumber()` de Frame, scopé par `gameId`). Conséquence importante : **position et score sont structurellement la même donnée** — contrairement à Frame, qui a eu un bug réel car son DM "vous êtes le Xe à avoir trouvé" utilisait par erreur le classement trié par score au lieu de l'ordre d'arrivée (`computeGameRanking` vs `computeArrivalOrder`). Anagram n'a qu'**une seule** fonction de classement par manche (`computeGameRanking()`, triée par `position` croissante) : cette classe de bug ne peut pas s'y reproduire.

### Réponse

Réponse libre uniquement (pas d'indice), insensible à la casse et aux accents (`normalizeAnswer()`, `backend/services/textNormalize.js` — partagée avec Frame, seule fonction commune aux deux jeux). `checkAnswer()` vérifie une **égalité stricte** normalisée contre `entry.accept` (contrairement à Frame, qui accepte une sous-chaîne) : une correspondance par sous-chaîne accepterait à tort "Barbares" seul pour "Barbares d'élite", ce qui viderait le jeu de son intérêt sur des noms de cartes courts.

### Données (anagrams.json)

- `data/anagrams/anagrams.json` — liste de 54 anagrammes (`ID`, `anagram`, `answer`, `accept[]`, `cardKey`), éditée à la main. `cardKey` est le nom **anglais** exact de la carte tel que renvoyé par l'API Clash Royale (`fetchCards()`) — ajouté manuellement (aucune localisation FR fournie par l'API), sert uniquement à résoudre l'image de la carte après résolution. La partie suivante boucle au début une fois toutes les entrées épuisées.
- Pas de route à protéger côté anti-spoiler : l'anagramme est un texte publié en clair dans l'embed (contrairement à l'image de Frame). L'image de carte, elle, n'est révélée qu'après résolution (réponse éphémère de révélation), jamais exposée avant.

### Résolution de l'image de carte

`getCardImageUrl(cardKey)` (`backend/services/anagrams.js`) réutilise le cache `getOrSet("clashCardDefinitions", () => fetchCards(), 24h)` **volontairement partagé** avec `backend/routes/matchup.js`/`backend/routes/decks.js` (le cache de `cache.js` est en mémoire, par process, pas namespacé par fichier). Si `cardKey` ne correspond à aucune carte de l'API (typo, carte retirée du jeu), dégrade proprement : `console.warn` + pas d'image dans le message de révélation, jamais de plantage.

### Stockage — Upstash Redis (`anagram:*`)

Même stockage que Frame, préfixe `anagram:` au lieu de `frame:`, **aucun partage de données entre les deux jeux**. Différences de schéma :

| Clé Redis                               | Type              | Contenu                                                                   |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `anagram:position_seq:<gameId>`         | STRING (compteur) | Dernière position d'arrivée attribuée pour cette manche (`INCR`)          |
| `anagram:positions:<gameId>`            | HASH              | `discordId → position` (1, 2, 3...), idempotent `HSETNX`                  |
| `anagram:attempts:<gameId>:<discordId>` | STRING (compteur) | Tentatives incorrectes — informatif uniquement, n'entre pas dans le score |

Pas d'équivalent à `frame:hints:*` (aucun indice) ni à `frame:posted_games` (aucune route d'image à protéger). Pas de clé Redis dédiée "déjà posté cette semaine" : `alreadyPostedThisWeek()` compare la date de `anagram:state.startedAt` à aujourd'hui — un seul writer (`startNewGame()`), pas de redondance.

### Post hebdomadaire à horaire aléatoire (samedi, 10h ou 18h UTC)

GitHub Actions ne permet pas nativement un cron à plage aléatoire. Le workflow `.github/workflows/anagrams.yml` se déclenche 2 fois le samedi (`cron: "0 10,18 * * 6"`, 10h et 18h UTC). À chaque déclenchement, `postAnagram()` (`api/discord/_handlers/anagrams.js`) décide de poster ou non :

1. `alreadyPostedThisWeek()` — si un post a déjà eu lieu cette semaine (même date UTC que `anagram:state.startedAt`), on ne repost pas.
2. `computeWeeklySlotIndex()` — détermine le créneau courant (1 ou 2).
3. `shouldPostThisSlot(slotIndex)` — tirage au sort, probabilité `1/(créneaux restants)` : 1/2 au premier créneau (10h), **1/1 (garanti) au second créneau (18h)** si aucun post n'a encore eu lieu.

Volontairement limité à 2 créneaux (plutôt que d'en étaler beaucoup sur la journée, comme les 7 créneaux de 7h à 19h utilisés initialement) : GitHub Actions retarde parfois les déclenchements planifiés (cf. commentaire dans `pre-reset-snapshot.yml`), et plus il y a de créneaux dans la journée, plus ce risque cumulé pousse mécaniquement le tirage vers le dernier créneau garanti — biais observé en pratique (posts quasi systématiquement en soirée avec 7 créneaux).

`--force` (`npm run anagram:test`/`anagram:public:force`) bypasse entièrement ce gating — utilisé pour les tests manuels en salon de test et le rattrapage si le cron a raté toute sa fenêtre un samedi donné.

### Commande `/anagram` — scores personnels

Miroir exact de `/frame` (voir [Commande `/frame`](#commande-frame--scores-personnels)) : réponse éphémère, bouton "🔄 Rafraîchir", manche en cours + historique de la saison + score total. Seule différence d'affichage : le classement de la manche en cours n'a pas besoin de `findTiedRank` (les positions sont garanties uniques, `entry.position` est directement le rang) — `findTiedRank` reste utilisé pour le classement de **saison** (ZSET, où des ex-aequo sont possibles sur plusieurs manches cumulées).

### Récapitulatif de fin de saison (Anagram)

Identique à Frame (voir [Récapitulatif de fin de saison](#récapitulatif-de-fin-de-saison)) : posté juste avant la manche 1 d'une nouvelle saison si `seasonId` a changé, mêmes règles de troncage (20 joueurs max, exclusion des 0 pt).

### Scripts npm (Anagram)

| Commande                       | Effet                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run anagram:test`         | Poste manuellement une nouvelle partie sur le salon de test, en ignorant le gating hebdomadaire (`--force`), **sans ping** (le salon de test ne pingue jamais `@MINI-JEUX`, même sans `--no-ping` explicite). |
| `npm run anagram:test:dry`     | Aperçu console de la prochaine partie (+ récap de saison éventuel), sans écrire d'état ni poster sur Discord.                                                                                                 |
| `npm run anagram:public`       | Poste sur le salon public si le gating hebdomadaire (jour + tirage au sort) le permet — utilisé par le cron `anagrams.yml`.                                                                                   |
| `npm run anagram:public:dry`   | Équivalent dry-run de `anagram:public`.                                                                                                                                                                       |
| `npm run anagram:public:force` | Poste sur le salon public en ignorant le gating — rattrapage manuel si le cron a raté toute sa fenêtre.                                                                                                       |
| `npm run anagram:scores`       | Classement de la partie en cours (position, score partie, score saison) + joueurs n'ayant pas encore joué.                                                                                                    |
| `npm run anagram:reset`        | Remet le jeu à zéro : plus de partie active, historique et scores effacés. **Destructif**.                                                                                                                    |

### Variables d'environnement requises (Anagram)

Aucune nouvelle variable : Anagram réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` (mêmes salons que Frame, décision explicite pour ne pas multiplier les salons) et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (même instance Upstash Redis, espace de clés `anagram:*` totalement séparé de `frame:*`). Le workflow `.github/workflows/anagrams.yml` réutilise aussi les mêmes secrets GitHub Actions que `frames.yml` (déjà configurés, rien à ajouter).

---

## Jeu Zoom carte (devine les cartes zoomées)

Troisième mini-jeu hebdomadaire indépendant, sur le modèle de Frame (voir [Jeu Frame](#jeu-frame-devine-le-film) pour les mécanismes partagés : Modal `type:9`/`MODAL_SUBMIT type:5`, stockage Upstash Redis et ses pièges, gestion de saison CR). Une manche = une carte de `data/zoom/zoom.json` (base/évoluée/héros mélangées dans le même pool), zoomée à l'extrême sur son icône.

> Une version antérieure affichait 2 cartes par manche avec score partiel indépendant ("slots" A/B) — abandonnée après le premier test réel : le roster de 62 cartes est trop petit pour 2 cartes/manche sans épuiser le pool en quelques semaines. Toute trace de `slot`/`entryA`/`entryB` dans du code plus ancien ou des commentaires fait référence à cette version révolue.

### Barème (Zoom carte)

- Réponse exacte du 1er coup sans indice : **10 pts**
- Chaque tentative incorrecte : **-2 pts**
- Indice utilisé (un seul palier, contrairement aux 2 indices de Frame) : **-3 pts**

`computeScore(attemptsIncorrects, hintUsed)` (`backend/services/zoom.js`) est identique à celle de Frame, sauf que `hintUsed` est un booléen (un seul palier) et non un compteur.

### Réponse (Zoom carte)

Modal à 1 champ, validée par `checkAnswer()` — égalité **stricte** normalisée (comme Anagram, pas de sous-chaîne comme Frame) : un nom de carte est court, une correspondance par sous-chaîne accepterait à tort un fragment.

### Sélection de la manche : progression séquentielle sur un fichier mélangé

Même pattern que Frame/Anagram : `pickNextZoomIndex()` (`backend/services/zoom.js`) avance simplement d'une position dans `data/zoom/zoom.json` (`index+1 % n`) et boucle au début une fois le catalogue épuisé — pas d'état supplémentaire à maintenir en Redis. Le "hasard" ne vient pas d'un tirage effectué au moment de poster, mais du fait que **le fichier lui-même a été mélangé une fois** (un premier essai avait trié `zoom.json` alphabétiquement par `id`, ce qui rendait le jeu totalement prévisible — l'ordre se voyait clairement en test réel). `scripts/generateZoomCatalog.js` préserve cet ordre à chaque régénération (ne retrie jamais alphabétiquement) et insère les cartes nouvellement ajoutées dans un ordre aléatoire plutôt qu'en bloc à la fin. `resetGame()` ne touche pas au fichier : une nouvelle partie repart simplement au début de son ordre actuel.

### Données (`data/zoom/zoom.json` + `data/zoom/images/`)

Contrairement à Anagram (image CDN résolue à la volée) et comme Frame (image stockée localement), les icônes sont téléchargées **une fois** via `scripts/generateZoomCatalog.js` (usage ponctuel, hors flux hebdomadaire) plutôt que requêtées à chaque manche :

- Pool de cartes : les `cardKey` uniques de `data/anagrams/anagrams.json` (même liste que le jeu Anagram, décision explicite — pas encore étendu aux 122 cartes du jeu).
- Noms français : `data/cardNames.json` (source de vérité partagée, voir [Noms français des cartes](#noms-français-des-cartes-datacardnamesjson)) — **jamais** `anagrams.json` directement, pour ne pas dupliquer une donnée corrigeable à un seul endroit. Resynchronisés à chaque exécution du script, même sans retélécharger l'image.
- Icônes de base : `fetchCards()` (catalogue générique Clash Royale, universel).
- Icônes évoluées/héros : `fetchPlayer(tag)` d'un compte de référence — **ces variantes ne sont exposées par l'API QUE sur les cartes que CE joueur a personnellement évoluées** (`evolutionLevel > 0`/`>= 2`), ce n'est pas une métadonnée statique par carte comme l'icône de base. Le script filtre via `countEvolved`/`countHeroes` (`backend/services/collectionConstants.js`, même logique que la page Collection).
- `data/zoom/zoom.json` — un objet par variante jouable (`id`, `cardKey`, `variant: "base"|"evolution"|"hero"`, `answer`, `accept`, `image`, `width`/`height`, `sourceUrl`, `fetchedAt`, et optionnellement `focal`/`zoomStages` pour surcharger le crop par défaut sur une carte précise, réglé à la main après une passe de QA visuelle).
- `data/zoom/images/*.png` — octets téléchargés, jamais exposés statiquement (seule la route `/api/zoom/image` y donne accès, voir ci-dessous).
- Idempotent et purgé : relancer le script ne re-télécharge que si l'URL source a changé ; toute entrée dont le `cardKey` n'est plus dans le pool source (carte retirée d'`anagrams.json`) est supprimée du catalogue et son image effacée — sûr tant qu'aucune manche n'a encore été postée en production.

### Synthèse d'image (`backend/services/zoomImage.js`)

Aucune nouvelle dépendance : réutilise `@resvg/resvg-js` (déjà présent, utilisé par `buildWarDecksImage` dans `api/discord/interactions.js`) pour rasteriser un SVG contenant une `<image href="data:...">` en PNG. Contrairement à `buildWarDecksImage` (qui télécharge des icônes distantes à chaque appel), les octets sont lus directement dans `data/zoom/images/` — aucun réseau au moment de servir une manche.

- `getZoomCardImage(gameId)` — image publique de l'embed, zoom extrême (fixe pour toute la durée de la manche : un embed Discord est partagé par tout le salon, il ne peut pas varier par joueur).
- `getZoomHintImage(gameId)` — crop dézoomé (indice).
- `getZoomRevealImage(gameId)` — carte entière (juste les octets du fichier source, sans SVG).
- Formule de crop : point focal normalisé `(fx, fy)` + facteur de zoom `Z`, une `<image>` surdimensionnée est positionnée pour que ce point atterrisse au centre de la cellule cible, `<clipPath>` explicite pour rogner. Valeurs par défaut `(0.5, 0.45)`, `Z=4.5` (zoom extrême) / `Z=2.3` (dézoom indice), surchargeables par carte via `zoom.json`. ⚠️ Ces valeurs ont déjà été revues une fois à la hausse après un premier test réel où le zoom par défaut (`Z=2.75`) rendait la réponse évidente sans même utiliser l'indice — toute nouvelle carte ajoutée au pool mérite une vérification visuelle avant publication.

### Anti-spoiler : bouton indice = message éphémère, jamais une édition du post public

Contrairement à Frame (indice textuel révélé en clair dans un message éphémère), l'indice de Zoom carte est une **image** — cliquer sur "Indice" ne peut pas modifier l'embed public (partagé par tout le salon), il répond donc par un **embed éphémère** avec le crop dézoomé (`GET /api/zoom/image?gameId=...&stage=hint`), jamais un PATCH du message d'origine.

`GET /api/zoom/image` (`backend/server.js`, juste après la route équivalente de Frame) vérifie `isGamePosted(gameId)` (registre Redis `zoom:posted_games`, jamais nettoyé, même garde-fou anti-spoiler que `frame:posted_games`) avant de servir quoi que ce soit — jamais l'image d'une manche future devinée par construction d'id.

⚠️ Limite acceptée : l'URL de l'indice (`?gameId=X&stage=hint`) est reconstructible par quiconque a vu la manche postée, sans cliquer le bouton ni perdre les 3 pts — aucune authentification possible sur une simple requête d'image d'embed (même modèle de confiance que l'URL d'image de Frame).

### Stockage — Upstash Redis (`zoom:*`)

Même stockage que Frame, préfixe `zoom:` :

| Clé Redis                            | Type              | Contenu                                                                                |
| ------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| `zoom:state`                         | STRING (JSON)     | État de la manche active (`gameId` + métadonnées de saison)                            |
| `zoom:hint:<gameId>:<discordId>`     | STRING (flag)     | Indice utilisé (`SETNX`, un seul palier donc pas besoin de `SADD`/`SCARD` comme Frame) |
| `zoom:attempts:<gameId>:<discordId>` | STRING (compteur) | Tentatives incorrectes                                                                 |
| `zoom:participants:<gameId>`         | HASH              | `discordId → { solved, solvedAt, score, attempts }`                                    |
| `zoom:archived:<seasonId>`           | HASH              | Un champ par manche résolue (`<gameId>:<discordId>`)                                   |
| `zoom:posted_games`                  | SET               | Registre anti-spoiler, jamais nettoyé                                                  |

`gameId` = `id` de l'entrée du catalogue directement (pas de composition, contrairement à l'ancienne version 2-cartes).

### Publication hebdomadaire (vendredi 18h UTC)

`.github/workflows/zoom.yml` (`cron: "0 18 * * 5"`) — horaire fixe comme Frame (contrairement au tirage aléatoire d'Anagram), exécute `npm run zoom:public`.

### Commande `/zoom` — scores personnels

Miroir de `/frame` (voir [Commande `/frame`](#commande-frame--scores-personnels)).

### Récapitulatif de fin de saison (Zoom carte)

Identique à Frame (voir [Récapitulatif de fin de saison](#récapitulatif-de-fin-de-saison)) : posté juste avant la manche 1 d'une nouvelle saison si `seasonId` a changé, mêmes règles de troncage (20 joueurs max, exclusion des 0 pt). Le libellé de chaque manche (`getZoomRoundLabel`) est directement `entry.answer`.

### Scripts npm (Zoom carte)

| Commande                  | Effet                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run zoom:catalog`    | Génère/complète `data/zoom/zoom.json` et télécharge les icônes manquantes dans `data/zoom/images/`. Usage ponctuel, jamais dans le flux hebdomadaire.         |
| `npm run zoom:test`       | Poste manuellement une nouvelle partie sur le salon de test, **sans ping** (le salon de test ne pingue jamais `@MINI-JEUX`, même sans `--no-ping` explicite). |
| `npm run zoom:test:dry`   | Aperçu console de la prochaine partie (+ récap de saison éventuel), sans écrire d'état ni poster sur Discord.                                                 |
| `npm run zoom:public`     | Poste sur le salon public (avec ping) — utilisé par le cron `zoom.yml`.                                                                                       |
| `npm run zoom:public:dry` | Équivalent dry-run de `zoom:public`.                                                                                                                          |
| `npm run zoom:scores`     | Classement de la partie en cours (score partie, score saison) + joueurs n'ayant pas encore joué.                                                              |
| `npm run zoom:move`       | Reposte la manche active dans un autre salon sans faire avancer la partie.                                                                                    |
| `npm run zoom:reset`      | Remet le jeu à zéro : plus de partie active (repart au début de `zoom.json`), historique et scores effacés. **Destructif**.                                   |

### Variables d'environnement requises (Zoom carte)

Aucune nouvelle variable : réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (espace de clés `zoom:*` totalement séparé). Le workflow `.github/workflows/zoom.yml` réutilise les mêmes secrets GitHub Actions que `frames.yml`/`anagrams.yml` (déjà configurés, rien à ajouter).

---

## Jeu La Juste Carte (devine la carte par ses stats)

Quatrième mini-jeu hebdomadaire indépendant, sur le modèle de Frame/Anagram (voir [Jeu Frame](#jeu-frame-devine-le-film) pour les mécanismes partagés : Modal `type:9`/`MODAL_SUBMIT type:5`, stockage Upstash Redis et ses pièges, gestion de saison CR). Différence structurelle majeure : contrairement aux 3 autres jeux (une seule tentative résout la manche), ici chaque joueur soumet **plusieurs propositions successives** contre une carte secrète — ce n'est pas une course entre joueurs, chacun joue sa propre partie à son rythme.

Pas d'autocomplete sur le nom de carte proposé : les Modals Discord ne le supportent pas (limitation de la plateforme). Une commande slash dédiée avec option autocomplete a été envisagée puis écartée (complexité jugée disproportionnée par rapport au gain) — le joueur tape le nom en clair dans la Modal, `resolveGuess()` tolère accents/casse mais pas les fautes d'orthographe.

Une carte Clash Royale secrète est tirée chaque semaine. Le joueur propose le nom (français) d'une autre carte, et le jeu compare les deux sur 4 stats — PV, Portée, Dégâts, Élixir — en indiquant pour chacune si la **proposition** est plus haute (⬆️), plus basse (⬇️) ou identique (✅) à la carte secrète.

### Barème (La Juste Carte)

- Le joueur commence avec 10 points.
- La 1ère proposition est **gratuite** (aucune pénalité, quel que soit le résultat).
- À partir de la 2e proposition, chaque tentative coûte 1 point.
- Bouton **"💡 Indice : rareté"** (voir plus bas) : coûte 3 points, une seule fois par manche.
- Un joueur qui trouve marque toujours **au moins 1 point**, même après plus de 10 essais et l'indice utilisé.

`computeScore(attemptNumber, hintUsed)` (`backend/services/lajustecarte.js`) = `Math.max(1, 11 - attemptNumber - (hintUsed ? 3 : 0))` — une seule formule couvre toutes les règles ci-dessus (la "1ère gratuite" est une conséquence de la formule à `attemptNumber=1`, pas une branche à part).

### Indice "rareté" (bouton, -3 pts)

Sur le même modèle que Zoom (`handleHintButton`, `recordHintUsed`) : bouton toujours visible à côté du bouton de réponse (post public **et** chaque réponse éphémère de reproposition — `buildGameComponents()`), custom_id `lajustecarte_hint:<gameId>`. Cliquer révèle la **rareté** de la carte secrète (Commune/Rare/Épique/Légendaire/Champion) dans un message éphémère, indépendamment du numéro de tentative en cours.

- Idempotent : `recordHintUsed()` utilise `SETNX` sur `lajustecarte:hint:<gameId>:<discordId>` — un 2e clic ré-affiche la rareté gratuitement (`alreadyUsed: true`), aucune pénalité supplémentaire.
- La pénalité de -3 pts n'est appliquée qu'**à la victoire** (`hintUsedFor()` relu au moment de `markSolved()`, pas mémorisé plus tôt) : peu importe quand l'indice a été pris pendant la manche, seul son usage ou non au moment de trouver compte pour le calcul final.
- `participant.hintUsed` est stocké sur le résultat archivé, pour traçabilité (pas encore affiché dans `/justecarte`, à ajouter si besoin).

### Réponse — flux à 3 issues (pas 2 comme Anagram)

Modal à 1 champ (pas d'autocomplete possible dans une Modal Discord), résolue par `resolveGuess()` — égalité **stricte** normalisée (`normalizeAnswer`, comme Anagram) contre le nom français de chaque carte du catalogue **éligible**. Trois issues possibles, à distinguer explicitement dans `handleModalSubmit` (`api/discord/_handlers/lajustecarte.js`) :

1. **Nom non reconnu** — aucun état modifié (ni compteur de tentatives, ni score). Deux sous-cas distingués dans le message renvoyé (`resolveAnyCard()`, qui résout contre la liste COMPLÈTE de `data/cardNames.json`, y compris les cartes non éligibles) : une vraie faute de frappe ("carte inconnue, vérifie l'orthographe") vs une carte réelle mais absente du pool ("🚫 carte non incluse dans ce jeu", avec pointeur vers le bouton "📋 Cartes non incluses" de `/justecarte`) — évite qu'un joueur qui tape correctement "Gobelin géant" pense à une faute de frappe alors que la carte n'est simplement pas dans le jeu.
2. **Carte reconnue mais fausse** — la tentative est ajoutée à l'historique du joueur (`recordAttempt`, `RPUSH`), les indices comparatifs débloqués à ce stade sont renvoyés avec le rappel des cartes déjà proposées (`getGuessHistory`) et un bouton pour reproposer.
3. **Carte trouvée** — `markSolved()` (idempotent) fige le score au numéro de tentative courant, `archiveSolve()` alimente le classement de saison, embed de victoire avec l'image de la carte, DM envoyé (voir plus bas).

### Cartes non incluses — visibles à la demande

`getExcludedCards()` dérive en direct (jamais périmée, pas de liste dupliquée à maintenir) les cartes de `data/cardNames.json` sans les 4 champs de stats (sorts, bâtiments, évolutions, troupes de tour, et les quelques troupes à stats composites/multiples de `scripts/generateCardStats.js`) — 45 cartes actuellement. Deux points d'accès :

- Automatiquement dans le message d'erreur quand un joueur propose une de ces cartes (voir ci-dessus).
- À la demande, bouton **"📋 Cartes non incluses"** sur `/justecarte` (`handleExcludedListButton`) — liste complète, triée alphabétiquement.

### Révélation progressive des indices

| Tentative du joueur | Indices visibles           |
| ------------------- | -------------------------- |
| 1ère                | PV, Portée                 |
| 2e                  | PV, Portée, Élixir         |
| 3e et suivantes     | PV, Portée, Élixir, Dégâts |

`compareCard(secretEntry, guessEntry, attemptNumber)` (fonction pure) calcule les 4 comparateurs puis ne renvoie que le sous-ensemble débloqué à ce numéro de tentative. Le sens de la flèche décrit la **carte secrète** relativement à la proposition ("PV ⬆️" = la carte secrète a un PV plus élevé que ta proposition) — comparateur `secretValue > guessValue ? "up" : "down"`. Sens inversé une fois en test réel : la lecture "ma proposition est plus haute" prêtait à confusion, l'intuition naturelle est que la flèche pointe vers où se trouve la cible.

Portée : les troupes de mêlée sont comparées sur une catégorie ordinale (`short` < `medium` < `long`), pas sur une valeur chiffrée ; les troupes à distance sur leur portée réelle. Les deux échelles sont fusionnées via un champ `range.rank` précalculé (mêlée = 1/2/3, distance = `3 + valeur`), qui garantit qu'une troupe à distance, même la plus courte, passe toujours devant la troupe de mêlée la plus longue. `compareCard` compare toujours `range.rank`, jamais la catégorie/valeur brute directement.

### Données — stats ajoutées directement dans `data/cardNames.json`

Contrairement à Zoom (catalogue dérivé séparé), **aucun fichier dédié** : `scripts/generateCardStats.js` ajoute les champs `elixir`/`hp`/`damage`/`range` directement aux entrées de `data/cardNames.json` (voir [Noms français des cartes](#noms-français-des-cartes-datacardnamesjson)) qui sont éligibles au jeu — les autres entrées (sorts, bâtiments, évolutions, troupes de tour) restent sans ces champs. Les **champions sont inclus** (seuls les évolutions et les troupes de tour sont exclues de fait, un champion n'est PAS un "héros" au sens de l'énoncé du jeu — décision confirmée explicitement). C'est justement cette présence des 4 champs qui sert de filtre du pool de jeu à l'exécution (`loadCatalog()`), aucun champ `type`/`eligible` séparé à maintenir.

Sources :

- Élixir : `fetchCards()` (API officielle Clash Royale) — la colonne "Cost" du wiki ne sert qu'en garde-fou de cohérence (avertissement console en cas d'écart, jamais stocké).
- PV/Dégâts/Portée : un seul appel à l'API MediaWiki de `clashroyale.fandom.com/wiki/Cards` (`action=parse&page=Cards&prop=wikitext`), section "Troops" du wikitext uniquement. Ces valeurs y sont déjà au niveau **Tournament Standard** (précisé explicitement dans le texte au-dessus de la table) — aucun calcul de niveau à faire.
- `damage` = colonne **"Damage"** (dégât par coup), volontairement pas "Damage Per Second" : la colonne DPS vaut `N/A` pour toute carte sans cadence d'attaque régulière (Esprits, Battle Ram, Wall Breakers...) alors que ces cartes ont bien un dégât par coup exploitable — utiliser "Damage" maximise le pool sans rien perdre en équité (toujours une seule valeur par carte).

Exclusions du pool (77 cartes éligibles sur 99 lignes de troupes "de base" au 2026-08, dont 6 champions : Archer Queen, Boss Bandit, Goblinstein, Golden Knight, Little Prince, Skeleton King) :

- Sous-unités générées (liens wiki _piped_, ex. Bush Goblins, Golemite, Lava Pup) — la vraie carte a sa propre ligne, sauf `Rascals` qui n'en a aucune et disparaît donc naturellement du pool.
- Cartes à stats "composites", variables, ou sans dégât direct — détection générique : si le champ brut PV, Dégâts ou Portée contient un `/` (mode double, ex. Goblin Gang "202/133") ou un `-` (dégât progressif, ex. Inferno Dragon "35-422") → exclue, aucune valeur unique fiable pour une comparaison équitable (Goblin Gang/Giant/Machine, Inferno Dragon, Mighty Miner, Monk, Ram Rider, Spirit Empress, Suspicious Bush — aucune attaque directe —, Three Musketeers). Deux champions (Mighty Miner, Monk) tombent dans cette exclusion pour la même raison technique que les autres cartes, pas parce que ce sont des champions.

Comme `generateCardNames.js` pour `fr` : le script ne fait qu'**ajouter** les 4 champs aux entrées qui n'en ont pas encore, jamais réécrire une entrée déjà complétée (y compris après correction manuelle). Usage ponctuel : `node scripts/generateCardStats.js` (ou `npm run justecarte:stats`).

### Ordre de rotation hebdomadaire — persisté en Redis, pas dans le fichier

Contrairement à Frame/Anagram/Zoom (l'ordre physique du fichier pilote la progression), `data/cardNames.json` doit rester trié alphabétiquement (contrainte de `generateCardNames.js`) : la prochaine carte secrète serait donc devinable à l'avance si on s'y fiait. L'ordre de passage est mélangé une fois puis **persisté dans Redis** (`lajustecarte:order`, `loadPlayOrder()`) ; les cartes nouvellement ajoutées par `generateCardStats.js` sont insérées à la suite, mélangées entre elles, sans perturber l'ordre déjà en cours. `pickNextIndex()` avance simplement d'une position dans cet ordre (`index+1 % n`), boucle une fois épuisé.

Cet ordre n'est visible nulle part côté joueur (le fichier reste alphabétique, l'embed public ne révèle jamais la carte à venir) : `npm run justecarte:order` (`scripts/justeCarteOrder.js`) affiche la rotation complète pour un admin — outil de lecture qui révèle toutes les cartes à venir, jamais exposé aux joueurs (même modèle de confiance que `justecarte:scores`). S'il n'existe pas encore d'ordre (avant la toute première partie), le script en génère un et le persiste, exactement comme le ferait la première publication.

### Stockage — Upstash Redis (`lajustecarte:*`)

| Clé Redis                                    | Type          | Contenu                                                                                                                                                                      |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lajustecarte:state`                         | STRING (JSON) | État de la manche active (`gameId` = cardKey de la carte secrète + métadonnées de saison)                                                                                    |
| `lajustecarte:order`                         | STRING (JSON) | Ordre de rotation mélangé, persisté (voir ci-dessus)                                                                                                                         |
| `lajustecarte:usernames:<gameId>`            | HASH          | `discordId → pseudo`                                                                                                                                                         |
| `lajustecarte:attempts:<gameId>:<discordId>` | LIST          | Historique des cartes **valides** proposées (nom FR, dans l'ordre) — sa longueur (`RPUSH`/`LLEN`) sert aussi de compteur de tentatives ; jamais complétée sur un nom inconnu |
| `lajustecarte:hint:<gameId>:<discordId>`     | STRING (flag) | Indice rareté utilisé (`SETNX`, idempotent)                                                                                                                                  |
| `lajustecarte:participants:<gameId>`         | HASH          | `discordId → { solved, solvedAt, score, attempts, hintUsed }`                                                                                                                |
| `lajustecarte:season:<seasonId>`             | ZSET          | Score cumulé de la saison                                                                                                                                                    |
| `lajustecarte:archived:<seasonId>`           | HASH          | Un champ par manche résolue (`<gameId>:<discordId>`), idempotence                                                                                                            |

Pas d'équivalent à `anagram:positions`/`position_seq` : aucune notion de rang d'arrivée collectif, le score de chaque joueur ne dépend que de son propre numéro de tentative.

### Publication hebdomadaire (dimanche 16h UTC)

`.github/workflows/lajustecarte.yml` (`cron: "0 16 * * 0"`) — horaire fixe comme Frame/Zoom (pas de tirage aléatoire comme Anagram), exécute `npm run justecarte:public`.

### Commande `/justecarte` — scores personnels

Miroir de `/anagram` (voir [Commande `/anagram`](#commande-anagram--scores-personnels) dans la section Anagram), adapté pour afficher le nombre de tentatives au lieu d'un rang d'arrivée.

### Récapitulatif de fin de saison (La Juste Carte)

Identique à Frame/Anagram (voir [Récapitulatif de fin de saison](#récapitulatif-de-fin-de-saison)) : posté juste avant la manche 1 d'une nouvelle saison si `seasonId` a changé, mêmes règles de troncage (20 joueurs max, exclusion des 0 pt).

### DM — uniquement à la victoire

Contrairement à Anagram (DM à chaque manche, puisqu'une seule tentative la résout), un DM à chaque proposition serait intrusif ici vu qu'un joueur peut en soumettre plusieurs de suite : `sendJusteCarteDM` n'est appelé qu'une fois, au moment où le joueur trouve la carte secrète.

### Scripts npm (La Juste Carte)

| Commande                        | Effet                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run justecarte:stats`      | Ajoute les stats (elixir/hp/damage/range) aux cartes éligibles de `data/cardNames.json`. Usage ponctuel, jamais dans le flux hebdomadaire.                                       |
| `npm run justecarte:test`       | Poste manuellement une nouvelle partie sur le salon de test, **sans ping** (le salon de test ne pingue jamais `@MINI-JEUX`, même sans `--no-ping` explicite, comme `zoom:test`). |
| `npm run justecarte:test:dry`   | Aperçu console de la prochaine partie (+ récap de saison éventuel), sans écrire d'état ni poster sur Discord.                                                                    |
| `npm run justecarte:public`     | Poste sur le salon public (avec ping) — utilisé par le cron `lajustecarte.yml`.                                                                                                  |
| `npm run justecarte:public:dry` | Équivalent dry-run de `justecarte:public`.                                                                                                                                       |
| `npm run justecarte:scores`     | Classement de la partie en cours (tentatives, score partie, score saison) + joueurs n'ayant pas encore joué.                                                                     |
| `npm run justecarte:order`      | Affiche l'ordre de rotation complet des cartes secrètes à venir. **Outil admin** — révèle toutes les cartes futures, jamais à exposer aux joueurs.                               |
| `npm run justecarte:reset`      | Remet le jeu à zéro : plus de partie active, ordre de rotation remélangé à la prochaine partie, historique et scores effacés. **Destructif**.                                    |

### Variables d'environnement requises (La Juste Carte)

Aucune nouvelle variable : réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (espace de clés `lajustecarte:*` totalement séparé). Le workflow `.github/workflows/lajustecarte.yml` réutilise les mêmes secrets GitHub Actions que `frames.yml`/`anagrams.yml`/`zoom.yml` (déjà configurés, rien à ajouter).

---

## Tamagoshi (bébé dragon "Lilith")

Mini-jeu communautaire quotidien indépendant du Clash Royale : Mohamed Light confie son Bébé Dragon "Lilith" à la communauté pendant `tamagotchi.json.duree_jours` jours (7 en Manche 2, était 10 en Manche 1). Les membres doivent maintenir 3 jauges (Estomac 🔥, Énergie ⚡, Moral 🥨, 0-100%) dans la « zone verte » (40-70%) via des votes par bouton, avec un Cron quotidien à 08:00 UTC. Pas de commande slash associée — la publication/suppression passe uniquement par `scripts/postTamagotchi.js` (manuel ou cron), les boutons restent gérés par `api/discord/interactions.js`. Le jeu est rejoué plusieurs fois dans l'année (une **manche** = une partie complète de `duree_jours` jours) ; les mécaniques ci-dessous ont été retravaillées entre la manche 1 (2026-08) et la manche 2 suite au constat que le jeu restait trop facile en répétant une même stratégie tout du long. Rien dans le code ne suppose une durée fixe : `duree_jours` pilote tout (paliers de fin de partie, fenêtre de la Pilule, texte d'intro du Jour 1), seul le calendrier d'événements (`evenements_possibles`) doit être redimensionné à la main si la durée change.

### Déroulement

Un seul message actif à la fois dans le salon dédié. Chaque jour, `postTamagotchi()` (`api/discord/_handlers/tamagotchi.js`) :

1. Clôture le jour actif (s'il y en a un) : tallie les votes du jour, calcule l'impact pondéré (voir "Résolution du vote" ci-dessous), en déduit les jauges de fin de journée, note la journée (Parfaite/Moyenne/Catastrophe → +1/0/-1 étoile de dressage), met à jour la Confiance et l'action fatiguée du lendemain (voir plus bas), et écrit un bilan dans l'historique interne.
2. Calcule les jauges d'ouverture du jour suivant (`computeDayOpenGauges()`) : jauges de fin de journée + modificateur de l'éventuel événement programmé ce jour-là (voir "Événements programmés").
3. Supprime le message Discord de la veille (`DELETE /channels/{id}/messages/{id}`, tolérant un échec) et publie le nouveau jour, avec un bouton par action affichant son compteur de votes en temps réel.

Au dernier jour (`jour > config.duree_jours`), au lieu d'ouvrir un nouveau jour, le message de fin de partie est posté (palier S/B/F selon le total d'étoiles, éventuellement plafonné par la Confiance — voir "Fin de partie") et `tamagotchi:state.termine` passe à `true` — les runs suivants du cron deviennent des no-op silencieux.

### Résolution du vote

Un membre ne peut voter qu'une fois par jour parmi les actions réelles (Nourrir, Sieste, Jouer, Câliner), et **ce vote n'est pas modifiable** : revoter la même action est un no-op, voter une action différente est rejeté (`recordVote()`, `backend/services/tamagotchi.js`). Le clic sur un bouton d'action répond toujours en éphémère à l'auteur (confirmation ou rejet du vote, `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` puis `PATCH .../messages/@original`) ; le message public (compteurs de votes) est mis à jour séparément par un `PATCH /channels/{id}/messages/{id}` direct avec le token du bot, découplé de la réponse éphémère.

Bretzel et le bouton Projection (ex-5ᵉ/6ᵉ choix de vote) ont été retirés en Manche 2 : Bretzel s'est avéré redondant une fois la Fatigue en place (jamais utilisé dans une stratégie optimale, vérifié par simulation), et Projection n'apportait qu'une commodité de coordination au prix d'un bouton en plus — `npm run tamagotchi:status` remplit déjà ce rôle côté admin.

L'impact d'une journée est une **moyenne pondérée par part de votes** (`computeDayImpact()`) : chaque action votée contribue à l'impact proportionnellement à sa part des votes exprimés, multipliée par un **facteur de participation** (`min(total_votes / votants_reference, 1)`, `tamagotchi.json.votants_reference`) — en dessous de la référence, l'effet est affaibli proportionnellement (plus de votants = plus d'impact réel, pas seulement un ratio) ; à la référence ou au-delà, l'effet est identique à une simple moyenne pondérée. Sans aucun vote, l'impact est nul (l'événement du jour, s'il y en a un, s'applique quand même).

**Fatigue** (`tamagotchi.json.fatigue.facteur`, `dominantAction()`) : l'action qui a recueilli le plus de votes un jour donné (Câliner incluse) voit son impact réduit de ce facteur le jour suivant (`computeDayImpact(..., fatigue)`) — empêche de répéter indéfiniment la même stratégie gagnante d'un jour sur l'autre. Égalité stricte entre deux actions -> aucune fatiguée ce jour-là. L'action fatiguée du lendemain est persistée dans `tamagotchi:state.actionFatiguee`.

### Câliner et Confiance

**Câliner** (🤗) est une action comme les autres (aucun impact notable sur les 3 jauges hormis un léger coût Estomac), mais c'est la SEULE à faire remonter la **Confiance** (`tamagotchi:state.confiance`, 4ᵉ jauge à sens unique visible dans l'embed, 100 au départ). La Confiance baisse d'elle-même sur les jours Moyenne/Catastrophe (`config.confiance.malus_moyen`/`malus_catastrophe`) et ne peut être compensée par AUCUNE des 3 jauges de gameplay — seul un vote Câliner (`computeCalinerConfianceBonus()`, elle-même soumise à la Fatigue) la fait remonter, au prix d'un vote non dépensé ailleurs. Objectif : rendre certaines conséquences non-compensables par un simple rééquilibrage des jauges le lendemain.

### Bouton Règles du jeu

`[📖 Règles du jeu]` est une action d'information pure, consultable librement sans jamais consommer le vote : elle affiche un rappel des impacts de chaque action, de la zone idéale, de la Fatigue et de la Confiance, généré depuis `tamagotchi.json`.

### Événements programmés

Les événements vivent dans `tamagotchi.json.evenements_possibles`, chacun portant son propre champ `jour` (`eventForDay()` cherche l'entrée dont `jour` correspond, pas un index positionnel — ajouter/déplacer un événement ne demande qu'une édition du JSON). Un événement modifie les jauges une seule fois, en entrée du jour concerné (jamais en sortie du jour précédent, sauf type `actions_modifiees` ci-dessous), donc il n'influence jamais la notation du jour où il a été calculé, seulement les jauges d'ouverture du jour où il s'applique. Un événement peut aussi être un nerf temporaire d'action(s) plutôt qu'un delta de jauges (`actions_modifiees`, ex. Jour 5 en Manche 2 : Nourrir remplit moins bien l'Estomac ce jour-là) — via `applyActionOverrides()`, effectif pendant toute la clôture du jour concerné.

### Fin de partie (dernier jour)

Le total d'étoiles de dressage détermine un premier palier (`computeFinalTier(starTotal, paliers)`) : **S-Tier**, **B-Tier**, **F-Tier** en dessous — annonces narratives, pas de rôle Discord réel créé/attribué. Les seuils S/B sont configurables (`tamagotchi.json.paliers`, ex. Manche 2 sur 7 jours : S≥6, B≥3 — proportionnels aux seuils historiques 8/10 et 4/10 de la Manche 1, pas remis à plat arbitrairement) ; `computeFinalTier()` retombe sur 8/4 par défaut si `paliers` est omis, pour rester rétro-compatible. Ce palier est ensuite **plafonné par la Confiance finale** (`capTierByConfiance()`, seuils dans `tamagotchi.json.confiance.plafond_tier`) : une Confiance trop basse empêche le palier S, une Confiance très basse plafonne même à F, quel que soit le nombre d'étoiles — un mauvais début de manche (jours Moyenne/Catastrophe non compensés par Câliner) laisse une trace qu'aucun bon jour de jauges ne peut effacer. Le récap final indique explicitement quand ce plafonnement a joué.

### Manches (comparaison entre parties) — Tamagoshi

`tamagotchi:manches` (HASH permanent, jamais nettoyé par `resetTamagotchi()`) archive le bilan de chaque manche terminée, indexé par un numéro strictement croissant (`tamagotchi:manche_seq`, `INCR` atomique) : `archiveManche({ starTotal, tier, resolvedAt })`. À l'écran de fin (dernier jour), l'embed liste les 10 dernières manches (`listManches()`) avec un 🏆 sur le meilleur total d'étoiles toutes manches confondues — la manche qui vient de se terminer y apparaît elle-même, marquée _(cette manche)_.

⚠️ L'archivage n'a lieu que pour une **vraie publication sur le salon public** (`postTamagotchi(channelId, { isPublic: true })`, déclenché uniquement par `npm run tamagotchi:public`/le workflow GitHub) — jamais en dry-run, ni sur le salon de test (`npm run tamagotchi:test`), même si la partie de test va jusqu'au bout. Convention volontaire : les scripts npm servent toujours à tester, seul `--public` (donc en pratique le workflow GitHub, cron ou `workflow_dispatch`) représente une manche réelle. Ça évite de polluer l'archive avec des parties de test sans avoir à y penser à chaque reset — `npm run tamagotchi:reset:manches` (`--manches`) reste disponible comme filet de sécurité manuel (ex. `--public` lancé par erreur), mais ne devrait normalement jamais être nécessaire.

### Données (tamagotchi.json)

- `data/tamagotchi/tamagotchi.json` — config statique éditée à la main : `duree_jours`, zones idéales, jauges initiales, `votants_reference`, `fatigue.facteur`, `confiance` (`depart`/`malus_moyen`/`malus_catastrophe`/`plafond_tier`), `paliers` (seuils S/B de fin de partie, voir "Fin de partie" — optionnel, `computeFinalTier()` retombe sur 8/4 si absent), `actions` (impact par jauge de chaque bouton — `pilule` marquée `is_info_action: true` pour être exclue du calcul d'impact ; `caliner` porte en plus `confiance_bonus`) et `evenements_possibles` (chaque entrée porte son propre champ `jour`, pas d'ordre positionnel). Chargée une fois et mise en cache (`loadTamagotchiConfig()`), jamais mutée à l'exécution.
- `frontend/public/images/tamagotchi/tama-01.webp` à `tama-10.webp` — une illustration par jour, servie en asset statique (même principe que `frontend/public/images/banner1.webp`/`banner2.webp`) et référencée directement par URL (`tamagotchiImageUrl()`, `api/discord/_handlers/tamagotchi.js`) dans le champ `image` de l'embed. Contrairement au jeu Frame, aucun besoin de masquer l'URL (pas un jeu de devinette) : pas de route API dédiée, juste un fichier public.
- `data/tamagotchi/narratifs.json` — pools de variantes de texte (une intro "lore inutile" façon météo/horoscope, 3 variantes par état notable de jauge × 3 jauges + Confiance, et des phrases de clôture citant les votants) séparées du code pour être enrichies sans y toucher. Sélection déterministe par jour (`pickFlavor()`, indexé sur `jour`, jamais `Math.random()`) : le texte reste identique à chaque ré-affichage du même jour (ex. après un clic de vote) et ne varie qu'd'un jour à l'autre.

### Stockage — Upstash Redis (`tamagotchi:*`)

Même instance et mêmes conventions que Frame/Anagram (`automaticDeserialization: false`, sérialisation JSON manuelle). Espace de clés `tamagotchi:*`, totalement séparé des autres jeux. La progression est strictement linéaire (Jour 1 à 10) : un simple compteur entier `jour` dans l'état suffit, pas de table jour→séquence dédiée.

| Clé Redis                          | Type              | Contenu                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tamagotchi:state`                 | STRING            | `{ jour, gauges, confiance, actionFatiguee, channelId, messageId, publishedAt, termine, starTotal, lastEvent, lastRating, dayVoters }` — jour actuellement affiché                                                                                                             |
| `tamagotchi:votes:<jour>`          | HASH              | `discordId → actionId` — jetable, effacé après clôture du jour                                                                                                                                                                                                                 |
| `tamagotchi:vote_usernames:<jour>` | HASH              | `discordId → pseudo` — jetable, uniquement pour l'affichage admin (`npm run tamagotchi:status`) et le texte narratif, jamais utilisé pour la logique de vote                                                                                                                   |
| `tamagotchi:historique`            | HASH              | `jour → { gaugesAvant, gaugesApres, voteCounts, voters, impact, event, rating, starDelta, starTotalApres, confianceAvant, confianceApres, actionFatiguee, resolvedAt }` — bilans quotidiens de la manche EN COURS, écrasés d'une manche à l'autre (les jours 1-10 se répètent) |
| `tamagotchi:manches`               | HASH              | `manche → { manche, starTotal, tier, resolvedAt }` — un bilan par manche TERMINÉE, jamais nettoyé (persiste entre les manches, y compris après `npm run tamagotchi:reset`)                                                                                                     |
| `tamagotchi:manche_seq`            | STRING (compteur) | Numéro de la prochaine manche à archiver, incrémenté (`INCR`) à chaque fin de partie réelle (jamais en dry-run)                                                                                                                                                                |
| `tamagotchi:pilule_total_used`     | STRING (compteur) | Nombre total d'utilisations réussies de la Pilule sur la manche en cours, plafonné par `actions.pilule.total_cap`                                                                                                                                                              |
| `tamagotchi:pilule_used:<jour>`    | STRING            | Posée (SETNX) dès la 1ʳᵉ utilisation réussie de la Pilule ce jour-là — au plus 1 réussite/jour                                                                                                                                                                                 |

### Pilule (filet de sécurité rare, Jours `pilule.day_min`-`pilule.day_max`)

Action à part (`is_info_action: true`, exclue de `computeDayImpact()`) : effet **instantané** (rapproche chaque jauge de la moyenne d'au plus `max_step` points dès le clic, `computePiluleDelta()`), pas seulement à la clôture. Ressource partagée et rare : au plus 1 réussite par jour (SETNX, premier arrivé) ET au plus `total_cap` réussites cumulées sur toute la manche (`claimPilule()`). Consomme le vote quotidien du joueur **seulement si l'effet est effectivement appliqué** — si la réclamation échoue (déjà utilisée aujourd'hui / quota épuisé), le vote est libéré (`releaseVote()`) pour qu'il puisse revoter une vraie action, même précédent que `releaseVoteSlot()` dans Robinson.

### Scripts npm (Tamagoshi)

| Commande                           | Effet                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run tamagotchi:test`          | Poste manuellement le jour du Tamagoshi sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`).                                                                                                                                                                              |
| `npm run tamagotchi:test:dry`      | Aperçu console du prochain jour (ou du message de fin de partie au dernier jour), sans écrire d'état ni poster sur Discord.                                                                                                                                                    |
| `npm run tamagotchi:public`        | Poste sur le salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) — utilisé par le cron `tamagotchi.yml`.                                                                                                                                                                        |
| `npm run tamagotchi:public:dry`    | Équivalent dry-run de `tamagotchi:public`.                                                                                                                                                                                                                                |
| `npm run tamagotchi:reset`         | Remet le Tamagoshi à zéro : plus de journée active, votes/historique de la manche en cours effacés. **Destructif** — préserve toujours `tamagotchi:manches` (l'archive des manches passées, qui ne s'alimente de toute façon qu'en `--public`, voir "Manches" plus haut). |
| `npm run tamagotchi:reset:manches` | Identique, mais efface aussi `tamagotchi:manches`/`tamagotchi:manche_seq`. **Destructif**, à réserver au filet de sécurité (ex. un `--public` lancé par erreur pendant les tests).                                                                                        |
| `npm run tamagotchi:status`        | Affiche l'état courant (jauges, Confiance, action fatiguée, étoiles, décompte des votes du jour) ainsi qu'une projection du jour suivant, sans passer par Discord.                                                                                                        |

### Variables d'environnement requises (Tamagoshi)

Aucune nouvelle variable : le Tamagoshi réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` (mêmes salons que Frame/Anagram, décision explicite pour ne pas multiplier les salons) et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (même instance Upstash Redis, espace de clés `tamagotchi:*` totalement séparé). Le workflow `.github/workflows/tamagotchi.yml` (cron quotidien `npm run tamagotchi:public`) réutilise les mêmes secrets GitHub Actions que les autres jeux (déjà configurés, rien à ajouter).

---

## Robinson (survie insulaire communautaire)

Mini-jeu communautaire quotidien indépendant du Clash Royale : la communauté est naufragée sur une île pendant 10 jours, jusqu'à l'arrivée des secours au Jour 11. Les membres votent chaque jour une action (Pêcher, Collecter de l'eau, Récolter du bois, Explorer, Construire le Radeau) pour alimenter 3 stocks de ressources (Nourriture, Eau, Bois) consommés automatiquement chaque nuit. Pas de commande slash associée — la publication/suppression passe uniquement par `scripts/postRobinson.js` (manuel ou cron), les boutons restent gérés par `api/discord/interactions.js`.

### Déroulement (Robinson)

Un seul message actif à la fois dans le salon dédié. Contrairement au Tamagoshi (où tout l'impact d'une journée est calculé une seule fois, séquentiellement, au cron), **les récoltes et le coût du Radeau sont appliqués en continu pendant la journée**, à chaque clic, avec un retour immédiat au joueur en éphémère (« Tu as pêché 2 poissons ! ») — voir "Résolution du vote et concurrence" ci-dessous pour le détail technique. Seule la **consommation automatique** reste calculée une fois par jour, au cron :

1. `postRobinson()` (`api/discord/_handlers/robinson.js`) clôture le jour actif : si le Radeau est déjà achevé (voir "Victoire anticipée"), la partie s'arrête là, sans consommation. Sinon, `computeClosure()` (`backend/services/robinson.js`) calcule `V` = nombre de votants uniques du jour qu'on clôture (`HLEN robinson:votes:<jour>`), mais applique la consommation automatique `-V_veille` Nourriture, `-V_veille` Eau, `-⌈V_veille/2⌉` Bois (plancher 0) — **`V_veille`, pas `V`** : la conso se base sur `getHistoriqueEntry(jour - 1).V`, la mobilisation d'**hier**, jamais sur les votes du jour même. ⚠️ **Décision du 27/08**, corrigeant un vrai souci de jeu collaboratif : baser la conso sur `V` du jour même rend toute baisse de participation "gratuite" (besoin et production rétrécissent ensemble, jamais de vraie pénurie même si plus personne ne vote). En la basant sur `V_veille`, une chute de mobilisation aujourd'hui reste chargée sur la taille de camp d'hier — un vrai coût, pas juste un signal d'alerte cosmétique. Exception unique : le **Jour 1** n'a pas de veille, il garde son propre `V` (comportement historique inchangé). `V` (le vrai décompte du jour qu'on clôture) continue de servir ailleurs sans changement : conditions des événements du jour suivant (Colis Royal, Poissons Pourris), montant de l'Épave, tirage du Chef Explorateur, champ `V` de l'historique. Seule la consommation change de base. Puis vérification Gobelins si l'événement du jour clos est actif — ce stock est encore **intermédiaire**, pas le stock final.
2. Si le Jour 11 est atteint → victoire (secours arrivés), sans jamais passer par l'étape suivante. Sinon, l'événement programmé du jour **suivant** est résolu (voir plus bas) et ses bonus/pertes (Colis Royal, Une incroyable découverte, Poissons Pourris, Indigestion Royale) sont appliqués au stock intermédiaire de l'étape 1 pour obtenir le stock **final**, celui qui sera réellement affiché.
3. `finalizeDayClosure()` met à jour les compteurs de jours consécutifs à 0 **sur ce stock final** (jamais sur l'intermédiaire de l'étape 1), écrit l'historique et vide les votes du jour clos. Si une ressource est à 0 pour la 3ᵉ journée consécutive → défaite immédiate (`ZERO_STREAK_LIMIT`, initialement 2 — assoupli le 24/08 pour remonter le taux de survie sans toucher au barème ni aux stocks initiaux). Sinon, le jour suivant s'ouvre : suppression du message de la veille (`DELETE`, tolérant), publication du nouveau jour.

⚠️ **Incident du 26/08** : avant cette étape 2/3, la défaite était déterminée directement sur le stock intermédiaire de l'étape 1, avant tout bonus/perte du jour suivant. Un Colis Royal (ou "Une incroyable découverte", ou Indigestion Royale) pouvait alors remonter à l'affichage un stock qui venait de toucher 0 — mais le "jour à 0" avait déjà été compté dans le streak, invisible pour les joueurs (l'embed n'a jamais montré que 0, seulement la valeur finale positive). Pire : ce streak fantôme restait en mémoire pour les jours suivants, un danger totalement invisible même en re-vérifiant l'affichage. Corrigé en déplaçant le calcul des compteurs (`updateZeroStreaks()`) après application des bonus/pertes du jour suivant — la défaite se base désormais uniquement sur ce que les joueurs voient réellement à l'écran.

`robinson:state.termine` passe à `true` dès qu'une issue (victoire Radeau, victoire Jour 11, défaite) est atteinte — les runs suivants du cron deviennent des no-op silencieux, même principe que `tamagotchi:state.termine`.

### Résolution du vote et concurrence

Un membre ne peut voter qu'une fois par jour parmi les 5 actions, et **ce vote n'est pas modifiable** une fois qu'il a réellement abouti (comme le Tamagoshi). La réservation du slot de vote utilise `HSETNX` (pas `HGET` puis `HSET`) car le Radeau doit pouvoir **libérer** une réservation ratée : si le stock de Bois est insuffisant au moment du clic, le vote est rejeté _sans consommer le slot_ (`releaseVoteSlot()`), le joueur peut réessayer plus tard dans la journée si le stock remonte — contrairement à un vote posé sur une action différente, qui reste définitif jusqu'au lendemain.

Les stocks de ressources (`robinson:stock:poisson/eau/bois`) et les points de Radeau (`robinson:radeau_points`) vivent dans des **clés Redis numériques séparées, mutées uniquement via `INCRBY`/`DECRBY`** — jamais un blob JSON relu-modifié-réécrit, qui perdrait des mises à jour si deux membres cliquent en même temps (le second `SET` écraserait le premier). Le coût du Radeau (le seul cas pouvant échouer) utilise le pattern « décrémenter puis vérifier, compenser si négatif » (`attemptRaftContribution()`) : sûr sans script Lua, personne d'autre ne lisant le stock de Bois de façon atomiquement sensible entre les deux appels du même flux.

Le clic sur un bouton d'action répond toujours en éphémère à l'auteur (`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` puis `PATCH .../messages/@original`, comme le Tamagoshi) avec le résultat exact du tirage ; le message public (stocks, radeau, compteurs de votes) est mis à jour séparément par un `PATCH /channels/{id}/messages/{id}` direct avec le token du bot.

### Tirages et équilibrage

Pêcher/Eau/Bois tirent **0 à 5** unités (~16,7 % chacun, `rollHarvestAmount()`) ; Explorer tire toujours 3 unités d'une seule et même ressource, tirée au hasard parmi les 3 (`rollExplorerYield()`) — jamais une répartition entre plusieurs ressources.

⚠️ Ce barème (0-5, moyenne 2,5 — initialement 0-3) est le résultat d'un équilibrage par **simulation Monte Carlo** (plusieurs milliers de parties simulées avec les vraies fonctions du jeu, plusieurs stratégies de vote testées). Le calcul brut (consommation `V`/`V`/`⌈V/2⌉` vs récolte moyenne par vote dédié) rend le jeu **mathématiquement imperdable-à-l'envers** avec le barème initial 0-3 : couvrir Nourriture _et_ Eau demanderait à elles seules 133 % des votes disponibles. Attention, ce garde-fou est fragile : redescendre à une moyenne de 2 (barème 0-4) fait retomber la survie passive à **1-16 %** pour tout groupe de 8 votants ou plus (confirmé par simulation) — quasiment le même effondrement que le barème 0-3 initial. Ne pas réduire ce barème sans revalider par simulation : le jeu redevient vite ingagnable.

⚠️ Le barème 0-5 place la moyenne de récolte _exactement_ au point d'équilibre statistique avec la consommation (`V`/`V`/`⌈V/2⌉` = 100 % des votes disponibles en moyenne, sans aucune marge) — un design volontairement tendu, mais qui s'est révélé beaucoup plus fragile que documenté à l'origine : une re-simulation du 24/08 (stratégie de vote réactive au stock affiché dans le Journal, pas un simple ratio théorique figé) donnait une survie passive proche de **1-7 % à V=10-20**, très loin de la fourchette 46-58 % annoncée précédemment — écart qui n'a pas pu être retracé à un changement de code (les valeurs de `robinson.json` sont identiques depuis leur commit d'introduction), donc vraisemblablement un biais ou un bug de la simulation Monte Carlo d'origine, jamais committée dans le dépôt. Deux ajustements ont été faits le 24/08 pour corriger le tir **sans toucher au barème de tirage ni aux stocks initiaux** (les deux leviers les plus sensibles, cf. ci-dessus) : `ZERO_STREAK_LIMIT` passé de 2 à 3 jours, et les événements Jour 5 / Jour 9 inversés en bonus (voir "Événements programmés" ci-dessous). Avec ces trois changements, la re-simulation retombe autour de **75 % (V=8) → 61-63 % (V=10-12) → 53 % (V=14) → 35-45 % (V=16-20)** — cohérent avec la cible 50-70 % pour un groupe d'une douzaine de votants, avec la même décroissance progressive selon la taille du groupe que le design d'origine prévoyait déjà.

### Chef Explorateur du jour

Mécanique ajoutée le 24/08 pour favoriser l'implication et la régularité des votants, indépendante des 8 événements programmés ci-dessous (elle peut se cumuler avec n'importe lequel d'entre eux). À l'ouverture de chaque jour à partir du **Jour 2**, `pickChefExplorateur()` tire au sort un `discordId` parmi les **votants réels de la veille** (`closure.voters`, jamais un non-votant — récompense la régularité, pas le hasard pur) et le stocke dans `robinson:state.chefExplorateurId`. Annoncé dès la publication du jour dans l'embed public (`👑 Chef explorateur du jour : @Untel`), pas seulement révélé après coup. Aucun tirage ni annonce si personne n'a voté la veille (`pickChefExplorateur([])` → `null`).

Si le Chef vote une action de récolte directe (Pêcher/Eau/Bois) aujourd'hui, son tirage est **garanti non-nul** : `rollHarvestAmountGuaranteed()` relance jusqu'à un résultat ≥ 1 (Uniforme{1..5}, moyenne 3 au lieu de 2,5) — ou, un jour à plafond (Canicule/Ouragan), le tirage devient simplement 1 fixe au lieu du 0/1 habituel. Le bonus ne s'applique **ni à Explorer** (qui ne tombe déjà jamais à 0) **ni au Radeau** (qui ne "trouve" pas de ressource par nature) : un Chef qui vote Radeau perd simplement le bénéfice de son tirage garanti, décision assumée (voir le message de confirmation éphémère, préfixé `👑 Chef explorateur du jour :` uniquement sur les actions concernées).

D'après simulation (stratégie de vote dynamique réactive au stock, même méthodologie que ci-dessus) : **+4 à +7 points de survie passive**, l'effet étant mécaniquement plus fort pour un petit groupe (+6-7 pts à V=8-12, un seul vote garanti pèse plus sur un total V plus petit) que pour un gros (+3-4 pts à V=16-20) — une propriété auto-équilibrante plutôt qu'un réglage explicite.

### Événements programmés (Robinson)

8 événements tirés de `robinson.json.evenements` (`eventForDay(jour, evenements, previousDayVoters)`) modifient le jour concerné. `previousDayVoters` (le `V` du jour qui vient de se clôturer) sert de **condition d'activation** (`condition_votants_veille` = seuil minimum, `condition_votants_veille_max` = seuil maximum — Colis Royal se déclenche _au-dessus_, Poissons Pourris se déclenche _en-dessous_) et de **paramètre de montant** (événements dégressifs) :

- **Poissons Pourris !** (Jour 2, **conditionnel**) : ne se déclenche **que si** le Jour 1 a réuni **moins de** `condition_votants_veille_max` (**14**, initialement 10 — relevé le 24/08) votants — sinon le Jour 2 reste normal. Une partie du stock de Poisson est perdue (`spoilPoisson()`, `DECRBY` plancher 0), montant calculé par `computePoissonsPourrisLoss(V, threshold)` = `max(1, min(threshold − V, 4 + V))`, où `threshold` **doit** être `event.condition_votants_veille_max` (jamais une valeur codée en dur — voir l'incident ci-dessous). La courbe grimpe à mesure que la mobilisation baisse, jusqu'à un pic à mi-parcours du seuil (`(threshold−4)/2`), puis **redescend** pour les groupes minuscules (V=2, V=1) — un groupe de 1-2 votants a de toute façon un stock trop faible pour justifier une perte aussi lourde que celle d'un groupe intermédiaire. Le `Math.max(1, …)` assure un atterrissage en douceur (perte plancher −1) juste avant que l'événement ne se désactive, quel que soit `threshold`. Avec la config actuelle (seuil 14) : pic à V=5 (−9), V=9 → −5, V=13 → −1 (juste avant l'exemption à 14). ⚠️ Le 24/08, le seuil a été relevé de 10 à 14 sans recaler cette formule (restée à `threshold` codé en dur à `10`) : l'atterrissage en douceur se produisait alors toujours autour de V=9 (perte −1) au lieu de V=13, un groupe de 9-13 votants s'en tirait donc avec un simple −1 alors qu'il aurait dû subir une perte proche du pic — corrigé le jour même en passant `threshold` en paramètre plutôt qu'en dur.
- **Grosse Canicule** (Jour 3) : Collecter de l'eau utilise un tirage dédié 0/1 (50/50, `rollCappedEventAmount()`) au lieu du tirage normal.
- **Colis Royal** (Jour 4, **conditionnel**) : ne se déclenche **que si** le Jour 3 a réuni au moins `condition_votants_veille` (12) votants — sinon le Jour 4 reste un jour normal, sans rien afficher de spécial. S'il se déclenche, offre `bonus_ressources` (2) unités de **chacune** des 3 ressources d'un coup (`grantEqualResources()`, `INCRBY` atomique sur les 3 clés de stock), récompense pour une mobilisation collective forte. Le seuil binaire crée mécaniquement un effet de seuil (un groupe de 11 votants n'en profite jamais, un groupe de 12 en profite systématiquement) : `bonus_ressources` a été volontairement réduit de 3 à 2 par simulation pour atténuer cet écart sans le supprimer.
- **Une incroyable découverte !** (Jour 5, **toujours déclenché**) : à l'origine un pur gag narratif sans aucun effet mécanique ("en fait c'est juste un bout de bois tordu"). Inversé le 24/08 en petit bonus inconditionnel, `bonus_ressources` (3) unités de chacune des 3 ressources (`grantEqualResources()`, même mécanique que Colis Royal) — un des deux leviers utilisés pour remonter le taux de survie sans toucher au barème de tirage ni aux stocks initiaux.
- **Ouragan Monstrueux** (Jour 6) : Pêcher et Récolter du bois utilisent le même tirage dédié 0/1.
- **Épave échouée** (Jour 7, **toujours déclenché**) : offre des points de Radeau **directs** (jamais de bois brut — convertir du bois en points coûte encore un vote, donc un don de bois seul n'aide pas le goulot d'étranglement réel, qui est le nombre de votes disponibles, pas la ressource). Montant dégressif selon `previousDayVoters` : `max(points_min, points_base − V)` (`computeEpaveBonus()`), soit 26−V plafonné à 10 minimum — un petit groupe (V=6) reçoit +20 points, un grand groupe (V=15) seulement +11, pour compenser le fait qu'un petit groupe a structurellement moins de votes/jour à consacrer au Radeau.
- **Invasion de Gobelins** (Jour 8) : le bouton Explorer est retiré des composants ce jour-là (`isExplorerDisabled()`). À la clôture, **après** la consommation automatique, si le stock de Bois restant est `< 5`, les Gobelins volent 5 Poissons (plancher 0).
- **Indigestion Royale** (Jour 9, **toujours déclenché**) : à l'origine un plafond pénalisant sur la collecte d'Eau (tirage dédié 0/1, jamais le Bois). Inversé le 24/08 en petit bonus, `bonus_eau` (2) unités offertes d'office (`grantResource("eau", ...)`, `INCRBY` sur la seule clé Eau) — l'eau n'est plus plafonnée ce jour-là, elle reçoit un don en plus du tirage normal. Second levier de la remontée du taux de survie, placé volontairement tard dans la partie : sans effet sur le taux de victoire par Radeau (les parties orientées Radeau sont presque toujours déjà tranchées avant le Jour 9).

Les dons/pertes de Poissons Pourris, Colis Royal, Une incroyable découverte, Épave et Indigestion Royale sont appliqués **une seule fois**, au moment de la publication du jour concerné (jamais liés à un vote, jamais répétés sur un reclic) — voir `postRobinson()` dans `api/discord/_handlers/robinson.js`.

⚠️ Ces 8 événements ne sont **jamais** listés dans l'embed `[📖 Règles du jeu]` (`buildReglesEmbed()`) — volontairement, pour qu'ils restent une surprise en cours de partie. Seul le barème des actions et la condition de défaite y figurent.

### Victoire anticipée (Radeau)

Construire le Radeau coûte `bois_par_point_radeau` (**1**, initialement 2) Bois pour `+1` point de construction ; `points_par_section` (**4**, initialement 5) points forment 1 section, `radeau_sections_max` (5) sections achèvent le Radeau (**20** points au total, initialement 25). La victoire par le Radeau n'est **jamais annoncée en temps réel** au clic qui complète la 5ᵉ section (cohérent avec « aucune publication en dehors du cron » déjà appliqué au Tamagoshi) : elle est détectée et révélée au cron suivant, qui court-circuite alors entièrement la consommation et la vérification de défaite de ce jour-là — y compris si c'est un don d'Épave qui vient de faire franchir le seuil.

⚠️ **Verrou anti-rush narré : "Grosse Houle"** (26/08, `data/robinson/robinson.json.radeau_verrouille`) : le bouton `[🛶 Radeau]` est masqué des composants (`buildRobinsonComponents()`, `isRadeauDisabled(jour, config.radeau_verrouille)`) pour les Jours **4 et 5** (`jour_debut`/`jour_fin`, lus depuis la config — jamais un seuil codé en dur dans le JS, pour rester ajustable sans redéploiement). Motivation : avec le barème 0-5, un groupe actif accumule vite assez de Bois pour financer les 20 points en une seule journée si tout le monde vote Radeau au même moment (`bois_par_point_radeau: 1`, aucun autre frein) — un "rush" total pouvait donc clore la partie dès le Jour 4-5, avant même la moitié de l'aventure. Contrairement à un simple verrou technique, cette version est **narrée** : une houle annonciatrice de l'Ouragan du Jour 6 (cohérence volontaire avec le calendrier des événements) explique aux joueurs pourquoi le bouton a disparu, avec un texte dédié affiché dans l'embed du jour (`buildRobinsonEmbed()`) — contrairement aux 8 événements de `evenements`, ce verrou peut **coexister** le même jour avec l'événement normal (le Colis Royal et la Grosse Houle tombent tous les deux au Jour 4). Message dédié aussi côté clic (`handleVoteButton()`, filet de sécurité si un joueur clique sur un message affiché avant la clôture du jour). Comme les 8 événements programmés, ce verrou n'est jamais annoncé à l'avance dans l'embed Règles — volontairement, pour garder la surprise. `radeauVerrouille` peut être `null`/absent pour désactiver le verrou entièrement sans toucher au JS. Les points déjà engrangés avant l'introduction de ce verrou ne sont jamais retirés rétroactivement — seuls les **nouveaux** votes sont bloqués pendant la fenêtre.

D'après une simulation antérieure au 24/08 (stratégie : survie pure jusqu'au Jour 7, puis ~30 % des votes redirigés vers le Radeau après l'Épave), la victoire par Radeau atteignait **93 %** pour un petit groupe (V=6) et restait dans une fourchette **59-78 %** pour les groupes de 10 à 20 votants — cohérent avec la cible ~75 %. Cette statistique Radeau n'a pas été revalidée depuis les trois ajustements du 24/08 (`ZERO_STREAK_LIMIT` à 3, Jour 5/Jour 9 inversés en bonus — voir "Tirages et équilibrage" ci-dessus) : ces changements ne peuvent que faciliter la construction du Radeau (plus de ressources disponibles, défaite moins punitive), donc 93 %/59-78 % restent un plancher plausible plutôt qu'une valeur exacte à jour. La survie passive (Jour 11, sans stratégie Radeau) est traitée en détail dans "Tirages et équilibrage" ci-dessus.

### Manches (comparaison entre parties) — Robinson

Robinson (comme le Tamagoshi et Boss Raid) est destiné à être rejoué plusieurs fois dans l'année — chaque partie complète est une **manche**. `robinson:manches` (HASH permanent, jamais nettoyé par `resetRobinson()`) archive le bilan de chaque manche terminée, indexé par un numéro strictement croissant (`robinson:manche_seq`, `INCR` atomique) : `archiveManche({ outcome, jour, radeauPoints, resolvedAt })`.

Robinson n'a pas de score numérique naturel (c'est une survie, pas un score attack) : `computeMancheScore(outcome, jour, dureeJours)` encode donc une hiérarchie explicite pour classer les manches entre elles — toute victoire bat toute défaite ; entre victoires Radeau, plus tôt = meilleur (`1000 + (dureeJours + 1 − jour)`, l'évasion rapide est valorisée) ; les victoires Jour 11 sont toutes à égalité (`500` flat, aucune notion de vitesse) ; entre défaites, plus de jours survécus = meilleur (`jour` brut). À l'écran de fin, l'embed liste les 10 dernières manches (`listManches()`) avec un 🏆 sur la meilleure selon ce score — la manche qui vient de se terminer y apparaît elle-même, marquée _(cette manche)_.

⚠️ L'archivage n'a lieu que pour une **vraie publication sur le salon public** (`postRobinson(channelId, { isPublic: true })`, déclenché uniquement par `npm run robinson:public`/le workflow GitHub) — jamais en dry-run, ni sur le salon de test (`npm run robinson:test`), même si la partie de test va jusqu'au bout. Convention volontaire : les scripts npm servent toujours à tester, seul `--public` (donc en pratique le workflow GitHub, cron ou `workflow_dispatch`) représente une manche réelle. Ça évite de polluer l'archive avec des parties de test sans avoir à y penser à chaque reset — `npm run robinson:reset:manches` (`--manches`) reste disponible comme filet de sécurité manuel (ex. `--public` lancé par erreur), mais ne devrait normalement jamais être nécessaire.

### Données (robinson.json)

- `data/robinson/robinson.json` — config statique éditée à la main : durée, coûts du Radeau, stocks initiaux, et `evenements` (3 événements, chacun portant son propre champ `jour` — contrairement à `tamagotchi.json` qui indexe ses événements positionnellement). Chargée une fois et mise en cache (`loadRobinsonConfig()`), jamais mutée à l'exécution.
- `frontend/public/images/robinson/rob-01.webp` à `rob-10.webp` — une illustration par jour, servie en asset statique (même principe que `tama-01.webp`…`tama-10.webp` du Tamagoshi) et référencée directement par URL (`robinsonImageUrl()`, `api/discord/_handlers/robinson.js`) dans le champ `image` de l'embed. L'embed de fin de partie (victoire Radeau, victoire Jour 11, défaite) réutilise systématiquement l'illustration du dernier jour (`rob-10.webp`).

### Stockage — Upstash Redis (`robinson:*`)

Même instance et mêmes conventions que les autres jeux (`automaticDeserialization: false`, sérialisation JSON manuelle). Espace de clés `robinson:*`, totalement séparé.

| Clé Redis                                   | Type              | Contenu                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robinson:state`                            | STRING            | `{ jour, channelId, messageId, publishedAt, termine, event, chefExplorateurId, zeroStreaks }` — jour actuellement affiché, muté uniquement au cron                                                                                                                                                                                                      |
| `robinson:stock:poisson` / `:eau` / `:bois` | STRING (compteur) | Stocks courants — mutés en continu via `INCRBY`/`DECRBY`, jamais un `GET` puis recalcul                                                                                                                                                                                                                                                                 |
| `robinson:radeau_points`                    | STRING (compteur) | Points de construction cumulés du Radeau                                                                                                                                                                                                                                                                                                                |
| `robinson:votes:<jour>`                     | HASH              | `discordId → actionId` — jetable, effacé après clôture du jour                                                                                                                                                                                                                                                                                          |
| `robinson:vote_details:<jour>`              | HASH              | `discordId → { actionId, amount\|yields\|pointsAdded, at }` — résultat exact du tirage, pour réafficher le même résultat sur un reclic idempotent sans re-tirer                                                                                                                                                                                         |
| `robinson:vote_usernames:<jour>`            | HASH              | `discordId → pseudo` — jetable, uniquement pour l'affichage admin (`npm run robinson:status`), jamais utilisé pour la logique de vote                                                                                                                                                                                                                   |
| `robinson:historique`                       | HASH              | `jour → { V, radeauVotes, stocksAvant, stocksApres, consumption, gobelinsVoleur, event, outcome, resolvedAt }` — bilans quotidiens de la manche EN COURS, alimente le bouton Journal de Bord, effacé par `resetRobinson()`. `radeauVotes` (ajouté le 25/08) absent sur les entrées antérieures, affiché de façon tolérante par `formatHistoriqueLine()` |
| `robinson:manches`                          | HASH              | `manche → { manche, outcome, jour, radeauPoints, resolvedAt }` — un bilan par manche TERMINÉE, jamais nettoyé (persiste entre les manches, y compris après `npm run robinson:reset`)                                                                                                                                                                    |
| `robinson:manche_seq`                       | STRING (compteur) | Numéro de la prochaine manche à archiver, incrémenté (`INCR`) à chaque fin de partie réelle (jamais en dry-run)                                                                                                                                                                                                                                         |

Le bouton `[📜 Journal de Bord]` (`handleJournal()`) affiche aussi, depuis le 26/08, le total de points de Radeau (`robinson:radeau_points`, invisible autrement dans le Journal) et les compteurs de jours consécutifs à 0 par ressource (`state.zeroStreaks`, jamais montrés ailleurs) — uniquement si au moins une ressource est déjà en streak, pour ne pas polluer l'affichage en temps normal.

### Scripts npm (Robinson)

| Commande                         | Effet                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run robinson:test`          | Poste manuellement le jour de Robinson sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`).                                                                                                                                                                            |
| `npm run robinson:test:dry`      | Aperçu console du prochain jour (ou du message de fin de partie), sans écrire d'état ni poster sur Discord.                                                                                                                                                            |
| `npm run robinson:public`        | Poste sur le salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) — utilisé par le cron `robinson.yml`.                                                                                                                                                                       |
| `npm run robinson:public:dry`    | Équivalent dry-run de `robinson:public`.                                                                                                                                                                                                                               |
| `npm run robinson:reset`         | Remet Robinson à zéro : plus de jour actif, stocks/votes/historique de la manche en cours effacés. **Destructif** — préserve toujours `robinson:manches` (l'archive des manches passées, qui ne s'alimente de toute façon qu'en `--public`, voir "Manches" plus haut). |
| `npm run robinson:reset:manches` | Identique, mais efface aussi `robinson:manches`/`robinson:manche_seq`. **Destructif**, à réserver au filet de sécurité (ex. un `--public` lancé par erreur pendant les tests).                                                                                         |
| `npm run robinson:status`        | Affiche l'état courant (stocks, radeau, décompte des votes du jour) sans passer par Discord.                                                                                                                                                                           |

### Variables d'environnement requises (Robinson)

Aucune nouvelle variable : Robinson réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (même instance Upstash Redis, espace de clés `robinson:*` totalement séparé). Le workflow `.github/workflows/robinson.yml` réutilise les mêmes secrets GitHub Actions que les autres jeux (déjà configurés, rien à ajouter). Comme pour le Tamagoshi, le `schedule` du cron reste **commenté** (seul `workflow_dispatch` actif) tant que le jeu est en phase de test — à réactiver une fois validé.

---

## Boss Raid (score attack communautaire)

Mini-jeu communautaire quotidien indépendant du Clash Royale : le clan affronte un Boss Colossal invulnérable pendant 7 jours de combat (`duree_jours` dans `boss_raid.json`, précédés d'un jour d'annonce), avec pour objectif d'accumuler le maximum de dégâts cumulés. Chaque membre vote un rôle par jour (Chevalier, Voleuse, Sorcier, Archères, Espion) ; contrairement à Robinson, **aucun tirage n'a lieu au clic** — le vote reste modifiable jusqu'au cron de 08:00 UTC. Pas de commande slash associée — la publication/suppression passe uniquement par `scripts/postBossRaid.js` (manuel ou cron), les boutons restent gérés par `api/discord/interactions.js`.

### Déroulement (Boss Raid)

Un seul message actif à la fois dans le salon dédié, en 3 phases :

1. **Jour d'annonce** (`bossraid:state.phase === "annonce"`) : premier `postBossRaid()`, publie le lore + la posture initiale du Boss, ping `@MINI-JEUX`. Seul le bouton `[📖 Règles & Rôles]` est visible — aucun vote possible.
2. **Transition vers le Jour 1/7** : deuxième `postBossRaid()`, détecte `phase === "annonce"` et publie directement le Jour 1 avec les 5 boutons de vote, sans clôture (rien n'a pu être voté avant) ni ping.
3. **Clôture quotidienne** (jours suivants) : `postBossRaid()` clôture le jour actif (`closeDayAndAdvance()`), calcule les dégâts et la nouvelle posture du Boss, publie le bilan + le jour suivant (jamais de ping). Au-delà du Jour 7 (`jourSuivant > duree_jours`), publie l'embed de fin de Raid (score total, aucun composant), ping `@MINI-JEUX`, et passe `termine: true` — les runs suivants du cron deviennent des no-op silencieux, même principe que les autres jeux.

### Résolution du vote — vote modifiable, calcul unique à la clôture

Le vote est **modifiable jusqu'au cron** : `recordVote()` fait un simple `HSET` écrasable sur `bossraid:votes:<jour>`, **pas** de `HSETNX` ni de logique de réservation/libération de slot comme Robinson — aucune action de vote ne peut « échouer ». Conséquence directe : **aucun tirage aléatoire n'a lieu au clic**, toute la logique de dégâts/protection/All-In/événements est calculée **une seule fois à la clôture**, dans la fonction pure `computeCloture()` (`backend/services/bossraid.js`).

Le clic sur un bouton de vote (sauf Espion) répond en `type: 6` (`DEFERRED_UPDATE_MESSAGE`) et édite le message public **en place**, jamais d'éphémère. Le bouton **Espion** est la seule exception : il répond en éphémère (`type: 5`) avec une **projection live** des dégâts du jour en cours, calculée par `previewCloture()` (écriture Redis nulle) — la même fonction qu'appelle `postBossRaid.js --dry-run`, garantissant que la projection Espion et la simulation dry-run ne divergent jamais. Le vote Espion compte quand même dans le dénominateur All-In (`recordVote(jour, discordId, "espion", ...)`), et son compteur public est rafraîchi séparément par un `PATCH` direct (token du bot), même découplage que Tamagotchi/Robinson pour un vote confirmé en éphémère.

⚠️ **Contraste volontaire avec Robinson** : la posture du Boss (Défense/Résistance) et le score cumulé vivent dans le même blob JSON `bossraid:state` que le Tamagoshi (`GET`/`SET` simple), **pas** dans des clés atomiques `INCRBY`/`DECRBY` séparées comme les stocks de Robinson. Ce n'est pas un oubli : rien n'est jamais écrit avant la clôture, donc il n'y a aucune écriture concurrente à sécuriser (contrairement à Robinson, où les récoltes sont appliquées en direct par des clics potentiellement simultanés).

### Contrainte Chevalier — pas 2 jours de suite

`bossraid:dernier_role` (HASH `discordId → roleId`) retient le dernier rôle **finalisé** de chaque membre, muté **uniquement au cron** (jamais pendant la fenêtre de vote). Au clic sur `[🛡️ Chevalier]`, `isChevalierVoteAllowed(dernierRole)` compare au rôle du jour **précédemment clos** — pas au choix courant du même jour, donc un membre peut changer d'avis plusieurs fois le même jour sans pénalité, seule la limite inter-jours compte. En cas de refus, l'ack `type: 6` reste sans PATCH (message public inchangé) et un message de suivi **éphémère séparé** (`postFollowup()`, `POST {webhookUrl}` + `flags: 64`) explique le refus à l'auteur du clic — le vote n'est jamais enregistré.

### Protection Chevalier — ordre en cas de pénurie de slots

Chaque Chevalier protège jusqu'à 2 unités à distance (Sorcier/Archères) : `capacite = nbChevaliers × 2`. Si le nombre de distants dépasse la capacité, les slots vont aux votants dont le vote a été fixé/mis à jour le **plus tôt** ce jour-là (`computeProtection()`, tri par `bossraid:vote_at:<jour>` croissant) — approximation la plus fidèle d'un « ordre d'arrivée » alors que les votes sont modifiables jusqu'au cron. Non protégé : malus **-50%** sur les dégâts (**-100%** si l'événement Frappe Léthale est actif ce jour-là) ; protégé : jamais de malus, quel que soit l'événement.

### Mécanique All-In (Ultimes d'équipe)

À la clôture, si un rôle d'attaque (Archères/Sorcier/Voleuse) réunit **strictement plus de 50%** de l'ensemble des votes du jour — les 5 rôles votables inclus, Chevalier et Espion comptent dans le dénominateur (`detectAllIn()`) — toute l'équipe déclenche son Ultime pour la journée :

- **🏹 Volée Céleste** (Archères) : ignore la Défense du Boss **et** la protection Chevalier — 100% de dégâts pour **tous** les votants Archères, protégés ou non. L'emporte même sur Bouclier d'Acier le même jour (testé en priorité dans `computeArcheresDamage()`).
- **🔮 Surcharge Arcane** (Sorcier) : double (`×2`) les dégâts magiques de tous les votants Sorcier, appliqué après les autres réductions. Composé avec Miroir de Mana (`×0,5`) le même jour → net `×1`, simple multiplication, aucun cas spécial codé.
- **🗡️ Coup à la Gorge** (Voleuse) : la Défense **et** la Résistance du Boss tombent à **0/10** pour le lendemain, **inconditionnellement** (`computeBossStatsNextDay()`) — écrase les debuffs individuels tirés par les votes Voleuse du même jour, qui restent visibles dans l'historique mais n'influencent jamais le résultat.

### Régénération nocturne de Kiki

Sans ce mécanisme, Défense et Résistance ne pourraient que stagner ou diminuer sur 10 jours (aucune autre source de hausse dans le jeu). À chaque clôture, `rollRegenAmount()` tire indépendamment **+0 ou +1** (30% de chances de +1) pour la Défense et pour la Résistance, appliqué **après** les debuffs Voleuse et **plafonné à 10** (`computeBossStatsNextDay()`) — un tirage systématique, y compris les jours sans aucun vote Voleuse. Documenté explicitement dans l'embed [📖 Règles & Rôles] (mécanique de base, pas une surprise) et rappelé dans le bilan de chaque jour (`🔄 Kiki récupère pendant la nuit : +X Défense, +Y Résistance` — ou une phrase dédiée si les deux tirages échouent, ~49% des jours, plutôt qu'un `+0 / +0` sans intérêt).

⚠️ Ce barème (30%, moyenne 0,3/stat/jour — initialement +1/+2, moyenne 1,5) est le résultat d'un équilibrage par **simulation Monte Carlo**, suite à un test manuel révélant Défense/Résistance à 9/10 dès le Jour 4 avec un seul votant. Le barème initial écrasait totalement la pression des debuffs Voleuse (25% de chance par vote Voleuse, -1 sur une seule stat) : même avec 16 votants et 20% d'entre eux votant Voleuse chaque jour, la régénération attendue (~1,5/stat/jour) restait très supérieure au debuff attendu (~0,4/stat/jour) — Défense/Résistance grimpaient à ~9/10 dès le Jour 4-5, **quel que soit** le nombre de votants (8, 12 ou 16 testés). Le barème à 30% cible une moyenne proche de **5/10** sur les 10 jours pour des groupes de 8 à 16 votants avec une répartition de vote réaliste (ni 100% Voleuse, ni 0%) ; le cas extrême "aucun vote Voleuse" reste élevé (~6,5/10 en moyenne) par construction — sans aucune pression, le Boss doit rester costaud.

Seule exception : lors d'un **Coup à la Gorge** (All-In Voleuse), la régénération est **tirée mais ignorée** ce jour-là — `computeBossStatsNextDay()` retourne `{0, 0}` inconditionnellement avant même de considérer `regen` (le tirage a quand même lieu, pour une consommation de `rng` prévisible dans `computeCloture()`, sans branche conditionnelle sur le nombre d'appels). La régénération reprend normalement dès le lendemain, à partir de 0/10.

### Événements du Boss

3 événements fixes tirés de `boss_raid.json.evenements_boss` (`activeEventForDay(jour, evenements)`, lookup exact — pas de condition comme Robinson, un jour donne toujours le même événement) :

- **⚡ Frappe Léthale** (Jour 3) : le malus de non-protection passe de -50% à **-100%** (0 dégât) pour Sorcier/Archères non protégés.
- **🧱 Bouclier d'Acier** (Jour 6) : Défense effective = **10/10** pour le calcul des dégâts de ce jour **seulement** — ne modifie jamais la valeur persistée dans `bossraid:state.bossStats`, la progression naturelle (debuffs Voleuse) reprend normalement le lendemain.
- **🪞 Miroir de Mana** (Jour 9) : réduction **supplémentaire** de 50% sur les dégâts de tous les votants Sorcier ce jour-là (s'additionne multiplicativement aux autres réductions).

⚠️ Ces 3 événements ne sont **jamais** listés dans l'embed `[📖 Règles & Rôles]` — volontairement, pour qu'ils restent une surprise. Seul le bouton **Espion** révèle en exclusivité, en éphémère, l'événement prévu pour le **lendemain** (`activeEventForDay(jour + 1, ...)`), jamais celui du jour même.

### Interface (embed)

Titre `⚔️ Boss Raid — Jour X/7` (ou `— Un Boss Colossal approche…` au jour d'annonce). Bilan de la veille (dégâts infligés, Ultime déclenchée le cas échéant) affiché uniquement après une clôture réelle — absent du premier post de combat (Jour 1). Barres `🟥`/`⬜` sur 10 segments pour la Défense et la Résistance courantes. Événement du jour révélé dans cet embed seulement à partir du jour concerné. Composants : row 1 = 5 boutons de vote (`{emoji} {label} (n)`, un seul par rôle, masquée hors phase combat) ; row 2 = `[📖 Règles & Rôles]` + `[📜 Journal]`.

### Manches (comparaison entre parties) — Boss Raid

Boss Raid (comme Robinson et le Tamagoshi) est destiné à être rejoué plusieurs fois dans l'année — chaque Raid complet est une **manche**. `bossraid:manches` (HASH permanent, jamais nettoyé par `resetBossRaid()`) archive le bilan de chaque manche terminée, indexé par un numéro strictement croissant (`bossraid:manche_seq`, `INCR` atomique) : `archiveManche({ totalDegatsCumules, bossStatsFinal, resolvedAt })`. Score comparatif naturel (contrairement à Robinson) : le total de dégâts cumulés, plus haut = meilleur. À l'écran de fin, l'embed liste les 10 dernières manches (`listManches()`) avec un 🏆 sur le meilleur total toutes manches confondues — la manche qui vient de se terminer y apparaît elle-même, marquée _(cette manche)_.

⚠️ L'archivage n'a lieu que pour une **vraie publication sur le salon public** (`postBossRaid(channelId, { isPublic: true })`, déclenché uniquement par `npm run bossraid:public`/le workflow GitHub) — jamais en dry-run, ni sur le salon de test (`npm run bossraid:test`), même si le Raid de test va jusqu'au bout. Convention volontaire : les scripts npm servent toujours à tester, seul `--public` (donc en pratique le workflow GitHub, cron ou `workflow_dispatch`) représente une manche réelle. Ça évite de polluer l'archive avec des parties de test sans avoir à y penser à chaque reset — `npm run bossraid:reset:manches` (`--manches`) reste disponible comme filet de sécurité manuel (ex. `--public` lancé par erreur), mais ne devrait normalement jamais être nécessaire.

### Données (boss_raid.json)

`data/bossraid/boss_raid.json` — config statique éditée à la main : `duree_jours`, `boss_stats_initiales`, `roles.<id>` (label, emoji, plage de dégâts, `protection_slots`/`chance_debuff`/`reduction_stat`/`is_info_action` selon le rôle) et `evenements_boss` (3 événements fixes, un par `jour`). Chargée une fois et mise en cache (`loadBossRaidConfig()`), jamais mutée à l'exécution.

`frontend/public/images/boss/boss-01.webp` à `boss-10.webp` — une illustration par jour de combat, servie en asset statique (même principe que `rob-01.webp`…`rob-10.webp` de Robinson) et référencée directement par URL (`bossRaidImageUrl()`, `api/discord/_handlers/bossraid.js`) dans le champ `image` de l'embed. Affichée uniquement à partir du Jour 1 (jamais au jour d'annonce, qui n'a pas d'illustration dédiée). Avec `duree_jours: 7`, seules `boss-01.webp` à `boss-07.webp` sont actuellement utilisées (`boss-08/09/10.webp` restent en réserve, inutilisées) ; l'embed de fin de Raid réutilise systématiquement l'illustration du dernier jour joué (`bossRaidImageUrl(config.duree_jours)`).

`data/bossraid/narratifs.json` — pools de variantes de texte (une intro "lore inutile" façon ambiance de camp, 2 variantes par état notable de Défense/Résistance, et des phrases de clôture citant les combattants les plus offensifs de la veille) séparées du code pour être enrichies sans y toucher. Même principe que `data/robinson/narratifs.json`/`data/tamagotchi/narratifs.json`, y compris la règle **"normal" = aucune ligne** : un état ordinaire (Défense/Résistance 4-6/10) n'a volontairement aucun pool de texte associé, la ligne est simplement omise plutôt que de meubler avec une phrase creuse — seuls les états notables (`_bas` ≤3, `_haut` ≥7) ont du texte. Sélection déterministe par jour (`pickFlavor()`, indexé sur `jour`, jamais `Math.random()`).

### Stockage — Upstash Redis (`bossraid:*`)

Même instance et mêmes conventions que les autres jeux. Espace de clés `bossraid:*`, totalement séparé.

| Clé Redis                        | Type              | Contenu                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bossraid:state`                 | STRING            | `{ phase, jour, channelId, messageId, publishedAt, termine, bossStats: {defense, resistance}, totalDegatsCumules }` — muté uniquement au cron                                                                                                                             |
| `bossraid:dernier_role`          | HASH              | `discordId → roleId` — dernier rôle finalisé, muté uniquement au cron                                                                                                                                                                                                     |
| `bossraid:votes:<jour>`          | HASH              | `discordId → roleId` — écrasable, jetable, effacé après clôture du jour                                                                                                                                                                                                   |
| `bossraid:vote_at:<jour>`        | HASH              | `discordId → ISO timestamp` — horodatage de la dernière mise à jour du vote, sert à l'ordre de protection Chevalier                                                                                                                                                       |
| `bossraid:vote_usernames:<jour>` | HASH              | `discordId → pseudo` — jetable, uniquement pour l'affichage admin (`npm run bossraid:status`)                                                                                                                                                                             |
| `bossraid:historique`            | HASH              | `jour → { voteCounts, totalVotes, protection, allIn, event, totalDamageDuJour, totalDegatsApres, bossStatsAvant, bossStatsApres, voleuseDebuffs, regen, resolvedAt }` — bilans quotidiens de la manche EN COURS, alimente le bouton Journal, effacé par `resetBossRaid()` |
| `bossraid:manches`               | HASH              | `manche → { manche, totalDegatsCumules, bossStatsFinal, resolvedAt }` — un bilan par manche TERMINÉE, jamais nettoyé (persiste entre les manches, y compris après `npm run bossraid:reset`)                                                                               |
| `bossraid:manche_seq`            | STRING (compteur) | Numéro de la prochaine manche à archiver, incrémenté (`INCR`) à chaque fin de Raid réel (jamais en dry-run)                                                                                                                                                               |

### Scripts npm (Boss Raid)

| Commande                         | Effet                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run bossraid:test`          | Poste manuellement le jour de Boss Raid sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`).                                                                                                                                                                                     |
| `npm run bossraid:test:dry`      | Aperçu console du prochain jour (ou du message de fin de Raid), sans écrire d'état ni poster sur Discord.                                                                                                                                                                        |
| `npm run bossraid:public`        | Poste sur le salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) — utilisé par le cron `bossraid.yml`.                                                                                                                                                                                 |
| `npm run bossraid:public:dry`    | Équivalent dry-run de `bossraid:public`.                                                                                                                                                                                                                                         |
| `npm run bossraid:reset`         | Remet Boss Raid à zéro : plus de partie active, votes/dernier rôle/historique de la manche en cours effacés. **Destructif** — préserve toujours `bossraid:manches` (l'archive des manches passées, qui ne s'alimente de toute façon qu'en `--public`, voir "Manches" plus haut). |
| `npm run bossraid:reset:manches` | Identique, mais efface aussi `bossraid:manches`/`bossraid:manche_seq`. **Destructif**, à réserver au filet de sécurité (ex. un `--public` lancé par erreur pendant les tests).                                                                                                   |
| `npm run bossraid:status`        | Affiche l'état courant (posture du Boss, score cumulé, décompte des votes du jour) sans passer par Discord.                                                                                                                                                                      |

### Variables d'environnement requises (Boss Raid)

Aucune nouvelle variable : Boss Raid réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (même instance Upstash Redis, espace de clés `bossraid:*` totalement séparé). Le workflow `.github/workflows/bossraid.yml` réutilise les mêmes secrets GitHub Actions que les autres jeux (déjà configurés, rien à ajouter). Comme pour les autres jeux en phase de test, le `schedule` du cron reste **commenté** (seul `workflow_dispatch` actif) — à réactiver une fois le jeu validé.

---

## Jeu Goblin Hunters (identité secrète, camps cachés)

Mini-jeu à identité secrète façon Shadow Hunters/Loups-Garous, adapté au rythme asynchrone quotidien du bot : deux camps s'affrontent en secret, les **Villageois** (majorité) et les **Gobelins infiltrés** (minorité, ratio ~2/5 arrondi selon l'effectif — voir "Rééquilibrage" plus bas), sur une partie de **7 jours maximum**. Modèle de référence = **Boss Raid**, pas Robinson : rien n'est appliqué en direct pendant la journée (positions/PV/votes/actions) — tout se résout **une seule fois à la clôture**, dans la fonction pure `computeCloture()` (`backend/services/goblinhunters.js`). Pas de commande slash associée — la publication/clôture passe uniquement par `scripts/postGoblinHunters.js` (manuel ou cron), les boutons et le select menu restent gérés par `api/discord/interactions.js`.

### Déroulement (Goblin Hunters)

Un seul message actif à la fois dans le salon dédié, en 3 phases :

1. **Fenêtre d'inscription** (`goblinhunters:state.phase === "inscription"`) : `postGoblinHunters()` ouvre l'inscription (`[✅ S'inscrire]`/`[✖️ Se désinscrire]`), ping `@MINI-JEUX`. Rappel quotidien avec le décompte des inscrits tant que la fenêtre (3 jours) n'est pas close. À la clôture : si moins de `effectif_min` (8) inscrits, la fenêtre est **prolongée de 3 jours** (pas d'annulation) ; sinon la partie est lancée (`launchGame()`) — roster figé, camps/rôles attribués, DM de rôle envoyé à chacun, inscriptions vidées.
2. **Jour de jeu** (jours 1 à 10) : chaque joueur vivant choisit un lieu (bouton éphémère), qui détermine son action — vote au Château, combat à l'Arène, enquête à la Tour de Guet, protection à la Taverne, révélation de position à la Clairière. **Définitif dès validation** (`isActionLocked()`, aucun changement d'avis possible sur aucun lieu — voir plus bas), enregistré via `recordAction()` en `HSET` (écrasable seulement tant qu'aucune valeur n'a encore été écrite pour ce slot). Rien n'est publié publiquement en cours de journée.
3. **Clôture quotidienne** : `postGoblinHunters()` clôture le jour actif (`closeDayAndAdvance()`), résout vote + combat + enquêtes + nouvelles positions, envoie les DM d'enquête, publie le bilan + le jour suivant (jamais de ping). Si une condition de victoire est atteinte ou que J10 est dépassé, publie l'embed de fin de partie (révélation complète des camps/rôles), ping `@MINI-JEUX`, et passe `termine: true` — les runs suivants deviennent des no-op silencieux, même principe que les autres jeux.

### Ciblage — restreint au dernier plateau connu, sauf le vote

La cible d'un **combat** (Arène, seul lieu de combat depuis la refonte de la Clairière — voir plus bas) ou d'une **enquête** (Tour de Guet) doit être positionnée au lieu choisi sur le **dernier plateau connu** (`joueursAvant`, figé depuis la clôture précédente) — le select menu ne propose que ces cibles valides, `computeAttacksFromActions()`/`computeInvestigations()` re-filtrent quand même par défense. Le **vote du Château** reste volontairement libre sur tout joueur vivant (accusation villageoise publique, pas une confrontation physique), et la **Clairière** n'a aucune notion de ciblage — elle tire 2 joueurs au hasard, sans co-location requise. Au Jour 1, la Tour de Guet n'a encore aucune cible sur le plateau (tout le monde démarre au Château) — le filet de sécurité prend le relais comme n'importe quel autre jour (voir "Filet de sécurité" plus bas). Château et Arène, eux, sautent carrément l'étape de cible ce jour-là — voir "Jour 1 — Château/Arène accessibles mais sans effet" ci-dessous.

### Jour 1 — Château/Arène accessibles mais sans effet (2026-08-26, sur demande explicite)

Vote et combat sont ignorés par `computeCloture()` tant que `jour === 1` (garde-fou déjà en place, voir "Plafond anti-snowball" plus bas) — mais rien n'empêchait un joueur de s'y rendre et de choisir une cible qui ne servirait jamais à rien, repéré comme source de confusion en test réel. Première version testée : désactiver carrément les boutons Château/Arène (`disabled: true`) le Jour 1 — **rejetée par l'utilisateur** ("on doit pouvoir se rendre à l'arène ou rester au château Jour 1, mais l'action sur place est nulle") : seule l'**action** doit être nulle, pas le **déplacement**, un joueur peut vouloir s'y rendre par choix (accompagner quelqu'un, observer, etc.).

Implémenté dans `handleLieuButton()` (`api/discord/_handlers/goblinhunters.js`) : `LIEUX_SANS_CIBLE_JOUR1` (`chateau`, `camp_entrainement`) — au Jour 1, ces deux lieux rejoignent la branche "aucune cible nécessaire" déjà utilisée par Taverne/Clairière (`recordAction(jour, discordId, slot, { lieu })`, pas de select menu), avec une confirmation dédiée précisant qu'il n'y a aucun effet aujourd'hui. Les boutons restent cliquables normalement (aucun `disabled`). `buildJourEmbed()` ajoute une ligne informative sur l'embed du Jour 1 pour prévenir avant le clic.

### Nerf Éclaireur — 2ᵉ action sur un lieu DIFFÉRENT de la 1ère (2026-08-26, bug repéré en test réel)

L'Éclaireur (2 actions/jour) pouvait jusqu'ici soumettre `primary` et `secondary` sur le **même** lieu — voter 2 fois au Château (2 votes au lieu d'1, doublant son poids dans `computeVoteTally()`) ou attaquer 2 fois à l'Arène (2 attaques au lieu d'1, doublant ses dégâts effectifs le même jour). Ni l'un ni l'autre n'était l'intention du rôle : le bonus est censé être "2 lieux/actions différents", pas "2x le même effet". Corrigé dans `handleLieuButton()` : quand `slot === "secondary"`, si `existingAction.primary.lieu === lieu` demandé, le clic est refusé avec un message explicite — vérifié après le verrou d'action définitive (`isActionLocked`) puisque `existingAction` est déjà chargé à ce stade, aucun appel Redis supplémentaire.

### DM d'élimination — description complète envoyée au joueur qui vient de mourir (2026-08-26, sur demande explicite)

Jusqu'ici, un joueur éliminé (vote ou combat) l'apprenait seulement en relisant le bilan public du jour suivant (qui ne montre que son camp, pas de détail personnel) — aucun MP dédié, contrairement aux résultats d'enquête/Clairière qui sont déjà envoyés en DM. `sendEliminationDM(discordId, cause, closure, jourClos, config)` (`api/discord/_handlers/goblinhunters.js`), appelée dans `postGoblinHunters()` juste après `closeDayAndAdvance()` (même bloc que `sendInvestigationDM`/`sendClairiereDM`, `!dryRun` uniquement), pour `closure.eliminationsParVote` et `closure.deathIdCombat` chacun s'ils sont non nuls (jusqu'à 2 DM le même jour si vote **et** combat ont eu lieu, cas différents joueurs par construction). Contenu : jour de l'élimination, camp/rôle du joueur (seule trace personnalisée en dehors du DM de rôle initial, plusieurs jours plus tôt), cause précise (vote avec le nombre de votes reçus, ou combat), et les effets de mort le concernant s'il détenait Guet-Apens (reveal déjà public, juste rappelé) ou Explosif (cible de la riposte).

⚠️ Ne révèle **pas** qui a voté contre lui, ni l'identité/camp de son attaquant au combat — décision de conception délibérée, pas un oubli : un joueur éliminé pourrait sinon relayer cette info aux vivants hors-jeu (voir la simulation d'équilibrage sur l'impact de la communication externe, mémoire projet `goblinhunters_game_design.md`) alors que lui-même n'a plus aucun enjeu à rester discret. Vérifié par test isolé du formatage (3 scénarios : vote simple, combat avec Guet-Apens, vote avec Explosif) via `fetch` mocké, sans toucher au Redis réel (partie en cours au moment de l'implémentation).

### Vote du Château — même stockage que les autres lieux (bug corrigé)

⚠️ Une première version stockait le vote d'accusation dans une clé Redis séparée (`goblinhunters:votes:<jour>`, via `recordVoteChateau()`) — repéré en test réel : un joueur pouvait voter au Château **puis** soumettre une action normale (ou l'inverse) le même jour, les deux stockages ne s'écrasant jamais l'un l'autre, en violation directe de la règle 1 action/jour. Corrigé en supprimant ce stockage séparé : voter est maintenant juste `recordAction(jour, discordId, slot, {lieu:"chateau", cibleId})`, exactement comme n'importe quel autre lieu, dans le même hash `goblinhunters:actions:<jour>`. `computeVoteTally(actionsRaw)` extrait le vote de la structure unifiée (`extractVote()`, regarde `primary` puis `secondary`) plutôt que de lire une source dédiée. Repère utile pour la suite : si un nouveau type d'action venait à être ajouté, il doit lui aussi passer par `recordAction()`/le hash `actions`, jamais par un stockage parallèle — c'est cette duplication qui avait causé le bug.

### Action définitive — aucun changement d'avis possible, sur aucun lieu

⚠️ Portée élargie suite à un retour en test réel : une première version ne verrouillait QUE le vote du Château (les 4 autres lieux restaient "modifiables jusqu'à la clôture, dernier clic gagne"). L'utilisateur a signalé pouvoir enchaîner Taverne → Clairière → Tour de Guet sans jamais être bloqué, et a confirmé vouloir la règle **sur tous les lieux**, pas seulement le vote — chaque choix est un engagement pour la journée, jamais un brouillon.

`isActionLocked(existingAction, slot)` (`backend/services/goblinhunters.js`) vérifie simplement si `existingAction?.[slot]` est déjà rempli — si oui, tout nouveau choix sur ce slot est refusé, quel que soit le lieu visé (changer de cible, changer de lieu, ou même retenter le même lieu). Ça marche parce que `recordAction()` n'écrit **jamais** d'état partiel : le clic initial sur un lieu à cible ne persiste rien tant que la cible n'est pas choisie (ou qu'un filet de sécurité ne s'est pas déclenché), donc la simple présence d'une entrée pour ce slot suffit à prouver qu'un choix a déjà été finalisé — pas besoin de vérifier le lieu ni la cible comme dans la version Château-only. Vérifié au clic dans `handleLieuButton` (avant même d'afficher le select de cible) et re-vérifié en défense dans `handleTargetSelect` — même esprit que `isLieuRepeatAllowed()`, mais `recordAction()` lui-même reste "bête" (n'écrit jamais de garde), toute la logique vit côté appelant. Le verrou est spécifique au `slot` : le primary verrouillé n'empêche pas l'Éclaireur de soumettre un secondary sur un lieu différent.

### Quorum de vote — 2 votants minimum (bug corrigé)

⚠️ Repéré en revue avec l'utilisateur : `resolveVoteElimination()` ne vérifiait à l'origine que « une seule cible au score maximum ? » — avec un seul votant, son unique vote _est_ mécaniquement le score maximum, donc il gagnait. Un joueur seul au Château pouvait exécuter n'importe qui unilatéralement. Corrigé par un quorum minimum (`config.vote_quorum_min`, 2 par défaut) : si le total de votes castés ce jour-là (toutes cibles confondues) est sous ce seuil, `resolveVoteElimination()` renvoie `null` avant même de regarder qui a le plus de voix.

### Clairière — révélation de position, pas un combat (refonte)

⚠️ Design initial insatisfaisant, repéré par l'utilisateur : la Clairière faisait exactement la même chose que l'Arène (mêmes dégâts, même ciblage), avec pour seule différence d'ignorer la protection Taverne — un avantage marginal, sans vraie contrepartie, qui ne justifiait pas un lieu à part. Refondue en pur renseignement : `computeClairiereReveals(actionsRaw, joueursApres, rng)` révèle, à la clôture, la position COURANTE de 2 joueurs vivants tirés au hasard (jamais soi-même, jamais un joueur déjà éliminé ce jour-là) — **aucune cible à choisir**, aucune restriction de co-location (ce n'est pas une confrontation, `lieuAction === "vision"` traité comme la Taverne : action enregistrée directement au clic). Résultat livré en DM (`sendClairiereDM`) et ajouté au carnet d'indices personnel (voir section Journal). Conséquence directe : le **Arène est désormais le seul lieu de combat** du jeu — plus de redondance entre les deux lieux.

⚠️ Le DM (plutôt que le message éphémère du clic) n'est pas un choix arbitraire : la révélation ne se calcule qu'à la **clôture** (le lendemain), une fois toutes les actions du jour connues — impossible de l'inclure dans la réponse éphémère du clic, dont le token webhook Discord expire bien avant que le résultat n'existe (~15 min, contre potentiellement 24h avant la clôture suivante). Même contrainte, même solution que pour les résultats d'enquête (`sendInvestigationDM`).

### Filet de sécurité Arène / Tour de Guet — cible aléatoire si personne d'éligible

⚠️ Problème structurel repéré par l'utilisateur, distinct de celui de la Clairière : avec seulement 3 lieux "sûrs" (Château/Taverne/Clairière) et la règle anti-camping qui n'interdit que de répéter le lieu de la **veille**, un joueur peut alterner indéfiniment entre ces 3 lieux sans jamais visiter l'Arène ni la Tour de Guet. Or ces deux lieux n'apportaient jamais rien tant que personne d'autre n'y était déjà allé — s'exposer en premier n'avait donc aucune contrepartie, et une population de joueurs "rationnels" pouvait les laisser morts toute la partie.

Corrigé par un filet de sécurité identique sur les deux lieux (`fallbackActorsFor()`, `backend/services/goblinhunters.js`) : si un joueur a choisi ce lieu mais n'a résolu aucune interaction (personne d'éligible n'était là hier, OU sa cible a été éliminée par le vote à la même clôture), il agit quand même sur un joueur vivant tiré au hasard — jamais un coup pour rien. `computeAttacksFromActions()`/`computeInvestigations()` prennent désormais un `rng` optionnel pour ce tirage.

⚠️ **Piège évité** : `computeIndicesForDay()` ne recalcule plus `computeAttacksFromActions()` en interne — elle reçoit désormais `result.attacks` directement depuis `computeCloture()` (le MÊME tirage `rng` que celui qui a servi à appliquer les dégâts). Un second appel indépendant avec un `rng` par défaut différent aurait pu tirer une cible différente de celle réellement touchée, désynchronisant le carnet d'indices personnel de ce qui s'est vraiment passé — vérifié par un test bout en bout (combat réel + indices comparés).

⚠️ **Doublon corrigé (2026-08-26, bug repéré en test réel)** : le tirage aléatoire du filet de sécurité de la Tour de Guet pouvait retomber sur une cible **déjà connue** de cet enquêteur (son camp lui avait déjà été révélé une enquête précédente) — un joueur a reçu 2 fois le même résultat ("X appartient au camp des Gobelins") en DM. Le combat n'a pas ce problème (une attaque ne révèle jamais de camp, réattaquer la même cible n'est pas une info gaspillée), donc seule `computeInvestigations()` est concernée.

Corrigé à deux niveaux, défense en profondeur :
- **Côté service** (`computeInvestigations()`, `backend/services/goblinhunters.js`) : nouveau paramètre `knownTargetsByInvestigator` (`{discordId: Set<cibleId>}`), dérivé du carnet d'indices de chaque joueur vivant via `knownEnqueteTargets(indices)` (nouvelle fonction pure — filtre `type: "enquete"`, collecte les `cibleId`). Exclut ces cibles à la fois du résultat délibéré (si la cible choisie sur le plateau est déjà connue, le résultat est écarté et l'enquêteur bascule sur le filet de sécurité) et du tirage aléatoire lui-même (`pickRandomTarget()` accepte désormais un 4ᵉ paramètre optionnel `extraExcludeIds`, jamais utilisé côté combat). `loadCloture()` construit cette map via `loadKnownTargetsByInvestigator()` (N lectures `readPlayerIndices()`, une par joueur vivant — négligeable, le cron ne tourne qu'une fois/jour).
- **Côté handler** (`handleLieuButton()`) : le select menu de la Tour de Guet filtre lui aussi les cibles déjà connues (`knownEnqueteTargets(await readPlayerIndices(discordId))`) — évite de proposer un choix inutile au clic, la vérification côté service n'est qu'un filet de défense, pas la seule garde.

Vérifié par 3 nouveaux tests unitaires (`knownEnqueteTargets()` isolée, filet de sécurité qui saute systématiquement une cible connue sur plusieurs graines de `rng`, résultat délibéré déjà connu écarté au profit du filet de sécurité).

### Plafond anti-snowball — 1 mort par combat maximum par jour

Sans plafond, plusieurs Gobelins attaquant le même jour pourraient éliminer plusieurs Villageois d'un coup et faire s'effondrer la partie en 2-3 jours. `resolveCombat()` calcule les PV bruts de toutes les cibles touchées, mais si **plusieurs** deviennent mortelles le même jour, seule celle ayant reçu le **plus de dégâts** meurt réellement (égalité → tirage au sort) — les autres sont plafonnées à **1 PV minimum**, pas éliminées. Le vote du Château suit une règle différente et volontairement plus douce, décidée avec l'utilisateur : en cas d'égalité entre plusieurs cibles, **personne** n'est éliminé (`resolveVoteElimination()`, pas de tirage au sort). Jusqu'à 2 morts par jour-cycle au total (1 vote + 1 combat), plafonds indépendants — même enchaînement que le classique jour/nuit du genre. **Jour 1** : aucune élimination possible, ni vote ni combat (garde-fou explicite dans `computeCloture()`).

### Rôles et combat

1 exemplaire de chaque rôle spécial par camp, quel que soit l'effectif (`assignCampsAndRoles()`) — 3 côté Villageois, 2 côté Gobelins :

- **Éclaireur** (Villageois) — 2 actions/jour au lieu d'une.
- **Bûcheron** (Villageois) — 1 PV/2 dégâts fixes au lieu de 2 PV/1 dégât — glass cannon.
- **Guet-Apens** (Villageois) — s'il meurt au combat à l'Arène, le camp de son ou ses attaquant(s) est révélé publiquement.
- **Infiltré** (Gobelin) — l'enquête menée sur lui à la Tour de Guet renvoie toujours `"chasseur"`, faux positif classique du genre.
- **Gobelin explosif** (Gobelin) — à sa mort (vote OU combat), inflige `config.roles.explosif.degats_riposte` (1 par défaut) à un Villageois, jamais mortel.

Les Gobelins connaissent l'identité des autres Gobelins dès la distribution des rôles (structurel, pas un rôle dédié — voir `otherGobelinsLine()` ci-dessus). Combat **déterministe** (pas de RNG comme Boss Raid) : dégâts fixes selon le rôle de l'attaquant, seul le départage d'un plafond anti-snowball est aléatoire.

⚠️ Bouton `[📖 Règles]` en style `3` (vert/Success) depuis le 2026-08-26, sur demande explicite pour le distinguer visuellement des autres boutons (tous en style `2`/gris) — présent à la fois sur l'embed d'inscription (`buildInscriptionComponents()`) et sur l'embed de jour (`buildJourComponents()`), les deux mis à jour pour rester cohérents.

Les 5 rôles spéciaux sont listés explicitement dans `buildReglesEmbed()` (bouton `[📖 Règles]`) **et** décrits en détail dans le DM de rôle (`sendRoleDM()`, sur demande explicite de l'utilisateur — le DM ne donnait auparavant que le libellé, jamais ce que le rôle fait concrètement). Les deux passent désormais par `roleDescription(roleKey, config)`, une fonction partagée générée depuis la config plutôt qu'écrite en dur deux fois — évite toute désynchronisation si les chiffres (PV/dégâts/etc.) changent un jour. Un oubli initial (avant `roleDescription()`) avait omis les rôles des Règles, repéré par l'utilisateur sur une vraie partie en test.

**Guet-Apens et Gobelin explosif** (2026-08-25, ajoutés sur demande explicite après une simulation Monte-Carlo d'équilibrage à 14 joueurs — voir mémoire projet `goblinhunters_game_design.md`) : deux rôles volontairement simples et symétriques (un par camp), qui ne changent aucun chiffre de combat/vote existant — seulement des effets déclenchés à la mort, pour ne pas rejouer sur l'équilibre déjà mesuré. `resolveGuetApensReveal({ deathIdCombat, attacks, joueursAvant })` et `resolveExplosifRetaliation({ eliminationsParVote, deathIdCombat, actionsRaw, attacks, joueursAvant, rng })` sont deux fonctions pures dans `backend/services/goblinhunters.js`, appelées dans `computeCloture()` juste après la résolution du combat, testées isolément dans `goblinhunters.test.js`. Les deux réutilisent `attacks` du MÊME appel que la résolution des PV (même contrainte que `computeIndicesForDay`, voir plus haut) — jamais recalculé séparément.

- La riposte de l'Explosif est **volontairement plafonnée à ne jamais tuer** (`Math.max(pv - degats_riposte, 1)`), décision explicite avec l'utilisateur (option retenue face à l'alternative "elle pourrait provoquer une 2e mort le même jour") — appliquée en aval du combat classique plutôt qu'injectée dans `resolveCombat()`, donc jamais en conflit avec son propre plafond anti-snowball (1 mort/jour). Cible : l'attaquant qui l'a achevé au combat (uniquement s'il est Villageois — pas de riposte sur un tir ami Gobelin via le filet de sécurité), ou un votant Villageois tiré au hasard s'il est éliminé au vote (pas d'attaquant unique dans ce cas).
- Le Guet-Apens ne se déclenche qu'au combat (l'Arène implique un attaquant identifiable), jamais au vote (pas d'attaquant unique dans un vote collectif). S'il est ciblé par plusieurs attaques le même jour, tous les attaquants sont révélés (pas seulement celui qui a porté le coup fatal).
- Les deux effets sont annoncés **publiquement** dans le bilan du jour (`buildJourEmbed()`), au même titre que le reveal de camp habituel à l'élimination — pas de DM privé, pas de nouvel indice dans le carnet Journal.

⚠️ **Bug de design trouvé après coup (2026-08-25)** : "les Gobelins se connaissent entre eux" était une décision actée dès la conception, mais jamais traduite en code — `sendRoleDM()` n'envoyait que le camp/rôle du joueur lui-même, sans jamais lister ses coéquipiers. Repéré par l'utilisateur sur une simulation d'équilibrage (une simulation Monte-Carlo supposant les Gobelins coordonnés donnait un tout autre résultat que le jeu réellement codé, où ils étaient en réalité aussi isolés que les Villageois). Corrigé : `otherGobelinsLine(joueur, joueurs)` (helper partagé) liste les autres membres du camp Gobelin — vivants **et** éliminés, marqués `☠️` — dans le DM de rôle (`sendRoleDM`, à l'appel de `launchGame()`) et dans le Journal personnel (`handleJournal`, relit `state.joueurs` à chaque clic donc reste à jour si un Gobelin meurt en cours de partie). Renvoie `null` pour un Villageois (aucune ligne ajoutée).

⚠️ Le nombre total de Gobelins n'est **pas un secret** : il découle mécaniquement de l'effectif de départ via `minority_table` (config publique, table 8→3…16→7, ratio ~2/5 depuis le rééquilibrage — voir "Rééquilibrage" plus bas) — n'importe quel joueur peut donc déjà le calculer lui-même. L'embed de jour affiche en conséquence le vrai décompte de Gobelins vivants (`👺 Gobelins en vie : **N**`), pas un `?` — un premier jet affichait `?` par réflexe "mystère façon Loups-Garous", incohérent avec le fait que le total de départ est public dès l'inscription. Seul reste secret : **qui** est Gobelin.

### Rééquilibrage 10j→7j (2026-08-26, sur demande explicite après tests réels)

Retour de terrain : le jeu semblait trop long sur 10 jours. Plutôt que deviner, **3 simulations Monte-Carlo successives** (script ponctuel non versionné, réutilisant les vraies fonctions pures du moteur avec des bots heuristiques, 4000-5000 parties/scénario) ont guidé chaque décision — voir mémoire projet `goblinhunters_game_design.md` pour le détail chiffré complet.

1. **10j→7j seul, aggrave le déséquilibre** : réduire la durée à 7 jours sans rien d'autre a fait chuter le taux de victoire Gobelins (déjà minoritaire) de ~17,9% à ~6,6% dans le scénario réaliste — moins de temps pour rattraper un écart de départ favorise mécaniquement le camp majoritaire qui gagne par défaut. Objectif fixé par l'utilisateur : ramener le taux de victoire Gobelins entre **40 et 60%** malgré la durée réduite.
2. **Piste écartée — condition de victoire assouplie ("quasi-parité")** : simulée et chiffrée (~58,6% avec minorité relevée), mais rejetée par l'utilisateur ("trop complexe à comprendre") — abandonnée au profit de leviers purement numériques.
3. **Piste écartée — parité de départ + victoire par élimination totale** : simulée sur demande, révèle un problème structurel indépendant de l'équilibrage — avec un rythme de mort plafonné à ~2/jour (1 vote + 1 combat) et 7 têtes à éliminer par camp au lieu de départager une parité, la partie ne se résout quasiment jamais dans un délai jouable (~100% non résolu à 7j, encore ~94% à 10j ; il faudrait ~25-30 jours pour converger de façon fiable). Abandonnée.
4. **Retenu — 3 leviers numériques combinés**, aucune nouvelle règle à expliquer :
   - `minority_table` relevée de ~1/3 à ~2/5 (ex. 14 joueurs : 5→6 Gobelins). Levier de loin le plus efficace mesuré (un Gobelin de plus pèse bien plus qu'un rôle spécial en plus).
   - ⚠️ **Piège découvert en simulant** : une minorité fixée à exactement N/2 (parité stricte dès l'assignation) fait gagner les Gobelins à **100%** dès la fin du Jour 1 — la condition de victoire par parité (`checkVictory()`) est trivialement remplie avant la moindre élimination, puisque personne ne peut mourir le Jour 1. Vérifié qu'aucune valeur de la table révisée n'atteint N/2 (voir table ci-dessous).
   - `combat.pv_base` : 3→2 PV pour les Villageois (combat plus rapide, cohérent avec une partie plus courte).
   - Nouveau `combat.gobelin_pv_bonus: 1` — les Gobelins ont 1 PV de plus que les Villageois (3 PV), avantage décidé avec l'utilisateur pour compenser leur infériorité numérique. Implémenté dans `buildInitialRoster()` (`backend/services/goblinhunters.js`) : s'applique à **tous** les Gobelins quel que soit leur rôle (Infiltré/Explosif compris), jamais au Bûcheron dont l'override de rôle reste prioritaire (de toute façon toujours camp Villageois). Testé unitairement (bonus appliqué/absent, override Bûcheron prioritaire).
   - Résultat mesuré : ~50-51% Gobelins dans les scénarios réalistes (coordonnés vs isolés/communicants), ~21% si personne ne coordonne rien — dans la fourchette cible, robuste sur les 2 niveaux de communication testés.
5. **Effet de bord du Bûcheron repéré et corrigé** : à PV=2, ses 2 dégâts fixes tueraient n'importe quelle cible fraîche en un seul coup, garanti par la priorité du plafond anti-snowball (2 dégâts = le maximum possible dans cette config, gagne toujours le départage) — un pur avantage sans plus aucune contrepartie, contrairement à l'esprit "glass cannon" du rôle. Recalé à **1 PV** (au lieu de 2) pour préserver le même écart relatif qu'avant (`pv_base − 1`), un simple coup normal (1 dégât) suffit désormais aussi à l'achever.

Nouvelle table `minority_table` (8→3, 9→4, 10→4, 11→5, 12→5, 13→6, 14→6, 15→6, 16→7) — vérifié programmatiquement qu'aucun effectif ne tombe sur N/2 (piège du point 4) et que les 5 rôles spéciaux (2 Gobelins/3 Villageois) tiennent toujours à l'effectif plancher (8 → 3 Gobelins/5 Villageois).

### Taverne — protection sous seuil uniquement

`computeTavernProtection()` : la protection ne tient que **sous** `taverne_seuil_protection` (3 par défaut, `data/goblinhunters/goblinhunters.json`) — au-dessus, surpeuplée, elle ne protège plus personne ce jour-là. Garde-fou décidé avec l'utilisateur contre le camping massif de la Taverne (sinon le camp majoritaire n'a aucune raison d'en bouger et la partie stagne jusqu'à J10). S'y rendre consomme l'action du jour comme n'importe quel autre lieu — aucun état supplémentaire à faire vivre sur la durée.

### Tour de Guet surpeuplée — inefficace au-delà de la moitié des vivants (2026-08-26, sur demande explicite)

Même principe que la Taverne ci-dessus, appliqué à la Tour de Guet : constat de l'utilisateur que le Jour 1 pousse mécaniquement **tout le monde** vers la Tour (seul lieu avec une vraie valeur ce jour-là — Château/Arène sans effet, le filet de sécurité de `computeInvestigations()` garantit toujours un résultat même sans cible éligible sur le plateau), ce qui viderait l'Arène et la Clairière de tout intérêt dès le Jour 2 si le réflexe se répète.

`computeTourDeGuetOccupants(actionsRaw)` (compte les joueurs ayant choisi ce lieu aujourd'hui, `primary` ou `secondary`) + `isTourDeGuetOvercrowded(occupantsCount, aliveCount, ratio)` (`config.tour_de_guet_seuil_ratio`, 0.5 par défaut — **strictement plus de** la moitié des vivants, pas "à partir de"). Si surpeuplée, `computeCloture()` court-circuite entièrement `computeInvestigations()` pour ce jour (`investigations: []`) — personne n'obtient de résultat, ni via une cible délibérée ni via le filet de sécurité. L'action reste quand même définitive (verrouillée dès le clic comme n'importe quel autre lieu) : se rendre à la Tour un jour surpeuplé consomme l'action pour rien, c'est le prix à payer pour avoir suivi le mouvement.

Annoncé publiquement dans le bilan du jour (`buildJourEmbed()`, "🔭 La Tour de Guet était trop encombrée hier...") — sans cette ligne, les enquêteurs n'auraient aucune explication au silence inhabituel de leur DM d'enquête habituel. Mentionné aussi dans `buildReglesEmbed()`. Testé unitairement (`isTourDeGuetOvercrowded()` isolée sur plusieurs ratios/effectifs, `computeCloture()` bout en bout avec 5/8 vivants à la Tour → `investigations: []`, et 4/8 exactement à la moitié → enquêtes normales, confirmant que "la moitié pile" ne déclenche PAS la règle).

### Anti-camping — interdit de rester au même lieu 2 jours de suite

`isLieuRepeatAllowed(previousPosition, lieu, jour)` : refuse au clic (avant tout enregistrement) de choisir le même lieu que celui occupé la veille, à partir du Jour 2 (le Jour 1 est exclu — la position de spawn initiale au Château ne compte pas comme un choix actif). Même principe que `isChevalierVoteAllowed()` de Bossraid : un garde-fou vérifié au clic dans `handleLieuButton`, pas une contrainte de résolution à la clôture. Motivation : sans cette règle, rester au Château en continu offrait une **immunité totale et gratuite** au combat — le ciblage étant restreint au dernier lieu connu (voir "Ciblage — restreint au dernier plateau connu" plus haut), un joueur qui ne quitte jamais le Château ne peut structurellement jamais être attaqué, contrairement à la Taverne qui au moins plafonne sa protection sous un seuil. Ne s'applique qu'au choix actif d'un lieu : un joueur passif (pass automatique, retombe au Château) n'est jamais bloqué par cette règle puisqu'il ne clique sur rien.

### Journal personnel — éphémère et privé, jamais un historique public

Contrairement au bouton Journal des autres jeux (Robinson, Boss Raid — historique public des jours passés), celui de Goblin Hunters est **exclusivement personnel** : il affiche, uniquement au joueur qui clique, son camp/rôle secrets, la liste des autres Gobelins si le joueur en est un (`otherGobelinsLine()`, voir "Rôles et combat" ci-dessus), sa dernière position connue, ses PV, le **choix déjà validé pour le jour en cours** (voir ci-dessous), et un **carnet d'indices** cumulé sur toute la partie. Motivation : le plateau public ne montre que les positions COURANTES (régénéré à chaque clôture, aucun historique) — sans ce carnet privé, un joueur perdrait toute trace de ses rencontres passées dès le lendemain.

**Choix du jour en cours** (ajouté sur demande explicite, retour en test réel) : puisque chaque action est **définitive dès validation** (`isActionLocked()`) mais n'est appliquée au plateau public qu'à la clôture du lendemain, un joueur n'avait aucun moyen de se rappeler ce qu'il venait de choisir en attendant. `handleJournal()` lit désormais aussi `readPlayerAction(state.jour, discordId)` — l'action de la journée EN COURS, pas encore résolue — et l'affiche (`🌫️ Clairière`, `⚔️ Arène → **Cible**`, etc., primary et secondary pour l'Éclaireur). Uniquement affiché si le joueur est vivant ; absent s'il n'a encore rien soumis aujourd'hui.

Trois sources alimentent le carnet à chaque clôture (`computeIndicesForDay()`, `backend/services/goblinhunters.js`), distinguées par un champ `type` (formatage différent côté `formatIndiceLine()`) :

- `type: "enquete"` (Tour de Guet) : révèle le camp de la cible (`campReporte`), y compris le faux positif de l'Infiltré.
- `type: "combat"` (Arène) : révèle seulement le **lieu de l'affrontement** (`campReporte: null`) — une attaque ne renseigne jamais sur le camp.
- `type: "reveal"` (Clairière) : révèle la **position courante** de la cible (`lieu` = où elle se trouve, pas où l'interaction a eu lieu — il n'y en a pas), sans jamais de camp non plus. Seule source qui ne nécessite aucune co-location (voir `computeClairiereReveals()`).

Stocké dans `goblinhunters:indices` (HASH permanent `discordId → JSON[]`, un tableau qui grandit à chaque clôture via `appendIndices()`), effacé par `resetGoblinHunters()` comme le reste de la manche en cours. `readPlayerIndices(discordId)` lit le carnet d'un seul joueur sans charger celui des autres. Le routage dans `interactions.js` passe désormais `discordId` à `handleJournal()` (auparavant appelé sans argument, contenu générique).

### Messagerie — mur de messages anonymes, 1/jour/joueur (2026-08-26, sur demande explicite)

Bouton `[📬 Messagerie]` sur l'embed de jour (3e bouton de la ligne Règles/Journal). Contrairement au reste du jeu, **c'est du live, pas résolu à la clôture** : un message posté est visible immédiatement au prochain clic de n'importe qui, pas seulement le lendemain.

- **Lecture** : affiche les 3 derniers messages postés, dans l'ordre chronologique (plus ancien en premier, même convention que le carnet d'indices du Journal), chacun annoté `Jour N` mais **jamais l'auteur**. Ouverte à tout le monde (participant ou non), même principe que le bouton Règles.
- **Écriture** : un 2e bouton `[✍️ Écrire un message]` n'apparaît que si le joueur est vivant et n'a pas encore posté aujourd'hui — clique dessus → ouvre une **Modal** Discord (texte libre, 200 caractères max, `type: 9` en réponse synchrone, même mécanisme que le bouton "Répondre" d'Anagram, voir `anagrams.js`) → soumission (`MODAL_SUBMIT`, `body.type === 5`, à ne pas confondre avec le type de réponse `5` DEFERRED) → message enregistré et confirmation éphémère.
- **Anonymat structurel, pas juste un masquage à l'affichage** : `recordMessage()`/`listRecentMessages()` (`backend/services/goblinhunters.js`) ne stockent JAMAIS le `discordId` de l'auteur avec le contenu du message (`goblinhunters:messages`) — impossible de le faire fuiter même en lisant le contenu brut de cette clé. Le quota quotidien (1/jour/joueur) vit dans une structure **séparée** (`goblinhunters:messages_sent:<jour>`, HASH `discordId → "1"`), jamais croisée avec le contenu des messages.
- **Bornage à 3 messages** : `RPUSH` + `LTRIM(-3, -1)` à chaque envoi — pas de structure de purge séparée à maintenir, la LIST Redis se borne elle-même.
- **Le quota est revérifié à l'écriture**, jamais fait confiance au seul fait que le bouton "Écrire" soit visible (l'affichage n'est qu'une aide UX, pas la garde réelle) — et sur le **jour courant relu depuis l'état**, jamais un jour capturé au moment de l'ouverture de la Modal (la partie a pu avancer si le joueur a mis du temps à écrire).
- Nettoyé par `resetGoblinHunters()` comme le reste de la manche en cours (`goblinhunters:messages` + tous les `goblinhunters:messages_sent:*`).
- Mentionnée dans `buildReglesEmbed()` (bouton `[📖 Règles]`), une ligne courte cohérente avec le style condensé du reste des Règles.

⚠️ Fonctions I/O (`hasSentMessageToday`, `recordMessage`, `listRecentMessages`) volontairement non couvertes par `goblinhunters.test.js`, cohérent avec le reste du fichier : seules les fonctions **pures** (aucun accès Redis) y sont testées, jamais les wrappers I/O (`recordAction`, `registerPlayer`, etc. ne le sont pas non plus). Vérifié à la place par relecture de code + test isolé du rendu de l'embed (les 3 états : vide/rempli, vivant/éliminé, déjà envoyé/pas encore) et de la Modal exportée (`buildMessagerieModal()`), sans toucher au Redis réel — une partie était en cours au moment de l'implémentation, écrire un message de test dans `goblinhunters:messages` l'aurait fait apparaître pour de vrais joueurs.

### Image du plateau

`backend/services/goblinhuntersImage.js` — même technique que `zoomImage.js` : `data/goblinhunters/images/board.jpg` encodé en `data:image/jpeg;base64,...`, injecté dans un `<image href="...">` de fond, rastérisé en PNG via `@resvg/resvg-js`. ⚠️ **JPEG, ni WebP ni AVIF** : l'asset original livré était un `.webp` ; un premier test avait semblé le valider (aucune exception levée), mais une vérification **visuelle** du rendu a révélé que resvg/usvg ignore silencieusement un `<image>` WebP OU AVIF embarqué en data URI — jamais d'erreur, juste un fond absent. Seuls PNG/JPEG/GIF sont réellement décodés. Le PNG converti (~2,3 Mo) était bien trop lourd pour un asset de repo ; le JPEG (converti puis recompressé manuellement, ~273 Ko actuellement) reste sans artefact visible perceptible, c'est le format retenu. `board.webp` (asset original) est conservé pour archive uniquement, jamais utilisé au rendu — toujours vérifier **visuellement** un rendu resvg avant de le considérer fonctionnel, l'absence d'exception ne garantit rien. Chaque joueur **vivant** apparaît en pastille positionnée sur son lieu courant (couleur neutre + initiale — **jamais** colorée par camp, ça fuiterait le secret), les joueurs **éliminés** apparaissent en bande grisée en bas de l'image avec la couleur de leur camp révélé (jamais le rôle précis). Servie par la route Express `GET /api/goblinhunters/image?jour=` (`backend/server.js`), référencée par URL dans l'embed — jamais un attachment Discord, même principe que Frame/Zoom. Le rendu reflète toujours l'état **courant** de la partie (pas un instantané historique par jour) : l'ancien message est supprimé avant chaque repost, `jour` ne sert qu'à invalider le cache Discord. Les coordonnées de chaque lieu (`LIEU_ANCHORS`) sont calibrées à l'œil sur l'aperçu généré — à affiner par itération visuelle si besoin, comme l'historique de réglage documenté dans `zoomImage.js`.

### Image de fin de partie

`getEndImage()` (`backend/services/goblinhuntersImage.js`) sert `data/goblinhunters/images/end.webp` **tel quel** — pas de composition SVG/resvg ici, juste une lecture de fichier mise en cache mémoire. ⚠️ Pas de conflit avec la limitation resvg documentée ci-dessus (PNG/JPEG/GIF uniquement pour un `<image>` embarqué) : cette contrainte ne concerne QUE resvg qui rastérise un SVG, pas un fichier servi directement — Discord décode nativement le WebP dans un embed, aucun souci. Route dédiée `GET /api/goblinhunters/end-image` (`backend/server.js`), sans paramètre (un seul fichier, inchangé toute la manche, pas de cache-busting nécessaire). Référencée dans `buildOutcomeEmbed()`.

La liste "Révélation des identités" précise, pour chaque joueur : un symbole vivant/mort (✅/☠️, distinct du camp/rôle) et le rôle spécial le cas échéant (`(Éclaireur)`/`(Bûcheron)`/`(Infiltré)`) — les deux ajoutés sur demande explicite, absents de la version initiale qui ne montrait que le camp.

### Image d'inscription

Même principe que l'image de fin de partie : `getStartImage()` (`backend/services/goblinhuntersImage.js`) sert `data/goblinhunters/images/start.webp` **tel quel** (aucune composition resvg), route dédiée `GET /api/goblinhunters/start-image` (`backend/server.js`), sans paramètre. Référencée sur les **3** gabarits d'inscription (`buildAnnonceInscriptionEmbed()`, `buildInscriptionRappelEmbed()`, `buildInscriptionReportEmbed()`), pas seulement l'annonce initiale — le message d'inscription est PATCHé en place à chaque inscription/désinscription en réutilisant toujours le gabarit "rappel" (`refreshInscriptionMessage()`, compteur live sur le bouton) ; sans l'image sur les 3 gabarits, elle disparaîtrait du message dès le premier clic S'inscrire/Se désinscrire.

### Messages de tension — victoire imminente

`buildJourEmbed()` ajoute une ligne narrative supplémentaire quand une victoire devient possible **dès la clôture du jour affiché**, en plus du "Villageois/Gobelins en vie" déjà public :

- **1 seul Gobelin en vie** (`gobelinsVivants === 1`) → pool `tension_gobelin_dernier` (les Villageois peuvent gagner par élimination totale).
- **Gobelins à 1 mort de la parité** (`gobelinsVivants === chasseursVivants - 1`, avec au moins 1 Gobelin vivant) → pool `tension_parite_proche`.
- **Les deux à la fois** (fin de partie très serrée, ex. 1 Gobelin / 2 Villageois) → pool dédié `tension_double`, plutôt que de choisir arbitrairement l'un des deux messages précédents.
- **Approche du Jour 10** (`jour >= config.duree_jours - 1`, donc les 2 derniers jours) → pool `tension_derniers_jours`, indépendant du compte de joueurs, rappelle l'échéance de victoire par défaut des Villageois.

Ce ne sont jamais des fuites d'info : les comptes par camp sont déjà publics (voir plus haut), ces messages ne font que les mettre en avant narrativement. Sélection déterministe par jour (`pickFlavor()`), textes dans `data/goblinhunters/narratifs.json`.

### Stockage — Upstash Redis (`goblinhunters:*`)

Même instance et mêmes conventions que les autres jeux (`automaticDeserialization: false`). Espace de clés `goblinhunters:*`, totalement séparé.

| Clé Redis                            | Type              | Contenu                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goblinhunters:state`                | STRING            | `{ phase, jour, channelId, messageId, publishedAt, termine, closingAt?, joueurs? }` — `joueurs` = roster complet (camp, rôle, PV, position, vivant, camp révélé) une fois la partie lancée                                                                                                                                                          |
| `goblinhunters:inscriptions`         | HASH              | `discordId → { username, registeredAt }` — vidée au lancement de la partie                                                                                                                                                                                                                                                                          |
| `goblinhunters:actions:<jour>`       | HASH              | `discordId → { primary: {lieu, cibleId}, secondary? }` — écrasable, jetable, effacé après clôture du jour. Le vote d'accusation du Château **n'a pas de clé séparée** : voter est juste `{lieu:"chateau", cibleId}` dans cette même structure (`computeVoteTally()` l'en extrait) — voir "Vote du Château" plus bas pour l'incident que ça corrige. |
| `goblinhunters:historique`           | HASH              | `jour → { eliminationsParVote, deathIdCombat, investigations, voteTally, victory, resolvedAt }` — bilans quotidiens de la manche EN COURS, effacé par `resetGoblinHunters()`                                                                                                                                                                        |
| `goblinhunters:manches`              | HASH              | `manche → { manche, victory, jourFinal, resolvedAt }` — un bilan par manche TERMINÉE, jamais nettoyé                                                                                                                                                                                                                                                |
| `goblinhunters:manche_seq`           | STRING (compteur) | Numéro de la prochaine manche à archiver, incrémenté (`INCR`) à chaque fin de partie réelle (jamais en dry-run)                                                                                                                                                                                                                                     |
| `goblinhunters:messages`             | LIST              | Les 3 derniers messages anonymes (`{ content, jour }`, jamais de `discordId`), `RPUSH` + `LTRIM(-3,-1)` à chaque envoi                                                                                                                                                                                                                              |
| `goblinhunters:messages_sent:<jour>` | HASH              | `discordId → "1"` — quota 1 message/jour/joueur, séparé du contenu pour ne jamais pouvoir croiser auteur/message                                                                                                                                                                                                                                    |

### Scripts npm (Goblin Hunters)

| Commande                                  | Effet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run goblinhunters:test`              | Poste manuellement l'étape courante sur le salon de test (`DISCORD_CHANNEL_FRAME_TEST`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run goblinhunters:test:dry`          | Aperçu console de la prochaine étape, sans écrire d'état ni poster sur Discord. Pendant la phase inscription, affiche aussi la répartition camps/rôles qu'un lancement produirait (sans l'appliquer).                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run goblinhunters:test:force-close`  | ⚠️ **TESTS UNIQUEMENT**, jamais câblé dans `goblinhunters.yml` — ignore l'échéance réelle de la fenêtre d'inscription (3 jours) pour déclencher immédiatement le lancement dès l'effectif minimum atteint. Combinable avec `--dry-run` pour prévisualiser sans lancer pour de vrai.                                                                                                                                                                                                                                                                                           |
| `npm run goblinhunters:seed-test-pool`    | ⚠️ **TESTS UNIQUEMENT** — inscrit un faux pool de 8 joueurs (IDs `test_fake_1`…`test_fake_8`, tout l'effectif minimum) pour pouvoir tester entièrement seul dans le salon de test, sans second testeur. Les DM de rôle échouent proprement pour ces faux comptes au lancement (catch déjà en place), sans incidence sur le reste. Accepte un nombre différent en argument (`node scripts/seedGoblinHuntersTestPool.js 4`).                                                                                                                                                    |
| `npm run goblinhunters:scatter-test-pool` | ⚠️ **TESTS UNIQUEMENT**, à lancer une fois la partie démarrée (`goblinhunters:test:force-close`) — répartit les faux joueurs sur les 5 lieux (round-robin déterministe) au lieu de les laisser tous groupés au Château, où le pass automatique les ramènerait sinon indéfiniment (aucun ne clique jamais de bouton). Effet immédiat sur `state.joueurs[].position` **et** persistant (soumet une action "reste ici" en leur nom pour le jour en cours) — à relancer chaque jour de test pour qu'ils restent en place plutôt que de retomber au Château à la clôture suivante. |
| `npm run goblinhunters:public`            | Poste sur le salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) — utilisé par le cron `goblinhunters.yml`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run goblinhunters:public:dry`        | Équivalent dry-run de `goblinhunters:public`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run goblinhunters:reset`             | Remet Goblin Hunters à zéro : plus de partie active, inscriptions/actions/votes/historique de la manche en cours effacés. **Destructif** — préserve toujours `goblinhunters:manches`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run goblinhunters:reset:manches`     | Identique, mais efface aussi `goblinhunters:manches`/`goblinhunters:manche_seq`. **Destructif**, à réserver au filet de sécurité.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run goblinhunters:status`            | Affiche l'état courant (phase, roster complet avec camps/rôles/PV/positions, progression des actions du jour) sans passer par Discord. ⚠️ **Sortie admin uniquement** — spoile les camps/rôles, ne jamais la partager avec les joueurs en cours de partie.                                                                                                                                                                                                                                                                                                                    |

### Tester une partie complète (Goblin Hunters)

1. `npm run goblinhunters:seed-test-pool` — inscrit 8 faux joueurs (effectif minimum atteint, aucun second testeur nécessaire).
2. `npm run goblinhunters:test` — ouvre la fenêtre d'inscription sur le salon de test.
3. `npm run goblinhunters:test:force-close` — clôture immédiatement les inscriptions et lance la partie (les DM de rôle échouent silencieusement pour les faux comptes, sans incidence).
4. `npm run goblinhunters:scatter-test-pool` — répartit les faux joueurs sur les 5 lieux (sinon ils restent tous groupés au Château, aucune cible co-localisée disponible pour tester le combat/l'enquête). À **relancer chaque jour de test** (avant l'étape 5) pour qu'ils restent à leur place plutôt que de retomber au Château au pass automatique.
5. Chaque jour : clique un bouton de lieu (+ cible si besoin) dans le salon de test, puis `npm run goblinhunters:test` clôture le jour et publie le suivant. Pas de contrainte d'horaire une fois la partie lancée, contrairement à la fenêtre d'inscription.
6. `npm run goblinhunters:reset` une fois le test terminé.

### Déroulement en production (Goblin Hunters)

Même principe que les autres jeux collaboratifs : seule l'ouverture de la fenêtre d'inscription est déclenchée à la main (`workflow_dispatch` sur `goblinhunters.yml`, ou `npm run goblinhunters:public`) — tout le reste (rappels quotidiens pendant l'inscription, lancement une fois l'effectif atteint et la fenêtre close, clôture de chaque jour de jeu) est pris en charge automatiquement par le cron de 08:00 UTC (`--require-active`, ne fait jamais rien tant qu'aucune fenêtre d'inscription n'a été ouverte manuellement) — voir `Déroulement (Goblin Hunters)` plus haut et `.github/workflows/goblinhunters.yml`, calqué sur `bossraid.yml`.

### Variables d'environnement requises (Goblin Hunters)

Aucune nouvelle variable : Goblin Hunters réutilise `DISCORD_CHANNEL_FRAME_TEST`/`DISCORD_CHANNEL_FRAME_PUBLIC` et `KV_REST_API_URL`/`KV_REST_API_TOKEN` (même instance Upstash Redis, espace de clés `goblinhunters:*` totalement séparé). Le workflow `.github/workflows/goblinhunters.yml` réutilise les mêmes secrets GitHub Actions que les autres jeux (déjà configurés, rien à ajouter).

---

## Détection des arrivées en cours de GDC

### Contexte

Plusieurs commandes Discord doivent distinguer les membres « installés » (présents toute la semaine de GDC) des membres « arrivés en cours de GDC » (nouveaux recruits, transferts). Les nouveaux arrivants ne doivent pas être pénalisés dans les listes de fail.

### Source : `streakInCurrentClan`

Le service `buildWarHistory()` dans `backend/services/warHistory.js` parcourt le race log du clan (de la semaine la plus récente à la plus ancienne) et calcule `streakInCurrentClan` : le nombre de **semaines complètes consécutives** où le joueur était présent dans le clan actuel. La semaine en cours est exclue car incomplète.

### Fonction utilitaire : `isJoinedThisWar()`

**Fichier :** `backend/services/arrivalUtils.js`

```js
isJoinedThisWar(streakInCurrentClan, (day1Decks = null));
```

| `streakInCurrentClan` | `day1Decks`   | Résultat                                                               |
| --------------------- | ------------- | ---------------------------------------------------------------------- |
| `0`                   | _ignoré_      | ✅ Arrivé en cours de GDC (0 semaine complète)                         |
| `1`                   | `null` ou `0` | ✅ Arrivé en début de GDC (1 semaine complète, mais pas de deck au J1) |
| `1`                   | `>= 1`        | ❌ Membre installé (a joué au J1, peut faire 16/16)                    |
| `>= 2`                | _ignoré_      | ❌ Membre installé                                                     |

### Commandes utilisatrices

| Commande  | Fichier:ligne                           | Usage                                                                          |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `/demote` | `api/discord/interactions.js:3220`      | Sépare les arrivés en cours de GDC des réguliers dans la liste des fails 16/16 |
| `/fail`   | `api/discord/interactions.js:3886-3888` | Exclut les arrivés en cours de GDC de la liste des fails journaliers           |

---

## Glossaire

### Full mode

Mode principal de calcul du score de fiabilité joueur.
Il est utilisé quand l’historique River Race permet de construire une warHistory suffisamment fiable.

Où le trouver :

- calcul dans backend/services/warScoring.js via computeWarScore() ;
- décision d’utiliser ce mode dans backend/services/playerAnalysis.js et backend/routes/clan.js.

Comment savoir si ce mode est actif :

- côté joueur, analysis.warScore existe sans isFallback ;
- côté clan, le membre a un warScore calculé depuis l’historique et non depuis le fallback.

### Fallback mode

Mode dégradé utilisé quand l’historique River Race est absent, insuffisant ou non exploitable.
Le calcul se base surtout sur le battle log, quelques métadonnées joueur et éventuellement les decks live de currentRace.

Où le trouver :

- calcul dans backend/services/warScoring.js via computeWarReliabilityFallback() ;
- sélection du mode dans backend/services/playerAnalysis.js et backend/routes/clan.js.

Comment le reconnaître :

- le payload contient isFallback: true dans le score calculé.

### Reset times

Heures officielles de reset GDC par clan, exprimées en UTC.
Elles servent à déterminer le vrai changement de journée de guerre.

Où trouver la valeur :

- backend/services/dateUtils.js, constante CLAN_RESET_TIMES.

Comment l’utiliser :

- ne pas recalculer à la main ;
- toujours passer par warResetOffsetMs(clanTag) pour obtenir l’offset en millisecondes.

### Saison

Cycle Clash Royale d’environ un mois, commençant le premier lundi du mois après le reset de guerre.
Une saison contient 3 à 5 semaines de guerre.

Où trouver ou calculer la valeur :

- `seasonId` est une `source de vérité` fournie par l’API sur `raceLog[0]` ;
- `sectionIndex` est une `source de vérité` fournie par l’API et commence à `0` ;
- le `weekId` courant se calcule avec `computeCurrentWeekId(currentRace, raceLog)` dans `backend/services/dateUtils.js` ;
- le `seasonId` courant se calcule avec `computeCurrentSeasonId(currentRace, raceLog)` dans `backend/services/dateUtils.js`.
- le nombre de manches du jeu Frame sur la saison en cours (X dans "Manche N/X") se calcule par **calcul purement calendaire**, indépendant de l'API Clash Royale : `getCurrentSeasonBounds(now)` détermine les bornes `[premier lundi du mois, premier lundi du mois suivant)`, et `computeSeasonMancheTotal(now)` compte les mercredis dans cet intervalle — les deux dans `backend/services/dateUtils.js`. Risque résiduel accepté : si Supercell décale une transition de saison par rapport à cette règle documentée, le calcul divergerait de la réalité jusqu'à correction manuelle.

### Jours de GDC

Les jours de guerre actifs de la semaine, du jeudi au dimanche.
Le code raisonne en journée GDC et non en simple journée civile UTC.

Où le trouver ou le calculer :

- `warDayKey()` dans `backend/services/dateUtils.js` est un `calcul fiable` à partir d’un timestamp et d’un `reset` de clan ;
- `buildCurrentWarDays()` dans `backend/services/playerAnalysis.js` est un `calcul fiable` des jours actifs de la semaine courante ;
- `getEndedWarDay()` dans `scripts/notifyWarSummary.js` est un `calcul fiable` du jour de guerre qui vient de se terminer.

### Jours de Colisée

Journées où la course est en période Colosseum au lieu du warDay classique.
Le traitement des points y reste cumulatif à l’échelle de la semaine — mais c'est
vrai aussi en GDC normale (`participants[].fame` ne se remet jamais à zéro entre
J1 et J4, dans les deux types de semaine). Ce qui **change vraiment** entre les
deux, c'est la métrique qui détermine le vainqueur : voir
`docs/api-clash-royale.md` § "Classement final GDC" et `backend/services/warStandings.js`
(nouveau module qui centralise ce calcul, utilisé par `backend/routes/clan.js` et
`scripts/notifyWarSummary.js`).

Où le trouver :

- `periodType` est une `source de vérité` renvoyée par l’API de guerre ;
- la logique de résumé dans `scripts/notifyWarSummary.js` est un `calcul fiable` pour convertir ce contexte en résumé quotidien ;
- `computeGroupStandings()` / `computeClanStanding()` dans `backend/services/warStandings.js` sont le `calcul fiable` du classement/de la victoire assurée, pour les deux types de semaine.

Comment les reconnaître :

- un jour est Colisée si `periodType === "colosseum"`.

### Clans autorisés

Liste fermée des clans de la famille pour lesquels l’analyse complète de clan est autorisée.

Où trouver la valeur :

- `ALLOWED_CLANS` est la `source de vérité` dans `backend/routes/clan.js`.

Valeurs actuelles :

- `Y8JUPC9C`
- `LRQP20V9`
- `QU9UQJRL`

> Note : la famille comporte désormais aussi le clan **La Treve** (`QUV220GJ`) pour les résumés `/family` et la vue collective, mais il n'est pas inclus dans `ALLOWED_CLANS` car il ne reçoit pas l'analyse complète de clan.

### Famille

Ensemble des clans autorisés considérés comme un même périmètre métier pour l’historique et certaines règles de continuité.

Où trouver la valeur :

- `FAMILY_CLAN_TAGS` est une `source de vérité` dans `backend/services/warHistory.js` ;
- `backend/routes/clan.js` réutilise `ALLOWED_CLANS` pour la même famille métier.

### Score de fiabilité (joueur)

Score principal affiché pour un joueur, exprimé en pourcentage du maximum du mode actif.
Il provient soit du full mode, soit du fallback mode.

Où trouver la valeur :

- `warScore.total` est un `calcul fiable` ;
- `warScore.maxScore` est un `calcul fiable` selon les critères disponibles ;
- `warScore.pct` est un `calcul fiable` dérivé des deux précédents ;
- l’endpoint `GET /api/player/:tag/analysis` est la `source de vérité` de l’API pour ce score.

### Score de fiabilité (clan)

Il n’existe pas aujourd’hui de score unique canonique pour un clan entier.
La vue clan s’appuie surtout sur les scores de fiabilité de ses membres et sur leurs verdicts.

Où trouver les données utiles :

- l’endpoint `GET /api/clan/:tag/analysis` est la `source de vérité` ;
- `members[].reliability` et `members[].verdict` sont des `calculs fiables` par membre ;
- `membersRaw` contient des données plus brutes, utiles pour le debug ;
- il n’existe pas de champ canonique `scoreClan` calculé une seule fois et stocké comme vérité métier.
- pour le résumé pré-GDC hebdo, le script stocke néanmoins un champ `scoreClan` dans `data/pre-gdc-weekly-log.json` afin de suivre l’évolution semaine après semaine.

Comment l’interpréter :

- la “fiabilité du clan” est une `estimation` agrégée à partir de la distribution des membres, pas une formule unique stockée dans un champ dédié.

### Statut `isNew` (Nouveau joueur)

Indique si un joueur est considéré comme "nouveau" dans la famille TrustRoyale. Un joueur est nouveau si **aucune semaine de GDC complétée avec > 0 decks** n'a été trouvée dans l'un des 3 clans familiaux (`FAMILY_CLAN_TAGS`).

**Algorithme** (dans `computeIsNewPlayer`, `playerAnalysis.js:397`) :

1. `hasCompletedWarWeeks` = `totalWeeks > 0` (compte les semaines terminées avec > 0 decks dans un clan familial)
2. `isNewClanArrivee` = `streak < 2` ET `totalWeeks > 1` (joueur transféré entre clans de la famille, pas encore installé)
3. Est "nouveau" si : `isNewClanArrivee` **ou** (`hasCompletedWarWeeks === false` **ou** seule la semaine en cours existe)

**Source de vérité** :

- `playerAnalysis.js:computeIsNewPlayer` — unique fonction de calcul, utilisée par les routes joueur et clan
- Même logique utilisée dans l'API (`/api/player/:tag/analysis` et `/api/clan/:tag/analysis`) et le bot Discord

⚠️ **Régression** : `totalWeeks` (depuis `warHistory.js`) ne compte que les semaines familiales (> 0 decks, non-current). Toute modification de `totalWeeks` doit vérifier que `computeIsNewPlayer` reste cohérent. Toute modification de `computeIsNewPlayer` doit être testée via `analysisService.test.js`.

### Snapshot

Capture persistée de l’état de guerre à un instant donné, utilisée pour reconstituer les deltas journaliers de decks et de points.

Où trouver la valeur :

- `backend/services/snapshot.js` est la logique de lecture/écriture ;
- `/tmp/clash-snapshots` est la destination runtime ;
- `data/snapshots` est la copie persistante ;
- `scripts/collectSnapshots.js` et `scripts/preResetSnapshot.js` produisent ces snapshots.

Champs utiles :

- `snapshotTime` est une `source de vérité` si présente dans le snapshot ;
- `snapshotBackupTime` est une `source de vérité` de secours ;
- `decks` est une `source de vérité` du snapshot ;
- `_cumul` et `_cumulFame` sont des `calculs fiables` persistés pour comparer les jours ;
- les versions `pre-reset` servent de `source de vérité` de secours pour la journée précédant le reset.

### Decks cumul

Total cumulé de decks joués depuis le début de la semaine de guerre pour un joueur ou un clan.

Où trouver la valeur :

- `currentRace.clan.participants[].decksUsed` est la `source de vérité` live ;
- `_cumul` dans les snapshots est une `source de vérité` persistée pour la semaine courante ;
- `decksUsed` dans `warHistory.weeks[]` est un `calcul fiable` basé sur le `riverracelog`.

### Decks journaliers

Nombre de decks joués pendant une seule journée GDC.

Comment le calculer :

- `decks` dans un snapshot journalier est une `source de vérité` si le snapshot est disponible ;
- le delta entre deux cumuls consécutifs est un `calcul fiable` à partir de la source de vérité ;
- `buildCurrentWarDays()` et `warSnapshotDays` servent de `calcul fiable` de reconstitution pour la vue joueur.

### Decks journaliers live

Decks joués pendant le jour courant, par joueur.

Où trouver la valeur :

- `currentRace.clan.participants[].decksUsedToday` est la `source de vérité` pour le jour courant, disponible pour tous les clans du groupe (`currentRace.clans[i].participants[].decksUsedToday`) sans appel supplémentaire.
- `currentRace.clan.participants[].decksUsed` est la `source de vérité` pour le cumul hebdomadaire.
- la semaine live construite dans `buildWarHistory()` avec `isCurrent: true` est un `calcul fiable` d’assemblage.

### Points (fame) cumul

Total de points accumulés depuis le début de la semaine de guerre.

Où trouver la valeur :

- `currentRace.clan.participants[].fame` est la `source de vérité` live ;
- `_cumulFame` dans les snapshots est une `source de vérité` persistée ;
- `warHistory.weeks[].fame` est un `calcul fiable` d’historique.

### Points (fame) journaliers

Points gagnés pendant une seule journée GDC.

Où trouver la valeur :

- `currentRace.clan.periodPoints` (et `currentRace.clans[i].periodPoints`) est la `source de vérité` pour le **jour courant** — disponible sans calcul pour tous les clans du groupe dans un seul appel API.
- `currentRace.periodLogs[i].items[j].pointsEarned` est la `source de vérité` pour les **jours terminés** (J1, J2, J3 disponibles pendant J4 ; disparaît après le reset hebdomadaire du lundi).
- `computeDailyFame(dayEntry, prevDayEntry)` reste un `calcul fiable` de secours (delta `_cumulFame` snapshot) quand `periodLogs` n’est pas disponible (J4 après reset, ou appel échoué).
- `debugSnapshotInfo` expose des valeurs journalières déjà calculées pour le debug.

Structure de `periodLogs` :

```json
{
  "periodLogs": [
    {
      "periodIndex": 3,
      "items": [
        {
          "clan": { "tag": "#LRQP20V9" },
          "pointsEarned": 30500,
          "progressStartOfDay": 0,
          "progressEndOfDay": 3323,
          "endOfDayRank": 0,
          "progressEarned": 3000,
          "numOfDefensesRemaining": 13,
          "progressEarnedFromDefenses": 323
        }
      ]
    }
  ]
}
```

`periodLogs` contient 1 entrée par jour de guerre **terminé** (J1→J3 visibles le J4). L’ordre est chronologique : J1 = `[0]`, J2 = `[1]`, J3 = `[2]`. À utiliser via `periodLogs[WAR_DAY_NUMBER[warDay] - 1]`.

⚠ **Ne pas confondre `pointsEarned` et `progressEarned`** :

- `pointsEarned` = fame de bataille (ex : 30 500) — c’est la valeur à utiliser.
- `progressEarned` = points de classement CR (ex : 3 000) — non pertinent pour les résumés de guerre.

### Points (fame) live

Valeur instantanée observée sur l’API pendant la journée courante.

Où trouver la valeur :

- `currentRace.clan.periodPoints` est la `source de vérité` pour le **jour courant** (tous les clans du groupe via `currentRace.clans[i].periodPoints`). Remplace tout calcul delta snapshot pour la journée en cours.
- `currentRace.clan.participants[].decksUsedToday` est la `source de vérité` pour les decks du jour courant, par joueur.

⚠ **À ne pas utiliser pour les pts du jour** :

- `currentRace.clan.fame` (et `currentRace.clans[i].fame`) = **score de progression de classement** (environ 3 000–10 000), **pas** les points de bataille. C’est l’équivalent de `progressEndOfDay` du dernier jour terminé. Ne jamais l’utiliser comme proxy des points de guerre du clan.
- `sum(currentRace.clan.participants[].fame)` = cumul hebdomadaire des points de bataille depuis J1 — à utiliser pour `currentFame` (total semaine), pas pour les pts du jour.

Comment l’interpréter :

- en `warDay` : `periodPoints` donne directement les pts du jour, pour tous les clans du groupe.
- en `colosseum` : `periodPoints` reste la source de vérité pour le jour courant.

### `periodType`

Indique le type de période fournie par l’API de guerre.

Où trouver la valeur :

- `periodType` est une `source de vérité` issue de l’API Clash Royale.

Comment l’utiliser :

- `periodType === "warDay"` indique une journée de guerre classique ;
- `periodType === "colosseum"` indique une journée de Colisée ;
- les calculs de résumé s’appuient dessus pour décider si la fame doit être cumulée ou soustraite.

---

## Licence

MIT — projet non affilié à Supercell et non approuvé par Supercell.
