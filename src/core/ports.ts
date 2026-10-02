import type { ChatMessage, Lead, Slot, TenantConfig, Meeting } from "./types";
import type { TurnAnalysis } from "./agent/analysis";

/* ------------------------------------------------------------------ */
/* RF-31 — modelo de linguagem atrás de interface própria.             */
/* ------------------------------------------------------------------ */

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TurnRequest {
  /** Bloco fixo (metodologia) — estável, bom para cache. */
  methodology: string;
  /** Bloco da empresa cliente — estável por cliente. */
  tenantContext: string;
  /** Memória do lead + etapa atual + instruções do turno. */
  turnContext: string;
  history: ChatMessage[];
  /** Correções de uma tentativa anterior reprovada no revisor (RF-34.6). */
  revisionNotes?: string[];
}

export interface LlmProvider {
  /** Um turno: redige a resposta e devolve a saída estruturada (RF-28). */
  runTurn(req: TurnRequest): Promise<{ analysis: TurnAnalysis; usage: LlmUsage }>;
  /** Texto livre curto (ex.: descrever imagem/PDF, simulador de lead, rubrica). */
  complete(system: string, user: string, opts?: { maxTokens?: number; attachments?: Attachment[] }): Promise<{ text: string; usage: LlmUsage }>;
}

export interface Attachment {
  kind: "image" | "pdf";
  mimeType: string;
  base64: string;
}

/* ------------------------------------------------------------------ */
/* RF-29 — ferramentas do agente                                       */
/* ------------------------------------------------------------------ */

export interface CalendarPort {
  /** Horários livres reais, já respeitando regras do RF-06. */
  findSlots(config: TenantConfig, lead: Lead, from: Date, count: number): Promise<Slot[]>;
  /** Reserva atômica. Retorna null se o horário já foi tomado. */
  book(config: TenantConfig, lead: Lead, slot: Slot): Promise<Meeting | null>;
  cancel(tenantId: string, meetingId: string): Promise<void>;
}

export interface KnowledgeHit {
  id: string;
  content: string;
  source: string;
  score: number;
}

export interface KnowledgeBasePort {
  /** Busca isolada por cliente (RNF-02). */
  search(tenantId: string, query: string, k?: number): Promise<KnowledgeHit[]>;
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  purpose: "follow_up" | "nutricao" | "reengajamento" | "lembrete" | "primeiro_contato" | "gatilho";
  status: "aprovado" | "pendente" | "rejeitado";
  /** Corpo com {{1}}, {{2}}... */
  body: string;
  variables: string[];
}

export interface OutboundResult {
  externalId?: string;
  ok: boolean;
  error?: string;
}

export interface MessengerPort {
  sendText(tenantId: string, to: string, text: string): Promise<OutboundResult>;
  sendTemplate(tenantId: string, to: string, template: WhatsAppTemplate, params: string[]): Promise<OutboundResult>;
}

export interface NumberHealth {
  quality: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  messagingLimit: string;
  sentToday: number;
  blocksLast7d: number;
  paused: boolean;
}

export interface Repository {
  getConfig(tenantId: string): Promise<TenantConfig | null>;
  getLead(leadId: string): Promise<Lead | null>;
  saveLead(lead: Lead): Promise<void>;
  getHistory(leadId: string, limit?: number): Promise<ChatMessage[]>;
  appendMessage(msg: ChatMessage): Promise<void>;
  /** Leads com próxima ação vencida, ordenados pela pirâmide (RF-21). */
  dueLeads(now: Date, limit: number): Promise<Lead[]>;
  getTemplates(tenantId: string): Promise<WhatsAppTemplate[]>;
  /** Conta um envio ativo no volume diário do número (RF-09). */
  countSend(tenantId: string): Promise<void>;
  getNumberHealth(tenantId: string): Promise<NumberHealth>;
  /** RNF-04 — log por turno. */
  logTurn(entry: TurnLog): Promise<void>;
  /** CRM: mudanças de estágio, passagem de bastão etc. (RF-40) */
  logEvent(tenantId: string, leadId: string, type: string, payload: Record<string, unknown>): Promise<void>;
  /** RF-32 — fila de revisão. */
  enqueueReview(tenantId: string, leadId: string, reason: string, payload: Record<string, unknown>): Promise<void>;
}

export interface TurnLog {
  tenantId: string;
  leadId: string;
  at: string;
  input: string;
  stateBefore: string;
  stateAfter: string;
  analysis: TurnAnalysis | null;
  tools: { name: string; input: unknown; output: unknown }[];
  output: string[];
  guardrailViolations: string[];
  costUsd: number;
}

/** Notificações ao vendedor e ao cliente (passagem do bastão, alertas). */
export interface NotifierPort {
  notifySeller(config: TenantConfig, sellerId: string, payload: { leadId: string; summary: string; mode: HandoffMode }): Promise<void>;
  notifyTenant(tenantId: string, kind: "escalonamento" | "trocar_canal" | "qualidade_numero" | "menor_idade", payload: Record<string, unknown>): Promise<void>;
}

export type HandoffMode = "ao_vivo" | "reuniao_agendada" | "apresentacao";

export interface Clock {
  now(): Date;
}

export interface Deps {
  repo: Repository;
  llm: LlmProvider;
  calendar: CalendarPort;
  kb: KnowledgeBasePort;
  messenger: MessengerPort;
  notifier: NotifierPort;
  clock: Clock;
  ids: () => string;
}
