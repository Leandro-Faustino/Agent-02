import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeBasePort, KnowledgeHit } from "@/core/ports";

/** Embeddings via Voyage AI (opcional). Sem chave, a busca usa texto completo do Postgres. */
export async function embed(texts: string[], inputType: "query" | "document"): Promise<number[][] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: texts, model: process.env.VOYAGE_MODEL ?? "voyage-3.5", input_type: inputType, output_dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`embeddings: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** RAG isolado por cliente (camada Empresa cliente). */
export class SupabaseKnowledgeBase implements KnowledgeBasePort {
  constructor(private db: SupabaseClient) {}

  async search(tenantId: string, query: string, k = 5): Promise<KnowledgeHit[]> {
    if (!query.trim()) return [];
    const vec = (await embed([query], "query"))?.[0] ?? null;
    const { data, error } = await this.db.rpc("match_kb_chunks", {
      p_tenant: tenantId,
      p_query: query,
      p_embedding: vec ? `[${vec.join(",")}]` : null,
      p_k: k,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as KnowledgeHit[];
  }

  /** Divide um documento em trechos e grava com embeddings. */
  async ingest(tenantId: string, title: string, source: string, text: string): Promise<string> {
    const { data: doc, error } = await this.db.from("kb_documents").insert({ tenant_id: tenantId, title, source }).select("id").single();
    if (error) throw new Error(error.message);
    const chunks = chunk(text);
    const vectors = await embed(chunks, "document");
    const rows = chunks.map((content, i) => ({
      tenant_id: tenantId,
      document_id: doc.id,
      content,
      embedding: vectors ? `[${vectors[i].join(",")}]` : null,
    }));
    const ins = await this.db.from("kb_chunks").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
    return doc.id;
  }
}

/** Trechos de ~800 caracteres respeitando parágrafos. */
export function chunk(text: string, size = 800): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size && cur) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length <= size * 1.5 ? [c] : c.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []));
}
