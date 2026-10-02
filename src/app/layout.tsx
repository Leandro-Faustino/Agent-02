import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Agente SDR", description: "Painel do agente SDR com IA para WhatsApp" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
