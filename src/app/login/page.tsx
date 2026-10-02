"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/components/supabase-browser";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/auth/callback` } });
    if (error) setError(error.message);
    else setSent(true);
  }
  return (
    <main style={{ maxWidth: 380 }}>
      <h1>Entrar</h1>
      {sent ? (
        <p>Enviamos um link de acesso para {email}.</p>
      ) : (
        <form onSubmit={submit} className="card" style={{ display: "grid", gap: 10, marginTop: 16 }}>
          <label>
            E-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit">Receber link</button>
          {error && <p className="errors">{error}</p>}
        </form>
      )}
    </main>
  );
}
