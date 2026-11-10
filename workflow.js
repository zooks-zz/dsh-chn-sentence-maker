// workflow.js —— 单轮工作流：生成 → 内存精确去重 → 审核
// 由主 Agent 读入本文件内容后，作为 workflow 工具的 script 传入；
// 主 Agent 每次调用另传 meta（见 README.md）。
//
// args = {
//   words:            [{ word, note }],   // 本轮待处理词（未完成词）
//   history:          [string],           // 全量历史句子（精确去重用，已去行尾换行）
//   generatorPrompt:  string,             // prompts/generator.md 原文（规则+输出契约，不含词表）
//   reviewerPrompt:   string              // prompts/reviewer.md 原文（规则+输出契约，不含候选句）
// }

const GEN_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          sentence: { type: "string" }
        },
        required: ["word", "sentence"],
        additionalProperties: false
      }
    }
  },
  required: ["sentences"],
  additionalProperties: false
};

const REV_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" },
          decision: { type: "string", enum: ["pass", "reject"] },
          reason: { type: "string" }
        },
        required: ["sentence", "decision", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["verdicts"],
  additionalProperties: false
};

const words = Array.isArray(args.words) ? args.words : [];
const wordNote = new Map(words.map((w) => [String(w.word), String(w.note || "")]));
const validWords = new Set(wordNote.keys());
const seen = new Set((Array.isArray(args.history) ? args.history : []).map((s) => String(s).trim()));

// 1. 生成
const genInput = [
  args.generatorPrompt,
  "",
  "【本轮目标词】（一行一词，首列是词，其后是备注）",
  ...words.map((w) => `${w.word}${w.note ? " " + w.note : ""}`)
].join("\n");

const gen = await agent(genInput, { schema: GEN_SCHEMA, label: "generator" });
if (!gen || !Array.isArray(gen.sentences)) {
  return { ok: false, error: "generator_failed", fresh: [], verdicts: [] };
}

// 2. 内存精确去重（对历史全集 + 批内）
const fresh = [];
for (const it of gen.sentences) {
  const word = String(it && it.word);
  const sentence = String(it && it.sentence).trim();
  if (!validWords.has(word) || sentence === "") continue;
  if (seen.has(sentence)) continue;
  seen.add(sentence);
  fresh.push({ word, note: wordNote.get(word), sentence });
}

if (fresh.length === 0) {
  return { ok: true, fresh: [], verdicts: [] };
}

// 3. 审核（只审去重后的新句）
const candidateBlock = fresh
  .map((f, i) => `${i + 1}. 目标词「${f.word}」${f.note ? "（备注：" + f.note + "）" : ""}\n   例句：${f.sentence}`)
  .join("\n");

const revInput = [
  args.reviewerPrompt,
  "",
  "【本轮候选句子】",
  candidateBlock
].join("\n");

const rev = await agent(revInput, { schema: REV_SCHEMA, label: "reviewer" });
if (!rev || !Array.isArray(rev.verdicts)) {
  return { ok: false, error: "reviewer_failed", fresh, verdicts: [] };
}

// 4. 校验判决覆盖所有新句，且字段合法
const verdicts = rev.verdicts;
const bySentence = new Map();
for (const v of verdicts) {
  if (!v || typeof v.sentence !== "string" || typeof v.decision !== "string" || typeof v.reason !== "string") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (v.decision !== "pass" && v.decision !== "reject") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (v.decision === "reject" && v.reason.trim() === "") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (bySentence.has(v.sentence)) {
    return { ok: false, error: "reviewer_duplicate_verdict", fresh, verdicts };
  }
  bySentence.set(v.sentence, v);
}
for (const f of fresh) {
  if (!bySentence.has(f.sentence)) {
    return { ok: false, error: "reviewer_missing_verdict", fresh, verdicts };
  }
}
if (bySentence.size !== fresh.length) {
  return { ok: false, error: "reviewer_extra_verdict", fresh, verdicts };
}

return { ok: true, fresh, verdicts };
