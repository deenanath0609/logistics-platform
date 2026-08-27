/**
 * The shape every finance server action returns.
 *
 * Kept in its own module rather than in an `actions.ts` file so client
 * components can import the type without pulling a `"use server"` module
 * into the browser bundle.
 */
export type FinanceActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Where to go after a successful action, when it creates something. */
  redirectTo?: string;
};

export const IDLE: FinanceActionState = {};
