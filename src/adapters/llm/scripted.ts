import type { LlmProvider, LlmUsage, TurnRequest } from "@/core/ports";
import { emptyAnalysis, type TurnAnalysis } from "@/core/agent/analysis";

const ZERO: LlmUsage = { model: "scripted", inputTokens: 0, outputTokens: 0, costUsd: 0 };

export type Script = (req: TurnRequest, call: number) => Partial<TurnAnalysis>;

/** LLM determinístico para testes: cada chamada devolve o que o roteiro manda. */
export class ScriptedLlm implements LlmProvider {
  calls: TurnRequest[] = [];
  constructor(private script: Script) {}
  async runTurn(req: TurnRequest) {
    this.calls.push(req);
    const partial = this.script(req, this.calls.length - 1);
    const base = emptyAnalysis();
    const analysis: TurnAnalysis = {
      ...base,
      ...partial,
      flags: { ...base.flags, ...(partial.flags ?? {}) },
      leadData: { ...base.leadData, ...(partial.leadData ?? {}) },
    };
    return { analysis, usage: ZERO };
  }
  async complete() {
    return { text: "", usage: ZERO };
  }
}
