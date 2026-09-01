import type { Metadata } from "next";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createPackageType,
  updatePackageType,
  setPackageTypeActive,
} from "./actions";

export const metadata: Metadata = { title: "Package types" };
export const dynamic = "force-dynamic";

const FIELDS: FieldDef[] = [
  { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "CARTON" },
  { type: "text", name: "name", label: "Name", required: true, half: true, placeholder: "Carton" },
  { type: "textarea", name: "description", label: "Description" },
  {
    type: "switch",
    name: "isFragile",
    label: "Fragile",
    help: "Prompts handling instructions at booking and flags it on the label.",
    defaultOn: false,
  },
  {
    type: "switch",
    name: "isStackable",
    label: "Stackable",
    help: "Used by load planning to work out truck utilisation.",
  },
  { type: "switch", name: "isActive", label: "Active" },
];

export default async function PackageTypesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");

  const rows = await prisma.packageType.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Package types"
        description="How goods are packed. Fragile and stackable flags drive handling instructions and load planning."
        actions={
          writable && (
            <MasterFormDialog
              title="New package type"
              fields={FIELDS}
              action={createPackageType}
              submitLabel="Create"
              trigger={{ label: "New package type", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState title="No package types yet" />
        ) : (
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Handling</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.isFragile && (
                        <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                          Fragile
                        </span>
                      )}
                      {!row.isStackable && (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                          No stack
                        </span>
                      )}
                      {row.isStackable && !row.isFragile && (
                        <span className="text-xs text-muted-foreground">Standard</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {row.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "secondary" : "outline"}>
                      {row.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {writable && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <MasterFormDialog
                          title={`Edit ${row.code}`}
                          fields={FIELDS}
                          action={updatePackageType}
                          record={row as unknown as Record<string, unknown>}
                          trigger={{
                            label: `Edit ${row.code}`,
                            icon: "pencil",
                            variant: "ghost",
                            size: "icon-sm",
                            iconOnly: true,
                          }}
                        />
                        <ToggleActive
                          id={row.id}
                          isActive={row.isActive}
                          label={row.code}
                          action={setPackageTypeActive}
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
