/** Imprime a configuração de demonstração em JSON (ponto de partida do onboarding). */
import { DEMO_CONFIG } from "@/fixtures/demo";

const { tenantId: _t, approved: _a, ...config } = DEMO_CONFIG;
console.log(JSON.stringify(config, null, 2));
