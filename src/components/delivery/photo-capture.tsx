"use client";

import { useRef, useState } from "react";
import { Camera, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compressImage } from "@/lib/delivery/image";

/**
 * The delivery photograph.
 *
 * `capture="environment"` opens the rear camera directly instead of the
 * gallery, which is what makes this one tap rather than four. The picture
 * is resized and re-encoded before it goes anywhere: it has to sit in
 * IndexedDB until the phone finds signal, and a stairwell full of 6 MB
 * originals is a queue that never drains.
 */
export function PhotoCapture({
  onChange,
  label = "Photo",
  hint,
  required,
  disabled,
}: {
  onChange: (dataUrl: string | null) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so retaking the same shot fires a change event.
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setError(null);

    try {
      const result = await compressImage(file);
      setPreview(result.dataUrl);
      setSize(result.bytes);
      onChange(result.dataUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That photo could not be read.");
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    setPreview(null);
    setSize(null);
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
          {required && <span className="ml-1 text-bad">required</span>}
        </span>
        {size !== null && (
          <span className="font-mono text-[0.65rem] text-muted-foreground tabular">
            {Math.round(size / 1024)} KB
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />

      {preview ? (
        <div className="relative overflow-hidden rounded-xl border">
          {/* A local data URL of the agent's own capture — next/image would
              add a proxy round trip for a picture that is already here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Delivery photograph" className="w-full object-cover" />
          <div className="grid grid-cols-2 border-t">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="flex min-h-12 items-center justify-center gap-2 border-r bg-card text-sm font-medium active:bg-muted"
            >
              <RotateCcw className="size-4" />
              Retake
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={disabled || busy}
              className="flex min-h-12 items-center justify-center gap-2 bg-card text-sm font-medium text-bad active:bg-muted"
            >
              <X className="size-4" />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-14 w-full border-dashed text-base"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          <Camera />
          {busy ? "Processing…" : "Take photo"}
        </Button>
      )}

      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
