# ⚔️ TrustRoyale — analyseur de fiabilité des guerres de clan

TrustRoyale aide les chefs de clan Clash Royale à évaluer rapidement la
fiabilité des joueurs et clans avant les recrutements ou les guerres.

Le service se compose :

- d'une application web accessible sur
  `https://trustroyale.vercel.app` ;
- d'un bot Discord (commande `/trust`) permettant de lancer une analyse
  depuis un serveur Discord.

---

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

---

## 📌 Astuces

- Les favoris sont stockés localement dans votre navigateur : ils ne sont pas
  partagés entre appareils.
- Le lien de partage de l'analyse (`https://trustroyale.vercel.app/?mode=...`) peut
  être copié et envoyé à d'autres membres du clan.
- Pour analyser rapidement un tag sans recharger, collez-le dans l'URL.

---

## 🛠  Pour les développeurs

Voir [`CONTRIBUTING.md`](CONTRIBUTING.md) pour la documentation technique,
le setup local et les formules de calcul.

---

## 📝 Licence

MIT — Ce projet n'est pas affilié à Supercell.
