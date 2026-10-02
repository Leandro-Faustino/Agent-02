import Link from "next/link";
import { supabaseUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function Painel() {
  const db = await supabaseUser();
  const { data: tenants } = await db.from("tenants").select("id, name").order("name");
  return (
    <main>
      <header className="top">
        <h1>Empresas</h1>
      </header>
      <div className="grid">
        {(tenants ?? []).map((t) => (
          <Link key={t.id} href={`/painel/${t.id}`} className="card">
            {t.name}
          </Link>
        ))}
        {!tenants?.length && <p className="muted">Nenhuma empresa vinculada ao seu usuário.</p>}
      </div>
    </main>
  );
}
