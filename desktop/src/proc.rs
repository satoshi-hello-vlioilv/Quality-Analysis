//! プロセスを PID で見る・止める（WaveLog の desktop/src/proc.rs から写した）。
//!
//! 窓が起こしたプロセスと、本当に動いている Python は**同じとは限らない**。Microsoft Store・Python Install Manager の
//! 入口（`WindowsApps\python.exe`）は別名で、本物（`pythoncore-*\python.exe`）を子として起こす。窓が入口だけを止めると
//! 本物が残り、作業フォルダ（`program`）を掴んだまま版の入れ替えが断られる（WaveLog で利用者の PC で起きた）。
//! そこで本物の PID（起動の合図 `ready.pid`）を見張り、止めるときも本物が終わるのを待つ。

use std::time::{Duration, Instant};

/// まだ動いているか。開けない（もう無い）なら false。
pub fn alive(pid: u32) -> bool {
    imp::alive(pid)
}

/// 止める（無ければ何もしない）。
pub fn kill(pid: u32) {
    imp::kill(pid)
}

/// 終わるまで待つ。`wait`のうちに終われば true。
pub fn wait_gone(pid: u32, wait: Duration) -> bool {
    let end = Instant::now() + wait;
    loop {
        if !alive(pid) {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub fn alive(pid: u32) -> bool {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            let _ = CloseHandle(h);
            running
        }
    }

    pub fn kill(pid: u32) {
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(h, 1);
                let _ = CloseHandle(h);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn alive(pid: u32) -> bool {
        // 終わったが親に回収されていない物（ゾンビ）は動いていない（Linux の網用）
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => !s.rsplit(')').next().unwrap_or("").trim_start().starts_with('Z'),
            Err(_) => false,
        }
    }

    pub fn kill(pid: u32) {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// 30秒ほど眠るだけのプロセス（どの OS にもある物で）。
    fn sleeper() -> std::process::Child {
        let mut c = if cfg!(windows) { Command::new("ping") } else { Command::new("sleep") };
        if cfg!(windows) {
            c.args(["-n", "30", "127.0.0.1"]);
        } else {
            c.arg("30");
        }
        c.stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("sleeper")
    }

    #[test]
    fn pid_is_seen_waited_and_killed() {
        // 窓は本物の Python を PID だけで見る（自分の子ではない）。子の持ち手を使わず、PID だけで見る・待つ・止める
        let mut c = sleeper();
        let pid = c.id();
        assert!(alive(pid), "動いている物を動いていると見る");
        assert!(!wait_gone(pid, Duration::from_millis(200)), "終わっていない物を終わったと言わない");
        kill(pid);
        let _ = c.wait(); // 回収（Linux ではゾンビの印も alive が見分ける）
        assert!(wait_gone(pid, Duration::from_secs(5)), "止めたら終わったと分かる");
    }

    #[test]
    fn missing_pid_is_not_alive() {
        assert!(!alive(u32::MAX - 7));
        assert!(wait_gone(u32::MAX - 7, Duration::ZERO));
    }
}
