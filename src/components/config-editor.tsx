"use client";
import { useEffect, useState } from "react";

export function ConfigEditor({ tenantId }: { tenantId: string }) {
  const url = `/api/tenants/${tenantId}/config`;
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await (await fetch(url)).json();
    setText(JSON.stringify(r.config ?? {}, null, 2));
    setErrors(r.errors ?? []);
    setApproved(r.approved);
  }
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      setErrors(["JSON inválido"]);
      return;
    }
    const r = await (await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    setErrors(r.errors ?? []);
    setApproved(false);
    setMsg(r.errors?.length ? "Salvo, mas incompleto." : "Salvo. Revise e aprove para o agente operar.");
  }

  async function approve() {
    const res = await fetch(url, { method: "POST" });
    const r = await res.json();
    if (res.ok) {
      setApproved(true);
      setMsg("Aprovado. O agente está em operação.");
    } else setMsg(r.error);
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="row">
        <span className="pill">{approved ? "Aprovado" : "Aguardando aprovação"}</span>
        <button onClick={save}>Salvar</button>
        <button className="secondary" onClick={approve} disabled={errors.length > 0 || approved}>Aprovar onboarding</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  );
}
