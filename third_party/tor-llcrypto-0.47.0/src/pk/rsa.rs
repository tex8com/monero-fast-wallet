//! Re-exporting RSA implementations.
//!
//! This module can currently handle public keys and signature
//! verification used in the Tor directory protocol and
//! similar places.
//!
//! Currently, that means validating PKCSv1 signatures, and encoding
//! and decoding RSA public keys from DER.
//!
//! # Limitations:
//!
//! Currently missing are support for signing and RSA-OEAP.  In Tor,
//! RSA signing is only needed for relays and authorities, and
//! RSA-OAEP padding is only needed for the (obsolete) TAP protocol.
//!
//! The MFW client fork uses OpenSSL public-only verification and deliberately
//! does not expose RSA private-key generation or signing APIs.
use std::fmt;
use subtle::{Choice, ConstantTimeEq};

#[cfg(feature = "memquota-memcost")]
use {derive_deftly::Deftly, tor_memquota_cost::derive_deftly_template_HasMemoryCost};

use crate::util::ct::CtByteArray;

/// How many bytes are in an "RSA ID"?  (This is a legacy tor
/// concept, and refers to identifying a relay by a SHA1 digest
/// of its RSA public identity key.)
pub const RSA_ID_LEN: usize = 20;

/// An identifier for an RSA key, based on SHA1 and DER.
///
/// These are used (for legacy purposes) all over the Tor protocol.
///
/// This object is an "identity" in the sense that it identifies (up to) one RSA
/// key.  It may also represent the identity for a particular entity, such as a
/// relay or a directory authority.
///
/// Note that for modern purposes, you should almost always identify a relay by
/// its [`Ed25519Identity`](crate::pk::ed25519::Ed25519Identity) instead of by
/// this kind of identity key.
#[derive(Clone, Copy, Hash, Ord, PartialOrd, Eq, PartialEq)]
#[cfg_attr(
    feature = "memquota-memcost",
    derive(Deftly),
    derive_deftly(HasMemoryCost)
)]
pub struct RsaIdentity {
    /// SHA1 digest of a DER encoded public key.
    id: CtByteArray<RSA_ID_LEN>,
}

impl ConstantTimeEq for RsaIdentity {
    fn ct_eq(&self, other: &Self) -> Choice {
        self.id.ct_eq(&other.id)
    }
}

impl fmt::Display for RsaIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${}", hex::encode(&self.id.as_ref()[..]))
    }
}
impl fmt::Debug for RsaIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RsaIdentity {{ {} }}", self)
    }
}

impl safelog::Redactable for RsaIdentity {
    /// Warning: This displays 16 bits of the RSA identity, which is
    /// enough to narrow down a public relay by a great deal.
    fn display_redacted(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "${}…", hex::encode(&self.id.as_ref()[..1]))
    }

    fn debug_redacted(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RsaIdentity {{ {} }}", self.redacted())
    }
}

impl serde::Serialize for RsaIdentity {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if serializer.is_human_readable() {
            serializer.serialize_str(&hex::encode(&self.id.as_ref()[..]))
        } else {
            serializer.serialize_bytes(&self.id.as_ref()[..])
        }
    }
}

impl<'de> serde::Deserialize<'de> for RsaIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if deserializer.is_human_readable() {
            /// Deserialization helper
            struct RsaIdentityVisitor;
            impl<'de> serde::de::Visitor<'de> for RsaIdentityVisitor {
                type Value = RsaIdentity;
                fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> fmt::Result {
                    fmt.write_str("hex-encoded RSA identity")
                }
                fn visit_str<E>(self, s: &str) -> Result<Self::Value, E>
                where
                    E: serde::de::Error,
                {
                    RsaIdentity::from_hex(s)
                        .ok_or_else(|| E::custom("wrong encoding for RSA identity"))
                }
            }

            deserializer.deserialize_str(RsaIdentityVisitor)
        } else {
            /// Deserialization helper
            struct RsaIdentityVisitor;
            impl<'de> serde::de::Visitor<'de> for RsaIdentityVisitor {
                type Value = RsaIdentity;
                fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> fmt::Result {
                    fmt.write_str("RSA identity")
                }
                fn visit_bytes<E>(self, bytes: &[u8]) -> Result<Self::Value, E>
                where
                    E: serde::de::Error,
                {
                    RsaIdentity::from_bytes(bytes)
                        .ok_or_else(|| E::custom("wrong length for RSA identity"))
                }
            }
            deserializer.deserialize_bytes(RsaIdentityVisitor)
        }
    }
}

impl RsaIdentity {
    /// Expose an RsaIdentity as a slice of bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.id.as_ref()[..]
    }

    /// Expose an RsaIdentity as a byte array.
    pub fn to_bytes(&self) -> [u8; 20] {
        self.id.into()
    }

    /// Expose an RsaIdentity as an uppercase hexadecimal string.
    pub fn as_hex_upper(&self) -> String {
        hex::encode_upper(self.as_bytes())
    }

    /// Construct an RsaIdentity from a slice of bytes.
    ///
    /// Returns None if the input is not of the correct length.
    ///
    /// ```
    /// use tor_llcrypto::pk::rsa::RsaIdentity;
    ///
    /// let bytes = b"xyzzyxyzzyxyzzyxyzzy";
    /// let id = RsaIdentity::from_bytes(bytes);
    /// assert_eq!(id.unwrap().as_bytes(), bytes);
    ///
    /// let truncated = b"xyzzy";
    /// let id = RsaIdentity::from_bytes(truncated);
    /// assert_eq!(id, None);
    /// ```
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        Some(RsaIdentity {
            id: CtByteArray::from(<[u8; RSA_ID_LEN]>::try_from(bytes).ok()?),
        })
    }
    /// Decode an `RsaIdentity` from a hexadecimal string.
    ///
    /// The string must have no spaces, or any extra characters.
    pub fn from_hex(s: &str) -> Option<Self> {
        let mut array = [0_u8; 20];
        match hex::decode_to_slice(s, &mut array) {
            Err(_) => None,
            Ok(()) => Some(RsaIdentity::from(array)),
        }
    }

    /// Return true if this `RsaIdentity` is composed entirely of zero-valued
    /// bytes.
    ///
    /// Such all-zero values should not be used internally, since they are not
    /// the ID of any valid key.  Instead, they are used in some places in the
    /// Tor protocols.
    pub fn is_zero(&self) -> bool {
        // We do a constant-time comparison to avoid side-channels.
        self.id.ct_eq(&[0; RSA_ID_LEN].into()).into()
    }
}

impl From<[u8; 20]> for RsaIdentity {
    fn from(id: [u8; 20]) -> RsaIdentity {
        RsaIdentity { id: id.into() }
    }
}

/// An RSA public key used only to verify legacy Tor signatures.
///
/// Private RSA operations deliberately do not exist in the MFW client fork.
/// PKCS#1 DER is retained to preserve Tor relay fingerprints and value equality.
#[derive(Clone, Debug)]
pub struct PublicKey {
    /// OpenSSL key containing public components only.
    key: openssl::rsa::Rsa<openssl::pkey::Public>,
    /// Canonical PKCS#1 public encoding, checked once at construction.
    der: Vec<u8>,
}

impl PartialEq for PublicKey {
    fn eq(&self, other: &Self) -> bool {
        self.der == other.der
    }
}
impl Eq for PublicKey {}

impl PublicKey {
    /// Check public-component limits previously enforced by RustCrypto RSA.
    /// This does not perform or enable any private-key operation.
    fn checked(key: openssl::rsa::Rsa<openssl::pkey::Public>) -> Option<Self> {
        let n = key.n();
        let e = key.e();
        let exponent = e.to_vec();
        if n.is_negative()
            || e.is_negative()
            || !n.is_odd()
            || !e.is_odd()
            || n.num_bits() > 4096
            || e.num_bits() > 33
            || e >= n
        {
            return None;
        }
        let exponent = exponent.iter().fold(0_u64, |v, b| (v << 8) | u64::from(*b));
        if !(3..=(1_u64 << 33) - 1).contains(&exponent) {
            return None;
        }
        let der = key.public_key_to_der_pkcs1().ok()?;
        Some(Self { key, der })
    }

    /// Construct a public key from unsigned, big-endian modulus and exponent.
    /// The same modulus/exponent limits apply as to DER input.
    pub fn from_components(modulus: &[u8], exponent: &[u8]) -> Option<Self> {
        use openssl::{bn::BigNum, rsa::Rsa};
        if modulus.len() > 512 || exponent.len() > 5 {
            return None;
        }
        let n = BigNum::from_slice(modulus).ok()?;
        let e = BigNum::from_slice(exponent).ok()?;
        Self::checked(Rsa::from_public_components(n, e).ok()?)
    }

    /// Return the modulus as unsigned, big-endian bytes.
    pub fn modulus_be(&self) -> Vec<u8> {
        self.key.n().to_vec()
    }

    /// Return the exponent as unsigned, big-endian bytes.
    pub fn exponent_be(&self) -> Vec<u8> {
        self.key.e().to_vec()
    }

    /// Return true iff the public exponent equals `e`.
    pub fn exponent_is(&self, e: u32) -> bool {
        self.exponent_be()
            == e.to_be_bytes()
                .into_iter()
                .skip_while(|b| *b == 0)
                .collect::<Vec<_>>()
    }

    /// Return the number of bits in the modulus.
    pub fn bits(&self) -> usize {
        self.key.n().num_bits() as usize
    }

    /// Verify a Tor RSA-PKCS#1 v1.5 signature of a raw hash, without a DigestInfo OID.
    ///
    /// OpenSSL's public operation checks the complete type-1 padding (including
    /// its minimum length). Requiring the exact modulus width also rejects
    /// truncated or extended encodings. No private RSA key is ever used.
    pub fn verify(&self, hashed: &[u8], sig: &[u8]) -> Result<(), signature::Error> {
        let size = self.key.size() as usize;
        if sig.len() != size || hashed.len() > size.saturating_sub(11) {
            return Err(signature::Error::new());
        }
        let mut recovered = vec![0_u8; size];
        let len = self
            .key
            .public_decrypt(sig, &mut recovered, openssl::rsa::Padding::PKCS1)
            .map_err(|_| signature::Error::new())?;
        if bool::from(recovered[..len].ct_eq(hashed)) {
            Ok(())
        } else {
            Err(signature::Error::new())
        }
    }

    /// Decode a canonical PKCS#1 RSAPublicKey, never SubjectPublicKeyInfo.
    /// Trailing bytes, non-canonical integers and invalid public components fail.
    pub fn from_der(der: &[u8]) -> Option<Self> {
        if der.len() > 1024 {
            return None;
        }
        let key = openssl::rsa::Rsa::public_key_from_der_pkcs1(der).ok()?;
        let result = Self::checked(key)?;
        (result.der == der).then_some(result)
    }

    /// Encode the public key as canonical PKCS#1 DER, as used in Tor.
    pub fn to_der(&self) -> Vec<u8> {
        self.der.clone()
    }

    /// Compute the legacy Tor SHA-1 identity of the canonical public encoding.
    pub fn to_rsa_identity(&self) -> RsaIdentity {
        use crate::d::Sha1;
        use digest::Digest;
        let id: [u8; RSA_ID_LEN] = Sha1::digest(&self.der).into();
        RsaIdentity { id: id.into() }
    }
}

/// An RSA signature plus all the information needed to validate it.
pub struct ValidatableRsaSignature {
    /// The key that allegedly signed this signature
    key: PublicKey,
    /// The signature in question
    sig: Vec<u8>,
    /// The value we expect to find that the signature is a signature of.
    expected_hash: Vec<u8>,
}

impl ValidatableRsaSignature {
    /// Construct a new ValidatableRsaSignature.
    pub fn new(key: &PublicKey, sig: &[u8], expected_hash: &[u8]) -> Self {
        ValidatableRsaSignature {
            key: key.clone(),
            sig: sig.into(),
            expected_hash: expected_hash.into(),
        }
    }
}

impl super::ValidatableSignature for ValidatableRsaSignature {
    fn is_valid(&self) -> bool {
        self.key
            .verify(&self.expected_hash[..], &self.sig[..])
            .is_ok()
    }
}

#[cfg(test)]
mod mfw_client_rsa_tests {
    use super::PublicKey;
    use openssl::{
        bn::BigNum,
        rsa::{Padding, Rsa},
    };

    fn key() -> Rsa<openssl::pkey::Private> {
        // Private operations are confined to this test oracle, never exposed by
        // the production client API and never implemented by RustCrypto RSA.
        Rsa::generate(1024).unwrap()
    }

    #[test]
    fn raw_hash_verification_rejects_wrong_hash_key_and_signature_width() {
        let signer = key();
        let public = PublicKey::from_der(&signer.public_key_to_der_pkcs1().unwrap()).unwrap();
        let hash = [0x42_u8; 20];
        let mut signature = vec![0; signer.size() as usize];
        signer
            .private_encrypt(&hash, &mut signature, Padding::PKCS1)
            .unwrap();
        assert!(public.verify(&hash, &signature).is_ok());
        assert!(public.verify(&[0x43; 20], &signature).is_err());
        assert!(public.verify(&[], &signature).is_err());
        assert!(public.verify(&[0x42; 128], &signature).is_err());
        assert!(public.verify(&hash, &signature[1..]).is_err());
        let mut extended = signature.clone();
        extended.push(0);
        assert!(public.verify(&hash, &extended).is_err());
        signature[30] ^= 1;
        assert!(public.verify(&hash, &signature).is_err());
        assert!(public.verify(&hash, &vec![0xff; 128]).is_err());
        let other = key();
        let other = PublicKey::from_der(&other.public_key_to_der_pkcs1().unwrap()).unwrap();
        assert!(other.verify(&hash, &extended[..128]).is_err());
    }

    #[test]
    fn malformed_type_one_padding_and_digestinfo_are_not_tor_signatures() {
        let signer = key();
        let public = PublicKey::from_der(&signer.public_key_to_der_pkcs1().unwrap()).unwrap();
        let hash = [0x42_u8; 20];
        let mut correct = vec![0xff; 128];
        correct[0] = 0;
        correct[1] = 1;
        correct[107] = 0;
        correct[108..].copy_from_slice(&hash);
        let mut cases = vec![correct.clone(); 4];
        cases[0][1] = 2; // Wrong block type.
        cases[1][10] = 0xfe; // Non-FF byte in the padding string.
        cases[2][8] = 0; // Only six padding bytes before the delimiter.
        cases[3][107] = 0xff; // Missing delimiter.
        for encoded in cases {
            let mut signature = vec![0; 128];
            signer
                .private_encrypt(&encoded, &mut signature, Padding::NONE)
                .unwrap();
            assert!(public.verify(&hash, &signature).is_err());
        }
        // A normal SHA-1 DigestInfo signature is not the raw-hash Tor scheme.
        let digest_info_prefix = [
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04,
            0x14,
        ];
        let digest_info = [digest_info_prefix.as_slice(), hash.as_slice()].concat();
        let mut signature = vec![0; 128];
        signer
            .private_encrypt(&digest_info, &mut signature, Padding::PKCS1)
            .unwrap();
        assert!(public.verify(&hash, &signature).is_err());
    }

    #[test]
    fn canonical_der_components_and_fingerprint_roundtrip() {
        let signer = key();
        let der = signer.public_key_to_der_pkcs1().unwrap();
        let public = PublicKey::from_der(&der).unwrap();
        let from_components =
            PublicKey::from_components(&signer.n().to_vec(), &signer.e().to_vec()).unwrap();
        assert_eq!(public, from_components);
        assert_eq!(public.to_der(), der);
        assert_eq!(public.to_rsa_identity(), from_components.to_rsa_identity());
        assert!(public.exponent_is(65537));
        assert_eq!(public.bits(), 1024);
        let mut trailing = der.clone();
        trailing.push(0);
        assert!(PublicKey::from_der(&trailing).is_none());
        assert!(PublicKey::from_der(&der[..der.len() - 1]).is_none());
        assert!(PublicKey::from_der(&signer.public_key_to_der().unwrap()).is_none());
        // DER must not contain an unnecessary leading zero for the exponent.
        let noncanonical = [0x30, 0x07, 0x02, 0x01, 0x0b, 0x02, 0x02, 0x00, 0x03];
        assert!(PublicKey::from_der(&noncanonical).is_none());
        let negative = [0x30, 0x06, 0x02, 0x01, 0xff, 0x02, 0x01, 0x03];
        assert!(PublicKey::from_der(&negative).is_none());
    }

    #[test]
    fn invalid_public_components_are_rejected_before_verification() {
        for exponent in [0_u64, 1, 2, 4, 1_u64 << 33] {
            let e = BigNum::from_slice(&exponent.to_be_bytes()).unwrap();
            assert!(PublicKey::from_components(&[0x01, 0x01], &e.to_vec()).is_none());
        }
        assert!(PublicKey::from_components(&[0x10], &[3]).is_none()); // Even n.
        assert!(PublicKey::from_components(&[3], &[3]).is_none()); // e >= n.
        assert!(PublicKey::from_components(&[], &[3]).is_none());
        assert!(PublicKey::from_components(&vec![0xff; 513], &[3]).is_none());
    }
}
