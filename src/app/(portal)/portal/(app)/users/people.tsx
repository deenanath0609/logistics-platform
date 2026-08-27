"use client";

import { useActionState, useState } from "react";
import { format } from "date-fns";
import { KeyRound, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableFrame } from "@/components/data/data-shell";
import { Field, FormError, selectClass } from "@/components/portal/form";
import {
  inviteSubUser,
  resetSubUserPassword,
  updateSubUser,
  type SubUserState,
} from "./actions";
import { cn } from "@/lib/utils";

export type SubUserRow = {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  role: "OWNER" | "MEMBER" | "VIEWER";
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  invitedAt: Date | null;
  visibleBranchNames: string[];
};

export type BranchOption = { value: string; label: string };

const EMPTY: SubUserState = {};

export function People({
  users,
  branches,
  currentUserId,
}: {
  users: SubUserRow[];
  branches: BranchOption[];
  currentUserId: string;
}) {
  const [inviting, setInviting] = useState(false);
  const [state, action, pending] = useActionState(inviteSubUser, EMPTY);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => setInviting((open) => !open)}
          variant={inviting ? "outline" : "default"}
        >
          <UserPlus />
          {inviting ? "Close" : "Invite a colleague"}
        </Button>
      </div>

      {state.temporaryPassword && (
        <TemporaryPassword
          message={state.message}
          password={state.temporaryPassword}
        />
      )}

      {inviting && (
        <form action={action} className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="name" required error={state.fieldErrors?.name}>
              <Input id="name" name="name" required />
            </Field>
            <Field label="Email" htmlFor="email" required error={state.fieldErrors?.email}>
              <Input id="email" name="email" type="email" required />
            </Field>
            <Field label="Mobile" htmlFor="mobile" error={state.fieldErrors?.mobile}>
              <Input id="mobile" name="mobile" inputMode="numeric" maxLength={10} />
            </Field>
            <Field
              label="What they may do"
              htmlFor="role"
              required
              error={state.fieldErrors?.role}
              help="A member can book and request pickups. A viewer can only look."
            >
              <select id="role" name="role" className={selectClass} defaultValue="MEMBER">
                <option value="MEMBER">Member — can book</option>
                <option value="VIEWER">Viewer — read only</option>
              </select>
            </Field>

            {branches.length > 0 && (
              <BranchPicker
                branches={branches}
                className="sm:col-span-2"
                help="Leave everything unticked to let them see the whole account."
              />
            )}
          </div>

          <FormError message={state.error} />

          <div>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create login
            </Button>
          </div>
        </form>
      )}

      <TableFrame>
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Sees</TableHead>
              <TableHead>Last signed in</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  {user.name}
                  {user.id === currentUserId && (
                    <span className="ml-1.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
                      you
                    </span>
                  )}
                  {!user.isActive && (
                    <span className="ml-1.5 font-mono text-[0.55rem] uppercase tracking-wider text-bad">
                      disabled
                    </span>
                  )}
                  {user.lockedUntil && user.lockedUntil > new Date() && (
                    <span className="ml-1.5 font-mono text-[0.55rem] uppercase tracking-wider text-warn">
                      locked
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-block rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
                      user.role === "OWNER"
                        ? "bg-accent text-accent-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {user.role}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {user.visibleBranchNames.length === 0
                    ? "Whole account"
                    : user.visibleBranchNames.join(", ")}
                </TableCell>
                <TableCell className="font-mono text-xs tabular text-muted-foreground">
                  {user.lastLoginAt
                    ? format(user.lastLoginAt, "dd MMM yy · HH:mm")
                    : user.invitedAt
                      ? "Invited, not yet used"
                      : "—"}
                </TableCell>
                <TableCell>
                  {user.role !== "OWNER" && user.id !== currentUserId && (
                    <RowActions user={user} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </div>
  );
}

function BranchPicker({
  branches,
  className,
  help,
}: {
  branches: BranchOption[];
  className?: string;
  help?: string;
}) {
  const [chosen, setChosen] = useState<string[]>([]);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium">Branch visibility</span>
      <input type="hidden" name="visibleBranchIds" value={chosen.join(",")} />
      <div className="flex flex-wrap gap-1.5">
        {branches.map((branch) => {
          const on = chosen.includes(branch.value);
          return (
            <button
              key={branch.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setChosen((current) =>
                  on
                    ? current.filter((id) => id !== branch.value)
                    : [...current, branch.value],
                )
              }
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                on
                  ? "border-primary bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {branch.label}
            </button>
          );
        })}
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function RowActions({ user }: { user: SubUserRow }) {
  const [updateState, update, updating] = useActionState(updateSubUser, EMPTY);
  const [resetState, reset, resetting] = useActionState(
    resetSubUserPassword,
    EMPTY,
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <form action={update} className="flex items-center gap-1.5">
          <input type="hidden" name="id" value={user.id} />
          <input type="hidden" name="role" value={user.role} />
          <input
            type="hidden"
            name="isActive"
            value={user.isActive ? "false" : "true"}
          />
          <Button type="submit" variant="ghost" size="xs" disabled={updating}>
            {updating && <Loader2 className="animate-spin" />}
            {user.isActive ? "Disable" : "Enable"}
          </Button>
        </form>

        <form action={reset}>
          <input type="hidden" name="id" value={user.id} />
          <Button type="submit" variant="ghost" size="xs" disabled={resetting}>
            {resetting ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Reset
          </Button>
        </form>
      </div>

      {(updateState.error ?? resetState.error) && (
        <span className="text-xs text-bad">
          {updateState.error ?? resetState.error}
        </span>
      )}
      {resetState.temporaryPassword && (
        <span className="font-mono text-xs text-warn">
          {resetState.temporaryPassword}
        </span>
      )}
    </div>
  );
}

function TemporaryPassword({
  message,
  password,
}: {
  message?: string;
  password: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-warn">
      <p className="text-sm font-medium">{message ?? "Login created"}</p>
      <p className="text-sm">
        Their one-time password is{" "}
        <span className="font-mono font-semibold">{password}</span>. It is shown
        once and never again — pass it on now. They will be asked to choose
        their own the first time they sign in.
      </p>
    </div>
  );
}
