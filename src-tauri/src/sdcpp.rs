// Image generation on the desktop: stable-diffusion.cpp's sd-cli (Vulkan build,
// works on any recent GPU) with Z-Image-Turbo. One process per image: it loads
// the model, renders, writes a PNG and exits, so its GPU memory is freed as
// soon as the image is done (the chat model may need it back).
use crate::llama::{data_dir, download, find_exe, hidden, models_dir, safe_name, LlamaState, Progress};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

pub const SD_VERSION: &str = "master-945-a1ded76";
const ZIP: &str = "sd-master-a1ded76-bin-win-vulkan-x64.zip";

fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("sd").join(SD_VERSION))
}

#[tauri::command]
pub fn sd_installed(app: AppHandle) -> bool {
    engine_dir(&app).map(|d| d.join("installed").exists()).unwrap_or(false)
}

/// Download and unpack stable-diffusion.cpp (Vulkan, ~30 MB).
#[tauri::command]
pub async fn install_sd(app: AppHandle, state: State<'_, LlamaState>, on_progress: Channel<Progress>) -> Result<(), String> {
    // The pinned release only has a Windows build; elsewhere the app keeps its other options.
    if !cfg!(windows) {
        return Err("Image generation is only available on Windows for now.".into());
    }
    let dir = engine_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join(ZIP);
    if !zip.exists() {
        let url = format!("https://github.com/leejet/stable-diffusion.cpp/releases/download/{SD_VERSION}/{ZIP}");
        download(&state, "sd", &url, &zip, "image engine", &on_progress, None).await?;
    }
    crate::llama::unzip(&zip, &dir)?;
    let _ = fs::remove_file(&zip);
    if find_exe(&dir, "sd-cli").is_none() {
        return Err("sd-cli.exe was not found in the download.".into());
    }
    fs::write(dir.join("installed"), SD_VERSION).map_err(|e| e.to_string())
}

/// Free GPU memory in MB (NVIDIA), or None without nvidia-smi (AMD, Intel: the app estimates it).
#[tauri::command]
pub fn gpu_free_mb() -> Option<u64> {
    let out = hidden(Command::new("nvidia-smi").args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"])).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<u64>().ok()).max()
}

/// Render one image; returns the PNG. Model files are names in the models folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_image(
    app: AppHandle,
    diffusion: String,
    vae: String,
    llm: String,
    prompt: String,
    width: u32,
    height: u32,
    steps: u32,
    seed: i64,
) -> Result<tauri::ipc::Response, String> {
    let cli = find_exe(&engine_dir(&app)?, "sd-cli").ok_or("The image engine is not installed.")?;
    let models = models_dir(&app)?;
    let file = |name: &str| -> Result<PathBuf, String> {
        let p = models.join(safe_name(name)?);
        if p.exists() { Ok(p) } else { Err(format!("{name} is not downloaded.")) }
    };
    let (diffusion, vae, llm) = (file(&diffusion)?, file(&vae)?, file(&llm)?);
    let out = data_dir(&app)?.join("last-image.png");
    let _ = fs::remove_file(&out);
    let log_path = data_dir(&app)?.join("sd-cli.log");
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&cli);
    cmd.current_dir(cli.parent().unwrap_or(std::path::Path::new(".")))
        .arg("--diffusion-model").arg(&diffusion)
        .arg("--vae").arg(&vae)
        .arg("--llm").arg(&llm)
        .arg("-p").arg(&prompt)
        .args(["--cfg-scale", "1.0", "--steps", &steps.to_string()])
        .args(["-W", &width.to_string(), "-H", &height.to_string()])
        .args(["--seed", &seed.to_string()])
        .args(["--diffusion-fa", "--offload-to-cpu"])
        .arg("-o").arg(&out)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    hidden(&mut cmd);
    let status = tauri::async_runtime::spawn_blocking(move || cmd.status())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Couldn't start sd-cli: {e}"))?;
    if !status.success() || !out.exists() {
        return Err(format!("Image generation failed ({status}):\n{}", crate::llama::log_tail(&log_path)));
    }
    fs::read(&out).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}
