"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The signature.
 *
 * A finger on glass, exported as a PNG data URL and stored as evidence
 * beside the photograph. Three details do the work:
 *
 *  - the canvas is backed at device pixel ratio, or a signature on a
 *    high-density phone comes out as a blurred smear;
 *  - `touch-action: none`, or the page scrolls under the finger instead of
 *    drawing;
 *  - pointer capture, so a stroke that leaves the box still finishes cleanly
 *    rather than leaving a stray line behind.
 */
export function SignaturePad({
  onChange,
  disabled,
  label = "Signature",
}: {
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    // Preserve what is already drawn across an orientation change.
    const previous = hasInk ? canvas.toDataURL("image/png") : null;

    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);

    const context = canvas.getContext("2d");
    if (!context) return;

    context.scale(ratio, ratio);
    context.lineWidth = 2.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    // Ink is read off a printed A4 POD, so it is always dark on white
    // regardless of the phone's theme.
    context.strokeStyle = "#111827";

    if (previous) {
      const image = new Image();
      image.onload = () => context.drawImage(image, 0, 0, rect.width, rect.height);
      image.src = previous;
    }
  }, [hasInk]);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
    };
    // Only on mount: re-running on every stroke would redraw constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;

    const point = pointFrom(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
    // A dot, so a full stop or a tick registers as ink.
    context.lineTo(point.x + 0.01, point.y);
    context.stroke();
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    const point = pointFrom(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;

    const canvas = canvasRef.current;
    if (!canvas) return;

    setHasInk(true);
    onChange(canvas.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const ratio = window.devicePixelRatio || 1;
    context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        {hasInk && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <Eraser />
            Clear
          </Button>
        )}
      </div>

      <div className="relative rounded-xl border-2 border-dashed bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
          className="h-40 w-full touch-none rounded-xl"
          aria-label={label}
        />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
            Sign here with your finger
          </span>
        )}
      </div>
    </div>
  );
}
