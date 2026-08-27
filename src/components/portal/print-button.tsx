"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Until the worker renders the branded PDF, printing the page IS the
 * download — every browser prints to PDF. One client component so the POD
 * page itself stays on the server.
 */
export function PrintButton({ label = "Print / save as PDF" }: { label?: string }) {
  return (
    <Button variant="outline" onClick={() => window.print()} className="print:hidden">
      <Printer />
      {label}
    </Button>
  );
}
