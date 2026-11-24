"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { cameraPossible, startCameraReader } from "@/components/pos/BarcodeScanner";

const noSubscribe = () => () => {};

/**
 * IX-P2: the return code, entered ONE way at the counter - typed then Enter,
 * a store scanner (it types the digits and presses Enter), or the camera
 * (reads the CODE128 barcode the shopper shows). Six digits only. The same
 * behaviour as the pickup-code field of the order screen; nothing here ever
 * shows a stored code - the server checks it.
 */
export default function ReturnCodeField({
  value,
  onChange,
  onEnter,
  disabled,
  invalid,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: (v: string) => void;
  disabled: boolean;
  invalid: boolean;
  t: (k: string) => string;
}) {
  const id = useId();
  const canCamera = useSyncExternalStore(noSubscribe, cameraPossible, () => false);
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stopper = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => stopper.current?.stop(), []);

  async function start() {
    setCameraError(false);
    setCamera(true);
    await new Promise((r) => window.setTimeout(r, 0));
    if (!videoRef.current) return;
    try {
      stopper.current = await startCameraReader(videoRef.current, (code) => {
        const digits = code.replace(/\D/g, "").slice(0, 6);
        stopper.current?.stop();
        stopper.current = null;
        setCamera(false);
        onChange(digits);
        // a full code read by the camera goes straight to the preview
        if (digits.length === 6) onEnter(digits);
        else inputRef.current?.focus();
      });
    } catch {
      setCamera(false);
      setCameraError(true);
    }
  }
  function stop() {
    stopper.current?.stop();
    stopper.current = null;
    setCamera(false);
    inputRef.current?.focus();
  }

  return (
    <div className="bo-code">
      <label htmlFor={id} className="dw-field">{t("rb.receive.code")}</label>
      <div className="bo-code-row">
        <input
          ref={inputRef}
          id={id}
          className="dw-input bo-code-input"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          dir="ltr"
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter(value);
            }
          }}
          autoFocus
          data-testid="rb-code-input"
        />
        {canCamera && (
          <button type="button" className="dw-btn dw-btn-quiet" onClick={() => (camera ? stop() : void start())} disabled={disabled} data-testid="rb-camera">
            {camera ? t("rb.receive.camera_stop") : t("rb.receive.camera")}
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="dw-muted">{t("rb.receive.code_hint")}</p>
      {camera && <video ref={videoRef} className="bo-camera" muted playsInline aria-hidden="true" />}
      {cameraError && <p className="dw-muted" role="status">{t("rb.receive.camera_error")}</p>}
    </div>
  );
}
