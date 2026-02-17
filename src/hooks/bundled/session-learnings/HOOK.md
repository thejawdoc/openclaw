---
name: session-learnings
description: "Extract session learnings to MEMORY.md after turn inactivity"
homepage: https://docs.openclaw.ai/automation/hooks#session-learnings
metadata:
  {
    "openclaw":
      {
        "emoji": "brain",
        "events": ["session:turn-complete"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Learnings Hook

Extracts key learnings from agent sessions and updates MEMORY.md after a period of turn inactivity.
