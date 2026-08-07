# `computeruse_cli.py` — Tools & Dialog Format

This document describes, for `agent_frameworks/computeruse_cli.py`:

1. The tools (function-calling) the Computer-Use agent can invoke
2. The conversation message format used to drive the agent
3. The on-disk output structure produced for each puzzle

> Source references use the form `computeruse_cli.py:line_no`.

---

## 1. Tool Catalog (12 tools)

The canonical list is `CUSTOM_TOOLS` at `computeruse_cli.py:307`. The OpenAI / OpenRouter channel uses it directly; the Google Gemini channel derives `GEMINI_TOOL_DECLARATIONS` from it (`computeruse_cli.py:517`).

| # | Tool | Purpose | Required | Optional |
|---|---|---|---|---|
| 1 | `screenshot` | Capture the current browser viewport | — | — |
| 2 | `click` | Click at pixel (x, y) | `x`, `y` | `button` (`left` / `right` / `middle`, default `left`) |
| 3 | `double_click` | Double-click at (x, y) | `x`, `y` | — |
| 4 | `type_text` | Type a string at the current caret | `text` | — |
| 5 | `press_key` | Press a single key (e.g. `Enter`, `Tab`, `Escape`, `Backspace`) | `key` | — |
| 6 | `scroll` | Scroll the page at (x, y) | `x`, `y`, `direction` (`up` / `down` / `left` / `right`) | `amount` (pixels, default 300) |
| 7 | `drag` | Drag from (start_x, start_y) to (end_x, end_y) | `start_x`, `start_y`, `end_x`, `end_y` | — |
| 8 | `mouse_down` | Press and hold mouse at (x, y) without releasing — pair with `mouse_move` / `mouse_up` for multi-step drags | `x`, `y` | `button` |
| 9 | `mouse_up` | Release a held mouse button at (x, y) | `x`, `y` | `button` |
| 10 | `mouse_move` | Move the cursor to (x, y) without clicking; while a button is held, this performs the drag motion | `x`, `y` | — |
| 11 | `hold` | Press and hold a single keyboard key **OR** mouse button for `duration_ms` ms | — | `key` or (`button` + `x` + `y`), `duration_ms` (default 500) |
| 12 | `done` | **Termination signal** — call ONLY after Submit has been clicked and feedback observed | `summary` | — |

### Key constraints

- `done` is the agent's only explicit exit signal (`computeruse_cli.py:1172`). The system prompt repeatedly insists: click Submit first, observe feedback, then call `done`.
- For `hold`, `key` and `button` are mutually exclusive (`computeruse_cli.py:478`).
- All coordinates are viewport pixels. Default viewport is `1280 × 1080` (`computeruse_cli.py:30`).

---

## 2. Provider Channel Differences

Three providers are supported; **the tool semantics are identical** — only the schema wrapping differs:

| Provider | How tools are passed | API call | Source |
|---|---|---|---|
| `openai` (incl. OpenRouter) | `tools=CUSTOM_TOOLS, tool_choice="auto"` | `client.chat.completions.create(...)` | `1143` |
| `anthropic` | `tools=[{"type": "computer_20250124", ...}]` (uses Anthropic's native Computer-Use tool, **not** the 12 above) | `client.beta.messages.create(..., betas=["computer-use-2025-01-24"])` | `768` |
| `google` | `types.FunctionDeclaration(**decl) for decl in GEMINI_TOOL_DECLARATIONS` | `genai.Client().models.generate_content(...)` | `1410` |

> **Note**: The `anthropic` channel uses Claude's native Computer-Use tool set (not the 12 function-calling tools). Action schemas differ slightly (e.g. `coordinate: [x, y]` instead of `x` / `y`); the CLI adapts at `computeruse_cli.py:836`.

---

## 3. Dialog (Message) Format

### 3.1 OpenAI / OpenRouter channel

The per-puzzle conversation history (`computeruse_cli.py:1123`) starts with one `system` message and then loops:

```
[
  {"role": "system",    "content": "<system_prompt>"},
  {"role": "user",      "content": [
      {"type": "text",      "text": "Here is the current state of the browser. Solve this puzzle: <puzzle_prompt>"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<screenshot>"}}
  ]},
  {"role": "assistant", "tool_calls": [{"function": {"name": "click", "arguments": "{\"x\":633,\"y\":710}"}, ...}]},
  {"role": "tool",      "tool_call_id": "...", "content": "clicked (633, 710) button=left"},
  {"role": "user",      "content": [
      {"type": "text",      "text": "Action executed: clicked (633, 710) button=left. Here is the updated screenshot:"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<new_screenshot>"}}
  ]},
  ...
  {"role": "assistant", "tool_calls": [{"function": {"name": "done", "arguments": "{\"summary\":\"Solved...\"}"}}]}
]
```

When history exceeds 22 turns it is auto-truncated to `[system] + last 20` (`computeruse_cli.py:1140`).

### 3.2 Anthropic channel

`computeruse_cli.py:778`:

```
messages = [
    {"role": "user", "content": "<system_prompt>"}
]
```

Each `assistant` reply returns a `content` block array which may include `tool_use` blocks. The CLI gathers all `tool_use` results and replies with a single `user` message wrapping each as a `tool_result`:

```
{"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "<id>", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<screenshot>"}}
    ]}
]}
```

### 3.3 Google Gemini channel

Starting at `computeruse_cli.py:1264`. Gemini uses `Content` + `Part` structures: `function_call` / `function_response` parts come in pairs, and screenshots are embedded as `inline_data` `Part`s.

---

## 4. SFT Training Data Format

In addition to the live conversation history, each puzzle also dumps a separate `sft_data.json` (`computeruse_cli.py:896`, `_save_sft_data`).

The format is compatible with Qwen-VL / LLaVA-style SFT:

```json
{
  "id": "Bingo_bingo13",
  "puzzle_type": "Bingo",
  "puzzle_prompt": "...",
  "reward": 1.0,
  "correct": true,
  "conversations": [
    {"role": "system",    "content": "<system_prompt>"},
    {"role": "user",      "content": [
        {"type": "image", "image": "screenshots/screenshot_step_0.png"},
        {"type": "text",  "text": "Here is the current state of the browser..."}
    ]},
    {"role": "assistant", "content": "<think>I see a 3x3 grid...</think>\nclick({\"x\": 633, \"y\": 710})"},
    {"role": "user",      "content": [
        {"type": "image", "image": "screenshots/screenshot_step_1.png"},
        {"type": "text",  "text": "Action executed: clicked (633, 710) button=left. Here is the updated screenshot:"}
    ]}
  ]
}
```

Highlights:
- `<think>...</think>` wraps the LLM's reasoning, immediately followed by an executable `tool_name(args)` call string.
- `image` is a relative path to `screenshots/screenshot_step_N.png`.
- `reward = 1.0` iff `submitted == True` AND `correct == True`.

---

## 5. Per-Puzzle Output Layout

Each puzzle is saved to `{output_root}/{puzzle_type}_{puzzle_id}/` (`computeruse_cli.py:1087`):

```
{output_root}/{puzzle_type}_{puzzle_id}/
├── metafile.json          # benchmark info + every step's thinking / action / result
├── sft_data.json          # multi-turn SFT conversation (see §4)
├── summary.json           # machine-readable: submitted / correct / reward / transitions
├── summary.md             # human-readable: per-step thinking + action + screenshot refs
├── trajectory.jsonl       # raw event stream, one event per line (TrajectoryRecorder, line 34)
└── screenshots/
    ├── screenshot_step_0.png
    ├── screenshot_step_1.png
    └── ...
```

After the entire run finishes, a `run_summary.json` is written at the `output_root` level (overall accuracy, `computeruse_cli.py:1675`).

### `metafile.json` key fields (`computeruse_cli.py:1305`)

```json
{
  "benchmark": "opencaptchaworld",
  "agent": "gemini-3.1-flash-lite-preview",
  "task_id": "Bingo_bingo13",
  "summary_info": {"cum_reward": 1.0},
  "goal": "<puzzle_prompt>",
  "steps": [
    {
      "screenshot_path": "screenshots/screenshot_step_1.png",
      "reasoning": "<assistant content>",
      "action": "click({\"x\": 633, \"y\": 710})",
      "result": "clicked (633, 710) button=left"
    },
    ...
  ]
}
```

### `summary.json` key fields (`computeruse_cli.py:290`)

```json
{
  "puzzle_type": "Bingo",
  "puzzle_id": "bingo13",
  "prompt": "...",
  "submitted": true,
  "correct": true,
  "reward": 1.0,
  "status": "ok",
  "total_steps": 7,
  "transitions": [
    {"step": 0, "action": "screenshot", "image": "screenshots/screenshot_step_0.png", "reasoning": "...", "result": "screenshot_taken"},
    ...
  ]
}
```

---

## 6. Auto-stop Conditions

The per-puzzle loop exits on any of these (OpenAI channel, `computeruse_cli.py:1136`):

1. The model returns **plain text with no tool_calls** (`1158`) — treated as puzzle finished.
2. The model calls `done` (`1172`) — explicit termination.
3. **`stats.total` increments on the page** (Submit was clicked and the next puzzle auto-loaded) (`1240`) — early exit for this puzzle.
4. Step count reaches `--max-steps` (default 30; this project's runner uses 15) — forced exit.

After exit, the CLI inspects the page's feedback class to decide `submitted` / `correct` (`computeruse_cli.py:240`).

---

## 7. Reference Index

| Concept | Location |
|---|---|
| Full tool definitions | `computeruse_cli.py:307` |
| Gemini tool derivation | `computeruse_cli.py:517` |
| Default viewport | `computeruse_cli.py:30` |
| OpenAI main loop | `computeruse_cli.py:1002` |
| Anthropic main loop | `computeruse_cli.py:752` |
| Google main loop | `computeruse_cli.py:1393` |
| Single-puzzle mode | `computeruse_cli.py:1433` |
| Per-puzzle mode | `computeruse_cli.py:1565` |
| System prompt (multi-puzzle) | `computeruse_cli.py:526` |
| System prompt (single-puzzle) | `computeruse_cli.py:557` |
| SFT data writer | `computeruse_cli.py:896` |
| `summary.md` writer | `computeruse_cli.py:833` |
| Output directory naming | `computeruse_cli.py:1087` |
