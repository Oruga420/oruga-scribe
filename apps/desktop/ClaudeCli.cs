// ClaudeCli.cs - synthesis through the Claude Code CLI, not through an API key.
//
// Alejandro's call: no ANTHROPIC_API_KEY. The app runs `claude -p` against the person's own
// web login, or against Vertex when the environment says so. Nothing here holds a secret.
//
// THIS IS THE SECOND COPY of the spawn contract. The first is relay/claude.js, where every flag
// below was measured rather than guessed. test/cli-parity.mjs parses both and fails if they
// disagree, for the same reason scrub-parity.mjs exists: this repo has already been bitten by
// two copies of one list drifting apart.
//
// The three things that are not style preferences:
//   - Spawn the NATIVE claude.exe, never claude.cmd and never through a shell. Routing through
//     cmd.exe concatenates arguments unescaped and silently mutilates anything multiline.
//   - The system prompt goes as a FILE (--system-prompt-file), never as an argv value.
//   - --verbose is mandatory alongside -p, or the process exits immediately.
//
// Thinking stays ON here. That is deliberate and is the opposite of the narration path: on
// synthesis, quality matters and latency does not.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace OrugaScribe.Desktop
{
    public static class ClaudeCli
    {
        private const string KEY = "\"result\"";

        public const string Model = "claude-haiku-4-5";

        /// <summary>KEEP IDENTICAL to ISOLATION in relay/claude.js.</summary>
        public static readonly string[] Isolation =
        {
            "--permission-mode", "dontAsk",
            "--tools=",
            "--strict-mcp-config",
            "--mcp-config", "{\"mcpServers\":{}}",
            "--setting-sources=",
            "--disable-slash-commands"
        };

        /// <summary>KEEP IDENTICAL to the synthesize profile in relay/claude.js buildArgs().</summary>
        public static List<string> SynthesizeArgs(string systemPromptFile)
        {
            var a = new List<string>
            {
                "-p",
                "--output-format", "json",
                "--verbose",
                "--model", Model
            };
            a.AddRange(Isolation);
            a.Add("--system-prompt-file"); a.Add(systemPromptFile);
            // No dollars are billed on a subscription, but this bounds runaway token spend
            // against the shared five hour quota window.
            a.Add("--max-budget-usd"); a.Add("1.00");
            return a;
        }

        /// <summary>
        /// The native binary. Never the .cmd wrapper: DEP0190, and multiline content comes out
        /// corrupted with no error to tell you why.
        /// </summary>
        public static string ResolveExe()
        {
            var candidates = new List<string>();

            string bin = Environment.GetEnvironmentVariable("CLAUDE_BIN");
            if (!string.IsNullOrEmpty(bin)) candidates.Add(bin.Trim());

            string appData = Environment.GetEnvironmentVariable("APPDATA");
            if (!string.IsNullOrEmpty(appData))
                candidates.Add(Path.Combine(appData, "npm", "node_modules", "@anthropic-ai",
                                            "claude-code", "bin", "claude.exe"));

            string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(localApp))
                candidates.Add(Path.Combine(localApp, "Programs", "claude", "claude.exe"));

            foreach (var c in candidates)
                if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;

            throw new InvalidOperationException(
                "Could not find the native claude executable.\n\nLooked in:\n  " +
                string.Join("\n  ", candidates.ToArray()) +
                "\n\nSet CLAUDE_BIN to the full path of claude.exe.\n" +
                "Do NOT point it at claude.cmd: routing through cmd.exe corrupts arguments.");
        }

        /// <summary>
        /// Which login the CLI will use.
        /// Empty means the machine default, which is what "the person's own web login" means for
        /// a desktop app that anyone at their own desk runs. SCRIBE_CLAUDE_CONFIG_DIR overrides
        /// it, and is TRIMMED: a cmd.exe `set X=%VAR% && ...` captures the space before the &&
        /// into the value, the directory then does not exist, and the CLI reports "not logged in"
        /// on a machine that is perfectly logged in. That cost twenty minutes once already.
        /// </summary>
        public static string ConfigDir()
        {
            string raw = Environment.GetEnvironmentVariable("SCRIBE_CLAUDE_CONFIG_DIR");
            return raw == null ? "" : raw.Trim();
        }

        public static bool UsingVertex()
        {
            string v = Environment.GetEnvironmentVariable("CLAUDE_CODE_USE_VERTEX");
            return v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Asks the CLI rather than guessing from files. An earlier version of this check read
        /// oauthAccount out of .claude.json and was wrong: a working config does not necessarily
        /// carry that key, so it reported "not logged in" against a config that worked.
        /// Vertex needs no login at all, so it short circuits.
        /// </summary>
        public static bool IsReady(out string detail)
        {
            if (UsingVertex())
            {
                string proj = Environment.GetEnvironmentVariable("ANTHROPIC_VERTEX_PROJECT_ID");
                if (string.IsNullOrEmpty(proj))
                {
                    detail = "CLAUDE_CODE_USE_VERTEX is set but ANTHROPIC_VERTEX_PROJECT_ID is not.";
                    return false;
                }
                detail = "Vertex, project " + proj;
                return true;
            }

            try
            {
                var psi = NewStartInfo(ResolveExe(), new List<string> { "auth", "status" });
                using (var p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                    p.WaitForExit(20000);
                    bool ok = p.HasExited && p.ExitCode == 0 &&
                              outp.IndexOf("not logged in", StringComparison.OrdinalIgnoreCase) < 0;
                    detail = ok ? "web login" : outp.Trim();
                    return ok;
                }
            }
            catch (Exception ex)
            {
                detail = ex.Message;
                return false;
            }
        }

        private static ProcessStartInfo NewStartInfo(string exe, List<string> args)
        {
            var psi = new ProcessStartInfo(exe)
            {
                // shell:false in every sense. UseShellExecute false plus an argument string we
                // quote ourselves, because .NET Framework has no ArgumentList.
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            };
            psi.Arguments = Join(args);

            string cfg = ConfigDir();
            if (cfg.Length > 0) psi.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = cfg;

            // Belt and braces. A key in the parent environment would override the subscription
            // login and quietly start billing. This app never uses one, by decision.
            psi.EnvironmentVariables.Remove("ANTHROPIC_API_KEY");
            psi.EnvironmentVariables.Remove("ANTHROPIC_AUTH_TOKEN");

            return psi;
        }

        /// <summary>Windows argv quoting. Only what is needed: quotes and backslash runs before a quote.</summary>
        public static string Join(List<string> args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
                sb.Append('"');
                int slashes = 0;
                foreach (char c in a)
                {
                    if (c == '\\') { slashes++; continue; }
                    if (c == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); }
                    else { sb.Append('\\', slashes).Append(c); }
                    slashes = 0;
                }
                sb.Append('\\', slashes * 2).Append('"');
            }
            return sb.ToString();
        }

        /// <summary>
        /// Runs synthesis. The prompt body goes over STDIN, never in argv: argv stays short and
        /// static so nothing can mutilate a multiline document.
        /// </summary>
        public static string Synthesize(string systemPromptFile, string userContent, int timeoutMs = 300000)
        {
            if (!File.Exists(systemPromptFile))
                throw new InvalidOperationException("Missing system prompt file:\n" + systemPromptFile);

            var psi = NewStartInfo(ResolveExe(), SynthesizeArgs(systemPromptFile));

            using (var p = Process.Start(psi))
            {
                var stdout = new StringBuilder();
                var stderr = new StringBuilder();
                p.OutputDataReceived += (s, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                using (var w = new StreamWriter(p.StandardInput.BaseStream, new UTF8Encoding(false)))
                    w.Write(userContent);

                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    throw new InvalidOperationException(
                        "claude did not answer within " + (timeoutMs / 1000) + " seconds.");
                }

                string outText = stdout.ToString();
                if (p.ExitCode != 0)
                    throw new InvalidOperationException(
                        "claude exited with code " + p.ExitCode + ".\n\n" +
                        Shorten(stderr.ToString()) + "\n" + Shorten(outText));

                string result = ExtractResult(outText);
                if (string.IsNullOrEmpty(result.Trim()))
                    throw new InvalidOperationException(
                        // Empty output with exit 0 is this project's documented failure shape.
                        // Saying "success" here would be the tenth silent failure.
                        "claude returned success but no text.\n\n" + Shorten(outText));
                return result;
            }
        }

        /// <summary>
        /// Pulls "result" out of the --output-format json envelope.
        /// Deliberately narrow and hand rolled: this build has no JSON library and no NuGet.
        /// </summary>
        public static string ExtractResult(string json)
        {
            // Find the KEY, not the value. The envelope opens with {"type":"result", so a plain
            // search for the quoted word lands on that VALUE and every offset after it reads the
            // wrong field: the whole SOP came back as the single word "success". Require a colon.
            int i = -1;
            for (int at = 0; ; )
            {
                int hit = json.IndexOf(KEY, at, StringComparison.Ordinal);
                if (hit < 0) break;
                int after = hit + KEY.Length;
                while (after < json.Length && char.IsWhiteSpace(json[after])) after++;
                if (after < json.Length && json[after] == ':') { i = after; break; }
                at = hit + 1;
            }
            if (i < 0) throw new InvalidOperationException("No result field in the CLI reply:\n\n" + Shorten(json));
            int colon = i;
            if (colon < 0) throw new InvalidOperationException("Malformed CLI reply:\n\n" + Shorten(json));
            int q = json.IndexOf('"', colon + 1);
            if (q < 0) throw new InvalidOperationException("Malformed CLI reply:\n\n" + Shorten(json));

            var b = new StringBuilder();
            for (int p = q + 1; p < json.Length; p++)
            {
                char c = json[p];
                if (c == '\\')
                {
                    p++;
                    if (p >= json.Length) break;
                    char e = json[p];
                    if (e == 'n') b.Append('\n');
                    else if (e == 't') b.Append('\t');
                    else if (e == 'r') { /* dropped, the writer reintroduces line endings */ }
                    else if (e == 'u' && p + 4 < json.Length)
                    {
                        b.Append((char)Convert.ToInt32(json.Substring(p + 1, 4), 16));
                        p += 4;
                    }
                    else b.Append(e);
                }
                else if (c == '"') break;
                else b.Append(c);
            }
            return b.ToString();
        }

        private static string Shorten(string s)
        {
            if (s == null) return "";
            s = s.Trim();
            return s.Length > 700 ? s.Substring(0, 700) + " ..." : s;
        }
    }
}
