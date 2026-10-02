import Link from "next/link";
import { supabaseUser } from "@/server/auth";

export const dynamic = "force-dynamic";

const STAGE: Record<string, string> = {
  prospect: "Prospect",
  em_conversa: "Em conversa",
  qualificado: "Qualificado",
  reuniao_agendada: "Reunião agendada",
  reuniao_realizada: "Reunião realizada",
  oportunidade_aceita: "Oportunidade aceita",
  devolvida: "Devolvida",
  nutricao: "Nutrição",
  descartado: "Descartado",
};

const fmt = (v: unknown, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

export default async function TenantDashboard({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = await supabaseUser();
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const [{ data: tenant }, { data: metrics }, { data: objections }, { data: leads }, { data: number }, { count: reviews }, { data: alerts }] =
    await Promise.all([
      db.from("tenants").select("name").eq("id", tenantId).single(),
      db.from("tenant_metrics").select("*").eq("tenant_id", tenantId).gte("month", month).maybeSingle(),
      db.from("objection_stats").select("*").eq("tenant_id", tenantId).order("total", { ascending: false }),
      db.from("leads").select("id, phone, stage, flow_state, score, data, updated_at").eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(50),
      db.from("whatsapp_numbers").select("display_phone, quality, messaging_limit, paused").eq("tenant_id", tenantId).maybeSingle(),
      db.from("review_queue").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "aberto"),
      db.from("events").select("type").eq("tenant_id", tenantId).in("type", ["alerta_escalonamento", "alerta_trocar_canal"]).gte("at", month),
    ]);
  const stats = [
    ["Oportunidades aceitas no mês", fmt(metrics?.accepted)],
    ["Lead → oportunidade aceita", fmt(metrics?.lead_to_accepted_pct, "%")],
    ["Aceite pelo vendedor", fmt(metrics?.seller_accept_pct, "%")],
    ["Comparecimento às reuniões", fmt(metrics?.show_rate_pct, "%")],
    ["Resposta à primeira mensagem", fmt(metrics?.first_reply_pct, "%")],
    ["Opt-outs por 100 conversas", fmt(metrics?.opt_outs_per_100)],
    ["Custo de IA por oportunidade", metrics?.ai_cost_per_opportunity != null ? `US$ ${metrics.ai_cost_per_opportunity}` : "—"],
  ];
  return (
    <main>
      <header className="top">
        <div>
          <h1>{tenant?.name}</h1>
          <span className="muted">
            {number ? `WhatsApp ${number.display_phone} · qualidade ${number.quality} · limite ${number.messaging_limit}` : "Número do WhatsApp não conectado"}
            {number?.paused && <strong style={{ color: "var(--bad)" }}> · envios ativos pausados</strong>}
          </span>
        </div>
        <div className="row">
          <Link href={`/painel/${tenantId}/config`}>Configuração</Link>
          <span className="muted">· {reviews ?? 0} itens na fila de revisão · {alerts?.length ?? 0} alertas no mês</span>
        </div>
      </header>

      <div className="grid">
        {stats.map(([l, v]) => (
          <div key={l} className="card stat">
            <div className="v">{v}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>

      <h2>Objeções mais frequentes</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Objeção</th><th>Vezes</th><th>Revertidas</th><th>Taxa de reversão</th></tr>
          </thead>
          <tbody>
            {(objections ?? []).map((o) => (
              <tr key={o.objection}><td>{o.objection}</td><td>{o.total}</td><td>{o.reverted}</td><td>{o.reversal_pct}%</td></tr>
            ))}
            {!objections?.length && <tr><td colSpan={4} className="muted">Sem objeções registradas.</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Leads recentes</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Lead</th><th>Estágio</th><th>Etapa</th><th>Pontos</th><th>Atualizado</th></tr>
          </thead>
          <tbody>
            {(leads ?? []).map((l) => (
              <tr key={l.id}>
                <td><Link href={`/painel/${tenantId}/leads/${l.id}`}>{l.data?.name ?? l.phone}</Link></td>
                <td><span className="pill">{STAGE[l.stage] ?? l.stage}</span></td>
                <td>{l.flow_state === "humano" ? <strong>com pessoa</strong> : l.flow_state}</td>
                <td>{l.score}</td>
                <td className="muted">{new Date(l.updated_at).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
