import type { NotificationChannel } from "@/generated/prisma/client";
import { maskRecipient } from "../mask";
import { senderHeaderFor } from "./sender";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";

// Imported and re-exported: the definition moved out because the template
// editor is a client component, and this file reaches the database.
import { segmentsFor } from "../segments";

export { segmentsFor };

/**
 * The default adapter, and the one every environment runs on until the
 * gateway contracts are signed.
 *
 * It succeeds, it logs, and it costs nothing — which means the whole
 * notification path (template resolution, opt-outs, idempotency, the send
 * log) is exercised in development exactly as it will be in production.
 * Only the last inch changes when a real provider arrives.
 */
export function mockAdapter(channel: NotificationChannel): ChannelAdapter {
  return {
    provider: "mock",
    channel,
    async send(message: OutboundMessage): Promise<SendResult> {
      // The recipient is masked even here. Development logs get pasted into
      // tickets, and a real consignee's number should not travel with them.
      const target = maskRecipient(message.to);

      const warnings: string[] = [];
      if (channel === "SMS" && !message.dltTemplateId) {
        warnings.push(
          "no DLT template id — a real Indian operator would drop this silently",
        );
      }
      // Warned about here as well as refused in `sms.ts`, because every
      // environment still runs on this adapter: a carrier onboarded without
      // a sender header would otherwise look fine right up to the day the
      // real gateway is switched on, and the registration that fixes it
      // takes weeks to obtain.
      if (channel === "SMS" && !(await senderHeaderFor(message))) {
        warnings.push(
          "no DLT sender header on the template or the carrier — the real " +
            "adapter refuses this send",
        );
      }

      // The body, only in development. This adapter is the *default* on a
      // fresh deployment — SMS and WhatsApp default to "mock" and email
      // falls back to it with no SMTP host — so a first deploy that has not
      // set those three variables would otherwise print every one-time code
      // and every tracking link to stdout.
      const detail =
        process.env.NODE_ENV === "development"
          ? `
${message.body}`
          : ` | ${message.body.length} chars`;

      console.info(
        `[notify:mock] ${channel} → ${target}` +
          (message.subject ? ` | ${message.subject}` : "") +
          `\n${message.body}` +
          (warnings.length ? `\n  ⚠ ${warnings.join("; ")}` : ""),
      );

      return {
        ok: true,
        providerRef: `mock-${message.reference ?? Date.now().toString(36)}`,
        response: {
          provider: "mock",
          accepted: true,
          warnings,
          at: new Date().toISOString(),
        },
        segments: channel === "SMS" ? segmentsFor(message.body) : null,
        cost: 0,
      };
    },
  };
}

