import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseRaciFile, type ParsedTeam } from "./raci-parse";

const FILE = resolve(__dirname, "../../attached_assets/IT_Team_RACI_1784220382220.xlsx");

describe("parseRaciFile (real IT team spreadsheet)", () => {
  const teams = parseRaciFile(FILE);
  const byName = new Map(teams.map((t) => [t.name, t]));
  const team = (name: string): ParsedTeam => {
    const t = byName.get(name);
    if (!t) throw new Error(`missing team ${name}`);
    return t;
  };

  it("parses the four team sheets in order", () => {
    expect(teams.map((t) => t.name)).toEqual([
      "Shared Systems",
      "Software Squad",
      "IT Ops",
      "Projects",
    ]);
  });

  it("reads member columns per sheet", () => {
    expect(team("Shared Systems").members).toEqual([
      "Brad", "Jose", "Ash", "Stephen", "Val", "Akin", "Marquis", "Esmeralda", "Bobby", "JJ",
    ]);
    expect(team("Software Squad").members).toContain("OakSchool(Katie)");
    expect(team("IT Ops").members).toEqual([
      "Brad", "Jose", "Esmeralda", "Bobby", "Marquis", "Stephen",
    ]);
  });

  it("groups rows under purple category headers", () => {
    const shared = team("Shared Systems");
    const pw = shared.rows.find((r) => r.name === "Password Resets");
    expect(pw?.category).toBe("Clever");
    expect(pw?.assignments).toEqual([{ member: "Bobby", value: "R" }]);
    const dns = shared.rows.find((r) => r.name === "Domain DNS");
    expect(dns?.category).toBe("AWS");
  });

  it("keeps category headers that carry assignments as rows too", () => {
    const squad = team("Software Squad");
    const rostering = squad.rows.find((r) => r.name === "ROSTERING");
    expect(rostering?.category).toBe("ROSTERING");
    expect(rostering?.assignments).toEqual(
      expect.arrayContaining([
        { member: "Brad", value: "I" },
        { member: "Ash", value: "A" },
      ]),
    );
    // Plain category headers (no assignments) become categories only.
    const shared = team("Shared Systems");
    expect(shared.rows.filter((r) => r.name === "Adobe")).toHaveLength(0);
    expect(shared.rows.some((r) => r.category === "Adobe")).toBe(true);
  });

  it("keeps rows with no assignments (e.g. McGraw-Hill) as tasks", () => {
    const squad = team("Software Squad");
    const mgh = squad.rows.find((r) => r.name === "McGraw-Hill");
    expect(mgh).toBeDefined();
    expect(mgh?.assignments).toEqual([]);
  });

  it("normalizes N/A cells", () => {
    const ops = team("IT Ops");
    const recycling = ops.rows.find((r) => r.name === "Recycling");
    expect(recycling?.assignments).toEqual(
      expect.arrayContaining([{ member: "Marquis", value: "N/A" }]),
    );
  });

  it("skips legend/blank rows and stops cleanly at trailing empties", () => {
    for (const t of teams) {
      expect(t.rows.every((r) => r.name.trim().length > 0)).toBe(true);
      expect(t.rows.some((r) => r.name.startsWith("Responsible:"))).toBe(false);
      expect(t.rows.some((r) => r.name.startsWith("Project:"))).toBe(false);
    }
    // Projects sheet has no purple categories → all rows ungrouped.
    expect(team("Projects").rows.every((r) => r.category === null)).toBe(true);
    expect(team("Projects").rows.map((r) => r.name)).toContain("SPED AMS");
  });
});
