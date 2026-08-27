"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, PackageX } from "lucide-react";
import { toast } from "sonner";
import { ScanInput } from "@/components/hub/scan-input";
import { ScanFeed, ScanTally, type ScanFeedItem } from "@/components/hub/scan-feed";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { scanToLoadAction, closeSheetAction, type LoadingState } from "./actions";

const IDLE: LoadingState = {};

export type LoadLine = {
  shipmentId: string;
  lrNumber: string;
  expectedPackages: number;
  loadedPackages: number;
  destinationCode: string;
};

/**
 * Scan-to-load.
 *
 * The close button stays disabled while the two columns disagree — a box
 * on the paperwork that was never scanned, or a box scanned that is not
 * on the paperwork. There is no override, because a sheet that closes
 * over a mismatch is worth nothing at the other end.
 */
export function LoadingConsole({
  loadingSheetId,
  tripId,
  tripNumber,
  lines: initialLines,
  strayBarcodes: initialStrays,
}: {
  loadingSheetId: string;
  tripId: string;
  tripNumber: string;
  lines: LoadLine[];
  strayBarcodes: string[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState(initialLines);
  const [strays, setStrays] = useState<string[]>(initialStrays);
  const [items, setItems] = useState<ScanFeedItem[]>([]);
  const [closeState, closeAction, closing] = useActionState(closeSheetAction, IDLE);

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

  useEffect(() => {
    if (closeState.ok && closeState.message) {
      toast.success(closeState.message);
      router.push(`/dispatch/trips/${tripId}`);
    } else if (closeState.error) {
      toast.error(closeState.error, { duration: 10_000 });
    }
  }, [closeState, router, tripId]);

  const handleScan = useCallback(
    async (barcode: string) => {
      const key = crypto.randomUUID();

      setItems((current) => [
        { key, tone: "pending", barcode: barcode.toUpperCase(), message: "Loading…" },
        ...current,
      ]);

      const result = await scanToLoadAction({
        loadingSheetId,
        barcode,
        idempotencyKey: key,
        deviceId: deviceId.current,
        scannedAt: new Date().toISOString(),
      });

      if (!result.ok) {
        setItems((current) =>
          current.map((item) =>
            item.key === key
              ? {
                  key,
                  tone: "bad",
                  barcode: barcode.toUpperCase(),
                  message: result.error,
                  at: new Date().toISOString(),
                }
              : item,
          ),
        );
        return;
      }

      const { outcome } = result;

      if (outcome.isExpected && outcome.shipmentId && !outcome.duplicate) {
        setLines((current) =>
          current.map((line) =>
            line.shipmentId === outcome.shipmentId
              ? {
                  ...line,
                  loadedPackages: Math.min(
                    line.expectedPackages,
                    line.loadedPackages + 1,
                  ),
                }
              : line,
          ),
        );
      }

      if (!outcome.isExpected) {
        setStrays((current) =>
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
                message: outcome.isExpected
                  ? outcome.message
                  : `${outcome.barcode} is not on this trip's paperwork. Take it off, or add it to a manifest first.`,
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
    [loadingSheetId],
  );

  const totals = useMemo(() => {
    const expected = lines.reduce((sum, l) => sum + l.expectedPackages, 0);
    const loaded = lines.reduce((sum, l) => sum + l.loadedPackages, 0);
    return {
      expected,
      loaded,
      notLoaded: Math.max(0, expected - loaded),
      notExpected: strays.length,
      canClose: expected === loaded && strays.length === 0,
    };
  }, [lines, strays]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <ScanInput
          onScan={handleScan}
          hint={`Scan each package as it goes on the vehicle. ${tripNumber} cannot gate out until this sheet closes, and it cannot close while the two columns disagree.`}
        />

        <ScanTally
          items={[
            { label: "On paperwork", value: totals.expected },
            {
              label: "Loaded",
              value: totals.loaded,
              tone: totals.loaded === totals.expected ? "ok" : "muted",
            },
            {
              label: "Not loaded",
              value: totals.notLoaded,
              tone: totals.notLoaded > 0 ? "bad" : "ok",
            },
            {
              label: "Not on paperwork",
              value: totals.notExpected,
              tone: totals.notExpected > 0 ? "bad" : "ok",
            },
          ]}
        />

        <div className="flex flex-col gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Consignments to load
          </h2>
          <ul className="flex flex-col gap-1">
            {lines.map((line) => {
              const done = line.loadedPackages >= line.expectedPackages;
              return (
                <li
                  key={line.shipmentId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2",
                    done ? "border-ok/30 bg-ok-muted" : "bg-card",
                  )}
                >
                  <span className="shrink-0">
                    {done ? (
                      <CheckCircle2 className="size-4 text-ok" />
                    ) : (
                      <PackageX className="size-4 text-muted-foreground" />
                    )}
                  </span>
                  <span className="flex-1 font-mono text-xs font-medium">
                    {line.lrNumber}
                  </span>
                  <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                    → {line.destinationCode}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-sm font-semibold tabular",
                      done ? "text-ok" : "text-muted-foreground",
                    )}
                  >
                    {line.loadedPackages}/{line.expectedPackages}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <aside className="flex flex-col gap-4">
        <form action={closeAction} className="flex flex-col gap-2">
          <input type="hidden" name="loadingSheetId" value={loadingSheetId} />
          <input type="hidden" name="tripId" value={tripId} />

          <Button type="submit" className="w-full" disabled={closing || !totals.canClose}>
            {closing && <Loader2 className="animate-spin" />}
            Close loading sheet
          </Button>

          {!totals.canClose && (
            <p className="rounded-md bg-warn-muted px-3 py-2 text-xs text-warn">
              {totals.notLoaded > 0 && (
                <>
                  {totals.notLoaded} package{totals.notLoaded === 1 ? "" : "s"} on the
                  paperwork {totals.notLoaded === 1 ? "has" : "have"} not been scanned
                  onto the vehicle.
                </>
              )}
              {totals.notLoaded > 0 && totals.notExpected > 0 && " "}
              {totals.notExpected > 0 && (
                <>
                  {totals.notExpected} scanned package
                  {totals.notExpected === 1 ? "" : "s"}{" "}
                  {totals.notExpected === 1 ? "is" : "are"} not on the paperwork.
                </>
              )}
            </p>
          )}
        </form>

        {strays.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-bad/30 bg-bad-muted p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-bad">
              Scanned but not on the paperwork
            </h2>
            <ul className="flex flex-col gap-1">
              {strays.map((barcode) => (
                <li key={barcode} className="font-mono text-xs break-all text-bad">
                  {barcode}
                </li>
              ))}
            </ul>
            <p className="text-xs text-bad/80">
              Either take these off the vehicle, or add their consignments to a
              manifest on this trip and refresh.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            This session
          </h2>
          <ScanFeed items={items} emptyLabel="Nothing loaded yet." />
        </div>
      </aside>
    </div>
  );
}
