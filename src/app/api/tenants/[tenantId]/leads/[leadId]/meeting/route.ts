import { z } from "zod";
import { handle, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";
import { markMeeting } from "@/core/agent/proactive";
import { loadLead } from "@/server/tenant";
import { supabaseAdmin } from "@/adapters/supabase/client";

export const runtime = "nodejs";

/** RF-19 — vendedor informa se a reunião aconteceu; falta gera nova tentativa. */
export const POST = handle(async (req, ctx) => {
  const { tenantId, leadId } = await ctx.params;
  await requireMember(tenantId);
  const before = await loadLead(tenantId, leadId);
  const { status } = z.object({ status: z.enum(["realizada", "no_show"]) }).parse(await req.json());
  const lead = await markMeeting(prodDeps(), leadId, status);
  if (before.meeting) await supabaseAdmin().from("bookings").update({ status }).eq("id", before.meeting.id);
  return Response.json({ stage: lead.stage });
});
