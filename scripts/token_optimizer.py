#!/usr/bin/env python3
"""
token_optimizer.py — Waste detection + smart compaction for Relay sessions.

Ported from https://github.com/alexgreensh/token-optimizer (TypeScript).
Adapted for the Relay system's session-driver architecture.

Two main features:
  1. WasteDetector — tracks per-message metrics, detects waste patterns
  2. SmartCompactor — extracts semantic checkpoints before context fills up

Usage in session-driver.py:
    from token_optimizer import WasteDetector, SmartCompactor

    detector = WasteDetector(session_name="codex")
    compactor = SmartCompactor(session_name="codex")

    # After each ask():
    detector.record(prompt, response, elapsed_seconds)
    findings = detector.analyze()

    # Before compaction / at intervals:
    checkpoint = compactor.capture(conversation_history)
    # On restart:
    restored = compactor.restore()
"""

import json
import os
import re
import hashlib
import time
import logging
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

log = logging.getLogger("token-optimizer")

# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class MessageMetric:
    """Metrics for a single ask() call."""
    timestamp: float
    prompt_len: int       # chars in prompt
    response_len: int     # chars in response
    elapsed_secs: float   # wall-clock time
    is_empty: bool        # response was empty/error
    is_timeout: bool      # timed out
    user: str = ""        # telegram user who triggered it
    prompt_preview: str = ""  # first 100 chars of prompt


@dataclass
class WasteFinding:
    """A detected waste pattern."""
    waste_type: str
    severity: str         # low, medium, high, critical
    confidence: float     # 0-1
    description: str
    recommendation: str
    evidence: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Waste Detection — adapted from waste-detectors.ts
# ---------------------------------------------------------------------------

class WasteDetector:
    """
    Tracks per-message metrics and detects waste patterns.

    Relevant detectors (adapted from token-optimizer):
    - empty_responses: high input, no/error output (≈ empty_runs)
    - session_bloat: long session without restart (≈ session_history_bloat)
    - loop_detection: repetitive short responses (≈ loop_detection)
    - slow_responses: consistently slow ask() calls
    - abandoned_prompts: prompts that time out repeatedly
    """

    def __init__(self, session_name: str, max_history: int = 500):
        self.session_name = session_name
        self.max_history = max_history
        self.metrics: list[MessageMetric] = []
        self._start_time = time.time()
        self._state_file = f"/tmp/token-opt-{session_name}.json"
        self._load_state()

    def record(self, prompt: str, response: str, elapsed: float,
               user: str = "", timed_out: bool = False):
        """Record metrics for one ask() call."""
        is_empty = (
            not response.strip()
            or response.startswith("Error:")
            or len(response.strip()) < 10
        )
        metric = MessageMetric(
            timestamp=time.time(),
            prompt_len=len(prompt),
            response_len=len(response),
            elapsed_secs=elapsed,
            is_empty=is_empty,
            is_timeout=timed_out,
            user=user,
            prompt_preview=prompt[:100],
        )
        self.metrics.append(metric)

        # Trim history
        if len(self.metrics) > self.max_history:
            self.metrics = self.metrics[-self.max_history:]

        self._save_state()

    def analyze(self) -> list[WasteFinding]:
        """Run all detectors and return findings sorted by severity."""
        if len(self.metrics) < 3:
            return []

        findings = []
        findings.extend(self._detect_empty_responses())
        findings.extend(self._detect_session_bloat())
        findings.extend(self._detect_loops())
        findings.extend(self._detect_slow_responses())
        findings.extend(self._detect_abandoned_prompts())

        # Sort: critical > high > medium > low
        severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        findings.sort(key=lambda f: severity_order.get(f.severity, 99))
        return findings

    def get_stats(self) -> dict:
        """Return current session stats."""
        if not self.metrics:
            return {"messages": 0, "uptime_hours": 0}

        total = len(self.metrics)
        empty_count = sum(1 for m in self.metrics if m.is_empty)
        timeout_count = sum(1 for m in self.metrics if m.is_timeout)
        avg_elapsed = sum(m.elapsed_secs for m in self.metrics) / total
        avg_response_len = sum(m.response_len for m in self.metrics) / total
        uptime = (time.time() - self._start_time) / 3600

        return {
            "messages": total,
            "empty_count": empty_count,
            "timeout_count": timeout_count,
            "empty_pct": round(empty_count / total * 100, 1),
            "avg_elapsed_secs": round(avg_elapsed, 1),
            "avg_response_chars": round(avg_response_len),
            "uptime_hours": round(uptime, 1),
        }

    # -- Detectors --

    def _detect_empty_responses(self) -> list[WasteFinding]:
        """Detect high rate of empty/error responses (≈ empty_runs detector)."""
        recent = self.metrics[-20:]
        empty = [m for m in recent if m.is_empty]

        if len(empty) < 3:
            return []

        empty_pct = len(empty) / len(recent)
        if empty_pct < 0.3:
            return []

        severity = "critical" if empty_pct > 0.7 else "high" if empty_pct > 0.5 else "medium"

        return [WasteFinding(
            waste_type="empty_responses",
            severity=severity,
            confidence=0.85,
            description=f"{len(empty)}/{len(recent)} recent responses empty/error ({empty_pct:.0%})",
            recommendation="Check if Claude session is healthy. Consider restart if pattern persists.",
            evidence={
                "empty_count": len(empty),
                "total_recent": len(recent),
                "empty_pct": round(empty_pct * 100, 1),
            },
        )]

    def _detect_session_bloat(self) -> list[WasteFinding]:
        """Detect long sessions that may need compaction (≈ session_history_bloat)."""
        uptime_hours = (time.time() - self._start_time) / 3600
        msg_count = len(self.metrics)

        # Flag if session has been running 4+ hours with 50+ messages
        if uptime_hours < 4 or msg_count < 50:
            return []

        total_prompt_chars = sum(m.prompt_len for m in self.metrics)
        # Rough estimate: 4 chars ≈ 1 token
        est_tokens = total_prompt_chars // 4

        severity = "high" if est_tokens > 500_000 else "medium"

        return [WasteFinding(
            waste_type="session_bloat",
            severity=severity,
            confidence=0.6,
            description=f"Session running {uptime_hours:.1f}h with {msg_count} messages (~{est_tokens:,} est. tokens)",
            recommendation="Consider smart compaction checkpoint + session restart to reclaim context window.",
            evidence={
                "uptime_hours": round(uptime_hours, 1),
                "message_count": msg_count,
                "est_total_tokens": est_tokens,
            },
        )]

    def _detect_loops(self) -> list[WasteFinding]:
        """Detect stuck loops — many messages with very short responses (≈ loop_detection)."""
        if len(self.metrics) < 10:
            return []

        recent = self.metrics[-15:]
        short_responses = [m for m in recent if m.response_len < 50 and not m.is_empty]

        if len(short_responses) < 8:
            return []

        # Check if responses are similar (potential retry storm)
        previews = [m.prompt_preview for m in short_responses]
        unique_prompts = len(set(previews))
        repetition = 1 - (unique_prompts / len(previews)) if previews else 0

        severity = "high" if repetition > 0.5 else "medium"

        return [WasteFinding(
            waste_type="loop_detection",
            severity=severity,
            confidence=0.6 + (repetition * 0.3),
            description=f"{len(short_responses)}/{len(recent)} recent responses are very short. "
                        f"Prompt repetition: {repetition:.0%}",
            recommendation="Check for retry storms or stuck tool calls. "
                           "Add loop-break logic or restart session.",
            evidence={
                "short_count": len(short_responses),
                "unique_prompts": unique_prompts,
                "repetition_pct": round(repetition * 100, 1),
            },
        )]

    def _detect_slow_responses(self) -> list[WasteFinding]:
        """Detect consistently slow responses."""
        recent = self.metrics[-10:]
        slow = [m for m in recent if m.elapsed_secs > 120]

        if len(slow) < 3:
            return []

        avg_time = sum(m.elapsed_secs for m in slow) / len(slow)

        return [WasteFinding(
            waste_type="slow_responses",
            severity="medium",
            confidence=0.7,
            description=f"{len(slow)}/{len(recent)} recent responses took >2min (avg {avg_time:.0f}s)",
            recommendation="Claude may be overloaded or context too large. "
                           "Consider compaction or model switch.",
            evidence={
                "slow_count": len(slow),
                "avg_seconds": round(avg_time),
            },
        )]

    def _detect_abandoned_prompts(self) -> list[WasteFinding]:
        """Detect repeated timeouts (≈ abandoned_sessions)."""
        recent = self.metrics[-10:]
        timeouts = [m for m in recent if m.is_timeout]

        if len(timeouts) < 2:
            return []

        severity = "critical" if len(timeouts) >= 5 else "high" if len(timeouts) >= 3 else "medium"

        return [WasteFinding(
            waste_type="abandoned_prompts",
            severity=severity,
            confidence=0.9,
            description=f"{len(timeouts)}/{len(recent)} recent prompts timed out",
            recommendation="Session likely unhealthy. Force restart.",
            evidence={"timeout_count": len(timeouts)},
        )]

    # -- Persistence --

    def _save_state(self):
        """Save metrics to disk for persistence across restarts."""
        try:
            data = {
                "session_name": self.session_name,
                "start_time": self._start_time,
                "metrics": [asdict(m) for m in self.metrics[-100:]],  # keep last 100
            }
            with open(self._state_file, "w") as f:
                json.dump(data, f)
        except Exception as e:
            log.debug(f"Failed to save state: {e}")

    def _load_state(self):
        """Load previous metrics from disk."""
        try:
            if os.path.exists(self._state_file):
                with open(self._state_file) as f:
                    data = json.load(f)
                self._start_time = data.get("start_time", self._start_time)
                for m in data.get("metrics", []):
                    self.metrics.append(MessageMetric(**m))
                log.info(f"Loaded {len(self.metrics)} previous metrics")
        except Exception as e:
            log.debug(f"Failed to load state: {e}")


# ---------------------------------------------------------------------------
# Smart Compaction — adapted from smart-compact.ts v2
# ---------------------------------------------------------------------------

# Pattern sets for intelligent extraction (from smart-compact.ts)
DECISION_PATTERNS = [
    re.compile(r"\bI'll\b", re.I),
    re.compile(r"\bLet's\b", re.I),
    re.compile(r"\bdecided\b", re.I),
    re.compile(r"\bchoosing\b", re.I),
    re.compile(r"\bgoing with\b", re.I),
    re.compile(r"\bswitching to\b", re.I),
]

ERROR_PATTERNS = [
    re.compile(r"\bError[:!]", re.I),
    re.compile(r"\bfailed\b", re.I),
    re.compile(r"\bexception\b", re.I),
    re.compile(r"\btraceback\b", re.I),
    re.compile(r"\bTypeError\b"),
    re.compile(r"\bSyntaxError\b"),
    re.compile(r"\bENOENT\b"),
    re.compile(r"\bconnection refused\b", re.I),
]

FILE_CHANGE_PATTERNS = [
    re.compile(r"\bwrit(?:e|ing|ten)\b", re.I),
    re.compile(r"\bedit(?:ed|ing)?\b", re.I),
    re.compile(r"\bcreated?\b", re.I),
    re.compile(r"\bmodif(?:y|ied|ying)\b", re.I),
]

INSTRUCTION_PATTERNS = [
    re.compile(r"\balways\b", re.I),
    re.compile(r"\bnever\b", re.I),
    re.compile(r"\bmake sure\b", re.I),
    re.compile(r"\bdon't\b", re.I),
    re.compile(r"\bdo not\b", re.I),
    re.compile(r"\bmust\b", re.I),
]


def _matches_any(text: str, patterns: list[re.Pattern]) -> bool:
    return any(p.search(text) for p in patterns)


@dataclass
class ExtractedContext:
    """Semantic context extracted from conversation."""
    decisions: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    file_changes: list[str] = field(default_factory=list)
    user_instructions: list[str] = field(default_factory=list)


class SmartCompactor:
    """
    Captures semantic checkpoints of session state.

    Before compaction (or periodically), extracts:
    - Key decisions made by Claude
    - Errors encountered and resolved
    - Files created/modified
    - User instructions/constraints

    This context is saved as a checkpoint that can be restored
    after session restart to preserve continuity.
    """

    def __init__(self, session_name: str, checkpoint_dir: str = "/tmp/checkpoints"):
        self.session_name = session_name
        self.checkpoint_dir = os.path.join(checkpoint_dir, session_name)
        os.makedirs(self.checkpoint_dir, exist_ok=True)
        self._manifest_file = os.path.join(self.checkpoint_dir, "manifest.jsonl")

    def capture(
        self,
        messages: list[dict],
        trigger: str = "compact",
        reason: str = "",
        max_recent: int = 10,
    ) -> Optional[str]:
        """
        Capture a v2 smart checkpoint.

        Args:
            messages: List of {"role": "user"|"assistant", "content": str, "timestamp"?: str}
            trigger: What triggered this checkpoint (compact, restart, manual, etc.)
            reason: Human-readable reason
            max_recent: Number of recent messages to include verbatim

        Returns:
            Path to checkpoint file, or None on failure.
        """
        if not messages:
            return None

        # Extract semantic context from full history
        extracted = self._extract_intelligent(messages)

        # Build checkpoint content
        recent = messages[-max_recent:]
        lines = self._build_header(trigger, reason, len(messages))

        # User instructions section
        if extracted.user_instructions:
            lines.append("## User Instructions")
            lines.append("")
            for inst in extracted.user_instructions[:10]:
                lines.append(f"- {inst}")
            lines.append("")

        # Decisions
        if extracted.decisions:
            lines.append("## Key Decisions")
            lines.append("")
            for dec in extracted.decisions[:10]:
                lines.append(f"- {dec}")
            lines.append("")

        # Errors
        if extracted.errors:
            lines.append("## Errors Encountered")
            lines.append("")
            for err in extracted.errors[:5]:
                lines.append(f"```\n{err}\n```")
                lines.append("")

        # File changes
        if extracted.file_changes:
            lines.append("## File Changes")
            lines.append("")
            for fc in extracted.file_changes[:10]:
                lines.append(f"- {fc}")
            lines.append("")

        # Recent messages (verbatim, truncated)
        lines.append("## Recent Messages")
        lines.append("")
        for msg in recent:
            role = "User" if msg.get("role") == "user" else "Assistant"
            ts = msg.get("timestamp", "")
            ts_str = f" ({ts})" if ts else ""
            lines.append(f"### {role}{ts_str}")
            lines.append("")
            content = msg.get("content", "")
            if len(content) > 1500:
                content = content[:1500] + "\n\n[...truncated]"
            lines.append(content)
            lines.append("")

        # Compute digest for dedup
        digest = self._semantic_digest(messages, trigger)

        # Check if identical to last checkpoint
        last = self._read_last_manifest()
        if last and last.get("digest") == digest and last.get("trigger") == trigger:
            return last.get("file")

        # Write checkpoint file
        timestamp = time.strftime("%Y%m%dT%H%M%S")
        filename = f"{timestamp}-{trigger}.md"
        filepath = os.path.join(self.checkpoint_dir, filename)

        try:
            with open(filepath, "w") as f:
                f.write("\n".join(lines))
        except Exception as e:
            log.error(f"Failed to write checkpoint: {e}")
            return None

        # Append to manifest
        self._append_manifest({
            "file": filepath,
            "filename": filename,
            "trigger": trigger,
            "reason": reason,
            "digest": digest,
            "message_count": len(messages),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

        log.info(f"Checkpoint captured: {filepath} ({trigger}, {len(messages)} msgs)")
        return filepath

    def restore(self) -> Optional[str]:
        """
        Restore the best available checkpoint.

        Returns checkpoint content as string, or None.
        """
        if not os.path.exists(self._manifest_file):
            return None

        try:
            entries = []
            with open(self._manifest_file) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entries.append(json.loads(line))

            if not entries:
                return None

            # Priority: milestone > compact > restart > others
            trigger_priority = {
                "milestone": 1000,
                "compact": 400,
                "restart": 350,
                "session-end": 300,
                "manual": 200,
            }

            entries.sort(key=lambda e: (
                trigger_priority.get(e.get("trigger", ""), 100),
                e.get("created_at", ""),
            ), reverse=True)

            for entry in entries:
                fp = entry.get("file", "")
                if os.path.exists(fp):
                    return Path(fp).read_text()

            return None
        except Exception as e:
            log.error(f"Failed to restore checkpoint: {e}")
            return None

    def cleanup(self, max_age_days: int = 7):
        """Remove old checkpoint files."""
        cutoff = time.time() - (max_age_days * 86400)
        try:
            for f in Path(self.checkpoint_dir).glob("*.md"):
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    log.info(f"Cleaned up old checkpoint: {f}")
        except Exception as e:
            log.debug(f"Cleanup error: {e}")

    # -- Internal --

    def _extract_intelligent(self, messages: list[dict]) -> ExtractedContext:
        """Extract semantic context from conversation (from smart-compact.ts v2)."""
        ctx = ExtractedContext()

        for msg in messages:
            content = msg.get("content", "")
            if not content:
                continue

            sample = content[:3000]
            role = msg.get("role", "")

            if role == "assistant":
                # Extract decisions
                if _matches_any(sample, DECISION_PATTERNS):
                    for line in sample.split("\n"):
                        if _matches_any(line, DECISION_PATTERNS) and 10 < len(line) < 500:
                            ctx.decisions.append(line.strip())
                            break

                # Extract errors
                if _matches_any(sample, ERROR_PATTERNS):
                    error_lines = []
                    for line in sample.split("\n"):
                        if _matches_any(line, ERROR_PATTERNS) and len(line) < 300:
                            error_lines.append(line.strip())
                            if len(error_lines) >= 3:
                                break
                    if error_lines:
                        ctx.errors.append("\n".join(error_lines))

                # Extract file changes
                if _matches_any(sample, FILE_CHANGE_PATTERNS):
                    for line in sample.split("\n"):
                        if _matches_any(line, FILE_CHANGE_PATTERNS) and 10 < len(line) < 300:
                            ctx.file_changes.append(line.strip())
                            break

            if role == "user" and _matches_any(sample, INSTRUCTION_PATTERNS):
                for line in sample.split("\n"):
                    if _matches_any(line, INSTRUCTION_PATTERNS) and 10 < len(line) < 500:
                        ctx.user_instructions.append(line.strip())
                        break

        # Deduplicate
        ctx.decisions = list(dict.fromkeys(ctx.decisions))[:10]
        ctx.errors = list(dict.fromkeys(ctx.errors))[:5]
        ctx.file_changes = list(dict.fromkeys(ctx.file_changes))[:10]
        ctx.user_instructions = list(dict.fromkeys(ctx.user_instructions))[:10]

        return ctx

    def _build_header(self, trigger: str, reason: str, msg_count: int) -> list[str]:
        """Build checkpoint header lines."""
        lines = [
            "# Session Checkpoint (v2)",
            f"> Captured at {time.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            f"> Session: {self.session_name}",
            f"> Trigger: {trigger}",
        ]
        if reason:
            lines.append(f"> Reason: {reason}")
        lines.append(f"> Messages preserved: {msg_count}")
        lines.append("")
        return lines

    def _semantic_digest(self, messages: list[dict], trigger: str) -> str:
        """Compute stable fingerprint for dedup (from smart-compact.ts)."""
        recent = messages[-10:]
        parts = [self.session_name, trigger]
        for msg in recent:
            parts.append(msg.get("role", ""))
            parts.append(msg.get("content", "")[:600])
        payload = "|".join(parts)
        return hashlib.sha256(payload.encode()).hexdigest()

    def _read_last_manifest(self) -> Optional[dict]:
        """Read last entry from manifest."""
        if not os.path.exists(self._manifest_file):
            return None
        try:
            lines = Path(self._manifest_file).read_text().strip().split("\n")
            if lines:
                return json.loads(lines[-1])
        except Exception:
            pass
        return None

    def _append_manifest(self, entry: dict):
        """Append entry to manifest file."""
        try:
            with open(self._manifest_file, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            log.error(f"Failed to append manifest: {e}")


# ---------------------------------------------------------------------------
# Convenience: format findings for Telegram
# ---------------------------------------------------------------------------

SEVERITY_ICONS = {
    "critical": "\u26a0\ufe0f",  # warning sign
    "high": "\u2757",            # exclamation mark
    "medium": "\u2139\ufe0f",    # info
    "low": "\u25aa\ufe0f",       # small square
}


def format_findings_html(findings: list[WasteFinding], stats: dict) -> str:
    """Format waste findings as HTML for Telegram."""
    if not findings:
        return ""

    lines = ["<b>Token Optimizer Report</b>", ""]

    # Stats summary
    lines.append(
        f"Messages: {stats.get('messages', 0)} | "
        f"Empty: {stats.get('empty_pct', 0)}% | "
        f"Uptime: {stats.get('uptime_hours', 0)}h"
    )
    lines.append("")

    for f in findings:
        icon = SEVERITY_ICONS.get(f.severity, "")
        lines.append(f"{icon} <b>[{f.severity.upper()}]</b> {f.waste_type}")
        lines.append(f"  {f.description}")
        lines.append(f"  <i>{f.recommendation}</i>")
        lines.append("")

    return "\n".join(lines)
