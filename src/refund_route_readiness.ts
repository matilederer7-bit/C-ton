import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this list in lock-step with scripts/web_route_inventory.cjs.
// tests/refund_policy_validation.ts enforces exact equality so an extracted
// route module cannot silently fall out of the live refund-readiness scan.
export const REFUND_READINESS_ROUTE_MODULES = [
  "app",
  "frontend_runtime",
  "receipt_content_routes",
  "distribution_hub",
  "admin_mission_control_routes",
  "operational_health_routes",
  "seller_deal_image_routes",
  "support_routes",
  "seller_fulfillment_routes",
  "admin_control_center_routes",
  "admin_growth_routes",
  "admin_demo_readiness_routes"
] as const;

const MANUAL_REFUND_ROUTE_PATTERNS = [
  /app\.(post|patch|put|delete)\(\s*["'`][^"'`]*\/api\/admin\/[^"'`]*refund/i,
  /app\.(post|patch|put|delete)\(\s*["'`][^"'`]*\/api\/seller\/[^"'`]*refund/i,
  /app\.(post|patch|put|delete)\(\s*["'`][^"'`]*\/api\/support\/[^"'`]*refund/i
];

export type RefundRouteScanResult = {
  manual_refund_routes_found: boolean;
  source_extension: ".ts" | ".js";
  scanned_modules: string[];
  unreadable_modules: string[];
};

export async function scanManualRefundRoutes(input?: {
  moduleDir?: string;
  extension?: ".ts" | ".js";
}): Promise<RefundRouteScanResult> {
  const currentModulePath = fileURLToPath(import.meta.url);
  const moduleDir = input?.moduleDir ?? dirname(currentModulePath);
  const extension = input?.extension ?? (extname(currentModulePath) === ".ts" ? ".ts" : ".js");

  const sourceResults = await Promise.all(
    REFUND_READINESS_ROUTE_MODULES.map(async (moduleName) => {
      const filename = join(moduleDir, `${moduleName}${extension}`);
      try {
        return { moduleName, text: await readFile(filename, "utf8"), readable: true };
      } catch {
        return { moduleName, text: "", readable: false };
      }
    })
  );

  const routeText = sourceResults.map((item) => item.text).join("\n");
  return {
    manual_refund_routes_found: MANUAL_REFUND_ROUTE_PATTERNS.some((pattern) => pattern.test(routeText)),
    source_extension: extension,
    scanned_modules: sourceResults.map((item) => item.moduleName),
    unreadable_modules: sourceResults.filter((item) => !item.readable).map((item) => item.moduleName)
  };
}
