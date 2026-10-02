"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LeadActions({ tenantId, leadId, hasMeeting, withHuman }: { tenantId: string; leadId: string; hasMeeting: boolean; withHuman: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/tenants/${tenantId}/leads/${leadId}`;

  async function call(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) setError((await res.json()).error ?? "erro");
    else router.refresh();
  }

  return (
    <div className="row">
      <button disabled={busy} onClick={() => call("/verdict", { accepted: true })}>Aceitar oportunidade</button>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          const reason = prompt("Motivo da devolução (vira aprendizado para o agente):");
          if (reason) call("/verdict", { accepted: false, reason });
        }}
      >
        Devolver
      </button>
      {hasMeeting && (
        <>
          <button className="secondary" disabled={busy} onClick={() => call("/meeting", { status: "realizada" })}>Reunião realizada</button>
          <button className="secondary" disabled={busy} onClick={() => call("/meeting", { status: "no_show" })}>Faltou</button>
        </>
      )}
      {withHuman && (
        <button className="secondary" disabled={busy} onClick={() => call("/release", {})}>Devolver ao agente</button>
      )}
      <a className="btn secondary" href={base} download={`lead-${leadId}.json`} style={{ background: "transparent", color: "var(--fg)", border: "1px solid var(--line)" }}>
        Exportar dados
      </a>
      {error && <span className="errors">{error}</span>}
    </div>
  );
}
