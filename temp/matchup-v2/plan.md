# Refonte de l'algorithme de %matchup (`/matchup`)

## Contexte

L'algorithme actuel de `computeBattleMatchup()` (dans `backend/services/battleLogUtils.js:270-331`) calcule le %matchup à partir de 5 critères pondérés : force de deck (`normLevel` des cartes), niveau de collection, victoires CW2, win rate, trophées — des signaux **de compte joueur**, dont 4 sur 5 dépendent de statistiques adverses souvent absentes.

L'utilisateur souhaite le remplacer par un algorithme purement **tactique, deck-vs-deck** (archétypes, counters directs, structure du deck, écart de niveau de cartes), fourni sous forme de system prompt LLM (`temp/matchup-v2/gemini-code-1784305026864.md`) accompagné d'un catalogue JSON de 21 win conditions meta avec leurs hard/soft counters (`temp/matchup-v2/clash_royale_matchup_data.json`).

**Décisions validées avec l'utilisateur :**
1. Réimplémentation en **JS déterministe pur** (pas d'appel LLM) — cohérent avec l'usage actuel (calcul par bataille, potentiellement des dizaines de fois par exécution de `/matchup`).
2. Le nouvel algorithme remplace `computeBattleMatchup` **partout** (affecte à la fois le %matchup affiché par deck de guerre dans `/matchup` et `analysis.matchup.average` utilisé dans l'analyse joueur globale) — une seule source de vérité.
3. Si la win condition d'un deck n'est pas dans le catalogue (Balloon, Sparky, Furnace...) : comportement **neutre**, Layers 1 et 2 ne s'appliquent pas (0%), seuls Layers 3 et 4 restent actifs.

Les données fournies (system prompt + JSON) sont **suffisantes** pour cette refonte : les decks de bataille (`battle.team[0].cards` / `battle.opponent[0].cards`) contiennent déjà `{name, level, rarity}` au format officiel de l'API Clash Royale, ce qui correspond exactement à l'input attendu par les 4 layers du prompt. Les seules données manquantes (catégories Small/Big Spells, Defensive Buildings, Tank Killers) sont données en dur dans le texte du markdown et seront recopiées en constantes JS.

## ⚠️ Piège critique : convention de signe

Le `matchup` actuel n'est **pas** l'avantage du joueur mais la **difficulté du combat pour lui** (confirmé par la doc `frontend/public/bot/index.html:223-228` : *"0% : très confortable ... 100% : très tendu"*, et par les tests existants). Le nouveau moteur (issu du markdown) calcule `scoreA` = avantage du Deck A (100 = A écrase B). Il faut donc **inverser** :

```js
difficulty = (100 - scoreA) / 100   // scoreA = score du deck du joueur
```

Oublier cette inversion produirait des % silencieusement inversés (un matchup facile affiché comme difficile), sans crash — vigilance particulière à ce point lors de l'implémentation et des tests.

## Fichiers à créer

- **`data/clash-royale-matchup-catalog.json`** — copie du catalogue fourni (21 win conditions, `name`/`archetype`/`hardCounters`/`softCounters`), déplacé dans `data/` pour suivre la convention du repo.
- **`backend/services/matchupCatalog.js`** — données statiques pures, chargées via `createRequire` (pattern JSON-en-ESM déjà robuste sous Vercel) :
  - `normalizeCardName(name)` : normalisation (lowercase, suppression ponctuation/accents) pour absorber les divergences de nommage API (ex. `"P.E.K.K.A."` vs `"P.E.K.K.A"`).
  - `WIN_CONDITIONS_BY_NAME` (Map indexée par nom normalisé).
  - `ARCHETYPE_ADVANTAGE` (table Layer 1, directionnelle) :
    ```js
    { Beatdown: ["Siege", "Control"], Cycle: ["Beatdown"], Control: ["Bridge Spam", "Cycle"],
      Bait: ["Control"], Siege: ["Bait", "Bridge Spam"] }
    ```
  - `SMALL_SPELLS`, `BIG_SPELLS`, `DEFENSIVE_BUILDINGS`, `TANK_KILLERS`, `HEAVY_BEATDOWN_WIN_CONDITIONS`, `SPLIT_PUSH_TRIGGER_CARDS` — listes littérales recopiées du markdown (commentaire citant la source).
- **`backend/services/matchupEngine.js`** — moteur pur (aucune I/O, aucune dépendance à `battleLogUtils.js`), testable isolément avec de simples tableaux `{name, level, rarity}` :
  - `identifyWinConditions(deckCards)` → toutes les entrées du catalogue matchées (0, 1 ou plusieurs).
  - `computeArchetypeLayer`, `computeCounterLayer`, `computeUtilityLayer`, `computeLevelDifferentialLayer` (Layers 1 à 4).
  - `computeDeckMatchupScore(deckACards, deckBCards)` → `{ scoreA, scoreB, breakdown, winConditionsA, winConditionsB }`.
- **`backend/services/matchupEngine.test.js`** — tests unitaires (voir section Vérification).

## Règles de conception à respecter dans l'implémentation

- **Win conditions multiples** (ex. deck Hog + Miner) : moyenne arithmétique des contributions Layer 1 et Layer 2 calculées indépendamment pour chaque win condition matchée. Pas de "win condition principale" arbitraire (aucune donnée du catalogue ne permettrait de la déterminer proprement).
- **Win condition inconnue d'un des deux decks** : Layer 1 **et** Layer 2 neutralisés pour toute la bataille (pas seulement côté inconnu, pour éviter une évaluation asymétrique). Layer 3 et Layer 4 restent actifs.
- **Layer 2, cas "exactement 1 soft counter"** : non couvert par le texte source (qui ne traite que 0 counter et ≥2 soft counters) → traité comme neutre (0).
- **Layer 3** scanne les noms de cartes bruts du deck (pas seulement via `identifyWinConditions`), pour rester actif même sur un deck à win condition inconnue (ex. deck Balloon + Goblin Barrel doit quand même déclencher le check Bait).
- **Layer 4** : utiliser `normLevel()` (offset de rareté, déjà utilisé partout ailleurs dans `battleLogUtils.js`/`collectionConstants.js`) plutôt que le niveau brut 1-16 du texte source — écart assumé et à documenter en commentaire, pour rester cohérent avec le reste du fichier (le niveau brut pénaliserait injustement les decks riches en légendaires/champions).

## Fichiers à modifier

- **`backend/services/battleLogUtils.js`** :
  - Supprimer `normalizeDeckStrength` et `deckStrengthFromBattle` (obsolètes).
  - Ajouter `deckCardsFromBattle(battle)` (extrait les tableaux de cartes bruts).
  - Réécrire `computeBattleMatchup(battle)` en adaptateur fin vers `computeDeckMatchupScore`, avec l'inversion de signe décrite plus haut. Le paramètre `options` (signaux compte-joueur) devient sans effet mais reste accepté pour compat d'appel.
  - `summarizeWarDecksForMatchup` : supprimer le bloc `opponentMeta`/`matchupOptions` (devenu mort), simplifier l'appel en `computeBattleMatchup(battle)`.
- **`api/discord/interactions.js`** : supprimer `buildOpponentStatsByTag` et `extractOpponentTagsFromBattleLog` (lignes ~1088-1100+), et les 3 appels correspondants (~lignes 3739, 3757, 3776) devenus morts — confirmé par grep qu'ils ne servent qu'à peupler les anciens signaux compte-joueur. Bonus : supprime jusqu'à plusieurs appels HTTP réseau par exécution de `/matchup`.
- **`backend/services/playerAnalysis.js`** (ligne ~102) : simplification cosmétique de l'appel à `computeMatchupFromBattleLog`, shape de `analysis.matchup.average` inchangée.
- **`backend/services/analysisService.test.js`** : les assertions `extremeMatchupHigh >= 0.99` / `extremeMatchupLow <= 0.01` / `measuredMatchup >= 0.8` (lignes ~284, 313, 342) vont casser — la somme maximale des 4 layers est ±90 (15+25+15+35, borné à 100), donc les bornes doivent être recalculées à la main une fois le moteur implémenté (probablement resserrées, ex. `>= 0.75`/`<= 0.25`), car les decks de test ("A".."H") ne matchent aucune win condition du catalogue.
- **`package.json`** : ajouter `matchupEngine.test.js` au script `test`.
- **`frontend/public/bot/index.html`** (section `#matchup`, ~lignes 192-231, priorité basse) : la doc décrit la formule à 5 critères pondérés, devenue fausse — à remplacer par une description des 4 layers, en conservant l'interprétation 0%/50%/100% inchangée côté utilisateur.

Ne pas toucher au format de sortie Discord (embed, emoji ⚡) — seul le calcul du nombre change.

## Séquencement

1. `data/clash-royale-matchup-catalog.json` + `matchupCatalog.js` (données, zéro risque).
2. `matchupEngine.js` + `matchupEngine.test.js` (moteur pur, testable isolément).
3. Intégration dans `battleLogUtils.js` (point le plus sensible — inversion de signe).
4. Correction des tests existants cassés (`analysisService.test.js`).
5. Nettoyage `interactions.js` (code mort).
6. `playerAnalysis.js` (cosmétique).
7. Doc `frontend/public/bot/index.html`.

## Vérification

- **Tests unitaires `matchupEngine.test.js`** (style `assert` natif, cohérent avec l'existant) :
  1. Win condition connue avec hard counter présent → `layer2 = -15`.
  2. Win condition connue sans aucun counter → `layer2 = +15`.
  3. Win condition inconnue (ex. carte hors catalogue) vs deck connu → `layer1 === 0 && layer2 === 0`.
  4. Deck à double win condition (Hog + Miner) → vérifier la moyenne Layer 1/2 calculée à la main.
  5. Écart de niveau extrême (tout niveau 1 commun vs tout niveau 16 légendaire) → `layer4 === -35` (cap atteint).
  6. Layer 3 isolé : Bait vs 0/2+ petits sorts adverses, Three Musketeers vs pas de big spell, Golem vs pas de tank killer/bâtiment défensif.
  7. Normalisation des noms : `"P.E.K.K.A."` et `"P.E.K.K.A"` doivent matcher la même entrée catalogue.
  8. Test anti-collision : toutes les clés normalisées du catalogue + catégories Layer 3 sont uniques (garde-fou statique).
  9. Convention de signe bout-en-bout via `computeBattleMatchup` sur un objet `battle` minimal : désavantage net → `matchup > 0.5`, avantage net → `matchup < 0.5`.
- **`npm test`** doit passer intégralement après correction des bornes dans `analysisService.test.js`.
- **Test manuel** : exécuter `/matchup` sur un tag de joueur réel (via le bot Discord en dev ou un script direct appelant `summarizeWarDecksForMatchup`) et vérifier que les % affichés sont cohérents (ex. deck avec hard counter adverse évident → % élevé de difficulté).
