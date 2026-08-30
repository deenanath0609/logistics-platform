/**
 * What each credential slot is made of, in one place.
 *
 * Read by the server action that validates a submission and by the client
 * component that renders the form, which is why it holds no imports at all:
 * a single `platformDb` in this module would drag the operator console's
 * database client into a browser bundle.
 *
 * The wording is part of the spec, not decoration. An operator filling this
 * in is deciding whose gateway account a carrier's consignees hear from, and
 * every field here has a failure mode that is invisible from the outside —
 * an unregistered SMS header is dropped after the aggregator says "accepted",
 * a relay that is not the carrier's fails their SPF, a GPS base URL pointed
 * at the wrong vendor returns a healthy-looking nothing.
 */

export const CREDENTIAL_KINDS = ["SMS", "SMTP", "WHATSAPP", "GPS"] as const;

export type CredentialKindCode = (typeof CREDENTIAL_KINDS)[number];

export type CredentialField = {
  /** Key inside `TenantCredential.settings`, and the form field name. */
  name: string;
  label: string;
  type: "text" | "number";
  placeholder?: string;
  hint?: string;
};

export type CredentialSpec = {
  /** Section heading. */
  title: string;
  /** What the outside service is, in the operator's words. */
  description: string;
  secretLabel: string;
  secretHint: string;
  /** What falling back to the platform's own account costs, per service. */
  sharedAccountNote: string;
  /** Non-secret configuration, shown and editable. */
  fields: CredentialField[];
  /** Where the shared account is read from, so its source is not a mystery. */
  platformEnv: string[];
};

export const CREDENTIAL_SPECS: Record<CredentialKindCode, CredentialSpec> = {
  SMS: {
    title: "SMS gateway",
    description:
      "The aggregator account transactional SMS is submitted to. Delivery OTPs, pickup confirmations and every tracking link ride on it.",
    secretLabel: "API key",
    secretHint:
      "The aggregator's key for this carrier's own account. Stored encrypted and never shown again.",
    sharedAccountNote:
      "Their SMS is submitted on the platform's aggregator account — billed to us, sharing one rate limit with every other carrier, and stopping for everyone if that key is revoked.",
    fields: [
      {
        name: "senderId",
        label: "Sender header on this account",
        type: "text",
        placeholder: "ACMELG",
        hint: "Only if the header registered on their own account differs from the one on their organisation above. Left empty, the organisation's is used.",
      },
      {
        name: "baseUrl",
        label: "API base URL",
        type: "text",
        placeholder: "https://api.aggregator.example",
        hint: "Only where the aggregator gives this carrier a dedicated endpoint.",
      },
    ],
    platformEnv: ["SMS_API_KEY", "SMS_SENDER_ID"],
  },

  SMTP: {
    title: "SMTP relay",
    description:
      "The relay notification email is submitted to. The address it is sent as is the carrier's own, set under White-label above.",
    secretLabel: "SMTP password",
    secretHint:
      "The password for the mailbox or relay account named below. Stored encrypted and never shown again.",
    sharedAccountNote:
      "Their email leaves through the platform's relay. It is a deliverability problem as much as a billing one: the carrier's SPF and DKIM records do not name our relay, so mail sent as them from it can be treated as forged.",
    fields: [
      {
        name: "host",
        label: "Host",
        type: "text",
        placeholder: "smtp.acme-logistics.example",
        hint: "Empty means this carrier has no relay of their own and falls back to the platform's.",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        placeholder: "587",
        hint: "587 for STARTTLS, 465 for implicit TLS.",
      },
      { name: "user", label: "Username", type: "text", placeholder: "no-reply@acme-logistics.example" },
    ],
    platformEnv: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"],
  },

  WHATSAPP: {
    title: "WhatsApp Business",
    description:
      "The Business Solution Provider account outbound WhatsApp templates are submitted to.",
    secretLabel: "Access token",
    secretHint:
      "The BSP's token for this carrier's account. Stored encrypted and never shown again.",
    sharedAccountNote:
      "There is no usable shared WhatsApp account: a Business number belongs to one business, and messages cannot go out as a carrier who has none. Until this is filled in, WhatsApp sends for them are refused rather than attempted.",
    fields: [
      {
        name: "phoneNumberId",
        label: "Phone number id",
        type: "text",
        hint: "The BSP's id for the sending number — not the number itself, which goes under White-label above.",
      },
      { name: "baseUrl", label: "API base URL", type: "text", placeholder: "https://graph.facebook.com/v20.0" },
    ],
    platformEnv: ["WHATSAPP_API_KEY"],
  },

  GPS: {
    title: "GPS / telematics vendor",
    description:
      "The telematics account vehicle positions are polled from. Feeds the live map, ETAs and the detention clock.",
    secretLabel: "API key",
    secretHint:
      "The vendor's key for this carrier's fleet account. Stored encrypted and never shown again.",
    sharedAccountNote:
      "They are on the platform's telematics account, which in practice means the simulated provider — every position on their live map is fiction until their own vendor account is entered here.",
    fields: [
      {
        name: "providerCode",
        label: "Vendor adapter",
        type: "text",
        placeholder: "mock",
        hint: "Which adapter in src/lib/tracking/providers speaks to this vendor. An unknown code is refused at poll time rather than silently simulated.",
      },
      { name: "baseUrl", label: "API base URL", type: "text", placeholder: "https://api.telematics.example" },
    ],
    platformEnv: ["GPS_PROVIDER", "GPS_API_BASE", "GPS_API_KEY"],
  },
};
