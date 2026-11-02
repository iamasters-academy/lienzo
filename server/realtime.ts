import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { SESSION_COOKIE, type User, userFromToken } from "./auth.js";
import { one, query } from "./db.js";

/**
 * One room per board. The server keeps the authoritative element map in memory, merges
 * incoming element updates by version (same rule as Excalidraw's reconcile: higher version
 * wins; on a tie the lower versionNonce wins), relays presence, and persists debounced.
 */

type Element = { id: string; version: number; versionNonce: number; isDeleted?: boolean; updated?: number } & Record<
  string,
  unknown
>;

type Timer = { endsAt: number | null; durationMs: number; pausedRemainingMs: number | null; startedBy: string };
type Voting = {
  open: boolean;
  votesPerUser: number;
  startedBy: string;
  votes: Record<string, Record<string, number>>; // userId -> elementId -> count
  revealed: boolean;
};

type Client = { socket: WebSocket; user: User; clientId: string };

type Room = {
  boardId: string;
  elements: Map<string, Element>;
  appState: Record<string, unknown>;
  clients: Set<Client>;
  dirty: boolean;
  saveTimer: NodeJS.Timeout | null;
  timer: Timer | null;
  voting: Voting | null;
  loading: Promise<void>;
};

const SAVE_DEBOUNCE_MS = 1500;
const TOMBSTONE_TTL_MS = 24 * 3600_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room: Room, message: unknown, except?: Client): void {
  const data = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== except && client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
  }
}

function presence(room: Room) {
  const seen = new Map<string, { id: string; name: string; color: string; clientIds: string[] }>();
  for (const { user, clientId } of room.clients) {
    const entry = seen.get(user.id) ?? { id: user.id, name: user.name, color: user.color, clientIds: [] };
    entry.clientIds.push(clientId);
    seen.set(user.id, entry);
  }
  return [...seen.values()];
}

function shouldAccept(current: Element | undefined, incoming: Element): boolean {
  if (!current) return true;
  if (incoming.version > current.version) return true;
  return incoming.version === current.version && incoming.versionNonce < current.versionNonce;
}

async function loadRoom(boardId: string): Promise<Room | undefined> {
  const existing = rooms.get(boardId);
  if (existing) {
    await existing.loading;
    return existing;
  }
  const room: Room = {
    boardId,
    elements: new Map(),
    appState: {},
    clients: new Set(),
    dirty: false,
    saveTimer: null,
    timer: null,
    voting: null,
    loading: Promise.resolve(),
  };
  let found = true;
  room.loading = (async () => {
    const row = await one<{ scene: { elements?: Element[]; appState?: Record<string, unknown> } }>(
      "select scene from boards where id = $1 and deleted_at is null",
      [boardId],
    );
    if (!row) {
      found = false;
      return;
    }
    for (const element of row.scene.elements ?? []) room.elements.set(element.id, element);
    room.appState = row.scene.appState ?? {};
  })();
  rooms.set(boardId, room);
  await room.loading;
  if (!found) {
    rooms.delete(boardId);
    return undefined;
  }
  return room;
}

async function saveRoom(room: Room): Promise<void> {
  if (!room.dirty) return;
  room.dirty = false;
  const now = Date.now();
  // Keep recent tombstones so late clients reconcile deletions; drop old ones.
  const elements = [...room.elements.values()].filter(
    (e) => !e.isDeleted || now - (e.updated ?? now) < TOMBSTONE_TTL_MS,
  );
  await query("update boards set scene = $1, updated_at = now() where id = $2", [
    { elements, appState: room.appState },
    room.boardId,
  ]);
}

function scheduleSave(room: Room): void {
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoom(room).catch((error) => console.error("[realtime] save failed", room.boardId, error));
  }, SAVE_DEBOUNCE_MS);
}

function votingSummary(voting: Voting | null, forUserId: string) {
  if (!voting) return null;
  const totals: Record<string, number> = {};
  for (const perUser of Object.values(voting.votes)) {
    for (const [elementId, count] of Object.entries(perUser)) totals[elementId] = (totals[elementId] ?? 0) + count;
  }
  const mine = voting.votes[forUserId] ?? {};
  return {
    open: voting.open,
    revealed: voting.revealed,
    votesPerUser: voting.votesPerUser,
    startedBy: voting.startedBy,
    mine,
    used: Object.values(mine).reduce((a, b) => a + b, 0),
    voters: Object.keys(voting.votes).length,
    totals: voting.revealed || !voting.open ? totals : null,
  };
}

function sendVoting(room: Room): void {
  for (const client of room.clients) send(client.socket, { type: "voting", voting: votingSummary(room.voting, client.user.id) });
}

function handleMessage(room: Room, client: Client, raw: string): void {
  let message: { type?: string } & Record<string, unknown>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  switch (message.type) {
    case "update": {
      const incoming = Array.isArray(message.elements) ? (message.elements as Element[]) : [];
      const accepted: Element[] = [];
      for (const element of incoming) {
        if (!element || typeof element.id !== "string" || typeof element.version !== "number") continue;
        if (shouldAccept(room.elements.get(element.id), element)) {
          room.elements.set(element.id, element);
          accepted.push(element);
        }
      }
      if (accepted.length) {
        broadcast(room, { type: "update", elements: accepted }, client);
        scheduleSave(room);
      }
      return;
    }
    case "appState": {
      const viewBackgroundColor = message.viewBackgroundColor;
      if (typeof viewBackgroundColor === "string") {
        room.appState = { ...room.appState, viewBackgroundColor };
        broadcast(room, { type: "appState", appState: room.appState }, client);
        scheduleSave(room);
      }
      return;
    }
    case "pointer":
      broadcast(
        room,
        {
          type: "pointer",
          clientId: client.clientId,
          user: { id: client.user.id, name: client.user.name, color: client.user.color },
          pointer: message.pointer,
          button: message.button,
          selectedElementIds: message.selectedElementIds,
          viewport: message.viewport,
        },
        client,
      );
      return;
    case "summon":
      // "Bring everyone to me": others jump to the sender's viewport.
      broadcast(room, { type: "summon", from: client.user.name, viewport: message.viewport }, client);
      return;
    case "reaction":
      broadcast(room, { type: "reaction", emoji: String(message.emoji ?? "").slice(0, 8), user: client.user.name });
      return;
    case "timer": {
      const action = message.action;
      const now = Date.now();
      if (action === "start") {
        const durationMs = Math.min(Math.max(Number(message.durationMs) || 0, 5_000), 3 * 3600_000);
        room.timer = { endsAt: now + durationMs, durationMs, pausedRemainingMs: null, startedBy: client.user.name };
      } else if (action === "pause" && room.timer?.endsAt) {
        room.timer = { ...room.timer, pausedRemainingMs: Math.max(room.timer.endsAt - now, 0), endsAt: null };
      } else if (action === "resume" && room.timer?.pausedRemainingMs != null) {
        room.timer = { ...room.timer, endsAt: now + room.timer.pausedRemainingMs, pausedRemainingMs: null };
      } else if (action === "add" && room.timer) {
        const extra = Number(message.ms) || 60_000;
        room.timer = room.timer.endsAt
          ? { ...room.timer, endsAt: room.timer.endsAt + extra, durationMs: room.timer.durationMs + extra }
          : { ...room.timer, pausedRemainingMs: (room.timer.pausedRemainingMs ?? 0) + extra };
      } else if (action === "stop") {
        room.timer = null;
      }
      broadcast(room, { type: "timer", timer: room.timer, serverNow: now });
      return;
    }
    case "voting": {
      const action = message.action;
      if (action === "start") {
        room.voting = {
          open: true,
          revealed: false,
          votesPerUser: Math.min(Math.max(Number(message.votesPerUser) || 3, 1), 20),
          startedBy: client.user.name,
          votes: {},
        };
      } else if (action === "vote" && room.voting?.open) {
        const elementId = String(message.elementId ?? "");
        const delta = message.delta === -1 ? -1 : 1;
        const mine = (room.voting.votes[client.user.id] ??= {});
        const used = Object.values(mine).reduce((a, b) => a + b, 0);
        const current = mine[elementId] ?? 0;
        if (delta === 1 && used < room.voting.votesPerUser && room.elements.has(elementId)) mine[elementId] = current + 1;
        if (delta === -1 && current > 0) mine[elementId] = current - 1;
      } else if (action === "reveal" && room.voting) {
        room.voting.revealed = true;
      } else if (action === "close" && room.voting) {
        room.voting.open = false;
        room.voting.revealed = true;
      } else if (action === "clear") {
        room.voting = null;
      }
      sendVoting(room);
      return;
    }
    case "comments-changed":
      broadcast(room, { type: "comments-changed" }, client);
      return;
    case "title":
      broadcast(room, { type: "title", title: String(message.title ?? "").slice(0, 120) }, client);
      return;
    default:
  }
}

export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const boardId = url.searchParams.get("board") ?? "";
  const clientId = (url.searchParams.get("client") ?? "").slice(0, 64) || Math.random().toString(36).slice(2);
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];

  (async () => {
    const user = await userFromToken(token);
    if (!user || !/^[0-9a-f-]{36}$/i.test(boardId)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const room = await loadRoom(boardId);
    if (!room) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client: Client = { socket: ws, user, clientId };
      room.clients.add(client);
      send(ws, {
        type: "init",
        elements: [...room.elements.values()],
        appState: room.appState,
        me: { ...user, clientId },
        timer: room.timer,
        serverNow: Date.now(),
        voting: votingSummary(room.voting, user.id),
      });
      broadcast(room, { type: "presence", users: presence(room) });

      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);

      ws.on("message", (data) => handleMessage(room, client, data.toString()));
      ws.on("close", () => {
        clearInterval(heartbeat);
        room.clients.delete(client);
        broadcast(room, { type: "presence", users: presence(room) });
        broadcast(room, { type: "pointer-leave", clientId });
        if (room.clients.size === 0) {
          saveRoom(room)
            .catch((error) => console.error("[realtime] save on close failed", error))
            .finally(() => {
              if (room.clients.size === 0 && !room.dirty) rooms.delete(boardId);
            });
        }
      });
    });
  })().catch((error) => {
    console.error("[realtime] upgrade failed", error);
    socket.destroy();
  });
}

/** Disconnects everyone from a board (used when it is deleted). */
export function closeRoom(boardId: string): void {
  const room = rooms.get(boardId);
  if (!room) return;
  for (const client of room.clients) client.socket.close(4004, "board_deleted");
  rooms.delete(boardId);
}

/** Flushes every room to the database (graceful shutdown). */
export async function flushAll(): Promise<void> {
  await Promise.all([...rooms.values()].map((room) => saveRoom(room)));
}
