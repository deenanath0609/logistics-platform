"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BadgeCheck,
  CircleX,
  KeyRound,
  PackageCheck,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignaturePad } from "@/components/delivery/signature-pad";
import { PhotoCapture } from "@/components/delivery/photo-capture";
import { enqueue } from "@/lib/delivery/offline-queue";
import { currentPosition } from "@/lib/delivery/image";
import { requestOtpAction } from "@/app/(field)/delivery/actions";

export type FieldReasonCode = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requiresPhoto: boolean;
  requiresRemarks: boolean;
  triggersReattempt: boolean;
  isChargeable: boolean;
};

const RELATIONS = [
  "Self",
  "Family member",
  "Neighbour",
  "Security guard",
  "Reception",
  "Colleague",
  "Other",
];

const COD_MODES = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "CARD", label: "Card" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "BANK_TRANSFER", label: "Transfer" },
] as const;

type Mode = "idle" | "deliver" | "fail";

/**
 * What the agent does while standing at the door.
 *
 * Every submission goes into the offline queue and confirms instantly. The
 * agent is told the stop is done and walks away; the phone deals with the
 * server whenever it next can. That is the difference between an app that
 * works in a basement car park and one that does not.
 */
export function DoorActions({
  taskId,
  lrNumber,
  consigneeName,
  codAmount,
  runStarted,
  reasonCodes,
}: {
  taskId: string;
  lrNumber: string;
  consigneeName: string;
  codAmount: number;
  runStarted: boolean;
  reasonCodes: FieldReasonCode[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [submitting, startSubmit] = useTransition();

  // Delivery capture
  const [receiverName, setReceiverName] = useState(consigneeName);
  const [receiverRelation, setReceiverRelation] = useState("Self");
  const [signature, setSignature] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [remarks, setRemarks] = useState("");

  // OTP
  const [otpCode, setOtpCode] = useState("");
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [otpSending, startOtp] = useTransition();

  // COD
  const [codCollected, setCodCollected] = useState(
    codAmount > 0 ? String(codAmount) : "",
  );
  const [codMode, setCodMode] = useState<(typeof COD_MODES)[number]["value"]>("CASH");
  const [codReference, setCodReference] = useState("");

  // Failure capture
  const [reasonId, setReasonId] = useState("");
  const [failPhoto, setFailPhoto] = useState<string | null>(null);
  const [failRemarks, setFailRemarks] = useState("");

  const reason = useMemo(
    () => reasonCodes.find((row) => row.id === reasonId) ?? null,
    [reasonCodes, reasonId],
  );

  function sendOtp() {
    startOtp(async () => {
      const result = await requestOtpAction(taskId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOtpSentTo(result.sentTo);
      toast.success(
        result.devCode
          ? `Code sent to ${result.sentTo}. Development code: ${result.devCode}`
          : `Code sent to ${result.sentTo}.`,
      );
    });
  }

  function submitDelivery() {
    if (receiverName.trim().length < 2) {
      toast.error("Who received it?");
      return;
    }
    if (!signature && !photo) {
      toast.error("Take a signature or a photograph — one of the two is proof.");
      return;
    }
    if (codAmount > 0) {
      const collected = Number(codCollected);
      if (!Number.isFinite(collected) || collected < codAmount) {
        toast.error(`₹${codAmount.toLocaleString("en-IN")} is due. Collect it in full.`);
        return;
      }
      if (codMode !== "CASH" && !codReference.trim()) {
        toast.error("Enter the transaction reference.");
        return;
      }
    }

    startSubmit(async () => {
      const position = await currentPosition();
      const occurredAt = new Date();

      await enqueue(
        "DELIVER",
        {
          taskId,
          receiverName: receiverName.trim(),
          receiverRelation,
          signatureDataUrl: signature,
          photoDataUrl: photo,
          otpCode: otpCode.trim() || null,
          remarks: remarks.trim() || null,
          latitude: position?.latitude ?? null,
          longitude: position?.longitude ?? null,
          cod:
            codAmount > 0
              ? {
                  amountCollected: Number(codCollected),
                  mode: codMode,
                  reference: codReference.trim() || null,
                }
              : null,
        },
        { occurredAt },
      );

      toast.success(`${lrNumber} delivered to ${receiverName.trim()}.`);
      router.push("/delivery");
      router.refresh();
    });
  }

  function submitFailure() {
    if (!reason) {
      toast.error("Choose what happened.");
      return;
    }
    if (reason.requiresPhoto && !failPhoto) {
      toast.error("This reason needs a photo.");
      return;
    }
    if (reason.requiresRemarks && !failRemarks.trim()) {
      toast.error("This reason needs a note.");
      return;
    }

    startSubmit(async () => {
      const position = await currentPosition();
      const occurredAt = new Date();

      await enqueue(
        "FAILED_ATTEMPT",
        {
          taskId,
          reasonCodeId: reason.id,
          remarks: failRemarks.trim() || null,
          photoDataUrl: failPhoto,
          latitude: position?.latitude ?? null,
          longitude: position?.longitude ?? null,
        },
        { occurredAt },
      );

      toast.success(
        reason.triggersReattempt
          ? "Attempt recorded. The branch will schedule another visit."
          : "Attempt recorded. The branch has been told.",
      );
      router.push("/delivery");
      router.refresh();
    });
  }

  // Not a gate. The out-scan may still be sitting in the queue behind this
  // stop, and a parcel in someone's hands beats a tidy event order — the
  // server writes the missing scan itself. Saying so is enough.
  const outScanNotice = !runStarted ? (
    <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      The branch has not seen your out-scan yet. Carry on — it will catch up
      when this phone next has signal.
    </p>
  ) : null;

  if (mode === "idle") {
    return (
      <div className="flex flex-col gap-3 pb-4">
        {outScanNotice}
        <Button
          size="lg"
          className="min-h-14 w-full text-base"
          onClick={() => setMode("deliver")}
        >
          <PackageCheck />
          Deliver
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="min-h-14 w-full text-base"
          onClick={() => setMode("fail")}
        >
          <CircleX />
          Could not deliver
        </Button>
      </div>
    );
  }

  if (mode === "deliver") {
    return (
      <section className="flex flex-col gap-5 pb-6">
        <SectionTitle
          title="Handing over"
          onBack={() => setMode("idle")}
        />

        {/* OTP */}
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Delivery code
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={otpSending}
              onClick={sendOtp}
            >
              <Send />
              {otpSentTo ? "Resend" : "Send code"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 digits"
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))}
              className="h-12 flex-1 text-center font-mono text-lg tracking-[0.3em]"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {otpSentTo
              ? `Sent to ${otpSentTo}. Ask the consignee to read it out.`
              : "Optional. A signature or photograph is proof on its own — the code is a second one."}
          </p>
        </div>

        {/* Receiver */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receiverName">Who is receiving it</Label>
            <Input
              id="receiverName"
              value={receiverName}
              onChange={(event) => setReceiverName(event.target.value)}
              className="h-12 text-base"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Relationship to the consignee</Label>
            <div className="flex flex-wrap gap-2">
              {RELATIONS.map((relation) => (
                <button
                  key={relation}
                  type="button"
                  onClick={() => setReceiverRelation(relation)}
                  className={`min-h-10 rounded-lg border px-3 text-sm ${
                    receiverRelation === relation
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card active:bg-muted"
                  }`}
                >
                  {relation}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* COD */}
        {codAmount > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border-2 border-warn/50 bg-warn-muted/40 p-4">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-warn">
                Cash on delivery
              </span>
              <span className="text-lg font-semibold tabular text-warn">
                ₹{codAmount.toLocaleString("en-IN")}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="codCollected">Amount taken</Label>
              <Input
                id="codCollected"
                inputMode="decimal"
                value={codCollected}
                onChange={(event) => setCodCollected(event.target.value)}
                className="h-12 text-base tabular"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {COD_MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setCodMode(option.value)}
                  className={`min-h-10 flex-1 rounded-lg border px-2 text-sm ${
                    codMode === option.value
                      ? "border-warn bg-warn text-warn-foreground"
                      : "bg-card active:bg-muted"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {codMode !== "CASH" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="codReference">Reference</Label>
                <Input
                  id="codReference"
                  value={codReference}
                  onChange={(event) => setCodReference(event.target.value)}
                  placeholder="UPI / cheque / transaction number"
                  className="h-12 text-base"
                />
              </div>
            )}
          </div>
        )}

        <SignaturePad onChange={setSignature} />

        <PhotoCapture
          onChange={setPhoto}
          label="Delivery photograph"
          hint="The parcel at the door, or with the person receiving it."
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="remarks">Note</Label>
          <Textarea
            id="remarks"
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            rows={2}
            placeholder="Optional"
          />
        </div>

        <Button
          size="lg"
          className="min-h-14 w-full text-base"
          disabled={submitting}
          onClick={submitDelivery}
        >
          <BadgeCheck />
          {submitting ? "Saving…" : "Mark delivered"}
        </Button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5 pb-6">
      <SectionTitle title="What happened" onBack={() => setMode("idle")} />

      <div className="flex flex-col gap-2">
        {reasonCodes.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No failure reasons have been configured. Call the branch.
          </p>
        )}
        {reasonCodes.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setReasonId(row.id)}
            className={`flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-xl border px-4 py-3 text-left ${
              reasonId === row.id
                ? "border-primary bg-accent"
                : "bg-card active:bg-muted"
            }`}
          >
            <span className="text-sm font-medium">{row.name}</span>
            {row.description && (
              <span className="text-xs text-muted-foreground">{row.description}</span>
            )}
            <span className="flex flex-wrap gap-2 pt-0.5 font-mono text-[0.55rem] uppercase tracking-wider">
              {row.triggersReattempt && (
                <span className="rounded-sm bg-info-muted px-1.5 py-0.5 text-info">
                  another visit
                </span>
              )}
              {row.isChargeable && (
                <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 text-warn">
                  chargeable
                </span>
              )}
              {row.requiresPhoto && (
                <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 text-bad">
                  photo needed
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {reason && (
        <>
          <PhotoCapture
            onChange={setFailPhoto}
            label="Photo"
            required={reason.requiresPhoto}
            hint={
              reason.requiresPhoto
                ? "This reason cannot be submitted without one."
                : "Optional, but it settles arguments later."
            }
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="failRemarks">
              Note{reason.requiresRemarks ? "" : " (optional)"}
            </Label>
            <Textarea
              id="failRemarks"
              value={failRemarks}
              onChange={(event) => setFailRemarks(event.target.value)}
              rows={3}
              placeholder="What did you find? Anything the next agent should know."
            />
          </div>

          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            This does not cancel the delivery. The parcel comes back to the
            branch and stays owed — every visit is kept on the record.
          </p>

          <Button
            size="lg"
            variant="outline"
            className="min-h-14 w-full text-base"
            disabled={submitting}
            onClick={submitFailure}
          >
            <CircleX />
            {submitting ? "Saving…" : "Record attempt"}
          </Button>
        </>
      )}
    </section>
  );
}

function SectionTitle({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
