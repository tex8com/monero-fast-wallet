//! Security-critical protocol primitives shared by the Fast Wallet clients,
//! Relay, Gateway and exact selected Worker.
//!
//! The crate deliberately uses a small, canonical binary format. Secret watch
//! material is always encrypted with RFC 9180 HPKE before it can cross the
//! native boundary.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable,
    Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop};

// Android and iOS must not link two Rust `staticlib` archives because each
// archive embeds Rust's standard library. The mobile builder supplies the
// authenticated, patch-series-owned Monero acceleration source path and the
// patched Dalek dependency; compiling it as a private module preserves its
// existing C ABI while producing a single Rust runtime.
#[cfg(feature = "mobile-fast-crypto")]
mod mobile_fast_crypto {
    include!(env!("MONERO_FAST_CRYPTO_SOURCE"));
}

pub const PROTOCOL_VERSION: u16 = 1;
pub const WATCH_PLAINTEXT_SIZE: usize = 256;
pub const WATCH_CIPHERTEXT_SIZE: usize = WATCH_PLAINTEXT_SIZE + 16;
pub const WATCH_ENVELOPE_SIZE: usize = 484;
pub const MAX_RELAY_ORIGIN_BYTES: usize = 200;
pub const MAX_MONERO_ADDRESS_BYTES: usize = 128;
pub const MAX_CLOCK_SKEW_SECONDS: u64 = 300;
pub const MAX_DESCRIPTOR_LIFETIME_SECONDS: u64 = 31 * 24 * 60 * 60;
pub const MAX_WATCH_LIFETIME_SECONDS: u64 = 15 * 60;

const DESCRIPTOR_MAGIC: &[u8; 8] = b"TX8WD001";
const WATCH_AAD_MAGIC: &[u8; 8] = b"TX8WA001";
const WATCH_PLAINTEXT_MAGIC: &[u8; 8] = b"TX8WP001";
const WORKER_AUTH_MAGIC: &[u8; 8] = b"TX8AU001";
const GATEWAY_WAKE_MAGIC: &[u8; 8] = b"TX8GW001";
const HPKE_INFO: &[u8] = b"TEX8 Fast Wallet watch-envelope.v1";
const WATCH_PURPOSE: u8 = 1;
const WATCH_AAD_SIZE: usize = 180;
const HPKE_ENCAPSULATED_KEY_SIZE: usize = 32;
pub const WORKER_AUTH_SIZE: usize = 204;
pub const MAX_WORKER_AUTH_LIFETIME_SECONDS: u64 = 60;

type Kem = X25519HkdfSha256;
type Kdf = HkdfSha256;
type Aead = ChaCha20Poly1305;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Network {
    Mainnet = 0,
    Testnet = 1,
    Stagenet = 2,
}

impl Network {
    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0 => Ok(Self::Mainnet),
            1 => Ok(Self::Testnet),
            2 => Ok(Self::Stagenet),
            _ => Err(ProtocolError::UnknownNetwork),
        }
    }
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
pub struct SigningKeyMaterial([u8; 32]);

impl SigningKeyMaterial {
    pub fn generate() -> Result<Self, ProtocolError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| ProtocolError::RandomnessUnavailable)?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn public_key(&self) -> [u8; 32] {
        SigningKey::from_bytes(&self.0).verifying_key().to_bytes()
    }

    fn sign(&self, message: &[u8]) -> [u8; 64] {
        SigningKey::from_bytes(&self.0).sign(message).to_bytes()
    }
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
pub struct HpkePrivateKey([u8; 32]);

impl HpkePrivateKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

pub fn generate_hpke_keypair() -> Result<(HpkePrivateKey, [u8; 32]), ProtocolError> {
    let (private, public) = Kem::gen_keypair();
    let private_bytes = fixed_32(private.to_bytes().as_slice())?;
    let public_bytes = fixed_32(public.to_bytes().as_slice())?;
    Ok((HpkePrivateKey(private_bytes), public_bytes))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerDescriptor {
    pub network: Network,
    pub issued_at: u64,
    pub expires_at: u64,
    pub worker_root_public_key: [u8; 32],
    pub worker_online_public_key: [u8; 32],
    pub hpke_public_key: [u8; 32],
    pub relay_origin: String,
    pub signature: [u8; 64],
}

#[derive(Clone, Debug)]
pub struct WorkerDescriptorInput {
    pub network: Network,
    pub issued_at: u64,
    pub expires_at: u64,
    pub worker_online_public_key: [u8; 32],
    pub hpke_public_key: [u8; 32],
    pub relay_origin: String,
}

impl WorkerDescriptor {
    pub fn sign(
        input: WorkerDescriptorInput,
        root_key: &SigningKeyMaterial,
    ) -> Result<Self, ProtocolError> {
        validate_time_window(
            input.issued_at,
            input.expires_at,
            MAX_DESCRIPTOR_LIFETIME_SECONDS,
        )?;
        validate_relay_origin(&input.relay_origin)?;
        let mut descriptor = Self {
            network: input.network,
            issued_at: input.issued_at,
            expires_at: input.expires_at,
            worker_root_public_key: root_key.public_key(),
            worker_online_public_key: input.worker_online_public_key,
            hpke_public_key: input.hpke_public_key,
            relay_origin: input.relay_origin,
            signature: [0_u8; 64],
        };
        descriptor.signature = root_key.sign(&descriptor.unsigned_bytes()?);
        Ok(descriptor)
    }

    pub fn verify(&self, expected_network: Network, now: u64) -> Result<(), ProtocolError> {
        if self.network != expected_network {
            return Err(ProtocolError::WrongNetwork);
        }
        validate_freshness(
            self.issued_at,
            self.expires_at,
            now,
            MAX_DESCRIPTOR_LIFETIME_SECONDS,
        )?;
        validate_relay_origin(&self.relay_origin)?;
        let key = VerifyingKey::from_bytes(&self.worker_root_public_key)
            .map_err(|_| ProtocolError::InvalidPublicKey)?;
        let signature = Signature::from_bytes(&self.signature);
        key.verify_strict(&self.unsigned_bytes()?, &signature)
            .map_err(|_| ProtocolError::InvalidSignature)
    }

    pub fn worker_root_id(&self) -> [u8; 32] {
        key_id(&self.worker_root_public_key)
    }

    pub fn worker_online_key_id(&self) -> [u8; 32] {
        key_id(&self.worker_online_public_key)
    }

    pub fn hpke_key_id(&self) -> [u8; 32] {
        key_id(&self.hpke_public_key)
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let mut encoded = self.unsigned_bytes()?;
        encoded.extend_from_slice(&self.signature);
        Ok(encoded)
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, ProtocolError> {
        let minimum = 8 + 2 + 1 + 1 + 8 + 8 + 32 + 32 + 32 + 2 + 64;
        if encoded.len() < minimum {
            return Err(ProtocolError::Truncated);
        }
        let mut cursor = Cursor::new(encoded);
        cursor.expect(DESCRIPTOR_MAGIC)?;
        if cursor.u16()? != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let network = Network::decode(cursor.u8()?)?;
        if cursor.u8()? != 0 {
            return Err(ProtocolError::NonCanonical);
        }
        let issued_at = cursor.u64()?;
        let expires_at = cursor.u64()?;
        let worker_root_public_key = cursor.array()?;
        let worker_online_public_key = cursor.array()?;
        let hpke_public_key = cursor.array()?;
        let origin_len = usize::from(cursor.u16()?);
        if origin_len == 0 || origin_len > MAX_RELAY_ORIGIN_BYTES {
            return Err(ProtocolError::InvalidRelayOrigin);
        }
        let relay_origin = std::str::from_utf8(cursor.take(origin_len)?)
            .map_err(|_| ProtocolError::InvalidRelayOrigin)?
            .to_owned();
        let signature = cursor.array()?;
        cursor.finish()?;
        let descriptor = Self {
            network,
            issued_at,
            expires_at,
            worker_root_public_key,
            worker_online_public_key,
            hpke_public_key,
            relay_origin,
            signature,
        };
        validate_time_window(issued_at, expires_at, MAX_DESCRIPTOR_LIFETIME_SECONDS)?;
        validate_relay_origin(&descriptor.relay_origin)?;
        if descriptor.encode()? != encoded {
            return Err(ProtocolError::NonCanonical);
        }
        Ok(descriptor)
    }

    fn unsigned_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        validate_relay_origin(&self.relay_origin)?;
        let origin = self.relay_origin.as_bytes();
        let origin_len = u16::try_from(origin.len()).map_err(|_| ProtocolError::Oversized)?;
        let mut encoded = Vec::with_capacity(126 + origin.len());
        encoded.extend_from_slice(DESCRIPTOR_MAGIC);
        encoded.extend_from_slice(&PROTOCOL_VERSION.to_be_bytes());
        encoded.push(self.network as u8);
        encoded.push(0);
        encoded.extend_from_slice(&self.issued_at.to_be_bytes());
        encoded.extend_from_slice(&self.expires_at.to_be_bytes());
        encoded.extend_from_slice(&self.worker_root_public_key);
        encoded.extend_from_slice(&self.worker_online_public_key);
        encoded.extend_from_slice(&self.hpke_public_key);
        encoded.extend_from_slice(&origin_len.to_be_bytes());
        encoded.extend_from_slice(origin);
        Ok(encoded)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum WorkerAuthPurpose {
    Pull = 1,
    Ack = 2,
    Receipt = 3,
    Wake = 4,
}

impl WorkerAuthPurpose {
    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Pull),
            2 => Ok(Self::Ack),
            3 => Ok(Self::Receipt),
            4 => Ok(Self::Wake),
            _ => Err(ProtocolError::WrongPurpose),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRequestAuth {
    pub purpose: WorkerAuthPurpose,
    pub worker_root_id: [u8; 32],
    pub worker_online_key_id: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: [u8; 16],
    pub body_hash: [u8; 32],
    pub signature: [u8; 64],
}

impl WorkerRequestAuth {
    pub fn sign(
        descriptor: &WorkerDescriptor,
        online_key: &SigningKeyMaterial,
        purpose: WorkerAuthPurpose,
        body: &[u8],
        issued_at: u64,
        expires_at: u64,
    ) -> Result<Self, ProtocolError> {
        validate_time_window(issued_at, expires_at, MAX_WORKER_AUTH_LIFETIME_SECONDS)?;
        if online_key.public_key() != descriptor.worker_online_public_key {
            return Err(ProtocolError::WrongWorker);
        }
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| ProtocolError::RandomnessUnavailable)?;
        let mut auth = Self {
            purpose,
            worker_root_id: descriptor.worker_root_id(),
            worker_online_key_id: descriptor.worker_online_key_id(),
            issued_at,
            expires_at,
            nonce,
            body_hash: key_id(body),
            signature: [0_u8; 64],
        };
        auth.signature = online_key.sign(&auth.unsigned_bytes());
        Ok(auth)
    }

    pub fn verify(
        &self,
        descriptor: &WorkerDescriptor,
        expected_purpose: WorkerAuthPurpose,
        body: &[u8],
        now: u64,
    ) -> Result<(), ProtocolError> {
        descriptor.verify(descriptor.network, now)?;
        validate_freshness(
            self.issued_at,
            self.expires_at,
            now,
            MAX_WORKER_AUTH_LIFETIME_SECONDS,
        )?;
        if self.purpose != expected_purpose {
            return Err(ProtocolError::WrongPurpose);
        }
        if self.worker_root_id != descriptor.worker_root_id()
            || self.worker_online_key_id != descriptor.worker_online_key_id()
        {
            return Err(ProtocolError::WrongWorker);
        }
        if self.body_hash != key_id(body) {
            return Err(ProtocolError::InvalidBodyHash);
        }
        let key = VerifyingKey::from_bytes(&descriptor.worker_online_public_key)
            .map_err(|_| ProtocolError::InvalidPublicKey)?;
        key.verify_strict(
            &self.unsigned_bytes(),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| ProtocolError::InvalidSignature)
    }

    pub fn replay_id(&self) -> [u8; 32] {
        key_id(&self.encode())
    }

    pub fn encode(&self) -> [u8; WORKER_AUTH_SIZE] {
        let unsigned = self.unsigned_bytes();
        let mut encoded = [0_u8; WORKER_AUTH_SIZE];
        encoded[..unsigned.len()].copy_from_slice(&unsigned);
        encoded[unsigned.len()..].copy_from_slice(&self.signature);
        encoded
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, ProtocolError> {
        if encoded.len() != WORKER_AUTH_SIZE {
            return Err(ProtocolError::InvalidLength);
        }
        let mut cursor = Cursor::new(encoded);
        cursor.expect(WORKER_AUTH_MAGIC)?;
        if cursor.u16()? != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let purpose = WorkerAuthPurpose::decode(cursor.u8()?)?;
        if cursor.u8()? != 0 {
            return Err(ProtocolError::NonCanonical);
        }
        let auth = Self {
            purpose,
            worker_root_id: cursor.array()?,
            worker_online_key_id: cursor.array()?,
            issued_at: cursor.u64()?,
            expires_at: cursor.u64()?,
            nonce: cursor.array()?,
            body_hash: cursor.array()?,
            signature: cursor.array()?,
        };
        cursor.finish()?;
        validate_time_window(
            auth.issued_at,
            auth.expires_at,
            MAX_WORKER_AUTH_LIFETIME_SECONDS,
        )?;
        if auth.encode().as_slice() != encoded {
            return Err(ProtocolError::NonCanonical);
        }
        Ok(auth)
    }

    fn unsigned_bytes(&self) -> [u8; WORKER_AUTH_SIZE - 64] {
        let mut encoded = [0_u8; WORKER_AUTH_SIZE - 64];
        let mut offset = 0;
        put(&mut encoded, &mut offset, WORKER_AUTH_MAGIC);
        put(&mut encoded, &mut offset, &PROTOCOL_VERSION.to_be_bytes());
        put(&mut encoded, &mut offset, &[self.purpose as u8]);
        put(&mut encoded, &mut offset, &[0]);
        put(&mut encoded, &mut offset, &self.worker_root_id);
        put(&mut encoded, &mut offset, &self.worker_online_key_id);
        put(&mut encoded, &mut offset, &self.issued_at.to_be_bytes());
        put(&mut encoded, &mut offset, &self.expires_at.to_be_bytes());
        put(&mut encoded, &mut offset, &self.nonce);
        put(&mut encoded, &mut offset, &self.body_hash);
        debug_assert_eq!(offset, WORKER_AUTH_SIZE - 64);
        encoded
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchBinding {
    pub network: Network,
    pub worker_root_id: [u8; 32],
    pub worker_online_key_id: [u8; 32],
    pub hpke_key_id: [u8; 32],
    pub assignment_handle: [u8; 32],
    pub assignment_epoch: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: [u8; 16],
}

impl WatchBinding {
    pub fn new(
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<Self, ProtocolError> {
        validate_time_window(issued_at, expires_at, MAX_WATCH_LIFETIME_SECONDS)?;
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| ProtocolError::RandomnessUnavailable)?;
        Ok(Self {
            network: descriptor.network,
            worker_root_id: descriptor.worker_root_id(),
            worker_online_key_id: descriptor.worker_online_key_id(),
            hpke_key_id: descriptor.hpke_key_id(),
            assignment_handle,
            assignment_epoch,
            issued_at,
            expires_at,
            nonce,
        })
    }

    fn aad(&self) -> [u8; WATCH_AAD_SIZE] {
        let mut encoded = [0_u8; WATCH_AAD_SIZE];
        let mut offset = 0;
        put(&mut encoded, &mut offset, WATCH_AAD_MAGIC);
        put(&mut encoded, &mut offset, &PROTOCOL_VERSION.to_be_bytes());
        put(&mut encoded, &mut offset, &[self.network as u8]);
        put(&mut encoded, &mut offset, &[WATCH_PURPOSE]);
        put(&mut encoded, &mut offset, &self.worker_root_id);
        put(&mut encoded, &mut offset, &self.worker_online_key_id);
        put(&mut encoded, &mut offset, &self.hpke_key_id);
        put(&mut encoded, &mut offset, &self.assignment_handle);
        put(
            &mut encoded,
            &mut offset,
            &self.assignment_epoch.to_be_bytes(),
        );
        put(&mut encoded, &mut offset, &self.issued_at.to_be_bytes());
        put(&mut encoded, &mut offset, &self.expires_at.to_be_bytes());
        put(&mut encoded, &mut offset, &self.nonce);
        debug_assert_eq!(offset, WATCH_AAD_SIZE);
        encoded
    }

    fn decode(encoded: &[u8]) -> Result<Self, ProtocolError> {
        if encoded.len() != WATCH_AAD_SIZE {
            return Err(ProtocolError::InvalidLength);
        }
        let mut cursor = Cursor::new(encoded);
        cursor.expect(WATCH_AAD_MAGIC)?;
        if cursor.u16()? != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let network = Network::decode(cursor.u8()?)?;
        if cursor.u8()? != WATCH_PURPOSE {
            return Err(ProtocolError::WrongPurpose);
        }
        let binding = Self {
            network,
            worker_root_id: cursor.array()?,
            worker_online_key_id: cursor.array()?,
            hpke_key_id: cursor.array()?,
            assignment_handle: cursor.array()?,
            assignment_epoch: cursor.u64()?,
            issued_at: cursor.u64()?,
            expires_at: cursor.u64()?,
            nonce: cursor.array()?,
        };
        cursor.finish()?;
        validate_time_window(
            binding.issued_at,
            binding.expires_at,
            MAX_WATCH_LIFETIME_SECONDS,
        )?;
        Ok(binding)
    }
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
pub struct WatchSecret {
    pub address: String,
    pub private_view_key: [u8; 32],
    #[zeroize(skip)]
    pub network: Network,
    #[zeroize(skip)]
    pub restore_height: u64,
}

impl WatchSecret {
    pub fn new(
        address: String,
        private_view_key: [u8; 32],
        network: Network,
        restore_height: u64,
    ) -> Result<Self, ProtocolError> {
        validate_monero_address(&address)?;
        Ok(Self {
            address,
            private_view_key,
            network,
            restore_height,
        })
    }

    fn encode_fixed(&self) -> Result<[u8; WATCH_PLAINTEXT_SIZE], ProtocolError> {
        validate_monero_address(&self.address)?;
        let mut encoded = [0_u8; WATCH_PLAINTEXT_SIZE];
        let address = self.address.as_bytes();
        let mut offset = 0;
        put(&mut encoded, &mut offset, WATCH_PLAINTEXT_MAGIC);
        put(&mut encoded, &mut offset, &PROTOCOL_VERSION.to_be_bytes());
        put(&mut encoded, &mut offset, &[self.network as u8]);
        put(&mut encoded, &mut offset, &[0]);
        put(
            &mut encoded,
            &mut offset,
            &self.restore_height.to_be_bytes(),
        );
        put(
            &mut encoded,
            &mut offset,
            &(address.len() as u16).to_be_bytes(),
        );
        encoded[offset..offset + address.len()].copy_from_slice(address);
        offset += MAX_MONERO_ADDRESS_BYTES;
        put(&mut encoded, &mut offset, &self.private_view_key);
        Ok(encoded)
    }

    fn decode_fixed(mut encoded: [u8; WATCH_PLAINTEXT_SIZE]) -> Result<Self, ProtocolError> {
        let result = (|| {
            let mut cursor = Cursor::new(&encoded);
            cursor.expect(WATCH_PLAINTEXT_MAGIC)?;
            if cursor.u16()? != PROTOCOL_VERSION {
                return Err(ProtocolError::UnsupportedVersion);
            }
            let network = Network::decode(cursor.u8()?)?;
            if cursor.u8()? != 0 {
                return Err(ProtocolError::NonCanonical);
            }
            let restore_height = cursor.u64()?;
            let address_len = usize::from(cursor.u16()?);
            if address_len == 0 || address_len > MAX_MONERO_ADDRESS_BYTES {
                return Err(ProtocolError::InvalidAddress);
            }
            let address_field = cursor.take(MAX_MONERO_ADDRESS_BYTES)?;
            if address_field[address_len..].iter().any(|byte| *byte != 0) {
                return Err(ProtocolError::NonCanonical);
            }
            let address = std::str::from_utf8(&address_field[..address_len])
                .map_err(|_| ProtocolError::InvalidAddress)?
                .to_owned();
            let private_view_key = cursor.array()?;
            if cursor.remaining().iter().any(|byte| *byte != 0) {
                return Err(ProtocolError::NonCanonical);
            }
            validate_monero_address(&address)?;
            Ok(Self {
                address,
                private_view_key,
                network,
                restore_height,
            })
        })();
        encoded.zeroize();
        result
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchEnvelope {
    pub binding: WatchBinding,
    pub encapsulated_key: [u8; HPKE_ENCAPSULATED_KEY_SIZE],
    pub ciphertext: [u8; WATCH_CIPHERTEXT_SIZE],
}

impl WatchEnvelope {
    pub fn seal(
        descriptor: &WorkerDescriptor,
        binding: WatchBinding,
        secret: &WatchSecret,
        now: u64,
    ) -> Result<Self, ProtocolError> {
        descriptor.verify(binding.network, now)?;
        binding.validate_for_descriptor(descriptor, now)?;
        if secret.network != binding.network {
            return Err(ProtocolError::WrongNetwork);
        }
        let recipient = <Kem as KemTrait>::PublicKey::from_bytes(&descriptor.hpke_public_key)
            .map_err(|_| ProtocolError::InvalidPublicKey)?;
        let (encapsulated, mut context) =
            hpke::setup_sender::<Aead, Kdf, Kem>(&OpModeS::Base, &recipient, HPKE_INFO)
                .map_err(|_| ProtocolError::Hpke)?;
        let aad = binding.aad();
        let mut plaintext = secret.encode_fixed()?;
        let encrypted = context
            .seal(&plaintext, &aad)
            .map_err(|_| ProtocolError::Hpke);
        plaintext.zeroize();
        let encrypted = encrypted?;
        let ciphertext = fixed_array::<WATCH_CIPHERTEXT_SIZE>(&encrypted)?;
        let encapsulated_key =
            fixed_array::<HPKE_ENCAPSULATED_KEY_SIZE>(encapsulated.to_bytes().as_slice())?;
        Ok(Self {
            binding,
            encapsulated_key,
            ciphertext,
        })
    }

    pub fn open(
        &self,
        descriptor: &WorkerDescriptor,
        recipient_private_key: &HpkePrivateKey,
        now: u64,
    ) -> Result<WatchSecret, ProtocolError> {
        descriptor.verify(self.binding.network, now)?;
        self.binding.validate_for_descriptor(descriptor, now)?;
        let private = <Kem as KemTrait>::PrivateKey::from_bytes(&recipient_private_key.0)
            .map_err(|_| ProtocolError::InvalidPrivateKey)?;
        let encapsulated = <Kem as KemTrait>::EncappedKey::from_bytes(&self.encapsulated_key)
            .map_err(|_| ProtocolError::InvalidPublicKey)?;
        let mut context = hpke::setup_receiver::<Aead, Kdf, Kem>(
            &OpModeR::Base,
            &private,
            &encapsulated,
            HPKE_INFO,
        )
        .map_err(|_| ProtocolError::Hpke)?;
        let aad = self.binding.aad();
        let mut plaintext = context
            .open(&self.ciphertext, &aad)
            .map_err(|_| ProtocolError::Hpke)?;
        let fixed = fixed_array::<WATCH_PLAINTEXT_SIZE>(&plaintext);
        plaintext.zeroize();
        let secret = WatchSecret::decode_fixed(fixed?)?;
        if secret.network != self.binding.network {
            return Err(ProtocolError::WrongNetwork);
        }
        Ok(secret)
    }

    pub fn encode(&self) -> [u8; WATCH_ENVELOPE_SIZE] {
        let mut encoded = [0_u8; WATCH_ENVELOPE_SIZE];
        encoded[..WATCH_AAD_SIZE].copy_from_slice(&self.binding.aad());
        encoded[WATCH_AAD_SIZE..WATCH_AAD_SIZE + HPKE_ENCAPSULATED_KEY_SIZE]
            .copy_from_slice(&self.encapsulated_key);
        encoded[WATCH_AAD_SIZE + HPKE_ENCAPSULATED_KEY_SIZE..].copy_from_slice(&self.ciphertext);
        encoded
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, ProtocolError> {
        if encoded.len() != WATCH_ENVELOPE_SIZE {
            return Err(ProtocolError::InvalidLength);
        }
        let binding = WatchBinding::decode(&encoded[..WATCH_AAD_SIZE])?;
        let encapsulated_key =
            fixed_array(&encoded[WATCH_AAD_SIZE..WATCH_AAD_SIZE + HPKE_ENCAPSULATED_KEY_SIZE])?;
        let ciphertext = fixed_array(&encoded[WATCH_AAD_SIZE + HPKE_ENCAPSULATED_KEY_SIZE..])?;
        let envelope = Self {
            binding,
            encapsulated_key,
            ciphertext,
        };
        if envelope.encode().as_slice() != encoded {
            return Err(ProtocolError::NonCanonical);
        }
        Ok(envelope)
    }
}

impl WatchBinding {
    fn validate_for_descriptor(
        &self,
        descriptor: &WorkerDescriptor,
        now: u64,
    ) -> Result<(), ProtocolError> {
        validate_freshness(
            self.issued_at,
            self.expires_at,
            now,
            MAX_WATCH_LIFETIME_SECONDS,
        )?;
        if self.network != descriptor.network {
            return Err(ProtocolError::WrongNetwork);
        }
        if self.worker_root_id != descriptor.worker_root_id()
            || self.worker_online_key_id != descriptor.worker_online_key_id()
            || self.hpke_key_id != descriptor.hpke_key_id()
        {
            return Err(ProtocolError::WrongWorker);
        }
        if self.assignment_handle == [0_u8; 32] || self.assignment_epoch == 0 {
            return Err(ProtocolError::InvalidAssignment);
        }
        Ok(())
    }
}

pub fn key_id(public_key: &[u8]) -> [u8; 32] {
    Sha256::digest(public_key).into()
}

pub fn gateway_wake_auth_body(
    assignment_handle: &[u8; 32],
    assignment_epoch: u64,
    event_id: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let valid_event_id = event_id.len() == 68
        && event_id.starts_with("evt_")
        && event_id[4..].bytes().all(|byte| byte.is_ascii_hexdigit());
    if assignment_handle == &[0_u8; 32] || assignment_epoch == 0 || !valid_event_id {
        return Err(ProtocolError::InvalidAssignment);
    }
    let mut body = Vec::with_capacity(8 + 32 + 8 + 2 + event_id.len());
    body.extend_from_slice(GATEWAY_WAKE_MAGIC);
    body.extend_from_slice(assignment_handle);
    body.extend_from_slice(&assignment_epoch.to_be_bytes());
    body.extend_from_slice(&(event_id.len() as u16).to_be_bytes());
    body.extend_from_slice(event_id.as_bytes());
    Ok(body)
}

fn validate_relay_origin(origin: &str) -> Result<(), ProtocolError> {
    if origin.is_empty() || origin.len() > MAX_RELAY_ORIGIN_BYTES {
        return Err(ProtocolError::InvalidRelayOrigin);
    }
    let parsed = Url::parse(origin).map_err(|_| ProtocolError::InvalidRelayOrigin)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ProtocolError::InvalidRelayOrigin);
    }
    Ok(())
}

fn validate_monero_address(address: &str) -> Result<(), ProtocolError> {
    let valid = (50..=MAX_MONERO_ADDRESS_BYTES).contains(&address.len())
        && address.bytes().all(|byte| byte.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err(ProtocolError::InvalidAddress)
    }
}

fn validate_time_window(
    issued_at: u64,
    expires_at: u64,
    maximum_lifetime: u64,
) -> Result<(), ProtocolError> {
    if issued_at == 0
        || expires_at <= issued_at
        || expires_at.saturating_sub(issued_at) > maximum_lifetime
    {
        Err(ProtocolError::InvalidTimeWindow)
    } else {
        Ok(())
    }
}

fn validate_freshness(
    issued_at: u64,
    expires_at: u64,
    now: u64,
    maximum_lifetime: u64,
) -> Result<(), ProtocolError> {
    validate_time_window(issued_at, expires_at, maximum_lifetime)?;
    if issued_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS) {
        return Err(ProtocolError::NotYetValid);
    }
    if expires_at < now {
        return Err(ProtocolError::Expired);
    }
    Ok(())
}

fn fixed_32(value: &[u8]) -> Result<[u8; 32], ProtocolError> {
    fixed_array(value)
}

fn fixed_array<const N: usize>(value: &[u8]) -> Result<[u8; N], ProtocolError> {
    value.try_into().map_err(|_| ProtocolError::InvalidLength)
}

fn put(target: &mut [u8], offset: &mut usize, value: &[u8]) {
    let end = *offset + value.len();
    target[*offset..end].copy_from_slice(value);
    *offset = end;
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(ProtocolError::Oversized)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(ProtocolError::Truncated)?;
        self.offset = end;
        Ok(value)
    }

    fn expect(&mut self, expected: &[u8]) -> Result<(), ProtocolError> {
        if self.take(expected.len())? == expected {
            Ok(())
        } else {
            Err(ProtocolError::WrongPurpose)
        }
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ProtocolError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, ProtocolError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ProtocolError> {
        fixed_array(self.take(N)?)
    }

    fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.offset..]
    }

    fn finish(&self) -> Result<(), ProtocolError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(ProtocolError::TrailingData)
        }
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum ProtocolError {
    #[error("secure randomness is unavailable")]
    RandomnessUnavailable,
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    #[error("unknown network")]
    UnknownNetwork,
    #[error("message is for the wrong network")]
    WrongNetwork,
    #[error("message is for the wrong worker")]
    WrongWorker,
    #[error("message has the wrong purpose")]
    WrongPurpose,
    #[error("invalid assignment")]
    InvalidAssignment,
    #[error("invalid time window")]
    InvalidTimeWindow,
    #[error("message is not valid yet")]
    NotYetValid,
    #[error("message has expired")]
    Expired,
    #[error("invalid Relay origin")]
    InvalidRelayOrigin,
    #[error("invalid Monero address")]
    InvalidAddress,
    #[error("invalid public key")]
    InvalidPublicKey,
    #[error("invalid private key")]
    InvalidPrivateKey,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("request body hash does not match")]
    InvalidBodyHash,
    #[error("HPKE operation failed")]
    Hpke,
    #[error("message is truncated")]
    Truncated,
    #[error("message contains trailing data")]
    TrailingData,
    #[error("message is oversized")]
    Oversized,
    #[error("invalid message length")]
    InvalidLength,
    #[error("message is not canonical")]
    NonCanonical,
}

/// Narrow native ABI. It accepts secret material only from the native Monero
/// Core and returns a fixed-size ciphertext. No error string, JSON value or
/// secret-bearing object crosses into React or Tauri.
pub mod ffi {
    #![allow(clippy::missing_safety_doc)]

    use super::*;
    use argon2::Argon2;
    use chacha20poly1305::{
        aead::{Aead as _, KeyInit as _, Payload},
        XChaCha20Poly1305, XNonce,
    };
    use curve25519_dalek::edwards::CompressedEdwardsY;
    use mfw_recipient_protocol::name::MAX_NAME_RECORD_BYTES;
    use mfw_recipient_protocol::{
        combine_phone_token, derive_hpke_key_id, derive_pair_id,
        generate_hpke_keypair as generate_mfw_hpke_keypair, normalize_e164,
        AddressKind as MfwAddressKind, AskDecision, AskEnvelope, AskMailboxPoll, AskMessageKind,
        AskRequest, AskResponse, CanonicalName as MfwCanonicalName,
        CommitRecord as MfwCommitRecord, ContactCard as MfwContactCard, ContactEnvelope,
        ContactPolicy, ContactRevocation, ContactSigningKey, HpkePrivateKey as MfwHpkePrivateKey,
        NameOperation as MfwNameOperation, NameRecord as MfwNameRecord,
        NameSigningKey as MfwNameSigningKey, Network as MfwNameNetwork, OprfClientSession,
        OprfEvaluation, PairId, ParticipantRecord, ParticipantRevocation, PermitRefreshRequest,
        PhoneToken, PublicAddress as MfwPublicAddress, SignedDirectorySnapshot, ASK_ENVELOPE_BYTES,
        ASK_MAILBOX_POLL_BYTES, PERMIT_REFRESH_REQUEST_BYTES, VOPRF_CLIENT_STATE_BYTES,
        VOPRF_EVALUATION_BYTES, VOPRF_REQUEST_BYTES,
    };
    use monero_address::{
        AddressType as MoneroAddressType, MoneroAddress, Network as MoneroAddressNetwork,
    };
    use std::{
        collections::BTreeMap,
        panic::catch_unwind,
        slice,
        sync::{Mutex, OnceLock},
    };

    pub const OK: i32 = 0;
    pub const INVALID_ARGUMENT: i32 = 1;
    pub const INVALID_DESCRIPTOR: i32 = 2;
    pub const ENCRYPTION_FAILED: i32 = 3;
    pub const PRIVATE_DIRECTORY_FAILED: i32 = 4;
    pub const MFW_NAME_RESOLUTION_BYTES: usize = 101;
    pub const MFW_MONERO_ADDRESS_BYTES: usize = 95;
    pub const MFW_NAME_OWNER_KEY_BYTES: usize = 32;
    pub const MFW_NAME_COMMIT_SALT_BYTES: usize = 16;
    pub const MFW_NAME_RECORD_MAX_BYTES: usize = MAX_NAME_RECORD_BYTES;
    pub const MFW_NAME_EXTRA_MAX_BYTES: usize = 255;
    pub const MFW_NAME_RECOVERY_MAX_BYTES: usize = 193;
    const MFW_NAME_RECOVERY_MAGIC: &[u8; 8] = b"MFWKEY01";
    pub const MFW_PHONE_SESSION_HANDLE_BYTES: usize = 32;
    pub const MFW_PARTICIPANT_RECORD_BYTES: usize = 201;
    pub const MFW_PERMIT_REFRESH_REQUEST_BYTES: usize = PERMIT_REFRESH_REQUEST_BYTES;
    pub const MFW_CONTACT_ENVELOPE_BYTES: usize = 537;
    pub const MFW_ASK_MESSAGE_BYTES: usize = 256;
    pub const MFW_ASK_ENVELOPE_BYTES: usize = ASK_ENVELOPE_BYTES;
    pub const MFW_ASK_MAILBOX_POLL_BYTES: usize = ASK_MAILBOX_POLL_BYTES;
    pub const MFW_CONTACT_REVOCATION_BYTES: usize = 193;
    pub const MFW_PARTICIPANT_REVOCATION_BYTES: usize = 169;
    const MAX_MFW_PHONE_SESSIONS: usize = 128;

    #[derive(Zeroize, ZeroizeOnDrop)]
    struct MfwPhoneSession {
        normalized_e164: String,
        epoch: u64,
        state: [u8; VOPRF_CLIENT_STATE_BYTES],
    }

    static MFW_PHONE_SESSIONS: OnceLock<
        Mutex<BTreeMap<[u8; MFW_PHONE_SESSION_HANDLE_BYTES], MfwPhoneSession>>,
    > = OnceLock::new();

    fn phone_sessions(
    ) -> &'static Mutex<BTreeMap<[u8; MFW_PHONE_SESSION_HANDLE_BYTES], MfwPhoneSession>> {
        MFW_PHONE_SESSIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    fn verify_mfw_name_record(
        record: &[u8],
        expected_name: &[u8],
        expected_network: u8,
        signing_owner_public_key: &[u8],
    ) -> Result<(MfwNameRecord, MfwNameNetwork), mfw_recipient_protocol::name::NameProtocolError>
    {
        let network = MfwNameNetwork::decode(expected_network)?;
        let expected_name = MfwCanonicalName::parse(
            std::str::from_utf8(expected_name)
                .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidName)?,
        )?;
        let record = MfwNameRecord::decode(record)?;
        if record.name != expected_name {
            return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidTransition);
        }
        record.verify_with_signer(
            network,
            signing_owner_public_key
                .try_into()
                .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?,
        )?;
        Ok((record, network))
    }

    fn encode_mfw_monero_address(
        record: &MfwNameRecord,
        network: MfwNameNetwork,
    ) -> Result<String, mfw_recipient_protocol::name::NameProtocolError> {
        encode_mfw_public_address(&record.address, network)
    }

    fn encode_mfw_public_address(
        public_address: &mfw_recipient_protocol::PublicAddress,
        network: MfwNameNetwork,
    ) -> Result<String, mfw_recipient_protocol::name::NameProtocolError> {
        let spend = CompressedEdwardsY(public_address.public_spend_key)
            .decompress()
            .ok_or(mfw_recipient_protocol::name::NameProtocolError::InvalidMoneroPublicKey)?;
        let view = CompressedEdwardsY(public_address.public_view_key)
            .decompress()
            .ok_or(mfw_recipient_protocol::name::NameProtocolError::InvalidMoneroPublicKey)?;
        let network = match network {
            MfwNameNetwork::Mainnet => MoneroAddressNetwork::Mainnet,
            MfwNameNetwork::Testnet => MoneroAddressNetwork::Testnet,
            MfwNameNetwork::Stagenet => MoneroAddressNetwork::Stagenet,
        };
        let address_type = match public_address.kind {
            MfwAddressKind::Standard => MoneroAddressType::Legacy,
            MfwAddressKind::Subaddress => MoneroAddressType::Subaddress,
        };
        Ok(MoneroAddress::new(network, address_type, spend, view).to_string())
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_fast_wallet_protocol_verify_descriptor_v1(
        descriptor: *const u8,
        descriptor_len: usize,
        expected_network: u8,
        now: u64,
    ) -> i32 {
        catch_unwind(|| {
            let Ok(network) = Network::decode(expected_network) else {
                return INVALID_ARGUMENT;
            };
            let Some(bytes) = checked_input(descriptor, descriptor_len, 1, 4_096) else {
                return INVALID_ARGUMENT;
            };
            match WorkerDescriptor::decode(bytes).and_then(|value| value.verify(network, now)) {
                Ok(()) => OK,
                Err(_) => INVALID_DESCRIPTOR,
            }
        })
        .unwrap_or(INVALID_DESCRIPTOR)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_fast_wallet_protocol_descriptor_relay_origin_v1(
        descriptor: *const u8,
        descriptor_len: usize,
        expected_network: u8,
        now: u64,
        output: *mut u8,
        output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Ok(network) = Network::decode(expected_network) else {
                return INVALID_ARGUMENT;
            };
            let Some(bytes) = checked_input(descriptor, descriptor_len, 1, 4_096) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len.is_null() {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let descriptor = WorkerDescriptor::decode(bytes)?;
                descriptor.verify(network, now)?;
                Ok::<_, ProtocolError>(descriptor.relay_origin.into_bytes())
            })();
            let Ok(origin) = result else {
                return INVALID_DESCRIPTOR;
            };
            // SAFETY: the caller owns the checked in/out pointer.
            let capacity = unsafe { *output_len };
            if origin.is_empty() || capacity < origin.len() {
                unsafe { *output_len = origin.len() };
                return INVALID_ARGUMENT;
            }
            // SAFETY: the caller declared at least `capacity` writable bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(origin.as_ptr(), output, origin.len());
                *output_len = origin.len();
            }
            OK
        })
        .unwrap_or(INVALID_DESCRIPTOR)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_fast_wallet_protocol_descriptor_worker_root_id_v1(
        descriptor: *const u8,
        descriptor_len: usize,
        expected_network: u8,
        now: u64,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Ok(network) = Network::decode(expected_network) else {
                return INVALID_ARGUMENT;
            };
            let Some(bytes) = checked_input(descriptor, descriptor_len, 1, 4_096) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != 32 {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let descriptor = WorkerDescriptor::decode(bytes)?;
                descriptor.verify(network, now)?;
                Ok::<_, ProtocolError>(descriptor.worker_root_id())
            })();
            let Ok(root_id) = result else {
                return INVALID_DESCRIPTOR;
            };
            // SAFETY: the caller declared an exact writable 32-byte output.
            unsafe {
                std::ptr::copy_nonoverlapping(root_id.as_ptr(), output, root_id.len());
            }
            OK
        })
        .unwrap_or(INVALID_DESCRIPTOR)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_fast_wallet_protocol_seal_watch_v1(
        descriptor: *const u8,
        descriptor_len: usize,
        expected_network: u8,
        assignment_handle: *const u8,
        assignment_epoch: u64,
        issued_at: u64,
        expires_at: u64,
        now: u64,
        address: *const u8,
        address_len: usize,
        private_view_key: *const u8,
        restore_height: u64,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Ok(network) = Network::decode(expected_network) else {
                return INVALID_ARGUMENT;
            };
            let Some(descriptor_bytes) = checked_input(descriptor, descriptor_len, 1, 4_096) else {
                return INVALID_ARGUMENT;
            };
            let Some(handle_bytes) = checked_input(assignment_handle, 32, 32, 32) else {
                return INVALID_ARGUMENT;
            };
            let Some(address_bytes) =
                checked_input(address, address_len, 1, MAX_MONERO_ADDRESS_BYTES)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(view_key_bytes) = checked_input(private_view_key, 32, 32, 32) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != WATCH_ENVELOPE_SIZE {
                return INVALID_ARGUMENT;
            }

            let result = (|| {
                let descriptor = WorkerDescriptor::decode(descriptor_bytes)?;
                descriptor.verify(network, now)?;
                let binding = WatchBinding::new(
                    &descriptor,
                    fixed_array(handle_bytes)?,
                    assignment_epoch,
                    issued_at,
                    expires_at,
                )?;
                let address = std::str::from_utf8(address_bytes)
                    .map_err(|_| ProtocolError::InvalidAddress)?
                    .to_owned();
                let mut secret = WatchSecret::new(
                    address,
                    fixed_array(view_key_bytes)?,
                    network,
                    restore_height,
                )?;
                let envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now)?;
                secret.zeroize();
                Ok::<_, ProtocolError>(envelope.encode())
            })();
            let Ok(mut encoded) = result else {
                return ENCRYPTION_FAILED;
            };
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), output, encoded.len());
            encoded.zeroize();
            OK
        })
        .unwrap_or(ENCRYPTION_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_normalize_e164_v1(
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(input) = checked_input(input, input_len, 9, 16) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len.is_null() {
                return INVALID_ARGUMENT;
            }
            let Ok(input) = std::str::from_utf8(input) else {
                return INVALID_ARGUMENT;
            };
            let Ok(normalized) = normalize_e164(input) else {
                return INVALID_ARGUMENT;
            };
            let capacity = unsafe { *output_len };
            if capacity < normalized.len() {
                unsafe { *output_len = normalized.len() };
                return INVALID_ARGUMENT;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(normalized.as_ptr(), output, normalized.len());
                *output_len = normalized.len();
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Verifies the canonical owner signature returned by the MFW name index.
    ///
    /// Output layout: address kind (1), public spend key (32), public view key
    /// (32), current owner key (32), and big-endian sequence (4). Inclusion,
    /// Registry payment and finality are checked by the canonical Cuprate
    /// index; callers must additionally enforce the finalized RPC status and
    /// minimum confirmation policy before allowing payment.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_verify_name_record_v1(
        record: *const u8,
        record_len: usize,
        expected_name: *const u8,
        expected_name_len: usize,
        expected_network: u8,
        signing_owner_public_key: *const u8,
        signing_owner_public_key_len: usize,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(record) = checked_input(record, record_len, 189, 251) else {
                return INVALID_ARGUMENT;
            };
            let Some(expected_name) = checked_input(expected_name, expected_name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(signing_owner_public_key) = checked_input(
                signing_owner_public_key,
                signing_owner_public_key_len,
                32,
                32,
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != MFW_NAME_RESOLUTION_BYTES {
                return INVALID_ARGUMENT;
            }
            let Ok((record, _network)) = verify_mfw_name_record(
                record,
                expected_name,
                expected_network,
                signing_owner_public_key,
            ) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                *output = record.address.kind as u8;
                std::ptr::copy_nonoverlapping(
                    record.address.public_spend_key.as_ptr(),
                    output.add(1),
                    32,
                );
                std::ptr::copy_nonoverlapping(
                    record.address.public_view_key.as_ptr(),
                    output.add(33),
                    32,
                );
                std::ptr::copy_nonoverlapping(record.owner_public_key.as_ptr(), output.add(65), 32);
                std::ptr::copy_nonoverlapping(
                    record.sequence.to_be_bytes().as_ptr(),
                    output.add(97),
                    4,
                );
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Verifies the signed canonical MFW name record and derives the exact
    /// Monero Base58 address from its authenticated public keys. The resolver
    /// never supplies a trusted address string.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_verify_and_encode_name_address_v1(
        record: *const u8,
        record_len: usize,
        expected_name: *const u8,
        expected_name_len: usize,
        expected_network: u8,
        signing_owner_public_key: *const u8,
        signing_owner_public_key_len: usize,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(record) = checked_input(record, record_len, 189, 251) else {
                return INVALID_ARGUMENT;
            };
            let Some(expected_name) = checked_input(expected_name, expected_name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(signing_owner_public_key) = checked_input(
                signing_owner_public_key,
                signing_owner_public_key_len,
                32,
                32,
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != MFW_MONERO_ADDRESS_BYTES {
                return INVALID_ARGUMENT;
            }
            let Ok((record, network)) = verify_mfw_name_record(
                record,
                expected_name,
                expected_network,
                signing_owner_public_key,
            ) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok(address) = encode_mfw_monero_address(&record, network) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            if address.len() != MFW_MONERO_ADDRESS_BYTES {
                return PRIVATE_DIRECTORY_FAILED;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(address.as_ptr(), output, address.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_decode_monero_address_v1(
        address: *const u8,
        address_len: usize,
        expected_network: u8,
        address_kind_output: *mut u8,
        public_spend_key_output: *mut u8,
        public_spend_key_output_len: usize,
        public_view_key_output: *mut u8,
        public_view_key_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(address) = checked_input(
                address,
                address_len,
                MFW_MONERO_ADDRESS_BYTES,
                MFW_MONERO_ADDRESS_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            if address_kind_output.is_null()
                || public_spend_key_output.is_null()
                || public_spend_key_output_len != 32
                || public_view_key_output.is_null()
                || public_view_key_output_len != 32
            {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let network = match MfwNameNetwork::decode(expected_network)? {
                    MfwNameNetwork::Mainnet => MoneroAddressNetwork::Mainnet,
                    MfwNameNetwork::Testnet => MoneroAddressNetwork::Testnet,
                    MfwNameNetwork::Stagenet => MoneroAddressNetwork::Stagenet,
                };
                let address = std::str::from_utf8(address).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::InvalidMoneroPublicKey
                })?;
                let decoded = MoneroAddress::from_str(network, address).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::InvalidMoneroPublicKey
                })?;
                let kind =
                    match decoded.kind() {
                        MoneroAddressType::Legacy => MfwAddressKind::Standard as u8,
                        MoneroAddressType::Subaddress => MfwAddressKind::Subaddress as u8,
                        _ => return Err(
                            mfw_recipient_protocol::name::NameProtocolError::InvalidMoneroPublicKey,
                        ),
                    };
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>((
                    kind,
                    decoded.spend().compress().to_bytes(),
                    decoded.view().compress().to_bytes(),
                ))
            })();
            let Ok((kind, spend, view)) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                *address_kind_output = kind;
                std::ptr::copy_nonoverlapping(spend.as_ptr(), public_spend_key_output, 32);
                std::ptr::copy_nonoverlapping(view.as_ptr(), public_view_key_output, 32);
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Creates the secret material and both canonical records for a new MFW
    /// name registration. Callers must copy the owner key and salt directly
    /// into platform protected storage and clear their temporary buffers.
    ///
    /// Neither the owner key, salt nor raw tx_extra belongs in a renderer or
    /// React Native value. Product bridges expose only the prepared Monero
    /// transaction and the public owner key.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_generate_name_registration_v1(
        name: *const u8,
        name_len: usize,
        expected_network: u8,
        address_kind: u8,
        public_spend_key: *const u8,
        public_spend_key_len: usize,
        public_view_key: *const u8,
        public_view_key_len: usize,
        owner_private_key_output: *mut u8,
        owner_private_key_output_len: usize,
        owner_public_key_output: *mut u8,
        owner_public_key_output_len: usize,
        commit_salt_output: *mut u8,
        commit_salt_output_len: usize,
        commit_extra_output: *mut u8,
        commit_extra_output_capacity: usize,
        commit_extra_output_len: *mut usize,
        claim_record_output: *mut u8,
        claim_record_output_capacity: usize,
        claim_record_output_len: *mut usize,
        claim_extra_output: *mut u8,
        claim_extra_output_capacity: usize,
        claim_extra_output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(name) = checked_input(name, name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(public_spend_key) =
                checked_input(public_spend_key, public_spend_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(public_view_key) = checked_input(public_view_key, public_view_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            if owner_private_key_output.is_null()
                || owner_private_key_output_len != MFW_NAME_OWNER_KEY_BYTES
                || owner_public_key_output.is_null()
                || owner_public_key_output_len != MFW_NAME_OWNER_KEY_BYTES
                || commit_salt_output.is_null()
                || commit_salt_output_len != MFW_NAME_COMMIT_SALT_BYTES
                || !valid_variable_output(
                    commit_extra_output,
                    commit_extra_output_capacity,
                    commit_extra_output_len,
                    MFW_NAME_EXTRA_MAX_BYTES,
                )
                || !valid_variable_output(
                    claim_record_output,
                    claim_record_output_capacity,
                    claim_record_output_len,
                    MFW_NAME_RECORD_MAX_BYTES,
                )
                || !valid_variable_output(
                    claim_extra_output,
                    claim_extra_output_capacity,
                    claim_extra_output_len,
                    MFW_NAME_EXTRA_MAX_BYTES,
                )
            {
                return INVALID_ARGUMENT;
            }

            let result = (|| {
                let network = MfwNameNetwork::decode(expected_network)?;
                let name =
                    MfwCanonicalName::parse(std::str::from_utf8(name).map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidName
                    })?)?;
                let address = mfw_public_address(address_kind, public_spend_key, public_view_key)?;
                let owner = MfwNameSigningKey::generate()?;
                let mut salt = [0_u8; MFW_NAME_COMMIT_SALT_BYTES];
                getrandom::fill(&mut salt).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::RandomnessUnavailable
                })?;
                let owner_public_key = owner.public_key();
                let commit = MfwCommitRecord::for_claim(network, &name, &owner_public_key, &salt);
                let claim = MfwNameRecord::signed_claim(network, name, address, salt, &owner)?;
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>((
                    owner.export_bytes(),
                    owner_public_key,
                    salt,
                    commit.to_tx_extra_nonce_field()?,
                    claim.encode()?,
                    claim.to_tx_extra_nonce_field()?,
                ))
            })();
            let Ok((
                mut owner_private_key,
                owner_public_key,
                mut salt,
                commit_extra,
                claim_record,
                claim_extra,
            )) = result
            else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    owner_private_key.as_ptr(),
                    owner_private_key_output,
                    owner_private_key.len(),
                );
                std::ptr::copy_nonoverlapping(
                    owner_public_key.as_ptr(),
                    owner_public_key_output,
                    owner_public_key.len(),
                );
                std::ptr::copy_nonoverlapping(salt.as_ptr(), commit_salt_output, salt.len());
                copy_variable_output(&commit_extra, commit_extra_output, commit_extra_output_len);
                copy_variable_output(&claim_record, claim_record_output, claim_record_output_len);
                copy_variable_output(&claim_extra, claim_extra_output, claim_extra_output_len);
            }
            owner_private_key.zeroize();
            salt.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Recreates a canonical CLAIM from protected owner material. This is
    /// intentionally deterministic so an interrupted COMMIT/CLAIM flow can be
    /// resumed after an application restart without persisting raw tx_extra.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_prepare_name_claim_v1(
        name: *const u8,
        name_len: usize,
        expected_network: u8,
        address_kind: u8,
        public_spend_key: *const u8,
        public_spend_key_len: usize,
        public_view_key: *const u8,
        public_view_key_len: usize,
        owner_private_key: *const u8,
        owner_private_key_len: usize,
        commit_salt: *const u8,
        commit_salt_len: usize,
        owner_public_key_output: *mut u8,
        owner_public_key_output_len: usize,
        claim_record_output: *mut u8,
        claim_record_output_capacity: usize,
        claim_record_output_len: *mut usize,
        claim_extra_output: *mut u8,
        claim_extra_output_capacity: usize,
        claim_extra_output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(name) = checked_input(name, name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(public_spend_key) =
                checked_input(public_spend_key, public_spend_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(public_view_key) = checked_input(public_view_key, public_view_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(owner_private_key) =
                checked_input(owner_private_key, owner_private_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(commit_salt) = checked_input(commit_salt, commit_salt_len, 16, 16) else {
                return INVALID_ARGUMENT;
            };
            if owner_public_key_output.is_null()
                || owner_public_key_output_len != MFW_NAME_OWNER_KEY_BYTES
                || !valid_variable_output(
                    claim_record_output,
                    claim_record_output_capacity,
                    claim_record_output_len,
                    MFW_NAME_RECORD_MAX_BYTES,
                )
                || !valid_variable_output(
                    claim_extra_output,
                    claim_extra_output_capacity,
                    claim_extra_output_len,
                    MFW_NAME_EXTRA_MAX_BYTES,
                )
            {
                return INVALID_ARGUMENT;
            }

            let result = (|| {
                let network = MfwNameNetwork::decode(expected_network)?;
                let name =
                    MfwCanonicalName::parse(std::str::from_utf8(name).map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidName
                    })?)?;
                let address = mfw_public_address(address_kind, public_spend_key, public_view_key)?;
                let owner =
                    MfwNameSigningKey::from_bytes(owner_private_key.try_into().map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidLength
                    })?);
                let salt = commit_salt
                    .try_into()
                    .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?;
                let claim = MfwNameRecord::signed_claim(network, name, address, salt, &owner)?;
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>((
                    owner.public_key(),
                    claim.encode()?,
                    claim.to_tx_extra_nonce_field()?,
                ))
            })();
            let Ok((owner_public_key, claim_record, claim_extra)) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    owner_public_key.as_ptr(),
                    owner_public_key_output,
                    owner_public_key.len(),
                );
                copy_variable_output(&claim_record, claim_record_output, claim_record_output_len);
                copy_variable_output(&claim_extra, claim_extra_output, claim_extra_output_len);
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Creates an owner-signed UPDATE, RENEW or REVOKE record from a verified
    /// predecessor. The new record keeps the same owner key. RENEW and REVOKE
    /// are additionally bound to the predecessor address; only UPDATE may
    /// change the destination.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_prepare_name_transition_v1(
        operation: u8,
        name: *const u8,
        name_len: usize,
        expected_network: u8,
        address_kind: u8,
        public_spend_key: *const u8,
        public_spend_key_len: usize,
        public_view_key: *const u8,
        public_view_key_len: usize,
        owner_private_key: *const u8,
        owner_private_key_len: usize,
        predecessor_record: *const u8,
        predecessor_record_len: usize,
        predecessor_signing_owner_public_key: *const u8,
        predecessor_signing_owner_public_key_len: usize,
        transition_record_output: *mut u8,
        transition_record_output_capacity: usize,
        transition_record_output_len: *mut usize,
        transition_extra_output: *mut u8,
        transition_extra_output_capacity: usize,
        transition_extra_output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(name) = checked_input(name, name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(public_spend_key) =
                checked_input(public_spend_key, public_spend_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(public_view_key) = checked_input(public_view_key, public_view_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(owner_private_key) =
                checked_input(owner_private_key, owner_private_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(predecessor_record) =
                checked_input(predecessor_record, predecessor_record_len, 189, 251)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(predecessor_signing_owner_public_key) = checked_input(
                predecessor_signing_owner_public_key,
                predecessor_signing_owner_public_key_len,
                32,
                32,
            ) else {
                return INVALID_ARGUMENT;
            };
            if !valid_variable_output(
                transition_record_output,
                transition_record_output_capacity,
                transition_record_output_len,
                MFW_NAME_RECORD_MAX_BYTES,
            ) || !valid_variable_output(
                transition_extra_output,
                transition_extra_output_capacity,
                transition_extra_output_len,
                MFW_NAME_EXTRA_MAX_BYTES,
            ) {
                return INVALID_ARGUMENT;
            }

            let result = (|| {
                let network = MfwNameNetwork::decode(expected_network)?;
                let operation = match operation {
                    3 => MfwNameOperation::Update,
                    4 => MfwNameOperation::Renew,
                    5 => MfwNameOperation::Revoke,
                    _ => {
                        return Err(mfw_recipient_protocol::name::NameProtocolError::WrongOperation)
                    }
                };
                let name =
                    MfwCanonicalName::parse(std::str::from_utf8(name).map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidName
                    })?)?;
                let address = mfw_public_address(address_kind, public_spend_key, public_view_key)?;
                let owner =
                    MfwNameSigningKey::from_bytes(owner_private_key.try_into().map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidLength
                    })?);
                let predecessor = MfwNameRecord::decode(predecessor_record)?;
                predecessor.verify_with_signer(
                    network,
                    predecessor_signing_owner_public_key
                        .try_into()
                        .map_err(|_| {
                            mfw_recipient_protocol::name::NameProtocolError::InvalidLength
                        })?,
                )?;
                if predecessor.name != name
                    || predecessor.owner_public_key != owner.public_key()
                    || (operation != MfwNameOperation::Update && predecessor.address != address)
                {
                    return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidTransition);
                }
                let sequence = predecessor
                    .sequence
                    .checked_add(1)
                    .ok_or(mfw_recipient_protocol::name::NameProtocolError::Overflow)?;
                let transition = MfwNameRecord::signed_transition(
                    network,
                    operation,
                    sequence,
                    name,
                    owner.public_key(),
                    address,
                    &predecessor,
                    &owner,
                )?;
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>((
                    transition.encode()?,
                    transition.to_tx_extra_nonce_field()?,
                ))
            })();
            let Ok((record, extra)) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                copy_variable_output(
                    &record,
                    transition_record_output,
                    transition_record_output_len,
                );
                copy_variable_output(&extra, transition_extra_output, transition_extra_output_len);
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Password-encrypts a device-held owner key into a portable, versioned
    /// recovery bundle. The caller presents and shares this bundle entirely
    /// in native UI; it must never be returned through React or Tauri.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_export_name_recovery_v1(
        name: *const u8,
        name_len: usize,
        expected_network: u8,
        owner_private_key: *const u8,
        owner_private_key_len: usize,
        passphrase: *const u8,
        passphrase_len: usize,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(name) = checked_input(name, name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(owner_private_key) =
                checked_input(owner_private_key, owner_private_key_len, 32, 32)
            else {
                return INVALID_ARGUMENT;
            };
            let Some(passphrase) = checked_input(passphrase, passphrase_len, 12, 1024) else {
                return INVALID_ARGUMENT;
            };
            if !valid_variable_output(
                output,
                output_capacity,
                output_len,
                MFW_NAME_RECOVERY_MAX_BYTES,
            ) {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let network = MfwNameNetwork::decode(expected_network)?;
                let name =
                    MfwCanonicalName::parse(std::str::from_utf8(name).map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidName
                    })?)?;
                let owner =
                    MfwNameSigningKey::from_bytes(owner_private_key.try_into().map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidLength
                    })?);
                let mut salt = [0_u8; 16];
                let mut nonce = [0_u8; 24];
                getrandom::fill(&mut salt).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::RandomnessUnavailable
                })?;
                getrandom::fill(&mut nonce).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::RandomnessUnavailable
                })?;
                let mut key = [0_u8; 32];
                Argon2::default()
                    .hash_password_into(passphrase, &salt, &mut key)
                    .map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                    })?;
                let mut header = Vec::with_capacity(82 + name.as_str().len());
                header.extend_from_slice(MFW_NAME_RECOVERY_MAGIC);
                header.push(network as u8);
                header.push(u8::try_from(name.as_str().len()).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::InvalidNameLength
                })?);
                header.extend_from_slice(name.as_str().as_bytes());
                header.extend_from_slice(&owner.public_key());
                header.extend_from_slice(&salt);
                header.extend_from_slice(&nonce);
                let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                })?;
                let cipher_nonce = XNonce::from(nonce);
                let encrypted = cipher
                    .encrypt(
                        &cipher_nonce,
                        Payload {
                            msg: owner_private_key,
                            aad: &header,
                        },
                    )
                    .map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                    })?;
                key.zeroize();
                salt.zeroize();
                nonce.zeroize();
                if encrypted.len() != 48 {
                    return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidLength);
                }
                header.extend_from_slice(&encrypted);
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>(header)
            })();
            let Ok(bundle) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                copy_variable_output(&bundle, output, output_len);
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    /// Decrypts and authenticates an exported owner key while binding it to
    /// the caller-selected canonical name and network.
    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_import_name_recovery_v1(
        bundle: *const u8,
        bundle_len: usize,
        expected_name: *const u8,
        expected_name_len: usize,
        expected_network: u8,
        passphrase: *const u8,
        passphrase_len: usize,
        owner_private_key_output: *mut u8,
        owner_private_key_output_len: usize,
        owner_public_key_output: *mut u8,
        owner_public_key_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(bundle) = checked_input(bundle, bundle_len, 131, 193) else {
                return INVALID_ARGUMENT;
            };
            let Some(expected_name) = checked_input(expected_name, expected_name_len, 1, 67) else {
                return INVALID_ARGUMENT;
            };
            let Some(passphrase) = checked_input(passphrase, passphrase_len, 12, 1024) else {
                return INVALID_ARGUMENT;
            };
            if owner_private_key_output.is_null()
                || owner_private_key_output_len != MFW_NAME_OWNER_KEY_BYTES
                || owner_public_key_output.is_null()
                || owner_public_key_output_len != MFW_NAME_OWNER_KEY_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let network = MfwNameNetwork::decode(expected_network)?;
                let expected_name =
                    MfwCanonicalName::parse(std::str::from_utf8(expected_name).map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidName
                    })?)?;
                if &bundle[..8] != MFW_NAME_RECOVERY_MAGIC || bundle[8] != network as u8 {
                    return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidTransition);
                }
                let name_len = usize::from(bundle[9]);
                let header_len = 82_usize
                    .checked_add(name_len)
                    .ok_or(mfw_recipient_protocol::name::NameProtocolError::Overflow)?;
                if name_len == 0
                    || name_len > 63
                    || bundle.len() != header_len + 48
                    || bundle.get(10..10 + name_len) != Some(expected_name.as_str().as_bytes())
                {
                    return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidName);
                }
                let public_key_start = 10 + name_len;
                let stored_public_key: [u8; 32] = bundle
                    .get(public_key_start..public_key_start + 32)
                    .ok_or(mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?
                    .try_into()
                    .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?;
                let salt_start = public_key_start + 32;
                let nonce_start = salt_start + 16;
                let salt = bundle
                    .get(salt_start..nonce_start)
                    .ok_or(mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?;
                let nonce: [u8; 24] = bundle
                    .get(nonce_start..header_len)
                    .ok_or(mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?
                    .try_into()
                    .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?;
                let mut key = [0_u8; 32];
                Argon2::default()
                    .hash_password_into(passphrase, salt, &mut key)
                    .map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                    })?;
                let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
                    mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                })?;
                let cipher_nonce = XNonce::from(nonce);
                let mut decrypted = cipher
                    .decrypt(
                        &cipher_nonce,
                        Payload {
                            msg: &bundle[header_len..],
                            aad: &bundle[..header_len],
                        },
                    )
                    .map_err(|_| {
                        mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey
                    })?;
                key.zeroize();
                if decrypted.len() != 32 {
                    decrypted.zeroize();
                    return Err(mfw_recipient_protocol::name::NameProtocolError::InvalidLength);
                }
                let owner_private_key: [u8; 32] = decrypted
                    .as_slice()
                    .try_into()
                    .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?;
                decrypted.zeroize();
                let owner_public_key =
                    MfwNameSigningKey::from_bytes(owner_private_key).public_key();
                if owner_public_key != stored_public_key {
                    return Err(
                        mfw_recipient_protocol::name::NameProtocolError::InvalidOwnerPublicKey,
                    );
                }
                Ok::<_, mfw_recipient_protocol::name::NameProtocolError>((
                    owner_private_key,
                    owner_public_key,
                ))
            })();
            let Ok((mut owner_private_key, owner_public_key)) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    owner_private_key.as_ptr(),
                    owner_private_key_output,
                    owner_private_key.len(),
                );
                std::ptr::copy_nonoverlapping(
                    owner_public_key.as_ptr(),
                    owner_public_key_output,
                    owner_public_key.len(),
                );
            }
            owner_private_key.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_voprf_blind_v1(
        e164: *const u8,
        e164_len: usize,
        epoch: u64,
        state_output: *mut u8,
        state_output_len: usize,
        request_output: *mut u8,
        request_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(e164) = checked_input(e164, e164_len, 9, 16) else {
                return INVALID_ARGUMENT;
            };
            if state_output.is_null()
                || state_output_len != VOPRF_CLIENT_STATE_BYTES
                || request_output.is_null()
                || request_output_len != VOPRF_REQUEST_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let Ok(e164) = std::str::from_utf8(e164) else {
                return INVALID_ARGUMENT;
            };
            let Ok((session, request)) = OprfClientSession::blind(e164, epoch) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let mut state = session.export_state();
            let request = request.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(state.as_ptr(), state_output, state.len());
                std::ptr::copy_nonoverlapping(request.as_ptr(), request_output, request.len());
            }
            state.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_voprf_blind_session_v1(
        e164: *const u8,
        e164_len: usize,
        epoch: u64,
        state_handle_output: *mut u8,
        state_handle_output_len: usize,
        request_output: *mut u8,
        request_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(e164) = checked_input(e164, e164_len, 9, 16) else {
                return INVALID_ARGUMENT;
            };
            if state_handle_output.is_null()
                || state_handle_output_len != MFW_PHONE_SESSION_HANDLE_BYTES
                || request_output.is_null()
                || request_output_len != VOPRF_REQUEST_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let Ok(e164) = std::str::from_utf8(e164) else {
                return INVALID_ARGUMENT;
            };
            let Ok(normalized) = normalize_e164(e164) else {
                return INVALID_ARGUMENT;
            };
            let Ok((session, request)) = OprfClientSession::blind(&normalized, epoch) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let state = session.export_state();
            let request = request.encode();
            let Ok(mut sessions) = phone_sessions().lock() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            if sessions.len() >= MAX_MFW_PHONE_SESSIONS {
                return PRIVATE_DIRECTORY_FAILED;
            }
            let mut handle = [0_u8; MFW_PHONE_SESSION_HANDLE_BYTES];
            let mut inserted = false;
            for _ in 0..8 {
                if getrandom::fill(&mut handle).is_err() || handle == [0; 32] {
                    continue;
                }
                if let std::collections::btree_map::Entry::Vacant(entry) = sessions.entry(handle) {
                    entry.insert(MfwPhoneSession {
                        normalized_e164: normalized.clone(),
                        epoch,
                        state,
                    });
                    inserted = true;
                    break;
                }
            }
            if !inserted {
                return PRIVATE_DIRECTORY_FAILED;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(handle.as_ptr(), state_handle_output, handle.len());
                std::ptr::copy_nonoverlapping(request.as_ptr(), request_output, request.len());
            }
            handle.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_voprf_finalize_v1(
        e164: *const u8,
        e164_len: usize,
        epoch: u64,
        state: *const u8,
        state_len: usize,
        evaluation: *const u8,
        evaluation_len: usize,
        expected_server_public_key: *const u8,
        expected_server_public_key_len: usize,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(e164) = checked_input(e164, e164_len, 9, 16) else {
                return INVALID_ARGUMENT;
            };
            let Some(state) = checked_input(
                state,
                state_len,
                VOPRF_CLIENT_STATE_BYTES,
                VOPRF_CLIENT_STATE_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            let Some(evaluation) = checked_input(
                evaluation,
                evaluation_len,
                VOPRF_EVALUATION_BYTES,
                VOPRF_EVALUATION_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            let Some(public_key) = checked_input(
                expected_server_public_key,
                expected_server_public_key_len,
                32,
                32,
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != 64 {
                return INVALID_ARGUMENT;
            }
            let Ok(e164) = std::str::from_utf8(e164) else {
                return INVALID_ARGUMENT;
            };
            let result = OprfClientSession::restore(
                e164,
                epoch,
                match state.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                },
            )
            .and_then(|session| {
                session.finalize(
                    &OprfEvaluation::decode(evaluation)?,
                    public_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?,
                )
            });
            let Ok(mut result) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(result.as_ptr(), output, result.len());
            }
            result.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_voprf_finalize_session_v1(
        state_handle: *const u8,
        state_handle_len: usize,
        evaluation: *const u8,
        evaluation_len: usize,
        expected_server_public_key: *const u8,
        expected_server_public_key_len: usize,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(state_handle) = checked_input(
                state_handle,
                state_handle_len,
                MFW_PHONE_SESSION_HANDLE_BYTES,
                MFW_PHONE_SESSION_HANDLE_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            let Some(evaluation) = checked_input(
                evaluation,
                evaluation_len,
                VOPRF_EVALUATION_BYTES,
                VOPRF_EVALUATION_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            let Some(public_key) = checked_input(
                expected_server_public_key,
                expected_server_public_key_len,
                32,
                32,
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != 64 {
                return INVALID_ARGUMENT;
            }
            let Ok(handle): Result<[u8; MFW_PHONE_SESSION_HANDLE_BYTES], _> =
                state_handle.try_into()
            else {
                return INVALID_ARGUMENT;
            };
            let Ok(mut sessions) = phone_sessions().lock() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Some(session) = sessions.remove(&handle) else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            drop(sessions);

            let mut state = [0_u8; VOPRF_CLIENT_STATE_BYTES];
            state.copy_from_slice(&session.state);
            let result = OprfClientSession::restore(&session.normalized_e164, session.epoch, state)
                .and_then(|client| {
                    client.finalize(
                        &OprfEvaluation::decode(evaluation)?,
                        public_key.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?,
                    )
                });
            state.zeroize();
            let Ok(mut result) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(result.as_ptr(), output, result.len());
            }
            result.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_voprf_discard_session_v1(
        state_handle: *const u8,
        state_handle_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(state_handle) = checked_input(
                state_handle,
                state_handle_len,
                MFW_PHONE_SESSION_HANDLE_BYTES,
                MFW_PHONE_SESSION_HANDLE_BYTES,
            ) else {
                return INVALID_ARGUMENT;
            };
            let Ok(handle): Result<[u8; MFW_PHONE_SESSION_HANDLE_BYTES], _> =
                state_handle.try_into()
            else {
                return INVALID_ARGUMENT;
            };
            let Ok(mut sessions) = phone_sessions().lock() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            if sessions.remove(&handle).is_some() {
                OK
            } else {
                PRIVATE_DIRECTORY_FAILED
            }
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_generate_phone_identity_v1(
        private_key_output: *mut u8,
        private_key_output_len: usize,
        public_key_output: *mut u8,
        public_key_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            if private_key_output.is_null()
                || private_key_output_len != 32
                || public_key_output.is_null()
                || public_key_output_len != 32
            {
                return INVALID_ARGUMENT;
            }
            let Ok((private, public)) = generate_mfw_hpke_keypair() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let mut private = private.export_bytes();
            unsafe {
                std::ptr::copy_nonoverlapping(private.as_ptr(), private_key_output, private.len());
                std::ptr::copy_nonoverlapping(public.as_ptr(), public_key_output, public.len());
            }
            private.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_generate_phone_registration_identity_v1(
        contact_private_key_output: *mut u8,
        contact_private_key_output_len: usize,
        contact_public_key_output: *mut u8,
        contact_public_key_output_len: usize,
        hpke_private_key_output: *mut u8,
        hpke_private_key_output_len: usize,
        hpke_public_key_output: *mut u8,
        hpke_public_key_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            if contact_private_key_output.is_null()
                || contact_private_key_output_len != 32
                || contact_public_key_output.is_null()
                || contact_public_key_output_len != 32
                || hpke_private_key_output.is_null()
                || hpke_private_key_output_len != 32
                || hpke_public_key_output.is_null()
                || hpke_public_key_output_len != 32
            {
                return INVALID_ARGUMENT;
            }
            let Ok(contact_key) = ContactSigningKey::generate() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok((hpke_private, hpke_public)) = generate_mfw_hpke_keypair() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let mut contact_private = contact_key.export_bytes();
            let contact_public = contact_key.public_key();
            let mut hpke_private = hpke_private.export_bytes();
            unsafe {
                std::ptr::copy_nonoverlapping(
                    contact_private.as_ptr(),
                    contact_private_key_output,
                    32,
                );
                std::ptr::copy_nonoverlapping(
                    contact_public.as_ptr(),
                    contact_public_key_output,
                    32,
                );
                std::ptr::copy_nonoverlapping(hpke_private.as_ptr(), hpke_private_key_output, 32);
                std::ptr::copy_nonoverlapping(hpke_public.as_ptr(), hpke_public_key_output, 32);
            }
            contact_private.zeroize();
            hpke_private.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_verify_phone_participant_v1(
        participant: *const u8,
        participant_len: usize,
        expected_verification_public_key: *const u8,
        expected_verification_public_key_len: usize,
        expected_epoch: u64,
        expected_contact_public_key: *const u8,
        expected_contact_public_key_len: usize,
        expected_hpke_public_key: *const u8,
        expected_hpke_public_key_len: usize,
        now: u64,
        phone_token_output: *mut u8,
        phone_token_output_len: usize,
        expires_at_output: *mut u64,
        sequence_output: *mut u64,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(participant), Some(verification_key), Some(contact_key), Some(hpke_key)) = (
                checked_input(
                    participant,
                    participant_len,
                    MFW_PARTICIPANT_RECORD_BYTES,
                    MFW_PARTICIPANT_RECORD_BYTES,
                ),
                checked_input(
                    expected_verification_public_key,
                    expected_verification_public_key_len,
                    32,
                    32,
                ),
                checked_input(
                    expected_contact_public_key,
                    expected_contact_public_key_len,
                    32,
                    32,
                ),
                checked_input(
                    expected_hpke_public_key,
                    expected_hpke_public_key_len,
                    32,
                    32,
                ),
            ) else {
                return INVALID_ARGUMENT;
            };
            if phone_token_output.is_null()
                || phone_token_output_len != 32
                || expires_at_output.is_null()
                || sequence_output.is_null()
            {
                return INVALID_ARGUMENT;
            }
            let result = ParticipantRecord::decode(participant).and_then(|record| {
                let verification_key: [u8; 32] = verification_key
                    .try_into()
                    .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                record.verify(verification_key, now)?;
                if record.epoch != expected_epoch
                    || record.contact_signing_public_key != contact_key
                    || record.hpke_public_key != hpke_key
                {
                    return Err(mfw_recipient_protocol::PhoneProtocolError::UnexpectedPublisher);
                }
                Ok(record)
            });
            let Ok(record) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    record.phone_token.0.as_ptr(),
                    phone_token_output,
                    32,
                );
                *expires_at_output = record.expires_at;
                *sequence_output = record.sequence;
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_sign_phone_permit_refresh_v1(
        epoch: u64,
        phone_token: *const u8,
        participant_sequence: u64,
        issued_at: u64,
        expires_at: u64,
        contact_private_key: *const u8,
        request_output: *mut u8,
        request_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(phone_token), Some(contact_key)) = (
                checked_input(phone_token, 32, 32, 32),
                checked_input(contact_private_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if request_output.is_null() || request_output_len != MFW_PERMIT_REFRESH_REQUEST_BYTES {
                return INVALID_ARGUMENT;
            }
            let mut nonce = [0_u8; 16];
            if getrandom::fill(&mut nonce).is_err() {
                return PRIVATE_DIRECTORY_FAILED;
            }
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let result = PermitRefreshRequest::signed(
                epoch,
                PhoneToken(phone_token.try_into().expect("fixed checked input")),
                participant_sequence,
                issued_at,
                expires_at,
                nonce,
                &signing_key,
            );
            nonce.zeroize();
            let Ok(request) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = request.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), request_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_seal_phone_contact_v1(
        publisher_phone_token: *const u8,
        recipient_phone_token: *const u8,
        policy: u8,
        network: u8,
        issued_at: u64,
        expires_at: u64,
        sequence: u64,
        has_address: u8,
        address_kind: u8,
        public_spend_key: *const u8,
        public_spend_key_len: usize,
        public_view_key: *const u8,
        public_view_key_len: usize,
        contact_private_key: *const u8,
        recipient_hpke_public_key: *const u8,
        envelope_output: *mut u8,
        envelope_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(publisher), Some(recipient), Some(contact_key), Some(recipient_hpke)) = (
                checked_input(publisher_phone_token, 32, 32, 32),
                checked_input(recipient_phone_token, 32, 32, 32),
                checked_input(contact_private_key, 32, 32, 32),
                checked_input(recipient_hpke_public_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if envelope_output.is_null() || envelope_output_len != MFW_CONTACT_ENVELOPE_BYTES {
                return INVALID_ARGUMENT;
            }
            let policy = match policy {
                1 => ContactPolicy::BadgeOnly,
                2 => ContactPolicy::AskEveryTime,
                3 => ContactPolicy::DirectReceiveAddress,
                _ => return INVALID_ARGUMENT,
            };
            let Ok(network) = MfwNameNetwork::decode(network) else {
                return INVALID_ARGUMENT;
            };
            let address = match has_address {
                0 if public_spend_key_len == 0 && public_view_key_len == 0 => None,
                1 => {
                    let (Some(spend), Some(view)) = (
                        checked_input(public_spend_key, public_spend_key_len, 32, 32),
                        checked_input(public_view_key, public_view_key_len, 32, 32),
                    ) else {
                        return INVALID_ARGUMENT;
                    };
                    let kind = match address_kind {
                        0 => MfwAddressKind::Standard,
                        1 => MfwAddressKind::Subaddress,
                        _ => return INVALID_ARGUMENT,
                    };
                    match MfwPublicAddress::new(
                        kind,
                        spend.try_into().expect("fixed checked input"),
                        view.try_into().expect("fixed checked input"),
                    ) {
                        Ok(value) => Some(value),
                        Err(_) => return INVALID_ARGUMENT,
                    }
                }
                _ => return INVALID_ARGUMENT,
            };
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let card = MfwContactCard {
                policy,
                network,
                issued_at,
                expires_at,
                sequence,
                publisher_token: PhoneToken(publisher.try_into().expect("fixed checked input")),
                recipient_token: PhoneToken(recipient.try_into().expect("fixed checked input")),
                address,
            };
            let result = ContactEnvelope::seal(
                &card,
                &signing_key,
                recipient_hpke.try_into().expect("fixed checked input"),
            );
            let Ok(envelope) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = envelope.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), envelope_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_seal_phone_ask_request_v1(
        requester_phone_token: *const u8,
        target_phone_token: *const u8,
        network: u8,
        issued_at: u64,
        expires_at: u64,
        sequence: u64,
        contact_private_key: *const u8,
        target_hpke_public_key: *const u8,
        request_id_output: *mut u8,
        request_id_output_len: usize,
        request_output: *mut u8,
        request_output_len: usize,
        envelope_output: *mut u8,
        envelope_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(requester), Some(target), Some(contact_key), Some(target_hpke_public)) = (
                checked_input(requester_phone_token, 32, 32, 32),
                checked_input(target_phone_token, 32, 32, 32),
                checked_input(contact_private_key, 32, 32, 32),
                checked_input(target_hpke_public_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if request_id_output.is_null()
                || request_id_output_len != 32
                || request_output.is_null()
                || request_output_len != MFW_ASK_MESSAGE_BYTES
                || envelope_output.is_null()
                || envelope_output_len != MFW_ASK_ENVELOPE_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let Ok(network) = MfwNameNetwork::decode(network) else {
                return INVALID_ARGUMENT;
            };
            let requester = PhoneToken(requester.try_into().expect("fixed checked input"));
            let target = PhoneToken(target.try_into().expect("fixed checked input"));
            let Ok(pair_id) = derive_pair_id(requester, target) else {
                return INVALID_ARGUMENT;
            };
            let mut request_id = [0_u8; 32];
            if getrandom::fill(&mut request_id).is_err() || request_id == [0; 32] {
                request_id.zeroize();
                return PRIVATE_DIRECTORY_FAILED;
            }
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let request = AskRequest {
                network,
                pair_id,
                request_id,
                requester_token: requester,
                target_token: target,
                issued_at,
                expires_at,
                sequence,
            };
            let result = AskEnvelope::seal_request(
                &request,
                &signing_key,
                target_hpke_public.try_into().expect("fixed checked input"),
            );
            let Ok(envelope) = result else {
                request_id.zeroize();
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok(mut encoded_request) = request.encode_fixed() else {
                request_id.zeroize();
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = envelope.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(
                    request_id.as_ptr(),
                    request_id_output,
                    request_id.len(),
                );
                std::ptr::copy_nonoverlapping(
                    encoded_request.as_ptr(),
                    request_output,
                    encoded_request.len(),
                );
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), envelope_output, encoded.len());
            }
            encoded_request.zeroize();
            request_id.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_phone_ask_request_v1(
        envelope: *const u8,
        envelope_len: usize,
        expected_requester_public_key: *const u8,
        target_hpke_private_key: *const u8,
        target_hpke_public_key: *const u8,
        now: u64,
        request_output: *mut u8,
        request_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (
                Some(envelope),
                Some(requester_public),
                Some(target_private),
                Some(target_public),
            ) = (
                checked_input(
                    envelope,
                    envelope_len,
                    MFW_ASK_ENVELOPE_BYTES,
                    MFW_ASK_ENVELOPE_BYTES,
                ),
                checked_input(expected_requester_public_key, 32, 32, 32),
                checked_input(target_hpke_private_key, 32, 32, 32),
                checked_input(target_hpke_public_key, 32, 32, 32),
            )
            else {
                return INVALID_ARGUMENT;
            };
            if request_output.is_null() || request_output_len != MFW_ASK_MESSAGE_BYTES {
                return INVALID_ARGUMENT;
            }
            let mut target_secret: [u8; 32] =
                target_private.try_into().expect("fixed checked input");
            let target_private = MfwHpkePrivateKey::from_bytes(target_secret);
            target_secret.zeroize();
            let result = AskEnvelope::decode(envelope).and_then(|envelope| {
                envelope.open_request(
                    requester_public.try_into().expect("fixed checked input"),
                    &target_private,
                    target_public.try_into().expect("fixed checked input"),
                    now,
                )
            });
            let Ok(request) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok(mut encoded) = request.encode_fixed() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), request_output, encoded.len());
            }
            encoded.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_seal_phone_ask_response_v1(
        request: *const u8,
        request_len: usize,
        decision: u8,
        issued_at: u64,
        expires_at: u64,
        sequence: u64,
        has_address: u8,
        address_kind: u8,
        public_spend_key: *const u8,
        public_spend_key_len: usize,
        public_view_key: *const u8,
        public_view_key_len: usize,
        responder_contact_private_key: *const u8,
        requester_hpke_public_key: *const u8,
        envelope_output: *mut u8,
        envelope_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(request), Some(contact_key), Some(requester_hpke_public)) = (
                checked_input(
                    request,
                    request_len,
                    MFW_ASK_MESSAGE_BYTES,
                    MFW_ASK_MESSAGE_BYTES,
                ),
                checked_input(responder_contact_private_key, 32, 32, 32),
                checked_input(requester_hpke_public_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if envelope_output.is_null() || envelope_output_len != MFW_ASK_ENVELOPE_BYTES {
                return INVALID_ARGUMENT;
            }
            let Ok(request) = AskRequest::decode_fixed(request) else {
                return INVALID_ARGUMENT;
            };
            let decision = match decision {
                1 => AskDecision::Declined,
                2 => AskDecision::Approved,
                _ => return INVALID_ARGUMENT,
            };
            let address = match has_address {
                0 if public_spend_key_len == 0 && public_view_key_len == 0 => None,
                1 => {
                    let (Some(spend), Some(view)) = (
                        checked_input(public_spend_key, public_spend_key_len, 32, 32),
                        checked_input(public_view_key, public_view_key_len, 32, 32),
                    ) else {
                        return INVALID_ARGUMENT;
                    };
                    let kind = match address_kind {
                        0 => MfwAddressKind::Standard,
                        1 => MfwAddressKind::Subaddress,
                        _ => return INVALID_ARGUMENT,
                    };
                    match MfwPublicAddress::new(
                        kind,
                        spend.try_into().expect("fixed checked input"),
                        view.try_into().expect("fixed checked input"),
                    ) {
                        Ok(value) => Some(value),
                        Err(_) => return INVALID_ARGUMENT,
                    }
                }
                _ => return INVALID_ARGUMENT,
            };
            if issued_at < request.issued_at
                || issued_at >= request.expires_at
                || expires_at > request.expires_at
            {
                return INVALID_ARGUMENT;
            }
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let response = AskResponse {
                decision,
                network: request.network,
                pair_id: request.pair_id,
                request_id: request.request_id,
                responder_token: request.target_token,
                requester_token: request.requester_token,
                issued_at,
                expires_at,
                sequence,
                address,
            };
            let result = AskEnvelope::seal_response(
                &response,
                &signing_key,
                requester_hpke_public
                    .try_into()
                    .expect("fixed checked input"),
            );
            let Ok(envelope) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = envelope.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), envelope_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_phone_ask_response_v1(
        envelope: *const u8,
        envelope_len: usize,
        expected_responder_public_key: *const u8,
        requester_hpke_private_key: *const u8,
        requester_hpke_public_key: *const u8,
        now: u64,
        expected_request: *const u8,
        expected_request_len: usize,
        decision_output: *mut u8,
        network_output: *mut u8,
        address_output: *mut u8,
        address_output_len: *mut usize,
        issued_at_output: *mut u64,
        expires_at_output: *mut u64,
        sequence_output: *mut u64,
    ) -> i32 {
        catch_unwind(|| {
            let (
                Some(envelope),
                Some(responder_public),
                Some(requester_private),
                Some(requester_public),
                Some(expected_request),
            ) = (
                checked_input(
                    envelope,
                    envelope_len,
                    MFW_ASK_ENVELOPE_BYTES,
                    MFW_ASK_ENVELOPE_BYTES,
                ),
                checked_input(expected_responder_public_key, 32, 32, 32),
                checked_input(requester_hpke_private_key, 32, 32, 32),
                checked_input(requester_hpke_public_key, 32, 32, 32),
                checked_input(
                    expected_request,
                    expected_request_len,
                    MFW_ASK_MESSAGE_BYTES,
                    MFW_ASK_MESSAGE_BYTES,
                ),
            )
            else {
                return INVALID_ARGUMENT;
            };
            if decision_output.is_null()
                || network_output.is_null()
                || address_output.is_null()
                || address_output_len.is_null()
                || issued_at_output.is_null()
                || expires_at_output.is_null()
                || sequence_output.is_null()
            {
                return INVALID_ARGUMENT;
            }
            let Ok(expected_request) = AskRequest::decode_fixed(expected_request) else {
                return INVALID_ARGUMENT;
            };
            let mut requester_secret: [u8; 32] =
                requester_private.try_into().expect("fixed checked input");
            let requester_private = MfwHpkePrivateKey::from_bytes(requester_secret);
            requester_secret.zeroize();
            let result = AskEnvelope::decode(envelope).and_then(|envelope| {
                envelope.open_response(
                    responder_public.try_into().expect("fixed checked input"),
                    &requester_private,
                    requester_public.try_into().expect("fixed checked input"),
                    now,
                )
            });
            let Ok(response) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            if response.pair_id != expected_request.pair_id
                || response.request_id != expected_request.request_id
                || response.responder_token != expected_request.target_token
                || response.requester_token != expected_request.requester_token
                || response.network != expected_request.network
                || response.issued_at < expected_request.issued_at
                || response.issued_at >= expected_request.expires_at
                || response.expires_at > expected_request.expires_at
            {
                return PRIVATE_DIRECTORY_FAILED;
            }
            let capacity = unsafe { *address_output_len };
            let encoded_address = match response.address {
                Some(address) => {
                    let Ok(encoded) = encode_mfw_public_address(&address, response.network) else {
                        return PRIVATE_DIRECTORY_FAILED;
                    };
                    if capacity < encoded.len() {
                        unsafe { *address_output_len = encoded.len() };
                        return INVALID_ARGUMENT;
                    }
                    Some(encoded)
                }
                None => None,
            };
            unsafe {
                *decision_output = response.decision as u8;
                *network_output = response.network as u8;
                *issued_at_output = response.issued_at;
                *expires_at_output = response.expires_at;
                *sequence_output = response.sequence;
                if let Some(address) = encoded_address {
                    std::ptr::copy_nonoverlapping(address.as_ptr(), address_output, address.len());
                    *address_output_len = address.len();
                } else {
                    *address_output_len = 0;
                }
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_sign_phone_ask_mailbox_poll_v1(
        kind: u8,
        participant_phone_token: *const u8,
        participant_sequence: u64,
        participant_hpke_public_key: *const u8,
        after_cursor: u64,
        issued_at: u64,
        expires_at: u64,
        participant_contact_private_key: *const u8,
        poll_output: *mut u8,
        poll_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(phone_token), Some(hpke_public), Some(contact_key)) = (
                checked_input(participant_phone_token, 32, 32, 32),
                checked_input(participant_hpke_public_key, 32, 32, 32),
                checked_input(participant_contact_private_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if poll_output.is_null() || poll_output_len != MFW_ASK_MAILBOX_POLL_BYTES {
                return INVALID_ARGUMENT;
            }
            let kind = match kind {
                1 => AskMessageKind::Request,
                2 => AskMessageKind::Response,
                _ => return INVALID_ARGUMENT,
            };
            let hpke_public: [u8; 32] = hpke_public.try_into().expect("fixed checked input");
            let Ok(hpke_key_id) = derive_hpke_key_id(hpke_public) else {
                return INVALID_ARGUMENT;
            };
            let mut nonce = [0_u8; 16];
            if getrandom::fill(&mut nonce).is_err() || nonce == [0; 16] {
                nonce.zeroize();
                return PRIVATE_DIRECTORY_FAILED;
            }
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let result = AskMailboxPoll::signed(
                kind,
                PhoneToken(phone_token.try_into().expect("fixed checked input")),
                participant_sequence,
                hpke_key_id,
                after_cursor,
                issued_at,
                expires_at,
                nonce,
                &signing_key,
            );
            nonce.zeroize();
            let Ok(poll) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = poll.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), poll_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_revoke_phone_contact_v1(
        publisher_phone_token: *const u8,
        recipient_phone_token: *const u8,
        issued_at: u64,
        expires_at: u64,
        sequence: u64,
        contact_private_key: *const u8,
        revocation_output: *mut u8,
        revocation_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(publisher), Some(recipient), Some(contact_key)) = (
                checked_input(publisher_phone_token, 32, 32, 32),
                checked_input(recipient_phone_token, 32, 32, 32),
                checked_input(contact_private_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if revocation_output.is_null() || revocation_output_len != MFW_CONTACT_REVOCATION_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let publisher = PhoneToken(publisher.try_into().expect("fixed checked input"));
            let recipient = PhoneToken(recipient.try_into().expect("fixed checked input"));
            let Ok(pair_id) = derive_pair_id(publisher, recipient) else {
                return INVALID_ARGUMENT;
            };
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let result = ContactRevocation::signed(
                pair_id,
                publisher,
                issued_at,
                expires_at,
                sequence,
                &signing_key,
            );
            let Ok(revocation) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = revocation.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), revocation_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_revoke_phone_participant_v1(
        phone_token: *const u8,
        issued_at: u64,
        expires_at: u64,
        cooldown_until: u64,
        sequence: u64,
        contact_private_key: *const u8,
        revocation_output: *mut u8,
        revocation_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(phone_token), Some(contact_key)) = (
                checked_input(phone_token, 32, 32, 32),
                checked_input(contact_private_key, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if revocation_output.is_null()
                || revocation_output_len != MFW_PARTICIPANT_REVOCATION_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let mut contact_secret: [u8; 32] = contact_key.try_into().expect("fixed checked input");
            let signing_key = ContactSigningKey::from_bytes(contact_secret);
            contact_secret.zeroize();
            let result = ParticipantRevocation::signed(
                PhoneToken(phone_token.try_into().expect("fixed checked input")),
                issued_at,
                expires_at,
                cooldown_until,
                sequence,
                &signing_key,
            );
            let Ok(revocation) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let encoded = revocation.encode();
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), revocation_output, encoded.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_combine_phone_token_v1(
        first_server_public_key: *const u8,
        first_output: *const u8,
        second_server_public_key: *const u8,
        second_output: *const u8,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(first_key), Some(first_output), Some(second_key), Some(second_output)) = (
                checked_input(first_server_public_key, 32, 32, 32),
                checked_input(first_output, 64, 64, 64),
                checked_input(second_server_public_key, 32, 32, 32),
                checked_input(second_output, 64, 64, 64),
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != 32 {
                return INVALID_ARGUMENT;
            }
            let result = combine_phone_token(
                match first_key.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                },
                match first_output.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                },
                match second_key.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                },
                match second_output.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                },
            );
            let Ok(result) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(result.0.as_ptr(), output, result.0.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_derive_pair_id_v1(
        first_phone_token: *const u8,
        second_phone_token: *const u8,
        output: *mut u8,
        output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(first), Some(second)) = (
                checked_input(first_phone_token, 32, 32, 32),
                checked_input(second_phone_token, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if output.is_null() || output_len != 32 {
                return INVALID_ARGUMENT;
            }
            let result = derive_pair_id(
                PhoneToken(match first.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                }),
                PhoneToken(match second.try_into() {
                    Ok(value) => value,
                    Err(_) => return INVALID_ARGUMENT,
                }),
            );
            let Ok(result) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(result.0.as_ptr(), output, result.0.len());
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_find_snapshot_participant_v1(
        snapshot: *const u8,
        snapshot_len: usize,
        expected_directory_public_key: *const u8,
        expected_verification_public_key: *const u8,
        now: u64,
        phone_token: *const u8,
        contact_signing_public_key_output: *mut u8,
        contact_signing_public_key_output_len: usize,
        hpke_public_key_output: *mut u8,
        hpke_public_key_output_len: usize,
        participant_expires_at_output: *mut u64,
        participant_sequence_output: *mut u64,
        snapshot_generation_output: *mut u64,
        snapshot_issued_at_output: *mut u64,
        snapshot_expires_at_output: *mut u64,
    ) -> i32 {
        catch_unwind(|| {
            let (Some(snapshot), Some(directory_key), Some(verification_key), Some(phone_token)) = (
                checked_input(snapshot, snapshot_len, 137, 256 * 1024 * 1024),
                checked_input(expected_directory_public_key, 32, 32, 32),
                checked_input(expected_verification_public_key, 32, 32, 32),
                checked_input(phone_token, 32, 32, 32),
            ) else {
                return INVALID_ARGUMENT;
            };
            if contact_signing_public_key_output.is_null()
                || contact_signing_public_key_output_len != 32
                || hpke_public_key_output.is_null()
                || hpke_public_key_output_len != 32
                || participant_expires_at_output.is_null()
                || participant_sequence_output.is_null()
                || snapshot_generation_output.is_null()
                || snapshot_issued_at_output.is_null()
                || snapshot_expires_at_output.is_null()
            {
                return INVALID_ARGUMENT;
            }
            let result = (|| {
                let snapshot = SignedDirectorySnapshot::decode(snapshot)?;
                snapshot.verify(
                    directory_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?,
                    verification_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?,
                    now,
                )?;
                let token = PhoneToken(
                    phone_token
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?,
                );
                let participant = snapshot
                    .find_participant(token)
                    .ok_or(mfw_recipient_protocol::PhoneProtocolError::UnknownRecipientKey)?;
                Ok::<_, mfw_recipient_protocol::PhoneProtocolError>((
                    participant.contact_signing_public_key,
                    participant.hpke_public_key,
                    participant.expires_at,
                    participant.sequence,
                    snapshot.generation,
                    snapshot.issued_at,
                    snapshot.expires_at,
                ))
            })();
            let Ok((
                contact_public_key,
                hpke_public_key,
                participant_expires_at,
                participant_sequence,
                snapshot_generation,
                snapshot_issued_at,
                snapshot_expires_at,
            )) = result
            else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    contact_public_key.as_ptr(),
                    contact_signing_public_key_output,
                    32,
                );
                std::ptr::copy_nonoverlapping(hpke_public_key.as_ptr(), hpke_public_key_output, 32);
                *participant_expires_at_output = participant_expires_at;
                *participant_sequence_output = participant_sequence;
                *snapshot_generation_output = snapshot_generation;
                *snapshot_issued_at_output = snapshot_issued_at;
                *snapshot_expires_at_output = snapshot_expires_at;
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_snapshot_pair_v1(
        snapshot: *const u8,
        snapshot_len: usize,
        expected_directory_public_key: *const u8,
        expected_verification_public_key: *const u8,
        now: u64,
        pair_id: *const u8,
        expected_publisher_public_key: *const u8,
        recipient_private_key: *const u8,
        recipient_public_key: *const u8,
        card_output: *mut u8,
        card_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(snapshot) = checked_input(snapshot, snapshot_len, 137, 256 * 1024 * 1024)
            else {
                return INVALID_ARGUMENT;
            };
            let (
                Some(directory_key),
                Some(verification_key),
                Some(pair_id),
                Some(publisher_key),
                Some(recipient_private),
                Some(recipient_public),
            ) = (
                checked_input(expected_directory_public_key, 32, 32, 32),
                checked_input(expected_verification_public_key, 32, 32, 32),
                checked_input(pair_id, 32, 32, 32),
                checked_input(expected_publisher_public_key, 32, 32, 32),
                checked_input(recipient_private_key, 32, 32, 32),
                checked_input(recipient_public_key, 32, 32, 32),
            )
            else {
                return INVALID_ARGUMENT;
            };
            if card_output.is_null()
                || card_output_len != mfw_recipient_protocol::phone::CONTACT_CARD_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let result =
                (|| {
                    let snapshot = SignedDirectorySnapshot::decode(snapshot)?;
                    let directory_key = directory_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                    let verification_key = verification_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                    snapshot.verify(directory_key, verification_key, now)?;
                    let pair_id =
                        PairId(pair_id.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?);
                    let publisher_key = publisher_key
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                    let recipient_private =
                        MfwHpkePrivateKey::from_bytes(recipient_private.try_into().map_err(
                            |_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength,
                        )?);
                    let recipient_public = recipient_public
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                    let entry = snapshot
                        .find_pair(pair_id)
                        .find(|entry| entry.envelope.publisher_signing_public_key == publisher_key)
                        .ok_or(mfw_recipient_protocol::PhoneProtocolError::UnauthorizedPublisher)?;
                    entry
                        .envelope
                        .open(publisher_key, &recipient_private, recipient_public, now)
                })();
            let Ok(card) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok(mut encoded) = card.encode_fixed() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), card_output, encoded.len());
            }
            encoded.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_snapshot_contact_v1(
        snapshot: *const u8,
        snapshot_len: usize,
        expected_directory_public_key: *const u8,
        expected_verification_public_key: *const u8,
        now: u64,
        pair_id: *const u8,
        publisher_phone_token: *const u8,
        recipient_private_key: *const u8,
        recipient_public_key: *const u8,
        card_output: *mut u8,
        card_output_len: usize,
    ) -> i32 {
        catch_unwind(|| {
            let Some(snapshot) = checked_input(snapshot, snapshot_len, 137, 256 * 1024 * 1024)
            else {
                return INVALID_ARGUMENT;
            };
            let (
                Some(directory_key),
                Some(verification_key),
                Some(pair_id),
                Some(publisher_token),
                Some(recipient_private),
                Some(recipient_public),
            ) = (
                checked_input(expected_directory_public_key, 32, 32, 32),
                checked_input(expected_verification_public_key, 32, 32, 32),
                checked_input(pair_id, 32, 32, 32),
                checked_input(publisher_phone_token, 32, 32, 32),
                checked_input(recipient_private_key, 32, 32, 32),
                checked_input(recipient_public_key, 32, 32, 32),
            )
            else {
                return INVALID_ARGUMENT;
            };
            if card_output.is_null()
                || card_output_len != mfw_recipient_protocol::phone::CONTACT_CARD_BYTES
            {
                return INVALID_ARGUMENT;
            }
            let result =
                (|| {
                    let snapshot = SignedDirectorySnapshot::decode(snapshot)?;
                    snapshot.verify(
                        directory_key.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?,
                        verification_key.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?,
                        now,
                    )?;
                    let pair_id =
                        PairId(pair_id.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?);
                    let publisher_token =
                        PhoneToken(publisher_token.try_into().map_err(|_| {
                            mfw_recipient_protocol::PhoneProtocolError::InvalidLength
                        })?);
                    let participant = snapshot
                        .find_participant(publisher_token)
                        .ok_or(mfw_recipient_protocol::PhoneProtocolError::UnauthorizedPublisher)?;
                    let entry = snapshot
                        .find_pair(pair_id)
                        .find(|entry| {
                            entry.envelope.publisher_token == publisher_token
                                && entry.envelope.publisher_signing_public_key
                                    == participant.contact_signing_public_key
                        })
                        .ok_or(mfw_recipient_protocol::PhoneProtocolError::UnauthorizedPublisher)?;
                    let recipient_private =
                        MfwHpkePrivateKey::from_bytes(recipient_private.try_into().map_err(
                            |_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength,
                        )?);
                    let recipient_public = recipient_public
                        .try_into()
                        .map_err(|_| mfw_recipient_protocol::PhoneProtocolError::InvalidLength)?;
                    entry.envelope.open(
                        participant.contact_signing_public_key,
                        &recipient_private,
                        recipient_public,
                        now,
                    )
                })();
            let Ok(card) = result else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let Ok(mut encoded) = card.encode_fixed() else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            unsafe {
                std::ptr::copy_nonoverlapping(encoded.as_ptr(), card_output, encoded.len());
            }
            encoded.zeroize();
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_snapshot_contact_address_v1(
        snapshot: *const u8,
        snapshot_len: usize,
        expected_directory_public_key: *const u8,
        expected_verification_public_key: *const u8,
        now: u64,
        pair_id: *const u8,
        publisher_phone_token: *const u8,
        recipient_private_key: *const u8,
        recipient_public_key: *const u8,
        policy_output: *mut u8,
        network_output: *mut u8,
        address_output: *mut u8,
        address_output_len: *mut usize,
    ) -> i32 {
        let mut issued_at = 0_u64;
        let mut expires_at = 0_u64;
        let mut sequence = 0_u64;
        unsafe {
            tex8_mfw_open_snapshot_contact_metadata_v1(
                snapshot,
                snapshot_len,
                expected_directory_public_key,
                expected_verification_public_key,
                now,
                pair_id,
                publisher_phone_token,
                recipient_private_key,
                recipient_public_key,
                policy_output,
                network_output,
                address_output,
                address_output_len,
                &mut issued_at,
                &mut expires_at,
                &mut sequence,
            )
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_mfw_open_snapshot_contact_metadata_v1(
        snapshot: *const u8,
        snapshot_len: usize,
        expected_directory_public_key: *const u8,
        expected_verification_public_key: *const u8,
        now: u64,
        pair_id: *const u8,
        publisher_phone_token: *const u8,
        recipient_private_key: *const u8,
        recipient_public_key: *const u8,
        policy_output: *mut u8,
        network_output: *mut u8,
        address_output: *mut u8,
        address_output_len: *mut usize,
        issued_at_output: *mut u64,
        expires_at_output: *mut u64,
        sequence_output: *mut u64,
    ) -> i32 {
        catch_unwind(|| {
            if policy_output.is_null()
                || network_output.is_null()
                || address_output.is_null()
                || address_output_len.is_null()
                || issued_at_output.is_null()
                || expires_at_output.is_null()
                || sequence_output.is_null()
            {
                return INVALID_ARGUMENT;
            }
            let mut encoded_card = [0_u8; mfw_recipient_protocol::phone::CONTACT_CARD_BYTES];
            let status = unsafe {
                tex8_mfw_open_snapshot_contact_v1(
                    snapshot,
                    snapshot_len,
                    expected_directory_public_key,
                    expected_verification_public_key,
                    now,
                    pair_id,
                    publisher_phone_token,
                    recipient_private_key,
                    recipient_public_key,
                    encoded_card.as_mut_ptr(),
                    encoded_card.len(),
                )
            };
            if status != OK {
                encoded_card.zeroize();
                return status;
            }
            let card = MfwContactCard::decode_fixed(&encoded_card);
            encoded_card.zeroize();
            let Ok(card) = card else {
                return PRIVATE_DIRECTORY_FAILED;
            };
            let capacity = unsafe { *address_output_len };
            let address = match card.address {
                Some(public_address) => {
                    let Ok(value) = encode_mfw_public_address(&public_address, card.network) else {
                        return PRIVATE_DIRECTORY_FAILED;
                    };
                    if value.len() != MFW_MONERO_ADDRESS_BYTES
                        || capacity < MFW_MONERO_ADDRESS_BYTES
                    {
                        unsafe { *address_output_len = MFW_MONERO_ADDRESS_BYTES };
                        return INVALID_ARGUMENT;
                    }
                    Some(value)
                }
                None => None,
            };
            unsafe {
                *policy_output = card.policy as u8;
                *network_output = card.network as u8;
                *issued_at_output = card.issued_at;
                *expires_at_output = card.expires_at;
                *sequence_output = card.sequence;
                if let Some(address) = address {
                    std::ptr::copy_nonoverlapping(address.as_ptr(), address_output, address.len());
                    *address_output_len = address.len();
                } else {
                    *address_output_len = 0;
                }
            }
            OK
        })
        .unwrap_or(PRIVATE_DIRECTORY_FAILED)
    }

    fn mfw_public_address(
        address_kind: u8,
        public_spend_key: &[u8],
        public_view_key: &[u8],
    ) -> Result<MfwPublicAddress, mfw_recipient_protocol::name::NameProtocolError> {
        let kind = match address_kind {
            0 => MfwAddressKind::Standard,
            1 => MfwAddressKind::Subaddress,
            _ => return Err(mfw_recipient_protocol::name::NameProtocolError::UnknownAddressKind),
        };
        MfwPublicAddress::new(
            kind,
            public_spend_key
                .try_into()
                .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?,
            public_view_key
                .try_into()
                .map_err(|_| mfw_recipient_protocol::name::NameProtocolError::InvalidLength)?,
        )
    }

    fn valid_variable_output(
        output: *mut u8,
        capacity: usize,
        output_len: *mut usize,
        required_capacity: usize,
    ) -> bool {
        !output.is_null() && !output_len.is_null() && capacity == required_capacity
    }

    unsafe fn copy_variable_output(bytes: &[u8], output: *mut u8, output_len: *mut usize) {
        // SAFETY: every caller validates the fixed ABI capacity and non-null
        // pointers before reaching this helper; protocol encoders guarantee
        // that `bytes` cannot exceed that capacity.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
            *output_len = bytes.len();
        }
    }

    fn checked_input<'a>(
        pointer: *const u8,
        length: usize,
        minimum: usize,
        maximum: usize,
    ) -> Option<&'a [u8]> {
        if pointer.is_null() || length < minimum || length > maximum {
            return None;
        }
        // SAFETY: exported callers must provide a readable buffer of `length`
        // bytes. Bounds are checked before constructing the borrowed slice.
        Some(unsafe { slice::from_raw_parts(pointer, length) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(now: u64) -> (SigningKeyMaterial, HpkePrivateKey, WorkerDescriptor) {
        let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let (hpke_private, hpke_public) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: now - 10,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: hpke_public,
                relay_origin: "https://relay.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        (root, hpke_private, descriptor)
    }

    #[test]
    fn signed_descriptor_is_canonical_and_rejects_tampering() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        descriptor.verify(Network::Stagenet, now).unwrap();
        let encoded = descriptor.encode().unwrap();
        assert_eq!(WorkerDescriptor::decode(&encoded).unwrap(), descriptor);

        let mut altered = encoded;
        altered[65] ^= 1;
        let altered = WorkerDescriptor::decode(&altered).unwrap();
        assert_eq!(
            altered.verify(Network::Stagenet, now),
            Err(ProtocolError::InvalidSignature)
        );
    }

    #[test]
    fn watch_envelope_is_fixed_size_and_round_trips() {
        let now = 1_800_000_000;
        let (_, hpke_private, descriptor) = fixture(now);
        let binding = WatchBinding::new(&descriptor, [4_u8; 32], 1, now - 1, now + 300).unwrap();
        let secret = WatchSecret::new("5".repeat(95), [9_u8; 32], Network::Stagenet, 123).unwrap();
        let envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now).unwrap();
        let encoded = envelope.encode();
        assert_eq!(encoded.len(), WATCH_ENVELOPE_SIZE);
        let decoded = WatchEnvelope::decode(&encoded).unwrap();
        let opened = decoded.open(&descriptor, &hpke_private, now).unwrap();
        assert_eq!(opened.address, "5".repeat(95));
        assert_eq!(opened.private_view_key, [9_u8; 32]);
        assert_eq!(opened.restore_height, 123);
    }

    #[test]
    fn altered_binding_fails_before_plaintext_is_returned() {
        let now = 1_800_000_000;
        let (_, hpke_private, descriptor) = fixture(now);
        let binding = WatchBinding::new(&descriptor, [4_u8; 32], 1, now - 1, now + 300).unwrap();
        let secret = WatchSecret::new("5".repeat(95), [9_u8; 32], Network::Stagenet, 123).unwrap();
        let mut envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now).unwrap();
        envelope.binding.assignment_epoch = 2;
        assert!(matches!(
            envelope.open(&descriptor, &hpke_private, now),
            Err(ProtocolError::Hpke)
        ));
    }

    #[test]
    fn wrong_worker_network_expiry_and_trailing_data_fail_closed() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        assert_eq!(
            descriptor.verify(Network::Mainnet, now),
            Err(ProtocolError::WrongNetwork)
        );
        assert_eq!(
            descriptor.verify(Network::Stagenet, now + 601),
            Err(ProtocolError::Expired)
        );
        let mut encoded = descriptor.encode().unwrap();
        encoded.push(0);
        assert_eq!(
            WorkerDescriptor::decode(&encoded),
            Err(ProtocolError::TrailingData)
        );
    }

    #[test]
    fn c_abi_returns_only_fixed_ciphertext_and_numeric_errors() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        let descriptor = descriptor.encode().unwrap();
        let address = "5".repeat(95);
        let mut output = [0_u8; WATCH_ENVELOPE_SIZE];
        let result = unsafe {
            ffi::tex8_fast_wallet_protocol_seal_watch_v1(
                descriptor.as_ptr(),
                descriptor.len(),
                Network::Stagenet as u8,
                [4_u8; 32].as_ptr(),
                1,
                now,
                now + 300,
                now,
                address.as_ptr(),
                address.len(),
                [9_u8; 32].as_ptr(),
                123,
                output.as_mut_ptr(),
                output.len(),
            )
        };
        assert_eq!(result, ffi::OK);
        assert_ne!(output, [0_u8; WATCH_ENVELOPE_SIZE]);
        assert_eq!(
            unsafe {
                ffi::tex8_fast_wallet_protocol_verify_descriptor_v1(
                    descriptor.as_ptr(),
                    descriptor.len(),
                    Network::Mainnet as u8,
                    now,
                )
            },
            ffi::INVALID_DESCRIPTOR
        );
    }

    #[test]
    fn c_abi_extracts_only_the_signed_verified_relay_origin() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        let expected = descriptor.relay_origin.clone();
        let encoded = descriptor.encode().unwrap();
        let mut output = [0_u8; MAX_RELAY_ORIGIN_BYTES];
        let mut output_len = output.len();
        assert_eq!(
            unsafe {
                ffi::tex8_fast_wallet_protocol_descriptor_relay_origin_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    Network::Stagenet as u8,
                    now,
                    output.as_mut_ptr(),
                    &mut output_len,
                )
            },
            ffi::OK
        );
        assert_eq!(
            std::str::from_utf8(&output[..output_len]).unwrap(),
            expected
        );
    }

    #[test]
    fn c_abi_extracts_only_the_signed_verified_worker_root() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        let expected = descriptor.worker_root_id();
        let encoded = descriptor.encode().unwrap();
        let mut output = [0_u8; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_fast_wallet_protocol_descriptor_worker_root_id_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    Network::Stagenet as u8,
                    now,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(output, expected);
        assert_eq!(
            unsafe {
                ffi::tex8_fast_wallet_protocol_descriptor_worker_root_id_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    Network::Mainnet as u8,
                    now,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::INVALID_DESCRIPTOR
        );
    }

    #[test]
    fn c_abi_private_phone_voprf_round_trip_and_fail_closed() {
        use mfw_recipient_protocol::{
            OprfBlindRequest, OprfServerKey, VOPRF_CLIENT_STATE_BYTES, VOPRF_REQUEST_BYTES,
        };

        let phone = b"+50761234567";
        let first_server = OprfServerKey::from_seed(12, &[12; 32]).unwrap();
        let second_server = OprfServerKey::from_seed(12, &[13; 32]).unwrap();
        let mut outputs = Vec::new();
        for server in [&first_server, &second_server] {
            let mut state = [0; VOPRF_CLIENT_STATE_BYTES];
            let mut request = [0; VOPRF_REQUEST_BYTES];
            assert_eq!(
                unsafe {
                    ffi::tex8_mfw_voprf_blind_v1(
                        phone.as_ptr(),
                        phone.len(),
                        12,
                        state.as_mut_ptr(),
                        state.len(),
                        request.as_mut_ptr(),
                        request.len(),
                    )
                },
                ffi::OK
            );
            let evaluation = server
                .evaluate(&OprfBlindRequest::decode(&request).unwrap())
                .unwrap()
                .encode();
            let mut output = [0; 64];
            assert_eq!(
                unsafe {
                    ffi::tex8_mfw_voprf_finalize_v1(
                        phone.as_ptr(),
                        phone.len(),
                        12,
                        state.as_ptr(),
                        state.len(),
                        evaluation.as_ptr(),
                        evaluation.len(),
                        server.public_key().as_ptr(),
                        32,
                        output.as_mut_ptr(),
                        output.len(),
                    )
                },
                ffi::OK
            );
            outputs.push(output);
        }
        let mut token = [0; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_combine_phone_token_v1(
                    first_server.public_key().as_ptr(),
                    outputs[0].as_ptr(),
                    second_server.public_key().as_ptr(),
                    outputs[1].as_ptr(),
                    token.as_mut_ptr(),
                    token.len(),
                )
            },
            ffi::OK
        );
        assert_ne!(token, [0; 32]);
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_combine_phone_token_v1(
                    first_server.public_key().as_ptr(),
                    outputs[0].as_ptr(),
                    first_server.public_key().as_ptr(),
                    outputs[0].as_ptr(),
                    token.as_mut_ptr(),
                    token.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
    }

    #[test]
    fn c_abi_private_phone_sessions_are_opaque_single_use_and_bounded() {
        use mfw_recipient_protocol::{OprfBlindRequest, OprfServerKey, VOPRF_REQUEST_BYTES};

        let phone = b"+50761234567";
        let server = OprfServerKey::from_seed(23, &[42; 32]).unwrap();
        let mut handle = [0_u8; ffi::MFW_PHONE_SESSION_HANDLE_BYTES];
        let mut request = [0_u8; VOPRF_REQUEST_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_voprf_blind_session_v1(
                    phone.as_ptr(),
                    phone.len(),
                    23,
                    handle.as_mut_ptr(),
                    handle.len(),
                    request.as_mut_ptr(),
                    request.len(),
                )
            },
            ffi::OK
        );
        assert_ne!(handle, [0; ffi::MFW_PHONE_SESSION_HANDLE_BYTES]);
        let evaluation = server
            .evaluate(&OprfBlindRequest::decode(&request).unwrap())
            .unwrap()
            .encode();
        let mut output = [0_u8; 64];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_voprf_finalize_session_v1(
                    handle.as_ptr(),
                    handle.len(),
                    evaluation.as_ptr(),
                    evaluation.len(),
                    server.public_key().as_ptr(),
                    32,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::OK
        );
        assert_ne!(output, [0; 64]);
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_voprf_finalize_session_v1(
                    handle.as_ptr(),
                    handle.len(),
                    evaluation.as_ptr(),
                    evaluation.len(),
                    server.public_key().as_ptr(),
                    32,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
        assert_eq!(
            unsafe { ffi::tex8_mfw_voprf_discard_session_v1(handle.as_ptr(), handle.len()) },
            ffi::PRIVATE_DIRECTORY_FAILED
        );

        let mut private_key = [0_u8; 32];
        let mut public_key = [0_u8; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_generate_phone_identity_v1(
                    private_key.as_mut_ptr(),
                    private_key.len(),
                    public_key.as_mut_ptr(),
                    public_key.len(),
                )
            },
            ffi::OK
        );
        assert_ne!(private_key, [0; 32]);
        assert_ne!(public_key, [0; 32]);
        assert_ne!(private_key, public_key);
        private_key.zeroize();
    }

    #[test]
    fn c_abi_private_phone_ask_round_trip_is_fixed_bound_and_fail_closed() {
        use mfw_recipient_protocol::{
            derive_hpke_key_id, generate_hpke_keypair, AskEnvelope, AskMailboxPoll, AskMessageKind,
            AskRequest, ContactSigningKey, Network as MfwNetwork, PhoneToken,
        };

        let now = 1_800_000_000;
        let requester_token = PhoneToken([70; 32]);
        let target_token = PhoneToken([71; 32]);
        let requester_signing_bytes = [72; 32];
        let target_signing_bytes = [73; 32];
        let requester_signing = ContactSigningKey::from_bytes(requester_signing_bytes);
        let target_signing = ContactSigningKey::from_bytes(target_signing_bytes);
        let (requester_hpke_private, requester_hpke_public) = generate_hpke_keypair().unwrap();
        let (target_hpke_private, target_hpke_public) = generate_hpke_keypair().unwrap();
        let requester_hpke_private = requester_hpke_private.export_bytes();
        let target_hpke_private = target_hpke_private.export_bytes();
        let mut request_id = [0_u8; 32];
        let mut request_state = [0_u8; ffi::MFW_ASK_MESSAGE_BYTES];
        let mut request_envelope = [0_u8; ffi::MFW_ASK_ENVELOPE_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_seal_phone_ask_request_v1(
                    requester_token.0.as_ptr(),
                    target_token.0.as_ptr(),
                    MfwNetwork::Mainnet as u8,
                    now,
                    now + 600,
                    1,
                    requester_signing_bytes.as_ptr(),
                    target_hpke_public.as_ptr(),
                    request_id.as_mut_ptr(),
                    request_id.len(),
                    request_state.as_mut_ptr(),
                    request_state.len(),
                    request_envelope.as_mut_ptr(),
                    request_envelope.len(),
                )
            },
            ffi::OK
        );
        assert_ne!(request_id, [0; 32]);
        assert_eq!(
            AskEnvelope::decode(&request_envelope).unwrap().request_id,
            request_id
        );
        assert_eq!(
            AskRequest::decode_fixed(&request_state).unwrap().request_id,
            request_id
        );
        let mut opened_request = [0_u8; ffi::MFW_ASK_MESSAGE_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_open_phone_ask_request_v1(
                    request_envelope.as_ptr(),
                    request_envelope.len(),
                    requester_signing.public_key().as_ptr(),
                    target_hpke_private.as_ptr(),
                    target_hpke_public.as_ptr(),
                    now + 1,
                    opened_request.as_mut_ptr(),
                    opened_request.len(),
                )
            },
            ffi::OK
        );
        let request = AskRequest::decode_fixed(&opened_request).unwrap();
        assert_eq!(request.request_id, request_id);
        assert_eq!(request.requester_token, requester_token);
        assert_eq!(request.target_token, target_token);

        let mut poll = [0_u8; ffi::MFW_ASK_MAILBOX_POLL_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_sign_phone_ask_mailbox_poll_v1(
                    AskMessageKind::Request as u8,
                    target_token.0.as_ptr(),
                    9,
                    target_hpke_public.as_ptr(),
                    12,
                    now,
                    now + 120,
                    target_signing_bytes.as_ptr(),
                    poll.as_mut_ptr(),
                    poll.len(),
                )
            },
            ffi::OK
        );
        AskMailboxPoll::decode(&poll)
            .unwrap()
            .verify(
                9,
                target_signing.public_key(),
                derive_hpke_key_id(target_hpke_public).unwrap(),
                now + 1,
            )
            .unwrap();

        let mut response_envelope = [0_u8; ffi::MFW_ASK_ENVELOPE_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_seal_phone_ask_response_v1(
                    opened_request.as_ptr(),
                    opened_request.len(),
                    1,
                    now + 2,
                    now + 500,
                    1,
                    0,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    target_signing_bytes.as_ptr(),
                    requester_hpke_public.as_ptr(),
                    response_envelope.as_mut_ptr(),
                    response_envelope.len(),
                )
            },
            ffi::OK
        );
        let mut decision = 0_u8;
        let mut network = u8::MAX;
        let mut address = [0_u8; ffi::MFW_MONERO_ADDRESS_BYTES];
        let mut address_len = address.len();
        let mut issued_at = 0_u64;
        let mut expires_at = 0_u64;
        let mut sequence = 0_u64;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_open_phone_ask_response_v1(
                    response_envelope.as_ptr(),
                    response_envelope.len(),
                    target_signing.public_key().as_ptr(),
                    requester_hpke_private.as_ptr(),
                    requester_hpke_public.as_ptr(),
                    now + 3,
                    opened_request.as_ptr(),
                    opened_request.len(),
                    &mut decision,
                    &mut network,
                    address.as_mut_ptr(),
                    &mut address_len,
                    &mut issued_at,
                    &mut expires_at,
                    &mut sequence,
                )
            },
            ffi::OK
        );
        assert_eq!((decision, network, address_len), (1, 0, 0));
        assert_eq!((issued_at, expires_at, sequence), (now + 2, now + 500, 1));

        response_envelope[300] ^= 1;
        address_len = address.len();
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_open_phone_ask_response_v1(
                    response_envelope.as_ptr(),
                    response_envelope.len(),
                    target_signing.public_key().as_ptr(),
                    requester_hpke_private.as_ptr(),
                    requester_hpke_public.as_ptr(),
                    now + 3,
                    opened_request.as_ptr(),
                    opened_request.len(),
                    &mut decision,
                    &mut network,
                    address.as_mut_ptr(),
                    &mut address_len,
                    &mut issued_at,
                    &mut expires_at,
                    &mut sequence,
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
    }

    #[test]
    fn c_abi_private_phone_contact_preserves_authenticated_freshness_metadata() {
        use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
        use mfw_recipient_protocol::{
            derive_pair_id, generate_hpke_keypair, AddressKind, ContactCard, ContactEnvelope,
            ContactPolicy, ContactSigningKey, DirectoryEntry, Network as MfwNetwork,
            ParticipantRecord, PhoneToken, PublicAddress, SignedDirectorySnapshot,
        };

        let now = 1_500;
        let verification = ContactSigningKey::from_bytes([21; 32]);
        let directory = ContactSigningKey::from_bytes([22; 32]);
        let publisher = ContactSigningKey::from_bytes([23; 32]);
        let recipient = ContactSigningKey::from_bytes([24; 32]);
        let (_, publisher_hpke) = generate_hpke_keypair().unwrap();
        let (recipient_private, recipient_hpke) = generate_hpke_keypair().unwrap();
        let publisher_token = PhoneToken([31; 32]);
        let recipient_token = PhoneToken([32; 32]);
        let participants = vec![
            ParticipantRecord::authorized(
                7,
                publisher_token,
                publisher.public_key(),
                publisher_hpke,
                1_000,
                2_000,
                4,
                &verification,
            )
            .unwrap(),
            ParticipantRecord::authorized(
                7,
                recipient_token,
                recipient.public_key(),
                recipient_hpke,
                1_000,
                2_000,
                5,
                &verification,
            )
            .unwrap(),
        ];
        let address = PublicAddress::new(
            AddressKind::Subaddress,
            (Scalar::from(41_u64) * ED25519_BASEPOINT_POINT)
                .compress()
                .to_bytes(),
            (Scalar::from(42_u64) * ED25519_BASEPOINT_POINT)
                .compress()
                .to_bytes(),
        )
        .unwrap();
        let card = ContactCard {
            policy: ContactPolicy::DirectReceiveAddress,
            network: MfwNetwork::Mainnet,
            issued_at: 1_100,
            expires_at: 1_900,
            sequence: 17,
            publisher_token,
            recipient_token,
            address: Some(address),
        };
        let envelope = ContactEnvelope::seal(&card, &publisher, recipient_hpke).unwrap();
        let snapshot = SignedDirectorySnapshot::signed(
            9,
            1_000,
            2_000,
            participants,
            vec![DirectoryEntry { envelope }],
            &directory,
        )
        .unwrap()
        .encode()
        .unwrap();
        let pair_id = derive_pair_id(publisher_token, recipient_token).unwrap();
        let private_key = recipient_private.export_bytes();
        let mut participant_contact_key = [0_u8; 32];
        let mut participant_hpke_key = [0_u8; 32];
        let mut participant_expires_at = 0_u64;
        let mut participant_sequence = 0_u64;
        let mut snapshot_generation = 0_u64;
        let mut snapshot_issued_at = 0_u64;
        let mut snapshot_expires_at = 0_u64;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_find_snapshot_participant_v1(
                    snapshot.as_ptr(),
                    snapshot.len(),
                    directory.public_key().as_ptr(),
                    verification.public_key().as_ptr(),
                    now,
                    publisher_token.0.as_ptr(),
                    participant_contact_key.as_mut_ptr(),
                    participant_contact_key.len(),
                    participant_hpke_key.as_mut_ptr(),
                    participant_hpke_key.len(),
                    &mut participant_expires_at,
                    &mut participant_sequence,
                    &mut snapshot_generation,
                    &mut snapshot_issued_at,
                    &mut snapshot_expires_at,
                )
            },
            ffi::OK
        );
        assert_eq!(participant_contact_key, publisher.public_key());
        assert_eq!(participant_hpke_key, publisher_hpke);
        assert_eq!((participant_expires_at, participant_sequence), (2_000, 4));
        assert_eq!(
            (snapshot_generation, snapshot_issued_at, snapshot_expires_at,),
            (9, 1_000, 2_000)
        );
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_find_snapshot_participant_v1(
                    snapshot.as_ptr(),
                    snapshot.len(),
                    directory.public_key().as_ptr(),
                    verification.public_key().as_ptr(),
                    now,
                    [99_u8; 32].as_ptr(),
                    participant_contact_key.as_mut_ptr(),
                    participant_contact_key.len(),
                    participant_hpke_key.as_mut_ptr(),
                    participant_hpke_key.len(),
                    &mut participant_expires_at,
                    &mut participant_sequence,
                    &mut snapshot_generation,
                    &mut snapshot_issued_at,
                    &mut snapshot_expires_at,
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
        let mut policy = 0_u8;
        let mut network = u8::MAX;
        let mut output = [0_u8; ffi::MFW_MONERO_ADDRESS_BYTES];
        let mut output_len = output.len();
        let mut issued_at = 0_u64;
        let mut expires_at = 0_u64;
        let mut sequence = 0_u64;

        assert_eq!(
            unsafe {
                ffi::tex8_mfw_open_snapshot_contact_metadata_v1(
                    snapshot.as_ptr(),
                    snapshot.len(),
                    directory.public_key().as_ptr(),
                    verification.public_key().as_ptr(),
                    now,
                    pair_id.0.as_ptr(),
                    publisher_token.0.as_ptr(),
                    private_key.as_ptr(),
                    recipient_hpke.as_ptr(),
                    &mut policy,
                    &mut network,
                    output.as_mut_ptr(),
                    &mut output_len,
                    &mut issued_at,
                    &mut expires_at,
                    &mut sequence,
                )
            },
            ffi::OK
        );
        assert_eq!(policy, ContactPolicy::DirectReceiveAddress as u8);
        assert_eq!(network, MfwNetwork::Mainnet as u8);
        assert_eq!(output_len, ffi::MFW_MONERO_ADDRESS_BYTES);
        assert_eq!((issued_at, expires_at, sequence), (1_100, 1_900, 17));
    }

    #[test]
    fn c_abi_phone_registration_publication_and_revocation_are_bound() {
        use mfw_recipient_protocol::{
            generate_hpke_keypair, ContactEnvelope, ContactRevocation, ContactSigningKey,
            Network as MfwNetwork, ParticipantRecord, ParticipantRevocation, PermitRefreshRequest,
            PhoneToken,
        };

        let mut contact_private = [0; 32];
        let mut contact_public = [0; 32];
        let mut hpke_private = [0; 32];
        let mut hpke_public = [0; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_generate_phone_registration_identity_v1(
                    contact_private.as_mut_ptr(),
                    contact_private.len(),
                    contact_public.as_mut_ptr(),
                    contact_public.len(),
                    hpke_private.as_mut_ptr(),
                    hpke_private.len(),
                    hpke_public.as_mut_ptr(),
                    hpke_public.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(
            ContactSigningKey::from_bytes(contact_private).public_key(),
            contact_public
        );

        let verification = ContactSigningKey::from_bytes([101; 32]);
        let publisher_token = PhoneToken([102; 32]);
        let recipient_token = PhoneToken([103; 32]);
        let participant = ParticipantRecord::authorized(
            11,
            publisher_token,
            contact_public,
            hpke_public,
            1_000,
            2_000,
            7,
            &verification,
        )
        .unwrap()
        .encode();
        let mut verified_token = [0; 32];
        let mut verified_expiry = 0;
        let mut verified_sequence = 0;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_phone_participant_v1(
                    participant.as_ptr(),
                    participant.len(),
                    verification.public_key().as_ptr(),
                    32,
                    11,
                    contact_public.as_ptr(),
                    32,
                    hpke_public.as_ptr(),
                    32,
                    1_500,
                    verified_token.as_mut_ptr(),
                    verified_token.len(),
                    &mut verified_expiry,
                    &mut verified_sequence,
                )
            },
            ffi::OK
        );
        assert_eq!(verified_token, publisher_token.0);
        assert_eq!((verified_expiry, verified_sequence), (2_000, 7));
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_phone_participant_v1(
                    participant.as_ptr(),
                    participant.len(),
                    [104; 32].as_ptr(),
                    32,
                    11,
                    contact_public.as_ptr(),
                    32,
                    hpke_public.as_ptr(),
                    32,
                    1_500,
                    verified_token.as_mut_ptr(),
                    verified_token.len(),
                    &mut verified_expiry,
                    &mut verified_sequence,
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );

        let mut refresh_request = [0; ffi::MFW_PERMIT_REFRESH_REQUEST_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_sign_phone_permit_refresh_v1(
                    11,
                    publisher_token.0.as_ptr(),
                    7,
                    1_400,
                    1_700,
                    contact_private.as_ptr(),
                    refresh_request.as_mut_ptr(),
                    refresh_request.len(),
                )
            },
            ffi::OK
        );
        PermitRefreshRequest::decode(&refresh_request)
            .and_then(|request| request.verify(11, 7, contact_public, 1_500))
            .unwrap();

        let (recipient_private, recipient_public) = generate_hpke_keypair().unwrap();
        let mut envelope = [0; ffi::MFW_CONTACT_ENVELOPE_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_seal_phone_contact_v1(
                    publisher_token.0.as_ptr(),
                    recipient_token.0.as_ptr(),
                    2,
                    MfwNetwork::Mainnet as u8,
                    1_100,
                    1_900,
                    8,
                    0,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    contact_private.as_ptr(),
                    recipient_public.as_ptr(),
                    envelope.as_mut_ptr(),
                    envelope.len(),
                )
            },
            ffi::OK
        );
        let envelope = ContactEnvelope::decode(&envelope).unwrap();
        let opened = envelope
            .open(contact_public, &recipient_private, recipient_public, 1_500)
            .unwrap();
        assert_eq!(opened.publisher_token, publisher_token);
        assert_eq!(opened.recipient_token, recipient_token);
        assert_eq!(opened.sequence, 8);
        assert!(opened.address.is_none());

        let mut contact_revocation = [0; ffi::MFW_CONTACT_REVOCATION_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_revoke_phone_contact_v1(
                    publisher_token.0.as_ptr(),
                    recipient_token.0.as_ptr(),
                    1_200,
                    1_800,
                    9,
                    contact_private.as_ptr(),
                    contact_revocation.as_mut_ptr(),
                    contact_revocation.len(),
                )
            },
            ffi::OK
        );
        ContactRevocation::decode(&contact_revocation)
            .unwrap()
            .verify(contact_public, 1_500)
            .unwrap();

        let mut participant_revocation = [0; ffi::MFW_PARTICIPANT_REVOCATION_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_revoke_phone_participant_v1(
                    publisher_token.0.as_ptr(),
                    1_200,
                    1_800,
                    1_600,
                    10,
                    contact_private.as_ptr(),
                    participant_revocation.as_mut_ptr(),
                    participant_revocation.len(),
                )
            },
            ffi::OK
        );
        ParticipantRevocation::decode(&participant_revocation)
            .unwrap()
            .verify(contact_public, 1_500)
            .unwrap();

        assert_ne!(hpke_private, [0; 32]);
    }

    #[test]
    fn c_abi_name_record_verifies_signature_name_network_and_output() {
        use mfw_recipient_protocol::{
            AddressKind as MfwAddressKind, CanonicalName, NameRecord, NameSigningKey,
            Network as MfwNetwork, PublicAddress,
        };

        // Published monero-oxide standard-address vector. Keeping the
        // expected Base58 string literal makes this an independent ABI vector
        // instead of comparing the encoder with itself.
        let public_spend_key: [u8; 32] =
            hex::decode("f8631661f6ab4e6fda310c797330d86e23a682f20d5bc8cc27b18051191f16d7")
                .unwrap()
                .try_into()
                .unwrap();
        let public_view_key: [u8; 32] =
            hex::decode("4a1535063ad1fee2dabbf909d4fd9a873e29541b401f0944754e17c9a41820ce")
                .unwrap()
                .try_into()
                .unwrap();
        let owner = NameSigningKey::from_bytes([42; 32]);
        let name = CanonicalName::parse("alice.mfw").unwrap();
        let address =
            PublicAddress::new(MfwAddressKind::Standard, public_spend_key, public_view_key)
                .unwrap();
        let record =
            NameRecord::signed_claim(MfwNetwork::Mainnet, name, address, [9; 16], &owner).unwrap();
        let encoded = record.encode().unwrap();
        let mut output = [0; ffi::MFW_NAME_RESOLUTION_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_name_record_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    b"ALICE.MFW".as_ptr(),
                    b"ALICE.MFW".len(),
                    MfwNetwork::Mainnet as u8,
                    owner.public_key().as_ptr(),
                    32,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(output[0], MfwAddressKind::Standard as u8);
        assert_eq!(&output[1..33], &public_spend_key);
        assert_eq!(&output[33..65], &public_view_key);
        assert_eq!(&output[65..97], &owner.public_key());
        assert_eq!(u32::from_be_bytes(output[97..101].try_into().unwrap()), 0);

        let mut encoded_address = [0; ffi::MFW_MONERO_ADDRESS_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_and_encode_name_address_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    b"ALICE.MFW".as_ptr(),
                    b"ALICE.MFW".len(),
                    MfwNetwork::Mainnet as u8,
                    owner.public_key().as_ptr(),
                    32,
                    encoded_address.as_mut_ptr(),
                    encoded_address.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(
            std::str::from_utf8(&encoded_address).unwrap(),
            "4B33mFPMq6mKi7Eiyd5XuyKRVMGVZz1Rqb9ZTyGApXW5d1aT7UBDZ89ewmnWFkzJ5wPd2SFbn313vCT8a4E2Qf4KQH4pNey"
        );
        let mut decoded_kind = u8::MAX;
        let mut decoded_spend = [0_u8; 32];
        let mut decoded_view = [0_u8; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_decode_monero_address_v1(
                    encoded_address.as_ptr(),
                    encoded_address.len(),
                    MfwNetwork::Mainnet as u8,
                    &mut decoded_kind,
                    decoded_spend.as_mut_ptr(),
                    decoded_spend.len(),
                    decoded_view.as_mut_ptr(),
                    decoded_view.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(decoded_kind, MfwAddressKind::Standard as u8);
        assert_eq!(decoded_spend, public_spend_key);
        assert_eq!(decoded_view, public_view_key);
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_decode_monero_address_v1(
                    encoded_address.as_ptr(),
                    encoded_address.len(),
                    MfwNetwork::Stagenet as u8,
                    &mut decoded_kind,
                    decoded_spend.as_mut_ptr(),
                    decoded_spend.len(),
                    decoded_view.as_mut_ptr(),
                    decoded_view.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_and_encode_name_address_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Stagenet as u8,
                    owner.public_key().as_ptr(),
                    32,
                    encoded_address.as_mut_ptr(),
                    encoded_address.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );

        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_name_record_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    b"bob.mfw".as_ptr(),
                    b"bob.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    owner.public_key().as_ptr(),
                    32,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_verify_name_record_v1(
                    encoded.as_ptr(),
                    encoded.len(),
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Stagenet as u8,
                    owner.public_key().as_ptr(),
                    32,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
    }

    #[test]
    fn c_abi_name_registration_round_trip_is_resumable_and_transition_bound() {
        use mfw_recipient_protocol::{
            extract_mfw_payloads, CommitRecord, NameOperation, NameRecord, NameSigningKey,
            Network as MfwNetwork,
        };

        let public_spend_key: [u8; 32] =
            hex::decode("f8631661f6ab4e6fda310c797330d86e23a682f20d5bc8cc27b18051191f16d7")
                .unwrap()
                .try_into()
                .unwrap();
        let public_view_key: [u8; 32] =
            hex::decode("4a1535063ad1fee2dabbf909d4fd9a873e29541b401f0944754e17c9a41820ce")
                .unwrap()
                .try_into()
                .unwrap();
        let mut owner_private_key = [0_u8; ffi::MFW_NAME_OWNER_KEY_BYTES];
        let mut owner_public_key = [0_u8; ffi::MFW_NAME_OWNER_KEY_BYTES];
        let mut salt = [0_u8; ffi::MFW_NAME_COMMIT_SALT_BYTES];
        let mut commit_extra = [0_u8; ffi::MFW_NAME_EXTRA_MAX_BYTES];
        let mut commit_extra_len = 0;
        let mut claim_record = [0_u8; ffi::MFW_NAME_RECORD_MAX_BYTES];
        let mut claim_record_len = 0;
        let mut claim_extra = [0_u8; ffi::MFW_NAME_EXTRA_MAX_BYTES];
        let mut claim_extra_len = 0;

        assert_eq!(
            unsafe {
                ffi::tex8_mfw_generate_name_registration_v1(
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    0,
                    public_spend_key.as_ptr(),
                    public_spend_key.len(),
                    public_view_key.as_ptr(),
                    public_view_key.len(),
                    owner_private_key.as_mut_ptr(),
                    owner_private_key.len(),
                    owner_public_key.as_mut_ptr(),
                    owner_public_key.len(),
                    salt.as_mut_ptr(),
                    salt.len(),
                    commit_extra.as_mut_ptr(),
                    commit_extra.len(),
                    &mut commit_extra_len,
                    claim_record.as_mut_ptr(),
                    claim_record.len(),
                    &mut claim_record_len,
                    claim_extra.as_mut_ptr(),
                    claim_extra.len(),
                    &mut claim_extra_len,
                )
            },
            ffi::OK
        );
        assert_ne!(owner_private_key, [0; 32]);
        assert_ne!(salt, [0; 16]);
        assert_eq!(
            NameSigningKey::from_bytes(owner_private_key).public_key(),
            owner_public_key
        );

        let passphrase = b"correct horse battery staple";
        let mut recovery = [0_u8; ffi::MFW_NAME_RECOVERY_MAX_BYTES];
        let mut recovery_len = 0;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_export_name_recovery_v1(
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    owner_private_key.as_ptr(),
                    owner_private_key.len(),
                    passphrase.as_ptr(),
                    passphrase.len(),
                    recovery.as_mut_ptr(),
                    recovery.len(),
                    &mut recovery_len,
                )
            },
            ffi::OK
        );
        let mut recovered_private_key = [0_u8; ffi::MFW_NAME_OWNER_KEY_BYTES];
        let mut recovered_public_key = [0_u8; ffi::MFW_NAME_OWNER_KEY_BYTES];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_import_name_recovery_v1(
                    recovery.as_ptr(),
                    recovery_len,
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    passphrase.as_ptr(),
                    passphrase.len(),
                    recovered_private_key.as_mut_ptr(),
                    recovered_private_key.len(),
                    recovered_public_key.as_mut_ptr(),
                    recovered_public_key.len(),
                )
            },
            ffi::OK
        );
        assert_eq!(recovered_private_key, owner_private_key);
        assert_eq!(recovered_public_key, owner_public_key);
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_import_name_recovery_v1(
                    recovery.as_ptr(),
                    recovery_len,
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    b"this passphrase is wrong".as_ptr(),
                    b"this passphrase is wrong".len(),
                    recovered_private_key.as_mut_ptr(),
                    recovered_private_key.len(),
                    recovered_public_key.as_mut_ptr(),
                    recovered_public_key.len(),
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );

        let commit_payloads = extract_mfw_payloads(&commit_extra[..commit_extra_len]).unwrap();
        let claim_payloads = extract_mfw_payloads(&claim_extra[..claim_extra_len]).unwrap();
        assert_eq!(commit_payloads.len(), 1);
        assert_eq!(claim_payloads.len(), 1);
        let commit = CommitRecord::decode(&commit_payloads[0]).unwrap();
        let claim = NameRecord::decode(&claim_record[..claim_record_len]).unwrap();
        assert_eq!(claim_payloads[0], &claim_record[..claim_record_len]);
        assert_eq!(claim.operation, NameOperation::Claim);
        assert_eq!(claim.claim_commitment(MfwNetwork::Mainnet).unwrap(), commit);
        claim.verify_claim(MfwNetwork::Mainnet).unwrap();

        let mut resumed_owner_public_key = [0_u8; ffi::MFW_NAME_OWNER_KEY_BYTES];
        let mut resumed_record = [0_u8; ffi::MFW_NAME_RECORD_MAX_BYTES];
        let mut resumed_record_len = 0;
        let mut resumed_extra = [0_u8; ffi::MFW_NAME_EXTRA_MAX_BYTES];
        let mut resumed_extra_len = 0;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_prepare_name_claim_v1(
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    0,
                    public_spend_key.as_ptr(),
                    public_spend_key.len(),
                    public_view_key.as_ptr(),
                    public_view_key.len(),
                    owner_private_key.as_ptr(),
                    owner_private_key.len(),
                    salt.as_ptr(),
                    salt.len(),
                    resumed_owner_public_key.as_mut_ptr(),
                    resumed_owner_public_key.len(),
                    resumed_record.as_mut_ptr(),
                    resumed_record.len(),
                    &mut resumed_record_len,
                    resumed_extra.as_mut_ptr(),
                    resumed_extra.len(),
                    &mut resumed_extra_len,
                )
            },
            ffi::OK
        );
        assert_eq!(resumed_owner_public_key, owner_public_key);
        assert_eq!(
            &resumed_record[..resumed_record_len],
            &claim_record[..claim_record_len]
        );
        assert_eq!(
            &resumed_extra[..resumed_extra_len],
            &claim_extra[..claim_extra_len]
        );

        let mut renew_record = [0_u8; ffi::MFW_NAME_RECORD_MAX_BYTES];
        let mut renew_record_len = 0;
        let mut renew_extra = [0_u8; ffi::MFW_NAME_EXTRA_MAX_BYTES];
        let mut renew_extra_len = 0;
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_prepare_name_transition_v1(
                    NameOperation::Renew as u8,
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    0,
                    public_spend_key.as_ptr(),
                    public_spend_key.len(),
                    public_view_key.as_ptr(),
                    public_view_key.len(),
                    owner_private_key.as_ptr(),
                    owner_private_key.len(),
                    claim_record.as_ptr(),
                    claim_record_len,
                    owner_public_key.as_ptr(),
                    owner_public_key.len(),
                    renew_record.as_mut_ptr(),
                    renew_record.len(),
                    &mut renew_record_len,
                    renew_extra.as_mut_ptr(),
                    renew_extra.len(),
                    &mut renew_extra_len,
                )
            },
            ffi::OK
        );
        let renew = NameRecord::decode(&renew_record[..renew_record_len]).unwrap();
        assert_eq!(renew.operation, NameOperation::Renew);
        assert_eq!(renew.sequence, 1);
        renew
            .verify_transition(MfwNetwork::Mainnet, &claim)
            .unwrap();
        assert_eq!(
            extract_mfw_payloads(&renew_extra[..renew_extra_len]).unwrap()[0],
            &renew_record[..renew_record_len]
        );

        // RENEW cannot silently redirect the name, and every transition must
        // authenticate its resolver-supplied predecessor signer.
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_prepare_name_transition_v1(
                    NameOperation::Renew as u8,
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    0,
                    public_view_key.as_ptr(),
                    public_view_key.len(),
                    public_spend_key.as_ptr(),
                    public_spend_key.len(),
                    owner_private_key.as_ptr(),
                    owner_private_key.len(),
                    claim_record.as_ptr(),
                    claim_record_len,
                    owner_public_key.as_ptr(),
                    owner_public_key.len(),
                    renew_record.as_mut_ptr(),
                    renew_record.len(),
                    &mut renew_record_len,
                    renew_extra.as_mut_ptr(),
                    renew_extra.len(),
                    &mut renew_extra_len,
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
        let wrong_signer = [9_u8; 32];
        assert_eq!(
            unsafe {
                ffi::tex8_mfw_prepare_name_transition_v1(
                    NameOperation::Renew as u8,
                    b"alice.mfw".as_ptr(),
                    b"alice.mfw".len(),
                    MfwNetwork::Mainnet as u8,
                    0,
                    public_spend_key.as_ptr(),
                    public_spend_key.len(),
                    public_view_key.as_ptr(),
                    public_view_key.len(),
                    owner_private_key.as_ptr(),
                    owner_private_key.len(),
                    claim_record.as_ptr(),
                    claim_record_len,
                    wrong_signer.as_ptr(),
                    wrong_signer.len(),
                    renew_record.as_mut_ptr(),
                    renew_record.len(),
                    &mut renew_record_len,
                    renew_extra.as_mut_ptr(),
                    renew_extra.len(),
                    &mut renew_extra_len,
                )
            },
            ffi::PRIVATE_DIRECTORY_FAILED
        );
    }

    #[test]
    fn published_worker_descriptor_vector_is_byte_identical() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../test-vectors/worker-descriptor-v1.json"))
                .unwrap();
        let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: 1_800_000_000,
                expires_at: 1_800_003_600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: [9_u8; 32],
                relay_origin: "https://relay.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        assert_eq!(
            hex::encode(descriptor.encode().unwrap()),
            vector["descriptor_hex"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(descriptor.worker_root_id()),
            vector["worker_root_id_hex"].as_str().unwrap()
        );
    }

    #[test]
    fn worker_request_auth_binds_purpose_body_worker_and_expiry() {
        let now = 1_800_000_000;
        let (_, _, descriptor) = fixture(now);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let auth = WorkerRequestAuth::sign(
            &descriptor,
            &online,
            WorkerAuthPurpose::Pull,
            b"mailbox cursor 7",
            now - 1,
            now + 30,
        )
        .unwrap();
        auth.verify(
            &descriptor,
            WorkerAuthPurpose::Pull,
            b"mailbox cursor 7",
            now,
        )
        .unwrap();
        let decoded = WorkerRequestAuth::decode(&auth.encode()).unwrap();
        assert_eq!(decoded, auth);
        assert_eq!(
            auth.verify(
                &descriptor,
                WorkerAuthPurpose::Ack,
                b"mailbox cursor 7",
                now
            ),
            Err(ProtocolError::WrongPurpose)
        );
        assert_eq!(
            auth.verify(
                &descriptor,
                WorkerAuthPurpose::Pull,
                b"mailbox cursor 8",
                now
            ),
            Err(ProtocolError::InvalidBodyHash)
        );
        assert_eq!(
            auth.verify(
                &descriptor,
                WorkerAuthPurpose::Pull,
                b"mailbox cursor 7",
                now + 31
            ),
            Err(ProtocolError::Expired)
        );
    }
}
