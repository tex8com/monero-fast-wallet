use crate::{
    model::{
        matched_output_id, DetectionStatus, MatchedOutput, Network, RegisterMatchedOutputRequest,
        WatchRegistration, WatchValidationError,
    },
    store::WatchStore,
};
use anyhow::{anyhow, Result};
use std::{
    cmp,
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub trait BlockSource {
    fn next_blocks(
        &mut self,
        network: Network,
        from_height_exclusive: u64,
        max_blocks: usize,
    ) -> Result<Vec<ScannedBlock>>;
}

pub trait OutputMatcher {
    fn match_block(
        &self,
        watch: &WatchRegistration,
        block: &ScannedBlock,
    ) -> Result<Vec<MatchedOutputCandidate>>;

    fn match_blocks(
        &self,
        watch: &WatchRegistration,
        blocks: &[ScannedBlock],
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        blocks
            .iter()
            .map(|block| self.match_block(watch, block))
            .collect()
    }

    fn match_blocks_for_watches(
        &self,
        watches: &[WatchRegistration],
        blocks: &[ScannedBlock],
    ) -> Result<Vec<Vec<Vec<MatchedOutputCandidate>>>> {
        watches
            .iter()
            .map(|watch| self.match_blocks(watch, blocks))
            .collect()
    }
}

pub trait MempoolSource {
    fn current_transactions(&mut self, network: Network) -> Result<Vec<ScannedMempoolTx>>;
}

pub trait MempoolOutputMatcher {
    fn match_mempool_tx(
        &self,
        watch: &WatchRegistration,
        tx: &ScannedMempoolTx,
    ) -> Result<Vec<MatchedOutputCandidate>>;

    fn match_mempool_txs(
        &self,
        watch: &WatchRegistration,
        txs: &[ScannedMempoolTx],
    ) -> Result<Vec<Vec<MatchedOutputCandidate>>> {
        txs.iter()
            .map(|tx| self.match_mempool_tx(watch, tx))
            .collect()
    }

    fn match_mempool_txs_for_watches(
        &self,
        watches: &[WatchRegistration],
        txs: &[ScannedMempoolTx],
    ) -> Result<Vec<Vec<Vec<MatchedOutputCandidate>>>> {
        watches
            .iter()
            .map(|watch| self.match_mempool_txs(watch, txs))
            .collect()
    }
}

pub struct ScannerWorker<S, M> {
    store: Arc<dyn WatchStore>,
    block_source: S,
    matcher: M,
}

impl<S, M> ScannerWorker<S, M>
where
    S: BlockSource,
    M: OutputMatcher,
{
    pub fn new(store: Arc<dyn WatchStore>, block_source: S, matcher: M) -> Self {
        Self {
            store,
            block_source,
            matcher,
        }
    }

    pub fn scan_once(&mut self, max_blocks_per_watch: usize, now_ms: u64) -> Result<ScannerRun> {
        if max_blocks_per_watch == 0 {
            return Ok(ScannerRun::default());
        }

        let watches = self.store.list()?;
        let mut run = ScannerRun {
            watched_identities: watches.len(),
            ..ScannerRun::default()
        };

        let mut groups = BTreeMap::<(Network, u64), Vec<WatchRegistration>>::new();
        for watch in watches {
            groups
                .entry((watch.network, watch.last_scanned_height))
                .or_default()
                .push(watch);
        }

        for ((network, from_height_exclusive), grouped_watches) in groups {
            let mut blocks = self.block_source.next_blocks(
                network,
                from_height_exclusive,
                max_blocks_per_watch,
            )?;
            blocks.sort_by_key(|block| block.height);

            let grouped_matches = self
                .matcher
                .match_blocks_for_watches(&grouped_watches, &blocks)?;
            if grouped_matches.len() != grouped_watches.len() {
                return Err(anyhow!("matcher watch result count mismatch"));
            }

            for (mut watch, matches) in grouped_watches.into_iter().zip(grouped_matches) {
                let mut advanced = false;
                if matches.len() != blocks.len() {
                    return Err(anyhow!(
                        "matcher result count mismatch for identity {}",
                        watch.identity_id
                    ));
                }
                for (block, candidates) in blocks.iter().zip(matches) {
                    if block.height <= watch.last_scanned_height {
                        continue;
                    }
                    let expected_height = watch.last_scanned_height.saturating_add(1);
                    if block.height != expected_height {
                        return Err(anyhow!(
                            "block source gap for identity {}: expected height {} got {}",
                            watch.identity_id,
                            expected_height,
                            block.height
                        ));
                    }

                    for candidate in candidates {
                        let output = candidate.into_matched_output(&watch.identity_id, now_ms)?;
                        self.store.upsert_match(output)?;
                        run.matched_outputs += 1;
                    }

                    watch.last_scanned_height = block.height;
                    watch.updated_at_ms = now_ms;
                    self.store.upsert(watch.clone())?;
                    run.scanned_blocks += 1;
                    run.highest_scanned_height = cmp::max(run.highest_scanned_height, block.height);
                    advanced = true;
                }

                if advanced {
                    run.advanced_identities += 1;
                }
            }
        }

        Ok(run)
    }
}

pub struct MempoolScannerWorker<S, M> {
    store: Arc<dyn WatchStore>,
    mempool_source: S,
    matcher: M,
}

impl<S, M> MempoolScannerWorker<S, M>
where
    S: MempoolSource,
    M: MempoolOutputMatcher,
{
    pub fn new(store: Arc<dyn WatchStore>, mempool_source: S, matcher: M) -> Self {
        Self {
            store,
            mempool_source,
            matcher,
        }
    }

    pub fn scan_once(&mut self, now_ms: u64) -> Result<MempoolRun> {
        let watches = self.store.list()?;
        let mut run = MempoolRun {
            watched_identities: watches.len(),
            ..MempoolRun::default()
        };

        let mut groups = BTreeMap::<Network, Vec<WatchRegistration>>::new();
        for watch in watches {
            groups.entry(watch.network).or_default().push(watch);
        }

        for (network, grouped_watches) in groups {
            let txs = self.mempool_source.current_transactions(network)?;
            let grouped_matches = self
                .matcher
                .match_mempool_txs_for_watches(&grouped_watches, &txs)?;
            if grouped_matches.len() != grouped_watches.len() {
                return Err(anyhow!("mempool matcher watch result count mismatch"));
            }

            for (watch, matches) in grouped_watches.into_iter().zip(grouped_matches) {
                let mut currently_seen = BTreeSet::new();
                if matches.len() != txs.len() {
                    return Err(anyhow!(
                        "mempool matcher result count mismatch for identity {}",
                        watch.identity_id
                    ));
                }

                for (tx, candidates) in txs.iter().zip(matches) {
                    for candidate in candidates {
                        let match_id = matched_output_id(
                            &watch.identity_id,
                            &candidate.tx_id,
                            candidate.output_index,
                        );
                        currently_seen.insert(match_id);
                        let output = candidate.into_mempool_output(
                            &watch.identity_id,
                            tx.received_ms,
                            now_ms,
                        )?;
                        self.store.upsert_match(output)?;
                        run.pending_outputs += 1;
                    }
                }

                let existing_matches = self.store.list_matches(&watch.identity_id)?;
                for output in existing_matches {
                    if output.detection_status == DetectionStatus::PendingMempool
                        && !currently_seen.contains(&output.id)
                    {
                        self.store.upsert_match(output.dropped_mempool(now_ms))?;
                        run.dropped_outputs += 1;
                    }
                }
            }
        }

        Ok(run)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScannedBlock {
    pub height: u64,
    pub hash: String,
    pub timestamp_ms: u64,
    pub outputs: Vec<ScannedOutput>,
    pub scannable_block: Option<Box<monero_rpc::ScannableBlock>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScannedMempoolTx {
    pub tx_id: String,
    pub received_ms: u64,
    pub outputs: Vec<ScannedOutput>,
    pub scannable_block: Option<Box<monero_rpc::ScannableBlock>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScannedOutput {
    pub tx_id: String,
    pub output_index: u64,
    pub output_public_key: String,
    pub view_tag: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchedOutputCandidate {
    pub tx_id: String,
    pub output_index: u64,
}

impl MatchedOutputCandidate {
    fn into_matched_output(
        self,
        identity_id: &str,
        now_ms: u64,
    ) -> Result<MatchedOutput, WatchValidationError> {
        MatchedOutput::from_request(
            RegisterMatchedOutputRequest {
                identity_id: identity_id.to_owned(),
                tx_id: self.tx_id,
                output_index: self.output_index,
            },
            now_ms,
        )
    }

    fn into_mempool_output(
        self,
        identity_id: &str,
        first_seen_ms: u64,
        now_ms: u64,
    ) -> Result<MatchedOutput, WatchValidationError> {
        let mut output = MatchedOutput::from_mempool_candidate(
            identity_id,
            self.tx_id,
            self.output_index,
            first_seen_ms,
        )?;
        output.updated_at_ms = now_ms;
        output.mempool_last_seen_ms = Some(now_ms);
        Ok(output)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScannerRun {
    pub watched_identities: usize,
    pub advanced_identities: usize,
    pub scanned_blocks: usize,
    pub matched_outputs: usize,
    pub highest_scanned_height: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MempoolRun {
    pub watched_identities: usize,
    pub pending_outputs: usize,
    pub dropped_outputs: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{DetectionStatus, Network, NotificationStatus},
        store::InMemoryWatchStore,
    };
    use anyhow::anyhow;
    use std::{
        collections::BTreeMap,
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn watch(identity_id: &str, restore_height: u64) -> WatchRegistration {
        WatchRegistration {
            identity_id: identity_id.to_owned(),
            address: "9".repeat(95),
            private_view_key: "c".repeat(64),
            management_token_hash: "0".repeat(64),
            network: Network::Stagenet,
            restore_height,
            push_token: Some("push-token".to_owned()),
            device_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: restore_height.saturating_sub(1),
        }
    }

    fn block(height: u64, outputs: Vec<ScannedOutput>) -> ScannedBlock {
        ScannedBlock {
            height,
            hash: format!("{height:064x}"),
            timestamp_ms: 1000 + height,
            outputs,
            scannable_block: None,
        }
    }

    fn mempool_tx(tx_nibble: char, outputs: Vec<ScannedOutput>) -> ScannedMempoolTx {
        ScannedMempoolTx {
            tx_id: tx_nibble.to_string().repeat(64),
            received_ms: 1500,
            outputs,
            scannable_block: None,
        }
    }

    fn output(tx_nibble: char, output_index: u64, marker: &str) -> ScannedOutput {
        ScannedOutput {
            tx_id: tx_nibble.to_string().repeat(64),
            output_index,
            output_public_key: marker.to_owned(),
            view_tag: None,
        }
    }

    #[derive(Default)]
    struct MemoryMempoolSource {
        txs: Vec<ScannedMempoolTx>,
        calls: Arc<AtomicUsize>,
    }

    impl MemoryMempoolSource {
        fn with_txs(txs: Vec<ScannedMempoolTx>, calls: Arc<AtomicUsize>) -> Self {
            Self { txs, calls }
        }
    }

    impl MempoolSource for MemoryMempoolSource {
        fn current_transactions(&mut self, _network: Network) -> Result<Vec<ScannedMempoolTx>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(self.txs.clone())
        }
    }

    #[derive(Default)]
    struct MemoryBlockSource {
        blocks: BTreeMap<NetworkHeightKey, ScannedBlock>,
        calls: Arc<AtomicUsize>,
    }

    impl MemoryBlockSource {
        fn with_blocks(blocks: Vec<ScannedBlock>) -> Self {
            Self::with_blocks_and_counter(blocks, Arc::new(AtomicUsize::new(0)))
        }

        fn with_blocks_and_counter(blocks: Vec<ScannedBlock>, calls: Arc<AtomicUsize>) -> Self {
            Self {
                blocks: blocks
                    .into_iter()
                    .map(|block| {
                        (
                            NetworkHeightKey {
                                network: Network::Stagenet,
                                height: block.height,
                            },
                            block,
                        )
                    })
                    .collect(),
                calls,
            }
        }
    }

    impl BlockSource for MemoryBlockSource {
        fn next_blocks(
            &mut self,
            network: Network,
            from_height_exclusive: u64,
            max_blocks: usize,
        ) -> Result<Vec<ScannedBlock>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(self
                .blocks
                .iter()
                .filter(|(key, _)| key.network == network && key.height > from_height_exclusive)
                .take(max_blocks)
                .map(|(_, block)| block.clone())
                .collect())
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
    struct NetworkHeightKey {
        network: Network,
        height: u64,
    }

    struct MarkerMatcher;

    impl OutputMatcher for MarkerMatcher {
        fn match_block(
            &self,
            watch: &WatchRegistration,
            block: &ScannedBlock,
        ) -> Result<Vec<MatchedOutputCandidate>> {
            Ok(block
                .outputs
                .iter()
                .filter(|output| output.output_public_key == watch.identity_id)
                .map(|output| MatchedOutputCandidate {
                    tx_id: output.tx_id.clone(),
                    output_index: output.output_index,
                })
                .collect())
        }
    }

    struct MempoolMarkerMatcher;

    impl MempoolOutputMatcher for MempoolMarkerMatcher {
        fn match_mempool_tx(
            &self,
            watch: &WatchRegistration,
            tx: &ScannedMempoolTx,
        ) -> Result<Vec<MatchedOutputCandidate>> {
            Ok(tx
                .outputs
                .iter()
                .filter(|output| output.output_public_key == watch.identity_id)
                .map(|output| MatchedOutputCandidate {
                    tx_id: output.tx_id.clone(),
                    output_index: output.output_index,
                })
                .collect())
        }
    }

    struct FailingMatcher;

    impl OutputMatcher for FailingMatcher {
        fn match_block(
            &self,
            _watch: &WatchRegistration,
            _block: &ScannedBlock,
        ) -> Result<Vec<MatchedOutputCandidate>> {
            Err(anyhow!("matcher unavailable"))
        }
    }

    #[test]
    fn scanner_advances_height_and_stores_only_matching_outputs() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let blocks = vec![
            block(10, vec![output('1', 0, "fast-a"), output('2', 1, "other")]),
            block(11, vec![output('3', 0, "fast-a")]),
        ];
        let mut worker = ScannerWorker::new(
            store.clone(),
            MemoryBlockSource::with_blocks(blocks),
            MarkerMatcher,
        );

        let run = worker.scan_once(10, 2000).unwrap();

        assert_eq!(
            run,
            ScannerRun {
                watched_identities: 1,
                advanced_identities: 1,
                scanned_blocks: 2,
                matched_outputs: 2,
                highest_scanned_height: 11,
            }
        );
        assert_eq!(
            store.get("fast-a").unwrap().unwrap().last_scanned_height,
            11
        );

        let matches = store.list_matches("fast-a").unwrap();
        assert_eq!(matches.len(), 2);
        assert!(matches
            .iter()
            .all(|output| output.detection_status == DetectionStatus::Confirmed));
        assert!(matches
            .iter()
            .all(|output| output.notification_status == NotificationStatus::Pending));
    }

    #[test]
    fn scanner_reprocessing_is_idempotent() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let blocks = vec![block(10, vec![output('1', 0, "fast-a")])];
        let mut worker = ScannerWorker::new(
            store.clone(),
            MemoryBlockSource::with_blocks(blocks),
            MarkerMatcher,
        );

        assert_eq!(worker.scan_once(10, 2000).unwrap().matched_outputs, 1);
        assert_eq!(worker.scan_once(10, 3000).unwrap().matched_outputs, 0);
        assert_eq!(store.list_matches("fast-a").unwrap().len(), 1);
        assert_eq!(
            store.get("fast-a").unwrap().unwrap().last_scanned_height,
            10
        );
    }

    #[test]
    fn scanner_fetches_a_shared_cursor_only_once() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        store.upsert(watch("fast-b", 10)).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut worker = ScannerWorker::new(
            store,
            MemoryBlockSource::with_blocks_and_counter(vec![block(10, vec![])], calls.clone()),
            MarkerMatcher,
        );

        let run = worker.scan_once(10, 2000).unwrap();

        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(run.advanced_identities, 2);
        assert_eq!(run.scanned_blocks, 2);
    }

    #[test]
    fn scanner_does_not_advance_when_matcher_fails() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let blocks = vec![block(10, vec![output('1', 0, "fast-a")])];
        let mut worker = ScannerWorker::new(
            store.clone(),
            MemoryBlockSource::with_blocks(blocks),
            FailingMatcher,
        );

        let error = worker.scan_once(10, 2000).unwrap_err();

        assert!(error.to_string().contains("matcher unavailable"));
        assert_eq!(store.get("fast-a").unwrap().unwrap().last_scanned_height, 9);
        assert!(store.list_matches("fast-a").unwrap().is_empty());
    }

    #[test]
    fn scanner_rejects_block_source_gaps_without_advancing() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let blocks = vec![block(11, vec![output('1', 0, "fast-a")])];
        let mut worker = ScannerWorker::new(
            store.clone(),
            MemoryBlockSource::with_blocks(blocks),
            MarkerMatcher,
        );

        let error = worker.scan_once(10, 2000).unwrap_err();

        assert!(error.to_string().contains("block source gap"));
        assert_eq!(store.get("fast-a").unwrap().unwrap().last_scanned_height, 9);
        assert!(store.list_matches("fast-a").unwrap().is_empty());
    }

    #[test]
    fn mempool_scanner_stores_pending_outputs() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let txs = vec![mempool_tx(
            '1',
            vec![output('1', 0, "fast-a"), output('1', 1, "other")],
        )];
        let mut worker = MempoolScannerWorker::new(
            store.clone(),
            MemoryMempoolSource::with_txs(txs, Arc::new(AtomicUsize::new(0))),
            MempoolMarkerMatcher,
        );

        let run = worker.scan_once(2000).unwrap();

        assert_eq!(
            run,
            MempoolRun {
                watched_identities: 1,
                pending_outputs: 1,
                dropped_outputs: 0,
            }
        );
        let matches = store.list_matches("fast-a").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].detection_status, DetectionStatus::PendingMempool);
        assert_eq!(matches[0].mempool_first_seen_ms, Some(1500));
        assert_eq!(matches[0].mempool_last_seen_ms, Some(2000));
    }

    #[test]
    fn block_confirmation_updates_mempool_match_without_duplicate() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let txs = vec![mempool_tx('1', vec![output('1', 0, "fast-a")])];
        let mut mempool_worker = MempoolScannerWorker::new(
            store.clone(),
            MemoryMempoolSource::with_txs(txs, Arc::new(AtomicUsize::new(0))),
            MempoolMarkerMatcher,
        );
        mempool_worker.scan_once(2000).unwrap();
        let mut notified = store.list_matches("fast-a").unwrap().remove(0);
        notified.notification_status = NotificationStatus::Sent;
        store.upsert_match(notified).unwrap();

        let blocks = vec![block(10, vec![output('1', 0, "fast-a")])];
        let mut block_worker = ScannerWorker::new(
            store.clone(),
            MemoryBlockSource::with_blocks(blocks),
            MarkerMatcher,
        );
        block_worker.scan_once(10, 3000).unwrap();

        let matches = store.list_matches("fast-a").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].detection_status, DetectionStatus::Confirmed);
        assert_eq!(matches[0].mempool_first_seen_ms, Some(1500));
        assert_eq!(matches[0].mempool_last_seen_ms, Some(2000));
        assert_eq!(matches[0].notification_status, NotificationStatus::Pending);
    }

    #[test]
    fn mempool_scanner_marks_unconfirmed_missing_tx_as_dropped() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        let txs = vec![mempool_tx('1', vec![output('1', 0, "fast-a")])];
        let mut first_worker = MempoolScannerWorker::new(
            store.clone(),
            MemoryMempoolSource::with_txs(txs, Arc::new(AtomicUsize::new(0))),
            MempoolMarkerMatcher,
        );
        first_worker.scan_once(2000).unwrap();

        let mut second_worker = MempoolScannerWorker::new(
            store.clone(),
            MemoryMempoolSource::with_txs(Vec::new(), Arc::new(AtomicUsize::new(0))),
            MempoolMarkerMatcher,
        );
        let run = second_worker.scan_once(3000).unwrap();

        assert_eq!(run.dropped_outputs, 1);
        let matches = store.list_matches("fast-a").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].detection_status, DetectionStatus::Dropped);
        assert_eq!(matches[0].mempool_first_seen_ms, Some(1500));
    }

    #[test]
    fn mempool_snapshot_is_fetched_once_per_network() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("fast-a", 10)).unwrap();
        store.upsert(watch("fast-b", 10)).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut worker = MempoolScannerWorker::new(
            store,
            MemoryMempoolSource::with_txs(Vec::new(), calls.clone()),
            MempoolMarkerMatcher,
        );

        worker.scan_once(2000).unwrap();

        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
}
