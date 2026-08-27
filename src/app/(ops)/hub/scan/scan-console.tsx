"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ScanInput } from "@/components/hub/scan-input";
import { ScanFeed, ScanTally, type ScanFeedItem } from "@/components/hub/scan-feed";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { submitScan } from "./actions";

/**
 * The dock screen.
 *
 * Optimistic by design: the barcode appears in the feed the instant the
 * gun fires, greyed, and turns green or red when the server answers. The
 * alternative — waiting for the round trip before showing anything — makes
 * a fast scanner feel broken and makes operators scan the same box twice.
 */

export type ScanTypeOption = {
  value: "INBOUND" | "OUTBOUND" | "SORT" | "LOAD" | "UNLOAD" | "AUDIT";
  label: string;
  hint: string;
};

export type BinOption = { id: string; code: string; name: string };

export function ScanConsole({
  branchId,
  branchLabel,
  scanTypes,
  bins,
}: {
  branchId: string;
  branchLabel: string;
  scanTypes: ScanTypeOption[];
  bins: BinOption[];
}) {
  const [scanType, setScanType] = useState<ScanTypeOption["value"]>(
    scanTypes[0]?.value ?? "INBOUND",
  );
  const [binId, setBinId] = useState<string | null>(null);
  const [items, setItems] = useState<ScanFeedItem[]>([]);

  // The device id identifies this browser across the session so a
  // ScanRecord can be traced back to the terminal that made it.
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

  const active = scanTypes.find((t) => t.value === scanType) ?? scanTypes[0];

  const handleScan = useCallback(
    async (barcode: string) => {
      const key = crypto.randomUUID();
      const scannedAt = new Date().toISOString();

      setItems((current) => [
        {
          key,
          tone: "pending",
          barcode: barcode.toUpperCase(),
          message: "Recording…",
        },
        ...current,
      ]);

      const result = await submitScan({
        barcode,
        scanType,
        branchId,
        idempotencyKey: key,
        binId: scanType === "SORT" ? binId : null,
        deviceId: deviceId.current,
        scannedAt,
      });

      setItems((current) =>
        current.map((item) =>
          item.key !== key
            ? item
            : result.ok
              ? {
                  key,
                  tone: result.outcome.tone,
                  barcode: result.outcome.barcode,
                  message: result.outcome.newStatus
                    ? `${result.outcome.message} · now ${result.outcome.newStatus.replace(/_/g, " ").toLowerCase()}`
                    : result.outcome.message,
                  lrNumber: result.outcome.lrNumber,
                  packageSequence: result.outcome.packageSequence,
                  packageCount: result.outcome.packageCount,
                  destinationBranchCode: result.outcome.destinationBranchCode,
                  at: result.outcome.at,
                }
              : {
                  key,
                  tone: "bad",
                  barcode: barcode.toUpperCase(),
                  message: result.error,
                  at: new Date().toISOString(),
                },
        ),
      );
    },
    [scanType, branchId, binId],
  );

  const tally = useMemo(() => {
    const settled = items.filter((i) => i.tone !== "pending");
    return {
      total: settled.length,
      ok: settled.filter((i) => i.tone === "ok").length,
      warn: settled.filter((i) => i.tone === "warn").length,
      bad: settled.filter((i) => i.tone === "bad").length,
    };
  }, [items]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {/* Mode */}
        <div className="flex flex-wrap gap-1.5">
          {scanTypes.map((type) => (
            <button
              key={type.value}
              type="button"
              onClick={() => setScanType(type.value)}
              className={cn(
                "rounded-lg border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] transition-colors",
                type.value === scanType
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {type.label}
            </button>
          ))}
        </div>

        {scanType === "SORT" && bins.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Drop into bin
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setBinId(null)}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider",
                  binId === null
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                No bin
              </button>
              {bins.map((bin) => (
                <button
                  key={bin.id}
                  type="button"
                  onClick={() => setBinId(bin.id)}
                  title={bin.name}
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider",
                    binId === bin.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {bin.code}
                </button>
              ))}
            </div>
          </div>
        )}

        <ScanInput
          onScan={handleScan}
          hint={`${active?.hint ?? ""} Scanning at ${branchLabel}. A gun that sends Enter works; one that does not is picked up from the keystroke burst.`}
        />

        <ScanTally
          items={[
            { label: "Scanned", value: tally.total },
            { label: "Accepted", value: tally.ok, tone: tally.ok > 0 ? "ok" : "muted" },
            { label: "Warnings", value: tally.warn, tone: tally.warn > 0 ? "warn" : "muted" },
            { label: "Rejected", value: tally.bad, tone: tally.bad > 0 ? "bad" : "muted" },
          ]}
        />

        <div className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            This session
          </h2>
          {items.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => setItems([])}>
              Clear list
            </Button>
          )}
        </div>

        <ScanFeed items={items} />
      </div>

      <aside className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
            What each mode does
          </h2>
          <dl className="flex flex-col gap-2 text-xs">
            {scanTypes.map((type) => (
              <div key={type.value} className="flex flex-col gap-0.5">
                <dt className="font-medium">{type.label}</dt>
                <dd className="text-muted-foreground">{type.hint}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
          Every scan is written whether or not it moves the consignment. A
          barcode nobody recognises is still recorded — flagged red and kept —
          because the evening reconciliation needs to know what was in the
          operator&rsquo;s hand.
        </p>
      </aside>
    </div>
  );
}
