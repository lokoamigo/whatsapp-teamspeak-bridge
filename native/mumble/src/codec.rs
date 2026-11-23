//! Small, ownership-scoped libopus interface. Codec instances stay on their
//! audio thread; neither C pointers nor mutable codec state are shared.
use anyhow::{Result, bail};
use std::ffi::{c_int, c_uchar, c_void};
use std::ptr::NonNull;

pub const RATE: usize = 48_000;
pub const FRAME: usize = 960; // 20 ms mono
pub const MAX_FRAME: usize = 5760; // Opus permits up to 120 ms per packet.

#[link(name = "opus")]
unsafe extern "C" {
    fn opus_encoder_create(
        rate: c_int,
        channels: c_int,
        application: c_int,
        error: *mut c_int,
    ) -> *mut c_void;
    fn opus_encoder_destroy(encoder: *mut c_void);
    fn opus_encoder_ctl(encoder: *mut c_void, request: c_int, ...) -> c_int;
    fn opus_encode(
        encoder: *mut c_void,
        pcm: *const i16,
        frame_size: c_int,
        data: *mut c_uchar,
        max_bytes: c_int,
    ) -> c_int;
    fn opus_decoder_create(rate: c_int, channels: c_int, error: *mut c_int) -> *mut c_void;
    fn opus_decoder_destroy(decoder: *mut c_void);
    fn opus_decode(
        decoder: *mut c_void,
        data: *const c_uchar,
        len: c_int,
        pcm: *mut i16,
        frame_size: c_int,
        fec: c_int,
    ) -> c_int;
    fn opus_packet_get_nb_samples(packet: *const c_uchar, len: c_int, rate: c_int) -> c_int;
}

pub struct Encoder(NonNull<c_void>);
pub struct Decoder(NonNull<c_void>);

impl Encoder {
    pub fn new(bitrate: i32) -> Result<Self> {
        let mut error = 0;
        // SAFETY: libopus owns the returned allocation; all parameters follow
        // the documented mono VOIP configuration. Drop frees it exactly once.
        let ptr = unsafe { opus_encoder_create(RATE as i32, 1, 2048, &mut error) };
        let encoder =
            Self(NonNull::new(ptr).ok_or_else(|| anyhow::anyhow!("Opus encoder: {error}"))?);
        unsafe {
            // SET_BITRATE, SET_COMPLEXITY and SET_INBAND_FEC requests.
            if opus_encoder_ctl(encoder.0.as_ptr(), 4002, bitrate) != 0
                || opus_encoder_ctl(encoder.0.as_ptr(), 4010, 5i32) != 0
                || opus_encoder_ctl(encoder.0.as_ptr(), 4012, 1i32) != 0
            {
                bail!("Cannot configure Opus encoder");
            }
        }
        Ok(encoder)
    }

    pub fn encode(&mut self, pcm: &[i16; FRAME]) -> Result<Vec<u8>> {
        let mut packet = vec![0; 512];
        // SAFETY: both slices cover the lengths supplied to libopus.
        let size = unsafe {
            opus_encode(
                self.0.as_ptr(),
                pcm.as_ptr(),
                FRAME as i32,
                packet.as_mut_ptr(),
                packet.len() as i32,
            )
        };
        if size < 0 {
            bail!("Opus encode: {size}");
        }
        packet.truncate(size as usize);
        Ok(packet)
    }

    pub fn reset(&mut self) -> Result<()> {
        // OPUS_RESET_STATE takes no additional argument.
        if unsafe { opus_encoder_ctl(self.0.as_ptr(), 4028) } != 0 {
            bail!("Cannot reset Opus encoder");
        }
        Ok(())
    }
}

impl Decoder {
    pub fn new() -> Result<Self> {
        let mut error = 0;
        let ptr = unsafe { opus_decoder_create(RATE as i32, 1, &mut error) };
        Ok(Self(
            NonNull::new(ptr).ok_or_else(|| anyhow::anyhow!("Opus decoder: {error}"))?,
        ))
    }

    pub fn samples(packet: &[u8]) -> Result<usize> {
        if packet.is_empty() || packet.len() > 8192 {
            bail!("Invalid Opus packet size");
        }
        let samples = unsafe {
            opus_packet_get_nb_samples(packet.as_ptr(), packet.len() as i32, RATE as i32)
        };
        if samples <= 0 || samples as usize > MAX_FRAME {
            bail!("Invalid Opus frame duration");
        }
        Ok(samples as usize)
    }

    pub fn decode(&mut self, packet: Option<&[u8]>, samples: usize) -> Result<Vec<i16>> {
        if samples == 0 || samples > MAX_FRAME {
            bail!("Invalid decode buffer size");
        }
        let (ptr, len) = packet.map_or((std::ptr::null(), 0), |p| (p.as_ptr(), p.len() as i32));
        let mut pcm = vec![0; samples];
        let decoded = unsafe {
            opus_decode(
                self.0.as_ptr(),
                ptr,
                len,
                pcm.as_mut_ptr(),
                samples as i32,
                0,
            )
        };
        if decoded < 0 {
            bail!("Opus decode: {decoded}");
        }
        pcm.truncate(decoded as usize);
        Ok(pcm)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.0.as_ptr()) }
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { opus_decoder_destroy(self.0.as_ptr()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opus_roundtrip_and_loss_concealment() {
        let pcm = std::array::from_fn(|i| ((i as f32 * 0.0576).sin() * 8000.) as i16);
        let packet = Encoder::new(32000).unwrap().encode(&pcm).unwrap();
        assert_eq!(Decoder::samples(&packet).unwrap(), FRAME);
        let mut decoder = Decoder::new().unwrap();
        let decoded = decoder.decode(Some(&packet), FRAME).unwrap();
        assert_eq!(decoded.len(), FRAME);
        assert!(decoded.iter().any(|sample| sample.abs() > 100));
        assert_eq!(decoder.decode(None, FRAME).unwrap().len(), FRAME);
        assert!(Decoder::samples(&[]).is_err());
    }
}
