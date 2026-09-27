# CaptchaArena

**A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs**

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
  <a href="https://x0x0x00.github.io/"><img src="https://img.shields.io/badge/Paper-under%20review-lightgrey" alt="Paper"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

![The 20 puzzle types, captured from the live benchmark pages](assets/overview.jpg)

This repository is the code behind CaptchaArena: the Flask server that renders 20
families of modern CAPTCHA as live web pages at a fixed 1280x1080 viewport and grades
answers, the screenshot-only computer-use agent that plays them, a gallery for browsing
the dataset on its live pages, and a viewer for agent runs and trajectories. An agent gets
screenshots and nothing else; it answers by moving the mouse and typing, and the page's
own checker decides whether it was right.

The puzzles and the reasoning-annotated trajectories live on the Hugging Face Hub (see
[Getting the data](#getting-the-data)). The dataset design, CaptchaAgent and all results
are in the paper (see [Citation](#citation)).

## Updates

- **2026-08-11** — Trajectory release: chain-of-thought computer-use rollouts that solve
  the `Train` and `Val` puzzles, one sample per turn, on the Hugging Face Hub.
- **2026-08-08** — Code release: the benchmark server, the screenshot agent, the dataset
  gallery and the trajectory viewer.
- **2026-08-07** — Dataset release: 50,000 puzzles across `Train` / `Val` / `Test`, on the
  Hugging Face Hub.

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
  `tolerance` used when grading it. Where the target is an irregular shape, the entry
  points at a binary mask instead, and a click is correct when it lands on a white pixel.
- `ground_truth_cu.json` — the same answer written out as agent actions:

```jsonc
"answer_cu": [
  {"action": "click", "arguments": {"x": 619, "y": 132}},
  {"action": "click", "arguments": {"x": 640, "y": 924}}
]
```

The second form is executable, which is the point. The bundled `mock` provider drives a
browser through `answer_cu` and submits to the real grader, so a split can prove itself:
anything short of 100% is a defect in the data, not in a model. We use it as a gate before
publishing any regenerated split.

Spatial answers are stored in **image-natural pixels**, origin top-left. The frontend
scale-corrects clicks back into that frame, so the stored answer stays valid however the
image is displayed.

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

## Getting the data

Both datasets are on the Hugging Face Hub, gated and CC BY-NC 4.0 — request access on the
dataset page, then `hf auth login`. Requests are reviewed once the paper is on arXiv; you
can file one before then and it will wait in the queue.

- **Puzzles** — [ZHEN-04/CaptchaArena](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)
  · images and ground truth for `Train` / `Val` / `Test`
- **Trajectories** — [ZHEN-04/CaptchaArena-Trajectories](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)
  · solved chain-of-thought rollouts over `Train` / `Val`, for fine-tuning

```bash
hf download ZHEN-04/CaptchaArena --repo-type dataset --local-dir data
```

One thing the dataset card does not cover: directory names carry their size
(`Train/Bingo_2100`, `Test/Bingo_200`), and that suffixed name is what the API expects as
`puzzle_type`. See [data/README.md](data/README.md).

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
  --limit 200 --max-steps 30 --headless \
  --output data/Output/<provider>/<model>
```

`--provider` takes `anthropic`, `google`, `mock`, or `openai` — the last of which is any
endpoint speaking the OpenAI chat-completions protocol, so a locally served checkpoint
under vLLM or SGLang works the same as a hosted API. Every puzzle leaves behind
`metafile.json`, `summary.json`, `trajectory.jsonl` and a `screenshots/` folder.

### 3. Check the data with the mock provider

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 \
  --puzzle-type Geometry_Click_200 --puzzle-id image1.png \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

No model is involved; the recorded actions are replayed in the browser. It is the quickest
way to confirm a fresh download, a code change, or a regenerated split is intact.

## Browsing the dataset

```bash
GALLERY_DATA_ROOT=data GALLERY_CAPTCHA_URL=http://127.0.0.1:7860 \
  python gallery/app.py                         # http://127.0.0.1:48040
```

Split and type on the left, thumbnails on the right.

![Dataset gallery](assets/gallery.jpg)

Clicking a thumbnail does not open a picture — it opens that puzzle's *live* page beside
its ground truth, so you can try it yourself under exactly the conditions an agent faces.

![A puzzle opened on its live page, with the ground truth beside it](assets/gallery_live.jpg)

## Release status

What is out, and what is still coming.

- [x] **Benchmark and agent** — this repository: the server, the 20 puzzle families, the
      screenshot agent, the dataset gallery and the trajectory viewer.
- [x] **Dataset** — `Train` / `Val` / `Test`, both ground-truth formats,
      [on the Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena) (gated, CC BY-NC 4.0;
      access requests are reviewed once the paper is on arXiv).
- [x] **Training trajectories** — 46,000 chain-of-thought computer-use rollouts over the
      `Train` and `Val` puzzles, one sample per turn,
      [on the Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories).
- [ ] **CaptchaAgent weights** — the Qwen3.5-9B checkpoints after SFT and after GRPO.
- [ ] **Training code** — supervised fine-tuning, plus the multi-turn GRPO setup that
      drives this environment as a live rollout target (DeepSpeed ZeRO-3, Liger FLCE,
      distributed checkpointing).
- [ ] **Puzzle generators** — the scripts that render each family, for anyone who wants
      more data than the shipped splits, or a new puzzle type.
- [ ] **Human baseline** — annotators solving the whole `Test` split through this same
      page, so agent scores have something to be measured against.
- [ ] **Paper** — under review. The arXiv preprint will also open dataset access.

## Citation

The paper is under review. Until the preprint is out, please cite the work as:

```bibtex
@misc{zhang2026captchaarena,
  title  = {CaptchaArena: A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs},
  author = {Zhang, Zhenhao and Fan, Zhaoyu and Ying, Haohan and Hu, Jingwen and Fan, Hancen and Zhou, Junhao and Chen, Zitian and Zhu, Linchao},
  year   = {2026},
  note   = {Under review}
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
