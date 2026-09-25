const { readFileSync, writeFileSync } = require("node:fs");

// `cap sync` writes the plugin paths it resolved through fs.realpath. In a
// checkout whose node_modules is a symlink (agent worktrees, some CI caches)
// that is an absolute path climbed with ../ segments — for the npm plugins
// under node_modules/ and for the repository's own plugins under
// mobile-plugins/ alike — which is neither portable nor what the committed
// projects hold. Fold any such path back onto the project-relative root each
// project expects (`../` from android/, `../../../` from ios/App/CapApp-SPM/).
function portable(content, relativeRoot) {
  return content.replace(/(?:\.\.\/)+(?:[^'"\s]*?\/)?(node_modules|mobile-plugins)\//g, `${relativeRoot}$1/`);
}

const swiftPackage = "ios/App/CapApp-SPM/Package.swift";
let content = readFileSync(swiftPackage, "utf8");
content = content.replaceAll("..\\..\\..\\", "../../../").replaceAll("\\", "/");
content = portable(content, "../../../");
writeFileSync(swiftPackage, content);

const gradleSettings = "android/capacitor.settings.gradle";
writeFileSync(gradleSettings, portable(readFileSync(gradleSettings, "utf8"), "../"));

if (/path:\s*"[^"]*\\/.test(content)) {
  throw new Error("CAPACITOR_NORMALIZE_FAIL SwiftPM contains a Windows path separator");
}
console.log("CAPACITOR_PROJECTS_NORMALIZED swiftpm_paths=portable");
