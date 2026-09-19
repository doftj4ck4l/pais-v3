import { describe, expect, test } from "bun:test";
import { containerSkillPromptLocations } from "./skill.service";

describe("skill prompt locations", () => {
  test("advertises the sandbox mount instead of host checkout paths", () => {
    const root = "/home/operator/pixelspace/apps/api/skills";
    const filePath = `${root}/docx/SKILL.md`;
    const block = `<skill><location>${filePath}</location></skill>`;

    expect(containerSkillPromptLocations(block, [{ filePath }], root)).toBe(
      "<skill><location>/skills/docx/SKILL.md</location></skill>",
    );
  });
});
