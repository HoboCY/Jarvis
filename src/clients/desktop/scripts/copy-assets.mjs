import { cp, mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await mkdir("dist/assets", { recursive: true });
await copyFile("src/renderer/index.html", "dist/renderer/index.html");
await copyFile("src/renderer/overlay.html", "dist/renderer/overlay.html");
await copyFile("src/assets/JarvisTemplate.png", "dist/assets/JarvisTemplate.png");
await copyFile("src/assets/JarvisTemplate@2x.png", "dist/assets/JarvisTemplate@2x.png");
await cp("src/assets/sherpa-kws-wenetspeech-3.3M", "dist/assets/sherpa-kws-wenetspeech-3.3M", { recursive: true });
console.log("Copied renderer and tray assets to dist.");
