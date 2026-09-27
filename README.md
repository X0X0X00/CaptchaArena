# CaptchaArena

**A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs**

<p align="center">
  <a href="https://x0x0x00.github.io/">Zhenhao Zhang</a><sup>*</sup>, Zhaoyu Fan, Haohan Ying, Jingwen Hu, Hancen Fan, Junhao Zhou, Zitian Chen, <a href="https://ffmpbgrnn.github.io/">Linchao Zhu</a><sup>†</sup><br>
  College of Computer Science and Technology, Zhejiang University<br>
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

CaptchaArena is a training dataset and a live environment for computer-use agents, built
around 20 families of modern CAPTCHA served as real web pages at a fixed 1280x1080
viewport. An agent gets screenshots and nothing else; it answers by moving the mouse and
typing, and the page's own checker decides whether it was right.

The release has three parts:

- **50,000 puzzles** across `Train` / `Val` / `Test`, covering 20 types and five
  interaction modes: single-click, multi-click, arrow-cycle, real-time and text-entry.
  Every puzzle carries an executable reference solution that has been replayed in a real
  browser and accepted by the page's verifier, so a whole split can be checked without
  ever calling a model.
- **46,000 reasoning-annotated trajectories** that solve the `Train` and `Val` puzzles
  step by step, one training sample per turn, for supervised fine-tuning.
- **CaptchaAgent**, a single Qwen3.5-9B policy for all 20 types, trained with SFT and then
  GRPO against the live verifier. It reaches 71.7 Pass@1 on `Test`, up from 11.4 for the
  base model; humans reach 94.1. See [Results](#results).

## Updates

- **2026-08-11** — Trajectory release: chain-of-thought computer-use rollouts that solve
  the `Train` and `Val` puzzles, one sample per turn, on the Hugging Face Hub.
- **2026-08-08** — Code release: the benchmark server, the screenshot agent, the dataset
  gallery and the trajectory viewer.
- **2026-08-07** — Dataset release: 50,000 puzzles across `Train` / `Val` / `Test`, on the
  Hugging Face Hub.

## Table of Contents

- [Updates](#updates)
- [Why a live page](#why-a-live-page)
- [The 20 puzzle types](#the-20-puzzle-types)
- [Ground truth](#ground-truth)
- [Results](#results)
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

## Why a live page

A CAPTCHA is not a labelling problem. Almost none of the interesting ones can be answered
by looking: you step an object round with arrow buttons until it lines up, you drag a
slider until the notch catches, you swap two tiles, you hold a button down and wait, you
click a spot that only exists after the page has laid itself out. Flatten that into a
static image plus a text answer and the part that is actually hard disappears.

So CaptchaArena keeps the page:

- **Rendered, not pre-baked.** Flask serves every puzzle and a real browser draws it at a
  locked 1280x1080 viewport, which is what makes pixel coordinates comparable between two
  models, or between the same model on two different days.
- **Screenshot in, mouse out.** The agent's whole observation is a screenshot, and its
  whole action space is five tools — `screenshot`, `click`, `drag`, `type_text` and
  `hold`. Submitting ends the episode. It is given no puzzle
  metadata, no DOM, and no benchmark API.
- **Graded by the page.** Correctness comes from `/api/check_answer`, the same endpoint a
  human clicking Submit goes through. There is no separate offline scorer to drift from.
  Irregular targets are graded against a pixel mask rather than a point and a radius, so
  "click the largest outlined area" is judged on the shape itself.
- **Multi-step by nature.** Reference solutions run from one action to 22. Seventeen of
  the twenty categories need at most six; `Unusual_Detection` and `Rotation_Match` reach
  seven and eight; `Patch_Select` is the long tail, with a median of 8 and a 90th
  percentile of 12. A score therefore reflects perception, grounding *and* ordering
  rather than a single guess.

## The 20 puzzle types

The instruction column is the literal text rendered on the page. "Actions" is the mean
length of the ground-truth solution measured over the `Test` split; the benchmark page
shows the same number as a 1–5 star rating.

| Type | Interaction | Instruction on the page | Actions |
|---|---|---|---|
| `Geometry_Click` | click | *Click on the cone.* | 1.0 |
| `Hold_Button` | press and hold | *Hold the button until it finishes loading.* | 1.0 |
| `Misleading_Click` | click | *Click the image to continue.* | 1.0 |
| `Pick_Area` | click | *Click on the center of the largest area outlined by the dotted line* | 1.0 |
| `Place_Dot` | click, submit | *Click to place a Dot at the end of the car's path* | 2.0 |
| `Select_Animal` | click, submit | *Pick a rooster* | 2.0 |
| `Object_Match` | arrow cycling | *Use the arrows to change the number of objects until it matches the left image.* | 2.8 |
| `Coordinates` | arrow cycling | *Using the arrows, move Jerry to the indicated seat* | 2.8 |
| `Bingo` | tile swap | *...click two images to exchange their position to line up the same images to a line* | 3.0 |
| `Dice_Count` | type a number | *Sum up the numbers on all the dice* | 3.0 |
| `Slide_Puzzle` | drag | *Drag the slider component to the correct position* | 3.0 |
| `Image_Matching` | arrow cycling | *Using the arrows, match the animal in the left and right image.* | 3.1 |
| `Connect_icon` | arrow cycling | *Using the arrows, connect the same two icons with the dotted line as shown on the left.* | 3.5 |
| `Dart_Count` | arrow cycling | *Use the arrows to pick the image where all the darts add up to the number in the left image.* | 3.7 |
| `Path_Finder` | arrow cycling | *Use the arrows to select the image where the object is on the spot marked by the X.* | 3.7 |
| `Image_Recognition` | grid multi-select | *Select all images containing a bicycle, then click submit* | 4.4 |
| `Unusual_Detection` | grid multi-select | *Select all the unusual images* | 4.5 |
| `Rotation_Match` | arrow cycling | *Use the arrows to rotate the object so it points in the same direction as the reference hand.* | 4.5 |
| `Click_Order` | ordered clicks | *Click the icons in order as shown in the reference image.* | 5.1 |
| `Patch_Select` | grid multi-select | *Select all squares with garden trowel* | 8.5 |

Seven of the types share one arrow-cycling widget: a left and a right button that page
through candidate images. They look alike and behave alike, but the underlying decision —
count darts, match a rotation, follow a path — is different in each, which makes them a
useful controlled comparison.

The paper groups the twenty into five interaction modes: single-click, multi-click,
arrow-cycle, real-time (holding a button until it finishes loading) and text-entry.

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

## Results

The paper trains **CaptchaAgent**, one Qwen3.5-9B policy for all 20 puzzle types, and
scores it on the `Test` split through the same screenshot-in, mouse-out loop as every
other model. Pass@1, in percent:

| Model | Pass@1 on `Test` |
|---|---|
| Qwen3.5-9B, base | 11.4 |
| CaptchaAgent, after SFT on 37.6K per-turn samples | 70.5 |
| CaptchaAgent, after SFT and GRPO | **71.7** |
| Strongest open-weight GUI agent evaluated | 35.2 |
| Strongest closed-source model evaluated | 69.2 |
| Human | 94.1 |

The GRPO stage uses the page's verifier as its only reward: no reward model and no human
labels. The gain carries over to benchmarks the policy never trained on, from 47.2 to 51.0
on [Open CaptchaWorld](https://github.com/MetaAgentX/OpenCaptchaWorld) and from 13.6 to
20.0 on Halligan. Per-type error analysis puts the remaining failures in three places: the
agent does not submit, it grounds the wrong pixel, or it executes an otherwise correct
plan unstably.

The SFT data is the trajectory dataset: the verified screenshot-and-action rollouts of the
`Train` and `Val` puzzles, annotated with step-by-step reasoning by a teacher model,
screened by a cross-family VLM judge for consistency with the action, absence of hindsight
and decisiveness, regenerated on judge feedback, and verified once more by a stronger
model. The dataset card lists the models used at each stage.

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
- [ ] **Human baseline** — the per-puzzle annotations behind the 94.1 in
      [Results](#results): annotators solving the whole `Test` split through this same page.
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
