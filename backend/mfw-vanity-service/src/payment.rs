use std::{fs, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use monero_address::{AddressType as MoneroAddressType, MoneroAddress, Network};
use reqwest::Url;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::database::PaymentObservation;

#[derive(Clone, Debug)]
pub struct PaymentConfig {
    pub public_address: String,
    pub private_view_key_file: PathBuf,
    pub wallet_password_file: PathBuf,
    pub wallet_rpc_url: String,
    pub wallet_filename: String,
    pub restore_height: u64,
}

#[async_trait]
pub trait PaymentBackend: Send + Sync {
    async fn invoice_address(&self, payment_id: &str) -> Result<String>;
    async fn poll(&self, payment_ids: &[String]) -> Result<Vec<PaymentObservation>>;
}

pub struct WalletRpcPaymentBackend {
    client: reqwest::Client,
    rpc_url: Url,
    public_address: String,
}

impl WalletRpcPaymentBackend {
    pub async fn connect(config: &PaymentConfig) -> Result<Self> {
        let rpc_url = local_rpc_url(&config.wallet_rpc_url)?;
        let mut raw_view_key = read_secret(&config.private_view_key_file)?;
        let wallet_password = read_secret(&config.wallet_password_file)?;
        let public_address = validate_view_key(&config.public_address, raw_view_key.trim())?;
        let backend = Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            rpc_url,
            public_address,
        };

        backend
            .rpc::<Value>("get_version", json!({}))
            .await
            .context("connect to loopback monero-wallet-rpc")?;

        if backend.current_address().await.is_err() {
            let opened = backend
                .rpc::<Value>(
                    "open_wallet",
                    json!({
                        "filename": config.wallet_filename,
                        "password": wallet_password.as_str(),
                    }),
                )
                .await;
            if opened.is_err() {
                backend
                    .rpc::<Value>(
                        "generate_from_keys",
                        json!({
                            "restore_height": config.restore_height,
                            "filename": config.wallet_filename,
                            "address": backend.public_address,
                            "spendkey": "",
                            "viewkey": raw_view_key.trim(),
                            "password": wallet_password.as_str(),
                            "autosave_current": true,
                        }),
                    )
                    .await
                    .context("open or create the view-only payment wallet")?;
            }
        }
        raw_view_key.zeroize();

        let opened_address = backend.current_address().await?;
        if opened_address != backend.public_address {
            bail!("monero-wallet-rpc opened a different payment wallet");
        }
        Ok(backend)
    }

    async fn current_address(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct GetAddressResult {
            address: String,
        }
        Ok(self
            .rpc::<GetAddressResult>("get_address", json!({}))
            .await?
            .address)
    }

    async fn rpc<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        #[derive(Deserialize)]
        struct RpcError {
            code: i64,
            message: String,
        }
        #[derive(Deserialize)]
        struct RpcResponse<T> {
            result: Option<T>,
            error: Option<RpcError>,
        }

        let response = self
            .client
            .post(self.rpc_url.clone())
            .json(
                &json!({"jsonrpc": "2.0", "id": "mfw-vanity", "method": method, "params": params}),
            )
            .send()
            .await
            .with_context(|| format!("call monero-wallet-rpc method {method}"))?
            .error_for_status()
            .with_context(|| format!("HTTP failure from monero-wallet-rpc method {method}"))?
            .json::<RpcResponse<T>>()
            .await
            .with_context(|| format!("decode monero-wallet-rpc method {method}"))?;
        if let Some(error) = response.error {
            bail!(
                "monero-wallet-rpc method {method} failed ({}): {}",
                error.code,
                error.message
            );
        }
        response
            .result
            .ok_or_else(|| anyhow!("monero-wallet-rpc method {method} returned no result"))
    }
}

#[async_trait]
impl PaymentBackend for WalletRpcPaymentBackend {
    async fn invoice_address(&self, payment_id: &str) -> Result<String> {
        if payment_id.len() != 16 || !payment_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("payment ID must be exactly 8 bytes in hexadecimal");
        }
        #[derive(Deserialize)]
        struct IntegratedAddressResult {
            integrated_address: String,
        }
        let integrated_address = self
            .rpc::<IntegratedAddressResult>(
                "make_integrated_address",
                json!({
                    "standard_address": self.public_address,
                    "payment_id": payment_id,
                }),
            )
            .await?
            .integrated_address;
        verify_invoice_address(&self.public_address, payment_id, &integrated_address)?;
        Ok(integrated_address)
    }

    async fn poll(&self, payment_ids: &[String]) -> Result<Vec<PaymentObservation>> {
        if payment_ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Deserialize)]
        struct HeightResult {
            height: u64,
        }
        #[derive(Deserialize, Default)]
        struct BulkPaymentsResult {
            #[serde(default)]
            payments: Vec<RpcPayment>,
        }
        #[derive(Deserialize)]
        struct RpcPayment {
            payment_id: String,
            tx_hash: String,
            amount: u64,
            block_height: u64,
            #[serde(default)]
            locked: bool,
        }

        self.rpc::<Value>("refresh", json!({})).await?;
        let wallet_height = self
            .rpc::<HeightResult>("get_height", json!({}))
            .await?
            .height;
        let mut observations = Vec::new();
        for chunk in payment_ids.chunks(100) {
            let response = self
                .rpc::<BulkPaymentsResult>(
                    "get_bulk_payments",
                    json!({"payment_ids": chunk, "min_block_height": 0}),
                )
                .await?;
            observations.extend(
                response
                    .payments
                    .into_iter()
                    .map(|payment| PaymentObservation {
                        payment_id: payment.payment_id,
                        tx_hash: payment.tx_hash,
                        amount_atomic: payment.amount,
                        block_height: payment.block_height,
                        confirmations: wallet_height.saturating_sub(payment.block_height),
                        unlocked: !payment.locked,
                    }),
            );
        }
        Ok(observations)
    }
}

fn local_rpc_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).context("parse MFW_VANITY_WALLET_RPC_URL")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
    {
        bail!("monero-wallet-rpc must use loopback HTTP so the private view key never leaves the host");
    }
    Ok(url)
}

fn read_secret(path: &std::path::Path) -> Result<Zeroizing<String>> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("read secret-file metadata {}", path.display()))?;
    if !metadata.is_file() {
        bail!("secret path {} is not a regular file", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!(
                "secret file {} must use permissions 0600 or stricter",
                path.display()
            );
        }
    }
    let value = Zeroizing::new(
        fs::read_to_string(path).with_context(|| format!("read secret file {}", path.display()))?,
    );
    if value.trim().is_empty() {
        bail!("secret file {} is empty", path.display());
    }
    Ok(value)
}

fn validate_view_key(public_address: &str, raw_view_key: &str) -> Result<String> {
    if public_address.trim() != public_address || public_address.len() != 95 {
        bail!("payment address must be a standard 95-character Monero mainnet address");
    }
    let address = MoneroAddress::from_str(Network::Mainnet, public_address)
        .map_err(|_| anyhow!("invalid Monero payment address"))?;
    if *address.kind() != MoneroAddressType::Legacy {
        bail!("payment address must be a standard Monero primary address");
    }
    let decoded = Zeroizing::new(hex::decode(raw_view_key).context("decode private view key")?);
    if decoded.len() != 32 {
        bail!("private view key must contain exactly 32 bytes");
    }
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(decoded.as_slice());
    let mut scalar = Option::<Scalar>::from(Scalar::from_canonical_bytes(bytes))
        .ok_or_else(|| anyhow!("private view key is not a canonical Monero scalar"))?;
    bytes.zeroize();
    let matches = ED25519_BASEPOINT_POINT * scalar == address.view();
    scalar.zeroize();
    if !matches {
        bail!("private view key does not belong to the configured payment address");
    }
    Ok(public_address.to_owned())
}

fn verify_invoice_address(
    public_address: &str,
    payment_id: &str,
    integrated_address: &str,
) -> Result<()> {
    let base = MoneroAddress::from_str(Network::Mainnet, public_address)
        .map_err(|_| anyhow!("invalid configured payment address"))?;
    let invoice = MoneroAddress::from_str(Network::Mainnet, integrated_address)
        .map_err(|_| anyhow!("monero-wallet-rpc returned an invalid integrated address"))?;
    let expected_payment_id = hex::decode(payment_id).context("decode payment ID")?;
    if invoice.kind()
        != &MoneroAddressType::LegacyIntegrated(expected_payment_id.as_slice().try_into()?)
        || invoice.spend() != base.spend()
        || invoice.view() != base.view()
    {
        bail!("monero-wallet-rpc returned an invoice address that does not match the configured wallet");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;

    #[test]
    fn view_key_must_match_the_public_payment_address() {
        let spend = Scalar::from(7_u64);
        let view = Scalar::from(11_u64);
        let address = MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            ED25519_BASEPOINT_POINT * spend,
            ED25519_BASEPOINT_POINT * view,
        )
        .to_string();
        assert!(validate_view_key(&address, &hex::encode(view.to_bytes())).is_ok());
        assert!(
            validate_view_key(&address, &hex::encode(Scalar::from(12_u64).to_bytes())).is_err()
        );
    }

    #[test]
    fn remote_wallet_rpc_is_rejected() {
        assert!(local_rpc_url("http://127.0.0.1:18083/json_rpc").is_ok());
        assert!(local_rpc_url("https://wallet.example/json_rpc").is_err());
    }
}
