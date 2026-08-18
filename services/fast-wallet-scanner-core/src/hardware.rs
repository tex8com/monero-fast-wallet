//! Hardware-aware hosted-view-key matching for the outbound Worker.
//!
//! The `epyc` feature is built against the authenticated Dalek patch set in
//! `third_party/curve25519-dalek-wallet-cpu`. It batches `D = 8 * a * R`
//! derivations with one prepared view scalar and a fixed Rayon worker pool.

use crate::{
    cuprate::validated_hosted_keys,
    model::WatchRegistration,
    scanner::{
        MatchedOutputCandidate, MempoolOutputMatcher, OutputMatcher, ScannedBlock, ScannedMempoolTx,
    },
};
use anyhow::{bail, Context, Result};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_TABLE,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    Scalar,
};
use monero_oxide::{
    io::VarInt,
    primitives::{keccak256, keccak256_to_scalar},
    transaction::{Output, TransactionPrefix},
};
use monero_rpc::ScannableBlock;
use monero_wallet::extra::Extra;
use std::collections::BTreeMap;
#[cfg(feature = "epyc")]
use std::sync::Arc;

#[cfg(feature = "epyc")]
use curve25519_dalek::edwards::{PreparedVariableBaseBatchWorkspace, PreparedVariableBaseScalar};
#[cfg(feature = "epyc")]
use rayon::prelude::*;

#[cfg(feature = "epyc")]
const DERIVATION_BATCH_SIZE: usize = 16;

#[derive(Clone)]
pub struct HardwareHostedViewKeyMatcher {
    workers: usize,
    #[cfg(feature = "epyc")]
    pool: Arc<rayon::ThreadPool>,
}

impl HardwareHostedViewKeyMatcher {
    pub fn new(workers: usize) -> Result<Self> {
        let workers = workers.max(1);
        #[cfg(feature = "epyc")]
        let pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .thread_name(|index| format!("hosted-view-derivation-{index}"))
                .build()
                .context("failed to create hosted-view-key derivation worker pool")?,
        );
        Ok(Self {
            workers,
            #[cfg(feature = "epyc")]
            pool,
        })
    }

    pub fn workers(&self) -> usize {
        self.workers
    }

    pub fn backend_name(&self) -> &'static str {
        #[cfg(all(feature = "epyc", target_arch = "x86_64"))]
        {
            if std::arch::is_x86_feature_detected!("avx512ifma")
                && std::arch::is_x86_feature_detected!("avx512vl")
            {
                return "epyc-dalek-avx512-ifma";
            }
            if std::arch::is_x86_feature_detected!("avx2") {
                return "epyc-dalek-avx2-fallback";
            }
            return "epyc-dalek-serial-fallback";
        }
        #[cfg(all(feature = "epyc", not(target_arch = "x86_64")))]
        {
            "epyc-dalek-portable-fallback"
        }
        #[cfg(not(feature = "epyc"))]
        {
            "portable-reference"
        }
    }

    pub fn block_window_transaction_key_count(&self, blocks: &[ScannedBlock]) -> Result<usize> {
        let scannables = blocks
            .iter()
            .map(|block| {
                block.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "block {} has no Monero scannable payload for hardware matching",
                        block.height
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(prepare_scannables(&scannables)?.points.len())
    }

    pub fn mempool_transaction_key_count(&self, txs: &[ScannedMempoolTx]) -> Result<usize> {
        let scannables = txs
            .iter()
            .map(|tx| {
                tx.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("mempool transaction has no Monero scannable payload")
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(prepare_scannables(&scannables)?.points.len())
    }

    fn match_scannables(
        &self,
        watch: &WatchRegistration,
        scannables: &[&ScannableBlock],
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        let prepared = prepare_scannables(scannables)?;
        self.match_prepared(watch, &prepared, true)
    }

    fn match_scannables_for_watches(
        &self,
        watches: &[WatchRegistration],
        scannables: &[&ScannableBlock],
    ) -> Result<Vec<Vec<Vec<MatchedOutputCandidate>>>> {
        let prepared = prepare_scannables(scannables)?;
        if watches.len() <= 1 {
            return watches
                .iter()
                .map(|watch| self.match_prepared(watch, &prepared, true))
                .collect();
        }

        #[cfg(feature = "epyc")]
        {
            return self.pool.install(|| {
                watches
                    .par_iter()
                    .map(|watch| self.match_prepared(watch, &prepared, false))
                    .collect()
            });
        }
        #[cfg(not(feature = "epyc"))]
        watches
            .iter()
            .map(|watch| self.match_prepared(watch, &prepared, false))
            .collect()
    }

    fn match_prepared(
        &self,
        watch: &WatchRegistration,
        prepared: &PreparedScannables,
        parallelize_points: bool,
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        let (spend, private_view) = validated_hosted_keys(watch)?;
        let mut matches = vec![Vec::new(); prepared.scannable_count];
        if prepared.points.is_empty() {
            return Ok(matches);
        }
        let derivations = if parallelize_points {
            self.derive_points(&private_view, &prepared.points)
        } else {
            self.derive_points_locally(&private_view, &prepared.points)
        };

        for prepared_tx in &prepared.transactions {
            for (output_index, output) in prepared_tx.outputs.iter().enumerate() {
                let Some(output_key) = output.key.decompress() else {
                    continue;
                };
                let additional = prepared_tx
                    .additional
                    .as_ref()
                    .and_then(|keys| keys.get(output_index));
                let key_indices = prepared_tx.primary.iter().chain(additional);

                for key_index in key_indices {
                    let Some(derivation) = derivations[*key_index] else {
                        continue;
                    };
                    let (view_tag, shared_key) = output_derivations(derivation, output_index)?;
                    if output
                        .view_tag
                        .is_some_and(|actual_view_tag| actual_view_tag != view_tag)
                    {
                        continue;
                    }
                    let shared_public = &shared_key * ED25519_BASEPOINT_TABLE;
                    if output_key - shared_public != spend {
                        continue;
                    }
                    matches[prepared_tx.scannable_index].push(MatchedOutputCandidate {
                        tx_id: hex::encode(prepared_tx.tx_hash),
                        output_index: u64::try_from(output_index)
                            .context("output index exceeded u64")?,
                    });
                    break;
                }
            }
        }

        Ok(matches)
    }

    fn match_scannable(
        &self,
        watch: &WatchRegistration,
        scannable: &ScannableBlock,
    ) -> Result<Vec<MatchedOutputCandidate>> {
        Ok(self
            .match_scannables(watch, &[scannable])?
            .pop()
            .unwrap_or_default())
    }

    #[cfg(feature = "epyc")]
    fn derive_points_locally(
        &self,
        private_view: &Scalar,
        points: &[CompressedEdwardsY],
    ) -> Vec<Option<[u8; 32]>> {
        let cofactored_view = Scalar::from(8_u64) * private_view;
        let prepared = PreparedVariableBaseScalar::new(&cofactored_view);
        let mut workspace = PreparedVariableBaseBatchWorkspace::new();
        points
            .chunks(DERIVATION_BATCH_SIZE)
            .flat_map(|chunk| {
                if let Some(compressed) = prepared.mul_compress_batch(chunk, &mut workspace) {
                    return compressed
                        .iter()
                        .map(|point| Some(point.to_bytes()))
                        .collect::<Vec<_>>();
                }
                chunk
                    .iter()
                    .map(|point| {
                        point
                            .decompress()
                            .map(|point| prepared.mul(&point).compress().to_bytes())
                    })
                    .collect()
            })
            .collect()
    }

    #[cfg(not(feature = "epyc"))]
    fn derive_points_locally(
        &self,
        private_view: &Scalar,
        points: &[CompressedEdwardsY],
    ) -> Vec<Option<[u8; 32]>> {
        self.derive_points(private_view, points)
    }

    #[cfg(feature = "epyc")]
    fn derive_points(
        &self,
        private_view: &Scalar,
        points: &[CompressedEdwardsY],
    ) -> Vec<Option<[u8; 32]>> {
        let cofactored_view = Scalar::from(8_u64) * private_view;
        let prepared = PreparedVariableBaseScalar::new(&cofactored_view);
        let chunks = self.pool.install(|| {
            points
                .par_chunks(DERIVATION_BATCH_SIZE)
                .map_init(
                    PreparedVariableBaseBatchWorkspace::new,
                    |workspace, chunk| {
                        if let Some(compressed) = prepared.mul_compress_batch(chunk, workspace) {
                            return compressed
                                .iter()
                                .map(|point| Some(point.to_bytes()))
                                .collect::<Vec<_>>();
                        }
                        chunk
                            .iter()
                            .map(|point| {
                                point
                                    .decompress()
                                    .map(|point| prepared.mul(&point).compress().to_bytes())
                            })
                            .collect()
                    },
                )
                .collect::<Vec<Vec<Option<[u8; 32]>>>>()
        });
        chunks.into_iter().flatten().collect()
    }

    #[cfg(not(feature = "epyc"))]
    fn derive_points(
        &self,
        private_view: &Scalar,
        points: &[CompressedEdwardsY],
    ) -> Vec<Option<[u8; 32]>> {
        let cofactored_view = Scalar::from(8_u64) * private_view;
        points
            .iter()
            .map(|point| {
                point
                    .decompress()
                    .map(|point| (cofactored_view * point).compress().to_bytes())
            })
            .collect()
    }
}

fn prepare_scannables(scannables: &[&ScannableBlock]) -> Result<PreparedScannables> {
    for scannable in scannables {
        if scannable.block.header.hardfork_version > 16 {
            bail!(
                "unsupported Monero hardfork version {}",
                scannable.block.header.hardfork_version
            );
        }
        if scannable.block.transactions.len() != scannable.transactions.len() {
            bail!("scannable block transaction count mismatch");
        }
    }

    let mut points = Vec::<CompressedEdwardsY>::new();
    let mut point_indices = BTreeMap::<[u8; 32], usize>::new();
    let mut transactions = Vec::new();

    for (scannable_index, scannable) in scannables.iter().enumerate() {
        let miner = scannable.block.miner_transaction();
        prepare_transaction(
            scannable_index,
            miner.hash(),
            miner.prefix(),
            &mut points,
            &mut point_indices,
            &mut transactions,
        );
        for (tx_index, tx) in scannable.transactions.iter().enumerate() {
            prepare_transaction(
                scannable_index,
                scannable.block.transactions[tx_index],
                tx.prefix(),
                &mut points,
                &mut point_indices,
                &mut transactions,
            );
        }
    }

    Ok(PreparedScannables {
        scannable_count: scannables.len(),
        points,
        transactions,
    })
}

impl Default for HardwareHostedViewKeyMatcher {
    fn default() -> Self {
        let workers = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        Self::new(workers).expect("failed to initialize hosted-view-key matcher")
    }
}

impl OutputMatcher for HardwareHostedViewKeyMatcher {
    fn match_block(
        &self,
        watch: &WatchRegistration,
        block: &ScannedBlock,
    ) -> Result<Vec<MatchedOutputCandidate>> {
        let scannable = block.scannable_block.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "block {} has no Monero scannable payload for hardware matching",
                block.height
            )
        })?;
        self.match_scannable(watch, scannable)
    }

    fn match_blocks(
        &self,
        watch: &WatchRegistration,
        blocks: &[ScannedBlock],
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        let scannables = blocks
            .iter()
            .map(|block| {
                block.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "block {} has no Monero scannable payload for hardware matching",
                        block.height
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.match_scannables(watch, &scannables)
    }

    fn match_blocks_for_watches(
        &self,
        watches: &[WatchRegistration],
        blocks: &[ScannedBlock],
    ) -> Result<Vec<Vec<Vec<MatchedOutputCandidate>>>> {
        let scannables = blocks
            .iter()
            .map(|block| {
                block.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "block {} has no Monero scannable payload for hardware matching",
                        block.height
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.match_scannables_for_watches(watches, &scannables)
    }
}

impl MempoolOutputMatcher for HardwareHostedViewKeyMatcher {
    fn match_mempool_tx(
        &self,
        watch: &WatchRegistration,
        tx: &ScannedMempoolTx,
    ) -> Result<Vec<MatchedOutputCandidate>> {
        let scannable = tx.scannable_block.as_ref().ok_or_else(|| {
            anyhow::anyhow!("mempool transaction has no Monero scannable payload")
        })?;
        self.match_scannable(watch, scannable)
    }

    fn match_mempool_txs(
        &self,
        watch: &WatchRegistration,
        txs: &[ScannedMempoolTx],
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        let scannables = txs
            .iter()
            .map(|tx| {
                tx.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("mempool transaction has no Monero scannable payload")
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.match_scannables(watch, &scannables)
    }

    fn match_mempool_txs_for_watches(
        &self,
        watches: &[WatchRegistration],
        txs: &[ScannedMempoolTx],
    ) -> Result<Vec<Vec<Vec<MatchedOutputCandidate>>>> {
        let scannables = txs
            .iter()
            .map(|tx| {
                tx.scannable_block.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("mempool transaction has no Monero scannable payload")
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.match_scannables_for_watches(watches, &scannables)
    }
}

struct PreparedScannables {
    scannable_count: usize,
    points: Vec<CompressedEdwardsY>,
    transactions: Vec<PreparedTransaction>,
}

struct PreparedTransaction {
    scannable_index: usize,
    tx_hash: [u8; 32],
    outputs: Vec<Output>,
    primary: Vec<usize>,
    additional: Option<Vec<usize>>,
}

fn prepare_transaction(
    scannable_index: usize,
    tx_hash: [u8; 32],
    prefix: &TransactionPrefix,
    points: &mut Vec<CompressedEdwardsY>,
    point_indices: &mut BTreeMap<[u8; 32], usize>,
    prepared: &mut Vec<PreparedTransaction>,
) {
    let Ok(extra) = Extra::read(&mut prefix.extra.as_slice()) else {
        return;
    };
    let Some((primary, additional)) = extra.keys() else {
        return;
    };
    let primary = primary
        .iter()
        .map(|point| insert_point(point, points, point_indices))
        .collect();
    let additional = additional.map(|additional| {
        additional
            .iter()
            .map(|point| insert_point(point, points, point_indices))
            .collect()
    });
    prepared.push(PreparedTransaction {
        scannable_index,
        tx_hash,
        outputs: prefix.outputs.clone(),
        primary,
        additional,
    });
}

fn insert_point(
    point: &EdwardsPoint,
    points: &mut Vec<CompressedEdwardsY>,
    point_indices: &mut BTreeMap<[u8; 32], usize>,
) -> usize {
    let compressed = point.compress();
    let bytes = compressed.to_bytes();
    if let Some(index) = point_indices.get(&bytes) {
        return *index;
    }
    let index = points.len();
    points.push(compressed);
    point_indices.insert(bytes, index);
    index
}

fn output_derivations(derivation: [u8; 32], output_index: usize) -> Result<(u8, Scalar)> {
    let mut bytes = derivation.to_vec();
    VarInt::write(&output_index, &mut bytes).context("failed to encode Monero output index")?;
    let view_tag = keccak256([b"view_tag".as_slice(), &bytes].concat())[0];
    Ok((view_tag, keccak256_to_scalar(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::Network,
        scanner::{MempoolOutputMatcher, OutputMatcher, ScannedBlock, ScannedMempoolTx},
    };
    use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, Scalar};
    use monero_address::Network as AddressNetwork;
    use monero_oxide::{
        block::{Block, BlockHeader},
        transaction::{Input, Output, Timelock, Transaction, TransactionPrefix},
    };
    use monero_rpc::ScannableBlock;
    use monero_wallet::{extra::ExtraField, Scanner, ViewPair};
    use zeroize::Zeroizing;

    fn incoming_fixture() -> (WatchRegistration, ScannedBlock) {
        let private_view = Scalar::from(11_u64);
        let private_spend = Scalar::from(7_u64);
        let spend = &private_spend * ED25519_BASEPOINT_TABLE;
        let pair = ViewPair::new(spend, Zeroizing::new(private_view)).unwrap();
        let address = pair.legacy_address(AddressNetwork::Mainnet).to_string();

        let tx_private = Scalar::from(19_u64);
        let tx_public = &tx_private * ED25519_BASEPOINT_TABLE;
        let derivation = (Scalar::from(8_u64) * private_view * tx_public)
            .compress()
            .to_bytes();
        let (view_tag, shared_key) = output_derivations(derivation, 0).unwrap();
        let output_key = spend + (&shared_key * ED25519_BASEPOINT_TABLE);
        let tx = Transaction::V2 {
            prefix: TransactionPrefix {
                additional_timelock: Timelock::None,
                inputs: vec![Input::Gen(1)],
                outputs: vec![Output {
                    amount: Some(1),
                    key: output_key.compress().into(),
                    view_tag: Some(view_tag),
                }],
                extra: ExtraField::PublicKey(tx_public).serialize(),
            },
            proofs: None,
        };
        let tx_hash = [3_u8; 32];
        let miner = Transaction::V1 {
            prefix: TransactionPrefix {
                additional_timelock: Timelock::None,
                inputs: vec![Input::Gen(1)],
                outputs: vec![],
                extra: vec![],
            },
            signatures: vec![],
        };
        let block = Block::new(
            BlockHeader {
                hardfork_version: 16,
                hardfork_signal: 16,
                timestamp: 1,
                previous: [0; 32],
                nonce: 0,
            },
            miner,
            vec![tx_hash],
        )
        .unwrap();
        let scannable = ScannableBlock {
            block: block.clone(),
            transactions: vec![tx],
            output_index_for_first_ringct_output: Some(0),
        };
        let watch = WatchRegistration {
            identity_id: "identity-a".to_owned(),
            address,
            private_view_key: hex::encode(private_view.to_bytes()),
            management_token_hash: "0".repeat(64),
            network: Network::Mainnet,
            restore_height: 1,
            push_token: None,
            device_id: None,
            worker_assignment_epoch: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 0,
            last_scanned_hash: None,
        };
        (
            watch,
            ScannedBlock {
                height: 1,
                hash: hex::encode(block.hash()),
                timestamp_ms: 1_000,
                outputs: vec![],
                scannable_block: Some(Box::new(scannable)),
            },
        )
    }

    fn mining_reward_fixture() -> (WatchRegistration, ScannedBlock) {
        let private_view = Scalar::from(23_u64);
        let private_spend = Scalar::from(29_u64);
        let spend = &private_spend * ED25519_BASEPOINT_TABLE;
        let pair = ViewPair::new(spend, Zeroizing::new(private_view)).unwrap();
        let address = pair.legacy_address(AddressNetwork::Mainnet).to_string();

        let tx_private = Scalar::from(31_u64);
        let tx_public = &tx_private * ED25519_BASEPOINT_TABLE;
        let derivation = (Scalar::from(8_u64) * private_view * tx_public)
            .compress()
            .to_bytes();
        let (_, shared_key) = output_derivations(derivation, 0).unwrap();
        let output_key = spend + (&shared_key * ED25519_BASEPOINT_TABLE);
        let miner = Transaction::V2 {
            prefix: TransactionPrefix {
                additional_timelock: Timelock::None,
                inputs: vec![Input::Gen(1)],
                outputs: vec![Output {
                    amount: Some(1),
                    key: output_key.compress().into(),
                    view_tag: None,
                }],
                extra: ExtraField::PublicKey(tx_public).serialize(),
            },
            proofs: None,
        };
        let block = Block::new(
            BlockHeader {
                hardfork_version: 16,
                hardfork_signal: 16,
                timestamp: 1,
                previous: [0; 32],
                nonce: 0,
            },
            miner,
            vec![],
        )
        .unwrap();
        let scannable = ScannableBlock {
            block: block.clone(),
            transactions: vec![],
            output_index_for_first_ringct_output: Some(0),
        };
        let watch = WatchRegistration {
            identity_id: "identity-miner".to_owned(),
            address,
            private_view_key: hex::encode(private_view.to_bytes()),
            management_token_hash: "0".repeat(64),
            network: Network::Mainnet,
            restore_height: 1,
            push_token: None,
            device_id: None,
            worker_assignment_epoch: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 0,
            last_scanned_hash: None,
        };
        (
            watch,
            ScannedBlock {
                height: 1,
                hash: hex::encode(block.hash()),
                timestamp_ms: 1_000,
                outputs: vec![],
                scannable_block: Some(Box::new(scannable)),
            },
        )
    }

    #[test]
    fn hardware_matcher_matches_monero_wallet_reference() {
        let (watch, block) = incoming_fixture();
        let hardware = HardwareHostedViewKeyMatcher::new(2)
            .unwrap()
            .match_block(&watch, &block)
            .unwrap();
        let pair = validated_hosted_keys(&watch)
            .and_then(|(spend, view)| ViewPair::new(spend, view).map_err(Into::into))
            .unwrap();
        let reference = Scanner::new(pair)
            .scan((**block.scannable_block.as_ref().unwrap()).clone())
            .unwrap()
            .ignore_additional_timelock();

        assert_eq!(hardware.len(), 1);
        assert_eq!(reference.len(), 1);
        assert_eq!(hardware[0].tx_id, hex::encode(reference[0].transaction()));
        assert_eq!(
            hardware[0].output_index,
            reference[0].index_in_transaction()
        );
    }

    #[test]
    fn multi_watch_batches_match_individual_block_and_mempool_results() {
        let (watch, block) = incoming_fixture();
        let private_view = Scalar::from(37_u64);
        let private_spend = Scalar::from(41_u64);
        let spend = &private_spend * ED25519_BASEPOINT_TABLE;
        let pair = ViewPair::new(spend, Zeroizing::new(private_view)).unwrap();
        let mut decoy = watch.clone();
        decoy.identity_id = "identity-decoy".to_owned();
        decoy.address = pair.legacy_address(AddressNetwork::Mainnet).to_string();
        decoy.private_view_key = hex::encode(private_view.to_bytes());
        let watches = vec![watch, decoy];
        let blocks = vec![block.clone()];
        let matcher = HardwareHostedViewKeyMatcher::new(2).unwrap();

        let individual_blocks = watches
            .iter()
            .map(|watch| matcher.match_blocks(watch, &blocks))
            .collect::<Result<Vec<_>>>()
            .unwrap();
        let batched_blocks = matcher.match_blocks_for_watches(&watches, &blocks).unwrap();
        assert_eq!(batched_blocks, individual_blocks);
        assert_eq!(batched_blocks[0][0].len(), 1);
        assert!(batched_blocks[1][0].is_empty());

        let tx = ScannedMempoolTx {
            tx_id: "a".repeat(64),
            received_ms: 1,
            outputs: vec![],
            scannable_block: block.scannable_block,
        };
        let txs = vec![tx];
        let individual_mempool = watches
            .iter()
            .map(|watch| matcher.match_mempool_txs(watch, &txs))
            .collect::<Result<Vec<_>>>()
            .unwrap();
        let batched_mempool = matcher
            .match_mempool_txs_for_watches(&watches, &txs)
            .unwrap();
        assert_eq!(batched_mempool, individual_mempool);
        assert_eq!(batched_mempool[0][0].len(), 1);
        assert!(batched_mempool[1][0].is_empty());
    }

    #[test]
    fn hardware_matcher_detects_mining_rewards() {
        let (watch, block) = mining_reward_fixture();
        let hardware = HardwareHostedViewKeyMatcher::new(2)
            .unwrap()
            .match_block(&watch, &block)
            .unwrap();
        let pair = validated_hosted_keys(&watch)
            .and_then(|(spend, view)| ViewPair::new(spend, view).map_err(Into::into))
            .unwrap();
        let reference = Scanner::new(pair)
            .scan((**block.scannable_block.as_ref().unwrap()).clone())
            .unwrap()
            .ignore_additional_timelock();

        assert_eq!(hardware.len(), 1);
        assert_eq!(hardware.len(), reference.len());
        assert_eq!(
            hardware[0].tx_id,
            hex::encode(
                block
                    .scannable_block
                    .as_ref()
                    .unwrap()
                    .block
                    .miner_transaction()
                    .hash()
            )
        );
    }

    #[cfg(feature = "epyc")]
    #[test]
    #[ignore = "performance diagnostic; run explicitly on the EPYC host"]
    fn epyc_derivation_throughput() {
        use std::{
            hint::black_box,
            time::{Duration, Instant},
        };

        const POINTS: usize = 65_536;
        const WARMUPS: usize = 3;
        const DEFAULT_ROUNDS: usize = 40;

        let workers = std::env::var("FAST_WALLET_SCANNER_CORE_DERIVATION_WORKERS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(12);
        let rounds = std::env::var("FAST_WALLET_SCANNER_CORE_BENCH_ROUNDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_ROUNDS);
        assert!(rounds > 0);
        let matcher = HardwareHostedViewKeyMatcher::new(workers).unwrap();
        let private_view = Scalar::from(0x1234_5678_u64);
        let mut point = curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
        let points = (0..POINTS)
            .map(|_| {
                let encoded = point.compress();
                point += curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
                encoded
            })
            .collect::<Vec<_>>();

        let expected_first = (Scalar::from(8_u64)
            * private_view
            * curve25519_dalek::constants::ED25519_BASEPOINT_POINT)
            .compress()
            .to_bytes();

        let derive_reference = || {
            let cofactored_view = Scalar::from(8_u64) * private_view;
            matcher.pool.install(|| {
                points
                    .par_iter()
                    .map(|point| {
                        point
                            .decompress()
                            .map(|point| (&cofactored_view * point).compress().to_bytes())
                    })
                    .collect::<Vec<_>>()
            })
        };
        for _ in 0..WARMUPS {
            black_box(derive_reference());
            black_box(matcher.derive_points(&private_view, &points));
        }

        let reference_preflight = derive_reference();
        let batch_preflight = matcher.derive_points(&private_view, &points);
        assert_eq!(reference_preflight, batch_preflight);
        assert_eq!(batch_preflight[0], Some(expected_first));

        let mut reference_elapsed = Vec::with_capacity(rounds);
        let mut batch_elapsed = Vec::with_capacity(rounds);
        for round in 0..rounds {
            let reference_first = round % 4 == 0 || round % 4 == 3;
            for use_reference in [reference_first, !reference_first] {
                let started = Instant::now();
                let derived = if use_reference {
                    derive_reference()
                } else {
                    matcher.derive_points(&private_view, &points)
                };
                let elapsed = started.elapsed();
                if use_reference {
                    reference_elapsed.push(elapsed);
                } else {
                    batch_elapsed.push(elapsed);
                }
                assert_eq!(derived[0], Some(expected_first));
                black_box(derived);
            }
        }

        reference_elapsed.sort();
        batch_elapsed.sort();
        let reference_median = reference_elapsed[reference_elapsed.len() / 2];
        let batch_median = batch_elapsed[batch_elapsed.len() / 2];
        let reference_per_second = POINTS as f64 / reference_median.as_secs_f64();
        let batch_per_second = POINTS as f64 / batch_median.as_secs_f64();
        let improvement = ((batch_per_second / reference_per_second) - 1.0) * 100.0;
        eprintln!(
            "backend={} workers={} points={} rounds={} reference_median_seconds={:.9} reference_derivations_per_second={:.3} batch_median_seconds={:.9} batch_derivations_per_second={:.3} improvement_percent={:.3}",
            matcher.backend_name(),
            matcher.workers(),
            POINTS,
            rounds,
            reference_median.as_secs_f64(),
            reference_per_second,
            batch_median.as_secs_f64(),
            batch_per_second,
            improvement,
        );
        assert!(reference_median > Duration::ZERO);
        assert!(batch_median > Duration::ZERO);
    }
}
