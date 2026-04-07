---
name: issue-manage
description: Issue 作成・整理・トリアージ。ユーザーが作業内容を説明したときに起動
user-invocable: true
argument-hint: [description]
---

# /issue-manage — Issue Creation and Triage

トリガー: ユーザーが作業内容を説明したとき、Issue の整理を依頼されたとき。

## Issue Creation Flow

1. FIRST run `gh issue list` to review ALL existing issues in the repo
2. Break down the user's request into well-scoped issues
3. **If investigation is needed** (code structure, affected files, bug analysis): launch a Dispatch (sub-agent) via Agent tool. The Dispatch returns findings only — it does NOT create issues
4. Based on Dispatch findings and user input, create issues with `gh issue create` — always include a `type/*` label
5. Analyze dependencies: which new issues depend on existing or other new issues
6. **Before adding `depends-on/<number>` labels**: verify each dependency target is OPEN (`gh issue view <number> --json state --jq '.state'`). If closed, skip the dependency and propose a new issue or reopen to the user
7. Add `depends-on/<number>` labels for each verified-open dependency
8. Confirm created issues and their dependency relationships to the user

**IMPORTANT**: Dispatch agents must NEVER run `gh issue create`. Issue creation is exclusively Bridge's responsibility.

## Mandatory Labels on Issue Creation

Every issue MUST have:
1. **One `type/` label** — choose exactly one based on classification criteria

Optional labels:
- `priority/critical` — only when the human explicitly instructs
- `depends-on/<number>` — when the issue depends on another issue (one label per dependency)

> **Note**: No `status/` labels are needed on issue creation. Sortie candidates = open issues without `status/sortied`. The Engine adds `status/sortied` when a Ship launches.

## Type Classification Criteria

| Criterion | Label |
|-----------|-------|
| Existing behavior is broken | `type/bug` |
| Changes to AI control settings (CLAUDE.md, skills/, rules/) | `type/skill` |
| CI/CD, build config, or dependency management | `type/infra` |
| Adding or modifying tests | `type/test` |
| Code improvement with no behavior change | `type/refactor` |
| Adding new functionality | `type/feature` |

If ambiguous, ask the human before creating the issue.

## Issue Creation Best Practices

- Always include clear requirements, acceptance criteria, and type labels
- Include one `type/*` label in every `gh issue create` command

## Dependency Tracking

- Use `depends-on/<number>` labels to mark blocking relationships (one label per dependency)
- The Engine automatically removes `depends-on/<N>` labels when a dependency issue is closed
- **Before setting a `depends-on/<number>` label**, verify the target issue is OPEN:
  ```bash
  gh issue view <number> --json state --jq '.state'
  ```
  If `CLOSED`: do NOT add the dependency. Instead propose to the user: (1) create a new issue, or (2) reopen the closed issue

## Sortie Readiness Evaluation

When asked about what to work on next:
1. Assess issue clarity and priority
2. Recommend a sortie order to the user
3. The user can then ask Flagship to launch sorties

## Closed Issue Check (Pre-Operation)

Before performing ANY operation on an existing issue (comment, label, dependency), verify its state:

```bash
STATE=$(gh issue view <number> --json state --jq '.state')
```

If `STATE` is `CLOSED`:
1. **Do NOT** add comments, labels, or dependencies to the closed issue
2. Inform the user that the issue is already closed
3. Propose one of:
   - **Create a new issue** referencing the closed one
   - **Reopen** the issue with `gh issue reopen <number>`

## Issue Triage Rules

When reviewing or organizing existing issues:

1. **State check**: verify the issue is OPEN before making changes. If closed, follow the "Closed Issue Check" rule above
2. **Type label**: exactly one `type/` label. If missing, classify and add. If incorrect, replace
3. **Type accuracy**: re-evaluate against classification criteria. If comments changed the nature of work, update accordingly
4. **Legacy labels**: remove outdated labels not following `type/` or `priority/` prefix convention. Remove any `status/ready` or `status/mooring` labels (these are deleted)
5. **Dependency labels**: ensure `depends-on/<number>` labels are accurate. Remove for closed dependencies. Migrate body "## Dependencies" sections to labels

## Priority Rules

- Evaluate urgency and impact when triaging issues
- Use `priority/*` labels to indicate importance (`priority/critical` for urgent issues)
- Only humans may apply the `priority/critical` label — Dock may suggest it but must not apply it
