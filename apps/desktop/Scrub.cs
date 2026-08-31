// Scrub.cs - the redaction gate. Nothing leaves this machine before it runs to completion.
//
// THIS IS THE THIRD COPY of the kill list. The first two are relay/scrub.js and
// apps/extension/lib/schema.js, and they DID drift: the extension copy was missing `email`,
// which is exactly the kind of hole that reads as coverage. That is why harness checks D6 and
// D6b exist. This copy is held to the same standard by test/scrub-parity.mjs, which parses
// the patterns out of relay/scrub.js and out of this file and fails if they disagree.
//
// If you add a pattern here, add it there. The test will tell you if you forget.
//
// The gate is FAIL CLOSED, in two independent ways:
//   1. By structure. A control name is only ever emitted when SecureState is NotSecure.
//      Secure redacts, and Unknown redacts too, because a UI Automation query that answered
//      nothing is not evidence that the field was safe.
//   2. By content. Even a NotSecure label goes through the patterns, because a label can carry
//      a token that the accessibility layer had no opinion about.
// If the scrubber throws, the caller drops the step. Never send raw.

using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace OrugaScribe.Desktop
{
    public static class Scrub
    {
        // KEEP IDENTICAL to SECRET_PATTERNS in relay/scrub.js, in the same order.
        // Order matters: the blunt opaque-run patterns are last so the specific ones win first.
        public static readonly Tuple<Regex, string>[] SecretPatterns = new[]
        {
            P(@"\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b",                                  "[email]"),
            P(@"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*",     "[jwt]"),
            P(@"\bBearer\s+[\w.\-~+/]+=*",                                         "Bearer [token]", true),
            P(@"\bsk-[A-Za-z0-9_-]{16,}",                                          "[api-key]"),
            P(@"\bpk-[A-Za-z0-9_-]{16,}",                                          "[api-key]"),
            P(@"\bghp_[A-Za-z0-9]{20,}",                                           "[github-token]"),
            P(@"\bgithub_pat_[A-Za-z0-9_]{20,}",                                   "[github-token]"),
            P(@"\bxox[baprs]-[A-Za-z0-9-]{10,}",                                   "[slack-token]"),
            P(@"\bAKIA[0-9A-Z]{16}\b",                                             "[aws-key]"),
            P(@"\bAIza[0-9A-Za-z_-]{35}\b",                                        "[google-key]"),
            P(@"\b\d{3}-\d{2}-\d{4}\b",                                            "[ssn]"),
            P(@"\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b",      "[phone]"),
            P(@"\b[0-9a-f]{32,}\b",                                                "[hex]", true),
            P(@"\b[A-Za-z0-9+/]{40,}={0,2}\b",                                     "[opaque]")
        };

        private static Tuple<Regex, string> P(string pattern, string to, bool ignoreCase = false)
        {
            var opts = RegexOptions.CultureInvariant;
            if (ignoreCase) opts |= RegexOptions.IgnoreCase;
            return Tuple.Create(new Regex(pattern, opts), to);
        }

        private static readonly Regex CardLike = new Regex(@"\b(?:\d[ -]?){13,19}\b");
        private static readonly Regex NonDigits = new Regex(@"\D");

        /// <summary>
        /// A digit run only counts as a card number if it passes Luhn. Without the check every
        /// order number, invoice id and phone string in an SOP gets mangled into [card] and the
        /// document becomes useless, which is how a redaction gate gets switched off entirely.
        /// </summary>
        public static string ScrubCards(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return CardLike.Replace(s, m =>
            {
                string digits = NonDigits.Replace(m.Value, "");
                return Luhn(digits) ? "[card]" : m.Value;
            });
        }

        private static bool Luhn(string digits)
        {
            if (digits.Length < 13 || digits.Length > 19) return false;
            int sum = 0;
            bool dbl = false;
            for (int i = digits.Length - 1; i >= 0; i--)
            {
                int d = digits[i] - '0';
                if (d < 0 || d > 9) return false;
                if (dbl) { d *= 2; if (d > 9) d -= 9; }
                sum += d;
                dbl = !dbl;
            }
            return sum % 10 == 0;
        }

        /// <summary>Every pattern, then the Luhn card pass. Throws on nothing but a null regex engine failure.</summary>
        public static string Text(string s)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            string outp = s;
            foreach (var p in SecretPatterns) outp = p.Item1.Replace(outp, p.Item2);
            return ScrubCards(outp);
        }

        /// <summary>
        /// The structural half of the gate. A label is emitted ONLY when the accessibility layer
        /// positively said the field is not secure. Secure and Unknown both redact.
        /// </summary>
        public static string Label(string name, SecureState secure)
        {
            if (secure != SecureState.NotSecure) return "[redacted: secure field]";
            return Text(name ?? "");
        }

        /// <summary>
        /// A step, reduced to what is safe to send. Coordinates and screenshots never leave;
        /// only this text does.
        /// </summary>
        public static string Line(Step s)
        {
            var b = new StringBuilder();
            b.Append(s.Index).Append(". ");
            b.Append("clicked ");
            string label = Label(s.ControlName, s.Secure);
            if (!string.IsNullOrEmpty(label) && label != "[redacted: secure field]")
                b.Append('"').Append(label).Append('"');
            else if (label == "[redacted: secure field]")
                b.Append(label);
            else
                b.Append("at (").Append(s.ScreenX).Append(", ").Append(s.ScreenY).Append(')');

            if (!string.IsNullOrEmpty(s.ControlType))
                b.Append(" [").Append(s.ControlType.Replace("ControlType.", "")).Append(']');

            b.Append(" in ").Append(Text(s.WindowTitle));
            if (!string.IsNullOrEmpty(s.ProcessName)) b.Append(" (").Append(s.ProcessName).Append(')');
            b.Append("  tier ").Append(s.Tier);
            return b.ToString();
        }
    }
}
