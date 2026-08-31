// SopWriter.cs - turns a finished recording into a Standard Operating Procedure.
//
// No API key. Synthesis runs through the Claude Code CLI against the person's own web login,
// or against Vertex when the environment says so. Alejandro's decision: this app never holds a
// secret, and it never bills a key. See ClaudeCli.cs for the spawn contract.
//
// What leaves this machine, and what does not:
//   LEAVES   the goal, and one scrubbed text line per step (see Scrub.cs)
//   NEVER    screenshots, coordinates, window handles, process paths, raw control names
// Screenshots stay local on purpose. Sending pixels would mean the redaction gate could not be
// authoritative, which is the exact criticism this project levels at microsoft/skill-recorder.
//
// The system prompt is relay/prompts/sop-system.txt, the same file the browser front end uses.
// Not a copy of it. The relay is the shared backend by design, and a second SOP prompt would
// drift from the first the first time either was tuned.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace OrugaScribe.Desktop
{
    public static class SopWriter
    {
        /// <summary>
        /// Walks up from the app folder to the repo root and returns the shared SOP prompt.
        /// </summary>
        public static string SystemPromptFile(string appDir)
        {
            var dir = new DirectoryInfo(appDir);
            for (int i = 0; i < 6 && dir != null; i++)
            {
                string candidate = Path.Combine(dir.FullName, "relay", "prompts", "sop-system.txt");
                if (File.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            throw new InvalidOperationException(
                "Could not find relay\\prompts\\sop-system.txt above:\n" + appDir +
                "\n\nThe desktop app shares the browser front end's SOP prompt on purpose.");
        }

        /// <summary>
        /// Reads a finished session, calls the CLI, writes SOP.md next to the steps.
        /// Returns the path, or throws with a message worth putting in front of a human.
        /// </summary>
        public static string Write(string sessionDir, IEnumerable<Step> steps, string goal, string appDir)
        {
            string detail;
            if (!ClaudeCli.IsReady(out detail))
                throw new InvalidOperationException(
                    "Claude is not signed in on this machine, so the SOP cannot be written.\n\n" +
                    detail + "\n\n" +
                    "The recording itself is safe and complete in:\n" + sessionDir + "\n\n" +
                    "Sign in once, then record again:\n" +
                    "  claude\n" +
                    "and run /login inside it.");

            // The redaction gate. Runs to completion before a single byte is composed into the
            // prompt. If it throws for a step, that step is dropped rather than sent raw.
            var lines = new List<string>();
            int dropped = 0;
            foreach (var s in steps)
            {
                try { lines.Add(Scrub.Line(s)); }
                catch { dropped++; }
            }

            if (lines.Count == 0)
                throw new InvalidOperationException(
                    "No steps survived the redaction gate, so there is nothing to write about.");

            var user = new StringBuilder();
            user.Append("Goal as stated before recording: ")
                .Append(string.IsNullOrEmpty(goal) ? "(none given)" : goal)
                .Append("\n\n");
            user.Append("Observed steps, one per click, in order.\n");
            user.Append("A step marked 'tier 1' means the accessibility layer did not answer, so the\n");
            user.Append("control has no name and only the window and coordinates are known. Do not\n");
            user.Append("invent a name for it. A step reading '[redacted: secure field]' landed on a\n");
            user.Append("password field, or on a field whose status could not be established. Never\n");
            user.Append("guess what it contained.\n\n");
            foreach (var l in lines) user.Append(l).Append('\n');
            if (dropped > 0)
                user.Append("\nNote: ").Append(dropped)
                    .Append(" step(s) were dropped by the redaction gate and are not shown.\n");

            string markdown = ClaudeCli.Synthesize(SystemPromptFile(appDir), user.ToString());

            string sopPath = Path.Combine(sessionDir, "SOP.md");
            File.WriteAllText(sopPath, markdown, new UTF8Encoding(false));
            return sopPath;
        }
    }
}
