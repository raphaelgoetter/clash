# Images du jeu Frame

Placer ici les images des frames de films, au format `.webp`, avec le nom
exact renseigné dans le champ `"image"` de `../frames.json` (convention :
index zero-paddé, ex. `0001.webp`, `0002.webp`, ...).

Ce dossier n'est **pas** servi statiquement (`data/` n'est pas exposé
publiquement). Seule l'image de la partie actuellement active est
accessible, via la route serveur `/api/frames/image` qui la lit ici et la
diffuse à la demande — impossible de deviner ou charger à l'avance
l'image d'une semaine future.
