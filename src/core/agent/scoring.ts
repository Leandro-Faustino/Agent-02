import type { Lead, TenantConfig } from "../types";
import { threeTests } from "./qualification";

/**
 * RF-42 — pontuação de 0 a 100: perfil (até 50) + comportamento (até 50),
 * com perda de pontos por inatividade.
 */
export function computeScore(lead: Lead, config: TenantConfig, now: Date): number {
  const t = threeTests(lead);
  let profile = 0;
  if (t.fit === true) profile += 25;
  if (t.authority === true) profile += 15;
  const profileDef = config.profiles.find((p) => p.id === lead.profileId);
  if (lead.role && profileDef?.decisionRoles.some((r) => lead.role!.toLowerCase().includes(r.toLowerCase()))) profile += 10;
  else if (t.pain === true) profile += 10;

  const weights: Record<string, number> = {
    respondeu: 10,
    respondeu_rapido: 5,
    perguntou_preco: 10,
    aceitou_proximo_passo: 20,
    descreveu_sonho: 5,
  };
  const behavior = Math.min(50, [...new Set(lead.signals)].reduce((acc, s) => acc + (weights[s] ?? 0), 0));

  let decay = 0;
  const last = lead.lastInboundAt ?? lead.createdAt;
  const idleDays = (now.getTime() - new Date(last).getTime()) / 86400000;
  if (idleDays > 7) decay = Math.floor(idleDays / 7) * 5;

  return Math.max(0, Math.min(100, profile + behavior - decay));
}

/** Prospect vira lead quando passa do limite configurado (padrão 65, Marketo). */
export function isAboveThreshold(lead: Lead, config: TenantConfig): boolean {
  return lead.score >= config.limits.scoreThreshold;
}
