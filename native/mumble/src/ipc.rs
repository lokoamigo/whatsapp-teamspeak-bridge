use crate::audio::AudioState;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use mumble_client_protocol::Handle;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{Mutex, Semaphore, broadcast, mpsc, oneshot},
    time::{Duration, timeout},
};
use tokio_util::codec::{Framed, LinesCodec};

pub const MAX_LINE: usize = 65536;
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub op: String,
    pub channel: Option<u32>,
    pub session: Option<u32>,
    pub text: Option<String>,
}
pub struct Rpc {
    pub request: Request,
    pub reply: oneshot::Sender<Value>,
}
pub struct Service {
    pub handle: Mutex<Option<Handle>>,
    pub events: broadcast::Sender<Value>,
    pub audio: Arc<AudioState>,
    control: Arc<Semaphore>,
}
impl Service {
    pub fn new(audio: Arc<AudioState>) -> Arc<Self> {
        let (events, _) = broadcast::channel(64);
        Arc::new(Self {
            handle: Mutex::new(None),
            events,
            audio,
            control: Arc::new(Semaphore::new(1)),
        })
    }
    pub fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }
}

pub fn bind(path: &Path) -> Result<UnixListener> {
    let parent = path.parent().context("Missing socket directory")?;
    std::fs::create_dir_all(parent)?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    if path.exists() {
        use std::os::unix::fs::FileTypeExt;
        if !std::fs::symlink_metadata(path)?.file_type().is_socket() {
            bail!("Native Mumble socket path is not a socket");
        }
        // Never unlink another running helper's socket.
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            bail!("Native Mumble is already running");
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub async fn serve(listener: UnixListener, service: Arc<Service>, requests: mpsc::Sender<Rpc>) {
    // One command consumer plus bounded independent health/status peers.
    let peers = Arc::new(Semaphore::new(4));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(permit) = peers.clone().try_acquire_owned() else {
            continue;
        };
        let service = service.clone();
        let requests = requests.clone();
        tokio::spawn(async move {
            let _permit = permit;
            serve_peer(stream, service, requests).await;
        });
    }
}

async fn serve_peer(stream: UnixStream, service: Arc<Service>, requests: mpsc::Sender<Rpc>) {
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(MAX_LINE));
    let mut events = service.events.subscribe();
    let mut control = None;
    loop {
        let message = tokio::select! {
            incoming = framed.next() => {
                let Some(Ok(line)) = incoming else { break; };
                match serde_json::from_str::<Request>(&line) {
                    Ok(request) => {
                        let id = request.id;
                        if request.op == "attach" {
                            if control.is_some() { break; }
                            match service.control.clone().try_acquire_owned() {
                                Ok(permit) => control = Some(permit),
                                Err(_) => { let _ = framed.send(json!({"id":id,"error":"A native Mumble controller is already attached"}).to_string()).await; break; }
                            }
                        }
                        if request.op == "status" || request.op == "attach" {
                            let handle = service.handle.lock().await.clone();
                            let audio = &service.audio;
                            use std::sync::atomic::Ordering::Relaxed;
                            json!({"id":id,"result":{
                                "connected":handle.as_ref().is_some_and(Handle::is_connected),
                                "captureReady":audio.capture_ready.load(Relaxed),
                                "playbackReady":audio.playback_ready.load(Relaxed),
                                    "transmitting":audio.speaking.load(Relaxed),"receiving":audio.receive.load(Relaxed),
                                "captured":audio.captured.load(Relaxed),"played":audio.played.load(Relaxed),
                                "dropped":audio.dropped.load(Relaxed),
                                "receiveDiagnostics":audio.receive_diagnostics(),
                                "transport":if audio.udp.load(Relaxed) { "udp" } else { "tcp" }}})
                        } else if control.is_none() {
                            json!({"id":id,"error":"Attach the command controller first"})
                        } else {
                            let (reply, response) = oneshot::channel();
                            if requests.try_send(Rpc { request, reply }).is_err() {
                                json!({"id":id,"error":"Native Mumble request queue is full"})
                            } else {
                                match timeout(Duration::from_secs(12), response).await {
                                    Ok(Ok(result)) => result,
                                    _ => json!({"id":id,"error":"Native Mumble request timed out"}),
                                }
                            }
                        }
                    },
                    Err(_) => break,
                }
            },
            event = events.recv(), if control.is_some() => match event { Ok(value) => value, Err(_) => break },
        };
        // A slow or stalled Node peer cannot accumulate writes or events.
        let mut encoded = message.to_string();
        if encoded.len() > MAX_LINE {
            if let Some(id) = message.get("id") {
                encoded =
                    json!({"id":id,"error":"Native Mumble response is too large"}).to_string();
            } else {
                break;
            }
        }
        if !matches!(
            timeout(Duration::from_secs(2), framed.send(encoded)).await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
}

pub async fn status(path: &Path) -> Result<()> {
    timeout(Duration::from_secs(2), async {
        let stream = UnixStream::connect(path).await?;
        let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(MAX_LINE));
        framed
            .send(json!({"id":1,"op":"status"}).to_string())
            .await?;
        let line = framed
            .next()
            .await
            .context("Native Mumble status connection closed")??;
        let response: Value = serde_json::from_str(&line)?;
        let state = &response["result"];
        println!("{state}");
        if state["connected"] != true
            || state["captureReady"] != true
            || state["playbackReady"] != true
        {
            bail!("Native Mumble is not ready");
        }
        Ok(())
    })
    .await
    .context("Native Mumble status timed out")?
}
