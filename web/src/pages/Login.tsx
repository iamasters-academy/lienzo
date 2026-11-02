import { type FormEvent, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useSession, Wordmark } from "../session";

export function Login() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next") || "/";

  if (me) return <Navigate to={next} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { email, password } });
      await refresh();
    } catch (err) {
      setError(
        (err as { status?: number }).status === 429
          ? "Demasiados intentos. Espera unos minutos y vuelve a probar."
          : "Email o contraseña incorrectos.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Entra en tu lienzo" subtitle="La pizarra colaborativa de tu equipo.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field label="Contraseña" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p className="rounded-lg bg-alert-bg px-3 py-2 text-sm text-alert">{error}</p>}
        <PrimaryButton disabled={busy}>{busy ? "Entrando…" : "Entrar"}</PrimaryButton>
        <p className="text-center text-xs text-muted">¿No tienes cuenta? Pide una invitación a un administrador.</p>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 text-2xl" />
        <div className="rounded-2xl border border-line bg-card p-7 shadow-[0_1px_0_#efe6d8]">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 mb-6 text-sm text-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="label-mono text-muted">{props.label}</span>
      <input
        required
        type={props.type ?? "text"}
        value={props.value}
        minLength={props.minLength}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1.5 w-full rounded-lg border border-line bg-cream px-3 py-2.5 text-[15px] outline-none focus:border-violet focus:ring-2 focus:ring-violet/15"
      />
      {props.hint && <span className="mt-1 block text-xs text-muted">{props.hint}</span>}
    </label>
  );
}

export function PrimaryButton({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="w-full rounded-lg bg-ink px-4 py-2.5 text-[15px] font-medium text-cream transition hover:bg-black disabled:opacity-60"
    >
      {children}
    </button>
  );
}
