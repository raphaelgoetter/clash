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

Les joueurs sont notés "nouveau" dans la vue Clan, mais ils ne sont PAS en mode "BattleLog" (ils ont un historique GDC complet) et ne sont pas notés "nouveau" dans la vue Joueur. C'est un bug, il ne faut pas les considérer comme "nouveaux" dans la vue Clan ni dans le bot Discord.
