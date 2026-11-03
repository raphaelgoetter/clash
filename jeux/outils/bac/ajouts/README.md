# Ajouts à la main aux listes du Petit Bac

Un fichier par thème (`<thème>.txt`, même identifiant que `jeux/data/bac/<thème>.json`), un mot par ligne ; pour les acteurs et la musique, le nom complet de la personne. Lignes commençant par `#` ignorées.

Pour ajouts versionnés (corrections de fond d'une liste), puis `node jeux/outils/bac/genererListes.mjs <thème>`. Les mots contestés par les joueurs s'acceptent sans commit ni déploiement : `node --env-file=.env jeux/outils/bac/contestations.mjs --accepter <thème>:<mot>` (Redis `bacduel:ajouts`).
