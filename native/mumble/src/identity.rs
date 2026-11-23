use anyhow::{Context, Result, bail};
use mumble_client_protocol::{
    ClientIdentity, ServerCert,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

fn openssl(args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
    let mut child = Command::new("openssl")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .context("OpenSSL input unavailable")?
        .write_all(input)?;
    let result = child.wait_with_output()?;
    // Do not copy command output into diagnostics: it can contain key material.
    if !result.status.success() {
        bail!("OpenSSL identity operation failed; check the certificate format and password");
    }
    Ok(result.stdout)
}

pub fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing identity directory")?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let saved = (|| -> Result<()> {
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if saved.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    saved
}

pub fn load(directory: &Path, gui_config: &Path, import: Option<&Path>) -> Result<ClientIdentity> {
    let path = directory.join("identity.pem");
    let pem = if path.exists() {
        fs::read(&path)?
    } else {
        let imported = if let Some(import) = import {
            let input =
                fs::read(import).context("Cannot read the explicit Mumble identity import")?;
            if input.starts_with(b"-----BEGIN") {
                input
            } else {
                import_pkcs12(&input)?
            }
        } else if gui_config.exists() {
            let settings = fs::read_to_string(gui_config)
                .context("Cannot read Mumble.conf for identity migration")?;
            match gui_certificate(&settings)? {
                Some(data) => import_pkcs12(&data).context(
                    "Existing Mumble identity could not be imported; refusing to replace it",
                )?,
                None => {
                    bail!(
                        "Existing Mumble.conf has no usable identity; export its certificate and set MUMBLE_NATIVE_IDENTITY_IMPORT"
                    );
                }
            }
        } else {
            eprintln!("Native Mumble: creating a persistent client identity");
            openssl(
                &[
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-sha256",
                    "-days",
                    "7300",
                    "-subj",
                    "/CN=WhatsAppBridge",
                    "-keyout",
                    "/dev/stdout",
                ],
                &[],
            )?
        };
        // Validate certificate and key together before making the import final.
        let _ = decode(&imported)?;
        write_private(&path, &imported)?;
        imported
    };
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    decode(&pem)
}

fn import_pkcs12(data: &[u8]) -> Result<Vec<u8>> {
    let pass = if std::env::var_os("MUMBLE_NATIVE_IDENTITY_PASSWORD").is_some() {
        "env:MUMBLE_NATIVE_IDENTITY_PASSWORD"
    } else {
        "pass:"
    };
    // Mumble 1.3 exports unencrypted key/cert bags with legacy PKCS#12 MACs.
    openssl(&["pkcs12", "-legacy", "-nodes", "-passin", pass], data)
}

fn decode(pem: &[u8]) -> Result<ClientIdentity> {
    let cert = openssl(&["x509", "-outform", "DER"], pem)?;
    let key = openssl(&["pkcs8", "-topk8", "-nocrypt", "-outform", "DER"], pem)?;
    let cert_public = openssl(&["x509", "-pubkey", "-noout"], pem)?;
    let key_public = openssl(&["pkey", "-pubout"], pem)?;
    if cert_public != key_public {
        bail!("Mumble certificate does not match its private key");
    }
    Ok(ClientIdentity {
        chain: vec![CertificateDer::from(cert)],
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
    })
}

// QSettings serializes net/certificate as @ByteArray(...), using C escapes.
// Preserve every byte, including variable-length hex escapes and escaped ')'.
fn gui_certificate(settings: &str) -> Result<Option<Vec<u8>>> {
    let mut section = "";
    for line in settings.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !((section == "net" && key.trim() == "certificate") || key.trim() == "net/certificate") {
            continue;
        }
        let value = value.trim().trim_matches('"');
        if value == "@ByteArray()" {
            return Ok(None);
        }
        let encoded = value
            .strip_prefix("@ByteArray(")
            .and_then(|v| v.strip_suffix(')'))
            .context("Unsupported certificate encoding in Mumble.conf")?;
        let mut bytes = Vec::new();
        let mut chars = encoded.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch != '\\' {
                if ch as u32 > 255 {
                    bail!("Invalid byte in Mumble identity");
                }
                bytes.push(ch as u8);
                continue;
            }
            match chars.next().context("Truncated certificate escape")? {
                'x' => {
                    let mut number = 0u32;
                    let mut count = 0;
                    while let Some(digit) = chars.peek().and_then(|c| c.to_digit(16)) {
                        if count == 2 {
                            break;
                        }
                        chars.next();
                        number = number * 16 + digit;
                        count += 1;
                    }
                    if count == 0 {
                        bail!("Empty hexadecimal certificate escape");
                    }
                    bytes.push(number as u8);
                }
                '0' => bytes.push(0),
                'n' => bytes.push(b'\n'),
                'r' => bytes.push(b'\r'),
                't' => bytes.push(b'\t'),
                'a' => bytes.push(7),
                'b' => bytes.push(8),
                'f' => bytes.push(12),
                'v' => bytes.push(11),
                c @ ('\\' | '"' | ')' | '(') => bytes.push(c as u8),
                _ => bail!("Unsupported certificate escape"),
            }
        }
        return Ok(Some(bytes));
    }
    Ok(None)
}

pub fn verifier(
    directory: &Path,
    legacy_pins: &Path,
    host: &str,
    port: u16,
) -> Result<mumble_client_protocol::tls::CertVerifier> {
    let path = directory.join("known-servers.json");
    if !path.exists() && legacy_pins.exists() {
        let pins: BTreeMap<String, String> = serde_json::from_slice(&fs::read(legacy_pins)?)
            .context("Existing server fingerprints are invalid; refusing to discard them")?;
        write_private(&path, &serde_json::to_vec_pretty(&pins)?)?;
    }
    let pins: BTreeMap<String, String> = if path.exists() {
        serde_json::from_slice(&fs::read(&path)?)
            .context("Native server fingerprints are invalid")?
    } else {
        BTreeMap::new()
    };
    let key = format!("{host}:{port}");
    let pins = Mutex::new(pins);
    Ok(Arc::new(move |cert: &ServerCert| {
        let Ok(mut pins) = pins.lock() else {
            return false;
        };
        if let Some(expected) = pins.get(&key) {
            if expected == &cert.sha256_hex {
                return true;
            }
            eprintln!("Native Mumble: server certificate changed; refusing the connection");
            return false;
        }
        // First use is persisted before acceptance; failed writes fail closed.
        let mut updated = pins.clone();
        updated.insert(key.clone(), cert.sha256_hex.clone());
        match serde_json::to_vec_pretty(&updated)
            .map_err(anyhow::Error::from)
            .and_then(|data| write_private(&path, &data))
        {
            Ok(()) => {
                *pins = updated;
                eprintln!(
                    "Native Mumble: pinned server certificate {}",
                    cert.sha256_hex
                );
                true
            }
            Err(_) => {
                eprintln!(
                    "Native Mumble: cannot persist server certificate; refusing the connection"
                );
                false
            }
        }
    }))
}

pub fn default_gui_config(root: &Path) -> PathBuf {
    root.join(".config/Mumble/Mumble.conf")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qsettings_bytes_preserve_identity() {
        assert_eq!(
            gui_certificate("[net]\ncertificate=@ByteArray(0\\x82\\x1\\0\\\\\\n\\r\\t\\)x)\n")
                .unwrap(),
            Some(vec![b'0', 0x82, 1, 0, b'\\', 10, 13, 9, b')', b'x'])
        );
        assert!(gui_certificate("[net]\ncertificate=@ByteArray(\\x)\n").is_err());
        assert!(gui_certificate("[net]\ncertificate=unexpected\n").is_err());
    }

    #[test]
    fn real_gui_identity_is_imported_and_never_replaced() {
        let root = std::env::temp_dir().join(format!(
            "bridge-identity-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let generated = root.join("generated");
        let gui = default_gui_config(&root);
        let original = load(&generated, &gui, None).unwrap();
        let pem = fs::read(generated.join("identity.pem")).unwrap();
        let bundle = openssl(&["pkcs12", "-export", "-passout", "pass:"], &pem).unwrap();
        fs::create_dir_all(gui.parent().unwrap()).unwrap();
        let encoded: String = bundle.iter().map(|b| format!("\\x{b:02x}")).collect();
        let settings = format!("[net]\ncertificate=@ByteArray({encoded})\n");
        fs::write(&gui, &settings).unwrap();
        let imported = load(&root.join("native"), &gui, None).unwrap();
        assert_eq!(
            original.chain, imported.chain,
            "registration certificate must stay identical"
        );
        assert_eq!(
            fs::read_to_string(&gui).unwrap(),
            settings,
            "GUI rollback profile remains unchanged"
        );
        let again = load(&root.join("native"), &gui, None).unwrap();
        assert_eq!(again.chain, original.chain);
        assert_eq!(
            fs::metadata(root.join("native/identity.pem"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::write(&gui, "[net]\ncertificate=broken\n").unwrap();
        assert!(
            load(&root.join("different"), &gui, None).is_err(),
            "migration must fail closed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_trust_store_is_not_silently_discarded() {
        let root = std::env::temp_dir().join(format!("bridge-pins-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let old = root.join("legacy.json");
        fs::write(&old, b"broken").unwrap();
        assert!(verifier(&root.join("native"), &old, "host", 64738).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_use_pin_is_fixed_across_address_attempts() {
        let root =
            std::env::temp_dir().join(format!("bridge-first-pin-test-{}", std::process::id()));
        let check = verifier(&root, &root.join("absent"), "host", 64738).unwrap();
        let mut cert = ServerCert {
            chain: vec![],
            sha1_hex: String::new(),
            sha256_hex: "11".repeat(32),
            issuer: None,
            valid_from: None,
            valid_until: None,
            pem: String::new(),
        };
        assert!(check(&cert));
        cert.sha256_hex = "22".repeat(32);
        assert!(
            !check(&cert),
            "later address attempts must not replace the first accepted fingerprint"
        );
        cert.sha256_hex = "11".repeat(32);
        assert!(check(&cert));
        fs::remove_dir_all(root).unwrap();
    }
}
