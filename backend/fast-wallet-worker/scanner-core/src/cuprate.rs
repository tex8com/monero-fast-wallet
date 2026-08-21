//! MFN block and mempool sources consumed by the outbound Worker.

use crate::{
    model::{Network, WatchRegistration},
    scanner::{
        BlockSource, MatchedOutputCandidate, MempoolOutputMatcher, MempoolSource, OutputMatcher,
        ScannedBlock, ScannedMempoolTx, ScannedOutput,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use cuprate_rpc_types::bin::GetBlocksResponse;
use cuprate_types::{rpc::BlockOutputIndices, BlockCompleteEntry, TransactionBlobs};
use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, edwards::EdwardsPoint, Scalar};
use monero_address::{MoneroAddress, Network as MoneroAddressNetwork};
use monero_oxide::{
    block::{Block, BlockHeader},
    transaction::{Input, NotPruned, Pruned, Timelock, Transaction, TransactionPrefix},
};
use monero_rpc::ScannableBlock;
use monero_wallet::{Scanner, ViewPair};
use serde::Deserialize;
use std::time::Duration;
use tonic::transport::Endpoint;
use zeroize::Zeroizing;

mod grpc {
    tonic::include_proto!("cuprate.stream.v1");
}

use grpc::{block_stream_client::BlockStreamClient, StreamBlocksRequest};

const DEFAULT_GRPC_CHUNK_BLOCKS: u32 = 200;
const MAX_GRPC_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MEMPOOL_TIMEOUT_SECS: u64 = 10;
const DEFAULT_HTTP_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedCuprateBlocks {
    pub start_height: u64,
    pub current_height: u64,
    pub blocks: Vec<ScannedBlock>,
}

pub struct CuprateGrpcBlockSource {
    endpoint: String,
    chunk_blocks_hint: u32,
    runtime: tokio::runtime::Runtime,
}

impl CuprateGrpcBlockSource {
    pub fn new(endpoint: impl Into<String>) -> Result<Self> {
        Self::new_with_chunk_blocks_hint(endpoint, DEFAULT_GRPC_CHUNK_BLOCKS)
    }

    pub fn new_with_chunk_blocks_hint(
        endpoint: impl Into<String>,
        chunk_blocks_hint: u32,
    ) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("failed to create Cuprate gRPC block-source runtime")?;
        Ok(Self {
            endpoint: normalize_grpc_endpoint(&endpoint.into())?,
            chunk_blocks_hint,
            runtime,
        })
    }

    async fn fetch_blocks(
        endpoint: String,
        from_height_exclusive: u64,
        max_blocks: usize,
        chunk_blocks_hint: u32,
    ) -> Result<Vec<ScannedBlock>> {
        if max_blocks == 0 {
            return Ok(vec![]);
        }

        let start_height = from_height_exclusive
            .checked_add(1)
            .context("start height overflow")?;
        let stop_height = start_height
            .checked_add(u64::try_from(max_blocks).context("max block count exceeded u64")?)
            .and_then(|height_after_end| height_after_end.checked_sub(1))
            .context("stop height overflow")?;

        let endpoint = Endpoint::from_shared(endpoint)?.connect().await?;
        let mut client = BlockStreamClient::new(endpoint)
            .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES);
        let request = StreamBlocksRequest {
            start_height,
            stop_height,
            // Hosted ownership detection needs the transaction prefix and
            // RingCT base, not the large prunable proof payload.
            prune: true,
            chunk_blocks_hint,
            no_miner_tx: false,
            client_request_id: format!("fast-wallet-worker-{start_height}-{stop_height}"),
            chain_locator: Vec::new(),
            // The sequential StreamBlocks RPC ignores lane fields. Keep
            // their explicit protobuf defaults so this client remains
            // source-compatible with the shared lane-capable request.
            stripe_span_blocks: 0,
            lane_index: 0,
            lane_count: 0,
        };
        let mut stream = client.stream_blocks(request).await?.into_inner();
        let mut blocks = Vec::with_capacity(max_blocks);

        while let Some(chunk) = stream.message().await? {
            let decoded = decode_get_blocks_payload(&chunk.payload)
                .with_context(|| format!("failed to decode gRPC chunk {}", chunk.chunk_seq))?;
            if decoded.start_height != chunk.start_height {
                bail!(
                    "gRPC chunk start mismatch: envelope={} payload={}",
                    chunk.start_height,
                    decoded.start_height
                );
            }
            blocks.extend(decoded.blocks);
            if blocks.len() >= max_blocks {
                blocks.truncate(max_blocks);
                break;
            }
        }

        Ok(blocks)
    }
}

impl BlockSource for CuprateGrpcBlockSource {
    fn next_blocks(
        &mut self,
        _network: Network,
        from_height_exclusive: u64,
        max_blocks: usize,
    ) -> Result<Vec<ScannedBlock>> {
        self.runtime.block_on(Self::fetch_blocks(
            self.endpoint.clone(),
            from_height_exclusive,
            max_blocks,
            self.chunk_blocks_hint,
        ))
    }

    fn canonical_block_hash(&mut self, network: Network, height: u64) -> Result<Option<String>> {
        if height == 0 {
            return Ok(None);
        }
        Ok(self
            .next_blocks(network, height - 1, 1)?
            .into_iter()
            .find(|block| block.height == height)
            .map(|block| block.hash))
    }
}

pub struct CuprateHttpMempoolSource {
    endpoint: String,
    agent: ureq::Agent,
}

impl CuprateHttpMempoolSource {
    pub fn new(endpoint: impl Into<String>) -> Result<Self> {
        Self::new_with_timeout(endpoint, Duration::from_secs(DEFAULT_MEMPOOL_TIMEOUT_SECS))
    }

    pub fn new_with_timeout(endpoint: impl Into<String>, timeout: Duration) -> Result<Self> {
        Ok(Self {
            endpoint: normalize_http_endpoint(&endpoint.into())?,
            agent: ureq::AgentBuilder::new().timeout(timeout).build(),
        })
    }

    fn fetch_current_transactions(&self) -> Result<Vec<ScannedMempoolTx>> {
        let url = format!("{}/get_transaction_pool", self.endpoint);
        let body = post_json_with_retries(&self.agent, &url, "{}")
            .with_context(|| format!("failed to read Cuprate txpool snapshot from {url}"))?;
        decode_mempool_response(&body)
    }
}

impl MempoolSource for CuprateHttpMempoolSource {
    fn current_transactions(&mut self, _network: Network) -> Result<Vec<ScannedMempoolTx>> {
        self.fetch_current_transactions()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostedViewKeyBlockMatcher;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostedViewKeyMempoolMatcher;

impl OutputMatcher for HostedViewKeyBlockMatcher {
    fn match_block(
        &self,
        watch: &WatchRegistration,
        block: &ScannedBlock,
    ) -> Result<Vec<MatchedOutputCandidate>> {
        let scannable_block = block.scannable_block.as_ref().ok_or_else(|| {
            anyhow!(
                "block {} has no monero scannable payload; use Cuprate block decoding for hosted view-key scanning",
                block.height
            )
        })?;
        let view_pair = view_pair_from_watch(watch)?;
        let mut scanner = Scanner::new(view_pair);
        let outputs = scanner
            .scan((**scannable_block).clone())
            .with_context(|| format!("failed to scan block {}", block.height))?
            .ignore_additional_timelock();

        Ok(outputs
            .into_iter()
            .map(|output| MatchedOutputCandidate {
                tx_id: hex::encode(output.transaction()),
                output_index: output.index_in_transaction(),
            })
            .collect())
    }
}

impl MempoolOutputMatcher for HostedViewKeyMempoolMatcher {
    fn match_mempool_tx(
        &self,
        watch: &WatchRegistration,
        tx: &ScannedMempoolTx,
    ) -> Result<Vec<MatchedOutputCandidate>> {
        let scannable_block = tx.scannable_block.as_ref().ok_or_else(|| {
            anyhow!(
                "mempool transaction has no scannable payload; use Cuprate txpool decoding for hosted mempool scanning"
            )
        })?;
        let view_pair = view_pair_from_watch(watch)?;
        let mut scanner = Scanner::new(view_pair);
        let outputs = scanner
            .scan((**scannable_block).clone())
            .context("failed to scan mempool transaction")?
            .ignore_additional_timelock();

        Ok(outputs
            .into_iter()
            .map(|output| MatchedOutputCandidate {
                tx_id: hex::encode(output.transaction()),
                output_index: output.index_in_transaction(),
            })
            .collect())
    }
}

pub fn decode_get_blocks_payload(payload: &[u8]) -> Result<DecodedCuprateBlocks> {
    let mut bytes = Bytes::copy_from_slice(payload);
    let response: GetBlocksResponse = cuprate_epee_encoding::from_bytes(&mut bytes)
        .context("failed to decode Cuprate Epee GetBlocksResponse")?;
    decode_get_blocks_response(response)
}

pub fn decode_get_blocks_response(response: GetBlocksResponse) -> Result<DecodedCuprateBlocks> {
    let blocks = decode_block_entries(
        response.start_height,
        &response.blocks,
        &response.output_indices,
    )?;

    Ok(DecodedCuprateBlocks {
        start_height: response.start_height,
        current_height: response.current_height,
        blocks,
    })
}

pub(crate) fn decode_block_entries(
    start_height: u64,
    entries: &[BlockCompleteEntry],
    output_indices: &[BlockOutputIndices],
) -> Result<Vec<ScannedBlock>> {
    if entries.len() != output_indices.len() {
        bail!(
            "block/output-index count mismatch: blocks={} indices={}",
            entries.len(),
            output_indices.len()
        );
    }
    let mut blocks = Vec::with_capacity(entries.len());

    for (offset, entry) in entries.iter().enumerate() {
        let height_offset = u64::try_from(offset).context("block offset exceeded u64")?;
        let height = start_height
            .checked_add(height_offset)
            .context("block height overflow")?;
        let block_indices = output_indices.get(offset);
        blocks.push(decode_block_entry(height, entry, block_indices)?);
    }

    Ok(blocks)
}

pub fn decode_mempool_transaction_blob(
    tx_hash: [u8; 32],
    received_unix_secs: u64,
    tx_blob: &[u8],
) -> Result<ScannedMempoolTx> {
    let tx = read_full_transaction(tx_blob).context("failed to parse mempool transaction")?;
    let actual_hash = tx.hash();
    if actual_hash != tx_hash {
        bail!("mempool transaction hash mismatch");
    }

    Ok(ScannedMempoolTx {
        tx_id: hex::encode(tx_hash),
        received_ms: received_unix_secs.saturating_mul(1000),
        outputs: scanned_outputs_for_transaction(tx_hash, tx.prefix())?,
        scannable_block: Some(Box::new(scannable_block_for_mempool_tx(
            tx_hash,
            received_unix_secs,
            tx,
        )?)),
    })
}

fn decode_mempool_response(body: &str) -> Result<Vec<ScannedMempoolTx>> {
    let response: TxPoolResponse =
        serde_json::from_str(body).context("failed to parse Cuprate txpool JSON")?;
    response
        .transactions
        .into_iter()
        .map(|tx| {
            let tx_hash = decode_hex_32("id_hash", &tx.id_hash)?;
            let tx_blob = hex::decode(tx.tx_blob.trim()).context("tx_blob is not hex")?;
            decode_mempool_transaction_blob(tx_hash, tx.receive_time, &tx_blob)
        })
        .collect()
}

fn post_json_with_retries(agent: &ureq::Agent, url: &str, body: &str) -> Result<String> {
    let mut last_error = None;
    for attempt in 1..=DEFAULT_HTTP_ATTEMPTS {
        match agent
            .post(url)
            .set("content-type", "application/json")
            .send_string(body)
            .with_context(|| format!("request attempt {attempt}/{DEFAULT_HTTP_ATTEMPTS} failed"))
            .and_then(|response| {
                response.into_string().with_context(|| {
                    format!("body read attempt {attempt}/{DEFAULT_HTTP_ATTEMPTS} failed")
                })
            }) {
            Ok(body) => return Ok(body),
            Err(error) => {
                last_error = Some(error);
                if attempt < DEFAULT_HTTP_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(150 * attempt as u64));
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("request failed without an error")))
}

#[derive(Debug, Deserialize)]
struct TxPoolResponse {
    #[serde(default)]
    transactions: Vec<TxPoolTransaction>,
}

#[derive(Debug, Deserialize)]
struct TxPoolTransaction {
    id_hash: String,
    receive_time: u64,
    tx_blob: String,
}

fn decode_block_entry(
    height: u64,
    entry: &BlockCompleteEntry,
    block_indices: Option<&BlockOutputIndices>,
) -> Result<ScannedBlock> {
    let block = read_block(entry.block.as_ref()).context("failed to parse block blob")?;
    let pruned_txs = match &entry.txs {
        TransactionBlobs::Normal(txs) => {
            if txs.len() != block.transactions.len() {
                bail!(
                    "block {} transaction blob count mismatch: expected {} got {}",
                    height,
                    block.transactions.len(),
                    txs.len()
                );
            }
            let mut parsed = Vec::with_capacity(txs.len());
            for (expected_hash, tx_blob) in block.transactions.iter().zip(txs.iter()) {
                let tx = read_full_transaction(tx_blob.as_ref())
                    .context("failed to parse block transaction")?;
                if &tx.hash() != expected_hash {
                    bail!("block {} transaction hash mismatch", height);
                }
                parsed.push(Transaction::<Pruned>::from(tx));
            }
            parsed
        }
        TransactionBlobs::Pruned(txs) => {
            if txs.len() != block.transactions.len() {
                bail!(
                    "block {} pruned transaction blob count mismatch: expected {} got {}",
                    height,
                    block.transactions.len(),
                    txs.len()
                );
            }
            txs.iter()
                .map(|tx| {
                    read_pruned_transaction(tx.blob.as_ref())
                        .context("failed to parse pruned block transaction")
                })
                .collect::<Result<Vec<_>>>()?
        }
        TransactionBlobs::None if block.transactions.is_empty() => Vec::new(),
        TransactionBlobs::None => {
            bail!(
                "block {} has transaction hashes but no transaction blobs",
                height
            )
        }
    };

    build_scanned_block(height, block, pruned_txs, block_indices)
}

fn build_scanned_block(
    height: u64,
    block: Block,
    pruned_txs: Vec<Transaction<Pruned>>,
    block_indices: Option<&BlockOutputIndices>,
) -> Result<ScannedBlock> {
    if pruned_txs.len() != block.transactions.len() {
        bail!(
            "block {} parsed transaction count mismatch: expected {} got {}",
            height,
            block.transactions.len(),
            pruned_txs.len()
        );
    }

    let mut outputs = scanned_outputs_for_transaction(
        block.miner_transaction().hash(),
        block.miner_transaction().prefix(),
    )?;
    for (tx_hash, tx) in block.transactions.iter().zip(&pruned_txs) {
        outputs.extend(scanned_outputs_for_transaction(*tx_hash, tx.prefix())?);
    }

    let first_ringct_index = first_ringct_output_index(&block, &pruned_txs, block_indices)?;
    let scannable_block = ScannableBlock {
        block: block.clone(),
        transactions: pruned_txs,
        output_index_for_first_ringct_output: first_ringct_index,
    };

    Ok(ScannedBlock {
        height,
        hash: hex::encode(block.hash()),
        timestamp_ms: block.header.timestamp.saturating_mul(1000),
        outputs,
        scannable_block: Some(Box::new(scannable_block)),
    })
}

fn read_block(blob: &[u8]) -> Result<Block> {
    let mut reader = blob;
    let block = Block::read(&mut reader)?;
    if !reader.is_empty() {
        bail!("block blob has {} trailing bytes", reader.len());
    }
    Ok(block)
}

fn read_full_transaction(blob: &[u8]) -> Result<Transaction<NotPruned>> {
    let mut reader = blob;
    let tx = Transaction::<NotPruned>::read(&mut reader)?;
    if !reader.is_empty() {
        bail!("transaction blob has {} trailing bytes", reader.len());
    }
    Ok(tx)
}

fn read_pruned_transaction(blob: &[u8]) -> Result<Transaction<Pruned>> {
    let mut reader = blob;
    let tx = Transaction::<Pruned>::read(&mut reader)?;
    if !reader.is_empty() {
        bail!(
            "pruned transaction blob has {} trailing bytes",
            reader.len()
        );
    }
    Ok(tx)
}

fn scanned_outputs_for_transaction(
    tx_hash: [u8; 32],
    prefix: &TransactionPrefix,
) -> Result<Vec<ScannedOutput>> {
    let tx_id = hex::encode(tx_hash);
    prefix
        .outputs
        .iter()
        .enumerate()
        .map(|(index, output)| {
            Ok(ScannedOutput {
                tx_id: tx_id.clone(),
                output_index: u64::try_from(index).context("output index exceeded u64")?,
                output_public_key: hex::encode(output.key.to_bytes()),
                view_tag: output.view_tag.map(|tag| format!("{tag:02x}")),
            })
        })
        .collect()
}

fn scannable_block_for_mempool_tx(
    tx_hash: [u8; 32],
    received_unix_secs: u64,
    tx: Transaction<NotPruned>,
) -> Result<ScannableBlock> {
    let miner_transaction = Transaction::V1 {
        prefix: TransactionPrefix {
            additional_timelock: Timelock::None,
            inputs: vec![Input::Gen(0)],
            outputs: vec![],
            extra: vec![],
        },
        signatures: vec![],
    };
    let block = Block::new(
        BlockHeader {
            hardfork_version: 16,
            hardfork_signal: 16,
            timestamp: received_unix_secs,
            previous: [0; 32],
            nonce: 0,
        },
        miner_transaction,
        vec![tx_hash],
    )
    .ok_or_else(|| anyhow!("failed to build synthetic mempool scannable block"))?;

    Ok(ScannableBlock {
        block,
        transactions: vec![Transaction::<Pruned>::from(tx)],
        output_index_for_first_ringct_output: Some(0),
    })
}

fn first_ringct_output_index(
    block: &Block,
    txs: &[Transaction<Pruned>],
    block_indices: Option<&BlockOutputIndices>,
) -> Result<Option<u64>> {
    if let Some(index) =
        first_ringct_output_index_in_tx(0, block.miner_transaction().prefix(), block_indices)?
    {
        return Ok(Some(index));
    }

    for (tx_offset, tx) in txs.iter().enumerate() {
        let tx_position = tx_offset
            .checked_add(1)
            .context("transaction position overflow")?;
        if let Some(index) =
            first_ringct_output_index_in_tx(tx_position, tx.prefix(), block_indices)?
        {
            return Ok(Some(index));
        }
    }

    Ok(None)
}

fn first_ringct_output_index_in_tx(
    tx_position: usize,
    prefix: &TransactionPrefix,
    block_indices: Option<&BlockOutputIndices>,
) -> Result<Option<u64>> {
    for (output_index, output) in prefix.outputs.iter().enumerate() {
        if output.amount.is_some() {
            continue;
        }
        let block_indices = block_indices
            .ok_or_else(|| anyhow!("missing output indices for RingCT transaction"))?;
        let tx_indices = block_indices.indices.get(tx_position).ok_or_else(|| {
            anyhow!("missing output index entry for transaction position {tx_position}")
        })?;
        let absolute_index = tx_indices.indices.get(output_index).ok_or_else(|| {
            anyhow!(
                "missing output index entry for transaction position {tx_position}, output {output_index}"
            )
        })?;
        return Ok(Some(*absolute_index));
    }

    Ok(None)
}

fn view_pair_from_watch(watch: &WatchRegistration) -> Result<ViewPair> {
    let (spend, private_view) = validated_hosted_keys(watch)?;
    ViewPair::new(spend, private_view).context("invalid hosted view pair")
}

pub(crate) fn validated_hosted_keys(
    watch: &WatchRegistration,
) -> Result<(EdwardsPoint, Zeroizing<Scalar>)> {
    let address = MoneroAddress::from_str(monero_address_network(watch.network), &watch.address)
        .context("invalid hosted address")?;
    let private_view = Zeroizing::new(parse_private_view_key(&watch.private_view_key)?);
    if &*private_view * ED25519_BASEPOINT_TABLE != address.view() {
        bail!("private view key does not match hosted address public view key");
    }
    Ok((address.spend(), private_view))
}

fn parse_private_view_key(value: &str) -> Result<Scalar> {
    let decoded = hex::decode(value.trim()).context("private view key is not hex")?;
    let bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| anyhow!("private view key must be 32 bytes"))?;
    let scalar = Option::<Scalar>::from(Scalar::from_canonical_bytes(bytes))
        .ok_or_else(|| anyhow!("private view key is not a canonical scalar"))?;
    if scalar == Scalar::ZERO {
        bail!("private view key must not be zero");
    }
    Ok(scalar)
}

fn decode_hex_32(name: &str, value: &str) -> Result<[u8; 32]> {
    let decoded = hex::decode(value.trim()).with_context(|| format!("{name} is not hex"))?;
    decoded
        .try_into()
        .map_err(|_| anyhow!("{name} must be 32 bytes"))
}

fn normalize_grpc_endpoint(value: &str) -> Result<String> {
    normalize_endpoint(value, "http")
}

fn normalize_http_endpoint(value: &str) -> Result<String> {
    normalize_endpoint(value, "http")
}

fn normalize_endpoint(value: &str, default_scheme: &str) -> Result<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        bail!("Cuprate endpoint must not be empty");
    }
    if trimmed.contains("://") {
        Ok(trimmed.to_owned())
    } else {
        Ok(format!("{default_scheme}://{trimmed}"))
    }
}

fn monero_address_network(network: Network) -> MoneroAddressNetwork {
    match network {
        Network::Mainnet => MoneroAddressNetwork::Mainnet,
        Network::Testnet => MoneroAddressNetwork::Testnet,
        Network::Stagenet => MoneroAddressNetwork::Stagenet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{BlockSource, MempoolSource};
    use cuprate_rpc_types::base::AccessResponseBase;
    use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
    use std::env;

    fn test_watch(private_view: Scalar, network: Network) -> WatchRegistration {
        let spend = &Scalar::from(7_u64) * ED25519_BASEPOINT_TABLE;
        let pair = ViewPair::new(spend, Zeroizing::new(private_view)).unwrap();
        let address = pair
            .legacy_address(monero_address_network(network))
            .to_string();

        WatchRegistration {
            identity_id: "identity-a".to_owned(),
            address,
            private_view_key: hex::encode(private_view.to_bytes()),
            management_token_hash: "0".repeat(64),
            network,
            restore_height: 1,
            push_token: None,
            device_id: None,
            worker_assignment_epoch: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 0,
            last_scanned_hash: None,
        }
    }

    #[test]
    fn decodes_empty_cuprate_get_blocks_payload() {
        let response = GetBlocksResponse {
            base: AccessResponseBase::OK,
            blocks: vec![],
            start_height: 9,
            current_height: 10,
            output_indices: vec![],
            daemon_time: 123,
            pool_info_extent: 0,
            added_pool_txs: vec![],
            remaining_added_pool_txids: Default::default(),
            removed_pool_txids: Default::default(),
        };
        let payload = cuprate_epee_encoding::to_bytes(response).unwrap();
        let decoded = decode_get_blocks_payload(&payload).unwrap();

        assert_eq!(decoded.start_height, 9);
        assert_eq!(decoded.current_height, 10);
        assert!(decoded.blocks.is_empty());
    }

    #[test]
    fn rejects_invalid_cuprate_get_blocks_payload() {
        let error = decode_get_blocks_payload(b"not-epee").unwrap_err();
        assert!(error
            .to_string()
            .contains("failed to decode Cuprate Epee GetBlocksResponse"));
    }

    #[test]
    fn normalizes_cuprate_endpoints() {
        assert_eq!(
            normalize_grpc_endpoint("127.0.0.1:48091").unwrap(),
            "http://127.0.0.1:48091"
        );
        assert_eq!(
            normalize_http_endpoint("http://tex8.com:18089/").unwrap(),
            "http://tex8.com:18089"
        );
        assert!(normalize_http_endpoint(" ").is_err());
    }

    #[test]
    fn decodes_empty_mempool_response() {
        let txs = decode_mempool_response(
            r#"{
                "credits": 0,
                "spent_key_images": [],
                "transactions": [],
                "status": "OK",
                "untrusted": false
            }"#,
        )
        .unwrap();

        assert!(txs.is_empty());
    }

    #[test]
    fn hosted_view_key_validation_accepts_matching_address_and_key() {
        let watch = test_watch(Scalar::from(11_u64), Network::Mainnet);
        view_pair_from_watch(&watch).unwrap();
    }

    #[test]
    fn hosted_view_key_validation_rejects_mismatched_key() {
        let mut watch = test_watch(Scalar::from(11_u64), Network::Mainnet);
        watch.private_view_key = hex::encode(Scalar::from(12_u64).to_bytes());

        let error = match view_pair_from_watch(&watch) {
            Ok(_) => panic!("mismatched private view key was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn hosted_matcher_requires_scannable_block() {
        let watch = test_watch(Scalar::from(11_u64), Network::Mainnet);
        let block = ScannedBlock {
            height: 1,
            hash: "00".repeat(32),
            timestamp_ms: 1000,
            outputs: vec![],
            scannable_block: None,
        };

        let error = HostedViewKeyBlockMatcher
            .match_block(&watch, &block)
            .unwrap_err();
        assert!(error.to_string().contains("no monero scannable payload"));
    }

    #[test]
    fn hosted_mempool_matcher_requires_scannable_payload() {
        let watch = test_watch(Scalar::from(11_u64), Network::Mainnet);
        let tx = ScannedMempoolTx {
            tx_id: "00".repeat(32),
            received_ms: 1000,
            outputs: vec![],
            scannable_block: None,
        };

        let error = HostedViewKeyMempoolMatcher
            .match_mempool_tx(&watch, &tx)
            .unwrap_err();
        assert!(error.to_string().contains("no scannable payload"));
    }

    #[test]
    #[ignore = "requires live Cuprate gRPC endpoint"]
    fn live_cuprate_grpc_source_fetches_block() {
        let endpoint = env::var("FAST_WALLET_SCANNER_CORE_TEST_GRPC_ENDPOINT")
            .unwrap_or_else(|_| "127.0.0.1:48091".to_owned());
        let from_height_exclusive = env::var("FAST_WALLET_SCANNER_CORE_TEST_FROM_HEIGHT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3_000_000);
        let mut source = CuprateGrpcBlockSource::new_with_chunk_blocks_hint(endpoint, 1).unwrap();

        let blocks =
            BlockSource::next_blocks(&mut source, Network::Mainnet, from_height_exclusive, 1)
                .unwrap();

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].height, from_height_exclusive + 1);
        assert!(blocks[0].scannable_block.is_some());
    }

    #[test]
    #[ignore = "requires live Cuprate RPC endpoint"]
    fn live_cuprate_txpool_source_decodes_snapshot() {
        let endpoint = env::var("FAST_WALLET_SCANNER_CORE_TEST_RPC_ENDPOINT")
            .unwrap_or_else(|_| "xmr.tex8.com:18089".to_owned());
        let mut source = CuprateHttpMempoolSource::new(endpoint).unwrap();

        let txs = MempoolSource::current_transactions(&mut source, Network::Mainnet).unwrap();

        assert!(txs.iter().all(|tx| tx.tx_id.len() == 64));
        assert!(txs.iter().all(|tx| tx.scannable_block.is_some()));
    }
}
