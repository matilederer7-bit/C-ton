// Throwaway CI diagnostic: publish the failing security-group test output via
// public channels (step summary + check-run annotations). Not used by any gate.
const fs = require("node:fs");
const logPath = process.argv[2] || ".ci-artifacts/test-security.log";
const exitCode = Number(process.argv[3] || 0);
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
const isPino = (l) => l.startsWith('{"level"');
const summaryLines = lines.filter((l) => /^(TEST_SUMMARY|TEST_FAIL|FAILED |TEST_INVENTORY)/.test(l));
const failedFiles = lines
  .filter((l) => l.startsWith("TEST_FAIL"))
  .map((l) => (l.match(/file=(\S+)/) || [])[1])
  .filter(Boolean);
const out = [
  "## Test group diagnostic",
  `exit=${exitCode} node=${process.version} platform=${process.platform}`,
  "```",
  ...summaryLines,
  "```"
];
const annotations = [];
for (const file of failedFiles) {
  const start = lines.findIndex((l) => l.startsWith("TEST_START") && l.includes(`file=${file}`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("TEST_FAIL") && l.includes(`file=${file}`));
  const section = lines.slice(Math.max(start, 0), end + 1).filter((l) => !isPino(l));
  out.push(`### ${file}`, "```", ...section.slice(-150), "```");
  const interesting = section.filter((l) => /^(FAIL |TEST_FAIL)|Error|assert|expected|actual|\bat |Cannot|ECONN|EADDR/i.test(l));
  for (const l of interesting.slice(0, 8)) annotations.push(`${file}: ${l}`);
  annotations.push(`${file} TAIL: ${section.slice(-6).join(" | ")}`);
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
for (const a of annotations.slice(0, 10)) console.log(`::error::${a.replace(/[\r\n]+/g, " ").slice(0, 1500)}`);
if (!failedFiles.length) console.log(`::notice::group exit=${exitCode}; no TEST_FAIL lines`);
for (const l of summaryLines.slice(0, 20)) console.log(`::notice::${l.slice(0, 1000)}`);
