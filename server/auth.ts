import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { one, query } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "lz_session";
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;

// Distinct, readable cursor colors for collaborators.
const USER_COLORS = ["#4262FF", "#E5484D", "#12A594", "#F76B15", "#8E4EC6", "#D6409F", "#0090FF", "#46A758"];

export type User = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  color: string;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [
    sha256(token),
    userId,
    expires,
  ]);
  return { token, expires };
}

export async function destroySession(token: string): Promise<void> {
  await query("delete from sessions where token_hash = $1", [sha256(token)]);
}

export async function userFromToken(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  return one<User>(
    `select u.id, u.email, u.name, u.role, u.color
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and not u.disabled`,
    [sha256(token)],
  );
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
}

/** Fastify preHandler: rejects the request with 401 unless a valid session cookie is present. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await userFromToken(request.cookies[SESSION_COOKIE]);
  if (!user) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  request.user = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent) return;
  if (request.user?.role !== "admin") await reply.code(403).send({ error: "forbidden" });
}

export async function createInvite(
  email: string,
  role: "admin" | "member",
  createdBy: string | null,
): Promise<string> {
  const token = newToken();
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await query(
    "insert into invites (token_hash, email, role, created_by, expires_at) values ($1, lower($2), $3, $4, $5)",
    [sha256(token), email, role, createdBy, expires],
  );
  return token;
}

export async function pickColor(): Promise<string> {
  const row = await one<{ n: string }>("select count(*)::text as n from users");
  return USER_COLORS[Number(row?.n ?? 0) % USER_COLORS.length] ?? USER_COLORS[0]!;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}
