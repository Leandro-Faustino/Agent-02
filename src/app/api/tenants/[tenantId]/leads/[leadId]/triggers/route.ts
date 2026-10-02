import crypto from "node:crypto";
import { z } from "zod";
import { handle, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";
import { loadLead } from "@/server/tenant";

export const runtime = "nodejs";

/** RF-24 — evento-gatilho por lead (fim de contrato, troca de gestor, sazonalidade...). */
export const POST = handle(async (req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId);
  const lead = await loadLead(tenantId, leadId);
  const b = z.object({ description: z.string().min(3), date: z.string().datetime() }).parse(await req.json());
  lead.triggers.push({ id: crypto.randomUUID(), description: b.description, date: b.date, fired: false });
  const canReopen = !lead.optedOut && !lead.meeting && lead.flowState !== "humano";
  if (canReopen && (!lead.nextActionAt || b.date < lead.nextActionAt)) {
    lead.nextActionAt = b.date;
    lead.nextActionKind = "gatilho";
  }
  await prodDeps().repo.saveLead(lead);
  return Response.json({ triggers: lead.triggers });
});
