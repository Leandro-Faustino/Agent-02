import crypto from "node:crypto";
import { z } from "zod";
import { handle, HttpError, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";
import { newLead } from "@/core/lead";
import { startOutbound } from "@/core/agent/proactive";

export const runtime = "nodejs";

const ImportSchema = z.object({
  start: z.boolean().default(false),
  leads: z
    .array(
      z.object({
        phone: z.string().regex(/^\d{10,15}$/),
        name: z.string().optional(),
        source: z.enum(["reengajamento", "indicacao", "janela_compra", "frio_optin"]),
        // RF-39 / RNF-11 — origem e base legal obrigatórias
        originNote: z.string().min(3),
        legalBasis: z.enum(["consentimento", "legitimo_interesse"]),
        optIn: z.boolean().default(false),
      }),
    )
    .max(1000),
});

/** Importa contatos para reengajamento ou abordagem com opt-in. Nunca listas compradas. */
export const POST = handle(async (req, ctx) => {
  const { tenantId } = await ctx.params;
  await requireMember(tenantId, ["dono", "admin"]);
  const body = ImportSchema.safeParse(await req.json());
  if (!body.success) throw new HttpError(422, body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const deps = prodDeps();
  const out = [];
  for (const l of body.data.leads) {
    if (l.source === "frio_optin" && !l.optIn) {
      out.push({ phone: l.phone, skipped: "sem opt-in registrado" });
      continue;
    }
    const lead = await deps.repo.findOrCreateLead(tenantId, l.phone, l.name, () =>
      newLead({ ...l, id: crypto.randomUUID(), tenantId, now: new Date() }),
    );
    await deps.repo.logEvent(tenantId, lead.id, "importado", { source: l.source, originNote: l.originNote, legalBasis: l.legalBasis });
    const sent = body.data.start ? await startOutbound(deps, lead.id) : [];
    out.push({ phone: l.phone, leadId: lead.id, started: sent.length > 0 });
  }
  return Response.json({ results: out });
});
