import type { NotificationChannel } from "@/generated/prisma/client";
import { maskRecipient } from "../mask";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";

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

/**
 * GSM-7 counts 160 characters per segment and 153 in a concatenated one.
 * Anything outside that alphabet drops the message to UCS-2 at 70/67.
 * Approximate, but close enough to make a template that quietly costs
 * three segments visible before the first invoice does.
 */
export function segmentsFor(body: string): number {
  const unicode = /[^\r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}[\]~|€\\]/.test(
    body,
  );
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;

  if (body.length === 0) return 1;
  if (body.length <= single) return 1;
  return Math.ceil(body.length / multi);
}
