# install-shortcut.ps1 - puts the oruga-scribe icon on the Desktop.
#
# Run once. Creates Desktop\oruga-scribe.lnk pointing at powershell.exe with run.ps1, windowless,
# so double clicking it goes straight to the monitor picker with no console flashing up.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- icon -------------------------------------------------------------------------------
# A .lnk needs an .ico. The project already has a 128px PNG, and the Vista era ICO format can
# carry a PNG payload verbatim, so the whole conversion is a 22 byte header in front of the
# original file. No image library, no dependency.
$icoPath = Join-Path $here 'oruga-scribe.ico'
$pngPath = Join-Path $here '..\extension\icons\icon128.png'

if (-not (Test-Path $icoPath)) {
    if (Test-Path $pngPath) {
        $png = [IO.File]::ReadAllBytes((Resolve-Path $pngPath))
        $ms = New-Object IO.MemoryStream
        $bw = New-Object IO.BinaryWriter($ms)
        $bw.Write([UInt16]0)      # reserved
        $bw.Write([UInt16]1)      # type: icon
        $bw.Write([UInt16]1)      # one image
        $bw.Write([Byte]0)        # width  0 means 256, fine for a 128 PNG payload too
        $bw.Write([Byte]0)        # height
        $bw.Write([Byte]0)        # palette
        $bw.Write([Byte]0)        # reserved
        $bw.Write([UInt16]1)      # colour planes
        $bw.Write([UInt16]32)     # bits per pixel
        $bw.Write([UInt32]$png.Length)
        $bw.Write([UInt32]22)     # offset to the payload
        $bw.Write($png)
        $bw.Flush()
        [IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
        $bw.Dispose(); $ms.Dispose()
        Write-Host "  icon written: $icoPath"
    }
    else {
        Write-Host "  no source PNG at $pngPath, falling back to the PowerShell icon"
    }
}

# ---- shortcut ---------------------------------------------------------------------------
$runPs1  = Join-Path $here 'run.ps1'
if (-not (Test-Path $runPs1)) { throw "run.ps1 not found next to this script" }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'oruga-scribe.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runPs1 + '"'
$lnk.WorkingDirectory = $here
$lnk.Description = 'Record a monitor and write the SOP'
if (Test-Path $icoPath) { $lnk.IconLocation = "$icoPath,0" }
$lnk.Save()

Write-Host "  shortcut written: $lnkPath"
Write-Host ""
Write-Host "  Double click 'oruga-scribe' on the Desktop to start."
