import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await copyFile("src/renderer/index.html", "dist/renderer/index.html");
console.log("Copied renderer assets to dist/renderer.");
