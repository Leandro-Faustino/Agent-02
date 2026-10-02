import type { SupabaseClient } from "@supabase/supabase-js";
import type { NumberHealth, Repository, TurnLog, WhatsAppTemplate } from "@/core/ports";
import { TenantConfigSchema, type ChatMessage, type Lead, type TenantConfig } from "@/core/types";
import { priorityOf } from "@/core/agent/cadence";

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

interface LeadRow {
  id: string;
  data: Lead;
}

/** Repositório Supabase. Toda consulta filtra por tenant (RNF-02). */
export class SupabaseRepo implements Repository {
  private configCache = new Map<string, { at: number; config: TenantConfig | null }>();

  constructor(private db: SupabaseClient) {}

  async getConfig(tenantId: string): Promise<TenantConfig | null> {
    const hit = this.configCache.get(tenantId);
    if (hit && Date.now() - hit.at < 30_000) return hit.config;
    const row = check(await this.db.from("tenant_configs").select("config, approved").eq("tenant_id", tenantId).maybeSingle());
    let config: TenantConfig | null = null;
    if (row) {
      const parsed = TenantConfigSchema.safeParse({ ...row.config, tenantId, approved: row.approved });
      config = parsed.success ? parsed.data : null;
    }
    this.configCache.set(tenantId, { at: Date.now(), config });
    return config;
  }

  async getLead(leadId: string): Promise<Lead | null> {
    const row = check(await this.db.from("leads").select("id, data").eq("id", leadId).maybeSingle()) as LeadRow | null;
    return row ? { ...row.data, id: row.id } : null;
  }

  async saveLead(lead: Lead): Promise<void> {
    check(
      await this.db.from("leads").upsert({
        id: lead.id,
        tenant_id: lead.tenantId,
        phone: lead.phone,
        data: lead,
        stage: lead.stage,
        flow_state: lead.flowState,
        source: lead.source,
        priority: priorityOf(lead),
        score: lead.score,
        opted_out: lead.optedOut,
        legal_basis: lead.legalBasis,
        origin_note: lead.originNote ?? null,
        next_action_at: lead.nextActionAt ?? null,
        processing_until: null,
        updated_at: new Date().toISOString(),
      }),
    );
  }

  async getHistory(leadId: string, limit = 30): Promise<ChatMessage[]> {
    const rows = check(
      await this.db
        .from("messages")
        .select("id, lead_id, role, text, media, template_name, at")
        .eq("lead_id", leadId)
        .order("at", { ascending: false })
        .limit(limit),
    ) as { id: string; lead_id: string; role: ChatMessage["role"]; text: string; media: ChatMessage["media"]; template_name: string | null; at: string }[];
    return rows.reverse().map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      role: r.role,
      text: r.text,
      at: r.at,
      media: r.media ?? undefined,
      templateName: r.template_name ?? undefined,
    }));
  }

  async appendMessage(msg: ChatMessage): Promise<void> {
    const lead = check(await this.db.from("leads").select("tenant_id").eq("id", msg.leadId).single()) as { tenant_id: string };
    check(
      await this.db.from("messages").insert({
        tenant_id: lead.tenant_id,
        lead_id: msg.leadId,
        role: msg.role,
        text: msg.text,
        media: msg.media ?? null,
        template_name: msg.templateName ?? null,
        at: msg.at,
      }),
    );
  }

  async dueLeads(_now: Date, limit: number): Promise<Lead[]> {
    const rows = check(await this.db.rpc("claim_due_leads", { p_limit: limit })) as LeadRow[];
    return rows.map((r) => ({ ...r.data, id: r.id }));
  }

  async getTemplates(tenantId: string): Promise<WhatsAppTemplate[]> {
    const rows = check(await this.db.from("whatsapp_templates").select("*").eq("tenant_id", tenantId)) as (WhatsAppTemplate & { variables: string[] })[];
    return rows.map((r) => ({ name: r.name, language: r.language, purpose: r.purpose, status: r.status, body: r.body, variables: r.variables }));
  }

  async countSend(tenantId: string): Promise<void> {
    check(await this.db.rpc("increment_send_counter", { p_tenant: tenantId }));
  }

  async getNumberHealth(tenantId: string): Promise<NumberHealth> {
    const n = check(
      await this.db.from("whatsapp_numbers").select("quality, messaging_limit, paused, blocks_last_7d").eq("tenant_id", tenantId).maybeSingle(),
    ) as { quality: NumberHealth["quality"]; messaging_limit: string; paused: boolean; blocks_last_7d: number } | null;
    const today = new Date().toISOString().slice(0, 10);
    const c = check(await this.db.from("send_counters").select("sent").eq("tenant_id", tenantId).eq("day", today).maybeSingle()) as { sent: number } | null;
    return {
      quality: n?.quality ?? "UNKNOWN",
      messagingLimit: n?.messaging_limit ?? "UNKNOWN",
      paused: n?.paused ?? true,
      blocksLast7d: n?.blocks_last_7d ?? 0,
      sentToday: c?.sent ?? 0,
    };
  }

  async logTurn(e: TurnLog): Promise<void> {
    check(
      await this.db.from("turn_logs").insert({
        tenant_id: e.tenantId,
        lead_id: e.leadId,
        at: e.at,
        input: e.input,
        state_before: e.stateBefore,
        state_after: e.stateAfter,
        analysis: e.analysis,
        tools: e.tools,
        output: e.output,
        guardrail_violations: e.guardrailViolations,
        cost_usd: e.costUsd,
      }),
    );
  }

  async logEvent(tenantId: string, leadId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    check(await this.db.from("events").insert({ tenant_id: tenantId, lead_id: leadId, type, payload }));
  }

  async enqueueReview(tenantId: string, leadId: string, reason: string, payload: Record<string, unknown>): Promise<void> {
    check(await this.db.from("review_queue").insert({ tenant_id: tenantId, lead_id: leadId, reason, payload }));
  }

  /* ---- usados pelo webhook e workers ---- */

  async findOrCreateLead(tenantId: string, phone: string, name: string | undefined, create: () => Lead): Promise<Lead> {
    const row = check(await this.db.from("leads").select("id, data").eq("tenant_id", tenantId).eq("phone", phone).maybeSingle()) as LeadRow | null;
    if (row) return { ...row.data, id: row.id };
    const lead = create();
    if (name) lead.name = name;
    await this.saveLead(lead);
    return lead;
  }

  async insertInbound(tenantId: string, leadId: string, m: { externalId: string; text: string; kind: string; media: unknown; at: string }) {
    const res = await this.db.from("messages").insert({
      tenant_id: tenantId,
      lead_id: leadId,
      role: "lead",
      text: m.text,
      kind: m.kind,
      media: m.media,
      external_id: m.externalId,
      processed: false,
      at: m.at,
    });
    // Reentrega do webhook: mensagem já registrada.
    if (res.error && !/duplicate key/.test(res.error.message)) throw new Error(res.error.message);
  }

  async claimDebounced(limit: number): Promise<string[]> {
    return (check(await this.db.rpc("claim_debounced_leads", { p_limit: limit })) as string[]) ?? [];
  }

  async pendingInbound(leadId: string) {
    return check(
      await this.db
        .from("messages")
        .select("id, lead_id, text, kind, media, at")
        .eq("lead_id", leadId)
        .eq("role", "lead")
        .eq("processed", false)
        .order("at"),
    ) as { id: string; lead_id: string; text: string; kind: string; media: Record<string, string> | null; at: string }[];
  }

  async updateInbound(id: string, patch: { text?: string; media?: unknown; processed?: boolean }) {
    check(await this.db.from("messages").update(patch).eq("id", id));
  }

  async releaseLead(leadId: string) {
    check(await this.db.from("leads").update({ processing_until: null }).eq("id", leadId));
  }

  async tenantByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const row = check(await this.db.from("whatsapp_numbers").select("tenant_id").eq("phone_number_id", phoneNumberId).maybeSingle()) as { tenant_id: string } | null;
    return row?.tenant_id ?? null;
  }
}
