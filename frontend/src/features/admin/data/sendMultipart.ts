/**
 * Multipart request with upload progress for methods other than POST (PROJ document replace is a PUT).
 * Same auth policy as `@/api/upload` (one refresh-and-retry on 401). Path is WITHOUT `/api/v1`.
 */
import { API_BASE, authHeaders } from "@/api/client";
import { ApiError } from "@/api/errors";
import { supabase } from "@/auth/supabase";

export async function sendMultipart<T>(
  method: "PUT" | "POST",
  path: string,
  form: FormData,
  opts: { onProgress?: (fraction: number) => void } = {},
): Promise<T> {
  const send = async (): Promise<{ status: number; body: string; requestId: string | null }> => {
    const headers = await authHeaders();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${API_BASE}${path}`);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
      xhr.onload = () =>
        resolve({ status: xhr.status, body: xhr.responseText, requestId: xhr.getResponseHeader("X-Request-ID") });
      xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "Upload failed. Check your connection."));
      xhr.send(form);
    });
  };
  let res = await send();
  if (res.status === 401) {
    const { data } = await supabase.auth.refreshSession();
    if (data.session) res = await send();
  }
  let parsed: { error?: { code?: string; message?: string; details?: never[]; request_id?: string } } | null = null;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    parsed = null;
  }
  if (res.status >= 200 && res.status < 300) return parsed as T;
  const e = parsed?.error;
  throw new ApiError(res.status, e?.code ?? "ERROR", e?.message ?? `Upload failed (${res.status})`, e?.details ?? [],
    e?.request_id ?? res.requestId);
}
