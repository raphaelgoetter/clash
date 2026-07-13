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
- Les commandes Discord manuelles `/champion-start` et `/champion-end` (`api/discord/handlers/championPredictions.js`) : elles postent directement dans le salon résolu via l'API Discord (token bot), avec une confirmation éphémère à l'endroit où la commande a été tapée — au lieu de répondre dans le salon/thread d'où la commande est lancée.

Scripts **non concernés** (restent dans le salon principal ou le salon staff) : `notifyPreWarSummary.js`, `notifyGdcLaunch.js`, `notifyRules.js`, `notifyClanStatus.js`.

Actuellement seul le clan 2 (`LRQP20V9`) a sa variable `DISCORD_THREAD_MEMBERS_LRQP20V9` renseignée (thread `1523295989044088964`), à titre de test. Pour étendre à un autre clan :

1. Renseigner `DISCORD_THREAD_MEMBERS_<TAG>` dans `.env` (local).
2. Ajouter le secret GitHub Actions du même nom dans les workflows concernés (`snapshot.yml`, `last-seen.yml`, `war-summary.yml`).

Aucun changement de code n'est nécessaire pour étendre le test à un autre clan (sauf pour les pronostics, qui ignorent volontairement le thread — voir plus haut).

### Planification des scripts automatiques (GitHub Actions)

Tous les horaires ci-dessous sont définis en UTC dans les workflows (`.github/workflows/`). L'heure de Paris correspond à UTC+2 en été (CEST) et UTC+1 en hiver (CET).

| Script                                                  | Workflow                 | Jour(s)                                       | Horaire UTC       | Horaire Paris (été/hiver) | Salon Discord                         |
| ------------------------------------------------------- | ------------------------ | --------------------------------------------- | ----------------- | ------------------------- | ------------------------------------- |
| `collectSnapshots.js` (`npm run snapshot`)              | `snapshot.yml`           | Tous les jours                                | Toutes les heures | —                         | Aucun post (données uniquement)       |
| `notifyMemberChanges.js` (`npm run notify-members`)     | `snapshot.yml`           | Tous les jours                                | Toutes les heures | —                         | Salon membres (ou thread test clan 2) |
| `refreshClanCache.js` (`npm run cache`)                 | `snapshot.yml`           | Tous les jours                                | Toutes les heures | —                         | Aucun post (cache statique)           |
| `preResetSnapshot.js`                                   | `pre-reset-snapshot.yml` | Ven, Sam, Dim, Lun                            | 07:30             | 09:30 / 08:30             | Aucun post (données uniquement)       |
| `notifyWarSummary.js`                                   | `war-summary.yml`        | Tous les jours (poste ven/sam/dim/lun)        | 10:05             | 12:05 / 11:05             | Salon membres (ou thread test clan 2) |
| `notifyClanStatus.js`                                   | `war-summary.yml`        | Tous les jours (idem)                         | 10:05             | 12:05 / 11:05             | Salon staff (`DISCORD_CHANNEL_STAFF`) |
| `notifyLastSeen.js`                                     | `last-seen.yml`          | Tous les jours                                | 10:08             | 12:08 / 11:08             | Salon membres (ou thread test clan 2) |
| `notifyGdcLaunch.js`                                    | `gdc-launch.yml`         | Jeudi                                         | 10:30             | 12:30 / 11:30             | Salon membres principal               |
| `notifyPreWarSummary.js` (`npm run pre-war-summary`)    | `pre-war-summary.yml`    | Mercredi                                      | 14:00             | 16:00 / 15:00             | Salon membres principal               |
| `notifyRules.js`                                        | `rules.yml`              | Mardi (le script ne poste que le 1er du mois) | 14:00             | 16:00 / 15:00             | Salon membres principal               |
| `autoStartPredictions.js` (`npm run predictions:start`) | `predictions.yml`        | Mardi                                         | 08:00             | 10:00 / 09:00             | Salon membres principal               |
| `autoEndPredictions.js` (`npm run predictions:end`)     | `predictions.yml`        | Lundi                                         | 12:00             | 14:00 / 13:00             | Salon membres principal               |

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

La variable de plafonnement utilisée ici s'appelle **Engagement GDC**. Elle est calculée au niveau du clan à partir de l'intersection entre le roster du clan et les participants de la guerre en cours qui ont déjà joué au moins un deck cette semaine :

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
Il est calculé en analysant les derniers combats de guerre (ou, à défaut, tous les combats compétitifs disponibles) et en associant cinq critères pondérés.

Généralités :

- Le matchup d’un combat est calculé à partir d’une base de `50%` et d’un total de critères compris entre `-50` et `+50`.
- `analysis.matchup.average` est la moyenne des matchups de combat sur les batailles GDC récentes.
- Si le `battleLog` ne contient aucune bataille de guerre, la moyenne est calculée sur les derniers combats compétitifs disponibles.

#### Critères et pondération

- `deckScore` (±15) :
  - Écart de niveau des cartes dans le deck joué.
  - Max atteint dès qu’il y a un écart d’au moins `10` points entre les deux forces de deck.
- `collectionScore` (±10) :
  - Écart de niveau de collection (total de toutes les cartes + nombre d'évo et de héros)
  - Max atteint pour un écart de collection de `100` points ou plus.
- `cw2Score` (±5) :
  - Écart relatif de victoires CW2.
  - Max atteint pour une différence de `50 %` ou plus.
- `winRateScore` (±5) :
  - Écart de winrate.
  - Max atteint pour une différence de `50` points de pourcentage ou plus.
- `trophyScore` (±15) :
  - Écart de trophées.
  - Max atteint pour une différence de `1000` ou plus.

#### Formule de calcul

```text
deckScore = clamp(opponentDeckStrength - playerDeckStrength, -10, 10) × 1.5
collectionScore = clamp((opponentCollectionLevel - playerCollectionLevel) / 100, -1, 1) × 10
cw2Score = clamp((opponentCw2Wins - playerCw2Wins) / max(1, opponentCw2Wins), -0.5, 0.5) × 10
winRateScore = clamp(opponentWinRateBaseline - playerWinRate, -0.5, 0.5) × 10
trophyScore = clamp((opponentTrophies - playerTrophies) / 1000, -1, 1) × 15

total = deckScore + collectionScore + cw2Score + winRateScore + trophyScore
Tension combat (%) = clamp(50 + total, 0, 100)
```

#### Interprétation

- `0%` : matchup très confortable.
- `50%` : matchup moyen, combat équilibré.
- `100%` : matchup très tendu (opposant très supérieur)

#### Source de vérité

- Fonction de référence : `backend/services/battleLogUtils.js`
- Formule principale : `computeBattleMatchup()`
- Agrégation : `computeMatchupFromBattleLog()`

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
- Activité GDC : 8. Basée uniquement sur le nombre de semaines GDC récupérées, avec maximum atteint à partir de 5 semaines récupérées.
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

## Détection des arrivées en cours de GDC

### Contexte

Plusieurs commandes Discord doivent distinguer les membres « installés » (présents toute la semaine de GDC) des membres « arrivés en cours de GDC » (nouveaux recruits, transferts). Les nouveaux arrivants ne doivent pas être pénalisés dans les listes de sous-quota ou de fail.

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
| `/quota`  | `api/discord/interactions.js:2017-2026` | Exclut les arrivés en cours de GDC de la liste des sous-quota                  |

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
