import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, timeAgo } from "../api";
import { useSession, Wordmark } from "../session";

type Member = { id: string; email: string; name: string; role: "admin" | "member"; color: string; disabled: boolean; created_at: string };
type PendingInvite = { email: string; role: string; created_at: string; expires_at: string };

export function Team() {
  const { me } = useSession();
  const [users, setUsers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isAdmin = me?.role === "admin";

  const load = useCallback(async () => {
    const data = await api<{ users: Member[]; invites: PendingInvite[] }>("/api/team");
    setUsers(data.users);
    setInvites(data.invites);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    const { url } = await api<{ url: string }>("/api/team/invites", { body: { email, role } });
    setLink(url);
    setCopied(false);
    setEmail("");
    await load();
  }

  async function update(id: string, body: { role?: string; disabled?: boolean }) {
    await api(`/api/team/users/${id}`, { method: "PATCH", body });
    await load();
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-4">
          <Link to="/">
            <Wordmark className="text-lg" />
          </Link>
          <Link to="/" className="ml-auto text-sm text-muted hover:text-ink">
            ← Tableros
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <div>
          <p className="label-mono text-muted">Equipo</p>
          <h1 className="mt-1 text-2xl font-semibold">Quién tiene acceso</h1>
          <p className="mt-1 text-sm text-muted">Todo el equipo ve y edita todos los tableros. Solo los administradores invitan.</p>
        </div>

        {isAdmin && (
          <form onSubmit={invite} className="rounded-xl border border-line bg-card p-5">
            <p className="mb-3 font-medium">Invitar a alguien</p>
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nombre@tuempresa.com"
                className="min-w-60 flex-1 rounded-lg border border-line bg-cream px-3 py-2 text-sm outline-none focus:border-violet"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "member" | "admin")}
                className="rounded-lg border border-line bg-cream px-3 py-2 text-sm"
              >
                <option value="member">Miembro</option>
                <option value="admin">Administrador</option>
              </select>
              <button className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-cream hover:bg-black">Crear enlace</button>
            </div>
            {link && (
              <div className="mt-4 rounded-lg bg-cream p-3 text-sm">
                <p className="mb-2 text-muted">Envía este enlace a la persona. Sirve una sola vez y caduca en 7 días:</p>
                <div className="flex gap-2">
                  <input readOnly value={link} className="flex-1 rounded border border-line bg-card px-2 py-1 font-mono text-xs" />
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
                    className="rounded border border-line px-3 text-xs hover:bg-line/60"
                  >
                    {copied ? "Copiado" : "Copiar"}
                  </button>
                </div>
              </div>
            )}
          </form>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-card">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
              <span className="grid size-8 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: u.color }}>
                {u.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`truncate ${u.disabled ? "text-muted line-through" : ""}`}>
                  {u.name} {u.id === me?.id && <span className="text-xs text-muted">(tú)</span>}
                </p>
                <p className="truncate text-xs text-muted">{u.email}</p>
              </div>
              <span className="label-mono text-muted">{u.role === "admin" ? "Admin" : "Miembro"}</span>
              {isAdmin && u.id !== me?.id && (
                <div className="flex gap-1 text-xs">
                  <button onClick={() => void update(u.id, { role: u.role === "admin" ? "member" : "admin" })} className="rounded px-2 py-1 text-muted hover:bg-cream hover:text-ink">
                    {u.role === "admin" ? "Quitar admin" : "Hacer admin"}
                  </button>
                  <button onClick={() => void update(u.id, { disabled: !u.disabled })} className="rounded px-2 py-1 text-alert hover:bg-alert-bg">
                    {u.disabled ? "Reactivar" : "Desactivar"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {invites.length > 0 && (
          <div>
            <p className="label-mono mb-2 text-muted">Invitaciones pendientes</p>
            <div className="overflow-hidden rounded-xl border border-line bg-card text-sm">
              {invites.map((i) => (
                <div key={i.email + i.created_at} className="flex justify-between border-b border-line px-5 py-2.5 last:border-b-0">
                  <span>{i.email}</span>
                  <span className="text-muted">enviada {timeAgo(i.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
