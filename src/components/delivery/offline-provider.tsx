"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CloudOff, RefreshCw, TriangleAlert, Check } from "lucide-react";
import {
  configureQueue,
  startQueue,
  subscribe,
  flush,
  type QueueStatus,
} from "@/lib/delivery/offline-queue";
import { syncFieldAction } from "@/app/(field)/delivery/actions";

/**
 * Wires the offline queue to the server and shows the agent where things
 * stand.
 *
 * The bar is deliberately quiet when everything is synced: a field app that
 * shouts about its plumbing trains people to ignore it. It speaks up for
 * exactly two situations — work waiting to go up, and work the server
 * refused, which is the only kind an agent can actually do something about.
 */
export function OfflineProvider() {
  const router = useRouter();
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const lastSynced = useRef<number | null>(null);

  useEffect(() => {
    configureQueue(async (action) => {
      const outcome = await syncFieldAction({
        id: action.id,
        kind: action.kind,
        occurredAt: action.occurredAt,
        payload: action.payload,
      });
      return outcome;
    });

    const stop = startQueue();
    const unsubscribe = subscribe(setStatus);

    return () => {
      unsubscribe();
      stop();
    };
  }, []);

  // Pull the server's view back down once the queue empties, so a stop
  // confirmed offline stops looking pending the moment it lands.
  useEffect(() => {
    if (!status?.lastSyncedAt) return;
    if (lastSynced.current === status.lastSyncedAt) return;
    lastSynced.current = status.lastSyncedAt;
    if (status.pending === 0) router.refresh();
  }, [status?.lastSyncedAt, status?.pending, router]);

  if (!status) return null;

  const quiet = status.online && status.pending === 0 && status.blocked === 0;
  if (quiet) return null;

  if (status.blocked > 0) {
    return (
      <Bar tone="bad" icon="alert">
        {status.blocked} action{status.blocked > 1 ? "s" : ""} the office
        rejected. Show this phone to your branch.
      </Bar>
    );
  }

  if (!status.online) {
    return (
      <Bar tone="warn" icon="offline">
        Offline — {status.pending} saved on this phone. They will go up on
        their own.
      </Bar>
    );
  }

  return (
    <Bar tone="info" icon={status.syncing ? "syncing" : "check"}>
      <button type="button" onClick={() => void flush()} className="underline-offset-2 hover:underline">
        Sending {status.pending}…
      </button>
    </Bar>
  );
}

function Bar({
  tone,
  icon,
  children,
}: {
  tone: "info" | "warn" | "bad";
  icon: "offline" | "syncing" | "alert" | "check";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "bad"
      ? "bg-bad-muted text-bad"
      : tone === "warn"
        ? "bg-warn-muted text-warn"
        : "bg-info-muted text-info";

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 text-[0.8rem] font-medium ${toneClass}`}
      role="status"
    >
      <Icon name={icon} />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Icons are chosen by name here, never handed down from a server component. */
function Icon({ name }: { name: "offline" | "syncing" | "alert" | "check" }) {
  switch (name) {
    case "offline":
      return <CloudOff className="size-4 shrink-0" />;
    case "syncing":
      return <RefreshCw className="size-4 shrink-0 animate-spin" />;
    case "alert":
      return <TriangleAlert className="size-4 shrink-0" />;
    default:
      return <Check className="size-4 shrink-0" />;
  }
}
