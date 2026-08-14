"""
CLI to drive the CaptchaArena benchmark with a screenshot-based Computer-Use agent.

Unlike the browser-use CLI, this agent sends raw screenshots to vision-capable
LLMs (Anthropic / OpenAI / Google) and executes the returned mouse/keyboard
actions on a Playwright browser – no browser-use abstraction layer needed.

Usage:
    python -m agent_frameworks.computeruse_cli --url http://127.0.0.1:7860 --provider anthropic --limit 3
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import re
import textwrap
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Screen dimensions used for the computer-use tools
# ---------------------------------------------------------------------------
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 1080


class TrajectoryRecorder:
    """Write step-level agent interactions to a JSONL file."""

    def __init__(self, run_id: str, trajectory_file: str, image_dir: Optional[str]) -> None:
        self.run_id = run_id
        self.trajectory_path = Path(trajectory_file).expanduser()
        self.trajectory_path.parent.mkdir(parents=True, exist_ok=True)

        self.image_dir: Optional[Path] = None
        if image_dir:
            self.image_dir = Path(image_dir).expanduser()
            self.image_dir.mkdir(parents=True, exist_ok=True)

        self.event_index = 0
        self._current_puzzle_key: Optional[str] = None
        self._puzzle_counter = 0

    def _get_puzzle_key(self, page_state: Optional[dict[str, Any]]) -> Optional[str]:
        """Extract a puzzle folder name from page_state."""
        if not page_state:
            return self._current_puzzle_key
        puzzle = page_state.get("puzzle")
        if puzzle and puzzle.get("puzzle_type"):
            ptype = puzzle["puzzle_type"]
            pid = puzzle.get("puzzle_id", "unknown")
            # Sanitize filename
            pid_clean = str(pid).replace("/", "_").replace(" ", "_")[:60]
            return f"{ptype}__{pid_clean}"
        return self._current_puzzle_key

    def _save_image(self, screenshot_b64: str, step: int | None, action: str | None,
                    puzzle_key: Optional[str] = None) -> Optional[str]:
        if not self.image_dir:
            return None

        # Use per-puzzle subdirectory
        if puzzle_key:
            save_dir = self.image_dir / puzzle_key
        else:
            save_dir = self.image_dir
        save_dir.mkdir(parents=True, exist_ok=True)

        step_part = f"{step:03d}" if isinstance(step, int) else "na"
        action_part = (action or "snapshot").replace(" ", "_")
        image_name = f"{self.event_index:06d}_s{step_part}_{action_part}.png"
        image_path = save_dir / image_name
        image_path.write_bytes(base64.b64decode(screenshot_b64))
        return str(image_path)

    def log_event(
        self,
        event_type: str,
        provider: str,
        step: Optional[int] = None,
        action: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
        result: Optional[str] = None,
        page_state: Optional[dict[str, Any]] = None,
        note: Optional[str] = None,
        screenshot_b64: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        # Track current puzzle for per-puzzle folders
        new_key = self._get_puzzle_key(page_state)
        if new_key and new_key != self._current_puzzle_key:
            self._puzzle_counter += 1
            self._current_puzzle_key = new_key
            logger.info("Puzzle switched to: %s (#%d)", new_key, self._puzzle_counter)

        # Prefix folder with counter for ordering
        folder_key = None
        if self._current_puzzle_key:
            folder_key = f"{self._puzzle_counter:03d}_{self._current_puzzle_key}"

        screenshot_path = None
        if screenshot_b64:
            screenshot_path = self._save_image(screenshot_b64, step, action, puzzle_key=folder_key)

        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "event_index": self.event_index,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "provider": provider,
            "step": step,
            "action": action,
            "params": params or {},
            "result": result,
            "page_state": page_state or {},
            "note": note,
            "screenshot_path": screenshot_path,
            "metadata": metadata or {},
        }

        with self.trajectory_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        self.event_index += 1


def _build_run_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{ts}-{uuid.uuid4().hex[:8]}"


def _create_trajectory_recorder(args: argparse.Namespace) -> Optional[TrajectoryRecorder]:
    if args.disable_trajectory:
        return None

    run_id = _build_run_id()
    trajectory_file = args.trajectory_file or f"runs/trajectories/{run_id}.jsonl"

    image_dir = None
    if not args.no_trajectory_images:
        image_dir = args.trajectory_image_dir or f"runs/trajectories/{run_id}_images"

    recorder = TrajectoryRecorder(run_id=run_id, trajectory_file=trajectory_file, image_dir=image_dir)
    logger.info("Trajectory logging enabled: %s", recorder.trajectory_path)
    if recorder.image_dir:
        logger.info("Trajectory screenshots directory: %s", recorder.image_dir)
    return recorder


async def _extract_page_state(page) -> dict[str, Any]:
    """Best-effort extraction of current puzzle state from the page."""
    script = """
    () => {
        const pickText = (selectors) => {
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent) {
                    const value = el.textContent.trim();
                    if (value) {
                        return value;
                    }
                }
            }
            return null;
        };

        let puzzle = null;
        try {
            if (typeof currentPuzzle !== "undefined" && currentPuzzle) {
                puzzle = {
                    puzzle_type: currentPuzzle.puzzle_type ?? null,
                    puzzle_id: currentPuzzle.puzzle_id ?? null,
                    input_type: currentPuzzle.input_type ?? null
                };
            }
        } catch (error) {
            puzzle = null;
        }

        if (!puzzle) {
            try {
                if (globalThis.currentPuzzle) {
                    puzzle = {
                        puzzle_type: globalThis.currentPuzzle.puzzle_type ?? null,
                        puzzle_id: globalThis.currentPuzzle.puzzle_id ?? null,
                        input_type: globalThis.currentPuzzle.input_type ?? null
                    };
                }
            } catch (error) {
                puzzle = null;
            }
        }

        // Detect feedback class (correct / incorrect)
        let feedbackClass = null;
        const fbEl = document.querySelector("#result-message, .result-message");
        if (fbEl) {
            feedbackClass = fbEl.className || null;
        }

        // Read scoreboard stats
        const totalEl = document.querySelector("#total-count");
        const correctEl = document.querySelector("#correct-count");
        const accuracyEl = document.querySelector("#accuracy");

        return {
            url: window.location.href,
            title: document.title,
            prompt: pickText(["#puzzle-prompt", ".puzzle-prompt", "#prompt", ".instruction", ".captcha-prompt"]),
            feedback: pickText(["#result-message", ".result-message", ".feedback", ".message"]),
            feedback_class: feedbackClass,
            stats: {
                total: totalEl ? parseInt(totalEl.textContent, 10) || 0 : 0,
                correct: correctEl ? parseInt(correctEl.textContent, 10) || 0 : 0,
                accuracy: accuracyEl ? accuracyEl.textContent.trim() : "0%",
            },
            debug_info: pickText(["#debug-info", ".debug-info"]),
            puzzle
        };
    }
    """

    try:
        state = await page.evaluate(script)
        if isinstance(state, dict):
            return state
    except Exception:  # pragma: no cover - best effort only
        pass

    return {"url": page.url}


def _detect_submit_result(page_state: dict[str, Any]) -> tuple[bool, bool]:
    """Check if submit was clicked and whether the answer was correct.

    Returns (submitted: bool, correct: bool).
    - submitted=False means the agent never clicked submit → failure.
    - correct is meaningful only when submitted=True.
    """
    feedback = (page_state.get("feedback") or "").strip().lower()
    feedback_class = (page_state.get("feedback_class") or "").lower()

    if not feedback:
        return False, False

    # The page sets class "result-message correct" or "result-message incorrect"
    if "correct" in feedback_class and "incorrect" not in feedback_class:
        return True, True
    if "incorrect" in feedback_class:
        return True, False

    # Fallback: check feedback text
    if "correct" in feedback and "incorrect" not in feedback:
        return True, True
    if "incorrect" in feedback:
        return True, False

    # There is some feedback text but we can't determine correctness
    return True, False


def _build_puzzle_summary(
    puzzle_type: str,
    puzzle_id: str,
    puzzle_prompt: str,
    submitted: bool,
    correct: bool,
    metafile_steps: list[dict[str, Any]],
    status: str,
) -> dict[str, Any]:
    """Build a summary.json dict for one puzzle."""
    transitions = []
    for i, step in enumerate(metafile_steps):
        entry: dict[str, Any] = {"step": i, "action": step.get("action", "")}
        if step.get("screenshot_path"):
            entry["image"] = step["screenshot_path"]
        if step.get("reasoning"):
            entry["reasoning"] = step["reasoning"]
        if step.get("result"):
            entry["result"] = step["result"]
        transitions.append(entry)

    return {
        "puzzle_type": puzzle_type,
        "puzzle_id": puzzle_id,
        "prompt": puzzle_prompt,
        "submitted": submitted,
        "correct": correct,
        "reward": 1.0 if (submitted and correct) else 0.0,
        "status": status,
        "total_steps": len(metafile_steps),
        "transitions": transitions,
    }


# ---------------------------------------------------------------------------
# Custom tool schemas (for OpenAI / Google function-calling)
# ---------------------------------------------------------------------------

CUSTOM_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "screenshot",
            "description": "Capture the current 1280x1080 browser viewport as an image so you can see the puzzle and the result of your last action.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "click",
            "description": "Click at the given (x, y) pixel coordinate on the page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer",
                        "description": "Horizontal pixel coordinate."
                    },
                    "y": {
                        "type": "integer",
                        "description": "Vertical pixel coordinate."
                    },
                    "button": {
                        "type": "string",
                        "enum": [
                            "left",
                            "right",
                            "middle"
                        ],
                        "description": "Mouse button. Defaults to left."
                    }
                },
                "required": [
                    "x",
                    "y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "Type the given text string at the current cursor position.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string"
                    }
                },
                "required": [
                    "text"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "press_key",
            "description": "Press a keyboard key (e.g. Enter, Tab, Escape, Backspace).",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string"
                    }
                },
                "required": [
                    "key"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "drag",
            "description": "Press the mouse at (start_x, start_y), move to (end_x, end_y), and release — use to move a slider handle or drag a puzzle piece into place.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_x": {
                        "type": "integer"
                    },
                    "start_y": {
                        "type": "integer"
                    },
                    "end_x": {
                        "type": "integer"
                    },
                    "end_y": {
                        "type": "integer"
                    }
                },
                "required": [
                    "start_x",
                    "start_y",
                    "end_x",
                    "end_y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_down",
            "description": "Press and hold a mouse button at (x, y) without releasing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer"
                    },
                    "y": {
                        "type": "integer"
                    },
                    "button": {
                        "type": "string",
                        "enum": [
                            "left",
                            "right",
                            "middle"
                        ]
                    }
                },
                "required": [
                    "x",
                    "y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_up",
            "description": "Release a held mouse button at (x, y).",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer"
                    },
                    "y": {
                        "type": "integer"
                    },
                    "button": {
                        "type": "string",
                        "enum": [
                            "left",
                            "right",
                            "middle"
                        ]
                    }
                },
                "required": [
                    "x",
                    "y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_move",
            "description": "Move the mouse cursor to (x, y) without clicking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer"
                    },
                    "y": {
                        "type": "integer"
                    }
                },
                "required": [
                    "x",
                    "y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "hold",
            "description": "Press and hold the mouse button at (x, y) for duration_ms ms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer"
                    },
                    "y": {
                        "type": "integer"
                    },
                    "button": {
                        "type": "string",
                        "enum": [
                            "left",
                            "right",
                            "middle"
                        ]
                    },
                    "duration_ms": {
                        "type": "integer"
                    }
                },
                "required": [
                    "x",
                    "y"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "done",
            "description": "Finish the puzzle. Call only after you have submitted your answer (if the puzzle needs a submit click) and seen the correct/incorrect feedback on the page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string"
                    }
                },
                "required": [
                    "summary"
                ]
            }
        }
    }
]

# 5-tool no-done set — byte-identical to the tools embedded in the (no-done) SFT data.
# Used ONLY for the per-puzzle openai eval so train == eval; CUSTOM_TOOLS (with done /
# press_key / mouse_*) stays for the frontier-baseline / batch / google paths.
SFT_EVAL_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "screenshot",
            "description": "Capture the current 1280x1080 browser viewport as an image so you can see the puzzle and the result of your last action.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "click",
            "description": "Click at the given (x, y) pixel coordinate — used to select a tile, an option, or a point on the page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "Horizontal pixel coordinate."},
                    "y": {"type": "integer", "description": "Vertical pixel coordinate."},
                    "button": {"type": "string", "enum": ["left", "right", "middle"],
                               "description": "Mouse button. Defaults to left; for these puzzles always use left."},
                },
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "Type the given text string at the current cursor position.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "The text to type."}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drag",
            "description": "Press the mouse at (start_x, start_y), move to (end_x, end_y), and release — drag the slider handle on the bar below the image horizontally until the puzzle piece lines up with its empty slot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_x": {"type": "integer", "description": "Start horizontal pixel (on the slider handle)."},
                    "start_y": {"type": "integer", "description": "Start vertical pixel (on the slider handle)."},
                    "end_x": {"type": "integer", "description": "Target horizontal pixel."},
                    "end_y": {"type": "integer", "description": "Target vertical pixel."},
                },
                "required": ["start_x", "start_y", "end_x", "end_y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "hold",
            "description": "Press and hold the mouse button at (x, y) for a fixed 10 seconds — for puzzles that require a sustained hold.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "Horizontal pixel coordinate."},
                    "y": {"type": "integer", "description": "Vertical pixel coordinate."},
                    "button": {"type": "string", "enum": ["left", "right", "middle"],
                               "description": "Mouse button. Defaults to left; for these puzzles always use left."},
                },
                "required": ["x", "y"],
            },
        },
    },
]

# Google Gemini uses a slightly different tool schema format
GEMINI_TOOL_DECLARATIONS: list[dict[str, Any]] = [
    t["function"] for t in CUSTOM_TOOLS
]


# ---------------------------------------------------------------------------
# Prompt
#
# NOTE: these strings are part of the train/serve contract, not just labels. A model
# fine-tuned against one wording and served with another degrades silently rather than
# failing, so if you retrain, keep the trained prompt and this one byte-identical.
# ---------------------------------------------------------------------------

def _build_system_prompt(url: str, limit: int, width: int, height: int) -> str:
    """System prompt shared across all providers."""
    return textwrap.dedent(f"""\
        You are a Computer-Use agent evaluating CAPTCHA puzzles on the CaptchaArena benchmark.

        The browser is open at {url} with a viewport of {width}x{height} pixels.
        You can see the page via screenshots and interact by clicking, typing, scrolling, or dragging.

        Your task:
        1. Take a screenshot to see the current puzzle.
        2. Read the puzzle instruction at the bottom of the page (e.g., "Select the animal with the wrong head").
        3. Analyze the puzzle carefully and perform the required action (click the correct image, type text, drag, etc.).
        4. IMPORTANT: You MUST click the submit button after selecting your answer. The button may be labeled "Submit", "Verify", "Swap and Submit", or "Check Position" depending on the puzzle type. Do NOT skip this step.
        5. After clicking Submit, take a screenshot to check the feedback message (correct/incorrect).
        6. A new puzzle will appear automatically. Continue solving the next puzzle.
        7. Repeat until you have attempted {limit} puzzle(s). Count a puzzle as "attempted" ONLY after you click Submit and see the feedback.
        8. After attempting {limit} puzzle(s), call the "done" tool with a summary.

        CRITICAL RULES:
        - You MUST click "Submit" for each puzzle. An attempt only counts after Submit is clicked.
        - Do NOT call "done" until you have clicked Submit at least {limit} time(s).
        - After every action, take a screenshot to observe the result before deciding the next step.
        - Be precise with click coordinates. Click on the exact center of buttons or elements.
        - The page shows "Total", "Correct", and "Accuracy" at the top — use these to track your progress.
        - `scroll` is a LOOK tool only — use it to bring offscreen Submit buttons or instructions into
          view. NEVER use scroll to interact with the puzzle (sliders / drags / rotations / clicks
          stay on `drag` / `mouse_*` / `click`). One-liner: scroll is for looking, not for playing.
        - After clicking Submit, the feedback appears and a new puzzle loads automatically. Just take a screenshot to see the new puzzle.
        - If you find yourself repeating the same action, stop and try a different approach.
        - If the page has popups or overlays, dismiss them first.
    """).strip()


def _build_single_puzzle_system_prompt(url: str, width: int, height: int) -> str:
    """System prompt for per-puzzle mode: solve exactly ONE puzzle then call done."""
    return textwrap.dedent(f"""\
        You are a Computer-Use agent solving ONE CAPTCHA puzzle on the CaptchaArena benchmark.

        The browser is open at {url} with a viewport of {width}x{height} pixels.
        You can see the page via screenshots and interact by clicking, typing, scrolling, or dragging.

        Your task:
        1. Take a screenshot to see the puzzle.
        2. Read the puzzle instruction at the bottom of the page.
        3. Analyze the puzzle carefully and perform the required action (click, type, drag, etc.).
        4. IMPORTANT: You MUST click the submit button after selecting your answer. The button may be labeled "Submit", "Verify", "Swap and Submit", or "Check Position" depending on the puzzle type.
        5. After clicking Submit, take a screenshot to check the feedback message (correct/incorrect).
        6. Once you see the feedback, call the "done" tool with a brief summary of what you did and whether it was correct.

        CRITICAL RULES:
        - There is only ONE puzzle on this page. Solve it and call "done".
        - You MUST click "Submit" before calling "done".
        - After every action, take a screenshot to observe the result before deciding the next step.
        - Be precise with click coordinates. Click on the exact center of buttons or elements.
        - `scroll` is a LOOK tool only — use it to bring offscreen Submit buttons or instructions into
          view. NEVER use scroll to interact with the puzzle (sliders / drags / rotations / clicks
          stay on `drag` / `mouse_*` / `click`). One-liner: scroll is for looking, not for playing.
        - If you find yourself repeating the same action, stop and try a different approach.
        - If the page has popups or overlays, dismiss them first.
    """).strip()


def _build_single_puzzle_system_prompt_sft(url: str, width: int, height: int) -> str:
    """Per-puzzle eval prompt for the no-done SFT models — byte-identical to the system
    embedded in the (no-done) SFT data: exactly 5 tools, the episode ends at the submit
    action, there is no `done`. Pair with SFT_EVAL_TOOLS so train == eval."""
    return (
        "You are a Computer-Use agent solving exactly one CAPTCHA puzzle on the CaptchaArena benchmark.\n"
        "\n"
        f"The page is already open at {url} \n"
        f"in a browser with a fixed {width}x{height} pixel viewport. You perceive the page only through screenshots "
        "and act on it with the mouse and keyboard tools provided. All coordinates are absolute pixels in that "
        "viewport, with the origin (0, 0) at the top-left corner.\n"
        "\n"
        "\n"
        "Tools available to you (these are the only ones):\n"
        "- screenshot — capture the current page state. Use it to read the instruction and to confirm effects.\n"
        "- click — select a tile, an option, or a point.\n"
        "- drag — move the handle on the bar below the image from its start point to the target point, dragging horizontally.\n"
        "- type_text — enter text into the focused field.\n"
        "- hold — press and keep a button pressed when the puzzle requires a sustained hold.\n"
        "\n"
        "\n"
        "Workflow:\n"
        "1. Call screenshot to see the current state, and read the instruction text shown on the page.\n"
        "2. Perform one action with a single tool call (one of the tools above) toward solving the puzzle.\n"
        "3. Call screenshot to confirm the effect of that action before deciding the next one.\n"
        "4. Repeat steps 2-3 until you have fully entered the answer the instruction asks for.\n"
        "5. Submit: if a visible Submit or Verify button exists, click it; some puzzles accept the answer "
        "automatically.\n"
        "\n"
        "Rules:\n"
        "- There is exactly one puzzle on the page. Solve it, then stop.\n"
        "- Be precise: click the center of the target element. For a drag, you don't have to land it in one move "
        "— drag, take a screenshot to check, then make small additional drags to fine-tune until the piece "
        "sits exactly in its slot.\n"
        "- Calling the same tool many times is fine when the puzzle calls for it — for example clicking several "
        "different tiles, or making many separate clicks across the task. Repeat as needed.\n"
        "- But re-clicking the exact same point (e.g., 3 times on the same spot) is a warning sign that the click "
        "isn't registering. If an action produced no visible change, don't resend the identical call — re-read "
        "the instruction and try a different point, target, or tool."
    )


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _configure_logging(verbose: bool) -> None:
    """Set a minimal logging format for the CLI."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format='[%(levelname)s] %(message)s')


# ---------------------------------------------------------------------------
# Playwright helpers
# ---------------------------------------------------------------------------

async def _launch_browser(url: str, headless: bool, width: int, height: int):
    """Launch a Playwright Chromium browser and navigate to the given URL.

    Returns (browser, page).
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise ImportError(
            'Playwright is required. Install it with `pip install playwright && playwright install chromium`.'
        ) from exc

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=headless)
    context = await browser.new_context(viewport={'width': width, 'height': height})
    page = await context.new_page()
    await page.goto(url, wait_until='domcontentloaded')
    await page.wait_for_timeout(2000)  # give the page time to render
    logger.info('Browser launched and navigated to %s', url)
    return pw, browser, page


async def _capture_screenshot(page) -> str:
    """Take a screenshot and return it as a base64-encoded PNG string."""
    png_bytes = await page.screenshot(type='png')
    return base64.b64encode(png_bytes).decode('utf-8')


async def _handle_action(page, action: str, params: dict[str, Any]) -> str:
    """Execute a single action on the Playwright page. Returns a status string."""
    # Qwen3-VL quirk: sometimes emits click coords as x=[x,y] (with or without
    # a separate y field). Always flatten x to a scalar; only fill y from x[1]
    # if y is missing.
    for xk, yk in (('x', 'y'), ('start_x', 'start_y'), ('end_x', 'end_y')):
        v = params.get(xk)
        if isinstance(v, (list, tuple)) and len(v) >= 1:
            params[xk] = v[0]
            if yk not in params and len(v) >= 2:
                params[yk] = v[1]
    # Coerce coordinate params to numbers (model may return strings)
    for k in ('x', 'y', 'start_x', 'start_y', 'end_x', 'end_y', 'amount'):
        if k in params:
            try:
                params[k] = int(float(params[k]))
            except (ValueError, TypeError):
                pass

    if action == 'screenshot':
        return 'screenshot_taken'

    if action == 'click':
        x, y = params['x'], params['y']
        button = params.get('button', 'left')
        await page.mouse.click(x, y, button=button)
        await page.wait_for_timeout(500)
        return f'clicked ({x}, {y}) button={button}'

    if action == 'type_text':
        text = params['text']
        await page.keyboard.type(text, delay=50)
        await page.wait_for_timeout(300)
        return f'typed "{text}"'

    if action == 'press_key':
        key = params['key']
        await page.keyboard.press(key)
        await page.wait_for_timeout(300)
        return f'pressed key "{key}"'

    if action == 'drag':
        sx, sy = params['start_x'], params['start_y']
        ex, ey = params['end_x'], params['end_y']
        await page.mouse.move(sx, sy)
        await page.mouse.down()
        # Move in small steps for smoother drag
        steps = 10
        for i in range(1, steps + 1):
            ix = sx + (ex - sx) * i // steps
            iy = sy + (ey - sy) * i // steps
            await page.mouse.move(ix, iy)
            await page.wait_for_timeout(30)
        await page.mouse.up()
        await page.wait_for_timeout(500)
        return f'dragged ({sx},{sy}) -> ({ex},{ey})'

    if action == 'mouse_down':
        x, y = params['x'], params['y']
        button = params.get('button', 'left')
        await page.mouse.move(x, y)
        await page.mouse.down(button=button)
        await page.wait_for_timeout(100)
        return f'mouse_down ({x}, {y}) button={button}'

    if action == 'mouse_up':
        x, y = params['x'], params['y']
        button = params.get('button', 'left')
        await page.mouse.move(x, y)
        await page.mouse.up(button=button)
        await page.wait_for_timeout(300)
        return f'mouse_up ({x}, {y}) button={button}'

    if action == 'mouse_move':
        x, y = params['x'], params['y']
        await page.mouse.move(x, y)
        await page.wait_for_timeout(50)
        return f'mouse_moved ({x}, {y})'

    if action == 'hold':
        if 'x' not in params or 'y' not in params:
            return 'hold error: x and y are required'
        x, y = params['x'], params['y']
        btn = params.get('button', 'left')
        duration = int(params.get('duration_ms', 10000))
        # Clamp: a degenerate model can emit an absurd duration (seen 9e7ms=25h),
        # which blocks the whole rollout in page.wait_for_timeout. Hold-type
        # captchas are all sub-10s, so 60s is a safe ceiling that never truncates
        # a legitimate hold.
        duration = max(0, min(duration, 60000))
        await page.mouse.move(x, y)
        await page.mouse.down(button=btn)
        await page.wait_for_timeout(duration)
        await page.mouse.up(button=btn)
        return f'held mouse {btn} at ({x}, {y}) for {duration}ms'

    if action == 'scroll':
        # `scroll` is a "look" tool only — used to bring offscreen captcha
        # content (Submit buttons on tall puzzles, etc.) into view. Puzzle
        # interaction itself never uses scroll; sliders/drags/clicks use the
        # mouse_* tools at viewport coords. The step size is fixed at 500 px
        # so the agent only needs to learn the direction.
        SCROLL_STEP = 500
        direction = str(params.get('direction', 'down')).lower()
        dx, dy = 0, 0
        if direction == 'down':
            dy = SCROLL_STEP
        elif direction == 'up':
            dy = -SCROLL_STEP
        elif direction == 'right':
            dx = SCROLL_STEP
        elif direction == 'left':
            dx = -SCROLL_STEP
        else:
            return f'scroll error: unknown direction "{direction}"'
        await page.evaluate(
            "(d) => window.scrollBy({left: d.x, top: d.y, behavior: 'instant'})",
            {"x": dx, "y": dy},
        )
        await page.wait_for_timeout(250)
        return f'scrolled {direction} by {SCROLL_STEP}px'

    if action == 'done':
        return 'agent_done'

    return f'unknown action: {action}'


# ---------------------------------------------------------------------------
# Anthropic Computer Use loop
# ---------------------------------------------------------------------------

async def _run_anthropic_loop(
    page, model: str, system_prompt: str, max_steps: int,
    width: int, height: int,
    recorder: Optional[TrajectoryRecorder] = None,
) -> str:
    """Agent loop using Anthropic's native computer-use beta."""
    try:
        import anthropic
    except ImportError as exc:
        raise ImportError(
            'The anthropic SDK is required. Install it with `pip install anthropic`.'
        ) from exc

    client = anthropic.Anthropic()

    tools = [
        {
            "type": "computer_20250124",
            "name": "computer",
            "display_width_px": width,
            "display_height_px": height,
        },
    ]

    # Start by asking the model to begin the task
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": system_prompt},
    ]

    for step in range(max_steps):
        logger.info('[anthropic] Step %d / %d', step + 1, max_steps)

        response = client.beta.messages.create(
            model=model,
            max_tokens=4096,
            tools=tools,
            messages=messages,
            betas=["computer-use-2025-01-24"],
        )

        # Add assistant response to conversation
        response_content = response.content
        messages.append({"role": "assistant", "content": response_content})

        # Check if Claude used any tools
        tool_results: list[dict[str, Any]] = []
        for block in response_content:
            if block.type == "tool_use":
                action = block.input.get("action", "screenshot")
                logger.debug('[anthropic] tool_use: %s %s', action, block.input)

                if action == "screenshot":
                    screenshot_b64 = await _capture_screenshot(page)
                    if recorder:
                        recorder.log_event(
                            event_type="tool_call",
                            provider="anthropic",
                            step=step + 1,
                            action="screenshot",
                            params=dict(block.input),
                            result="screenshot_taken",
                            page_state=await _extract_page_state(page),
                            screenshot_b64=screenshot_b64,
                        )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": screenshot_b64,
                                },
                            }
                        ],
                    })
                else:
                    # Map Anthropic native actions to our handler
                    params = dict(block.input)
                    params.pop("action", None)
                    # Anthropic uses "coordinate" for click location
                    if "coordinate" in params:
                        coord = params.pop("coordinate")
                        params["x"] = coord[0]
                        params["y"] = coord[1]
                    if action == "type":
                        params.setdefault("text", params.pop("text", ""))
                        action = "type_text"
                    if action == "key":
                        params.setdefault("key", params.pop("text", ""))
                        action = "press_key"
                    if action in ("left_click", "right_click", "middle_click"):
                        params["button"] = action.replace("_click", "")
                        action = "click"
                    if action == "scroll":
                        # Anthropic native scroll uses {coordinate, scroll_direction, scroll_amount};
                        # our scroll has a fixed 500 px step, so we keep only the direction.
                        params["direction"] = params.pop("scroll_direction", "down")
                        params.pop("scroll_amount", None)
                        params.pop("coordinate", None)

                    result_str = await _handle_action(page, action, params)
                    logger.info('[anthropic] Action result: %s', result_str)

                    # After action, return a screenshot so Claude can see the result
                    screenshot_b64 = await _capture_screenshot(page)
                    if recorder:
                        recorder.log_event(
                            event_type="tool_call",
                            provider="anthropic",
                            step=step + 1,
                            action=action,
                            params=params,
                            result=result_str,
                            page_state=await _extract_page_state(page),
                            screenshot_b64=screenshot_b64,
                        )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": [
                            {"type": "text", "text": result_str},
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": screenshot_b64,
                                },
                            },
                        ],
                    })

        if not tool_results:
            # Claude is done – extract final text
            final_parts = [b.text for b in response_content if hasattr(b, 'text')]
            return '\n'.join(final_parts) if final_parts else 'Agent finished without summary.'

        messages.append({"role": "user", "content": tool_results})

    return 'Reached maximum steps without agent signalling completion.'


# ---------------------------------------------------------------------------
# OpenAI vision + function-calling loop
# ---------------------------------------------------------------------------

def _save_sft_data(
    puzzle_dir: Path,
    system_prompt: str,
    sft_turns: list[dict[str, Any]],
    puzzle_type: str,
    puzzle_id: str,
    puzzle_prompt: str,
    submitted: bool,
    correct: bool,
) -> None:
    """Save SFT training data as a multi-turn conversation (system/user/assistant).

    Format compatible with Qwen-VL / LLaVA style SFT:
    {
      "id": "Bingo_bingo13",
      "conversations": [
        {"role": "system", "content": "..."},
        {"role": "user",   "content": [{"type": "image", "image": "screenshots/screenshot_step_0.png"}, {"type": "text", "text": "..."}]},
        {"role": "assistant", "content": "<think>I see a 3x3 grid...</think>\nclick({\"x\": 633, \"y\": 710})"},
        {"role": "user",   "content": [{"type": "image", "image": "screenshots/screenshot_step_1.png"}, {"type": "text", "text": "Action executed..."}]},
        ...
      ],
      "reward": 1.0
    }
    """
    conversations: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
    ]

    for turn in sft_turns:
        if turn["role"] == "user":
            content: list[dict[str, Any]] = []
            if turn.get("image"):
                content.append({"type": "image", "image": turn["image"]})
            content.append({"type": "text", "text": turn["text"]})
            conversations.append({"role": "user", "content": content})
        elif turn["role"] == "assistant":
            thinking = turn.get("thinking", "")
            action = turn.get("action", "")
            parts = []
            if thinking:
                parts.append(f"<think>{thinking}</think>")
            if action:
                parts.append(action)
            conversations.append({"role": "assistant", "content": "\n".join(parts)})

    reward = 1.0 if (submitted and correct) else 0.0
    sft_record = {
        "id": f"{puzzle_type}_{puzzle_id}",
        "puzzle_type": puzzle_type,
        "puzzle_prompt": puzzle_prompt,
        "reward": reward,
        "correct": correct,
        "conversations": conversations,
    }
    (puzzle_dir / "sft_data.json").write_text(
        json.dumps(sft_record, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _save_summary_md(
    puzzle_dir: Path,
    puzzle_type: str,
    puzzle_id: str,
    puzzle_prompt: str,
    submitted: bool,
    correct: bool,
    metafile_steps: list[dict[str, Any]],
    status: str,
) -> None:
    """Save a human-readable summary.md with step-by-step action transitions."""
    result_icon = "CORRECT" if (submitted and correct) else ("INCORRECT" if submitted else "NOT SUBMITTED")
    lines = [
        f"# {puzzle_type} / {puzzle_id}",
        f"**Prompt:** {puzzle_prompt}",
        f"**Result:** {result_icon}",
        f"**Status:** {status}  |  **Steps:** {len(metafile_steps)}",
        "",
    ]

    for i, step in enumerate(metafile_steps):
        lines.append(f"## Step {i + 1}")
        # Image transition: previous screenshot -> current screenshot
        prev_img = metafile_steps[i - 1].get("screenshot_path") if i > 0 else "screenshots/screenshot_step_0.png"
        cur_img = step.get("screenshot_path")
        if prev_img and cur_img:
            lines.append(f"**Screenshot:** `{prev_img}` -> `{cur_img}`")
        elif cur_img:
            lines.append(f"**Screenshot:** `{cur_img}`")

        # Thinking
        if step.get("reasoning"):
            lines.append(f"**Thinking:** {step['reasoning']}")

        # Action
        lines.append(f"**Action:** `{step.get('action', 'N/A')}`")

        # Result
        if step.get("result"):
            lines.append(f"**Result:** {step['result']}")

        lines.append("")

    (puzzle_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


# --- SFT_EVAL_NATIVE: qwen3_xml tools-template mismatch workaround -----------
# The merged Qwen3.5 checkpoints emit CORRECT coordinates in their native XML
# (<function=click><parameter=x>720</parameter>...), but once tools are injected
# into the prompt at serve time the (train != serve) tools template makes them
# emit GARBAGE args ({"x": [579, 784]}) and even worse coordinates. So with
# SFT_EVAL_NATIVE=1 we send NO tools and parse the model's clean native XML from
# the message content ourselves. Verified: native output gives x=720 (right arrow)
# where the tool-parsed path gave x=[579,784].
_NATIVE_FN_RE = re.compile(r'<function=(\w+)>(.*?)</function>', re.S)
_NATIVE_PARAM_RE = re.compile(r'<parameter=(\w+)>\s*(.*?)\s*</parameter>', re.S)


class _NativeFn:
    def __init__(self, name, args):
        self.name = name
        self.arguments = json.dumps(args)


class _NativeCall:
    """Quacks like an OpenAI tool_call so the existing dispatch loop is unchanged."""
    def __init__(self, name, args, cid):
        self.function = _NativeFn(name, args)
        self.id = cid


def _parse_native_tool_calls(content):
    """Extract Qwen3 XML <function=..><parameter=..> blocks (SFT_EVAL_NATIVE mode)."""
    out = []
    _int_keys = ("x", "y", "start_x", "start_y", "end_x", "end_y", "duration_ms")
    for name, body in _NATIVE_FN_RE.findall(content or ""):
        args = {}
        for k, v in _NATIVE_PARAM_RE.findall(body):
            v = v.strip()
            # ONLY coordinate/duration params become ints; text/button/etc. must stay
            # strings (type_text does page.keyboard.type(text) which needs a str).
            if k in _int_keys and re.fullmatch(r'-?\d+', v):
                args[k] = int(v)
            else:
                args[k] = v
        out.append((name, args))
    return out


async def _run_openai_loop(
    page, model: str, system_prompt: str, max_steps: int,
    openai_base_url: Optional[str] = None,
    openai_api_key: Optional[str] = None,
    limit: int = 3,
    url: str = "http://127.0.0.1:7860",
    output_root: str = "runs/analyzed",
    rollout: Optional[int] = None,
    tools: Optional[list] = None,
    **_kwargs,
) -> str:
    """Agent loop: runs `limit` puzzles, each up to `max_steps` steps.

    Each puzzle saves to {output_root}/{puzzle_type}_{puzzle_id}/ with:
      - images/          per-step screenshots
      - metafile.json    full thinking + actions log
      - sft_data.json    system/user/assistant conversation for SFT training
      - summary.md       human-readable step-by-step summary
      - summary.json     machine-readable summary
      - trajectory.jsonl  raw step logs
    """
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ImportError(
            'The openai SDK is required. Install it with `pip install openai`.'
        ) from exc

    client_kwargs: dict[str, Any] = {}
    if openai_base_url:
        client_kwargs["base_url"] = openai_base_url
    if openai_api_key:
        client_kwargs["api_key"] = openai_api_key
    # CU_LLM_TIMEOUT_S: a 16k-token degenerate generation takes >600 s on L40S,
    # which trips the SDK's default timeout and retry-loops the same step forever.
    if os.environ.get('CU_LLM_TIMEOUT_S'):
        client_kwargs["timeout"] = float(os.environ['CU_LLM_TIMEOUT_S'])
    client = OpenAI(**client_kwargs)

    puzzle_results: list[str] = []
    all_puzzle_summaries: list[dict[str, Any]] = []

    # Intercept /api/get_puzzle requests to force puzzle type if specified in URL
    from urllib.parse import urlparse, parse_qs
    parsed_url = urlparse(url)
    url_params = parse_qs(parsed_url.query)
    forced_type = (url_params.get('debug_type') or url_params.get('type') or [None])[0]

    if forced_type:
        async def _route_handler(route):
            req_url = route.request.url
            if '/api/get_puzzle' in req_url and f'debug_type={forced_type}' not in req_url:
                sep = '&' if '?' in req_url else '?'
                new_url = f"{req_url}{sep}debug_type={forced_type}"
                await route.continue_(url=new_url)
            else:
                await route.continue_()

        await page.route('**/api/get_puzzle*', _route_handler)
        logger.info('[openai] Forcing puzzle type: %s via route interception', forced_type)

    if forced_type:
        await page.goto(url, wait_until='domcontentloaded')
        await page.wait_for_timeout(2000)

    prev_submitted = False

    max_puzzles = limit if limit > 0 else float('inf')
    puzzle_idx = 0

    while puzzle_idx < max_puzzles:
        logger.info('[openai] === Puzzle %d / %d ===', puzzle_idx + 1, limit)

        if puzzle_idx > 0:
            if prev_submitted:
                await page.wait_for_timeout(2500)
            else:
                await page.goto(url, wait_until='domcontentloaded')
                await page.wait_for_timeout(2000)

        # Ensure the async /api/get_puzzle actually populated the page before we
        # screenshot / name the output dir. Under heavy concurrent load a single
        # Flask can stall a fetch, leaving the page stuck on "Loading puzzle..." —
        # which previously got recorded as an unknown_unknown dead-page artifact and
        # lost a real puzzle's rollout. Wait for script.js to set window.currentPuzzle,
        # reloading the page on timeout before giving up.
        for _load_try in range(3):
            try:
                await page.wait_for_function(
                    "() => (window.currentPuzzle && typeof window.currentPuzzle.puzzle_id === 'string' "
                    "&& window.currentPuzzle.puzzle_id.length > 0)",
                    timeout=15000,
                )
                break
            except Exception:
                if _load_try < 2:
                    logger.warning('[openai] puzzle not loaded (try %d), reloading %s', _load_try + 1, url)
                    try:
                        await page.goto(url, wait_until='domcontentloaded')
                        await page.wait_for_timeout(500)
                    except Exception:
                        pass

        # Take initial screenshot
        screenshot_b64 = await _capture_screenshot(page)

        # Get puzzle info
        page_state = await _extract_page_state(page)
        stats_before = page_state.get("stats", {})
        puzzle = page_state.get("puzzle") or {}
        puzzle_type = puzzle.get("puzzle_type", "unknown")
        puzzle_id_raw = puzzle.get("puzzle_id", "unknown")
        if puzzle_type == "unknown" or puzzle_id_raw == "unknown":
            # Load still stalled after retries: recover the intended puzzle from the
            # request URL (?...&puzzle_type=..&puzzle_id=..) so this rollout is filed
            # under the correct puzzle instead of an unknown_unknown dead page.
            from urllib.parse import parse_qs, urlparse as _urlparse
            _q = parse_qs(_urlparse(url).query)
            puzzle_type = (_q.get("puzzle_type") or [puzzle_type])[0]
            puzzle_id_raw = (_q.get("puzzle_id") or [puzzle_id_raw])[0]
        puzzle_id = Path(puzzle_id_raw).stem.replace("/", "_").replace(" ", "_")
        puzzle_prompt = page_state.get("prompt", "")

        puzzle_dir = Path(output_root) / puzzle_type.lower() / f"{puzzle_type}_{puzzle_id}"
        if rollout is not None:
            puzzle_dir = puzzle_dir / f"rollout_{rollout}"
        ss_dir = puzzle_dir / "screenshots"
        ss_dir.mkdir(parents=True, exist_ok=True)

        # Create per-puzzle recorder
        recorder = TrajectoryRecorder(
            run_id=f"{puzzle_type}_{puzzle_id}",
            trajectory_file=str(puzzle_dir / "trajectory.jsonl"),
            image_dir=str(ss_dir),
        )

        import base64 as _b64

        # Save initial screenshot
        (ss_dir / "screenshot_step_0.png").write_bytes(_b64.b64decode(screenshot_b64))

        recorder.log_event(
            event_type="run_start", provider="openai",
            page_state=page_state, note="puzzle_start",
            metadata={"puzzle_idx": puzzle_idx, "model": model,
                       "max_steps": max_steps, "url": url},
        )

        metafile_steps: list[dict[str, Any]] = []
        # SFT conversation turns (excluding the system prompt, added later)
        sft_turns: list[dict[str, Any]] = []
        # Screenshot counter for sequential naming
        ss_counter = 0

        logger.info('[openai] Puzzle: %s/%s - %s', puzzle_type, puzzle_id, puzzle_prompt)

        # First user turn with initial screenshot
        user_text = f"Here is the current state of the browser. Solve this puzzle: {puzzle_prompt}" if puzzle_prompt else "Here is the current state of the browser. Begin solving this puzzle."
        sft_turns.append({"role": "user", "image": f"screenshots/screenshot_step_{ss_counter}.png", "text": user_text})

        # Fresh messages per puzzle (for the OpenAI API)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"}},
                ],
            },
        ]

        puzzle_done = False

        for step in range(max_steps):
            logger.info('[openai] Puzzle %d, Step %d / %d', puzzle_idx + 1, step + 1, max_steps)

            # Keep message history bounded
            if len(messages) > 22:
                messages = [messages[0]] + messages[-20:]

            # Strip older screenshots to stay under Doubleword's 413 payload limit:
            # keep image data only in the last KEEP_IMG_TURNS user messages, replace
            # older image_url blocks with a "[older screenshot omitted]" text stub.
            # NB: messages list mixes dict entries and ChatCompletionMessage objects
            # (assistant turns appended from API responses); only dict user entries
            # ever contain image_url content, so skip non-dicts everywhere.
            # Default 8 covers the longest SFT episode (IR: 7 actions -> 8 screenshots),
            # so eval context matches the training data exactly; override via env.
            KEEP_IMG_TURNS = int(os.environ.get("KEEP_IMG_TURNS", "8"))
            user_msgs_with_image = [
                i for i, m in enumerate(messages)
                if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), list)
                and any(isinstance(c, dict) and c.get("type") == "image_url" for c in m["content"])
            ]
            keep_idxs = set(user_msgs_with_image[-KEEP_IMG_TURNS:])
            for i, m in enumerate(messages):
                if i in keep_idxs: continue
                if not isinstance(m, dict): continue
                if m.get("role") != "user" or not isinstance(m.get("content"), list): continue
                m["content"] = [
                    {"type": "text", "text": "[older screenshot omitted]"} if isinstance(c, dict) and c.get("type") == "image_url" else c
                    for c in m["content"]
                ]

            # DUMP_REQUEST_DIR: write each request body to disk for train/inference
            # template-alignment checks (diff vs the SFT jsonl rendering).
            dump_dir = os.environ.get("DUMP_REQUEST_DIR")
            if dump_dir:
                Path(dump_dir).mkdir(parents=True, exist_ok=True)
                dump_msgs = [
                    m if isinstance(m, dict) else m.model_dump(exclude_none=True)
                    for m in messages
                ]
                with open(Path(dump_dir) / f"request_p{puzzle_idx}_s{step}.json", "w") as df:
                    json.dump({"messages": dump_msgs, "tools": (tools or CUSTOM_TOOLS)}, df,
                              ensure_ascii=False, indent=1)

            _native = os.environ.get('SFT_EVAL_NATIVE') == '1'
            _create_kw = dict(
                model=model,
                # CU_MAX_TOKENS: cap degenerate runaway generations (e.g. a LoRA adapter
                # rambling to the 12k ceiling takes ~8 min/step on L40S and trips the
                # client's 600 s timeout); default unchanged.
                max_tokens=int(os.environ.get('CU_MAX_TOKENS', '12000')),
                messages=messages,
            )
            if not _native:
                _create_kw['tools'] = (tools or CUSTOM_TOOLS)
                _create_kw['tool_choice'] = "auto"
            # CU_DISABLE_THINKING=1: turn off the serving-side forced <think> prefix
            # (Qwen3.5 thinking template). Needed for models trained on NON-think SFT
            # (e.g. place_dot): a think-forcing template makes them ramble / emit no
            # clean action. Sends vLLM chat_template_kwargs.enable_thinking=false.
            if os.environ.get('CU_DISABLE_THINKING') == '1':
                _create_kw['extra_body'] = {"chat_template_kwargs": {"enable_thinking": False}}
            response = client.chat.completions.create(**_create_kw)

            choice = response.choices[0]
            assistant_msg = choice.message
            reasoning = assistant_msg.content or ""

            if _native:
                # No tools were sent → parse the model's clean native XML instead of the
                # (mangled) tool_calls. Append assistant as plain text so the chat stays
                # valid without tool-call/tool-response pairing. Take the first action only
                # (matches per-turn SFT: one action → screenshot → next turn).
                messages.append({"role": "assistant", "content": reasoning})
                _tool_calls = [_NativeCall(n, a, f"native_{step}_{i}")
                               for i, (n, a) in enumerate(_parse_native_tool_calls(reasoning)[:1])]
            else:
                messages.append(assistant_msg)
                _tool_calls = list(assistant_msg.tool_calls or [])

            # No actionable call → model gave a plain text response, puzzle done
            if not _tool_calls:
                sft_turns.append({"role": "assistant", "thinking": reasoning, "action": ""})
                puzzle_results.append(f"Puzzle {puzzle_idx+1}: {reasoning[:100]}")
                puzzle_done = True
                break

            # Process tool calls
            for tool_call in _tool_calls:
                fn_name = tool_call.function.name
                try:
                    fn_args = json.loads(tool_call.function.arguments) if tool_call.function.arguments else {}
                except json.JSONDecodeError as e:
                    logger.error('[openai] tool_call %s args_raw=%r FAILED json.loads: %s', fn_name, tool_call.function.arguments, e)
                    fn_args = {}
                logger.info('[openai] tool_call: %s args_raw=%r parsed=%s', fn_name, tool_call.function.arguments, fn_args)

                action_str = f"{fn_name}({json.dumps(fn_args)})" if fn_args else fn_name

                if fn_name == 'done':
                    recorder.log_event(
                        event_type="tool_call", provider="openai",
                        step=step, action="done", params=fn_args,
                        result="agent_done",
                        page_state=await _extract_page_state(page),
                        note=reasoning,
                        metadata={"summary": fn_args.get("summary", "")},
                    )
                    metafile_steps.append({"screenshot_path": None, "reasoning": reasoning,
                                           "action": action_str, "result": "agent_done"})
                    sft_turns.append({"role": "assistant", "thinking": reasoning, "action": action_str})
                    puzzle_results.append(f"Puzzle {puzzle_idx+1} ({puzzle_type}/{puzzle_id}): {fn_args.get('summary', '')[:100]}")
                    puzzle_done = True
                    break

                if fn_name == 'screenshot':
                    screenshot_b64 = await _capture_screenshot(page)
                    ss_counter += 1
                    ss_name = f"screenshot_step_{ss_counter}.png"
                    (ss_dir / ss_name).write_bytes(_b64.b64decode(screenshot_b64))
                    recorder.log_event(
                        event_type="tool_call", provider="openai",
                        step=step, action="screenshot", params=fn_args,
                        result="screenshot_taken",
                        page_state=await _extract_page_state(page),
                        note=reasoning,
                    )
                    metafile_steps.append({"screenshot_path": f"screenshots/{ss_name}",
                                           "reasoning": reasoning, "action": action_str, "result": "screenshot_taken"})
                    sft_turns.append({"role": "assistant", "thinking": reasoning, "action": action_str})
                    if not _native:
                        messages.append({"role": "tool", "tool_call_id": tool_call.id,
                                         "content": "Screenshot captured. See the image below."})
                    messages.append({"role": "user", "content": [
                        {"type": "text", "text": "Here is the updated screenshot:"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"}},
                    ]})
                    sft_turns.append({"role": "user", "image": f"screenshots/{ss_name}", "text": "Here is the updated screenshot."})
                else:
                    result_str = await _handle_action(page, fn_name, fn_args)
                    logger.info('[openai] Action result: %s', result_str)

                    await page.wait_for_timeout(800)

                    if not _native:
                        messages.append({"role": "tool", "tool_call_id": tool_call.id,
                                         "content": result_str})

                    screenshot_b64 = await _capture_screenshot(page)
                    ss_counter += 1
                    ss_name = f"screenshot_step_{ss_counter}.png"
                    (ss_dir / ss_name).write_bytes(_b64.b64decode(screenshot_b64))

                    cur_state = await _extract_page_state(page)
                    recorder.log_event(
                        event_type="tool_call", provider="openai",
                        step=step, action=fn_name, params=fn_args,
                        result=result_str,
                        page_state=cur_state,
                        note=reasoning,
                    )
                    metafile_steps.append({"screenshot_path": f"screenshots/{ss_name}",
                                           "reasoning": reasoning, "action": action_str, "result": result_str})

                    # SFT: assistant turn (thinking + action), then user turn (result screenshot)
                    sft_turns.append({"role": "assistant", "thinking": reasoning, "action": action_str})

                    # Plan②: end the episode the moment the answer is submitted — either the
                    # page auto-accepted (Total ticked) or submit feedback is now on the page.
                    # This mirrors the no-done SFT, where the conversation stops at the submit
                    # action; we no longer wait for the model to emit a `done` tool call.
                    cur_total = cur_state.get("stats", {}).get("total", 0)
                    submitted_now, _correct_now = _detect_submit_result(cur_state)
                    if cur_total > stats_before.get("total", 0) or submitted_now:
                        logger.info('[openai] Puzzle %d: submit detected (total %d -> %d, feedback=%s), ending puzzle',
                                    puzzle_idx + 1, stats_before.get("total", 0), cur_total, submitted_now)
                        # Still save the result screenshot as a user turn so SFT sees the outcome
                        feedback_text = cur_state.get("feedback", "") or ""
                        sft_turns.append({"role": "user", "image": f"screenshots/{ss_name}",
                                          "text": f"Action executed: {result_str}. Result: {feedback_text}"})
                        puzzle_done = True
                        break

                    messages.append({"role": "user", "content": [
                        {"type": "text", "text": f"Action executed: {result_str}. Here is the updated screenshot:"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"}},
                    ]})
                    sft_turns.append({"role": "user", "image": f"screenshots/{ss_name}",
                                      "text": f"Action executed: {result_str}. Here is the updated screenshot."})

            if puzzle_done:
                break

        # --- Detect submit result ---
        end_state = await _extract_page_state(page)
        stats_after = end_state.get("stats", {})
        total_before = stats_before.get("total", 0)
        total_after = stats_after.get("total", 0)

        submitted_via_stats = total_after > total_before
        submitted_via_feedback, correct_via_feedback = _detect_submit_result(end_state)
        submitted = submitted_via_stats or submitted_via_feedback

        if submitted_via_stats:
            correct_before = stats_before.get("correct", 0)
            correct_after = stats_after.get("correct", 0)
            correct = correct_after > correct_before
        else:
            correct = correct_via_feedback

        reward = 1.0 if (submitted and correct) else 0.0
        status = "max_steps_reached" if not puzzle_done else "done"

        if not submitted:
            status = "submit_not_clicked"
            logger.warning('[openai] Puzzle %d: submit was NOT clicked', puzzle_idx + 1)

        puzzle_results.append(
            f"Puzzle {puzzle_idx+1} ({puzzle_type}/{puzzle_id}): "
            f"submitted={submitted}, correct={correct}, reward={reward}"
        )

        prev_submitted = submitted

        recorder.log_event(
            event_type="run_end", provider="openai",
            result=status,
            page_state=end_state,
            metadata={"status": status, "submitted": submitted,
                       "correct": correct, "reward": reward},
        )

        logger.info('[openai] Puzzle %d: submitted=%s correct=%s reward=%s',
                     puzzle_idx + 1, submitted, correct, reward)

        # --- Save all output files ---

        # 1. metafile.json (full thinking + actions)
        metafile = {
            "benchmark": "opencaptchaworld",
            "agent": model.split("/")[-1],
            "task_id": f"{puzzle_type}_{puzzle_id}",
            "summary_info": {"cum_reward": reward},
            "goal": puzzle_prompt,
            "steps": metafile_steps,
        }
        (puzzle_dir / "metafile.json").write_text(
            json.dumps(metafile, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # 2. sft_data.json (system/user/assistant conversation for training)
        _save_sft_data(
            puzzle_dir, system_prompt, sft_turns,
            puzzle_type, puzzle_id, puzzle_prompt,
            submitted, correct,
        )

        # 3. summary.md (human-readable)
        _save_summary_md(
            puzzle_dir, puzzle_type, puzzle_id, puzzle_prompt,
            submitted, correct, metafile_steps, status,
        )

        # 4. summary.json (machine-readable, backward compatible)
        summary = _build_puzzle_summary(
            puzzle_type, puzzle_id, puzzle_prompt,
            submitted, correct, metafile_steps, status,
        )
        (puzzle_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        all_puzzle_summaries.append(summary)
        logger.info('[openai] Puzzle %d saved to: %s', puzzle_idx + 1, puzzle_dir)

        puzzle_idx += 1

    # --- Overall run summary ---
    total_puzzles = len(all_puzzle_summaries)
    total_submitted = sum(1 for s in all_puzzle_summaries if s["submitted"])
    total_correct = sum(1 for s in all_puzzle_summaries if s["correct"])
    overall_accuracy = (total_correct / total_puzzles * 100) if total_puzzles else 0.0

    run_summary = {
        "benchmark": "opencaptchaworld",
        "agent": model.split("/")[-1],
        "total_puzzles": total_puzzles,
        "total_submitted": total_submitted,
        "total_correct": total_correct,
        "accuracy": round(overall_accuracy, 2),
        "puzzles": [
            {
                "task_id": f"{s['puzzle_type']}_{s['puzzle_id']}",
                "puzzle_type": s["puzzle_type"],
                "submitted": s["submitted"],
                "correct": s["correct"],
                "reward": s["reward"],
                "status": s["status"],
            }
            for s in all_puzzle_summaries
        ],
    }

    out_root = Path(output_root)
    out_root.mkdir(parents=True, exist_ok=True)
    (out_root / "run_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info('[openai] Run summary saved to: %s/run_summary.json', out_root)

    result_lines = [
        f"\nResults: {total_correct}/{total_puzzles} correct "
        f"({total_submitted} submitted, {overall_accuracy:.1f}% accuracy)",
    ]
    result_lines.extend(puzzle_results)
    return "\n".join(result_lines)


# ---------------------------------------------------------------------------
# Mock loop — scripts actions from ground truth instead of calling an LLM.
# Useful for end-to-end sanity checks: does our action dispatch + page wiring
# actually solve a puzzle when fed the canonical answer?
# ---------------------------------------------------------------------------

def _mock_load_gt(gt_root: Path, puzzle_type: str) -> dict[str, Any]:
    """Read ground_truth_cu.json (preferred) or ground_truth.json from
    <gt_root>/<puzzle_type>/. The CU file has answer_cu/answer_cu_kind."""
    type_dir = gt_root / puzzle_type
    cu_path = type_dir / "ground_truth_cu.json"
    plain_path = type_dir / "ground_truth.json"
    if cu_path.exists():
        return json.loads(cu_path.read_text(encoding="utf-8"))
    if plain_path.exists():
        return json.loads(plain_path.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"No ground_truth*.json under {type_dir}")


async def _wait_for_images_settled(page, timeout_ms: int = 5000) -> None:
    """Wait until every <img> in the page reports `complete && naturalWidth > 0`
    (or 0×0 placeholder if intentionally hidden). Used after each mock action so
    image swaps from option/rotation/grid cycling are fully fetched before the
    next click — otherwise rapid clicks land before the page repaints and the
    captcha never sees them as distinct rotations."""
    try:
        await page.wait_for_function(
            """() => {
              const imgs = Array.from(document.querySelectorAll('img'));
              if (imgs.length === 0) return true;
              return imgs.every((im) => {
                  // `complete` is true once the load has either finished or
                  // errored; naturalWidth > 0 confirms a real image landed.
                  // Allow imgs with no src yet (e.g. lazy mounts) — they aren't
                  // contributing to the current state.
                  if (!im.src) return true;
                  return im.complete && (im.naturalWidth > 0 || im.naturalHeight > 0);
              });
            }""",
            timeout=timeout_ms,
        )
    except Exception:
        pass  # bounded — proceed even if one stubborn image stalls


async def _mock_locate_center(page, selectors: list[str]) -> tuple[int, int] | None:
    """Find the first visible element from `selectors` and return its viewport center."""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0:
                continue
            if not await loc.is_visible():
                continue
            box = await loc.bounding_box()
            if box and box.get("width") and box.get("height"):
                return (int(box["x"] + box["width"] / 2), int(box["y"] + box["height"] / 2))
        except Exception:
            continue
    return None


# Selectors used to find the "next option" arrow per puzzle type. Order
# matters — the first visible match wins, and one click advances the option
# index by +1 (with wrap-around).
_NEXT_OPTION_SELECTORS = [
    ".object-match-arrow.right-arrow",
    ".connect-arrows-container .right-arrow",
    ".dart-count-arrow.right-arrow",
    ".navigate-right",
    "[aria-label='Next image']",
    "[aria-label='Next option']",
]

# One click on .rotate-right rotates the object by +45 degrees.
_ROTATE_CW_SELECTORS = [".rotate-right", "[aria-label='Rotate right']"]
_ROTATE_STEP_DEG = 45


def _infer_answer_cu_kind(cu: Any) -> str | None:
    """Infer answer_cu_kind from structure when the GT omits it. The new
    explicit-tool-call schemas:
      multi_swap: list of lists of tool-call dicts (Bingo)
      multi_xy:   flat list of tool-call dicts (Click_Order)
    Other kinds remain self-tagged for now."""
    if not isinstance(cu, list) or not cu:
        return None
    first = cu[0]
    if isinstance(first, dict) and (first.get("action") or first.get("name")):
        return "multi_xy"
    if (
        isinstance(first, list) and first
        and isinstance(first[0], dict)
        and (first[0].get("action") or first[0].get("name"))
    ):
        return "multi_swap"
    return None


async def _mock_actions_from_answer(
    page, entry: dict[str, Any]
) -> list[tuple[str, dict[str, Any]]]:
    """Convert a single GT entry's answer_cu into a list of (action, params)
    drawn from the 10 declared tools (click / drag / type_text / hold). The
    submit click is appended by the caller."""
    kind = entry.get("answer_cu_kind") or _infer_answer_cu_kind(entry.get("answer_cu"))
    # New schema label "tool_calls" is a structural hint, not a dispatch kind —
    # delegate to the inference helper to pick the right legacy branch.
    if kind == "tool_calls":
        kind = _infer_answer_cu_kind(entry.get("answer_cu"))
    cu = entry.get("answer_cu")
    actions: list[tuple[str, dict[str, Any]]] = []

    if kind == "single_xy" and isinstance(cu, list) and len(cu) == 2:
        actions.append(("click", {"x": int(cu[0]), "y": int(cu[1])}))

    elif kind == "multi_xy" and isinstance(cu, list):
        # Accept both the explicit tool-call form and the legacy raw-coord form.
        for p in cu:
            if isinstance(p, dict) and (p.get("action") or p.get("name")):
                name = p.get("action") or p.get("name")
                args = p.get("arguments") or {}
                actions.append((str(name), {k: v for k, v in args.items()}))
            elif isinstance(p, list) and len(p) == 2:
                actions.append(("click", {"x": int(p[0]), "y": int(p[1])}))

    elif kind == "multi_swap" and isinstance(cu, list) and cu:
        # Pick alternative #0 — historically each alt was a 2-click swap pair;
        # the new schema may include a trailing submit click, so accept any
        # alt length and emit every tool-call.
        pair = cu[0]
        if isinstance(pair, list):
            for p in pair:
                if isinstance(p, dict) and (p.get("action") or p.get("name")):
                    name = p.get("action") or p.get("name")
                    args = p.get("arguments") or {}
                    actions.append((str(name), {k: v for k, v in args.items()}))
                elif isinstance(p, list) and len(p) == 2:
                    actions.append(("click", {"x": int(p[0]), "y": int(p[1])}))

    elif kind == "drag" and isinstance(cu, dict):
        drag = cu.get("drag", {})
        to = drag.get("to")
        frm = drag.get("from")
        if isinstance(to, list) and len(to) == 2:
            if isinstance(frm, list) and len(frm) == 2:
                actions.append(("drag", {
                    "start_x": int(frm[0]), "start_y": int(frm[1]),
                    "end_x": int(to[0]), "end_y": int(to[1]),
                }))
            else:
                # No start point given — emit a click on the target as a
                # last resort (still within the 10-tool spec).
                actions.append(("click", {"x": int(to[0]), "y": int(to[1])}))

    elif kind == "type_text" and isinstance(cu, dict):
        txt = cu.get("type_text")
        if txt is not None:
            actions.append(("type_text", {"text": str(txt)}))

    elif kind == "option" and isinstance(cu, dict):
        n = int(cu.get("select_option_index", 0))
        center = await _mock_locate_center(page, _NEXT_OPTION_SELECTORS)
        if center and n > 0:
            for _ in range(n):
                actions.append(("click", {"x": center[0], "y": center[1]}))

    elif kind == "rotate" and isinstance(cu, dict):
        deg = int(cu.get("rotate_to_angle", 0)) % 360
        clicks = deg // _ROTATE_STEP_DEG
        center = await _mock_locate_center(page, _ROTATE_CW_SELECTORS)
        if center and clicks > 0:
            for _ in range(clicks):
                actions.append(("click", {"x": center[0], "y": center[1]}))

    elif kind == "hold" and isinstance(cu, dict):
        ms = int(cu.get("duration_ms", 1000))
        center = await _mock_locate_center(page, [".hold-button"])
        if center:
            actions.append(("hold", {"x": center[0], "y": center[1], "duration_ms": ms}))

    return actions


async def _mock_image_transform(
    page, source_png: Path | None = None
) -> tuple[float, float, float, float] | None:
    """Return (offset_x, offset_y, scale_x, scale_y) so that
    viewport_x = offset_x + scale_x * image_natural_x.

    answer_cu coords live in the puzzle image's own pixel frame; the page
    renders the image at some offset and often a different size. Bingo is a
    special case: the composite image is split into separate canvas cells in
    a CSS grid, so #puzzle-image is hidden. We fall back to .bingo-grid and
    read the natural dimensions from the source PNG."""
    # 1. Standard case: visible main puzzle <img> with naturalWidth.
    #    `#puzzle-image` is the default; `#click-order-main-image` is a
    #    Click_Order-specific element rendered into a fresh container.
    for sel in ("#puzzle-image", "#click-order-main-image"):
        try:
            img = page.locator(sel).first
            if await img.count() > 0 and await img.is_visible():
                box = await img.bounding_box()
                nat = await img.evaluate("el => ({ w: el.naturalWidth, h: el.naturalHeight })")
                if box and nat and nat.get("w") and nat.get("h"):
                    return (box["x"], box["y"], box["width"] / nat["w"], box["height"] / nat["h"])
        except Exception:
            continue

    # 2. Bingo (canvas-rendered grid). Use .bingo-grid + source PNG natural size.
    if source_png and source_png.exists():
        try:
            grid = page.locator(".bingo-grid").first
            if await grid.count() > 0:
                box = await grid.bounding_box()
                if box and box.get("width") and box.get("height"):
                    from PIL import Image as _PILImage
                    with _PILImage.open(source_png) as im:
                        nw, nh = im.size
                    return (box["x"], box["y"], box["width"] / nw, box["height"] / nh)
        except Exception:
            pass

    return None


def _mock_apply_transform(actions: list[tuple[str, dict[str, Any]]],
                          tx: tuple[float, float, float, float]) -> list[tuple[str, dict[str, Any]]]:
    ox, oy, sx, sy = tx
    out = []
    for name, params in actions:
        p = dict(params)
        if "x" in p and "y" in p:
            p["x"] = int(round(ox + sx * p["x"]))
            p["y"] = int(round(oy + sy * p["y"]))
        for kx, ky in (("start_x", "start_y"), ("end_x", "end_y")):
            if kx in p and ky in p:
                p[kx] = int(round(ox + sx * p[kx]))
                p[ky] = int(round(oy + sy * p[ky]))
        out.append((name, p))
    return out


async def _mock_locate_submit(page) -> tuple[int, int] | None:
    """Find the visible submit-style button. Different puzzle types render
    different submit elements (e.g. Bingo uses '.submit-bingo' / 'Swap and
    Submit', Click_Order uses '.click-order-submit-btn'). Try in priority
    order; scroll the match into the viewport so the returned coords are
    actually clickable via mouse.click(x, y)."""
    selectors = [
        ".submit-bingo",
        ".click-order-submit-btn",
        "#submit-answer",
        "button:has-text('Swap and Submit')",
        "button:has-text('Submit Order')",
        "button:has-text('Submit')",
        "button:has-text('Verify')",
        "button:has-text('Check Position')",
    ]
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0:
                continue
            if not await loc.is_visible():
                continue
            # Bring it into view; mouse.click() is viewport-coord-based and
            # silently no-ops when the target is below the fold.
            await loc.scroll_into_view_if_needed()
            await page.wait_for_timeout(150)
            box = await loc.bounding_box()
            if box and box.get("width") and box.get("height"):
                return (int(box["x"] + box["width"] / 2), int(box["y"] + box["height"] / 2))
        except Exception:
            continue
    return None


async def _run_mock_loop(
    page, system_prompt: str, max_steps: int,
    limit: int = 1,
    url: str = "http://127.0.0.1:7860",
    output_root: str = "runs/analyzed",
    mock_gt_dir: str = "data/Validation",
    **_kwargs,
) -> str:
    """Drive the page using ground-truth answers. No LLM is called."""
    gt_root = Path(mock_gt_dir).expanduser().resolve()
    if not gt_root.is_dir():
        raise FileNotFoundError(f"--mock-gt-dir does not exist: {gt_root}")

    import base64 as _b64

    all_summaries: list[dict[str, Any]] = []
    puzzle_idx = 0
    max_puzzles = limit if limit > 0 else 1
    prev_submitted = False

    while puzzle_idx < max_puzzles:
        if puzzle_idx > 0:
            if prev_submitted:
                await page.wait_for_timeout(2000)
            else:
                await page.goto(url, wait_until='domcontentloaded')
                await page.wait_for_timeout(1500)
        # Don't start clicking until every puzzle image is loaded. Click_Order
        # icons, Rotation_Match angle variants, option_images carousels, etc.
        # all stream in after DOMContentLoaded — a too-eager first click can
        # land on a 0×0 placeholder that the captcha later ignores.
        await _wait_for_images_settled(page)

        # Wait for currentPuzzle.puzzle_id to be populated by script.js before
        # extracting state — otherwise raw_pid lands as None and Path(None)
        # crashes. The page loads currentPuzzle async after /api/get_puzzle.
        try:
            await page.wait_for_function(
                "() => (window.currentPuzzle && typeof window.currentPuzzle.puzzle_id === 'string' && window.currentPuzzle.puzzle_id.length > 0)",
                timeout=15000,
            )
        except Exception:
            pass  # fall through; will use "unknown" stem below

        # Initial state
        page_state = await _extract_page_state(page)
        stats_before = page_state.get("stats", {})
        puzzle = page_state.get("puzzle") or {}
        puzzle_type = puzzle.get("puzzle_type") or "unknown"
        raw_pid = puzzle.get("puzzle_id") or "unknown"
        puzzle_id_stem = Path(raw_pid).stem.replace("/", "_").replace(" ", "_")
        puzzle_prompt = page_state.get("prompt", "") or ""

        puzzle_dir = Path(output_root) / puzzle_type.lower() / f"{puzzle_type}_{puzzle_id_stem}"
        ss_dir = puzzle_dir / "screenshots"
        ss_dir.mkdir(parents=True, exist_ok=True)

        recorder = TrajectoryRecorder(
            run_id=f"{puzzle_type}_{puzzle_id_stem}",
            trajectory_file=str(puzzle_dir / "trajectory.jsonl"),
            image_dir=str(ss_dir),
        )

        # Save initial screenshot as step_0
        screenshot_b64 = await _capture_screenshot(page)
        (ss_dir / "screenshot_step_0.png").write_bytes(_b64.b64decode(screenshot_b64))

        recorder.log_event(
            event_type="run_start", provider="mock",
            page_state=page_state, note="puzzle_start",
            metadata={"puzzle_idx": puzzle_idx, "model": "mock-gt", "max_steps": max_steps, "url": url},
        )

        logger.info('[mock] Puzzle %d/%d: %s/%s — %s',
                    puzzle_idx + 1, max_puzzles, puzzle_type, raw_pid, puzzle_prompt)

        # Resolve GT
        try:
            gt = _mock_load_gt(gt_root, puzzle_type)
            entry = gt.get(raw_pid) or gt.get(puzzle_id_stem) or gt.get(f"{puzzle_id_stem}.png")
            if entry is None:
                logger.error('[mock] No GT entry for %s in %s', raw_pid, puzzle_type)
                break
        except FileNotFoundError as e:
            logger.error('[mock] %s', e)
            break

        actions = await _mock_actions_from_answer(page, entry)
        # Image-natural -> viewport transform only applies to coords sourced
        # from the puzzle image (single_xy / multi_xy / multi_swap / drag).
        # option / rotate / hold actions are sourced from live UI element
        # bounding boxes and are already in viewport coords.
        kind = entry.get("answer_cu_kind") or _infer_answer_cu_kind(entry.get("answer_cu"))
        if kind in {"single_xy", "multi_xy", "multi_swap", "drag"}:
            source_png = gt_root / puzzle_type / raw_pid
            tx = await _mock_image_transform(page, source_png if source_png.exists() else None)
            if tx is not None:
                actions = _mock_apply_transform(actions, tx)
                logger.debug('[mock] image transform offset=(%.1f,%.1f) scale=(%.3f,%.3f)', *tx)
        # Submit click is appended LATER, after the image-frame clicks have
        # been dispatched — locating it can scroll the page (the button is
        # often below the fold) and that would invalidate the viewport coords
        # we just computed.
        needs_submit = kind != "hold"

        metafile_steps: list[dict[str, Any]] = []
        ss_counter = 0
        step_idx = 0

        for action_name, params in actions:
            if step_idx >= max_steps:
                break
            try:
                result_str = await _handle_action(page, action_name, params)
            except Exception as exc:
                result_str = f"error: {exc}"
            # If the action triggered an image swap (option arrow, rotation,
            # etc.) the new <img> won't be ready yet. Wait until every img on
            # the page reports complete + naturalWidth>0 so subsequent clicks
            # don't outrun the captcha state machine.
            if action_name in ("click", "mouse_down", "mouse_up", "drag", "press_key"):
                await _wait_for_images_settled(page)
            # 10s inter-action gap: gives a human observer time to follow each
            # step on the live page, and is well within budget for the captcha
            # state machine to react / animate / re-render between clicks.
            # Bulk verification runs can shrink it via MOCK_ACTION_WAIT_MS.
            await page.wait_for_timeout(int(os.environ.get("MOCK_ACTION_WAIT_MS", "10000")))

            ss_counter += 1
            screenshot_b64 = await _capture_screenshot(page)
            ss_name = f"screenshot_step_{ss_counter}.png"
            (ss_dir / ss_name).write_bytes(_b64.b64decode(screenshot_b64))

            cur_state = await _extract_page_state(page)
            action_str = f"{action_name}({json.dumps(params, ensure_ascii=False)})"
            recorder.log_event(
                event_type="tool_call", provider="mock",
                step=step_idx, action=action_name, params=params,
                result=result_str, page_state=cur_state, screenshot_b64=screenshot_b64,
                note="scripted from ground truth",
            )
            metafile_steps.append({
                "screenshot_path": f"screenshots/{ss_name}",
                "reasoning": "ground-truth driven (no LLM)",
                "action": action_str,
                "result": result_str,
            })
            step_idx += 1

            # Stop if the page advanced (auto-submit → Total++) OR explicit
            # feedback appeared (an answer_cu that ends in its own submit click
            # already submitted). Firing the deferred submit anyway would
            # double-submit: e.g. Rotation_Match shows correct/incorrect feedback
            # but does NOT increment Total, so the old Total-only check never
            # tripped and a 2nd submit could re-evaluate a reset angle, flipping
            # a correct answer to incorrect.
            cur_total = cur_state.get("stats", {}).get("total", 0)
            submitted_now, _ = _detect_submit_result(cur_state)
            if cur_total > stats_before.get("total", 0) or submitted_now:
                logger.info('[mock] submit detected at step %d', step_idx)
                needs_submit = False
                break

        # Submit click — deferred so we can locate the button (and scroll it
        # into view) AFTER the image-frame clicks have already been dispatched
        # at their original viewport coords.
        if needs_submit and step_idx < max_steps:
            submit_xy = await _mock_locate_submit(page)
            if submit_xy is None:
                logger.warning('[mock] submit-style button not found; skipping submit click')
            else:
                action_name, params = "click", {"x": submit_xy[0], "y": submit_xy[1]}
                try:
                    result_str = await _handle_action(page, action_name, params)
                except Exception as exc:
                    result_str = f"error: {exc}"
                await page.wait_for_timeout(600)

                ss_counter += 1
                screenshot_b64 = await _capture_screenshot(page)
                ss_name = f"screenshot_step_{ss_counter}.png"
                (ss_dir / ss_name).write_bytes(_b64.b64decode(screenshot_b64))
                cur_state = await _extract_page_state(page)
                action_str = f"{action_name}({json.dumps(params, ensure_ascii=False)})"
                recorder.log_event(
                    event_type="tool_call", provider="mock",
                    step=step_idx, action=action_name, params=params,
                    result=result_str, page_state=cur_state, screenshot_b64=screenshot_b64,
                    note="submit click (post-scroll)",
                )
                metafile_steps.append({
                    "screenshot_path": f"screenshots/{ss_name}",
                    "reasoning": "ground-truth driven (no LLM)",
                    "action": action_str,
                    "result": result_str,
                })
                step_idx += 1

        end_state = await _extract_page_state(page)
        stats_after = end_state.get("stats", {})
        submitted_via_stats = stats_after.get("total", 0) > stats_before.get("total", 0)
        submitted_via_feedback, correct_via_feedback = _detect_submit_result(end_state)
        submitted = submitted_via_stats or submitted_via_feedback
        if submitted_via_stats:
            correct = stats_after.get("correct", 0) > stats_before.get("correct", 0)
        else:
            correct = correct_via_feedback
        reward = 1.0 if (submitted and correct) else 0.0
        status = "done" if submitted else "submit_not_clicked"

        recorder.log_event(
            event_type="run_end", provider="mock", result=status, page_state=end_state,
            metadata={"status": status, "submitted": submitted, "correct": correct, "reward": reward},
        )

        # metafile.json + summary.json
        metafile = {
            "benchmark": "opencaptchaworld",
            "agent": "mock-gt",
            "task_id": f"{puzzle_type}_{puzzle_id_stem}",
            "summary_info": {"cum_reward": reward},
            "goal": puzzle_prompt,
            "steps": metafile_steps,
        }
        (puzzle_dir / "metafile.json").write_text(
            json.dumps(metafile, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summary = _build_puzzle_summary(
            puzzle_type, puzzle_id_stem, puzzle_prompt,
            submitted, correct, metafile_steps, status,
        )
        (puzzle_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        all_summaries.append(summary)

        logger.info('[mock] Puzzle %d: submitted=%s correct=%s', puzzle_idx + 1, submitted, correct)
        prev_submitted = submitted
        puzzle_idx += 1

    # Overall run summary
    out_root = Path(output_root)
    out_root.mkdir(parents=True, exist_ok=True)
    total = len(all_summaries)
    sub = sum(1 for s in all_summaries if s["submitted"])
    cor = sum(1 for s in all_summaries if s["correct"])
    (out_root / "run_summary.json").write_text(
        json.dumps({
            "benchmark": "opencaptchaworld",
            "agent": "mock-gt",
            "total_puzzles": total,
            "total_submitted": sub,
            "total_correct": cor,
            "accuracy": round((cor / total * 100) if total else 0.0, 2),
            "puzzles": [
                {"task_id": f"{s['puzzle_type']}_{s['puzzle_id']}", **{k: s[k] for k in ("puzzle_type", "submitted", "correct", "reward", "status")}}
                for s in all_summaries
            ],
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return f"mock: {cor}/{total} correct, {sub} submitted"


# ---------------------------------------------------------------------------
# Google Gemini vision + function-calling loop
# ---------------------------------------------------------------------------

async def _run_google_loop(
    page, model: str, system_prompt: str, max_steps: int,
    recorder: Optional[TrajectoryRecorder] = None,
) -> str:
    """Agent loop using Google Gemini's vision models with function calling."""
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise ImportError(
            'The google-genai SDK is required. Install it with `pip install google-genai`.'
        ) from exc

    client = genai.Client()

    # Take initial screenshot
    screenshot_b64 = await _capture_screenshot(page)
    screenshot_bytes = base64.b64decode(screenshot_b64)

    # Build tool declarations
    tool_config = types.Tool(function_declarations=[
        types.FunctionDeclaration(**decl) for decl in GEMINI_TOOL_DECLARATIONS
    ])

    # Start the conversation
    contents: list[types.Content] = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    "Here is the current state of the browser. Begin solving the puzzles."
                ),
                types.Part.from_bytes(data=screenshot_bytes, mime_type="image/png"),
            ],
        ),
    ]

    for step in range(max_steps):
        logger.info('[google] Step %d / %d', step + 1, max_steps)

        response = client.models.generate_content(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                tools=[tool_config],
                max_output_tokens=4096,
            ),
        )

        candidate = response.candidates[0]
        # Add assistant response to contents
        contents.append(candidate.content)

        # Check for function calls
        function_calls = [
            part for part in candidate.content.parts
            if part.function_call is not None
        ]

        if not function_calls:
            # Model is done – extract text
            text_parts = [p.text for p in candidate.content.parts if p.text]
            return '\n'.join(text_parts) if text_parts else 'Agent finished without summary.'

        # Process function calls
        fn_response_parts: list[types.Part] = []
        for part in function_calls:
            fn_call = part.function_call
            fn_name = fn_call.name
            fn_args = dict(fn_call.args) if fn_call.args else {}
            logger.debug('[google] function_call: %s %s', fn_name, fn_args)

            if fn_name == 'done':
                if recorder:
                    recorder.log_event(
                        event_type="tool_call",
                        provider="google",
                        step=step + 1,
                        action="done",
                        params=fn_args,
                        result="agent_done",
                        page_state=await _extract_page_state(page),
                        metadata={"summary": fn_args.get("summary", "")},
                    )
                return fn_args.get('summary', 'Agent finished.')

            if fn_name == 'screenshot':
                screenshot_b64 = await _capture_screenshot(page)
                screenshot_bytes = base64.b64decode(screenshot_b64)
                if recorder:
                    recorder.log_event(
                        event_type="tool_call",
                        provider="google",
                        step=step + 1,
                        action="screenshot",
                        params=fn_args,
                        result="screenshot_taken",
                        page_state=await _extract_page_state(page),
                        screenshot_b64=screenshot_b64,
                    )
                fn_response_parts.append(
                    types.Part.from_function_response(
                        name=fn_name,
                        response={"result": "screenshot_taken"},
                    )
                )
            else:
                # Convert args to proper types (Gemini may return floats)
                int_keys = ['x', 'y', 'start_x', 'start_y', 'end_x', 'end_y', 'amount']
                for k in int_keys:
                    if k in fn_args:
                        fn_args[k] = int(fn_args[k])

                result_str = await _handle_action(page, fn_name, fn_args)
                logger.info('[google] Action result: %s', result_str)
                fn_response_parts.append(
                    types.Part.from_function_response(
                        name=fn_name,
                        response={"result": result_str},
                    )
                )
                # Capture updated screenshot
                screenshot_b64 = await _capture_screenshot(page)
                screenshot_bytes = base64.b64decode(screenshot_b64)
                if recorder:
                    recorder.log_event(
                        event_type="tool_call",
                        provider="google",
                        step=step + 1,
                        action=fn_name,
                        params=fn_args,
                        result=result_str,
                        page_state=await _extract_page_state(page),
                        screenshot_b64=screenshot_b64,
                    )

        # Send function responses + updated screenshot back as user message
        contents.append(
            types.Content(
                role="user",
                parts=[
                    *fn_response_parts,
                    types.Part.from_text("Here is the updated screenshot after the actions:"),
                    types.Part.from_bytes(data=screenshot_bytes, mime_type="image/png"),
                ],
            )
        )

    return 'Reached maximum steps without agent signalling completion.'


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def _fetch_puzzle_list(base_url: str) -> list[tuple[str, str]]:
    """Fetch all (puzzle_type, puzzle_id) pairs from the server API."""
    import urllib.request
    url = f"{base_url.rstrip('/')}/api/list_puzzles"
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read().decode())
    puzzles = []
    for ptype, ids in data.items():
        for pid in ids:
            puzzles.append((ptype, pid))
    return puzzles


async def _run_single_puzzle(args: argparse.Namespace) -> int:
    """Single-puzzle mode: solve exactly one specified puzzle, output result, exit."""
    from playwright.async_api import async_playwright

    puzzle_type = args.puzzle_type
    puzzle_id = args.puzzle_id
    width = args.window_width or DEFAULT_WIDTH
    height = args.window_height or DEFAULT_HEIGHT
    provider = args.provider.lower()
    model = args.model or {
        'openai': 'gpt-4o', 'anthropic': 'claude-sonnet-4-20250514', 'google': 'gemini-2.0-flash',
        'mock': 'mock-gt',
    }.get(provider, 'gpt-4o')

    base_url = args.url.split('?')[0].rstrip('/')
    puzzle_url = f"{base_url}?single_puzzle=true&puzzle_type={puzzle_type}&puzzle_id={puzzle_id}"

    out_root = Path(args.output)
    out_root.mkdir(parents=True, exist_ok=True)

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=args.headless)
    context = await browser.new_context(viewport={'width': width, 'height': height})
    page = await context.new_page()
    await page.goto(puzzle_url, wait_until='domcontentloaded')
    await page.wait_for_timeout(2000)

    # openai = the no-done SFT model → use the SFT-matching prompt + 5 tools; other
    # providers (frontier baselines) keep the original done-based prompt + CUSTOM_TOOLS.
    system_prompt = (
        _build_single_puzzle_system_prompt_sft(puzzle_url, width, height)
        if provider == 'openai'
        else _build_single_puzzle_system_prompt(puzzle_url, width, height)
    )
    result = ""
    summary = None

    try:
        if provider == 'openai':
            result = await _run_openai_loop(
                page, model, system_prompt, args.max_steps,
                openai_base_url=getattr(args, 'openai_base_url', None),
                openai_api_key=getattr(args, 'openai_api_key', None),
                limit=1, url=puzzle_url, output_root=args.output,
                tools=SFT_EVAL_TOOLS,
            )
        elif provider == 'anthropic':
            result = await _run_anthropic_loop(
                page, model, system_prompt, args.max_steps, width, height,
            )
        elif provider == 'google':
            result = await _run_google_loop(
                page, model, system_prompt, args.max_steps,
            )
        elif provider == 'mock':
            result = await _run_mock_loop(
                page, system_prompt, args.max_steps,
                limit=1, url=puzzle_url, output_root=args.output,
                mock_gt_dir=getattr(args, 'mock_gt_dir', 'data/Validation'),
            )
        else:
            raise ValueError(f'Unsupported provider: {provider}')
    except Exception as exc:
        logger.error('[single-puzzle] Failed: %s', exc)
        result = f"Error: {exc}"
    finally:
        await context.close()
        await browser.close()
        await pw.stop()

    # Read summary if saved
    puzzle_id_stem = Path(puzzle_id).stem.replace("/", "_").replace(" ", "_")
    summary_path = out_root / f"{puzzle_type}_{puzzle_id_stem}" / "summary.json"
    if summary_path.exists():
        try:
            summary = json.loads(summary_path.read_text(encoding='utf-8'))
        except Exception:
            pass

    correct = summary.get('correct', False) if summary else False
    submitted = summary.get('submitted', False) if summary else False

    print(json.dumps({
        "puzzle_type": puzzle_type,
        "puzzle_id": puzzle_id,
        "submitted": submitted,
        "correct": correct,
        "reward": 1.0 if (submitted and correct) else 0.0,
        "output_dir": str(out_root / f"{puzzle_type}_{puzzle_id_stem}"),
    }, ensure_ascii=False))

    return 0 if correct else 1


async def _run_agent(args: argparse.Namespace) -> int:
    """Launch browser, dispatch to the correct provider loop, and report results."""
    if getattr(args, 'puzzle_type', None) and getattr(args, 'puzzle_id', None):
        return await _run_single_puzzle(args)
    if getattr(args, 'per_puzzle', False):
        return await _run_agent_per_puzzle(args)

    width = args.window_width or DEFAULT_WIDTH
    height = args.window_height or DEFAULT_HEIGHT
    provider = args.provider.lower()

    pw, browser, page = await _launch_browser(
        args.url, args.headless, width, height,
    )

    prompt_limit = args.limit if args.limit > 0 else 999
    system_prompt = _build_system_prompt(args.url, prompt_limit, width, height)
    result = ""

    try:
        if provider == 'openai':
            model = args.model or 'gpt-4o'
            result = await _run_openai_loop(
                page, model, system_prompt, args.max_steps,
                openai_base_url=args.openai_base_url,
                openai_api_key=args.openai_api_key,
                limit=args.limit,
                url=args.url,
                output_root=args.output,
            )
        elif provider == 'anthropic':
            model = args.model or 'claude-sonnet-4-20250514'
            result = await _run_anthropic_loop(
                page, model, system_prompt, args.max_steps, width, height,
            )
        elif provider == 'google':
            model = args.model or 'gemini-2.0-flash'
            result = await _run_google_loop(
                page, model, system_prompt, args.max_steps,
            )
        elif provider == 'mock':
            result = await _run_mock_loop(
                page, system_prompt, args.max_steps,
                limit=args.limit, url=args.url, output_root=args.output,
                mock_gt_dir=getattr(args, 'mock_gt_dir', 'data/Validation'),
            )
        else:
            raise ValueError(f'Unsupported provider "{provider}". Choose from: anthropic, openai, google, mock')
    finally:
        await browser.close()
        await pw.stop()

    print('\n=== Agent Result ===\n')
    print(result)
    print(f'\nOutput directory: {args.output}/')
    return 0


async def _run_agent_per_puzzle(args: argparse.Namespace) -> int:
    """Per-puzzle mode: each puzzle gets a fresh browser context and independent agent session."""
    from playwright.async_api import async_playwright

    width = args.window_width or DEFAULT_WIDTH
    height = args.window_height or DEFAULT_HEIGHT
    provider = args.provider.lower()
    model = args.model or {'openai': 'gpt-4o', 'anthropic': 'claude-sonnet-4-20250514', 'google': 'gemini-2.0-flash', 'mock': 'mock-gt'}.get(provider, 'gpt-4o')

    base_url = args.url.split('?')[0].rstrip('/')  # strip any existing query params

    # Fetch the full puzzle inventory from the server
    all_puzzles = await _fetch_puzzle_list(base_url)
    logger.info('[per-puzzle] Total puzzles available: %d', len(all_puzzles))

    # Apply limit
    max_puzzles = args.limit if args.limit > 0 else len(all_puzzles)
    puzzles_to_run = all_puzzles[:max_puzzles]
    shard_spec = getattr(args, 'shard', None)
    if shard_spec:
        si, sn = (int(x) for x in shard_spec.split('/'))
        puzzles_to_run = puzzles_to_run[si::sn]
        logger.info('[per-puzzle] --shard %d/%d: this lane handles %d of %d puzzles (stride; '
                    'resume-skip dedups overlaps with sibling shards)', si, sn, len(puzzles_to_run), max_puzzles)
    if getattr(args, 'reverse', False):
        puzzles_to_run = puzzles_to_run[::-1]
        logger.info('[per-puzzle] --reverse: traversing %d puzzles back-to-front '
                    '(dual-endpoint sharding; pairs with a forward run on the same --output)',
                    len(puzzles_to_run))

    all_summaries: list[dict[str, Any]] = []
    out_root = Path(args.output)
    out_root.mkdir(parents=True, exist_ok=True)

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=args.headless)

    try:
        rollouts = max(1, getattr(args, 'rollouts', 1) or 1)
        for pidx, (puzzle_type, puzzle_id) in enumerate(puzzles_to_run):
            puzzle_url = f"{base_url}?single_puzzle=true&puzzle_type={puzzle_type}&puzzle_id={puzzle_id}"
            puzzle_id_stem = Path(puzzle_id).stem.replace("/", "_").replace(" ", "_")
            base_task_dir = out_root / puzzle_type.lower() / f"{puzzle_type}_{puzzle_id_stem}"

            for r in range(1, rollouts + 1):
                rollout = r if rollouts > 1 else None
                task_dir = (base_task_dir / f"rollout_{r}") if rollouts > 1 else base_task_dir
                tag = f" rollout {r}/{rollouts}" if rollouts > 1 else ""

                # Skip this (puzzle, rollout) if it already has a saved summary (resume support).
                if (task_dir / "summary.json").exists():
                    logger.info('[per-puzzle] === Puzzle %d / %d%s: %s / %s — SKIP (summary exists) ===', pidx + 1, len(puzzles_to_run), tag, puzzle_type, puzzle_id)
                    continue

                logger.info('[per-puzzle] === Puzzle %d / %d%s: %s / %s ===', pidx + 1, len(puzzles_to_run), tag, puzzle_type, puzzle_id)

                # Fresh browser context per (puzzle, rollout) for full isolation
                context = await browser.new_context(viewport={'width': width, 'height': height})
                page = await context.new_page()
                await page.goto(puzzle_url, wait_until='domcontentloaded')
                await page.wait_for_timeout(2000)

                system_prompt = (
                    _build_single_puzzle_system_prompt_sft(puzzle_url, width, height)
                    if provider == 'openai'
                    else _build_single_puzzle_system_prompt(puzzle_url, width, height)
                )

                try:
                    if provider == 'openai':
                        result = await _run_openai_loop(
                            page, model, system_prompt, args.max_steps,
                            openai_base_url=getattr(args, 'openai_base_url', None),
                            openai_api_key=getattr(args, 'openai_api_key', None),
                            limit=1,
                            url=puzzle_url,
                            output_root=args.output,
                            rollout=rollout,
                            tools=SFT_EVAL_TOOLS,
                        )
                    elif provider == 'anthropic':
                        result = await _run_anthropic_loop(
                            page, model, system_prompt, args.max_steps, width, height,
                        )
                    elif provider == 'google':
                        result = await _run_google_loop(
                            page, model, system_prompt, args.max_steps,
                        )
                    elif provider == 'mock':
                        result = await _run_mock_loop(
                            page, system_prompt, args.max_steps,
                            limit=1, url=puzzle_url, output_root=args.output,
                            mock_gt_dir=getattr(args, 'mock_gt_dir', 'data/Validation'),
                        )
                    else:
                        raise ValueError(f'Unsupported provider: {provider}')
                except Exception as exc:
                    logger.error('[per-puzzle] Puzzle %d%s failed: %s', pidx + 1, tag, exc)
                    result = f"Error: {exc}"
                finally:
                    await context.close()

                # Read the per-(puzzle,rollout) summary if it was saved by the loop
                summary_path = task_dir / "summary.json"
                if summary_path.exists():
                    try:
                        summary = json.loads(summary_path.read_text(encoding='utf-8'))
                        all_summaries.append(summary)
                        logger.info('[per-puzzle] Puzzle %d%s result: submitted=%s correct=%s',
                                    pidx + 1, tag, summary.get('submitted'), summary.get('correct'))
                    except Exception:
                        pass

                print(f'[{pidx + 1}/{len(puzzles_to_run)}{tag}] {puzzle_type}/{puzzle_id} done')

    finally:
        await browser.close()
        await pw.stop()

    # --- Overall run summary ---
    # Aggregate from DISK (every per-puzzle summary.json under out_root), not just this
    # process's in-memory results. Sharded runs launch N processes that all write to the
    # same --output; if each built run_summary from its own shard only, the last writer
    # would clobber the file with a single shard's slice (e.g. 3/50 puzzles). Re-reading
    # the union off disk makes every shard emit a COMPLETE merged summary, so whoever
    # writes last is still correct. Non-sharded runs are unaffected (disk == all_summaries).
    disk_summaries = []
    for _sp in out_root.rglob("summary.json"):
        try:
            disk_summaries.append(json.loads(_sp.read_text(encoding="utf-8")))
        except Exception:
            pass
    if disk_summaries:
        all_summaries = disk_summaries

    total_puzzles = len(all_summaries)
    total_submitted = sum(1 for s in all_summaries if s.get("submitted"))
    total_correct = sum(1 for s in all_summaries if s.get("correct"))
    overall_accuracy = (total_correct / total_puzzles * 100) if total_puzzles else 0.0

    run_summary = {
        "benchmark": "opencaptchaworld",
        "agent": model.split("/")[-1],
        "mode": "per_puzzle",
        "total_puzzles": total_puzzles,
        "total_submitted": total_submitted,
        "total_correct": total_correct,
        "accuracy": round(overall_accuracy, 2),
        "puzzles": [
            {
                "task_id": f"{s.get('puzzle_type', 'unknown')}_{s.get('puzzle_id', 'unknown')}",
                "puzzle_type": s.get("puzzle_type", "unknown"),
                "submitted": s.get("submitted", False),
                "correct": s.get("correct", False),
                "reward": s.get("reward", 0.0),
                "status": s.get("status", "unknown"),
            }
            for s in all_summaries
        ],
    }

    (out_root / "run_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Per-type run_summary inside each <type_lower>/ folder so the web viewer
    # can show "Mock / bingo  N/N correct · X%" using the same schema.
    by_type: dict[str, list[dict[str, Any]]] = {}
    for s in all_summaries:
        by_type.setdefault(s.get("puzzle_type", "unknown"), []).append(s)
    for ptype, summaries in by_type.items():
        t_total = len(summaries)
        t_sub = sum(1 for s in summaries if s.get("submitted"))
        t_cor = sum(1 for s in summaries if s.get("correct"))
        t_acc = (t_cor / t_total * 100) if t_total else 0.0
        type_summary = {
            "benchmark": "opencaptchaworld",
            "agent": model.split("/")[-1],
            "mode": "per_puzzle",
            "puzzle_type": ptype,
            "total_puzzles": t_total,
            "total_submitted": t_sub,
            "total_correct": t_cor,
            "accuracy": round(t_acc, 2),
            "puzzles": [
                {
                    "task_id": f"{s.get('puzzle_type', 'unknown')}_{s.get('puzzle_id', 'unknown')}",
                    "puzzle_type": s.get("puzzle_type", "unknown"),
                    "submitted": s.get("submitted", False),
                    "correct": s.get("correct", False),
                    "reward": s.get("reward", 0.0),
                    "status": s.get("status", "unknown"),
                }
                for s in summaries
            ],
        }
        type_dir = out_root / ptype.lower()
        type_dir.mkdir(parents=True, exist_ok=True)
        (type_dir / "run_summary.json").write_text(
            json.dumps(type_summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    print(f'\n=== Per-Puzzle Results ===')
    print(f'Total: {total_puzzles}, Submitted: {total_submitted}, Correct: {total_correct}, Accuracy: {overall_accuracy:.1f}%')
    print(f'Output: {args.output}/')
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Run a Computer-Use agent on CaptchaArena puzzles (screenshot-based).',
    )
    parser.add_argument('--url', default='http://127.0.0.1:7860',
                        help='URL of the running CaptchaArena server.')
    parser.add_argument('--limit', type=int, default=3,
                        help='Number of puzzle attempts before the agent stops.')
    parser.add_argument(
        '--provider',
        choices=['anthropic', 'openai', 'google', 'mock'],
        default='anthropic',
        help='LLM provider to use. "mock" scripts actions from ground truth — no LLM call.',
    )
    parser.add_argument('--model',
                        help='Override the model name for the selected provider.')
    parser.add_argument(
        '--openai-base-url',
        help='Custom OpenAI-compatible base URL (for vLLM/Qwen/OpenRouter style endpoints).',
    )
    parser.add_argument(
        '--openai-api-key',
        help='Optional OpenAI API key override. If omitted, the SDK uses environment variables.',
    )
    parser.add_argument('--output', '-o', default='runs/analyzed',
                        help='Output root directory for per-puzzle results.')
    parser.add_argument('--max-steps', type=int, default=30,
                        help='Maximum agent reasoning steps.')
    parser.add_argument('--headless', action='store_true',
                        help='Run the browser in headless mode.')
    parser.add_argument('--window-width', type=int,
                        help=f'Browser viewport width (pixels). Default: {DEFAULT_WIDTH}.')
    parser.add_argument('--window-height', type=int,
                        help=f'Browser viewport height (pixels). Default: {DEFAULT_HEIGHT}.')
    parser.add_argument(
        '--trajectory-file',
        help='Write structured step logs to this JSONL file. Default: runs/trajectories/<run_id>.jsonl',
    )
    parser.add_argument(
        '--trajectory-image-dir',
        help='Directory to save trajectory screenshots. Default: runs/trajectories/<run_id>_images',
    )
    parser.add_argument(
        '--no-trajectory-images',
        action='store_true',
        help='Disable saving screenshot files for trajectory logs.',
    )
    parser.add_argument(
        '--disable-trajectory',
        action='store_true',
        help='Disable trajectory JSONL logging entirely.',
    )
    parser.add_argument('--per-puzzle', action='store_true',
                        help='Per-puzzle mode: each puzzle gets a fresh browser context and independent agent session. '
                             'The orchestrator fetches the puzzle list from the server and runs them one by one.')
    parser.add_argument('--rollouts', type=int, default=1,
                        help='Per-puzzle mode: run each puzzle N times into <task>/rollout_<n>/ subdirs (for pass@k). '
                             'Default 1 = no rollout subdir (legacy layout).')
    parser.add_argument('--reverse', action='store_true',
                        help='Per-puzzle mode: traverse the puzzle list back-to-front. '
                             'Run one endpoint forward and another with --reverse on the SAME --output '
                             'to split work across two inference endpoints (resume-skip dedups the middle).')
    parser.add_argument('--shard', type=str, default=None,
                        help='Per-puzzle mode: "i/N" — handle only puzzles[i::N] (disjoint stride shard). '
                             'Run N lanes 0/N..(N-1)/N on the SAME --output, each pointed at any inference '
                             'endpoint, to fan one captcha-server across N GPUs. resume-skip dedups overlaps.')
    parser.add_argument('--puzzle-type',
                        help='Run a single puzzle of this type (requires --puzzle-id). '
                             'Agent solves one puzzle and exits.')
    parser.add_argument('--puzzle-id',
                        help='Run a single puzzle with this ID (requires --puzzle-type).')
    parser.add_argument('--verbose', action='store_true',
                        help='Enable verbose / debug logging.')
    parser.add_argument(
        '--mock-gt-dir', default='data/Validation',
        help='Ground-truth root for --provider mock. Expects <dir>/<puzzle_type>/ground_truth_cu.json.',
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    try:
        return asyncio.run(_run_agent(args))
    except KeyboardInterrupt:
        print('\nInterrupted by user.')
        return 1
    except Exception as exc:  # pylint: disable=broad-except
        logging.exception('Computer-Use agent run failed: %s', exc)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
