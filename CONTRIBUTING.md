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

### Notes sur les scripts de snapshots

- Les snapshots sont écrits en priorité dans /tmp/clash-snapshots à l’exécution.
- Quand le dossier data/snapshots est accessible, une copie persistante y est aussi écrite.
- À la lecture, loadSnapshots() privilégie /tmp puis fusionne avec data/snapshots si les deux existent.
- La fusion se fait jour par jour avec mergeSnapshotsByDay(), en gardant le snapshot valide le plus récent pour chaque journée.

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

---

## Formules et scoring

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

### Score de fiabilité guerre, mode complet

Le mode complet est utilisé quand l’historique River Race permet de calculer une `warHistory` exploitable.
La fonction source est `computeWarScore()` dans `backend/services/warScoring.js`.

Condition d’activation précise :

- côté joueur, `playerAnalysis.js` bascule vers le mode complet si l’historique contient assez de matière pour le score, avec au minimum une vraie semaine terminée dans le clan ou une continuité de famille suffisamment longue ;
- le code n’impose pas “X jours de présence” comme règle fixe ; il s’appuie sur la profondeur de `raceLog`, la présence de `streakInFamily` / `streakInCurrentClan` et le test `hasEnoughHistory` ;
- si l’historique famille est inexistant ou trop faible, on reste en `fallback`.

Durée récupérable depuis l’API :

- `fetchRaceLog()` récupère le `riverracelog` du clan, documenté dans le code comme les `last ~10 completed seasons` ;
- `fetchCurrentRace()` ajoute la semaine live en cours ;
- en pratique, la fenêtre exploitable est donc `~10` saisons terminées + `1` semaine courante, sous réserve de ce que l’API renvoie réellement.

Critères :

| #   | Critère            | Maximum | Règle actuelle                                                                                          |
| --- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Régularité         | 12      | Proportion de decks joués sur les semaines terminées, avec pénalité de 0,5 point par semaine incomplète |
| 2   | Score moyen        | 10      | Moyenne de points hebdomadaires, avec plage utile 1000 à 3000                                           |
| 3   | Stabilité          | 8       | 5 semaines consécutives dans le clan ou la famille donnent le maximum                                   |
| 4   | Expérience         | 3       | Basée sur les trophées actuels, plage 4000 à 14000                                                      |
| 5   | Dons               | 2       | Basé sur totalDonations, cap à 100000                                                                   |
| 6   | Win rate guerre    | 3       | Ajouté seulement si le battle log permet un taux exploitable                                            |
| 7   | Badge CW2          | 8       | Cap à 250 victoires CW2                                                                                 |
| 8   | Dernière connexion | 5       | Ajoutée seulement si lastSeen est disponible                                                            |
| 9   | Discord            | 2       | Compte Discord lié                                                                                      |

Maxima réels :

- 45 points : sans win rate et sans lastSeen, avec Discord inclus.
- 48 points : avec win rate, sans lastSeen.
- 50 points : sans win rate, avec lastSeen.
- 53 points : avec win rate et lastSeen.

Règle importante d’assainissement de l’historique :

- si un joueur a au moins deux semaines passées dans l’historique et que la plus ancienne est incomplète, cette semaine peut être marquée ignored pour ne pas pénaliser une arrivée en cours de guerre ;
- elle reste visible dans l’historique, mais ne compte plus dans les moyennes utiles au score.

### Score de fiabilité guerre, mode fallback

Le mode fallback est utilisé quand l’historique River Race est insuffisant ou indisponible.
La fonction source est `computeWarReliabilityFallback()` dans `backend/services/warScoring.js`.

Quand il s’active :

- le `riverracelog` n’existe pas, est partiel, ou n’apporte pas assez d’éléments pour un score complet ;
- le `battlelog` du joueur reste la source de vérité restante ;
- si l’API de guerre ne fournit plus de combats GDC, le code peut utiliser `currentRace` pour récupérer les `decksUsed` live du jour courant et éviter un zéro artificiel.

Durée récupérable depuis l’API :

- `fetchBattleLog()` récupère les `25` derniers combats d’un joueur ;
- ces combats mélangent guerre, ladder et challenges, donc le fallback doit les filtrer pour extraire la guerre ;
- quand le `battlelog` est trop court ou trop écrasé par des combats non-GDC, le calcul devient moins fiable et peut retomber sur des approximations.

Critères :

| #   | Critère            | Maximum | Règle actuelle                                                                                                                                              |
| --- | ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Activité GDC       | 8       | Basée sur les decks par jour dans une fenêtre glissante de 14 jours, avec bonus pour les journées complètes et légère pénalité pour les journées partielles |
| 2   | Activité générale  | 8       | Basée sur les combats compétitifs, pondérée par la part de combats GDC                                                                                      |
| 3   | Badge CW2          | 10      | Cap à 250 victoires CW2                                                                                                                                     |
| 4   | Dernière connexion | 3       | Ajoutée si lastSeen est disponible                                                                                                                          |
| 5   | Expérience         | 3       | Basée sur les trophées actuels                                                                                                                              |
| 6   | Dons               | 2       | Basé sur totalDonations                                                                                                                                     |
| 7   | Discord            | 2       | Compte Discord lié                                                                                                                                          |

Maxima réels :

- 33 points : sans lastSeen, avec Discord inclus.
- 36 points : avec lastSeen et avec Discord inclus.

Particularités :

- si le battle log ne contient plus de combats GDC mais que currentRace expose encore des decks utilisés, le code peut synthétiser une activité minimale du jour pour éviter un zéro artificiel ;
- le fallback ne calcule plus de critère win rate séparé ;
- l’activité GDC est plafonnée par un niveau de confiance basé sur le volume de combats observés.

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
score = min(40, scoreTotalDonations(totalDonations, 40))
      + min(40, trophies / 10000 × 40)
      + min(20, expLevel / 60 × 20)
```

Notes :

- `totalDonations` est une `source de vérité` venant du profil joueur ;
- `trophies` et `expLevel` sont des `sources de vérité` venant aussi du profil joueur ;
- `scoreTotalDonations()` est un `calcul fiable` à partir de `totalDonations` ;
- le score final est une `estimation` légère ramenée sur `100` et sert surtout à trier/filtrer la vue clan ;
- les seuils associés dans la vue clan sont : `75+`, `61-74`, `31-60`, `0-30`.

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
Le traitement des points y reste cumulatif à l’échelle de la semaine.

Où le trouver :

- `periodType` est une `source de vérité` renvoyée par l’API de guerre ;
- la logique de résumé dans `scripts/notifyWarSummary.js` est un `calcul fiable` pour convertir ce contexte en résumé quotidien.

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

Comment l’interpréter :

- la “fiabilité du clan” est une `estimation` agrégée à partir de la distribution des membres, pas une formule unique stockée dans un champ dédié.

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

### Decks live

Valeur instantanée issue de l’API en cours de journée, non figée par snapshot.

Où trouver la valeur :

- `currentRace.clan.participants[].decksUsed` est la `source de vérité` live ;
- la semaine live construite dans `buildWarHistory()` avec `isCurrent: true` est un `calcul fiable` d’assemblage.

### Points (fame) cumul

Total de points accumulés depuis le début de la semaine de guerre.

Où trouver la valeur :

- `currentRace.clan.participants[].fame` est la `source de vérité` live ;
- `_cumulFame` dans les snapshots est une `source de vérité` persistée ;
- `warHistory.weeks[].fame` est un `calcul fiable` d’historique.

### Points (fame) journaliers

Points gagnés pendant une seule journée GDC.

Comment le calculer :

- `computeDailyFame(dayEntry, prevDayEntry)` est un `calcul fiable` à partir des cumuls ;
- le cumul du jour et celui du jour précédent sont des `sources de vérité` prises dans `_cumulFame` ;
- `debugSnapshotInfo` expose des valeurs journalières déjà calculées pour le debug.

### Points (fame) live

Valeur instantanée observée sur l’API pendant la journée courante.
Elle peut rester cumulative sur la semaine, selon le contexte warDay ou Colisée.

Où trouver la valeur :

- `currentRace.clan.participants[].fame` est la `source de vérité` live.

Comment l’interpréter :

- en `warDay`, le score journalier est souvent un `calcul fiable` obtenu par soustraction du cumul précédent ;
- en `colosseum`, la valeur peut rester un cumul natif et donc être une `source de vérité` déjà exploitable telle quelle.

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
