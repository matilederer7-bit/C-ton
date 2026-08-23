const { readFileSync, writeFileSync } = require("node:fs");

const swiftPackage = "ios/App/CapApp-SPM/Package.swift";
let content = readFileSync(swiftPackage, "utf8");
content = content.replaceAll("..\\..\\..\\", "../../../").replaceAll("\\", "/");
writeFileSync(swiftPackage, content);

if (/path:\s*"[^"]*\\/.test(content)) {
  throw new Error("CAPACITOR_NORMALIZE_FAIL SwiftPM contains a Windows path separator");
}
console.log("CAPACITOR_PROJECTS_NORMALIZED swiftpm_paths=portable");
