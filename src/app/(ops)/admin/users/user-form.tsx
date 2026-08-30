"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, Plus, Pencil, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

export type RoleOption = {
  id: string;
  code: string;
  name: string;
  scope: string;
  description: string | null;
};

export type UserRecord = {
  id: string;
  name: string;
  mobile: string;
  email: string | null;
  employeeCode: string | null;
  primaryBranchId: string | null;
  status: string;
  isFieldUser: boolean;
  roleIds: string[];
};

const SCOPE_HINT: Record<string, string> = {
  OWN: "own records",
  BRANCH: "their branch",
  BRANCH_SET: "assigned branches",
  NETWORK: "whole network",
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-bad">{message}</p>;
}

export function UserFormDialog({
  mode,
  action,
  roles,
  branches,
  user,
  defaultFieldUser = false,
  createLabel = "New user",
}: {
  mode: "create" | "edit";
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  roles: RoleOption[];
  branches: Array<{ id: string; code: string; name: string }>;
  user?: UserRecord;
  /**
   * Where a new record starts. The field-staff roster opens this form
   * already knowing it is adding a delivery or pickup boy, and making the
   * admin tick a box to say so is how a field user gets created with a
   * password login and cannot sign in on the phone.
   */
  defaultFieldUser?: boolean;
  createLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const [isFieldUser, setIsFieldUser] = useState(
    user?.isFieldUser ?? defaultFieldUser,
  );
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Saved.");
        setOpen(false);
      }
    });
  }

  function handleOpenChange(next: boolean) {
    if (next) setState(EMPTY);
    setOpen(next);
  }

  const creating = mode === "create";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant={creating ? "default" : "ghost"}
            size={creating ? "default" : "icon-sm"}
            title={creating ? undefined : `Edit ${user?.name}`}
          />
        }
      >
        {creating ? <Plus /> : <Pencil />}
        {creating ? createLabel : <span className="sr-only">Edit {user?.name}</span>}
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{creating ? "New user" : `Edit ${user?.name}`}</DialogTitle>
          <DialogDescription>
            Roles decide what someone can do; the home branch decides what they
            can see. Both are enforced on the server, not just in the menu.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="flex flex-col gap-4">
          {user?.id ? <input type="hidden" name="id" value={user.id} /> : null}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-name`}>
                Full name<span className="ml-0.5 text-bad">*</span>
              </Label>
              <Input
                id={`${formId}-name`}
                name="name"
                defaultValue={user?.name ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.name)}
                required
              />
              <FieldError message={state.fieldErrors?.name} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-mobile`}>
                Mobile<span className="ml-0.5 text-bad">*</span>
              </Label>
              <Input
                id={`${formId}-mobile`}
                name="mobile"
                inputMode="numeric"
                maxLength={10}
                className="font-mono"
                defaultValue={user?.mobile ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.mobile)}
                required
              />
              <FieldError message={state.fieldErrors?.mobile} />
              <p className="text-xs text-muted-foreground">
                This is the sign-in identifier.
              </p>
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-email`}>Email</Label>
              <Input
                id={`${formId}-email`}
                name="email"
                type="email"
                defaultValue={user?.email ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.email)}
              />
              <FieldError message={state.fieldErrors?.email} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-employeeCode`}>Employee code</Label>
              <Input
                id={`${formId}-employeeCode`}
                name="employeeCode"
                className="font-mono"
                defaultValue={user?.employeeCode ?? ""}
              />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-branch`}>
                Home branch<span className="ml-0.5 text-bad">*</span>
              </Label>
              <select
                id={`${formId}-branch`}
                name="primaryBranchId"
                defaultValue={user?.primaryBranchId ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.primaryBranchId)}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                required
              >
                <option value="">Select…</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} — {branch.name}
                  </option>
                ))}
              </select>
              <FieldError message={state.fieldErrors?.primaryBranchId} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-status`}>Status</Label>
              <select
                id={`${formId}-status`}
                name="status"
                defaultValue={user?.status ?? "ACTIVE"}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Anything but Active blocks sign-in immediately.
              </p>
            </div>

            <div className="col-span-2 flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${formId}-field`} className="cursor-pointer">
                  Field user
                </Label>
                <p className="text-xs text-muted-foreground">
                  Drivers, delivery agents and pickup executives sign in with a
                  one-time code instead of a password.
                </p>
              </div>
              <input type="hidden" name="isFieldUser" value="false" />
              <Switch
                id={`${formId}-field`}
                name="isFieldUser"
                value="true"
                checked={isFieldUser}
                onCheckedChange={(checked) => setIsFieldUser(Boolean(checked))}
              />
            </div>

            {creating && !isFieldUser && (
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-password`}>
                  Initial password<span className="ml-0.5 text-bad">*</span>
                </Label>
                <Input
                  id={`${formId}-password`}
                  name="password"
                  type="text"
                  autoComplete="off"
                  className="font-mono"
                  aria-invalid={Boolean(state.fieldErrors?.password)}
                />
                <FieldError message={state.fieldErrors?.password} />
                <p className="text-xs text-muted-foreground">
                  Hand this over in person. They are forced to change it at
                  first sign-in.
                </p>
              </div>
            )}

            <fieldset className="col-span-2 flex flex-col gap-2">
              <legend className="pb-1.5 text-sm font-medium">
                Roles<span className="ml-0.5 text-bad">*</span>
              </legend>
              <FieldError message={state.fieldErrors?.roleIds} />
              <div className="grid gap-1.5 sm:grid-cols-2">
                {roles.map((role) => (
                  <label
                    key={role.id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 hover:bg-accent/40"
                  >
                    <Checkbox
                      name="roleIds"
                      value={role.id}
                      defaultChecked={user?.roleIds.includes(role.id)}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{role.name}</span>
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        sees {SCOPE_HINT[role.scope] ?? role.scope}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
            >
              {state.error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {creating ? "Create user" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({
  userId,
  userName,
  action,
}: {
  userId: string;
  userName: string;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Password reset.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState(EMPTY);
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title={`Reset password for ${userName}`}
          />
        }
      >
        <KeyRound />
        <span className="sr-only">Reset password for {userName}</span>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Sets a new password for {userName} and signs them out everywhere.
            They must change it at next sign-in.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={userId} />
          <Label htmlFor={`${formId}-pw`}>New password</Label>
          <Input
            id={`${formId}-pw`}
            name="password"
            type="text"
            autoComplete="off"
            className="font-mono"
            aria-invalid={Boolean(state.fieldErrors?.password)}
          />
          <FieldError message={state.fieldErrors?.password} />
          {state.error && (
            <p role="alert" className="text-sm text-bad">
              {state.error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
