# CaptchaArena

<p align="center"><b>A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs</b></p>

<p align="center">
  <a href="https://x0x0x00.github.io/">Zhenhao Zhang</a><sup>1,*</sup>, Zhaoyu Fan<sup>2</sup>, Haohan Ying<sup>3</sup>, Jingwen Hu<sup>3</sup><br>
  Hancen Fan<sup>1</sup>, Junhao Zhou<sup>4</sup>, Zitian Chen<sup>1</sup>, <a href="https://ffmpbgrnn.github.io/">Linchao Zhu</a><sup>2,†</sup><br>
  <sup>1</sup>哥伦比亚大学 &nbsp;·&nbsp; <sup>2</sup>浙江大学<br>
  <sup>3</sup>罗切斯特大学 &nbsp;·&nbsp; <sup>4</sup>伊利诺伊大学厄巴纳-香槟分校<br>
  <sup>*</sup>项目负责人 &nbsp;·&nbsp; <sup>†</sup>通讯作者
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena"><img src="https://img.shields.io/badge/🤗%20Bench-gated-orange" alt="Bench"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories"><img src="https://img.shields.io/badge/🤗%20Trajectories-gated-orange" alt="Trajectories"></a>
  <a href="https://huggingface.co/ZHEN-04/CaptchaAgent"><img src="https://img.shields.io/badge/🤗%20Model-CaptchaAgent-yellow" alt="Model"></a>
  <a href="https://arxiv.org/abs/2609.31957"><img src="https://img.shields.io/badge/arXiv-2609.31957-b31b1b.svg" alt="arXiv"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

![20 类题目,截自真实的基准页面](assets/overview.jpg)

这个仓库是 CaptchaArena 的代码部分:把 20 类 CAPTCHA 渲染成真实网页(视口固定 1280×1080)并负责
判分的 Flask 服务器、只靠截图作答的 computer-use agent、在实时页面上浏览数据集的画廊,以及查看
agent 运行与轨迹的界面。

数据集在 Hugging Face Hub 上(见[获取数据](#获取数据));CaptchaAgent 权重在
[ZHEN-04/CaptchaAgent](https://huggingface.co/ZHEN-04/CaptchaAgent)。数据集设计、CaptchaAgent 和全部实验结果见[论文](https://arxiv.org/abs/2609.31957)。

## 更新

- **2026-09-29** —— 模型发布:CaptchaAgent 权重,[ZHEN-04/CaptchaAgent](https://huggingface.co/ZHEN-04/CaptchaAgent)。
- **2026-09-25** —— 论文已上 arXiv:[arXiv:2609.31957](https://arxiv.org/abs/2609.31957)。
- **2026-08-11** —— 轨迹发布:`Train` / `Val` 上带推理标注的轨迹,
  [ZHEN-04/CaptchaArena-Trajectories](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)。
- **2026-08-08** —— 代码发布:基准服务器、截图 agent、数据集画廊、轨迹查看器,
  [X0X0X00/CaptchaArena](https://github.com/X0X0X00/CaptchaArena)。
- **2026-08-07** —— 数据集发布:`Train` / `Val` / `Test` 三个划分的题目,
  [ZHEN-04/CaptchaArena](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)。

## 目录

- [更新](#更新)
- [标准答案](#标准答案)
- [仓库结构](#仓库结构)
- [安装](#安装)
- [获取数据](#获取数据)
- [运行](#运行)
- [浏览数据集](#浏览数据集)
- [发布状态](#发布状态)
- [引用](#引用)
- [许可](#许可)
- [致谢](#致谢)

## 标准答案

每个题目目录里有两份文件:

- `ground_truth.json` —— 原始形式的答案(索引、坐标、文本),以及判分时用的 `tolerance`。目标
  形状不规则的题型改为给出 `mask_path`,指向一张二值掩码,路径相对题目目录:`Geometry_Click`
  和 `Pick_Area` 放在 `answer.valid_area` 下,`Misleading_Click` 放在顶层。白色(>127)标出
  目标;`Misleading_Click` 则相反,白色标出要避开的角色。
- `ground_truth_cu.json` —— 同一个答案,写成 agent 动作序列(`answer_cu`):

```jsonc
"answer_cu": [
  {"action": "click", "arguments": {"x": 619, "y": 132}},
  {"action": "click", "arguments": {"x": 640, "y": 924}}
]
```

`answer_cu` 就是 `mock` provider 重放并提交给真实判分器的内容,见
[第 3 步](#3-用-mock-provider-检查数据)。完好的划分应得到 100%。

## 仓库结构

```
CaptchaArena/
├── app.py                    # Flask 服务器:提供题目页面并判分
├── agent_frameworks/
│   └── computeruse_cli.py    # 截图 agent(anthropic / openai / google / mock)
├── templates/ static/        # 基准页面本身
├── gallery/
│   └── app.py                # 数据集浏览器:缩略图 + 实时题目页
├── web/                      # 查看 agent 运行与轨迹的 React 界面
├── data/                     # 下载的数据集放这里(见 data/README.md)
├── requirements.txt
└── Dockerfile
```

## 安装

```bash
pip install -r requirements.txt
playwright install chromium
```

服务器和 agent 都需要 Python 3.10+。

服务器也可以用自带的 `Dockerfile` 跑:镜像里有代码和 Chromium,数据集需要挂载到 `/app/data`:

```bash
docker build -t captcha-arena .
docker run -p 7860:7860 -v "$PWD/data:/app/data" captcha-arena    # serves data/Test
```

加 `-e CAPTCHA_DATA_DIRS=data/Val` 可以换成别的划分。

## 获取数据

两个数据集都在 Hugging Face Hub 上,均为 gated + CC BY-NC 4.0 —— 先到数据集页面申请访问权限,
然后 `hf auth login`。

- **题目** —— [ZHEN-04/CaptchaArena](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)
  · `Train` / `Val` / `Test` 的图片与标准答案
- **轨迹** —— [ZHEN-04/CaptchaArena-Trajectories](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)
  · `Train` / `Val` 上已解出的带思维链轨迹,用于微调

```bash
hf download ZHEN-04/CaptchaArena --repo-type dataset --local-dir data
```

有一点数据集卡片上没说:API 要的 `puzzle_type` 就是带数量后缀的目录名(`Train/Bingo_2100`、
`Test/Bingo_200`),而不是 `Bingo`。详见 [data/README.md](data/README.md)。

## 运行

### 1. 起题目服务

```bash
CAPTCHA_DATA_DIRS=data/Test python app.py       # http://127.0.0.1:7860
```

直接打开某一道题:

```
http://127.0.0.1:7860/?single_puzzle=true&puzzle_type=Geometry_Click_200&puzzle_id=image1.png
```

![agent 被评分时所面对的基准页面](assets/benchmark_page.jpg)

### 2. 把 agent 指过去

```bash
python -m agent_frameworks.computeruse_cli \
  --provider openai --model <model> \
  --openai-base-url <endpoint> --openai-api-key <key> \
  --url http://127.0.0.1:7860 \
  --per-puzzle --limit 0 --max-steps 15 --headless \
  --output data/Output/<provider>/<model>
```

`--provider` 可选 `anthropic`、`google`、`mock` 或 `openai` —— 最后一个指任何讲 OpenAI
chat-completions 协议的端点,所以用 vLLM 或 SGLang 本地部署的 ckpt 和托管 API 用法完全一样。
`anthropic` 和 `google` 从环境变量读 `ANTHROPIC_API_KEY` 和 `GOOGLE_API_KEY`;其余可调项见
`.env.example`(代码不会加载 `.env`,需要什么自己 export)。

`--per-puzzle --limit 0` 会把服务器列出的每道题都跑一遍,`--max-steps 15` 是论文使用的步数上限。
结果写到 `--output` 下。

### 3. 用 mock provider 检查数据

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 \
  --puzzle-type Geometry_Click_200 --puzzle-id image1.png \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

全程不涉及模型,只是把记录好的动作在浏览器里重放一遍。要重放整个划分,去掉
`--puzzle-type`/`--puzzle-id`,加上 `--per-puzzle --limit 0`;`<output>/run_summary.json`
里的 `accuracy` 应当是 `100.0`:

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 --per-puzzle --limit 0 \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

### 4. 查看运行结果

```bash
cd web && npm install
VITE_CAPTCHA_SERVER_URL=http://127.0.0.1:7860 npm run dev    # http://127.0.0.1:5173
```

需要 Node.js。**Output Runs** 列出 `data/Output/<provider>/<model>/` 下的全部运行(即第 2 步
的 `--output`;可用 `CAPTCHA_RUNS_ROOT` 改),可逐步查看每条轨迹。**Dataset** 在实时页面上浏览
`data/` 下的各个划分(`CAPTCHA_DATA_ROOT`),页面由第 1 步的服务器提供;不设
`VITE_CAPTCHA_SERVER_URL` 时它会到 47860 端口找这个服务器。

## 浏览数据集

```bash
GALLERY_DATA_ROOT=data GALLERY_CAPTCHA_URL=http://127.0.0.1:7860 \
  python gallery/app.py                         # http://127.0.0.1:48040
```

左边选划分和类型,右边是缩略图。

![数据集画廊](assets/gallery.jpg)

点缩略图会打开那道题的实时页面,旁边并排显示标准答案;需要第 1 步的服务器在跑。

![一道题的实时页面,旁边是它的标准答案](assets/gallery_live.jpg)

## 发布状态

已经放出来的,和还没放的。

- [x] **基准与 agent** —— 本仓库:服务器、20 类题目、截图 agent、数据集画廊、轨迹查看器。
- [x] **数据集** —— `Train` / `Val` / `Test` 题目及两份标准答案文件,
      [已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)。
- [x] **训练轨迹** —— `Train` / `Val` 上带推理标注的轨迹,每题一条,
      [已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)。
- [x] **论文** —— [arXiv:2609.31957](https://arxiv.org/abs/2609.31957)。
- [x] **人类基线** —— 整个 `Test` 划分上分题型的正确率与用时,见论文(附录 G,表 9)。
- [x] **CaptchaAgent 权重** —— SFT 之后与 GRPO 之后的 Qwen3.5-9B ckpt,[已上 Hub](https://huggingface.co/ZHEN-04/CaptchaAgent)。
- [ ] **训练代码** —— 监督微调,以及把本环境当作实时 rollout 目标的多轮 GRPO 配置
      (配置见论文附录 K 和 L)。
- [ ] **题目生成器** —— 各类题目的渲染脚本。

## 引用

如果用到了 CaptchaArena,请引用:

```bibtex
@article{zhang2026captchaarena,
  title   = {CaptchaArena: A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs},
  author  = {Zhang, Zhenhao and Fan, Zhaoyu and Ying, Haohan and Hu, Jingwen and Fan, Hancen and Zhou, Junhao and Chen, Zitian and Zhu, Linchao},
  journal = {arXiv preprint arXiv:2609.31957},
  year    = {2026}
}
```

## 许可

本仓库的**代码**是 MIT —— 见 [LICENSE](LICENSE)。

**数据集不是**:两个数据集均以 **CC BY-NC 4.0** 发布并设置了访问门槛,仅限非商业学术研究使用。

## 致谢

`app.py`、页面模板和前端脚本最初源自
[OpenCaptchaWorld](https://github.com/MetaAgentX/OpenCaptchaWorld),按其 MIT 许可在此再分发。
computer-use agent、画廊和轨迹查看器均为本项目所写;题目生成器(尚未发布)和 Hub 上的全部题目
数据同样出自本项目。

