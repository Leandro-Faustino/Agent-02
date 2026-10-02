import type { Lead, LeadSource, LegalBasis } from "./types";

export function newLead(p: {
  id: string;
  tenantId: string;
  phone: string;
  now: Date;
  source?: LeadSource;
  name?: string;
  originNote?: string;
  legalBasis?: LegalBasis;
  optIn?: boolean;
}): Lead {
  const at = p.now.toISOString();
  return {
    id: p.id,
    tenantId: p.tenantId,
    phone: p.phone,
    name: p.name,
    source: p.source ?? "inbound",
    originNote: p.originNote,
    // RNF-11 — quem escreve primeiro inicia a conversa: legítimo interesse documentado.
    legalBasis: p.legalBasis ?? (p.source === "frio_optin" ? "consentimento" : "legitimo_interesse"),
    optIn: p.optIn ?? p.source !== "frio_optin",
    optedOut: false,
    stage: "prospect",
    flowState: "abertura",
    score: 0,
    signals: [],
    criteria: {},
    yeses: [],
    quotes: [],
    objections: [],
    consecutiveObjections: 0,
    questionsForSeller: [],
    dreamDescribed: false,
    proposedSlots: [],
    triggers: [],
    unansweredAttempts: 0,
    totalAttempts: 0,
    channelSwitchSuggested: false,
    createdAt: at,
    updatedAt: at,
  };
}
