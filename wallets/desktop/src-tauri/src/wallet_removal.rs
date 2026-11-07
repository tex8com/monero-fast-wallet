//! Session ownership changes for destructive wallet removal. No disk or secret
//! storage operation belongs here: callers may begin those only after success.
use std::collections::{HashMap, HashSet};

/// Close each native session once, retaining sessions still owned by a saved
/// registration outside this removal. Callers keep the session map stable and
/// serialize native operations while this runs. A failed close keeps its owners
/// intact. Already closed groups must stay removed, even if a later close fails,
/// because restoring those handles would leave stale sessions in the UI.
pub fn close_and_remove_session_owners(
    sessions: &mut HashMap<String, String>,
    removed_keys: &[String],
    mut close: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let removed_keys = removed_keys
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut native_sessions = sessions
        .iter()
        .filter(|(key, _)| removed_keys.contains(key.as_str()))
        .map(|(_, native_id)| native_id.clone())
        .collect::<Vec<_>>();
    // Stable order makes retries and phase timing reproducible without logging
    // any wallet/session identifiers.
    native_sessions.sort_unstable();
    native_sessions.dedup();
    for native_id in native_sessions {
        let retained_owner = sessions
            .iter()
            .any(|(key, value)| value == &native_id && !removed_keys.contains(key.as_str()));
        if !retained_owner {
            close(&native_id)?;
        }
        sessions.retain(|key, value| value != &native_id || !removed_keys.contains(key.as_str()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::close_and_remove_session_owners;
    use std::collections::HashMap;

    fn map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn keys(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn failed_close_preserves_all_affected_owners_and_blocks_later_removal() {
        let mut sessions = map(&[("parent", "session-a"), ("child", "session-a")]);
        let before = sessions.clone();
        let mut local_data_removed = false;
        let result =
            close_and_remove_session_owners(&mut sessions, &keys(&["parent", "child"]), |_| {
                Err("native-close-timeout".to_owned())
            })
            .map(|()| {
                local_data_removed = true;
            });
        assert_eq!(result, Err("native-close-timeout".to_owned()));
        assert_eq!(sessions, before);
        assert!(!local_data_removed);
    }

    #[test]
    fn retained_external_owner_prevents_closing_shared_container() {
        let mut sessions = map(&[("removed", "shared"), ("kept", "shared")]);
        close_and_remove_session_owners(&mut sessions, &keys(&["removed"]), |_| {
            panic!("a retained wallet still owns this native session")
        })
        .unwrap();
        assert_eq!(sessions, map(&[("kept", "shared")]));
    }

    #[test]
    fn all_aliases_and_distinct_ledger_signing_handle_close_once() {
        let mut sessions = map(&[
            ("parent", "a-view"),
            ("companion", "a-view"),
            ("__ledger-signing-session:parent", "b-sign"),
            ("unrelated", "c-kept"),
        ]);
        let mut closed = Vec::new();
        close_and_remove_session_owners(
            &mut sessions,
            &keys(&["parent", "companion", "__ledger-signing-session:parent"]),
            |native_id| {
                closed.push(native_id.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(closed, vec!["a-view", "b-sign"]);
        assert_eq!(sessions, map(&[("unrelated", "c-kept")]));
    }

    #[test]
    fn partial_failure_retains_only_live_handles_and_retry_does_not_close_stale_handle() {
        let mut sessions = map(&[
            ("first", "a-closed"),
            ("second", "b-busy"),
            ("third", "c-live"),
        ]);
        let removed = keys(&["first", "second", "third"]);
        let mut closed = Vec::new();
        let result = close_and_remove_session_owners(&mut sessions, &removed, |native_id| {
            if native_id == "b-busy" {
                return Err("busy".to_owned());
            }
            closed.push(native_id.to_owned());
            Ok(())
        });
        assert_eq!(result, Err("busy".to_owned()));
        assert_eq!(closed, vec!["a-closed"]);
        assert_eq!(sessions, map(&[("second", "b-busy"), ("third", "c-live")]));
        close_and_remove_session_owners(&mut sessions, &removed, |native_id| {
            closed.push(native_id.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(closed, vec!["a-closed", "b-busy", "c-live"]);
        assert!(sessions.is_empty());
    }

    #[test]
    fn closed_wallet_needs_no_native_close() {
        let mut sessions = map(&[("other", "kept")]);
        close_and_remove_session_owners(&mut sessions, &keys(&["already-closed"]), |_| {
            panic!("there is no open handle to close")
        })
        .unwrap();
        assert_eq!(sessions, map(&[("other", "kept")]));
    }
}
