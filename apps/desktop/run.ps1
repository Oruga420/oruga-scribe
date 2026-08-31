# run.ps1 - launcher for the oruga-scribe desktop recorder.
#
# Compiles OrugaScribe.cs in process and runs it. There is deliberately no .exe: Smart App
# Control is enforced on this machine and blocks a freshly built binary that has no reputation.
# powershell.exe is signed and already trusted, so hosting the code inside it is the only path
# that runs consistently today. The desktop icon points here, so it is still a double click.
#
# If this ever needs to become a real signed .exe, none of the C# changes. Only the packaging.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Show-Fatal([string]$message) {
    # This is launched from an icon with no console, so an error MUST be a window or it is
    # invisible and the app just "does nothing", which is the worst failure mode there is.
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'oruga-scribe could not start',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

try {
    . (Join-Path $here 'Build.ps1')
    $refs = Get-OrugaScribeReferences

    Add-Type -TypeDefinition (Get-OrugaScribeSource -SourceDir $here) -ReferencedAssemblies $refs -ErrorAction Stop

    # Recordings land in the repo's out\, which is gitignored. A screenshot of an admin console
    # must never become a commit.
    $root = Resolve-Path (Join-Path $here '..\..\out') -ErrorAction SilentlyContinue
    if (-not $root) {
        $root = Join-Path (Resolve-Path (Join-Path $here '..\..')) 'out'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }

    $outDir = [OrugaScribe.Desktop.App]::Run($root.ToString(), $here)

    if ($outDir) {
        Add-Type -AssemblyName System.Windows.Forms
        $steps = 0
        $jsonl = Join-Path $outDir 'steps.jsonl'
        if (Test-Path $jsonl) { $steps = @(Get-Content $jsonl).Count }
        $answer = [System.Windows.Forms.MessageBox]::Show(
            "Recording stopped.`n`n$steps steps captured.`n$outDir`n`nOpen the folder?",
            'oruga-scribe',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Information)
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Start-Process explorer.exe $outDir }
    }
}
catch {
    Show-Fatal ($_.Exception.Message + "`n`n" + $_.ScriptStackTrace)
    exit 1
}
