import type {
  CalendarPort,
  Clock,
  Deps,
  KnowledgeBasePort,
  KnowledgeHit,
  LlmProvider,
  MessengerPort,
  NotifierPort,
  NumberHealth,
  OutboundResult,
  Repository,
  TurnLog,
  WhatsAppTemplate,
} from "@/core/ports";
import type { ChatMessage, Lead, Meeting, Slot, TenantConfig } from "@/core/types";
import { eligibleSellers, freeSlots, type Busy } from "@/core/agent/scheduling";
import { priorityOf } from "@/core/agent/cadence";

/** Implementações em memória: testes, simulador e bateria de avaliação. */

export class MemoryRepo implements Repository {
  configs = new Map<string, TenantConfig>();
  leads = new Map<string, Lead>();
  messages: ChatMessage[] = [];
  turns: TurnLog[] = [];
  events: { tenantId: string; leadId: string; type: string; payload: Record<string, unknown> }[] = [];
  reviews: { tenantId: string; leadId: string; reason: string; payload: Record<string, unknown> }[] = [];
  templates = new Map<string, WhatsAppTemplate[]>();
  health: NumberHealth = { quality: "GREEN", messagingLimit: "TIER_1K", sentToday: 0, blocksLast7d: 0, paused: false };

  async getConfig(id: string) {
    return this.configs.get(id) ?? null;
  }
  async getLead(id: string) {
    const l = this.leads.get(id);
    return l ? structuredClone(l) : null;
  }
  async saveLead(lead: Lead) {
    this.leads.set(lead.id, structuredClone(lead));
  }
  async getHistory(leadId: string, limit = 30) {
    return this.messages.filter((m) => m.leadId === leadId).slice(-limit);
  }
  async appendMessage(msg: ChatMessage) {
    this.messages.push(msg);
  }
  async dueLeads(now: Date, limit: number) {
    return [...this.leads.values()]
      .filter((l) => l.nextActionAt && new Date(l.nextActionAt) <= now)
      .sort((a, b) => priorityOf(a) - priorityOf(b) || a.nextActionAt!.localeCompare(b.nextActionAt!))
      .slice(0, limit)
      .map((l) => structuredClone(l));
  }
  async getTemplates(tenantId: string) {
    return this.templates.get(tenantId) ?? [];
  }
  async countSend() {
    this.health.sentToday += 1;
  }
  async getNumberHealth() {
    return this.health;
  }
  async logTurn(entry: TurnLog) {
    this.turns.push(entry);
  }
  async logEvent(tenantId: string, leadId: string, type: string, payload: Record<string, unknown>) {
    this.events.push({ tenantId, leadId, type, payload });
  }
  async enqueueReview(tenantId: string, leadId: string, reason: string, payload: Record<string, unknown>) {
    this.reviews.push({ tenantId, leadId, reason, payload });
  }
}

export class MemoryCalendar implements CalendarPort {
  busy: Busy[] = [];
  meetings: Meeting[] = [];
  private seq = 0;
  async findSlots(config: TenantConfig, lead: Lead, from: Date, count: number): Promise<Slot[]> {
    return freeSlots(config, eligibleSellers(config, lead, this.meetings.length), this.busy, from).slice(0, count);
  }
  async book(config: TenantConfig, lead: Lead, slot: Slot): Promise<Meeting | null> {
    const taken = this.busy.some((b) => b.sellerId === slot.sellerId && b.startsAt === slot.startsAt);
    if (taken) return null;
    this.busy.push(slot);
    const m: Meeting = { id: `m${++this.seq}`, sellerId: slot.sellerId, startsAt: slot.startsAt, endsAt: slot.endsAt, status: "agendada", remindersSent: [] };
    this.meetings.push(m);
    void config;
    void lead;
    return m;
  }
  async cancel(_tenantId: string, meetingId: string) {
    const m = this.meetings.find((x) => x.id === meetingId);
    if (m) {
      m.status = "cancelada";
      this.busy = this.busy.filter((b) => !(b.sellerId === m.sellerId && b.startsAt === m.startsAt));
    }
  }
}

/** Busca por sobreposição de palavras — suficiente para testes. */
export class MemoryKB implements KnowledgeBasePort {
  docs: { tenantId: string; id: string; content: string; source: string }[] = [];
  async search(tenantId: string, query: string, k = 5): Promise<KnowledgeHit[]> {
    const terms = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    return this.docs
      .filter((d) => d.tenantId === tenantId)
      .map((d) => ({ ...d, score: d.content.toLowerCase().split(/\W+/).filter((w) => terms.has(w)).length }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ tenantId: _t, ...hit }) => hit);
  }
}

export class FakeMessenger implements MessengerPort {
  outbox: { tenantId: string; to: string; text?: string; template?: string; params?: string[] }[] = [];
  async sendText(tenantId: string, to: string, text: string): Promise<OutboundResult> {
    this.outbox.push({ tenantId, to, text });
    return { ok: true, externalId: `wamid.${this.outbox.length}` };
  }
  async sendTemplate(tenantId: string, to: string, template: WhatsAppTemplate, params: string[]): Promise<OutboundResult> {
    this.outbox.push({ tenantId, to, template: template.name, params });
    return { ok: true, externalId: `wamid.${this.outbox.length}` };
  }
}

export class FakeNotifier implements NotifierPort {
  sellers: { sellerId: string; leadId: string; summary: string; mode: string }[] = [];
  tenant: { kind: string; payload: Record<string, unknown> }[] = [];
  async notifySeller(_c: TenantConfig, sellerId: string, p: { leadId: string; summary: string; mode: string }) {
    this.sellers.push({ sellerId, ...p });
  }
  async notifyTenant(_t: string, kind: string, payload: Record<string, unknown>) {
    this.tenant.push({ kind, payload });
  }
}

export class FixedClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
  advance(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60000);
  }
}

export function memoryDeps(llm: LlmProvider, now: Date) {
  const repo = new MemoryRepo();
  const calendar = new MemoryCalendar();
  const kb = new MemoryKB();
  const messenger = new FakeMessenger();
  const notifier = new FakeNotifier();
  const clock = new FixedClock(now);
  let n = 0;
  const deps: Deps = { repo, llm, calendar, kb, messenger, notifier, clock, ids: () => `id${++n}` };
  return { deps, repo, calendar, kb, messenger, notifier, clock };
}
