use thiserror::Error;

pub const ATOMIC_PER_XMR: u128 = 1_000_000_000_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FormatError {
    #[error("invalid XMR amount")]
    InvalidAmount,
    #[error("amount has more than 12 decimal places")]
    TooManyDecimals,
    #[error("amount is too large")]
    Overflow,
}

pub fn parse_xmr_to_atomic(input: &str) -> Result<u128, FormatError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(FormatError::InvalidAmount);
    }
    let (whole, frac) = match trimmed.split_once('.') {
        Some((whole, frac)) => (whole, frac),
        None => (trimmed, ""),
    };
    if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) {
        return Err(FormatError::InvalidAmount);
    }
    if !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(FormatError::InvalidAmount);
    }
    if frac.len() > 12 {
        return Err(FormatError::TooManyDecimals);
    }
    let whole_value: u128 = whole.parse().map_err(|_| FormatError::Overflow)?;
    let whole_atomic = whole_value
        .checked_mul(ATOMIC_PER_XMR)
        .ok_or(FormatError::Overflow)?;
    let mut frac_padded = frac.to_owned();
    while frac_padded.len() < 12 {
        frac_padded.push('0');
    }
    let frac_atomic: u128 = if frac_padded.is_empty() {
        0
    } else {
        frac_padded.parse().map_err(|_| FormatError::Overflow)?
    };
    whole_atomic
        .checked_add(frac_atomic)
        .ok_or(FormatError::Overflow)
}

pub fn format_atomic_xmr(atomic: u128) -> String {
    let whole = atomic / ATOMIC_PER_XMR;
    let frac = atomic % ATOMIC_PER_XMR;
    format!("{whole}.{frac:012}")
}

pub fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        "•".repeat(value.chars().count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_balance_format() {
        assert_eq!(parse_xmr_to_atomic("0.000000000000").unwrap(), 0);
        assert_eq!(
            parse_xmr_to_atomic("1.230000000000").unwrap(),
            1_230_000_000_000
        );
        assert_eq!(parse_xmr_to_atomic("3").unwrap(), 3_000_000_000_000);
        assert_eq!(parse_xmr_to_atomic("0.000000000001").unwrap(), 1);
    }

    #[test]
    fn rejects_bad_amounts() {
        assert_eq!(parse_xmr_to_atomic(""), Err(FormatError::InvalidAmount));
        assert_eq!(
            parse_xmr_to_atomic("1.2.3"),
            Err(FormatError::InvalidAmount)
        );
        assert_eq!(
            parse_xmr_to_atomic("0.0000000000001"),
            Err(FormatError::TooManyDecimals)
        );
    }

    #[test]
    fn roundtrips() {
        let atomic = parse_xmr_to_atomic("12.340000000001").unwrap();
        assert_eq!(format_atomic_xmr(atomic), "12.340000000001");
    }

    #[test]
    fn masks_passwords_without_leaking_length_of_empty() {
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("abc"), "•••");
    }
}
