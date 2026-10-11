# Capture the EXACT failing assertion label for each mutation.
#
# Documentation that names an assertion is a claim, and a claim about a test
# has to be checkable — so this reads the labels out of the runner instead of
# trusting the table in DESIGN.md to have remembered them.

param([string]$Mutations = "11,12,16,19,21,22,23,24,25")

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# A target maps to a LIST, mirroring run-mutations.ps1. Without that shape a
# `monitor` mutation resolves to a single suite and half of its mutants come
# back with no label at all, which reads like "this mutant has no assertion".
$suiteFor = @{
	"client"     = @("tools\client-smoke.mjs")
	"collectors" = @("tools\smoke.mjs")
	"terminal"   = @("tools\terminal-smoke.mjs")
	"route"      = @("tools\terminal-smoke.mjs")
	"host"       = @("tools\activate-smoke.mjs")
	"monitor"    = @("tools\settings-smoke.mjs", "tools\smoke.mjs")
	"http"       = @("tools\smoke.mjs")
	"manifest"   = @("tools\pack-dist.mjs")
	"tools"      = @("tools\smoke.mjs")
}

foreach ($i in ($Mutations -split "," | ForEach-Object { [int]$_.Trim() })) {
	$line = (node tools\apply-mutation.mjs list | Select-String -Pattern "^$i`t")
	if ($null -eq $line) { continue }
	$parts = $line.ToString() -split "`t"
	$target = $parts[1].Trim("[", "]")
	$name = $parts[2]
	$suites = $suiteFor[$target]
	if ($null -eq $suites) { $suites = @() }

	node tools\apply-mutation.mjs apply $i | Out-Null
	$out = ""
	foreach ($suite in $suites) {
		$out = node $suite 2>&1 | Out-String
		if ($out -notmatch "ALL PASS") { break }
	}
	node tools\apply-mutation.mjs restore | Out-Null

	$failLines = ($out -split "`n") | Where-Object { $_ -match "^\s+FAIL " } | ForEach-Object { $_.Trim() }
	# A mutation can also be caught by an uncaught throw rather than a failed
	# assertion — M33 (the React #310 hook-order guard) is exactly that, and
	# harvesting only "FAIL" lines reported it as a mutation with no label.
	$throwLines = ($out -split "`n") | Where-Object { $_ -match "^\s*(Error|TypeError|ReferenceError|RangeError):" } | ForEach-Object { $_.Trim() }
	Write-Host "=== M$i [$target] $name"
	foreach ($f in $failLines) { Write-Host "    $f" }
	foreach ($f in $throwLines) { Write-Host "    THREW $f" }
}
