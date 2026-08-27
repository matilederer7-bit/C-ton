param(
  [string]$OutputPath = "supabase/staging/001_siton_inventory_v1.sql"
)

$ErrorActionPreference = "Stop"

function Read-Base44File([string]$Path) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $raw = (& npx base44 sandbox read $Path --offset 1 --limit 2000 2>&1 | Out-String)
  $ErrorActionPreference = $previousPreference
  if ($LASTEXITCODE -ne 0) {
    throw "Base44 read failed for $Path"
  }
  $jsonStart = $raw.IndexOf("{")
  if ($jsonStart -lt 0) {
    throw "Base44 did not return JSON for $Path"
  }
  $payload = $raw.Substring($jsonStart) | ConvertFrom-Json
  $file = $payload.files | Where-Object { $_.path -eq $Path } | Select-Object -First 1
  if (-not $file -or [string]::IsNullOrWhiteSpace($file.content)) {
    throw "Base44 did not return file content for $Path"
  }
  return [string]$file.content
}

function Extract-Template([string]$Source, [string]$ConstantName) {
  $pattern = "const\s+$ConstantName\s*=\s*``(?<sql>[\s\S]*?)``;"
  $match = [regex]::Match($Source, $pattern)
  if (-not $match.Success) {
    throw "Could not extract $ConstantName"
  }
  return $match.Groups["sql"].Value.Trim()
}

$schemaAdmin = Read-Base44File "base44/functions/supabase-schema-admin/entry.ts"
$rpcAdmin = Read-Base44File "base44/functions/supabase-inventory-rpc-admin/entry.ts"

$schemaSql = Extract-Template $schemaAdmin "SCHEMA_SQL"
$hardeningSql = Extract-Template $schemaAdmin "HARDENING_SQL"
$rpcSql = Extract-Template $rpcAdmin "RPC_SQL"

$header = @"
-- Canonical SITON inventory foundation, extracted read-only from the Stage31
-- Base44 provisioners. This file contains schema, RPC, RLS, grants and
-- search_path hardening and is intended for fresh staging reconstruction.
-- Source project nqgbqbqextiryqqpggju was not mutated by this extraction.

"@

$target = Join-Path (Get-Location) $OutputPath
$targetDirectory = Split-Path -Parent $target
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$content = $header + $schemaSql + "`r`n`r`n" + $rpcSql + "`r`n`r`n" + $hardeningSql + "`r`n"
[System.IO.File]::WriteAllText($target, $content, [System.Text.UTF8Encoding]::new($false))

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
Write-Output "inventory_sql=$OutputPath"
Write-Output "sha256=$hash"
