// Workspace folders: the folders the user chose, which the assistant may list,
// read, search and (with approval, asked by the web side) write. Every path is
// resolved inside its folder: "..", absolute paths and links leading out are
// refused, whatever the model asks.
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Path relative to the folder, with "/" separators.
    path: String,
    is_dir: bool,
    bytes: u64,
    /// Last change, in ms since 1970.
    modified: u64,
}

/// `rel` inside `root`, or an error if it would leave it.
fn inside(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("Folder not found ({root}): {e}"))?;
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    let mut out = root.clone();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(format!("\"{rel}\" is outside the folder.")),
        }
    }
    // A link inside the folder may point elsewhere: check where it really leads.
    if out.exists() {
        let real = fs::canonicalize(&out).map_err(|e| e.to_string())?;
        if !real.starts_with(&root) {
            return Err(format!("\"{rel}\" leads outside the folder."));
        }
    } else if let Some(parent) = out.parent().filter(|p| p.exists()) {
        let real = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        if !real.starts_with(&root) {
            return Err(format!("\"{rel}\" is outside the folder."));
        }
    }
    Ok(out)
}

fn entry(root: &Path, p: &Path) -> Option<Entry> {
    let meta = fs::metadata(p).ok()?;
    let rel = p.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    Some(Entry {
        path: rel,
        is_dir: meta.is_dir(),
        bytes: if meta.is_dir() { 0 } else { meta.len() },
        modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
    })
}

/// Skipped while walking: hidden folders and build/dependency folders.
fn skip(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "__pycache__" | "venv" | ".venv" | "dist" | "build" | "$RECYCLE.BIN")
}

/// One folder level (`recursive`: everything below it, up to `limit` entries).
#[tauri::command]
pub fn fs_list(root: String, path: String, recursive: bool, limit: usize) -> Result<Vec<Entry>, String> {
    let base = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let dir = inside(&root, &path)?;
    let mut out = vec![];
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        let mut items: Vec<_> = fs::read_dir(&d).map_err(|e| format!("Can't open {}: {e}", d.display()))?.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for item in items {
            let name = item.file_name().to_string_lossy().to_string();
            if skip(&name) {
                continue;
            }
            let p = item.path();
            if let Some(e) = entry(&base, &p) {
                if recursive && e.is_dir {
                    stack.push(p);
                }
                out.push(e);
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
        if !recursive {
            break;
        }
    }
    Ok(out)
}

/// A file's bytes (up to `max_bytes`).
#[tauri::command]
pub fn fs_read(root: String, path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let p = inside(&root, &path)?;
    let meta = fs::metadata(&p).map_err(|_| format!("No file \"{path}\"."))?;
    if meta.is_dir() {
        return Err(format!("\"{path}\" is a folder."));
    }
    if meta.len() > max_bytes {
        return Err(format!("\"{path}\" is too big ({} MB).", meta.len() / 1_000_000));
    }
    fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Write a text file (the web side has asked the user). Creates missing folders.
#[tauri::command]
pub fn fs_write(root: String, path: String, content: String, overwrite: bool) -> Result<(), String> {
    let p = inside(&root, &path)?;
    if p.exists() && !overwrite {
        return Err(format!("\"{path}\" already exists."));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Recheck now that the parent folders exist.
    inside(&root, &path)?;
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// Does `path` exist inside the folder?
#[tauri::command]
pub fn fs_exists(root: String, path: String) -> Result<bool, String> {
    Ok(inside(&root, &path)?.exists())
}
