//! Regression coverage for clocks with Windows FILETIME's 100 ns resolution.

use std::{cell::Cell, time::Duration};

use crate::{
    SaturatingTime as PublicTime,
    internal::{self, SaturatingTime},
};

/// A bounded clock whose checked arithmetic truncates to 100 ns ticks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CoarseTime(u64);

impl SaturatingTime for CoarseTime {
    fn anchor() -> Self {
        Self(500)
    }
    fn max_value() -> Self {
        Self(1000)
    }
    fn min_value() -> Self {
        Self(0)
    }

    fn checked_add(&self, duration: Duration) -> Option<Self> {
        let ticks = u64::try_from(duration.as_nanos() / 100).ok()?;
        self.0
            .checked_add(ticks)
            .filter(|value| *value <= 1000)
            .map(Self)
    }

    fn checked_sub(&self, duration: Duration) -> Option<Self> {
        let ticks = u64::try_from(duration.as_nanos() / 100).ok()?;
        self.0.checked_sub(ticks).map(Self)
    }

    fn checked_duration_since(&self, earlier: Self) -> Option<Duration> {
        self.0
            .checked_sub(earlier.0)
            .map(|ticks| Duration::from_nanos(ticks * 100))
    }
}

impl PublicTime for CoarseTime {}

/// Bound calls so removing the no-progress fix fails instead of hanging tests.
fn bounded_limit(subtract: bool) -> CoarseTime {
    let calls = Cell::new(0_u32);
    internal::find_limit(|time: &CoarseTime, step| {
        calls.set(calls.get() + 1);
        assert!(calls.get() < 512, "limit search did not terminate");
        if subtract {
            time.checked_sub(step)
        } else {
            time.checked_add(step)
        }
    })
}

#[test]
fn coarse_clock_max_search_terminates_at_exact_boundary() {
    assert_eq!(bounded_limit(false), CoarseTime(1000));
    assert_eq!(
        CoarseTime(1000).checked_add(Duration::from_nanos(1)),
        Some(CoarseTime(1000))
    );
    assert_eq!(
        CoarseTime(1000).checked_add(Duration::from_nanos(100)),
        None
    );
}

#[test]
fn coarse_clock_min_search_terminates_at_exact_boundary() {
    assert_eq!(bounded_limit(true), CoarseTime(0));
    assert_eq!(
        CoarseTime(0).checked_sub(Duration::from_nanos(1)),
        Some(CoarseTime(0))
    );
    assert_eq!(CoarseTime(0).checked_sub(Duration::from_nanos(100)), None);
}

#[test]
fn coarse_clock_overflow_and_underflow_saturate() {
    assert_eq!(
        CoarseTime(500).saturating_add(Duration::MAX),
        CoarseTime(1000)
    );
    assert_eq!(CoarseTime(500).saturating_sub(Duration::MAX), CoarseTime(0));
    assert_eq!(
        CoarseTime(500).saturating_add(Duration::ZERO),
        CoarseTime(500)
    );
    assert_eq!(
        CoarseTime(500).saturating_sub(Duration::ZERO),
        CoarseTime(500)
    );
}

/// Successful arithmetic must never evaluate either fallback limit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LimitsMustNotRun(CoarseTime);

impl SaturatingTime for LimitsMustNotRun {
    fn anchor() -> Self {
        Self(CoarseTime::anchor())
    }
    fn max_value() -> Self {
        panic!("successful addition evaluated max_value")
    }
    fn min_value() -> Self {
        panic!("successful subtraction evaluated min_value")
    }
    fn checked_add(&self, duration: Duration) -> Option<Self> {
        self.0.checked_add(duration).map(Self)
    }
    fn checked_sub(&self, duration: Duration) -> Option<Self> {
        self.0.checked_sub(duration).map(Self)
    }
    fn checked_duration_since(&self, earlier: Self) -> Option<Duration> {
        self.0.checked_duration_since(earlier.0)
    }
}

impl PublicTime for LimitsMustNotRun {}

#[test]
fn successful_addition_does_not_evaluate_maximum() {
    let now = LimitsMustNotRun(CoarseTime(500));
    assert_eq!(
        now.saturating_add(Duration::from_nanos(100)),
        LimitsMustNotRun(CoarseTime(501))
    );
    assert_eq!(now.saturating_add(Duration::ZERO), now);
}

#[test]
fn successful_subtraction_does_not_evaluate_minimum() {
    let now = LimitsMustNotRun(CoarseTime(500));
    assert_eq!(
        now.saturating_sub(Duration::from_nanos(100)),
        LimitsMustNotRun(CoarseTime(499))
    );
    assert_eq!(now.saturating_sub(Duration::ZERO), now);
}
