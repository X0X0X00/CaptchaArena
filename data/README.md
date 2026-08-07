# Data

The puzzle data is **not** stored in this repository — it is ~100 GB of images and
ground truth, hosted on the Hugging Face Hub.

```
https://huggingface.co/datasets/ZHEN-04/Captcha
```

## Layout expected by the code

`app.py` reads puzzle directories from `CAPTCHA_DATA_DIRS` (comma-separated, default
`captcha_data_gen,captcha_data`). Point it at whichever split you downloaded:

```
data/
├── Train/<Type>_2100/         # ground_truth.json, ground_truth_cu.json, *.png
├── Val/<Type>_200/
├── Test/<Type>_200/
└── Validation/<Type>/         # hand-curated split, bare type names (no count suffix)
```

Each puzzle directory holds the images plus two ground-truth files:

- `ground_truth.json` — raw answers (indices, coordinates, text) + `tolerance`
- `ground_truth_cu.json` — the same answers as explicit computer-use tool-call
  sequences (`answer_cu`), which is what the agent and the mock replay execute

## Download

```bash
pip install huggingface_hub
huggingface-cli login          # the dataset is private; ask the authors for access

# everything (~100 GB)
huggingface-cli download ZHEN-04/Captcha --repo-type dataset --local-dir data

# or a single split
huggingface-cli download ZHEN-04/Captcha --repo-type dataset \
  --include "Validation/*" --local-dir data
```

Then run the server against it:

```bash
CAPTCHA_DATA_DIRS=data/Validation python app.py     # :7860
```

## Note on coordinates

All spatial ground truth is stored in **image-natural pixels** with the origin at the
top-left. The page renders each puzzle at a fixed 1280x1080 viewport, and the frontend
scale-corrects clicks back to natural pixels, so `answer_cu` viewport coordinates stay
valid as long as the page layout is unchanged.
