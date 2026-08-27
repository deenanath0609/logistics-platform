"use client";

import {
  Bike,
  Building2,
  CalendarClock,
  ClipboardList,
  Contact,
  FileSignature,
  FileText,
  Fuel,
  Gauge,
  Handshake,
  Hourglass,
  IdCard,
  MessageSquareWarning,
  Navigation,
  PackageCheck,
  Receipt,
  TrendingUp,
  TriangleAlert,
  Truck,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icons, resolved from a name.
 *
 * The report registry lives on the server and names its icon as a string.
 * A server component cannot hand a Lucide component across to a client
 * one — functions do not serialise — so the mapping happens here, once,
 * where the names arrive as data.
 */
const ICONS: Record<string, LucideIcon> = {
  Bike,
  Building2,
  CalendarClock,
  ClipboardList,
  Contact,
  FileSignature,
  FileText,
  Fuel,
  Gauge,
  Handshake,
  Hourglass,
  IdCard,
  MessageSquareWarning,
  Navigation,
  PackageCheck,
  Receipt,
  TrendingUp,
  TriangleAlert,
  Truck,
  Warehouse,
};

export function ReportIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  // An unknown name falls back rather than crashing the index: a missing
  // icon is a cosmetic problem, and a blank reports page is not.
  const Icon = ICONS[name] ?? FileText;
  return <Icon className={cn("size-4", className)} aria-hidden />;
}
