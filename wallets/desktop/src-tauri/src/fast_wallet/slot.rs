const MAX_PRODUCT_SLOT: u64 = 999;

/// Keep existing product slots unchanged and allocate strictly after the
/// highest recorded slot. Slot zero is reserved, including for an empty
/// registry; gaps are not reused as identity derivation may depend on slots.
pub(super) fn next_derivation_index(indices: impl IntoIterator<Item = u64>) -> Result<u64, String> {
    indices
        .into_iter()
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .filter(|index| *index <= MAX_PRODUCT_SLOT)
        .ok_or_else(|| {
            "The maximum number of Fast Wallets on this device has been reached.".to_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::next_derivation_index;

    #[test]
    fn first_fast_wallet_uses_slot_one_when_only_other_wallet_kinds_exist() {
        // Ledger/software registrations are separate from this empty registry.
        assert_eq!(next_derivation_index([]), Ok(1));
    }

    #[test]
    fn an_existing_zero_slot_is_preserved_and_never_selected_again() {
        let existing = [0];
        assert_eq!(next_derivation_index(existing), Ok(1));
        assert_eq!(existing, [0]);
    }

    #[test]
    fn allocation_follows_the_highest_slot_and_does_not_reuse_gaps() {
        let existing = [4, 1, 7, 3];
        assert_eq!(next_derivation_index(existing), Ok(8));
        assert_eq!(existing, [4, 1, 7, 3]);
    }

    #[test]
    fn the_last_supported_slot_is_usable() {
        assert_eq!(next_derivation_index([998]), Ok(999));
    }

    #[test]
    fn exhaustion_does_not_reuse_a_gap_or_return_an_invalid_slot() {
        assert!(next_derivation_index([1, 999]).is_err());
        assert!(next_derivation_index(1..=999).is_err());
    }

    #[test]
    fn out_of_range_metadata_and_integer_overflow_fail_closed() {
        assert!(next_derivation_index([1000]).is_err());
        assert!(next_derivation_index([u64::MAX]).is_err());
    }
}
