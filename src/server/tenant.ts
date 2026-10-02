import { prodDeps } from "@/adapters/container";
import { HttpError } from "./auth";

/** Carrega um lead garantindo que pertence à empresa (RNF-02). */
export async function loadLead(tenantId: string, leadId: string) {
  const lead = await prodDeps().repo.getLead(leadId);
  if (!lead || lead.tenantId !== tenantId) throw new HttpError(404, "lead não encontrado");
  return lead;
}
