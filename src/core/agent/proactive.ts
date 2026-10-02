import type { Lead, TenantConfig } from "../types";
import type { Deps, WhatsAppTemplate } from "../ports";
import { methodologyPrompt, tenantPrompt, turnPrompt } from "../methodology/playbook";
import { normalizeBalloons, reviewReply } from "./guardrails";
import {
  clampToSendWindow,
  cycleEnded,
  endOfCycleOutcome,
  inServiceWindow,
  nextFollowUp,
  nextNurture,
  shouldSuggestChannelSwitch,
} from "./cadence";
import { factCorpus, firstName, scheduleReminder, sendFree, twoSlots } from "./engine";
import { addDays, formatSlot } from "../time";
import { buildHandoffSummary } from "./handoff";

export interface ProactiveResult {
  leadId: string;
  action: string;
  sent: string[];
}

/**
 * Worker de cadência: follow-ups (RF-22), nutrição (RF-23), gatilhos (RF-24),
 * fim de ciclo (RF-25), lembretes e no-show (RF-19). Fila pela pirâmide (RF-21).
 */
export async function runDue(deps: Deps, limit = 50): Promise<ProactiveResult[]> {
  const now = deps.clock.now();
  const leads = await deps.repo.dueLeads(now, limit);
  const out: ProactiveResult[] = [];
  for (const lead of leads) {
    try {
      out.push(await runOne(deps, lead));
    } catch (e) {
      await deps.repo.logEvent(lead.tenantId, lead.id, "erro_cadencia", { error: String(e) });
    }
  }
  return out;
}

async function runOne(deps: Deps, lead: Lead): Promise<ProactiveResult> {
  const now = deps.clock.now();
  const config = await deps.repo.getConfig(lead.tenantId);
  const res = (action: string, sent: string[] = []) => ({ leadId: lead.id, action, sent });
  if (!config?.approved) return res("sem_onboarding");
  if (lead.optedOut || lead.flowState === "humano" || lead.stage === "descartado") {
    lead.nextActionAt = undefined;
    await deps.repo.saveLead(lead);
    return res("ignorado");
  }

  // Lembretes e conferência de comparecimento.
  if (lead.nextActionKind === "lembrete" || lead.nextActionKind === "reagendar") {
    return res(lead.nextActionKind, await meetingAction(deps, lead, config));
  }

  // RF-37 / RF-38 / RF-09 — horário, saúde do número e volume diário.
  const health = await deps.repo.getNumberHealth(lead.tenantId);
  const allowedAt = clampToSendWindow(now, config);
  if (allowedAt > now) return postpone(deps, lead, allowedAt, "fora_do_horario");
  if (health.paused || health.quality === "RED") return postpone(deps, lead, addDays(now, 1), "numero_pausado");
  if (health.sentToday >= config.limits.dailyVolumePerNumber) {
    return postpone(deps, lead, clampToSendWindow(addDays(now, 1), config), "limite_diario");
  }

  // RF-24 — gatilho vencido tem prioridade.
  const trigger = lead.triggers.find((t) => !t.fired && new Date(t.date) <= now);
  if (trigger) {
    trigger.fired = true;
    const sent = await proactiveMessage(deps, lead, config, "gatilho", {
      extra: `REABERTURA POR GATILHO: ${trigger.description}. Cite o gatilho de forma natural, ligue à dor do lead e faça uma pergunta.`,
    });
    lead.flowState = "follow_up";
    lead.cadenceStartedAt = now.toISOString();
    lead.unansweredAttempts = 0;
    scheduleFollowUp(lead, config, now);
    await deps.repo.saveLead(lead);
    return res("gatilho", sent);
  }

  if (lead.nextActionKind === "nutricao") {
    const sent = await proactiveMessage(deps, lead, config, "nutricao", {
      extra: "NUTRIÇÃO: mensagem de valor sem pedido direto (conteúdo útil da base, novidade relevante do setor ou parabéns por conquista do lead). Nenhuma pergunta de agenda.",
    });
    lead.flowState = "nutricao";
    lead.nextActionAt = nextNurture(now, config).toISOString();
    await deps.repo.saveLead(lead);
    return res("nutricao", sent);
  }

  // RF-25 — fim de ciclo.
  if (cycleEnded(lead, config, now)) return res(await endCycle(deps, lead, config));

  // RF-22 — follow-up sem resposta.
  const slots = config.goal === "reuniao" ? await twoSlots(deps, config, lead, now) : [];
  const sent = await proactiveMessage(deps, lead, config, "follow_up", {
    extra:
      "FOLLOW-UP SEM RESPOSTA: traga algo novo (um dado, um caso autorizado ou uma pergunta diferente das anteriores), ligado à dor do lead. Proibido \"só passando\". Uma única pergunta.",
    slots,
  });
  if (sent.length) {
    if (slots.length) lead.proposedSlots = slots;
    lead.unansweredAttempts += 1;
    lead.totalAttempts += 1;
  }
  if (shouldSuggestChannelSwitch(lead)) {
    lead.channelSwitchSuggested = true;
    await deps.notifier.notifyTenant(lead.tenantId, "trocar_canal", { leadId: lead.id, tentativas: lead.unansweredAttempts });
  }
  if (!scheduleFollowUp(lead, config, now)) await endCycle(deps, lead, config);
  await deps.repo.saveLead(lead);
  return res("follow_up", sent);
}

function scheduleFollowUp(lead: Lead, config: TenantConfig, now: Date): boolean {
  const next = nextFollowUp(lead, config, now);
  if (!next) return false;
  lead.nextActionAt = next.toISOString();
  lead.nextActionKind = "follow_up";
  return true;
}

async function postpone(deps: Deps, lead: Lead, when: Date, why: string): Promise<ProactiveResult> {
  lead.nextActionAt = when.toISOString();
  await deps.repo.saveLead(lead);
  return { leadId: lead.id, action: `adiado:${why}`, sent: [] };
}

async function endCycle(deps: Deps, lead: Lead, config: TenantConfig): Promise<string> {
  const now = deps.clock.now();
  const outcome = endOfCycleOutcome(lead, config);
  if (outcome === "desqualificado") {
    lead.stage = "descartado";
    lead.discardReason = "fim de ciclo sem qualificação";
    lead.flowState = "encerrado";
    lead.nextActionAt = undefined;
  } else if (outcome === "reciclado") {
    lead.stage = "nutricao";
    lead.flowState = "nutricao";
    lead.nextActionAt = nextNurture(now, config).toISOString();
    lead.nextActionKind = "nutricao";
  }
  await deps.repo.logEvent(lead.tenantId, lead.id, "fim_de_ciclo", { outcome });
  await deps.repo.saveLead(lead);
  return `fim_de_ciclo:${outcome}`;
}

/**
 * Mensagem iniciada pela empresa. Dentro da janela de 24 h: texto livre.
 * Fora dela: modelo aprovado pela Meta, com o gancho redigido pelo agente (RF-33).
 */
async function proactiveMessage(
  deps: Deps,
  lead: Lead,
  config: TenantConfig,
  purpose: WhatsAppTemplate["purpose"],
  opts: { extra: string; slots?: Lead["proposedSlots"] },
): Promise<string[]> {
  const now = deps.clock.now();
  const kb = await deps.kb.search(lead.tenantId, [lead.criteria.dor?.value, lead.company, purpose].filter(Boolean).join(" "), 4);
  const history = await deps.repo.getHistory(lead.id, 20);
  const longGap = !lead.lastOutboundAt || now.getTime() - new Date(lead.lastOutboundAt).getTime() > 7 * 86400000;
  const window = inServiceWindow(lead, now);
  const extra = window
    ? opts.extra
    : `${opts.extra}\nFORA DA JANELA DE 24 H: escreva um único balão curto (até 160 caracteres), sem saudação nem nome, que será inserido no modelo aprovado.`;

  const { analysis, usage } = await deps.llm.runTurn({
    methodology: methodologyPrompt(),
    tenantContext: tenantPrompt(config),
    turnContext: turnPrompt({ lead, config, now, proposed: [], slots: opts.slots ?? [], kb, mustIdentify: window && longGap, extra }),
    history,
  });
  const reply = normalizeBalloons(analysis.reply);
  const ctx = {
    config,
    mustIdentify: window && longGap,
    factCorpus: factCorpus(config, kb),
    allowedNumbers: (opts.slots ?? []).map((s) => formatSlot(s.startsAt, config.limits.timezone, now)),
    askedIfBot: false,
  };
  const violations = reviewReply(reply, ctx);
  await deps.repo.logTurn({
    tenantId: lead.tenantId,
    leadId: lead.id,
    at: now.toISOString(),
    input: `[${purpose}]`,
    stateBefore: lead.flowState,
    stateAfter: lead.flowState,
    analysis,
    tools: [],
    output: violations.length ? [] : reply,
    guardrailViolations: violations,
    costUsd: usage.costUsd,
  });
  if (violations.length) {
    await deps.repo.enqueueReview(lead.tenantId, lead.id, "revisor_reprovou_proativa", { purpose, reply, violations });
    return [];
  }

  if (window) {
    const sent = await sendFree(deps, lead, reply, now);
    if (sent.length) await deps.repo.countSend(lead.tenantId);
    return sent;
  }
  return sendTemplate(deps, lead, purpose, { gancho: reply[0] });
}

export async function sendTemplate(
  deps: Deps,
  lead: Lead,
  purpose: WhatsAppTemplate["purpose"],
  values: Record<string, string>,
): Promise<string[]> {
  const now = deps.clock.now();
  const templates = await deps.repo.getTemplates(lead.tenantId);
  const tpl = templates.find((t) => t.purpose === purpose && t.status === "aprovado");
  if (!tpl) {
    await deps.repo.logEvent(lead.tenantId, lead.id, "sem_modelo_aprovado", { purpose });
    return [];
  }
  const all: Record<string, string> = { nome: lead.name ? firstName(lead.name) : "tudo bem", origem: lead.originNote ?? "", ...values };
  const params = tpl.variables.map((v) => all[v] ?? "");
  const r = await deps.messenger.sendTemplate(lead.tenantId, lead.phone, tpl, params);
  if (!r.ok) {
    await deps.repo.logEvent(lead.tenantId, lead.id, "falha_envio", { error: r.error, template: tpl.name });
    return [];
  }
  const text = tpl.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
  await deps.repo.appendMessage({ id: deps.ids(), leadId: lead.id, role: "agente", text, at: now.toISOString(), templateName: tpl.name });
  await deps.repo.countSend(lead.tenantId);
  lead.lastOutboundAt = now.toISOString();
  return [text];
}

/** RF-19 — lembretes 24 h e 1 h antes; no-show gera nova tentativa. */
async function meetingAction(deps: Deps, lead: Lead, config: TenantConfig): Promise<string[]> {
  const now = deps.clock.now();
  const m = lead.meeting;
  if (!m || m.status === "cancelada") {
    lead.nextActionAt = undefined;
    await deps.repo.saveLead(lead);
    return [];
  }
  const tz = config.limits.timezone;
  const when = formatSlot(m.startsAt, tz, now);
  let sent: string[] = [];

  if (lead.nextActionKind === "lembrete") {
    const which: "24h" | "1h" = m.remindersSent.includes("24h") || new Date(m.startsAt).getTime() - now.getTime() < 3 * 3600000 ? "1h" : "24h";
    const text = `Lembrete: nossa conversa é ${when}${config.meetings.meetingLink ? `, pelo link ${config.meetings.meetingLink}` : ""}. Se precisar trocar o horário, é só me responder por aqui.`;
    sent = inServiceWindow(lead, now)
      ? await sendFree(deps, lead, [text], now)
      : await sendTemplate(deps, lead, "lembrete", { horario: when, link: config.meetings.meetingLink ?? "" });
    m.remindersSent.push(which);
    if (which === "1h" && m.status === "agendada") m.status = "confirmada";
    scheduleReminder(lead, now);
  } else if (m.status === "no_show") {
    const slots = await twoSlots(deps, config, lead, now);
    const text =
      slots.length >= 2
        ? `Sentimos sua falta na conversa de hoje. Imagino que algo tenha surgido. Podemos remarcar para ${formatSlot(slots[0].startsAt, tz, now)} ou ${formatSlot(slots[1].startsAt, tz, now)}?`
        : "Sentimos sua falta na conversa de hoje. Imagino que algo tenha surgido. Posso te mandar novos horários?";
    sent = inServiceWindow(lead, now) ? await sendFree(deps, lead, [text], now) : await sendTemplate(deps, lead, "follow_up", { gancho: text });
    lead.proposedSlots = slots;
    lead.flowState = "pedido";
    lead.stage = "qualificado";
    lead.meeting = undefined;
    lead.cadenceStartedAt = now.toISOString();
    lead.unansweredAttempts = 0;
    scheduleFollowUp(lead, config, now);
  } else if (m.status === "realizada") {
    lead.nextActionAt = undefined;
  } else {
    // Vendedor ainda não informou se a reunião aconteceu: pergunta de novo amanhã.
    lead.nextActionAt = addDays(now, 1).toISOString();
    await deps.notifier.notifySeller(config, m.sellerId, {
      leadId: lead.id,
      summary: `Como foi a reunião com ${lead.name ?? lead.phone}? Marque como realizada ou falta no painel.\n\n${buildHandoffSummary(lead, config, now)}`,
      mode: "reuniao_agendada",
    });
  }
  await deps.repo.saveLead(lead);
  return sent;
}

/**
 * Primeiro contato ativo (reengajamento ou frio com opt-in): sempre por modelo
 * aprovado e citando a origem (RF-39). Sem opt-in registrado, não envia.
 */
export async function startOutbound(deps: Deps, leadId: string): Promise<string[]> {
  const lead = await deps.repo.getLead(leadId);
  if (!lead) throw new Error("lead não encontrado");
  const config = await deps.repo.getConfig(lead.tenantId);
  if (!config?.approved) return [];
  if (lead.optedOut) return [];
  if (lead.source === "frio_optin" && !lead.optIn) {
    await deps.repo.logEvent(lead.tenantId, lead.id, "bloqueado_sem_optin", {});
    return [];
  }
  const now = deps.clock.now();
  const allowedAt = clampToSendWindow(now, config);
  const health = await deps.repo.getNumberHealth(lead.tenantId);
  if (allowedAt > now || health.paused || health.sentToday >= config.limits.dailyVolumePerNumber) {
    lead.nextActionAt = (allowedAt > now ? allowedAt : addDays(now, 1)).toISOString();
    lead.nextActionKind = "follow_up";
    await deps.repo.saveLead(lead);
    return [];
  }
  const purpose = lead.source === "reengajamento" ? "reengajamento" : "primeiro_contato";
  const sent = await sendTemplate(deps, lead, purpose, {
    empresa: config.persona.companyName,
    agente: config.persona.agentName,
  });
  if (sent.length) {
    lead.stage = "prospect";
    lead.flowState = "abertura";
    lead.cadenceStartedAt = now.toISOString();
    lead.totalAttempts += 1;
    scheduleFollowUp(lead, config, now);
  }
  await deps.repo.saveLead(lead);
  return sent;
}

/** RF-18 — vendedor aceita ou devolve; devolução vira aprendizado (RF-32). */
export async function sellerVerdict(deps: Deps, leadId: string, accepted: boolean, reason?: string) {
  const lead = await deps.repo.getLead(leadId);
  if (!lead) throw new Error("lead não encontrado");
  lead.stage = accepted ? "oportunidade_aceita" : "devolvida";
  await deps.repo.logEvent(lead.tenantId, lead.id, accepted ? "oportunidade_aceita" : "oportunidade_devolvida", { reason });
  if (!accepted) await deps.repo.enqueueReview(lead.tenantId, lead.id, "devolucao_vendedor", { reason });
  await deps.repo.saveLead(lead);
  return lead;
}

/** Vendedor marca a reunião como realizada ou falta. */
export async function markMeeting(deps: Deps, leadId: string, status: "realizada" | "no_show") {
  const lead = await deps.repo.getLead(leadId);
  if (!lead?.meeting) throw new Error("lead sem reunião");
  lead.meeting.status = status;
  if (status === "realizada") lead.stage = "reuniao_realizada";
  lead.nextActionAt = deps.clock.now().toISOString();
  lead.nextActionKind = "reagendar";
  await deps.repo.logEvent(lead.tenantId, lead.id, `reuniao_${status}`, {});
  await deps.repo.saveLead(lead);
  return lead;
}
