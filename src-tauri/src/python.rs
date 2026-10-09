// Real Python on the PC (opt-in, Settings → Connectors): the user's own
// interpreter and packages, with access to their files. The web side asks the
// user before every run and shows the code. Output is captured and capped,
// and a run past its time limit is killed.
use crate::llama::{data_dir, hidden};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Serialize)]
pub struct PythonInfo {
    /// The command that works: "py -3", "python" or "python3".
    command: Vec<String>,
    version: String,
}

fn candidates() -> Vec<Vec<&'static str>> {
    if cfg!(windows) { vec![vec!["py", "-3"], vec!["python"], vec!["python3"]] } else { vec![vec!["python3"], vec!["python"]] }
}

/// The installed Python, if any.
#[tauri::command]
pub fn python_info() -> Option<PythonInfo> {
    for c in candidates() {
        let out = hidden(Command::new(c[0]).args(&c[1..]).arg("--version")).output();
        if let Ok(o) = out {
            let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            // The Windows Store alias prints nothing useful and fails.
            if o.status.success() && text.contains("Python 3") {
                return Some(PythonInfo { command: c.iter().map(|s| s.to_string()).collect(), version: text.trim().to_string() });
            }
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    output: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

/// Run `code` with the installed Python in `cwd` (a workspace folder, or the app's scratch folder).
#[tauri::command]
pub async fn run_python(app: AppHandle, command: Vec<String>, code: String, cwd: Option<String>, timeout_s: u64) -> Result<RunOutput, String> {
    let scratch = data_dir(&app)?.join("python");
    fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let script = scratch.join("run.py");
    fs::write(&script, code).map_err(|e| e.to_string())?;
    let dir = cwd.map(std::path::PathBuf::from).filter(|p| p.is_dir()).unwrap_or(scratch.clone());
    let program = command.first().ok_or("No Python command.")?.clone();
    let mut cmd = Command::new(&program);
    cmd.args(&command[1..])
        .arg("-X").arg("utf8")
        .arg(&script)
        .current_dir(&dir)
        .env("PYTHONIOENCODING", "utf-8")
        .env("MPLBACKEND", "Agg")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hidden(&mut cmd);
    tauri::async_runtime::spawn_blocking(move || -> Result<RunOutput, String> {
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Python: {e}"))?;
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let t_out = std::thread::spawn(move || { let mut s = Vec::new(); let _ = out.read_to_end(&mut s); s });
        let t_err = std::thread::spawn(move || { let mut s = Vec::new(); let _ = err.read_to_end(&mut s); s });
        let deadline = Instant::now() + Duration::from_secs(timeout_s.max(1));
        let mut timed_out = false;
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(s);
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut text = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).to_string();
        let err_text = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).to_string();
        if !err_text.trim().is_empty() {
            text.push_str(&err_text);
        }
        if text.len() > 100_000 {
            let cut = text.len() - 100_000;
            text = format!("…{}", &text[text.char_indices().find(|(i, _)| *i >= cut).map(|(i, _)| i).unwrap_or(0)..]);
        }
        Ok(RunOutput { output: text, exit_code: status.and_then(|s| s.code()), timed_out })
    })
    .await
    .map_err(|e| e.to_string())?
}
