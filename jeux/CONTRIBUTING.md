# 🎲 Jeux Discord : documentation développeurs

Source de vérité des jeux de la famille (mini-jeux hebdomadaires, jeux spéciaux sur 7 jours, duels à la demande) : règles, barèmes, données, clés Redis, scripts et crons. **Avant de modifier une règle de jeu, consulter ce document** et le mettre à jour dans le même changement.

Pour l'architecture commune (organisation du monorepo, endpoint Discord, `runBackground()`, règles critiques du bot, variables d'environnement), voir le [`CONTRIBUTING.md` racine](../CONTRIBUTING.md). Rappel : `jeux/` n'importe jamais `backend/`, `api/` ni `scripts/` ; uniquement ses fichiers et `@clash/commun` / `@clash/clash-royale`.

Sommaire : routes Discord · mini-jeux hebdomadaires (Frame, Trivia, Anagram, Pêle-mêle, Zoom carte, Palette, La Juste Carte, Blind Royale) · jeux spéciaux (Quiz, Robinson, Blackjack, Gobelet, Bang!, Qui est-ce ?, Meow, Goblin Hunters, Mario Clash) · duels · sondage public · noms des cartes · jeux archivés.

---

## Bot Discord : routes des jeux

Les jeux ont leur propre application Discord (« bot des jeux »), servie par `api/discord/jeux.js` (architecture commune, `runBackground()` et règles critiques : voir `CONTRIBUTING.md` racine). La logique propre à chaque jeu est dans `jeux/discord/handlers/`.

- **Identifiants** : `jeux/env.js`, importé en premier par `api/discord/jeux.js` et par chaque `jeux/scripts/*.js`, charge `./.env` puis substitue `DISCORD_JEUX_TOKEN` / `DISCORD_JEUX_APP_ID` / `DISCORD_JEUX_PUBLIC_KEY` à `DISCORD_TOKEN` / `DISCORD_APP_ID` / `DISCORD_PUBLIC_KEY`. Le code des jeux ne lit que les noms standards et agit donc au nom du bot des jeux. Sans `DISCORD_JEUX_*`, tout reste sur le bot TrustRoyale et `api/discord/jeux.js` répond 404.
- **Workflows** : chaque workflow de jeu passe `DISCORD_JEUX_TOKEN` et `DISCORD_JEUX_APP_ID` (secrets GitHub) en plus de `DISCORD_TOKEN`.
- **Commandes** : `JEUX_COMMANDS` dans `scripts/registerCommands.js`, enregistrées sur le bot des jeux.
- **Transition** : `api/discord/interactions.js` (bot TrustRoyale) route encore `jeux/discord/routes/`, pour les boutons des messages postés par TrustRoyale avant la bascule. ⚠️ Un bot ne peut ni modifier ni supprimer le message d'un autre bot : basculer entre deux jeux spéciaux, jamais pendant une partie.
- ⚠️ Émojis d'application (`<:nom:id>`) : propres à chaque application ; un émoji du bot TrustRoyale ne s'affiche pas dans un message du bot des jeux.

| Module | Contenu |
| --- | --- |
| `jeux/discord/routes/miniJeux.js` | Mini-jeux quotidiens (Frame, Anagram, Zoom, Blind Royale, La Juste Carte, Pêle-Mêle, Palette, Trivia, Quiz, sondage d'idées), `/mini-jeux` (boutons « Ma participation » et « 📊 Stats », ce dernier calculé par `jeux/services/miniJeuxStats.js` depuis les archives des jeux), `/mini-jeux-history` |
| `jeux/discord/routes/jeuxSpeciaux.js` | Jeux spéciaux sur 7 jours (Blackjack, Gobelet, Tamagotchi, Robinson, Boss Raid, Goblin Hunters, Mario Clash, Bang!, Qui est-ce ?, Meow) |
| `jeux/discord/routes/duels.js` | `/blackjack`, `/bang`, `/gobelet` et leurs boutons de duel |

⚠️ Les `custom_id` et noms de commandes doivent rester disjoints de ceux des modules TrustRoyale : l'ordre des modules n'est pas un mécanisme de priorité.

---

## Mini-jeux hebdomadaires : fonctionnement commun

S'applique à Frame, Trivia, Trivia Geek, Concept, Synopsis éclaté, Anagram, Pêle-mêle, Zoom carte, Palette, La Juste Carte et Blind Royale. Chaque section de jeu ne décrit que ses spécificités.

### Alternance saisonnière (4 groupes)

Chaque groupe fait tourner **un seul jeu par saison** (voir « Saison et numérotation des manches »), en alternance. Décision : écart à `ACTIVE_GAME_REFERENCE_SEASON = 136` pair → 1er jeu, impair → 2nd jeu.

| Groupe | Pair / impair | Publication (UTC) | Workflow | Orchestrateur | Service | npm |
| --- | --- | --- | --- | --- | --- | --- |
| 🎬 Jeux de culture | Frame / Trivia | mercredi 08:00 (`0 8 * * 3`) | `jeux-culture.yml` | `jeux/scripts/postJeuxCulture.js` | `jeuxculture.js` | `culture:*` |
| 🔤 Jeux de lettres | Anagram / Pêle-mêle | samedi 18:00 (`0 18 * * 6`) | `jeux-de-lettres.yml` | `postJeuxDeLettres.js` | `jeuxdelettres.js` | `lettres:*` |
| 🎨 Jeux visuels | Zoom carte / Palette | vendredi 18:00 (`0 18 * * 5`) | `jeux-visuels.yml` | `postJeuxVisuels.js` | `jeuxvisuels.js` | `visuels:*` |
| 🙈 Jeux à l'aveugle | La Juste Carte / Blind Royale | lundi 18:00 (`0 18 * * 1`) | `jeux-aveugle.yml` | `postJeuxAveugle.js` | `jeuxaveugle.js` | `aveugle:*` |

### Refonte hors Clash Royale (bascule par groupe)

`jeux/services/refonte.js` remplace chaque paire par une nouvelle, sans lien avec Clash Royale, à partir de la saison `REFONTE_SEASON[groupe]` (139 = décembre 2026 pour les 4 groupes). Avant cette saison, l'alternance ci-dessus s'applique sans changement ; à partir d'elle, la parité s'ancre sur la saison de bascule : écart pair → 1er jeu, impair → 2nd. Reporter la bascule d'un groupe = augmenter sa saison dans `REFONTE_SEASON`.

| Groupe (clé technique) | Libellé après bascule | Écart pair (déc. 2026) | Écart impair (janv. 2027) |
| --- | --- | --- | --- |
| `culture` | 🎬 Ciné-club | `synopsis` (Synopsis éclaté) | `frame` (Trouve le film) |
| `aveugle` | 🎮 Culture geek | `triviageek` (Trivia Geek) | `intrus` (Intrus de l'inventaire) |
| `lettres` | 🔤 Jeux de mots | `concept` (Concept) | `pelemele` (Pêle-mêle, nouveau thème) |
| `visuels` | 📸 Coup d'œil | `platpays` (Plat Pays) | `zoom` (Zoom, nouveau thème) |

- Les clés de groupe et `<groupe>:last_season_id` ne changent pas ; seul le libellé affiché dépend de la saison (`groupLabel`, utilisé par `/mini-jeux-history`).
- Pêle-mêle et Zoom gardent leur identifiant (même jeu, nouveau thème) : leurs archives sont rangées par saison, donc jamais mélangées avec celles de la version Clash Royale. Les clés de rotation et d'état (`<jeu>:order`, `<jeu>:state`…) sont à purger au lancement du nouveau thème. Trivia Geek change de groupe, d'où un identifiant distinct (`triviageek`).
- À partir de la bascule, un jeu n'est lancé que s'il figure dans `REFONTE_PRETS` (`getWiredGame`) et dans les tables `*_BY_GAME` de l'orchestrateur. Sinon, l'orchestrateur poste quand même le récap du jeu qui se termine, puis échoue explicitement (« pas encore prêt »), et `/mini-jeux` n'affiche jamais ce jeu. Ce garde-fou empêche aussi de relancer la version Clash Royale de Pêle-mêle ou de Zoom.
- Catalogue Trivia Geek : `jeux/data/triviageek/trivia-geek.json`, même format que `trivia-clash.json` (bonne réponse suffixée « √ », parcouru dans l'ordre, ajouts en fin de fichier) plus `numero` (repère humain, 1 = première manche, à garder égal à la position dans le fichier), `titre` (titre humoristique affiché avec la question) et `sourceUrl`. Chaque réponse est vérifiée par une source web avant d'entrer au catalogue.
- Brancher un nouveau jeu : l'ajouter à `REFONTE_PRETS`, aux 4 tables de l'orchestrateur, à la paire de `minijeux.js` et à la catégorie de `miniJeuxHistory.js` (`tagSubGame`, libellé du jeu selon la date pour Pêle-mêle et Zoom).

Les orchestrateurs sont les **seuls points d'entrée en production**. À chaque passage :

1. Changement de saison détecté via un suivi **partagé** (`<groupe>:last_season_id`, ex. `jeuxvisuels:last_season_id`, `getLastKnownSeasonId`/`setLastKnownSeasonId`) → récap de fin de saison du jeu qui vient de finir. ⚠️ Ce suivi doit rester indépendant de `<jeu>:state` : le jeu qui reprend la main ne verrait sinon la transition que deux saisons plus tard. Jamais en dry-run (aucune écriture Redis).
2. Gating (sauf `--force`/`--dry-run`) : bon jour UTC, puis `alreadyPostedThisWeek()` du jeu actif (date UTC de `<jeu>:state.startedAt` = aujourd'hui).
3. Délégation à `post<Jeu>(channelId, { force: true, skipSeasonRecap: true, noPing })`.

`skipSeasonRecap` existe sur Frame, Anagram, Zoom, La Juste Carte et Blind Royale (ignoré par Trivia) : un appel direct (`post<Jeu>.js`) détecte lui-même le changement de saison sur son propre état et poste le récap. Pêle-mêle et Palette n'ont pas ce paramètre : leur récap n'est posté **que** par l'orchestrateur. Les scripts `jeux/scripts/post<Jeu>.js` restent utilisables pour un test ou un rattrapage d'un jeu précis.

Chaque service réexporte `getCurrentSeasonId()` depuis `jeux/services/saison.js` (aucun appel à l'API Clash Royale).

### Salons, ping et variables d'environnement

- Salon de test `DISCORD_CHANNEL_FRAME_TEST`, salon public `DISCORD_CHANNEL_FRAME_PUBLIC` : partagés par tous les mini-jeux, ne pas créer de salon dédié.
- Le salon de test ne pingue jamais (`NO_PING = --no-ping || !--public`). En public, ping du rôle `MINI-JEUX` résolu par son nom (`MINI_JEUX_ROLE_NAME`, `getRoleIdByName`/`buildRolePingFields`, `packages/commun/discordRoles.js`). ⚠️ Le nom doit correspondre exactement au rôle Discord, sinon le ping échoue silencieusement pour tous les jeux.
- Redis : `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Upstash), un préfixe de clés par jeu, aucun partage de données entre jeux.
- Secrets des 4 workflows : `CLASH_API_KEY`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_FRAME_PUBLIC`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` (GitHub → Settings → Secrets and variables → Actions). Sans les `KV_*`, échec `[Upstash Redis] The 'url'/'token' property is missing`.

### Stockage Upstash Redis : pièges et schéma

- ⚠️ `automaticDeserialization: false` obligatoire : sinon le SDK convertit les IDs Discord (17-19 chiffres) en `Number` et les corrompt. JSON géré à la main (`toJson`/`fromJson`/`hgetallJson`). Avec cette option, `HGETALL` renvoie un tableau plat `[champ1, valeur1, …]` : passer par `pairsToObject()`.
- ⚠️ Client construit paresseusement (`getRedis()`), jamais au chargement du module : les imports ES s'exécutent avant le `dotenv.config()` du script appelant.
- Opérations atomiques (`INCR`, `SADD`, `HSETNX`, `ZINCRBY`) pour la concurrence, sans verrou applicatif.

Clés communes (`<p>` = préfixe du jeu) :

| Clé | Type | Contenu |
| --- | --- | --- |
| `<p>:state` | STRING (JSON) | Manche active (`gameId`, `currentIndex`, `seasonId`, `seasonManche`, `seasonMancheTotal`, `startedAt`, `channelId`, `messageId`) |
| `<p>:participants:<gameId>` | HASH | `discordId → résultat` |
| `<p>:usernames:<gameId>` | HASH | `discordId → pseudo` |
| `<p>:attempts:<gameId>:<discordId>` | STRING (compteur) ou LIST | Tentatives |
| `<p>:season:<seasonId>` | ZSET | Score cumulé de la saison (`ZINCRBY`) |
| `<p>:season:<seasonId>:pseudos` | HASH | Pseudos du classement de saison |
| `<p>:season:<seasonId>:manche_seq` | STRING (compteur) | Dernier n° de manche attribué |
| `<p>:season:<seasonId>:manche_numbers` | HASH | `gameId → n° de manche` (`HSETNX`, idempotent) |
| `<p>:archived:<seasonId>` | HASH | `<gameId>:<discordId> → résultat`, `HSETNX` contre le double comptage |
| `<p>:posted_games` | SET | Registre anti-spoiler des `gameId` postés, jamais nettoyé (jeux à image) |

- `startNewGame()` purge les données de progression de la manche **précédente** ; `<p>:season:*` et `<p>:archived:*` ne sont jamais supprimés automatiquement.
- Changement de saison : une nouvelle clé `<p>:season:<seasonId>` suffit, aucune remise à zéro.
- `npm run <jeu>:reset` efface tout l'état du jeu (manche, historique, scores). **Destructif**.

### Saison et numérotation des manches

- **Une saison = un mois calendaire**, du 1er à minuit au 1er du mois suivant, **heure de Paris**, indépendamment des saisons Clash Royale. Source de vérité : `jeux/services/saison.js` (`seasonIdForDate`, `getCurrentSeasonBounds`, `countRemainingWeekdayOccurrences`/`countRemainingWednesdays`), testée par `saison.test.js`.
- Identifiant technique : un entier par mois, qui prolonge l'ancienne numérotation (octobre 2026 = 137, novembre = 138…), jamais affiché aux joueurs. Les clés `<jeu>:season:<id>` / `<jeu>:archived:<id>` et l'alternance continuent sans migration. ⚠️ Les archives antérieures à novembre 2026 ont été numérotées selon les saisons Clash Royale (bornes au 1er lundi du mois) : `/mini-jeux-history` regroupe donc les résultats par date réelle, jamais par `seasonId`.
- Affichage « **Saison d'Octobre · Manche N/X** » (post, DM) via `nomSaison(seasonId)` ; `/mini-jeux-history` affiche le mois et l'année (`libelleMoisAnnee`).
- N relatif à la saison (`assignSeasonMancheNumber()` : `INCR` + `HSETNX`), X = N + nombre d'occurrences restantes du jour de publication avant la fin de la saison (`computeSeasonMancheTotal`, `countRemainingWednesdays`/`countRemainingWeekdayOccurrences`).
- La progression dans le catalogue (`currentIndex`) est indépendante de la saison et boucle au début une fois épuisée.

### Interactions Discord

- Bot en webhook HTTP uniquement (pas de Gateway ni d'intent `MESSAGE_CONTENT`) : les réponses libres passent par une **Modal** (réponse `type: 9`, `custom_id: <jeu>_answer_modal:<gameId>`). La soumission arrive avec `body.type === 5` (`MODAL_SUBMIT`), à ne pas confondre avec la réponse `type: 5` (`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`).
- Routage des boutons/modals : `jeux/discord/routes/miniJeux.js` (`routeMiniJeux`, appelé par `api/discord/interactions.js`).
- Normalisation des réponses : `normalizeAnswer()` (`packages/commun/textNormalize.js` : minuscules, accents et ponctuation retirés).
- Scores personnels d'un joueur : bouton « Ma participation » de `/mini-jeux`, aucune commande par jeu.

### Images servies et anti-spoiler

- Routes d'images : `jeux/server/imageRoutes.js` (monté par `backend/server.js`). URL d'embed `https://trustroyale.vercel.app/api/<jeu>/image?gameId=<gameId>&v=<horodatage>`.
- ⚠️ `gameId` épingle l'image de **cette** manche (sinon les anciens messages affichent la manche en cours quand le proxy Discord revalide son cache). La route refuse tout `gameId` jamais posté (registre `<p>:posted_games` ou équivalent), donc aucune manche future devinable. `v` n'est qu'un cache-buster.
- Aucun asset de jeu n'est exposé statiquement (rien sous `frontend/public/`).
- ⚠️ Zoom et Palette (images, surlignages) et la police `data/fonts/Inter-Bold.ttf` sont lus depuis Vercel Blob privé (`readBlobAsset`/`readBlobFontPath`, `packages/commun/blobAssets.js`, nécessite `BLOB_READ_WRITE_TOKEN`) : le dossier `jeux/data/jeux-visuels/` est trop lourd pour le bundle. Après toute régénération d'images : `npm run assets:upload-blob -- jeux-visuels`.
- ⚠️ Rendu SVG → PNG par `@resvg/resvg-js` : tout texte exige la police embarquée (`fontFiles` + `loadSystemFonts: false`), sinon il est invisible sur Vercel, sans erreur.

### Récapitulatif de fin de saison

Posté sur le salon public juste avant la manche 1 de la nouvelle saison (jamais en DM) :

- classement final (`computeSeasonRanking`), félicitations au(x) vainqueur(s) avec gestion des ex aequo ;
- médailles 🥇🥈🥉 uniquement pour un rang non partagé (`findTiedRank`), sinon numéro simple ;
- scores à 0 exclus, 20 joueurs max (`SEASON_RECAP_MAX_PLAYERS`, puis « … et X autres joueurs ») ;
- liste des manches jouées avec leur libellé ;
- rien n'est posté si personne n'a marqué.

Prévisualisation : `npm run <groupe>:public:dry` ou `<jeu>:test:dry`.

### Scripts npm (convention)

Dans le `package.json` racine (`node jeux/scripts/…`) :

| Commande | Effet |
| --- | --- |
| `<groupe>:test` / `:test:dry` / `:public` / `:public:dry` | Orchestrateur (`culture`, `lettres`, `visuels`, `aveugle`) ; `:public` = cron |
| `<jeu>:test` | Nouvelle manche sur le salon de test, sans ping |
| `<jeu>:test:dry` | Aperçu console (+ récap éventuel), sans écrire ni poster |
| `<jeu>:public` / `:public:dry` | Post direct sur le salon public (avec ping), hors orchestrateur |
| `<jeu>:scores` | Classement de la manche en cours + score de saison (+ joueurs n'ayant pas encore joué) |
| `<jeu>:reset` | Remise à zéro complète. **Destructif** |

Les scripts propres à un jeu sont listés dans sa section.

---

## Frame (devine le film)

Jeux de culture (en alternance avec Trivia), mercredi 08:00 UTC. Une image de film, les joueurs devinent le titre. Service `jeux/services/frames.js`, handler `jeux/discord/handlers/frames.js`.

### Barème

`computeScore(attemptsIncorrects, hintsUsedCount)` = `max(1, 10 − 2 × tentatives incorrectes − 3 × indices)` : 10 pts au 1er coup sans indice, −2 par tentative incorrecte, −3 par indice (2 indices : `indice1`, `indice2`), **plancher 1**. La tentative gagnante n'est pas comptée comme incorrecte.

### Réponse

Bouton « Répondre » → Modal. `checkAnswer()` : la réponse normalisée doit **contenir** un terme de `accepte` et **aucun** terme de `refuse`. Ex. `The Dark Knight` (`accepte: ["knight"]`, `refuse: ["rises", "joker"]`) : « dark knight » accepté, « the dark knight rises » refusé.

DM de fin de manche au joueur qui trouve.

### Données

- `jeux/data/frames/frames.json` : liste ordonnée (`image`, `indice1`, `indice2`, `titre`, `accepte`, `refuse?`), éditée à la main, parcourue dans l'ordre en boucle. `gameId` = nom du fichier image sans extension.
- `jeux/data/frames/images/*.webp`, servies uniquement par `GET /api/frames/image?gameId=` (`getFrameImageByGameId()`, garde `frame:posted_games`).

### Redis (`frame:*`)

Schéma commun, plus `frame:hints:<gameId>:<discordId>` (SET des indices pris). `frame:attempts:*` est un compteur `INCR`.

### Scripts npm spécifiques

`frame:move` : reposte la manche active dans un autre salon sans la faire avancer.

---

## Trivia et Trivia Geek (QCM)

Deux instances du même moteur : service `jeux/services/triviaEngine.js` (`createTriviaService`), handlers `jeux/discord/handlers/triviaEngine.js` (`createTriviaHandlers`). Chaque instance a son préfixe Redis, son catalogue et son jour ; aucune donnée partagée.

| Jeu | Groupe | Préfixe Redis | Catalogue | Jour | Boutons |
| --- | --- | --- | --- | --- | --- |
| 🧠 Trivia (culture Clash Royale) | Jeux de culture, alternance avec Frame | `trivia:` | `jeux/data/triviaclash/trivia-clash.json` | mercredi | `trivia_answer:` |
| 🎮 Trivia Geek | Culture geek à partir de la refonte | `triviageek:` | `jeux/data/triviageek/trivia-geek.json` | lundi | `triviageek_answer:` |

- QCM A/B/C/D, essai unique, miroir de Palette. Catalogue parcouru dans l'ordre du fichier, en boucle. `id` = index zéro-paddé (`q000`…) : ne jamais réordonner un catalogue déjà joué, ajouter en fin.
- Champ optionnel `titre` : affiché en italique au-dessus de la question.
- Ordre des réponses mélangé par manche (`<préfixe>:order:<gameId>`).
- Barème : **1 pt** bonne réponse, 0 sinon, un seul clic verrouillé (`HSETNX`). La réponse éphémère révèle la bonne réponse et la source (`source`).
- Erratum : un champ `erratum` sur une question offre 1 pt à tous les participants de la manche (`grantErratumPoint()`, idempotent) et poste une annonce une seule fois (`<préfixe>:erratum_posted:<gameId>`).
- Pas de logique de récap interne (`skipSeasonRecap` ignoré) : le récap de fin de saison est posté par l'orchestrateur du groupe.
- Scripts : `trivia:*` et `triviageek:*` (`test`, `test:dry`, `reset`, `scores`) ; `postTrivia.js`, `resetTrivia.js` et `triviaScores.js` prennent `--geek` pour viser Trivia Geek.

---

## Concept (devine le concept caché derrière des emojis)

Groupe « Jeux de mots » (samedi 18:00 UTC) à partir de la refonte, en alternance avec Pêle-mêle. Service `jeux/services/concept.js`, handler `jeux/discord/handlers/concept.js`, même parcours que Frame (Modal de réponse, indice, DM de fin de manche avec score de la manche et total de la saison, sans rang d'arrivée).

- Catalogue `jeux/data/concept/concepts.json` (importé d'UniClaude, `github.com/alsacreations/uniclaude`, puis trié à la main) : `numero`, `emojis`, `categorie` (affichée dans le post), `reponse` (affichée à la résolution), `solution` (réponse « propre » sans parenthèse, base de l'indice, toujours acceptée), `accepte`, `refuse?`, `origine` (id UniClaude ou `null`). Parcouru dans l'ordre du fichier, en boucle ; `gameId` = `c` + numéro sur 3 chiffres. Ne jamais réordonner un catalogue déjà joué, ajouter en fin.
- Règles de contenu : pas de doublon de réponse, jamais un prénom ou un mot courant seul dans `accepte` (nom complet, ou nom de famille sans ambiguïté), chanson = titre complet, pas de réponse double, uniquement des emojis Unicode 13 au plus (pas de lettres, de symbole non emoji ni de drapeau de subdivision), pas deux catégories identiques consécutives.
- Réponse : un terme `accepte` doit apparaître **en mots entiers** dans la réponse normalisée (`normalizeConcept` : `normalizeAnswer` + ligatures œ/æ), aucun terme `refuse`.
- Barème : `max(1, 10 − 2 × tentatives incorrectes − 3 × indice)`. La catégorie est affichée d'office ; le seul indice (éphémère) est le masque de `solution` (`buildMasque` : une case par lettre, ponctuation visible, nombre de lettres par mot). Score figé à la résolution.
- Redis (`concept:*`) : `state`, `participants:<gameId>`, `usernames:<gameId>`, `hint:<gameId>:<discordId>`, `attempts:<gameId>:<discordId>` (purgés à la manche suivante), `season:<id>` (+ `pseudos`, `manche_seq`, `manche_numbers`), `archived:<id>`.
- Boutons `concept_hint:`, `concept_answer:` (Modal `concept_answer_modal:`). Pas de commande de scores : « Ma participation » de `/mini-jeux`.
- Scripts : `concept:test`, `concept:test:dry`, `concept:reset`.

---

## Synopsis éclaté (devine le film ou la série à partir du pire synopsis)

Groupe « Ciné-club » (mercredi 08:00 UTC) à partir de la refonte, en alternance avec Frame. Service `jeux/services/synopsis.js`, handler `jeux/discord/handlers/synopsis.js`, même parcours que Frame (Modal de réponse, deux indices, DM de fin de manche avec score de la manche et total de la saison, sans rang d'arrivée). Bannière fixe `frontend/public/images/synopsis/synopsis-game.webp`.

- Catalogue `jeux/data/synopsis/synopsis.json` : `numero` (= position), `difficulte` (`intermediaire` ou `difficile`, repère de curation non affiché), `variante` (affichée dans le post), `synopsis`, `indice1` (année de sortie du film ou de première diffusion de la série), `indice2`, `titre` (affiché à la résolution), `accepte`, `refuse?`. Parcouru dans l'ordre du fichier, en boucle ; `gameId` = `s` + numéro sur 3 chiffres. Ne jamais réordonner un catalogue déjà joué, ajouter en fin.
- `indice2` : réalisateur (premier crédité) pour un film, studio pour un film d'animation (Pixar, DreamWorks, Studio Ghibli), « Série » pour toute série, animée comprise. Libellé affiché : « Réalisation ».
- Variantes : Ultra-littéral, Une phrase, Leboncoin, Recette de cuisine, Avis 1 étoile, Figurant, Patch notes, Commentaire sportif, Djeunz, Enfant. Une variante imite un format de texte reconnaissable ; pas de variante « Classique ».
- Règles de contenu : pas de niveau facile (le synopsis passe par un angle détourné, sans l'élément signature de l'œuvre), années, réalisateurs et faits d'intrigue vérifiés par une source web, pas de tiret cadratin. Ordre : jamais deux séries ni deux films d'animation consécutifs, ni la même variante ou le même réalisateur/studio à moins de trois rangs, ni deux intermédiaires de suite. Les doublons d'œuvres avec Frame sont autorisés.
- Réponse : système de Frame (`checkAnswer` réexporté de `frames.js`) : un terme `accepte` en sous-chaîne de la réponse normalisée, aucun terme `refuse` (suites, autres épisodes). Les termes `accepte` font au moins 4 caractères (« up » validerait « super ») ; le titre complet doit toujours être accepté (vérifié par `synopsis.test.js`).
- Barème de Frame : `max(1, 10 − 2 × tentatives incorrectes − 3 × indices utilisés)`, score figé à la résolution.
- Redis (`synopsis:*`) : `state`, `participants:<gameId>`, `usernames:<gameId>`, `hints:<gameId>:<discordId>` (ensemble), `attempts:<gameId>:<discordId>` (purgés à la manche suivante), `season:<id>` (+ `pseudos`, `manche_seq`, `manche_numbers`), `archived:<id>`.
- Boutons `synopsis_hint1:`, `synopsis_hint2:`, `synopsis_answer:` (Modal `synopsis_answer_modal:`). Pas de commande de scores : « Ma participation » de `/mini-jeux`.
- Scripts : `synopsis:test`, `synopsis:test:dry`, `synopsis:reset`.

---

## Anagram (devine la carte)

Jeux de lettres (en alternance avec Pêle-mêle). Service `jeux/services/anagrams.js`.

### Barème : rang d'arrivée

`computeScore(position)` = `max(1, 11 − position)` : 1er 10 pts, 2e 9 pts… 10e et suivants 1 pt. Non trouvé : 0 (absent du classement). Pas d'indice ni de pénalité de tentative.

Position attribuée atomiquement et définitivement à la résolution (`assignArrivalPosition()` : `INCR` + `HSETNX`). Position et score sont donc la même donnée : une seule fonction de classement de manche (`computeGameRanking()`, tri par `position`), pas besoin de `findTiedRank` pour la manche.

### Réponse

Égalité **stricte** normalisée contre `entry.accept` (une sous-chaîne accepterait « Barbares » pour « Barbares d'élite »). DM de fin de manche.

### Données

- `jeux/data/anagrams/anagrams.json` : 50 entrées (`ID`, `anagram`, `answer`, `accept[]`, `cardKey`), éditées à la main, parcourues en boucle. L'anagramme est publiée en clair (pas de route anti-spoiler).
- Image révélée après résolution (réponse éphémère) via `getCardImageUrl(cardKey)`, qui réutilise le cache mémoire partagé `getOrSet("clashCardDefinitions", fetchCards, 24h)`. Un `cardKey` inconnu donne un `console.warn` et pas d'image, jamais d'erreur.

### Redis (`anagram:*`)

Schéma commun, plus :

| Clé | Type | Contenu |
| --- | --- | --- |
| `anagram:position_seq:<gameId>` | STRING (compteur) | Dernière position attribuée |
| `anagram:positions:<gameId>` | HASH | `discordId → position` (`HSETNX`) |

`anagram:attempts:*` est informatif, hors score.

### Scripts npm spécifiques

`anagram:test` force le post (ignore le gating) ; `anagram:public:force` poste en public en ignorant le gating (rattrapage).

---

## Pêle-mêle (retrouve les cartes cachées dans les lettres)

Jeux de lettres (en alternance avec Anagram). Service `jeux/services/pelemele.js`.

Une manche = un **tirage** ouvert de `DRAW_SIZE` (14) lettres. Toute carte du pool formable avec ces lettres est valide ; la manche n'est jamais « résolue », elle reste ouverte jusqu'à son remplacement. Chaque joueur propose autant de cartes qu'il veut.

### Barème

- **5 pts** (`LONGEST_WORD_BONUS`) pour la ou les cartes de longueur maximale possible sur ce tirage (`maxWordLength`).
- **+1 pt** (`EXTRA_WORD_POINTS`) pour chaque autre carte valide.
- Une carte déjà trouvée (forme canonique `canonicalWordForm`) ne rapporte rien.
- Score = somme des cartes distinctes ; le ZSET de saison est incrémenté à chaque carte. Constantes fixes, indépendantes de `DRAW_SIZE`.

### Pool et validation

- Éligible (`filterEligiblePool`) : `fr` connu, **sans apostrophe**, nombre de lettres (espaces/accents ignorés) ≤ `DRAW_SIZE`.
- `validateSubmission()` (pure) : `invalid` (aucune carte connue), `not-eligible` (hors pool), `impossible` (ne rentre pas dans ce tirage), `ok`. Correspondance stricte normalisée, avec repli sans espaces.

### Tirage

- Deux solutions garanties : carte principale en rotation équitable persistée (`pelemele:order`, `loadSeedOrder`/`pickNextIndex`) + seconde carte compatible (`pickCompatibleSecondarySeed`). Union de leurs lettres, complétée par des lettres pondérées selon les fréquences du Scrabble français (`FR_LETTER_WEIGHTS`), puis mélange (`buildLetterBagFromSeeds`).
- Chaque tirage doit offrir **4 à 9 cartes trouvables** (`MIN_VALID_WORDS`/`MAX_VALID_WORDS`) : `generateDraw()` retire seconde carte et complément jusqu'à 1000 fois, sinon garde le tirage le plus proche. Carte principale de 13 lettres ou plus : minimum 3 (`validWordsRangeFor`).
- Exclues de la rotation des cartes principales (`EXCLUDED_PRIMARY_SEEDS`, jamais plus de 3 mots trouvables) : Bélier de combat, Recrues royales, Électrocuteurs, Gang de gobelins, Fût à squelettes. Elles restent des réponses valides et des secondes cartes possibles.
- Tirages **préparés à l'avance** dans `pelemele:draws` (`{ seedCardKey, letters }`) : la file est remplie à `PREPARED_DRAWS_TARGET` (50) après chaque manche (`refillPreparedDraws`), `startNewGame()` consomme le premier.
- La liste des cartes valides est calculée une fois à `startNewGame()` (`computeValidWordsForDraw`, stockée en `totalValidWords`/`maxWordLength`).
- Image du chevalet : `GET /api/pelemele/image` (pas d'anti-spoiler, les lettres sont publiques).

### Spécificités d'affichage

- Bouton « Journal » (`pelemele_journal`) : cartes trouvées sur la manche en cours (`X/totalValidWords`) et les `JOURNAL_HISTORY_LIMIT` (10) dernières manches de la saison. Pas de DM de fin de manche.
- Récap : chaque manche est libellée par son tirage (lettres).

### Redis (`pelemele:*`)

Schéma commun, plus :

| Clé | Type | Contenu |
| --- | --- | --- |
| `pelemele:participants:<gameId>` | HASH | `discordId → { foundWords[], score, lastFoundAt }` |
| `pelemele:attempts:<gameId>:<discordId>` | LIST | Propositions valides (forme canonique), pour le Journal |
| `pelemele:order` | STRING (JSON) | Rotation des cartes principales |
| `pelemele:draws` | LIST | Tirages préparés, dans l'ordre |

Les résultats de **tous** les participants sont archivés d'un coup (`finalizeRound`) quand `startNewGame()` remplace la manche.

### Scripts npm spécifiques

- `pelemele:test` force le post (ignore le gating).
- `pelemele:draws` : complète la file et affiche le nombre de cartes trouvables par manche à venir (`-- --reveal` pour lettres et cartes).
- `pelemele:reset` remélange aussi la rotation et vide les tirages préparés.

---

## Zoom carte (devine la carte zoomée)

Jeux visuels (en alternance avec Palette). Service `jeux/services/zoom.js`, image `jeux/services/zoomImage.js`. Une manche = une carte (base, évolution ou héros) zoomée à l'extrême.

### Barème

`computeScore(attemptsIncorrects, hintUsed)` = `max(1, 10 − 2 × tentatives incorrectes − (indice ? 3 : 0))` : un seul indice, **plancher 1**.

### Réponse et indice

- Modal, égalité **stricte** normalisée (comme Anagram). DM de fin de manche avec l'image entière.
- Indice = image dézoomée envoyée en **embed éphémère** (`/api/zoom/image?gameId=&stage=hint`), jamais une édition du post public. Révélation : `stage=reveal`.
- Limite acceptée : l'URL `stage=hint` est reconstructible par qui a vu la manche, sans perdre les 3 pts.

### Catalogue (`jeux/data/jeux-visuels/zoom/zoom.json`)

- Généré par `npm run zoom:catalog` (`jeux/scripts/generateZoomCatalog.js`, usage ponctuel). Pool : `cardKey` d'`anagrams.json` + `EXTRA_ENTRIES` ajoutées à la main ; noms FR depuis `cardNames.json` uniquement.
- Icônes de base : `fetchCards()`. Évolutions/héros : `fetchPlayer(REFERENCE_PLAYER_TAG)` (l'API n'expose ces variantes que pour les cartes évoluées par ce joueur ; filtre `countEvolved`/`countHeroes`, `packages/clash-royale/collectionConstants.js`), ou `iconUrls.evolutionMedium`/`heroMedium` pour les ajouts manuels.
- Entrée : `id` (= `gameId`), `cardKey`, `variant: "base"|"evolution"|"hero"`, `answer`, `accept`, `image`, `width`/`height`, `sourceUrl`, `fetchedAt`, optionnellement `focal`/`zoomStages` (réglage manuel).
- ⚠️ L'ordre du fichier **est** l'ordre de jeu (`pickNextZoomIndex` : index + 1, en boucle). Il a été mélangé une fois : le script ne le retrie jamais et insère les nouvelles cartes à des positions aléatoires. Un fichier trié rend le jeu prévisible.
- Idempotent : ne retélécharge que si l'URL source change ; purge les entrées dont le `cardKey` a quitté le pool.
- Images dans `jeux/data/jeux-visuels/zoom/images/`, servies depuis Blob (voir fonctionnement commun).

### Recadrage

Point focal normalisé (défaut `(0.5, 0.45)`) et facteur de zoom : `DEFAULT_STAGE0_SCALE = 6.0` (post public), `DEFAULT_STAGE1_SCALE = 3.1` (indice), surchargeables par carte (`focal`, `zoomStages.stage0/stage1`). Un embed est partagé par tout le salon : le zoom ne varie pas par joueur. ⚠️ Vérifier visuellement toute nouvelle carte : un zoom trop faible rend la réponse évidente.

### Redis (`zoom:*`)

Schéma commun avec `zoom:posted_games`, plus `zoom:hint:<gameId>:<discordId>` (flag `SETNX`). `zoom:participants` : `{ solved, solvedAt, score, attempts }`.

### Scripts npm spécifiques

`zoom:catalog` ; `zoom:move` (reposte la manche active dans un autre salon sans l'avancer).

---

## Palette (devine la couleur dominante d'une carte)

Jeux visuels (en alternance avec Zoom carte). Service `jeux/services/palette.js` (parité de structure avec `zoom.js`), image `jeux/services/paletteImage.js`.

QCM à 4 choix (A/B/C/D), **un seul clic par joueur**, sans Modal (même mécanique que le vote du Quiz : ACK éphémère immédiat). Discord n'autorise pas de couleur sur les boutons : les 4 pastilles sont dessinées dans l'image, les boutons (`palette_answer:<gameId>:<lettre>`) ne portent que la lettre.

### Barème

`computeScore(rank)` = `RANK_POINTS[rank]` avec `RANK_POINTS = [4, 2, 1, 0]` : dominante 4 pts, 2e couleur 2, 3e 1, 4e 0 (`getAnswerRank`, rang dans `entry.colors` trié par part décroissante). Pas de bonus de rapidité ni de pénalité de tentative. `rank` est stocké dans participants et archives ; pour une archive sans `rank`, elle compte comme « dominante trouvée » si `score > 0`.

### Réponse à essai unique

`recordAnswer()` verrouille via `HSETNX` (sûr en cas de double-clic). `archiveAnswer()` archive **tous** les participants, score 0 compris. Pas de DM de fin de manche ni de Journal.

### Catalogue et couleurs

- `npm run palette:catalog` (`jeux/scripts/generatePaletteCatalog.js`, usage ponctuel) : génère `jeux/data/jeux-visuels/palette/palette.json`, télécharge `images/` et `highlights/`, applique `manualOverrides.json` (`forcePlayable`/`forceExcluded`) en dernier. Extraction : `jeux/services/dominantColor.js` (k-means en espace Lab, cadre de rareté exclu par comparaison inter-cartes).
- Carte jouable si la couleur dominante fait au plus 60 % (`MAX_TOP1_SHARE`) **et** dépasse la 2e d'au moins 5 points (`MIN_TOP_GAP`, sinon `excludedReason: "top1-top2<5%"`). Ce filtre prime sur `forcePlayable`.
- ⚠️ Une régénération complète peut recalculer le masque de cadre de toute une rareté et changer les couleurs d'autres cartes : à éviter pendant une saison Palette.
- ⚠️ `images/` (question) et `highlights/` (voile sur la dominante, résultat) ont les mêmes noms de fichiers : les inverser spoile la réponse.
- Images servies depuis Blob : `/api/palette/image?gameId=` (question), `&stage=result` (résultat).

### Ordre et mélange

- `palette.json` est trié (ordre de `cardNames.json`) : l'ordre de jeu est un mélange persisté dans `palette:play_order` (cartes `playable: true` uniquement). Les nouvelles cartes jouables y sont insérées à des positions aléatoires.
- Ordre des 4 couleurs : mélange Fisher-Yates à `startNewGame()`, persisté dans `palette:order:<gameId>` (jamais recalculé). L'existence de cette clé sert de registre anti-spoiler (`isGamePosted`).

### Redis (`palette:*`)

Schéma commun (sans `usernames`/`attempts`/`posted_games`), plus `palette:order:<gameId>` et `palette:play_order` (permanents, non effacés par `palette:reset`). `palette:participants` : `{ letter, correct, rank, score, answeredAt }`.

Libellé de manche (récap) : `entry.fr`.

---

## La Juste Carte (devine la carte par ses stats)

Jeux à l'aveugle (en alternance avec Blind Royale). Service `jeux/services/lajustecarte.js`, handler `jeux/discord/handlers/lajustecarte.js`.

Une carte secrète par manche. Chaque joueur propose des cartes successivement, à son rythme ; pour chaque stat débloquée, une flèche indique où se situe la **carte secrète** par rapport à la proposition (⬆️ plus haute, ⬇️ plus basse, ✅ égale).

### Barème

`computeScore(attemptNumber, hintUsed)` = `max(1, 11 − attemptNumber − (indice ? 3 : 0))` : 1re proposition gratuite (10 pts), −1 par proposition suivante, −3 pour l'indice, **plancher 1**.

### Indices

| Tentative | Stats visibles |
| --- | --- |
| 1re | PV, Portée |
| 2e | + Élixir |
| 3e et suivantes | + Dégâts |

- `compareCard(secret, guess, attemptNumber)` (pure) : `secret > guess ? "up" : "down"`.
- Portée comparée sur `range.rank` uniquement : mêlée `short/medium/long` = 1/2/3, distance = 3 + portée (une troupe à distance passe toujours devant la mêlée).
- Bouton « 💡 Indice : rareté » (`lajustecarte_hint:<gameId>`), présent sur le post et chaque réponse éphémère : révèle la rareté. Idempotent (`SETNX` sur `lajustecarte:hint:<gameId>:<discordId>`, un 2e clic ne recoûte rien). La pénalité n'est appliquée qu'à la victoire (`hintUsedFor()` relu dans `markSolved()`), `hintUsed` est archivé.

### Réponse : 3 issues

Modal sans autocomplétion (impossible dans une Modal). `resolveGuess()` : égalité stricte normalisée contre le nom FR des cartes du pool.

1. **Nom non reconnu** : aucun état modifié. `resolveAnyCard()` distingue une faute de frappe d'une carte réelle hors pool (« 🚫 carte non incluse dans ce jeu »).
2. **Carte fausse** : ajoutée à l'historique (`RPUSH`), indices et cartes déjà proposées renvoyés, bouton pour reproposer.
3. **Carte trouvée** : `markSolved()` (idempotent), `archiveSolve()`, embed de victoire avec image. **DM uniquement à la victoire** (`sendJusteCarteDM`).

Bouton « 📋 Cartes non incluses » sur le post et chaque réponse (`lajustecarte_excluded_list`) : `getExcludedCards()` dérive en direct les cartes de `cardNames.json` sans stats (44 actuellement), triées par nom.

### Données : stats dans `jeux/data/cardNames.json`

- Pool = entrées ayant `elixir`, `hp`, `damage` et `range` (`loadCatalog()`, 79 cartes actuellement), aucun autre champ d'éligibilité. Champions inclus ; évolutions, sorts, bâtiments et troupes de tour exclus.
- `npm run justecarte:stats` (`jeux/scripts/generateCardStats.js`, ponctuel, n'ajoute que les champs absents) :
  - Élixir : `fetchCards()` (la colonne « Cost » du wiki ne sert que de contrôle).
  - PV / Dégâts / Portée : API MediaWiki de `clashroyale.fandom.com/wiki/Cards` (section « Troops »), niveau Tournament Standard.
  - `damage` = colonne « Damage » (dégât par coup), pas le DPS (`N/A` pour beaucoup de cartes).
  - Exclusions : sous-unités générées (liens wiki _piped_), et toute carte dont PV, Dégâts ou Portée contient `/` (valeurs multiples) ou `-` (dégâts progressifs).

### Rotation

`cardNames.json` reste trié alphabétiquement : l'ordre de jeu est un mélange persisté dans `lajustecarte:order` (`loadPlayOrder()`), les nouvelles cartes étant ajoutées à la suite, mélangées entre elles. `pickNextIndex()` avance en boucle.

### Redis (`lajustecarte:*`)

Schéma commun, plus `lajustecarte:order` et `lajustecarte:hint:<gameId>:<discordId>`. `lajustecarte:attempts:<gameId>:<discordId>` est une LIST des propositions valides (sa longueur = numéro de tentative). `participants` : `{ solved, solvedAt, score, attempts, hintUsed }`.

### Scripts npm spécifiques

- `justecarte:stats`.
- `justecarte:order` : affiche toute la rotation à venir (et la crée si absente). **Outil admin**, ne jamais l'exposer aux joueurs.
- `justecarte:reset` : la rotation est remélangée à la manche suivante.

---

## Blind Royale (devine la carte au son)

Jeux à l'aveugle (en alternance avec La Juste Carte). Service `jeux/services/blindroyale.js`, handler `jeux/discord/handlers/blindroyale.js`.

- Chaque manche poste un extrait audio de la carte secrète en **pièce jointe** nommée `carte-mystere.mp3` (le vrai nom du fichier spoilerait la réponse).
- Pool : entrées de `cardNames.json` ayant un champ `sound` ; fichiers dans `jeux/data/card-sounds/sounds/` (provenance, licence et cartes sans son : `jeux/data/card-sounds/README.md`). Ordre mélangé persisté dans `blindroyale:order`.
- Réponse via Modal, égalité stricte normalisée.
- Barème : `max(1, 10 − 2 × tentatives incorrectes − (indice ? 3 : 0))`.
- Bouton « 💡 Indice : rareté » (`blindroyale_hint:<gameId>`), une fois par manche (`blindroyale:hint:<gameId>:<discordId>`).
- DM de fin de manche.
- Scripts spécifiques : `blindroyale:test` force le post ; `blindroyale:public:force` poste en public en ignorant le gating.

---

## Jeux spéciaux : fonctionnement commun

Jeux à avancée quotidienne (un message actif à la fois, publié par `jeux/scripts/post<Jeu>.js`, boutons routés par `jeux/discord/routes/jeuxSpeciaux.js`, sauf le vote du Quiz `quiz_vote:` routé par `miniJeux.js`) : Quiz, Robinson, Mario Clash, Bang!, Gobelet, Blackjack, Meow, Qui est-ce ?, Goblin Hunters (+ Tamagotchi et Boss Raid, archivés). Un seul jeu spécial actif à la fois sur le salon public, affiché dans `/mini-jeux` (`SPECIAL_GAMES`, `jeux/discord/handlers/minijeux.js`, premier état non terminé sur le salon public).

### Lancement : jour d'annonce obligatoire

- ⚠️ Tout jeu spécial publie d'abord un **jour d'annonce** (ou d'inscription) au lancement manuel ; le Jour 1 n'arrive qu'au passage suivant du cron. Jamais de lancement direct au Jour 1.
- État : `phase: "annonce"` (`"inscription"` pour Goblin Hunters), `jour: null`. `/mini-jeux` affiche alors « Phase de présentation du jeu ». Un état sans `phase` est traité comme un jour normal.
- Modèle : `postMarioClash()` (`jeux/discord/handlers/marioclash.js`).

### Cron et `--require-active`

- Workflow `.github/workflows/<jeu>.yml` : `workflow_dispatch` (lancement) + `schedule` quotidien. Crons décalés de quelques minutes entre 7 h et 8 h UTC (jamais `0 8`, pour éviter la charge GitHub en haut d'heure).
- Le run `schedule` passe `--require-active` (`requireActiveState`) : sans état en Redis, ne fait rien. ⚠️ Le cron ne démarre jamais une partie seul ; seul un lancement manuel le fait (l'annonce compte comme partie active).
- Garde-fou anti-double-avancée : `isTooSoonSinceLastClosure()` refuse de clôturer un jour publié depuis moins de `MIN_HOURS_BETWEEN_CLOSURES` (8 h) (cron en retard après une relance manuelle). `--force` le contourne ; automatique hors `--public`. (Meow n'en a pas besoin : son jour se déduit de l'horloge de la partie, `jourDe()`, et un second passage le même jour est ignoré, `dejaPublie`.)
- Partie terminée (`state.termine`) : les runs suivants sont des no-op.

### Salon test / salon public : état partagé

- Tous les jeux réutilisent `DISCORD_CHANNEL_FRAME_TEST` (par défaut) et `DISCORD_CHANNEL_FRAME_PUBLIC` (`--public`) ; aucune variable de salon dédiée. Redis : même instance (`KV_REST_API_URL`/`KV_REST_API_TOKEN`), `automaticDeserialization: false`, un espace de clés par jeu.
- ⚠️ **Un seul état Redis par jeu, partagé entre les deux salons.** Si une partie est active sur l'autre salon, `post<Jeu>()` renvoie `wrongChannel` et ne publie rien : `npm run <jeu>:reset` avant de changer de salon.
- Archivage des manches (`<jeu>:manches`, `<jeu>:manche_seq`, `archiveManche()`) **uniquement** en publication réelle sur le salon public (`isPublic`), jamais en dry-run ni sur le salon de test. `npm run <jeu>:reset` conserve l'archive ; `<jeu>:reset:manches` l'efface (filet de sécurité).

### Ping `@MINI-JEUX`

- Rôle résolu par `getRoleIdByName(MINI_JEUX_ROLE_NAME)` (`@clash/commun/discordRoles.js`), injecté via `buildRolePingFields()`.
- ⚠️ Jamais de ping hors salon public : `NO_PING = --no-ping || !PUBLIC` dans chaque `post*.js`.
- Au minimum : ping à l'annonce et à la fin de partie (y compris annulation). Jours intermédiaires : selon le jeu (Quiz, Gobelet, Blackjack pinguent à chaque post ; Robinson, Mario Clash, Goblin Hunters jamais ; voir la section du jeu).

### Inscriptions (Meow, Qui est-ce ?, Goblin Hunters)

- Fenêtre de `fenetre_inscription_jours` (2) jours. `closingAt` = J + 2 à l'heure du cron du jeu (`dateCloture()` : Meow 7 h 22, Qui est-ce ? 8 h 20, Goblin Hunters 8 h 04 UTC), affichée en pied d'embed.
- Pendant la fenêtre, chaque passage du cron republie un rappel (sans ping). Effectif `effectif_max` atteint : lancement anticipé au passage suivant du cron.
- **Clôture à l'heure** (`inscriptionsCloses(state)`) : dès `closingAt` passé, S'inscrire et Se désinscrire sont refusés en éphémère, et le premier clic déclenche `cloturerInscriptions()` qui remplace le message sur place :
  - moins de `effectif_min` inscrits → « partie annulée » (dates d'ouverture/clôture, effectif minimum), `termine: true` ;
  - sinon → « inscriptions closes », `cloture: true` ; le Jour 1 part au passage du cron.
- Au passage du cron après `closingAt` : annulation (sans prolongation) si effectif minimum non atteint, sinon Jour 1. Les inscrits ayant quitté le serveur (404 sur `GET /guilds/{id}/members/{id}`, `membresPartis()` dans `@clash/commun/discordUsers.js`) sont désinscrits à chaque passage et avant le décompte.
- Effectifs (`jeux/data/<jeu>/<jeu>.json`) : Meow 14-22, Qui est-ce ? 10-18, Goblin Hunters 10-18.
- Tests : `--force-close` ignore `closingAt` (automatique hors `--public` pour Meow et Qui est-ce ?) ; sur le salon de test, Meow et Qui est-ce ? complètent l'effectif avec des PNJ.

### Classements

- Rangs ex aequo : deux joueurs à égalité partagent le même rang (« 1, 2, 2, 4 ») via `rangExAequo()` (`@clash/commun/classement.js`) ; les récaps utilisent `findTiedRank()`. Départages propres à un jeu : voir sa section.

---

## Crons GitHub Actions (jeux spéciaux)

Chaque jeu à avancée quotidienne a son propre workflow `.github/workflows/<jeu>.yml`, déclenché à une minute **distincte** de la tranche 7h-8h UTC :

| Jeu            | Workflow            | Cron         |
| -------------- | ------------------- | ------------ |
| Meow           | `meow.yml`          | `22 7 * * *` (8h22 à Paris en hiver, après la distribution de 8 h) |
| Goblin Hunters | `goblinhunters.yml` | `4 8 * * *`  |
| Quiz           | `quiz.yml`          | `6 8 * * *`  |
| Robinson       | `robinson.yml`      | `8 8 * * *`  |
| Blackjack      | `blackjack.yml`     | `12 8 * * *` |
| Mario Clash    | `marioclash.yml`    | `14 8 * * *` |
| Jeu du Gobelet | `gobelet.yml`       | `16 8 * * *` |
| Bang!          | `bang.yml`          | `18 8 * * *` |
| Qui est-ce ?   | `quiestce.yml`      | `20 8 * * *` |

Tamagotchi (`tamagotchi.yml`, ex-minute 10) et Boss Raid (`bossraid.yml`, ex-minute 2) ont leur cron commenté : voir « Jeux archivés ».

- Le cron lance `npm run <jeu>:public -- --require-active` : il n'avance qu'une partie déjà lancée. Le lancement se fait à la main (`workflow_dispatch`, bouton « Run workflow » ou `gh workflow run <fichier>.yml`).
- ⚠️ Ne jamais caler deux crons sur la même minute ni sur une heure ronde : les triggers `schedule` de GitHub sont _best-effort_ et retardés aux heures chargées.
- ⚠️ Un trigger `schedule` peut se désynchroniser silencieusement côté GitHub (aucun run, `workflow_dispatch` fonctionne toujours). Correctif officiel : pousser un commit sur la branche par défaut qui touche le workflow ([community#185355](https://github.com/orgs/community/discussions/185355)).
- Rattrapage d'un cron manqué : `workflow_dispatch`. Sans risque grâce aux garde-fous anti-double-avancée (ex. `isTooSoonSinceLastClosure()`, `jeux/services/robinson.js`).

---

## Quiz — 7 questions sur une thématique

Jeu spécial de 7 jours : une question à choix par jour sur une thématique unique par manche, votes secrets et définitifs, bonnes réponses et classement révélés après le Jour 7. Pas de commande slash.

| Rôle | Fichier |
| ---- | ------- |
| Contenu, état, votes, scoring, Redis | `jeux/services/quiz.js` |
| Discord (embeds, boutons, `postQuiz()`, `handleQuizVote()`) | `jeux/discord/handlers/quiz.js` |
| Routage du bouton `quiz_vote:*` | `jeux/discord/routes/miniJeux.js` |
| Publication quotidienne | `jeux/scripts/postQuiz.js` |
| Contenu | `jeux/data/quiz/quiz.json` (voir Config) |

### Déroulement (Quiz)

- **Annonce** (`phase: "annonce"`) : pas de bouton (pas de bouton Règles), thématique non révélée (« révélée demain »).
- **Passage au Jour 1** : thématique tirée par `pickNextMancheIndex()`, **cycle séquentiel** dans l'ordre de `manches` (jamais aléatoire, jamais deux fois la même de suite), curseur `quiz:theme_cursor`. Le numéro de manche (`INCR quiz:manche_seq`) est attribué **dès le Jour 1** (pas à la clôture) car il namespace les votes des 7 jours.
- **Jours 1 à 7** : question `questions[jour - 1]`. Chaque post supprime le message de la veille puis publie le suivant ; la clôture d'un jour est silencieuse (aucun bilan intermédiaire).
- **Après le Jour 7** : révélation finale (`termine: true`), archivage si `isPublic`.

### Votes

- Bouton `Réponse A/B/…` (`custom_id` `quiz_vote:<manche>:<jour>:<index>`), un bouton par entrée de `choix`.
- **Vote unique et définitif** (`recordVote()`) : revoter le même choix = no-op (`already_recorded`), un autre choix = refusé sans écriture (`rejected`).
- Clic sur une question qui n'est plus la question active (`manche`/`jour` ≠ état, ou partie terminée) : « Cette question est déjà close, regarde le nouveau message ! ».
- ⚠️ Rien n'est public avant la révélation : aucun compteur de votes, message public jamais repatché. `/mini-jeux` n'affiche que la participation du jour (« N participants ce jour »), jamais de score.

### Barème et classement (Quiz)

- 1 point par bonne réponse (`choiceIndex === bonne_reponse`), 0 pour une mauvaise réponse ou un jour sans vote. Score sur 7.
- `computeMancheRanking()` : seuls les joueurs ayant voté au moins une fois, tri par score décroissant, rangs ex aequo (`rangExAequo`, sans critère de départage). Top 20 affiché.
- Vainqueurs : tous les joueurs au score max, **seulement si ce max > 0** (sinon `winners: []`).
- Score de manche cumulé dans l'historique de saison des mini-jeux (`miniJeuxHistory.js`, champ `score`).

### Interface (Quiz)

- Annonce : `❓ Quiz : une nouvelle manche se prépare`, pied « La partie commence demain à 8 h UTC (heure de Paris) ».
- Question : titre `❓ Quiz : <theme> (Jour X/7)`, énoncé en titre Markdown, propositions `**A.** …` **dans l'embed uniquement** (boutons génériques `Réponse A`, pour ne pas trahir la longueur des réponses), image optionnelle, pied « Vote avant <8 h UTC> demain » + heure du post (Paris).
- Réponse au clic : ACK `type: 5` éphémère (`flags: 64`) envoyé avant tout traitement, puis `runBackground()` → `handleQuizVote()` patche le message éphémère (« Vote enregistré ! », « Tu as déjà voté… »).
- Révélation `🏁 Quiz : révélation finale` : thème, bonne réponse de chaque jour, classement, vainqueurs, puis vainqueurs des 10 dernières manches archivées (`listManches()`).

### Config (`jeux/data/quiz/quiz.json`)

```
{ manches: [{ id, theme, questions: [{ type, enonce, image, choix, bonne_reponse }] }] }
```

| Champ | Rôle |
| ----- | ---- |
| `id` | Slug stable (stocké en `mancheId`, debug) |
| `theme` | Affiché dans les titres et la révélation |
| `questions` | ⚠️ **Exactement 7** : `TOTAL_QUESTIONS = 7` est codé en dur (titres, passage à la révélation) |
| `type` | `"qcm"` ou `"vrai_faux"` (informatif : le nombre de boutons suit `choix.length`) |
| `image` | Chemin relatif sous `frontend/public/images/` (servi par `https://trustroyale.vercel.app/images/…`) ou `null`, jamais d'URL absolue |
| `choix` | 2 à 5 propositions (lettres A-E, une seule rangée de boutons) |
| `bonne_reponse` | Index 0-based dans `choix` |

Le fichier est lu une fois et mis en cache (jamais muté). Manches actuelles : `staff-histoire`, `Nombres`.

### Stockage Redis (`quiz:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `quiz:state` | STRING | `{ phase, manche, mancheIndex, mancheId, theme, jour, channelId, messageId, publishedAt, termine }` |
| `quiz:votes:<manche>:<jour>` | HASH | `discordId → index du choix` |
| `quiz:vote_usernames:<manche>:<jour>` | HASH | `discordId → pseudo` (affichage seulement) |
| `quiz:theme_cursor` | STRING | index de la dernière thématique jouée |
| `quiz:manche_seq` | STRING | compteur de manches (incrémenté au Jour 1) |
| `quiz:manches` | HASH | `manche → { manche, mancheId, theme, resolvedAt, ranking, winners, maxScore }` |

`resetQuiz()` efface `quiz:state` et les votes ; `--manches` efface aussi `quiz:manches`, `quiz:manche_seq` et `quiz:theme_cursor` (le cycle repart de la première thématique).

### Scripts et cron (Quiz)

| Commande | Effet |
| -------- | ----- |
| `npm run quiz:test` / `:test:dry` | Salon de test / aperçu console |
| `npm run quiz:public` / `:public:dry` | Salon public |
| `npm run quiz:reset` | **Destructif** : partie et votes effacés, archive, compteur et curseur conservés |
| `npm run quiz:reset:manches` | **Destructif** : efface aussi archive, compteur et curseur |
| `npm run quiz:status` | Manche, thème, jour, votants du jour (sans le contenu des votes) |
| `npm run quiz:scores` | Admin : matrice joueur × jour (1/0/`-`) + total, visible avant la révélation |

Options de `postQuiz.js` : `--dry-run`, `--public`, `--no-ping`, `--require-active`, `--force`.

Cron `.github/workflows/quiz.yml` : `6 8 * * *`. Variables : `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_FRAME_PUBLIC`, `KV_REST_API_URL`/`KV_REST_API_TOKEN`.

---

## Robinson (survie insulaire communautaire)

Jeu spécial collaboratif : la communauté, naufragée, doit survivre `duree_jours` (7) jours jusqu'aux secours (Jour `duree_jours + 1`) ou s'évader plus tôt en Radeau. Chaque jour, chaque membre vote une action (Pêcher, Eau, Bois, Explorer, Radeau) qui alimente 3 stocks (Nourriture/poisson, Eau, Bois) consommés chaque nuit. Mécaniques communes (annonce, cron `--require-active`, salon test/public, ping, manches) : voir « Jeux spéciaux : fonctionnement commun ».

| Rôle | Fichier |
|---|---|
| Logique métier, Redis, fonctions pures | `jeux/services/robinson.js` |
| Embeds, publication, boutons | `jeux/discord/handlers/robinson.js` (`postRobinson()`, `handleVoteButton()`, `handleJournal()`, `handleRegles()`) |
| Routage des boutons (`robinson_vote:<jour>:<action>`, `robinson_journal`, `robinson_regles`) | `jeux/discord/routes/jeuxSpeciaux.js` |
| Publication (manuel/cron) | `jeux/scripts/postRobinson.js` (pas de commande slash) |
| Config | `jeux/data/robinson/robinson.json`, `jeux/data/robinson/narratifs.json` |
| Illustrations | `frontend/public/images/robinson/rob-01.webp` … `rob-10.webp` (`robinsonImageUrl(jour)`) ; seules 01-07 servent avec 7 jours, l'embed de fin réutilise celle de `duree_jours` |

### Déroulement

1. **Annonce** (lancement manuel) : `phase: "annonce"`, `jour: null`, bouton Règles seul, ping MINI-JEUX.
2. **Jour 1** (cron suivant) : `initEconomy(stocks_initiaux)` (stocks + Radeau à 0), pas de ping.
3. **Clôture quotidienne** (`postRobinson()` → `computeClosure()` puis `finalizeDayClosure()`) :
   - Radeau achevé (`isRaftVictory()`) → victoire Radeau, sans consommation ni vérification de défaite.
   - Sinon consommation automatique (`computeDailyConsumption()`) : `-V` Nourriture, `-V` Eau, `-⌈V/2⌉` Bois (plancher 0), où **V = votants uniques de la veille** (`historique[jour-1].V`) ; seul le Jour 1 utilise son propre V. ⚠️ Ne pas baser la conso sur le V du jour clos : une baisse de participation deviendrait gratuite.
   - Jour 5 (Gobelins) : après conso, si Bois `< 5` → vol de 5 Poissons (plancher 0).
   - Jour `duree_jours + 1` atteint → victoire par survie.
   - Sinon : résolution de l'événement du jour suivant (pertes/dons Poissons Pourris, Épave) → stock **final**, puis `updateZeroStreaks()` sur ce stock final. Ressource à 0 pendant `ZERO_STREAK_LIMIT` (**2**) jours consécutifs → défaite. ⚠️ Toujours calculer les streaks sur le stock final affiché, jamais sur le stock intermédiaire (sinon « jour à 0 » invisible pour les joueurs).
   - Tirage des Chefs du jour, suppression du message de la veille, publication du jour suivant.
4. Fin (victoire Radeau, victoire survie, défaite) : `termine: true`, ping, archivage de la manche (salon public).

### Votes

- Un vote par membre et par jour, **définitif** : `recordVote()` en `HSETNX` ; même action = no-op (réaffiche le tirage via `vote_details`), autre action = rejet.
- **Récoltes appliquées en direct au clic** (pas au cron) : stock incrémenté immédiatement, résultat exact en éphémère (ack `type: 5` puis `PATCH @original`) ; message public rafraîchi par un `PATCH` séparé (token bot, `refreshPublicMessage()`).
- ⚠️ Stocks et points de Radeau = clés numériques séparées mutées uniquement en `INCRBY`/`DECRBY`, jamais un blob JSON lu-modifié-réécrit (clics concurrents).
- Radeau sans Bois suffisant (`attemptRaftContribution()`, décrémente puis compense si négatif) : vote rejeté **et slot libéré** (`releaseVoteSlot()`), le joueur peut réessayer.

### Tirages

| Action | Gain |
|---|---|
| Pêcher / Eau / Bois | 0-5 uniforme (`rollHarvestAmount()`) |
| Pêcher / Eau / Bois plafonnés par événement | palier « modéré » 0-2 (Canicule, `rollModerateCapAmount()`) ; palier « léger » 1-2 (Ouragan, Indigestion Royale, `rollMildCapAmount()`) ; dispatch `rollEventCappedAmount()`, cible via `harvestCapForEvent()` |
| Explorer | toujours 3 unités d'une seule ressource tirée au hasard (`rollExplorerYield()`), jamais plafonné |
| Radeau | `bois_par_point_radeau` (1) Bois → +1 point |

⚠️ Barème 0-5 calibré par simulation Monte Carlo : récolte moyenne = consommation (équilibre sans marge). Le baisser (0-4) effondre la survie ; tout changement de barème, palier, stocks ou `ZERO_STREAK_LIMIT` doit être revalidé par simulation **sur le code réellement implémenté**. Cibles de calibrage : survie passive 40-60 % et victoire Radeau 20-40 % à V=12-16.

### Chefs du jour

Tirés à chaque ouverture de jour (à partir du Jour 2) parmi les **votants réels de la veille** ; aucun si personne n'a voté ; jamais tirés en dry-run. Annoncés dans l'embed public (`state.chefExplorateurId`, `state.chefCharpentierId`).

- **👑 Chef Explorateur** (`pickChefExplorateur()`) : **+1** au tirage du jour (normal ou plafonné) sur Pêcher/Eau/Bois uniquement (pas Explorer, pas Radeau).
- **🪓 Chef Charpentier** (`pickChefCharpentier()`) : tiré seulement les jours où le Radeau est déverrouillé, en excluant le Chef Explorateur (sauf votant unique). Son vote Radeau est **gratuit** (aucun Bois, `grantFreeRadeauPoints()`) et vaut `(rollHarvestAmount() + 1) × 2` points (2-12, `rollCharpentierRadeauPoints()`). ⚠️ Raison d'être : détourner une fraction des votes du groupe vers le Radeau fait s'effondrer la survie ; ce rôle ne coûte qu'un vote.

### Événements programmés (`robinson.json.evenements`)

`eventForDay(jour, evenements, V_veille)` : lookup par champ `jour` ; `condition_votants_veille_max` désactive l'événement si `V_veille >=` seuil. Les pertes/dons s'appliquent **une seule fois**, à la publication du jour concerné.

| Jour | Événement (`id`) | Effet |
|---|---|---|
| 2 | Poissons Pourris (`poissons_pourris`) | Seulement si V_veille `<` 14 (`condition_votants_veille_max`). Perte de Poisson `computePoissonsPourrisLoss(V, seuil) = max(1, min(seuil − V, 4 + V))` (`spoilPoisson()`). ⚠️ `seuil` doit être `event.condition_votants_veille_max`, jamais codé en dur. |
| 3 | Grosse Canicule (`canicule`) | Eau : palier modéré 0-2 |
| 4 | Ouragan Monstrueux (`ouragan`) | Pêcher et Bois : palier léger 1-2 |
| 5 | Invasion de Gobelins (`gobelins`) | Bouton Explorer retiré (`isExplorerDisabled()`) ; vol de 5 Poissons si Bois `< 5` après conso (`computeGobelinsTheft()`) |
| 6 | Indigestion Royale (`indigestion_royale`) | Eau : palier léger 1-2 |
| 7 | Épave échouée (`epave`) | Don de **Bois** `max(bois_min, bois_base − V_veille)` = `max(5, 19 − V)` (`computeEpaveBoisBonus()`). ⚠️ Don de Bois, jamais de points de Radeau directs (rendrait la victoire Radeau quasi certaine). |

⚠️ Les événements ne figurent jamais dans l'embed Règles (`buildReglesEmbed()`) : surprise volontaire.

### Radeau

- `points_par_section` (4) × `radeau_sections_max` (5) = **20 points** pour la victoire.
- Victoire **jamais annoncée au clic** : détectée au cron suivant, qui court-circuite conso et défaite (y compris si c'est l'Épave qui fait franchir le seuil).
- **Verrou « Grosse Houle »** (`robinson.json.radeau_verrouille`, `isRadeauDisabled(jour, radeau_verrouille)`) : bouton Radeau masqué Jours 3-4 (`jour_debut`/`jour_fin`), texte narratif dans l'embed, refus au clic en filet de sécurité. Empêche un rush des 20 points en une journée. `radeau_verrouille` absent/`null` = pas de verrou. Jamais annoncé dans les Règles.

### Manches

Score de classement (`computeMancheScore(outcome, jour, dureeJours)`) : victoire Radeau `1000 + (dureeJours + 1 − jour)` (plus tôt = mieux) ; victoire survie `500` (identifiant interne `victoire_jour11` conservé, voir `outcomeLabel()`) ; défaite = `jour`. L'embed de fin liste les 10 dernières manches avec 🏆 sur la meilleure. `archiveManche({ outcome, jour, radeauPoints, resolvedAt })`.

### Config (`jeux/data/robinson/robinson.json`)

`duree_jours` (7), `radeau_sections_max` (5), `bois_par_point_radeau` (1), `points_par_section` (4), `stocks_initiaux` (`{ poisson: 11, eau: 11, bois: 6 }`), `radeau_verrouille`, `actions`, `evenements`. Chargée une fois (`loadRobinsonConfig()`), jamais mutée. Constantes dans le code : `ZERO_STREAK_LIMIT = 2`, seuil Gobelins 5 et vol de 5 Poissons. `narratifs.json` : textes cosmétiques.

### Redis (`robinson:*`)

| Clé | Type | Contenu |
|---|---|---|
| `robinson:state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine, event, chefExplorateurId, chefCharpentierId, zeroStreaks, dayVoters }`, muté au cron |
| `robinson:stock:poisson` / `:eau` / `:bois` | compteur | stocks, `INCRBY`/`DECRBY` uniquement |
| `robinson:radeau_points` | compteur | points de Radeau |
| `robinson:votes:<jour>` | HASH | `discordId → actionId` (effacé à la clôture) |
| `robinson:vote_details:<jour>` | HASH | `discordId → { actionId, amount\|yields\|pointsAdded, isChef?, isCharpentier?, at }` (réaffichage sans re-tirage) |
| `robinson:vote_usernames:<jour>` | HASH | `discordId → pseudo` (affichage admin) |
| `robinson:historique` | HASH | `jour → { V, radeauVotes, stocksAvant, stocksApres, consumption, gobelinsVoleur, event, outcome, resolvedAt }`, manche en cours, alimente le Journal de Bord |
| `robinson:manches` / `robinson:manche_seq` | HASH / compteur | archive permanente des manches |

Le bouton `[📜 Journal de Bord]` affiche aussi les points de Radeau et, seulement si une ressource est en streak, les compteurs `zeroStreaks`.

### Scripts et workflow

| Commande | Effet |
|---|---|
| `npm run robinson:test` / `:test:dry` | salon de test (`DISCORD_CHANNEL_FRAME_TEST`) / aperçu console |
| `npm run robinson:public` / `:public:dry` | salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) / aperçu |
| `npm run robinson:reset` | efface état, stocks, votes, historique (**destructif**, garde les manches) |
| `npm run robinson:reset:manches` | idem + `robinson:manches`/`manche_seq` |
| `npm run robinson:status` | état courant + projection du jour suivant |
| `npm run robinson:refresh` / `:refresh:dry` | réédite le message du jour en place (sans clôturer) après un correctif de texte |

Workflow `.github/workflows/robinson.yml` : cron `8 8 * * *` UTC (avec `--require-active`) + `workflow_dispatch` (lancement). Variables : `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_FRAME_PUBLIC`/`_TEST`, `KV_REST_API_URL`/`KV_REST_API_TOKEN` (aucune spécifique).

---

## Blackjack — bats le Croupier

Jeu spécial de 7 jours (`duree_jours`) : chaque membre affronte le Croupier en solo, une main par jour, classement cumulé révélé après le Jour 7. Pas de commande slash.

| Rôle | Fichier |
| ---- | ------- |
| Règles, Redis | `jeux/services/blackjack.js` |
| Discord (embeds, boutons, `postBlackjack()`) | `jeux/discord/handlers/blackjack.js` |
| Routage des boutons | `jeux/discord/routes/jeuxSpeciaux.js` |
| Publication quotidienne | `jeux/scripts/postBlackjack.js` |
| Config | `jeux/data/blackjack/blackjack.json` : `duree_jours` (7), `croupier.min`/`croupier.max` (16-21) |

### Déroulement (Blackjack)

- Un seul message actif. `postBlackjack()` clôture le jour actif (`resolveDay()`, points attribués), puis publie le jour suivant ou, après le Jour 7, la révélation finale (`termine: true`, les runs suivants sont des no-op). Points et mains remis à zéro au passage au Jour 1.
- Garde-fou `isTooSoonSinceLastClosure()` (`MIN_HOURS_BETWEEN_CLOSURES` = 8 h) : empêche un cron en retard de re-clôturer un jour rouvert à la main. Contourné par `--force`, et automatiquement hors `--public` (`postBlackjack.js`).
- Une main `en_cours` à la clôture est figée sur son score courant (jamais ignorée).

### Croupier

- `dealerPlay()` tire un score entier uniforme dans `croupier.min`-`croupier.max` (pas de main simulée, donc jamais de saut) ; `buildHandForScore()` l'habille d'une main de 2 cartes, purement cosmétique.
- **Jours impairs** (`isDealerRevealed(n)` : `n % 2 === 1`) : score affiché dès l'ouverture (« 🎩 Score à battre aujourd'hui : N », avertissement si 21 pile : seule l'égalité est possible) ; le résultat est révélé au joueur dès que sa main est figée.
- **Jours pairs** : le Croupier « joue en second », son score (déjà tiré) reste caché jusqu'à la clôture ; ⚠️ aucun message ne doit le laisser fuiter, même sur un dépassement.

### Main du joueur

- `drawCard()` : rang uniforme parmi 13 (sabot virtuel par joueur, pas de deck partagé), couleur cosmétique. As = 11 ou 1.
- 🃏 **Jouer** (2 cartes, `stand` automatique sur 21), 🎴 **Piocher** (répétable), 🛑 **Arrêter**. Au-delà de 21 : `bust`, main perdue.
- Tout se joue en éphémère : rien n'est repatché sur le message public, la main reste secrète jusqu'au bilan du lendemain.

### Barème et classement (Blackjack)

| Résultat | Points (`pointsForResult()`) |
| -------- | ------ |
| Victoire | 2 |
| Égalité | 1 |
| Défaite, dépassement, main non jouée | 0 |

- `buildRanking(points, usernames, cardsDrawn)` : points décroissants, puis **moins de cartes piochées** sur la manche (`sumCardsPerPlayer()`, jours clôturés seulement, d'après `blackjack:historique`). Deux joueurs ne sont ex aequo qu'à points **et** cartes égaux. Le critère n'est pas affiché dans les embeds, seulement dans `blackjack:status`/`blackjack:scores` (colonne `Cartes`).
- Score de manche cumulé dans l'historique de saison des mini-jeux (`miniJeuxHistory.js`, champ `points`).

### Interface (Blackjack)

- Titre `🃏 Blackjack (Jour X/7)`. Cartes en titre Markdown rang+couleur (`# A♠️ K♥️`) : ⚠️ ne pas utiliser les glyphes Unicode de cartes (U+1F0A0-1F0DF), minuscules sur Discord.
- Bilan de la veille (`formatResultsSection()`) : résumé, seuls les gagnants sont nommés.
- Boutons `[🃏 Jouer]`, `[📜 Journal]` (main du jour, classement cumulé, 10 derniers jours), `[📖 Règles]`.
- Illustrations : `frontend/public/images/blackjack/blackjack-start.webp` (Jour 1, révélation finale) et `blackjack-game.webp` (autres jours), suffixe `?v=` (`BLACKJACK_IMAGE_VERSION`) à incrémenter après remplacement d'un fichier.
- La révélation finale liste les vainqueurs des manches précédentes.

### Manches (Blackjack)

`archiveManche({ ranking, winners, maxPoints, resolvedAt })` archive chaque partie terminée dans `blackjack:manches` (numéro via `INCR blackjack:manche_seq`), **uniquement en publication publique** (`isPublic: true`), jamais en dry-run ni sur le salon de test.

### Stockage Redis (`blackjack:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `blackjack:state` | STRING | `{ phase, jour, dealer, channelId, messageId, publishedAt, termine }` |
| `blackjack:points` | HASH | `discordId → points` de la manche (`HINCRBY`) |
| `blackjack:usernames` | HASH | `discordId → pseudo` (repli d'affichage) |
| `blackjack:hand:<jour>` | HASH | `discordId → { cards, score, status, username }` |
| `blackjack:historique` | HASH | `jour → { jour, dealer, results, resolvedAt }`, effacé par `resetBlackjack()` |
| `blackjack:manches` | HASH | `manche → { manche, ranking, winners, maxPoints, resolvedAt }`, jamais nettoyé sauf `--manches` |
| `blackjack:manche_seq` | STRING | compteur de manches |

### Scripts et cron (Blackjack)

| Commande | Effet |
| -------- | ----- |
| `npm run blackjack:test` / `:test:dry` | Salon de test (`DISCORD_CHANNEL_FRAME_TEST`) / aperçu console |
| `npm run blackjack:public` / `:public:dry` | Salon public (`DISCORD_CHANNEL_FRAME_PUBLIC`) |
| `npm run blackjack:reset` | **Destructif** : partie en cours effacée, `blackjack:manches` préservé |
| `npm run blackjack:reset:manches` | **Destructif** : efface aussi l'archive des manches |
| `npm run blackjack:status` | État courant et projection de la clôture, sans Discord |
| `npm run blackjack:scores` | Classement cumulé seul |

Cron `.github/workflows/blackjack.yml` : `12 8 * * *`. Variables : `DISCORD_CHANNEL_FRAME_TEST`/`PUBLIC`, `DISCORD_TOKEN`, `KV_REST_API_URL`/`KV_REST_API_TOKEN`.

## Jeu du Gobelet — dés façon Yahtzee

Jeu spécial de 7 jours sur le squelette de Blackjack, sans adversaire : chaque jour, chaque membre lance 5 dés, en conserve 0 à 5 et relance les autres jusqu'à 2 fois (3 tirages), puis marque une combinaison. Pas de commande slash.

| Rôle | Fichier |
| ---- | ------- |
| Règles, Redis | `jeux/services/gobelet.js` |
| Discord (`postGobelet()`) | `jeux/discord/handlers/gobelet.js` |
| Publication quotidienne | `jeux/scripts/postGobelet.js` |
| Config | `jeux/data/gobelet/gobelet.json` : `duree_jours` (7), `diceEmojis`, `trophees` |

Même déroulement et mêmes garde-fous que Blackjack (`isTooSoonSinceLastClosure()` : copie propre dans `gobelet.js`, chaque jeu à cron a la sienne). Points et combinaisons utilisées remis à zéro au passage au Jour 1.

### Barème

`COMBINATIONS` (`gobelet.js`, ordre croissant) est la source unique du calcul et des règles affichées (`formatBaremeLines()`). Règles communes au jeu spécial et à Gobelet Duel.

| Résultat | Condition | Points |
| -------- | --------- | ------ |
| Aucune combinaison | rien de libre, Joker déjà utilisé | 0 |
| Joker (`JOKER`) | voir ci-dessous | somme des 5 dés |
| Double quelconque | au moins 2 dés identiques | 10 |
| Brelan | au moins 3 dés identiques | 20 |
| Pairs | 5 dés pairs | 25 |
| Impairs | 5 dés impairs | 25 |
| Juste total | somme exacte de 21 | 25 |
| Carré | au moins 4 dés identiques | 30 |
| Petite Suite | 4 valeurs consécutives parmi les 5 dés (5ᵉ dé libre) | 30 |
| Full | exactement 3 + 2 | 40 |
| Somme ≤ 7 | | 45 |
| Somme ≥ 28 | | 45 |
| Grande Suite | 1-2-3-4-5 ou 2-3-4-5-6 | 50 |
| Gobelet | 5 dés identiques | 60 |

- **Unicité** : chaque combinaison ne rapporte qu'**une fois par partie**. `computeBestCombination(dice, used)` retient la plus payante parmi les combinaisons présentes (`listMatchingCombinations()`) et pas encore réalisées ; égalité de points départagée par `CATEGORY_PRIORITY`.
- ⚠️ Double, Brelan et Carré sont des motifs « **au moins** N dés » (un Carré contient un Brelan), pour qu'un joueur ayant déjà fait Carré puisse marquer Brelan. Le Full reste strict.
- **Joker** (une fois par partie, hors `COMBINATIONS`) : retenu automatiquement seulement si rien d'autre n'est libre, ou choisi volontairement dans le select de fin de main. Le bouton Valider l'ignore (`allowJoker: false`) : impossible de le griller dès le 1ᵉʳ tirage.
- « Aucune combinaison » vaut 0 et n'est jamais consommée (`withUsedCategory()`).
- **Choix de la combinaison** : en fin de main (3ᵉ tirage ou Valider), `listChoices(dice, used)` liste les combinaisons libres présentes plus le Joker s'il est libre. Avec 2 choix ou plus, `finishHand()` passe la main en statut `"choix"` et le joueur choisit dans un select (`gobelet_choix:<jour>` / `gobeletduel_choix:<manche>`, validé par `pickChoice()`) ; sinon la main est figée directement.
- Combinaisons réalisées : `gobelet:used` / `gobeletduel:used` (`discordId → tableau JSON`), mises à jour **uniquement à la résolution** du jour ou de la manche ; affichées dans l'éphémère (« 🚫 Déjà réalisées »).

### Main du joueur (Gobelet)

- 🎲 **Jouer** lance 5 dés. Un bouton par dé (🔒 gardé / 🎲 relancé, ou la vraie face si `diceEmojis` est renseigné) : basculer ne consomme pas de tirage. La sélection **persiste** d'un tirage à l'autre (seuls les dés relancés repartent « non gardés »).
- 🔁 **Relancer** : relance les dés non gardés, 2 fois au plus.
- 👍 **Valider** : affiché dès que les dés courants forment une combinaison encore libre (hors Joker), y compris au 1ᵉʳ tirage ; son libellé ne nomme pas la combinaison. Un clic sur un bouton obsolète est ignoré, le message est repeint.
- Une main `en_cours` ou `"choix"` à la clôture est résolue par `resolveJour()` sur les dés courants (`computeBestCombination()`, Joker en dernier recours).
- Verrou par main (`withHandLock()`, clé `gobelet:lock:<jour>:<discordId>`, 10 s) : un clic qui trouve le verrou pris est ignoré (sinon des clics simultanés relançaient sans faire avancer le compteur).
- ⚠️ Dés gardés stockés à part, un champ de hash par dé (`gobelet:kept:<jour>:<discordId>`, `readKept`/`setKeptField`/`resetKept`) : deux clics simultanés sur des dés différents ne s'écrasent pas. Idem `gobeletduel:kept:<manche>:<discordId>`.

### Interface (Gobelet)

- Titre `🎲 Jeu du Gobelet (Jour X/7)`. Dés en titre Markdown avec des keycaps (`# 3️⃣ 5️⃣ 6️⃣ 2️⃣ 4️⃣`) : ⚠️ pas les glyphes U+2680-2685, minuscules sur Discord.
- Boutons `[🎲 Jouer]`, `[📜 Journal]`, `[📖 Règles]`.
- Illustrations `frontend/public/images/gobelet/gobelet.webp` (Jour 1, révélation finale) et `dices.webp` (autres jours), suffixe `?v=` (`GOBELET_IMAGE_VERSION`) ; originaux dans `jeux/data/gobelet/images/`.
- **Emojis de dés** : `npm run gobelet:emojis` (`jeux/scripts/uploadGobeletEmojis.js`) uploade `jeux/data/gobelet/images/dice-1.png` à `dice-6.png` comme emoji d'application ; coller les 6 IDs dans `diceEmojis`. Tant qu'ils valent `null`, emoji génériques.
- **Mentions spéciales** : `trophees` (`{ emoji, label, username }`, saisie à la main) affichées en « 🎖️ Mentions spéciales » dans la révélation finale. À vider pour la partie suivante.
- Archivage des manches : comme Blackjack (`archiveManche()`, public seulement). Le Gobelet n'est **pas** compté dans l'historique de saison des mini-jeux.

### Stockage Redis (`gobelet:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `gobelet:state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine }` |
| `gobelet:points` | HASH | `discordId → points` (`HINCRBY`) |
| `gobelet:usernames` | HASH | `discordId → pseudo` (repli) |
| `gobelet:hand:<jour>` | HASH | `discordId → { dice, tirage, status, category, points, username }` |
| `gobelet:kept:<jour>:<discordId>` | HASH | `"0".."4" → "1"/"0"` |
| `gobelet:lock:<jour>:<discordId>` | STRING | verrou de main (10 s) |
| `gobelet:used` | HASH | `discordId → [catégories réalisées]` |
| `gobelet:historique` | HASH | `jour → { jour, results, resolvedAt }`, effacé par `resetGobelet()` |
| `gobelet:manches` / `gobelet:manche_seq` | HASH / compteur | `manche → { manche, ranking, winners, maxPoints, resolvedAt }`, jamais nettoyé sauf `--manches` |

### Scripts et cron (Gobelet)

Mêmes commandes que Blackjack avec le préfixe `gobelet:` (`test`, `test:dry`, `public`, `public:dry`, `reset`, `reset:manches`, `status`, `scores`), plus `npm run gobelet:emojis` (upload one-shot des faces de dé). Cron `.github/workflows/gobelet.yml` : `16 8 * * *`. Variables : celles de Blackjack, plus `DISCORD_APP_ID` (upload des emojis).

## Bang! — dernier joueur en vie en 7 jours

Jeu spécial 100 % asynchrone inspiré d'Exploding Kittens : une pioche commune truffée de **Gobelins explosifs**, des cartes d'action pour piéger les autres, objectif être le dernier en vie. Pas d'ordre de passage, chaque action est résolue tout de suite.

| Rôle | Fichier |
| ---- | ------- |
| Règles pures (testées par `bangRules.test.js`) | `jeux/services/bangRules.js` |
| Redis | `jeux/services/bang.js` |
| Images | `jeux/services/bangImage.js` |
| Discord | `jeux/discord/handlers/bang.js` |
| Publication | `jeux/scripts/postBang.js` |
| Config | `jeux/data/bang/bang.json` |

### Cartes (Bang!)

Chaque carte est illustrée par une carte Clash Royale (`CARTES`).

| Carte | Carte CR | Effet |
| ----- | -------- | ----- |
| 💥 Gobelin explosif | Goblin Demolisher | Piochée : un Esprit de guérison en main est sacrifié, sinon le joueur explose (éliminé, main défaussée, le Gobelin explosif quitte le jeu). |
| 💚 Esprit de guérison | Heal Spirit | Sauve du Gobelin explosif, que le joueur cache ensuite dans la pioche (`POSITIONS` : haut, 2e, 3e, milieu, fond, hasard). Un en main au départ. |
| 🙏 Moine | Monk | Joué à l'avance, **secret** (absent du journal). La prochaine attaque ciblée (Gang, Malédiction, Voleuse) est renvoyée à l'attaquant. Actif jusqu'à la clôture, un seul à la fois, un renvoi ne se renvoie pas. |
| 🛢️ Fût à gobelins | Goblin Barrel | Annule une pioche due (Gang), sinon termine le tour sans piocher. Ne vise personne. |
| 🧿 Malédiction | Goblin Curse | La prochaine carte piochée par la cible (hors Gobelin explosif) devient un simple Gobelin ; reste active les jours suivants tant qu'elle n'est pas consommée. |
| 👊 Gang de gobelins | Goblin Gang | La cible doit piocher `gang_pioches` (2) cartes. Reçu avant son tour : minimum du menu de pioche relevé à 2. Reçu après : pioches dues en un clic (sans choix ni Bravoure), et le joueur peut rejouer des cartes (Fût…) tant qu'elles ne sont pas faites. |
| 🎯 Gobelin à sarbacane | Dart Goblin | Montre les 3 premières cartes de la pioche (éphémère). |
| 🦹 Voleuse | Bandit | Vole une carte au hasard dans la main de la cible. |
| 👺 Gobelin | Goblins | Sans pouvoir (dilue la main face à la Voleuse). |

### Règles (Bang!)

- **Inscription** au premier clic sur un bouton, jusqu'au jour `inscription_jours` (2) inclus (`agir()`). Le joueur reçoit un Esprit de guérison et `main_depart` (2) cartes de son paquet ; le reste est mélangé dans la pioche (`paquet_par_joueur` : gobelin 4, sarbacane 1, moine 1, fût 1, gang 1, malédiction 1, voleuse 1, esprit 0,5 ; un taux fractionnaire de 0,5 = un exemplaire tous les deux joueurs), plus `bombes_par_joueur` (1,5) Gobelins explosifs par joueur **à partir du deuxième** (`ajouterJoueur()`).
- **Tour** : le joueur joue ses cartes d'abord, puis pioche **1 à `pioches_par_jour` (3) cartes d'un coup**, ce qui termine son tour jusqu'à la clôture (`joueur.tourFait`). Menu `choixPioche()` : de `max(1, dette)` à `pioches_par_jour`, borné par la taille de la pioche ; `piocherClic(…, { nb })` pose `dette = nb`, `bonus = nb - min`. La pioche s'arrête sur un Gobelin explosif désamorcé ; les cartes restantes sont piochées dès qu'il est caché.
- Jouer une carte est gratuit, dans la limite de `cartes_par_jour` (3) par jour (`joueur.jouees`) : empêche les rafales sur une même cible. Jamais obligé de jouer la carte piochée.
- **Une attaque de chaque type subie par jour** (`UNIQUES` : Gang, Voleuse, Malédiction ; `joueur.subies`) quel que soit l'attaquant ; un attaquant peut viser plusieurs cibles. `jouer()` renvoie `dejaSubie` (carte gardée), le menu n'affiche que les cibles attaquables (`ciblesPossibles()`). Une attaque renvoyée par un Moine compte pour l'attaquant.
- **Clôture** (`cloturer()`, cron), dans un ordre aléatoire : Gobelin explosif pas encore caché placé au hasard ; chaque survivant qui n'a ni pioché ni joué de Fût pioche automatiquement `max(dette, pioches_auto)` (2) cartes (pénalité de passivité, sans Bravoure) ; Moines, `subies`, `jouees`, `dette` remis à zéro.
- **🔥 Bravoure** (`joueur.bravoure`) : `bravoure.pioche` (1) par carte piochée au-delà du minimum du tour (sur les `bonus` dernières pioches, jamais pour une carte non piochée) ; `bravoure.attaque` (1) par attaque aboutie (Gang, Malédiction, Voleuse, même sur main vide ; en cas de renvoi, c'est le joueur protégé qui la gagne). Le Fût n'en rapporte pas.
- **Fin** : dès qu'il ne reste qu'un joueur (message final posté par l'action éliminatoire, résultat figé une seule fois par `figerResultat()`), sinon à la clôture du jour `duree_jours` (7).
- **Classement** (`classement()`, ordre strict, pas de `rangExAequo`) : survivants d'abord, par Bravoure, puis Esprits en main, nombre de cartes, ordre d'arrivée ; puis éliminés du dernier au premier. **Score = nombre de joueurs classés derrière**, cumulé dans l'historique de saison des mini-jeux.

**Équilibrage** : `jeux/outils/bang/simulateBang.mjs` (bots passif/prudent/hardi/audacieux) et `jeux/outils/bang/simulateLimite.mjs` (plafond de cartes jouées). Avec les réglages actuels, à 15-18 joueurs (cible habituelle) : environ 5 % / 1 % de parties finies avant le J7, 3,7 / 4,5 survivants, et un profil passif quasi jamais gagnant. Le nombre de Gobelins (4 par joueur) dilue les Gobelins explosifs pour compenser les pioches volontaires.

### Interface (Bang!)

- **Message officiel** (un par jour, réédité après chaque action par `rafraichirTable()`) : intro au J1, puis bilan de la veille (« 📰 Hier dans l'Arène » : explosions, sauvetages, attaques, renvois, pioches automatiques ; `partie.jour` archivé dans `partie.veille`), pioche et Gobelins explosifs restants, survivants, éliminés, et seulement les faits cruciaux du jour (« 💥 Aujourd'hui »). Boutons **Piocher**, **Jouer une carte**, **Journal**, **Règles**, en éphémère.
- ⚠️ Plateau **joint au message** (`joindreImage()`, `attachment://plateau.png`) plutôt que confié par URL (le proxy Discord dépassait son délai sur un rendu à froid, l'image disparaissait d'une édition à l'autre). Chaque envoi liste la seule pièce jointe à garder (`attachments`), même au repli sur l'URL, sinon l'ancien plateau reste affiché.
- **Piocher** (`buildPiocheView()`) : menu « Combien de cartes piocher ? » (`bang_nbpioche`, avec la Bravoure de chaque option ; option « Imposé par le Gang de gobelins » après un Gang), cartes piochées, menu « Où cacher le Gobelin explosif ? » après un désamorçage, bouton « Piocher (N) » pour des pioches dues.
- **Jouer une carte** (`buildJouerView()`) : dernier résultat, alertes (Gang, Malédiction, Moine actif), Bravoure, image de la main, menu des cartes jouables avec leur effet, menu des cibles, Annuler.
- **Journal** (`handleJournal()`) : ce qui concerne le joueur, par jour, du plus récent au plus ancien. `partie.journal` (1000 entrées au plus) : `{ j, k, s, v, c, ids, … }` pour un événement public, rédigé à l'affichage par `texteJournal()` (2e personne pour le lecteur, 3e sur le message officiel) ; `{ j, t, p }` pour une note privée. Les mains restent secrètes ; le Moine joué n'apparaît pas.

### Images (Bang!)

Routes dans `jeux/server/imageRoutes.js`, dessin des cartes via `@clash/clash-royale/cardImage.js`.

- `/api/bang/main?c=id1|id2|…` : main du joueur (cartes seules, 5 par ligne, badge `×N`), cache CDN (`s-maxage`).
- `/api/bang/table?d=…` : plateau sur le tapis `bang-table.jpg` (⚠️ JPEG : resvg ne décode pas le WebP embarqué) ; état encodé dans l'URL (`encodeTable()`, base64url), donc nouvelle URL à chaque action, ce qui contourne le cache Discord. Avatars sur anneau doré avec le nombre de cartes, gris barrés pour les éliminés. Rendu local : `node jeux/outils/bang/renderTable.mjs <sortie.png> [joueurs] [éliminés]`.
- **Avatars** : 12 créatures DiceBear Clay (CC0), `jeux/data/bang/avatars/clay-01…12.png`, attribués par ordre d'arrivée décalé au hasard (`partie.decalageAvatars`), répétés au-delà de 12 joueurs.
- `/api/bang/illustration` : `bang-launch.webp`, message de présentation.
- Assets servis depuis Vercel Blob : `npm run assets:upload-blob -- bang` après modification.

### Stockage Redis (`bang:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `bang:state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing }` |
| `bang:partie` | STRING | `{ pioche, joueurs, journal, numeroJour, elimines, termine, jour, veille, decalageAvatars }` ; joueur : `{ username, main, bravoure, pioches, bonus, subies, vivant, moine, maudit, dette, tourFait, jouees, enAttente, arrivee, rangElimination }`. Réécrite sous verrou à chaque action. |
| `bang:resultat` | STRING | classement final (écrit une fois) |
| `bang:lock` | STRING | verrou des actions (10 s) |
| `bang:manches` / `bang:manche_seq` | HASH / compteur | `{ manche, vainqueur, scoreGagnant, nbJoueurs, ranking, resolvedAt }` des parties publiques, jamais nettoyé sauf `--manches` |

### Scripts et cron (Bang!)

| Commande | Effet |
| -------- | ----- |
| `npm run bang:test` | Salon de test. Au passage au J1, inscrit 6 ou 7 **PNJ** (`pnj-N`) qui ne jouent pas mais piochent à la clôture et servent de cibles (`-- --sans-pnj` pour s'en passer). |
| `npm run bang:test:dry` / `bang:public` / `bang:public:dry` | Aperçu / salon public / aperçu public |
| `npm run bang:reset` / `bang:reset:manches` | **Destructif** (le second efface aussi l'archive) |
| `npm run bang:status` | Vue organisateur (pioche, mains, effets en cours) |

Test de bout en bout local (Redis et Discord simulés) : `node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/bang/e2eBang.mjs [joueurs]`. Cron `.github/workflows/bang.yml` : `18 8 * * *`. Variables : `DISCORD_CHANNEL_FRAME_TEST`/`PUBLIC`, `DISCORD_TOKEN`, `KV_REST_API_URL`/`TOKEN`, `BLOB_READ_WRITE_TOKEN`.

## Qui est-ce ? — démasquer les cartes secrètes en 7 jours

Jeu spécial 100 % asynchrone : chaque joueur reçoit en secret une carte d'une grille commune et chasse les cartes des autres, avec **une question par jour** sur sa cible puis une accusation. Un objet gratuit par jour, offensif (contre sa cible) ou défensif (contre son chasseur).

| Rôle | Fichier |
| ---- | ------- |
| Règles pures (testées par `quiestceRules.test.js`) | `jeux/services/quiestceRules.js` |
| Redis | `jeux/services/quiestce.js` |
| Grille | `jeux/services/quiestceImage.js` |
| Discord | `jeux/discord/handlers/quiestce.js` |
| Publication | `jeux/scripts/postQuiEstCe.js` |
| Config | `jeux/data/quiestce/quiestce.json` |

Effectif `effectif_min` (10) à `effectif_max` (18), fenêtre d'inscription `fenetre_inscription_jours` (2), clôture calée sur le cron (`dateCloture()` : 8h20 UTC). Roster figé au lancement (aucune arrivée ensuite).

### Grille et questions

- **Grille** (`tirerGrille()`) : `taille_grille` (30) cartes de `jeux/data/cardNames.json` (au moins une par joueur), **une seule carte par profil de réponses** (sinon deux cartes seraient indiscernables), au moins 4 sorts, 2 bâtiments, 3 troupes aériennes, 1 ou 2 champions.
- **Compléments** : les troupes sans PV ni portée dans `cardNames.json` (exclues de La Juste Carte par `jeux/scripts/generateCardStats.js`) sont complétées pour Qui est-ce ? seulement par `complements` de `quiestce.json` (`completerCartes()`) : Gobelin géant, Machine gobeline, Dragon de l'enfer, Maître Mineur, Moine, Cavabélier, Buisson suspicieux, Trois mousquetaires. ⚠️ Ne pas les ajouter à `cardNames.json` (elles entreraient dans La Juste Carte).
- **Cartes écartées** (`carteEligible()`) : toute carte sans coût connu (Miroir) ou troupe sans PV/portée après compléments (Gang de gobelins, Fripons, Impératrice spirituelle : réponses ambiguës).
- **6 questions en tranches** (`QUESTIONS`) :

| Question | Réponses |
| -------- | -------- |
| 💎 Rareté | commune, rare, épique, légendaire ou champion (regroupés) |
| 💧 Élixir | 1 ou 2, 3, 4, 5 ou plus |
| 🧩 Type | troupe terrestre, troupe aérienne, sort, bâtiment |
| 🏹 Portée | mêlée, distance ; « sans objet » (sort, bâtiment) |
| 👪 Famille | humain, gobelin, squelette, gargouille, aucune |
| ❤️ Points de vie | moins de 500, 500 à 1500, plus de 1500 ; « sans objet » (sort, bâtiment) |

- **Questions du jour** : 3 de base (`pool`, par jour) plus une 4e débloquée par la Loupe (`pool_loupe`). Une question déjà connue sur la cible n'est plus proposée ; si toutes celles du jour le sont, choix libre parmi les autres (`questionsPossibles()`).

### Règles (Qui est-ce ?)

- **Jour 1** (`demarrer()`) : grille tirée, une carte secrète par inscrit, première cible **en cercle** (chacun chasse le suivant d'un ordre aléatoire).
- **Indice de départ** (`assignerCible()`/`donnerIndice()`) : à chaque nouvelle cible, une caractéristique inconnue tirée au hasard, de préférence hors des questions du jour (Loupe comprise).
- **Chaque jour** : `questions_par_jour` (1) question, toutes cibles confondues ; puis une accusation au plus (`accusationsRestantes()`), parmi les cartes encore possibles.
- **Accusation juste** : +`points_carte` (3), plus `bonus_efficacite` selon le nombre d'indices connus (indice de départ compris) : +3 avec 1, +2 avec 2, +1 avec 3, rien au-delà. La cible perd `malus_demasque` (2). Le démasquage est public, la carte reste connue du seul chasseur ; la cible garde sa carte (peut être redémasquée par un autre).
- **Choix de la cible suivante** (`choisirCible()`, `ciblesDisponibles()`) : au plus `chasseurs_max` (2) chasseurs par cible, jamais un joueur déjà démasqué par ce chasseur ; liste triée du meneur au dernier, meneur présélectionné (« 🎯 Viser X (N pts) »).
- **Accusation ratée** : carte barrée, comptée dans le départage, note privée uniquement.
- **Survie** : +`bonus_survie_jour` (1) à chaque clôture pour tout joueur **actif ce jour-là** (`actifJour` : question, accusation, objet ou choix de cible) et non démasqué (`demasqueJour`). Un absent ne marque rien et peut finir en négatif.
- **Fiche d'enquête** (`candidats()`) : cartes incompatibles barrées, ainsi que sa propre carte et les cartes déjà découvertes (`cartesConnues`).
- **Fin** à la clôture du jour `duree_jours` (7). **Classement** (`classement()`) : `points()` = `pointsCartes` + `bonus` + `survie` − `malus`, puis le plus de cartes découvertes, le moins d'accusations ratées, le premier à avoir atteint son total (`seqScore`), l'arrivée. Score de manche = points, cumulé dans l'historique de saison des mini-jeux.

**Équilibrage** : `jeux/outils/quiestce-sim/` (`sim-v2.mjs` avec `CHOIX=1 BROUILLARD_FORT=1` pour cibles et objets, `bareme.mjs` pour le barème, `accelerateurs.mjs` pour l'indice de départ). Le choix de la cible fait du meneur la cible naturelle (rattrapage sans règle dédiée) ; le barème 3/−2 avec survie limitée aux jours joués écarte les scores et pénalise les absents.

### Objets

Un objet tiré au hasard à la **première action du jour** (`debutAction()`, `tirage_objets` équiprobable), gardé jusqu'à `inventaire_max` (3, au-delà rien n'est reçu). **Un seul objet utilisé par jour** (`etatObjet()` donne la raison d'un objet inutilisable).

| Objet | Famille | Effet |
| ----- | ------- | ----- |
| 🔍 Loupe | offensif | 4e question au choix aujourd'hui (`pool_loupe`), toujours une seule question. Inutilisable une fois la question posée. |
| 🎯 Double accusation | offensif | Deux accusations aujourd'hui sur la cible actuelle (`doubleCible`), même si une accusation a déjà visé une cible précédente. |
| 🧨 Désamorçage | offensif | Coupe le Brouillard ou le Miroir actif de la cible, sinon détruit un objet défensif de sa réserve. La cible est prévenue. |
| 🌫️ Brouillard | défensif | Public, jusqu'à la clôture : questions sur le joueur sans réponse (question perdue) et, avec `brouillard_bloque_accusation`, aucune accusation possible. |
| 🎭 Déguisement | défensif | Carte échangée contre une carte libre (`cartesLibres()` : ni attribuée ni déjà découverte) ; indices des chasseurs et renseignements du Miroir sur lui effacés ; annoncé publiquement. |
| 🪞 Miroir | défensif | Secret, jusqu'à la clôture : la prochaine question posée sur le joueur lui révèle la même caractéristique de la carte de son chasseur (`renseignements`, réinjectés si ce chasseur devient sa cible). |

### Interface (Qui est-ce ?)

- **Message officiel** (réédité après chaque action, `rafraichirMessage()`) : bilan de la veille (« 📰 Hier »), classement (« 2 pts (3 cartes découvertes, 1× démasqué) »), tableau de chasse (« **Chasseur** → cible (N ❓) », 🌫️ sous Brouillard, joueurs sans cible, joueurs non chassés), faits du jour. Grille publique **jointe au message** (`attachment://`, même raison que Bang!). Boutons **Jouer**, **Règles**, **Journal**.
- **Enquête** (`buildEnqueteView()`, éphémère) : objet reçu, carte secrète, points, défenses actives, chasseurs et nombre de questions posées sur soi, rival sur la même cible, « Ce que tu sais sur X » (indices et source), et trois menus : question du jour, accusation (25 cartes par menu, masqués sous Brouillard), « 🎒 Utiliser un objet » ; fiche d'enquête en image. Sans cible : bouton « Viser » et menu des autres cibles.
- **Journal** : ce qui concerne le joueur, par jour ; même format d'entrées que Bang! (`texteJournal()`).
- **Fin** : classement aux points avec toutes les cartes tenues (`anciennesCartes`, Déguisements compris), manches précédentes, illustration de lancement (`illustrationUrl()`).

### Images (Qui est-ce ?)

- `/api/quiestce/grille?d=…` (`jeux/server/imageRoutes.js`) : grille 6 colonnes (cartes via `cardImage.js`), publique ou fiche d'enquête (cartes barrées). État encodé dans l'URL (`encodeGrille()`), cache CDN. Rendu local : `node jeux/outils/quiestce/renderGrille.mjs <sortie.png>`.
- `/api/quiestce/illustration` : `quiestce-launch.webp`, jointe au message (`attachment://`) : confiée par URL, elle disparaissait à la réédition. Asset Blob : `npm run assets:upload-blob -- quiestce`.

### Stockage Redis (`quiestce:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `quiestce:state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing, closingAt, openedAt, cloture }` |
| `quiestce:partie` | STRING | `{ demarree, grille, cartes, joueurs, journal, numeroJour, seq, termine, jour, veille }` ; joueur : `{ username, arrivee, carte, anciennesCartes, cible, enquete: { infos, ordre, sources, posees, eliminees }, demasques, cartesConnues, nbDemasque, pointsCartes, bonus, survie, malus, actifJour, demasqueJour, erreurs, seqScore, objets, renseignements, questionsJour, loupe, accusationsJour, accusationsCible, doubleCible, objetJour, objetRecuJour, brouillard, miroir }`. Réécrite sous verrou. |
| `quiestce:resultat` | STRING | classement final |
| `quiestce:lock` | STRING | verrou (10 s) |
| `quiestce:manches` / `quiestce:manche_seq` | HASH / compteur | `{ manche, vainqueur, scoreGagnant, nbJoueurs, ranking, resolvedAt }`, jamais nettoyé sauf `--manches` |

### Scripts et cron (Qui est-ce ?)

| Commande | Effet |
| -------- | ----- |
| `npm run quiestce:test` | Salon de test : 1er lancement = inscriptions, 2e = Jour 1 immédiat (clôture forcée), puis un jour par lancement. Inscrit des **PNJ** (6 ou 7, ou plus pour atteindre `effectif_min`) qui ont carte et cible mais ne jouent jamais (`-- --sans-pnj` pour s'en passer). |
| `npm run quiestce:test:dry` / `quiestce:public` / `quiestce:public:dry` | Aperçu / public / aperçu public |
| `npm run quiestce:reset` / `quiestce:reset:manches` | **Destructif** |
| `npm run quiestce:status` | Vue organisateur (cartes, cibles, indices, objets) |

Options de `postQuiEstCe.js` : `--force` (garde-fou anti-double-avancée), `--force-close` (ignore la date de clôture). E2E local : `node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/quiestce/e2eQuiEstCe.mjs [joueurs]`. Cron `.github/workflows/quiestce.yml` : `20 8 * * *`. Variables : comme Bang! (`BLOB_READ_WRITE_TOKEN` pour la police et l'illustration).

## Meow — trois bandes de chats squattent la maison en 7 jours

Jeu spécial **en équipe et en temps réel** : un Risk simplifié. Trois bandes (🟠 Roux, ⚫ Chats noirs, 🔵 Chartreux) se disputent les 20 coins d'une maison ; chaque joueur reçoit des chats trois fois par jour, les **appelle** sur les coins de sa bande et **squatte** les coins voisins (dés du Risk). Chaque soir, chaque coin tenu rapporte 1 point à sa bande. Les chats disponibles sont limités pour tous : le volume de clics ne décide pas.

| Rôle | Fichier |
| ---- | ------- |
| Règles pures (testées par `meowRules.test.js`) | `jeux/services/meowRules.js` |
| Redis | `jeux/services/meow.js` |
| Carte | `jeux/services/meowImage.js` |
| Discord | `jeux/discord/handlers/meow.js` |
| Publication | `jeux/scripts/postMeow.js` |
| Config | `jeux/data/meow/meow.json` |
| Simulateur | `jeux/outils/meow-simulation/simulate.mjs <parties> <scénario>` |

Effectif `effectif_min` (14) à `effectif_max` (22), fenêtre `fenetre_inscription_jours` (2), clôture calée sur le cron (`dateCloture()` : 7h22 UTC).

### Carte (Meow)

- Les joueurs voient des **territoires** ; le code dit **coins** (`COINS`, `partie.coins`).
- **5 pièces de 4 coins** (`PIECES`) : Chambre (Fenêtre, Couette, Armoire, Carton), Grenier (Malle, Chapeaux, Poutre, Lucarne), Salon (Radiateur, Canapé, Tapis, Bibliothèque), Cuisine (Évier, Frigo, Corbeille, Gamelle), Jardin (Arbre, Perron, Potager, Cabane).
- **Voisinage** (`VOISINS`) : tous les coins d'une pièce se touchent ; entre pièces, seulement par les **6 passages** (`PASSAGES`, 🐾) : Carton ↔ Canapé, Armoire ↔ Malle, Évier ↔ Chapeaux, Gamelle ↔ Bibliothèque, Tapis ↔ Perron, Cabane ↔ Lucarne.
- ⚠️ **Carte symétrique** : chaque pièce de départ a deux sorties sur deux coins distincts (une vers le Salon, une vers le Grenier) et aucune bande n'en touche une autre au départ. Une pièce dont toutes les sorties partent d'un seul coin est enfermée dès que ce coin tombe.
- **Départs** (`BANDES`) : Roux en Chambre, Chats noirs au Jardin, Chartreux en Cuisine, `chats_depart` (2) par coin ; Salon et Grenier : `chats_errants` (2) chats errants par coin (`b = -1`), qui ne squattent ni ne reçoivent jamais de chats.
- **Paniers imprenables** (`PANIERS`) : Fenêtre (Roux), Potager (Noirs), Frigo (Chartreux), hors passages. Jamais squattables : une bande n'est jamais éliminée. Seule la bande d'origine peut donc tenir sa pièce de départ entière.

### Règles (Meow)

- **Lancement** (`demarrer()`) : bandes égales tirées au sort parmi les premiers inscrits ; les 1 ou 2 derniers inscrits au-delà d'un multiple de 3 (ordre `arrivee`) vont chacun dans une bande différente. Première distribution immédiate. Chaque joueur (hors PNJ) reçoit en MP sa bande, sa pièce, son panier et la composition des trois bandes (`envoyerBandesEnMp()` ; un MP refusé ne bloque rien).
- **Temps réel paresseux** (`rattraper()`) : aucun cron horaire. Les événements passés (heure de Paris, `evenementsEntre()`) sont rattrapés dans l'ordre au début de chaque action et publication : distributions (`distributions` : 8 h, 13 h, 21 h), décompte (`heure_decompte` = 24 : minuit, compte pour le jour qui s'achève), sieste (0 h à `fin_sieste` = 8 h). Combats abandonnés expirés au même moment.
- **Distribution** (`distribuer()`) : `chats_par_distribution` (2) chats par joueur, réserve plafonnée à `stock_max` (3) ; squats et déplacements remis à zéro. ⚠️ **Recharge équilibrée** : une petite bande reçoit au total autant de chats qu'une grande (chaque joueur cumule `(taille max / taille de sa bande − 1) × chats_par_distribution` dans `frac`, versé chat par chat) ; sans elle, une bande de 4 contre 3/3 gagnait 74 % des parties.
- **Croquettes** : à chaque distribution, une bande qui tient une pièce entière reçoit `croquettes[pièce]` (1) chat, posé sur le coin le plus menacé de la pièce.
- **Appeler** (`appeler()`) : toute la réserve va sur un coin de sa bande, à toute heure (sieste comprise), sauf coin en combat.
- **Déplacer** (`deplacer()`) : 1 chat d'un coin de sa bande (qui en garde au moins 1) vers un coin voisin de sa bande, `deplacements_par_distribution` (1) fois entre deux distributions, à toute heure (`deplacementsPossibles()` : vers le coin le plus menacé d'abord).
- **Sieste** (0 h à 8 h) : aucun squat. À 0 h, juste après le décompte, **1 seul chat** en réserve par joueur s'installe sur le coin le plus menacé de la bande (`siester()`, `j.nuit` affiché le lendemain). `menace()` = plus forte pile adverse voisine moins 1, moins les chats présents (errants exclus). Un absent ne perd jamais ses chats.
- **Squatter** (`lancerSquat()`) : depuis un coin de sa bande d'au moins 2 chats vers un coin voisin d'une autre bande ou errant (jamais un panier) ; 1 chat reste garder, les autres partent. `squats_par_distribution` (1) par joueur entre deux distributions, compté dès le lancement. Les chats d'un coin appartiennent à la bande : tout membre peut les engager.
- **Crêpage de poils** (`jouerManche()`) : l'attaquant lance jusqu'à 3 dés, le défenseur jusqu'à 2 ; plus hauts dés comparés deux à deux, le plus petit perd un chat, **égalité au défenseur**. 1re manche jouée au lancement, puis **Finir la baston** (`jusquauBout()`) ou **Battre en retraite** (`retraite()`, survivants rentrés). Victoire : les survivants occupent le coin pris. Pendant un combat, les deux coins sont verrouillés. Sans clic pendant `delai_combat_minutes` (5) : retraite automatique (le jeton d'un éphémère expire à 15 min).
- **⚔️ Mercenaires** (`envoyerMercenaires()`) : une fois, à la première distribution du jour `mercenaires.jour` (3), la bande dernière aux points (à égalité, le moins de coins) reçoit `mercenaires.par_joueur` (1) chat par joueur sur son coin le plus menacé (`partie.mercenaires`). Annoncé dans le message du jour, le Journal de bande et par MP (une fois, `notifie`). Effet surtout moral.
- **Décompte** (`decompter()`, minuit) : chaque coin tenu rapporte `points_territoire` (1) point à sa bande.
- **Fin** : après le décompte du jour `duree_jours` (7). Classement des bandes aux points, puis aux coins tenus (`classementBandes()`).
- **🏅 Caïd des coussins** (classement individuel, la victoire reste collective) : `caid.coin` (3) par coin pris + `caid.chat` (1) par chat adverse délogé (`scoreCaid()`). Secret jusqu'au message de fin (ni vue Jouer ni `/mini-jeux`).
- Meow n'est **pas** compté dans l'historique de saison des mini-jeux (jeu d'équipe).

**Équilibrage** (`simulate.mjs`, bots malins/naïfs, profils assidu/régulier/occasionnel/abandon) : chaque bande gagne entre 32 et 36 % de 12 à 20 joueurs (bandes inégales comprises), une bande naïve nettement moins, une bande entièrement assidue pas plus que les autres. Scénarios `actifs` (réserve et fréquence de jeu) et `deblocage` (mercenaires). ⚠️ Les bots doivent trancher leurs égalités au hasard (`bruit: true` dans `BASE`) : trancher par l'ordre des coins biaise les comparaisons de départs. Écartés : 3 dés en défense, plafond de chats par coin, bonus de départ par bande.

### Interface (Meow)

- **Message officiel** (réédité après chaque appel et fin de squat, `rafraichirMessage()`) : intro au J1, **🏆 Classement des bandes** (« 42 pts (8 territoires) »), **💥 Aujourd'hui** (bilan des squats, puis les 5 derniers territoires changés de main et « … et N autres plus tôt »), mercenaires le cas échéant, carte jointe. Boutons **Jouer**, **Ma bande**, **Règles**, **Journal**.
- **Jouer** (`buildJouerView()`, éphémère sans image) : bande, réserve, squats restants, compte à rebours avant la prochaine distribution (avertissement si réserve pleine), sieste, croquettes ; menus « 🐱 Appeler », « 😼 Squatter » (« Carton → Canapé · 4 chats contre 2 chats errants · 79 % de réussite », `pVictoire()` en jouant jusqu'au bout), « 🚚 Déplacer », grisés avec la raison quand l'action est impossible. Pendant un combat : vue Crêpage de poils (dés, chances, 2 boutons). Après un squat : titre « 🎉 Victoire ! », « 😿 Raté » ou « 🏃 Retraite » (`TITRES_ISSUE`).
- **💬 Ma bande** : messagerie signée réservée à la bande (`posterMessage()`, `messagesBande()`). Affiche les `messages_affiches` (15) derniers ; **Écrire** ouvre une fenêtre Discord (`type: 9`, `message_max` 200 caractères, espaces compactés) ; `messages_par_jour` (10) par joueur et par jour de jeu, revérifié à l'envoi ; 30 messages gardés par bande ; ouvrir la vue marque comme lu (`marquerLus()`), libellé « Ma bande (N) » en vert s'il y a du nouveau (`nouveauxMessages()`). Pas de ping.
- **Journal** : aujourd'hui et hier, ce qui concerne sa bande (territoires pris, perdus, retraites), du plus récent au plus ancien avec l'heure ; croquettes regroupées par jour.
- **Fin** : classement des bandes, **📰 La partie en bref** (`compteRendu()` : déroulé de la course, record de territoires, plus bel exploit `partie.exploit` si moins de 50 % de chances, effet des mercenaires ; chaque phrase omise si la donnée manque), 3 premiers du Caïd (classement complet archivé dans la manche), manches précédentes, illustration.
- **Ping** `@MINI-JEUX` : ouverture des inscriptions, annulation et fin seulement.

### Images (Meow)

- `/api/meow/carte?d=…` (`jeux/server/imageRoutes.js`) : carte en **JPEG** (`jpeg-js`, qualité 80) ; ⚠️ pas de `sharp` (trop lourd pour le Function Storage Vercel). Rendu sans état (`encodeCarte()` : par coin, bande `r`/`n`/`c`/`e` et nombre de chats sur 2 chiffres). Fond `meow-map.jpg` (1000×667) ; positions des pastilles dans `POSITIONS` (`meowImage.js`), à recalibrer si le fond change. Rendu local : `node jeux/outils/meow/renderCarte.mjs <sortie.jpg>`.
- `/api/meow/illustration` : `meow-launch.webp` (présentation et fin), jointe au message comme la carte.
- ⚠️ Pas de cache des cartes dans Vercel Blob (quota d'opérations avancées ~2 000/mois) : la carte est jointe au message (`attachment://`).
- Assets Blob : `npm run assets:upload-blob -- meow` après modification.

### Stockage Redis (`meow:*`)

| Clé | Type | Contenu |
| --- | ---- | ------- |
| `meow:state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing, closingAt, openedAt, cloture }` |
| `meow:partie` | STRING | `{ demarree, termine, joueurs, coins, combats, messages, points, decomptes, journal, exploit, mercenaires, jourDebut, debut, curseur, decalage, seqInscription, pnjActifs }` (`messages` : 3 listes de `{ p, t, txt }` ; `journal` : 400 entrées au plus ; `curseur` : instant du dernier rattrapage) ; joueur : `{ username, arrivee, bande, stock, frac, squats, deplacements, coinsPris, chatsDeloges, jourActif, nuit, messagesJour: { jour, n }, vuMessages }` ; coin : `{ b, n }` |
| `meow:lock` | STRING | verrou (10 s) |
| `meow:manches` / `meow:manche_seq` | HASH / compteur | `{ manche, vainqueur, points, nbJoueurs, bandes, ranking, resolvedAt }`, jamais nettoyé sauf `--manches` |

### Scripts et cron (Meow)

| Commande | Effet |
| -------- | ----- |
| `npm run meow:test` | Salon de test : 1er lancement = inscriptions, 2e = Jour 1 immédiat (clôture forcée) avec des **PNJ** pour atteindre l'effectif, qui jouent seuls à chaque distribution (`jouerPnj()`, `partie.pnjActifs` : chats sur le coin le plus menacé, sinon le plus garni, squats tant qu'une cible offre ≥ 60 %). Ensuite un jour par lancement : la partie de test suit sa propre horloge (`horloge()` = heure réelle + `partie.decalage`), avancée au lendemain 8h22 (`avancerHorloge()`), événements sautés rattrapés. |
| `npm run meow:test:distribution` | Salon de test : avance seulement jusqu'à la prochaine distribution (8h05, 13h05, 21h05). |
| `npm run meow:test:dry` / `meow:public:dry` | Aperçus console |
| `npm run meow:public` | Salon public (heure réelle) ; ne republie jamais deux fois le même jour sans `--force`. |
| `npm run meow:reset` / `meow:reset:manches` | **Destructif** (le second efface aussi l'archive) |

Options de `postMeow.js` : `--force`, `--force-close`. E2E local : `node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/meow/e2eMeow.mjs [joueurs]` ; autres outils de diagnostic dans `jeux/outils/meow/`. Cron `.github/workflows/meow.yml` : `22 7 * * *` (8h22 à Paris en hiver, après la distribution de 8 h). Variables : comme Bang! (`BLOB_READ_WRITE_TOKEN` pour fond, police, illustration).

---

## Goblin Hunters (identité secrète, camps cachés)

Jeu à identité secrète (Shadow Hunters / Loups-Garous) au rythme quotidien : **Villageois** (majorité, camp `chasseur`) contre **Gobelins infiltrés** (minorité ~2/5), sur **`duree_jours` (7) jours** au plus. Modèle Boss Raid : rien ne s'applique en direct (sauf la Messagerie), tout se résout **une fois à la clôture** dans la fonction pure `computeCloture()`.

- Service : `jeux/services/goblinhunters.js` (tests des fonctions pures dans `goblinhunters.test.js`, jamais des wrappers I/O). Handler : `jeux/discord/handlers/goblinhunters.js`. Image : `jeux/services/goblinhuntersImage.js`.
- Config : `jeux/data/goblinhunters/goblinhunters.json` ; textes : `narratifs.json`.
- Pas de commande slash : publication/clôture uniquement par `jeux/scripts/postGoblinHunters.js`.

### Déroulement

1. **Inscription** (`state.phase === "inscription"`) : ouverture manuelle (boutons ✅ S'inscrire / ✖️ Se désinscrire, ping `@MINI-JEUX`), rappel quotidien avec décompte, fenêtre de `fenetre_inscription_jours` (2). Clôture calée sur le cron (`dateCloture()` : 8h04 UTC). Dès `closingAt` passé, inscriptions et désinscriptions sont refusées (`refuserApresCloture()`) et un clic avant le passage du cron fige le message sur place (`cloturerInscriptions()`). Les inscrits ayant quitté le serveur sont désinscrits à la clôture. Au passage du cron :
   - moins de `effectif_min` (10) inscrits → partie **annulée** (`termine: true`, ping) ;
   - sinon `launchGame()` : roster figé, camps/rôles attribués, DM de rôle à chacun, inscriptions vidées.
   - `effectif_max` (18) atteint : inscription refusée au-delà (`registerPlayer()` → `full`) et lancement anticipé au prochain cron sans attendre `closingAt`.
2. **Jour de jeu** : chaque vivant choisit un lieu (bouton éphémère) qui détermine son action. Rien n'est publié en cours de journée.
3. **Clôture quotidienne** (`closeDayAndAdvance()`) : résout vote, combat, enquêtes, positions ; envoie les DM ; publie le bilan et le jour suivant (sans ping). Victoire ou fin du dernier jour : embed de fin avec révélation complète, ping `@MINI-JEUX`, `termine: true` (les runs suivants sont des no-op). Garde-fou anti-double-avancée : pas de nouvelle clôture moins de `MIN_HOURS_BETWEEN_CLOSURES` (8 h) après la précédente (`isTooSoonSinceLastClosure()`, contournable par `--force`).

### Lieux

| N° | Lieu (clé) | Action | Ciblage |
| --- | --- | --- | --- |
| 1 | Château (`chateau`) | vote d'accusation | libre sur tout vivant (sauf l'immunisé du jour) |
| 2 | Arène (`camp_entrainement`) | combat (seul lieu de combat) | joueurs présents à ce lieu sur le **dernier plateau connu** (`joueursAvant`), + joueurs révélés à l'attaquant par sa Clairière de la veille ; sauf l'immunisé |
| 3 | Tour de Guet (`tour_de_guet`) | enquête (révèle le camp) | présents sur le dernier plateau connu, hors cibles déjà enquêtées |
| 4 | Taverne (`taverne`) | protection | aucun |
| 5 | Clairière (`clairiere_mystique`) | vision | aucun : 2 vivants tirés au hasard |

Les numéros (`numero` dans la config) apparaissent sur l'image, les boutons (`1. Château`) et les règles. Le menu de cible ne propose que des cibles valides ; `computeAttacksFromActions()` / `computeInvestigations()` re-filtrent par défense.

### Règles de choix (handler `handleLieuButton()`)

- **Confirmation anti-missclick** : un clic sur un lieu répond d'abord « Ce choix sera définitif » avec [✅ Confirmer] (`goblinhunters_lieuok:<jour>:<lieu>:<slot>`) / [✖️ Annuler] (`goblinhunters_lieuko`). Rien n'est enregistré ni aucun nom de cible affiché avant confirmation.
- **Action définitive** sur tous les lieux : `isActionLocked(existingAction, slot, lieu)` refuse tout nouveau choix sur un slot déjà rempli. Exception `pending` : Arène et Tour de Guet enregistrent le lieu dès l'ouverture du menu de cible (`{ lieu, cibleId: null, pending: true }`), seul le même lieu peut être rouvert pour choisir la cible. ⚠️ Sans ce verrou, ouvrir le menu révélait gratuitement les noms des présents puis permettait de changer de lieu. Sans cible choisie avant la clôture, le filet de sécurité tire une cible.
- `recordAction()` reste « bête » (écrit ce qu'on lui donne, jamais d'état partiel) : toutes les gardes sont côté handler (et revérifiées dans `handleTargetSelect`).
- **Anti-camping** : `isLieuRepeatAllowed()` interdit le même lieu que la veille à partir du Jour 2 (sinon rester au Château donnerait une immunité totale au combat). Un joueur passif n'est jamais bloqué.
- **Éclaireur** : sa 2ᵉ action (`secondary`) doit viser un lieu **différent** de la 1ʳᵉ (pas 2 votes ni 2 attaques). Le verrou est par slot.
- **Jour 1** : Château et Arène restent cliquables mais sans effet (`LIEUX_SANS_CIBLE_JOUR1`, pas de menu de cible, confirmation dédiée, ligne d'info sur l'embed). Aucune élimination possible le Jour 1.
- ⚠️ Tout nouveau type d'action doit passer par `recordAction()` et le hash `goblinhunters:actions:<jour>`, jamais par un stockage parallèle (le vote est `{ lieu: "chateau", cibleId }`, extrait par `computeVoteTally()` / `extractVote()`).

### Résolution (`computeCloture()`)

Ordre : actions des bots de remplacement → **vote** (l'éliminé est retiré du combat) → **combat** → conversion Zombie → riposte Explosif / Guet-Apens → enquêtes → positions → Clairière → victoire → tirage de l'immunisé du lendemain.

- **Vote** (`resolveVoteElimination()`) : quorum `vote_quorum_min` (2) votes au total, sinon personne ; égalité au sommet → personne (pas de tirage). Voix contre l'immunisé ignorées.
- **Combat** : dégâts fixes (aucun aléa) selon l'attaquant : `degats_base` (1) Villageois, `degats_gobelin` (2) Gobelin, Bûcheron `roles.bucheron.degats` (2). Plusieurs attaques sur une même cible s'additionnent.
- **Plafond anti-snowball** (`resolveCombat()`) : 1 mort au combat par jour au plus ; si plusieurs cibles tombent à 0, seule la plus touchée meurt (égalité → tirage), les autres restent à 1 PV. Donc au plus 2 morts par jour (1 vote + 1 combat).
- **Taverne** (`computeTavernProtection()`) : protège ses occupants seulement si leur nombre est ≤ `taverne_seuil_protection` (3) ; au-delà, personne n'est protégé.
- **Tour de Guet surpeuplée** (`isTourDeGuetOvercrowded()`) : si **strictement plus** de `tour_de_guet_seuil_ratio` (0,5) des vivants y vont, aucune enquête n'aboutit ce jour-là (action consommée), annoncé dans le bilan et les règles.
- **Filet de sécurité** (`fallbackActorsFor()`) : un joueur à l'Arène ou à la Tour sans cible résolue (personne d'éligible, cible éliminée au vote, pas de cible choisie) agit sur un vivant tiré au hasard. À la Tour, le tirage exclut les cibles dont le camp lui est déjà connu (`knownEnqueteTargets()`, `pickRandomTarget(…, extraExcludeIds)`) ; une cible délibérée déjà connue bascule aussi sur le filet.
- ⚠️ `computeIndicesForDay()`, la riposte et le Guet-Apens réutilisent `result.attacks` du **même** tirage que la résolution des PV, jamais recalculé (sinon le carnet d'indices diverge de ce qui s'est passé).
- **Clairière** (`computeClairiereReveals()`) : révèle la position **finale du jour** de 2 vivants au hasard (jamais soi-même, jamais un éliminé du jour), en DM (la réponse éphémère du clic expire avant la clôture). Ces joueurs deviennent ciblables à l'Arène par ce voyant le lendemain, où qu'ils soient (`revealedTargetsForDay()`).
- **Immunité** : chaque clôture tire un survivant (`immuneIdSuivant` → `state.immuneId`, aucun en cas de victoire ni le Jour 1), annoncé publiquement ; le lendemain ses voix reçues ne comptent pas, il est protégé du combat et de la riposte, et exclu des menus du Château et de l'Arène (pas de la Tour).
- **Absents** : vivants sans action `primary` (une action `pending` compte comme jouée) replacés au Château et affichés dans le bilan (« 💤 N'a pas joué »). Après `absences_avant_remplacement` (2) absences consécutives, le joueur est remplacé par un bot de `bots_remplacants` (« Kévina », « Georgette ») : même `discordId`/camp/rôle/PV/position, pseudo « Kévina (bot) », annonce publique. Bot neutre (`computeBotActions()`) : au Château, il rejoint le meneur du vote seulement si majorité claire (meneur unique, quorum atteint sans lui), sinon Clairière le lendemain. Aucun DM aux bots ; l'ancien joueur humain est bloqué. Plus de bot libre → le joueur reste absent.
- **Victoire** (`checkVictory()`) : Gobelins vivants ≥ Villageois vivants (et > 0) → `gobelins_parite` ; plus aucun Gobelin → `chasseurs_gobelins_elimines` ; dernier jour atteint → `chasseurs_survie`.

### Rôles et PV

`assignCampsAndRoles()` : 1 exemplaire de chaque rôle par partie, quel que soit l'effectif.

| Rôle | Camp | Effet |
| --- | --- | --- |
| 🧭 Éclaireur | Villageois | 2 actions/jour, sur 2 lieux différents |
| 🪓 Bûcheron | Villageois | 1 PV, 2 dégâts |
| 🪤 Guet-Apens | Villageois | mort au combat → camp de tous ses attaquants du jour révélé publiquement (jamais au vote) |
| 🎭 Infiltré | Gobelin | une enquête sur lui renvoie toujours Villageois |
| 💣 Gobelin explosif | Gobelin | à sa mort : `degats_riposte` (1) à un Villageois, jamais mortel (`max(pv - 1, 1)`). Cible : un Villageois qui l'a attaqué (combat) ou un Villageois qui a voté contre lui (vote), hors immunisé |
| 🧟 Gobelin-zombie | Gobelin | une fois par partie : un Villageois achevé au combat par une attaque du Zombie vivant n'est pas tué mais **converti** (`camp: "gobelin"`, `role: null`, `roleOrigine` conservé, PV max d'un Gobelin, `converti: jour`) ; pas de Guet-Apens ni de riposte. Annonce publique « 🧟 … converti », DM au converti et aux Gobelins (`sendConversionDMs`) |

- PV : `pv_base` (2) pour tous (+ `gobelin_pv_bonus`, 0 actuellement), Bûcheron 1.
- `minority_table` (effectif → Gobelins) : 8→3, 9→4, 10→4, 11→5, 12→5, 13→6, 14→6, 15→6, 16→7, 17→7, 18→8. ⚠️ Ne jamais atteindre N/2 : la parité serait acquise dès le Jour 1 (100 % de victoires Gobelins). Les 3 rôles Gobelins doivent tenir à l'effectif plancher.
- Les Gobelins se connaissent (`otherGobelinsLine()` : coéquipiers vivants et ☠️ morts, dans le DM de rôle et le Journal). Le nombre de Gobelins est public (découle de la table) : l'embed affiche « 👺 Gobelins en vie : **N** ». Seul « qui » est secret.
- Les rôles sont décrits par `roleDescription(roleKey, config)`, partagée entre le DM de rôle (`sendRoleDM()`) et les Règles (`buildReglesEmbed()`), qui ne listent que les rôles de la partie en cours (`roleOrigine ?? role`, pour ne pas trahir une conversion).

### DM et vues privées

- **DM d'élimination** (`sendEliminationDM()`, vote et/ou combat) : jour, camp/rôle, cause (nombre de votes, ou combat avec le **camp** des attaquants via `formatAttaquantsCamps()`), effets Guet-Apens/Explosif le concernant. ⚠️ Jamais le nom des votants ni des attaquants (un mort n'a plus d'enjeu à se taire).
- DM d'enquête (`sendInvestigationDM()`) et de Clairière (`sendClairiereDM()`).
- **Journal** (bouton, éphémère, strictement personnel) : camp/rôle, coéquipiers Gobelins, position, PV, choix déjà validé du jour (`readPlayerAction()`), vivants annotés du camp connu (`vivantsLine()` : un Gobelin voit tout, un Villageois ses résultats d'enquête, donc l'Infiltré en 🗡️), et carnet d'indices cumulé (`computeIndicesForDay()`, `goblinhunters:indices`) : `enquete` (camp), `combat` (lieu de l'affrontement, jamais le camp), `reveal` (position courante).
- **Messagerie** (📬, en direct) : les 3 derniers messages anonymes (« Jour N », jamais l'auteur), lisibles par tous ; ✍️ Écrire réservé aux vivants n'ayant pas posté aujourd'hui (Modal, 200 caractères max). ⚠️ Anonymat structurel : le contenu (`goblinhunters:messages`) ne stocke jamais le `discordId` ; le quota vit à part (`goblinhunters:messages_sent:<jour>`) et est revérifié à l'écriture sur le jour relu depuis l'état.
- Bouton 📖 Règles en style vert (`3`), sur les embeds d'inscription et de jour.

### Embeds et images

- **Messages de tension** (`buildJourEmbed()`, `pickFlavor()` déterministe par jour) : `tension_gobelin_dernier` (1 Gobelin vivant), `tension_parite_proche` (Gobelins = Villageois − 1), `tension_double` (les deux), puis `tension_dernier_jour` (dernier jour) ou `tension_derniers_jours` (avant-dernier).
- **Plateau** (`GET /api/goblinhunters/image?jour=`) : `board.jpg` en fond SVG rastérisé par `@resvg/resvg-js`. Pastilles neutres pour les vivants (⚠️ ni initiale ni couleur de camp), éliminés en bande grisée avec la couleur de leur camp révélé (jamais le rôle), pastilles numérotées des lieux (`LIEU_ANCHORS`, `buildLieuBadgesSvg`). Reflète l'état courant ; `jour` sert seulement à invalider le cache Discord. Référencée par URL, jamais en pièce jointe.
- **Inscription** (`/api/goblinhunters/start-image`, `start.webp`) sur les 3 gabarits d'inscription (annonce, rappel, report : le message est PATCHé avec le gabarit rappel à chaque clic). **Fin** (`/api/goblinhunters/end-image`, `end.webp`) dans `buildOutcomeEmbed()`, avec ✅/☠️ et rôle de chaque joueur.
- Routes dans `jeux/server/imageRoutes.js` ; images et police (`fonts/Inter-Bold.ttf`) lues depuis Vercel Blob (`@clash/commun/blobAssets.js`), les sources restant dans `jeux/data/goblinhunters/images/`.
- ⚠️ resvg ignore **silencieusement** un `<image>` WebP ou AVIF embarqué (seuls PNG/JPEG/GIF) : d'où `board.jpg` (`board.webp` archivé, inutilisé). Toujours vérifier un rendu resvg visuellement. ⚠️ Police embarquée obligatoire (`loadSystemFonts: false`) : aucune police système sur Vercel, le texte disparaîtrait sans erreur. Les WebP servis tels quels (start/end) ne sont pas concernés.

### Stockage Redis (`goblinhunters:*`)

| Clé | Type | Contenu |
| --- | --- | --- |
| `state` | STRING | `{ phase, jour, channelId, messageId, publishedAt, termine, closingAt?, cloture?, immuneId?, joueurs? }` (roster complet une fois lancé) |
| `inscriptions` | HASH | `discordId → { username, registeredAt }`, vidée au lancement |
| `actions:<jour>` | HASH | `discordId → { primary: { lieu, cibleId, pending? }, secondary? }`, purgée après clôture |
| `action_usernames:<jour>` | HASH | `discordId → username`, purgée après clôture |
| `historique` | HASH | `jour → { eliminationsParVote, deathIdCombat, investigations, voteTally, explosifRetaliation, guetApensReveal, tourDeGuetSurpeuplee, absents, remplacements, conversionId, immuneId, victory, actions, resolvedAt }` (manche en cours) |
| `indices` | HASH | `discordId → JSON[]` carnet d'indices (manche en cours) |
| `messages` | LIST | 3 derniers messages `{ content, jour }` (`RPUSH` + `LTRIM -3 -1`) |
| `messages_sent:<jour>` | HASH | `discordId → "1"` (quota) |
| `manches` | HASH | `manche → { manche, victory, jourFinal, resolvedAt }`, jamais nettoyé |
| `manche_seq` | STRING | compteur `INCR` des manches (jamais en dry-run) |

`resetGoblinHunters()` efface tout sauf `manches`/`manche_seq` (sauf `--manches`).

### Scripts, cron et environnement

| Commande | Effet |
| --- | --- |
| `npm run goblinhunters:test` | Étape courante sur `DISCORD_CHANNEL_FRAME_TEST` (sans ping, sans garde-fou 8 h) |
| `npm run goblinhunters:test:dry` | Aperçu console sans écrire ni poster (en inscription : répartition camps/rôles simulée) |
| `npm run goblinhunters:test:force-close` | ⚠️ Tests uniquement : ignore `closingAt` et lance dès l'effectif minimum (combinable avec `--dry-run`) |
| `npm run goblinhunters:seed-test-pool` | ⚠️ Tests : inscrit de faux joueurs `test_fake_N` (10 par défaut, nombre en argument du script) ; leurs DM échouent proprement |
| `npm run goblinhunters:scatter-test-pool` | ⚠️ Tests : répartit les faux joueurs sur les 5 lieux (à relancer chaque jour de test) |
| `npm run goblinhunters:public` / `:public:dry` | Salon public `DISCORD_CHANNEL_FRAME_PUBLIC` (cron) |
| `npm run goblinhunters:reset` | ⚠️ Destructif : efface la manche en cours, garde `manches` |
| `npm run goblinhunters:reset:manches` | ⚠️ Idem + `manches`/`manche_seq` |
| `npm run goblinhunters:status` | État complet. ⚠️ Admin uniquement (spoile camps et rôles) |

- `node jeux/scripts/goblinHuntersRecap.js` : compte-rendu admin (votes, attaques contre son camp, enquêtes, absences) à partir de l'historique. ⚠️ Spoile, lecture seule.
- **Production** : seule l'ouverture des inscriptions est manuelle (`workflow_dispatch` de `.github/workflows/goblinhunters.yml` ou `npm run goblinhunters:public`). Le cron `4 8 * * *` (8h04 UTC, `--require-active` : ne fait rien sans partie ouverte) gère rappels, lancement/annulation et clôtures.
- **Test complet** : `seed-test-pool` → `test` (ouvre) → `test:force-close` (lance) → chaque jour `scatter-test-pool` puis clic(s) puis `test` (clôture) → `reset`.
- **Environnement** : aucune variable dédiée (`DISCORD_CHANNEL_FRAME_TEST`/`PUBLIC`, `KV_REST_API_URL`/`TOKEN`, secrets GitHub déjà en place).

---

## Mario Clash (course communautaire)

Course façon Mario Kart sur un plateau de 49 cases (départ case 0, arrivée `case_arrivee` 48), sur `duree_jours` (7) jours. **Participation libre**, sans inscription : un joueur est créé au premier clic (`ensureJoueur()`, `colorIndex` figé par ordre d'arrivée pour la couleur de son pion).

- Service : `jeux/services/marioclash.js` (tests `marioclash.test.js`) ; handler : `jeux/discord/handlers/marioclash.js` (routé par `jeux/discord/routes/jeuxSpeciaux.js`) ; image : `jeux/services/marioclashImage.js`.
- Config : `jeux/data/marioclash/marioclash.json` ; textes : `narratifs.json` ; images sources dans `jeux/data/marioclash/images/`.
- Script : `jeux/scripts/postMarioClash.js` (`postMarioClash()`).

### Déroulé

1. **Jour de présentation** (aucun état, lancement manuel) : embed d'annonce + Règles, ping `@MINI-JEUX` (`phase: "annonce"`).
2. **Jour 1** au passage suivant (rien à clôturer), sans ping.
3. **Chaque jour** : clôture du jour actif (`closeDayAndAdvance()`), résumé narratif, nouveau message (l'ancien est supprimé), sans ping.
4. **Fin** après le jour `duree_jours` (la course ne s'arrête pas au premier arrivé) : classement final, historique des manches, trophées (`config.trophees`), ping `@MINI-JEUX`, `termine: true`. La manche est archivée (`archiveManche()`) seulement en public et hors dry-run.

Garde-fou anti-double-avancée : 8 h minimum entre deux clôtures (`isTooSoonSinceLastClosure()`, `--force` pour forcer). Une course active sur un autre salon bloque la publication (`wrongChannel`).

### Actions du jour (une de chaque, au choix)

- **🎲 Dé** (résolu **au clic**, `rollDiceForPlayer()`) : le joueur choisit son dé ; l'Or ne s'obtient qu'en lançant le dé.

| Dé | Avance | Or |
| --- | --- | --- |
| 🎲 classique | 1 à 6 | 1 |
| 🐢 prudent | 3 | 1 |
| 💰 épargne | 1 à 2 | 2 |
| 🃏 Farceur (`reserve_sort`, imposé par sort uniquement) | 0 ou 7 | 1 |

- Effets du sort de la veille appliqués à ce dé : Gel (avance 1, Or conservé), Rage (+N), dé imposé.
- **Cases spéciales**, déclenchées uniquement par un arrêt de dé (jamais par objet/sort, pas d'enchaînement, pas de redéclenchement sur place) : Turbo +3 (4, 27), Coffre +2 Or (7, 22, 41), Glace −2 Or (12, 31), Feu −3 (19, 44), Turbo inversé −2 (36).

- **🛍️ Boutique** (achat au clic, `purchaseItem()`, un achat par jour) : achat = utilisation, l'objet s'applique à la clôture. Cible choisie après l'achat pour un objet « adversaire » (cibles vérifiées avant le débit) ; objet acheté sans cible validée → remboursé à la clôture.

| Objet | Coût | Effet |
| --- | --- | --- |
| 🚀 Accélérateur | 2 | +4 cases |
| 💣 Bombe | 2 | adversaire au choix −3 |
| ⭐ Étoile | 4 | immunité du jour : bloque les sorts (même les siens) et **renvoie** les objets adverses (l'attaquant recule de `recul_renvoi`, 3) |
| 🍌 Peau de banane | 5 | échange de place avec un adversaire **devant** soi, à 10 cases au plus (sinon le(s) plus proche(s) devant) |
| 🔵 Carapace bleue | 5 | le leader (hors lanceur) −5 |

- **✨ Sort** (`castSpellForPlayer()`, avec confirmation) : toujours sur **soi-même**, effet tiré au clic et annoncé, appliqué à la clôture. Sorts actifs : Recul −2, Gel, Dé Farceur demain, Clone (rejoue le déplacement du dé du jour, sans case spéciale), Rage +2 demain, Avance +3. L'échange aléatoire (id 3, `retire: true`) n'est plus tiré mais reste dans la config.
- **🔋 Concentration** : chaque jour sans sort charge la jauge (max `concentration_max`, 2) ; le prochain sort est tiré sans Gel dès le niveau 1, sans Recul au niveau 2 (`retire_concentration`), puis la jauge retombe à 0.

### Clôture (`computeCloture()`, pure)

Ordre : 1) Étoiles actives → immunisés ; 2) **sorts** (bloqués si immunisé) ; 3) **objets** (Accélérateur, Bombe, Banane), puis **Carapaces bleues** en dernier sur un classement figé une fois (égalité départagée par pseudo) ; 4) remboursement des objets non utilisés. Gel/Rage/dé imposé de la veille sont purgés avant les sorts.


- **Arrivée** (`estArrive()`) : un joueur sur la case 48 ne joue plus, n'est plus ciblable, plus rien ne le déplace ; un objet visant un arrivé est remboursé. Classement : arrivés par `arriveJour` (premier arrivé = vainqueur), puis par position ; ex æquo au même rang.
- ⚠️ Le classement public n'affiche jamais l'objet possédé (les achats restent cachés jusqu'au bilan, pour le bluff autour de l'Étoile).
- Historique : instantané positions/Or par jour pour le récit de fin.

### Images

- Plateau : `GET /api/marioclash/image?jour=` (`mario-clash-board.jpg` + pions sur `CASE_ANCHORS`, calibrées par détection de pixels). Illustration : `GET /api/marioclash/illustration` (`mario-clash.webp`). Routes dans `jeux/server/imageRoutes.js`, assets et police via Vercel Blob. Mêmes pièges resvg que Goblin Hunters (JPEG obligatoire, police embarquée).

### Redis (`marioclash:*`)

| Clé | Type | Contenu |
| --- | --- | --- |
| `state` | STRING | `{ phase: "annonce"\|"jour", jour, channelId, messageId, publishedAt, termine }` |
| `joueurs` | HASH | `discordId → { username, position, points, objet, dernierAchatJour, colorIndex, concentration, gel, rage, deImpose, arriveJour }` |
| `actions:<jour>` | HASH | `discordId → { dice, diceValue, diceAvance, deId, positionDe, caseSpeciale, item: { target }, spell: { target, sortId, concentration } }`, purgée à la clôture |
| `historique` | HASH | `jour → { lignes, immunises, positions, resolvedAt }` |
| `manches` / `manche_seq` | HASH / STRING | `{ manche, vainqueur, positionFinale, nbJoueurs, resolvedAt }` (compté par 📊 Stats de `/mini-jeux`) |

### Scripts et cron

| Commande | Effet |
| --- | --- |
| `npm run marioclash:test` / `:test:dry` | Salon de test (sans ping, sans garde-fou 8 h) |
| `npm run marioclash:public` / `:public:dry` | Salon public (cron) |
| `npm run marioclash:reset` | Efface la course en cours, garde `manches` |
| `npm run marioclash:reset:manches` | Idem + `manches`/`manche_seq` |
| `npm run marioclash:status` | État courant |

Options du script : `--no-ping`, `--require-active`, `--force`. Production : présentation lancée à la main (`workflow_dispatch` de `.github/workflows/marioclash.yml` ou `npm run marioclash:public`), puis cron `14 8 * * *` (8h14 UTC, `--require-active`). ⚠️ Chaque cron de 8h UTC a sa propre minute (bossraid 2, goblinhunters 4, quiz 6, robinson 8, tamagotchi 10, blackjack 12, marioclash 14). Aucune variable d'environnement dédiée (`DISCORD_CHANNEL_FRAME_TEST`/`PUBLIC`, `KV_REST_API_*`, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`).

---

## Duels à la demande

Trois duels lancés par commande slash, sans cron ni historique de manches : `/blackjack`, `/gobelet`, `/bang`. Routage : `jeux/discord/routes/duels.js` ; commandes déclarées dans `scripts/registerCommands.js`.

### Fonctionnement commun

- **Lancement réservé au rôle MINI-JEUX** : defer éphémère (`type: 5`, `flags: 64`) puis vérification du rôle en arrière-plan (`runBackground`), car `getRoleIdByName()` fait un appel réseau trop lent pour la fenêtre de 3 s. Rejoindre une partie déjà lancée n'exige pas le rôle.
- **Indépendants des jeux spéciaux** : espace Redis dédié (`blackjackduel:*`, `gobeletduel:*`, `bangduel:*`), `custom_id` préfixés (`blackjackduel_*`, `gobeletduel_*`, `bangduel_*`). Seules les fonctions **pures** du jeu spécial sont importées ; le rendu Discord est dupliqué dans le handler du duel.
- **Avancement piloté par les actions des joueurs**, jamais par un cron.
- **Une seule partie publique à la fois** (Blackjack, Gobelet, Bang! 1v1). Le message public est édité en place pendant la partie ; **en fin de partie, le récapitulatif est posté dans un nouveau message et l'ancien supprimé** (repli : édition de l'ancien si le POST échoue).

### Blackjack Duel et Gobelet Duel (1-3 joueurs)

`/blackjack joueurs:<1-3> manches:<5|10>` et `/gobelet joueurs:<1-3> manches:<5|10>`.

| | Blackjack Duel | Gobelet Duel |
| --- | --- | --- |
| Service | `jeux/services/blackjackDuel.js` | `jeux/services/gobeletDuel.js` |
| Handler | `jeux/discord/handlers/blackjackDuel.js` | `jeux/discord/handlers/gobeletDuel.js` |
| Fonctions pures réutilisées | `blackjack.js` : `drawCard`, `drawUniqueCard`, `computeHandValue`, `dealerPlay`, `resolveDay`, `buildRanking`, `pointsForResult`, `isDealerRevealed` | `gobelet.js` : `rollDice`, `rerollKept`, `computeBestCombination`, `finishHand`, `pickChoice`, `resolveJour`, `buildRanking`, `withUsedCategory`, `withHandLock` |
| Spécificités | aucune | emoji des dés relus dans `jeux/data/gobelet/gobelet.json` (`diceEmojis`, via `loadGobeletConfig()`, config statique sans état) ; sélection des dés Jouer/toggle/Relancer dupliquée |

- **Lobby fermé** : inscription par le bouton Jouer jusqu'à ce que tous les sièges soient pris, puis roster verrouillé.
- **Résolution d'une manche** : seulement quand tous les sièges sont occupés **et** que chaque joueur a fini sa main (`isMancheReady()`, appelée par `checkAndResolveManche()`, verrou `HSETNX` sur `<jeu>:resolving`). Un joueur seul sur 2-3 places attend ses adversaires (« ⏳ En attente de N joueur(s) supplémentaire(s) »). ⚠️ Ne pas résoudre avant le remplissage des sièges, sinon le roster se verrouille et la partie devient injoignable.
- **Partie abandonnée** (`STALE_HOURS` = 1 h d'inactivité) : un nouveau `/blackjack` ou `/gobelet` la remplace (`startGame()`). Gobelet Duel la clôt en plus paresseusement à la moindre interaction (`expireIfStale()`, `expired: true`) et poste le récapitulatif « Partie terminée » avec le classement figé.
- **High score par format** (5 ou 10 manches, totaux non comparables) : affiché dans le récap de fin (« High score : Pseudo (N pts) »), hash `<jeu>:highscore` (`totalManches` → `{ discordId, username, points, at }`), mis à jour par `updateHighScore()` seulement si le record est **strictement** battu (`isNewHighScore()`, score > 0). Jamais effacé par un reset.
- **Gobelet Duel uniquement** : la main éphémère liste les combinaisons déjà réalisées par les adversaires (« 👀 Pseudo : … », `readOpponentsUsed()`, pseudos dans `gobeletduel:usernames`, catégories dans `gobeletduel:used`).
- **Clés Redis** (`<jeu>` = `blackjackduel` ou `gobeletduel`) : `state`, `points`, `usernames`, `resolving`, `highscore`, `hand:<manche>`, `webhook:<manche>` ; Gobelet en plus `used`, `kept:<manche>:<discordId>`, `lock:<discordId>`.
- **Nettoyage 100 % manuel** (⚠️ aucun cron ni workflow, choix explicite) :

| Commande | Effet |
| --- | --- |
| `npm run blackjackduel:status` / `gobeletduel:status` | État courant, pour décider |
| `npm run blackjackduel:watchdog` / `gobeletduel:watchdog` | Reset seulement si inactif depuis 1 h (`resetIfStale()`) |
| `npm run blackjackduel:reset` / `gobeletduel:reset` | Reset inconditionnel (préserve le high score) |

### Bang! Duel (contre Kévina ou en 1v1)

Adaptation d'Exploding Kittens Duel avec les cartes de Bang!. `/bang adversaire:bot|1v1` (option obligatoire). **Jeu libre : aucun score conservé.**

- Code : `jeux/services/bangDuelRules.js` (règles pures et Bot, tests `bangDuelRules.test.js`), `jeux/services/bangDuel.js` (Redis), `jeux/discord/handlers/bangDuel.js` (Discord).
- Config : `jeux/data/bang/duel.json`. Cartes partagées avec Bang! (`CARTES` de `bangRules.js` ; la 🌪️ Tornade est réservée au Duel), images de main via `/api/bang/main`.
- `custom_id` : `bangduel_<action>` contre Kévina, `bangduel_<action>:pvp` en 1v1 (`piocher`, `carte`, `placer`), `bangduel_ouvrir` (Jouer du message public 1v1), `bangduel_regles`.

#### Règles (config `duel.json`)

| Paramètre | Valeur |
| --- | --- |
| `paquet` | 6 Gobelins, 3 Fûts, 3 Sarbacanes, 2 Gangs, 2 Voleuses, 2 Moines, 2 Tornades (mélangés) |
| `main_depart` | 4 cartes + 1 Esprit de guérison par joueur |
| Pioche | reste du paquet + `esprits_pioche` (2) Esprits + `bombes` (2) Gobelins explosifs (16 cartes) |
| `tours_max` | 10 tours (un tour = joueur puis adversaire) ; **match nul** si personne n'a explosé |
| `cartes_par_tour` | 3 cartes jouées au plus |
| `gang_pioches` | 2 |
| `delai_tour_minutes` | 5 (1v1 uniquement) |

- **Le joueur commence toujours** contre Kévina (tiré au sort en 1v1).
- **À son tour** : jusqu'à 3 cartes jouées **d'abord**, puis **la pioche termine le tour** : une carte, ou les 2 pioches dues d'un Gang, en un seul clic (`piocherClic()` : arrêt sur un Gobelin explosif désamorcé le temps de le cacher, puis les pioches restantes s'enchaînent). Pas de bouton « Finir mon tour » ni « Abandonner ». Pioche vide : le bouton devient « Passer ». `dette` = pioches restantes du tour.
- **Cartes** :
  - 💥 Gobelin explosif : un Esprit est sacrifié puis la bombe cachée au choix (positions de Bang!) ; sans Esprit, défaite.
  - 🎯 Sarbacane : voit les 3 premières cartes.
  - 🛢️ Fût : esquive une pioche (celle du tour, qui se termine alors, ou une des pioches dues d'un Gang).
  - 👊 Gang : termine le tour sans piocher, l'adversaire devra piocher 2 fois (sans cumul).
  - 🦹 Voleuse : prend **une carte au hasard** de la main adverse (jamais au choix, sinon l'Esprit est toujours pris).
  - 🙏 Moine : secret, actif jusqu'à la prochaine attaque reçue, renvoie un Gang ou une Voleuse (Voleuse renvoyée : carte au hasard de l'attaquant).
  - 🌪️ Tornade : mélange la pioche.
  - 👺 Gobelin : inutile (pas de paire). Ni « Non ! », ni Malédiction.
- **Une attaque subie par tour** : un joueur ne subit qu'un Gang et une Voleuse par tour (`UNIQUES_DUEL`, `joueur.subies`, remis à zéro par `finirTour()`) ; `jouer()` renvoie `dejaSubie` et la carte disparaît du menu. Une attaque renvoyée par un Moine est subie par l'attaquant.
- **Bot** (`jouerBot()`, stratège) : Moine d'avance, Voleuse dès que possible, Sarbacane avant de piocher, esquive (Gang, puis Tornade, puis Fût) si un Gobelin explosif est vu ou soupçonné au sommet (l'adversaire vient d'en cacher un), bombe désamorcée cachée au sommet une fois sur deux, sinon au hasard ; s'il lui reste une pioche due, toujours **hors sommet** (`placer(…, { eviterSommet })`). Son tour est raconté sans dévoiler ses pioches, son Moine ni l'emplacement de ses bombes.

#### Contre Kévina

- Partie **privée** : un message éphémère édité en place. Une partie par joueur (`bangduel:<discordId>`, verrou `bangduel:lock:<discordId>`), expiration 1 h après la dernière action (`INACTIVITE_SECONDES`). `/bang` relance toujours une nouvelle partie.
- Fin de partie : résultat publié en **public** dans le salon du clic (`messageFinalSolo()`) avec un récit (`recit()`) : au plus 3 moments forts (classés par priorité, affichés dans l'ordre chronologique, coup fatal en tête), plus une ligne d'explosions évitées. Moments retenus : coup fatal (bombe cachée par l'adversaire ou par soi, suivie via l'`index` du journal et perdue après une Tornade ; Gang ou Gang renvoyé), Esprit volé, Gang renvoyé par un Moine, piège adverse évité grâce à un Esprit, Gang volé puis renvoyé, Voleuse renvoyée, bombe repérée à la Sarbacane (`vu`) puis esquivée. Match nul : bilan explosions évitées et Gangs envoyés.

#### 1v1

- Même moteur (sièges `joueur` = celui qui commence, `bot` = l'autre ; `sieges` → discordId). **Une partie à la fois** (`bangduel:pvp`, verrou `bangduel:lock:pvp`, expiration 1 h).
- Message public avec bouton **Jouer** : le premier autre joueur qui clique relève le défi, un 3ᵉ est refusé. Chaque joueur a sa vue éphémère, rééditée après chaque action adverse via le webhook mémorisé (jeton valable 15 min ; au-delà, Jouer rouvre une vue à jour). Le joueur en attente voit le tour adverse en direct (`debutTour`), puis son résumé à son tour (`resume[siège]`).
- **Délai** : 5 min par tour, dépassé = défaite, vérifié paresseusement à la prochaine interaction (`verifierDelai()`, pas de cron).
- Fin (explosion, nul, délai) : récapitulatif (même récit) dans un nouveau message public, l'ancien supprimé. Un lobby sans adversaire depuis le délai (ou relancé par son lanceur) et une partie au délai dépassé sont remplacés par un nouveau `/bang adversaire:1v1`.

#### Outils (`jeux/outils/bang/`, à lancer à la main)

- `simulateDuel.mjs` : équilibrage sur les vraies règles. Repères (20 000 parties, stratège contre stratège) : ~53 % pour le joueur qui commence, ~46 % pour le Bot, ~1 % de nuls, fin moyenne au tour ~6. ⚠️ Avec 10 Gobelins, ~14 % de nuls (trop de parties sans explosion).
- `e2eDuel.mjs` (handler contre Kévina), `e2ePvp.mjs` (1v1, refuse de tourner si un vrai 1v1 est en cours).

---

## Sondage public (sondages natifs Discord)

Sondage ponctuel : chaque question devient un message séparé avec un **sondage natif Discord** (objet `poll`, API v10), qui gère seul vote et décompte (une seule question par poll).

### Format (`jeux/data/poll/poll.json`)

```json
{ "questions": [
  { "id": "...", "type": "choice", "question": "...", "answers": ["...", "..."], "allowMultiselect": false, "durationHours": 168 },
  { "id": "...", "type": "note", "question": "...", "durationHours": 168 }
] }
```

- `choice` : réponses de `answers` (10 max).
- `note` : réponses `"1"` à `"5"` générées automatiquement.
- `freetext` : pas de poll possible ; message avec bouton « 💡 Proposer une idée » qui ouvre une Modal (`poll_idea`/`poll_idea_modal`, `jeux/discord/handlers/poll.js`).
- Défauts : `durationHours` 168, `allowMultiselect` false.

### Redis

- `poll:state` : `{ channelId, startedAt, messages: [{ questionId, question, type, channelId, messageId }] }`, sert uniquement à retrouver les messages pour `poll:reset`.
- `poll:ideas` : liste des idées `freetext` (`{ discordId, username, text, submittedAt }`).

### Scripts npm

| Commande | Effet |
| --- | --- |
| `poll:test` / `:test:dry` | Salon `DISCORD_CHANNEL_FRAME_TEST`, sans ping / aperçu console |
| `poll:test:force` | Supprime les messages d'un sondage actif puis reposte |
| `poll:public` / `:public:dry` | Salon « Annonces » `DISCORD_CHANNEL_ANNONCES`, `@everyone` sur le premier message |
| `poll:status` | Idées soumises uniquement (les votes sont visibles dans Discord) |
| `poll:reset` | Supprime les messages postés (best-effort) et l'état. **Destructif** |

Variables : `DISCORD_CHANNEL_FRAME_TEST`, `DISCORD_CHANNEL_ANNONCES`, `DISCORD_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

---

## Noms français des cartes (`jeux/data/cardNames.json`)

Source de vérité anglais ↔ français des cartes, partagée par les mini-jeux. Un objet par carte : `cardKey` (nom anglais exact de l'API, `fetchCards()`), `rarity`, `fr`, et selon les jeux `sound`, `elixir`, `hp`, `damage`, `range`, `type`, `family`.

- **Édité à la main**. Les scripts d'enrichissement (usage ponctuel) n'ajoutent que les champs absents et ne réécrivent jamais une entrée existante (sauf `--force` explicite) :
  - `jeux/scripts/generateCardNames.js` : ajoute les cartes manquantes ; `fr` résolu via les liens interlangues du wiki Fandom FR (vérifiés dans les deux sens) puis repli sur `anagrams.json`. `fr: null` = à compléter à la main (liste en fin d'exécution). Toute valeur automatique est à relire.
  - `jeux/scripts/tagCards.js` (`--dry-run`, `--force` pour `type`/`family`) : `type` ∈ `troop|flying|spell|building` (préfixe d'id officiel `26` troupe, `27` bâtiment, `28` sort, puis liste de volants), `family` ∈ `goblin|skeleton|human|minion|null` ; complète `elixir` depuis l'API (sauf Miroir, coût variable).
  - `jeux/scripts/generateCardStats.js` : stats de La Juste Carte (voir cette section).
- `generateZoomCatalog.js` lit ses noms FR **uniquement** ici et resynchronise `answer`/`accept` à chaque exécution. `anagrams.json` n'est **pas** resynchronisé : reporter toute correction à la main, en vérifiant que l'anagramme reste valide.

---

## Jeux archivés

Jeux retirés de `/mini-jeux` (`archived: true` dans `SPECIAL_GAMES`, `jeux/discord/handlers/minijeux.js`) et dont le `schedule` est commenté dans leur workflow (seul `workflow_dispatch` reste). Code, données et archives Redis des manches sont conservés. Les règles complètes (formules, barèmes, clés Redis) sont dans l'historique git : `CONTRIBUTING.md` avant le 23/10/2026.

**Pour relancer** : décommenter le `schedule` du workflow, retirer `archived: true`, lancer `npm run <jeu>:reset`, puis lancement manuel (`workflow_dispatch`). Revérifier la conformité aux règles communes des jeux spéciaux (notamment le jour d'annonce, absent du Tamagotchi).

### Tamagotchi (bébé dragon « Lilith »)

- Jeu collaboratif de 7 jours : vote quotidien (Nourrir, Sieste, Jouer, Câliner, Pilule) pour garder 3 jauges en zone verte ; étoiles de dressage, Confiance, Fatigue, palier final S/B/F.
- Code : `jeux/services/tamagotchi.js`, `jeux/discord/handlers/tamagotchi.js`, `jeux/scripts/postTamagotchi.js`, `resetTamagotchi.js`, `tamagotchiStatus.js` ; données `jeux/data/tamagotchi/` ; images `frontend/public/images/tamagotchi/` ; Redis `tamagotchi:*` ; workflow `.github/workflows/tamagotchi.yml` ; scripts `npm run tamagotchi:*`.
- ⚠️ Lance directement le Jour 1 (pas de phase d'annonce) : à ajouter avant toute relance.

### Boss Raid (score attack communautaire)

- Jeu collaboratif (annonce + 7 jours) : chaque membre vote un rôle (Chevalier, Voleuse, Sorcier, Archères, Princesse) ; dégâts fixes calculés à la clôture et comparés à la meilleure combinaison possible (note SS à D), événement du Boss chaque jour à partir du Jour 2.
- Code : `jeux/services/bossraid.js`, `jeux/discord/handlers/bossraid.js`, `jeux/scripts/postBossRaid.js`, `resetBossRaid.js`, `bossRaidStatus.js`, `bossraidRefresh.js` ; données `jeux/data/bossraid/` ; images `frontend/public/images/boss/` ; Redis `bossraid:*` ; workflow `.github/workflows/bossraid.yml` ; scripts `npm run bossraid:*`.
