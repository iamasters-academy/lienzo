import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAiRoutes } from "./ai.js";
import { migrate } from "./db.js";
import { flushAll, handleUpgrade } from "./realtime.js";
import { registerRoutes } from "./routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.PORT ?? 3000);

await migrate(path.join(root, "server", "migrations"));

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 16 * 1024 * 1024, trustProxy: true });
await app.register(cookie);

app.addHook("onSend", async (_request, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  reply.header("x-robots-tag", "noindex, nofollow");
  reply.header("content-security-policy", "frame-ancestors 'none'");
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: "invalid_input", issues: error.issues });
  app.log.error(error);
  const statusCode = (error as { statusCode?: number }).statusCode;
  const message = error instanceof Error ? error.message : "internal_error";
  return reply.code(statusCode ?? 500).send({ error: statusCode && statusCode < 500 ? message : "internal_error" });
});

await registerRoutes(app);
await registerAiRoutes(app);

// Serve the built SPA in production; every non-API route falls back to index.html.
const webDist = path.join(root, "dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: true,
    cacheControl: false,
    // Hashed bundles never change; index.html must always be revalidated so a deploy is picked up.
    setHeaders(res, filePath) {
      res.header(
        "cache-control",
        filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes(`${path.sep}fonts${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    // Missing API routes and missing static files are real 404s, never the SPA shell.
    if (/^\/(api|assets|fonts)\//.test(request.url) || /\.[a-z0-9]+$/i.test(request.url.split("?")[0]!)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.header("cache-control", "no-cache").sendFile("index.html");
  });
}

app.server.on("upgrade", handleUpgrade);

async function shutdown(signal: string) {
  app.log.info(`${signal}: flushing boards`);
  await flushAll().catch((error) => app.log.error(error));
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port, host: "0.0.0.0" });
