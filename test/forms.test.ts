import { describe, expect, it } from "vitest";
import { isFormType, resolveEmailColumn } from "../src/config/forms";

describe("isFormType", () => {
  it("accepts only the two registered types", () => {
    expect(isFormType("application")).toBe(true);
    expect(isFormType("audition")).toBe(true);
    expect(isFormType("Application")).toBe(false);
    expect(isFormType("roster")).toBe(false);
  });
});

describe("resolveEmailColumn", () => {
  const headers = ["Timestamp", "Email Address", "Name", "Video link"];

  it("detects the email column and reports which one it picked", () => {
    const resolved = resolveEmailColumn(headers, null);
    expect(resolved.column).toBe("B");
    expect(resolved.detail).toContain("Email Address");
  });

  it("honours a preferred column when its header agrees", () => {
    expect(resolveEmailColumn(headers, "B").column).toBe("B");
  });

  it("refuses a preferred column whose header is something else", () => {
    const resolved = resolveEmailColumn(headers, "C");
    expect(resolved.column).toBeNull();
    expect(resolved.detail).toContain("Name");
  });

  it("refuses a preferred column with no header at all", () => {
    const resolved = resolveEmailColumn(headers, "Z");
    expect(resolved.column).toBeNull();
    expect(resolved.detail).toContain("no header");
  });

  it("refuses a form that collects no email, since nothing could be matched", () => {
    const resolved = resolveEmailColumn(["Timestamp", "Name", "Video"], null);
    expect(resolved.column).toBeNull();
    expect(resolved.detail).toContain("email");
  });

  it("finds an email column past Z", () => {
    const wide = new Array(30).fill("Question");
    wide[27] = "Your email";
    expect(resolveEmailColumn(wide, null).column).toBe("AB");
  });
});
