import { db, step, done } from "./client";
import { DEFAULT_TEMPLATES } from "../../src/lib/notifications/default-templates";

/**
 * Loads the default notification templates.
 *
 * Without these rows the dispatcher matches nothing and every operational
 * event drains from the outbox having sent precisely no messages — a
 * failure mode that looks identical to a working system from the UI.
 *
 * SMS templates are seeded INACTIVE on purpose. Indian transactional SMS
 * requires each template to be registered on DLT before an operator will
 * deliver it, and a template activated without its `dltTemplateId` fails
 * silently at the gateway. Operations activates them once registration
 * comes back — the screen at /notifications/templates says so.
 */
export async function seedNotificationTemplates(orgId: string) {
  step("notification templates");

  let created = 0;
  let updated = 0;

  for (const tpl of DEFAULT_TEMPLATES) {
    const existing = await db.notificationTemplate.findFirst({
      where: {
        orgId,
        code: tpl.code,
        channel: tpl.channel,
        language: tpl.language ?? "en",
      },
    });

    const data = {
      eventType: tpl.eventType,
      name: tpl.name,
      subject: tpl.subject ?? null,
      body: tpl.body,
      variables: tpl.variables ?? [],
      recipientKind: tpl.recipientKind,
    };

    if (existing) {
      // Never re-activate or overwrite a DLT id someone has registered.
      await db.notificationTemplate.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    } else {
      await db.notificationTemplate.create({
        data: {
          ...data,
          orgId,
          code: tpl.code,
          channel: tpl.channel,
          language: tpl.language ?? "en",
          // What the default set itself says, not a rule restated here.
          // `default-templates.ts` explains why SMS ships off.
          isActive: tpl.isActive,
        },
      });
      created++;
    }
  }

  done(`${created} new, ${updated} refreshed`);

  const pendingDlt = await db.notificationTemplate.count({
    where: { orgId, channel: "SMS", dltTemplateId: null },
  });

  if (pendingDlt > 0) {
    console.log(
      `    ! ${pendingDlt} SMS template(s) are inactive pending DLT registration.`,
    );
  }
}
