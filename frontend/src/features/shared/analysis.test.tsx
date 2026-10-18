import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/api/client", () => ({
  api: { GET: request }, call: (result: unknown) => result,
  API_BASE: "http://localhost/api/v1", authHeaders: vi.fn(),
}));

import { useAnalysis } from "./views";
import { useMySubmissionHistory } from "../student/hooks";

afterEach(() => { cleanup(); request.mockReset(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("evaluation polling", () => {
  it("keeps polling after the worker has not yet created the analysis", async () => {
    request.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Analysis not found"))
      .mockResolvedValue({ data: { status: "completed" } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAnalysis("submission", true), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    await waitFor(() => expect(result.current.data?.data.status).toBe("completed"), { timeout: 6000 });
    expect(request).toHaveBeenCalledTimes(2);
  }, 8000);

  it("refreshes outcomes and progress when analysis completes", async () => {
    request.mockResolvedValue({ data: { status: "completed" } });
    const { client, wrapper } = setup();
    client.setQueryData(qk.submissions.detail("submission"), { data: { status: "submitted" } });
    client.setQueryData(qk.submissions.list(), { data: [] });
    client.setQueryData(qk.progress.list(), { data: [] });
    renderHook(() => useAnalysis("submission", true), { wrapper });
    await waitFor(() => expect(client.getQueryState(qk.submissions.detail("submission"))?.isInvalidated).toBe(true));
    expect(client.getQueryState(qk.submissions.list())?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.progress.list())?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.submissions.analysis("submission"))?.isInvalidated).toBe(false);
  });

  it("updates the trainee's outcome even when the analysis card is not open", async () => {
    request.mockResolvedValueOnce({ data: [{ status: "submitted" }] })
      .mockResolvedValue({ data: [{ status: "rework_requested" }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMySubmissionHistory(), { wrapper });
    await waitFor(() => expect(result.current.data?.data[0].status).toBe("submitted"));
    await waitFor(() => expect(result.current.data?.data[0].status).toBe("rework_requested"), { timeout: 6000 });
    expect(request).toHaveBeenCalledTimes(2);
  }, 8000);
});
