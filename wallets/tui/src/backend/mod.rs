mod memory;
mod product_cli;
mod types;
mod unavailable;

pub use memory::MemoryBackend;
pub use product_cli::{parse_cli_output, ProductCliBackend};
pub use types::*;
pub use unavailable::UnavailableBackend;

use std::path::PathBuf;

pub fn default_backend(product_cli: Option<PathBuf>) -> Box<dyn WalletBackend> {
    match product_cli {
        Some(path) => Box::new(ProductCliBackend::new(path)),
        None => Box::new(UnavailableBackend),
    }
}
