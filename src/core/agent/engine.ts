import type { ChatMessage, Lead, Slot, Stage, TenantConfig } from "../types";
import type { Deps, KnowledgeHit, TurnLog } from "../ports";
import { emptyAnalysis, type TurnAnalysis } from "./analysis";
import { decide, needsRedraft, type Decision, type DecisionKind } from "./state-machine";
import { normalizeBalloons, reviewReply } from "./guardrails";
import { methodologyPrompt, tenantPrompt, turnPrompt } from "../methodology/playbook";
import { BOT_QUESTION_PATTERNS, HUMAN_REQUEST_PATTERNS, OPT_OUT_PATTERNS } from "../methodology/defaults";
import { eligibleSellers, pickTwo, preferenceFilter } from "./scheduling";
import { computeScore } from "./scoring";
import { requiredSatisfied } from "./qualification";
import { buildHandoffSummary, handoffMode, sellerName } from "./handoff";
import { clampToSendWindow, nextFollowUp, nextNurture } from "./cadence";
import { addDays, addMinutes, formatSlot } from "../time";

export interface TurnResult {
  sent: string[];
  decision: DecisionKind | "opt_out" | "ignorado";
  lead: Lead;
}

const LONG_GAP_DAYS = 7;

/* ------------------------------------------------------------------ */
/* Mensagens determinísticas (não passam pelo modelo)                  */
/* ------------------------------------------------------------------ */

export const MSG = {
  optOut: () => "Combinado, não envio mais mensagens por aqui. Obrigado por avisar.",
  human: (c: TenantConfig) => `Entendi. Vou chamar uma pessoa da equipe da ${c.persona.companyName} para continuar com você por aqui.`,
  confirmed: (c: TenantConfig, lead: Lead, slot: Slot, now: Date) =>
    `Combinado${lead.name ? `, ${firstName(lead.name)}` : ""}: reunião com ${sellerName(c, slot.sellerId)} ${formatSlot(slot.startsAt, c.limits.timezone, now)}, ${formatLabel(c)}. Vou te lembrar um dia antes e uma hora antes.`,
  slotTaken: (c: TenantConfig, slots: Slot[], now: Date) =>
    slots.length >= 2
      ? `Esse horário acabou de ser ocupado. Tenho ${formatSlot(slots[0].startsAt, c.limits.timezone, now)} ou ${formatSlot(slots[1].startsAt, c.limits.timezone, now)}. Qual fica melhor?`
      : `Esse horário acabou de ser ocupado. Vou pedir para a equipe te mandar novas opções ainda hoje.`,
};

function formatLabel(c: TenantConfig): string {
  return { video: "por vídeo", presencial: "presencial", ligacao: "por ligação" }[c.meetings.format];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0];
}

/* ------------------------------------------------------------------ */
/* Turno de conversa (mensagens do lead já juntadas e convertidas)     */
/* ------------------------------------------------------------------ */

export async function handleInbound(deps: Deps, leadId: string, inbound: ChatMessage[]): Promise<TurnResult> {
  const { repo, clock } = deps;
  const lead = await repo.getLead(leadId);
  if (!lead) throw new Error(`lead ${leadId} não encontrado`);
  const config = await repo.getConfig(lead.tenantId);
  const now = clock.now();
  const input = inbound.map((m) => m.media?.transcript ?? m.text).filter(Boolean).join("\n");
  const stateBefore = lead.flowState;
  const tools: TurnLog["tools"] = [];
  const log = async (output: string[], analysis: TurnAnalysis | null, violations: string[] = [], cost = 0) =>
    repo.logTurn({
      tenantId: lead.tenantId,
      leadId,
      at: now.toISOString(),
      input,
      stateBefore,
      stateAfter: lead.flowState,
      analysis,
      tools,
      output,
      guardrailViolations: violations,
      costUsd: cost,
    });

  // P1 — sem PIC configurado e aprovado, o agente não conversa.
  if (!config || !config.approved) {
    await repo.logEvent(lead.tenantId, leadId, "ignorado_sem_onboarding", {});
    return { sent: [], decision: "ignorado", lead };
  }

  // Sinais de comportamento e janela de atendimento.
  const prevStage = lead.stage;
  const wasLongGap = !lead.lastOutboundAt || now.getTime() - new Date(lead.lastOutboundAt).getTime() > LONG_GAP_DAYS * 86400000;
  addSignal(lead, "respondeu");
  if (lead.lastOutboundAt && now.getTime() - new Date(lead.lastOutboundAt).getTime() < 10 * 60000) addSignal(lead, "respondeu_rapido");
  lead.lastInboundAt = now.toISOString();
  lead.unansweredAttempts = 0;
  if (lead.stage === "prospect") lead.stage = "em_conversa";

  // RF-26 — opt-out imediato, sem passar pelo modelo.
  if (OPT_OUT_PATTERNS.some((re) => re.test(input))) {
    const sent = await optOut(deps, lead, "palavra de opt-out");
    await log(sent, null);
    return { sent, decision: "opt_out", lead };
  }

  // Conversa já está com uma pessoa: o agente não interfere.
  if (lead.flowState === "humano") {
    await repo.saveLead(touch(lead, now));
    await log([], null);
    return { sent: [], decision: "ignorado", lead };
  }

  // Lead que já pediu opt-out e voltou a escrever: uma pessoa responde.
  if (lead.optedOut) {
    const sent = await escalate(deps, lead, config, "lead com opt-out voltou a escrever");
    await log(sent, null);
    return { sent, decision: "transferir_humano", lead };
  }

  // RF-20 — pedido explícito de pessoa: transfere sem discutir.
  if (HUMAN_REQUEST_PATTERNS.some((re) => re.test(input))) {
    const sent = await escalate(deps, lead, config, "lead pediu pessoa");
    await log(sent, null);
    return { sent, decision: "transferir_humano", lead };
  }

  // Contexto do turno: base do cliente (RAG isolado) e horários reais.
  const kb = await deps.kb.search(lead.tenantId, input, 5);
  tools.push({ name: "buscar_base", input: { query: input }, output: kb.map((h) => h.id) });
  const wantsSlots = config.goal === "reuniao";
  let slots = wantsSlots ? await twoSlots(deps, config, lead, now) : [];
  if (wantsSlots) tools.push({ name: "consultar_agenda", input: {}, output: slots });
  const proposed = lead.proposedSlots;
  const askedIfBot = BOT_QUESTION_PATTERNS.some((re) => re.test(input));
  // RF-34.1 — identificar-se no primeiro contato e após longos intervalos.
  const mustIdentify = wasLongGap;

  const history = await repo.getHistory(leadId, 30);
  const base = {
    methodology: methodologyPrompt(),
    tenantContext: tenantPrompt(config),
    history,
  };
  let cost = 0;
  const run = async (forced?: DecisionKind, returnDate?: Date, revisionNotes?: string[]) => {
    const res = await deps.llm.runTurn({
      ...base,
      turnContext: turnPrompt({ lead, config, now, proposed, slots, kb, mustIdentify, forcedDecision: forced, returnDate }),
      revisionNotes,
    });
    cost += res.usage.costUsd;
    return res.analysis;
  };

  // 1ª passada: o modelo redige e classifica.
  const analysis = await run();
  if (askedIfBot) analysis.flags.askedIfBot = true;
  applyAnalysis(lead, analysis, now);

  // O código decide a etapa (RF-27).
  const decision = decide(lead, analysis, config);
  const returnDate = returnDateFor(decision, lead, analysis, config, now);

  // Preferência de horário: novos horários que respeitam o pedido do lead.
  let slotsChanged = false;
  if (wantsSlots && analysis.timePreference && (decision.kind === "propor_horario" || decision.kind === "tratar_objecao")) {
    const filtered = await twoSlots(deps, config, lead, now, analysis.timePreference);
    if (filtered.length) {
      slots = filtered;
      slotsChanged = true;
    }
  }

  let reply = normalizeBalloons(analysis.reply);
  let deterministic = false;

  // Ferramenta de agenda: só confirma depois da reserva (RF-29).
  if (decision.kind === "reservar_horario") {
    const slot = lead.proposedSlots[analysis.slotChoice!];
    const meeting = await deps.calendar.book(config, lead, slot);
    tools.push({ name: "agendar_reuniao", input: slot, output: meeting });
    deterministic = true;
    if (meeting) {
      lead.meeting = meeting;
      lead.proposedSlots = [];
      addSignal(lead, "aceitou_proximo_passo");
      reply = [MSG.confirmed(config, lead, slot, now)];
      if (config.meetings.meetingLink) reply.push(`Link da reunião: ${config.meetings.meetingLink}`);
    } else {
      slots = await twoSlots(deps, config, lead, now);
      reply = [MSG.slotTaken(config, slots, now)];
      decision.next = "pedido";
      decision.kind = "propor_horario";
    }
  } else if (decision.kind === "transferir_humano") {
    deterministic = true;
    reply = [MSG.human(config)];
  } else if (needsRedraft(decision, analysis) || slotsChanged) {
    // A resposta precisa refletir a decisão do código.
    const second = await run(decision.kind, returnDate);
    reply = normalizeBalloons(second.reply);
    tools.push({ name: "redigir_novamente", input: { decision: decision.kind }, output: null });
  }

  // RF-34.6 / RF-30 — revisão antes de enviar; uma correção, senão pessoa assume.
  let violations: string[] = [];
  if (!deterministic) {
    const ctx = {
      config,
      mustIdentify,
      factCorpus: factCorpus(config, kb),
      allowedNumbers: [...slots, ...proposed].map((s) => formatSlot(s.startsAt, config.limits.timezone, now)).concat(returnDate ? [formatSlot(returnDate.toISOString(), config.limits.timezone, now)] : []),
      askedIfBot: analysis.flags.askedIfBot,
    };
    violations = reviewReply(reply, ctx);
    if (violations.length) {
      const fixed = await run(decision.kind, returnDate, violations);
      const fixedReply = normalizeBalloons(fixed.reply);
      const again = reviewReply(fixedReply, ctx);
      if (again.length === 0) {
        reply = fixedReply;
      } else {
        await repo.enqueueReview(lead.tenantId, leadId, "revisor_reprovou", { first: violations, second: again, reply: fixedReply });
        violations = [...violations, ...again];
        const sent = await escalate(deps, lead, config, "resposta reprovada pelo revisor");
        await log(sent, analysis, violations, cost);
        return { sent, decision: "transferir_humano", lead };
      }
    }
  }

  // Efeitos da decisão no CRM e na cadência (P16: nunca termina em aberto).
  await applyDecision(deps, lead, config, decision, analysis, now, returnDate);
  if (decision.kind === "propor_horario" || decision.kind === "tratar_objecao") lead.proposedSlots = slots;

  lead.score = computeScore(lead, config, now);
  if (lead.stage !== prevStage) await repo.logEvent(lead.tenantId, leadId, "estagio", { de: prevStage, para: lead.stage });

  const sent = await sendFree(deps, lead, reply, now);
  await repo.saveLead(touch(lead, now));
  await log(sent, analysis, violations, cost);
  return { sent, decision: decision.kind, lead };
}

/* ------------------------------------------------------------------ */

function addSignal(lead: Lead, s: Lead["signals"][number]) {
  if (!lead.signals.includes(s)) lead.signals.push(s);
}

function touch(lead: Lead, now: Date): Lead {
  lead.updatedAt = now.toISOString();
  return lead;
}

/** Atualiza a memória estruturada do lead com a análise do turno. */
export function applyAnalysis(lead: Lead, a: TurnAnalysis, now: Date) {
  for (const c of a.criteria) {
    lead.criteria[c.id] = { value: c.value, satisfied: c.satisfied };
  }
  if (a.profileId) lead.profileId = a.profileId;
  if (a.leadData.name && !lead.name) lead.name = a.leadData.name;
  if (a.leadData.company) lead.company = a.leadData.company;
  if (a.leadData.role) lead.role = a.leadData.role;
  if (a.dreamDescribed && !lead.dreamDescribed) {
    lead.dreamDescribed = true;
    addSignal(lead, "descreveu_sonho");
  }
  lead.yeses.push(...a.yeses.filter((y) => !lead.yeses.includes(y)));
  lead.quotes.push(...a.quotes.filter((q) => !lead.quotes.includes(q)).slice(0, 3));
  for (const q of a.questionsForSeller) if (!lead.questionsForSeller.includes(q)) lead.questionsForSeller.push(q);
  if (a.intent === "pergunta_preco") addSignal(lead, "perguntou_preco");

  if (a.objection) {
    lead.objections.push({ type: a.objection.type, text: a.objection.text, at: now.toISOString(), reverted: false });
    lead.consecutiveObjections += 1;
  } else {
    // Objeção anterior revertida se o lead seguiu em frente (RF-43: taxa de reversão).
    const last = lead.objections[lead.objections.length - 1];
    if (last && lead.consecutiveObjections > 0 && (a.slotChoice != null || a.intent === "demonstra_interesse" || a.intent === "responde_pergunta")) {
      last.reverted = true;
    }
    lead.consecutiveObjections = 0;
  }
}

function returnDateFor(d: Decision, lead: Lead, a: TurnAnalysis, config: TenantConfig, now: Date): Date | undefined {
  switch (d.kind) {
    case "agendar_retorno_pedido_pelo_lead": {
      const asked = a.followUpDate ? new Date(a.followUpDate) : null;
      return clampToSendWindow(asked && !isNaN(asked.getTime()) && asked > now ? asked : addDays(now, 7), config);
    }
    case "recuar_apos_duas_objecoes":
      return clampToSendWindow(addDays(now, 14), config);
    case "nutrir":
      return nextNurture(now, config);
    default:
      return undefined;
  }
}

async function applyDecision(
  deps: Deps,
  lead: Lead,
  config: TenantConfig,
  d: Decision,
  a: TurnAnalysis,
  now: Date,
  returnDate: Date | undefined,
) {
  const { repo } = deps;
  lead.flowState = d.next;
  const setStage = (s: Stage) => (lead.stage = s);

  if (requiredSatisfied(lead, config) && lead.stage === "em_conversa") setStage("qualificado");

  switch (d.kind) {
    case "descartar_fora_do_perfil":
    case "descartar_menor":
      setStage("descartado");
      lead.discardReason = d.reason;
      clearNext(lead);
      if (a.referral?.name || a.referral?.phone) await repo.logEvent(lead.tenantId, lead.id, "indicacao", a.referral);
      if (d.kind === "descartar_menor") await deps.notifier.notifyTenant(lead.tenantId, "menor_idade", { leadId: lead.id });
      break;
    case "transferir_humano":
      lead.handoffReason = d.reason;
      clearNext(lead);
      await deps.notifier.notifyTenant(lead.tenantId, "escalonamento", { leadId: lead.id, motivo: d.reason });
      break;
    case "reservar_horario":
      if (lead.meeting) {
        setStage("reuniao_agendada");
        scheduleReminder(lead, now);
        const summary = buildHandoffSummary(lead, config, now);
        const mode = handoffMode(config, lead.meeting.sellerId, true);
        await deps.notifier.notifySeller(config, lead.meeting.sellerId, { leadId: lead.id, summary, mode });
        await repo.logEvent(lead.tenantId, lead.id, "passagem_bastao", { sellerId: lead.meeting.sellerId, mode, summary });
      }
      break;
    case "recuar_apos_duas_objecoes":
    case "agendar_retorno_pedido_pelo_lead":
      lead.nextActionAt = returnDate!.toISOString();
      lead.nextActionKind = "follow_up";
      lead.consecutiveObjections = 0;
      lead.cadenceStartedAt = returnDate!.toISOString();
      break;
    case "nutrir":
      setStage("nutricao");
      lead.nextActionAt = returnDate!.toISOString();
      lead.nextActionKind = "nutricao";
      break;
    default: {
      // Aguardando resposta do lead: o timer de follow-up é o próximo passo (RF-14, RF-22).
      lead.cadenceStartedAt = now.toISOString();
      lead.unansweredAttempts = 0;
      const next = nextFollowUp(lead, config, now);
      if (next) {
        lead.nextActionAt = next.toISOString();
        lead.nextActionKind = "follow_up";
      } else {
        lead.nextActionAt = nextNurture(now, config).toISOString();
        lead.nextActionKind = "nutricao";
      }
    }
  }
}

function clearNext(lead: Lead) {
  lead.nextActionAt = undefined;
  lead.nextActionKind = undefined;
}

/** RF-19 — lembretes 24 h e 1 h antes. */
export function scheduleReminder(lead: Lead, now: Date) {
  if (!lead.meeting) return;
  const start = new Date(lead.meeting.startsAt);
  const at24 = addMinutes(start, -24 * 60);
  const at1 = addMinutes(start, -60);
  const sent = lead.meeting.remindersSent;
  const next = !sent.includes("24h") && at24 > now ? at24 : !sent.includes("1h") && at1 > now ? at1 : null;
  if (next) {
    lead.nextActionAt = next.toISOString();
    lead.nextActionKind = "lembrete";
  } else {
    // Depois da reunião: confere comparecimento.
    lead.nextActionAt = addMinutes(new Date(lead.meeting.endsAt), 60).toISOString();
    lead.nextActionKind = "reagendar";
  }
}

export async function twoSlots(deps: Deps, config: TenantConfig, lead: Lead, now: Date, preference?: string | null): Promise<Slot[]> {
  const all = await deps.calendar.findSlots(config, lead, now, 40);
  return pickTwo(all, config.limits.timezone, preferenceFilter(preference, config.limits.timezone));
}

export function factCorpus(config: TenantConfig, kb: KnowledgeHit[]): string {
  const o = config.offer;
  return [
    o.product,
    o.summary,
    ...o.authorizedPrices.map((p) => `${p.label} ${p.value}`),
    ...o.differentiators,
    ...o.cases.map((c) => `${c.client} ${c.result}`),
    ...o.testimonials.map((t) => `${t.author} ${t.text}`),
    ...o.provenNumbers,
    ...o.faq.map((f) => `${f.q} ${f.a}`),
    `${config.meetings.durationMinutes} minutos`,
    ...kb.map((h) => h.content),
  ].join("\n");
}

/** Envia texto livre (dentro da janela de atendimento) e registra no CRM. */
export async function sendFree(deps: Deps, lead: Lead, balloons: string[], now: Date): Promise<string[]> {
  const sent: string[] = [];
  for (const text of balloons) {
    const r = await deps.messenger.sendText(lead.tenantId, lead.phone, text);
    if (!r.ok) {
      await deps.repo.logEvent(lead.tenantId, lead.id, "falha_envio", { error: r.error });
      break;
    }
    await deps.repo.appendMessage({ id: deps.ids(), leadId: lead.id, role: "agente", text, at: now.toISOString() });
    sent.push(text);
  }
  if (sent.length) lead.lastOutboundAt = now.toISOString();
  return sent;
}

/** RF-26 — encerra a cadência na hora, confirma e registra. */
export async function optOut(deps: Deps, lead: Lead, reason: string): Promise<string[]> {
  const now = deps.clock.now();
  lead.optedOut = true;
  lead.flowState = "encerrado";
  lead.proposedSlots = [];
  clearNext(lead);
  await deps.repo.logEvent(lead.tenantId, lead.id, "opt_out", { reason });
  const sent = await sendFree(deps, lead, [MSG.optOut()], now);
  await deps.repo.saveLead(touch(lead, now));
  return sent;
}

/** RF-20 — transfere para uma pessoa. */
export async function escalate(deps: Deps, lead: Lead, config: TenantConfig, reason: string): Promise<string[]> {
  const now = deps.clock.now();
  lead.flowState = "humano";
  lead.handoffReason = reason;
  clearNext(lead);
  await deps.notifier.notifyTenant(lead.tenantId, "escalonamento", { leadId: lead.id, motivo: reason });
  await deps.repo.logEvent(lead.tenantId, lead.id, "escalonamento", { reason });
  const sent = await sendFree(deps, lead, [MSG.human(config)], now);
  await deps.repo.saveLead(touch(lead, now));
  return sent;
}

export { emptyAnalysis };
