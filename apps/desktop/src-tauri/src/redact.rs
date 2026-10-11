//! Redaction for native diagnostics.
//!
//! The desktop shell must never write an absolute path, a credential, an OS
//! user name, a vault identifier, an e-mail address, or a command line into a
//! log, an error string, or anything else that could be copied out of the
//! machine. [`scrub`] is the single place that policy is implemented, so the
//! rules can be tested directly instead of being re-derived at each call site.
//!
//! The intent is deliberately aggressive: over-redacting a diagnostic is
//! acceptable, leaking one is not.

const REDACTED: &str = "<redacted>";
const PATH: &str = "<path>";
const COMMAND: &str = "<command>";
const VAULT_ID: &str = "<vault-key>";
const USER: &str = "<user>";

/// Literal vault identifiers that must never appear in a diagnostic.
const VAULT_LITERALS: [&str; 3] = ["tracehealer.desktop", "desktop-session", "active-session"];

/// Key names whose values are sensitive no matter how short the value is.
const SENSITIVE_NAMES: [&str; 13] = [
    "token",
    "secret",
    "password",
    "passwd",
    "verifier",
    "credential",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "code",
    "state",
    "nonce",
];

/// Absolute POSIX prefixes worth redacting as whole paths.
const POSIX_ROOTS: [&str; 10] = [
    "home/", "Users/", "root/", "var/", "tmp/", "etc/", "opt/", "mnt/", "private/", "usr/",
];

fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SENSITIVE_NAMES.iter().any(|needle| lower.contains(needle))
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_value_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '&' | '"' | '\'' | ',' | '}' | ']' | ')' | '<' | '>' | ';'
        )
}

fn is_path_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '"' | '\'' | '`' | ',' | ';' | ')' | ']' | '}' | '<' | '>'
        )
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '~' | '+')
}

fn starts_with_ci(chars: &[char], at: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    if at + needle.len() > chars.len() {
        return false;
    }
    chars[at..at + needle.len()]
        .iter()
        .zip(needle.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// Consume a run of characters accepted by `accept`, starting at `at`.
fn run_len(chars: &[char], at: usize, accept: impl Fn(char) -> bool) -> usize {
    let mut end = at;
    while end < chars.len() && accept(chars[end]) {
        end += 1;
    }
    end - at
}

/// A `name = value` pair whose value must be masked.
fn sensitive_pair(chars: &[char], at: usize) -> Option<(usize, String)> {
    let name_len = run_len(chars, at, is_ident_char);
    if name_len == 0 || !chars[at].is_ascii_alphabetic() {
        return None;
    }
    let name: String = chars[at..at + name_len].iter().collect();
    if !is_sensitive_name(&name) {
        return None;
    }

    let mut cursor = at + name_len;
    if cursor < chars.len() && chars[cursor] == '"' {
        cursor += 1;
    }
    while cursor < chars.len() && chars[cursor] == ' ' {
        cursor += 1;
    }
    if cursor >= chars.len() || !matches!(chars[cursor], '=' | ':') {
        return None;
    }
    cursor += 1;
    while cursor < chars.len() && chars[cursor] == ' ' {
        cursor += 1;
    }

    // A quoted value runs to its closing quote; anything else runs to a
    // delimiter. Either way the value is replaced, never reproduced.
    let value_start = cursor;
    let value_end = if value_start < chars.len() && matches!(chars[value_start], '"' | '\'') {
        let quote = chars[value_start];
        let mut end = value_start + 1;
        while end < chars.len() && chars[end] != quote {
            end += 1;
        }
        if end >= chars.len() {
            return None;
        }
        end + 1
    } else {
        let len = run_len(chars, value_start, is_value_char);
        if len == 0 {
            return None;
        }
        let mut end = value_start + len;
        // `Authorization: Bearer <token>` puts the credential in the *second*
        // word, so a sensitive key consumes the rest of its line. Dropping the
        // tail of a log line is the safe direction to err in.
        while end < chars.len() && chars[end] != '\n' {
            end += 1;
        }
        end
    };
    Some((value_end - at, format!("{name}={REDACTED}")))
}

/// An absolute Windows (`C:\…`), UNC (`\\…`), or well-known POSIX path.
fn absolute_path(chars: &[char], at: usize) -> Option<usize> {
    // C:\ or C:/ — but not the `s:/` inside `https://`, which is a scheme, not
    // a drive letter.
    if at + 2 < chars.len()
        && chars[at].is_ascii_alphabetic()
        && chars[at + 1] == ':'
        && matches!(chars[at + 2], '\\' | '/')
        && (at == 0 || !chars[at - 1].is_alphanumeric())
    {
        return Some(run_len(chars, at, is_path_char));
    }
    // \\server\share
    if at + 1 < chars.len() && chars[at] == '\\' && chars[at + 1] == '\\' {
        return Some(run_len(chars, at, is_path_char));
    }
    // /home/user/…, /Users/user/…, /tmp/…
    if chars[at] == '/' {
        let tail: String = chars[at + 1..].iter().take(12).collect();
        if POSIX_ROOTS
            .iter()
            .any(|root| tail.len() >= root.len() && tail[..root.len()].eq_ignore_ascii_case(root))
        {
            let len = run_len(chars, at, is_path_char);
            if len > 1 {
                return Some(len);
            }
        }
    }
    None
}

/// An executable reference plus the command line that follows it.
fn command_line(chars: &[char], at: usize) -> Option<usize> {
    let len = run_len(chars, at, |c| is_path_char(c) && !matches!(c, '(' | '<'));
    if len == 0 {
        return None;
    }
    let candidate: String = chars[at..at + len].iter().collect();
    let lower = candidate.to_ascii_lowercase();
    // `.com` is deliberately absent: it would match every domain name.
    let looks_like_program = [".exe", ".cmd", ".bat", ".ps1"]
        .iter()
        .any(|suffix| lower.ends_with(suffix));
    if !looks_like_program {
        return None;
    }
    // Everything after the program name up to the end of the line is a command
    // line (arguments, flags, paths); drop all of it.
    let mut end = at + len;
    while end < chars.len() && chars[end] != '\n' {
        end += 1;
    }
    Some(end - at)
}

/// A long, high-entropy run: an access token, JWT, PKCE verifier, or digest.
fn opaque_run(chars: &[char], at: usize) -> Option<usize> {
    if !(chars[at].is_ascii_alphanumeric() || chars[at] == '_' || chars[at] == '-') {
        return None;
    }
    let len = run_len(chars, at, is_token_char);
    if len < 32 {
        return None;
    }
    let run: Vec<char> = chars[at..at + len].to_vec();
    let has_digit = run.iter().any(|c| c.is_ascii_digit());
    let has_upper = run.iter().any(|c| c.is_ascii_uppercase());
    let has_lower = run.iter().any(|c| c.is_ascii_lowercase());
    if has_digit || (has_upper && has_lower) {
        return Some(len);
    }
    None
}

/// Redact everything sensitive from a diagnostic string.
pub fn scrub(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if starts_with_ci(&chars, i, "bearer") {
            let mut cursor = i + "bearer".len();
            let spaces = run_len(&chars, cursor, |c| c == ' ');
            cursor += spaces;
            let value = run_len(&chars, cursor, is_value_char);
            if spaces > 0 && value > 0 {
                out.push_str(&format!("Bearer {REDACTED}"));
                i = cursor + value;
                continue;
            }
        }

        if let Some((len, replacement)) = sensitive_pair(&chars, i) {
            out.push_str(&replacement);
            i += len;
            continue;
        }

        if VAULT_LITERALS
            .iter()
            .any(|literal| starts_with_ci(&chars, i, literal))
        {
            out.push_str(VAULT_ID);
            i += VAULT_LITERALS
                .iter()
                .find(|literal| starts_with_ci(&chars, i, literal))
                .map(|literal| literal.len())
                .unwrap_or(0);
            continue;
        }

        if starts_with_ci(&chars, i, "session:") {
            let len = run_len(&chars, i, |c| is_ident_char(c) || c == ':' || c == '.');
            out.push_str(VAULT_ID);
            i += len;
            continue;
        }

        // Commands before paths: a program reference swallows its whole command
        // line, which a bare path match would leave behind.
        if let Some(len) = command_line(&chars, i) {
            out.push_str(COMMAND);
            i += len;
            continue;
        }

        if let Some(len) = absolute_path(&chars, i) {
            out.push_str(PATH);
            i += len.max(1);
            continue;
        }

        if let Some(len) = opaque_run(&chars, i) {
            out.push_str(REDACTED);
            i += len;
            continue;
        }

        // user@example.com
        if chars[i].is_ascii_alphanumeric() || matches!(chars[i], '.' | '_' | '%' | '+' | '-') {
            let len = run_len(&chars, i, |c| {
                c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-' | '@')
            });
            let candidate: String = chars[i..i + len].iter().collect();
            let parts: Vec<&str> = candidate.split('@').collect();
            if parts.len() == 2
                && !parts[0].is_empty()
                && parts[1].contains('.')
                && !candidate.contains(' ')
            {
                out.push_str(&format!("{USER}@{}", parts[1]));
                i += len;
                continue;
            }
        }

        out.push(chars[i]);
        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_query_parameters_that_carry_credentials() {
        let scrubbed = scrub(
            "callback rejected: https://healer.example/auth/callback?session_token=abc123&code=SECRET99",
        );
        assert!(!scrubbed.contains("abc123"), "{scrubbed}");
        assert!(!scrubbed.contains("SECRET99"), "{scrubbed}");
        assert!(scrubbed.contains(REDACTED), "{scrubbed}");
        assert!(
            scrubbed.contains("https://healer.example/auth/callback"),
            "{scrubbed}"
        );
    }

    #[test]
    fn masks_bearer_tokens_and_json_fields() {
        let scrubbed = scrub(r#"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"#);
        assert!(!scrubbed.contains("eyJhbGciOiJIUzI1NiJ9"), "{scrubbed}");
        let json = scrub(r#"{"refresh_token":"rt_9f8e7d6c5b4a3210","ok":true}"#);
        assert!(!json.contains("rt_9f8e7d6c5b4a3210"), "{json}");
        assert!(json.contains("ok"), "{json}");
    }

    #[test]
    fn masks_windows_and_posix_paths_with_the_os_user_name() {
        let windows = scrub(r"failed to open C:\Users\Sumit\projects\tracehealer\secret.txt");
        assert!(!windows.contains("Sumit"), "{windows}");
        assert!(!windows.contains("secret.txt"), "{windows}");
        assert!(windows.contains(PATH), "{windows}");

        let unc = scrub(r"\\fileserver\share\customer\patch.diff");
        assert!(!unc.contains("patch.diff"), "{unc}");

        let posix = scrub("keychain error for /home/sumit/.config/tracehealer");
        assert!(!posix.contains("sumit"), "{posix}");
        assert!(posix.contains(PATH), "{posix}");
    }

    #[test]
    fn masks_vault_identifiers() {
        let scrubbed =
            scrub("keyring lookup tracehealer.desktop/session:tenant-a:workspace-a failed");
        assert!(!scrubbed.contains("tracehealer.desktop"), "{scrubbed}");
        assert!(!scrubbed.contains("session:tenant-a"), "{scrubbed}");
        assert!(scrubbed.contains(VAULT_ID), "{scrubbed}");
    }

    #[test]
    fn masks_command_lines_and_long_high_entropy_runs() {
        let command = scrub(r"spawned C:\tools\helper.exe --token-file .env --verbose");
        assert!(!command.contains("helper.exe"), "{command}");
        assert!(!command.contains("--verbose"), "{command}");
        assert!(command.contains(COMMAND), "{command}");

        let digest =
            scrub("digest 9f2c4b7e1a5d8c3f6b0e9a2d7c4f1b8e5a3d6c9f2b7e4a1d8c5f3b6e9a2d7c4f");
        assert!(digest.contains(REDACTED), "{digest}");
        assert!(!digest.contains("9f2c4b7e"), "{digest}");
    }

    #[test]
    fn keeps_operational_text_readable() {
        let message = scrub("run heal_69977a13 finished as healed for workspace workspace-a");
        assert_eq!(
            message,
            "run heal_69977a13 finished as healed for workspace workspace-a"
        );
        // A scheme is not a drive letter, and an ordinary URL survives intact.
        assert_eq!(
            scrub("GET https://healer.example/api/runs?limit=2 failed"),
            "GET https://healer.example/api/runs?limit=2 failed"
        );
    }

    #[test]
    fn masks_e_mail_local_parts() {
        let scrubbed = scrub("notified sumit.agg@example.com about the run");
        assert!(!scrubbed.contains("sumit.agg"), "{scrubbed}");
        assert!(scrubbed.contains("@example.com"), "{scrubbed}");
    }
}
