import { toApiError } from "./errors";

const envelope = { error: { code: "NOT_PROVISIONED", message: "Account is not provisioned yet", request_id: "r1" } };

describe("toApiError", () => {
  it("uses the already-parsed body when the response stream was consumed", async () => {
    const res = new Response(JSON.stringify(envelope), { status: 403 });
    await res.json(); // openapi-fetch consumes error bodies before call() sees them
    const e = await toApiError(res, envelope);
    expect(e.code).toBe("NOT_PROVISIONED");
    expect(e.message).toBe("Account is not provisioned yet");
  });

  it("reads the body itself when nothing was parsed", async () => {
    const e = await toApiError(new Response(JSON.stringify(envelope), { status: 403 }));
    expect(e.code).toBe("NOT_PROVISIONED");
  });

  it("falls back for non-JSON errors", async () => {
    const e = await toApiError(new Response("Bad gateway", { status: 502 }));
    expect(e.code).toBe("ERROR");
  });
});
