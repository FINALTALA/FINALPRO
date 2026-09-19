import { getSessionToken } from "./session";

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
  ) {
    super(message);
  }
}

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  idempotencyKey?: string;
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

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(
      res.status,
      parsed?.error?.code ?? "UNKNOWN_ERROR",
      parsed?.error?.message ?? "Something went wrong",
    );
  }
  return parsed as T;
}

export function newIdempotencyKey(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
