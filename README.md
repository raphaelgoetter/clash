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

## 🤖 Bot Discord `/trust`

Tapez :

```
/trust tag: #ABC123
```

Le bot répond avec l'analyse du joueur, formatée et colorée directement dans
le canal. L'analyse est différée — vous voyez « Processing… » puis le résultat
quelques secondes plus tard.

> Remarque : l'installation de ce bot n'est réalisable que par displaynone.

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
  "Snapshot : yesterday ⚠️" ou une date plus ancienne (⚠️/❌ selon le jour). Les
  snapshots sont pris automatiquement lorsque des logs de guerre sont disponibles.
- Sur la vue clan, le badge **new** indique seulement que l'analyse n'a pas
  pu s'appuyer sur un historique de guerre complet. Il n'apparait plus si le
  membre n'a pas été vu dans le jeu depuis plus d'une semaine (pour éviter de
  considérer comme « nouveau » un ancien membre rentré sans jouer).
- Pour analyser rapidement un tag sans recharger, collez-le dans l'URL.

---

## 🛠  Pour les développeurs

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
