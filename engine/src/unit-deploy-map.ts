/**
 * Unit-based deploy mapping for skills and rules.
 * Each UnitType maps to its own skills (sourced from units/<unit>/skills/)
 * and shared skills (sourced from units/shared/skills/).
 */

export type UnitType = "ship" | "escort" | "flagship" | "dock";

export const UNIT_DEPLOY_MAP: Record<UnitType, { skills: string[]; sharedSkills: string[] }> = {
  ship: {
    skills: ["implement"],
    sharedSkills: ["admiral-protocol", "read-issue"],
  },
  escort: {
    skills: ["planning-gate", "implementing-gate", "acceptance-test-gate"],
    sharedSkills: ["read-issue", "escort-gate-protocol"],
  },
  flagship: {
    skills: ["sortie", "ship-inspect"],
    sharedSkills: ["admiral-protocol", "read-issue"],
  },
  dock: {
    skills: ["issue-manage", "investigate", "dock-ship-status"],
    sharedSkills: ["admiral-protocol", "read-issue"],
  },
};
