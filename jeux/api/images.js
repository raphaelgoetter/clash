// Fonction Vercel des images générées des jeux (plateaux, cartes,
// illustrations) : routes /api/<jeu>/… de jeux/server/imageRoutes.js. Les
// images fixes sont servies telles quelles depuis jeux/public/.

import "../env.js";
import express from "express";
import imageRoutes from "../server/imageRoutes.js";

const app = express();
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use(imageRoutes);

export default app;
