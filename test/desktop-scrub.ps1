# test/desktop-scrub.ps1 - the desktop redaction gate, and the API reply parser.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\desktop-scrub.ps1
#
# scrub-parity.mjs proves the pattern LIST is identical to relay/scrub.js. This proves the gate
# actually CLOSES, which is a different claim. The load bearing one is the three state secure
# flag: Unknown must redact, because a UI Automation query that answered nothing is not evidence
# that the field was safe. That single confusion is the bug this whole design exists to avoid.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = Join-Path $root 'apps\desktop'

. (Join-Path $desktop 'Build.ps1')
$refs = Get-OrugaScribeReferences
$code = Get-OrugaScribeSource -SourceDir $desktop

Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -ErrorAction Stop

$script:pass = 0
$script:fail = 0
$script:failed = @()

function Ok($name, $detail) {
  $script:pass++
  if ($detail) { Write-Output ("  PASS  " + $name + "   " + $detail) }
  else { Write-Output ("  PASS  " + $name) }
}
function Bad($name, $why) {
  $script:fail++
  $script:failed += $name
  Write-Output ("  FAIL  " + $name + [char]10 + "        " + $why)
}
function Expect($name, $actual, $expected) {
  if ($actual -eq $expected) { Ok $name $actual }
  else { Bad $name ("got:      " + $actual + [char]10 + "        expected: " + $expected) }
}

$S = [OrugaScribe.Desktop.Scrub]
$Sec = [OrugaScribe.Desktop.SecureState]

Write-Output ""
Write-Output "  the three state secure flag, which is the whole point"
Write-Output ""

Expect "a field UIA positively called NOT a password keeps its label" `
  ($S::Label("Username", $Sec::NotSecure)) "Username"

Expect "a field UIA called a password is redacted" `
  ($S::Label("Password", $Sec::Secure)) "[redacted: secure field]"

Expect "a field UIA could not answer for is redacted TOO, it is not assumed safe" `
  ($S::Label("Password", $Sec::Unknown)) "[redacted: secure field]"

Expect "an innocent looking label is still redacted when the state is Unknown" `
  ($S::Label("Search", $Sec::Unknown)) "[redacted: secure field]"

Write-Output ""
Write-Output "  content patterns, on a label the tree swore was safe"
Write-Output ""

Expect "an email in a safe label is still redacted" `
  ($S::Label("write to chuckbassdelamora@gmail.com now", $Sec::NotSecure)) "write to [email] now"

Expect "an anthropic style key is redacted" `
  ($S::Text("key sk-ant0123456789abcdefghij end")) "key [api-key] end"

Expect "a github token is redacted" `
  ($S::Text("ghp_abcdefghijklmnopqrstuvwxyz0123")) "[github-token]"

Expect "a slack token is redacted" `
  ($S::Text("xoxb-1234567890-abcdefghij")) "[slack-token]"

Expect "an aws key is redacted" `
  ($S::Text("AKIAIOSFODNN7EXAMPLE")) "[aws-key]"

Expect "a bearer header is redacted but the scheme survives" `
  ($S::Text("Authorization: Bearer abc.def.ghi")) "Authorization: Bearer [token]"

Expect "a jwt is redacted" `
  ($S::Text("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc")) "[jwt]"

Write-Output ""
Write-Output "  Luhn, so real documents do not get mangled into uselessness"
Write-Output ""

# The card regex is (?:\d[ -]?){13,19}, so the optional separator after the LAST digit is
# part of the match and the following space is eaten. Cosmetic, and inherited verbatim from
# relay/scrub.js. Asserted as it actually behaves rather than as it reads, because the port
# being FAITHFUL matters more than the space: diverging here would break scrub-parity.mjs and
# reintroduce exactly the drift that put a hole in the extension copy.
Expect "a number that passes Luhn is treated as a card" `
  ($S::ScrubCards("card 4242424242424242 ok")) "card [card]ok"

Expect "and the same quirk is what relay/scrub.js does, so the port is faithful" `
  ($S::ScrubCards("4242424242424242")) "[card]"

Expect "a digit run that FAILS Luhn is left alone, it is an order number" `
  ($S::ScrubCards("order 4242424242424243 ok")) "order 4242424242424243 ok"

Write-Output ""
Write-Output "  the API reply parser"
Write-Output ""

$C = [OrugaScribe.Desktop.ClaudeCli]
# The reply is now the --output-format json envelope from the CLI, not an API messages body.
# Built from char codes on purpose: a literal \n inside a quoted string in this file has
# been silently turned into a real newline more than once, which made the fixture invalid JSON.
$esc = [char]92 + "n"                      # the two characters backslash and n
$sample = '{"type":"result","subtype":"success","is_error":false,"result":"# Title' + $esc + $esc + 'Line with a ' + [char]92 + '"quote' + [char]92 + '" in it."}'
Expect "the CLI result is extracted and unescaped" `
  ($C::ExtractResult($sample)) ("# Title" + [char]10 + [char]10 + 'Line with a "quote" in it.')

try {
  $C::ExtractResult('{"type":"error","error":{"message":"bad login"}}') | Out-Null
  Bad "a reply with no result field throws rather than returning junk" "it returned instead of throwing"
} catch {
  Ok "a reply with no result field throws rather than returning junk" "and the body is carried in the message"
}

Write-Output ""
Write-Output "  argv quoting, because cmd.exe corruption is silent"
Write-Output ""

$args1 = New-Object 'System.Collections.Generic.List[string]'
$args1.Add("--mcp-config"); $args1.Add('{"mcpServers":{}}')
Expect "inner quotes are escaped so the JSON survives argv" `
  ($C::Join($args1)) '--mcp-config "{\"mcpServers\":{}}"'

$args2 = New-Object 'System.Collections.Generic.List[string]'
$args2.Add("--tools=")
Expect "an empty valued flag stays ONE token" ($C::Join($args2)) "--tools="

Write-Output ""
Write-Output "  the spawn contract itself"
Write-Output ""

Expect "the synthesis model is the measured one" $C::Model "claude-haiku-4-5"

$syn = $C::SynthesizeArgs("C:\prompt.txt")
Expect "--verbose is present, without it -p exits immediately" `
  ([bool]($syn -contains "--verbose")) $true
Expect "the system prompt is passed as a FILE" `
  ([bool]($syn -contains "--system-prompt-file")) $true
Expect "the isolation flags are all carried" `
  (($C::Isolation | Measure-Object).Count) 8

Write-Output ""
Write-Output "  nombres de control utiles vs el titulo de la ventana disfrazado"
Write-Output ""

$R = [OrugaScribe.Desktop.Recorder]

# Los cinco casos falsos de la primera grabacion real, sobre Blender.
Expect "el titulo de la ventana devuelto como nombre de control NO cuenta" `
  ($R::IsUsefulName("(Unsaved) - Blender 5.1.1", "(Unsaved) - Blender 5.1.1")) $false

Expect "ni con el asterisco de documento modificado, que lo hace ver distinto" `
  ($R::IsUsefulName("* (Unsaved) - Blender 5.1.1", "(Unsaved) - Blender 5.1.1")) $false

Expect "ni al reves, titulo con asterisco y control sin el" `
  ($R::IsUsefulName("(Unsaved) - Blender 5.1.1", "* (Unsaved) - Blender 5.1.1")) $false

Expect "un nombre de control de verdad SI cuenta" `
  ($R::IsUsefulName("Save", "(Unsaved) - Blender 5.1.1")) $true

Expect "un nombre que solo CONTIENE el titulo sigue contando, no se descarta de mas" `
  ($R::IsUsefulName("Close (Unsaved) - Blender 5.1.1", "(Unsaved) - Blender 5.1.1")) $true

Expect "vacio no cuenta" ($R::IsUsefulName("", "cualquier ventana")) $false
Expect "solo espacios no cuenta" ($R::IsUsefulName("   ", "cualquier ventana")) $false

Expect "sin titulo de ventana, un nombre cualquiera se acepta" `
  ($R::IsUsefulName("Text editor", "")) $true

Write-Output ""
Write-Output ("=" * 62)
Write-Output ("  " + $script:pass + " passed, " + $script:fail + " failed")
if ($script:fail -gt 0) {
  Write-Output ("  failing: " + ($script:failed -join ", "))
  exit 1
}
Write-Output "  the gate closes"
