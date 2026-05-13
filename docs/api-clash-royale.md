# API Clash Royale — Référence des champs

Ce fichier documente les champs des réponses de l'API Clash Royale utilisés dans TrustRoyale.
L'API est accédée via le proxy `https://proxy.royaleapi.dev/v1` avec la clé `CLASH_API_KEY`.

Chaque section précise **la source de vérité recommandée** pour chaque valeur métier.

---

## `/clans/{clanTag}/currentriverrace`

Retourne l'état de la River Race (GDC) en cours pour un clan.
Un seul appel API suffit pour obtenir les données du clan propre **et** de tous les rivaux du groupe.

### Structure de haut niveau

```json
{
  "state": "warDay",
  "periodType": "warDay",
  "periodIndex": 6,
  "sectionIndex": 0,
  "periodLogs": [...],
  "clan": { ... },
  "clans": [ ... ]
}
```

| Champ          | Type     | Description                                                                                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`        | `string` | État général de la race. Valeurs connues : `"warDay"`, `"training"`.                                                                             |
| `periodType`   | `string` | Type de la période courante. **Source de vérité** pour décider du mode de calcul. Valeurs : `"warDay"` (GDC classique), `"colosseum"` (Colisée). |
| `periodIndex`  | `number` | Index de la journée au sein de la saison (cumulatif).                                                                                            |
| `sectionIndex` | `number` | Index de la semaine dans la saison (0-based : W1 = 0, …, W5 = 4). Utilisé par `computeCurrentWeekId()` / `computePrevWeekId()`.                  |

---

### `clan` — clan propre uniquement

Données du clan pour lequel l'appel est effectué.

```json
"clan": {
  "tag": "#LRQP20V9",
  "name": "...",
  "fame": 9587,
  "repairPoints": 0,
  "finishTime": "...",
  "periodPoints": 28050,
  "clanScore": 122350,
  "participants": [...],
  "attacks": [...]
}
```

| Champ          | Type     |                Source de vérité                 | Description                                                                                                                                                                                                  |
| -------------- | -------- | :---------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tag`          | `string` |                       ✅                        | Tag du clan, préfixé `#`.                                                                                                                                                                                    |
| `name`         | `string` |                       ✅                        | Nom du clan.                                                                                                                                                                                                 |
| `fame`         | `number` | ⚠️ **NE PAS UTILISER pour les pts de bataille** | Score de **progression de classement** du dernier jour terminé (équivalent de `progressEndOfDay` dans `periodLogs`). Valeur typique : 3 000–10 000. **Ne représente pas les pts de combat du jour courant.** |
| `repairPoints` | `number` |                       ✅                        | Points de réparation du bateau.                                                                                                                                                                              |
| `finishTime`   | `string` |                       ✅                        | ISO datetime de fin de la race (si terminée).                                                                                                                                                                |
| `periodPoints` | `number` |             ✅ **Source de vérité**             | **Pts de bataille exacts gagnés par le clan pendant le jour courant.** Valeur typique : 20 000–50 000. Utiliser pour `clanScore` en `warDay`. Disponible aussi dans `clans[i].periodPoints` pour les rivaux. |
| `clanScore`    | `number` |             ✅ **Source de vérité**             | Cumul total de pts de bataille depuis J1 (somme de tous les jours de la semaine). Équivalent à `sum(participants[].fame)`.                                                                                   |
| `participants` | `array`  |                       ✅                        | Liste des joueurs actifs dans la race. Voir section [`participants[]`](#participants) ci-dessous.                                                                                                            |
| `attacks`      | `array`  |                       ✅                        | Liste des attaques de bateau effectuées par le clan.                                                                                                                                                         |

---

### `participants[]` — joueurs du clan (propre ou rival)

Présent dans `clan.participants` (clan propre) et dans `clans[i].participants` (tous les clans du groupe).

```json
{
  "tag": "#ABCDEF",
  "name": "PlayerName",
  "fame": 3200,
  "repairPoints": 0,
  "boatAttacks": 0,
  "decksUsed": 12,
  "decksUsedToday": 3
}
```

| Champ            | Type     |    Source de vérité     | Description                                                                                                                                                                        |
| ---------------- | -------- | :---------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`            | `string` |           ✅            | Tag du joueur.                                                                                                                                                                     |
| `name`           | `string` |           ✅            | Pseudo du joueur au moment de l'appel.                                                                                                                                             |
| `fame`           | `number` |           ✅            | **Cumul hebdomadaire** de pts de bataille depuis J1 pour ce joueur. `sum(participants[].fame)` = `clan.clanScore` = total semaine.                                                 |
| `repairPoints`   | `number` |           ✅            | Points de réparation du bateau apportés par ce joueur.                                                                                                                             |
| `boatAttacks`    | `number` |           ✅            | Nombre d'attaques de bateau effectuées cette semaine.                                                                                                                              |
| `decksUsed`      | `number` | ✅ **Source de vérité** | **Decks joués depuis le début de la semaine** (cumul J1→Jn). Max 16 (4 decks × 4 jours).                                                                                           |
| `decksUsedToday` | `number` | ✅ **Source de vérité** | **Decks joués pendant la journée courante uniquement.** Source directe, sans calcul. Max 4. Disponible pour tous les clans du groupe via `clans[i].participants[].decksUsedToday`. |

---

### `clans[]` — tous les clans du groupe de guerre

Contient les 5 clans du groupe, y compris le clan propre. Itérer pour obtenir les données des rivaux sans appel API supplémentaire.

```json
"clans": [
  {
    "tag": "#LRQP20V9",
    "name": "...",
    "fame": 9587,
    "repairPoints": 0,
    "finishTime": "...",
    "periodPoints": 28050,
    "rank": 1,
    "trophyChange": 452,
    "clanScore": 122350,
    "participants": [...]
  }
]
```

Champs identiques à `clan` (voir ci-dessus), avec en plus :

| Champ          | Type     |    Source de vérité     | Description                                                                                      |
| -------------- | -------- | :---------------------: | ------------------------------------------------------------------------------------------------ |
| `rank`         | `number` |           ✅            | Classement actuel dans le groupe (1 = premier).                                                  |
| `trophyChange` | `number` |           ✅            | Variation de trophées de guerre en fin de semaine (peut être négatif).                           |
| `periodPoints` | `number` | ✅ **Source de vérité** | **Pts de bataille du jour courant pour ce clan rival.** Même sémantique que `clan.periodPoints`. |

> ⚠️ `clans[i].fame` souffre du même problème que `clan.fame` : c'est le score de progression de classement, pas les pts de bataille.

---

### `periodLogs[]` — historique des jours terminés

Disponible pendant la semaine en cours. Contient **une entrée par jour de guerre terminé** (J1→J3 visibles le J4). Disparaît après le reset du lundi.

```json
"periodLogs": [
  {
    "periodIndex": 3,
    "items": [
      {
        "clan": { "tag": "#LRQP20V9", "name": "..." },
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
```

**Indexation** : `periodLogs[0]` = J1 (jeudi), `periodLogs[1]` = J2 (vendredi), `periodLogs[2]` = J3 (samedi).
Pattern d'accès recommandé :

```js
const periodLogIndex = WAR_DAY_NUMBER[warDay] - 1; // 0, 1 ou 2
const item = race.periodLogs?.[periodLogIndex]?.items?.find(
  (item) => item.clan.tag.toUpperCase() === `#${clanTag}`.toUpperCase(),
);
const apiDayFame = item?.pointsEarned ?? null;
```

#### `periodLogs[i].items[j]`

| Champ                        | Type     |    Source de vérité     | Description                                                                                                                                                           |
| ---------------------------- | -------- | :---------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clan.tag`                   | `string` |           ✅            | Tag du clan concerné par cette entrée.                                                                                                                                |
| `pointsEarned`               | `number` | ✅ **Source de vérité** | **Pts de bataille exacts gagnés par le clan pendant ce jour terminé.** Valeur typique : 25 000–40 000. Utiliser pour `totalFame` dans les résumés quotidiens (J1-J3). |
| `progressStartOfDay`         | `number` |           ✅            | Score de progression en début de journée.                                                                                                                             |
| `progressEndOfDay`           | `number` |           ✅            | Score de progression en fin de journée. Correspond à `clan.fame` dans la réponse.                                                                                     |
| `endOfDayRank`               | `number` |           ✅            | Classement du clan à la fin de cette journée.                                                                                                                         |
| `progressEarned`             | `number` |           ⚠️            | Points de **classement** CR gagnés pendant la journée. **≠ pts de bataille.** Valeur typique : 2 000–5 000. Ne pas utiliser pour les résumés de guerre.               |
| `numOfDefensesRemaining`     | `number` |           ✅            | Nombre de défenses de bateau restantes pour ce clan.                                                                                                                  |
| `progressEarnedFromDefenses` | `number` |           ✅            | Part des pts de progression provenant des défenses de bateau.                                                                                                         |

---

## Correspondance champ → usage dans TrustRoyale

| Valeur métier                          | Champ API à utiliser                                                              | Fallback                                      |
| -------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| Pts du jour (clan propre)              | `clan.periodPoints`                                                               | `ownHistoricPpd × decksToday`                 |
| Pts du jour (clan rival)               | `clans[i].periodPoints`                                                           | `rivalAvgPtsPerDeckByTag × decksToday`        |
| Pts du jour terminé (résumé J1-J3)     | `periodLogs[n].items[j].pointsEarned`                                             | delta `_cumulFame` snapshot                   |
| Decks joués aujourd'hui (joueur)       | `participants[].decksUsedToday`                                                   | delta entre deux snapshots                    |
| Decks cumulés semaine (joueur)         | `participants[].decksUsed`                                                        | `_cumul` snapshot                             |
| Cumul fame semaine (clan, currentRace) | `clan.clanScore` = `sum(participants[].fame)` ✅ **Source de vérité**             | snapshot pré-reset `_cumulFamePreReset`       |
| Cumul fame semaine (clan, raceLog)     | ⚠️ Aucun champ fiable — utiliser `sum(participants[].fame)` du snapshot pré-reset | `sum(standings[j].clan.participants[k].fame)` |
| Efficacité pts/deck                    | `periodPoints / sum(decksUsedToday)`                                              | historique `raceLog`                          |
| Type de période                        | `periodType`                                                                      | —                                             |
| Semaine courante (weekId)              | `computeCurrentWeekId(currentRace, raceLog)`                                      | —                                             |

---

## `/clans/{clanTag}/riverracelog`

Retourne l'historique des semaines de guerre **terminées** pour un clan (jusqu'aux dernières semaines selon la pagination).

### Structure de haut niveau

```json
{
  "items": [
    {
      "seasonId": 131,
      "sectionIndex": 3,
      "createdDate": "20260504T095403.000Z",
      "standings": [ ... ]
    }
  ],
  "paging": { "cursors": {} }
}
```

| Champ          | Type     | Description                                                                                                                               |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `seasonId`     | `number` | Identifiant de la saison. Utilisé par `computePrevWeekId()`.                                                                              |
| `sectionIndex` | `number` | Index de la semaine dans la saison (0-based). Utilisé par `computePrevWeekId()`.                                                          |
| `createdDate`  | `string` | Timestamp de **fin de la semaine** (reset du lundi). Format `YYYYMMDDTHHmmss.000Z`. Utile pour borner des requêtes ou afficher des dates. |
| `standings`    | `array`  | Classement final des 5 clans du groupe, triés par rang croissant.                                                                         |

> `items[0]` = semaine la plus récente terminée. `items[1]` = semaine d'avant, etc.

---

### `standings[]`

```json
{
  "rank": 2,
  "trophyChange": 50,
  "clan": { ... }
}
```

| Champ          | Type     | Description                                                               |
| -------------- | -------- | ------------------------------------------------------------------------- |
| `rank`         | `number` | Classement final du clan pour cette semaine (1 = premier).                |
| `trophyChange` | `number` | Variation de trophées de guerre. Positif pour le 1er, négatif pour le 5e. |
| `clan`         | `object` | Données du clan. Voir section ci-dessous.                                 |

---

### `standings[].clan`

```json
{
  "tag": "#LRQP20V9",
  "name": "Les Resistants",
  "fame": 117050,
  "repairPoints": 0,
  "finishTime": "19691231T235959.000Z",
  "periodPoints": 0,
  "clanScore": 3747,
  "participants": [ ... ]
}
```

| Champ          | Type     |    Source de vérité    | Description                                                                                                                                                                                |
| -------------- | -------- | :--------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tag`          | `string` |           ✅           | Tag du clan.                                                                                                                                                                               |
| `name`         | `string` |           ✅           | Nom du clan au moment de la fin de la semaine.                                                                                                                                             |
| `fame`         | `number` |  ⚠️ **Inconsistant**   | Parfois = `sum(participants[].fame)` (GDC classique), parfois = position du bateau (~10 000 en Colisée). **Ne pas utiliser directement** — utiliser `sum(participants[].fame)` à la place. |
| `repairPoints` | `number` |           ✅           | Points de réparation du bateau accumulés sur la semaine.                                                                                                                                   |
| `finishTime`   | `string` |           ✅           | Date de fin anticipée en Colisée. **Si `"19691231T235959.000Z"` (epoch 0) → le clan n'a pas terminé en avance.** Date réelle → fin anticipée (Colisée uniquement).                         |
| `periodPoints` | `number` |   ⚠️ **Toujours 0**    | **Toujours 0 dans `raceLog`.** Ce champ n'est significatif que dans `currentRace`. Ne pas utiliser.                                                                                        |
| `clanScore`    | `number` | ⚠️ **NE PAS UTILISER** | **Trophées de guerre** (`clanWarTrophies`, ~3 000–5 000). ≠ pts de bataille. Ne pas utiliser pour le bilan GDC.                                                                            |

> **⚠️ Piège** : dans `raceLog`, `clan.fame` est **inconsistant** selon le type de semaine (GDC classique vs Colisée). `clan.clanScore` y représente les trophées de guerre, pas les pts de bataille. La seule source fiable est `sum(participants[].fame)`. Pour le total exact de la semaine (= `currentRace.clan.clanScore`), utiliser le **snapshot pré-reset** (`_cumulFamePreReset`) capturé depuis `currentriverrace` avant le reset.

---

### `standings[].clan.participants[]` — joueurs (données hebdomadaires complètes)

```json
{
  "tag": "#ABCDEF",
  "name": "PlayerName",
  "fame": 2750,
  "repairPoints": 0,
  "boatAttacks": 2,
  "decksUsed": 16,
  "decksUsedToday": 0
}
```

| Champ            | Type     |    Source de vérité     | Description                                                                                                                                                               |
| ---------------- | -------- | :---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`            | `string` |           ✅            | Tag du joueur.                                                                                                                                                            |
| `name`           | `string` |           ✅            | Pseudo du joueur.                                                                                                                                                         |
| `fame`           | `number` | ✅ **Source de vérité** | **Total de pts de bataille gagnés par ce joueur sur toute la semaine.** Max théorique ~3 300 (16 decks × ~200 pts/deck). Utilisé dans `warHistory.js` et `warScoring.js`. |
| `boatAttacks`    | `number` |           ✅            | Nombre total d'attaques de bateau effectuées sur la semaine.                                                                                                              |
| `decksUsed`      | `number` | ✅ **Source de vérité** | **Total de decks joués sur toute la semaine.** Max 16 (4 par jour × 4 jours). Utilisé dans `warHistory.js` pour calculer la fiabilité.                                    |
| `decksUsedToday` | `number` |    ⚠️ **Toujours 0**    | **Toujours 0 dans `raceLog`.** Ce champ n'est significatif que dans `currentRace`. Ne pas utiliser.                                                                       |

---

### Usage dans TrustRoyale

| Valeur métier                           | Champ raceLog à utiliser                                             | Utilisé dans                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Semaine précédente (weekId)             | `computePrevWeekId(raceLog)`                                         | `dateUtils.js`                                                                               |
| Total pts de bataille semaine (clan)    | `sum(standings[j].clan.participants[k].fame)` ⚠️ fallback uniquement | snapshot pré-reset `_cumulFamePreReset` (= `clanScore` de `currentRace` capturé avant reset) |
| Total decks semaine (clan)              | `sum(items[i].standings[j].clan.participants[k].decksUsed)`          | `notifyWarSummary.js` (bilan J4, exact)                                                      |
| Total decks semaine (joueur)            | `items[i].standings[j].clan.participants[k].decksUsed`               | `warHistory.js`, `warScoring.js`                                                             |
| Total pts semaine (joueur)              | `items[i].standings[j].clan.participants[k].fame`                    | `warHistory.js`, `warScoring.js`                                                             |
| Classement final de la semaine          | `items[i].standings[j].rank`                                         | `notifyWarSummary.js` (bilan J4)                                                             |
| Variation trophées                      | `items[i].standings[j].trophyChange`                                 | `notifyWarSummary.js` (bilan J4)                                                             |
| Fin anticipée (Colisée)                 | `items[i].standings[j].clan.finishTime` ≠ epoch                      | À implémenter si nécessaire                                                                  |
| Efficacité historique pts/deck (rivaux) | `fame / decksUsed` calculé sur `participants[]`                      | `warHistory.js`                                                                              |

---

## `/locations`

Retourne la liste de toutes les locations (régions et pays) disponibles dans Clash Royale.
Utile pour obtenir l'`id` d'un pays à partir de son nom ou de son code ISO, notamment pour interroger ensuite `/locations/{locationId}/rankings/clanwars`.

```
GET /locations
```

### Structure de la réponse

```json
{
  "items": [
    {
      "id": 57000000,
      "name": "Europe",
      "isCountry": false
    },
    {
      "id": 57000007,
      "name": "Afghanistan",
      "isCountry": true,
      "countryCode": "AF"
    }
  ]
}
```

### Champs utiles

| Champ         | Type      | Description                                                                                |
| ------------- | --------- | ------------------------------------------------------------------------------------------ |
| `id`          | `number`  | Identifiant de la location. À utiliser comme `locationId` dans les endpoints de ranking.   |
| `name`        | `string`  | Nom de la région ou du pays (en anglais).                                                  |
| `isCountry`   | `boolean` | `true` si c'est un pays, `false` si c'est une région (Europe, Asia…).                      |
| `countryCode` | `string`  | Code ISO 3166-1 alpha-2 du pays (ex. `"FR"` pour la France). Absent si `isCountry: false`. |

### Notes

- L'endpoint retourne **toutes les locations en une seule réponse** (pas de pagination nécessaire).
- La France a l'ID `57000087` (`countryCode: "FR"`).
- Les régions (`isCountry: false`) ont des IDs de `57000000` à `57000006`.

---

## `/locations/{locationId}/rankings/clanwars`

Classement national des clans par trophées de guerre.
La location France a l'ID `57000087`.

**Particularité** : l'endpoint retourne une **liste paginée** triée par `clanScore` décroissant.
Il n'est **pas possible de rechercher un clan spécifique** — il faut récupérer suffisamment d'entrées
(via `?limit=N`) pour couvrir le rang attendu, puis filtrer côté client.

```
GET /locations/57000087/rankings/clanwars?limit=500
```

### Structure de la réponse

```json
{
  "items": [
    {
      "tag": "#LRQP20V9",
      "name": "Les Resistants",
      "rank": 323,
      "previousRank": 339,
      "location": {
        "id": 57000087,
        "name": "France",
        "isCountry": true,
        "countryCode": "FR"
      },
      "clanScore": 3817,
      "members": 49,
      "badgeId": 16000036
    }
  ]
}
```

### Champs utiles

| Champ          | Type     | Description                                                                                                                                                                                                                |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`          | `string` | Tag du clan (avec `#`).                                                                                                                                                                                                    |
| `rank`         | `number` | Classement actuel dans la location (1 = meilleur).                                                                                                                                                                         |
| `previousRank` | `number` | Classement la semaine précédente. Permet de calculer la variation (`previousRank - rank` = progression). **`-1` = clan non classé la semaine précédente (nouveau ou réentrant) — ne pas utiliser pour calculer un delta.** |
| `clanScore`    | `number` | Trophées de guerre du clan (≈ `clanWarTrophies` retourné par `/clans/{tag}`). Source de vérité pour le classement.                                                                                                         |
| `members`      | `number` | Nombre de membres du clan au moment de la requête.                                                                                                                                                                         |

### Pièges

- **Limite à fixer explicitement** : sans `?limit=N`, seuls ~50 résultats sont retournés (défaut API). Utiliser `?limit=500` pour couvrir les rangs attendus (~300-400 pour nos clans).
- **`clanScore` ici ≠ `clanScore` dans `currentRace`** : ici c'est le score de trophées de guerre (`clanWarTrophies`), pas les points de bataille cumulés.
- **Délai de mise à jour** : le classement est mis à jour après chaque reset hebdomadaire de GDC, pas en temps réel.
- **Non filtrables par tag** : il faut récupérer la liste et chercher le clan dedans par son `tag`.

### Usage dans TrustRoyale

| Valeur métier               | Champ à utiliser        | Utilisé dans                                       |
| --------------------------- | ----------------------- | -------------------------------------------------- |
| Classement France du clan   | `items[i].rank`         | `clan.js` (`buildClanAnalysis` → `frRank`)         |
| Classement France précédent | `items[i].previousRank` | `clan.js` (`buildClanAnalysis` → `frPreviousRank`) |
| Variation de rang           | `previousRank - rank`   | Frontend vue Clan (calcul local)                   |

---

## `/players/{playerTag}`

Retourne le profil complet d'un joueur Clash Royale.
Le tag doit être encodé URL (ex. `%23YRGJGR8R` pour `#YRGJGR8R`).

```
GET /players/%23YRGJGR8R
```

### Structure de haut niveau

```json
{
  "tag": "#YRGJGR8R",
  "name": "displaynone",
  "expLevel": 76,
  "trophies": 9691,
  "bestTrophies": 9975,
  "wins": 8288,
  "losses": 8474,
  "battleCount": 16762,
  "threeCrownWins": 2930,
  "challengeCardsWon": 1052,
  "challengeMaxWins": 9,
  "tournamentCardsWon": 15,
  "tournamentBattleCount": 77,
  "currentWinLoseStreak": 0,
  "role": "coLeader",
  "donations": 616,
  "donationsReceived": 280,
  "totalDonations": 148846,
  "warDayWins": 32,
  "clanCardsCollected": 36080,
  "starPoints": 13785,
  "expPoints": 296604,
  "clan": { ... },
  "arena": { ... },
  "cards": [ ... ],
  "badges": [ ... ],
  "currentDeck": [ ... ],
  "currentDeckSupportCards": [ ... ],
  "currentFavouriteCard": { ... }
}
```

### Champs principaux

| Champ                   | Type     | Description                                                                      |
| ----------------------- | -------- | -------------------------------------------------------------------------------- |
| `tag`                   | `string` | Tag du joueur (avec `#`).                                                        |
| `name`                  | `string` | Pseudo du joueur.                                                                |
| `expLevel`              | `number` | Niveau d'expérience du joueur.                                                   |
| `trophies`              | `number` | Trophées actuels.                                                                |
| `bestTrophies`          | `number` | Record personnel de trophées.                                                    |
| `wins`                  | `number` | Nombre total de victoires.                                                       |
| `losses`                | `number` | Nombre total de défaites.                                                        |
| `battleCount`           | `number` | Nombre total de batailles jouées.                                                |
| `threeCrownWins`        | `number` | Nombre de victoires 3 couronnes.                                                 |
| `challengeCardsWon`     | `number` | Cartes gagnées en défi.                                                          |
| `challengeMaxWins`      | `number` | Nombre maximum de victoires consécutives en défi classique (12 max).             |
| `tournamentCardsWon`    | `number` | Cartes gagnées en tournoi.                                                       |
| `tournamentBattleCount` | `number` | Nombre total de batailles en tournoi.                                            |
| `currentWinLoseStreak`  | `number` | Série de victoires (positif) ou défaites (négatif) en cours. `0` = pas de série. |
| `role`                  | `string` | Rôle dans le clan. Valeurs : `"member"`, `"elder"`, `"coLeader"`, `"leader"`.    |
| `donations`             | `number` | Dons effectués dans la semaine en cours.                                         |
| `donationsReceived`     | `number` | Dons reçus dans la semaine en cours.                                             |
| `totalDonations`        | `number` | Total cumulé de toutes les cartes données depuis la création du compte.          |
| `warDayWins`            | `number` | Victoires en jour de guerre GDC (cumulatif).                                     |
| `clanCardsCollected`    | `number` | Total de cartes de clan collectées (contribue aux coffres de clan).              |
| `starPoints`            | `number` | Points étoile accumulés (obtenus en améliorant des cartes déjà au niveau max).   |
| `expPoints`             | `number` | Points d'expérience totaux accumulés.                                            |

---

### `clan`

Clan actuel du joueur. **Absent si le joueur n'est dans aucun clan.**

```json
"clan": {
  "tag": "#LRQP20V9",
  "name": "Les Resistants",
  "badgeId": 16000036
}
```

| Champ     | Type     | Description             |
| --------- | -------- | ----------------------- |
| `tag`     | `string` | Tag du clan (avec `#`). |
| `name`    | `string` | Nom du clan.            |
| `badgeId` | `number` | Identifiant du badge.   |

---

### `arena`

Arène actuelle du joueur.

```json
"arena": {
  "id": 54000031,
  "name": "Legendary Arena",
  "rawName": "Arena_L10"
}
```

| Champ     | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `id`      | `number` | Identifiant interne de l'arène.                |
| `name`    | `string` | Nom affiché de l'arène.                        |
| `rawName` | `string` | Identifiant technique de l'arène (asset name). |

---

### `cards[]` — collection de cartes

Liste complète des cartes possédées par le joueur.

```json
{
  "name": "Firecracker",
  "id": 26000064,
  "level": 14,
  "evolutionLevel": 1,
  "maxLevel": 16,
  "maxEvolutionLevel": 1,
  "rarity": "common",
  "count": 4020,
  "elixirCost": 3,
  "iconUrls": {
    "medium": "https://...",
    "evolutionMedium": "https://..."
  }
}
```

| Champ                      | Type     | Description                                                                                         |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`                     | `string` | Nom de la carte.                                                                                    |
| `id`                       | `number` | Identifiant unique de la carte.                                                                     |
| `level`                    | `number` | Niveau actuel de la carte pour ce joueur.                                                           |
| `maxLevel`                 | `number` | Niveau maximum atteignable pour cette carte (varie selon la rareté).                                |
| `evolutionLevel`           | `number` | Niveau d'évolution actuel. **Absent si la carte n'est pas évoluée (ou non évoluable).**             |
| `maxEvolutionLevel`        | `number` | Niveau d'évolution maximum. **Absent si la carte n'est pas évoluable.**                             |
| `rarity`                   | `string` | Rareté de la carte. Valeurs : `"common"`, `"rare"`, `"epic"`, `"legendary"`, `"champion"`.          |
| `count`                    | `number` | Nombre d'exemplaires en possession. `0` si la carte est au niveau max ou en deck (non accumulable). |
| `elixirCost`               | `number` | Coût en élixir pour jouer la carte.                                                                 |
| `iconUrls.medium`          | `string` | URL de l'image de la carte (300 px).                                                                |
| `iconUrls.evolutionMedium` | `string` | URL de l'image de la version évoluée. **Absent si non évoluable.**                                  |

---

### `badges[]` — badges de maîtrise et autres

Liste des badges obtenus par le joueur (maîtrise de cartes, achievements…).

```json
{
  "name": "MasteryFirecracker",
  "level": 6,
  "maxLevel": 10,
  "progress": 6,
  "target": 7,
  "iconUrls": {
    "large": "https://..."
  }
}
```

| Champ            | Type     | Description                                        |
| ---------------- | -------- | -------------------------------------------------- |
| `name`           | `string` | Identifiant du badge (ex. `"MasteryFirecracker"`). |
| `level`          | `number` | Niveau actuel du badge.                            |
| `maxLevel`       | `number` | Niveau maximum du badge.                           |
| `progress`       | `number` | Progression actuelle vers le prochain niveau.      |
| `target`         | `number` | Valeur cible pour atteindre le prochain niveau.    |
| `iconUrls.large` | `string` | URL de l'image du badge (512 px).                  |

---

### `currentDeck[]` — deck actuel (8 cartes)

Deck équipé actuellement par le joueur. Même structure que `cards[]` avec les champs supplémentaires :

| Champ       | Type     | Description                                                               |
| ----------- | -------- | ------------------------------------------------------------------------- |
| `starLevel` | `number` | Niveau d'étoile cosmétique de la carte (1–3). **Absent si non appliqué.** |

> `count: 0` dans le deck actuel signifie que la carte est en usage (non accumulable tant qu'elle est équipée).

---

### `currentDeckSupportCards[]` — cartes de soutien

Cartes de soutien équipées (ex. Tour Princesse). Structure identique à `currentDeck[]`.

```json
{
  "name": "Tower Princess",
  "id": 159000000,
  "level": 16,
  "maxLevel": 16,
  "rarity": "common",
  "count": 0,
  "iconUrls": { "medium": "https://..." }
}
```

---

### `currentFavouriteCard` — carte favorite

Carte mise en avant sur le profil du joueur.

```json
{
  "name": "Bomb Tower",
  "id": 27000004,
  "maxLevel": 14,
  "elixirCost": 4,
  "rarity": "rare",
  "iconUrls": { "medium": "https://..." }
}
```

Champs identiques à `cards[]` (sans `level`, `count`, `evolutionLevel`).

---

### Usage dans TrustRoyale

| Valeur métier       | Champ à utiliser | Utilisé dans                                                          |
| ------------------- | ---------------- | --------------------------------------------------------------------- |
| Tag du joueur       | `tag`            | `clashApi.js`, `playerAnalysis.js`                                    |
| Rôle dans le clan   | `role`           | `playerAnalysis.js` (affichage)                                       |
| Dons de la semaine  | `donations`      | `warScoring.js` (`scoreTotalDonations`)                               |
| Dons totaux         | `totalDonations` | `warScoring.js` (`scoreTotalDonations`) — source de vérité cumulative |
| Victoires GDC       | `warDayWins`     | `playerAnalysis.js` (stats affichées)                                 |
| Niveau d'expérience | `expLevel`       | Affiché dans le profil joueur                                         |
| Clan actuel         | `clan.tag`       | Détection transfert familial (`isFamilyTransfer`)                     |
| Deck actuel         | `currentDeck[]`  | Affiché dans le profil joueur                                         |
