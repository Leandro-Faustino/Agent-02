import crypto from "node:crypto";
import type { Deps } from "@/core/ports";
import { supabaseAdmin } from "./supabase/client";
import { SupabaseRepo } from "./supabase/repository";
import { SupabaseCalendar } from "./supabase/calendar";
import { SupabaseKnowledgeBase } from "./supabase/knowledge";
import { CloudApiMessenger } from "./whatsapp/cloud-api";
import { AnthropicProvider } from "./llm/anthropic";
import { WebhookNotifier } from "./notifier";

let cached: (Deps & { repo: SupabaseRepo; kb: SupabaseKnowledgeBase }) | null = null;

/** Monta as dependências de produção. */
export function prodDeps() {
  if (cached) return cached;
  const db = supabaseAdmin();
  const repo = new SupabaseRepo(db);
  cached = {
    repo,
    llm: new AnthropicProvider(),
    calendar: new SupabaseCalendar(db),
    kb: new SupabaseKnowledgeBase(db),
    messenger: new CloudApiMessenger(db),
    notifier: new WebhookNotifier(repo),
    clock: { now: () => new Date() },
    ids: () => crypto.randomUUID(),
  };
  return cached;
}
