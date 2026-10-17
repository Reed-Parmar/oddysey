import { supabase } from "@/auth/supabase";

import { API_BASE, authHeaders } from "./client";
import { ApiError } from "./errors";

/** Multipart upload over XHR (progress events), same auth policy as the fetch client. */
export async function uploadMultipart<T>(
  path: string,
  form: FormData,
  opts: { onProgress?: (fraction: number) => void } = {},
): Promise<T> {
  const send = async (): Promise<{ status: number; body: string; requestId: string | null }> => {
    const headers = await authHeaders();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}${path}`);
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
  const parsed = res.body ? JSON.parse(res.body) : null;
  if (res.status >= 200 && res.status < 300) return parsed as T;
  const e = parsed?.error;
  throw new ApiError(res.status, e?.code ?? "ERROR", e?.message ?? `Upload failed (${res.status})`, e?.details ?? [],
    e?.request_id ?? res.requestId);
}
