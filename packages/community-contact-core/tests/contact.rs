use community_contact_core::{ContactError, ContactStatus, ContactStore};
use std::fs;

const NOW: u64 = 2_000_000_000_000;

fn register(store: &ContactStore) {
    store
        .register_matrix_identity("person_alice", "@alice:matrix.example", NOW)
        .unwrap();
    store
        .register_matrix_identity("person_bob", "@bob:matrix.example", NOW)
        .unwrap();
}

#[test]
fn matrix_identity_is_disclosed_only_after_explicit_acceptance() {
    let store = ContactStore::in_memory([7_u8; 32]).unwrap();
    register(&store);
    let request = store
        .request("person_alice", "person_bob", NOW + 1)
        .unwrap();
    assert_eq!(request.status, ContactStatus::Pending);
    assert!(matches!(
        store.resolve_accepted("person_alice", "person_bob"),
        Err(ContactError::NotFound)
    ));
    let accepted = store
        .respond("person_bob", &request.request_id, true, NOW + 2)
        .unwrap();
    assert_eq!(accepted.status, ContactStatus::Accepted);
    assert_eq!(
        store
            .resolve_accepted("person_alice", "person_bob")
            .unwrap()
            .matrix_user_id,
        "@bob:matrix.example"
    );
    assert_eq!(
        store
            .resolve_accepted("person_bob", "person_alice")
            .unwrap()
            .matrix_user_id,
        "@alice:matrix.example"
    );
    assert_eq!(
        store
            .accepted_for("person_alice")
            .unwrap()
            .into_iter()
            .map(|contact| contact.peer_id)
            .collect::<Vec<_>>(),
        vec!["person_bob"]
    );
}

#[test]
fn blocking_revokes_an_accepted_contact_in_both_directions() {
    let store = ContactStore::in_memory([8_u8; 32]).unwrap();
    register(&store);
    let request = store
        .request("person_alice", "person_bob", NOW + 1)
        .unwrap();
    store
        .respond("person_bob", &request.request_id, true, NOW + 2)
        .unwrap();
    store.block("person_bob", "person_alice", NOW + 3).unwrap();
    assert!(store
        .resolve_accepted("person_alice", "person_bob")
        .is_err());
    assert!(store
        .resolve_accepted("person_bob", "person_alice")
        .is_err());
    assert!(store
        .request("person_alice", "person_bob", NOW + 4)
        .is_err());
}

#[test]
fn deleting_an_identity_removes_matrix_and_contact_access() {
    let store = ContactStore::in_memory([5u8; 32]).unwrap();
    register(&store);
    let request = store
        .request("person_alice", "person_bob", NOW + 1)
        .unwrap();
    store
        .respond("person_bob", &request.request_id, true, NOW + 2)
        .unwrap();
    store.delete_identity("person_alice", NOW + 3).unwrap();
    assert!(store
        .resolve_accepted("person_bob", "person_alice")
        .is_err());
    assert!(store
        .request("person_bob", "person_alice", NOW + 4)
        .is_err());
}

#[test]
fn encrypted_database_does_not_contain_matrix_ids() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("contacts.sqlite3");
    let store = ContactStore::open(&database, [9_u8; 32]).unwrap();
    register(&store);
    drop(store);
    let bytes = fs::read(database).unwrap();
    for secret in ["@alice:matrix.example", "@bob:matrix.example"] {
        assert!(!bytes
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
    }
}

#[test]
fn reverse_pending_request_and_self_contact_fail_closed() {
    let store = ContactStore::in_memory([10_u8; 32]).unwrap();
    register(&store);
    store
        .request("person_alice", "person_bob", NOW + 1)
        .unwrap();
    assert!(matches!(
        store.request("person_bob", "person_alice", NOW + 2),
        Err(ContactError::Conflict)
    ));
    assert!(store
        .request("person_alice", "person_alice", NOW + 3)
        .is_err());
}
