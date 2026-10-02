import type { Lead, TenantConfig } from "../types";

export interface ThreeTests {
  /** Encaixa no PIC? */
  fit: boolean | null;
  /** Fala com quem decide ou influencia? */
  authority: boolean | null;
  /** Há dor clara (pré-condição do interesse real no próximo passo)? */
  pain: boolean | null;
}

const FIT_IDS = ["encaixe_pic", "fit", "perfil"];
const AUTH_IDS = ["autoridade", "authority", "decisor"];
const PAIN_IDS = ["dor", "pain", "problema"];

function pick(lead: Lead, ids: string[]): boolean | null {
  for (const id of ids) {
    const c = lead.criteria[id];
    if (c) return c.satisfied;
  }
  return null;
}

/** P5 — três testes antes de passar o bastão. */
export function threeTests(lead: Lead): ThreeTests {
  return { fit: pick(lead, FIT_IDS), authority: pick(lead, AUTH_IDS), pain: pick(lead, PAIN_IDS) };
}

/** Todos os critérios obrigatórios do cliente (RF-04) satisfeitos. */
export function requiredSatisfied(lead: Lead, config: TenantConfig): boolean {
  return config.qualification.filter((c) => c.required).every((c) => lead.criteria[c.id]?.satisfied === true);
}

/** Critérios obrigatórios ainda sem resposta, na ordem configurada. */
export function missingRequired(lead: Lead, config: TenantConfig): string[] {
  return config.qualification.filter((c) => c.required && lead.criteria[c.id]?.satisfied == null).map((c) => c.id);
}

/** P7 — fora do perfil: reprovado no encaixe com o PIC. */
export function isOutOfProfile(lead: Lead): boolean {
  return threeTests(lead).fit === false;
}

/** Tem perfil, mas não há dor clara agora: vai para nutrição (P9), não para o vendedor (P2). */
export function shouldNurture(lead: Lead): boolean {
  const t = threeTests(lead);
  return t.fit === true && t.pain === false;
}
