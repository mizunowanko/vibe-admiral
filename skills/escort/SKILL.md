# /escort — Persistent Gate Reviewer

Unified Escort skill that persists across all gate phases for a single Ship.
Polls the parent Ship's phase via Engine REST API and performs gate reviews
when gate phases are detected.

## Environment Variables

- `VIBE_ADMIRAL_SHIP_ID` — This Escort Ship's own ID
- `VIBE_ADMIRAL_PARENT_SHIP_ID` — The parent Ship being reviewed
- `VIBE_ADMIRAL_MAIN_REPO` — The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API port (default: 9721)

## Arguments

- Issue number (e.g., `42`)

## Main Loop

Poll the parent Ship's phase and execute the appropriate gate review when a gate phase is detected.

```bash
PARENT_SHIP_ID="${VIBE_ADMIRAL_PARENT_SHIP_ID}"
ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
ISSUE_NUMBER=<issue-number>
REPO="${VIBE_ADMIRAL_MAIN_REPO}"
POLL_INTERVAL=30

while true; do
  RESULT=$(curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/phase")
  PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)

  case "$PHASE" in
    planning-gate)
      echo "Detected planning-gate — starting plan review"
      # Execute plan review (see Planning Gate Review section below)
      ;;
    implementing-gate)
      echo "Detected implementing-gate — starting code review"
      # Execute code review (see Implementing Gate Review section below)
      ;;
    acceptance-test-gate)
      echo "Detected acceptance-test-gate — starting acceptance test"
      # Execute acceptance test (see Acceptance Test Gate Review section below)
      ;;
    done|stopped)
      echo "Parent Ship phase is ${PHASE} — Escort exiting"
      exit 0
      ;;
    *)
      # Parent Ship is in a work phase — wait and poll again
      # NOTE: This sleep is an intentional polling interval, NOT rate limit backoff.
      sleep $POLL_INTERVAL
      ;;
  esac
done
```

## Planning Gate Review

When the parent Ship enters `planning-gate`:

1. Read the Issue and its comments to find the Implementation Plan comment:
   ```bash
   gh issue view $ISSUE_NUMBER --repo "$REPO" --json number,title,body,labels,comments
   ```

2. Review the plan for:
   - Alignment with Issue requirements
   - Feasibility and completeness
   - Impact analysis accuracy
   - Test plan adequacy

3. Post review findings as an Issue comment

4. Submit verdict:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Implementing Gate Review

When the parent Ship enters `implementing-gate`:

1. Get the PR URL from the parent Ship or find it via gh:
   ```bash
   gh pr list --head "<branch-name>" --repo "$REPO" --json number,url --jq '.[0]'
   ```

2. Review the PR diff:
   ```bash
   gh pr diff <pr-number> --repo "$REPO"
   ```

3. Check for:
   - Code quality and consistency
   - **Alignment with the approved plan** (you reviewed the plan in planning-gate)
   - Test coverage
   - No security issues

4. Post review findings as a PR comment

5. Submit verdict:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Acceptance Test Gate Review

When the parent Ship enters `acceptance-test-gate`:

### Step 0: QA Required Check

Check if QA is required by reading the planning-gate transition metadata:
```bash
TRANSITIONS=$(curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/phase-transition-log?limit=50")
# Find the planning-gate transition and extract qaRequired from metadata
QA_REQUIRED=$(echo "$TRANSITIONS" | grep -o '"toPhase":"planning-gate"[^}]*"metadata":{[^}]*"qaRequired":[^,}]*' | grep -o '"qaRequired":[^,}]*' | cut -d: -f2 | head -1)
QA_REQUIRED="${QA_REQUIRED:-true}"
```

If `QA_REQUIRED` is `false`:
1. Post a QA skip comment on the PR
2. Submit `approve` verdict immediately
3. Return to the polling loop (do not execute the steps below)

### Steps (when QA is required):

1. Read the Issue to understand acceptance criteria

2. Run Playwright E2E tests if applicable:
   ```bash
   npx playwright test
   ```

3. Verify acceptance criteria are met

4. Submit verdict:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Key Advantages

- **Context preservation**: Plan review insights carry over to code review
- **Consistency**: Same agent ensures plan and implementation align
- **Efficiency**: No repeated context loading across gates
