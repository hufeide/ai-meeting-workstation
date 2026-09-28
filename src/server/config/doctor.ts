import "dotenv/config";
import { runDiagnostics, type DiagnosticItem } from "./diagnostics";

const report = await runDiagnostics();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

console.log(report.title);
console.log("");

for (const [group, items] of groupItems(report.items)) {
  console.log(group);
  for (const item of items) {
    const marker = item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗";
    console.log(`${marker} ${item.label}${item.message ? `：${item.message}` : ""}`);
  }
  console.log("");
}

if (report.ok) {
  console.log("结果：必需项通过。warning 可按真实运行需要补齐。");
} else {
  console.log(`结果：发现 ${report.issueCount} 个必需项问题，请根据上方提示修复。`);
}

process.exit(report.ok ? 0 : 1);

function groupItems(items: DiagnosticItem[]): Array<[string, DiagnosticItem[]]> {
  const groups = new Map<string, DiagnosticItem[]>();
  for (const item of items) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return [...groups.entries()];
}
