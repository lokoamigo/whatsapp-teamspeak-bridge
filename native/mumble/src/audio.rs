use crate::{
    codec::{Decoder, Encoder, FRAME, RATE},
    pulse,
};
use bytes::Bytes;
use mumble_client_protocol::VoicePacket;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const MAX_SPEAKERS: usize = 32;
const MAX_PACKETS: usize = 24;
// The fixed 40 ms lead previously concealed ordinary delayed speech packets,
// then discarded them when they arrived. Buffer six 20 ms frames before play.
const JITTER_DELAY: Duration = Duration::from_millis(120);
const SEQUENCE_SAMPLES: usize = RATE / 100;
const MAX_CONCEALMENTS: u8 = 3;
const DIAGNOSTICS_RETENTION: Duration = Duration::from_secs(60);
const DIAGNOSTICS_INTERVAL: Duration = Duration::from_millis(250);
const VOICE_RMS: u64 = 100; // Approximately -50 dBFS; ignore quiet digital noise.
const VOICE_RELEASE_FRAMES: u8 = 15; // 300 ms keeps gaps between words open.

pub struct Outgoing {
    pub packet: Bytes,
    pub last: bool,
    pub generation: u64,
}

enum GateDecision {
    Quiet,
    Start,
    Continue,
    End,
}

#[derive(Default)]
struct VoiceGate {
    active: bool,
    release: u8,
    lead_in: Option<[i16; FRAME]>,
}

impl VoiceGate {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn observe(&mut self, pcm: &[i16; FRAME]) -> GateDecision {
        let energy: u64 = pcm
            .iter()
            .map(|sample| i64::from(*sample).pow(2) as u64)
            .sum();
        let audible = energy >= FRAME as u64 * VOICE_RMS * VOICE_RMS;
        if audible {
            self.release = VOICE_RELEASE_FRAMES;
            if self.active {
                GateDecision::Continue
            } else {
                self.active = true;
                GateDecision::Start
            }
        } else if self.active {
            self.release -= 1;
            if self.release == 0 {
                self.active = false;
                GateDecision::End
            } else {
                GateDecision::Continue
            }
        } else {
            self.lead_in = Some(*pcm);
            GateDecision::Quiet
        }
    }
}

struct Packet {
    data: Bytes,
    last: bool,
    samples: usize,
}
impl Packet {
    fn end(&self, seq: u64) -> u64 {
        seq.saturating_add((self.samples / SEQUENCE_SAMPLES) as u64)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SenderDiagnostics {
    received_packets: u64,
    late_packets: u64,
    concealed_samples: u64,
    jitter_resets: u64,
    #[serde(skip)]
    last_packet: Instant,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveDiagnostics {
    senders: HashMap<u32, SenderDiagnostics>,
    mix_clipped_samples: u64,
}

impl ReceiveDiagnostics {
    fn sender(&mut self, session: u32, now: Instant) -> &mut SenderDiagnostics {
        if self.senders.len() >= MAX_SPEAKERS
            && !self.senders.contains_key(&session)
            && let Some((&oldest, _)) = self
                .senders
                .iter()
                .min_by_key(|(_, stats)| stats.last_packet)
        {
            self.senders.remove(&oldest);
        }
        self.senders.entry(session).or_insert(SenderDiagnostics {
            received_packets: 0,
            late_packets: 0,
            concealed_samples: 0,
            jitter_resets: 0,
            last_packet: now,
        })
    }

    fn expire(&mut self, now: Instant) {
        self.senders
            .retain(|_, stats| now.duration_since(stats.last_packet) < DIAGNOSTICS_RETENTION);
    }
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

    fn push(&mut self, seq: u64, packet: Packet, now: Instant, stats: &mut SenderDiagnostics) {
        // Reject packets already fully played, but retain the tail of a
        // longer packet that arrives after concealment has started.
        if packet.samples != 0 {
            stats.received_packets += 1;
            stats.last_packet = now;
            if self.playing && seq < self.next {
                stats.late_packets += 1;
            }
        }
        if seq < self.next && (packet.samples == 0 || packet.end(seq) <= self.next) && self.playing
        {
            return;
        }
        if self.packets.len() >= MAX_PACKETS {
            return;
        }
        if !self.playing {
            self.next = self.next.min(seq);
        }
        self.heard = now;
        self.packets.entry(seq).or_insert(packet);
    }

    fn render(&mut self, now: Instant, mixed: &mut [i32; FRAME], stats: &mut SenderDiagnostics) {
        if now < self.ready {
            return;
        }
        self.playing = true;
        while self.pcm.len() < FRAME && !self.ended {
            // A packet can overlap the playout cursor after a short loss.
            // Decode it whole and enqueue only the audio not yet played.
            self.packets
                .retain(|&seq, packet| seq >= self.next || packet.end(seq) > self.next);
            if let Some((&seq, _)) = self.packets.first_key_value()
                && seq <= self.next
            {
                let packet = self.packets.pop_first().expect("packet present").1;
                self.missing = 0;
                if packet.samples == 0 {
                    self.ended = true;
                    break;
                }
                let already_played = ((self.next - seq) as usize) * SEQUENCE_SAMPLES;
                self.next = packet.end(seq);
                if let Ok(decoded) = self.decoder.decode(Some(&packet.data), packet.samples) {
                    self.pcm.extend(decoded.into_iter().skip(already_played));
                }
                self.ended = packet.last;
            } else {
                if self.missing >= MAX_CONCEALMENTS {
                    stats.jitter_resets += 1;
                    // Rebuffer from packets that are already queued. A lost
                    // packet must never discard the rest of the talk burst.
                    if let Some((&seq, _)) = self.packets.first_key_value() {
                        self.next = seq;
                        self.ready = now + JITTER_DELAY;
                        self.playing = false;
                        self.missing = 0;
                    } else {
                        self.ended = true;
                    }
                    break;
                }
                let units = self
                    .packets
                    .first_key_value()
                    .map_or(2, |(&seq, _)| (seq - self.next).min(2));
                let samples = units as usize * SEQUENCE_SAMPLES;
                if let Ok(concealed) = self.decoder.decode(None, samples) {
                    stats.concealed_samples += concealed.len() as u64;
                    self.pcm.extend(concealed);
                }
                self.next = self.next.saturating_add(units);
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
    diagnostics: ReceiveDiagnostics,
}
impl Mixer {
    pub fn new() -> Self {
        Self {
            speakers: HashMap::new(),
            diagnostics: ReceiveDiagnostics::default(),
        }
    }
    pub fn clear(&mut self) {
        self.speakers.clear();
    }
    pub fn push(&mut self, packet: VoicePacket, now: Instant) {
        let samples = if packet.payload.is_empty() && packet.is_last {
            0
        } else {
            match Decoder::samples(&packet.payload) {
                Ok(samples) if samples % SEQUENCE_SAMPLES == 0 => samples,
                _ => return,
            }
        };
        let replace = self.speakers.get(&packet.session).is_some_and(|speaker| {
            (speaker.ended && speaker.pcm.is_empty())
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
                    samples,
                },
                now,
                self.diagnostics.sender(packet.session, now),
            );
        }
    }
    pub fn render(&mut self, now: Instant) -> [i16; FRAME] {
        self.speakers
            .retain(|_, speaker| now.duration_since(speaker.heard) < Duration::from_secs(2));
        let mut mixed = [0i32; FRAME];
        for (&session, speaker) in &mut self.speakers {
            speaker.render(
                now,
                &mut mixed,
                self.diagnostics.sender(session, speaker.heard),
            );
        }
        let mut clipped = 0;
        let pcm = mixed.map(|sample| {
            let clamped = sample.clamp(i16::MIN as i32, i16::MAX as i32);
            clipped += u64::from(clamped != sample);
            clamped as i16
        });
        self.diagnostics.mix_clipped_samples += clipped;
        pcm
    }
}

#[derive(Default)]
pub struct AudioState {
    pub transmit: AtomicBool,
    pub speaking: AtomicBool,
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
    receive_diagnostics: Mutex<Option<(u64, ReceiveDiagnostics)>>,
}

impl AudioState {
    pub fn receive_diagnostics(&self) -> ReceiveDiagnostics {
        let generation = self.generation.load(Ordering::Relaxed);
        self.receive_diagnostics
            .lock()
            .ok()
            .and_then(|snapshot| {
                snapshot
                    .as_ref()
                    .filter(|(current, _)| *current == generation)
                    .map(|(_, diagnostics)| diagnostics.clone())
            })
            .unwrap_or_default()
    }
}

pub struct Audio {
    pub state: Arc<AudioState>,
    pub outgoing: mpsc::Receiver<Outgoing>,
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
            let mut gate = VoiceGate::default();
            let mut generation = state.generation.load(Ordering::Relaxed);
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
                    state.speaking.store(false, Ordering::Relaxed);
                    gate.reset();
                    stream = None;
                    continue;
                }
                let current = state.generation.load(Ordering::Relaxed);
                if generation != current {
                    gate.reset();
                    state.speaking.store(false, Ordering::Relaxed);
                    generation = current;
                }
                if !state.transmit.load(Ordering::Relaxed) {
                    gate.reset();
                    state.speaking.store(false, Ordering::Relaxed);
                    continue;
                }
                match gate.observe(&pcm) {
                    GateDecision::Start => {
                        // Opus must begin a new talk burst without stale predictor state.
                        if let Err(error) = encoder.reset() {
                            report_audio_error(&mut last_error, &error);
                            gate.reset();
                            continue;
                        }
                        if let Some(lead_in) = gate.lead_in.take() {
                            send_frame(
                                &mut encoder,
                                &lead_in,
                                generation,
                                &out_tx,
                                &state,
                                &mut last_error,
                            );
                        }
                        state.speaking.store(true, Ordering::Relaxed);
                        send_frame(
                            &mut encoder,
                            &pcm,
                            generation,
                            &out_tx,
                            &state,
                            &mut last_error,
                        );
                    }
                    GateDecision::Continue => {
                        state.speaking.store(true, Ordering::Relaxed);
                        send_frame(
                            &mut encoder,
                            &pcm,
                            generation,
                            &out_tx,
                            &state,
                            &mut last_error,
                        );
                    }
                    GateDecision::End => {
                        state.speaking.store(false, Ordering::Relaxed);
                        // Data frames reserve one slot for the terminator.
                        if out_tx
                            .try_send(Outgoing {
                                packet: Bytes::new(),
                                last: true,
                                generation,
                            })
                            .is_err()
                        {
                            state.dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    GateDecision::Quiet => {}
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
            let mut next_snapshot = Instant::now();
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
                    mixer.diagnostics = ReceiveDiagnostics::default();
                    generation = current;
                    next_snapshot = now;
                }
                for _ in 0..64 {
                    let Ok((packet_generation, packet)) = in_rx.try_recv() else {
                        break;
                    };
                    let current = state.generation.load(Ordering::Relaxed);
                    if generation != current {
                        mixer.clear();
                        mixer.diagnostics = ReceiveDiagnostics::default();
                        generation = current;
                        next_snapshot = now;
                    }
                    if packet_generation == generation && state.receive.load(Ordering::Relaxed) {
                        mixer.push(packet, now);
                    }
                }
                if !state.receive.load(Ordering::Relaxed) {
                    mixer.clear();
                }
                let pcm = mixer.render(now);
                if now >= next_snapshot {
                    mixer.diagnostics.expire(now);
                    // Keep the playback thread independent of socket readers.
                    if let Ok(mut snapshot) = state.receive_diagnostics.try_lock() {
                        *snapshot = Some((generation, mixer.diagnostics.clone()));
                        next_snapshot = now + DIAGNOSTICS_INTERVAL;
                    }
                }
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
        self.state.speaking.store(false, Ordering::Relaxed);
        self.state.receive.store(false, Ordering::Relaxed);
        self.state.generation.fetch_add(1, Ordering::Relaxed);
    }
}

fn send_frame(
    encoder: &mut Encoder,
    pcm: &[i16; FRAME],
    generation: u64,
    tx: &mpsc::Sender<Outgoing>,
    state: &AudioState,
    last_error: &mut Option<Instant>,
) {
    // Keep one slot free so a talk burst can always finish cleanly.
    if tx.capacity() <= 1 {
        state.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    match encoder.encode(pcm) {
        Ok(packet) => {
            state.captured.fetch_add(1, Ordering::Relaxed);
            if tx
                .try_send(Outgoing {
                    packet: Bytes::from(packet),
                    last: false,
                    generation,
                })
                .is_err()
            {
                state.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        Err(error) => report_audio_error(last_error, &error),
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

    #[test]
    fn voice_gate_leads_in_releases_and_reopens() {
        let mut gate = VoiceGate::default();
        let quiet = [0; FRAME];
        let below = [99; FRAME];
        let voice = [100; FRAME];
        assert!(matches!(gate.observe(&quiet), GateDecision::Quiet));
        assert!(matches!(gate.observe(&below), GateDecision::Quiet));
        assert!(matches!(gate.observe(&voice), GateDecision::Start));
        assert_eq!(gate.lead_in.take(), Some(below));
        for _ in 0..VOICE_RELEASE_FRAMES - 1 {
            assert!(matches!(gate.observe(&quiet), GateDecision::Continue));
        }
        assert!(matches!(gate.observe(&quiet), GateDecision::End));
        assert!(matches!(gate.observe(&quiet), GateDecision::Quiet));
        assert!(matches!(gate.observe(&voice), GateDecision::Start));
        assert_eq!(gate.lead_in.take(), Some(quiet));
        assert!(matches!(gate.observe(&voice), GateDecision::Continue));
        gate.reset();
        assert!(matches!(gate.observe(&voice), GateDecision::Start));
        assert_eq!(gate.lead_in.take(), None);
    }
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
        let tone: [i16; FRAME] =
            std::array::from_fn(|i| ((i as f32 * 0.0576).sin() * 4000.) as i16);
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
    fn delayed_second_packet_is_played_without_concealment() {
        let mut encoder = Encoder::new(32000).unwrap();
        let tone: [i16; FRAME] =
            std::array::from_fn(|i| ((i as f32 * 0.0576).sin() * 4000.) as i16);
        let first = Bytes::from(encoder.encode(&tone).unwrap());
        let second = Bytes::from(encoder.encode(&tone).unwrap());
        let now = Instant::now();
        let mut mixer = Mixer::new();
        mixer.push(packet(1, 0, first, false), now);
        assert!(
            mixer
                .render(now + Duration::from_millis(40))
                .iter()
                .all(|s| *s == 0)
        );
        assert!(
            mixer
                .render(now + Duration::from_millis(60))
                .iter()
                .all(|s| *s == 0)
        );
        mixer.push(packet(1, 2, second, false), now + Duration::from_millis(70));
        assert!(mixer.speakers[&1].packets.contains_key(&2));
        assert!(
            mixer
                .render(now + JITTER_DELAY)
                .iter()
                .any(|s| s.abs() > 100)
        );
        assert!(
            mixer
                .render(now + JITTER_DELAY + Duration::from_millis(20))
                .iter()
                .any(|s| s.abs() > 100)
        );
    }
    #[test]
    fn late_long_packet_still_plays_its_unconcealed_samples() {
        let mut encoder = Encoder::new(32000).unwrap();
        let samples: [i16; FRAME * 3] =
            std::array::from_fn(|i| ((i as f32 * 0.0576).sin() * 6000.) as i16);
        let first = Bytes::from(encoder.encode(&samples).unwrap());
        let second = Bytes::from(encoder.encode(&samples).unwrap());
        let now = Instant::now();
        let mut mixer = Mixer::new();
        mixer.push(packet(1, 0, first, false), now);
        let start = now + JITTER_DELAY;
        let tick = Duration::from_millis(20);
        for frame in 0..4 {
            mixer.render(start + tick * frame);
        }
        assert_eq!(mixer.speakers[&1].next, 8, "20 ms concealed");
        // A 60 ms desktop packet still has 40 ms left to play.
        mixer.push(packet(1, 6, second, true), start + tick * 4);
        let output = mixer.render(start + tick * 4);
        assert!(output.iter().any(|s| s.abs() > 1000));
        assert_eq!(mixer.speakers[&1].next, 12);
        assert_eq!(mixer.speakers[&1].pcm.len(), FRAME);
        assert!(mixer.speakers[&1].ended);
        let stats = &mixer.diagnostics.senders[&1];
        assert_eq!(stats.received_packets, 2);
        assert_eq!(stats.late_packets, 1);
        assert_eq!(stats.concealed_samples, FRAME as u64);
        assert_eq!(stats.jitter_resets, 0);
    }

    #[test]
    fn packet_gap_does_not_discard_audio_already_buffered() {
        let data = Bytes::from(Encoder::new(32000).unwrap().encode(&[1000; FRAME]).unwrap());
        let now = Instant::now();
        let mut mixer = Mixer::new();
        mixer.push(packet(1, 0, data.clone(), false), now);
        let start = now + JITTER_DELAY;
        let tick = Duration::from_millis(20);
        mixer.render(start);
        mixer.push(packet(1, 10, data.clone(), false), start + tick);
        for frame in 1..=4 {
            mixer.render(start + tick * frame);
        }
        // Sequence 10 was queued before the loss limit was reached.
        // It must play before the next arriving packet.
        mixer.push(packet(1, 12, data, true), start + tick * 5);
        mixer.render(start + tick * 4 + JITTER_DELAY);
        assert_eq!(mixer.speakers[&1].next, 12);
        assert!(mixer.speakers[&1].packets.contains_key(&12));
        let stats = &mixer.diagnostics.senders[&1];
        assert_eq!(stats.concealed_samples, (FRAME * 3) as u64);
        assert_eq!(stats.jitter_resets, 1);
    }

    #[test]
    fn receive_diagnostics_report_only_mix_clipping_and_recent_senders() {
        let now = Instant::now();
        let mut mixer = Mixer::new();
        for session in [11, 17] {
            let mut speaker = Speaker::new(0, now).unwrap();
            speaker.pcm.extend([20_000; FRAME]);
            speaker.ended = true;
            mixer.speakers.insert(session, speaker);
            mixer.diagnostics.sender(session, now).received_packets = 1;
        }
        assert_eq!(mixer.render(now + JITTER_DELAY), [i16::MAX; FRAME]);
        let snapshot = serde_json::to_value(&mixer.diagnostics).unwrap();
        assert_eq!(snapshot["mixClippedSamples"], FRAME);
        for session in ["11", "17"] {
            let stats = &snapshot["senders"][session];
            assert_eq!(stats["receivedPackets"], 1);
            assert_eq!(stats["latePackets"], 0);
            assert_eq!(stats["concealedSamples"], 0);
            assert_eq!(stats["jitterResets"], 0);
            assert!(stats.get("lastPacket").is_none());
        }
        for session in 100..200 {
            mixer.diagnostics.sender(session, now);
        }
        assert_eq!(mixer.diagnostics.senders.len(), MAX_SPEAKERS);
        mixer.diagnostics.expire(now + DIAGNOSTICS_RETENTION);
        assert!(mixer.diagnostics.senders.is_empty());
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
