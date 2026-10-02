import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export function supabaseUser(): Promise<SupabaseClient> {
  return (async () => {
    const store = await cookies();
    return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // Chamado de Server Component: o middleware renova a sessão.
          }
        },
      },
    }) as unknown as SupabaseClient;
  })();
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Usuário logado e membro da empresa (RNF-06: acesso por papel). */
export async function requireMember(tenantId: string, roles?: string[]) {
  const db = await supabaseUser();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) throw new HttpError(401, "não autenticado");
  const { data } = await db.from("tenant_members").select("role, seller_id").eq("tenant_id", tenantId).eq("user_id", auth.user.id).maybeSingle();
  if (!data) throw new HttpError(403, "sem acesso a esta empresa");
  if (roles && !roles.includes(data.role)) throw new HttpError(403, "papel sem permissão");
  return { userId: auth.user.id, role: data.role as string, sellerId: data.seller_id as string | null };
}

export function requireCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "não autorizado");
}

export function handle(fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: "erro interno" }, { status: 500 });
    }
  };
}
