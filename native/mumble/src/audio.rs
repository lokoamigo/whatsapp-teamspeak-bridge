use crate::{
    codec::{Decoder, Encoder, FRAME, RATE},
    pulse,
};
use bytes::Bytes;
use mumble_client_protocol::VoicePacket;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const MAX_SPEAKERS: usize = 32;
const MAX_PACKETS: usize = 12;
const JITTER_DELAY: Duration = Duration::from_millis(40);
const TICK: Duration = Duration::from_millis(20);

struct Packet {
    data: Bytes,
    last: bool,
}
struct Speaker {
    decoder: Decoder,
    packets: BTreeMap<u64, Packet>,
    pcm: VecDeque<i16>,
    next: u64,
    ready: Instant,
    heard: Instant,
    playing: bool,
    ended: bool,
    missing: u8,
}

impl Speaker {
    fn new(seq: u64, now: Instant) -> anyhow::Result<Self> {
        Ok(Self {
            decoder: Decoder::new()?,
            packets: BTreeMap::new(),
            pcm: VecDeque::new(),
            next: seq,
            ready: now + JITTER_DELAY,
            heard: now,
            playing: false,
            ended: false,
            missing: 0,
        })
    }

    fn push(&mut self, seq: u64, packet: Packet, now: Instant) {
        self.heard = now;
        if !self.playing {
            self.next = self.next.min(seq);
        }
        if seq < self.next || self.packets.len() >= MAX_PACKETS {
            return;
        }
        self.packets.entry(seq).or_insert(packet);
    }

    fn render(&mut self, now: Instant, mixed: &mut [i32; FRAME]) {
        if now < self.ready {
            return;
        }
        self.playing = true;
        while self.pcm.len() < FRAME && !self.ended {
            if let Some(packet) = self.packets.remove(&self.next) {
                self.missing = 0;
                if packet.data.is_empty() {
                    self.ended = true;
                    break;
                }
                let Ok(samples) = Decoder::samples(&packet.data) else {
                    self.next = self.next.saturating_add(2);
                    continue;
                };
                self.next = self.next.saturating_add((samples / (RATE / 100)) as u64);
                if let Ok(decoded) = self.decoder.decode(Some(&packet.data), samples) {
                    self.pcm.extend(decoded);
                }
                self.ended = packet.last;
            } else {
                if self.missing >= 3 {
                    self.ended = true;
                    break;
                }
                self.packets.retain(|seq, _| *seq >= self.next);
                // A 10 ms packet may follow a missing 10 ms packet: never
                // conceal past the sequence number of a packet already queued.
                let samples = self
                    .packets
                    .first_key_value()
                    .map(|(&seq, _)| ((seq - self.next) as usize * (RATE / 100)).min(FRAME))
                    .unwrap_or(FRAME);
                if samples == 0 {
                    break;
                }
                if let Ok(concealed) = self.decoder.decode(None, samples) {
                    self.pcm.extend(concealed);
                }
                self.next = self.next.saturating_add((samples / (RATE / 100)) as u64);
                self.missing += 1;
            }
        }
        for sample in mixed {
            *sample += i32::from(self.pcm.pop_front().unwrap_or(0));
        }
    }
}

pub struct Mixer {
    speakers: HashMap<u32, Speaker>,
}
impl Mixer {
    pub fn new() -> Self {
        Self {
            speakers: HashMap::new(),
        }
    }
    pub fn clear(&mut self) {
        self.speakers.clear();
    }
    pub fn push(&mut self, packet: VoicePacket, now: Instant) {
        if packet.payload.len() > 8192 || (packet.payload.is_empty() && !packet.is_last) {
            return;
        }
        let replace = self.speakers.get(&packet.session).is_some_and(|speaker| {
            (speaker.ended && speaker.pcm.is_empty())
                || packet.seq > speaker.next.saturating_add(20)
                || now.duration_since(speaker.heard) > Duration::from_secs(1)
        });
        if replace {
            self.speakers.remove(&packet.session);
        }
        if !self.speakers.contains_key(&packet.session) {
            if self.speakers.len() >= MAX_SPEAKERS {
                return;
            }
            let Ok(speaker) = Speaker::new(packet.seq, now) else {
                return;
            };
            self.speakers.insert(packet.session, speaker);
        }
        if let Some(speaker) = self.speakers.get_mut(&packet.session) {
            speaker.push(
                packet.seq,
                Packet {
                    data: packet.payload,
                    last: packet.is_last,
                },
                now,
            );
        }
    }
    pub fn render(&mut self, now: Instant) -> [i16; FRAME] {
        self.speakers
            .retain(|_, speaker| now.duration_since(speaker.heard) < Duration::from_secs(2));
        let mut mixed = [0i32; FRAME];
        for speaker in self.speakers.values_mut() {
            speaker.render(now, &mut mixed);
        }
        mixed.map(|sample| sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16)
    }
}

#[derive(Default)]
pub struct AudioState {
    pub transmit: AtomicBool,
    pub receive: AtomicBool,
    pub capture_ready: AtomicBool,
    pub playback_ready: AtomicBool,
    pub captured: AtomicU64,
    pub played: AtomicU64,
    pub dropped: AtomicU64,
    pub generation: AtomicU64,
    pub udp: AtomicBool,
    pub failed: AtomicBool,
    stopped: AtomicBool,
}

pub struct Audio {
    pub state: Arc<AudioState>,
    pub outgoing: mpsc::Receiver<Bytes>,
    incoming: std::sync::mpsc::SyncSender<(u64, VoicePacket)>,
}

struct WorkerGuard {
    state: Arc<AudioState>,
    capture: bool,
}
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if self.capture {
            self.state.capture_ready.store(false, Ordering::Relaxed);
        } else {
            self.state.playback_ready.store(false, Ordering::Relaxed);
        }
        if !self.state.stopped.load(Ordering::Relaxed) {
            self.state.failed.store(true, Ordering::Relaxed);
        }
    }
}
impl Audio {
    pub fn start(source: String, sink: String, bitrate: i32) -> Self {
        let state = Arc::new(AudioState::default());
        let (out_tx, outgoing) = mpsc::channel(8);
        let (incoming, in_rx) = std::sync::mpsc::sync_channel::<(u64, VoicePacket)>(64);
        let capture_state = state.clone();
        std::thread::spawn(move || {
            let state = capture_state;
            let _worker = WorkerGuard {
                state: state.clone(),
                capture: true,
            };
            let Ok(mut encoder) = Encoder::new(bitrate) else {
                eprintln!("Native Mumble: cannot initialize Opus encoder");
                return;
            };
            let mut stream = None;
            let mut pcm = [0; FRAME];
            let mut last_error = None;
            while !state.stopped.load(Ordering::Relaxed) {
                if stream.is_none() {
                    match pulse::Stream::new(&source, true) {
                        Ok(opened) => {
                            stream = Some(opened);
                            state.capture_ready.store(true, Ordering::Relaxed);
                        }
                        Err(error) => {
                            report_audio_error(&mut last_error, &error);
                            std::thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                if stream
                    .as_mut()
                    .expect("capture opened")
                    .read(&mut pcm)
                    .is_err()
                {
                    state.capture_ready.store(false, Ordering::Relaxed);
                    stream = None;
                    continue;
                }
                if !state.transmit.load(Ordering::Relaxed) {
                    continue;
                }
                match encoder.encode(&pcm) {
                    Ok(packet) => {
                        state.captured.fetch_add(1, Ordering::Relaxed);
                        if out_tx.try_send(Bytes::from(packet)).is_err() {
                            state.dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Err(error) => report_audio_error(&mut last_error, &error),
                }
            }
        });
        let playback_state = state.clone();
        std::thread::spawn(move || {
            let state = playback_state;
            let _worker = WorkerGuard {
                state: state.clone(),
                capture: false,
            };
            let mut stream = None;
            let mut mixer = Mixer::new();
            let mut next = Instant::now();
            let mut last_error = None;
            let mut generation = state.generation.load(Ordering::Relaxed);
            while !state.stopped.load(Ordering::Relaxed) {
                if stream.is_none() {
                    match pulse::Stream::new(&sink, false) {
                        Ok(opened) => {
                            stream = Some(opened);
                            mixer.clear();
                            state.playback_ready.store(true, Ordering::Relaxed);
                        }
                        Err(error) => {
                            report_audio_error(&mut last_error, &error);
                            std::thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                let now = Instant::now();
                let current = state.generation.load(Ordering::Relaxed);
                if generation != current {
                    mixer.clear();
                    generation = current;
                }
                // Never replay a backlog after a stalled sound server.
                if now.saturating_duration_since(next) > Duration::from_millis(100) {
                    mixer.clear();
                    next = now;
                }
                for _ in 0..64 {
                    let Ok((packet_generation, packet)) = in_rx.try_recv() else {
                        break;
                    };
                    let current = state.generation.load(Ordering::Relaxed);
                    if generation != current {
                        mixer.clear();
                        generation = current;
                    }
                    if packet_generation == generation && state.receive.load(Ordering::Relaxed) {
                        mixer.push(packet, now);
                    }
                }
                if !state.receive.load(Ordering::Relaxed) {
                    mixer.clear();
                }
                let pcm = mixer.render(now);
                if stream
                    .as_mut()
                    .expect("playback opened")
                    .write(&pcm)
                    .is_err()
                {
                    state.playback_ready.store(false, Ordering::Relaxed);
                    stream = None;
                    continue;
                }
                state.played.fetch_add(1, Ordering::Relaxed);
                next += TICK;
                std::thread::sleep(next.saturating_duration_since(Instant::now()));
            }
        });
        Self {
            state,
            outgoing,
            incoming,
        }
    }
    pub fn push(&self, packet: VoicePacket) {
        if self
            .incoming
            .try_send((self.state.generation.load(Ordering::Relaxed), packet))
            .is_err()
        {
            self.state.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn offline(&self) {
        self.state.transmit.store(false, Ordering::Relaxed);
        self.state.receive.store(false, Ordering::Relaxed);
        self.state.generation.fetch_add(1, Ordering::Relaxed);
    }
}
impl Drop for Audio {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Relaxed);
    }
}

fn report_audio_error(last: &mut Option<Instant>, error: &anyhow::Error) {
    let now = Instant::now();
    if last.is_none_or(|at| now.duration_since(at) >= Duration::from_secs(60)) {
        eprintln!("Native Mumble audio: {error}");
        *last = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mumble_client_protocol::Transport;
    fn packet(session: u32, seq: u64, data: Bytes, last: bool) -> VoicePacket {
        VoicePacket {
            session,
            seq,
            payload: data,
            is_last: last,
            via_listener: false,
            whisper: None,
            positional: None,
            transport: Transport::Tcp,
        }
    }
    #[test]
    fn reorder_deduplicate_mix_and_expire() {
        let mut encoder = Encoder::new(32000).unwrap();
        let tone = std::array::from_fn(|i| ((i as f32 * 0.0576).sin() * 4000.) as i16);
        let first = Bytes::from(encoder.encode(&tone).unwrap());
        let second = Bytes::from(encoder.encode(&tone).unwrap());
        let now = Instant::now();
        let mut one = Mixer::new();
        let mut two = Mixer::new();
        for session in [1, 2] {
            two.push(packet(session, 2, second.clone(), false), now);
            two.push(packet(session, 0, first.clone(), false), now);
            two.push(packet(session, 0, first.clone(), false), now);
        }
        one.push(packet(1, 0, first, false), now);
        one.push(packet(1, 2, second, false), now);
        assert!(two.render(now).iter().all(|s| *s == 0));
        let single = one.render(now + JITTER_DELAY);
        let mixed = two.render(now + JITTER_DELAY);
        assert!(single.iter().any(|s| s.abs() > 100));
        assert!(
            single
                .iter()
                .zip(mixed)
                .all(|(&s, m)| m == s.saturating_mul(2))
        );
        assert_eq!(two.speakers[&1].packets.len(), 1);
        assert!(
            two.render(now + Duration::from_secs(3))
                .iter()
                .all(|s| *s == 0)
        );
        assert!(two.speakers.is_empty());
    }
    #[test]
    fn speaker_and_jitter_memory_are_bounded() {
        let data = Bytes::from(Encoder::new(32000).unwrap().encode(&[0; FRAME]).unwrap());
        let now = Instant::now();
        let mut mixer = Mixer::new();
        for session in 0..1000 {
            for seq in 0..100 {
                mixer.push(packet(session, seq, data.clone(), false), now);
            }
        }
        assert!(mixer.speakers.len() <= MAX_SPEAKERS);
        assert!(
            mixer
                .speakers
                .values()
                .all(|s| s.packets.len() <= MAX_PACKETS)
        );
    }
}
