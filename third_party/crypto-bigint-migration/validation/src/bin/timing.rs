//! Diagnostic timing samples, not a proof of constant-time execution.
//! All operands are synthetic and public. Build with the production Rust toolchain.

use crypto_bigint::{BoxedUint, CtOption, NonZero, U256, const_monty_params, modular::{BoxedMontyForm, BoxedMontyParams, ConstMontyForm}};
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use std::{hint::black_box, time::Instant};

const_monty_params!(Modulus, U256, "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
type Monty = ConstMontyForm<Modulus, { U256::LIMBS }>;

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_sub(a: &U256, b: &U256) -> U256 {
    a.wrapping_sub(b)
}

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_zero_counts(a: &U256) -> (u32, u32) {
    (a.leading_zeros(), a.trailing_zeros())
}

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_div(a: &U256, b: &NonZero<U256>) -> (U256, U256) {
    a.div_rem(b)
}

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_montgomery(a: &U256, b: &U256) -> U256 {
    Monty::new(a).mul(&Monty::new(b)).retrieve()
}

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_ref_eq(a: &U256, b: &U256) -> bool {
    crypto_bigint::ctutils::CtEq::ct_eq(a.as_uint_ref(), b.as_uint_ref()).into()
}

#[no_mangle]
#[inline(never)]
pub fn mfw_ct_probe_boxed_invert(a: &BoxedMontyForm) -> CtOption<BoxedMontyForm> {
    a.invert()
}

fn mean_variance(values: &[f64]) -> (f64, f64) {
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    (mean, variance)
}

fn main() {
    let mut rng = ChaCha20Rng::from_seed([0x67; 32]);
    let boxed_params = BoxedMontyParams::new(BoxedUint::from_be_hex("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed", 256).unwrap().to_odd().unwrap());
    let mut order = (0..1024).map(|i| i % 2).collect::<Vec<_>>();
    for i in (1..order.len()).rev() {
        order.swap(i, rng.next_u32() as usize % (i + 1));
    }
    println!("{{\"arch\":\"{}\",\"os\":\"{}\",\"crypto_bigint\":\"0.7.10\",\"profile\":\"release\",\"claim\":\"diagnostic only; no constant-time proof\",\"batch_size\":64,\"operations\":[", std::env::consts::ARCH, std::env::consts::OS);
    for (op, name) in ["sub", "zero_counts", "div_rem", "montgomery", "uint_ref_eq", "boxed_invert"].iter().enumerate() {
        let mut samples = [Vec::with_capacity(512), Vec::with_capacity(512)];
        // Warm each code path before collecting balanced, randomly interleaved classes.
        for (sample_index, class) in order.iter().cycle().take(order.len() + 128).enumerate() {
            let mut bytes = [0; 32];
            rng.fill_bytes(&mut bytes);
            let random = U256::from_le_slice(&bytes);
            let mut a = if *class == 0 { U256::ZERO } else { random };
            bytes[0] |= 1;
            let mut b = U256::from_le_slice(&bytes);
            // Division classes also exercise minimum versus full-width divisors.
            if op == 2 && *class == 0 { b = U256::ONE; }
            // Equality classes differ in the first versus last compared limb.
            if op == 4 {
                a = random;
                let mut other: [u8; 32] = a.to_le_bytes().into();
                other[if *class == 0 { 0 } else { 31 }] ^= 1;
                b = U256::from_le_slice(&other);
            }
            let nonzero = NonZero::new(b).unwrap();
            let boxed = BoxedMontyForm::new(BoxedUint::from_be_slice(a.to_be_bytes().as_ref(), 256).unwrap(), &boxed_params);
            let start = Instant::now();
            for _ in 0..64 {
                match op {
                    0 => { black_box(mfw_ct_probe_sub(black_box(&a), black_box(&b))); },
                    1 => { black_box(mfw_ct_probe_zero_counts(black_box(&a))); },
                    2 => { black_box(mfw_ct_probe_div(black_box(&a), black_box(&nonzero))); },
                    3 => { black_box(mfw_ct_probe_montgomery(black_box(&a), black_box(&b))); },
                    4 => { black_box(mfw_ct_probe_ref_eq(black_box(&a), black_box(&b))); },
                    _ => { black_box(mfw_ct_probe_boxed_invert(black_box(&boxed))); },
                }
            }
            let ns_per_op = start.elapsed().as_nanos() as f64 / 64.0;
            if sample_index >= 128 { samples[*class].push(ns_per_op); }
        }
        let (mean0, var0) = mean_variance(&samples[0]);
        let (mean1, var1) = mean_variance(&samples[1]);
        let denominator = (var0 / samples[0].len() as f64 + var1 / samples[1].len() as f64).sqrt();
        let welch_t = if denominator > 0.0 { (mean0 - mean1) / denominator } else { 0.0 };
        if op != 0 { println!(","); }
        print!("{{\"name\":\"{name}\",\"class0_count\":{},\"class1_count\":{},\"class0_mean_ns\":{mean0},\"class1_mean_ns\":{mean1},\"welch_t\":{welch_t},\"class0_ns\":{:?},\"class1_ns\":{:?}}}", samples[0].len(), samples[1].len(), samples[0], samples[1]);
    }
    println!("]}}");
}
