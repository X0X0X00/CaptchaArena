# Data

The puzzle data is **not** stored in this repository — it is hosted on the Hugging Face
Hub:

```
https://huggingface.co/datasets/ZHEN-04/CaptchaArena
```

Solved agent trajectories over the `Train` and `Val` puzzles are a separate dataset —
chain-of-thought rollouts in per-turn SFT format, for training rather than evaluating:

```
https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories
```

Both datasets are gated and released under CC BY-NC 4.0 (non-commercial academic
research), so each needs an approved access request and `hf auth login` before it will
download. Nothing in this repository reads the trajectories; the benchmark server only
needs the puzzles.

## Download

```bash
pip install -U huggingface_hub
hf auth login          # gated: request access on the dataset page first

# everything
hf download ZHEN-04/CaptchaArena --repo-type dataset --local-dir data

# or a single split
hf download ZHEN-04/CaptchaArena --repo-type dataset \
  --include "Test/*" --local-dir data
```

## Layout expected by the code

`app.py` reads puzzle directories from `CAPTCHA_DATA_DIRS` (comma-separated, default
`captcha_data_gen,captcha_data`). Point it at whichever split you downloaded:

```
data/
├── Train/<Type>_2100/    # ground_truth.json, ground_truth_cu.json, images
├── Val/<Type>_200/
└── Test/<Type>_200/
```

The `_<count>` suffix is part of the directory name and part of the `puzzle_type` the API
expects — `Test/Bingo_200`, not `Test/Bingo`.

Each puzzle directory holds the images plus two ground-truth files:

- `ground_truth.json` — raw answers (indices, coordinates, text) + `tolerance`
- `ground_truth_cu.json` — the same answers as explicit computer-use tool-call
  sequences (`answer_cu`), which is what the agent and the mock replay execute

Then run the server against it:

```bash
CAPTCHA_DATA_DIRS=data/Test python app.py     # :7860
```

## Note on coordinates

All spatial ground truth is stored in **image-natural pixels** with the origin at the
top-left. The page renders each puzzle at a fixed 1280x1080 viewport, and the frontend
scale-corrects clicks back to natural pixels, so `answer_cu` viewport coordinates stay
valid as long as the page layout is unchanged.
