use async_trait::async_trait;
use community_chat_report_core::ChatReportStore;
use community_contact_core::ContactStore;
use community_notification_core::NotificationStore;
use community_publication_core::PublicationStore;
use community_query_contribution_core::QueryContributionStore;
use community_search_core::{
    CatalogPayload, CatalogSnapshot, ModelContract, SignedCatalogPackage, V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::SigningKey;
use enthusiast_v1::{
    router, AccountStore, ApiState, MatrixAccountLifecycle, MatrixAccountProvisioner,
    ProvisionedMatrixAccount,
};
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const INTERNAL_TOKEN: &str = "cli-testbench-internal-token-at-least-32-bytes";

#[derive(Default)]
struct RecordingMatrix {
    provisioned: Mutex<Vec<String>>,
    deleted: Mutex<Vec<String>>,
    locked: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl MatrixAccountProvisioner for RecordingMatrix {
    async fn provision(
        &self,
        identity_id: &str,
        _password: &str,
    ) -> Result<ProvisionedMatrixAccount, String> {
        self.provisioned
            .lock()
            .unwrap()
            .push(identity_id.to_owned());
        Ok(ProvisionedMatrixAccount {
            matrix_user_id: format!("@{identity_id}:matrix.test"),
            homeserver: "https://matrix.test".to_owned(),
        })
    }
}

#[async_trait]
impl MatrixAccountLifecycle for RecordingMatrix {
    async fn deactivate_and_erase(&self, matrix_user_id: &str) -> Result<(), String> {
        self.deleted.lock().unwrap().push(matrix_user_id.to_owned());
        Ok(())
    }

    async fn set_locked(&self, matrix_user_id: &str, locked: bool) -> Result<(), String> {
        self.locked
            .lock()
            .unwrap()
            .push((matrix_user_id.to_owned(), locked));
        Ok(())
    }
}

struct Harness {
    origin: String,
    root: tempfile::TempDir,
    publication: Arc<PublicationStore>,
    matrix: Arc<RecordingMatrix>,
    server: tokio::task::JoinHandle<()>,
}

impl Harness {
    async fn start() -> Self {
        let publication = Arc::new(PublicationStore::in_memory([7; 32]).unwrap());
        let matrix = Arc::new(RecordingMatrix::default());
        let state = ApiState::new(
            Arc::new(AccountStore::in_memory().unwrap()),
            publication.clone(),
            Arc::new(ContactStore::in_memory([8; 32]).unwrap()),
            Arc::new(ChatReportStore::in_memory([9; 32]).unwrap()),
            Arc::new(NotificationStore::in_memory([10; 32]).unwrap()),
            INTERNAL_TOKEN.as_bytes(),
        )
        .unwrap()
        .with_query_contributions(Arc::new(
            QueryContributionStore::in_memory([11; 32], 3).unwrap(),
        ))
        .with_matrix_lifecycle(matrix.clone())
        .with_matrix_provisioner(matrix.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        Self {
            origin: format!("http://{address}"),
            root: tempfile::tempdir().unwrap(),
            publication,
            matrix,
            server,
        }
    }

    fn state(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn cli_command(&self) -> Command {
        if let Some(launcher) = std::env::var_os("MFW_COMMUNITY_CLI_LAUNCHER") {
            let mut command = Command::new(launcher);
            command.arg("community");
            command
        } else {
            Command::new(env!("CARGO_BIN_EXE_monero-fast-wallet-community"))
        }
    }

    fn run(&self, state: &Path, args: &[&str]) -> Value {
        let output = self
            .cli_command()
            .arg("--api-origin")
            .arg(&self.origin)
            .arg("--state-dir")
            .arg(state)
            .arg("--allow-loopback-http")
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "command {:?} failed\nstdout={}\nstderr={}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn run_failure(&self, state: &Path, args: &[&str]) -> Value {
        let output = self
            .cli_command()
            .arg("--api-origin")
            .arg(&self.origin)
            .arg("--state-dir")
            .arg(state)
            .arg("--allow-loopback-http")
            .args(args)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "command {:?} unexpectedly succeeded\nstdout={}\nstderr={}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stderr).unwrap()
    }

    fn admin(&self, state: &Path, method: &str, path: &str, body: Option<&Path>) -> Value {
        let token = self.root.path().join("internal-token");
        private_file(&token, INTERNAL_TOKEN.as_bytes());
        let mut args = vec![
            "admin",
            "--origin",
            &self.origin,
            "--token-file",
            token.to_str().unwrap(),
            method,
            path,
        ];
        if let Some(body) = body {
            args.extend(["--body-file", body.to_str().unwrap()]);
        }
        self.run(state, &args)
    }

    fn json_file(&self, name: &str, value: Value) -> PathBuf {
        let path = self.root.path().join(name);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        path
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn unit_vector(axis: usize) -> Vec<f32> {
    let mut value = vec![0.0; V1_EMBEDDING_DIMENSION];
    value[axis] = 1.0;
    value
}

fn draft_kind(kind: &str, title: &str) -> Value {
    json!({
        "kind": kind,
        "title": title,
        "summary": "Architecture and implementation for private Monero applications.",
        "roles": ["developer"],
        "categories": ["software", "privacy"],
        "languages": ["en"],
        "coarseRegion": null,
        "radiusKm": null,
        "media": []
    })
}

fn draft(title: &str) -> Value {
    draft_kind("service_listing", title)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_cli_acceptance_flow_covers_listing_search_contacts_reports_push_and_deletion() {
    let harness = Harness::start().await;
    let alice = harness.state("alice");
    let bob = harness.state("bob");
    let carol = harness.state("carol");

    let alice_created = harness.run(&alice, &["identity", "create"]);
    assert!(alice_created.get("accessToken").is_none());
    let alice_identity = alice_created["identityId"].as_str().unwrap().to_owned();
    let bob_identity = harness.run(&bob, &["identity", "create"])["identityId"]
        .as_str()
        .unwrap()
        .to_owned();
    let carol_identity = harness.run(&carol, &["identity", "create"])["identityId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        harness.run(&alice, &["status"])["identityId"],
        alice_identity
    );
    assert_eq!(
        harness.run(&alice, &["identity", "status"])["identityId"],
        alice_identity
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(alice.join("account.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert!(
        harness.run_failure(&alice, &["identity", "delete", "--confirm", "wrong"])["error"]
            .as_str()
            .unwrap()
            .contains("exact deletion confirmation")
    );

    let first = harness.json_file("listing-1.json", draft("Private wallet engineering"));
    let submitted = harness.run(
        &alice,
        &["listing", "create", "--file", first.to_str().unwrap()],
    );
    let public_id = submitted["publicId"].as_str().unwrap().to_owned();
    assert_eq!(submitted["revision"], 1);
    assert_eq!(
        harness
            .run(&alice, &["listing", "list"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        harness.run(&alice, &["listing", "show", &public_id])["publicId"],
        public_id
    );

    // Exercise the typed convenience commands as well as the generic content
    // surface. They deliberately share the same server lifecycle but remain
    // separate public CLI contracts.
    let profile_file = harness.json_file(
        "profile-1.json",
        draft_kind("profile", "Privacy-focused Monero developer"),
    );
    let profile = harness.run(
        &alice,
        &[
            "profile",
            "create",
            "--file",
            profile_file.to_str().unwrap(),
        ],
    );
    let profile_id = profile["publicId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness.run(&alice, &["profile", "show", &profile_id])["draft"]["kind"],
        "profile"
    );
    harness.run(&alice, &["profile", "withdraw", &profile_id, "1"]);
    let profile_update = harness.json_file(
        "profile-2.json",
        draft_kind("profile", "Monero privacy engineer"),
    );
    assert_eq!(
        harness.run(
            &alice,
            &[
                "profile",
                "update",
                &profile_id,
                "--file",
                profile_update.to_str().unwrap(),
            ],
        )["revision"],
        2
    );
    harness.run(&alice, &["profile", "withdraw", &profile_id, "2"]);

    let post_file = harness.json_file(
        "post-1.json",
        draft_kind("post", "Monero Community test post"),
    );
    let post = harness.run(
        &alice,
        &["post", "create", "--file", post_file.to_str().unwrap()],
    );
    let post_id = post["publicId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness.run(&alice, &["post", "show", &post_id])["draft"]["kind"],
        "post"
    );
    harness.run(&alice, &["post", "withdraw", &post_id, "1"]);
    let post_update = harness.json_file(
        "post-2.json",
        draft_kind("post", "Updated Monero Community test post"),
    );
    assert_eq!(
        harness.run(
            &alice,
            &[
                "post",
                "update",
                &post_id,
                "--file",
                post_update.to_str().unwrap(),
            ],
        )["revision"],
        2
    );
    harness.run(&alice, &["post", "withdraw", &post_id, "2"]);

    let product_file = harness.json_file(
        "product-1.json",
        draft_kind("product_listing", "Monero hardware accessory"),
    );
    let product = harness.run(
        &alice,
        &[
            "content",
            "submit",
            "--file",
            product_file.to_str().unwrap(),
        ],
    );
    let product_id = product["publicId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness.run(&alice, &["content", "get", &product_id])["draft"]["kind"],
        "product_listing"
    );
    harness.run(&alice, &["content", "withdraw", &product_id, "1"]);
    let product_update = harness.json_file(
        "product-2.json",
        draft_kind("product_listing", "Updated Monero hardware accessory"),
    );
    assert_eq!(
        harness.run(
            &alice,
            &[
                "content",
                "resubmit",
                &product_id,
                "--file",
                product_update.to_str().unwrap(),
            ],
        )["revision"],
        2
    );
    assert!(harness
        .run(&alice, &["content", "list"])
        .as_array()
        .unwrap()
        .iter()
        .any(|record| record["publicId"] == product_id));
    harness.run(&alice, &["content", "withdraw", &product_id, "2"]);

    let wording_screening = harness.json_file(
        "wording-screening.json",
        json!({
            "modelVersion": "policy-model-v1", "rulesVersion": "community-rules-v1",
            "confidence": 0.88, "triggeredPolicy": "wording", "outcome": "wording_only",
            "optionalWordingSuggestion": "Describe the Monero-specific service more clearly."
        }),
    );
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/content/{public_id}/1/screening"),
        Some(&wording_screening),
    );
    let updated = harness.json_file("listing-2.json", draft("Private Monero wallet engineering"));
    let resubmitted = harness.run(
        &alice,
        &[
            "listing",
            "update",
            &public_id,
            "--file",
            updated.to_str().unwrap(),
        ],
    );
    assert_eq!(resubmitted["revision"], 2);

    let screening = harness.json_file(
        "screening.json",
        json!({
            "modelVersion": "policy-model-v1", "rulesVersion": "community-rules-v1",
            "confidence": 0.99, "triggeredPolicy": "none", "outcome": "clear",
            "optionalWordingSuggestion": null
        }),
    );
    let case = harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/content/{public_id}/2/screening"),
        Some(&screening),
    );
    let case_id = case["caseId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness
            .admin(
                &alice,
                "get",
                "/internal/v2/moderation/cases?limit=10",
                None
            )
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let acknowledge = harness.json_file("ack.json", json!({"moderatorId": "cli-test-moderator"}));
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/moderation/cases/{case_id}/acknowledge"),
        Some(&acknowledge),
    );
    let decision = harness.json_file("decision.json", json!({"moderatorId": "cli-test-moderator", "decision": "approve", "reason": "Acceptance-test approval."}));
    assert_eq!(
        harness.admin(
            &alice,
            "post",
            &format!("/internal/v2/moderation/cases/{case_id}/decision"),
            Some(&decision)
        )["status"],
        "approved_awaiting_embedding"
    );
    let publish = harness.json_file("publish.json", json!({"model": ModelContract::harrier_v1(), "embedding": unit_vector(0), "embeddingChunks": []}));
    assert_eq!(
        harness.admin(
            &alice,
            "post",
            &format!("/internal/v2/content/{public_id}/2/publish"),
            Some(&publish)
        )["status"],
        "published"
    );

    let signing_key = SigningKey::generate(&mut OsRng);
    let now = now_ms();
    let package = SignedCatalogPackage::create(
        &CatalogPayload::Snapshot(CatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "cli-test-v1".to_owned(),
            sequence: 1,
            model: ModelContract::harrier_v1(),
            items: harness.publication.catalog_records(now).unwrap(),
            tombstones: harness.publication.catalog_tombstones().unwrap(),
        }),
        &signing_key,
        "test-review-v1",
        "test-policy-v1",
        now - 1_000,
        now + 60_000,
    )
    .unwrap();
    let manifest = harness.root.path().join("catalog-manifest.json");
    let payload = harness.root.path().join("catalog.json");
    fs::write(&manifest, package.manifest_json).unwrap();
    fs::write(&payload, package.payload_json).unwrap();
    let verify = hex::encode(signing_key.verifying_key().to_bytes());
    let now_text = now.to_string();
    assert_eq!(
        harness.run(
            &alice,
            &[
                "catalog",
                "install",
                "--scope",
                "cli-test-v1",
                "--verifying-key-hex",
                &verify,
                "--manifest",
                manifest.to_str().unwrap(),
                "--payload",
                payload.to_str().unwrap(),
                "--now-ms",
                &now_text
            ]
        )["items"],
        1
    );
    assert_eq!(
        harness.run(
            &alice,
            &[
                "catalog",
                "status",
                "--scope",
                "cli-test-v1",
                "--verifying-key-hex",
                &verify,
                "--now-ms",
                &now_text,
            ],
        )["sequence"],
        1
    );
    let query = harness.json_file("query-vector.json", json!(unit_vector(0)));
    let results = harness.run(
        &alice,
        &[
            "catalog",
            "search",
            "--scope",
            "cli-test-v1",
            "--verifying-key-hex",
            &verify,
            "--embedding-file",
            query.to_str().unwrap(),
            "--now-ms",
            &now_text,
        ],
    );
    assert_eq!(results[0]["item"]["publicId"], public_id);

    let tampered_payload = harness.root.path().join("catalog-tampered.json");
    fs::write(&tampered_payload, b"{}").unwrap();
    assert!(harness.run_failure(
        &alice,
        &[
            "catalog",
            "install",
            "--scope",
            "cli-test-tampered",
            "--verifying-key-hex",
            &verify,
            "--manifest",
            manifest.to_str().unwrap(),
            "--payload",
            tampered_payload.to_str().unwrap(),
            "--now-ms",
            &now_text,
        ],
    )["error"]
        .as_str()
        .is_some());

    let push_token = harness.root.path().join("push-token");
    private_file(&push_token, format!("fcm:{}", "a".repeat(64)).as_bytes());
    harness.run(
        &alice,
        &[
            "notifications",
            "register",
            "alice-ci",
            "--provider",
            "fcm",
            "--token-file",
            push_token.to_str().unwrap(),
        ],
    );
    assert_eq!(
        harness
            .run(&alice, &["notifications", "list"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    harness.run(&alice, &["notifications", "remove", "alice-ci"]);
    assert!(harness
        .run(&alice, &["notifications", "list"])
        .as_array()
        .unwrap()
        .is_empty());

    let apns_token = harness.root.path().join("apns-token");
    private_file(&apns_token, "ab".repeat(32).as_bytes());
    harness.run(
        &alice,
        &[
            "notifications",
            "register",
            "alice-ios-ci",
            "--provider",
            "apns",
            "--token-file",
            apns_token.to_str().unwrap(),
        ],
    );
    assert_eq!(
        harness.run(&alice, &["notifications", "list"])[0]["provider"],
        "apns"
    );
    harness.run(&alice, &["notifications", "remove", "alice-ios-ci"]);

    let matrix_password = harness.root.path().join("matrix-password");
    private_file(
        &matrix_password,
        b"matrix-test-password-at-least-32-characters",
    );
    harness.run(
        &alice,
        &[
            "matrix",
            "provision",
            "--password-file",
            matrix_password.to_str().unwrap(),
        ],
    );
    let bob_matrix = harness.run(
        &bob,
        &[
            "matrix",
            "provision",
            "--password-file",
            matrix_password.to_str().unwrap(),
        ],
    );
    harness.run(
        &carol,
        &[
            "matrix",
            "provision",
            "--password-file",
            matrix_password.to_str().unwrap(),
        ],
    );
    assert_eq!(harness.matrix.provisioned.lock().unwrap().len(), 3);

    let declined = harness.run(&alice, &["contacts", "request", &carol_identity]);
    let declined_id = declined["requestId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness.run(&carol, &["contacts", "pending"])[0]["requestId"],
        declined_id
    );
    harness.run(&carol, &["contacts", "decline", &declined_id]);
    assert!(harness
        .run(&carol, &["contacts", "pending"])
        .as_array()
        .unwrap()
        .is_empty());

    let requested = harness.run(&alice, &["contacts", "request", &bob_identity]);
    let request_id = requested["requestId"].as_str().unwrap().to_owned();
    assert_eq!(
        harness.run(&bob, &["contacts", "pending"])[0]["requestId"],
        request_id
    );
    harness.run(&bob, &["contacts", "accept", &request_id]);
    assert_eq!(
        harness.run(&alice, &["contacts", "resolve", &bob_identity])["matrixUserId"],
        bob_matrix["matrixUserId"]
    );
    assert_eq!(
        harness
            .run(&alice, &["contacts", "accepted"])
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let report_file = harness.json_file("chat-report.json", json!({
        "selectedMessage": {"roomId": "!test-room:matrix.test", "eventId": "$test-event:matrix.test", "senderId": bob_matrix["matrixUserId"], "body": "Selected test message", "timestampMs": 123456},
        "reason": "CLI acceptance-test report", "illegalContentNotice": false, "confirmedExactMessage": true
    }));
    let report = harness.run(
        &alice,
        &[
            "contacts",
            "report-message",
            &bob_identity,
            "--file",
            report_file.to_str().unwrap(),
        ],
    );
    let report_case = report["caseId"].as_str().unwrap().to_owned();
    let report_decision = harness.json_file("chat-decision.json", json!({"moderatorId": "cli-test-moderator", "decision": "suspend_sender", "reason": "Exercise suspension and appeal."}));
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/moderation/chat-reports/{report_case}/decision"),
        Some(&report_decision),
    );
    assert_eq!(
        harness.run(&bob, &["contacts", "report-outcome", &report_case])["decision"],
        "suspend_sender"
    );
    harness.run(
        &bob,
        &[
            "contacts",
            "appeal-report",
            &report_case,
            "--reason",
            "Acceptance-test appeal",
        ],
    );
    let dismiss = harness.json_file("chat-dismiss.json", json!({"moderatorId": "cli-test-reviewer", "decision": "dismiss", "reason": "Acceptance-test reversal."}));
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/moderation/chat-reports/{report_case}/decision"),
        Some(&dismiss),
    );
    assert_eq!(harness.matrix.locked.lock().unwrap().len(), 2);

    let content_report = harness.run(
        &bob,
        &[
            "content",
            "report",
            &public_id,
            "2",
            "--reason",
            "Acceptance-test public-content report",
        ],
    );
    let content_report_case = content_report["caseId"].as_str().unwrap().to_owned();
    let hide = harness.json_file(
        "hide-decision.json",
        json!({
            "moderatorId": "cli-test-moderator", "decision": "hide",
            "reason": "Exercise owner outcome and appeal."
        }),
    );
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/moderation/cases/{content_report_case}/decision"),
        Some(&hide),
    );
    assert_eq!(
        harness.run(&alice, &["content", "outcomes"])[0]["decision"],
        "hide"
    );
    harness.run(
        &alice,
        &[
            "content",
            "appeal",
            &content_report_case,
            "--reason",
            "Acceptance-test owner appeal",
        ],
    );
    let reinstate = harness.json_file(
        "reinstate-decision.json",
        json!({
            "moderatorId": "cli-test-reviewer", "decision": "reinstate",
            "reason": "Exercise reinstatement."
        }),
    );
    assert_eq!(
        harness.admin(
            &alice,
            "post",
            &format!("/internal/v2/moderation/cases/{content_report_case}/decision"),
            Some(&reinstate),
        )["revision"],
        3
    );
    assert_eq!(
        harness.admin(
            &alice,
            "post",
            &format!("/internal/v2/content/{public_id}/3/publish"),
            Some(&publish),
        )["status"],
        "published"
    );

    harness.run(&alice, &["listing", "withdraw", &public_id, "3"]);
    let republished = harness.run(
        &alice,
        &[
            "listing",
            "republish",
            &public_id,
            "--file",
            updated.to_str().unwrap(),
        ],
    );
    assert_eq!(republished["revision"], 4);

    let model = ModelContract::harrier_v1();
    for (index, state) in [&alice, &bob, &carol].into_iter().enumerate() {
        harness.run(
            state,
            &[
                "query",
                "contribute",
                "--submission-id",
                &format!("cli-query-{index}"),
                "--query",
                "privacy friendly shopping",
                "--language",
                "en",
            ],
        );
    }
    let candidates = harness.admin(
        &alice,
        "get",
        "/internal/v2/query-contributions/candidates?limit=10",
        None,
    );
    assert_eq!(candidates[0]["independentContributors"], 3);
    let query_id = candidates[0]["queryId"].as_str().unwrap();
    let query_decision = harness.json_file("query-decision.json", json!({"moderatorId": "cli-test-moderator", "decision": "approve", "reason": "Reviewed test query.", "embedding": unit_vector(0)}));
    harness.admin(
        &alice,
        "post",
        &format!("/internal/v2/query-contributions/{query_id}/decision"),
        Some(&query_decision),
    );
    let delta_path = "/internal/v2/query-contributions/catalog-delta?catalogScopeId=cli-queries&fromSequence=1&toSequence=2&limit=10";
    assert_eq!(
        harness.admin(&alice, "get", delta_path, None)["upserts"][0]["model"],
        json!(model)
    );

    harness.run(&alice, &["contacts", "block", &bob_identity]);
    harness.run(
        &alice,
        &[
            "identity",
            "delete",
            "--confirm",
            "DELETE MY COMMUNITY PROFILE",
        ],
    );
    harness.run(
        &bob,
        &[
            "identity",
            "delete",
            "--confirm",
            "DELETE MY COMMUNITY PROFILE",
        ],
    );
    harness.run(
        &carol,
        &[
            "identity",
            "delete",
            "--confirm",
            "DELETE MY COMMUNITY PROFILE",
        ],
    );
    assert_eq!(harness.matrix.deleted.lock().unwrap().len(), 3);
    assert!(!alice.join("account.json").exists());
}
