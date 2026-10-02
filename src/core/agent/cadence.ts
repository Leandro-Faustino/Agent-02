import type { Lead, LeadSource, TenantConfig } from "../types";
import { addDays, addMinutes, nextWindowStart } from "../time";
import { requiredSatisfied, threeTests } from "./qualification";

/** RF-21 — pirâmide de prospecção: menor número = mais prioridade. */
export const PRIORITY: Record<LeadSource, number> = {
  inbound: 1,
  janela_compra: 1,
  indicacao: 2,
  reengajamento: 3,
  nutricao: 4,
  frio_optin: 5,
};

export function priorityOf(lead: Lead): number {
  return PRIORITY[lead.source];
}

/** RF-33 — janela de atendimento de 24h desde a última mensagem do lead. */
export function inServiceWindow(lead: Lead, now: Date): boolean {
  if (!lead.lastInboundAt) return false;
  return now.getTime() - new Date(lead.lastInboundAt).getTime() < 24 * 3600 * 1000;
}

/** RF-37 — envios ativos só no horário comercial do cliente. */
export function clampToSendWindow(when: Date, config: TenantConfig): Date {
  return nextWindowStart(when, config.limits.timezone, config.limits.sendWindow);
}

/**
 * RF-22 — próximo follow-up sem resposta. Cadência padrão: dias 0, 1, 3, 7, 14
 * contados do início da cadência; depois disso, nutrição mensal.
 * Retorna null quando a cadência acabou.
 */
export function nextFollowUp(lead: Lead, config: TenantConfig, now: Date): Date | null {
  const start = new Date(lead.cadenceStartedAt ?? now.toISOString());
  const steps = config.limits.cadenceDays.filter((d) => d > 0);
  const step = steps[lead.unansweredAttempts];
  if (step == null) return null;
  if (lead.totalAttempts >= config.limits.maxAttemptsPerLead) return null;
  let when = addDays(start, step);
  const minGap = addMinutes(now, config.limits.minIntervalMinutes);
  if (when < minGap) when = minGap;
  return clampToSendWindow(when, config);
}

/** RF-23 — nutrição: no máximo uma por mês. */
export function nextNurture(now: Date, config: TenantConfig): Date {
  return clampToSendWindow(addDays(now, 30), config);
}

/** Após duas tentativas sem resposta, sugerir ao cliente trocar de canal (RF-22). */
export function shouldSuggestChannelSwitch(lead: Lead): boolean {
  return lead.unansweredAttempts >= 2 && !lead.channelSwitchSuggested;
}

export type CycleOutcome = "desqualificado" | "oportunidade" | "reciclado";

/** RF-25 — fim de ciclo após N dias (padrão 21). */
export function cycleEnded(lead: Lead, config: TenantConfig, now: Date): boolean {
  if (!lead.cadenceStartedAt) return false;
  return now.getTime() - new Date(lead.cadenceStartedAt).getTime() >= config.limits.cycleDays * 86400000;
}

export function endOfCycleOutcome(lead: Lead, config: TenantConfig): CycleOutcome {
  if (lead.meeting && lead.meeting.status !== "cancelada") return "oportunidade";
  const t = threeTests(lead);
  if (t.fit === false) return "desqualificado";
  if (requiredSatisfied(lead, config) || t.fit === true) return "reciclado";
  // Sem informação suficiente: recicla para nutrição se houve alguma conversa.
  return lead.lastInboundAt ? "reciclado" : "desqualificado";
}
