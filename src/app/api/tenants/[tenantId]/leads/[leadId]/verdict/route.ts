import { z } from "zod";
import { handle, HttpError, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";
import { sellerVerdict } from "@/core/agent/proactive";
import { loadLead } from "@/server/tenant";

export const runtime = "nodejs";

const Body = z.object({ accepted: z.boolean(), reason: z.string().optional() });

/** RF-18 — vendedor requalifica: aceita ou devolve com motivo. */
export const POST = handle(async (req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId);
  await loadLead(tenantId, leadId);
  const b = Body.parse(await req.json());
  if (!b.accepted && !b.reason) throw new HttpError(422, "informe o motivo da devolução");
  const lead = await sellerVerdict(prodDeps(), leadId, b.accepted, b.reason);
  return Response.json({ stage: lead.stage });
});
