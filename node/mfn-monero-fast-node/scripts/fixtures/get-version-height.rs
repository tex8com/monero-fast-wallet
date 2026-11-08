//! Real get_version, chain_height and top_height functions; no node or network.
#![allow(dead_code)]
use std::{future::Future, pin::pin, task::{Context, Poll, Waker}};

type Error = &'static str;
const CORE_RPC_VERSION: u32 = 3 << 16;
const RELEASE: bool = false;

struct BlockchainReadHandle { count: usize, ready_error: bool, read_error: bool }
enum BlockchainReadRequest { ChainHeight }
enum BlockchainResponse { ChainHeight(usize, [u8; 32]), Other }
impl BlockchainReadHandle {
    async fn ready(&mut self) -> Result<&mut Self, Error> {
        if self.ready_error { Err("backend unavailable") } else { Ok(self) }
    }
    async fn call(&mut self, _: BlockchainReadRequest) -> Result<BlockchainResponse, Error> {
        if self.read_error { Err("chain height read failed") }
        else { Ok(BlockchainResponse::ChainHeight(self.count, [0; 32])) }
    }
}
fn usize_to_u64(value: usize) -> u64 { u64::try_from(value).unwrap() }
struct CupratedRpcHandler { blockchain_read: BlockchainReadHandle, blockchain_context: () }
struct GetVersionRequest;
#[derive(Debug)]
struct GetVersionResponse {
    base: bool, version: u32, release: bool, current_height: u64,
    target_height: u64, hard_forks: Vec<HardForkEntry>,
}
#[derive(Debug, Clone, Copy, PartialEq)]
enum HardFork { V16, V17 }
impl HardFork {
    const COUNT: usize = 2;
    const VARIANTS: &'static [Self] = &[Self::V16, Self::V17];
    fn from_version(version: u8) -> Option<Self> {
        match version { 16 => Some(Self::V16), 17 => Some(Self::V17), _ => None }
    }
}
struct HardForkInfo { earliest_height: u64, version: u8 }
#[derive(Debug)]
struct HardForkEntry { height: u64, hf_version: HardFork }
mod blockchain {
    use super::*;
    include!(env!("MFW_CHAIN_HEIGHT_FUNCTION"));
}
mod helper {
    use super::*;
    pub fn response_base(value: bool) -> bool { value }
    include!(env!("MFW_TOP_HEIGHT_FUNCTION"));
}
mod blockchain_context {
    use super::*;
    pub async fn hard_fork_info(_: &mut (), hf: HardFork) -> Result<HardForkInfo, Error> {
        Ok(match hf {
            HardFork::V16 => HardForkInfo { earliest_height: 2_689_608, version: 16 },
            HardFork::V17 => HardForkInfo { earliest_height: 4_000_000, version: 17 },
        })
    }
}
include!(env!("MFW_GET_VERSION_FUNCTION"));

fn block_on<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("isolated backend unexpectedly suspended"),
    }
}
fn state(count: usize) -> CupratedRpcHandler {
    CupratedRpcHandler { blockchain_read: BlockchainReadHandle {
        count, ready_error: false, read_error: false,
    }, blockchain_context: () }
}
fn version(count: usize) -> GetVersionResponse {
    block_on(get_version(state(count), GetVersionRequest)).unwrap()
}

#[test]
fn genesis_and_live_height_are_block_counts_in_both_response_fields() {
    for count in [1, 2, 3_801_648] {
        let response = version(count);
        assert_eq!(response.current_height, usize_to_u64(count));
        assert_eq!(response.target_height, usize_to_u64(count));
    }
}
#[test]
fn maximal_backend_count_does_not_add_or_overflow() {
    let response = version(usize::MAX);
    assert_eq!(response.current_height, usize_to_u64(usize::MAX));
    assert_eq!(response.target_height, usize_to_u64(usize::MAX));
}
#[test]
fn empty_backend_count_does_not_underflow_a_top_index() {
    let response = version(0);
    assert_eq!(response.current_height, 0);
    assert_eq!(response.target_height, 0);
}
#[test]
fn backend_ready_failure_is_returned_without_a_fabricated_height() {
    let mut input = state(3_801_648);
    input.blockchain_read.ready_error = true;
    assert_eq!(block_on(get_version(input, GetVersionRequest)).unwrap_err(), "backend unavailable");
}
#[test]
fn backend_read_failure_is_returned_without_a_fabricated_height() {
    let mut input = state(3_801_648);
    input.blockchain_read.read_error = true;
    assert_eq!(block_on(get_version(input, GetVersionRequest)).unwrap_err(), "chain height read failed");
}
#[test]
fn header_helper_still_returns_the_zero_based_top_index() {
    let mut input = state(3_801_648);
    assert_eq!(block_on(helper::top_height(&mut input)).unwrap().0, 3_801_647);
    assert_eq!(version(3_801_648).current_height, 3_801_648);
}
#[test]
fn version_release_and_hard_fork_metadata_are_preserved() {
    let response = version(3_801_648);
    assert!(!response.base);
    assert_eq!(response.version, CORE_RPC_VERSION);
    assert_eq!(response.release, RELEASE);
    assert_eq!(response.hard_forks.len(), 2);
    assert_eq!(response.hard_forks[0].height, 2_689_608);
    assert_eq!(response.hard_forks[0].hf_version, HardFork::V16);
    assert_eq!(response.hard_forks[1].height, 4_000_000);
    assert_eq!(response.hard_forks[1].hf_version, HardFork::V17);
}
