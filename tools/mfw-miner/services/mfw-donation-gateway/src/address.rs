// SPDX-License-Identifier: GPL-3.0-only

use anyhow::{Context, Result, bail, ensure};
use tiny_keccak::{Hasher, Keccak};

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCODED_BLOCK_SIZES: [usize; 9] = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_ENCODED_BLOCK_SIZE: usize = 11;
const FULL_DECODED_BLOCK_SIZE: usize = 8;
const STANDARD_MAINNET_TAG: u8 = 18;

/// Validates a standard (non-integrated, non-subaddress) Monero mainnet address,
/// including its Keccak checksum. MFW donation mining deliberately accepts only
/// this address type so pool and solo backends have identical payout semantics.
pub fn validate_monero_mainnet_standard(address: &str) -> Result<()> {
    ensure!(
        address.len() == 95,
        "address must contain exactly 95 characters"
    );

    let decoded = decode_monero_base58(address)?;
    ensure!(decoded.len() == 69, "address must decode to 69 bytes");
    ensure!(
        decoded[0] == STANDARD_MAINNET_TAG,
        "address is not a standard Monero mainnet address"
    );

    let payload_len = decoded.len() - 4;
    let mut hash = [0_u8; 32];
    let mut keccak = Keccak::v256();
    keccak.update(&decoded[..payload_len]);
    keccak.finalize(&mut hash);

    ensure!(
        decoded[payload_len..] == hash[..4],
        "address checksum is invalid"
    );

    Ok(())
}

fn decode_monero_base58(value: &str) -> Result<Vec<u8>> {
    let bytes = value.as_bytes();
    let full_blocks = bytes.len() / FULL_ENCODED_BLOCK_SIZE;
    let last_size = bytes.len() % FULL_ENCODED_BLOCK_SIZE;
    let last_decoded_size = ENCODED_BLOCK_SIZES
        .iter()
        .position(|size| *size == last_size)
        .context("invalid final Monero base58 block size")?;

    let mut out = Vec::with_capacity(full_blocks * FULL_DECODED_BLOCK_SIZE + last_decoded_size);

    for block_index in 0..=full_blocks {
        let encoded_size = if block_index < full_blocks {
            FULL_ENCODED_BLOCK_SIZE
        } else {
            last_size
        };
        if encoded_size == 0 {
            continue;
        }

        let decoded_size = if block_index < full_blocks {
            FULL_DECODED_BLOCK_SIZE
        } else {
            last_decoded_size
        };
        let start = block_index * FULL_ENCODED_BLOCK_SIZE;
        let block = &bytes[start..start + encoded_size];

        let mut number = 0_u64;
        for byte in block {
            let digit = ALPHABET
                .iter()
                .position(|candidate| candidate == byte)
                .with_context(|| format!("invalid Monero base58 character: {}", *byte as char))?
                as u64;
            number = number
                .checked_mul(ALPHABET.len() as u64)
                .and_then(|value| value.checked_add(digit))
                .context("Monero base58 block overflow")?;
        }

        if decoded_size < FULL_DECODED_BLOCK_SIZE {
            let max = 1_u128 << (decoded_size * 8);
            if number as u128 >= max {
                bail!("Monero base58 block does not fit decoded size");
            }
        }

        let encoded = number.to_be_bytes();
        out.extend_from_slice(&encoded[FULL_DECODED_BLOCK_SIZE - decoded_size..]);
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MFW_ADDRESS: &str = "49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL";

    #[test]
    fn accepts_configured_mfw_address() {
        validate_monero_mainnet_standard(MFW_ADDRESS).unwrap();
    }

    #[test]
    fn rejects_tampered_checksum() {
        let mut value = MFW_ADDRESS.to_owned();
        value.pop();
        value.push('M');
        assert!(validate_monero_mainnet_standard(&value).is_err());
    }
}
