# Mutation-test driver.
#
# Runs ONE child process per mutation. `apply-mutation.mjs apply` writes the
# mutant, the suite runs, `restore` puts every target back from its immutable
# pristine copy. Spawning each step as its own process is deliberate: a driver
# that reused one in-process module would keep the pre-mutation code in its
# cache and report every mutant as "not caught".
#
# A mutation that comes back GREEN is a test gap, not a passing grade, so the
# exit code is non-zero if any mutant survives.
#
# Usage: powershell -File tools\run-mutations.ps1 [-From 0] [-To 37]

param([int]$From = 0, [int]$To = 40)

$ErrorActionPreference = "Continue"
# Resolved from this script's own location so a checkout anywhere works.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Which suite is supposed to catch which target. The terminal half is covered by
# the terminal suite; everything else lands in the client or host smoke suites.
#
# A target maps to a LIST, not a single suite: `monitor` is the natural home of
# two unrelated concerns (credential resolution, and what the exec audit row
# records), and each is asserted where it can actually be observed. Pointing both
# at one suite would make half of that target's mutants unkillable.
$suiteFor = @{
	"client"     = @("tools\client-smoke.mjs")
	"collectors" = @("tools\smoke.mjs")
	"terminal"   = @("tools\terminal-smoke.mjs")
	"route"      = @("tools\terminal-smoke.mjs")
	"host"       = @("tools\activate-smoke.mjs")
	# `withStoredSecret` is asserted by the settings suite, which walks the roster
	# and the draft route's payload shapes; the exec-audit contract is asserted
	# from the `device_exec` call site in the smoke suite, against the on-disk log.
	"monitor"    = @("tools\settings-smoke.mjs", "tools\smoke.mjs")
	# The trust fence is exercised through the real route layer by the main
	# smoke suite, which drives it over HTTP rather than by calling the predicate
	# — so a mutant here has to survive the wire to be reported green.
	"http"       = @("tools\smoke.mjs")
	# A packaging defect is invisible to the working tree — the file that never
	# ships is still present there. `pack-dist.mjs` is the only suite that asks
	# what the TARBALL contains, so the manifest target is paired with it.
	"manifest"   = @("tools\pack-dist.mjs")
	# The Agent tool definitions. Every one of them is driven from the public
	# entry point in the smoke suite, which is where the tool roster is pinned.
	"tools"      = @("tools\smoke.mjs")
	# The distribution checker's own expectations. Its subject is the packed
	# artefact, so mutating the checker is the only way to prove its guards can
	# fail — a guard that reads what it validates is green forever, and no
	# mutation of the product would ever reveal that.
	"packdist"   = @("tools\pack-dist.mjs")
}

$results = @()
for ($i = $From; $i -le $To; $i++) {
	$line = (node tools\apply-mutation.mjs list | Select-String -Pattern "^$i`t")
	if ($null -eq $line) { continue }
	$parts = $line.ToString() -split "`t"
	$target = $parts[1].Trim("[", "]")
	$name = $parts[2]
	$suites = $suiteFor[$target]
	if ($null -eq $suites) { $suites = @() }

	$applied = node tools\apply-mutation.mjs apply $i 2>&1 | Out-String
	if ($applied -notmatch "APPLIED") {
		$results += [pscustomobject]@{ Index=$i; Target=$target; Verdict="ANCHOR-MISSING"; Name=$name }
		node tools\apply-mutation.mjs restore | Out-Null
		continue
	}

	# Run every paired suite and keep the FIRST one that goes red. The verdict is
	# "caught" only if some suite actually failed; a mutant the suites disagree
	# about is still a caught mutant, and the failing suite's output is the one
	# worth reporting.
	$out = ""
	foreach ($suite in $suites) {
		$out = node $suite 2>&1 | Out-String
		if ($out -notmatch "ALL PASS") { break }
	}
	node tools\apply-mutation.mjs restore | Out-Null

	# A suite that crashed is a catch too, but it has to be labelled, because a
	# crash and a failed assertion are different kinds of evidence.
	$crashed = $out -match "ERR_|TypeError|ReferenceError|SyntaxError|heap out of memory"
	$green = $out -match "ALL PASS"
	if ($green) {
		$verdict = "SURVIVED"
	} elseif ($crashed -and $out -notmatch "FAILURES") {
		$verdict = "CAUGHT-CRASH"
	} else {
		$verdict = "CAUGHT"
	}
	$results += [pscustomobject]@{ Index=$i; Target=$target; Verdict=$verdict; Name=$name }
	Write-Host ("{0,2} {1,-8} {2}" -f $i, $verdict, $name)
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
$survived = @($results | Where-Object { $_.Verdict -eq "SURVIVED" -or $_.Verdict -eq "ANCHOR-MISSING" })
Write-Host ("TOTAL {0}  CAUGHT {1}  SURVIVED/MISSING {2}" -f $results.Count, (@($results | Where-Object { $_.Verdict -like "CAUGHT*" }).Count), $survived.Count)
if ($survived.Count -gt 0) { exit 1 }
