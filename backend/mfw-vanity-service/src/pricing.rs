use std::collections::BTreeMap;

use anyhow::{anyhow, Context, Result};

pub const ATOMIC_UNITS_PER_XMR: u64 = 1_000_000_000_000;
pub const MAX_PRICED_PREFIX_LENGTH: usize = 10;
pub const LIMITED_SEARCH_PREFIX_LENGTH: usize = 10;
pub const PREFIXES_PER_SEARCH_GROUP: usize = 3;
pub const MAX_ACTIVE_PREFIX_SLOTS: usize = 2_000;
pub const LIMITED_SEARCH_SECONDS: u64 = 60 * 24 * 60 * 60;

const PRICE_0_001_XMR: u64 = 1_000_000_000;
const PRICE_0_002_XMR: u64 = 2_000_000_000;
const PRICE_0_01_XMR: u64 = 10_000_000_000;
const PRICE_0_30_XMR: u64 = 300_000_000_000;
const PRICE_1_XMR: u64 = ATOMIC_UNITS_PER_XMR;

#[derive(Clone, Debug)]
pub struct PricingCatalog {
    by_prefix_length: BTreeMap<usize, u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceQuote {
    pub total_atomic: u64,
    pub list_price_atomic: u64,
    pub discount_atomic: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchGroupPlan {
    pub prefix_length: usize,
    pub prefixes: Vec<String>,
    pub price_atomic: u64,
    pub maximum_search_seconds: u64,
}

impl PricingCatalog {
    pub fn fixed() -> Self {
        let mut by_prefix_length = BTreeMap::new();
        for length in 2..=6 {
            by_prefix_length.insert(length, PRICE_0_001_XMR);
        }
        by_prefix_length.insert(7, PRICE_0_002_XMR);
        by_prefix_length.insert(8, PRICE_0_01_XMR);
        by_prefix_length.insert(9, PRICE_0_30_XMR);
        by_prefix_length.insert(10, PRICE_1_XMR);
        Self { by_prefix_length }
    }

    pub fn quote(&self, prefixes: &[String]) -> Result<PriceQuote> {
        let mut list_price_atomic = 0_u64;
        for prefix in prefixes {
            let length = prefix.chars().count();
            let price = self
                .by_prefix_length
                .get(&length)
                .copied()
                .ok_or_else(|| anyhow!("no price configured for prefix length {length}"))?;
            list_price_atomic = list_price_atomic
                .checked_add(price)
                .context("quote list price overflow")?;
        }

        let mut total_atomic = 0_u64;
        for group in self.search_groups(prefixes)? {
            total_atomic = total_atomic
                .checked_add(group.price_atomic)
                .context("grouped quote price overflow")?;
        }
        Ok(PriceQuote {
            total_atomic,
            list_price_atomic,
            discount_atomic: list_price_atomic.saturating_sub(total_atomic),
        })
    }

    pub fn search_groups(&self, prefixes: &[String]) -> Result<Vec<SearchGroupPlan>> {
        let mut by_length = BTreeMap::<usize, Vec<String>>::new();
        for prefix in prefixes {
            let length = prefix.chars().count();
            if !self.by_prefix_length.contains_key(&length) {
                return Err(anyhow!("no price configured for prefix length {length}"));
            }
            by_length.entry(length).or_default().push(prefix.clone());
        }

        let mut groups = Vec::new();
        for (prefix_length, same_length_prefixes) in by_length {
            let price_atomic = self.by_prefix_length[&prefix_length];
            let maximum_search_seconds = maximum_search_seconds(prefix_length)?;
            for chunk in same_length_prefixes.chunks(PREFIXES_PER_SEARCH_GROUP) {
                groups.push(SearchGroupPlan {
                    prefix_length,
                    prefixes: chunk.to_vec(),
                    price_atomic,
                    maximum_search_seconds,
                });
            }
        }
        Ok(groups)
    }
}

pub fn maximum_search_seconds(prefix_length: usize) -> Result<u64> {
    match prefix_length {
        2..=6 => Ok(10 * 60),
        7 => Ok(60 * 60),
        8 => Ok(12 * 60 * 60),
        9 => Ok(7 * 24 * 60 * 60),
        10 => Ok(LIMITED_SEARCH_SECONDS),
        _ => Err(anyhow!(
            "no maximum search time configured for prefix length {prefix_length}"
        )),
    }
}

pub fn format_xmr(atomic: u64) -> String {
    let whole = atomic / ATOMIC_UNITS_PER_XMR;
    let fraction = atomic % ATOMIC_UNITS_PER_XMR;
    if fraction == 0 {
        return format!("{whole}.0");
    }
    let mut fraction = format!("{fraction:012}");
    while fraction.ends_with('0') {
        fraction.pop();
    }
    format!("{whole}.{fraction}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_prices_match_the_product_decision() {
        let catalog = PricingCatalog::fixed();
        let cases = [
            ("4M", PRICE_0_001_XMR),
            ("4MFW12", PRICE_0_001_XMR),
            ("4MFW123", PRICE_0_002_XMR),
            ("4MFW1234", PRICE_0_01_XMR),
            ("4MFW12345", PRICE_0_30_XMR),
            ("4MFW123456", PRICE_1_XMR),
        ];
        for (prefix, expected) in cases {
            assert_eq!(
                catalog.quote(&[prefix.to_owned()]).unwrap().total_atomic,
                expected
            );
        }
    }

    #[test]
    fn up_to_three_same_length_prefixes_cost_one_search() {
        let catalog = PricingCatalog::fixed();
        let quote = catalog
            .quote(&["4AA".into(), "4BB".into(), "4CC".into()])
            .unwrap();
        assert_eq!(quote.list_price_atomic, 3_000_000_000);
        assert_eq!(quote.total_atomic, 1_000_000_000);
        assert_eq!(quote.discount_atomic, 2_000_000_000);
    }

    #[test]
    fn a_fourth_same_length_prefix_starts_a_second_paid_group() {
        let catalog = PricingCatalog::fixed();
        let prefixes = ["4AA", "4BB", "4CC", "4DD"].map(str::to_owned);
        let quote = catalog.quote(&prefixes).unwrap();
        assert_eq!(quote.list_price_atomic, 4_000_000_000);
        assert_eq!(quote.total_atomic, 2_000_000_000);
        let groups = catalog.search_groups(&prefixes).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].prefixes.len(), 3);
        assert_eq!(groups[1].prefixes.len(), 1);
    }

    #[test]
    fn one_ten_character_search_costs_exactly_one_xmr() {
        let quote = PricingCatalog::fixed()
            .quote(&["4MFW123456".into()])
            .unwrap();
        assert_eq!(quote.total_atomic, ATOMIC_UNITS_PER_XMR);
        assert_eq!(LIMITED_SEARCH_SECONDS, 5_184_000);
    }

    #[test]
    fn atomic_amounts_are_formatted_without_float_rounding() {
        assert_eq!(format_xmr(3_000_000_000), "0.003");
        assert_eq!(format_xmr(1_000_000_000_001), "1.000000000001");
    }
}
