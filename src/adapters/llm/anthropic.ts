import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Attachment, LlmProvider, LlmUsage, TurnRequest } from "@/core/ports";
import { emptyAnalysis, TurnAnalysisSchema, type TurnAnalysis } from "@/core/agent/analysis";
import type { ChatMessage } from "@/core/types";

/** Preço por 1M tokens (entrada, saída) — RNF-05: custo de IA visível no painel. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

function cost(model: string, usage: Anthropic.Beta.BetaUsage): LlmUsage {
  const [inP, outP] = PRICES[model] ?? [4, 20];
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens;
  const usd = (input * inP + cacheWrite * inP * 1.25 + cacheRead * inP * 0.1 + usage.output_tokens * outP) / 1_000_000;
  return { model, inputTokens: input + cacheRead + cacheWrite, outputTokens: usage.output_tokens, costUsd: usd };
}

/** Converte o histórico em turnos alternados user/assistant. */
function toMessages(history: ChatMessage[], turnContext: string, revisionNotes?: string[]): Anthropic.Beta.BetaMessageParam[] {
  const msgs: Anthropic.Beta.BetaMessageParam[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${text}`;
    else msgs.push({ role, content: text });
  };
  for (const m of history) {
    if (m.role === "lead") push("user", `<lead>${m.media?.transcript ?? m.text}</lead>`);
    else if (m.role === "agente") push("assistant", m.text);
    else if (m.role === "vendedor") push("assistant", `[mensagem do vendedor] ${m.text}`);
  }
  // O contexto do turno vai na última mensagem de usuário, após o histórico (prefixo estável para cache).
  const tail = [
    `<contexto_do_turno>\n${turnContext}\n</contexto_do_turno>`,
    revisionNotes?.length
      ? `<revisao>A versão anterior foi reprovada pelo revisor automático. Corrija: ${revisionNotes.join("; ")}</revisao>`
      : "",
    "Redija a próxima mensagem do agente e a análise.",
  ]
    .filter(Boolean)
    .join("\n");
  push("user", tail);
  if (msgs[0]?.role === "assistant") msgs.unshift({ role: "user", content: "<inicio_da_conversa/>" });
  return msgs;
}

export interface AnthropicProviderOptions {
  /** Modelo que redige e classifica o turno. */
  writerModel?: string;
  /** Modelo para tarefas auxiliares (ler mídia, simulador, rubrica). */
  auxModel?: string;
  effort?: "low" | "medium" | "high";
  client?: Anthropic;
}

/**
 * RF-31 — implementação Claude da interface LlmProvider.
 * Trocar de provedor = escrever outra classe com a mesma interface.
 */
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  private writer: string;
  private aux: string;
  private effort: "low" | "medium" | "high";

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.writer = opts.writerModel ?? process.env.LLM_MODEL_WRITER ?? "claude-opus-5-5";
    this.aux = opts.auxModel ?? process.env.LLM_MODEL_CLASSIFIER ?? "claude-opus-5-5";
    // Conversa de WhatsApp: latência importa (RNF-01); esforço baixo costuma bastar.
    this.effort = opts.effort ?? "low";
  }

  async runTurn(req: TurnRequest): Promise<{ analysis: TurnAnalysis; usage: LlmUsage }> {
    const res = await this.client.beta.messages.parse({
      model: this.writer,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.effort, format: betaZodOutputFormat(TurnAnalysisSchema) },
      system: [
        { type: "text", text: req.methodology },
        // Cache por cliente: metodologia + contexto da empresa formam o prefixo estável.
        { type: "text", text: req.tenantContext, cache_control: { type: "ephemeral" } },
      ],
      messages: toMessages(req.history, req.turnContext, req.revisionNotes),
    });
    const usage = cost(res.model, res.usage);
    if (res.stop_reason === "refusal" || !res.parsed_output) {
      // Sem saída válida: confiança zero leva o turno para uma pessoa (RF-20).
      const analysis = { ...emptyAnalysis(), confidence: 0, suggestedNextAction: "transferir_humano" as const };
      return { analysis, usage };
    }
    return { analysis: res.parsed_output, usage };
  }

  async complete(system: string, user: string, opts: { maxTokens?: number; attachments?: Attachment[] } = {}) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const a of opts.attachments ?? []) {
      if (a.kind === "pdf") {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } });
      } else {
        content.push({
          type: "image",
          source: { type: "base64", media_type: a.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: a.base64 },
        });
      }
    }
    content.push({ type: "text", text: user });
    const res = await this.client.beta.messages.create({
      model: this.aux,
      max_tokens: opts.maxTokens ?? 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content }],
    });
    const text = res.stop_reason === "refusal" ? "" : res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, usage: cost(res.model, res.usage) };
  }
}
