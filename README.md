# CaptchaArena

<p align="center"><b>A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs</b></p>

<p align="center">
  <a href="https://x0x0x00.github.io/">Zhenhao Zhang</a><sup>1,*</sup>, Zhaoyu Fan<sup>2</sup>, Haohan Ying<sup>3</sup>, Jingwen Hu<sup>3</sup>, Hancen Fan<sup>1</sup>, Junhao Zhou<sup>4</sup>, Zitian Chen<sup>1</sup>, <a href="https://ffmpbgrnn.github.io/">Linchao Zhu</a><sup>2,†</sup><br>
  <sup>1</sup>Columbia University &nbsp;·&nbsp; <sup>2</sup>Zhejiang University &nbsp;·&nbsp; <sup>3</sup>University of Rochester &nbsp;·&nbsp; <sup>4</sup>University of Illinois at Urbana-Champaign<br>
  <sup>*</sup>Project lead &nbsp;·&nbsp; <sup>†</sup>Corresponding author
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena"><img src="https://img.shields.io/badge/🤗%20Bench-gated-orange" alt="Bench"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories"><img src="https://img.shields.io/badge/🤗%20Trajectories-gated-orange" alt="Trajectories"></a>
  <a href="https://arxiv.org/abs/2609.31957"><img src="https://img.shields.io/badge/arXiv-2609.31957-b31b1b.svg" alt="arXiv"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

![The 20 puzzle types, captured from the live benchmark pages](assets/overview.jpg)

This repository is the code behind CaptchaArena: the Flask server that renders the 20
CAPTCHA families as live web pages at a fixed 1280x1080 viewport and grades answers, the
screenshot-only computer-use agent that plays them, a gallery for browsing the dataset on
its live pages, and a viewer for agent runs and trajectories.

The puzzles and the reasoning-annotated trajectories live on the Hugging Face Hub (see
[Getting the data](#getting-the-data)). The dataset design, CaptchaAgent and all results
are in the [paper](https://arxiv.org/abs/2609.31957).

## Updates

- **2026-09-25** — Paper released on arXiv:
  [arXiv:2609.31957](https://arxiv.org/abs/2609.31957).
- **2026-08-11** — Trajectory release: the reasoning-annotated trajectories over
  `Train` / `Val`, on the Hugging Face Hub.
- **2026-08-08** — Code release: the benchmark server, the screenshot agent, the dataset
  gallery and the trajectory viewer.
- **2026-08-07** — Dataset release: the `Train` / `Val` / `Test` puzzles, on the Hugging
  Face Hub.

## Table of Contents

- [Updates](#updates)
- [Ground truth](#ground-truth)
- [Repository layout](#repository-layout)
- [Setup](#setup)
- [Getting the data](#getting-the-data)
- [Running it](#running-it)
- [Browsing the dataset](#browsing-the-dataset)
- [Release status](#release-status)
- [Citation](#citation)
- [License](#license)
- [Credits](#credits)
- [Contact](#contact)

## Ground truth

Every puzzle directory carries two files:

- `ground_truth.json` — the answer in its raw form (indices, coordinates, text) with the
  `tolerance` used when grading it. Irregular targets carry a `mask_path` to a binary
  mask instead, relative to the puzzle directory: under `answer.valid_area` for
  `Geometry_Click` and `Pick_Area`, top-level for `Misleading_Click`. White (>127) marks
  the target — or, for `Misleading_Click`, the character to avoid.
- `ground_truth_cu.json` — the same answer written out as agent actions (`answer_cu`):

```jsonc
"answer_cu": [
  {"action": "click", "arguments": {"x": 619, "y": 132}},
  {"action": "click", "arguments": {"x": 640, "y": 924}}
]
```

`action` is one of `click`, `drag`, `type_text` or `hold`, with the same `arguments` the
agent's tools take (`x`/`y`; `start_x`, `start_y`, `end_x`, `end_y`; `text`; optional
`duration_ms`). For `Bingo` and the arrow-cycle types, `answer_cu` is a list of
alternative sequences rather than one sequence; the replay takes the first.
`Geometry_Click`, `Pick_Area`, `Misleading_Click` and `Hold_Button` submit on their own,
so their sequences end without a submit click.

`answer_cu` is what the `mock` provider replays and submits to the real grader — see
[step 3](#3-check-the-data-with-the-mock-provider). An intact split scores 100%.

Two coordinate frames are in play. `ground_truth.json` targets and masks are in
**image-natural pixels**, origin top-left; the page maps clicks on the image back into
that frame before grading. The tool-call form of `answer_cu` shown above is in absolute
pixels of the fixed 1280x1080 page and is executed as-is. Legacy entries whose
`answer_cu_kind` is `single_xy`, `multi_xy`, `multi_swap` or `drag` are image-natural,
and the mock replay converts them at run time.

## Repository layout

```
CaptchaArena/
├── app.py                    # Flask server: serves puzzle pages, grades answers
├── agent_frameworks/
│   └── computeruse_cli.py    # the screenshot agent (anthropic / openai / google / mock)
├── templates/ static/        # the benchmark page itself
├── gallery/
│   └── app.py                # dataset browser: thumbnails + live puzzle pages
├── web/                      # React viewer for agent runs and trajectories
├── data/                     # where the downloaded dataset goes (see data/README.md)
├── requirements.txt
└── Dockerfile
```

## Setup

```bash
pip install -r requirements.txt
playwright install chromium
```

The server and the agent both run on Python 3.10+.

The server can also run from the bundled `Dockerfile`: the image holds the code and
Chromium, and expects the dataset mounted at `/app/data`:

```bash
docker build -t captcha-arena .
docker run -p 7860:7860 -v "$PWD/data:/app/data" captcha-arena    # serves data/Test
```

Pass `-e CAPTCHA_DATA_DIRS=data/Val` to serve another split.

## Getting the data

Both datasets are on the Hugging Face Hub, gated and CC BY-NC 4.0 — request access on the
dataset page, then `hf auth login`.

- **Puzzles** — [ZHEN-04/CaptchaArena](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)
  · images and ground truth for `Train` / `Val` / `Test`
- **Trajectories** — [ZHEN-04/CaptchaArena-Trajectories](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)
  · solved chain-of-thought rollouts over `Train` / `Val`, for fine-tuning

```bash
hf download ZHEN-04/CaptchaArena --repo-type dataset --local-dir data
```

One thing the dataset card does not say: the size-suffixed directory name
(`Train/Bingo_2100`, `Test/Bingo_200`) is exactly what the API expects as `puzzle_type`,
not `Bingo`. See [data/README.md](data/README.md).

## Running it

### 1. Serve the puzzles

```bash
CAPTCHA_DATA_DIRS=data/Test python app.py       # http://127.0.0.1:7860
```

Jump straight to one puzzle:

```
http://127.0.0.1:7860/?single_puzzle=true&puzzle_type=Geometry_Click_200&puzzle_id=image1.png
```

![The benchmark page an agent is scored on](assets/benchmark_page.jpg)

### 2. Point an agent at it

```bash
python -m agent_frameworks.computeruse_cli \
  --provider openai --model <model> \
  --openai-base-url <endpoint> --openai-api-key <key> \
  --url http://127.0.0.1:7860 \
  --per-puzzle --limit 0 --max-steps 15 --headless \
  --output data/Output/<provider>/<model>
```

`--provider` takes `anthropic`, `google`, `mock`, or `openai` — the last of which is any
endpoint speaking the OpenAI chat-completions protocol, so a locally served checkpoint
under vLLM or SGLang works the same as a hosted API. `anthropic` and `google` read
`ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` from the environment; `.env.example` lists the
other knobs (nothing loads `.env`, so export what you need).

`--per-puzzle` plays every puzzle the server lists, each in a fresh browser context;
`--limit 0` means all of them, and `--max-steps 15` is the step cap used in the paper.
Re-running with the same `--output` skips puzzles that already have a `summary.json`;
`--shard i/N` splits the list across N processes writing to the same `--output`, and
`--rollouts N` plays each puzzle N times into `rollout_<n>/`.

With `openai` or `mock`, each puzzle is written to `<output>/<type>/<Type>_<id>/` —
`metafile.json`, `summary.json`, `trajectory.jsonl` and a `screenshots/` folder — and the
whole run to `<output>/run_summary.json`. The `anthropic` and `google` loops only print
their result and write nothing under `--output`.

### 3. Check the data with the mock provider

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 \
  --puzzle-type Geometry_Click_200 --puzzle-id image1.png \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

No model is involved; the recorded actions are replayed in the browser. To replay a whole
split, drop `--puzzle-type`/`--puzzle-id` and add `--per-puzzle --limit 0`; `accuracy` in
`<output>/run_summary.json` should come back as `100.0`:

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 --per-puzzle --limit 0 \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

### 4. View the runs

```bash
cd web && npm install
VITE_CAPTCHA_SERVER_URL=http://127.0.0.1:7860 npm run dev    # http://127.0.0.1:5173
```

Needs Node.js. **Output Runs** lists everything under `data/Output/<provider>/<model>/`
(the `--output` from step 2; override with `CAPTCHA_RUNS_ROOT`) and steps through each
trajectory. **Dataset** browses the splits under `data/` (`CAPTCHA_DATA_ROOT`) on their
live pages, served by the server from step 1; without `VITE_CAPTCHA_SERVER_URL` it looks
for that server on port 47860.

## Browsing the dataset

```bash
GALLERY_DATA_ROOT=data GALLERY_CAPTCHA_URL=http://127.0.0.1:7860 \
  python gallery/app.py                         # http://127.0.0.1:48040
```

Split and type on the left, thumbnails on the right.

![Dataset gallery](assets/gallery.jpg)

Clicking a thumbnail opens that puzzle's live benchmark page beside its ground truth; the
*Raw image* toggle shows the source picture instead. The live page is proxied from
`GALLERY_CAPTCHA_URL`, so the server from step 1 must be running; it looks the puzzle up
under `CAPTCHA_DATASET_ROOT/<split>/` (default `data`), independent of
`CAPTCHA_DATA_DIRS`.

![A puzzle opened on its live page, with the ground truth beside it](assets/gallery_live.jpg)

## Release status

What is out, and what is still coming.

- [x] **Benchmark and agent** — this repository: the server, the 20 puzzle families, the
      screenshot agent, the dataset gallery and the trajectory viewer.
- [x] **Dataset** — `Train` / `Val` / `Test` puzzles with both ground-truth files,
      [on the Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena).
- [x] **Training trajectories** — reasoning-annotated trajectories over `Train` / `Val`,
      one per puzzle,
      [on the Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories).
- [x] **Paper** — [arXiv:2609.31957](https://arxiv.org/abs/2609.31957).
- [ ] **CaptchaAgent weights** — the Qwen3.5-9B checkpoints after SFT and after GRPO.
- [ ] **Training code** — supervised fine-tuning, plus the multi-turn GRPO setup that
      drives this environment as a live rollout target (configuration: paper, App. K
      and L).
- [ ] **Puzzle generators** — the scripts that render each family.
- [ ] **Human baseline data** — the per-puzzle records of the two annotators who solved
      the whole `Test` split through this page (the study harness ships in `app.py`,
      gated on `STUDY_STORE`).

## Citation

If you use CaptchaArena, please cite:

```bibtex
@article{zhang2026captchaarena,
  title   = {CaptchaArena: A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs},
  author  = {Zhang, Zhenhao and Fan, Zhaoyu and Ying, Haohan and Hu, Jingwen and Fan, Hancen and Zhou, Junhao and Chen, Zitian and Zhu, Linchao},
  journal = {arXiv preprint arXiv:2609.31957},
  year    = {2026}
}
```

## License

The code in this repository is MIT — see [LICENSE](LICENSE).

The datasets are not: both are released under **CC BY-NC 4.0** with gated access, for
non-commercial academic research only.

## Credits

`app.py`, the page template and the frontend script began as
[OpenCaptchaWorld](https://github.com/MetaAgentX/OpenCaptchaWorld) and are redistributed
here under its MIT license. The generators, all shipped puzzle data, the computer-use
agent, the gallery and the trajectory viewer were written for this project.

## Contact

Questions about the benchmark, the data or the paper: open an issue, or write to
Zhenhao Zhang (project lead; now at Columbia University) at zz3530@columbia.edu.
Homepage: [x0x0x00.github.io](https://x0x0x00.github.io/) ·
[Google Scholar](https://scholar.google.com/citations?user=yR55AfsAAAAJ) ·
[GitHub](https://github.com/X0X0X00).
