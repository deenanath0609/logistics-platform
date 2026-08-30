/**
 * Notification engine — public surface.
 *
 * Wiring it up is one call, made in the process that drains the outbox —
 * `workers/index.ts`, not the web server:
 *
 * ```ts
 * import { registerNotificationDispatch } from "@/lib/notifications";
 * import { outboxPass } from "@/server/services/outbox";
 *
 * registerNotificationDispatch();
 * // ...then schedule outboxPass.
 * ```
 *
 * Registration must happen before the first drain tick — an event marked
 * DONE with nothing listening is delivered to nobody, once — and is safe to
 * call repeatedly: the guard inside is what keeps a hot reload from doubling
 * every send.
 */

export { registerNotificationDispatch, dispatchEvent } from "./dispatch";
export type { DispatchInput, DispatchSummary } from "./dispatch";

export { DEFAULT_TEMPLATES, smsTemplatesNeedingDlt } from "./default-templates";
export type { DefaultTemplate } from "./default-templates";

export {
  renderTemplate,
  renderSubject,
  validateTemplate,
  extractPlaceholders,
  missingVariables,
  escapeHtml,
} from "./render";
export type { TemplateVariables, TemplateValidation } from "./render";

export { maskPhone, maskEmail, maskRecipient } from "./mask";

export {
  getChannelAdapter,
  resetChannels,
  setChannelAdapter,
  segmentsFor,
  ChannelNotConfiguredError,
  ProviderNotImplementedError,
} from "./channels";
export type { ChannelAdapter, OutboundMessage, SendResult } from "./channels";

export {
  ALL_VARIABLES,
  TRIGGER_EVENTS,
  EVENT_LABEL,
  variablesForEvent,
  sampleVariables,
} from "./variables";
export type { VariableSpec } from "./variables";
