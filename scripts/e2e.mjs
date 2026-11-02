// End-to-end check of a running Lienzo instance: auth, boards, realtime sync between two clients,
// persistence, facilitation, comments, files, duplicate/trash and logout.
// Usage (inside the image, so `ws` resolves): BASE_URL=http://host:3000 INVITE_TOKEN=... node scripts/e2e.mjs
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const base = process.env.BASE_URL;
const inviteToken = process.env.INVITE_TOKEN;
if (!base || !inviteToken) throw new Error("BASE_URL and INVITE_TOKEN are required");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

let cookie = "";
async function call(path, { method, body, withCookie = true } = {}) {
  const res = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(withCookie && cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function client(boardId) {
  const url = `${base.replace(/^http/, "ws")}/ws?board=${boardId}&client=${randomBytes(6).toString("hex")}`;
  const ws = new WebSocket(url, { headers: { cookie } });
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const next = (type, pred = () => true, ms = 4000) =>
    new Promise((resolve, reject) => {
      const found = inbox.find((m) => m.type === type && pred(m));
      if (found) return resolve(found);
      const w = { match: (m) => m.type === type && pred(m), resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    });
  const open = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("unexpected-response", (_req, res) => reject(new Error(`ws ${res.statusCode}`)));
    ws.on("error", reject);
  });
  return { ws, open, next, inbox, send: (m) => ws.send(JSON.stringify(m)) };
}

const password = `e2e-${randomBytes(9).toString("hex")}`;

// --- Auth ----------------------------------------------------------------------------------------
check("health", (await call("/api/health", { withCookie: false })).data.ok === true);
check("me without session is 401", (await call("/api/me", { withCookie: false })).status === 401);
const invite = await call(`/api/invites/${inviteToken}`, { withCookie: false });
check("invite is valid", invite.status === 200, invite.data.email);
const accepted = await call(`/api/invites/${inviteToken}/accept`, { body: { name: "E2E Bot", password } });
check("invite accepted and session set", accepted.status === 200 && cookie.startsWith("lz_session="));
check("invite cannot be reused", (await call(`/api/invites/${inviteToken}`, { withCookie: false })).status === 404);
const me = await call("/api/me");
check("me with session", me.status === 200 && me.data.user?.role === "admin");

// --- Boards ----------------------------------------------------------------------------------------
const created = await call("/api/boards", { body: { title: "E2E board" } });
const boardId = created.data.id;
check("board created", created.status === 200 && /^[0-9a-f-]{36}$/.test(boardId ?? ""));
check("board listed", (await call("/api/boards")).data.boards?.some((b) => b.id === boardId));

// --- Realtime --------------------------------------------------------------------------------------
const anonymous = new WebSocket(`${base.replace(/^http/, "ws")}/ws?board=${boardId}`);
const anonStatus = await new Promise((r) => {
  anonymous.on("unexpected-response", (_q, res) => r(res.statusCode));
  anonymous.on("open", () => r(101));
  anonymous.on("error", () => r(0));
});
check("websocket rejects requests without session", anonStatus === 401, String(anonStatus));

const a = client(boardId);
const b = client(boardId);
await Promise.all([a.open, b.open]);
await Promise.all([a.next("init"), b.next("init")]);
check("two clients joined the room", true);
const presence = await b.next("presence", (m) => m.users?.[0]?.clientIds?.length === 2);
check("presence lists both connections", presence.users.length === 1 && presence.users[0].clientIds.length === 2);

const sticky = {
  id: "e2e-sticky",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  version: 1,
  versionNonce: 42,
  isDeleted: false,
  backgroundColor: "#FFF59D",
  updated: Date.now(),
};
a.send({ type: "update", elements: [sticky] });
const relayed = await b.next("update", (m) => m.elements?.some((e) => e.id === "e2e-sticky"));
check("element update relayed to the other client", relayed.elements[0].version === 1);

a.send({ type: "update", elements: [{ ...sticky, version: 2, x: 50 }] });
await b.next("update", (m) => m.elements?.some((e) => e.id === "e2e-sticky" && e.version === 2));
b.send({ type: "update", elements: [{ ...sticky, version: 1, x: 999 }] }); // stale write must lose
await new Promise((r) => setTimeout(r, 300));
check(
  "stale update is rejected by the server",
  !a.inbox.some((m) => m.type === "update" && m.elements?.some((e) => e.id === "e2e-sticky" && e.x === 999)),
);

a.send({ type: "pointer", pointer: { x: 10, y: 20, tool: "pointer" }, button: "up" });
const pointer = await b.next("pointer");
check("cursor relayed with user name", pointer.user?.name === "E2E Bot");

a.send({ type: "timer", action: "start", durationMs: 60_000 });
const timer = await b.next("timer", (m) => m.timer);
check("timer shared", timer.timer.durationMs === 60_000);

a.send({ type: "voting", action: "start", votesPerUser: 2 });
await b.next("voting", (m) => m.voting?.open);
a.send({ type: "voting", action: "vote", elementId: "e2e-sticky", delta: 1 });
a.send({ type: "voting", action: "reveal" });
const votes = await b.next("voting", (m) => m.voting?.totals?.["e2e-sticky"] === 1);
check("vote counted and revealed", votes.voting.totals["e2e-sticky"] === 1);

await new Promise((r) => setTimeout(r, 2500)); // debounced save
a.ws.close();
b.ws.close();
await new Promise((r) => setTimeout(r, 500));
const c = client(boardId);
await c.open;
const init = await c.next("init");
const saved = init.elements.find((e) => e.id === "e2e-sticky");
check("element persisted with the winning version", saved?.version === 2 && saved?.x === 50);
c.ws.close();

// --- Comments, files, duplicate, trash ---------------------------------------------------------------
await call(`/api/boards/${boardId}/comments`, { body: { body: "e2e comment", x: 1, y: 2 } });
check("comment stored", (await call(`/api/boards/${boardId}/comments`)).data.comments?.[0]?.body === "e2e comment");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
check("image uploaded", (await call(`/api/boards/${boardId}/files`, { body: { id: "e2e-file", mimeType: "image/png", dataURL: png } })).status === 200);
check("image served back", (await call(`/api/boards/${boardId}/files`)).data.files?.[0]?.dataURL === png);
const copy = await call(`/api/boards/${boardId}/duplicate`, { body: {} });
check("board duplicated", copy.status === 200 && copy.data.id && copy.data.id !== boardId);
await call(`/api/boards/${boardId}`, { method: "DELETE" });
check("board moved to trash", (await call("/api/boards?trash=1")).data.boards?.some((x) => x.id === boardId));

// --- Login / logout ------------------------------------------------------------------------------
await call("/api/auth/logout", { body: {} });
cookie = "";
check("logged out", (await call("/api/me")).status === 401);
check("wrong password rejected", (await call("/api/auth/login", { body: { email: invite.data.email, password: "nope-nope-nope" } })).status === 401);
const login = await call("/api/auth/login", { body: { email: invite.data.email, password } });
check("login with password", login.status === 200 && login.data.user?.name === "E2E Bot");
const ai = await call("/api/ai/status");
check("AI status reported", typeof ai.data.enabled === "boolean", `enabled=${ai.data.enabled}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
