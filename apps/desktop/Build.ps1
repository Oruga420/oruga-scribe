# Build.ps1 - one place that knows how to turn this folder's C# into a compilation unit.
#
# Dot source it. Both run.ps1 and test\desktop-scrub.ps1 use it, deliberately, so the app and
# its tests compile through the SAME path. A test that builds differently from the app is a test
# of something the user never runs.
#
# The reason this exists at all: naively joining the files puts the `using` directives of the
# second and third file AFTER the first file's `namespace` block, and C# rejects that with
# "A using clause must precede all other elements defined in the namespace". The app failed to
# start and nothing said why, because the launcher hides its console.

function Get-OrugaScribeReferences {
    $gac = "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL"
    $refs = @(
        "$gac\UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll",
        "$gac\UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll",
        "$gac\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll",
        'System.dll',
        'System.Core.dll',
        'System.Drawing.dll',
        'System.Windows.Forms.dll'
    )
    foreach ($r in $refs) {
        if ($r -like '*\*' -and -not (Test-Path $r)) {
            throw "Missing reference assembly:`n$r`n`nThis needs the .NET Framework 4.x UI Automation assemblies, which ship with Windows."
        }
    }
    return $refs
}

function Get-OrugaScribeSource {
    param([Parameter(Mandatory = $true)][string]$SourceDir)

    $files = Get-ChildItem -Path $SourceDir -Filter '*.cs' | Sort-Object Name
    if ($files.Count -eq 0) { throw "No .cs sources found in $SourceDir" }

    $usings = New-Object System.Collections.Generic.List[string]
    $bodies = New-Object System.Collections.Generic.List[string]

    foreach ($f in $files) {
        $body = New-Object System.Collections.Generic.List[string]
        foreach ($line in (Get-Content $f.FullName)) {
            # Only top level using directives, which in this codebase are always at column 0.
            # A `using (var x = ...)` statement is indented and must stay in the body.
            if ($line -match '^using\s+[^\s(].*;\s*$') {
                if (-not $usings.Contains($line.Trim())) { $usings.Add($line.Trim()) }
            }
            else {
                $body.Add($line)
            }
        }
        $bodies.Add(($body -join [char]10))
    }

    return (($usings -join [char]10) + [char]10 + [char]10 + ($bodies -join [char]10))
}
