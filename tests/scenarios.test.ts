import { describe, expect, it } from "vitest";
import { setup, QUALIFIED } from "./helpers";
import { runDue } from "@/core/agent/proactive";

/**
 * Cenários obrigatórios do documento de requisitos (Critérios de aceite).
 * O modelo é roteirizado: aqui testamos o que o CÓDIGO garante.
 */
describe("cenários obrigatórios", () => {
  it("lead fora do PIC: encerra com cortesia, pede indicação e descarta com motivo", async () => {
    const t = setup((req, call) =>
      call === 0
        ? {
            reply: ["Entendi. E quantas pessoas trabalham com você hoje?"],
            intent: "responde_pergunta",
            criteria: [{ id: "encaixe_pic", value: "dentista autônoma, sem equipe", satisfied: false }],
            suggestedNextAction: "continuar_qualificacao",
          }
        : {
            reply: ["Obrigada por contar, Carla. Nosso trabalho é focado em clínicas com equipe. Conhece alguma clínica que poderia se beneficiar?"],
            suggestedNextAction: "descartar",
            referral: null,
          },
    );
    const r = await t.say("Sou dentista autônoma, atendo sozinha no consultório");
    expect(r.decision).toBe("descartar_fora_do_perfil");
    expect(t.llm.calls).toHaveLength(2);
    expect(t.llm.calls[1].turnContext).toContain("fora do perfil");
    expect(t.lead().stage).toBe("descartado");
    expect(t.lead().discardReason).toMatch(/PIC/);
    expect(r.sent[0]).toMatch(/Conhece alguma/);
  });

  it("decisor ocupado: borda + perturbar + dois horários; recua na segunda recusa", async () => {
    const t = setup(
      (req) =>
        req.turnContext.includes("Objeções seguidas: 1") || req.turnContext.includes("duas objeções")
          ? {
              reply: ["Sem problema, Carla, não vou insistir. Volto a falar com você daqui a duas semanas."],
              objection: { type: "sem_tempo", text: "não tenho tempo mesmo" },
              intent: "objecao",
              suggestedNextAction: "agendar_retorno",
            }
          : {
              reply: ["Imaginei. Por isso quero achar um horário que caiba na sua agenda. Terça às 9h ou quarta às 14h?"],
              objection: { type: "sem_tempo", text: "estou sem tempo" },
              intent: "objecao",
              suggestedNextAction: "tratar_objecao",
            },
      { lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true } },
    );
    const r1 = await t.say("Estou sem tempo essa semana");
    expect(r1.decision).toBe("tratar_objecao");
    expect(t.lead().proposedSlots).toHaveLength(2);
    expect(t.lead().flowState).toBe("objecao");

    const r2 = await t.say("Não tenho tempo mesmo");
    expect(r2.decision).toBe("recuar_apos_duas_objecoes");
    expect(t.lead().flowState).toBe("follow_up");
    expect(t.lead().nextActionKind).toBe("follow_up");
    const days = (new Date(t.lead().nextActionAt!).getTime() - t.clock.now().getTime()) / 86400000;
    expect(days).toBeGreaterThanOrEqual(13);
  });

  it("\"me manda informações\": classifica e mantém o pedido com horários", async () => {
    const t = setup(() => ({
      reply: ["Mando, sim. Para não te afogar em material, o que exatamente você quer ver?"],
      objection: { type: "manda_informacoes", text: "me manda informações" },
      intent: "objecao",
      suggestedNextAction: "tratar_objecao",
    }), { lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true } });
    const r = await t.say("Me manda informações por aqui");
    expect(r.decision).toBe("tratar_objecao");
    expect(t.lead().objections[0].type).toBe("manda_informacoes");
    expect(t.lead().nextActionAt).toBeDefined();
  });

  it("pergunta de preço: preço fora da base é barrado e corrigido; pergunta vai para o vendedor", async () => {
    const t = setup((req) =>
      req.revisionNotes
        ? {
            reply: ["Os planos começam em R$ 890 por mês; o valor exato depende do volume da clínica. O que mais pesa para você nessa decisão?"],
            intent: "pergunta_preco",
            questionsForSeller: ["Qual o valor para 3 CNPJs?"],
          }
        : {
            reply: ["Custa R$ 500 por mês. O que mais pesa para você?"],
            intent: "pergunta_preco",
            questionsForSeller: ["Qual o valor para 3 CNPJs?"],
          },
    );
    const r = await t.say("Quanto custa? Tenho 3 CNPJs");
    expect(r.sent[0]).toContain("R$ 890");
    expect(r.sent.join(" ")).not.toContain("500");
    expect(t.lead().questionsForSeller).toContain("Qual o valor para 3 CNPJs?");
    expect(t.lead().signals).toContain("perguntou_preco");
    expect(t.repo.turns.at(-1)!.guardrailViolations.join()).toMatch(/fato não encontrado/);
  });

  it("não é o decisor: pede quem decide (autoridade reprovada não descarta)", async () => {
    const t = setup(() => ({
      reply: ["Obrigada por avisar. Quem cuida disso aí?"],
      objection: { type: "nao_decide", text: "não sou eu quem decide" },
      criteria: [{ id: "autoridade", value: "recepcionista, não decide", satisfied: false }],
      intent: "objecao",
      suggestedNextAction: "tratar_objecao",
    }));
    const r = await t.say("Não sou eu quem decide isso");
    expect(r.decision).toBe("tratar_objecao");
    expect(t.lead().stage).not.toBe("descartado");
  });

  it("lead pede humano: transfere sem passar pelo modelo", async () => {
    const t = setup(() => ({ reply: ["não deveria ser chamado"] }));
    const r = await t.say("Quero falar com uma pessoa, por favor");
    expect(t.llm.calls).toHaveLength(0);
    expect(r.decision).toBe("transferir_humano");
    expect(t.lead().flowState).toBe("humano");
    expect(t.notifier.tenant[0].kind).toBe("escalonamento");
  });

  it("lead irritado: transfere para pessoa com mensagem fixa", async () => {
    const t = setup(() => ({ reply: ["Calma, deixa eu explicar melhor."], flags: { irritated: true } as never, intent: "outro" }));
    const r = await t.say("Que saco, já falei que isso não funciona!!!");
    expect(r.decision).toBe("transferir_humano");
    expect(r.sent[0]).toMatch(/pessoa da equipe/);
  });

  it("\"você é um robô?\": confirma que é assistente virtual", async () => {
    const t = setup((req) =>
      req.revisionNotes
        ? { reply: ["Sou a Ana, assistente virtual da Lumen Contábil. Se preferir, chamo uma pessoa da equipe. Quer seguir comigo?"], intent: "pergunta_se_robo" }
        : { reply: ["Sou a Ana, da Lumen Contábil! Como posso ajudar?"], intent: "pergunta_se_robo" },
    );
    const r = await t.say("Você é um robô?");
    expect(r.sent[0]).toMatch(/assistente virtual/);
    expect(t.llm.calls).toHaveLength(2);
  });

  it("\"pare de me mandar mensagem\": opt-out imediato e cadência encerrada", async () => {
    const t = setup(() => ({ reply: ["x"] }), { lead: { nextActionAt: "2026-10-06T13:00:00Z", nextActionKind: "follow_up" } });
    const r = await t.say("Pare de me mandar mensagem");
    expect(r.decision).toBe("opt_out");
    expect(t.llm.calls).toHaveLength(0);
    expect(t.lead().optedOut).toBe(true);
    expect(t.lead().nextActionAt).toBeUndefined();
    expect(t.repo.events.some((e) => e.type === "opt_out")).toBe(true);
    t.clock.advance(60 * 24 * 3);
    const before = t.messenger.outbox.length;
    await runDue(t.deps);
    expect(t.messenger.outbox.length).toBe(before);
  });

  it("mensagens picadas e áudio: junta tudo e responde uma vez", async () => {
    const t = setup(() => ({ reply: ["Entendi, Carla. Onde o fechamento mais trava hoje?"], intent: "responde_pergunta" }));
    const msgs = [
      { id: "a", leadId: "L1", role: "lead" as const, text: "oi", at: t.clock.now().toISOString() },
      { id: "b", leadId: "L1", role: "lead" as const, text: "então", at: t.clock.now().toISOString() },
      { id: "c", leadId: "L1", role: "lead" as const, text: "[áudio]", at: t.clock.now().toISOString(), media: { kind: "audio" as const, transcript: "nosso fechamento atrasa todo mês" } },
    ];
    const { handleInbound } = await import("@/core/agent/engine");
    const r = await handleInbound(t.deps, "L1", msgs);
    expect(t.llm.calls).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(t.repo.turns[0].input).toBe("oi\nentão\nnosso fechamento atrasa todo mês");
  });

  it("lead aceita horário: reserva antes de confirmar e entrega resumo completo ao vendedor", async () => {
    const t = setup(
      () => ({ reply: ["Perfeito!"], intent: "aceita_horario", slotChoice: 0, quotes: ["quero parar de fechar o mês no dia 20"] }),
      { lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true, stage: "qualificado" } },
    );
    const { twoSlots } = await import("@/core/agent/engine");
    const lead = t.lead();
    lead.proposedSlots = await twoSlots(t.deps, t.config, lead, t.clock.now());
    t.repo.leads.set("L1", lead);

    const r = await t.say("Pode ser o primeiro horário");
    expect(r.decision).toBe("reservar_horario");
    expect(t.calendar.meetings).toHaveLength(1);
    expect(r.sent[0]).toMatch(/Combinado, Carla: reunião com Marcos/);
    expect(t.lead().stage).toBe("reuniao_agendada");
    expect(t.lead().nextActionKind).toBe("lembrete");
    const s = t.notifier.sellers[0];
    expect(s.sellerId).toBe("marcos");
    for (const field of ["Encaixe no PIC", "Dor", "Decisor", "Situação atual", "Prazo", "Objeções", "Frases do lead", "Próximo passo"]) {
      expect(s.summary).toContain(field);
    }
    expect(s.summary).toContain("quero parar de fechar o mês no dia 20");
  });

  it("horário ocupado na hora da reserva: não confirma e propõe outros", async () => {
    const t = setup(() => ({ reply: ["Ótimo"], intent: "aceita_horario", slotChoice: 0 }), {
      lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true },
    });
    const { twoSlots } = await import("@/core/agent/engine");
    const lead = t.lead();
    lead.proposedSlots = await twoSlots(t.deps, t.config, lead, t.clock.now());
    t.repo.leads.set("L1", lead);
    t.calendar.busy.push(lead.proposedSlots[0]);

    const r = await t.say("Fechado, o primeiro");
    expect(r.sent[0]).toMatch(/acabou de ser ocupado/);
    expect(t.lead().meeting).toBeUndefined();
    expect(t.lead().flowState).toBe("pedido");
  });
});

describe("regras de fluxo", () => {
  it("não pula a etapa do sonho: qualificado sem sonho vai para 'sonho', não para 'pedido'", async () => {
    const t = setup((req, call) =>
      call === 0
        ? { reply: ["Quinta às 10h ou sexta às 15h?"], criteria: Object.entries(QUALIFIED).map(([id, c]) => ({ id, ...c })), suggestedNextAction: "propor_horario" }
        : { reply: ["Se você pudesse desenhar o fechamento ideal, como ele seria?"], suggestedNextAction: "vender_sonho" },
      { lead: { flowState: "qualificacao" } },
    );
    const r = await t.say("Sou sócia, somos 20 na clínica e o fechamento atrasa até o dia 20");
    expect(r.decision).toBe("vender_sonho");
    expect(t.lead().flowState).toBe("sonho");
    expect(t.lead().stage).toBe("qualificado");
    expect(r.sent[0]).toMatch(/ideal/);
  });

  it("toda conversa termina com próximo passo (P16)", async () => {
    const t = setup(
      () => ({ reply: ["Oi, Carla, aqui é a Ana, assistente virtual da Lumen Contábil. Como funciona hoje o fechamento do mês aí na clínica?"], intent: "saudacao" }),
      { lead: { lastOutboundAt: undefined } },
    );
    await t.say("Oi, vi o anúncio");
    const l = t.lead();
    expect(l.flowState).toBe("qualificacao");
    expect(l.nextActionAt).toBeDefined();
  });

  it("revisor reprova duas vezes: não envia e chama uma pessoa", async () => {
    const t = setup(() => ({ reply: ["Oi vc tem 5 min? Veja bit.ly/abc"], intent: "outro" }));
    const r = await t.say("oi");
    expect(r.decision).toBe("transferir_humano");
    expect(r.sent.join()).not.toMatch(/bit\.ly/);
    expect(t.repo.reviews[0].reason).toBe("revisor_reprovou");
  });

  it("sem onboarding aprovado o agente não conversa (P1)", async () => {
    const t = setup(() => ({ reply: ["x"] }), { config: { approved: false } });
    const r = await t.say("oi");
    expect(r.decision).toBe("ignorado");
    expect(t.messenger.outbox).toHaveLength(0);
  });
});

describe("reabertura", () => {
  it("lead em nutrição que responde volta para a qualificação (RF-23)", async () => {
    const t = setup(() => ({ reply: ["Que bom ter notícias, Carla. Como está o fechamento do mês aí hoje?"], intent: "responde_pergunta" }), {
      lead: { stage: "nutricao", flowState: "nutricao", criteria: { encaixe_pic: QUALIFIED.encaixe_pic } },
    });
    await t.say("Oi, agora estamos com problema no fechamento");
    expect(t.lead().stage).toBe("em_conversa");
    expect(t.lead().flowState).toBe("qualificacao");
  });
});
