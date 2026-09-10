import { describe, expect, it } from "vitest";
import { subcommandOf } from "../src/commands/options";
import type { Interaction } from "../src/discord/types";

const interaction = (data: Interaction["data"]): Interaction =>
  ({ id: "1", type: 2, token: "t", application_id: "a", data }) as Interaction;

describe("subcommandOf", () => {
  it("reads the subcommand name and its options", () => {
    const sub = subcommandOf(
      interaction({
        name: "form",
        options: [
          {
            name: "register",
            type: 1,
            options: [
              { name: "type", type: 3, value: "audition" },
              { name: "url", type: 3, value: "https://docs.google.com/forms/d/ABC/edit" },
            ],
          },
        ],
      }),
    );
    expect(sub?.name).toBe("register");
    expect(sub?.options.get("type")).toBe("audition");
    expect(sub?.options.get("url")).toContain("forms/d/ABC");
  });

  it("returns null when the first option isn't a subcommand", () => {
    expect(
      subcommandOf(interaction({ name: "form", options: [{ name: "type", type: 3, value: "x" }] })),
    ).toBeNull();
    expect(subcommandOf(interaction({ name: "form" }))).toBeNull();
  });
});
