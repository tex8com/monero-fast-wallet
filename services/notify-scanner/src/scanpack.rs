//! Strictly read-only access to Cuprate's `MWSPACK1` wallet scan sidecar.
//!
//! Cuprate remains the sole writer. This module deliberately contains no
//! production write, delete, rename, repair, or cache-builder operation.

use crate::{
    cuprate::decode_block_entries,
    model::Network,
    scanner::{BlockSource, ScannedBlock},
};
use anyhow::{bail, Context, Result};
use bytes::Bytes;
use cuprate_fixed_bytes::ByteArray;
use cuprate_types::{
    rpc::{BlockOutputIndices, TxOutputIndices},
    BlockCompleteEntry, PrunedTxBlobEntry, TransactionBlobs,
};
use ed25519_dalek::VerifyingKey;
use scanpack_format::{
    load_verified_manifest, load_verified_manifest_generation, load_verified_status,
    verify_pack_file, VerifiedManifest, VerifiedStatus,
};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File, Metadata, OpenOptions},
    io::{BufReader, Read},
    ops::Bound,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::{
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawFd,
};

const MAGIC: &[u8; 8] = b"MWSPACK1";
const FORMAT_VERSION: u32 = 1;
const FIXED_HEADER_BYTES: u64 = 32;
const MAX_PACK_BLOCKS: usize = 10_000;
const MAX_ITEM_BYTES: usize = 64 * 1024 * 1024;
const MAX_PACK_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TXS_PER_BLOCK: usize = 1_000_000;
const MAX_TX_INDEX_LISTS_PER_BLOCK: usize = 1_000_000;
const MAX_INDICES_PER_TX: usize = 1_000_000;
const DECODED_PACK_CACHE_SIZE: usize = 16;
const MAX_STATUS_FUTURE_SKEW_SECONDS: u64 = 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanPackHealth {
    pub available: bool,
    pub generation: u64,
    pub manifest_end_height: u64,
    pub canonical_height: u64,
    pub lag_blocks: u64,
    pub status_age_seconds: u64,
}

#[derive(Clone, Debug)]
struct IndexedPack {
    path: PathBuf,
    end_height: u64,
    sha256: String,
    start_block_hash: String,
    end_block_hash: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScanPackMetadata {
    start_height: u64,
    end_height: u64,
    block_count: usize,
}

#[derive(Debug)]
struct ScanPack {
    metadata: ScanPackMetadata,
    blocks: Vec<BlockCompleteEntry>,
    output_indices: Vec<BlockOutputIndices>,
}

/// A local ScanPack block source. It opens every package read-only and never
/// shares the hosted private-view-key store with the Cuprate process.
pub struct ScanPackBlockSource {
    directory: PathBuf,
    network: Network,
    refresh_interval: Duration,
    last_refresh: Instant,
    packs: BTreeMap<u64, IndexedPack>,
    decoded_packs: VecDeque<(PathBuf, String, Arc<ScanPack>)>,
    verifying_key: VerifyingKey,
    manifest: Option<VerifiedManifest>,
    status: Option<VerifiedStatus>,
    max_lag_blocks: u64,
    max_status_age: Duration,
}

impl ScanPackBlockSource {
    pub fn open(
        directory: impl Into<PathBuf>,
        network: Network,
        refresh_interval: Duration,
        verifying_key: VerifyingKey,
        max_lag_blocks: u64,
        max_status_age: Duration,
    ) -> Result<Self> {
        if max_status_age.is_zero() {
            bail!("ScanPack maximum status age must be positive");
        }
        let directory = directory.into();
        validate_directory(&directory)?;
        let mut source = Self {
            directory,
            network,
            refresh_interval,
            last_refresh: Instant::now(),
            packs: BTreeMap::new(),
            decoded_packs: VecDeque::with_capacity(DECODED_PACK_CACHE_SIZE),
            verifying_key,
            manifest: None,
            status: None,
            max_lag_blocks,
            max_status_age,
        };
        source.refresh()?;
        Ok(source)
    }

    pub fn cached_interval(&self) -> Option<(u64, u64)> {
        let start = *self.packs.first_key_value()?.0;
        let end = self.packs.last_key_value()?.1.end_height;
        Some((start, end))
    }

    pub fn health(&self) -> Option<ScanPackHealth> {
        let manifest = self.manifest.as_ref()?;
        let status = self.status.as_ref()?;
        Some(scanpack_health(
            manifest,
            status,
            now_seconds(),
            self.max_lag_blocks,
            self.max_status_age,
        ))
    }

    fn refresh_if_due(&mut self) -> Result<()> {
        if self.last_refresh.elapsed() >= self.refresh_interval {
            self.refresh()?;
        }
        Ok(())
    }

    fn refresh(&mut self) -> Result<()> {
        validate_directory(&self.directory)?;
        let manifest = load_verified_manifest(&self.directory, &self.verifying_key)?;
        let status = load_verified_status(&self.directory, &self.verifying_key)?;
        if manifest.signed.body.network != self.network.to_string() {
            bail!(
                "ScanPack manifest network mismatch: source={} manifest={}",
                self.network,
                manifest.signed.body.network
            );
        }
        validate_status_binding(
            &manifest,
            &status,
            &self.network.to_string(),
            self.max_lag_blocks,
            self.max_status_age,
        )?;
        if let Some(previous) = &self.manifest {
            let current_body = &manifest.signed.body;
            let previous_body = &previous.signed.body;
            if current_body.generation < previous_body.generation {
                bail!("ScanPack manifest generation rolled back");
            }
            if current_body.generation == previous_body.generation {
                if manifest.manifest_hash != previous.manifest_hash {
                    bail!("ScanPack manifest changed within one generation");
                }
                self.status = Some(status);
                self.last_refresh = Instant::now();
                return Ok(());
            } else {
                verify_manifest_chain(
                    &self.directory,
                    previous,
                    &manifest,
                    &self.verifying_key,
                    &self.network.to_string(),
                )?;
            }
        }

        let mut packs = BTreeMap::new();
        for descriptor in &manifest.signed.body.packs {
            let path = self.directory.join(&descriptor.file);
            let metadata = read_pack_metadata(&path)
                .with_context(|| format!("invalid ScanPack {}", path.display()))?;
            if metadata.start_height != descriptor.start_height
                || metadata.end_height != descriptor.end_height
            {
                bail!("ScanPack manifest/header mismatch for {}", path.display());
            }
            if packs
                .insert(
                    descriptor.start_height,
                    IndexedPack {
                        path,
                        end_height: descriptor.end_height,
                        sha256: descriptor.sha256.clone(),
                        start_block_hash: descriptor.start_block_hash.clone(),
                        end_block_hash: descriptor.end_block_hash.clone(),
                    },
                )
                .is_some()
            {
                bail!(
                    "duplicate ScanPack start height {}",
                    descriptor.start_height
                );
            }
        }

        let mut previous: Option<(u64, u64)> = None;
        for (start, pack) in &packs {
            if let Some((previous_start, previous_end)) = previous {
                if *start < previous_end {
                    bail!(
                        "overlapping ScanPacks: {}..{} and {}..{}",
                        previous_start,
                        previous_end,
                        start,
                        pack.end_height
                    );
                }
                if *start > previous_end {
                    bail!(
                        "gap between ScanPacks: {}..{} then {}..{}",
                        previous_start,
                        previous_end,
                        start,
                        pack.end_height
                    );
                }
            }
            previous = Some((*start, pack.end_height));
        }

        self.packs = packs;
        self.decoded_packs.clear();
        self.manifest = Some(manifest);
        self.status = Some(status);
        self.last_refresh = Instant::now();
        Ok(())
    }

    fn covering_pack(&self, height: u64) -> Option<&IndexedPack> {
        let (_, pack) = self
            .packs
            .range((Bound::Unbounded, Bound::Included(height)))
            .next_back()?;
        (height < pack.end_height).then_some(pack)
    }

    fn load_pack(&mut self, indexed: &IndexedPack) -> Result<Arc<ScanPack>> {
        if let Some(position) =
            self.decoded_packs
                .iter()
                .position(|(cached_path, cached_hash, _)| {
                    cached_path == &indexed.path && cached_hash == &indexed.sha256
                })
        {
            let cached = self
                .decoded_packs
                .remove(position)
                .expect("cached position must remain valid");
            let pack = cached.2.clone();
            self.decoded_packs.push_back(cached);
            return Ok(pack);
        }

        verify_pack_file(
            &self.directory,
            &scanpack_format::PackDescriptor {
                file: indexed
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .context("ScanPack filename is invalid")?
                    .to_owned(),
                start_height: read_pack_metadata(&indexed.path)?.start_height,
                end_height: indexed.end_height,
                sha256: indexed.sha256.clone(),
                start_block_hash: indexed.start_block_hash.clone(),
                end_block_hash: indexed.end_block_hash.clone(),
            },
        )?;
        let pack = Arc::new(read_pack(&indexed.path)?);
        validate_pack_boundary_hashes(&pack, &indexed.start_block_hash, &indexed.end_block_hash)?;
        if self.decoded_packs.len() == DECODED_PACK_CACHE_SIZE {
            self.decoded_packs.pop_front();
        }
        self.decoded_packs
            .push_back((indexed.path.clone(), indexed.sha256.clone(), pack.clone()));
        Ok(pack)
    }
}

fn validate_status_binding(
    manifest: &VerifiedManifest,
    status: &VerifiedStatus,
    expected_network: &str,
    max_lag_blocks: u64,
    max_status_age: Duration,
) -> Result<()> {
    let body = &status.signed.body;
    let manifest_body = &manifest.signed.body;
    if body.network != expected_network
        || body.manifest_generation != manifest_body.generation
        || body.manifest_hash != manifest.manifest_hash
        || body.manifest_end_height != manifest_body.end_height
    {
        bail!("ScanPack status does not bind the current manifest");
    }
    let health = scanpack_health(
        manifest,
        status,
        now_seconds(),
        max_lag_blocks,
        max_status_age,
    );
    if !health.available {
        bail!(
            "ScanPack is unavailable: canonical={} lag_blocks={} status_age_seconds={}",
            body.manifest_canonical,
            health.lag_blocks,
            health.status_age_seconds
        );
    }
    Ok(())
}

fn scanpack_health(
    manifest: &VerifiedManifest,
    status: &VerifiedStatus,
    now: u64,
    max_lag_blocks: u64,
    max_status_age: Duration,
) -> ScanPackHealth {
    let body = &status.signed.body;
    let age = now.saturating_sub(body.observed_at_unix_seconds);
    let future_ok =
        body.observed_at_unix_seconds <= now.saturating_add(MAX_STATUS_FUTURE_SKEW_SECONDS);
    let lag = body
        .canonical_height
        .saturating_sub(body.manifest_end_height);
    ScanPackHealth {
        available: body.manifest_canonical
            && future_ok
            && lag <= max_lag_blocks
            && age <= max_status_age.as_secs(),
        generation: manifest.signed.body.generation,
        manifest_end_height: body.manifest_end_height,
        canonical_height: body.canonical_height,
        lag_blocks: lag,
        status_age_seconds: age,
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn verify_manifest_chain(
    directory: &Path,
    previous: &VerifiedManifest,
    current: &VerifiedManifest,
    verifying_key: &VerifyingKey,
    expected_network: &str,
) -> Result<()> {
    let mut parent_generation = previous.signed.body.generation;
    let mut parent_hash = previous.manifest_hash.clone();
    let first_generation = parent_generation
        .checked_add(1)
        .context("ScanPack manifest generation overflow")?;
    for generation in first_generation..=current.signed.body.generation {
        let child = if generation == current.signed.body.generation {
            current.clone()
        } else {
            load_verified_manifest_generation(directory, generation, verifying_key)?
        };
        if child.signed.body.network != expected_network
            || child.signed.body.generation != generation
            || child.signed.body.previous_generation != Some(parent_generation)
            || child.signed.body.previous_manifest_hash.as_deref() != Some(parent_hash.as_str())
        {
            bail!("ScanPack manifest generation chain is invalid");
        }
        parent_generation = generation;
        parent_hash = child.manifest_hash;
    }
    Ok(())
}

fn validate_pack_boundary_hashes(
    pack: &ScanPack,
    expected_start: &str,
    expected_end: &str,
) -> Result<()> {
    let decoded = decode_block_entries(
        pack.metadata.start_height,
        &pack.blocks,
        &pack.output_indices,
    )?;
    validate_chain_continuity(None, &decoded)?;
    let first = decoded.first().context("decoded ScanPack is empty")?;
    let last = decoded.last().context("decoded ScanPack is empty")?;
    if first.hash != expected_start || last.hash != expected_end {
        bail!("ScanPack block boundary hash does not match signed manifest");
    }
    Ok(())
}

impl BlockSource for ScanPackBlockSource {
    fn next_blocks(
        &mut self,
        network: Network,
        from_height_exclusive: u64,
        max_blocks: usize,
    ) -> Result<Vec<ScannedBlock>> {
        if network != self.network {
            bail!(
                "ScanPack network mismatch: source={} request={}",
                self.network,
                network
            );
        }
        if max_blocks == 0 {
            return Ok(Vec::new());
        }
        self.refresh_if_due()?;

        let mut next_height = from_height_exclusive
            .checked_add(1)
            .context("ScanPack start height overflow")?;
        let mut decoded = Vec::with_capacity(max_blocks);
        let mut previous_hash: Option<[u8; 32]> = None;

        while decoded.len() < max_blocks {
            let Some(indexed) = self.covering_pack(next_height).cloned() else {
                // A cache miss is safe: the identity cursor is not advanced.
                break;
            };
            let pack = self
                .load_pack(&indexed)
                .with_context(|| format!("failed to read ScanPack {}", indexed.path.display()))?;
            if pack.metadata.end_height != indexed.end_height {
                // The sole mutable live-tail package is replaced atomically.
                // Refresh once so the in-memory interval follows the new file.
                self.refresh()?;
            }
            let offset = usize::try_from(
                next_height
                    .checked_sub(pack.metadata.start_height)
                    .context("ScanPack does not cover requested height")?,
            )?;
            if offset >= pack.blocks.len() {
                bail!(
                    "ScanPack {} does not contain requested height {}",
                    indexed.path.display(),
                    next_height
                );
            }
            let take = (max_blocks - decoded.len()).min(pack.blocks.len() - offset);
            let end = offset + take;
            let mut this_pack = decode_block_entries(
                next_height,
                &pack.blocks[offset..end],
                &pack.output_indices[offset..end],
            )?;
            validate_chain_continuity(previous_hash, &this_pack)?;
            previous_hash = this_pack
                .last()
                .and_then(|block| decode_hash(&block.hash).ok());
            decoded.append(&mut this_pack);
            next_height = next_height
                .checked_add(u64::try_from(take)?)
                .context("ScanPack next height overflow")?;
        }

        Ok(decoded)
    }

    fn canonical_block_hash(&mut self, network: Network, height: u64) -> Result<Option<String>> {
        if network != self.network {
            bail!(
                "ScanPack network mismatch: source={} request={}",
                self.network,
                network
            );
        }
        self.refresh_if_due()?;
        let Some(indexed) = self.covering_pack(height).cloned() else {
            return Ok(None);
        };
        let pack = self.load_pack(&indexed)?;
        let offset = usize::try_from(
            height
                .checked_sub(pack.metadata.start_height)
                .context("ScanPack cursor is outside the package")?,
        )?;
        let decoded = decode_block_entries(
            height,
            &pack.blocks[offset..offset + 1],
            &pack.output_indices[offset..offset + 1],
        )?;
        Ok(decoded.first().map(|block| block.hash.clone()))
    }
}

fn validate_chain_continuity(
    previous_hash: Option<[u8; 32]>,
    blocks: &[ScannedBlock],
) -> Result<()> {
    let mut expected_previous = previous_hash;
    for block in blocks {
        let scannable = block
            .scannable_block
            .as_ref()
            .context("decoded ScanPack block has no scannable payload")?;
        if let Some(expected) = expected_previous {
            if scannable.block.header.previous != expected {
                bail!("ScanPack chain discontinuity at height {}", block.height);
            }
        }
        expected_previous = Some(decode_hash(&block.hash)?);
    }
    Ok(())
}

fn decode_hash(value: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value).context("block hash is not hex")?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("block hash is not 32 bytes"))
}

fn validate_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect ScanPack directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "ScanPack directory must be a real directory, not a symlink: {}",
            path.display()
        );
    }
    validate_not_group_or_world_writable(path, &metadata)
}

fn open_read_only_regular(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .with_context(|| format!("failed to open ScanPack {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("ScanPack is not a regular file: {}", path.display());
    }
    validate_not_group_or_world_writable(path, &metadata)?;
    if metadata.len() < FIXED_HEADER_BYTES || metadata.len() > MAX_PACK_FILE_BYTES {
        bail!(
            "ScanPack file size is outside the accepted range: {} bytes",
            metadata.len()
        );
    }
    #[cfg(unix)]
    {
        let path_metadata = fs::metadata(path)?;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            bail!("ScanPack changed while opening: {}", path.display());
        }
        if file.as_raw_fd() < 0 {
            bail!("ScanPack file descriptor is invalid");
        }
    }
    Ok(file)
}

fn validate_not_group_or_world_writable(path: &Path, metadata: &Metadata) -> Result<()> {
    #[cfg(unix)]
    if metadata.mode() & 0o022 != 0 {
        bail!(
            "ScanPack path must not be group- or world-writable: {}",
            path.display()
        );
    }
    Ok(())
}

fn read_pack_metadata(path: &Path) -> Result<ScanPackMetadata> {
    let mut reader = BufReader::new(open_read_only_regular(path)?);
    read_pack_metadata_from(&mut reader)
}

fn read_pack(path: &Path) -> Result<ScanPack> {
    let mut reader = BufReader::new(open_read_only_regular(path)?);
    let metadata = read_pack_metadata_from(&mut reader)?;
    let mut blocks = Vec::with_capacity(metadata.block_count);
    let mut output_indices = Vec::with_capacity(metadata.block_count);

    for _ in 0..metadata.block_count {
        let mut pruned = [0; 1];
        reader.read_exact(&mut pruned)?;
        let block_weight = read_u64(&mut reader)?;
        let block = Bytes::from(read_bytes(&mut reader)?);
        let mut tag = [0; 1];
        reader.read_exact(&mut tag)?;
        let tx_count = usize::try_from(read_u32(&mut reader)?)?;
        if tx_count > MAX_TXS_PER_BLOCK {
            bail!("ScanPack has too many transactions in one block");
        }
        let txs = match tag[0] {
            0 => TransactionBlobs::Normal(
                (0..tx_count)
                    .map(|_| read_bytes(&mut reader).map(Bytes::from))
                    .collect::<Result<Vec<_>>>()?,
            ),
            1 => TransactionBlobs::Pruned(
                (0..tx_count)
                    .map(|_| {
                        let blob = Bytes::from(read_bytes(&mut reader)?);
                        let mut hash = [0; 32];
                        reader.read_exact(&mut hash)?;
                        Ok(PrunedTxBlobEntry {
                            blob,
                            prunable_hash: ByteArray::from(hash),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            2 if tx_count == 0 => TransactionBlobs::None,
            _ => bail!("invalid ScanPack transaction tag"),
        };

        let tx_index_count = usize::try_from(read_u32(&mut reader)?)?;
        if tx_index_count > MAX_TX_INDEX_LISTS_PER_BLOCK {
            bail!("ScanPack has too many transaction index lists");
        }
        let mut per_block = Vec::with_capacity(tx_index_count);
        for _ in 0..tx_index_count {
            let index_count = usize::try_from(read_u32(&mut reader)?)?;
            if index_count > MAX_INDICES_PER_TX {
                bail!("ScanPack has too many output indices");
            }
            let mut indices = Vec::with_capacity(index_count);
            for _ in 0..index_count {
                indices.push(read_u64(&mut reader)?);
            }
            per_block.push(TxOutputIndices { indices });
        }
        blocks.push(BlockCompleteEntry {
            pruned: pruned[0] != 0,
            block,
            block_weight,
            txs,
        });
        output_indices.push(BlockOutputIndices { indices: per_block });
    }

    let mut trailing = [0; 1];
    if reader.read(&mut trailing)? != 0 {
        bail!("ScanPack has trailing bytes");
    }
    Ok(ScanPack {
        metadata,
        blocks,
        output_indices,
    })
}

fn read_pack_metadata_from(reader: &mut impl Read) -> Result<ScanPackMetadata> {
    let mut magic = [0; 8];
    reader.read_exact(&mut magic)?;
    if &magic != MAGIC {
        bail!("invalid ScanPack magic");
    }
    if read_u32(reader)? != FORMAT_VERSION {
        bail!("unsupported ScanPack version");
    }
    let start_height = read_u64(reader)?;
    let end_height = read_u64(reader)?;
    let block_count = usize::try_from(read_u32(reader)?)?;
    if block_count == 0 || block_count > MAX_PACK_BLOCKS {
        bail!("invalid ScanPack block count");
    }
    if end_height.checked_sub(start_height) != Some(u64::try_from(block_count)?) {
        bail!("ScanPack height interval mismatch");
    }
    Ok(ScanPackMetadata {
        start_height,
        end_height,
        block_count,
    })
}

fn read_u32(reader: &mut impl Read) -> std::io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> std::io::Result<u64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_bytes(reader: &mut impl Read) -> Result<Vec<u8>> {
    let length = usize::try_from(read_u32(reader)?)?;
    if length > MAX_ITEM_BYTES {
        bail!("ScanPack item exceeds size limit");
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use monero_oxide::{
        block::{Block, BlockHeader},
        transaction::{Input, Timelock, Transaction, TransactionPrefix},
    };
    use std::io::Write;
    use tempfile::tempdir;

    fn write_u32(writer: &mut impl Write, value: u32) {
        writer.write_all(&value.to_le_bytes()).unwrap();
    }

    fn write_u64(writer: &mut impl Write, value: u64) {
        writer.write_all(&value.to_le_bytes()).unwrap();
    }

    fn write_bytes(writer: &mut impl Write, value: &[u8]) {
        write_u32(writer, u32::try_from(value.len()).unwrap());
        writer.write_all(value).unwrap();
    }

    fn test_entry(previous: [u8; 32]) -> BlockCompleteEntry {
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
                previous,
                nonce: 0,
            },
            miner,
            vec![],
        )
        .unwrap();
        BlockCompleteEntry {
            pruned: true,
            block: Bytes::from(block.serialize()),
            block_weight: 0,
            txs: TransactionBlobs::None,
        }
    }

    fn write_test_pack(
        path: &Path,
        start_height: u64,
        entries: &[BlockCompleteEntry],
        add_trailing_byte: bool,
    ) {
        let mut file = File::create(path).unwrap();
        file.write_all(MAGIC).unwrap();
        write_u32(&mut file, FORMAT_VERSION);
        write_u64(&mut file, start_height);
        write_u64(
            &mut file,
            start_height + u64::try_from(entries.len()).unwrap(),
        );
        write_u32(&mut file, u32::try_from(entries.len()).unwrap());
        for entry in entries {
            file.write_all(&[u8::from(entry.pruned)]).unwrap();
            write_u64(&mut file, entry.block_weight);
            write_bytes(&mut file, &entry.block);
            file.write_all(&[2]).unwrap();
            write_u32(&mut file, 0);
            write_u32(&mut file, 0);
        }
        if add_trailing_byte {
            file.write_all(&[1]).unwrap();
        }
        file.sync_all().unwrap();
    }

    fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[42; 32])
    }

    fn publish_test_manifest(
        directory: &Path,
        path: &Path,
        start_height: u64,
        entries: &[BlockCompleteEntry],
    ) {
        let hashes = entries
            .iter()
            .map(|entry| {
                let mut bytes = entry.block.as_ref();
                hex::encode(Block::read(&mut bytes).unwrap().hash())
            })
            .collect::<Vec<_>>();
        let end_height = start_height + u64::try_from(entries.len()).unwrap();
        let sha256 = scanpack_format::sha256_file(path).unwrap();
        let final_path =
            directory.join(scanpack_format::pack_file_name(start_height, &sha256).unwrap());
        fs::rename(path, &final_path).unwrap();
        let descriptor = scanpack_format::PackDescriptor {
            file: final_path.file_name().unwrap().to_str().unwrap().to_owned(),
            start_height,
            end_height,
            sha256,
            start_block_hash: hashes.first().unwrap().clone(),
            end_block_hash: hashes.last().unwrap().clone(),
        };
        let body = scanpack_format::ManifestBody {
            schema_version: scanpack_format::MANIFEST_SCHEMA_VERSION,
            network: "mainnet".to_owned(),
            generation: 1,
            previous_generation: None,
            previous_manifest_hash: None,
            published_at_unix_seconds: 1_700_000_000,
            replaces_from_height: None,
            start_height,
            end_height,
            blocks_per_pack: u32::try_from(entries.len()).unwrap(),
            start_block_hash: descriptor.start_block_hash.clone(),
            end_block_hash: descriptor.end_block_hash.clone(),
            packs: vec![descriptor],
        };
        let key = test_signing_key();
        let signed = scanpack_format::SignedManifest::sign(body, &key).unwrap();
        scanpack_format::publish_manifest_atomic(directory, &signed, &key.verifying_key()).unwrap();
        publish_test_status(directory, now_seconds(), true, end_height);
    }

    fn publish_test_status(
        directory: &Path,
        observed_at: u64,
        manifest_canonical: bool,
        canonical_height: u64,
    ) {
        let key = test_signing_key();
        let manifest = load_verified_manifest(directory, &key.verifying_key()).unwrap();
        let status = scanpack_format::SignedStatus::sign(
            scanpack_format::StatusBody {
                schema_version: scanpack_format::STATUS_SCHEMA_VERSION,
                network: manifest.signed.body.network.clone(),
                manifest_generation: manifest.signed.body.generation,
                manifest_hash: manifest.manifest_hash.clone(),
                manifest_end_height: manifest.signed.body.end_height,
                manifest_canonical,
                canonical_height,
                canonical_tip_hash: manifest.signed.body.end_block_hash.clone(),
                observed_at_unix_seconds: observed_at,
            },
            &key,
        )
        .unwrap();
        scanpack_format::publish_status_atomic(directory, &status, &key.verifying_key()).unwrap();
    }

    fn republish_next_generation(directory: &Path) {
        let key = test_signing_key();
        let previous = load_verified_manifest(directory, &key.verifying_key()).unwrap();
        let mut body = previous.signed.body;
        body.generation += 1;
        body.previous_generation = Some(body.generation - 1);
        body.previous_manifest_hash = Some(previous.manifest_hash);
        body.published_at_unix_seconds += 1;
        let signed = scanpack_format::SignedManifest::sign(body, &key).unwrap();
        scanpack_format::publish_manifest_atomic(directory, &signed, &key.verifying_key()).unwrap();
        let current = load_verified_manifest(directory, &key.verifying_key()).unwrap();
        publish_test_status(
            directory,
            now_seconds(),
            true,
            current.signed.body.end_height,
        );
    }

    #[test]
    fn reads_scanpack_directly_and_decodes_blocks() {
        let directory = tempdir().unwrap();
        let first = test_entry([0; 32]);
        let first_block = {
            let mut bytes = first.block.as_ref();
            Block::read(&mut bytes).unwrap()
        };
        let second = test_entry(first_block.hash());
        let path = directory.path().join(".test-pack.mwsp");
        write_test_pack(&path, 100, &[first, second], false);
        let entries = read_pack(&path).unwrap().blocks;
        publish_test_manifest(directory.path(), &path, 100, &entries);

        let mut source = ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .unwrap();
        let blocks = source.next_blocks(Network::Mainnet, 99, 2).unwrap();

        assert_eq!(source.cached_interval(), Some((100, 102)));
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].height, 100);
        assert_eq!(blocks[1].height, 101);
    }

    #[test]
    fn rejects_trailing_bytes_and_wrong_network() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".test-pack.mwsp");
        write_test_pack(&path, 100, &[test_entry([0; 32])], true);
        assert!(read_pack(&path)
            .unwrap_err()
            .to_string()
            .contains("trailing bytes"));

        write_test_pack(&path, 100, &[test_entry([0; 32])], false);
        let entries = read_pack(&path).unwrap().blocks;
        publish_test_manifest(directory.path(), &path, 100, &entries);
        let mut source = ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .unwrap();
        assert!(source.next_blocks(Network::Stagenet, 99, 1).is_err());
    }

    #[test]
    fn verifies_skipped_generations_through_immutable_history() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".test-pack.mwsp");
        let entry = test_entry([0; 32]);
        write_test_pack(&path, 100, &[entry], false);
        let entries = read_pack(&path).unwrap().blocks;
        publish_test_manifest(directory.path(), &path, 100, &entries);
        let mut source = ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .unwrap();

        republish_next_generation(directory.path());
        republish_next_generation(directory.path());
        source.refresh().unwrap();
        assert_eq!(source.manifest.as_ref().unwrap().signed.body.generation, 3);
    }

    #[test]
    fn rejects_stale_lagging_or_noncanonical_status() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".test-pack.mwsp");
        let entry = test_entry([0; 32]);
        write_test_pack(&path, 100, &[entry], false);
        let entries = read_pack(&path).unwrap().blocks;
        publish_test_manifest(directory.path(), &path, 100, &entries);

        publish_test_status(directory.path(), now_seconds() - 301, true, 101);
        assert!(ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .is_err());

        publish_test_status(directory.path(), now_seconds(), true, 102);
        assert!(ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .is_err());

        publish_test_status(directory.path(), now_seconds(), false, 101);
        assert!(ScanPackBlockSource::open(
            directory.path(),
            Network::Mainnet,
            Duration::from_secs(30),
            test_signing_key().verifying_key(),
            0,
            Duration::from_secs(300),
        )
        .is_err());
    }

    #[test]
    #[ignore = "requires a real read-only Cuprate ScanPack directory"]
    fn reads_live_scanpack_tail_without_writing() {
        let directory = std::env::var("NOTIFY_SCANNER_TEST_SCANPACK_DIRECTORY")
            .expect("NOTIFY_SCANNER_TEST_SCANPACK_DIRECTORY is required");
        let public_key = hex::decode(
            std::env::var("NOTIFY_SCANNER_TEST_SCANPACK_PUBLIC_KEY")
                .expect("NOTIFY_SCANNER_TEST_SCANPACK_PUBLIC_KEY is required"),
        )
        .unwrap()
        .try_into()
        .unwrap();
        let mut source = ScanPackBlockSource::open(
            directory,
            Network::Mainnet,
            Duration::from_secs(30),
            VerifyingKey::from_bytes(&public_key).unwrap(),
            3,
            Duration::from_secs(60),
        )
        .unwrap();
        let (_, end_height) = source
            .cached_interval()
            .expect("the live ScanPack directory must not be empty");
        let target_height = end_height
            .checked_sub(2)
            .expect("the live ScanPack must contain at least two blocks");
        let blocks = source
            .next_blocks(Network::Mainnet, target_height - 1, 2)
            .unwrap();

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].height, target_height);
        assert_eq!(blocks[1].height, target_height + 1);
        assert!(blocks[0].scannable_block.is_some());
        assert!(blocks[1].scannable_block.is_some());
    }
}
