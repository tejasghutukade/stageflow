import { describe, expect, it } from "vitest";
import { loginCheckIssue, matchLoginState } from "../src/browser/loginCheck.js";

const check = {
  logged_in_url: "https://app.example.test/home*",
  logged_out_url: ["https://app.example.test/login*", "https://sso.example.test/*"],
};

const match = (finalUrl: string, c: Parameters<typeof matchLoginState>[0]["check"] = check) =>
  matchLoginState({ finalUrl, check: c });

describe("matchLoginState", () => {
  it("is logged in when only the logged-in pattern matches", () => {
    expect(match("https://app.example.test/home/feed?x=1")).toMatchObject({
      state: "logged_in",
      logged_in: true,
    });
  });

  it("is logged out for any logged-out pattern in a list", () => {
    expect(match("https://app.example.test/login?next=/home").logged_in).toBe(false);
    expect(match("https://sso.example.test/a/b").logged_in).toBe(false);
  });

  it("accepts a single string for logged_out_url", () => {
    expect(
      match("https://x.test/signin", { logged_out_url: "https://x.test/signin" }).logged_in,
    ).toBe(false);
  });

  it("lets logged-out win when both match", () => {
    expect(
      match("https://app.example.test/home/login", {
        logged_in_url: "https://app.example.test/*",
        logged_out_url: "*/login",
      }),
    ).toMatchObject({ state: "logged_out", logged_in: false });
  });

  it("is unknown when neither matches or no patterns are set", () => {
    expect(match("https://other.test/")).toMatchObject({ state: "unknown", logged_in: null });
    expect(match("https://other.test/", {}).state).toBe("unknown");
  });

  it("matches the whole URL and treats regex characters literally", () => {
    expect(match("https://app.example.test/home", { logged_in_url: "https://app.example.test/home" }).logged_in).toBe(true);
    expect(match("https://app.example.test/homepage", { logged_in_url: "https://app.example.test/home" }).state).toBe("unknown");
    expect(match("https://appXexample.test/home", { logged_in_url: "https://app.example.test/home" }).state).toBe("unknown");
    expect(match("https://a.test/p?q=1+1", { logged_in_url: "https://a.test/p?q=1+1" }).logged_in).toBe(true);
  });

  it("supports ? as a single character and * across slashes", () => {
    expect(match("https://a.test/v1/x", { logged_in_url: "https://a.test/v?/*" }).logged_in).toBe(true);
    expect(match("https://a.test/v12/x", { logged_in_url: "https://a.test/v?/*" }).state).toBe("unknown");
    expect(match("https://a.test/a/b/c", { logged_in_url: "https://a.test/*" }).logged_in).toBe(true);
  });
});

describe("loginCheckIssue", () => {
  const known = { state: "logged_in" as const, logged_in: true, url: "https://a.test/home" };
  it("accepts the exact Host result", () => {
    expect(loginCheckIssue({ logged_in: true, url: known.url }, known)).toBeUndefined();
  });
  it("rejects a different value or url", () => {
    expect(loginCheckIssue({ logged_in: false, url: known.url }, known)).toMatch(/logged_in/);
    expect(loginCheckIssue({ logged_in: true, url: "https://a.test/x" }, known)).toMatch(/url/);
  });
  it("for unknown only requires a boolean and the matching url", () => {
    const unknown = { state: "unknown" as const, logged_in: null, url: "https://a.test/?" };
    expect(loginCheckIssue({ logged_in: false, url: unknown.url }, unknown)).toBeUndefined();
    expect(loginCheckIssue({ logged_in: "yes", url: unknown.url }, unknown)).toMatch(/boolean/);
    expect(loginCheckIssue({ logged_in: true, url: "other" }, unknown)).toMatch(/url/);
  });
});
