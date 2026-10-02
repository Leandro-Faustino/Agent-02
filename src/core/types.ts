import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Configuração por empresa cliente (RF-01 a RF-09)                    */
/* ------------------------------------------------------------------ */

export const ObjectionTypeSchema = z.enum([
  "sem_interesse",
  "sem_tempo",
  "manda_informacoes",
  "ja_tem_fornecedor",
  "sem_orcamento",
  "faz_internamente",
  "nao_decide",
  "ja_usou_nao_deu_certo",
  // Objeções de próximo passo (RF-16)
  "manda_email",
  "me_chama_depois",
  "eu_te_chamo",
  "outra",
]);
export type ObjectionType = z.infer<typeof ObjectionTypeSchema>;

/** RF-01 — Perfil ideal de cliente. 3 a 5 critérios positivos, até 5 perfis. */
export const IcpProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  positive: z.array(z.string().min(1)).min(3).max(5),
  negative: z.array(z.string().min(1)).default([]),
  decisionRoles: z.array(z.string()).default([]),
  /** RF-02 — Mapa de dores, alimenta as pontes. */
  pains: z.object({
    challenges: z.array(z.string()).min(1),
    sleeplessNights: z.array(z.string()).default([]),
    frustrations: z.array(z.string()).default([]),
    fears: z.array(z.string()).default([]),
    mostImportant: z.array(z.string()).default([]),
    currentSpend: z.string().optional(),
    realWants: z.array(z.string()).default([]),
  }),
  /** Ponte padrão por segmento (RF-11). */
  bridges: z.array(z.string()).min(1),
  /** RF-07 — ajuste de tom por perfil. */
  toneOverride: z.string().optional(),
});
export type IcpProfile = z.infer<typeof IcpProfileSchema>;

/** RF-03 — Oferta e prova. O agente nunca inventa prova social. */
export const OfferSchema = z.object({
  product: z.string().min(1),
  summary: z.string().min(1),
  authorizedPrices: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  differentiators: z.array(z.string()).default([]),
  cases: z.array(z.object({ client: z.string(), result: z.string(), authorized: z.literal(true) })).default([]),
  testimonials: z.array(z.object({ author: z.string(), text: z.string(), authorized: z.literal(true) })).default([]),
  provenNumbers: z.array(z.string()).default([]),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
});
export type Offer = z.infer<typeof OfferSchema>;

/** RF-04 — Critérios de qualificação. */
export const QualificationCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  question: z.string().min(1),
  required: z.boolean(),
});
export type QualificationCriterion = z.infer<typeof QualificationCriterionSchema>;

/** RF-05 — Banco de objeções: borda, perturbar, pedir. */
export const ObjectionResponseSchema = z.object({
  type: ObjectionTypeSchema,
  label: z.string(),
  edge: z.string(),
  disrupt: z.string(),
  ask: z.string(),
});
export type ObjectionResponse = z.infer<typeof ObjectionResponseSchema>;

/** RF-06 — Agenda e regras de reunião. */
export const SellerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  territories: z.array(z.string()).default([]),
  segments: z.array(z.string()).default([]),
  /** Dias da semana (0=domingo) e horários permitidos "HH:MM-HH:MM". */
  availability: z.array(z.object({ weekday: z.number().int().min(0).max(6), from: z.string(), to: z.string() })).min(1),
  /** Se pode entrar na conversa na hora (modo preferido de passagem, RF-18). */
  canJoinLive: z.boolean().default(false),
});
export type Seller = z.infer<typeof SellerSchema>;

export const MeetingRulesSchema = z.object({
  sellers: z.array(SellerSchema).min(1),
  durationMinutes: z.number().int().min(10).max(180).default(30),
  bufferMinutes: z.number().int().min(0).default(15),
  minLeadTimeHours: z.number().min(0).default(2),
  horizonDays: z.number().int().min(1).max(30).default(10),
  distribution: z.enum(["rodizio", "territorio", "segmento"]).default("rodizio"),
  format: z.enum(["video", "presencial", "ligacao"]).default("video"),
  meetingLink: z.string().url().optional(),
});
export type MeetingRules = z.infer<typeof MeetingRulesSchema>;

/** RF-07 — Persona e tom. */
export const PersonaSchema = z.object({
  agentName: z.string().min(1),
  companyName: z.string().min(1),
  signature: z.string().optional(),
  formality: z.enum(["formal", "neutro", "informal"]).default("neutro"),
  forbiddenWords: z.array(z.string()).default([]),
  brandExpressions: z.array(z.string()).default([]),
  /** Padrão: nenhum emoji. Cliente pode liberar no máximo um por mensagem (RF-34). */
  allowOneEmoji: z.boolean().default(false),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** RF-08 — Objetivo de conversão. */
export const ConversionGoalSchema = z.enum(["reuniao", "fechamento_direto", "coleta_informacoes"]);
export type ConversionGoal = z.infer<typeof ConversionGoalSchema>;

/** RF-09 — Limites operacionais; RF-22 cadência; RF-37 horário. */
export const LimitsSchema = z.object({
  timezone: z.string().default("America/Sao_Paulo"),
  sendWindow: z.object({ from: z.string().default("08:00"), to: z.string().default("19:00"), weekdays: z.array(z.number()).default([1, 2, 3, 4, 5]) }),
  replyOutsideHours: z.boolean().default(true),
  dailyVolumePerNumber: z.number().int().min(1).default(250),
  maxAttemptsPerLead: z.number().int().min(1).default(6),
  minIntervalMinutes: z.number().int().min(1).default(60),
  cadenceDays: z.array(z.number().int().min(0)).default([0, 1, 3, 7, 14]),
  cycleDays: z.number().int().default(21),
  debounceSeconds: z.number().int().min(0).max(60).default(8),
  /** RF-42 — limite que separa prospect de lead (Marketo: 65). */
  scoreThreshold: z.number().int().min(0).max(100).default(65),
  /** RF-20 — abaixo disso, transfere para humano. */
  minConfidence: z.number().min(0).max(1).default(0.55),
  /** RNF-13 — dias até anonimizar descartados. */
  retentionDays: z.number().int().min(1).default(180),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const TenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  profiles: z.array(IcpProfileSchema).min(1).max(5),
  offer: OfferSchema,
  qualification: z.array(QualificationCriterionSchema).min(1),
  objections: z.array(ObjectionResponseSchema).min(3),
  meetings: MeetingRulesSchema,
  persona: PersonaSchema,
  goal: ConversionGoalSchema.default("reuniao"),
  limits: LimitsSchema,
  /** RF-40 — integração com CRMs externos e avisos ao time (passagem do bastão, alertas). */
  integrations: z.object({ webhookUrl: z.string().url().optional(), webhookSecret: z.string().optional() }).default({}),
  /** O agente só opera após aprovação do onboarding pelo cliente. */
  approved: z.boolean().default(false),
});
export type TenantConfig = z.infer<typeof TenantConfigSchema>;

/* ------------------------------------------------------------------ */
/* Lead e conversa                                                     */
/* ------------------------------------------------------------------ */

/** RF-41 — Estágios do lead. */
export type Stage =
  | "prospect"
  | "em_conversa"
  | "qualificado"
  | "reuniao_agendada"
  | "reuniao_realizada"
  | "oportunidade_aceita"
  | "devolvida"
  | "nutricao"
  | "descartado";

/** RF-27 — Etapas do fluxo controladas por código. */
export type FlowState =
  | "abertura"
  | "qualificacao"
  | "sonho"
  | "pedido"
  | "objecao"
  | "bastao"
  | "follow_up"
  | "nutricao"
  | "humano"
  | "encerrado";

/** RF-21 — Origem do contato, define a prioridade na fila. */
export type LeadSource =
  | "inbound"
  | "janela_compra"
  | "indicacao"
  | "reengajamento"
  | "nutricao"
  | "frio_optin";

export type LegalBasis = "consentimento" | "legitimo_interesse";

export type BehaviorSignal = "respondeu" | "respondeu_rapido" | "perguntou_preco" | "aceitou_proximo_passo" | "descreveu_sonho";

export interface CriterionState {
  value: string;
  satisfied: boolean | null;
}

export interface ObjectionRecord {
  type: ObjectionType;
  text: string;
  at: string;
  reverted: boolean;
}

export interface Meeting {
  id: string;
  sellerId: string;
  startsAt: string;
  endsAt: string;
  status: "agendada" | "confirmada" | "realizada" | "no_show" | "cancelada";
  remindersSent: ("24h" | "1h")[];
}

export interface TriggerEvent {
  id: string;
  description: string;
  date: string;
  fired: boolean;
}

export interface Lead {
  id: string;
  tenantId: string;
  phone: string;
  name?: string;
  company?: string;
  role?: string;
  profileId?: string;
  source: LeadSource;
  /** Texto da origem para a primeira mensagem (RF-39), ex.: "baixou nosso material sobre X". */
  originNote?: string;
  legalBasis: LegalBasis;
  optIn: boolean;
  optedOut: boolean;
  stage: Stage;
  flowState: FlowState;
  /** Etapa a retomar depois de tratar uma objeção. */
  resumeState?: FlowState;
  score: number;
  /** Sinais de comportamento para a pontuação (RF-42). */
  signals: BehaviorSignal[];
  criteria: Record<string, CriterionState>;
  /** RF-13 — concordâncias guardadas para usar depois. */
  yeses: string[];
  /** Frases do próprio lead para o resumo do vendedor (RF-18). */
  quotes: string[];
  objections: ObjectionRecord[];
  consecutiveObjections: number;
  questionsForSeller: string[];
  dreamDescribed: boolean;
  proposedSlots: Slot[];
  meeting?: Meeting;
  triggers: TriggerEvent[];
  /** Follow-ups sem resposta seguidos. */
  unansweredAttempts: number;
  totalAttempts: number;
  cadenceStartedAt?: string;
  nextActionAt?: string;
  nextActionKind?: "follow_up" | "nutricao" | "lembrete" | "gatilho" | "reagendar";
  lastInboundAt?: string;
  lastOutboundAt?: string;
  discardReason?: string;
  handoffReason?: string;
  channelSwitchSuggested: boolean;
  /** Variante de abertura/objeção em teste A/B (RF-44). */
  experimentVariant?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Slot {
  sellerId: string;
  startsAt: string;
  endsAt: string;
}

export type MessageRole = "lead" | "agente" | "vendedor" | "sistema";

export interface ChatMessage {
  id: string;
  leadId: string;
  role: MessageRole;
  text: string;
  at: string;
  /** Mídia recebida já convertida em texto (RF-35). */
  media?: { kind: "audio" | "image" | "document"; transcript?: string };
  templateName?: string;
}

/** Mensagem recebida antes da conversão para texto. */
export interface InboundMessage {
  externalId: string;
  at: string;
  kind: "text" | "audio" | "image" | "document" | "other";
  text?: string;
  mediaId?: string;
  mimeType?: string;
}
