import { handle, HttpError, requireMember } from "@/server/auth";
import { supabaseAdmin } from "@/adapters/supabase/client";
import { TenantConfigSchema } from "@/core/types";

export const runtime = "nodejs";

/** Configuração da empresa (RF-01 a RF-09) com erros de validação do onboarding. */
export const GET = handle(async (_req, ctx) => {
  const { tenantId } = await ctx.params;
  await requireMember(tenantId);
  const { data } = await supabaseAdmin().from("tenant_configs").select("config, approved, approved_at").eq("tenant_id", tenantId).maybeSingle();
  const parsed = data ? TenantConfigSchema.safeParse({ ...data.config, tenantId }) : null;
  return Response.json({
    config: data?.config ?? null,
    approved: data?.approved ?? false,
    approvedAt: data?.approved_at ?? null,
    errors: parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : [],
  });
});

/** Salvar invalida a aprovação: o cliente aprova de novo antes de o agente operar. */
export const PUT = handle(async (req, ctx) => {
  const { tenantId } = await ctx.params;
  await requireMember(tenantId, ["dono", "admin"]);
  const config = await req.json();
  const parsed = TenantConfigSchema.safeParse({ ...config, tenantId, approved: false });
  await supabaseAdmin()
    .from("tenant_configs")
    .upsert({ tenant_id: tenantId, config, approved: false, approved_by: null, approved_at: null, updated_at: new Date().toISOString() });
  return Response.json({ saved: true, errors: parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
});

/** Aprovação do onboarding pelo cliente. */
export const POST = handle(async (_req, ctx) => {
  const { tenantId } = await ctx.params;
  const { userId } = await requireMember(tenantId, ["dono", "admin"]);
  const db = supabaseAdmin();
  const { data } = await db.from("tenant_configs").select("config").eq("tenant_id", tenantId).single();
  const parsed = TenantConfigSchema.safeParse({ ...data?.config, tenantId });
  if (!parsed.success) throw new HttpError(422, "onboarding incompleto: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const { data: num } = await db.from("whatsapp_numbers").select("tenant_id").eq("tenant_id", tenantId).maybeSingle();
  if (!num) throw new HttpError(422, "conecte o número do WhatsApp antes de aprovar");
  await db.from("tenant_configs").update({ approved: true, approved_by: userId, approved_at: new Date().toISOString() }).eq("tenant_id", tenantId);
  return Response.json({ approved: true });
});
