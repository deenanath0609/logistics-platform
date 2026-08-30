import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createBooking } from "@/lib/shipment/booking";
import { recordAudit } from "@/server/services/audit";
import { loadValidationContext } from "@/lib/bulk/context";
import { validateRow } from "@/lib/bulk/validate";
import { toPartnerShipment, PUBLIC_SHIPMENT_SELECT } from "@/lib/webhooks/public-payload";
import { partnerFacingError } from "@/lib/api/domain-error";
import { withApiKey, ok, fail } from "../_lib/guard";
import { fieldErrors, readJson } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/shipments — book a consignment.
 *
 * Validation happens twice on purpose and the two layers do different
 * jobs. Zod checks the *shape* the partner sent, in their vocabulary, and
 * gives a precise message per field. The bulk validator then checks the
 * same row against the *network* — service codes, branch codes, PIN
 * serviceability, COD rules — which is the identical code path a CSV
 * upload takes. A booking made through the API and the same booking made
 * through a spreadsheet therefore succeed and fail for the same reasons,
 * which is not true of any system that writes its API rules twice.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value ?? "");

const schema = z.object({
  serviceCode: text(20),
  originBranchCode: text(20),
  destinationBranchCode: text(20),

  consignor: z.object({
    name: text(120),
    company: optionalText(120),
    phone: text(20),
    email: optionalText(160),
    address: text(300),
    pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
    gstin: optionalText(20),
  }),

  consignee: z.object({
    name: text(120),
    company: optionalText(120),
    phone: text(20),
    email: optionalText(160),
    address: text(300),
    pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
    landmark: optionalText(120),
    gstin: optionalText(20),
  }),

  packageCount: z.number().int().min(1).max(9999),
  actualWeight: z.number().positive(),
  dimensionsCm: z
    .object({
      length: z.number().positive(),
      breadth: z.number().positive(),
      height: z.number().positive(),
    })
    .nullish(),
  declaredValue: z.number().min(0).nullish(),
  goodsDescription: text(300),
  specialInstructions: optionalText(300),
  isFragile: z.boolean().default(false),

  paymentType: z.enum(["PAID", "TO_PAY", "TBB", "COD"]),
  codAmount: z.number().min(0).nullish(),

  customerReference: optionalText(60),
  ewayBillNumber: optionalText(30),
  invoiceNumber: optionalText(40),
  invoiceValue: z.number().min(0).nullish(),
  pickupRequired: z.boolean().default(true),
});

type BookingBody = z.infer<typeof schema>;

/** The partner's JSON, flattened into the cells the shared validator reads. */
function toCells(body: BookingBody): Record<string, string> {
  const number = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);

  return {
    serviceTypeCode: body.serviceCode,
    originBranchCode: body.originBranchCode,
    destinationBranchCode: body.destinationBranchCode,

    consignorName: body.consignor.name,
    consignorCompany: body.consignor.company,
    consignorPhone: body.consignor.phone,
    consignorEmail: body.consignor.email,
    consignorAddress: body.consignor.address,
    consignorPincode: body.consignor.pincode,
    consignorGstin: body.consignor.gstin,

    consigneeName: body.consignee.name,
    consigneeCompany: body.consignee.company,
    consigneePhone: body.consignee.phone,
    consigneeEmail: body.consignee.email,
    consigneeAddress: body.consignee.address,
    consigneePincode: body.consignee.pincode,
    consigneeLandmark: body.consignee.landmark,
    consigneeGstin: body.consignee.gstin,

    packageCount: String(body.packageCount),
    actualWeight: String(body.actualWeight),
    lengthCm: number(body.dimensionsCm?.length),
    breadthCm: number(body.dimensionsCm?.breadth),
    heightCm: number(body.dimensionsCm?.height),
    declaredValue: number(body.declaredValue),
    goodsDescription: body.goodsDescription,
    specialInstructions: body.specialInstructions,
    isFragile: body.isFragile ? "Yes" : "No",

    paymentType: body.paymentType,
    codAmount: number(body.codAmount),

    customerReference: body.customerReference,
    ewayBillNumber: body.ewayBillNumber,
    invoiceNumber: body.invoiceNumber,
    invoiceValue: number(body.invoiceValue),
    pickupRequired: body.pickupRequired ? "Yes" : "No",
  };
}

export async function POST(request: Request): Promise<Response> {
  return withApiKey(request, "shipment.create", async (context) => {
    const body = await readJson(request);
    if (!body.ok) {
      return fail("invalid_request", body.message, context.requestId);
    }

    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      return fail("invalid_request", "Check the fields listed.", context.requestId, {
        fields: fieldErrors(parsed.error),
      });
    }

    const cells = toCells(parsed.data);
    const row = { rowNumber: 1, sourceLine: 1, raw: cells };

    const validationContext = await loadValidationContext([row], context.actor);
    const validated = validateRow(row, validationContext);

    if (!validated.value) {
      return fail("invalid_request", "Check the fields listed.", context.requestId, {
        fields: validated.errors,
      });
    }

    const value = validated.value;

    // A partner retrying a timed-out request must not book twice. The key
    // is namespaced to the API key so two partners cannot collide on the
    // same string.
    const supplied = request.headers.get("idempotency-key")?.trim();
    const idempotencyKey = supplied
      ? `api:${context.key.id}:${supplied.slice(0, 120)}`
      : undefined;

    if (idempotencyKey) {
      const existing = await prisma.shipmentEvent.findUnique({
        where: { orgId_idempotencyKey: { orgId: context.actor.orgId, idempotencyKey } },
        select: { shipment: { select: { id: true, lrNumber: true } } },
      });

      if (existing) {
        return ok(
          {
            lrNumber: existing.shipment.lrNumber,
            shipmentId: existing.shipment.id,
            duplicate: true,
          },
          context.requestId,
          { status: 200 },
        );
      }
    }

    const bookingBranchId =
      context.actor.primaryBranch?.id ?? value.originBranchId;

    const result = await createBooking(
      {
        mode: value.mode,
        serviceTypeId: value.serviceTypeId,
        bookingBranchId,
        originBranchId: value.originBranchId,
        destinationBranchId: value.destinationBranchId,

        consignorId: context.key.customerId,
        consignorName: value.consignorName,
        consignorCompany: value.consignorCompany,
        consignorPhone: value.consignorPhone,
        consignorEmail: value.consignorEmail,
        consignorAddress: value.consignorAddress,
        consignorCityId: value.consignorCityId,
        consignorPincode: value.consignorPincode,
        consignorGstin: value.consignorGstin,

        consigneeName: value.consigneeName,
        consigneeCompany: value.consigneeCompany,
        consigneePhone: value.consigneePhone,
        consigneeEmail: value.consigneeEmail,
        consigneeAddress: value.consigneeAddress,
        consigneeCityId: value.consigneeCityId,
        consigneePincode: value.consigneePincode,
        consigneeLandmark: value.consigneeLandmark,
        consigneeGstin: value.consigneeGstin,

        packageCount: value.packageCount,
        actualWeight: value.actualWeight,
        packages:
          value.lengthCm !== null &&
          value.breadthCm !== null &&
          value.heightCm !== null
            ? Array.from({ length: value.packageCount }, () => ({
                lengthCm: value.lengthCm,
                breadthCm: value.breadthCm,
                heightCm: value.heightCm,
              }))
            : undefined,
        declaredValue: value.declaredValue,
        goodsDescription: value.goodsDescription,
        specialInstructions: value.specialInstructions,
        isFragile: value.isFragile,

        paymentType: value.paymentType,
        codAmount: value.codAmount,

        customerReference: value.customerReference,
        ewayBillNumber: value.ewayBillNumber,
        invoiceNumber: value.invoiceNumber,
        invoiceValue: value.invoiceValue,
        pickupRequired: value.pickupRequired,

        idempotencyKey,
        source: "API",
      },
      context.actor,
    );

    if (!result.ok) {
      // `createBooking` ends in a catch that returns `error.message`
      // verbatim, so an unfielded failure here may be a Prisma error naming
      // a model and a column, or a TenantContextError carrying two
      // organisation ids. It went straight into this 422 body.
      const safe = partnerFacingError(result);
      if (safe.withheld) {
        console.error(`[api/v1] ${context.requestId} booking failed`, safe.withheld);
      }
      return fail("invalid_request", safe.message, context.requestId, {
        field: safe.field,
      });
    }

    await recordAudit({
      user: context.actor,
      action: "CREATE",
      entity: "Shipment",
      entityId: result.shipmentId,
      entityRef: result.lrNumber,
      after: {
        via: "api/v1",
        apiKey: context.key.keyPrefix,
        customerReference: value.customerReference,
      },
    });

    const shipment = await prisma.shipment.findUnique({
      where: { id: result.shipmentId },
      select: PUBLIC_SHIPMENT_SELECT,
    });

    return ok(
      {
        lrNumber: result.lrNumber,
        shipmentId: result.shipmentId,
        barcodes: result.barcodes,
        shipment: shipment ? toPartnerShipment(shipment) : null,
      },
      context.requestId,
      { status: 201 },
    );
  });
}
