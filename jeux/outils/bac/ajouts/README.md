# Ajouts à la main aux listes du Petit Bac

Un fichier par thème (`<thème>.txt`, même identifiant que `jeux/data/bac/<thème>.json`), un mot par ligne ; pour les acteurs et la musique, le nom complet de la personne. Lignes commençant par `#` ignorées.

Source : les mots contestés par les joueurs (`node --env-file=.env jeux/outils/bac/contestations.mjs`), vérifiés à la main. Puis `node jeux/outils/bac/genererListes.mjs <thème>`.
