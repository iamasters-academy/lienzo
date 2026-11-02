import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  FONT_FAMILY,
  MainMenu,
  reconcileElements,
  sceneCoordsToViewportCoords,
  TTDDialog,
  TTDDialogTrigger,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, type Comment, timeAgo } from "../api";
import { useSession } from "../session";
import { BoardSocket, type ConnectionState, type ServerMessage } from "./socket";
import { ensureCanvasFont, STICKY_COLORS, STICKY_SIZE, type Skeleton, stickySkeleton } from "./stickies";
import { buildTemplate } from "./templates";

type PresenceUser = { id: string; name: string; color: string; clientIds: string[] };
type Timer = { endsAt: number | null; durationMs: number; pausedRemainingMs: number | null; startedBy: string };
type Voting = {
  open: boolean;
  revealed: boolean;
  votesPerUser: number;
  startedBy: string;
  mine: Record<string, number>;
  used: number;
  voters: number;
  totals: Record<string, number> | null;
};
type Viewport = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };
type Reaction = { id: number; emoji: string; user: string; left: number };

const REACTIONS = ["👍", "❤️", "🎉", "😂", "🤔", "🔥"];
const THUMBNAIL_EVERY_MS = 45_000;

function toSkeletonElements(skeleton: Skeleton[]): ExcalidrawElement[] {
  return convertToExcalidrawElements(skeleton, { regenerateIds: false }) as ExcalidrawElement[];
}

export default function BoardPage() {
  const { id: boardId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useSession();

  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [title, setTitle] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [timer, setTimer] = useState<(Timer & { offset: number }) | null>(null);
  const [voting, setVoting] = useState<Voting | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [panel, setPanel] = useState<"comments" | "timer" | "voting" | "reactions" | "bulk" | null>(null);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1, offsetLeft: 0, offsetTop: 0, tick: 0 });
  const [aiEnabled, setAiEnabled] = useState(false);

  const socketRef = useRef<BoardSocket | null>(null);
  const synced = useRef(new Map<string, number>()); // element id -> last version sent or received
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  const initialized = useRef(false);
  const broadcastQueued = useRef(false);
  const uploadedFiles = useRef(new Set<string>());
  const lastBackground = useRef<string | null>(null);
  const lastPointerSent = useRef(0);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const viewRaf = useRef<number | null>(null);
  const sceneDirtySinceThumb = useRef(false);
  const stickyCursor = useRef(0);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? null : t)), 3500);
  }, []);

  // ---- Load board metadata and AI availability ------------------------------------------------
  useEffect(() => {
    api<{ board: { title: string } }>(`/api/boards/${boardId}`)
      .then((r) => setTitle(r.board.title))
      .catch(() => navigate("/", { replace: true }));
    api<{ enabled: boolean }>("/api/ai/status")
      .then((r) => setAiEnabled(r.enabled))
      .catch(() => setAiEnabled(false));
  }, [boardId, navigate]);

  const loadComments = useCallback(async () => {
    setComments((await api<{ comments: Comment[] }>(`/api/boards/${boardId}/comments`)).comments);
  }, [boardId]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const loadFiles = useCallback(
    async (target: ExcalidrawImperativeAPI) => {
      const { files } = await api<{ files: BinaryFileData[] }>(`/api/boards/${boardId}/files`);
      for (const f of files) uploadedFiles.current.add(f.id);
      if (files.length) target.addFiles(files);
    },
    [boardId],
  );

  // ---- Broadcasting local changes ----------------------------------------------------------------
  const flushBroadcast = useCallback(() => {
    broadcastQueued.current = false;
    if (!excalidraw || !socketRef.current) return;
    const changed = excalidraw
      .getSceneElementsIncludingDeleted()
      .filter((el) => synced.current.get(el.id) !== el.version);
    if (!changed.length) return;
    for (const el of changed) synced.current.set(el.id, el.version);
    socketRef.current.send({ type: "update", elements: changed });
    sceneDirtySinceThumb.current = true;
  }, [excalidraw]);

  const queueBroadcast = useCallback(() => {
    if (broadcastQueued.current) return;
    broadcastQueued.current = true;
    setTimeout(flushBroadcast, 60);
  }, [flushBroadcast]);

  const uploadNewFiles = useCallback(
    (files: BinaryFiles) => {
      for (const file of Object.values(files)) {
        if (uploadedFiles.current.has(file.id)) continue;
        uploadedFiles.current.add(file.id);
        api(`/api/boards/${boardId}/files`, { body: { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL } }).catch(() => {
          uploadedFiles.current.delete(file.id);
          showToast("No se pudo subir una imagen (máximo 10 MB).");
        });
      }
    },
    [boardId, showToast],
  );

  // ---- Applying remote messages -------------------------------------------------------------------
  const applyRemoteElements = useCallback(
    (target: ExcalidrawImperativeAPI, remote: ExcalidrawElement[]) => {
      const reconciled = reconcileElements(
        target.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[],
        remote as unknown as Parameters<typeof reconcileElements>[1],
        target.getAppState(),
      );
      target.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
      const byId = new Map(reconciled.map((el) => [el.id, el.version]));
      for (const el of remote) if (byId.get(el.id) === el.version) synced.current.set(el.id, el.version);
      const known = target.getFiles();
      if (remote.some((el) => el.type === "image" && "fileId" in el && el.fileId && !known[el.fileId as string])) {
        void loadFiles(target);
      }
    },
    [loadFiles],
  );

  const viewportOf = useCallback((state: AppState): Viewport => {
    return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, width: state.width, height: state.height };
  }, []);

  const handleMessage = useCallback(
    (message: ServerMessage, target: ExcalidrawImperativeAPI) => {
      switch (message.type) {
        case "init": {
          const elements = (message.elements as ExcalidrawElement[]) ?? [];
          synced.current = new Map(elements.map((el) => [el.id, el.version]));
          const appState = (message.appState as { viewBackgroundColor?: string }) ?? {};
          if (appState.viewBackgroundColor) lastBackground.current = appState.viewBackgroundColor;
          if (!initialized.current) {
            target.updateScene({
              elements,
              appState: appState.viewBackgroundColor ? { viewBackgroundColor: appState.viewBackgroundColor } : undefined,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            target.history.clear();
            initialized.current = true;
            void loadFiles(target);
            const template = params.get("template");
            if (template && !elements.some((el) => !el.isDeleted)) {
              const skeleton = buildTemplate(template);
              if (skeleton) {
                void ensureCanvasFont().then(() => {
                  target.updateScene({
                    elements: [...target.getSceneElementsIncludingDeleted(), ...toSkeletonElements(skeleton)],
                    captureUpdate: CaptureUpdateAction.NEVER,
                  });
                  setTimeout(() => target.scrollToContent(undefined, { fitToContent: true, animate: false }), 50);
                });
              }
              setParams({}, { replace: true });
            } else if (elements.length) {
              setTimeout(() => target.scrollToContent(undefined, { fitToContent: true, animate: false }), 50);
            }
          } else {
            // Reconnected: merge whatever changed while we were away, then resend our pending edits.
            applyRemoteElements(target, elements);
            synced.current = new Map(elements.map((el) => [el.id, el.version]));
          }
          queueBroadcast();
          const t = message.timer as Timer | null;
          setTimer(t ? { ...t, offset: Number(message.serverNow) - Date.now() } : null);
          setVoting((message.voting as Voting) ?? null);
          return;
        }
        case "update":
          applyRemoteElements(target, (message.elements as ExcalidrawElement[]) ?? []);
          setView((v) => ({ ...v, tick: v.tick + 1 }));
          return;
        case "appState": {
          const color = (message.appState as { viewBackgroundColor?: string })?.viewBackgroundColor;
          if (color) {
            lastBackground.current = color;
            target.updateScene({ appState: { viewBackgroundColor: color }, captureUpdate: CaptureUpdateAction.NEVER });
          }
          return;
        }
        case "pointer": {
          const user = message.user as { id: string; name: string; color: string };
          collaborators.current.set(message.clientId as SocketId, {
            id: user.id,
            username: user.name,
            color: { background: user.color, stroke: user.color },
            pointer: message.pointer as Collaborator["pointer"],
            button: message.button as Collaborator["button"],
            selectedElementIds: message.selectedElementIds as Collaborator["selectedElementIds"],
          });
          target.updateScene({ collaborators: new Map(collaborators.current) });
          return;
        }
        case "pointer-leave":
          collaborators.current.delete(message.clientId as SocketId);
          target.updateScene({ collaborators: new Map(collaborators.current) });
          return;
        case "presence":
          setPresence(message.users as PresenceUser[]);
          return;
        case "summon": {
          const remote = message.viewport as Viewport;
          const mine = target.getAppState();
          const centerX = -remote.scrollX + remote.width / (2 * remote.zoom);
          const centerY = -remote.scrollY + remote.height / (2 * remote.zoom);
          target.updateScene({
            appState: {
              zoom: { value: remote.zoom as AppState["zoom"]["value"] },
              scrollX: -(centerX - mine.width / (2 * remote.zoom)),
              scrollY: -(centerY - mine.height / (2 * remote.zoom)),
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          showToast(`${String(message.from)} os ha traído a su vista`);
          return;
        }
        case "reaction": {
          const id = Date.now() + Math.random();
          setReactions((r) => [...r, { id, emoji: String(message.emoji), user: String(message.user), left: 15 + Math.random() * 70 }]);
          setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 2500);
          return;
        }
        case "timer": {
          const t = message.timer as Timer | null;
          setTimer(t ? { ...t, offset: Number(message.serverNow) - Date.now() } : null);
          return;
        }
        case "voting":
          setVoting((message.voting as Voting) ?? null);
          return;
        case "comments-changed":
          void loadComments();
          return;
        case "title":
          setTitle(String(message.title));
          return;
        default:
      }
    },
    [applyRemoteElements, loadComments, loadFiles, params, queueBroadcast, setParams, showToast],
  );

  const handleMessageRef = useRef(handleMessage);
  handleMessageRef.current = handleMessage;

  // ---- Socket lifecycle ---------------------------------------------------------------------------
  useEffect(() => {
    if (!excalidraw) return;
    const socket = new BoardSocket(
      boardId,
      (message) => handleMessageRef.current(message, excalidraw),
      setConnection,
      () => {
        showToast("Este tablero se ha movido a la papelera.");
        navigate("/", { replace: true });
      },
    );
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
      initialized.current = false;
    };
  }, [boardId, excalidraw, navigate, showToast]);

  // ---- Thumbnails for the dashboard ----------------------------------------------------------------
  const saveThumbnail = useCallback(async () => {
    if (!excalidraw || !sceneDirtySinceThumb.current) return;
    const elements = excalidraw.getSceneElements();
    if (!elements.length) return;
    sceneDirtySinceThumb.current = false;
    try {
      const blob = await exportToBlob({
        elements,
        appState: { ...excalidraw.getAppState(), exportBackground: true },
        files: excalidraw.getFiles(),
        maxWidthOrHeight: 520,
        mimeType: "image/jpeg",
        quality: 0.82,
      });
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      if (dataUrl.length < 380_000) await api(`/api/boards/${boardId}`, { method: "PATCH", body: { thumbnail: dataUrl } });
    } catch {
      sceneDirtySinceThumb.current = true;
    }
  }, [boardId, excalidraw]);

  useEffect(() => {
    const interval = setInterval(() => void saveThumbnail(), THUMBNAIL_EVERY_MS);
    const onHide = () => void saveThumbnail();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onHide);
      void saveThumbnail();
    };
  }, [saveThumbnail]);

  // ---- Excalidraw callbacks ------------------------------------------------------------------------
  const onChange = useCallback(
    (_elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (!initialized.current) return;
      queueBroadcast();
      uploadNewFiles(files);
      if (lastBackground.current !== null && appState.viewBackgroundColor !== lastBackground.current) {
        lastBackground.current = appState.viewBackgroundColor;
        socketRef.current?.send({ type: "appState", viewBackgroundColor: appState.viewBackgroundColor });
      } else if (lastBackground.current === null) {
        lastBackground.current = appState.viewBackgroundColor;
      }
      if (viewRaf.current === null) {
        viewRaf.current = requestAnimationFrame(() => {
          viewRaf.current = null;
          setView((v) => ({
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom.value,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
            tick: v.tick + 1,
          }));
        });
      }
    },
    [queueBroadcast, uploadNewFiles],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "down" | "up" }) => {
      lastPointer.current = { x: payload.pointer.x, y: payload.pointer.y };
      const now = performance.now();
      if (now - lastPointerSent.current < 40 || !excalidraw) return;
      lastPointerSent.current = now;
      socketRef.current?.send(
        {
          type: "pointer",
          pointer: payload.pointer,
          button: payload.button,
          selectedElementIds: excalidraw.getAppState().selectedElementIds,
        },
        true,
      );
    },
    [excalidraw],
  );

  // ---- Sticky notes --------------------------------------------------------------------------------
  /** Top-left corner near the viewport centre where a w×h block does not cover existing objects. */
  const findFreeSpot = useCallback(
    (w: number, h: number) => {
      const state = excalidraw!.getAppState();
      const center = viewportCoordsToSceneCoords(
        { clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 },
        state,
      );
      const boxes = excalidraw!
        .getSceneElements()
        .filter((el) => el.type !== "frame" && el.type !== "text")
        .map((el) => ({ x: el.x, y: el.y, w: el.width, h: el.height }));
      const free = (x: number, y: number) =>
        boxes.every((b) => x + w <= b.x || x >= b.x + b.w || y + h <= b.y || y >= b.y + b.h);
      const step = STICKY_SIZE + 20;
      // Spiral outwards from the centre in sticky-sized steps.
      for (let ring = 0; ring < 8; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const x = center.x - w / 2 + dx * step;
            const y = center.y - h / 2 + dy * step;
            if (free(x, y)) return { x, y };
          }
        }
      }
      return { x: center.x - w / 2 + (stickyCursor.current++ % 6) * 24, y: center.y - h / 2 };
    },
    [excalidraw],
  );

  const addStickies = useCallback(
    async (items: { text?: string; color?: string; x?: number; y?: number }[]) => {
      if (!excalidraw) return;
      await ensureCanvasFont();
      const perRow = Math.max(1, Math.ceil(Math.sqrt(items.length)));
      const rows = Math.ceil(items.length / perRow);
      const origin = findFreeSpot(perRow * (STICKY_SIZE + 20) - 20, rows * (STICKY_SIZE + 20) - 20);
      const skeleton = items.map((item, i) =>
        stickySkeleton({
          text: item.text,
          color: item.color,
          x: item.x ?? origin.x + (i % perRow) * (STICKY_SIZE + 20),
          y: item.y ?? origin.y + Math.floor(i / perRow) * (STICKY_SIZE + 20),
        }),
      );
      const created = toSkeletonElements(skeleton);
      const containers = created.filter((el) => el.type === "rectangle");
      excalidraw.updateScene({
        elements: [...excalidraw.getSceneElementsIncludingDeleted(), ...created],
        appState: { selectedElementIds: Object.fromEntries(containers.map((el) => [el.id, true])) },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [excalidraw, findFreeSpot],
  );

  // "N" adds a sticky note under the cursor, like most whiteboards.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "n") return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (excalidraw?.getAppState().editingTextElement) return;
      event.preventDefault();
      const at = lastPointer.current;
      void addStickies([
        at ? { color: STICKY_COLORS[0].value, x: at.x - STICKY_SIZE / 2, y: at.y - STICKY_SIZE / 2 } : { color: STICKY_COLORS[0].value },
      ]);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [addStickies, excalidraw]);

  function onDropSticky(event: React.DragEvent) {
    const color = event.dataTransfer.getData("application/x-lienzo-sticky");
    if (!color || !excalidraw) return;
    event.preventDefault();
    event.stopPropagation();
    const point = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, excalidraw.getAppState());
    void addStickies([{ color, x: point.x - STICKY_SIZE / 2, y: point.y - STICKY_SIZE / 2 }]);
  }

  // ---- Facilitation actions ------------------------------------------------------------------------
  const send = useCallback((message: Record<string, unknown>) => socketRef.current?.send(message), []);

  function summon() {
    if (!excalidraw) return;
    send({ type: "summon", viewport: viewportOf(excalidraw.getAppState()) });
    showToast("Has traído a todo el mundo a tu vista");
  }

  function react(emoji: string) {
    send({ type: "reaction", emoji });
  }

  async function renameBoard(next: string) {
    const clean = next.trim();
    if (!clean || clean === title) return;
    setTitle(clean);
    await api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: clean } });
    send({ type: "title", title: clean });
  }

  async function addComment(body: string) {
    if (!excalidraw) return;
    const state = excalidraw.getAppState();
    const selected = excalidraw.getSceneElements().filter((el) => state.selectedElementIds[el.id]);
    let x: number;
    let y: number;
    if (selected.length) {
      x = Math.max(...selected.map((el) => el.x + el.width));
      y = Math.min(...selected.map((el) => el.y));
    } else {
      const c = viewportCoordsToSceneCoords({ clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 }, state);
      x = c.x;
      y = c.y;
    }
    await api(`/api/boards/${boardId}/comments`, { body: { body, x, y } });
    send({ type: "comments-changed" });
    await loadComments();
  }

  async function resolveComment(comment: Comment) {
    await api(`/api/comments/${comment.id}`, { method: "PATCH", body: { resolved: !comment.resolved } });
    send({ type: "comments-changed" });
    await loadComments();
  }

  function focusComment(comment: Comment) {
    if (!excalidraw || comment.x == null || comment.y == null) return;
    const state = excalidraw.getAppState();
    excalidraw.updateScene({
      appState: {
        scrollX: -(comment.x - state.width / (2 * state.zoom.value)),
        scrollY: -(comment.y - state.height / (2 * state.zoom.value)),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  function voteSelected(delta: 1 | -1) {
    if (!excalidraw) return;
    const state = excalidraw.getAppState();
    const ids = Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]);
    const targets = excalidraw
      .getSceneElements()
      .filter((el) => ids.includes(el.id) && el.type !== "text")
      .map((el) => el.id);
    if (!targets.length) {
      showToast("Selecciona una nota o forma para votar");
      return;
    }
    for (const elementId of targets) send({ type: "voting", action: "vote", elementId, delta });
  }

  // ---- AI: text → Mermaid → diagram (Excalidraw's own text-to-diagram dialog) ------------------------
  const onTextSubmit = useCallback(async (input: string) => {
    try {
      const response = await fetch("/api/ai/mermaid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: input }),
      });
      const data = (await response.json()) as { mermaid?: string; error?: string };
      if (!response.ok || !data.mermaid) {
        return { error: new Error(data.error === "ai_disabled" ? "La IA aún no está activada en Lienzo." : "No se pudo generar el diagrama.") };
      }
      return { generatedResponse: data.mermaid };
    } catch {
      return { error: new Error("No se pudo conectar con la IA.") };
    }
  }, []);

  // ---- Overlays positioned on the canvas ------------------------------------------------------------
  const appStateForCoords = useMemo(
    () =>
      ({
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: { value: view.zoom },
        offsetLeft: view.offsetLeft,
        offsetTop: view.offsetTop,
      }) as unknown as AppState,
    [view],
  );

  const voteBadges = useMemo(() => {
    if (!excalidraw || !voting) return [];
    const counts = voting.totals ?? voting.mine;
    const elements = excalidraw.getSceneElements();
    return Object.entries(counts)
      .filter(([, n]) => n > 0)
      .flatMap(([id, n]) => {
        const el = elements.find((e) => e.id === id);
        if (!el) return [];
        // Bottom-right corner: the top-right one is where comment pins anchor.
        const p = sceneCoordsToViewportCoords({ sceneX: el.x + el.width, sceneY: el.y + el.height }, appStateForCoords);
        return [{ id, n, x: p.x, y: p.y }];
      });
    // view.tick re-evaluates positions when elements move or the canvas scrolls
  }, [excalidraw, voting, appStateForCoords, view.tick]);

  const ranking = useMemo(() => {
    if (!excalidraw || !voting?.totals) return [];
    const elements = excalidraw.getSceneElementsIncludingDeleted();
    const labelOf = (id: string) => {
      const text = elements.find((e) => e.type === "text" && "containerId" in e && e.containerId === id);
      const own = elements.find((e) => e.id === id);
      const raw = (text && "text" in text ? text.text : own && "text" in own ? own.text : "") as string;
      return raw.trim().slice(0, 60) || "(sin texto)";
    };
    return Object.entries(voting.totals)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => ({ id, n, label: labelOf(id) }));
  }, [excalidraw, voting]);

  const openComments = comments.filter((c) => !c.parent_id);

  return (
    <div className="fixed inset-0" onDragOver={(e) => e.dataTransfer.types.includes("application/x-lienzo-sticky") && e.preventDefault()} onDrop={onDropSticky}>
      <Excalidraw
        excalidrawAPI={setExcalidraw}
        isCollaborating
        langCode="es-ES"
        name={title}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        initialData={{
          appState: {
            currentItemRoughness: 0,
            currentItemFontFamily: FONT_FAMILY.Nunito,
            currentItemStrokeColor: "#1A0F0C",
            viewBackgroundColor: "#FFFFFF",
          },
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } }}
        renderTopRightUI={() => (
          <TopRight
            presence={presence}
            meId={me?.id}
            connection={connection}
            commentsOpen={panel === "comments"}
            openComments={openComments.filter((c) => !c.resolved).length}
            onPanel={(p) => setPanel((cur) => (cur === p ? null : p))}
            onSummon={summon}
          />
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => navigate("/")}>← Volver a mis tableros</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <TTDDialog onTextSubmit={onTextSubmit} />
        <TTDDialogTrigger>{aiEnabled ? "Diagrama con IA" : "Texto a diagrama"}</TTDDialogTrigger>
      </Excalidraw>

      {/* Board title, top-left after the main menu button */}
      <div className="pointer-events-none fixed top-4 left-16 z-[5] flex items-center gap-2">
        <Link to="/" className="pointer-events-auto rounded-lg border border-line bg-card/95 px-2 py-1.5 text-sm text-muted shadow-sm hover:text-ink" title="Mis tableros">
          ⌂
        </Link>
        <input
          key={title}
          defaultValue={title}
          onBlur={(e) => void renameBoard(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="pointer-events-auto hidden w-48 truncate rounded-lg border border-line bg-card/95 px-3 py-1.5 text-sm font-medium shadow-sm outline-none focus:border-violet min-[1180px]:block"
          aria-label="Nombre del tablero"
        />
      </div>

      {/* Sticky palette, bottom centre */}
      <div className="fixed bottom-4 left-1/2 z-[5] flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-line bg-card/95 px-3 py-2 shadow-md">
        <span className="label-mono mr-1 hidden text-muted sm:inline">Notas</span>
        {STICKY_COLORS.map((c) => (
          <button
            key={c.value}
            title={`Nota ${c.name.toLowerCase()} (arrastra o pulsa · tecla N)`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-lienzo-sticky", c.value);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => void addStickies([{ color: c.value }])}
            className="size-7 rounded-md shadow-sm ring-1 ring-black/5 transition hover:-translate-y-0.5"
            style={{ background: c.value }}
          />
        ))}
        <span className="mx-1 h-6 w-px bg-line" />
        <button onClick={() => setPanel((p) => (p === "bulk" ? null : "bulk"))} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-cream hover:text-ink" title="Pega una lista y crea una nota por línea">
          En bloque
        </button>
      </div>

      {timer && <TimerBadge timer={timer} onOpen={() => setPanel("timer")} />}

      {/* Vote badges */}
      {voteBadges.map((b) => (
        <span
          key={b.id}
          className="pointer-events-none fixed z-[4] grid min-w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-violet px-1.5 py-0.5 text-xs font-semibold text-white shadow"
          style={{ left: b.x, top: b.y }}
        >
          {b.n}
        </span>
      ))}

      {/* Comment pins */}
      {openComments
        .filter((c) => !c.resolved && c.x != null && c.y != null)
        .map((c) => {
          const p = sceneCoordsToViewportCoords({ sceneX: c.x!, sceneY: c.y! }, appStateForCoords);
          return (
            <button
              key={c.id}
              onClick={() => setPanel("comments")}
              title={`${c.author_name}: ${c.body}`}
              className="fixed z-[4] grid size-7 -translate-y-full place-items-center rounded-full rounded-bl-none border-2 border-white text-xs font-semibold text-white shadow"
              style={{ left: p.x, top: p.y, background: c.author_color ?? "#6D28D9" }}
            >
              {(c.author_name ?? "?").slice(0, 1).toUpperCase()}
            </button>
          );
        })}

      {/* Floating reactions */}
      {reactions.map((r) => (
        <div key={r.id} className="reaction-float pointer-events-none fixed bottom-24 z-[6] text-center" style={{ left: `${r.left}%` }}>
          <div className="text-4xl">{r.emoji}</div>
          <div className="rounded bg-ink/70 px-1.5 text-[11px] text-white">{r.user}</div>
        </div>
      ))}

      {panel && panel !== "comments" && (
        <Popover onClose={() => setPanel(null)}>
          {panel === "timer" && <TimerPanel timer={timer} send={send} />}
          {panel === "voting" && <VotingPanel voting={voting} send={send} onVote={voteSelected} ranking={ranking} />}
          {panel === "reactions" && (
            <div>
              <p className="mb-2 font-medium">Reacciones</p>
              <div className="flex gap-1">
                {REACTIONS.map((e) => (
                  <button key={e} onClick={() => react(e)} className="rounded-lg p-1.5 text-2xl hover:bg-cream">
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {panel === "bulk" && (
            <BulkPanel
              onCreate={(lines, color) => {
                void addStickies(lines.map((text) => ({ text, color })));
                setPanel(null);
              }}
            />
          )}
        </Popover>
      )}

      {panel === "comments" && (
        <CommentsPanel
          comments={openComments}
          onClose={() => setPanel(null)}
          onAdd={addComment}
          onResolve={resolveComment}
          onFocus={focusComment}
        />
      )}

      {toast && (
        <div className="fixed top-20 left-1/2 z-[7] -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-cream shadow-lg">{toast}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------

function TopRight(props: {
  presence: PresenceUser[];
  meId?: string;
  connection: ConnectionState;
  commentsOpen: boolean;
  openComments: number;
  onPanel: (panel: "comments" | "timer" | "voting" | "reactions") => void;
  onSummon: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <div className="mr-1 flex -space-x-2">
        {props.presence.slice(0, 6).map((u) => (
          <span
            key={u.id}
            title={u.id === props.meId ? `${u.name} (tú)` : u.name}
            className="grid size-8 place-items-center rounded-full border-2 border-white text-xs font-semibold text-white"
            style={{ background: u.color }}
          >
            {u.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {props.presence.length > 6 && (
          <span className="grid size-8 place-items-center rounded-full border-2 border-white bg-muted text-xs text-white">+{props.presence.length - 6}</span>
        )}
      </div>
      {props.connection !== "online" && (
        <span className="rounded-md bg-alert-bg px-2 py-1 text-xs text-alert">{props.connection === "connecting" ? "Conectando…" : "Sin conexión"}</span>
      )}
      <ToolButton label="Temporizador" onClick={() => props.onPanel("timer")}>⏱</ToolButton>
      <ToolButton label="Votación" onClick={() => props.onPanel("voting")}>🗳</ToolButton>
      <ToolButton label="Reacciones" onClick={() => props.onPanel("reactions")}>☺</ToolButton>
      <ToolButton label="Traer a todos a mi vista" onClick={props.onSummon}>⇲</ToolButton>
      <ToolButton label="Comentarios" active={props.commentsOpen} onClick={() => props.onPanel("comments")}>
        💬{props.openComments > 0 && <span className="ml-0.5 text-[10px]">{props.openComments}</span>}
      </ToolButton>
      <button
        onClick={() => void navigator.clipboard.writeText(location.href).then(() => setCopied(true))}
        onMouseLeave={() => setCopied(false)}
        className="rounded-lg bg-violet px-3 py-2 text-sm font-medium text-white hover:bg-[#5b21b6]"
      >
        {copied ? "Enlace copiado" : "Compartir"}
      </button>
    </div>
  );
}

function ToolButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-9 min-w-9 items-center justify-center rounded-lg border px-2 text-base shadow-sm ${active ? "border-violet bg-[#ede9fe]" : "border-line bg-card hover:bg-cream"}`}
    >
      {children}
    </button>
  );
}

function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed top-16 right-4 z-[6] w-80 rounded-xl border border-line bg-card p-4 text-sm shadow-xl">
      <button onClick={onClose} className="absolute top-2 right-3 text-muted hover:text-ink" aria-label="Cerrar">
        ×
      </button>
      {children}
    </div>
  );
}

function formatMs(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function remainingOf(timer: Timer & { offset: number }, now: number) {
  if (timer.pausedRemainingMs != null) return timer.pausedRemainingMs;
  return (timer.endsAt ?? 0) - (now + timer.offset);
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch {
    // audio not available
  }
}

function TimerBadge({ timer, onOpen }: { timer: Timer & { offset: number }; onOpen: () => void }) {
  const now = useNow(true);
  const remaining = remainingOf(timer, now);
  const done = remaining <= 0;
  const rang = useRef(false);
  useEffect(() => {
    if (done && !rang.current && timer.endsAt) {
      rang.current = true;
      beep();
    }
    if (!done) rang.current = false;
  }, [done, timer.endsAt]);
  return (
    <button
      onClick={onOpen}
      className={`fixed top-16 left-1/2 z-[5] -translate-x-1/2 rounded-full px-4 py-1.5 font-mono text-lg font-semibold shadow-md ${done ? "bg-alert text-white" : "bg-ink text-cream"}`}
    >
      {done ? "¡Tiempo!" : formatMs(remaining)}
      {timer.pausedRemainingMs != null && <span className="ml-2 text-xs font-normal opacity-70">en pausa</span>}
    </button>
  );
}

function TimerPanel({ timer, send }: { timer: (Timer & { offset: number }) | null; send: (m: Record<string, unknown>) => void }) {
  const [minutes, setMinutes] = useState(5);
  const presets = [1, 3, 5, 10, 15, 25];
  return (
    <div>
      <p className="mb-1 font-medium">Temporizador compartido</p>
      <p className="mb-3 text-xs text-muted">Todo el mundo en el tablero ve la misma cuenta atrás.</p>
      {!timer ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {presets.map((m) => (
              <button key={m} onClick={() => setMinutes(m)} className={`rounded-md border px-2.5 py-1 ${minutes === m ? "border-violet bg-[#ede9fe]" : "border-line"}`}>
                {m} min
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="number" min={1} max={180} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-20 rounded-md border border-line px-2 py-1" />
            <button onClick={() => send({ type: "timer", action: "start", durationMs: minutes * 60_000 })} className="flex-1 rounded-md bg-ink py-1.5 font-medium text-cream">
              Empezar
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {timer.pausedRemainingMs != null ? (
            <PanelButton onClick={() => send({ type: "timer", action: "resume" })}>Reanudar</PanelButton>
          ) : (
            <PanelButton onClick={() => send({ type: "timer", action: "pause" })}>Pausar</PanelButton>
          )}
          <PanelButton onClick={() => send({ type: "timer", action: "add", ms: 60_000 })}>+1 min</PanelButton>
          <PanelButton danger onClick={() => send({ type: "timer", action: "stop" })}>
            Parar
          </PanelButton>
          <p className="w-full text-xs text-muted">Iniciado por {timer.startedBy}</p>
        </div>
      )}
    </div>
  );
}

function VotingPanel({
  voting,
  send,
  onVote,
  ranking,
}: {
  voting: Voting | null;
  send: (m: Record<string, unknown>) => void;
  onVote: (delta: 1 | -1) => void;
  ranking: { id: string; n: number; label: string }[];
}) {
  const [votes, setVotes] = useState(3);
  if (!voting) {
    return (
      <div>
        <p className="mb-1 font-medium">Votación</p>
        <p className="mb-3 text-xs text-muted">Cada persona reparte sus votos entre notas y formas. Los resultados se ocultan hasta que los reveles.</p>
        <label className="mb-3 flex items-center justify-between">
          <span>Votos por persona</span>
          <input type="number" min={1} max={20} value={votes} onChange={(e) => setVotes(Number(e.target.value))} className="w-16 rounded-md border border-line px-2 py-1" />
        </label>
        <button onClick={() => send({ type: "voting", action: "start", votesPerUser: votes })} className="w-full rounded-md bg-ink py-1.5 font-medium text-cream">
          Empezar votación
        </button>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 font-medium">{voting.open ? "Votación abierta" : "Votación cerrada"}</p>
      <p className="mb-3 text-xs text-muted">
        Iniciada por {voting.startedBy} · {voting.voters} {voting.voters === 1 ? "persona ha votado" : "personas han votado"}
      </p>
      {voting.open && (
        <>
          <p className="mb-2">
            Te quedan <strong>{voting.votesPerUser - voting.used}</strong> de {voting.votesPerUser} votos.
          </p>
          <div className="mb-3 flex gap-2">
            <PanelButton onClick={() => onVote(1)}>👍 Votar selección</PanelButton>
            <PanelButton onClick={() => onVote(-1)}>Quitar voto</PanelButton>
          </div>
        </>
      )}
      {ranking.length > 0 && (
        <ol className="mb-3 space-y-1">
          {ranking.map((r, i) => (
            <li key={r.id} className="flex justify-between gap-2 rounded bg-cream px-2 py-1">
              <span className="truncate">
                {i + 1}. {r.label}
              </span>
              <strong>{r.n}</strong>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        {voting.open && !voting.revealed && <PanelButton onClick={() => send({ type: "voting", action: "reveal" })}>Revelar resultados</PanelButton>}
        {voting.open && <PanelButton onClick={() => send({ type: "voting", action: "close" })}>Cerrar votación</PanelButton>}
        <PanelButton danger onClick={() => send({ type: "voting", action: "clear" })}>
          Borrar votación
        </PanelButton>
      </div>
    </div>
  );
}

function BulkPanel({ onCreate }: { onCreate: (lines: string[], color: string) => void }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState<string>(STICKY_COLORS[0].value);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 100);
  return (
    <div>
      <p className="mb-1 font-medium">Notas en bloque</p>
      <p className="mb-2 text-xs text-muted">Una nota por línea (máximo 100).</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} className="mb-2 w-full rounded-md border border-line p-2" placeholder={"Idea 1\nIdea 2\nIdea 3"} />
      <div className="mb-3 flex gap-1.5">
        {STICKY_COLORS.map((c) => (
          <button key={c.value} onClick={() => setColor(c.value)} className={`size-6 rounded ${color === c.value ? "ring-2 ring-violet" : ""}`} style={{ background: c.value }} title={c.name} />
        ))}
      </div>
      <button disabled={!lines.length} onClick={() => onCreate(lines, color)} className="w-full rounded-md bg-ink py-1.5 font-medium text-cream disabled:opacity-50">
        Crear {lines.length || ""} notas
      </button>
    </div>
  );
}

function CommentsPanel(props: {
  comments: Comment[];
  onClose: () => void;
  onAdd: (body: string) => Promise<void>;
  onResolve: (c: Comment) => Promise<void>;
  onFocus: (c: Comment) => void;
}) {
  const [body, setBody] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const list = props.comments.filter((c) => showResolved || !c.resolved).slice().reverse();
  return (
    <aside className="fixed top-0 right-0 bottom-0 z-[6] flex w-80 flex-col border-l border-line bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="font-medium">Comentarios</p>
        <button onClick={props.onClose} className="text-muted hover:text-ink" aria-label="Cerrar">
          ×
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim()) return;
          void props.onAdd(body.trim()).then(() => setBody(""));
        }}
        className="border-b border-line p-3"
      >
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Escribe un comentario…" className="w-full rounded-md border border-line p-2 text-sm" />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted">Se ancla a lo seleccionado o al centro de tu vista</span>
          <button className="rounded-md bg-ink px-3 py-1 text-sm text-cream">Comentar</button>
        </div>
      </form>
      <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Mostrar resueltos
      </label>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {list.length === 0 && <p className="px-1 text-sm text-muted">No hay comentarios.</p>}
        {list.map((c) => (
          <div key={c.id} className={`rounded-lg border border-line p-3 text-sm ${c.resolved ? "opacity-60" : ""}`}>
            <div className="mb-1 flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: c.author_color ?? "#8C8079" }} />
              <span className="font-medium">{c.author_name ?? "—"}</span>
              <span className="ml-auto text-[11px] text-muted">{timeAgo(c.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap">{c.body}</p>
            <div className="mt-2 flex gap-3 text-xs">
              <button onClick={() => props.onFocus(c)} className="text-violet hover:underline">
                Ver en el tablero
              </button>
              <button onClick={() => void props.onResolve(c)} className="text-muted hover:text-ink">
                {c.resolved ? "Reabrir" : "Resolver"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function PanelButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`rounded-md border px-2.5 py-1 ${danger ? "border-alert/30 text-alert hover:bg-alert-bg" : "border-line hover:bg-cream"}`}>
      {children}
    </button>
  );
}
