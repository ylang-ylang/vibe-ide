"""Git-specific constants and diff parsing patterns."""

from __future__ import annotations

import re


GIT_STATUS_META = {
    "conflicted": {"code": "!", "label": "conflicted", "priority": 70},
    "deleted": {"code": "D", "label": "deleted", "priority": 60},
    "modified": {"code": "M", "label": "modified", "priority": 50},
    "added": {"code": "A", "label": "added", "priority": 40},
    "renamed": {"code": "R", "label": "renamed", "priority": 30},
    "copied": {"code": "C", "label": "copied", "priority": 20},
    "typechanged": {"code": "T", "label": "type changed", "priority": 10},
    "untracked": {"code": "U", "label": "untracked", "priority": 0},
}

HUNK_HEADER_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@"
)
