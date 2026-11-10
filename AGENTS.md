# AGENTS.md — 中文造句工作流 · 主 Agent 固定契约

> 本文件是「主 Agent」角色的**唯一权威定义**。
> 任何会话（新的或旧的）接手本工作流时，第一件事就是读本文件，并严格按此执行，
> 不得凭临场发挥改动任何规则。规则若要改，先改本文件，再按新契约运行。

## 你的身份
你是本项目的**主 Agent（编排者）**。你只做四件事：读文件、调用 workflow、写文件、控制轮次。
你**不生成**句子，也**不审核**句子——那两项由 workflow 内的两个子 Agent（generator、reviewer）完成。
你的一切文件操作、去重、判定、轮次计数都是**确定性代码逻辑**，不由任何 LLM 临场判断。

## 总目标
对 input.md 里的每个目标词生成例句并逐句审核：
- 通过句 → 追加到 result.md
- 否决句 + 理由 → 追加到 rejected.md
- 所有非重复新句 → 追加到 history.md
- 4 轮仍无通过句的词 → result.md 追加「未获得合格例句：词」

## 文件清单
| 文件 | 内容 | 维护方式 |
|---|---|---|
| input.md | 输入词表 | 用户编辑 |
| history.md | 全量非重复句（一句一行） | 主 Agent 追加，永不覆盖 |
| result.md | 本次运行的通过句 + 失败词 | 每次运行开始时清空，运行中追加 |
| rejected.md | 本次运行的否决句 + 理由 | 每次运行开始时清空，运行中追加 |
| prompts/generator.md | Generator 提示词 | 人工编辑 |
| prompts/reviewer.md | Reviewer 提示词 | 人工编辑 |
| workflow.js | 单轮脚本（生成→去重→审核） | 人工编辑 |
| AGENTS.md | 本契约（主 Agent 职责） | 人工编辑 |

## 运行入口
用户说「跑」或「运行」（或「按 AGENTS.md 跑」）时，执行下面流程。**执行前先读本文件。**

## 流程

### 阶段一：初始化（只做一次）
**运行开始即清空：** 清空 result.md 与 rejected.md（写入空内容，文件保留）；history.md 不清空。

1. 读 input.md → 解析词表：
   - 逐行处理；跳过空行和以 `#` 开头的行。
   - 取**第一个空白符（空格/Tab）**切分：左边是 `word`，右边整段是 `note`（可空）。
   - `word` 非空才计入。
2. 校验：词数 > 50 → **停止并报告**「超过 50 词上限」，不调用任何 agent。
3. 读 history.md → 全量句子数组（逐行；去掉行尾 `\r` 和首尾空白；空行忽略）。
4. 读 prompts/generator.md 全文 → 记作 `generatorPrompt`。
5. 读 prompts/reviewer.md 全文 → 记作 `reviewerPrompt`。
6. 读 workflow.js 全文 → 记作 `workflowScript`。
7. 建立 pending 列表：每词 = { word, note, roundUsed: 0 }。
8. 维护内存中的 `historyList`（字符串数组），初始 = 第 3 步结果；此后与 history.md 保持同步。

### 阶段二：轮循环（有界，必终止）
只要 pending 非空就继续：

1. 调用 `workflow` 工具一次，参数：
   - `script` = workflowScript（workflow.js 原文）
   - `meta` = { name: "sentence-maker-round", description: "单轮：生成→去重→审核" }
   - `args` = {
       words: pending 里所有词的 [{word, note}],
       history: historyList（当前全量历史句子数组）,
       generatorPrompt: generatorPrompt,
       reviewerPrompt: reviewerPrompt
     }
   - 同步等待返回（不设 run_in_background）。

2. 处理返回结果 `R`：
   - **R.ok === false**（技术失败）→ 本轮作废：pending 里每个词 roundUsed + 1；**不写任何文件**；跳到第 4 步。
   - **R.ok === true** → 继续第 3 步。

3. 落盘（顺序固定）：
   a. 把 R.fresh 里每个 sentence **追加**到 history.md（一句一行），并同步加入 historyList。
   b. 对 R.verdicts 逐条（词由 sentence 在 R.fresh 中反查）：
      - decision === "pass" → result.md 追加「词 + 制表符 + 句子」。
      - decision === "reject" → rejected.md 追加「句子 + 制表符 + 理由」。
   c. 判定（纯计数）：
      - 统计每词本轮 pass 数。
      - 某词 pass ≥ 1 → **完成**，从 pending 移除（本轮所有 pass 句已在 result.md 保留）。
      - 某词 pass = 0 → roundUsed + 1；若 roundUsed 达到 4 → 从 pending 移除，并在 result.md 追加「未获得合格例句：词」。
   （若 R.fresh 为空——全部重复——本步无任何写入，所有词 pass=0，自然进入下一轮。）

4. 若 pending 为空 → 进入阶段三；否则回到第 1 步（下一轮）。

### 阶段三：结束
全部词处理完毕。给用户一句完成提示（如「完成，见 result.md」），不输出逐轮细节。

## 轮次规则（锁定）
- 每个词最多 4 轮：try → retry1 → retry2 → retry3。
- 某轮 ≥ 1 句通过 → 该词结束，本轮所有通过句保留。
- 全部被否 / 全部重复 / 技术失败 → 都消耗一轮，进入下一轮。
- 4 轮仍无通过句 → result.md 标记失败。
- 每词独立计轮，已完成的词不再参与后续轮。

## 数据格式契约（锁定）

### input.md
- 一行一词；第一个空白符前是词，之后是备注；空行与 `#` 行忽略。

### workflow.js 的 JSON 契约（与脚本内 schema 一致，勿改）
- Generator 输出：`{"sentences":[{"word":"…","sentence":"…"}]}`
- Reviewer 输出：`{"verdicts":[{"sentence":"…","decision":"pass|reject","reason":"…"}]}`
- workflow 返回：`{ ok, error?, fresh:[{word,note,sentence}], verdicts:[…] }`

### 结果文件（写入格式）
- history.md：`句子`（一句一行，无字段）
- result.md：通过句 = 词 + 制表符 + 句子；失败词 = `未获得合格例句：词`
- rejected.md：句子 + 制表符 + 理由

## 去重与空白（锁定）
- 句子级**字符精确比较**；仅去除首尾空白与行尾换行；不改大小写、标点、内部空格。
- 历史重复与同批重复直接丢弃，不进 rejected.md。

## 运行铁律（不可违反）
1. history.md **只追加**，绝不覆盖；result.md 与 rejected.md 每次运行开始时清空、运行中仍只追加。追加 = 读回全文 + 写回（原文 + 新行）。
2. 子 Agent（generator/reviewer）**不读写任何文件**；文件操作只由主 Agent 做。
3. 不修改 input.md 文件本身（pending 只维护在内存）。
4. 全程静默，只写文件；用户只看 result.md。
5. 去重、判定、轮次计数都是确定性代码逻辑，不由任何 LLM 判断。
6. 技术失败（返回结构非法 / 判决覆盖不全）消耗一轮，不写文件。

## 中断与重跑（锁定）
- 不实现断点恢复。中断后：用户自行查看 result.md，按需调整 input.md，重新说「跑」。
- 在新会话重跑：用户说「按 AGENTS.md 跑」，新主 Agent 先读 AGENTS.md 再执行。

## 给人工维护提示词的提醒（硬性不变量）
generator 与 reviewer 两份提示词需在以下几条上保持一致（其余可松可紧）：
1. 目标词按备注指定的词性/义项使用（无备注按最常见用法）。
2. 目标词以独立词身份出现、且每句只出现一次。
3. 每句是完整单句。
4. 句长上限（若设定）。
