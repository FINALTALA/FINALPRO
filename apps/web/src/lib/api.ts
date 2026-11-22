import { getSessionToken } from "./session";
import {
  WORKSPACE_REQUIRED_EVENT,
  forgetWorkspace,
  workspaceOfApiPath,
  workspaceToken,
  workspaceTokenForApiPath,
  type WorkspaceRef,
} from "./workspaceSession";

// Matches apps/api/src/main.ts exactly: API_PORT default 3001, global
// prefix /api/v1. Overridable via NEXT_PUBLIC_API_URL for a real deploy
// target without a code change.
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown[] = [],
  ) {
    super(message);
  }
}

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  idempotencyKey?: string;
  /** Lets a caller cancel a superseded request (e.g. a filter change). */
  signal?: AbortSignal;
  /** TB-26: send this workspace's token even though the path is not a
   * workspace path - only for leaving a workspace. */
  workspace?: WorkspaceRef;
}

/**
 * P1 «معاينة آمنة»: while the owner's full preview is open (store page with
 * ?home_preview=draft, her own store), every non-GET request is refused
 * here before it leaves the browser. Switched on/off by the preview's guard
 * (components/store-home/PreviewGuard.tsx), which also guards window.fetch.
 */
let previewReadOnly = false;
let onPreviewWrite: (() => void) | null = null;
export function setPreviewReadOnly(on: boolean, onRefused: (() => void) | null = null): void {
  previewReadOnly = on;
  onPreviewWrite = on ? onRefused : null;
}
export function isPreviewReadOnly(): boolean {
  return previewReadOnly;
}

/**
 * The one HTTP call site every page below goes through - attaches the
 * stored session (when `auth` isn't explicitly turned off) and parses
 * this codebase's standard `{ error: { code, message } }` shape into a
 * typed `ApiError` rather than a generic HTTP failure.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  // P1: the full preview is read only - no write leaves the browser, even if
  // a control slipped past the page's guard.
  if (previewReadOnly && (options.method ?? "GET") !== "GET") {
    onPreviewWrite?.();
    throw new ApiError(0, "PREVIEW_READ_ONLY", "Nothing can be changed inside the preview", []);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.auth !== false) {
    const token = getSessionToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  // TB-26: the workspace token only on that workspace's own calls - never
  // on a shopping call (the API would refuse it: SHOPPING_REQUIRED).
  const workspace =
    options.auth === false
      ? null
      : options.workspace
        ? workspaceToken(options.workspace)
        : workspaceTokenForApiPath(path);
  if (workspace) headers["X-Workspace-Token"] = workspace;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const code = parsed?.error?.code ?? "UNKNOWN_ERROR";
    if (res.status === 403 && code === "WORKSPACE_REQUIRED") signalWorkspaceRequired(path);
    throw new ApiError(
      res.status,
      code,
      parsed?.error?.message ?? "Something went wrong",
      Array.isArray(parsed?.error?.details) ? parsed.error.details : [],
    );
  }
  return parsed as T;
}

/**
 * TB-26: the session header plus - for a workspace call only - the
 * workspace token, for the few places that call fetch() themselves
 * (file uploads/downloads). Takes an API path or a full API URL.
 */
export function authHeadersFor(pathOrUrl: string): Record<string, string> {
  // A full API URL (possibly another public base than ours): its path
  // after the /api/v1 prefix is what decides the workspace.
  const prefixAt = pathOrUrl.startsWith("/") ? -1 : pathOrUrl.indexOf("/api/v1/");
  const path = prefixAt >= 0 ? pathOrUrl.slice(prefixAt + "/api/v1".length) : pathOrUrl;
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const workspace = workspaceTokenForApiPath(path);
  if (workspace) headers["X-Workspace-Token"] = workspace;
  return headers;
}

/** TB-26: the workspace this call needed is not (or no longer) entered in
 * this tab - forget the stale token and let the app shell send the person
 * to the entry confirmation (never entering on its own). */
function signalWorkspaceRequired(path: string): void {
  const ref = workspaceOfApiPath(path);
  if (!ref) return;
  forgetWorkspace(ref);
  try {
    window.dispatchEvent(new CustomEvent(WORKSPACE_REQUIRED_EVENT, { detail: ref }));
  } catch {
    // Not in a browser.
  }
}

// Sprint 26: mirrors apps/api's MAX_UPLOAD_BYTES and accepted types,
// checked here first only so the owner gets an instant message - the
// API decides by the file's own bytes regardless.
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/**
 * Uploads one owner image (store logo/cover, product photo) and returns
 * its URL - attach that URL through the usual storefront/media calls.
 */
export async function uploadVendorImage(
  vendorId: string,
  file: File,
): Promise<{ url: string; width?: number | null; height?: number | null }> {
  if (!IMAGE_UPLOAD_ACCEPT.split(",").includes(file.type)) {
    throw new ApiError(400, "UNSUPPORTED_IMAGE_TYPE", "الصيغ المسموحة: JPG أو PNG أو WebP أو GIF");
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", "حجم الصورة أكبر من 5 ميغابايت");
  }
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const workspace = workspaceTokenForApiPath(`/vendors/${vendorId}/uploads`);
  if (workspace) headers["X-Workspace-Token"] = workspace;
  const res = await fetch(`${API_BASE_URL}/vendors/${vendorId}/uploads`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      parsed?.error?.code ?? "UNKNOWN_ERROR",
      res.status === 413 ? "حجم الصورة أكبر من 5 ميغابايت" : (parsed?.error?.message ?? "تعذّر رفع الصورة"),
    );
  }
  return parsed as { url: string; width?: number | null; height?: number | null };
}

// PD-3: review images - JPEG/PNG/WebP only (no GIF), <= 5 MB, checked
// here only for an instant message; the API re-checks the bytes and
// re-encodes the image (metadata stripped) regardless.
export const REVIEW_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

/** Attaches one image to the signed-in author's own product review. */
export async function uploadReviewImage(
  reviewId: string,
  file: File,
  altText: string,
): Promise<{ id: string; url: string; alt_text: string | null; width: number; height: number }> {
  if (!REVIEW_IMAGE_ACCEPT.split(",").includes(file.type)) {
    throw new ApiError(400, "UNSUPPORTED_MEDIA_TYPE", "الصيغ المسموحة: JPG أو PNG أو WebP");
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", "حجم الصورة أكبر من 5 ميغابايت");
  }
  const form = new FormData();
  form.append("file", file);
  form.append("consent", "true");
  if (altText.trim()) form.append("alt_text", altText.trim());
  const headers: Record<string, string> = { "Idempotency-Key": newIdempotencyKey("review-image") };
  const token = getSessionToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}/reviews/${reviewId}/media`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 413 ? "FILE_TOO_LARGE" : (parsed?.error?.code ?? "UNKNOWN_ERROR"),
      res.status === 413 ? "حجم الصورة أكبر من 5 ميغابايت" : (parsed?.error?.message ?? "تعذّر رفع الصورة"),
    );
  }
  return parsed as { id: string; url: string; alt_text: string | null; width: number; height: number };
}

export function newIdempotencyKey(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
