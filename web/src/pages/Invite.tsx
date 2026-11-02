import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { FullScreenMessage, useSession } from "../session";
import { AuthShell, Field, PrimaryButton } from "./Login";

export function Invite() {
  const { token = "" } = useParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ email: string }>(`/api/invites/${token}`)
      .then((r) => setEmail(r.email))
      .catch(() => setInvalid(true));
  }, [token]);

  if (invalid) return <FullScreenMessage>Esta invitación no es válida o ya se usó. Pide una nueva.</FullScreenMessage>;
  if (!email) return <FullScreenMessage>Comprobando invitación…</FullScreenMessage>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/invites/${token}/accept`, { body: { name, password } });
      await refresh();
      navigate("/", { replace: true });
    } catch {
      setError("No se pudo activar la cuenta. Revisa la contraseña (mínimo 10 caracteres).");
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Activa tu cuenta" subtitle={`Te han invitado con ${email}. Elige tu nombre y tu contraseña.`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tu nombre" value={name} onChange={setName} autoComplete="name" />
        <Field
          label="Contraseña"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={10}
          autoComplete="new-password"
          hint="Mínimo 10 caracteres."
        />
        {error && <p className="rounded-lg bg-alert-bg px-3 py-2 text-sm text-alert">{error}</p>}
        <PrimaryButton disabled={busy}>{busy ? "Activando…" : "Activar y entrar"}</PrimaryButton>
      </form>
    </AuthShell>
  );
}
