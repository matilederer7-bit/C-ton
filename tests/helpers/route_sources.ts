// Shared test helper: the route-module registry (scripts/lib/route_modules.cjs)
// for text-reading tests. Not a test file itself (tests/helpers is not
// enumerated by the group runner).
//
// Use readFrontendRuntimeFamily() wherever a test used to concatenate
// src/frontend_runtime.ts with the modules extracted from it, and
// ROUTE_MODULE_FILES wherever it listed every route-bearing module.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

type RouteModuleRegistry = {
  ROUTE_MODULES: readonly string[];
  FRONTEND_RUNTIME_FAMILY: readonly string[];
  FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED: readonly string[];
  ROUTE_MODULE_FILES: readonly string[];
  FRONTEND_RUNTIME_FAMILY_FILES: readonly string[];
};

const registry = createRequire(import.meta.url)(resolve(process.cwd(), "scripts/lib/route_modules.cjs")) as RouteModuleRegistry;

export const ROUTE_MODULES: readonly string[] = registry.ROUTE_MODULES;
export const FRONTEND_RUNTIME_FAMILY: readonly string[] = registry.FRONTEND_RUNTIME_FAMILY;
export const FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED: readonly string[] = registry.FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED;
export const ROUTE_MODULE_FILES: readonly string[] = registry.ROUTE_MODULE_FILES;
export const FRONTEND_RUNTIME_FAMILY_FILES: readonly string[] = registry.FRONTEND_RUNTIME_FAMILY_FILES;

export async function readRouteFiles(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return parts.join("\n");
}

export function readRouteFilesSync(files: readonly string[]): string {
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

export function readFrontendRuntimeFamily(): Promise<string> {
  return readRouteFiles(FRONTEND_RUNTIME_FAMILY_FILES);
}

export function readFrontendRuntimeFamilySync(): string {
  return readRouteFilesSync(FRONTEND_RUNTIME_FAMILY_FILES);
}

export function readAllRouteModules(): Promise<string> {
  return readRouteFiles(ROUTE_MODULE_FILES);
}
