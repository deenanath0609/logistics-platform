/**
 * The operator console's palette.
 *
 * The console must never be mistaken for a carrier's own app — an operator
 * who thinks they are in one tenant while looking at another is the whole
 * class of mistake this separation exists to prevent. So it overrides the
 * same design tokens a white-label tenant does (ADR 001 §3), scoped to the
 * console's root element, and every shadcn component inside picks up
 * operator colours without a single component being forked.
 *
 * Two things make it unmistakable at a glance: a violet accent where the
 * product is teal, and a dark sidebar in an otherwise light application.
 *
 * `.dark` is the app's dark-mode selector (`globals.css`), so the second
 * block covers a console rendered inside it.
 */
export const CONSOLE_PALETTE_CSS = `
[data-platform-console] {
  --primary: oklch(0.46 0.152 288);
  --primary-foreground: oklch(0.99 0.003 288);
  --ring: oklch(0.46 0.152 288);
  --accent: oklch(0.952 0.022 288);
  --accent-foreground: oklch(0.36 0.112 288);

  --sidebar: oklch(0.24 0.048 288);
  --sidebar-foreground: oklch(0.94 0.012 288);
  --sidebar-primary: oklch(0.72 0.132 288);
  --sidebar-primary-foreground: oklch(0.20 0.048 288);
  --sidebar-accent: oklch(0.32 0.062 288);
  --sidebar-accent-foreground: oklch(0.97 0.008 288);
  --sidebar-border: oklch(0.34 0.044 288);
  --sidebar-ring: oklch(0.72 0.132 288);
}

.dark [data-platform-console] {
  --primary: oklch(0.76 0.132 288);
  --primary-foreground: oklch(0.20 0.048 288);
  --ring: oklch(0.76 0.132 288);
  --accent: oklch(0.30 0.056 288);
  --accent-foreground: oklch(0.88 0.072 288);

  --sidebar: oklch(0.20 0.042 288);
  --sidebar-foreground: oklch(0.93 0.012 288);
  --sidebar-accent: oklch(0.29 0.056 288);
  --sidebar-accent-foreground: oklch(0.96 0.008 288);
  --sidebar-border: oklch(0.30 0.040 288);
}
`;
