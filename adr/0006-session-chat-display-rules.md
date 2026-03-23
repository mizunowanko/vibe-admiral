# ADR-0006: SessionChat Display Rules by Unit Type

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#588](https://github.com/mizunowanko-org/vibe-admiral/issues/588)
- **Tags**: frontend, session-chat, display-rules

## Context

SessionChat renders messages from multiple Unit types (Dock, Flagship, Ship, Dispatch) in a single component tree. Different Unit types have different visibility requirements — for example, Ship sessions never receive User messages (running in `-p` mode), and Dock sessions should not display Ship operation messages. Without explicit rules, the display logic was implicit and scattered, leading to potential display of irrelevant elements.

Additionally, the AskUserQuestion feature (Question display + Pending Question banner) was implemented but never used in production — Commanders use `allowedTools` restrictions that include `AskUserQuestion`, but the Engine intercepts it before it reaches the frontend UI flow. This dead code path added unnecessary complexity.

## Decision

### Display Visibility Matrix

Enforce the following visibility rules at the `SessionMessage` render level (return `null` for suppressed messages):

#### Scroll Area — Conversation Messages

| Element | Dock | Flagship | Ship |
|---------|:----:|:--------:|:----:|
| User message | ✓ | ✓ | - |
| Assistant message | ✓ | ✓ | ✓ |
| Error message | ✓ | ✓ | ✓ |

#### Scroll Area — Tool Display

| Element | Dock | Flagship | Ship |
|---------|:----:|:--------:|:----:|
| Tool Use / Tool Result | ✓ | ✓ | ✓ |
| ToolUseGroup | ✓ | ✓ | ✓ |

#### Scroll Area — System Messages

| Element | Dock | Flagship | Ship |
|---------|:----:|:--------:|:----:|
| Compact Status | ✓ | ✓ | ✓ |
| Task Notification | ✓ | ✓ | ✓ |
| Request Result | ✓ | ✓ | ✓ |
| Dispatch Log | ✓ | ✓ | ✓ |
| Escort Log | - | - | ✓ |
| Commander Status | ✓ | ✓ | - |

#### Scroll Area — Ship Operation Messages

Scope rule: Dock suppressed, Flagship shows all Ships, Ship shows own Ship only.

| Element | Dock | Flagship | Ship |
|---------|:----:|:--------:|:----:|
| Ship Status badge | - | ✓ (all) | ✓ (own) |
| Gate Check Request | - | ✓ (all) | ✓ (own) |
| PR Review Request | - | ✓ (all) | ✓ (own) |
| Lookout Alert | - | ✓ (all) | - |

#### Message Processing Pipeline

| Processing | Dock | Flagship | Ship |
|------------|:----:|:--------:|:----:|
| collapseShipStatus | - | ✓ | - |
| groupToolMessages | ✓ | ✓ | ✓ |
| LOG_TAIL_LIMIT (200) | - | - | ✓ |

### Filtering Strategy

Filtering is applied at the `SessionMessage` component render level rather than at the data/hook level. This keeps the message pipeline simple and the display rules co-located in a single component with a visibility matrix comment.

### Removed: AskUserQuestion UI

The Question rendering branch in `SessionMessage`, Pending Question banner in `SessionChat`, and `pendingQuestion`/`answerQuestion` state in `useCommander` are removed. The `"question"` type is removed from `StreamMessage`. Server-side message types (`ServerMessage`) are preserved for Engine compatibility.

### Alternatives Considered

- **Filter at hook level** (`useSessionMessages`): Rejected because it would split display rules across multiple files and make the visibility matrix harder to audit.
- **Keep AskUserQuestion as feature flag**: Rejected because the feature is architecturally incompatible with the current Commander `allowedTools` setup where the Engine intercepts questions.

## Consequences

- **Positive**: Display rules are documented and enforced in code. Dead code (AskUserQuestion UI) is removed, reducing frontend complexity.
- **Positive**: `collapseShipStatus` only runs for Flagship where ship-status messages are actually visible, avoiding unnecessary processing for Dock.
- **Negative**: If AskUserQuestion is ever needed in the future, the UI must be re-implemented. However, the Engine-side plumbing (`ServerMessage` types) is preserved.
- **Neutral**: Ship operation message suppression in Dock is defensive — Engine typically doesn't send these to Dock, but the render guard ensures correctness regardless.
