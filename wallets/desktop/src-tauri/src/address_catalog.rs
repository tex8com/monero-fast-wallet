//! Read-only enumeration of the native wallet's existing account/address set.
use crate::send_plan::{atomic, Account};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub account_index: u32,
    pub address_index: u32,
    pub address: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAccount {
    pub account_index: u32,
    pub label: String,
    pub balance_atomic: String,
    pub unlocked_balance_atomic: String,
    pub addresses: Vec<Address>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub accounts: Vec<CatalogAccount>,
}

pub fn collect(
    mut accounts: Vec<Account>,
    mut list: impl FnMut(u32) -> Result<Vec<Address>, String>,
) -> Result<Catalog, String> {
    if accounts.is_empty() {
        return Err("The native wallet has no receiving accounts.".to_owned());
    }
    accounts.sort_by_key(|account| account.account_index);
    let mut account_indices = HashSet::new();
    let mut result = Vec::with_capacity(accounts.len());
    for account in accounts {
        if !account_indices.insert(account.account_index)
            || atomic(&account.unlocked_balance_atomic)? > atomic(&account.balance_atomic)?
        {
            return Err("The native receiving account catalog is inconsistent.".to_owned());
        }
        let mut addresses = list(account.account_index)?;
        addresses.sort_by_key(|address| address.address_index);
        let mut address_indices = HashSet::new();
        if addresses.is_empty()
            || addresses.iter().any(|address| {
                address.account_index != account.account_index
                    || address.address.is_empty()
                    || !address_indices.insert(address.address_index)
            })
        {
            return Err("The native receiving address catalog is inconsistent.".to_owned());
        }
        // Wallet2 stores the account name as the label of its primary address.
        let primary = addresses
            .iter()
            .find(|address| address.address_index == 0)
            .ok_or_else(|| {
                "A native receiving account is missing its primary address.".to_owned()
            })?;
        result.push(CatalogAccount {
            account_index: account.account_index,
            label: primary.label.clone(),
            balance_atomic: account.balance_atomic,
            unlocked_balance_atomic: account.unlocked_balance_atomic,
            addresses,
        });
    }
    Ok(Catalog { accounts: result })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(index: u32) -> Account {
        Account {
            account_index: index,
            balance_atomic: "0".to_owned(),
            unlocked_balance_atomic: "0".to_owned(),
        }
    }
    fn address(account: u32, index: u32) -> Address {
        Address {
            account_index: account,
            address_index: index,
            address: format!("fixture-{account}-{index}"),
            label: if index == 0 {
                format!("Account {account}")
            } else {
                String::new()
            },
        }
    }
    #[test]
    fn address_catalog_lists_every_native_account_and_primary_even_without_history_or_balance() {
        let mut calls = Vec::new();
        let catalog = collect(vec![account(7), account(0), account(2)], |index| {
            calls.push(index);
            Ok(vec![address(index, 3), address(index, 0)])
        })
        .unwrap();
        assert_eq!(calls, vec![0, 2, 7]);
        assert_eq!(catalog.accounts.len(), 3);
        assert_eq!(
            catalog
                .accounts
                .iter()
                .map(|group| group.addresses.len())
                .sum::<usize>(),
            6
        );
        for group in catalog.accounts {
            assert_eq!(group.addresses[0].address_index, 0);
            assert_eq!(group.label, format!("Account {}", group.account_index));
        }
    }
    #[test]
    fn address_catalog_fails_the_whole_read_instead_of_omitting_an_unavailable_account() {
        let mut calls = Vec::new();
        let result = collect(vec![account(0), account(1), account(2)], |index| {
            calls.push(index);
            if index == 1 {
                Err("fixture read failure".to_owned())
            } else {
                Ok(vec![address(index, 0)])
            }
        });
        assert!(result.is_err());
        assert_eq!(calls, vec![0, 1]);
    }
    #[test]
    fn address_catalog_rejects_foreign_duplicate_and_missing_primary_rows() {
        for rows in [
            vec![address(1, 0)],
            vec![address(0, 0), address(0, 0)],
            vec![address(0, 2)],
        ] {
            assert!(collect(vec![account(0)], |_| Ok(rows.clone())).is_err());
        }
    }
    #[test]
    fn address_catalog_does_not_guess_or_create_absent_accounts() {
        let mut calls = Vec::new();
        let catalog = collect(vec![account(0), account(19)], |index| {
            calls.push(index);
            Ok(vec![address(index, 0)])
        })
        .unwrap();
        assert_eq!(calls, vec![0, 19]);
        assert_eq!(catalog.accounts.len(), 2);
        assert!(collect(Vec::new(), |_| panic!(
            "an empty account list must not probe any index"
        ))
        .is_err());
    }
}
