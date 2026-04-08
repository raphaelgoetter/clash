# ⚔️ TrustRoyale — analyseur de fiabilité des guerres de clan

TrustRoyale est un outil Clash Royale servant à évaluer rapidement la
fiabilité des joueurs et clans avant les recrutements ou les guerres.

Le service se compose :

- d'une application web accessible sur
  `https://trustroyale.vercel.app` ;
- d'un bot Discord (commande `/trust`) permettant de lancer une analyse
  depuis un serveur Discord.

<img width="612" height="100" alt="image" src="https://github.com/user-attachments/assets/9c05c90d-7890-4e32-aa8c-550909837c58" />

## 🚀 Utilisation de l'application web

1. Rendez-vous sur <https://trustroyale.vercel.app>.
2. Choisissez le mode `Player` ou `Clan` en haut.
3. Saisissez le tag du joueur ou du clan (le `#` est ajouté automatiquement)
   puis cliquez sur **Analyze**.
4. L'interface affiche :
   - fiche d'aperçu (nom, tag, trophées, etc.) ;
   - indicateurs d'activité et graphiques (logs de bataille/guerre) ;
   - score de fiabilité en pourcentage suivant les données disponibles ;
   - verdict couleur (vert, jaune, orange, rouge).

Un bouton étoile permet d'enregistrer le tag en « favori » ; la liste des
favoris se retrouve sous la barre de recherche.

---

## 🤖 Bot Discord

Liste des commandes disponibles :

1. **`/trust`** : analyse la fiabilité d'un joueur. Options : `tag:#TAG`
2. **`/trust-clan`** : liste tous les membres peu fiables d'un clan de la famille. Options : `clan:N`
3. **`/late`** : liste les joueurs en retard sur leurs decks de la journée (avant le reset). Options : `clan:N`
4. **`/chelem`** : liste les joueurs ayant fait 16/16 decks toutes les semaines d'une saison (par défaut : la dernière saison terminée). Options : `clan:N [season:X]`
5. **`/promote`** : liste les joueurs ayant atteint ≥ 2600 pts la semaine précédente. Options : `clan:N min:X`
6. **`/top-players`** : liste les meilleurs joueurs de la famille en fonction de la période. Options : `number:X period:[week|season] scope:[previous|actual]`
7. **`/demote`** : liste les joueurs n’ayant pas fait tous leurs combats GDC la semaine précédente. Options : `clan:N`
8. **`/discord-link`** : lie son compte Clash à son Discord. Options : `tag:#TAG` (tag2 et tag3 optionnels pour comptes multiples)
9. **`/discord-check`** : vérifie quels membres d'un clan sont présents sur le serveur Discord. Options : `clan:N`

> Remarque : l'installation de ce bot n'est réalisable que par displaynone.

## Notifications Discord automatiques

Deux scripts permettent de publier des messages dans les channels Discord des clans :

1. **Entrées/Sorties** : détecte les entrées et sorties de membres par comparaison entre deux snapshots. Post automatique dans le channel Discord du clan.
2. **Résumé GDC** : poste un résumé de la journée de GDC qui vient de se terminer dans chaque channel clan. Poste un résumé de la semaine lorsque le dernier jour de la GDC est fini.

<img width="802" height="656" alt="image" src="https://github.com/user-attachments/assets/7b0409be-0518-424f-a959-3c4a1fbb22b5" />

---

## 📌 Astuces

- Les favoris sont stockés localement dans votre navigateur : ils ne sont pas
  partagés entre appareils.
- Le lien de partage de l'analyse (`https://trustroyale.vercel.app/?mode=...`) peut
  être copié et envoyé à d'autres membres du clan.
- Sur la fiche joueur, le tag du clan renvoie désormais vers la page RoyaleAPI du
  clan (les analyses directes ne sont possibles que pour les 3 clans autorisés).
- La note jaune/verte en haut à droite indique si les données provenaient du cache
  (`Cached content 🔃`) ou non (`Live data`).
  Elle affiche aussi l'âge du dernier snapshot de decks&nbsp;: "Snapshot : today ✅",
  "Snapshot : yesterday ⚠️" ou une date plus ancienne (⚠️/❌ selon le jour).
  Si aucun snapshot n'a encore été enregistré pour le clan, la mention devient
  "Snapshot : none (no data) ❌".
  Les snapshots sont pris automatiquement lorsque des logs de guerre sont disponibles.
  Chaque snapshot contient désormais un champ `gdcPeriod` (UTC) qui indique
  précisément l'intervalle couvert par ce snapshot (par ex. "Sat 10:40 → Sun 10:40").

- Les pages de clan utilisent en priorité des données pré‑calculées
  (fichiers JSON issus de `npm run cache` et embarqués dans
  `frontend/public/clan-cache`) afin d'afficher instantanément l'aperçu
  et les graphiques (< 200 ms). Pendant ce temps, la liste des membres
  affiche un indicateur de chargement. Les données live arrivent ensuite
  (~3 s) et remplacent la liste des membres une seule fois, sans décalage
  visuel (*skeleton pattern*). L'aperçu et les graphiques sont également
  mis à jour silencieusement avec les valeurs fraîches.
- Le serveur garde également un petit cache mémoire (TTL ≈ 30 s) pour
  accélérer les navigations répétées sur la même instance. Ce dernier ne
  persiste pas entre redémarrages, mais évite des recomputations trop
  fréquentes lors d'un simple retour arrière dans le navigateur.
- Sur la vue clan, le badge **new** indique seulement que l'analyse n'a pas
  pu s'appuyer sur un historique de guerre complet. Il n'apparait plus si le
  membre n'a pas été vu dans le jeu depuis plus d'une semaine (pour éviter de
  considérer comme « nouveau » un ancien membre rentré sans jouer).
- **Transferts familiaux** : si un joueur passe d'un clan de la famille
  (`Y8JUPC9C`, `LRQP20V9`, `QU9UQJRL`) à un autre et qu'il a joué au moins 13 decks
  la semaine précédente, son historique est automatiquement fusionné et il
  est marqué **transfer** (score calé sur le vrai war log, pas sur le battle log).
- Pour analyser rapidement un tag sans recharger, collez-le dans l'URL.

---

## �🛠  Pour les développeurs

Voir [`CONTRIBUTING.md`](CONTRIBUTING.md) pour la documentation technique,
le setup local et les formules de calcul.

---

## 📝 Captures

Vue Clan générale :

<img width="1188" height="758" alt="image" src="https://github.com/user-attachments/assets/8689d747-d0a3-4d9c-9b45-17c66b2b202d" />

Vue Clan section membres :

<img width="1148" height="847" alt="image" src="https://github.com/user-attachments/assets/c0d6c3bc-0710-4f10-9aec-9a5b8538b892" />

Vue Joueur générale :

<img width="1184" height="935" alt="image" src="https://github.com/user-attachments/assets/dc56e2cb-5f1c-4432-b84d-ba7f67618f0e" />

Vue Joueur score :

<img width="1149" height="943" alt="image" src="https://github.com/user-attachments/assets/d5f2815d-a07a-4373-8b48-f82458ffb0fd" />
