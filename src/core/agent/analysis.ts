import { z } from "zod/v4";

/**
 * RF-28 — saída estruturada a cada turno.
 * O modelo redige a resposta e classifica o que o lead disse; o código decide
 * as transições (RF-27). Sem min/max no esquema: limites são checados depois,
 * no revisor (guardrails), para manter o esquema compatível com saída estruturada.
 */
export const IntentSchema = z.enum([
  "responde_pergunta",
  "demonstra_interesse",
  "descreve_sonho",
  "objecao",
  "aceita_horario",
  "pede_outro_horario",
  "pergunta_preco",
  "pergunta_compra",
  "desvio",
  "fora_do_perfil",
  "pede_humano",
  "opt_out",
  "pergunta_se_robo",
  "suporte_cliente_ativo",
  "saudacao",
  "outro",
]);

export const NextActionSchema = z.enum([
  "continuar_qualificacao",
  "vender_sonho",
  "propor_horario",
  "tratar_objecao",
  "agendar_retorno",
  "descartar",
  "nutrir",
  "transferir_humano",
]);

export const TurnAnalysisSchema = z.object({
  reply: z.array(z.string()).describe("Um ou dois balões de até 250 caracteres cada, em português do Brasil."),
  intent: IntentSchema,
  objection: z
    .object({
      type: z.enum([
        "sem_interesse",
        "sem_tempo",
        "manda_informacoes",
        "ja_tem_fornecedor",
        "sem_orcamento",
        "faz_internamente",
        "nao_decide",
        "ja_usou_nao_deu_certo",
        "manda_email",
        "me_chama_depois",
        "eu_te_chamo",
        "outra",
      ]),
      text: z.string().describe("Trecho do lead que contém a objeção."),
    })
    .nullable(),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("id do critério de qualificação"),
        value: z.string().describe("o que o lead disse, resumido"),
        satisfied: z.boolean().nullable().describe("true atende, false não atende, null ainda incerto"),
      }),
    )
    .describe("Somente critérios que ganharam informação nova neste turno."),
  profileId: z.string().nullable().describe("id do perfil de cliente ideal que melhor encaixa, ou null"),
  leadData: z.object({ name: z.string().nullable(), company: z.string().nullable(), role: z.string().nullable() }),
  dreamDescribed: z.boolean().describe("O lead já descreveu como seria a situação ideal?"),
  yeses: z.array(z.string()).describe("Concordâncias novas do lead sobre dor e objetivo."),
  quotes: z.array(z.string()).describe("Frases literais e relevantes do lead para o vendedor."),
  slotChoice: z.number().nullable().describe("Índice (0 ou 1) do horário proposto que o lead aceitou, ou null."),
  timePreference: z.string().nullable().describe("Preferência de horário do lead quando recusa os propostos, ex.: 'segunda de manhã'."),
  followUpDate: z.string().nullable().describe("Data ISO 8601 que o lead pediu para retomar, se pediu."),
  referral: z.object({ name: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  questionsForSeller: z.array(z.string()).describe("Perguntas de preço, contrato ou técnicas sem resposta na base."),
  factsUsed: z.array(z.string()).describe("Fatos (preço, número, cliente, prazo) citados na resposta, copiados da base."),
  flags: z.object({
    wantsHuman: z.boolean(),
    irritated: z.boolean(),
    sensitiveTopic: z.boolean(),
    minorSuspected: z.boolean(),
    askedIfBot: z.boolean(),
  }),
  confidence: z.number().describe("0 a 1: confiança de que a resposta está correta e dentro da base."),
  suggestedNextAction: NextActionSchema,
});

export type TurnAnalysis = z.infer<typeof TurnAnalysisSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;

export function emptyAnalysis(reply: string[] = []): TurnAnalysis {
  return {
    reply,
    intent: "outro",
    objection: null,
    criteria: [],
    profileId: null,
    leadData: { name: null, company: null, role: null },
    dreamDescribed: false,
    yeses: [],
    quotes: [],
    slotChoice: null,
    timePreference: null,
    followUpDate: null,
    referral: null,
    questionsForSeller: [],
    factsUsed: [],
    flags: { wantsHuman: false, irritated: false, sensitiveTopic: false, minorSuspected: false, askedIfBot: false },
    confidence: 1,
    suggestedNextAction: "continuar_qualificacao",
  };
}
