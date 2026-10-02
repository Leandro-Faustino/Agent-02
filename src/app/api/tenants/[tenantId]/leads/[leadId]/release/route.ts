import { handle, HttpError, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";
import { loadLead } from "@/server/tenant";
import { flowPosition } from "@/core/agent/state-machine";

export const runtime = "nodejs";

/** Pessoa devolve a conversa ao agente depois de um escalonamento (RF-20). */
export const POST = handle(async (_req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId);
  const deps = prodDeps();
  const lead = await loadLead(tenantId, leadId);
  if (lead.flowState !== "humano") throw new HttpError(409, "conversa não está com uma pessoa");
  if (lead.optedOut) throw new HttpError(409, "lead pediu opt-out");
  const config = await deps.repo.getConfig(tenantId);
  if (!config) throw new HttpError(409, "configuração inválida");
  lead.flowState = flowPosition(lead, config);
  lead.handoffReason = undefined;
  await deps.repo.saveLead(lead);
  await deps.repo.logEvent(tenantId, leadId, "devolvido_ao_agente", {});
  return Response.json({ flowState: lead.flowState });
});
