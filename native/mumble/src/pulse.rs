//! Blocking PulseAudio streams live on dedicated audio threads, never on the
//! Tokio executor. Explicit devices keep routing independent of default nudges.
use crate::codec::{FRAME, RATE};
use anyhow::{Result, bail};
use std::ffi::{CString, c_char, c_int, c_void};
use std::ptr::NonNull;

#[repr(C)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}
#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

#[link(name = "pulse-simple")]
unsafe extern "C" {
    fn pa_simple_new(
        server: *const c_char,
        name: *const c_char,
        dir: c_int,
        device: *const c_char,
        stream: *const c_char,
        spec: *const SampleSpec,
        map: *const c_void,
        attr: *const BufferAttr,
        error: *mut c_int,
    ) -> *mut c_void;
    fn pa_simple_free(stream: *mut c_void);
    fn pa_simple_read(
        stream: *mut c_void,
        data: *mut c_void,
        bytes: usize,
        error: *mut c_int,
    ) -> c_int;
    fn pa_simple_write(
        stream: *mut c_void,
        data: *const c_void,
        bytes: usize,
        error: *mut c_int,
    ) -> c_int;
}

pub struct Stream(NonNull<c_void>);
impl Stream {
    pub fn new(device: &str, record: bool) -> Result<Self> {
        let device = CString::new(device)?;
        // PA_SAMPLE_S16LE=3; Linux runtime is little-endian amd64/arm64.
        let spec = SampleSpec {
            format: 3,
            rate: RATE as u32,
            channels: 1,
        };
        let bytes = (FRAME * 2) as u32;
        let attr = BufferAttr {
            maxlength: bytes * 8,
            // Let PulseAudio pace the playback worker through blocking
            // writes. Queue four frames and prebuffer three to absorb
            // scheduler pauses without inserting silence between frames.
            tlength: bytes * 4,
            prebuf: bytes * 3,
            minreq: bytes,
            fragsize: bytes,
        };
        let mut error = 0;
        // SAFETY: libpulse copies the strings/structs during construction;
        // the opaque result is used only by its owning thread until Drop.
        let ptr = unsafe {
            pa_simple_new(
                std::ptr::null(),
                c"bridge-mumble".as_ptr(),
                if record { 2 } else { 1 },
                device.as_ptr(),
                if record {
                    c"WhatsApp to Mumble".as_ptr()
                } else {
                    c"Mumble to WhatsApp".as_ptr()
                },
                &spec,
                std::ptr::null(),
                &attr,
                &mut error,
            )
        };
        Ok(Self(NonNull::new(ptr).ok_or_else(|| {
            anyhow::anyhow!("PulseAudio stream unavailable ({error})")
        })?))
    }

    pub fn read(&mut self, data: &mut [i16; FRAME]) -> Result<()> {
        let mut error = 0;
        if unsafe {
            pa_simple_read(
                self.0.as_ptr(),
                data.as_mut_ptr().cast(),
                size_of_val(data),
                &mut error,
            )
        } < 0
        {
            bail!("PulseAudio capture failed ({error})");
        }
        Ok(())
    }
    pub fn write(&mut self, data: &[i16; FRAME]) -> Result<()> {
        let mut error = 0;
        if unsafe {
            pa_simple_write(
                self.0.as_ptr(),
                data.as_ptr().cast(),
                size_of_val(data),
                &mut error,
            )
        } < 0
        {
            bail!("PulseAudio playback failed ({error})");
        }
        Ok(())
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { pa_simple_free(self.0.as_ptr()) }
    }
}
