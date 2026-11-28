mod audio;
mod codec;
mod config;
mod identity;
mod ipc;
mod pulse;

use anyhow::{Context, Result, bail};
use config::Config;
use mumble_client_protocol::{
    ConnectConfig, Event, Handle, OutgoingAudio, TextTarget, VoiceEvent, VoiceTransport,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering::Relaxed},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, timeout},
};

struct PendingMove {
    id: u64,
    channel: u32,
    reply: oneshot::Sender<Value>,
    deadline: Instant,
}

struct DisconnectOnDrop(Handle);
impl Drop for DisconnectOnDrop {
    fn drop(&mut self) {
        self.0.disconnect();
    }
}

fn channels(handle: &Handle) -> Value {
    handle.with_state(|state| {
        let own = state.own_user().map(|user| user.channel_id);
        json!(state.channels.values().filter(|channel| Some(channel.id) != own).map(|channel|
            json!({"id":channel.id,"name":if channel.name.is_empty() { "Root" } else { &channel.name },"parentId":channel.parent})
        ).collect::<Vec<_>>())
    })
}

fn current_channel(handle: &Handle) -> Result<Value> {
    handle.with_state(|state| {
        let id = state
            .own_user()
            .context("Own channel is unavailable")?
            .channel_id;
        let channel = state.channels.get(&id);
        let name = channel
            .map(|channel| channel.name.as_str())
            .filter(|name| !name.is_empty())
            .or((id == 0).then_some("Root"));
        Ok(json!({ "id": id, "name": name }))
    })
}

// Other users in the bridge's own channel, for the bridge's presence notices.
fn roster(handle: &Handle) -> Result<Value> {
    handle.with_state(|state| {
        let own = state.own_user().context("Own channel is unavailable")?;
        let users: Vec<Value> = state
            .users
            .values()
            .filter(|user| user.session != own.session && user.channel_id == own.channel_id)
            .map(|user| json!({"session": user.session, "name": user.name}))
            .collect();
        Ok(json!({"channel": own.channel_id, "users": users}))
    })
}

fn resolve_channel(handle: &Handle, path: &[String]) -> Result<Option<u32>> {
    if path.is_empty() {
        return Ok(None);
    }
    handle.with_state(|state| {
        let mut parent = 0;
        for component in path {
            let matches = state
                .channels
                .values()
                .filter(|c| c.parent == Some(parent) && c.name == *component)
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                bail!("MUMBLE_URI channel path is missing or ambiguous");
            }
            parent = matches[0].id;
        }
        Ok(Some(parent))
    })
}

fn set_audio_state(audio: &audio::Audio, handle: &Handle) {
    handle.with_state(|state| {
        let own = state.own_user();
        audio.state.transmit.store(
            own.is_some_and(|u| !u.mute && !u.self_mute && !u.deaf && !u.self_deaf && !u.suppress),
            Relaxed,
        );
        audio
            .state
            .receive
            .store(own.is_some_and(|u| !u.deaf && !u.self_deaf), Relaxed);
    });
}

fn response(id: u64, result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"id":id,"result":value}),
        Err(error) => json!({"id":id,"error":error.to_string()}),
    }
}

fn rpc(rpc: ipc::Rpc, handle: &Handle, pending: &mut Option<PendingMove>) {
    let ipc::Rpc { request, reply } = rpc;
    let id = request.id;
    if request.op == "move" {
        let Some(channel) = request.channel else {
            let _ = reply.send(response(id, Err(anyhow::anyhow!("Missing channel"))));
            return;
        };
        if pending.is_some() {
            let _ = reply.send(response(
                id,
                Err(anyhow::anyhow!("A channel move is already pending")),
            ));
            return;
        }
        if !handle.with_state(|state| state.channels.contains_key(&channel)) {
            let _ = reply.send(response(
                id,
                Err(anyhow::anyhow!("Mumble channel no longer exists")),
            ));
            return;
        }
        if handle.with_state(|state| state.own_user().is_some_and(|u| u.channel_id == channel)) {
            let _ = reply.send(response(id, Ok(json!(null))));
            return;
        }
        match handle.join_channel(channel) {
            Ok(()) => {
                *pending = Some(PendingMove {
                    id,
                    channel,
                    reply,
                    deadline: Instant::now() + Duration::from_secs(10),
                })
            }
            Err(error) => {
                let _ = reply.send(response(id, Err(error.into())));
            }
        }
        return;
    }
    let result = (|| -> Result<Value> {
        match request.op.as_str() {
            "channels" => Ok(channels(handle)),
            "current_channel" => current_channel(handle),
            "roster" => roster(handle),
            "send_text" | "send_channel" => {
                let text = request.text.context("Missing message")?;
                if text.len() > 16000 {
                    bail!("Mumble message is too long");
                }
                let target = if request.op == "send_text" {
                    TextTarget::user(request.session.context("Missing recipient")?)
                } else {
                    TextTarget::channel(
                        handle
                            .with_state(|s| s.own_user().map(|u| u.channel_id))
                            .context("Own channel is unavailable")?,
                    )
                };
                handle.send_text(&target, &text)?;
                Ok(json!(null))
            }
            _ => bail!("Unknown native Mumble operation"),
        }
    })();
    if result.is_ok() && matches!(request.op.as_str(), "send_text" | "send_channel") {
        // Wait for server acknowledgement outside the voice loop. The local
        // IPC peer serializes requests, bounding the upstream pacing queue.
        let handle = handle.clone();
        tokio::spawn(async move {
            let result = match timeout(Duration::from_secs(10), handle.flush()).await {
                Ok(Ok(())) => result,
                _ => Err(anyhow::anyhow!("Mumble did not acknowledge the message")),
            };
            let _ = reply.send(response(id, result));
        });
    } else {
        let _ = reply.send(response(id, result));
    }
}

async fn connected(
    config: &Config,
    audio: &mut audio::Audio,
    service: &Arc<ipc::Service>,
    requests: &mut mpsc::Receiver<ipc::Rpc>,
) -> Result<()> {
    let identity = identity::load(&config.directory, &config.gui, config.import.as_deref())?;
    let verifier = identity::verifier(
        &config.directory,
        &config.root.join("bridge-bot/known-servers.json"),
        &config.host,
        config.port,
    )?;
    let addresses = timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((config.host.as_str(), config.port)),
    )
    .await
    .context("Mumble DNS lookup timed out")??
    .take(8);
    let (peer, mut connection) = timeout(Duration::from_secs(15), async {
        let mut last_error = None;
        for peer in addresses {
            let result = mumble_client_protocol::connect(ConnectConfig {
                host: peer.ip().to_string(),
                port: config.port,
                username: config.username.clone(),
                password: config.password.clone(),
                tokens: vec![],
                identity: Some(mumble_client_protocol::ClientIdentity {
                    chain: identity.chain.clone(),
                    key: identity.key.clone_key(),
                }),
                verify_cert: verifier.clone(),
                login_timeout: Duration::from_secs(5),
            })
            .await;
            match result {
                Ok(connection) => return Ok((peer, connection)),
                Err(
                    error @ (mumble_client_protocol::ConnectError::Io(_)
                    | mumble_client_protocol::ConnectError::Timeout),
                ) => last_error = Some(error),
                Err(error) => return Err(error.into()),
            }
        }
        Err(last_error
            .map(anyhow::Error::from)
            .unwrap_or_else(|| anyhow::anyhow!("No reachable Mumble server address")))
    })
    .await
    .context("Mumble connection attempts timed out")??;
    let handle = connection.handle.clone();
    let _disconnect = DisconnectOnDrop(handle.clone());
    if let Some(channel) = resolve_channel(&handle, &config.channels)?
        && !handle.with_state(|state| {
            state
                .own_user()
                .is_some_and(|user| user.channel_id == channel)
        })
    {
        handle.join_channel(channel)?;
        // Never transmit into the default/root channel while an initial URI
        // join is still pending. Refusals fail clearly and keep audio offline.
        timeout(Duration::from_secs(10), async {
            loop {
                if handle.with_state(|state| {
                    state
                        .own_user()
                        .is_some_and(|user| user.channel_id == channel)
                }) {
                    return Ok(());
                }
                match connection.events.recv().await {
                    Some(Event::PermissionDenied(_)) => bail!(
                        "Mumble refused the initial channel; check Enter/Traverse permissions"
                    ),
                    Some(Event::Disconnected(_)) | None => {
                        bail!("Mumble disconnected before joining the initial channel")
                    }
                    _ => {}
                }
            }
        })
        .await
        .context("Mumble did not confirm the initial channel")??;
    }
    let (voice, mut packets) = VoiceTransport::start(handle.clone(), peer).await?;
    audio.state.udp.store(false, Relaxed);
    while audio.outgoing.try_recv().is_ok() {}
    set_audio_state(audio, &handle);
    *service.handle.lock().await = Some(handle.clone());
    service.emit(json!({"event":"connected"}));
    eprintln!("Native Mumble: connected with one audio/chat account");
    let mut pending = None;
    let mut timer = tokio::time::interval(Duration::from_millis(100));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_probe = Instant::now();
    let mut probe = None;
    let result = loop {
        // The upstream protocol delivers events via unbounded channels. Drain
        // promptly, and reconnect on overload before retaining a large backlog.
        if connection.events.len() > 512 || packets.len() > 256 {
            break Err(anyhow::anyhow!("Mumble event backlog exceeded its limit"));
        }
        tokio::select! {
            event = connection.events.recv() => match event {
                Some(Event::CryptSetup(setup)) => voice.on_crypt_setup(setup),
                Some(Event::UdpTunnel(packet)) => voice.on_tunnel(packet),
                Some(Event::TextMessage(message)) => {
                    let own = handle.with_state(|state| state.session);
                    // Ignore messages from ourselves and server-originated text.
                    if message.actor.is_some() && message.actor != own {
                        service.emit(json!({"event":"text","message":message.message,"private":own.is_some_and(|id| message.target.sessions.contains(&id)),
                            "actor":message.actor,"user":message.sender.map(|user| json!({"session":user.session,"name":user.name,"hash":user.cert_hash}))}));
                    }
                },
                Some(Event::UserUpdated(change)) => {
                    let own = handle.with_state(|state| state.session);
                    if Some(change.user.session) == own {
                        if change.moved_from.is_some() {
                            audio.state.generation.fetch_add(1, Relaxed);
                            while packets.try_recv().is_ok() {}
                        }
                        set_audio_state(audio, &handle);
                        if pending.as_ref().is_some_and(|p: &PendingMove| p.channel == change.user.channel_id) {
                            let p = pending.take().expect("pending move"); let _ = p.reply.send(response(p.id, Ok(json!(null))));
                        }
                    }
                },
                Some(Event::PermissionDenied(denied)) => {
                    if let Some(p) = pending.take() {
                        let _ = p.reply.send(response(p.id, Err(anyhow::anyhow!("Mumble refused joining the channel ({:?}); check Enter/Traverse permissions and channel capacity", denied.kind))));
                    } else { eprintln!("Native Mumble: server refused an operation ({:?})", denied.kind); }
                },
                Some(Event::Disconnected(_)) | None => break Err(anyhow::anyhow!("Mumble server disconnected")),
                _ => {},
            },
            packet = packets.recv() => match packet {
                Some(VoiceEvent::Packet(packet)) => audio.push(packet),
                Some(VoiceEvent::TransportChanged(transport)) => {
                    audio.state.udp.store(transport == mumble_client_protocol::Transport::Udp, Relaxed);
                    service.emit(json!({"event":"transport","transport":format!("{transport:?}")}));
                },
                None => break Err(anyhow::anyhow!("Mumble voice transport stopped")),
            },
            packet = audio.outgoing.recv() => match packet {
                Some(packet) if audio.state.transmit.load(Relaxed) && packet.generation == audio.state.generation.load(Relaxed) =>
                    voice.send_audio(OutgoingAudio::new(packet.packet, if packet.last { 0 } else { 2 }, packet.last)),
                Some(_) => {},
                None => break Err(anyhow::anyhow!("Native capture worker stopped")),
            },
            request = requests.recv() => if let Some(request) = request { rpc(request, &handle, &mut pending); },
            _ = timer.tick() => {
                if let Some(p) = pending.take() {
                    if Instant::now() >= p.deadline { let _ = p.reply.send(response(p.id, Err(anyhow::anyhow!("Mumble did not confirm the channel move")))); }
                    else { pending = Some(p); }
                }
                if probe.as_ref().is_some_and(|task: &tokio::task::JoinHandle<bool>| task.is_finished())
                    && !probe.take().expect("probe").await.unwrap_or(false) {
                    break Err(anyhow::anyhow!("Mumble control connection stalled"));
                }
                if probe.is_none() && last_probe.elapsed() >= Duration::from_secs(5) {
                    last_probe = Instant::now();
                    let probe_handle = handle.clone();
                    probe = Some(tokio::spawn(async move { timeout(Duration::from_secs(5), probe_handle.flush()).await.is_ok_and(|r| r.is_ok()) }));
                }
                if handle.with_state(|s| s.users.len() > 4096 || s.channels.len() > 4096) { break Err(anyhow::anyhow!("Mumble server state exceeds its limit")); }
                if !voice.is_running() { break Err(anyhow::anyhow!("Mumble voice transport stopped")); }
                if audio.state.failed.load(Relaxed) { break Err(anyhow::anyhow!("Native audio worker stopped")); }
            },
        }
    };
    if let Some(p) = pending {
        let _ = p.reply.send(response(
            p.id,
            Err(anyhow::anyhow!("Mumble disconnected during the move")),
        ));
    }
    if let Some(probe) = probe {
        probe.abort();
    }
    handle.disconnect();
    audio.offline();
    *service.handle.lock().await = None;
    service.emit(json!({"event":"disconnected"}));
    result
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--status") {
        return ipc::status(std::path::Path::new(
            &std::env::var("MUMBLE_NATIVE_SOCKET")
                .unwrap_or_else(|_| "/tmp/runtime-bridge/mumble-native.sock".into()),
        ))
        .await;
    }
    let config = Config::from_env()?;
    let listener = ipc::bind(&config.socket)?;
    // Fail identity migration before starting audio or joining the server.
    let _ = identity::load(&config.directory, &config.gui, config.import.as_deref())?;
    let mut audio = audio::Audio::start(config.source.clone(), config.sink.clone(), config.bitrate);
    let service = ipc::Service::new(audio.state.clone());
    let (tx, mut requests) = mpsc::channel(32);
    let ipc_task = tokio::spawn(ipc::serve(listener, service.clone(), tx));
    let connection_task = async {
        let mut retry = 1;
        loop {
            let started = Instant::now();
            if let Err(error) = connected(&config, &mut audio, &service, &mut requests).await {
                // URI/passwords and TLS key material never enter log messages.
                eprintln!("Native Mumble: {error}; reconnecting");
            }
            if audio.state.failed.load(Relaxed) {
                return Err(anyhow::anyhow!(
                    "Native audio worker stopped; supervisor must restart the helper"
                ));
            }
            audio.offline();
            *service.handle.lock().await = None;
            while let Ok(request) = requests.try_recv() {
                let _ = request.reply.send(response(
                    request.request.id,
                    Err(anyhow::anyhow!("Native Mumble is disconnected")),
                ));
            }
            tokio::time::sleep(Duration::from_secs(retry)).await;
            retry = if started.elapsed() > Duration::from_secs(30) {
                1
            } else {
                (retry * 2).min(30)
            };
        }
    };
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let result: Result<()> = tokio::select! { result = connection_task => result, _ = term.recv() => Ok(()), _ = tokio::signal::ctrl_c() => Ok(()) };
    if let Some(handle) = service.handle.lock().await.take() {
        handle.disconnect();
        let _ = timeout(Duration::from_secs(2), handle.closed()).await;
    }
    audio.offline();
    ipc_task.abort();
    let _ = std::fs::remove_file(&config.socket);
    result
}
