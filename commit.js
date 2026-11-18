// commit.js —— 本地确定性落盘（history 永不进入大模型）
//
// 职责（全部为确定性代码，无任何 LLM 判断）：
//   1. 读 history.md，对 fresh 做字符级精确去重（与历史重复的句子直接丢弃，不写任何文件）；
//   2. 把非重复新句追加到 history.md（只追加，永不覆盖）；
//   3. 按 verdict：通过句写入 result.md（词 + 制表符 + 句子），否决句写入 rejected.md（句子 + 制表符 + 理由）；
//   4. 把 fails 里的每个词写成「未获得合格例句：词」追加到 result.md；
//   5. 输出每词本轮（非重复）pass 数到 report 文件，供主 Agent 判定完成/重试。
//
// 用法：
//   node commit.js <round.json> <history.md> <result.md> <rejected.md> <report.json>
//
// round.json 结构：
//   {
//     "words":    ["词1", "词2", ...],
//     "fresh":    [{ "word": "…", "note": "…", "sentence": "…" }, ...],
//     "verdicts": [{ "sentence": "…", "decision": "pass|reject", "reason": "…" }, ...],
//     "fails":    ["词A", ...]   // 可选；4 轮仍无通过句的词
//   }

const fs = require("fs");

function readLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
}

const [roundFile, histFile, resultFile, rejectedFile, reportFile] = process.argv.slice(2);
if (!roundFile || !histFile || !resultFile || !rejectedFile || !reportFile) {
  console.error("用法：node commit.js <round.json> <history.md> <result.md> <rejected.md> <report.json>");
  process.exit(2);
}

const round = JSON.parse(fs.readFileSync(roundFile, "utf8"));
const fresh = Array.isArray(round.fresh) ? round.fresh : [];
const verdicts = Array.isArray(round.verdicts) ? round.verdicts : [];
const fails = Array.isArray(round.fails) ? round.fails : [];

const verdictMap = new Map();
for (const v of verdicts) {
  if (v && typeof v.sentence === "string") verdictMap.set(v.sentence, v);
}

// 读历史（只在本脚本内，不进大模型）
const historySet = new Set(readLines(histFile));

const appendHist = [];
const resultPassLines = [];
const rejectedLines = [];
const passCount = {};

for (const f of fresh) {
  const word = String(f && f.word);
  const sentence = String(f && f.sentence).trim();
  if (sentence === "") continue;
  if (historySet.has(sentence)) continue; // 历史重复：直接丢弃，不写任何文件
  historySet.add(sentence);
  appendHist.push(sentence);
  const v = verdictMap.get(sentence);
  if (v && v.decision === "pass") {
    resultPassLines.push(word + "\t" + sentence);
    passCount[word] = (passCount[word] || 0) + 1;
  } else if (v && v.decision === "reject") {
    rejectedLines.push(sentence + "\t" + String(v.reason || ""));
  }
}

// 追加 history（只追加，永不覆盖；末尾无换行时先补一个）
if (appendHist.length > 0) {
  let existing = fs.readFileSync(histFile, "utf8");
  if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
  fs.writeFileSync(histFile, existing + appendHist.join("\n") + "\n", "utf8");
}

// 追加 result / rejected（运行开始时已清空，此处只追加）
if (resultPassLines.length > 0) {
  fs.appendFileSync(resultFile, resultPassLines.join("\n") + "\n", "utf8");
}
if (rejectedLines.length > 0) {
  fs.appendFileSync(rejectedFile, rejectedLines.join("\n") + "\n", "utf8");
}
const failLines = fails.map((w) => "未获得合格例句：" + String(w));
if (failLines.length > 0) {
  fs.appendFileSync(resultFile, failLines.join("\n") + "\n", "utf8");
}

// 报告：每词本轮（非重复）pass 数
fs.writeFileSync(reportFile, JSON.stringify({ passCount }, null, 2), "utf8");
