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
3. **If investigation is needed** (code structure, affected files, bug analysis): launch a Dispatch (sub-agent) via Task tool. The Dispatch returns findings only — it does NOT create issues
4. Based on Dispatch findings and user input, create issues with `gh issue create` — always include `--label status/ready` and a `type/*` label
5. Analyze dependencies: which new issues depend on existing or other new issues
6. Add `depends-on/<number>` labels for each dependency
7. Confirm created issues and their dependency relationships to the user

**IMPORTANT**: Dispatch agents must NEVER run `gh issue create`. Issue creation is exclusively Bridge's responsibility.

## Mandatory Labels on Issue Creation

> **Note**: Bridge Rules state "Never touch `status/*` labels", but issue creation is the **sole exception** — you MUST include `--label status/ready` in every `gh issue create` command. Without it, the issue won't appear in the sortie candidate list and will require manual label addition.

Every issue MUST have:
1. **One `status/` label** — always `status/ready` for new issues (include `--label status/ready` in the `gh issue create` command)
2. **One `type/` label** — choose exactly one based on classification criteria

Optional labels:
- `priority/critical` — only when the human explicitly instructs
- `depends-on/<number>` — when the issue depends on another issue (one label per dependency)

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

## Issue Triage Rules

When reviewing or organizing existing issues:

1. **Status label**: exactly one `status/` label. If multiple exist, remove extras. If none, add `status/ready`
2. **Type label**: exactly one `type/` label. If missing, classify and add. If incorrect, replace
3. **Type accuracy**: re-evaluate against classification criteria. If comments changed the nature of work, update accordingly
4. **Legacy labels**: remove outdated labels not following `status/` or `type/` prefix convention. Replace with correct labels
5. **Dependency labels**: ensure `depends-on/<number>` labels are accurate. Remove for closed dependencies. Migrate body "## Dependencies" sections to labels
