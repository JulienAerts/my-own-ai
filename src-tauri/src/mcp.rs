// MCP servers over stdio (the usual "command + args" kind, as in Claude
// Desktop's config). The app starts the process, writes JSON-RPC lines to its
// stdin and forwards each stdout line to the web side, which speaks the protocol
// (src/mcp/client.ts). stderr is kept for error messages.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct McpState {
    procs: Mutex<HashMap<String, Proc>>,
}

impl McpState {
    pub fn stop_all(&self) {
        for (_, mut p) in self.procs.lock().unwrap().drain() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

fn command(program: &str, args: &[String]) -> Command {
    // npx, uvx and friends are .cmd scripts on Windows: start them through cmd.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/C").arg(program).args(args);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new(program);
        c.args(args);
        c
    }
}

/// Start server `id`. Each stdout line is sent to `on_message`; when the process
/// ends, a final `{"__exit": code}` line is sent.
#[tauri::command]
pub fn mcp_start(
    state: State<'_, McpState>,
    id: String,
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    on_message: Channel<String>,
) -> Result<(), String> {
    mcp_stop(state.clone(), id.clone());
    let mut child = command(&program, &args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr")?;

    let stderr = Arc::new(Mutex::new(VecDeque::new()));
    let tail = stderr.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
            let mut t = tail.lock().unwrap();
            t.push_back(line);
            if t.len() > 40 {
                t.pop_front();
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if on_message.send(line).is_err() {
                break;
            }
        }
        let _ = on_message.send("{\"__exit\":true}".to_string());
    });
    state.procs.lock().unwrap().insert(id, Proc { child, stdin, stderr });
    Ok(())
}

/// Write one JSON-RPC message (a single line) to server `id`.
#[tauri::command]
pub fn mcp_send(state: State<'_, McpState>, id: String, line: String) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    let p = procs.get_mut(&id).ok_or("The server is not running.")?;
    p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.write_all(b"\n")).and_then(|_| p.stdin.flush()).map_err(|e| format!("The server stopped reading ({e})."))
}

#[tauri::command]
pub fn mcp_stop(state: State<'_, McpState>, id: String) {
    if let Some(mut p) = state.procs.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

/// The server's last stderr lines (why it failed to start, usually).
#[tauri::command]
pub fn mcp_stderr(state: State<'_, McpState>, id: String) -> String {
    state.procs.lock().unwrap().get(&id).map(|p| p.stderr.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default()
}
