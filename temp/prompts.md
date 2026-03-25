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

Données TrustRoyale (fausses) :

```
week  Clan  riverRaceBattles
semaine -1  AGS™  5 ⚠️
semaine -2  Clan #GRC8QYL2  0 ❌
semaine -3  ClubeDoPrensado  0 ❌
semaine -4  Cocbros  0 ❌
semaine -5  dan saco duro  0 ❌
semaine -6  EPIC PANAMÁ  0 ❌
semaine -7  Hao The God  0 ❌
semaine -8  kings of death  0 ❌
semaine -9  Ledjero  0 ❌
semaine -10  Los Pochoclos  0 ❌
semaine -11  Los Special  0 ❌
semaine -12  No Clan  0 ❌
semaine -13  Os Patetas  0 ❌
semaine -14  pelones  0 ❌
semaine -15  TeTus Klan  0 ❌
```

Données Royaleapi (correctes) :

```
S   R  L  C      
130-3  2026-03-23  2  legendary-1  AGS™  0  0  0  0  0
130-2  2026-03-16  2  legendary-1  AGS™  12  1600  0  0  1600
130-1  2026-03-09  2  legendary-1  AGS™  15  2400  0  0  2400
129-1  2026-02-09  3  gold-3  EPIC PANAMÁ  16  2400  0  0  2400
128-4  2026-02-02  1  gold-3  EPIC PANAMÁ  13  1900  0  0  1900
128-3  2026-01-26  5  gold-3  Panamá+507  16  2400  0  0  2400
128-2  2026-01-19  5  gold-3  Panamá+507  8  1200  0  0  1200
128-1  2026-01-12  5  gold-3  Panamá+507  16  2700  0  0  2700
127-5  2026-01-05  5  gold-3  Panamá+507  12  1700  0  0  1700
127-4  2025-12-29  5  legendary-1  Panamá+507  8  1000  0  0  1000
127-3  2025-12-22  5  legendary-1  Panamá+507  8  1100  0  0  1100
127-2  2025-12-15  5  legendary-1  Panamá+507  12  1600  0  0  1600
127-1  2025-12-08  2  legendary-1  Panamá+507  14  2100  0  0  2100
126-1  2025-11-10  1  gold-3  Panamá+507  4  500  0  0  500
125-4  2025-11-03  2  gold-3  Panamá+507  14  2300  0  0  2300
125-3  2025-10-27  2  gold-3  Panamá+507  12  2100  0  0  2100
125-2  2025-10-20  2  gold-3  Panamá+507  12  1800  0  0  1800
125-1  2025-10-13  2  gold-3  Panamá+507  13  1750  0  0  1750
124-5  2025-10-06  2  gold-3  Panamá+507  8  1100  0  0  1100
124-4  2025-09-29  2  gold-3  Panamá+507  16  2650  0  0  2650
124-3  2025-09-22  2  gold-3  Panamá+507  12  1700  0  0  1700
124-2  2025-09-15  1  gold-3  Panamá+507  12  1900  0  0  1900
124-1  2025-09-08  1  gold-3  Panamá+507  12  1800  0  0  1800
```

---

J'ai toujours les mêmes données affichées pour lauramarin1 (screenshot)

- il est nouveau dans le clan, il doit avoir un tag "nouveau"
- la card "River Race History – 13 week" est OK pour moi si les valeurs sont correctes. Mais la question est : ces valeurs ne proviennent forcément pas du Battle Log, d'où viennent-elles ?
- il n'y a pas le tableau des semaines passées clan par clan

Le tableau s'affiche pour <http://localhost:5174/en/?mode=player&tag=%23P2YYR29QU> mais les donnnées ne sont toujours pas identiques à celles de Royaleapi : l'ordre des clans est différent, les combats également.

Données affichées :

```
week Clan riverRaceBattles
S?·W4 (live) Les Resistants 0 ❌
semaine -1 Les Resistants 0 ❌
semaine -2 AGS™ 0 ❌
semaine -3 EPIC PANAMÁ 0 ❌
semaine -4 AGS™ 12 ⚠️
semaine -5 EPIC PANAMÁ 0 ❌
semaine -6 AGS™ 15 ⚠️
semaine -7 EPIC PANAMÁ 0 ❌
semaine -8 EPIC PANAMÁ 12 ⚠️
semaine -9 EPIC PANAMÁ 16 ✅
semaine -10 EPIC PANAMÁ 16 ✅
semaine -11 EPIC PANAMÁ 16 ✅
semaine -12 EPIC PANAMÁ 13 ❓
```

Données Réelles :

```
S   R  L  C      
130-3  2026-03-23  2  legendary-1  AGS™  0  0  0  0  0
130-2  2026-03-16  2  legendary-1  AGS™  12  1600  0  0  1600
130-1  2026-03-09  2  legendary-1  AGS™  15  2400  0  0  2400
129-1  2026-02-09  3  gold-3  EPIC PANAMÁ  16  2400  0  0  2400
128-4  2026-02-02  1  gold-3  EPIC PANAMÁ  13  1900  0  0  1900
128-3  2026-01-26  5  gold-3  Panamá+507  16  2400  0  0  2400
128-2  2026-01-19  5  gold-3  Panamá+507  8  1200  0  0  1200
128-1  2026-01-12  5  gold-3  Panamá+507  16  2700  0  0  2700
127-5  2026-01-05  5  gold-3  Panamá+507  12  1700  0  0  1700
127-4  2025-12-29  5  legendary-1  Panamá+507  8  1000  0  0  1000
127-3  2025-12-22  5  legendary-1  Panamá+507  8  1100  0  0  1100
127-2  2025-12-15  5  legendary-1  Panamá+507  12  1600  0  0  1600
127-1  2025-12-08  2  legendary-1  Panamá+507  14  2100  0  0  2100
126-1  2025-11-10  1  gold-3  Panamá+507  4  500  0  0  500
125-4  2025-11-03  2  gold-3  Panamá+507  14  2300  0  0  2300
125-3  2025-10-27  2  gold-3  Panamá+507  12  2100  0  0  2100
```

1. Si tu as accès au numéro correct des semaines (130-3, 130-2, ...), peut-être peux-tu les afficher pour qu'on puisse mieux comparer avec Royaleapi ? (au lieu de "semaine -1", "semaine -2", etc.)
2. Comment expliques-tu ces différences ?

---

Les valeurs ne sont toujours pas identiques :

- Les semaines sont encore exprimées en "semaine -1", etc. donc on ne peut pas comparer :
  - la série correcte des semaines est : 130-3, 130-2, 130-1, 129-1, 128-4, 128-3, 128-2, 128-1, 127-5, 127-4, 127-3, 127-2
  - la série affichée : S?·W4 (live, c'est OK), semaine -1, semaine -2, semaine -3, semaine -4, semaine -5, semaine -6, etc.
- Les nombres de decks ne sont pas exactement identiques :
  - la série correcte des decks est  : 0, 12, 15, 16, 13, 16, 8, 18
  - la série affichée est : 0 (live, c'est OK), 0, 12, 15, 12, 16, 16, 16, 13

---

Pourquoi certains nouveaux joueurs ont plusieurs semaines d'historique de clans dans la card "📅 Données Battle Log" alors que d'autres n'en ont aucune ? Par exemple, le joueur lauramarin1 (<http://localhost:5174/en/?mode=player&tag=%23P2YYR29QU>) a un historique de 9 semaines, alors que le joueur darren (<http://localhost:5174/en/?mode=player&tag=%2388Y9Q8UPQ>) n'a aucune semaine d'historique de clan à part la semaine-live (screenshot) ?

Pour le joueur darren (<http://localhost:5174/en/?mode=player&tag=%2388Y9Q8UPQ>), les données affichées sont les suivantes :

```
S?·W4 (live) Les Resistants 0 ❓
```

Les données de decks (<https://royaleapi.com/player/88Y9Q8UPQ>) réelles sont :

```

S  R L C     
130-3 2026-03-23 4 legendary-1 Empire du Goret 0 0 0 0 0
130-2 2026-03-16 4 legendary-1 Empire du Goret 0 0 0 0 0
130-1 2026-03-09 5 legendary-1 Empire du Goret 8 1100 0 0 1100
129-4 2026-03-02 3 legendary-1 Empire du Goret 9 1200 0 0 1200
129-3 2026-02-23 1 legendary-1 Larichouette 4 600 0 0 600
129-2 2026-02-16 3 legendary-1 OM 0 0 0 0 0
129-1 2026-02-09 3 legendary-1 OM 1 100 0 0 100
128-4 2026-02-02 1 legendary-1 Gob-Trotteurs 0 0 0 0 0
128-3 2026-01-26 2 legendary-1 Gob-Trotteurs 0 0 0 0 0
128-2 2026-01-19 3 legendary-1 Gob-Trotteurs 2 200 0 0 200
128-1 2026-01-12 3 legendary-1 Gob-Trotteurs 6 800 0 0 800
```

- J'ai besoin de comprendre EXACTEMENT pourquoi lauramarin1 a un historique sur plusieurs semaines alors que darren non.
- Comment procéder EXACTEMENT pour corriger ce problème.

---

Pour le joueur Hafid (<http://localhost:5173/fr/?mode=player&tag=%23YQVP9P0Y>), le tableau des semaines passées de Battle Log montre qu'il est très actif dans son clan précédent :

```
Semaine en cours Les Resistants 0
S130·W3 adulte french 16 ✅
S130·W2 adulte french 16 ✅
S130·W1 adulte french 16 ✅
S129·W4 adulte french 16 ❓
```

Pourtant son score de fiabilité total n'est que de 58%. Et sont critère de "Régularité" est de 0/12 :

```
Régularité
0 / 12
No completed week in this clan yet
```

Pour les joueurs qui ont un Battle Log sur plusieurs semaines, il faudrait que le critère de "Régularité" prenne en compte les semaines passées et pas seulement la semaine en cours. Par exemple, pour Hafid, il devrait être de 12/12 et pas de 0/12, puisqu'il a fait le maximum de decks (16) pendant les 3 semaines passées dans son clan précédent.

Peux-tu corriger ce problème pour que le critère de "Régularité" prenne en compte les semaines passées dans le Battle Log, si les infos existent et pas seulement la semaine en cours ? Si les infos n'existent pas, alors on peut laisser "0/12" comme c'est le cas actuellement car cela signifie effectivement que le joueur n'était pas actif dans son clan précédent.

Le score de fiabilité total de Hafid et des joueurs dans le même cas devrait également être corrigé pour refléter cette régularité passée.

Attention à toujours vérifier que le score en vue Player est synchronisé avec la vue Clan.
