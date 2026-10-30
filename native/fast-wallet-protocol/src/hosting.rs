//! Fresh, nonce-bound proof of the Worker's current watch-store contents.
use crate::{ProtocolError, WorkerAuthPurpose, WorkerDescriptor, WorkerRequestAuth};

pub const HOSTING_PROOF_LIFETIME_SECONDS: u64 = 60;

pub fn hosting_status_body(
    worker_root_id: &[u8; 32],
    handle: &[u8; 32],
    epoch: u64,
    nonce: &[u8; 32],
    hosted: bool,
    checked_at: u64,
) -> [u8; 121] {
    let mut body = [0; 121];
    body[..8].copy_from_slice(b"TX8HST01");
    body[8..40].copy_from_slice(worker_root_id);
    body[40..72].copy_from_slice(handle);
    body[72..80].copy_from_slice(&epoch.to_be_bytes());
    body[80..112].copy_from_slice(nonce);
    body[112] = u8::from(hosted);
    body[113..].copy_from_slice(&checked_at.to_be_bytes());
    body
}

#[allow(clippy::too_many_arguments)]
pub fn verify_hosting_status(
    descriptor: &WorkerDescriptor,
    handle: &[u8; 32],
    epoch: u64,
    nonce: &[u8; 32],
    hosted: bool,
    checked_at: u64,
    proof: &WorkerRequestAuth,
    now: u64,
) -> Result<(), ProtocolError> {
    if *handle == [0; 32]
        || epoch == 0
        || *nonce == [0; 32]
        || proof.issued_at != checked_at
        || checked_at > now.saturating_add(5)
        || now.saturating_sub(checked_at) > HOSTING_PROOF_LIFETIME_SECONDS
        || proof.expires_at > checked_at.saturating_add(HOSTING_PROOF_LIFETIME_SECONDS)
    {
        return Err(ProtocolError::InvalidTimeWindow);
    }
    proof.verify(
        descriptor,
        WorkerAuthPurpose::HostingStatus,
        &hosting_status_body(
            &descriptor.worker_root_id(),
            handle,
            epoch,
            nonce,
            hosted,
            checked_at,
        ),
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{generate_hpke_keypair, Network, SigningKeyMaterial, WorkerDescriptorInput};

    #[test]
    fn hosting_proof_binds_every_challenge_field_and_is_not_a_receipt() {
        let now = 1_800_000_000;
        let root = SigningKeyMaterial::from_bytes([71; 32]);
        let online = SigningKeyMaterial::from_bytes([72; 32]);
        let (_, hpke) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now - 1,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: hpke,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        let (handle, nonce) = ([73; 32], [74; 32]);
        let body = hosting_status_body(&descriptor.worker_root_id(), &handle, 9, &nonce, true, now);
        assert_eq!(&body[..8], b"TX8HST01");
        assert_eq!(&body[72..80], &9u64.to_be_bytes());
        assert_eq!(body[112], 1);
        let proof = WorkerRequestAuth::sign(
            &descriptor,
            &online,
            WorkerAuthPurpose::HostingStatus,
            &body,
            now,
            now + 60,
        )
        .unwrap();
        assert!(
            verify_hosting_status(&descriptor, &handle, 9, &nonce, true, now, &proof, now).is_ok()
        );
        for (h, e, n, s, t) in [
            (handle, 10, nonce, true, now),
            ([75; 32], 9, nonce, true, now),
            (handle, 9, [76; 32], true, now),
            (handle, 9, nonce, false, now),
            (handle, 9, nonce, true, now + 1),
        ] {
            assert!(verify_hosting_status(&descriptor, &h, e, &n, s, t, &proof, now).is_err());
        }
        assert!(verify_hosting_status(
            &descriptor,
            &handle,
            9,
            &nonce,
            true,
            now,
            &proof,
            now + 61
        )
        .is_err());
        let receipt = WorkerRequestAuth::sign(
            &descriptor,
            &online,
            WorkerAuthPurpose::Receipt,
            &body,
            now,
            now + 60,
        )
        .unwrap();
        assert!(
            verify_hosting_status(&descriptor, &handle, 9, &nonce, true, now, &receipt, now)
                .is_err()
        );
        let encoded = descriptor.encode().unwrap();
        let bytes = proof.encode();
        assert_eq!(
            unsafe {
                crate::ffi::tex8_fast_wallet_protocol_verify_hosting_status_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    Network::Mainnet as u8,
                    now,
                    handle.as_ptr(),
                    9,
                    nonce.as_ptr(),
                    1,
                    now,
                    bytes.as_ptr(),
                    bytes.len(),
                )
            },
            crate::ffi::OK
        );
        assert_ne!(
            unsafe {
                crate::ffi::tex8_fast_wallet_protocol_verify_hosting_status_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    Network::Testnet as u8,
                    now,
                    handle.as_ptr(),
                    9,
                    nonce.as_ptr(),
                    1,
                    now,
                    bytes.as_ptr(),
                    bytes.len(),
                )
            },
            crate::ffi::OK
        );
    }
}
