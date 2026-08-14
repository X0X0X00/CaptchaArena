# CaptchaArena

**面向 computer-use agent 的交互式 CAPTCHA 基准。**

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python"></a>
  <a href="https://huggingface.co/datasets/ZHEN-04/CaptchaArena"><img src="https://img.shields.io/badge/🤗%20Puzzles-gated-orange" alt="Puzzles"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

![20 类题目,截自真实的基准页面](assets/overview.jpg)

CaptchaArena 把 20 类现代 CAPTCHA 以真实网页的形式提供,视口固定 1280×1080。Agent 能拿到的
只有截图,靠移动鼠标和打字作答,由页面自己的校验逻辑判定对错。`Train` / `Val` / `Test` 三个
划分共 50,000 道题,每道都带一份可直接执行的解法,因此整个划分不调用任何模型就能重放并验证。

## 更新

- **2026-08-08** —— 代码发布:基准服务器、截图 agent、数据集画廊、轨迹查看器。
- **2026-08-07** —— 数据集发布:`Train` / `Val` / `Test` 共 50,000 道题,已上 Hugging Face Hub。

## 目录

- [更新](#更新)
- [为什么用真实页面](#为什么用真实页面)
- [20 类题目](#20-类题目)
- [标准答案](#标准答案)
- [仓库结构](#仓库结构)
- [安装](#安装)
- [获取数据](#获取数据)
- [运行](#运行)
- [浏览数据集](#浏览数据集)
- [发布状态](#发布状态)
- [许可](#许可)
- [致谢](#致谢)

## 为什么用真实页面

CAPTCHA 不是一个打标签问题。真正有意思的那些,光看是答不出来的:你要用箭头按钮把物体一步步
转到对齐、把滑块拖到缺口卡进去、交换两块拼图、按住按钮等它读完、点一个只有在页面完成布局之后
才存在的位置。把这些压扁成"一张静态图 + 一个文本答案",难的那部分就消失了。

所以 CaptchaArena 保留了页面本身:

- **实时渲染,不是预先烘焙。** 每道题由 Flask 提供,由真实浏览器在锁定的 1280×1080 视口下绘制
  —— 正因为如此,像素坐标才能在两个模型之间、或同一个模型的两天之间相互比较。
- **输入截图,输出鼠标动作。** Agent 的全部观测就是一张截图,全部动作空间是五个工具 ——
  `screenshot`、`click`、`drag`、`type_text`、`hold`。没有 `done`:提交即结束。它拿不到任何
  题目元数据、拿不到 DOM、也没有任何基准 API。
- **由页面判分。** 对错来自 `/api/check_answer`,和真人点 Submit 走的是同一个接口。不存在另一套
  离线判分器,也就不会和线上逻辑漂移。
- **天然多步。** 参考解法的长度从 1 步到 22 步。20 类里有 17 类最多 6 步;`Unusual_Detection`
  和 `Rotation_Match` 分别到 7 步和 8 步;`Patch_Select` 是长尾,中位数 8、90 分位 12。因此
  分数反映的是感知、grounding **以及**顺序,而不是一次性猜测。

## 20 类题目

"页面上的指令"一列是页面上实际渲染的原文。"动作数"是在 `Test` 划分上实测的标准解法平均长度;
基准页面把同一个数字显示成 1–5 星。

| 类型 | 交互方式 | 页面上的指令 | 动作数 |
|---|---|---|---|
| `Geometry_Click` | 点击 | *Click on the cone.* | 1.0 |
| `Hold_Button` | 按住 | *Hold the button until it finishes loading.* | 1.0 |
| `Misleading_Click` | 点击 | *Click the image to continue.* | 1.0 |
| `Pick_Area` | 点击 | *Click on the center of the largest area outlined by the dotted line* | 1.0 |
| `Place_Dot` | 点击 + 提交 | *Click to place a Dot at the end of the car's path* | 2.0 |
| `Select_Animal` | 点击 + 提交 | *Pick a rooster* | 2.0 |
| `Object_Match` | 箭头翻页 | *Use the arrows to change the number of objects until it matches the left image.* | 2.8 |
| `Coordinates` | 箭头翻页 | *Using the arrows, move Jerry to the indicated seat* | 2.8 |
| `Bingo` | 交换方块 | *...click two images to exchange their position to line up the same images to a line* | 3.0 |
| `Dice_Count` | 输入数字 | *Sum up the numbers on all the dice* | 3.0 |
| `Slide_Puzzle` | 拖拽 | *Drag the slider component to the correct position* | 3.0 |
| `Image_Matching` | 箭头翻页 | *Using the arrows, match the animal in the left and right image.* | 3.1 |
| `Connect_icon` | 箭头翻页 | *Using the arrows, connect the same two icons with the dotted line as shown on the left.* | 3.5 |
| `Dart_Count` | 箭头翻页 | *Use the arrows to pick the image where all the darts add up to the number in the left image.* | 3.7 |
| `Path_Finder` | 箭头翻页 | *Use the arrows to select the image where the object is on the spot marked by the X.* | 3.7 |
| `Image_Recognition` | 网格多选 | *Select all images containing a bicycle, then click submit* | 4.4 |
| `Unusual_Detection` | 网格多选 | *Select all the unusual images* | 4.5 |
| `Rotation_Match` | 箭头翻页 | *Use the arrows to rotate the object so it points in the same direction as the reference hand.* | 4.5 |
| `Click_Order` | 按序点击 | *Click the icons in order as shown in the reference image.* | 5.1 |
| `Patch_Select` | 网格多选 | *Select all squares with garden trowel* | 8.5 |

其中 7 类共用同一个箭头翻页控件:一个左键、一个右键,在候选图之间翻。它们长得像、操作也一样,
但底下要做的判断各不相同 —— 数飞镖、对旋转角、跟踪路径 —— 这使它们成为一组有用的受控对照。

## 标准答案

每个题目目录里有两份文件:

- `ground_truth.json` —— 原始形式的答案(索引、坐标、文本),以及判分时用的 `tolerance`。
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
然后 `hf auth login`。

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
      [已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena)(gated,CC BY-NC 4.0)。
- [x] **训练轨迹** —— `Train` / `Val` 上的带思维链 computer-use 轨迹,按轮拆分为逐条样本,
      [已上 Hub](https://huggingface.co/datasets/ZHEN-04/CaptchaArena-Trajectories)。
- [ ] **模型权重** —— 微调后的 ckpt。
- [ ] **训练代码** —— 监督微调,以及把本环境当作实时 rollout 目标的多轮 RL 配置。
- [ ] **题目生成器** —— 各类题目的渲染脚本,供需要比现成划分更多数据、或想加新题型的人使用。
- [ ] **人类基线** —— 标注者通过同一个页面做完整个 `Test` 划分,好让 agent 的分数有参照系。
- [ ] **论文**,以及与之配套的基线数字。

## 许可

本仓库的**代码**是 MIT —— 见 [LICENSE](LICENSE)。

**数据集不是**:两个数据集均以 **CC BY-NC 4.0** 发布并设置了访问门槛,仅限非商业学术研究使用。

## 致谢

`app.py`、页面模板和前端脚本最初源自
[OpenCaptchaWorld](https://github.com/MetaAgentX/OpenCaptchaWorld),按其 MIT 许可在此再分发。
生成器、随仓库发布的全部题目数据、computer-use agent、画廊和轨迹查看器均为本项目所写。
