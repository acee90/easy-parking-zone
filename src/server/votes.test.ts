import { describe, it, expect } from "vitest";
import {
  getAnonIdFromRequest,
  resolveVoterId,
  generateAnonId,
  buildAnonCookieValue,
} from "@/lib/vote-utils";

describe("getAnonIdFromRequest", () => {
  it("returns null when no cookie header", () => {
    const req = new Request("http://localhost", { headers: {} });
    expect(getAnonIdFromRequest(req)).toBeNull();
  });

  it("returns null when cookie exists but no anon id", () => {
    const req = new Request("http://localhost", {
      headers: { cookie: "other=value; foo=bar" },
    });
    expect(getAnonIdFromRequest(req)).toBeNull();
  });

  it("extracts anon id from cookie", () => {
    const anonId = "anon_abc123-def456";
    const req = new Request("http://localhost", {
      headers: { cookie: `parking_anon_id=${anonId}; other=val` },
    });
    expect(getAnonIdFromRequest(req)).toBe(anonId);
  });

  it("extracts anon id when it is the only cookie", () => {
    const anonId = "anon_xyz789";
    const req = new Request("http://localhost", {
      headers: { cookie: `parking_anon_id=${anonId}` },
    });
    expect(getAnonIdFromRequest(req)).toBe(anonId);
  });
});

describe("resolveVoterId", () => {
  it("returns userId when logged in", () => {
    expect(resolveVoterId("user123", "anon_abc")).toBe("user123");
  });

  it("returns userId even when anonId is null", () => {
    expect(resolveVoterId("user123", null)).toBe("user123");
  });

  it("returns anonId when not logged in", () => {
    expect(resolveVoterId(null, "anon_abc123")).toBe("anon_abc123");
  });

  it("returns null when both are null", () => {
    expect(resolveVoterId(null, null)).toBeNull();
  });

  it("returns null when anonId doesn't start with anon_", () => {
    expect(resolveVoterId(null, "invalid_id")).toBeNull();
  });

  it("prefers userId over anonId", () => {
    expect(resolveVoterId("real_user", "anon_fallback")).toBe("real_user");
  });
});

describe("generateAnonId", () => {
  it("starts with anon_ prefix", () => {
    const id = generateAnonId();
    expect(id).toMatch(/^anon_/);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateAnonId()));
    expect(ids.size).toBe(10);
  });
});

describe("buildAnonCookieValue", () => {
  it("includes the anon id", () => {
    const val = buildAnonCookieValue("anon_test123");
    expect(val).toContain("parking_anon_id=anon_test123");
  });

  it("sets HttpOnly flag", () => {
    const val = buildAnonCookieValue("anon_test");
    expect(val).toContain("HttpOnly");
  });

  it("sets Path and SameSite", () => {
    const val = buildAnonCookieValue("anon_test");
    expect(val).toContain("Path=/");
    expect(val).toContain("SameSite=Lax");
  });

  it("sets 1 year max age", () => {
    const val = buildAnonCookieValue("anon_test");
    expect(val).toContain(`Max-Age=${365 * 86400}`);
  });
});
