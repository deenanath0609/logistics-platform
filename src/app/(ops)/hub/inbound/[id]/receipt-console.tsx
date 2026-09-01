"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, PackageX } from "lucide-react";
import { ScanInput } from "@/components/hub/scan-input";
import { ScanFeed, ScanTally, type ScanFeedItem } from "@/components/hub/scan-feed";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  scanIntoInboundReceipt,
  closeInboundReceipt,
  type CloseReceiptState,
} from "../actions";

/**
 * The receiving console.
 *
 * Lines tick green as they fill. What matters most is the counter that
 * never moves: a line stuck at 4 of 5 is the line that will become a
 * shortage, and it should be obvious from across the dock long before
 * anybody presses close.
 */

export type ReceiptLine = {
  shipmentId: string;
  lrNumber: string;
  expectedPackages: number;
  scannedPackages: number;
  destinationCode: string;
  consigneeName: string;
};

const IDLE: CloseReceiptState = {};

export function ReceiptConsole({
  receiptId,
  manifestNumber,
  originCode,
  lines: initialLines,
  canClose,
  sealIntact,
}: {
  receiptId: string;
  manifestNumber: string;
  originCode: string;
  lines: ReceiptLine[];
  canClose: boolean;
  sealIntact: boolean | null;
}) {
  const router = useRouter();
  const [lines, setLines] = useState(initialLines);
  const [items, setItems] = useState<ScanFeedItem[]>([]);
  const [excessBarcodes, setExcessBarcodes] = useState<string[]>([]);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeState, setCloseState] = useState<CloseReceiptState>(IDLE);
  const [closing, startClosing] = useTransition();

  /**
   * Closing, submitted by hand.
   *
   * `<form action={…}>` in React 19 resets the form as soon as the action
   * returns, and this one carries the seal answer and the remarks the
   * receiving clerk writes for the dispatching branch. A refusal — the
   * receipt already closed by a colleague, a permission the role turns out
   * not to hold — threw both away and left an empty dialog behind an
   * error message.
   */
  function submitClose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startClosing(async () => {
      const result = await closeInboundReceipt(IDLE, formData);
      setCloseState(result);
      if (result.ok) setCloseOpen(false);
    });
  }

  const deviceId = useRef<string>(
    typeof window === "undefined"
      ? "server"
      : (window.sessionStorage.getItem("hub.deviceId") ??
        (() => {
          const id = `web-${crypto.randomUUID().slice(0, 8)}`;
          window.sessionStorage.setItem("hub.deviceId", id);
          return id;
        })()),
  );

  const handleScan = useCallback(
    async (barcode: string) => {
      const key = crypto.randomUUID();

      setItems((current) => [
        { key, tone: "pending", barcode: barcode.toUpperCase(), message: "Checking against the manifest…" },
        ...current,
      ]);

      const result = await scanIntoInboundReceipt({
        receiptId,
        barcode,
        idempotencyKey: key,
        deviceId: deviceId.current,
        scannedAt: new Date().toISOString(),
      });

      if (!result.ok) {
        setItems((current) =>
          current.map((item) =>
            item.key === key
              ? { key, tone: "bad", barcode: barcode.toUpperCase(), message: result.error, at: new Date().toISOString() }
              : item,
          ),
        );
        return;
      }

      const { outcome, line } = result;

      if (line) {
        setLines((current) =>
          current.map((l) =>
            l.shipmentId === line.shipmentId
              ? { ...l, scannedPackages: line.scannedPackages }
              : l,
          ),
        );
      }

      if (!outcome.isExpected && !outcome.duplicate) {
        setExcessBarcodes((current) =>
          current.includes(outcome.barcode) ? current : [...current, outcome.barcode],
        );
      }

      setItems((current) =>
        current.map((item) =>
          item.key === key
            ? {
                key,
                tone: outcome.tone,
                barcode: outcome.barcode,
                message: outcome.message,
                lrNumber: outcome.lrNumber,
                packageSequence: outcome.packageSequence,
                packageCount: outcome.packageCount,
                destinationBranchCode: outcome.destinationBranchCode,
                at: outcome.at,
              }
            : item,
        ),
      );
    },
    [receiptId],
  );

  const totals = useMemo(() => {
    const expected = lines.reduce((sum, l) => sum + l.expectedPackages, 0);
    const scanned = lines.reduce((sum, l) => sum + Math.min(l.scannedPackages, l.expectedPackages), 0);
    return {
      expected,
      scanned,
      short: Math.max(0, expected - scanned),
      excess: excessBarcodes.length,
      complete: lines.filter((l) => l.scannedPackages >= l.expectedPackages).length,
    };
  }, [lines, excessBarcodes]);

  // Closed successfully — pull the fresh, server-rendered page in.
  if (closeState.ok) {
    return (
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-6">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-ok" />
          <h2 className="font-medium">Receipt closed</h2>
        </div>
        <p className="text-sm text-muted-foreground">{closeState.summary}</p>
        {closeState.warnings?.map((warning) => (
          <p key={warning} className="rounded-md bg-warn-muted px-3 py-2 text-xs text-warn">
            {warning}
          </p>
        ))}
        <div className="flex gap-2">
          <Button onClick={() => router.refresh()}>See the reconciliation</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-4">
        <ScanInput
          onScan={handleScan}
          hint={`Every read is checked against ${manifestNumber}. A barcode that is not on it goes red and becomes an excess against ${originCode} at close.`}
        />

        <ScanTally
          items={[
            { label: "Expected", value: totals.expected },
            {
              label: "Received",
              value: totals.scanned,
              tone: totals.scanned === totals.expected ? "ok" : "muted",
            },
            {
              label: "Still missing",
              value: totals.short,
              tone: totals.short > 0 ? "bad" : "ok",
            },
            {
              label: "Unexpected",
              value: totals.excess,
              tone: totals.excess > 0 ? "warn" : "muted",
            },
          ]}
        />

        {/* Lines */}
        <div className="flex flex-col gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Manifest lines — {totals.complete} of {lines.length} complete
          </h2>

          <ul className="flex flex-col gap-1">
            {lines.map((line) => {
              const done = line.scannedPackages >= line.expectedPackages;
              const started = line.scannedPackages > 0;

              return (
                <li
                  key={line.shipmentId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                    done
                      ? "border-ok/30 bg-ok-muted"
                      : started
                        ? "border-warn/30 bg-warn-muted"
                        : "bg-card",
                  )}
                >
                  <span className="shrink-0">
                    {done ? (
                      <CheckCircle2 className="size-4 text-ok" />
                    ) : (
                      <PackageX
                        className={cn("size-4", started ? "text-warn" : "text-muted-foreground")}
                      />
                    )}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-xs font-medium">{line.lrNumber}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {line.consigneeName} · {line.destinationCode}
                    </span>
                  </div>

                  <span
                    className={cn(
                      "shrink-0 font-mono text-sm font-semibold tabular",
                      done ? "text-ok" : started ? "text-warn" : "text-muted-foreground",
                    )}
                  >
                    {line.scannedPackages}/{line.expectedPackages}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <aside className="flex flex-col gap-4">
        {canClose && (
          <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
            <DialogTrigger
              render={
                <Button
                  className="w-full"
                  variant={
                    totals.short > 0 || totals.excess > 0 ? "destructive" : "default"
                  }
                />
              }
            >
              Close &amp; reconcile
            </DialogTrigger>

            <DialogContent className="sm:max-w-md">
              <form onSubmit={submitClose}>
                <input type="hidden" name="receiptId" value={receiptId} />

                <DialogHeader>
                  <DialogTitle>Close {manifestNumber}</DialogTitle>
                  <DialogDescription>
                    {totals.short === 0 && totals.excess === 0
                      ? `All ${totals.expected} packages are accounted for. Closing files the receipt as clean.`
                      : "Closing raises these against the dispatching branch. It cannot be undone from this screen."}
                  </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 py-4">
                  {(totals.short > 0 || totals.excess > 0) && (
                    <ul className="flex flex-col gap-1.5 text-sm">
                      {totals.short > 0 && (
                        <li className="flex items-center justify-between gap-3 rounded-md bg-bad-muted px-3 py-2 text-bad">
                          <span>Short — never scanned here</span>
                          <span className="font-mono font-semibold tabular">
                            {totals.short}
                          </span>
                        </li>
                      )}
                      {totals.excess > 0 && (
                        <li className="flex items-center justify-between gap-3 rounded-md bg-warn-muted px-3 py-2 text-warn">
                          <span>Excess — not on this manifest</span>
                          <span className="font-mono font-semibold tabular">
                            {totals.excess}
                          </span>
                        </li>
                      )}
                    </ul>
                  )}

                  <div className="flex flex-col gap-2">
                    <Label>Seal on arrival</Label>
                    {[
                      { value: "yes", label: "Intact" },
                      { value: "no", label: "Broken or missing" },
                      { value: "unknown", label: "Not checked" },
                    ].map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        <input
                          type="radio"
                          name="sealIntact"
                          value={option.value}
                          defaultChecked={
                            option.value ===
                            (sealIntact === null ? "unknown" : sealIntact ? "yes" : "no")
                          }
                          className="accent-primary"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="close-remarks">Remarks</Label>
                    <Textarea
                      id="close-remarks"
                      name="remarks"
                      rows={3}
                      maxLength={500}
                      placeholder="Anything the dispatching branch should know — pallet condition, late arrival, driver's account of a missing box."
                    />
                  </div>
                </div>

                {closeState.error && (
                  <p className="pb-2 text-sm text-bad">{closeState.error}</p>
                )}

                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setCloseOpen(false)}
                    disabled={closing}
                  >
                    Keep scanning
                  </Button>
                  <Button type="submit" disabled={closing}>
                    {closing && <Loader2 className="animate-spin" />}
                    Close receipt
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}

        {!canClose && (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            You can scan into this receipt but not close it. Closing raises
            discrepancies against another branch, which needs the
            receipt.close permission.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Scanned this session
          </h2>
          <ScanFeed
            items={items}
            emptyLabel="Nothing scanned yet. Start with the first box off the truck."
          />
        </div>
      </aside>
    </div>
  );
}
