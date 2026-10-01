use crate::{
    loopback_url, parse_transaction, Chain, Notify, Resolution, Status, TransactionEvidence,
};
use anyhow::{ensure, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

pub struct RpcChain {
    client: reqwest::Client,
    origin: reqwest::Url,
}
impl RpcChain {
    pub fn new(origin: &str) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
            origin: daemon_origin(origin)?,
        })
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        limited_json(
            self.client
                .post(self.origin.join(path)?)
                .json(&body)
                .send()
                .await?,
        )
        .await
    }
}

/// Operator-configured local/WireGuard daemon only; never a client URL or DNS
/// name. Some installations bind restricted RPC to their private interface.
fn daemon_origin(value: &str) -> Result<reqwest::Url> {
    if let Ok(url) = loopback_url(value) {
        return Ok(url);
    }
    let url = reqwest::Url::parse(value)?;
    let ip: std::net::Ipv4Addr = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("missing daemon host"))?
        .parse()?;
    ensure!(
        ip.is_private()
            && url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "fixed private daemon origin required"
    );
    Ok(url)
}

async fn limited_json(mut response: reqwest::Response) -> Result<Value> {
    ensure!(response.status().is_success(), "upstream unavailable");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 1024 * 1024,
            "upstream response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[async_trait]
impl Chain for RpcChain {
    async fn height(&self) -> Result<u64> {
        let info = self.post("get_info", json!({})).await?;
        ensure!(
            info["status"] == "OK"
                && info["synchronized"] == true
                && info["mainnet"] == true
                && info["untrusted"] != true,
            "daemon not synchronized on mainnet"
        );
        let response = self.post("get_height", json!({})).await?;
        ensure!(
            response["status"] == "OK" && response["untrusted"] != true,
            "untrusted height"
        );
        response["height"]
            .as_u64()
            .filter(|h| *h > 0)
            .ok_or_else(|| anyhow::anyhow!("height missing"))
    }
    async fn transaction(&self, txid: &str) -> Result<Option<TransactionEvidence>> {
        let response = self
            .post(
                "get_transactions",
                json!({"txs_hashes":[txid], "decode_as_json":false, "prune":false}),
            )
            .await?;
        ensure!(
            response["status"] == "OK" && response["untrusted"] != true,
            "untrusted transaction response"
        );
        let txs = response["txs"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("transactions missing"))?;
        if txs.is_empty() {
            return Ok(None);
        }
        ensure!(
            txs.len() == 1 && response["txs"][0]["tx_hash"] == txid,
            "transaction mismatch"
        );
        let tx = &txs[0];
        let raw = tx["as_hex"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("full transaction missing"))?
            .to_owned();
        ensure!(
            hex::encode(parse_transaction(&raw)?.hash()) == txid,
            "transaction hash mismatch"
        );
        let in_pool = tx["in_pool"]
            .as_bool()
            .ok_or_else(|| anyhow::anyhow!("pool flag missing"))?;
        let height = if in_pool {
            None
        } else {
            Some(
                tx["block_height"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("block height missing"))?,
            )
        };
        Ok(Some(TransactionEvidence { raw, height }))
    }
    async fn resolve(&self, name: &str) -> Result<Resolution> {
        let response = limited_json(
            self.client
                .get(self.origin.join(&format!("v1/mfw/names/{name}"))?)
                .send()
                .await?,
        )
        .await?;
        ensure!(
            response["network"] == "mainnet" && response["canonicalName"] == name,
            "resolver mismatch"
        );
        Ok(Resolution {
            finalized: response["status"] == "finalized",
            source_txid: response["sourceTxidHex"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            owner: response["ownerPublicKeyHex"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            tip_height: response["chainTipHeight"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("resolver height missing"))?,
        })
    }
    async fn broadcast(&self, raw: &str) -> Result<()> {
        let response = self
            .post(
                "send_raw_transaction",
                json!({"tx_as_hex":raw,"do_not_relay":false,"do_sanity_checks":true}),
            )
            .await?;
        ensure!(
            response["status"] == "OK" && response["not_relayed"] != true,
            "broadcast not acknowledged"
        );
        Ok(())
    }
}

pub struct GatewayNotify {
    client: reqwest::Client,
    origin: reqwest::Url,
    secret: zeroize::Zeroizing<String>,
}
impl GatewayNotify {
    pub fn new(origin: &str, secret: String) -> Result<Self> {
        ensure!(crate::hex_id(&secret, 64), "invalid notification secret");
        Ok(Self {
            origin: loopback_url(origin)?,
            secret: zeroize::Zeroizing::new(secret),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
        })
    }
}
#[async_trait]
impl Notify for GatewayNotify {
    async fn send(&self, installation: &str, status: &Status) -> Result<()> {
        use sha2::{Digest, Sha256};
        let event = hex::encode(Sha256::digest(format!(
            "mfw-claim:{}:{:?}",
            status.job_id, status.state
        )));
        let response = self.client.post(self.origin.join("api/v1/internal/mfw-claim-event")?)
            .header("x-mfw-claim-service-auth", self.secret.as_str())
            .json(&json!({"installationId":installation,"eventId":format!("evt_{event}"),"jobId":status.job_id}))
            .send().await?;
        ensure!(
            response.status().is_success(),
            "notification enqueue failed"
        );
        Ok(())
    }
}
