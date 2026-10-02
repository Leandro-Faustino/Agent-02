import { prodDeps } from "@/adapters/container";
import { handleInbound } from "@/core/agent/engine";
import { runDue } from "@/core/agent/proactive";
import { numberCredentials, fetchNumberHealth, fetchTemplateStatuses } from "@/adapters/whatsapp/cloud-api";
import { mediaToText } from "@/adapters/media/processor";
import { supabaseAdmin } from "@/adapters/supabase/client";
import type { ChatMessage } from "@/core/types";

/** RF-36 — processa leads cujas mensagens picadas já "assentaram". */
export async function processInbound(limit = 20) {
  const deps = prodDeps();
  const leadIds = await deps.repo.claimDebounced(limit);
  const results = await Promise.allSettled(leadIds.map((id) => processLead(id)));
  return results.map((r, i) => ({ leadId: leadIds[i], ok: r.status === "fulfilled", error: r.status === "rejected" ? String(r.reason) : undefined }));
}

async function processLead(leadId: string) {
  const deps = prodDeps();
  const { repo } = deps;
  try {
    const pending = await repo.pendingInbound(leadId);
    if (!pending.length) return;
    const lead = await repo.getLead(leadId);
    if (!lead) return;
    const msgs: ChatMessage[] = [];
    for (const m of pending) {
      let media: ChatMessage["media"];
      if (m.media?.mediaId && !m.media.transcript) {
        const kind = m.kind as "audio" | "image" | "document";
        try {
          const creds = await numberCredentials(supabaseAdmin(), lead.tenantId);
          const transcript = await mediaToText(deps.llm, creds.token, { kind, mediaId: m.media.mediaId, caption: m.text || undefined });
          media = { kind, transcript: transcript ?? undefined };
        } catch (e) {
          await repo.logEvent(lead.tenantId, leadId, "falha_midia", { error: String(e) });
          media = { kind };
        }
        // Sem transcrição possível o agente não adivinha: registra para a pessoa ver.
        await repo.updateInbound(m.id, { media: { ...m.media, ...media }, text: media.transcript ?? (m.text || `[${kind} não lido]`) });
      }
      msgs.push({ id: m.id, leadId, role: "lead", text: media?.transcript ?? m.text, at: m.at, media });
    }
    await handleInbound(deps, leadId, msgs);
    for (const m of pending) await repo.updateInbound(m.id, { processed: true });
  } finally {
    await repo.releaseLead(leadId);
  }
}

/** RF-19, RF-22 a RF-25. */
export async function processCadence(limit = 50) {
  return runDue(prodDeps(), limit);
}

/** RF-38 — qualidade e limite; pausa envios ativos quando cai. RF-33 — status dos modelos. */
export async function refreshNumberHealth() {
  const db = supabaseAdmin();
  const { data: numbers, error } = await db.from("whatsapp_numbers").select("tenant_id, phone_number_id, waba_id, blocks_last_7d");
  if (error) throw new Error(error.message);
  const out = [];
  for (const n of numbers ?? []) {
    try {
      const creds = await numberCredentials(db, n.tenant_id);
      const h = await fetchNumberHealth(creds.token, n.phone_number_id);
      const { count: optOuts } = await db
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", n.tenant_id)
        .eq("type", "opt_out")
        .gte("at", new Date(Date.now() - 7 * 86400000).toISOString());
      const { count: convs } = await db
        .from("turn_logs")
        .select("lead_id", { count: "exact", head: true })
        .eq("tenant_id", n.tenant_id)
        .gte("at", new Date(Date.now() - 7 * 86400000).toISOString());
      const optOutRate = convs ? (100 * (optOuts ?? 0)) / convs : 0;
      // Pausa com qualidade vermelha/amarela ou opt-outs acima de 5 por 100 turnos.
      const paused = h.quality === "RED" || h.quality === "YELLOW" || optOutRate > 5;
      await db
        .from("whatsapp_numbers")
        .update({ quality: h.quality, messaging_limit: h.messagingLimit, paused, checked_at: new Date().toISOString() })
        .eq("tenant_id", n.tenant_id);
      if (paused) await prodDeps().notifier.notifyTenant(n.tenant_id, "qualidade_numero", { quality: h.quality, optOutRate });

      const statuses = await fetchTemplateStatuses(creds.token, n.waba_id);
      for (const s of statuses) {
        const status = s.status === "APPROVED" ? "aprovado" : s.status === "REJECTED" ? "rejeitado" : "pendente";
        await db.from("whatsapp_templates").update({ status, category: s.category }).eq("tenant_id", n.tenant_id).eq("name", s.name).eq("language", s.language);
      }
      out.push({ tenantId: n.tenant_id, ...h, paused });
    } catch (e) {
      out.push({ tenantId: n.tenant_id, error: String(e) });
    }
  }
  return out;
}
