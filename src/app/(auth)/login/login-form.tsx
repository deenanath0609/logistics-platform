"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  signInWithPassword,
  requestOtp,
  signInWithOtp,
  type LoginState,
} from "./actions";

const EMPTY: LoginState = {};

function Notice({ state }: { state: LoginState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
      >
        {state.error}
      </p>
    );
  }
  if (state.devCode) {
    return (
      <p className="rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
        Development mode — your code is{" "}
        <span className="font-mono font-semibold">{state.devCode}</span>. In
        production this arrives by SMS.
      </p>
    );
  }
  if (state.otpSentTo) {
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
        If that number belongs to an active account, a code is on its way.
      </p>
    );
  }
  return null;
}

export function LoginForm({ next }: { next: string }) {
  const [passwordState, passwordAction, passwordPending] = useActionState(
    signInWithPassword,
    EMPTY,
  );
  const [otpState, otpAction, otpPending] = useActionState(requestOtp, EMPTY);
  const [verifyState, verifyAction, verifyPending] = useActionState(
    signInWithOtp,
    EMPTY,
  );
  const [mobile, setMobile] = useState("");

  const codeSent = Boolean(otpState.otpSentTo || verifyState.otpSentTo);

  return (
    <Tabs defaultValue="password" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="password">Password</TabsTrigger>
        <TabsTrigger value="otp">Mobile OTP</TabsTrigger>
      </TabsList>

      <TabsContent value="password" className="mt-6">
        <form action={passwordAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="mobile">Mobile number</Label>
            <Input
              id="mobile"
              name="mobile"
              inputMode="numeric"
              autoComplete="username"
              placeholder="10-digit mobile"
              maxLength={10}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <Notice state={passwordState} />

          <Button type="submit" disabled={passwordPending} className="mt-1">
            {passwordPending && <Loader2 className="animate-spin" />}
            Sign in
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="otp" className="mt-6">
        <div className="flex flex-col gap-4">
          <form action={otpAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="otp-mobile">Mobile number</Label>
              <div className="flex gap-2">
                <Input
                  id="otp-mobile"
                  name="mobile"
                  inputMode="numeric"
                  autoComplete="username"
                  placeholder="10-digit mobile"
                  maxLength={10}
                  value={mobile}
                  onChange={(e) =>
                    setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  required
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={otpPending || mobile.length !== 10}
                >
                  {otpPending && <Loader2 className="animate-spin" />}
                  {codeSent ? "Resend" : "Send code"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                For drivers, delivery agents, and pickup executives.
              </p>
            </div>
          </form>

          <form action={verifyAction} className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="mobile" value={mobile} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={8}
                disabled={!codeSent}
                className="font-mono tracking-[0.3em]"
                required
              />
            </div>

            <Notice state={verifyState.error ? verifyState : otpState} />

            <Button type="submit" disabled={verifyPending || !codeSent}>
              {verifyPending && <Loader2 className="animate-spin" />}
              Verify and sign in
            </Button>
          </form>
        </div>
      </TabsContent>
    </Tabs>
  );
}
