import { z } from "zod";
import { handle, HttpError, requireMember } from "@/server/auth";
import { supabaseAdmin } from "@/adapters/supabase/client";
import { numberCredentials, submitTemplate } from "@/adapters/whatsapp/cloud-api";
import { reviewReply } from "@/core/agent/guardrails";
import { prodDeps } from "@/adapters/container";

export const runtime = "nodejs";

const Body = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  language: z.string().default("pt_BR"),
  purpose: z.enum(["follow_up", "nutricao", "reengajamento", "lembrete", "primeiro_contato", "gatilho"]),
  category: z.enum(["MARKETING", "UTILITY"]).default("MARKETING"),
  body: z.string().min(10).max(1024),
  variables: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
});

/** Gerenciador de modelos (RF-33): cadastra e envia para aprovação da Meta. */
export const POST = handle(async (req, ctx) => {
  const { tenantId } = await ctx.params;
  await requireMember(tenantId, ["dono", "admin"]);
  const t = Body.parse(await req.json());
  const config = await prodDeps().repo.getConfig(tenantId);
  if (config) {
    const sample = t.body.replace(/\{\{\d+\}\}/g, "x");
    const v = reviewReply([sample.slice(0, 250)], { config, mustIdentify: false, factCorpus: sample, askedIfBot: false }).filter(
      (x) => !x.startsWith("balão"),
    );
    if (v.length) throw new HttpError(422, `modelo fere as regras de escrita: ${v.join("; ")}`);
  }
  const db = supabaseAdmin();
  const creds = await numberCredentials(db, tenantId);
  const r = await submitTemplate(creds.token, creds.wabaId, t);
  if (!r.ok) throw new HttpError(502, `Meta recusou: ${JSON.stringify(r.body)}`);
  const { error } = await db.from("whatsapp_templates").upsert(
    { tenant_id: tenantId, name: t.name, language: t.language, purpose: t.purpose, category: t.category, body: t.body, variables: t.variables, status: "pendente" },
    { onConflict: "tenant_id,name,language" },
  );
  if (error) throw new HttpError(500, error.message);
  return Response.json({ submitted: true });
});
