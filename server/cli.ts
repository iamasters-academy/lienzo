// Usage: node dist-server/cli.js invite <email> [admin|member]
// Prints a one-time link where the person sets their own name and password.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInvite } from "./auth.js";
import { migrate, pool } from "./db.js";

const [command, email, role = "member"] = process.argv.slice(2);

if (command !== "invite" || !email || (role !== "admin" && role !== "member")) {
  console.error("Usage: cli invite <email> [admin|member]");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await migrate(path.join(root, "server", "migrations"));
const token = await createInvite(email, role, null);
const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:5173";
console.log(`${base}/invite/${token}`);
await pool.end();
