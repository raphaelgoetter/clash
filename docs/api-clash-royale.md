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

| Valeur métier                      | Champ API à utiliser                           | Fallback                               |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------- |
| Pts du jour (clan propre)          | `clan.periodPoints`                            | `ownHistoricPpd × decksToday`          |
| Pts du jour (clan rival)           | `clans[i].periodPoints`                        | `rivalAvgPtsPerDeckByTag × decksToday` |
| Pts du jour terminé (résumé J1-J3) | `periodLogs[n].items[j].pointsEarned`          | delta `_cumulFame` snapshot            |
| Decks joués aujourd'hui (joueur)   | `participants[].decksUsedToday`                | delta entre deux snapshots             |
| Decks cumulés semaine (joueur)     | `participants[].decksUsed`                     | `_cumul` snapshot                      |
| Cumul fame semaine (clan)          | `sum(participants[].fame)` ou `clan.clanScore` | `_cumulFame` snapshot                  |
| Efficacité pts/deck                | `periodPoints / sum(decksUsedToday)`           | historique `raceLog`                   |
| Type de période                    | `periodType`                                   | —                                      |
| Semaine courante (weekId)          | `computeCurrentWeekId(currentRace, raceLog)`   | —                                      |

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

| Champ          | Type     |    Source de vérité     | Description                                                                                                                                                                                        |
| -------------- | -------- | :---------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`          | `string` |           ✅            | Tag du clan.                                                                                                                                                                                       |
| `name`         | `string` |           ✅            | Nom du clan au moment de la fin de la semaine.                                                                                                                                                     |
| `fame`         | `number` | ⚠️ **NE PAS UTILISER**  | Score de **progression du bateau** dans la course (usage interne). Valeur typique : quelques milliers de points. **Ne représente pas les pts de bataille de la semaine.**                          |
| `repairPoints` | `number` |           ✅            | Points de réparation du bateau accumulés sur la semaine.                                                                                                                                           |
| `finishTime`   | `string` |           ✅            | Date de fin anticipée en Colisée. **Si `"19691231T235959.000Z"` (epoch 0) → le clan n'a pas terminé en avance.** Date réelle → fin anticipée (Colisée uniquement).                                 |
| `periodPoints` | `number` |    ⚠️ **Toujours 0**    | **Toujours 0 dans `raceLog`.** Ce champ n'est significatif que dans `currentRace`. Ne pas utiliser.                                                                                                |
| `clanScore`    | `number` | ✅ **Source de vérité** | **Cumul total des pts de bataille de la semaine.** Même sémantique que `clan.clanScore` dans `currentRace`. Valeur typique : 80 000–130 000. C'est le champ à utiliser pour le bilan hebdomadaire. |

> **Note** : `clan.clanScore` a la **même sémantique** dans `currentRace` et dans `raceLog` : cumul total des pts de bataille de la semaine. `clan.fame` dans `raceLog` est un score interne de progression du bateau — à ne pas utiliser pour les pts de bataille.

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

| Valeur métier                           | Champ raceLog à utiliser                                    | Utilisé dans                                             |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Semaine précédente (weekId)             | `computePrevWeekId(raceLog)`                                | `dateUtils.js`                                           |
| Total pts de bataille semaine (clan)    | `items[i].standings[j].clan.clanScore`                      | `warHistory.js`, `notifyWarSummary.js` (bilan J4, exact) |
| Total decks semaine (clan)              | `sum(items[i].standings[j].clan.participants[k].decksUsed)` | `notifyWarSummary.js` (bilan J4, exact)                  |
| Total decks semaine (joueur)            | `items[i].standings[j].clan.participants[k].decksUsed`      | `warHistory.js`, `warScoring.js`                         |
| Total pts semaine (joueur)              | `items[i].standings[j].clan.participants[k].fame`           | `warHistory.js`, `warScoring.js`                         |
| Classement final de la semaine          | `items[i].standings[j].rank`                                | `notifyWarSummary.js` (bilan J4)                         |
| Variation trophées                      | `items[i].standings[j].trophyChange`                        | `notifyWarSummary.js` (bilan J4)                         |
| Fin anticipée (Colisée)                 | `items[i].standings[j].clan.finishTime` ≠ epoch             | À implémenter si nécessaire                              |
| Efficacité historique pts/deck (rivaux) | `fame / decksUsed` calculé sur `participants[]`             | `warHistory.js`                                          |

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

| Champ          | Type     | Description                                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `tag`          | `string` | Tag du clan (avec `#`).                                                                                            |
| `rank`         | `number` | Classement actuel dans la location (1 = meilleur).                                                                 |
| `previousRank` | `number` | Classement la semaine précédente. Permet de calculer la variation (`previousRank - rank` = progression).           |
| `clanScore`    | `number` | Trophées de guerre du clan (≈ `clanWarTrophies` retourné par `/clans/{tag}`). Source de vérité pour le classement. |
| `members`      | `number` | Nombre de membres du clan au moment de la requête.                                                                 |

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
