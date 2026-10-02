import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalendarPort } from "@/core/ports";
import type { Lead, Meeting, Slot, TenantConfig } from "@/core/types";
import { eligibleSellers, freeSlots, type Busy } from "@/core/agent/scheduling";
import { addDays } from "@/core/time";

/**
 * Agenda interna dos vendedores (RF-06). A disponibilidade vem da configuração;
 * as reservas ficam na tabela bookings, que impede sobreposição no banco.
 * Integrações com Google/Outlook podem gravar bloqueios na mesma tabela (source != 'agente').
 */
export class SupabaseCalendar implements CalendarPort {
  constructor(private db: SupabaseClient) {}

  private async busy(tenantId: string, from: Date, days: number): Promise<Busy[]> {
    const { data, error } = await this.db
      .from("bookings")
      .select("seller_id, starts_at, ends_at")
      .eq("tenant_id", tenantId)
      .neq("status", "cancelada")
      .gte("ends_at", from.toISOString())
      .lte("starts_at", addDays(from, days + 1).toISOString());
    if (error) throw new Error(error.message);
    return (data ?? []).map((b) => ({ sellerId: b.seller_id, startsAt: b.starts_at, endsAt: b.ends_at }));
  }

  async findSlots(config: TenantConfig, lead: Lead, from: Date, count: number): Promise<Slot[]> {
    const busy = await this.busy(config.tenantId, from, config.meetings.horizonDays);
    const { count: total } = await this.db.from("bookings").select("id", { count: "exact", head: true }).eq("tenant_id", config.tenantId);
    return freeSlots(config, eligibleSellers(config, lead, total ?? 0), busy, from).slice(0, count);
  }

  async book(config: TenantConfig, lead: Lead, slot: Slot): Promise<Meeting | null> {
    const { data, error } = await this.db
      .from("bookings")
      .insert({ tenant_id: config.tenantId, seller_id: slot.sellerId, lead_id: lead.id, starts_at: slot.startsAt, ends_at: slot.endsAt })
      .select("id")
      .single();
    if (error) {
      // 23P01 = exclusion_violation: alguém reservou primeiro.
      if (error.code === "23P01") return null;
      throw new Error(error.message);
    }
    return { id: data.id, sellerId: slot.sellerId, startsAt: slot.startsAt, endsAt: slot.endsAt, status: "agendada", remindersSent: [] };
  }

  async cancel(tenantId: string, meetingId: string): Promise<void> {
    const { error } = await this.db.from("bookings").update({ status: "cancelada" }).eq("tenant_id", tenantId).eq("id", meetingId);
    if (error) throw new Error(error.message);
  }
}
