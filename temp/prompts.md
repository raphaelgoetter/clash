# Prompts

Pour les joueurs en mode "BattleLog" (les nouveaux arrivants), la card "📅 River Race History" a peu d'intérêt, elle est même souvent vide (screenshot).

Il faudrait la remplacer par une card "📅 Battle Log data" qui affiche des statistiques issues du BattleLog :

- Titre (à traduire) : "📅 BattleLog data
- Description (à traduire) : "Nouvel arrivant dans la famille. Pour ces joueurs, l'API "Battle Log" ne fournit que les 30 derniers combats tout modes confondus.
- Bloc avec bar charts montrant la décomposition des combats (River Race / Ladder / Challenges / Autres). Mettre en exergue les combats River Race.
- Bloc tableau affichant les données chronologiques des combats (à traduire) :
  - Semaine (ex. S129-W1)
  - Nom du clan (ou "No Clan" si pas de clan) (ex. Mugiwara)
  - Nombre de combats en River Race
  - Mettre en exergue si des semaines sont vides (0 combats) ou quasi vides (1-2 combats), ce qui peut indiquer un manque d'activité.

---

- Remplace "S?·W?" par "Semaine en cours"
- Traduction FR "📅 Battle Log data" je t'ai demandé EXPLICITEMENT "📅 Données Battle Log"
- Traductions FR : Titres de colonnes "week", "riverRaceBattles" je t'ai demandé EXPLICITEMENT "Semaines", "Decks GDC". Pourquoi est-ce si compliqué de traduire ces titres ?!

---

1. Tu as remplacé  "S?·W?" par "battleLogCurrentWeek". Il faut remplacer par "Semaine en cours"
2. Traduction FR "📅 Battle Log data" je t'ai demandé EXPLICITEMENT "📅 Données Battle Log"
3. Traductions FR : Titres de colonnes "week", "riverRaceBattles" je t'ai demandé EXPLICITEMENT "Semaines", "Decks GDC". Pourquoi est-ce si compliqué de traduire ces titres ?!

---

Certains joueurs sont notés "nouveau" dans la vue Clan, mais ils ne sont PAS en mode "BattleLog" (ils ont un historique Race Log complet) et ne sont pas notés "nouveau" dans la vue Joueur. C'est un bug, il ne faut pas les considérer comme "nouveaux" dans la vue Clan ni dans le bot Discord.

Ces joueurs sont actuellement :

- greg <http://localhost:5173/fr/?mode=player&tag=%238GGQLU28>
- arll2.0 : <http://localhost:5173/fr/?mode=player&tag=%23U9PP0CJRL>

---

Certains joueurs sont nouveaux. Ils sont en mode Battle Log dans la vue Player Pourtant leur card est "📅 Historique Guerre de clans" et non "📅 Données Battle Log". Ce n'est pas logique : la règle doit être que si un joueur est en Battle Log, il faut rester cohérent et remplacer la card "📅 Historique Guerre de clans" par "📅 Données Battle Log".

Les joueurs actuellement concernés sont :

- VTLX.KING <http://localhost:5173/fr/?mode=player&tag=%2389L8J9YV9>
- ylanMRtebz <http://localhost:5173/fr/?mode=player&tag=%23PRGCCRUJP>

Peux-tu vérifier et corriger cette incohérence ? (changer la règle actuelle si nécessaire)

---

Le tableau des anciens clans dans la card "📅 Données Battle Log" n'est pas rigoureusement correct.

Par exemple pour le joueur lauramarin1 <https://trustroyale.vercel.app/en/?mode=player&tag=%23P2YYR29QU> : l'historique de ses clans (screenshot) ne correspond absolument pas à l'historique réel affiché sur Royaleapi <https://royaleapi.com/player/P2YYR29QU> (screenshot).

- les précédents clans ne sont pas corrects (elle était 3 semaines dans le clan "AGS™", 2 semaines dans "EPIC PANAMÁ", etc. mais le tableau affiche des clans complètement différents)
- les combats en River Race ne sont pas corrects (elle a fait 0 la semaine passée chez "AGS™", mais le tableau affiche 5; elle a fait 12 la semaine d'avant chez "AGS™" encore mais le tableau affiche 0 chez un clan différent "Clan #GRC8QYL2")
- C'est absolument crucial parce que le tableau actuel laisse croire qu'elle change de clan toutes les semaines alors que c'est totalement faux !

Dans un premier temps, comment expliques-tu cette incohérence ?
Puis, peux-tu corriger le problème pour que l'historique des clans affiché dans le tableau de la card "📅 Données Battle Log" soit rigoureusement correct ?
