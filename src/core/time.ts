/** Utilitários de fuso horário sem dependências (RF-37: fuso do lead/cliente). */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday as string],
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

/** Converte horário local do fuso em instante UTC. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offsetMs(new Date(guess), tz);
  ts = guess - offsetMs(new Date(ts), tz);
  return new Date(ts);
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

export interface Window {
  from: string;
  to: string;
  weekdays: number[];
}

export function isWithinWindow(date: Date, tz: string, w: Window): boolean {
  const p = localParts(date, tz);
  const mins = p.hour * 60 + p.minute;
  return w.weekdays.includes(p.weekday) && mins >= parseHHMM(w.from) && mins < parseHHMM(w.to);
}

/** Primeiro instante >= date dentro da janela de envio. */
export function nextWindowStart(date: Date, tz: string, w: Window): Date {
  if (isWithinWindow(date, tz, w)) return date;
  for (let i = 0; i < 14; i++) {
    const day = addDaysLocal(date, tz, i);
    const start = zonedToUtc(day.year, day.month, day.day, Math.floor(parseHHMM(w.from) / 60), parseHHMM(w.from) % 60, tz);
    if (start.getTime() >= date.getTime() && isWithinWindow(start, tz, w)) return start;
  }
  return date;
}

export function addDaysLocal(date: Date, tz: string, days: number): LocalParts {
  const p = localParts(date, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, weekday: d.getUTCDay() };
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "quinta (12/10) às 10h" / "amanhã às 15h30". */
export function formatSlot(iso: string, tz: string, now: Date): string {
  const d = new Date(iso);
  const p = localParts(d, tz);
  const today = localParts(now, tz);
  const diffDays = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86400000,
  );
  const hora = p.minute ? `${p.hour}h${String(p.minute).padStart(2, "0")}` : `${p.hour}h`;
  const dd = `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`;
  if (diffDays === 0) return `hoje às ${hora}`;
  if (diffDays === 1) return `amanhã (${dd}) às ${hora}`;
  return `${DIAS[p.weekday]} (${dd}) às ${hora}`;
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60000);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}
