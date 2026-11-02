// Copies Excalidraw's fonts into web/public so they are served from our own origin
// (window.EXCALIDRAW_ASSET_PATH = "/") instead of a third-party CDN.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const source = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const target = "web/public/fonts";
if (!existsSync(source)) throw new Error(`Missing ${source}: run npm install first`);
mkdirSync("web/public", { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`Copied Excalidraw fonts to ${target}`);
