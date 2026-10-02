import { ConfigEditor } from "@/components/config-editor";

export default async function ConfigPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  return (
    <main>
      <header className="top">
        <div>
          <a href={`/painel/${tenantId}`}>← voltar</a>
          <h1>Onboarding e configuração</h1>
          <span className="muted">
            Perfil de cliente ideal, mapa de dores, oferta e prova, critérios, objeções, agenda, persona, objetivo e limites (RF-01 a RF-09).
            O agente só opera depois da aprovação.
          </span>
        </div>
      </header>
      <ConfigEditor tenantId={tenantId} />
    </main>
  );
}
