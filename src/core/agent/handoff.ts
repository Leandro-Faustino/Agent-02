import type { Lead, TenantConfig } from "../types";
import type { HandoffMode } from "../ports";
import { threeTests } from "./qualification";
import { formatSlot } from "../time";

/**
 * RF-18 — resumo da passagem do bastão: encaixe no PIC, dor, decisor,
 * situação atual, prazo, objeções, frases do lead e próximo passo.
 */
export function buildHandoffSummary(lead: Lead, config: TenantConfig, now: Date): string {
  const t = threeTests(lead);
  const crit = (id: string) => lead.criteria[id]?.value ?? "não informado";
  const yn = (b: boolean | null) => (b === true ? "sim" : b === false ? "não" : "a confirmar");
  const profile = config.profiles.find((p) => p.id === lead.profileId);
  const next = lead.meeting
    ? `Reunião ${formatSlot(lead.meeting.startsAt, config.limits.timezone, now)} com ${sellerName(config, lead.meeting.sellerId)}`
    : lead.nextActionAt
      ? `Retorno agendado para ${formatSlot(lead.nextActionAt, config.limits.timezone, now)}`
      : "Sem próximo passo";

  const lines = [
    `Oportunidade: ${lead.name ?? "sem nome"}${lead.company ? `, ${lead.company}` : ""}${lead.role ? ` (${lead.role})` : ""} — ${lead.phone}`,
    `Origem: ${lead.source}${lead.originNote ? ` — ${lead.originNote}` : ""}`,
    `Encaixe no PIC: ${yn(t.fit)}${profile ? ` (${profile.name})` : ""} — ${crit("encaixe_pic")}`,
    `Dor: ${crit("dor")}`,
    `Decisor/influenciador: ${yn(t.authority)} — ${crit("autoridade")}`,
    `Situação atual: ${crit("situacao_atual")}`,
    `Prazo: ${crit("prazo")}`,
    `Gatilho: ${crit("gatilho")}`,
    `Pontuação: ${lead.score}/100`,
    `Objeções levantadas: ${lead.objections.length ? lead.objections.map((o) => `${o.type}${o.reverted ? " (revertida)" : ""}`).join(", ") : "nenhuma"}`,
    `Concordâncias do lead: ${lead.yeses.length ? lead.yeses.join(" | ") : "—"}`,
    `Frases do lead: ${lead.quotes.length ? lead.quotes.map((q) => `"${q}"`).join(" | ") : "—"}`,
    `Perguntas para o vendedor: ${lead.questionsForSeller.length ? lead.questionsForSeller.join(" | ") : "—"}`,
    `Próximo passo: ${next}`,
  ];
  return lines.join("\n");
}

export function sellerName(config: TenantConfig, sellerId: string): string {
  return config.meetings.sellers.find((s) => s.id === sellerId)?.name ?? "especialista";
}

/** Modo de passagem em ordem de preferência (Receita Previsível). */
export function handoffMode(config: TenantConfig, sellerId: string, bookedMeeting: boolean): HandoffMode {
  const seller = config.meetings.sellers.find((s) => s.id === sellerId);
  if (!bookedMeeting && seller?.canJoinLive) return "ao_vivo";
  if (bookedMeeting) return "reuniao_agendada";
  return "apresentacao";
}
