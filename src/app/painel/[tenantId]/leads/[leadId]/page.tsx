import Link from "next/link";
import { supabaseUser } from "@/server/auth";
import { buildHandoffSummary } from "@/core/agent/handoff";
import { TenantConfigSchema, type Lead } from "@/core/types";
import { LeadActions } from "@/components/lead-actions";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ tenantId: string; leadId: string }> }) {
  const { tenantId, leadId } = await params;
  const db = await supabaseUser();
  const [{ data: row }, { data: messages }, { data: cfg }, { data: events }] = await Promise.all([
    db.from("leads").select("data").eq("id", leadId).eq("tenant_id", tenantId).single(),
    db.from("messages").select("id, role, text, at, template_name").eq("lead_id", leadId).order("at"),
    db.from("tenant_configs").select("config").eq("tenant_id", tenantId).single(),
    db.from("events").select("type, payload, at").eq("lead_id", leadId).order("at", { ascending: false }).limit(30),
  ]);
  if (!row) return <main>Lead não encontrado.</main>;
  const lead = { ...(row.data as Lead), id: leadId };
  const config = TenantConfigSchema.safeParse({ ...cfg?.config, tenantId });
  const summary = config.success ? buildHandoffSummary(lead, config.data, new Date()) : "Configuração inválida.";
  return (
    <main>
      <header className="top">
        <div>
          <Link href={`/painel/${tenantId}`}>← voltar</Link>
          <h1>{lead.name ?? lead.phone}</h1>
          <span className="muted">
            {lead.stage} · etapa {lead.flowState} · {lead.score} pontos{lead.handoffReason ? ` · com pessoa: ${lead.handoffReason}` : ""}
          </span>
        </div>
        <LeadActions tenantId={tenantId} leadId={leadId} hasMeeting={!!lead.meeting} withHuman={lead.flowState === "humano"} />
      </header>
      <div className="two">
        <section className="card chat">
          {(messages ?? []).map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
              <small>
                {new Date(m.at).toLocaleString("pt-BR")}
                {m.template_name ? ` · modelo ${m.template_name}` : ""}
              </small>
            </div>
          ))}
        </section>
        <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Resumo para o vendedor</h2>
            <pre className="summary">{summary}</pre>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Histórico no CRM</h2>
            {(events ?? []).map((e, i) => (
              <div key={i} className="muted" style={{ fontSize: 13 }}>
                {new Date(e.at).toLocaleString("pt-BR")} · {e.type}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
