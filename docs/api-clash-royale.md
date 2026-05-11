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
| `clanScore`    | `number` |                       ✅                        | Cumul total de pts de bataille depuis J1 (somme de tous les jours de la semaine). Équivalent à `sum(participants[].fame)`.                                                                                   |
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
