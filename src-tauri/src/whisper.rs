// Speech recognition on the desktop: whisper.cpp's whisper-server with CUDA,
// any of ~100 languages (detected). Installed on first use (a pinned release),
// its model sits in the models folder, and the server runs on 127.0.0.1 with
// a random port while the app is open. The web side posts WAV audio to it.
use crate::llama::{data_dir, download, find_exe, hidden, log_tail, models_dir, safe_name, LlamaState};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

pub const WHISPER_VERSION: &str = "b5454";
const ZIP: &str = "whisper-bin-win-cuda-12.4.0-x64.zip";

#[derive(Default)]
pub struct WhisperState {
    child: Mutex<Option<(Child, u16)>>,
}

impl WhisperState {
    pub fn stop(&self) {
        if let Some((mut c, _)) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("whisper").join(WHISPER_VERSION))
}

#[tauri::command]
pub fn whisper_installed(app: AppHandle) -> bool {
    engine_dir(&app).map(|d| d.join("installed").exists()).unwrap_or(false)
}

/// Download and unpack whisper.cpp (CUDA build, with its runtime: ~685 MB).
#[tauri::command]
pub async fn install_whisper(app: AppHandle, state: State<'_, LlamaState>, on_progress: Channel<crate::llama::Progress>) -> Result<(), String> {
    // The pinned release only has a Windows build; elsewhere the app keeps its other options.
    if !cfg!(windows) {
        return Err("Whisper is only available on Windows for now.".into());
    }
    let dir = engine_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join(ZIP);
    if !zip.exists() {
        let url = format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_VERSION}/{ZIP}");
        download(&state, "whisper", &url, &zip, "speech engine", &on_progress, None).await?;
    }
    crate::llama::unzip(&zip, &dir)?;
    let _ = fs::remove_file(&zip);
    if find_exe(&dir, "whisper-server").is_none() {
        return Err("whisper-server.exe was not found in the download.".into());
    }
    fs::write(dir.join("installed"), WHISPER_VERSION).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_whisper(app: AppHandle, state: State<'_, WhisperState>) -> Result<(), String> {
    state.stop();
    let dir = data_dir(&app)?.join("whisper");
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Start whisper-server with `file` (in the models folder), or return the running one's port.
#[tauri::command]
pub async fn start_whisper(app: AppHandle, state: State<'_, WhisperState>, file: String) -> Result<u16, String> {
    if let Some((c, port)) = state.child.lock().unwrap().as_mut() {
        if matches!(c.try_wait(), Ok(None)) {
            return Ok(*port);
        }
    }
    state.stop();
    let server = find_exe(&engine_dir(&app)?, "whisper-server").ok_or("The speech engine is not installed.")?;
    let model = models_dir(&app)?.join(safe_name(&file)?);
    if !model.exists() {
        return Err(format!("{file} is not downloaded."));
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let log_path = data_dir(&app)?.join("whisper-server.log");
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let child = hidden(
        Command::new(&server)
            .current_dir(server.parent().unwrap_or(std::path::Path::new(".")))
            .arg("--model").arg(&model)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            // Detect the language of each recording.
            .args(["--language", "auto"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log),
    )
    .spawn()
    .map_err(|e| format!("Couldn't start whisper-server: {e}"))?;
    *state.child.lock().unwrap() = Some((child, port));

    // Ready once its HTTP port answers (the model loads before it listens).
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if let Some((c, _)) = state.child.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                return Err(format!("whisper-server stopped ({status}):\n{}", log_tail(&log_path)));
            }
        }
        if client.get(format!("http://127.0.0.1:{port}/")).send().await.is_ok() {
            return Ok(port);
        }
        if Instant::now() > deadline {
            state.stop();
            return Err(format!("The speech model took too long to load:\n{}", log_tail(&log_path)));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
