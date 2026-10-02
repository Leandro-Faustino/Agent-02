import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { parseWebhook, verifySignature } from "@/adapters/whatsapp/cloud-api";
import { chunk } from "@/adapters/supabase/knowledge";

describe("webhook do WhatsApp", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123" },
              contacts: [{ wa_id: "5511988887777", profile: { name: "Carla" } }],
              messages: [
                { id: "wamid.1", from: "5511988887777", timestamp: "1791205200", type: "text", text: { body: "oi" } },
                { id: "wamid.2", from: "5511988887777", timestamp: "1791205201", type: "audio", audio: { id: "media1", mime_type: "audio/ogg" } },
              ],
              statuses: [{ id: "wamid.x", status: "read" }],
            },
          },
        ],
      },
    ],
  };
  it("extrai texto e áudio, ignora status", () => {
    const items = parseWebhook(payload);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ phoneNumberId: "123", from: "5511988887777", profileName: "Carla", message: { kind: "text", text: "oi" } });
    expect(items[1].message).toMatchObject({ kind: "audio", mediaId: "media1" });
  });
  it("valida assinatura HMAC", () => {
    const raw = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(raw).digest("hex");
    expect(verifySignature(raw, sig, "s3cr3t")).toBe(true);
    expect(verifySignature(raw, sig, "outro")).toBe(false);
    expect(verifySignature(raw, null, "s3cr3t")).toBe(false);
  });
});

describe("base de conhecimento", () => {
  it("divide documentos respeitando parágrafos", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Parágrafo ${i} ` + "x".repeat(200)).join("\n\n");
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 1200)).toBe(true);
  });
});
