// Stub local de blobAssets.js (lecture dans data/)
import fs from "node:fs/promises";
export async function readBlobAsset(rel) { return fs.readFile(new URL(`../../data/${rel}`, import.meta.url)); }
export async function readBlobFontPath(rel) { return new URL(`../../data/${rel}`, import.meta.url).pathname; }
