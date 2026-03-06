# AGENTS.md

## Projet

Analyseur de fiabilité de guerre de clan Clash Royale — backend Express + frontend Vite, déployé sur Vercel.

## Stack technique

- **Backend** : Node.js ESM, Express 4, `node-fetch`, port 3000 en dev
- **Frontend** : Vite 5, Vanilla JS, Chart.js 4, pas de framework
- **Déploiement** : Vercel (`vercel --prod` depuis la racine), `api/index.js` comme entrée serverless
- **Cache** : in-memory, TTL 5 min (`backend/services/cache.js`)

## Commandes essentielles

```bash
# Dev
cd backend && npm run dev        # Express sur :3000 (nodemon)
cd frontend && npm run dev       # Vite sur :5173, proxy /api → :3000

# Build + deploy
cd frontend && npx vite build
vercel --prod                    # depuis la racine
```

## Conventions critiques du projet

- **ESM obligatoire** : `"type": "module"` dans le backend — pas de `require()`
- **Verdicts** : 4 paliers stricts — vert ≥ 76 %, jaune 61–75 %, orange 31–60 %, rouge 0–30 %

## Conventions générales critiques

- **CSS** : pas de styles inline (bloqués par CSP). CSS natif uniquement, pas de Tailwind/Bootstrap.
- **Commits** : Conventional Commits — type en anglais, description en français ex : `feat(clan): ajoute filtre par verdict`
- **Commentaires** : en français

## Sous-agents

Utiliser des **sous-agents** (Task tool) par défaut pour toute opération dont seul le résumé compte : exploration de code, recherche, revue, investigation. Ne pas encombrer la conversation principale.
