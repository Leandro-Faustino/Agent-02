import { describe, expect, it } from "vitest";
import { reviewReply, unsupportedFacts } from "@/core/agent/guardrails";
import { DEMO_CONFIG } from "@/fixtures/demo";
import { freeSlots, pickTwo, preferenceFilter } from "@/core/agent/scheduling";
import { localParts } from "@/core/time";
import { canTransition, TRANSITIONS } from "@/core/agent/state-machine";
import { computeScore } from "@/core/agent/scoring";
import { newLead } from "@/core/lead";
import { MONDAY_10H, setup, QUALIFIED } from "./helpers";
import { runDue, startOutbound, sellerVerdict, markMeeting } from "@/core/agent/proactive";
import { TenantConfigSchema } from "@/core/types";

const ctx = { config: DEMO_CONFIG, mustIdentify: false, factCorpus: "R$ 890 por mês; 120 clínicas", askedIfBot: false };

describe("revisor (RF-34.6, RF-30, RNF-08)", () => {
  it("aprova mensagem dentro das regras", () => {
    expect(reviewReply(["Entendi, Carla. Onde o fechamento mais trava hoje?"], ctx)).toEqual([]);
  });
  it("reprova tamanho, balões, abreviação, clichê, link encurtado, emoji e duas perguntas", () => {
    const v = reviewReply(["a".repeat(260), "Oi vc viu? só passando 😀", "bit.ly/x tudo bem?"], ctx);
    const all = v.join(" | ");
    for (const s of ["caracteres", "balões", "abreviações", "clichê", "link encurtado", "emojis", "mais de uma pergunta"]) expect(all).toContain(s);
  });
  it("bloqueia palavras proibidas e falsa urgência", () => {
    const v = reviewReply(["É barato e restam apenas duas vagas."], ctx).join();
    expect(v).toMatch(/proibidas/);
    expect(v).toMatch(/tática proibida/);
  });
  it("números-fato precisam estar na base; horários e datas não contam", () => {
    expect(unsupportedFacts("Atendemos 120 clínicas, planos a partir de R$ 890.", ctx)).toEqual([]);
    expect(unsupportedFacts("Quinta às 10h ou sexta (09/10) às 15h30?", ctx)).toEqual([]);
    expect(unsupportedFacts("Reduzimos 40% dos impostos", ctx)).toHaveLength(1);
  });
  it("não deixa afirmar que é humano", () => {
    expect(reviewReply(["Não sou robô, pode confiar."], ctx).join()).toMatch(/RNF-07/);
  });
  it("exige nome e empresa no primeiro contato", () => {
    expect(reviewReply(["Oi! Como funciona o fechamento aí?"], { ...ctx, mustIdentify: true }).join()).toMatch(/nome e empresa/);
  });
});

describe("agenda (RF-06, RF-14)", () => {
  const lead = newLead({ id: "x", tenantId: "demo", phone: "5511", now: MONDAY_10H });
  it("gera horários só dentro da disponibilidade e com antecedência mínima", () => {
    const slots = freeSlots(DEMO_CONFIG, DEMO_CONFIG.meetings.sellers, [], MONDAY_10H);
    expect(slots.length).toBeGreaterThan(10);
    const first = localParts(new Date(slots[0].startsAt), "America/Sao_Paulo");
    expect(first.hour * 60 + first.minute).toBeGreaterThanOrEqual(12 * 60); // 10h + 2h
    for (const s of slots) {
      const p = localParts(new Date(s.startsAt), "America/Sao_Paulo");
      expect([1, 2, 3, 4, 5]).toContain(p.weekday);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(p.hour).toBeLessThan(17);
    }
    void lead;
  });
  it("propõe dois horários em dias e períodos diferentes", () => {
    const slots = freeSlots(DEMO_CONFIG, DEMO_CONFIG.meetings.sellers, [], MONDAY_10H);
    const [a, b] = pickTwo(slots, "America/Sao_Paulo");
    const pa = localParts(new Date(a.startsAt), "America/Sao_Paulo");
    const pb = localParts(new Date(b.startsAt), "America/Sao_Paulo");
    expect(pa.day).not.toBe(pb.day);
    expect(pa.hour < 12).not.toBe(pb.hour < 12);
  });
  it("respeita preferência do lead", () => {
    const slots = freeSlots(DEMO_CONFIG, DEMO_CONFIG.meetings.sellers, [], MONDAY_10H);
    const two = pickTwo(slots, "America/Sao_Paulo", preferenceFilter("sexta de manhã", "America/Sao_Paulo"));
    for (const s of two) {
      const p = localParts(new Date(s.startsAt), "America/Sao_Paulo");
      expect(p.weekday).toBe(5);
      expect(p.hour).toBeLessThan(12);
    }
  });
  it("não oferece horário ocupado", () => {
    const busy = freeSlots(DEMO_CONFIG, DEMO_CONFIG.meetings.sellers, [], MONDAY_10H).slice(0, 1).map((s) => ({ ...s }));
    const slots = freeSlots(DEMO_CONFIG, DEMO_CONFIG.meetings.sellers, busy, MONDAY_10H);
    expect(slots.find((s) => s.startsAt === busy[0].startsAt)).toBeUndefined();
  });
});

describe("máquina de estados (RF-27)", () => {
  it("abertura não pula direto para pedido ou bastão", () => {
    expect(canTransition("abertura", "pedido")).toBe(false);
    expect(canTransition("qualificacao", "pedido")).toBe(false);
    expect(canTransition("qualificacao", "bastao")).toBe(false);
  });
  it("todo estado pode ir para humano ou encerrado", () => {
    for (const s of Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]) {
      expect(TRANSITIONS[s].includes("humano") || s === "humano").toBe(true);
    }
  });
});

describe("pontuação (RF-42)", () => {
  it("soma perfil e comportamento e perde pontos por inatividade", () => {
    const l = newLead({ id: "x", tenantId: "demo", phone: "1", now: MONDAY_10H });
    l.criteria = QUALIFIED;
    l.signals = ["respondeu", "aceitou_proximo_passo"];
    l.lastInboundAt = MONDAY_10H.toISOString();
    const fresh = computeScore(l, DEMO_CONFIG, MONDAY_10H);
    expect(fresh).toBe(25 + 15 + 10 + 10 + 20);
    const stale = computeScore(l, DEMO_CONFIG, new Date(MONDAY_10H.getTime() + 21 * 86400000));
    expect(stale).toBe(fresh - 15);
  });
});

describe("onboarding (RF-01 a RF-09)", () => {
  it("rejeita PIC com menos de 3 critérios", () => {
    const bad = structuredClone(DEMO_CONFIG);
    bad.profiles[0].positive = ["só um"];
    expect(TenantConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe("cadência e ações proativas", () => {
  it("follow-up fora da janela de 24 h usa modelo aprovado; após 2 sem resposta sugere trocar de canal", async () => {
    const t = setup(() => ({ reply: ["Uma clínica do mesmo porte reduziu o fechamento de 12 para 4 dias. Faria diferença para vocês?"] }), {
      lead: {
        flowState: "qualificacao",
        lastInboundAt: "2026-10-01T13:00:00Z",
        cadenceStartedAt: "2026-10-01T13:00:00Z",
        nextActionAt: "2026-10-05T12:00:00Z",
        nextActionKind: "follow_up",
      },
    });
    t.repo.configs.get("demo")!.offer.cases[0].result = "reduziu o fechamento de 12 para 4 dias";
    const r1 = await runDue(t.deps);
    expect(r1[0].action).toBe("follow_up");
    expect(t.messenger.outbox[0].template).toBe("follow_up_v1");
    expect(t.lead().unansweredAttempts).toBe(1);

    t.clock.current = new Date(t.lead().nextActionAt!);
    await runDue(t.deps);
    expect(t.notifier.tenant.some((n) => n.kind === "trocar_canal")).toBe(true);
  });

  it("não envia fora do horário comercial: adia para a janela", async () => {
    const t = setup(() => ({ reply: ["x"] }), { lead: { nextActionAt: "2026-10-05T01:00:00Z", nextActionKind: "follow_up" } });
    t.clock.current = new Date("2026-10-05T01:30:00Z"); // 22h30 de domingo em SP
    const r = await runDue(t.deps);
    expect(r[0].action).toBe("adiado:fora_do_horario");
    expect(t.messenger.outbox).toHaveLength(0);
  });

  it("pausa envios ativos quando a qualidade do número cai (RF-38)", async () => {
    const t = setup(() => ({ reply: ["x"] }), { lead: { nextActionAt: "2026-10-05T12:00:00Z", nextActionKind: "follow_up" } });
    t.repo.health.quality = "RED";
    const r = await runDue(t.deps);
    expect(r[0].action).toBe("adiado:numero_pausado");
  });

  it("frio sem opt-in não recebe mensagem (RF-39)", async () => {
    const t = setup(() => ({ reply: ["x"] }), { lead: { source: "frio_optin", optIn: false } });
    expect(await startOutbound(t.deps, "L1")).toEqual([]);
    expect(t.repo.events.at(-1)!.type).toBe("bloqueado_sem_optin");
  });

  it("reengajamento usa modelo citando a origem", async () => {
    const t = setup(() => ({ reply: ["x"] }), { lead: { source: "reengajamento", originNote: "participou do nosso evento de gestão em março" } });
    const sent = await startOutbound(t.deps, "L1");
    expect(sent[0]).toContain("participou do nosso evento");
    expect(t.lead().nextActionAt).toBeDefined();
  });

  it("lembretes 24 h e 1 h; no-show gera nova tentativa", async () => {
    const t = setup(() => ({ reply: ["x"] }));
    const lead = t.lead();
    lead.meeting = { id: "m1", sellerId: "marcos", startsAt: "2026-10-07T13:00:00Z", endsAt: "2026-10-07T13:30:00Z", status: "agendada", remindersSent: [] };
    lead.nextActionAt = "2026-10-06T13:00:00Z";
    lead.nextActionKind = "lembrete";
    t.repo.leads.set("L1", lead);
    t.clock.current = new Date("2026-10-06T13:00:00Z");
    await runDue(t.deps);
    expect(t.lead().meeting!.remindersSent).toEqual(["24h"]);
    t.clock.current = new Date(t.lead().nextActionAt!);
    await runDue(t.deps);
    expect(t.lead().meeting!.remindersSent).toEqual(["24h", "1h"]);
    expect(t.lead().nextActionKind).toBe("reagendar");

    await markMeeting(t.deps, "L1", "no_show");
    await runDue(t.deps);
    expect(t.lead().flowState).toBe("pedido");
    expect(t.lead().proposedSlots.length).toBe(2);
  });

  it("devolução do vendedor vai para a fila de revisão (RF-32)", async () => {
    const t = setup(() => ({ reply: ["x"] }));
    await sellerVerdict(t.deps, "L1", false, "não tinha orçamento");
    expect(t.lead().stage).toBe("devolvida");
    expect(t.repo.reviews[0].reason).toBe("devolucao_vendedor");
  });
});
