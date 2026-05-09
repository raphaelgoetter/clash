# Trustroyale

Trustroyale est un outil web ainsi qu'un bot Discord développé pour la famille Résistance que j'ai commencé à developper le 8 mars (il y a 2 mois aujourd'hui !). Il calcule un **score de fiabilité GDC** (0–100 %) pour chaque joueur à partir de 9 critères objectifs (régularité, score, victoires, stabilité, activité…).

- L'interface web ([trustroyale.vercel.app](https://trustroyale.vercel.app/)) permet d'analyser joueurs et clans. C'est ouvert à tous, mais les données de fiabilité sont limitées à la famille Résistance (3 clans).
- Le bot Discord expose une dizaine de commandes (`/trust`, `/stats`, `/trust-clan`, `/chelem`, `/top-players`, `/promote`, `/demote`…) pour piloter les GDC, les recrutements et les promotions sans quitter Discord. Le bot est déployé sur les serveurs de la famille et accessible à tous les membres.

---

**Trustroyale** est un outil développé en interne pour la famille Résistance afin de mieux organiser nos clans et faciliter les recrutements.

Trustroyale fournit des "critères de fiabilité" objectifs et orientés spécifiquement pour les Guerres de Clan, pour que chacun (membres et chefs de clan) puisse avancer ensemble en meilleure confiance.

## 🧭 Les critères de fiabilité

Trustroyale analyse plusieurs critères pour évaluer la fiabilité d’un joueur ou d’un clan. Le score final est un pourcentage calculé à partir de ces critères.

- **Regularité** (coeff 12) : decks de GDC joués / (16 × semaine) — malus par semaine incomplète
- **Score moyenne** (coeff 10) : score moyen / semaine (max = 3000)
- **Victoires CW2** (coeff 8) : victoires totales en GDC (max = 250)
- **Stabilité clan** (coeff 8) : semaines consécutives dans le clan (max = 5+)
- **Dernière connexion** (coeff 5) : 5 pts si connecté ce jour (moins si plus vieux)
- **Win rate** (coeff 3) : pourcentage de victoires en GDC (max = 100% win rate)
- **Expérience (trophées)** (coeff 3) : nombre de trophées (max = 14 000)
- **Dons** (coeff 2) : nombre de cartes données (max = 500)
- **Discord lié** (coeff 2) : 2 pts si compte lié via `/discord-link`

L’algorithme est conçu pour que le score reflète à la fois l’investissement **individuel** et la **contribution au clan**, tout en restant transparent et explicable.

---

## 🚀 Comment utiliser l’application web ?

Rendez-vous sur :

👉 <https://trustroyale.vercel.app/>

L’interface propose deux modes :

- **Player** : analyse individuelle (fiabilité, activité, score, historique)
- **Clan** : analyse collective (répartition des risques, historique, top joueurs)

> ⭐ Favoris : Un bouton étoile permet d’ajouter un joueur ou un clan à vos favoris et les conserver aux prochaines visites (stockage local).

## 🤖 Le bot Discord

Pour rendre Trustroyale accessible directement dans nos serveurs Discord, nous avons déployé un bot avec plusieurs commandes utiles.

### 1) `/trust tag:#TAG`

➡️ Donne une fiche complète d’un joueur :

- Score global (pourcentage + couleur)
- Détail par critère (activité, régularité, winrate, dons, etc.)
- Historique des semaines de GDC
- Liens utiles (profil, clan, etc.)

**Usage** :

```text
/trust tag:#YRGJGR8R
```

### 2) `/stats tag:#TAG`

➡️ Affiche les statistiques détaillées de GDC pour un membre de la famille :

- Historique des decks par semaine
- Points par semaine
- Moyenne et record de points
- Statut de présence dans la famille

**Usage** :

```text
/stats tag:#YRGJGR8R
```

### 3) `/trust-clan clan:N`

➡️ Liste les membres **risqués** du clan.

C’est un outil conçu pour être **proactif** : on détecte les membres à risque dans l'objectif d'optimiser les Guerres de clan.

**Usage** :

```text
/trust-clan clan:2
```

### 4) `/chelem clan:N [season:X]`

➡️ Liste les joueurs ayant fait **16/16 decks** chaque semaine de la saison spécifiée (par défaut : la dernière saison terminée).

**Usage** :

```text
/chelem clan:1
```

### 5) `/top-players number:[3|5|10] period:[week|season]`

➡️ Liste les top X joueurs (tous clans) sur la période demandée.

- `period=week` : points de la semaine précédente
- `period=season` : total points de la saison précédente

**Usage** :

```text
/top-players number:5 period:week
/top-players number:10 period:season
/top-players number:5 period:season
```

### 6) `/discord-link tag:#TAG`

➡️ Lie ton compte Clash à ton compte Discord.

✅ IMPORTANT : cela **ajoute 2 points** à ton score de fiabilité (c’est un bonus pour lier les identités).

**Usage** :

```text
/discord-link tag:#YRGJGR8R
```

Plusieurs tags peuvent être liés (ex : pour les comptes secondaires) en ajoutant `tag2:#TAG` et `tag3:#TAG` dans la commande.

### 7) `/discord-check clan:N` (surtout pour chefs de clan)

➡️ Vérifie qui du clan est présent sur le serveur Discord (liés / non liés / absents).

Pratique pour les recrutements et pour s’assurer que tout le monde est bien connecté.

### 8) `/promote clan:N` (pour chefs de clan)

➡️ Affiche les joueurs qui ont atteint un minimum de 2600 points la semaine précédente.

Utile pour les campagnes de promotion et pour savoir qui soutenir pour monter dans les quotas.

**Usage** :

```text
/promote clan:1
```

### 9) `/demote clan:N` (pour chefs de clan)

➡️ Affiche les joueurs qui n’ont pas réalisé 16/16 decks la semaine précédente (identique à la carte "🤷 Last War fails").

- inclut le week ID (`Sxxx-Wx`) dans le titre
- joue en priorité sur les membres encore présents dans le clan
- affiche un maximum de 25 joueurs puis `...and N de plus`

**Usage** :

```text
/demote clan:2
```

---

## 💡 Pourquoi utiliser ces outils ?

### ✅ Pour s’améliorer individuellement

- Voir son **score de fiabilité** et comprendre ce qui le tire vers le bas (activité, war log, etc.).
- Suivre son **évolution semaine après semaine**.
- Se comparer aux autres membres (sans stigmatisation — chacun progresse à son rythme).

### ✅ Pour renforcer le collectif

- Repérer rapidement les joueurs qui peuvent avoir besoin de soutien (à orienter vers un clan plus "chill").
- Comprendre la **valeur globale du clan** en termes d’activité et de fiabilité.
- Faciliter la communication entre leaders / co-leaders (qui peut recruter, qui a besoin d’aide, etc.).

### ✅ Pour booster la cohérence interne

- Les scores sont basés sur des **données objectives** (logs, snapshots, activité).
- Ils ne se basent **pas sur des avis**, mais sur du factuel. Si un membre est “à risque”, c’est pour l’aider.
