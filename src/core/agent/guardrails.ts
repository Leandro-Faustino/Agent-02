import {
  ABBREVIATIONS,
  CLICHES,
  MANIPULATION_PATTERNS,
  MAX_BALLOONS,
  MAX_BALLOON_CHARS,
  URL_SHORTENERS,
} from "../methodology/principles";
import type { TenantConfig } from "../types";

export interface ReviewContext {
  config: TenantConfig;
  /** Primeiro contato ou retomada após longo intervalo (RF-34.1). */
  mustIdentify: boolean;
  /** Texto de onde fatos podem vir: oferta + trechos da base recuperados (RF-30). */
  factCorpus: string;
  /** Textos de horários propostos — números neles são permitidos. */
  allowedNumbers?: string[];
  askedIfBot: boolean;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Números que não são fatos: horas, datas, dias. */
const TIME_DATE_RE = /\b\d{1,2}h(\d{2})?\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\bdia \d{1,2}\b|\b\d{1,2} (min|minutos|horas?)\b/gi;
const FACT_NUMBER_RE = /R\$\s?\d[\d.,]*|\d[\d.,]*\s?%|\d[\d.,]*\s?(mil|milh(ão|ões)|clientes|empresas|dias|meses|anos|vezes|x)\b|\b\d{2,}[\d.,]*/gi;

/**
 * RF-34.6 — revisão automática antes de enviar: tom, tamanho, fatos e regras proibidas.
 * Retorna a lista de violações (vazia = aprovada).
 */
export function reviewReply(balloons: string[], ctx: ReviewContext): string[] {
  const v: string[] = [];
  const parts = balloons.map((b) => b.trim()).filter(Boolean);
  if (parts.length === 0) v.push("resposta vazia");
  if (parts.length > MAX_BALLOONS) v.push(`mais de ${MAX_BALLOONS} balões (${parts.length})`);
  parts.forEach((b, i) => {
    if (b.length > MAX_BALLOON_CHARS) v.push(`balão ${i + 1} com ${b.length} caracteres (máx. ${MAX_BALLOON_CHARS})`);
  });

  const all = parts.join("\n");
  const lower = all.toLowerCase();
  const plain = stripAccents(lower);

  const words = plain.split(/[^a-z0-9]+/);
  const abbr = ABBREVIATIONS.filter((a) => a.length > 1 && words.includes(a));
  if (abbr.length) v.push(`abreviações: ${abbr.join(", ")}`);

  const cliches = CLICHES.filter((c) => plain.includes(stripAccents(c)));
  if (cliches.length) v.push(`clichê de vendedor: ${cliches.join(", ")}`);

  for (const s of URL_SHORTENERS) if (lower.includes(s)) v.push(`link encurtado: ${s}`);
  if (/(^|\s)www\.[^\s]+/i.test(all)) v.push("link sem https://");

  const forbidden = ctx.config.persona.forbiddenWords.filter((w) => plain.includes(stripAccents(w.toLowerCase())));
  if (forbidden.length) v.push(`palavras proibidas: ${forbidden.join(", ")}`);

  const emojis = all.match(EMOJI_RE)?.length ?? 0;
  const maxEmoji = ctx.config.persona.allowOneEmoji ? 1 : 0;
  if (emojis > maxEmoji) v.push(`emojis demais (${emojis}, máx. ${maxEmoji})`);

  const questions = (all.match(/\?/g) ?? []).length;
  if (questions > 1) v.push(`mais de uma pergunta (${questions})`);

  for (const re of MANIPULATION_PATTERNS) if (re.test(all)) v.push(`tática proibida: ${re.source}`);

  if (/(?<!\p{L})(sou (um|uma) (humano|humana|pessoa( de verdade| real)?)|n[aã]o sou (um )?(rob[oô]|bot|ia))(?!\p{L})/iu.test(all)) {
    v.push("afirma ser humano (RNF-07)");
  }
  if (ctx.askedIfBot && !/assistente virtual|intelig[eê]ncia artificial|\bIA\b/i.test(all)) {
    v.push("perguntaram se é robô e a resposta não confirma que é assistente virtual");
  }

  if (ctx.mustIdentify) {
    const p = ctx.config.persona;
    if (!plain.includes(stripAccents(p.agentName.toLowerCase())) || !plain.includes(stripAccents(p.companyName.toLowerCase()))) {
      v.push("primeiro contato sem nome e empresa");
    }
  }

  v.push(...unsupportedFacts(all, ctx));
  return v;
}

/** RF-30 — nada inventado: todo número-fato precisa existir na base do cliente. */
export function unsupportedFacts(text: string, ctx: Pick<ReviewContext, "factCorpus" | "allowedNumbers">): string[] {
  const allowed = new Set((ctx.allowedNumbers ?? []).flatMap((s) => (s.match(/\d+/g) ?? []).map(String)));
  const cleaned = text.replace(TIME_DATE_RE, " ");
  const corpusDigits = ctx.factCorpus.match(/\d[\d.,]*/g)?.map(digitsOnly) ?? [];
  const out: string[] = [];
  for (const m of cleaned.match(FACT_NUMBER_RE) ?? []) {
    const d = digitsOnly(m);
    if (!d || allowed.has(d)) continue;
    if (!corpusDigits.includes(d)) {
      out.push(`fato não encontrado na base: "${m.trim()}"`);
    }
  }
  return out;
}

/** Ajustes mecânicos seguros antes de revisar (não alteram sentido). */
export function normalizeBalloons(balloons: string[]): string[] {
  return balloons
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
