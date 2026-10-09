// Native inference for the desktop app: llama.cpp's llama-server, run on this
// machine's GPU: the CUDA or Vulkan build on Windows, Vulkan on Linux, Metal on
// Apple Silicon Macs. The app installs the engine (a pinned llama.cpp release),
// downloads GGUF models into its data folder, and starts the server on
// 127.0.0.1 with a random port and API key, so no website or other program can
// use it. The web side talks to it through the HTTP plugin (see src/native/llama.ts).
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The llama.cpp release the app installs (tested with it).
pub const LLAMA_VERSION: &str = "b11480";
const RELEASES: &str = "https://github.com/ggml-org/llama.cpp/releases/download";

#[derive(Default)]
pub struct LlamaState {
    child: Mutex<Option<Child>>,
    /// Downloads the user cancelled, by id.
    cancelled: Mutex<HashSet<String>>,
}

impl LlamaState {
    pub fn stop(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    #[serde(rename = "vramMB")]
    vram_mb: u64,
    driver: String,
    /// "nvidia", "amd", "intel", "apple" or "other".
    vendor: String,
    /// The CUDA builds (llama.cpp, Whisper) can run on it: an NVIDIA GPU on Windows.
    cuda: bool,
    /// The llama.cpp build for this GPU on this system ("cuda-12.4", "vulkan", "metal").
    engine: String,
}

/// The engine build for a GPU on this system.
fn engine_for(vendor: &str, cuda: bool) -> &'static str {
    if cfg!(target_os = "macos") {
        "metal"
    } else if cuda && vendor == "nvidia" {
        "cuda-12.4"
    } else {
        "vulkan"
    }
}

fn vendor_of(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") || n.contains("rtx") { "nvidia" }
    else if n.contains("amd") || n.contains("radeon") { "amd" }
    else if n.contains("intel") || n.contains(" arc") || n.starts_with("arc") { "intel" }
    else { "other" }
}

/// Display adapters from the registry, where drivers record the dedicated memory
/// as a 64-bit value (WMI's AdapterRAM stops at 4 GB). Covers AMD, Intel and others.
#[cfg(windows)]
fn registry_gpus() -> Vec<Gpu> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    const DISPLAY: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(DISPLAY) else { return vec![] };
    class
        .enum_keys()
        .flatten()
        .filter_map(|k| {
            let sub = class.open_subkey(&k).ok()?;
            let name: String = sub.get_value("DriverDesc").ok()?;
            let bytes: u64 = sub
                .get_value::<u64, _>("HardwareInformation.qwMemorySize")
                .ok()
                .or_else(|| sub.get_value::<u32, _>("HardwareInformation.MemorySize").ok().map(u64::from))?;
            let driver: String = sub.get_value("DriverVersion").unwrap_or_default();
            let vendor = vendor_of(&name);
            Some(Gpu { vendor: vendor.into(), engine: engine_for(vendor, false).into(), name, vram_mb: bytes / (1024 * 1024), driver, cuda: false })
        })
        .collect()
}

/// Linux: AMD cards report their memory under /sys (amdgpu); NVIDIA comes from nvidia-smi.
#[cfg(target_os = "linux")]
fn registry_gpus() -> Vec<Gpu> {
    let Ok(cards) = fs::read_dir("/sys/class/drm") else { return vec![] };
    cards
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("card") && !e.file_name().to_string_lossy().contains('-'))
        .filter_map(|e| {
            let dev = e.path().join("device");
            let id = fs::read_to_string(dev.join("vendor")).ok()?;
            let vendor = match id.trim() {
                "0x1002" => "amd",
                "0x8086" => "intel",
                "0x10de" => "nvidia",
                _ => "other",
            };
            let bytes: u64 = fs::read_to_string(dev.join("mem_info_vram_total")).ok()?.trim().parse().ok()?;
            let name = fs::read_to_string(dev.join("product_name")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("{} GPU", match vendor { "amd" => "AMD", "intel" => "Intel", "nvidia" => "NVIDIA", _ => "Graphics" }));
            Some(Gpu { name, vram_mb: bytes / (1024 * 1024), driver: String::new(), vendor: vendor.into(), cuda: false, engine: engine_for(vendor, false).into() })
        })
        .collect()
}

/// Apple Silicon: one memory for CPU and GPU, of which Metal can use about 70%.
#[cfg(target_os = "macos")]
fn registry_gpus() -> Vec<Gpu> {
    if !cfg!(target_arch = "aarch64") {
        return vec![]; // Intel Macs: the browser engine (WebLLM) instead
    }
    let sysctl = |key: &str| Command::new("sysctl").args(["-n", key]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let Some(bytes) = sysctl("hw.memsize").and_then(|s| s.parse::<u64>().ok()) else { return vec![] };
    let name = sysctl("machdep.cpu.brand_string").filter(|s| !s.is_empty()).unwrap_or_else(|| "Apple Silicon".into());
    vec![Gpu { name, vram_mb: bytes / (1024 * 1024) * 7 / 10, driver: String::new(), vendor: "apple".into(), cuda: false, engine: "metal".into() }]
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn registry_gpus() -> Vec<Gpu> {
    vec![]
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    received: u64,
    total: u64,
    /// What is being downloaded ("engine", "CUDA runtime", a model file).
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    file: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Installed engine build ("cuda-12.4"), if any.
    engine: Option<String>,
    /// Every installed build ("cuda-12.4", "vulkan").
    engines: Vec<String>,
    version: &'static str,
    models: Vec<ModelFile>,
    running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    port: u16,
    key: String,
}

pub(crate) fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn engine_dir(app: &AppHandle, variant: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("engine").join(format!("{variant}-{LLAMA_VERSION}")))
}

pub(crate) fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("models");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Only plain file names: a model name must not reach outside the models folder.
pub(crate) fn safe_name(file: &str) -> Result<&str, String> {
    if file.is_empty() || file.contains(['/', '\\', ':']) || file.starts_with('.') {
        return Err(format!("Invalid file name: {file}"));
    }
    Ok(file)
}

/// The computer's GPUs: NVIDIA from nvidia-smi (installed with the driver), the others from
/// the system (Windows registry, Linux /sys, the Mac's unified memory).
#[tauri::command]
pub fn gpu_info() -> Vec<Gpu> {
    // NVIDIA: nvidia-smi (exact memory, and proof the CUDA driver works).
    let mut gpus: Vec<Gpu> = hidden(
        Command::new("nvidia-smi").args(["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]),
    )
    .output()
    .ok()
    .filter(|o| o.status.success())
    .map(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split(',').map(str::trim).collect();
                // The CUDA builds the app installs are Windows ones; Linux uses Vulkan on NVIDIA too.
                let cuda = cfg!(windows);
                Some(Gpu {
                    name: p.first()?.to_string(),
                    vram_mb: p.get(1)?.parse().ok()?,
                    driver: p.get(2).unwrap_or(&"").to_string(),
                    vendor: "nvidia".into(),
                    cuda,
                    engine: engine_for("nvidia", cuda).into(),
                })
            })
            .collect()
    })
    .unwrap_or_default();
    // Everything else (AMD, Intel, Apple, an NVIDIA card nvidia-smi didn't list).
    let smi = !gpus.is_empty();
    for g in registry_gpus() {
        // nvidia-smi already listed the NVIDIA cards (names can differ slightly between the two).
        if !(g.vendor == "nvidia" && smi) && !gpus.iter().any(|x| x.name == g.name) {
            gpus.push(g);
        }
    }
    gpus
}

fn installed_engines(app: &AppHandle) -> Vec<String> {
    ["cuda-12.4", "vulkan", "metal"]
        .into_iter()
        .filter(|v| engine_dir(app, v).map(|d| d.join("installed").exists()).unwrap_or(false))
        .map(String::from)
        .collect()
}

/// The build to run: `wanted` if installed, else any installed one.
fn installed_engine(app: &AppHandle, wanted: Option<&str>) -> Option<String> {
    let all = installed_engines(app);
    wanted.and_then(|w| all.iter().find(|v| *v == w).cloned()).or_else(|| all.into_iter().next())
}

#[tauri::command]
pub fn llama_status(app: AppHandle, state: State<'_, LlamaState>) -> Result<Status, String> {
    let mut models = vec![];
    for e in fs::read_dir(models_dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".gguf") {
            models.push(ModelFile { file: name, bytes: e.metadata().map(|m| m.len()).unwrap_or(0) });
        }
    }
    let running = state.child.lock().unwrap().as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
    Ok(Status { engine: installed_engine(&app, None), engines: installed_engines(&app), version: LLAMA_VERSION, models, running })
}

/// Download `url` to `dest`, resuming a previous partial download, with progress.
/// `token`: a Hugging Face token, sent only to huggingface.co (reqwest drops it on the
/// redirect to the CDN, whose signed URL needs none).
pub(crate) async fn download(state: &LlamaState, id: &str, url: &str, dest: &Path, label: &str, progress: &Channel<Progress>, token: Option<&str>) -> Result<(), String> {
    let part = dest.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let client = reqwest::Client::builder().user_agent("LocalAI-desktop").build().map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if let Some(t) = token.filter(|t| !t.is_empty() && url.starts_with("https://huggingface.co/")) {
        req = req.bearer_auth(t);
    }
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let res = req.send().await.map_err(|e| format!("{url}: {e}"))?;
    let resumed = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !res.status().is_success() {
        let code = res.status().as_u16();
        if (code == 401 || code == 403) && url.starts_with("https://huggingface.co/") {
            return Err("This model is gated on Hugging Face: accept its terms on its page, then add your Hugging Face token in Settings → Model.".into());
        }
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    let start = if resumed { have } else { 0 };
    let total = start + res.content_length().unwrap_or(0);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| e.to_string())?;
    let mut received = start;
    let mut last = Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if state.cancelled.lock().unwrap().remove(id) {
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            let _ = progress.send(Progress { received, total, label: label.into() });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    let _ = progress.send(Progress { received, total: total.max(received), label: label.into() });
    Ok(())
}

pub(crate) fn unzip(zip: &Path, into: &Path) -> Result<(), String> {
    let f = fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = into.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The release files of a build on this system (engine, then its runtime if any).
fn engine_files(variant: &str) -> Option<Vec<(String, &'static str)>> {
    let v = LLAMA_VERSION;
    let files = if cfg!(windows) {
        match variant {
            "cuda-12.4" => vec![
                (format!("llama-{v}-bin-win-cuda-12.4-x64.zip"), "llama.cpp engine"),
                ("cudart-llama-bin-win-cuda-12.4-x64.zip".to_string(), "CUDA runtime"),
            ],
            "vulkan" => vec![(format!("llama-{v}-bin-win-vulkan-x64.zip"), "llama.cpp engine")],
            _ => return None,
        }
    } else if cfg!(target_os = "linux") {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        match variant {
            "vulkan" => vec![(format!("llama-{v}-bin-ubuntu-vulkan-{arch}.tar.gz"), "llama.cpp engine")],
            _ => return None,
        }
    } else if cfg!(target_os = "macos") {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        match variant {
            "metal" => vec![(format!("llama-{v}-bin-macos-{arch}.tar.gz"), "llama.cpp engine")],
            _ => return None,
        }
    } else {
        return None;
    };
    Some(files)
}

/// Unpack a release archive: .zip (Windows) or .tar.gz (Linux, macOS, keeping the executable bits).
pub(crate) fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    if archive.extension().is_some_and(|e| e == "zip") {
        return unzip(archive, into);
    }
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(into).map_err(|e| e.to_string())
}

/// Download and unpack llama.cpp: "cuda-12.4" (NVIDIA on Windows, with the CUDA runtime),
/// "vulkan" (other GPUs, and every GPU on Linux) or "metal" (Apple Silicon).
#[tauri::command]
pub async fn install_engine(app: AppHandle, state: State<'_, LlamaState>, variant: String, on_progress: Channel<Progress>) -> Result<(), String> {
    let zips = engine_files(&variant).ok_or_else(|| format!("No {variant} build of llama.cpp for this system."))?;
    let dir = engine_dir(&app, &variant)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, label) in zips {
        let zip = dir.join(&name);
        if !zip.exists() {
            download(&state, "engine", &format!("{RELEASES}/{LLAMA_VERSION}/{name}"), &zip, label, &on_progress, None).await?;
        }
        unpack(&zip, &dir)?;
        let _ = fs::remove_file(&zip);
    }
    if find_server(&dir).is_none() {
        return Err("llama-server was not found in the download.".into());
    }
    fs::write(dir.join("installed"), LLAMA_VERSION).map_err(|e| e.to_string())
}

fn find_server(dir: &Path) -> Option<PathBuf> {
    find_exe(dir, "llama-server")
}

/// `name` (+ .exe on Windows) in `dir` or a folder below it.
pub(crate) fn find_exe(dir: &Path, name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let direct = dir.join(&exe);
    if direct.exists() {
        return Some(direct);
    }
    fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_exe(&e.path(), name))
}

/// Download a GGUF model into the models folder (resumable). Returns its file name.
#[tauri::command]
pub async fn download_model(app: AppHandle, state: State<'_, LlamaState>, url: String, file: String, token: Option<String>, on_progress: Channel<Progress>) -> Result<String, String> {
    let name = safe_name(&file)?.to_string();
    if !url.starts_with("https://") {
        return Err("Models download over https only.".into());
    }
    let dest = models_dir(&app)?.join(&name);
    if !dest.exists() {
        state.cancelled.lock().unwrap().remove(&name);
        download(&state, &name, &url, &dest, &name, &on_progress, token.as_deref()).await?;
    }
    Ok(name)
}

/// Stop a download; what was received stays, and the next attempt resumes.
#[tauri::command]
pub fn cancel_download(state: State<'_, LlamaState>, id: String) {
    state.cancelled.lock().unwrap().insert(id);
}

#[tauri::command]
pub fn delete_model(app: AppHandle, file: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let name = safe_name(&file)?;
    for p in [dir.join(name), dir.join(name).with_extension("part")] {
        if p.exists() {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn log_tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

/// Start llama-server with `file` and wait until the model is loaded.
/// `ctx`: context size in tokens. Any server already running is stopped first.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_llama(
    app: AppHandle,
    state: State<'_, LlamaState>,
    file: String,
    ctx: u32,
    mmproj: Option<String>,
    // Local API (Settings): a fixed port and key other apps can use; otherwise random ones.
    port: Option<u16>,
    key: Option<String>,
    // Engine build: "cuda-12.4" (NVIDIA on Windows), "vulkan" or "metal" (Apple Silicon).
    variant: Option<String>,
    // The model's trained context when `ctx` goes beyond it: stretch positions with YaRN.
    yarn: Option<u32>,
) -> Result<Server, String> {
    state.stop();
    let variant = installed_engine(&app, variant.as_deref()).ok_or("The llama.cpp engine is not installed.")?;
    let server = find_server(&engine_dir(&app, &variant)?).ok_or("llama-server is missing: reinstall the engine.")?;
    let model = models_dir(&app)?.join(safe_name(&file)?);
    if !model.exists() {
        return Err(format!("{file} is not downloaded."));
    }
    // Vision models: the image encoder ("multimodal projector") is a second file.
    let projector = match &mmproj {
        Some(f) => {
            let p = models_dir(&app)?.join(safe_name(f)?);
            if !p.exists() {
                return Err(format!("{f} is not downloaded."));
            }
            Some(p)
        }
        None => None,
    };
    let port = match port {
        Some(p) => {
            // Fail clearly if another program holds the chosen port.
            std::net::TcpListener::bind(("127.0.0.1", p)).map_err(|_| format!("Port {p} is already in use: choose another one for the local API."))?;
            p
        }
        None => std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port(),
    };
    let key = key.filter(|k| !k.is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let log_path = data_dir(&app)?.join("llama-server.log");
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&server);
    // Linux builds ship their libraries (libggml…, libllama…) next to llama-server.
    if cfg!(target_os = "linux") {
        if let Some(dir) = server.parent() {
            let old = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            cmd.env("LD_LIBRARY_PATH", if old.is_empty() { dir.display().to_string() } else { format!("{}:{old}", dir.display()) });
        }
    }
    if let Some(p) = &projector {
        cmd.arg("--mmproj").arg(p);
    }
    if let Some(orig) = yarn.filter(|&o| o > 0 && ctx > o) {
        cmd.args(["--rope-scaling", "yarn", "--rope-scale", &(ctx as f32 / orig as f32).to_string(), "--yarn-orig-ctx", &orig.to_string()]);
    }
    let child = hidden(
        cmd
            .current_dir(server.parent().unwrap_or(Path::new(".")))
            .arg("--model").arg(&model)
            .args(["--ctx-size", &ctx.to_string()])
            .args(["--n-gpu-layers", "999"])
            // 8-bit KV cache (needs flash attention): half the memory of 16-bit, about the same answers.
            .args(["--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"])
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--api-key", &key])
            // The model's own chat template; keep <think>…</think> in the text (the app parses it).
            .args(["--jinja", "--reasoning-format", "none"])
            .args(["--parallel", "1", "--no-webui"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log),
    )
    .spawn()
    .map_err(|e| format!("Couldn't start llama-server: {e}"))?;
    *state.child.lock().unwrap() = Some(child);

    // /health answers 503 while the model loads, 200 once it's ready.
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        if let Some(c) = state.child.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                return Err(format!("llama-server stopped ({status}):\n{}", log_tail(&log_path)));
            }
        } else {
            return Err("Stopped.".into());
        }
        if let Ok(r) = client.get(format!("http://127.0.0.1:{port}/health")).send().await {
            if r.status().is_success() {
                return Ok(Server { port, key });
            }
        }
        if Instant::now() > deadline {
            state.stop();
            return Err(format!("The model took too long to load:\n{}", log_tail(&log_path)));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

#[tauri::command]
pub fn stop_llama(state: State<'_, LlamaState>) {
    state.stop();
}

/// The server's log (last lines), for error reports.
#[tauri::command]
pub fn llama_log(app: AppHandle) -> String {
    data_dir(&app).map(|d| log_tail(&d.join("llama-server.log"))).unwrap_or_default()
}
