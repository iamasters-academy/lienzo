import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createInvite,
  createSession,
  destroySession,
  hashPassword,
  pickColor,
  requireAdmin,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  sha256,
  type User,
  verifyPassword,
} from "./auth.js";
import { one, pool, query } from "./db.js";
import { closeRoom } from "./realtime.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Brute-force guard for password and invite endpoints: 10 attempts per IP every 10 minutes.
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}
const publicBaseUrl = () => process.env.PUBLIC_BASE_URL ?? "http://localhost:5173";

type BoardRow = {
  id: string;
  title: string;
  owner_id: string | null;
  owner_name: string | null;
  thumbnail: string | null;
  starred: boolean;
  created_at: string;
  updated_at: string;
};

const boardColumns = `b.id, b.title, b.owner_id, u.name as owner_name, b.thumbnail,
  ($1::uuid = any(b.starred_by)) as starred, b.created_at, b.updated_at`;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    await pool.query("select 1");
    return { ok: true };
  });

  // ---- Auth ------------------------------------------------------------------------------

  app.post("/api/auth/login", async (request, reply) => {
    if (tooManyAttempts(request.ip)) return reply.code(429).send({ error: "too_many_attempts" });
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const user = await one<User & { password_hash: string | null; disabled: boolean }>(
      "select id, email, name, role, color, password_hash, disabled from users where email = lower($1)",
      [body.email],
    );
    if (!user || user.disabled || !(await verifyPassword(body.password, user.password_hash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expires);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role, color: user.color } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireUser }, async (request) => ({ user: request.user }));

  app.patch("/api/me", { preHandler: requireUser }, async (request) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(80).optional(), password: z.string().min(10).optional() })
      .parse(request.body);
    if (body.name) await query("update users set name = $1 where id = $2", [body.name, request.user!.id]);
    if (body.password) {
      await query("update users set password_hash = $1 where id = $2", [
        await hashPassword(body.password),
        request.user!.id,
      ]);
    }
    return { ok: true };
  });

  // ---- Invites (team onboarding without sharing passwords) ----------------------------------

  app.get("/api/invites/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const invite = await one<{ email: string }>(
      "select email from invites where token_hash = $1 and used_at is null and expires_at > now()",
      [sha256(token)],
    );
    if (!invite) return reply.code(404).send({ error: "invite_not_found" });
    return invite;
  });

  app.post("/api/invites/:token/accept", async (request, reply) => {
    if (tooManyAttempts(request.ip)) return reply.code(429).send({ error: "too_many_attempts" });
    const { token } = request.params as { token: string };
    const body = z
      .object({ name: z.string().trim().min(1).max(80), password: z.string().min(10).max(200) })
      .parse(request.body);
    const invite = await one<{ email: string; role: "admin" | "member" }>(
      `update invites set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning email, role`,
      [sha256(token)],
    );
    if (!invite) return reply.code(404).send({ error: "invite_not_found" });
    const passwordHash = await hashPassword(body.password);
    const user = await one<User>(
      `insert into users (email, name, password_hash, role, color) values ($1, $2, $3, $4, $5)
       on conflict (email) do update set name = excluded.name, password_hash = excluded.password_hash,
         role = excluded.role, disabled = false
       returning id, email, name, role, color`,
      [invite.email, body.name, passwordHash, invite.role, await pickColor()],
    );
    const session = await createSession(user!.id);
    setSessionCookie(reply, session.token, session.expires);
    return { user };
  });

  app.get("/api/team", { preHandler: requireUser }, async () => {
    const users = await query(
      "select id, email, name, role, color, disabled, created_at from users order by created_at",
    );
    const invites = await query(
      `select email, role, created_at, expires_at from invites
        where used_at is null and expires_at > now() order by created_at desc`,
    );
    return { users, invites };
  });

  app.post("/api/team/invites", { preHandler: requireAdmin }, async (request) => {
    const body = z
      .object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") })
      .parse(request.body);
    const token = await createInvite(body.email, body.role, request.user!.id);
    return { url: `${publicBaseUrl()}/invite/${token}` };
  });

  app.patch("/api/team/users/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({ role: z.enum(["admin", "member"]).optional(), disabled: z.boolean().optional() })
      .parse(request.body);
    if (id === request.user!.id) return reply.code(400).send({ error: "cannot_change_self" });
    if (body.role) await query("update users set role = $1 where id = $2", [body.role, id]);
    if (body.disabled !== undefined) {
      await query("update users set disabled = $1 where id = $2", [body.disabled, id]);
      if (body.disabled) await query("delete from sessions where user_id = $1", [id]);
    }
    return { ok: true };
  });

  // ---- Boards ------------------------------------------------------------------------------

  app.get("/api/boards", { preHandler: requireUser }, async (request) => {
    const { trash } = request.query as { trash?: string };
    const boards = await query<BoardRow>(
      `select ${boardColumns} from boards b left join users u on u.id = b.owner_id
        where ${trash ? "b.deleted_at is not null" : "b.deleted_at is null"}
        order by b.updated_at desc`,
      [request.user!.id],
    );
    return { boards };
  });

  app.post("/api/boards", { preHandler: requireUser }, async (request) => {
    // Templates are expanded in the browser (text measuring needs the DOM): the board starts empty.
    const body = z.object({ title: z.string().trim().max(120).optional() }).parse(request.body ?? {});
    return one<{ id: string }>("insert into boards (title, owner_id) values ($1, $2) returning id", [
      body.title || "Tablero sin título",
      request.user!.id,
    ]);
  });

  app.get("/api/boards/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const board = await one<BoardRow>(
      `select ${boardColumns} from boards b left join users u on u.id = b.owner_id
        where b.id = $2 and b.deleted_at is null`,
      [request.user!.id, id],
    );
    if (!board) return reply.code(404).send({ error: "board_not_found" });
    return { board };
  });

  app.patch("/api/boards/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        starred: z.boolean().optional(),
        thumbnail: z.string().max(400_000).optional(),
      })
      .parse(request.body);
    const exists = await one("select 1 from boards where id = $1", [id]);
    if (!exists) return reply.code(404).send({ error: "board_not_found" });
    if (body.title) await query("update boards set title = $1, updated_at = now() where id = $2", [body.title, id]);
    if (body.thumbnail) await query("update boards set thumbnail = $1 where id = $2", [body.thumbnail, id]);
    if (body.starred !== undefined) {
      await query(
        body.starred
          ? "update boards set starred_by = array_append(array_remove(starred_by, $1::uuid), $1::uuid) where id = $2"
          : "update boards set starred_by = array_remove(starred_by, $1::uuid) where id = $2",
        [request.user!.id, id],
      );
    }
    return { ok: true };
  });

  app.post("/api/boards/:id/duplicate", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const copy = await one<{ id: string }>(
      `insert into boards (title, owner_id, scene, thumbnail)
       select title || ' (copia)', $2, scene, thumbnail from boards where id = $1 and deleted_at is null
       returning id`,
      [id, request.user!.id],
    );
    if (!copy) return reply.code(404).send({ error: "board_not_found" });
    await query(
      `insert into files (id, board_id, mime, size, data, created_by)
       select id || '-' || $3, $2, mime, size, data, created_by from files where board_id = $1`,
      [id, copy.id, copy.id.slice(0, 8)],
    );
    // File ids are referenced from image elements: remap them in the copied scene.
    await query(
      `update boards set scene = jsonb_set(scene, '{elements}', coalesce((
          select jsonb_agg(case when e ? 'fileId' and e->>'fileId' is not null
            then jsonb_set(e, '{fileId}', to_jsonb((e->>'fileId') || '-' || $2)) else e end)
          from jsonb_array_elements(scene->'elements') e), '[]'::jsonb))
        where id = $1`,
      [copy.id, copy.id.slice(0, 8)],
    );
    return copy;
  });

  app.delete("/api/boards/:id", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    await query("update boards set deleted_at = now() where id = $1", [id]);
    closeRoom(id);
    return { ok: true };
  });

  app.post("/api/boards/:id/restore", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    await query("update boards set deleted_at = null, updated_at = now() where id = $1", [id]);
    return { ok: true };
  });

  // ---- Files (images dropped on the canvas) -------------------------------------------------

  app.post("/api/boards/:id/files", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({ id: z.string().min(1).max(200), mimeType: z.string().max(100), dataURL: z.string() })
      .parse(request.body);
    const match = /^data:([^;]+);base64,(.+)$/.exec(body.dataURL);
    if (!match) return reply.code(400).send({ error: "invalid_data_url" });
    const data = Buffer.from(match[2]!, "base64");
    if (data.length > MAX_FILE_BYTES) return reply.code(413).send({ error: "file_too_large" });
    await query(
      `insert into files (id, board_id, mime, size, data, created_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [body.id, id, match[1], data.length, data, request.user!.id],
    );
    return { ok: true };
  });

  app.get("/api/boards/:id/files", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await query<{ id: string; mime: string; data: Buffer; created_at: string }>(
      "select id, mime, data, created_at from files where board_id = $1",
      [id],
    );
    return {
      files: rows.map((r) => ({
        id: r.id,
        mimeType: r.mime,
        dataURL: `data:${r.mime};base64,${r.data.toString("base64")}`,
        created: new Date(r.created_at).getTime(),
      })),
    };
  });

  // ---- Comments ------------------------------------------------------------------------------

  app.get("/api/boards/:id/comments", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const comments = await query(
      `select c.id, c.parent_id, c.x, c.y, c.body, c.resolved, c.created_at,
              u.id as author_id, u.name as author_name, u.color as author_color
         from comments c left join users u on u.id = c.author_id
        where c.board_id = $1 order by c.created_at`,
      [id],
    );
    return { comments };
  });

  app.post("/api/boards/:id/comments", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        body: z.string().trim().min(1).max(4000),
        x: z.number().optional(),
        y: z.number().optional(),
        parentId: z.string().uuid().optional(),
      })
      .parse(request.body);
    return one(
      `insert into comments (board_id, parent_id, author_id, x, y, body) values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [id, body.parentId ?? null, request.user!.id, body.x ?? null, body.y ?? null, body.body],
    );
  });

  app.patch("/api/comments/:id", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ resolved: z.boolean() }).parse(request.body);
    await query("update comments set resolved = $1 where id = $2", [body.resolved, id]);
    return { ok: true };
  });

  app.delete("/api/comments/:id", { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    await query("delete from comments where id = $1 and author_id = $2", [id, request.user!.id]);
    return { ok: true };
  });
}
