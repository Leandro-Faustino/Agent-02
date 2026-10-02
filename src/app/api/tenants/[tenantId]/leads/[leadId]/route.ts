import { handle, requireMember } from "@/server/auth";
import { supabaseAdmin } from "@/adapters/supabase/client";
import { loadLead } from "@/server/tenant";

export const runtime = "nodejs";

/** RNF-12 — exportação dos dados do lead. */
export const GET = handle(async (_req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId);
  const lead = await loadLead(tenantId, leadId);
  const db = supabaseAdmin();
  const [{ data: messages }, { data: events }] = await Promise.all([
    db.from("messages").select("role, text, at, template_name").eq("lead_id", leadId).order("at"),
    db.from("events").select("type, payload, at").eq("lead_id", leadId).order("at"),
  ]);
  return Response.json({ lead, messages, events });
});

/** RNF-12 — exclusão sob pedido do titular. */
export const DELETE = handle(async (_req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId, ["dono", "admin"]);
  await loadLead(tenantId, leadId);
  const db = supabaseAdmin();
  await db.from("events").insert({ tenant_id: tenantId, lead_id: null, type: "exclusao_titular", payload: { leadId } });
  await db.from("leads").delete().eq("id", leadId).eq("tenant_id", tenantId);
  return Response.json({ deleted: true });
});
