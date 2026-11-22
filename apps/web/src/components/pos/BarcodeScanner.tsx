"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from "react";
import "@/lib/storePosText";
import { useT } from "@/lib/useLang";

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Retail formats this store reads (the browser's own names). */
const WANTED_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

/** The browser's own BarcodeDetector when it reads retail barcodes (Chrome / Edge on Android). */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? WANTED_FORMATS;
    const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new Ctor({ formats }) : null;
  } catch {
    return null;
  }
}

/**
 * Whether this page may use a camera at all: a browser with getUserMedia, in a
 * secure context (HTTPS or localhost). Without it the camera button is not
 * shown - the store scanner and typing always remain.
 */
export function cameraPossible(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
}
const noSubscribe = () => () => {};

type Stopper = { stop: () => void };

/**
 * Reads codes from the camera into `onCode`, with whichever engine this
 * browser has: its own BarcodeDetector, else the ZXing reader (loaded only
 * now - Safari on iPhone, desktop browsers). Resolves to a stopper.
 */
export async function startCameraReader(video: HTMLVideoElement, onCode: (code: string) => void): Promise<Stopper> {
  const native = await nativeDetector();
  if (native) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2) {
        try {
          const code = (await native.detect(video)).find((b) => b.rawValue?.trim())?.rawValue.trim();
          if (code && !stopped) {
            onCode(code);
            return;
          }
        } catch {
          // one unreadable frame - keep looking
        }
      }
      window.setTimeout(tick, 200);
    };
    void tick();
    return {
      stop: () => {
        stopped = true;
        stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      },
    };
  }
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128]);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
  let done = false;
  const controls = await reader.decodeFromConstraints({ video: { facingMode: "environment" }, audio: false }, video, (result) => {
    const code = result?.getText()?.trim();
    if (code && !done) {
      done = true;
      onCode(code);
    }
  });
  return { stop: () => controls.stop() };
}

export interface BarcodeScannerHandle {
  focus: () => void;
  clear: () => void;
}

/**
 * The one barcode reader of the store screens - the cashier, linking a code
 * to a product, and the wizard:
 *  - a store scanner: it types like a keyboard and presses Enter; the field
 *    says when it is ready (focused) and is ready again after each read;
 *  - «مسح بالكاميرا»: shown only where a camera can be used; it opens a scan
 *    area in this same screen (never a panel over the panel), reads a code
 *    and hands it over exactly like the scanner;
 *  - typing by hand always works too.
 */
export const BarcodeScanner = forwardRef<
  BarcodeScannerHandle,
  {
    id: string;
    label: string;
    hint?: string;
    submitLabel: string;
    busy?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    /** The cashier: the field takes the focus back after each read (the next scan goes straight in). */
    keepReady?: boolean;
    /** The wizard: the read code stays in the field (the field IS the value). */
    keepValue?: boolean;
    initialValue?: string;
    onSubmit: (code: string) => void;
    onChange?: (value: string) => void;
    testId?: string;
  }
>(function BarcodeScanner(
  { id, label, hint, submitLabel, busy, disabled, autoFocus, keepReady, keepValue, initialValue, onSubmit, onChange, testId },
  ref,
) {
  const t = useT();
  const [value, setValue] = useState(initialValue ?? "");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopperRef = useRef<Stopper | null>(null);
  const canCamera = useSyncExternalStore(noSubscribe, cameraPossible, () => false);
  const [camera, setCamera] = useState<"off" | "starting" | "on">("off");
  const [cameraError, setCameraError] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: () => setValue(""),
  }));

  const stopCamera = useCallback(() => {
    stopperRef.current?.stop();
    stopperRef.current = null;
    setCamera("off");
  }, []);
  useEffect(() => stopCamera, [stopCamera]);

  const submit = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code || busy || disabled) return;
      setLastRead(code);
      onSubmit(code);
      if (!keepValue) setValue("");
      if (keepReady) window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [busy, disabled, keepReady, keepValue, onSubmit],
  );

  async function startCamera() {
    setCameraError(false);
    setCamera("starting");
    // the video element exists only once the scan area is shown
    await new Promise((r) => window.setTimeout(r, 0));
    const video = videoRef.current;
    if (!video) return;
    try {
      stopperRef.current = await startCameraReader(video, (code) => {
        stopCamera();
        try {
          navigator.vibrate?.(60);
        } catch {
          // no vibration here
        }
        setValue(code);
        onChange?.(code);
        submit(code);
      });
      setCamera((c) => (c === "starting" ? "on" : c));
    } catch {
      stopCamera();
      setCameraError(true);
    }
  }

  return (
    <div className={`pos-scanner${focused ? " is-ready" : ""}`}>
      <label htmlFor={id} className="pos-scanner-label">{label}</label>
      <div className="pos-scanner-row">
        <span className="pos-scanner-field">
          <svg className="pos-scanner-glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 8v8M11 8v8M13.5 8v8M16 8v8" />
          </svg>
          <input
            ref={inputRef}
            id={id}
            className="pos-scanner-input"
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-describedby={`${id}-status`}
            data-testid={testId}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setValue(e.target.value);
              onChange?.(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit(value);
              }
            }}
          />
        </span>
        <button type="button" className="pos-btn pos-btn-quiet" disabled={busy || disabled || !value.trim()} onClick={() => submit(value)}>
          {submitLabel}
        </button>
        {canCamera && (
          <button
            type="button"
            className="pos-btn pos-btn-secondary pos-camera-toggle"
            aria-pressed={camera !== "off"}
            aria-controls={`${id}-camera`}
            disabled={disabled}
            onClick={() => (camera !== "off" ? stopCamera() : void startCamera())}
            data-testid={testId ? `${testId}-camera` : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            {camera !== "off" ? t("pos.camera.close") : t("pos.camera.open")}
          </button>
        )}
      </div>
      {/* one line that never changes its height (focus changes only its words) - a
          click elsewhere must not move the screen under the pointer */}
      <p id={`${id}-status`} className="pos-scanner-status" aria-live="polite">
        <span className="pos-scanner-dot" aria-hidden="true" />
        <span className="pos-scanner-state">{focused ? t("pos.scan.ready") : t("pos.scan.tap")}</span>
        {lastRead && <span className="visually-hidden"> {lastRead}</span>}
      </p>
      {hint && <p className="pos-scanner-hint">{hint}</p>}
      {cameraError && <p className="pos-inline-error" role="alert">{t("pos.camera.denied")}</p>}
      {camera !== "off" && (
        <div className="pos-camera" id={`${id}-camera`} data-testid={testId ? `${testId}-camera-view` : undefined}>
          <div className="pos-camera-frame">
            <video ref={videoRef} className="pos-camera-video" muted playsInline aria-label={t("pos.camera.video")} />
            <span className="pos-camera-guide" aria-hidden="true" />
          </div>
          <p className="pos-camera-note" aria-live="polite">{camera === "starting" ? t("pos.camera.starting") : t("pos.camera.aim")}</p>
        </div>
      )}
    </div>
  );
});
