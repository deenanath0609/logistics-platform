"use client";

import { useState, useTransition } from "react";
import { Loader2, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { revokeApiKey } from "../actions";
import type { ActionState } from "@/server/services/master-crud";

const IDLE: ActionState = {};

export function RevokeButton({
  keyId,
  keyName,
  keyPrefix,
}: {
  keyId: string;
  keyName: string;
  keyPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await revokeApiKey(IDLE, formData);
      if (result.ok) {
        toast.success(result.message ?? "Revoked.");
        setOpen(false);
      } else {
        toast.error(result.error ?? "That key could not be revoked.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        <ShieldOff />
        Revoke
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {keyName}?</DialogTitle>
          <DialogDescription>
            Every call presenting <code className="font-mono">{keyPrefix}…</code>{" "}
            stops working immediately. The row is kept, so a partner asking why
            their integration broke can be answered.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={keyId} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`revoke-reason-${keyId}`}>Reason</Label>
            <Input
              id={`revoke-reason-${keyId}`}
              name="reason"
              placeholder="Rotated after a leak in the partner's repository"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <ShieldOff />}
              Revoke key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
