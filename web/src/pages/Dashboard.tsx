import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type BoardSummary, timeAgo } from "../api";
import { useSession, Wordmark } from "../session";
import { TEMPLATE_LIST } from "../templateList";

type Tab = "recent" | "starred" | "mine" | "trash";

export function Dashboard() {
  const { me, logout } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("recent");
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ boards: BoardSummary[] }>(tab === "trash" ? "/api/boards?trash=1" : "/api/boards");
    setBoards(data.boards);
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (boards ?? [])
      .filter((b) => (tab === "starred" ? b.starred : tab === "mine" ? b.owner_id === me?.id : true))
      .filter((b) => !q || b.title.toLowerCase().includes(q));
  }, [boards, tab, search, me]);

  async function createBoard(template?: string) {
    const meta = TEMPLATE_LIST.find((t) => t.id === template);
    const { id } = await api<{ id: string }>("/api/boards", { body: { title: meta?.name } });
    navigate(template ? `/b/${id}?template=${template}` : `/b/${id}`);
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Wordmark className="text-lg" />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link to="/team" className="rounded-lg px-3 py-1.5 text-muted hover:bg-line/60 hover:text-ink">
              Equipo
            </Link>
            <span className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: me?.color }}>
                {me?.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden sm:inline">{me?.name}</span>
            </span>
            <button onClick={() => void logout()} className="rounded-lg px-3 py-1.5 text-muted hover:bg-line/60 hover:text-ink">
              Salir
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <section className="mb-10">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="label-mono text-muted">Empieza algo nuevo</p>
              <h1 className="mt-1 text-2xl font-semibold">Hola, {me?.name.split(" ")[0]}</h1>
            </div>
            <button onClick={() => setShowTemplates((v) => !v)} className="text-sm text-violet hover:underline">
              {showTemplates ? "Ver menos" : "Ver todas las plantillas"}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <button
              onClick={() => void createBoard()}
              className="group flex h-36 flex-col justify-between rounded-xl border border-line bg-card p-4 text-left transition hover:border-violet"
            >
              <span className="ai-gradient grid size-9 place-items-center rounded-lg text-xl text-white">+</span>
              <span>
                <span className="block font-medium">Tablero en blanco</span>
                <span className="text-xs text-muted">Lienzo infinito vacío</span>
              </span>
            </button>
            {(showTemplates ? TEMPLATE_LIST : TEMPLATE_LIST.slice(0, 4)).map((t) => (
              <button
                key={t.id}
                onClick={() => void createBoard(t.id)}
                className="flex h-36 flex-col justify-between rounded-xl border border-line bg-card p-4 text-left transition hover:border-violet"
              >
                <span className="text-2xl">{t.emoji}</span>
                <span>
                  <span className="block font-medium">{t.name}</span>
                  <span className="line-clamp-2 text-xs text-muted">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {(
              [
                ["recent", "Recientes"],
                ["starred", "Destacados"],
                ["mine", "Míos"],
                ["trash", "Papelera"],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`rounded-full px-3.5 py-1.5 text-sm ${tab === key ? "bg-ink text-cream" : "text-muted hover:bg-line/60 hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar tableros…"
              className="ml-auto w-56 rounded-lg border border-line bg-card px-3 py-1.5 text-sm outline-none focus:border-violet"
            />
          </div>

          {boards === null ? (
            <p className="text-muted">Cargando tableros…</p>
          ) : visible.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-10 text-center text-muted">
              {tab === "trash" ? "La papelera está vacía." : "Aún no hay tableros aquí. Crea uno arriba."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((board) => (
                <BoardCard key={board.id} board={board} trash={tab === "trash"} onChanged={load} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function BoardCard({ board, trash, onChanged }: { board: BoardSummary; trash: boolean; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);

  async function act(action: "star" | "rename" | "duplicate" | "delete" | "restore") {
    setMenu(false);
    if (action === "star") await api(`/api/boards/${board.id}`, { method: "PATCH", body: { starred: !board.starred } });
    if (action === "rename") {
      const title = prompt("Nuevo nombre del tablero", board.title)?.trim();
      if (!title) return;
      await api(`/api/boards/${board.id}`, { method: "PATCH", body: { title } });
    }
    if (action === "duplicate") await api(`/api/boards/${board.id}/duplicate`, { body: {} });
    if (action === "delete" && confirm(`¿Mover «${board.title}» a la papelera?`)) {
      await api(`/api/boards/${board.id}`, { method: "DELETE" });
    }
    if (action === "restore") await api(`/api/boards/${board.id}/restore`, { body: {} });
    await onChanged();
  }

  return (
    <div className="group relative overflow-hidden rounded-xl border border-line bg-card transition hover:border-violet">
      <button disabled={trash} onClick={() => navigate(`/b/${board.id}`)} className="block w-full text-left">
        <div className="grid h-40 place-items-center overflow-hidden border-b border-line bg-cream">
          {board.thumbnail ? (
            <img src={board.thumbnail} alt="" className="max-h-full max-w-full object-contain p-3" />
          ) : (
            <span className="label-mono text-muted/70">Sin vista previa</span>
          )}
        </div>
        <div className="px-4 py-3">
          <p className="truncate font-medium">{board.title}</p>
          <p className="text-xs text-muted">
            {board.owner_name ?? "—"} · editado {timeAgo(board.updated_at)}
          </p>
        </div>
      </button>
      <div className="absolute top-2 right-2 flex gap-1">
        {!trash && (
          <button
            onClick={() => void act("star")}
            title={board.starred ? "Quitar de destacados" : "Destacar"}
            className={`grid size-8 place-items-center rounded-lg bg-card/90 shadow-sm ${board.starred ? "text-amber-500" : "text-muted opacity-0 group-hover:opacity-100"}`}
          >
            ★
          </button>
        )}
        <button
          onClick={() => setMenu((v) => !v)}
          title="Opciones"
          className="grid size-8 place-items-center rounded-lg bg-card/90 text-muted opacity-0 shadow-sm group-hover:opacity-100"
        >
          ⋯
        </button>
      </div>
      {menu && (
        <div className="absolute top-11 right-2 z-10 w-44 overflow-hidden rounded-lg border border-line bg-card text-sm shadow-lg">
          {trash ? (
            <MenuItem onClick={() => void act("restore")}>Restaurar</MenuItem>
          ) : (
            <>
              <MenuItem onClick={() => void act("rename")}>Renombrar</MenuItem>
              <MenuItem onClick={() => void act("duplicate")}>Duplicar</MenuItem>
              <MenuItem onClick={() => void act("delete")} danger>
                Mover a la papelera
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`block w-full px-3 py-2 text-left hover:bg-cream ${danger ? "text-alert" : ""}`}>
      {children}
    </button>
  );
}
