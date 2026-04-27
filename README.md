# ⚔️ TrustRoyale

TrustRoyale est le Bot officiel de la ☆. Resistance Family 🛠️

- Suivez en temps réel les statistiques de nos clans
- Analysez vos performances et celles des autres joueurs
- Optimisez votre stratégie

TrustRoyale se compose :

1. d'une application web accessible sur `https://trustroyale.vercel.app` ;
2. d'un bot Discord (commandes `/`) permettant de lancer diverses analyses
   depuis notre serveur Discord.

<img width="612" height="100" alt="image" src="https://github.com/user-attachments/assets/9c05c90d-7890-4e32-aa8c-550909837c58" />

## 🚀 Utilisation de l'application web

1. Rendez-vous sur <https://trustroyale.vercel.app> (version anglaise ou française disponibles)
2. Choisissez le mode `Player` ou `Clan` en haut.
3. Saisissez le tag du joueur ou du clan (le `#` est ajouté automatiquement)
   puis cliquez sur **Analyze**.
4. L'interface affiche :
   - fiche d'aperçu (nom, tag, trophées, etc.) ;
   - indicateurs d'activité et graphiques (logs de bataille/guerre) ;
   - score de fiabilité en pourcentage suivant les données disponibles ;
   - etc.

Un bouton étoile permet d'enregistrer le tag en « favori » ; la liste des
favoris se retrouve sous la barre de recherche.

## 🤖 Utilisation du Bot Discord

Commencer par taper `/` dans le chat pour voir la liste des commandes disponibles.

Liste des commandes :

1. **`/trust`** : analyse la fiabilité d'un joueur. Options : `tag:#TAG`
2. **`/stats`** : affiche les statistiques GDC détaillées d'un membre de la famille. Options : `tag:#TAG`
3. **`/trust-clan`** : liste tous les membres peu fiables d'un clan de la famille. Options : `clan:N`
4. **`/late`** : liste les joueurs en retard sur leurs decks de la journée (avant le reset). Options : `clan:N`
5. **`/chelem`** : liste les joueurs ayant fait 16/16 decks toutes les semaines d'une saison (par défaut : la dernière saison terminée). Options : `clan:N [season:X]`
6. **`/promote`** : liste les joueurs ayant atteint ≥ 2600 pts la semaine précédente. Options : `clan:N`
7. **`/top-players`** : liste les meilleurs joueurs de la famille pour la période précédente. Options : `number:[3|5|10] period:[week|season]`
8. **`/demote`** : liste les joueurs n’ayant pas fait tous leurs combats GDC la semaine précédente. Options : `clan:N`
9. **`/discord-link`** : lie son compte Clash à son Discord. Options : `tag:#TAG` (tag2 et tag3 optionnels pour comptes multiples)
10. **`/discord-check`** : vérifie quels membres d'un clan sont présents sur le serveur Discord. Options : `clan:N`

> Remarque : l'installation de ce bot n'est réalisable que par displaynone.

## 📮 Notifications Discord automatiques

En plus des commandes du Bot, deux scripts permettent de publier automatiquement des messages dans les channels Discord des clans :

1. **Nouveautés** : détecte les arrivées, départs et changements de rôle des membres par comparaison entre deux snapshots. Post automatique dans le channel Discord du clan.
2. **Résumé GDC** : poste un résumé de la journée de GDC qui vient de se terminer dans chaque channel clan. Poste un résumé de la semaine lorsque le dernier jour de la GDC est terminé.

<img width="802" height="656" alt="image" src="https://github.com/user-attachments/assets/7b0409be-0518-424f-a959-3c4a1fbb22b5" />

---

## 📌 Astuces

- Les favoris sont stockés localement dans votre navigateur : ils ne sont pas
  partagés entre appareils.
- Le lien de partage de l'analyse (`https://trustroyale.vercel.app/?mode=...`) peut
  être copié et envoyé à d'autres membres du clan.

---

## �🛠 Pour les développeurs

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
