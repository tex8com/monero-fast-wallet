//! Compatibility adapter; randomness is still supplied by the caller's CSRNG.

/// Infallible adapter from rand_core 0.6 to rand_core 0.10.
#[doc(hidden)]
pub struct LegacyRng<'a, R: rand_core::RngCore + ?Sized>(pub &'a mut R);

impl<R: rand_core::RngCore + ?Sized> rand_core_10::TryRng for LegacyRng<'_, R> {
    type Error = core::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(self.0.next_u32())
    }
    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        Ok(self.0.next_u64())
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        self.0.fill_bytes(dst);
        Ok(())
    }
}
