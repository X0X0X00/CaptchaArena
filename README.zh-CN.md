# CaptchaArena

**A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs**

<p align="center">
  <a href="https://x0x0x00.github.io/">Zhenhao Zhang</a><sup>1,*</sup>, Zhaoyu Fan<sup>2</sup>, Haohan Ying<sup>3</sup>, Jingwen Hu<sup>3</sup>, Hancen Fan<sup>1</sup>, Junhao Zhou<sup>4</sup>, Zitian Chen<sup>1</sup>, <a href="https://ffmpbgrnn.github.io/">Linchao Zhu</a><sup>2,†</sup><br>
  <sup>1</sup>哥伦比亚大学 &nbsp;·&nbsp; <sup>2</sup>浙江大学 &nbsp;·&nbsp; <sup>3</sup>罗切斯特大学 &nbsp;·&nbsp; <sup>4</sup>伊利诺伊大学厄巴纳-香槟分校<br>
  <sup>*</sup>项目负责人 &nbsp;·&nbsp; <sup>†</sup>通讯作者
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena"><img src="https://img.shields.io/badge/🤗%20Bench-gated-orange" alt="Bench"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories"><img src="https://img.shields.io/badge/🤗%20Trajectories-gated-orange" alt="Trajectories"></a>
  <a href="https://x0x0x00.github.io/"><img src="https://img.shields.io/badge/Paper-under%20review-lightgrey" alt="Paper"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

![20 类题目,截自真实的基准页面](assets/overview.jpg)

这个仓库是 CaptchaArena 的代码部分:把 20 类现代 CAPTCHA 以真实网页形式渲染(视口固定
1280×1080)并负责判分的 Flask 服务器、只靠截图作答的 computer-use agent、在实时页面上浏览
数据集的画廊,以及查看 agent 运行与轨迹的界面。Agent 能拿到的只有截图,靠移动鼠标和打字
作答,由页面自己的校验逻辑判定对错。

题目和带推理标注的轨迹都在 Hugging Face Hub 上(见[获取数据](#获取数据))。数据集设计、
CaptchaAgent 和全部实验结果见论文(见[引用](#引用))。

## 更新

- **2026-08-11** —— 轨迹发布:解出 `Train` / `Val` 题目的带思维链 computer-use 轨迹,按轮拆分为
  逐条样本,已上 Hugging Face Hub。
- **2026-08-08** —— 代码发布:基准服务器、截图 agent、数据集画廊、轨迹查看器。
- **2026-08-07** —— 数据集发布:`Train` / `Val` / `Test` 共 50,000 道题,已上 Hugging Face Hub。

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
- [联系方式](#联系方式)

## 标准答案

每个题目目录里有两份文件:

- `ground_truth.json` —— 原始形式的答案(索引、坐标、文本),以及判分时用的 `tolerance`。目标
  形状不规则时,条目指向一张二值掩码而不是一个点,点击落在白色像素上即为正确。
- `ground_truth_cu.json` —— 同一个答案,写成 agent 动作序列:

```jsonc
"answer_cu": [
  {"action": "click", "arguments": {"x": 619, "y": 132}},
  {"action": "click", "arguments": {"x": 640, "y": 924}}
]
```

第二种形式是**可执行的**,这正是关键。内置的 `mock` provider 会驱动浏览器把 `answer_cu` 走一遍
并提交给真实判分器,于是一个划分可以自证:凡是达不到 100%,问题就出在数据上,不在模型上。我们
把它当作每次重新生成划分后的发布闸门。

空间类答案统一以**图像原始像素**存储,原点在左上角。前端会把点击换算回该坐标系,所以无论图片以
什么尺寸显示,存下来的答案都保持有效。

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

## 获取数据

两个数据集都在 Hugging Face Hub 上,均为 gated + CC BY-NC 4.0 —— 先到数据集页面申请访问权限,
然后 `hf auth login`。申请会在论文上 arXiv 之后统一审核;现在提交也可以,会先排在队列里。

- **题目** —— [ZHEN-04/CaptchaArena](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)
  · `Train` / `Val` / `Test` 的图片与标准答案
- **轨迹** —— [ZHEN-04/CaptchaArena-Trajectories](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)
  · `Train` / `Val` 上已解出的带思维链轨迹,用于微调

```bash
hf download ZHEN-04/CaptchaArena --repo-type dataset --local-dir data
```

有一点数据集卡片上没写:目录名自带数量后缀(`Train/Bingo_2100`、`Test/Bingo_200`),而 API 要的
`puzzle_type` 就是这个带后缀的名字。详见 [data/README.md](data/README.md)。

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
  --limit 200 --max-steps 30 --headless \
  --output data/Output/<provider>/<model>
```

`--provider` 可选 `anthropic`、`google`、`mock` 或 `openai` —— 最后一个指任何讲 OpenAI
chat-completions 协议的端点,所以用 vLLM 或 SGLang 本地部署的 ckpt 和托管 API 用法完全一样。
每道题都会留下 `metafile.json`、`summary.json`、`trajectory.jsonl` 和一个 `screenshots/` 目录。

### 3. 用 mock provider 检查数据

```bash
python -m agent_frameworks.computeruse_cli --provider mock \
  --url http://127.0.0.1:7860 \
  --puzzle-type Geometry_Click_200 --puzzle-id image1.png \
  --mock-gt-dir data/Test --output /tmp/mockrun --headless
```

全程不涉及模型,只是把记录好的动作在浏览器里重放一遍。要确认刚下载的数据、某次代码改动或重新
生成的划分是否完好,这是最快的办法。

## 浏览数据集

```bash
GALLERY_DATA_ROOT=data GALLERY_CAPTCHA_URL=http://127.0.0.1:7860 \
  python gallery/app.py                         # http://127.0.0.1:48040
```

左边选划分和类型,右边是缩略图。

![数据集画廊](assets/gallery.jpg)

点缩略图打开的**不是图片**,而是那道题的**实时页面**,旁边并排显示标准答案 —— 你可以在与 agent
完全相同的条件下亲自试一遍。

![一道题的实时页面,旁边是它的标准答案](assets/gallery_live.jpg)

## 发布状态

已经放出来的,和还没放的。

- [x] **基准与 agent** —— 本仓库:服务器、20 类题目、截图 agent、数据集画廊、轨迹查看器。
- [x] **数据集** —— `Train` / `Val` / `Test`,两种标准答案格式,
      [已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)(gated,CC BY-NC 4.0;
      访问申请在论文上 arXiv 之后审核)。
- [x] **训练轨迹** —— `Train` / `Val` 上的 46,000 条带思维链 computer-use 轨迹,按轮拆分为
      逐条样本,[已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)。
- [ ] **CaptchaAgent 权重** —— SFT 之后与 GRPO 之后的 Qwen3.5-9B ckpt。
- [ ] **训练代码** —— 监督微调,以及把本环境当作实时 rollout 目标的多轮 GRPO 配置
      (DeepSpeed ZeRO-3、Liger FLCE、分布式 checkpoint)。
- [ ] **题目生成器** —— 各类题目的渲染脚本,供需要比现成划分更多数据、或想加新题型的人使用。
- [ ] **人类基线** —— 标注者通过同一个页面做完整个 `Test` 划分,好让 agent 的分数有参照系。
- [ ] **论文** —— 审稿中。arXiv 预印本放出的同时,数据集也将开放访问。

## 引用

论文正在审稿。预印本放出之前,请按如下方式引用:

```bibtex
@misc{zhang2026captchaarena,
  title  = {CaptchaArena: A Large-Scale, Fine-Grained Dataset for Training Computer-Use Agents on Interactive CAPTCHAs},
  author = {Zhang, Zhenhao and Fan, Zhaoyu and Ying, Haohan and Hu, Jingwen and Fan, Hancen and Zhou, Junhao and Chen, Zitian and Zhu, Linchao},
  year   = {2026},
  note   = {Under review}
}
```

## 许可

本仓库的**代码**是 MIT —— 见 [LICENSE](LICENSE)。

**数据集不是**:两个数据集均以 **CC BY-NC 4.0** 发布并设置了访问门槛,仅限非商业学术研究使用。

## 致谢

`app.py`、页面模板和前端脚本最初源自
[OpenCaptchaWorld](https://github.com/MetaAgentX/OpenCaptchaWorld),按其 MIT 许可在此再分发。
生成器、随仓库发布的全部题目数据、computer-use agent、画廊和轨迹查看器均为本项目所写。

## 联系方式

关于基准、数据或论文的问题,欢迎开 issue,或发邮件给张臻昊(Zhenhao Zhang,项目负责人,现于哥伦比亚大学):
zz3530@columbia.edu。个人主页:[x0x0x00.github.io](https://x0x0x00.github.io/) ·
[Google Scholar](https://scholar.google.com/citations?user=yR55AfsAAAAJ) ·
[GitHub](https://github.com/X0X0X00)。
