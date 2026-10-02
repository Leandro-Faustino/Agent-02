import type { FlowState, Lead, TenantConfig } from "../types";
import type { NextAction, TurnAnalysis } from "./analysis";
import { isOutOfProfile, requiredSatisfied, shouldNurture } from "./qualification";

/**
 * RF-27 — máquina de estados. O modelo sugere; o código decide.
 * Só transições listadas aqui são possíveis; nenhuma etapa é pulada.
 */
export const TRANSITIONS: Record<FlowState, FlowState[]> = {
  abertura: ["qualificacao", "objecao", "follow_up", "humano", "encerrado", "nutricao"],
  qualificacao: ["qualificacao", "sonho", "objecao", "follow_up", "nutricao", "humano", "encerrado"],
  sonho: ["sonho", "pedido", "objecao", "follow_up", "nutricao", "humano", "encerrado"],
  pedido: ["pedido", "bastao", "objecao", "follow_up", "nutricao", "humano", "encerrado"],
  objecao: ["objecao", "qualificacao", "sonho", "pedido", "bastao", "follow_up", "nutricao", "humano", "encerrado"],
  bastao: ["bastao", "pedido", "follow_up", "humano", "encerrado"],
  follow_up: ["follow_up", "qualificacao", "sonho", "pedido", "objecao", "nutricao", "humano", "encerrado"],
  nutricao: ["nutricao", "qualificacao", "sonho", "pedido", "objecao", "follow_up", "humano", "encerrado"],
  humano: ["humano", "qualificacao", "sonho", "pedido", "encerrado"],
  encerrado: ["encerrado", "qualificacao", "sonho", "pedido", "humano"],
};

export function canTransition(from: FlowState, to: FlowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type DecisionKind =
  | "continuar"
  | "descartar_fora_do_perfil"
  | "descartar_menor"
  | "transferir_humano"
  | "tratar_objecao"
  | "recuar_apos_duas_objecoes"
  | "agendar_retorno_pedido_pelo_lead"
  | "reservar_horario"
  | "propor_horario"
  | "vender_sonho"
  | "nutrir";

export interface Decision {
  next: FlowState;
  kind: DecisionKind;
  reason: string;
}

/** Onde o lead está no caminho principal, a partir do que já sabemos dele. */
export function flowPosition(lead: Lead, config: TenantConfig): FlowState {
  if (!requiredSatisfied(lead, config)) return "qualificacao";
  if (config.goal === "coleta_informacoes") return "nutricao";
  if (!lead.dreamDescribed) return "sonho";
  return "pedido";
}

/**
 * Decide a próxima etapa. `lead` já tem a memória do turno aplicada
 * (critérios, sonho, objeções consecutivas).
 */
export function decide(lead: Lead, a: TurnAnalysis, config: TenantConfig): Decision {
  const from = lead.flowState;
  const go = (next: FlowState, kind: DecisionKind, reason: string): Decision => {
    if (!canTransition(from, next)) {
      // Nunca pula etapas: se a transição não existe, fica onde está.
      return { next: from, kind: "continuar", reason: `transição ${from}→${next} bloqueada (${reason})` };
    }
    return { next, kind, reason };
  };

  if (a.flags.minorSuspected) return go("encerrado", "descartar_menor", "possível menor de idade (RNF-09)");
  if (
    a.flags.wantsHuman ||
    a.flags.irritated ||
    a.flags.sensitiveTopic ||
    a.intent === "pede_humano" ||
    a.intent === "suporte_cliente_ativo" ||
    a.confidence < config.limits.minConfidence
  ) {
    const why = a.flags.wantsHuman || a.intent === "pede_humano"
      ? "lead pediu pessoa"
      : a.flags.irritated
        ? "lead irritado"
        : a.flags.sensitiveTopic
          ? "assunto sensível"
          : a.intent === "suporte_cliente_ativo"
            ? "suporte de cliente ativo"
            : `confiança baixa (${a.confidence.toFixed(2)})`;
    return go("humano", "transferir_humano", why);
  }

  if (isOutOfProfile(lead) || a.intent === "fora_do_perfil") {
    return go("encerrado", "descartar_fora_do_perfil", "lead fora do PIC (P7)");
  }

  if (lead.consecutiveObjections >= 2) {
    return go("follow_up", "recuar_apos_duas_objecoes", "duas objeções seguidas (P15)");
  }

  if (a.objection) {
    return go("objecao", "tratar_objecao", `objeção ${a.objection.type} (P14)`);
  }

  if (a.slotChoice != null && lead.proposedSlots[a.slotChoice]) {
    return go("bastao", "reservar_horario", "lead aceitou horário proposto");
  }

  if (a.followUpDate) {
    return go("follow_up", "agendar_retorno_pedido_pelo_lead", "lead pediu retomar em data definida");
  }

  if (shouldNurture(lead)) return go("nutricao", "nutrir", "perfil certo, sem dor clara agora (P9)");

  const pos = flowPosition(lead, config);
  if (pos === "nutricao") return go("nutricao", "nutrir", "objetivo de coleta de informações concluído");
  if (pos === "pedido") return go("pedido", "propor_horario", "três testes ok e sonho descrito (P5, P4)");
  if (pos === "sonho") return go("sonho", "vender_sonho", "qualificado; falta o lead descrever o ideal (P4)");
  return go("qualificacao", "continuar", "critérios obrigatórios pendentes");
}

/** Ação que a resposta redigida precisa refletir para cada decisão. */
const EXPECTED_ACTION: Partial<Record<DecisionKind, NextAction[]>> = {
  descartar_fora_do_perfil: ["descartar"],
  descartar_menor: ["descartar"],
  recuar_apos_duas_objecoes: ["agendar_retorno"],
  propor_horario: ["propor_horario"],
  vender_sonho: ["vender_sonho"],
  nutrir: ["nutrir", "agendar_retorno"],
  tratar_objecao: ["tratar_objecao"],
};

/** Se a resposta do modelo não combina com a decisão do código, redige de novo. */
export function needsRedraft(d: Decision, a: TurnAnalysis): boolean {
  const expected = EXPECTED_ACTION[d.kind];
  return !!expected && !expected.includes(a.suggestedNextAction);
}
