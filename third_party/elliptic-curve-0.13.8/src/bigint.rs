//! Byte-container compatibility for the official crypto-bigint 0.7 implementation.
//!
//! Elliptic-curve 0.13 exposes generic-array 0.14 in its public API. Keep that
//! representation at the boundary and delegate integer operations to 0.7.

pub use crypto_bigint::*;
use generic_array::{ArrayLength, GenericArray};

/// Byte array in the existing elliptic-curve public encoding API.
pub type ByteArray<T> = GenericArray<u8, <T as ArrayEncoding>::ByteSize>;

/// Encoding boundary between generic-array and crypto-bigint's hybrid-array.
pub trait ArrayEncoding: Encoding {
    /// Number of encoded bytes.
    type ByteSize: ArrayLength<u8> + core::ops::Add + Eq + Ord;
    /// Decode big-endian bytes.
    fn from_be_byte_array(bytes: ByteArray<Self>) -> Self;
    /// Decode little-endian bytes.
    fn from_le_byte_array(bytes: ByteArray<Self>) -> Self;
    /// Encode big-endian bytes.
    fn to_be_byte_array(&self) -> ByteArray<Self>;
    /// Encode little-endian bytes.
    fn to_le_byte_array(&self) -> ByteArray<Self>;
}

impl<const LIMBS: usize> ArrayEncoding for Uint<LIMBS>
where
    Uint<LIMBS>: crypto_bigint::ArrayEncoding,
    <Uint<LIMBS> as crypto_bigint::ArrayEncoding>::ByteSize: ArrayLength<u8>,
{
    type ByteSize = <Self as crypto_bigint::ArrayEncoding>::ByteSize;
    fn from_be_byte_array(bytes: ByteArray<Self>) -> Self {
        Self::from_be_slice(&bytes)
    }
    fn from_le_byte_array(bytes: ByteArray<Self>) -> Self {
        Self::from_le_slice(&bytes)
    }
    fn to_be_byte_array(&self) -> ByteArray<Self> {
        GenericArray::clone_from_slice(self.to_be_bytes().as_ref())
    }
    fn to_le_byte_array(&self) -> ByteArray<Self> {
        GenericArray::clone_from_slice(self.to_le_bytes().as_ref())
    }
}

/// Traits used by elliptic-curve 0.13 and its existing curve consumers.
/// Ctutils comparison traits are deliberately qualified at the implementation
/// boundary, so these imports retain the public subtle comparison API.
pub mod prelude {
    pub use super::{ArrayEncoding, ByteArray};
    pub use crypto_bigint::{
        AddMod, BitOps, Bounded, CheckedAdd, CheckedDiv, CheckedMul, CheckedSub,
        ConstOne, ConstZero, Encoding, Integer, NegMod, Random, RandomMod, SubMod,
        Zero,
    };
}
