//! Notification policy: which run states deserve a toast, once only.
//!
//! The rules live here, separate from the Tauri plumbing, so they can be tested
//! without a window: terminal states only, one notification per
//! `(run, state)` pair even across reconnects, an explicit user opt-out, and a
//! body that carries an identifier and a fixed label — never trace text.

use std::collections::{HashSet, VecDeque};

/// Run states that end a run and therefore deserve a notification.
pub const TERMINAL_STATES: [&str; 5] = [
    "healed",
    "needs-review",
    "cancelled",
    "timed-out",
    "delivery-failed",
];

/// Cap on remembered notifications so a long-lived client cannot grow without
/// bound.
const MAX_REMEMBERED: usize = 256;
/// Longest run identifier the desktop accepts.
pub const MAX_RUN_ID_LEN: usize = 80;

/// A run identifier that is safe to put in a notification body and a deep link:
/// short, and restricted to the characters the server actually issues.
pub fn is_valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_LEN
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The notification destination for a run: the deep link the app already knows
/// how to open, and the only link a clicked toast can produce.
pub fn notification_target(run_id: &str) -> Option<String> {
    if !is_valid_run_id(run_id) {
        return None;
    }
    Some(format!("tracehealer://run/{run_id}"))
}

/// Human label for a terminal state. Fixed strings, so no server text can be
/// mistaken for trace content.
pub fn state_label(state: &str) -> &'static str {
    match state {
        "healed" => "Repair verified",
        "needs-review" => "Run needs review",
        "cancelled" => "Run cancelled",
        "timed-out" => "Run timed out",
        "delivery-failed" => "Delivery failed",
        _ => "Run finished",
    }
}

/// What the shell should do about a reported run state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Notify(Notification),
    Skip(SkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The state is not terminal, so nothing ends here.
    NotTerminal,
    /// The user turned notifications off.
    Disabled,
    /// This run already reported this terminal state.
    Duplicate,
    /// The run identifier is not one the desktop will put in a link.
    InvalidRunId,
}

impl SkipReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            SkipReason::NotTerminal => "not-terminal",
            SkipReason::Disabled => "disabled",
            SkipReason::Duplicate => "duplicate",
            SkipReason::InvalidRunId => "invalid-run-id",
        }
    }
}

/// The exact strings handed to the OS notification centre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: &'static str,
    pub body: String,
    pub target: String,
    pub run_id: String,
    pub state: String,
}

/// Remembers which `(run, state)` pairs have been announced.
#[derive(Default)]
pub struct NotifiedRuns {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl NotifiedRuns {
    fn key(run_id: &str, state: &str) -> String {
        format!("{run_id}:{state}")
    }

    /// Record the pair, returning false when it was already recorded.
    pub fn remember(&mut self, run_id: &str, state: &str) -> bool {
        let key = Self::key(run_id, state);
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > MAX_REMEMBERED {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }

    /// Forget a pair so it can be announced again — used when delivery failed,
    /// where silence would otherwise hide a run that ended.
    pub fn forget(&mut self, run_id: &str, state: &str) {
        let key = Self::key(run_id, state);
        self.seen.remove(&key);
        self.order.retain(|existing| existing != &key);
    }

    #[cfg(test)]
    pub fn contains(&self, run_id: &str, state: &str) -> bool {
        self.seen.contains(&Self::key(run_id, state))
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

/// Decide whether a run update becomes a notification, remembering it when it
/// does. Callers perform the effect; this function owns the policy.
pub fn decide(
    remembered: &mut NotifiedRuns,
    notifications_allowed: bool,
    run_id: &str,
    state: &str,
) -> Decision {
    if !notifications_allowed {
        return Decision::Skip(SkipReason::Disabled);
    }
    if !TERMINAL_STATES.contains(&state) {
        return Decision::Skip(SkipReason::NotTerminal);
    }
    let Some(target) = notification_target(run_id) else {
        return Decision::Skip(SkipReason::InvalidRunId);
    };
    if !remembered.remember(run_id, state) {
        return Decision::Skip(SkipReason::Duplicate);
    }
    Decision::Notify(Notification {
        title: state_label(state),
        // An identifier and a fixed label only: trace text, repository names,
        // file paths, and error bodies never reach the notification centre.
        body: format!("Run {run_id} finished as {state}."),
        target,
        run_id: run_id.to_string(),
        state: state.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_terminal_states_notify() {
        for state in TERMINAL_STATES {
            let mut remembered = NotifiedRuns::default();
            assert!(
                matches!(
                    decide(&mut remembered, true, "heal_1", state),
                    Decision::Notify(_)
                ),
                "{state}"
            );
        }
        for state in ["queued", "verifying", "reproducing", "patching", ""] {
            let mut remembered = NotifiedRuns::default();
            assert_eq!(
                decide(&mut remembered, true, "heal_1", state),
                Decision::Skip(SkipReason::NotTerminal),
                "{state}"
            );
            assert!(remembered.is_empty(), "{state} must not be remembered");
        }
    }

    #[test]
    fn a_disabled_setting_suppresses_everything() {
        let mut remembered = NotifiedRuns::default();
        assert_eq!(
            decide(&mut remembered, false, "heal_1", "healed"),
            Decision::Skip(SkipReason::Disabled)
        );
        // Nothing is remembered while disabled, so enabling later still
        // announces the current state once.
        assert!(remembered.is_empty());
        assert!(matches!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Notify(_)
        ));
    }

    #[test]
    fn deduplication_is_per_run_and_per_state() {
        let mut remembered = NotifiedRuns::default();
        assert!(matches!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Notify(_)
        ));
        // A reconnect that replays the same terminal state stays silent.
        assert_eq!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Skip(SkipReason::Duplicate)
        );
        assert_eq!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Skip(SkipReason::Duplicate)
        );
        // A different run, or a different terminal state for the same run, is
        // still news.
        assert!(matches!(
            decide(&mut remembered, true, "heal_2", "healed"),
            Decision::Notify(_)
        ));
        assert!(matches!(
            decide(&mut remembered, true, "heal_1", "needs-review"),
            Decision::Notify(_)
        ));
        assert!(remembered.contains("heal_1", "healed"));
        assert_eq!(remembered.len(), 3);
    }

    #[test]
    fn notification_text_never_carries_trace_content() {
        let mut remembered = NotifiedRuns::default();
        let decision = decide(&mut remembered, true, "heal_69977a13", "delivery-failed");
        let Decision::Notify(notification) = decision else {
            panic!("expected a notification");
        };
        assert_eq!(notification.title, "Delivery failed");
        assert_eq!(
            notification.body,
            "Run heal_69977a13 finished as delivery-failed."
        );
        let haystack = format!("{} {}", notification.title, notification.body);
        for leak in ["/home/", "C:\\", "token", "secret", "stack", "Traceback"] {
            assert!(!haystack.contains(leak), "{haystack}");
        }
    }

    #[test]
    fn the_target_is_the_deep_link_the_app_can_open() {
        assert_eq!(
            notification_target("heal_69977a13").as_deref(),
            Some("tracehealer://run/heal_69977a13")
        );
        for hostile in [
            "",
            "../../etc/passwd",
            "run with spaces",
            "run\ninjection",
            "tracehealer://run/other",
            &"a".repeat(MAX_RUN_ID_LEN + 1),
        ] {
            assert_eq!(notification_target(hostile), None, "{hostile}");
            let mut remembered = NotifiedRuns::default();
            assert_eq!(
                decide(&mut remembered, true, hostile, "healed"),
                Decision::Skip(SkipReason::InvalidRunId),
                "{hostile}"
            );
        }
    }

    #[test]
    fn a_failed_delivery_can_be_retried() {
        let mut remembered = NotifiedRuns::default();
        assert!(matches!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Notify(_)
        ));
        assert_eq!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Skip(SkipReason::Duplicate)
        );
        remembered.forget("heal_1", "healed");
        assert!(matches!(
            decide(&mut remembered, true, "heal_1", "healed"),
            Decision::Notify(_)
        ));
    }

    #[test]
    fn memory_is_bounded() {
        let mut remembered = NotifiedRuns::default();
        for index in 0..(MAX_REMEMBERED * 2) {
            assert!(remembered.remember(&format!("heal_{index}"), "healed"));
        }
        assert!(remembered.len() <= MAX_REMEMBERED);
        // The oldest entries were evicted; the newest are still deduplicated.
        assert!(remembered.contains(&format!("heal_{}", MAX_REMEMBERED * 2 - 1), "healed"));
    }

    #[test]
    fn every_reason_has_a_stable_string() {
        for (reason, expected) in [
            (SkipReason::NotTerminal, "not-terminal"),
            (SkipReason::Disabled, "disabled"),
            (SkipReason::Duplicate, "duplicate"),
            (SkipReason::InvalidRunId, "invalid-run-id"),
        ] {
            assert_eq!(reason.as_str(), expected);
        }
    }
}
