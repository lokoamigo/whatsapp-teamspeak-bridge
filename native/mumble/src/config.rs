use anyhow::{Context, Result, bail};
use std::{env, path::PathBuf};
use url::Url;

struct Server {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    channels: Vec<String>,
}

pub struct Config {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub channels: Vec<String>,
    pub root: PathBuf,
    pub directory: PathBuf,
    pub socket: PathBuf,
    pub import: Option<PathBuf>,
    pub gui: PathBuf,
    pub source: String,
    pub sink: String,
    pub bitrate: i32,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let raw = env::var("MUMBLE_URI").context("MUMBLE_URI is required for the native client")?;
        let parsed = Self::parse_uri(&raw)?;
        let root =
            PathBuf::from(env::var("MUMBLE_DATA_DIR").unwrap_or_else(|_| "/data/mumble".into()));
        let directory = root.join("native");
        let gui = env::var("MUMBLE_NATIVE_GUI_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| crate::identity::default_gui_config(&root));
        let bitrate = env::var("MUMBLE_NATIVE_BITRATE")
            .unwrap_or_else(|_| "32000".into())
            .parse::<i32>()?;
        if !(8000..=64000).contains(&bitrate) {
            bail!("MUMBLE_NATIVE_BITRATE must be between 8000 and 64000");
        }
        Ok(Self {
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            channels: parsed.channels,
            socket: PathBuf::from(
                env::var("MUMBLE_NATIVE_SOCKET")
                    .unwrap_or_else(|_| "/tmp/runtime-bridge/mumble-native.sock".into()),
            ),
            import: env::var("MUMBLE_NATIVE_IDENTITY_IMPORT")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            source: "wa_mic".into(),
            sink: "ts_out".into(),
            root,
            directory,
            gui,
            bitrate,
        })
    }

    fn parse_uri(raw: &str) -> Result<Server> {
        // Do not attach parser errors: invalid URLs may include passwords.
        let uri = Url::parse(raw).map_err(|_| anyhow::anyhow!("MUMBLE_URI is invalid"))?;
        if uri.scheme() != "mumble" {
            bail!("MUMBLE_URI must start with mumble://");
        }
        let host = uri
            .host_str()
            .context("MUMBLE_URI has no server host")?
            .trim_matches(['[', ']'])
            .to_string();
        let username = percent_decode(uri.username())?;
        let password = uri.password().map(percent_decode).transpose()?;
        let channels = uri
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .map(percent_decode)
            .collect::<Result<Vec<_>>>()?;
        Ok(Server {
            host,
            port: uri.port().unwrap_or(64738),
            username: if username.is_empty() {
                "WhatsAppBridge".into()
            } else {
                username
            },
            password,
            channels,
        })
    }
}

fn percent_decode(raw: &str) -> Result<String> {
    let mut data = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            data.push(byte);
            continue;
        }
        let high = bytes
            .next()
            .and_then(|b| (b as char).to_digit(16))
            .context("Invalid percent encoding in MUMBLE_URI")?;
        let low = bytes
            .next()
            .and_then(|b| (b as char).to_digit(16))
            .context("Invalid percent encoding in MUMBLE_URI")?;
        data.push((high * 16 + low) as u8);
    }
    String::from_utf8(data).context("MUMBLE_URI contains invalid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uri_preserves_names_channels_passwords_and_ipv6() {
        let server = Config::parse_uri("mumble://Whats%20App:p%40ss@[::1]:1234/A/B%20C").unwrap();
        assert_eq!(server.host, "::1");
        assert_eq!(server.port, 1234);
        assert_eq!(server.username, "Whats App");
        assert_eq!(server.password.as_deref(), Some("p@ss"));
        assert_eq!(server.channels, ["A", "B C"]);
        assert_eq!(
            Config::parse_uri("mumble://host").unwrap().username,
            "WhatsAppBridge"
        );
        assert!(
            Config::parse_uri("https://user:secret@host")
                .err()
                .unwrap()
                .to_string()
                .find("secret")
                .is_none()
        );
    }
}
