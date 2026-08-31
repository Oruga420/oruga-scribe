@echo off
REM Builds CaptureSpike.exe with the csc.exe that ships with .NET Framework 4.8.
REM No SDK, no NuGet, no install. The UIA assemblies are pulled straight from the GAC
REM because this machine has no Reference Assemblies directory.

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set GAC=C:\Windows\Microsoft.NET\assembly\GAC_MSIL

"%CSC%" /nologo /target:exe /platform:x64 /out:CaptureSpike.exe ^
  /reference:"%GAC%\UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll" ^
  /reference:"%GAC%\UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll" ^
  /reference:"%GAC%\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll" ^
  /reference:System.dll ^
  /reference:System.Core.dll ^
  /reference:System.Drawing.dll ^
  CaptureSpike.cs

if errorlevel 1 (echo BUILD FAILED & exit /b 1)
echo built CaptureSpike.exe
