"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2, Save, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { updateRolePermissions } from "../actions";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

export type PermissionRow = {
  code: string;
  module: string;
  resource: string;
  action: string;
  description: string | null;
  isSensitive: boolean;
};

const MODULE_LABEL: Record<string, string> = {
  booking: "Booking & shipments",
  pickup: "Pickup",
  hub: "Hub operations",
  dispatch: "Manifest & dispatch",
  delivery: "Delivery & POD",
  fleet: "Fleet",
  tracking: "Tracking",
  exception: "Exceptions & complaints",
  party: "Customers & vendors",
  finance: "Finance",
  report: "Reporting",
  admin: "Administration",
};

export function PermissionMatrix({
  roleId,
  roleName,
  isSuperAdmin,
  permissions,
  granted,
  editable,
}: {
  roleId: string;
  roleName: string;
  isSuperAdmin: boolean;
  permissions: PermissionRow[];
  granted: string[];
  editable: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    updateRolePermissions,
    EMPTY,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set(granted));

  useEffect(() => {
    if (state.ok) toast.success(state.message ?? "Saved.");
    else if (state.error) toast.error(state.error);
  }, [state]);

  const modules = [...new Set(permissions.map((p) => p.module))];

  function toggle(code: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  function toggleModule(module: string, on: boolean) {
    const codes = permissions.filter((p) => p.module === module).map((p) => p.code);
    setSelected((current) => {
      const next = new Set(current);
      for (const code of codes) {
        if (on) next.add(code);
        else next.delete(code);
      }
      return next;
    });
  }

  const dirty =
    selected.size !== granted.length ||
    granted.some((code) => !selected.has(code));

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="roleId" value={roleId} />
      {[...selected].map((code) => (
        <input key={code} type="hidden" name="permissionCodes" value={code} />
      ))}

      {isSuperAdmin && (
        <p className="flex items-start gap-2.5 rounded-md border border-warn/40 bg-warn-muted px-3 py-2.5 text-sm text-warn">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Super Admin must keep every permission — removing any would lock
            everyone out of the parts of the system only this role can reach.
            Create a separate role if you need a narrower one.
          </span>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {modules.map((module) => {
          const rows = permissions.filter((p) => p.module === module);
          const on = rows.filter((p) => selected.has(p.code)).length;
          const all = on === rows.length;

          return (
            <section
              key={module}
              className="flex flex-col gap-2 rounded-lg border bg-card p-4"
            >
              <header className="flex items-center justify-between gap-3 pb-1">
                <h3 className="text-sm font-semibold">
                  {MODULE_LABEL[module] ?? module}
                </h3>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[0.65rem] text-muted-foreground tabular">
                    {on}/{rows.length}
                  </span>
                  {editable && !isSuperAdmin && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleModule(module, !all)}
                    >
                      {all ? "None" : "All"}
                    </Button>
                  )}
                </div>
              </header>

              <div className="flex flex-col gap-1">
                {rows.map((permission) => (
                  <label
                    key={permission.code}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/40"
                  >
                    <Checkbox
                      checked={selected.has(permission.code)}
                      onCheckedChange={(value) =>
                        toggle(permission.code, Boolean(value))
                      }
                      disabled={!editable || isSuperAdmin}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm">
                        {permission.description}
                        {permission.isSensitive && (
                          <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-bad">
                            Sensitive
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        {permission.code}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {editable && !isSuperAdmin && (
        <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3 shadow-lg">
          <p className="text-sm text-muted-foreground">
            {dirty ? (
              <>
                <span className="font-medium text-foreground tabular">
                  {selected.size}
                </span>{" "}
                permissions selected — unsaved
              </>
            ) : (
              `${selected.size} permissions granted to ${roleName}`
            )}
          </p>
          <Button type="submit" disabled={pending || !dirty}>
            {pending ? <Loader2 className="animate-spin" /> : <Save />}
            Save permissions
          </Button>
        </div>
      )}
    </form>
  );
}
