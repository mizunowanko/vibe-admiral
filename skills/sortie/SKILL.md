---
name: sortie
description: Sortie 計画・優先順位決定・出撃実行。"sortie" や "出撃" で起動
user-invocable: true
argument-hint: [issue-numbers]
---

# /sortie — Sortie Planning and Execution

トリガー: ユーザーが実装開始を依頼したとき ("start implementation", "sortie", "出撃", etc.)

## Autonomous Sortie Flow

1. Run `gh issue list --label status/ready` to get ready issues
2. For each issue, check `depends-on/<N>` labels to identify dependencies. If an issue has `depends-on/` labels pointing to open issues, it is blocked
3. Read body AND comments (`gh issue view <number> --json number,title,body,labels,state,comments`) for additional context: sub-issues, "## Dependencies" section (legacy), priority overrides, and human decisions
4. **Issue Clarity Check** — Assess each sortie candidate (see below)
5. Identify which issues are UNBLOCKED, labeled "status/ready", and sufficiently clear
6. Apply Sortie Priority Rules to determine the recommended order
7. Explain analysis to the human (which issues are ready, which are blocked and why, which need clarification, and the proposed priority order)
8. Launch UNBLOCKED + "status/ready" + **clear** issues via `sortie` admiral-request
9. After sortie, monitor with `ship-status` when asked

## Issue Clarity Check

Before launching a sortie, Bridge MUST assess whether each candidate issue is clear enough for a Ship to implement autonomously. Ships cannot ask questions (AskUserQuestion is disallowed), so unclear issues lead to wasted sorties.

### Assessment Criteria

Evaluate the issue body (and comments) for:

1. **Specific behavior or outcome**: Does the issue describe what should happen? (e.g., "add a button that does X" or "fix the crash when Y")
2. **Scope boundaries**: Is it clear what is in scope and what is not?
3. **Acceptance criteria or expected result**: Can a Ship determine when the task is done?
4. **For bugs**: Are reproduction steps or error descriptions provided?

### Clarity Levels

| Level | Action |
|-------|--------|
| **Clear** | Proceed to sortie |
| **Mostly clear** | Proceed — minor ambiguities can be resolved by Ship during planning |
| **Unclear** | Ask the human for clarification before sortie |

### When an issue is unclear

1. Tell the human which issue(s) need clarification and what specifically is missing
2. Use `AskUserQuestion` to ask targeted questions (one question per unclear issue, covering all missing points)
3. After receiving answers, update the issue:
   - Use `gh issue comment <number> --body "<clarification>"` to add the clarification as a comment
   - Or use `gh issue edit <number> --body "<updated body>"` if the body needs structural correction
4. Re-assess: if now clear, include in the sortie batch; if still unclear, inform the human and defer

### Examples of unclear issues

- Title only, no body: "Add dark mode" — What components? Toggle location? Default state?
- Vague requirement: "Improve performance" — Which page? What metric? What target?
- Missing context: "Fix the bug" — What bug? Steps to reproduce? Expected vs actual behavior?

### Examples of clear issues

- "Add a dark mode toggle to Settings page. Store preference in localStorage. Default to system preference."
- "Fix: clicking 'Save' on the Fleet config page causes a 500 error when `maxConcurrentSorties` is empty. Expected: validation prevents empty submission."

> **NOTE**: The Engine automatically removes `depends-on/<N>` labels and transitions `status/mooring` → `status/ready` when a dependency issue is closed.

## Label System

### Status labels (`status/` prefix) — Engine-managed, mutually exclusive
| Label | Meaning |
|-------|---------|
| `status/ready` | Ready for sortie |
| `status/sortied` | Ship is active |
| `status/mooring` | Blocked by dependencies |

### Type labels (`type/` prefix) — set by Bridge or human
| Priority | Label | Commit prefix |
|----------|-------|---------------|
| 1 | `type/skill` | `skill:` |
| 2 | `type/bug` | `fix:` |
| 3 | `type/infra` | `infra:` |
| 4 | `type/test` | `test:` |
| 5 | `type/refactor` | `refactor:` |
| 6 | `type/feature` | `feat:` |

## Sortie Priority Rules

### Base Priority (type label order)
| Rank | Label | Target |
|------|-------|--------|
| 1 | `type/skill` | AI control settings |
| 2 | `type/bug` | Bug fixes |
| 3 | `type/infra` | CI/CD and build config |
| 4 | `type/test` | Test additions/fixes |
| 5 | `type/refactor` | Refactoring |
| 6 | `type/feature` | New features |

### Priority Label Override
Issues with `priority/critical` override base priority and sort first. Only humans may apply this label.

### Dependency Constraint
- Issues with `depends-on/<N>` pointing to open issues are blocked and MUST NOT be sortied
- Within same tier, fewer `depends-on/` labels come first (they unblock others)
- `status/mooring` issues are excluded from candidates

### Decision Flow
1. Collect all `status/ready` issues
2. Filter out issues with `depends-on/<N>` pointing to open issues
3. Separate `priority/critical` issues (these come first)
4. Sort remaining by base type priority
5. Within each tier, prefer issues with fewer dependencies
6. **Critical Issue Escalation** — if any candidate has `priority/critical`, run the Pre-Sortie Escalation flow (see below) BEFORE proceeding
7. Propose ordered list to human → sortie after approval

## Pre-Sortie Escalation (priority/critical)

When a sortie candidate has the `priority/critical` label, Bridge MUST discuss the approach with the human **before** launching the sortie. Ships run non-interactively and cannot ask questions, so unclear or risky plans waste the sortie.

### Why before sortie

- Ships run in `-p` mode — changing direction after launch requires stop → issue update → re-sortie
- Fixing the plan pre-sortie is cheap; fixing it post-sortie is expensive
- plan-review Gate happens after the Ship has already started, which is too late for critical decisions

### Escalation Flow

1. **Highlight**: Clearly inform the human that critical issue(s) were detected in the sortie candidates
2. **Summarize**: For each critical issue, present:
   - Issue number, title, and labels
   - Impact scope (which components, systems, or users are affected)
   - Proposed approach (from the issue body or Bridge's analysis)
   - Key risks or open questions
3. **Discuss**: Ask the human to confirm, refine, or reject the approach. Use normal Bridge chat messages — do NOT use `AskUserQuestion`
4. **Record**: After reaching agreement, update the issue to capture the agreed approach:
   - `gh issue edit <number> --body "<updated body>"` to append an "## Agreed Approach" section, OR
   - `gh issue comment <number> --body "<agreement summary>"` if the body should remain unchanged
5. **Proceed**: Include the critical issue(s) in the sortie batch alongside any non-critical candidates

### Constraints

- **`AskUserQuestion` is PROHIBITED** for this flow. Use regular Bridge chat messages only.
- Only humans may apply the `priority/critical` label. Bridge may suggest it but must not apply it.
- If the human declines the approach, defer the critical issue and sortie only the non-critical candidates.
- Non-critical candidates in the same batch do NOT need escalation — they proceed normally.

> **NOTE**: The Engine's `getUnblockedReadyIssues()` returns issues pre-sorted by this priority order. Bridge should respect this order.
