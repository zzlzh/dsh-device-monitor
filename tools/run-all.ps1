# Run EVERY suite, including the ones that need the packaged runtime.
#
# Why this exists: the Electron-runtime verifiers (`verify-host-boot`,
# `verify-fresh-boot-e2e`) were listed separately in the README and were never
# part of any "run everything" command. When the terminal-status route landed
# they both went red — `routes.length === 14` against an actual 15 — and stayed
# red for a long time, because nothing ever ran them together. A suite that no
# command runs is a suite that silently rots.
#
# So: one command, every suite, one exit code. A long-red assertion is worse
# than a long-green one — it trains people to skip the check.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-all.ps1
#        add -RequireRuntime to make a missing Harness binary a hard failure

param([switch]$RequireRuntime)

$ErrorActionPreference = "Continue"
# Resolved from this script's own location so a checkout anywhere works.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Resolve the runtimes rather than hardcoding install paths:
#  - `node` comes from PATH, falling back to the usual Windows install location.
#  - the Harness binary is needed ONLY by the packaged-runtime verifiers below,
#    because they read files inside app.asar. Point $env:DSH_EXE at it (or
#    install to the default location) if these three suites are to run.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$exe = $env:DSH_EXE
if (-not $exe) {
	$exe = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\DeepSeek Harness.exe"
}
if (-not (Test-Path $exe)) {
	Write-Host "WARNING: Harness binary not found at '$exe'." -ForegroundColor Yellow
	Write-Host "         The packaged-runtime verifiers will be SKIPPED, not failed." -ForegroundColor Yellow
	Write-Host "         Set `$env:DSH_EXE (or pass -RequireRuntime) to change that." -ForegroundColor Yellow
}

# Count assertions rather than trusting a summary line: three of the suites
# print a verdict without a count, and a runner that parses only "n/n" would
# silently score them as 0.
function Measure-Suite([string]$label, [string]$output) {
	$lines = $output -split "`r?`n"
	$passed = @($lines | Where-Object { $_ -match '^\s*ok\s' }).Count
	$failed = @($lines | Where-Object { $_ -match '^\s*FAIL\s' }).Count
	$plural = @($lines | Where-Object { $_ -match '^(ALL PASS|FAILURES)' })
	[pscustomobject]@{ Suite = $label; Passed = $passed; Failed = $failed; Verdict = ($plural -join ' ') }
}

$results = @()

Write-Host "== the offline suites (plain node) ==" -ForegroundColor Cyan
foreach ($suite in @(
		'smoke', 'activate-smoke', 'settings-smoke', 'rawlog-smoke',
		'terminal-smoke', 'ssh-integration', 'client-smoke',
		'verify-ssh-resolution', 'verify-ssh-fix-causality', 'verify-audit-verdict'
	)) {
	$out = & $node "tools\$suite.mjs" 2>&1 | Out-String
	$row = Measure-Suite $suite $out
	$results += $row
	Write-Host ("  {0,-26} ok={1,-5} fail={2}" -f $row.Suite, $row.Passed, $row.Failed)
}

# These read inside app.asar, so they must run under the Electron binary in
# Node mode. This is exactly the group that used to go unchecked.
Write-Host "== the packaged-runtime verifiers (ELECTRON_RUN_AS_NODE=1) ==" -ForegroundColor Cyan
if (-not (Test-Path $exe)) {
	# Skipping is NOT the same as passing. A runner that quietly leaves three
	# suites out would report a green total that is missing 108 assertions —
	# the same class of failure that let these suites rot unnoticed before.
	# So the skip is loud, named, and can be made fatal.
	Write-Host "  SKIPPED: verify-define-tool, verify-host-boot, verify-fresh-boot-e2e" -ForegroundColor Yellow
	Write-Host "  ($exe not found — set `$env:DSH_EXE to run them)" -ForegroundColor Yellow
	if ($RequireRuntime) { exit 1 }
} else {
	$env:ELECTRON_RUN_AS_NODE = 1
	foreach ($suite in @('verify-define-tool', 'verify-host-boot', 'verify-fresh-boot-e2e')) {
		$out = & $exe --expose-internals "tools\$suite.mjs" 2>&1 | Out-String
		$row = Measure-Suite $suite $out
		$results += $row
		Write-Host ("  {0,-26} ok={1,-5} fail={2}" -f $row.Suite, $row.Passed, $row.Failed)
	}
}

# The distribution check is separate from the suites above and deliberately
# last: it PACKS the plugin, so it is only meaningful once the source it packs
# has already passed. Running it first would report on a tarball built from
# possibly-broken source. It is part of run-all rather than a manual step
# because a packaging defect is invisible in every other suite — they all run
# against the working tree, which is exactly the context that hides it.
Write-Host "== the distribution (pack, then install the packed copy) ==" -ForegroundColor Cyan
$packOut = & $node "tools\pack-dist.mjs" 2>&1 | Out-String
$packRow = Measure-Suite 'pack-dist' $packOut
$results += $packRow
Write-Host ("  {0,-26} ok={1,-5} fail={2}" -f $packRow.Suite, $packRow.Passed, $packRow.Failed)

$distOut = & $node "tools\verify-dist-installable.mjs" 2>&1 | Out-String
$distRow = Measure-Suite 'verify-dist-installable' $distOut
$results += $distRow
Write-Host ("  {0,-26} ok={1,-5} fail={2}" -f $distRow.Suite, $distRow.Passed, $distRow.Failed)

Write-Host ""
$totalOk = ($results | Measure-Object -Property Passed -Sum).Sum
$totalFail = ($results | Measure-Object -Property Failed -Sum).Sum
$broke = @($results | Where-Object { $_.Failed -gt 0 })

# The total says what RAN, so a skip cannot hide inside a green number. The
# earlier form printed "EVERY SUITE GREEN" over a total that was silently 108
# assertions short — which is the exact failure mode this file exists to fix.
Write-Host ("TOTAL {0} assertions from {1} suites  PASSED {2}  FAILED {3}" -f ($totalOk + $totalFail), $results.Count, $totalOk, $totalFail)
if ($results.Count -lt 15) {
	Write-Host ("NOTE: {0} of 15 suites ran; the packaged-runtime group was skipped." -f $results.Count) -ForegroundColor Yellow
}
if ($broke.Count -gt 0) {
	Write-Host "failing suites:" -ForegroundColor Red
	$broke | ForEach-Object { Write-Host ("  {0} ({1} failed)" -f $_.Suite, $_.Failed) -ForegroundColor Red }
	exit 1
}
Write-Host "EVERY SUITE THAT RAN IS GREEN" -ForegroundColor Green
