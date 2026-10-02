import type { Lead, Seller, Slot, TenantConfig } from "../types";
import { addDaysLocal, addMinutes, localParts, parseHHMM, zonedToUtc } from "../time";

export interface Busy {
  sellerId: string;
  startsAt: string;
  endsAt: string;
}

/** RF-06 — distribuição: rodízio, território ou segmento. */
export function eligibleSellers(config: TenantConfig, lead: Lead, rotationIndex = 0): Seller[] {
  const { sellers, distribution } = config.meetings;
  let pool = sellers;
  if (distribution === "segmento" && lead.profileId) {
    const m = sellers.filter((s) => s.segments.includes(lead.profileId!));
    if (m.length) pool = m;
  }
  if (distribution === "territorio") {
    const ddd = lead.phone.replace(/\D/g, "").slice(2, 4);
    const m = sellers.filter((s) => s.territories.includes(ddd));
    if (m.length) pool = m;
  }
  if (distribution === "rodizio" && pool.length > 1) {
    const k = rotationIndex % pool.length;
    pool = [...pool.slice(k), ...pool.slice(0, k)];
  }
  return pool;
}

/** Todos os horários livres no horizonte, ordenados. */
export function freeSlots(config: TenantConfig, sellers: Seller[], busy: Busy[], from: Date): Slot[] {
  const tz = config.limits.timezone;
  const { durationMinutes, bufferMinutes, minLeadTimeHours, horizonDays } = config.meetings;
  const earliest = addMinutes(from, minLeadTimeHours * 60);
  const out: Slot[] = [];
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDaysLocal(from, tz, i);
    for (const seller of sellers) {
      for (const av of seller.availability.filter((a) => a.weekday === day.weekday)) {
        const end = parseHHMM(av.to);
        for (let m = parseHHMM(av.from); m + durationMinutes <= end; m += durationMinutes + bufferMinutes) {
          const start = zonedToUtc(day.year, day.month, day.day, Math.floor(m / 60), m % 60, tz);
          if (start < earliest) continue;
          const stop = addMinutes(start, durationMinutes);
          const clash = busy.some(
            (b) =>
              b.sellerId === seller.id &&
              new Date(b.startsAt).getTime() < addMinutes(stop, bufferMinutes).getTime() &&
              new Date(b.endsAt).getTime() > addMinutes(start, -bufferMinutes).getTime(),
          );
          if (!clash) out.push({ sellerId: seller.id, startsAt: start.toISOString(), endsAt: stop.toISOString() });
        }
      }
    }
  }
  // Ordem do rodízio desempata horários iguais.
  const order = new Map(sellers.map((s, i) => [s.id, i]));
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || order.get(a.sellerId)! - order.get(b.sellerId)!);
}

/**
 * RF-14 — dois horários reais, em dias diferentes e de preferência em
 * períodos diferentes (manhã/tarde), para o pedido assumido.
 */
export function pickTwo(slots: Slot[], tz: string, preference?: (s: Slot) => boolean): Slot[] {
  const pool = preference ? slots.filter(preference) : slots;
  const list = pool.length ? pool : slots;
  if (list.length === 0) return [];
  const first = list[0];
  const p1 = localParts(new Date(first.startsAt), tz);
  const differentDay = list.filter((s) => {
    const p = localParts(new Date(s.startsAt), tz);
    return p.day !== p1.day || p.month !== p1.month;
  });
  const differentPeriod = differentDay.find((s) => (localParts(new Date(s.startsAt), tz).hour < 12) !== (p1.hour < 12));
  const second = differentPeriod ?? differentDay[0] ?? list[1];
  return second ? [first, second] : [first];
}

/** Interpreta preferências simples ("segunda de manhã", "à tarde", "sexta"). */
export function preferenceFilter(text: string | null | undefined, tz: string): ((s: Slot) => boolean) | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const days = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
  const wd = days.findIndex((d) => t.includes(d));
  const morning = /manha/.test(t);
  const afternoon = /tarde/.test(t);
  const evening = /noite|fim do dia|final do dia/.test(t);
  if (wd < 0 && !morning && !afternoon && !evening) return undefined;
  return (s) => {
    const p = localParts(new Date(s.startsAt), tz);
    if (wd >= 0 && p.weekday !== wd) return false;
    if (morning && p.hour >= 12) return false;
    if (afternoon && (p.hour < 12 || p.hour >= 18)) return false;
    if (evening && p.hour < 17) return false;
    return true;
  };
}
