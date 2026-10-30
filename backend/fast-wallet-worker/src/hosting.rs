use super::*;
use fast_wallet_protocol::{hosting_status_body, HOSTING_PROOF_LIFETIME_SECONDS};
use fast_wallet_relay::hosting::{hosting_pull_body, HostingChallenge, HostingResponse, CONTRACT};

impl OutboundRelayWorker {
    pub(crate) fn process_hosting_checks(
        &self,
        relay: &dyn RelayClient,
        now: u64,
    ) -> anyhow::Result<()> {
        let auth = WorkerRequestAuth::sign(
            &self.descriptor,
            &self.online_signing_key,
            WorkerAuthPurpose::Pull,
            &hosting_pull_body(&self.descriptor.worker_root_id(), 16),
            now,
            now.saturating_add(30),
        )?;
        let Some(challenges) = relay.pull_hosting_checks(&self.descriptor, &auth, 16, now)? else {
            return Ok(());
        };
        if challenges.len() > 16 {
            anyhow::bail!("too many hosting challenges");
        }
        for challenge in challenges {
            let response = self.check_hosting_challenge(&challenge, now)?;
            relay.complete_hosting_check(&self.descriptor, response, now)?;
        }
        Ok(())
    }

    pub fn check_hosting_challenge(
        &self,
        challenge: &HostingChallenge,
        now: u64,
    ) -> anyhow::Result<HostingResponse> {
        self.descriptor.verify(self.descriptor.network, now)?;
        let handle: [u8; 32] = decode_lower_hex(&challenge.assignment_handle)?;
        let nonce: [u8; 32] = decode_lower_hex(&challenge.nonce)?;
        if handle == [0; 32]
            || nonce == [0; 32]
            || challenge.assignment_epoch == 0
            || challenge.expires_at <= now
            || challenge.expires_at > now.saturating_add(60)
            || challenge.assignment_expires_at <= now
            || challenge.expires_at > challenge.assignment_expires_at
        {
            anyhow::bail!("hosting challenge is invalid or expired");
        }
        // A read error stays an error. Only a completed real WatchStore read
        // may produce the signed absence result. Envelope expiry is solely
        // the admission TTL and is intentionally not used as a watch lease.
        let watch = self
            .acceptor
            .store
            .get(&assignment_id_from_handle(&handle))?;
        let hosted = watch.as_ref().is_some_and(|watch| {
            watch.worker_assignment_epoch == Some(challenge.assignment_epoch)
                && watch.network == scanner_network(self.descriptor.network)
                && fast_wallet_scanner_core::cuprate::validated_hosted_keys(watch).is_ok()
        });
        let proof = WorkerRequestAuth::sign(
            &self.descriptor,
            &self.online_signing_key,
            WorkerAuthPurpose::HostingStatus,
            &hosting_status_body(
                &self.descriptor.worker_root_id(),
                &handle,
                challenge.assignment_epoch,
                &nonce,
                hosted,
                now,
            ),
            now,
            now.saturating_add(HOSTING_PROOF_LIFETIME_SECONDS)
                .min(self.descriptor.expires_at),
        )?;
        eprintln!("FAST_WALLET_DIAGNOSTICS service=fast-wallet-worker event=hosting-check.completed hostingCheckId={} epoch={} phase=watch-store result={}", &challenge.nonce[..16], challenge.assignment_epoch, if hosted {"hosted"} else {"missing"});
        Ok(HostingResponse {
            contract_version: CONTRACT.to_owned(),
            status: if hosted { "hosted" } else { "missing" }.to_owned(),
            assignment_handle: challenge.assignment_handle.clone(),
            assignment_epoch: challenge.assignment_epoch,
            nonce: challenge.nonce.clone(),
            checked_at: Some(now),
            proof: Some(hex::encode(proof.encode())),
        })
    }
}

impl HttpRelayClient {
    pub(crate) fn http_pull_hosting_checks(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        limit: usize,
    ) -> anyhow::Result<Option<Vec<HostingChallenge>>> {
        let request = serde_json::json!({"workerDescriptor":hex::encode(descriptor.encode()?),
            "workerAuth":hex::encode(auth.encode()),"limit":limit});
        let response = match self
            .agent
            .post(&format!("{}/v1/workers/hosting-checks/pull", self.endpoint))
            .set("content-type", "application/json")
            .send_json(request)
        {
            Ok(response) => response,
            Err(ureq::Error::Status(404 | 405, _)) => return Ok(None),
            Err(_) => anyhow::bail!("Relay hosting check request failed"),
        };
        let mut body = Vec::new();
        response
            .into_reader()
            .take(64 * 1024 + 1)
            .read_to_end(&mut body)?;
        if body.len() > 64 * 1024 {
            anyhow::bail!("Relay hosting response exceeds its limit");
        }
        Ok(Some(serde_json::from_slice(&body)?))
    }

    pub(crate) fn http_complete_hosting_check(
        &self,
        descriptor: &WorkerDescriptor,
        response: HostingResponse,
    ) -> anyhow::Result<()> {
        let request = serde_json::json!({"workerDescriptor":hex::encode(descriptor.encode()?),"response":response});
        let response = self
            .agent
            .post(&format!(
                "{}/v1/workers/hosting-checks/complete",
                self.endpoint
            ))
            .set("content-type", "application/json")
            .send_json(request)
            .map_err(|_| anyhow::anyhow!("Relay hosting proof completion failed"))?;
        if response.status() != 204 {
            anyhow::bail!("Relay hosting proof was not accepted");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, scalar::Scalar};
    use fast_wallet_protocol::{
        generate_hpke_keypair, verify_hosting_status, WatchBinding, WatchSecret,
        WorkerDescriptorInput,
    };
    use fast_wallet_relay::{AssignmentPermit, RelayApiState};
    use fast_wallet_scanner_core::InMemoryWatchStore;
    use monero_address::{AddressType, MoneroAddress, Network as AddressNetwork};
    const NOW: u64 = 1_800_000_000;
    const HANDLE: [u8; 32] = [31; 32];

    fn fixture(store: Arc<dyn WatchStore>) -> OutboundRelayWorker {
        fixture_at(store, NOW)
    }
    fn fixture_at(store: Arc<dyn WatchStore>, now: u64) -> OutboundRelayWorker {
        let root = SigningKeyMaterial::from_bytes([32; 32]);
        let online = SigningKeyMaterial::from_bytes([33; 32]);
        let (private, public) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: ProtocolNetwork::Mainnet,
                issued_at: now - 1,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: public,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        let acceptor = WorkerWatchAcceptor::new(
            store,
            descriptor.clone(),
            private,
            ProtocolNetwork::Mainnet,
            now,
        )
        .unwrap();
        OutboundRelayWorker::new(acceptor, descriptor, online, now).unwrap()
    }
    fn challenge(nonce: u8, now: u64) -> HostingChallenge {
        HostingChallenge {
            assignment_handle: hex::encode(HANDLE),
            assignment_epoch: 1,
            nonce: hex::encode([nonce; 32]),
            expires_at: now + 60,
            assignment_expires_at: NOW + 600,
        }
    }
    fn enroll(worker: &OutboundRelayWorker) -> Vec<u8> {
        let private = Scalar::from(11u64);
        let spend = &Scalar::from(12u64) * ED25519_BASEPOINT_TABLE;
        let view = &private * ED25519_BASEPOINT_TABLE;
        let address = MoneroAddress::new(AddressNetwork::Mainnet, AddressType::Legacy, spend, view)
            .to_string();
        let secret =
            WatchSecret::new(address, private.to_bytes(), ProtocolNetwork::Mainnet, 1).unwrap();
        let binding = WatchBinding::new(worker.descriptor(), HANDLE, 1, NOW - 1, NOW + 30).unwrap();
        let envelope = WatchEnvelope::seal(worker.descriptor(), binding, &secret, NOW)
            .unwrap()
            .encode()
            .to_vec();
        worker.acceptor.accept(&envelope, NOW).unwrap();
        envelope
    }
    fn verify(worker: &OutboundRelayWorker, response: &HostingResponse, now: u64) {
        let proof =
            WorkerRequestAuth::decode(&hex::decode(response.proof.as_ref().unwrap()).unwrap())
                .unwrap();
        verify_hosting_status(
            worker.descriptor(),
            &HANDLE,
            1,
            &decode_lower_hex(&response.nonce).unwrap(),
            response.status == "hosted",
            response.checked_at.unwrap(),
            &proof,
            now,
        )
        .unwrap();
    }
    fn sponsor(relay: &RelayMailbox, worker: &OutboundRelayWorker) {
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: HANDLE,
                    assignment_epoch: 1,
                    worker_root_id: worker.descriptor.worker_root_id(),
                    worker_online_key_id: worker.descriptor.worker_online_key_id(),
                    hpke_key_id: worker.descriptor.hpke_key_id(),
                    expires_at: NOW + 600,
                },
                NOW,
            )
            .unwrap();
    }

    #[test]
    fn real_store_absence_then_enrollment_then_removal_changes_fresh_signed_proof() {
        let store = Arc::new(InMemoryWatchStore::default());
        let worker = fixture(store.clone());
        let absent = worker
            .check_hosting_challenge(&challenge(34, NOW), NOW)
            .unwrap();
        assert_eq!(absent.status, "missing");
        verify(&worker, &absent, NOW);
        enroll(&worker);
        // The encrypted admission message expired at NOW+30. The actual
        // stored watch and the independent Relay assignment are still active.
        let hosted = worker
            .check_hosting_challenge(&challenge(35, NOW + 31), NOW + 31)
            .unwrap();
        assert_eq!(hosted.status, "hosted");
        verify(&worker, &hosted, NOW + 31);
        store.remove(&assignment_id_from_handle(&HANDLE)).unwrap();
        assert_eq!(
            worker
                .check_hosting_challenge(&challenge(36, NOW + 32), NOW + 32)
                .unwrap()
                .status,
            "missing"
        );
    }

    #[test]
    fn mismatched_epoch_or_real_view_key_pair_cannot_claim_hosted() {
        let store = Arc::new(InMemoryWatchStore::default());
        let worker = fixture(store.clone());
        enroll(&worker);
        let mut watch = store
            .get(&assignment_id_from_handle(&HANDLE))
            .unwrap()
            .unwrap();
        watch.worker_assignment_epoch = Some(2);
        store.upsert(watch.clone()).unwrap();
        assert_eq!(
            worker
                .check_hosting_challenge(&challenge(37, NOW), NOW)
                .unwrap()
                .status,
            "missing"
        );
        watch.worker_assignment_epoch = Some(1);
        watch.private_view_key = hex::encode(Scalar::from(13u64).to_bytes());
        store.upsert(watch).unwrap();
        assert_eq!(
            worker
                .check_hosting_challenge(&challenge(38, NOW), NOW)
                .unwrap()
                .status,
            "missing"
        );
        let mut expired = challenge(39, NOW);
        expired.assignment_expires_at = NOW;
        assert!(worker.check_hosting_challenge(&expired, NOW).is_err());
    }

    struct FailedRead;
    impl WatchStore for FailedRead {
        fn get(&self, _: &str) -> anyhow::Result<Option<WatchRegistration>> {
            anyhow::bail!("synthetic store unavailable")
        }
        fn upsert(&self, _: WatchRegistration) -> anyhow::Result<WatchRegistration> {
            unreachable!()
        }
        fn remove(&self, _: &str) -> anyhow::Result<Option<WatchRegistration>> {
            unreachable!()
        }
        fn list(&self) -> anyhow::Result<Vec<WatchRegistration>> {
            unreachable!()
        }
        fn upsert_match(&self, _: MatchedOutput) -> anyhow::Result<MatchedOutput> {
            unreachable!()
        }
        fn list_matches(&self, _: &str) -> anyhow::Result<Vec<MatchedOutput>> {
            unreachable!()
        }
    }
    #[test]
    fn failed_real_store_read_never_signs_absence() {
        let worker = fixture(Arc::new(FailedRead));
        assert!(worker
            .check_hosting_challenge(&challenge(44, NOW), NOW)
            .is_err());
    }

    #[test]
    fn relay_round_trip_requires_challenge_and_rejects_replay_or_wrong_nonce() {
        let worker = fixture(Arc::new(InMemoryWatchStore::default()));
        let relay = RelayMailbox::in_memory();
        sponsor(&relay, &worker);
        let nonce = [40; 32];
        assert_eq!(
            relay
                .hosting_check(worker.descriptor(), HANDLE, 1, nonce, NOW)
                .unwrap()
                .status,
            "pending"
        );
        worker.process_hosting_checks(&relay, NOW).unwrap();
        let proof = relay
            .hosting_check(worker.descriptor(), HANDLE, 1, nonce, NOW + 1)
            .unwrap();
        assert_eq!(proof.status, "missing");
        verify(&worker, &proof, NOW + 1);
        let mut wrong = proof.clone();
        wrong.nonce = hex::encode([41; 32]);
        assert!(relay
            .complete_hosting_check(worker.descriptor(), wrong, NOW + 1)
            .is_err());
        let auth = WorkerRequestAuth::sign(
            worker.descriptor(),
            &worker.online_signing_key,
            WorkerAuthPurpose::Pull,
            &hosting_pull_body(&worker.descriptor.worker_root_id(), 16),
            NOW,
            NOW + 30,
        )
        .unwrap();
        relay
            .pull_hosting_checks(worker.descriptor(), &auth, 16, NOW)
            .unwrap();
        assert!(relay
            .pull_hosting_checks(worker.descriptor(), &auth, 16, NOW)
            .is_err());
    }

    #[test]
    fn legacy_worker_is_unsupported_but_an_offline_worker_is_not_missing() {
        let worker = fixture(Arc::new(InMemoryWatchStore::default()));
        let relay = RelayMailbox::in_memory();
        sponsor(&relay, &worker);
        let auth = WorkerRequestAuth::sign(
            worker.descriptor(),
            &worker.online_signing_key,
            WorkerAuthPurpose::Pull,
            &pull_auth_body(&worker.descriptor.worker_root_id(), 10, true),
            NOW,
            NOW + 30,
        )
        .unwrap();
        relay
            .pull(worker.descriptor(), &auth, 10, true, NOW)
            .unwrap();
        let legacy = relay
            .hosting_check(worker.descriptor(), HANDLE, 1, [45; 32], NOW)
            .unwrap();
        assert_eq!(legacy.status, "unsupported");
        assert!(legacy.proof.is_none());
        let offline = relay
            .hosting_check(worker.descriptor(), HANDLE, 1, [46; 32], NOW + 121)
            .unwrap();
        assert_eq!(offline.status, "pending");
        assert!(offline.proof.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn http_worker_queue_returns_real_nonce_bound_store_result() {
        let now = unix_seconds();
        let worker = fixture_at(Arc::new(InMemoryWatchStore::default()), now);
        let relay = RelayMailbox::in_memory();
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: HANDLE,
                    assignment_epoch: 1,
                    worker_root_id: worker.descriptor.worker_root_id(),
                    worker_online_key_id: worker.descriptor.worker_online_key_id(),
                    hpke_key_id: worker.descriptor.hpke_key_id(),
                    expires_at: now + 600,
                },
                now,
            )
            .unwrap();
        let state = RelayApiState::new(relay, [42; 32]);
        let mailbox = state.mailbox().clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, fast_wallet_relay::router(state))
                .await
                .unwrap();
        });
        let worker=tokio::task::spawn_blocking(move|| {
            let request=serde_json::json!({"workerDescriptor":hex::encode(worker.descriptor.encode().unwrap()),
                "assignmentHandle":hex::encode(HANDLE),"assignmentEpoch":1,"nonce":hex::encode([43;32])});
            let endpoint=format!("{origin}/v1/assignments/hosting-check");
            assert!(matches!(ureq::post(&endpoint).send_json(&request),Err(ureq::Error::Status(401,_))));
            let pending=ureq::post(&endpoint).set("x-fast-wallet-relay-internal-auth",&hex::encode([42;32]))
                .send_json(&request).unwrap();
            assert_eq!(pending.status(),202);
            let response:HostingResponse=pending.into_json().unwrap();assert_eq!(response.status,"pending");
            let client=HttpRelayClient::new(origin,Duration::from_secs(5)).unwrap();
            worker.process_hosting_checks(&client,unix_seconds()).unwrap();worker
        }).await.unwrap();
        let proof = mailbox
            .hosting_check(worker.descriptor(), HANDLE, 1, [43; 32], unix_seconds())
            .unwrap();
        assert_eq!(proof.status, "missing");
        verify(&worker, &proof, unix_seconds());
        server.abort();
    }
}
