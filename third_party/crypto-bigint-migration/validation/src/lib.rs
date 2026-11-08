//! Independent arithmetic and protocol-vector checks for the 0.7.10 API adapters.

#[cfg(test)]
mod tests {
    use group::ff::PrimeField;
    use num_bigint::BigUint;
    use rand_chacha::ChaCha20Rng;
    use rand_core::{RngCore, SeedableRng};

    fn integer<F: PrimeField>(value: F) -> BigUint {
        BigUint::from_bytes_le(value.to_repr().as_ref())
    }

    fn field<F: PrimeField>(wide_bytes: usize) {
        let modulus = BigUint::parse_bytes(F::MODULUS.as_bytes(), 16).unwrap();
        let one = BigUint::from(1u8);
        let mut rng = ChaCha20Rng::from_seed([0x37; 32]);

        // Exercise the adapters' exact wide-random reduction and byte order.
        for _ in 0..128 {
            let mut oracle_rng = rng.clone();
            let mut wide = vec![0; wide_bytes];
            oracle_rng.fill_bytes(&mut wide);
            let a = F::random(&mut rng);
            assert_eq!(integer(a), BigUint::from_bytes_le(&wide) % &modulus);
            let b = F::random(&mut rng);
            let ai = integer(a);
            let bi = integer(b);
            assert_eq!(integer(a + b), (&ai + &bi) % &modulus);
            assert_eq!(integer(a - b), (&ai + &modulus - &bi) % &modulus);
            assert_eq!(integer(a * b), (&ai * &bi) % &modulus);
            assert_eq!(integer(a.square()), (&ai * &ai) % &modulus);
            if !bool::from(a.is_zero()) {
                assert_eq!(a * a.invert().unwrap(), F::ONE);
            }
            let squared = a.square();
            assert_eq!(squared.sqrt().unwrap().square(), squared);
        }

        // Canonical decoding accepts p-1 and rejects p and p+1.
        for n in [BigUint::from(0u8), one.clone(), &modulus - &one, modulus.clone(), &modulus + &one] {
            let mut repr = F::Repr::default();
            let bytes = n.to_bytes_le();
            repr.as_mut()[..bytes.len()].copy_from_slice(&bytes);
            let decoded = F::from_repr(repr);
            assert_eq!(bool::from(decoded.is_some()), n < modulus);
            if n < modulus {
                assert_eq!(integer(decoded.unwrap()), n);
            }
        }
        assert_eq!(F::TWO_INV + F::TWO_INV, F::ONE);
        assert_eq!(F::ROOT_OF_UNITY * F::ROOT_OF_UNITY_INV, F::ONE);
        assert!(!bool::from(F::ZERO.invert().is_some()));
    }

    #[test]
    fn dalek_04_field_matches_independent_biguint_oracle() {
        field::<dalek04::FieldElement>(64);
    }

    #[test]
    fn dalek_05_field_matches_independent_biguint_oracle() {
        field::<dalek05::FieldElement>(64);
    }

    #[test]
    fn ed448_field_matches_independent_biguint_oracle() {
        field::<minimal_ed448::FieldElement>(112);
    }

    #[test]
    fn ed448_scalar_matches_independent_biguint_oracle() {
        field::<minimal_ed448::Scalar>(112);
    }

    #[test]
    fn ed448_wide_scalar_reduction_matches_independent_oracle() {
        let modulus = BigUint::parse_bytes(minimal_ed448::Scalar::MODULUS.as_bytes(), 16).unwrap();
        let mut rng = ChaCha20Rng::from_seed([0x91; 32]);
        for _ in 0..128 {
            let mut bytes = [0; 114];
            rng.fill_bytes(&mut bytes);
            assert_eq!(integer(minimal_ed448::Scalar::wide_reduce(bytes)), BigUint::from_bytes_le(&bytes) % &modulus);
        }
    }

    #[test]
    fn monero_hash_to_point_matches_existing_monero_vectors() {
        let vectors = include_str!("../../../monero-generators-0.4.0/src/tests/tests.txt");
        let mut checked = 0;
        for line in vectors.lines() {
            let mut words = line.split_whitespace();
            if words.next() != Some("hash_to_ec") { continue; }
            let input: [u8; 32] = hex::decode(words.next().unwrap()).unwrap().try_into().unwrap();
            let expected = words.next().unwrap();
            let actual = monero_generators::biased_hash_to_point(input).compress().to_bytes();
            assert_eq!(hex::encode(actual), expected);
            checked += 1;
        }
        assert!(checked > 100, "must exercise the upstream vector set");
    }

    #[test]
    fn advisory_integer_operations_match_independent_oracle() {
        use crypto_bigint::{NonZero, U256};
        let mut rng = ChaCha20Rng::from_seed([0x14; 32]);
        let width = BigUint::from(1u8) << 256;
        for i in 0..512 {
            let mut a_bytes = [0; 32];
            let mut b_bytes = [0; 32];
            rng.fill_bytes(&mut a_bytes);
            rng.fill_bytes(&mut b_bytes);
            // Include all limb-boundary zero counts and powers-of-two divisors.
            if i < 256 {
                a_bytes.fill(0);
                a_bytes[i / 8] = 1 << (i % 8);
                b_bytes = a_bytes;
            }
            b_bytes[0] |= 1;
            let a = U256::from_le_slice(&a_bytes);
            let b = U256::from_le_slice(&b_bytes);
            let ai = BigUint::from_bytes_le(&a_bytes);
            let bi = BigUint::from_bytes_le(&b_bytes);
            assert_eq!(BigUint::from_bytes_le(a.wrapping_sub(&b).to_le_bytes().as_ref()), (&ai + &width - &bi) % &width);
            let (q, r) = a.div_rem(&NonZero::new(b).unwrap());
            assert_eq!(BigUint::from_bytes_le(q.to_le_bytes().as_ref()), &ai / &bi);
            assert_eq!(BigUint::from_bytes_le(r.to_le_bytes().as_ref()), &ai % &bi);
            assert_eq!(a.leading_zeros(), 256 - ai.bits() as u32);
            assert_eq!(a.trailing_zeros(), ai.trailing_zeros().unwrap_or(256) as u32);
            assert!(bool::from(crypto_bigint::ctutils::CtEq::ct_eq(a.as_uint_ref(), a.as_uint_ref())));
        }
        assert_eq!(U256::ZERO.leading_zeros(), 256);
        assert_eq!(U256::ZERO.trailing_zeros(), 256);
    }

    #[test]
    fn advisory_montgomery_and_boxed_inversion_regressions() {
        use crypto_bigint::{BoxedUint, U256, const_monty_params, modular::{BoxedMontyForm, BoxedMontyParams, ConstMontyForm}};
        const_monty_params!(Modulus, U256, "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
        type Monty = ConstMontyForm<Modulus, { U256::LIMBS }>;
        let modulus = BigUint::parse_bytes(b"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed", 16).unwrap();
        let params = BoxedMontyParams::new(BoxedUint::from_be_slice(&modulus.to_bytes_be(), 256).unwrap().to_odd().unwrap());
        let mut rng = ChaCha20Rng::from_seed([0xa8; 32]);
        for _ in 0..128 {
            let mut a_bytes = [0; 32];
            let mut b_bytes = [0; 32];
            rng.fill_bytes(&mut a_bytes);
            rng.fill_bytes(&mut b_bytes);
            let a = Monty::new(&U256::from_be_slice(&a_bytes));
            let b = Monty::new(&U256::from_be_slice(&b_bytes));
            let expected = (BigUint::from_bytes_be(&a_bytes) * BigUint::from_bytes_be(&b_bytes)) % &modulus;
            assert_eq!(BigUint::from_bytes_be(a.mul(&b).retrieve().to_be_bytes().as_ref()), expected);
            let boxed = BoxedMontyForm::new(BoxedUint::from_be_slice(&a_bytes, 256).unwrap(), &params);
            let inverse = boxed.invert().unwrap();
            assert_eq!((&boxed * &inverse).retrieve(), BoxedUint::from_be_slice(&[1], 256).unwrap());
        }
        let zero = BoxedMontyForm::new(BoxedUint::from_be_slice(&[0], 256).unwrap(), &params);
        assert!(!bool::from(zero.invert().is_some()));
    }
}
